// Google Cloud Function (Node.js 20+)
// ต้องติดตั้ง node-fetch: npm install node-fetch
const fetch = require('node-fetch');

// **สำคัญ:** แทนที่ด้วย Execute URL ของ GAS ที่ได้จากการ Deploy ล่าสุด
// URL ที่ลงท้ายด้วย /exec
const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbyeI39d30ZwiCCp6Wm1PiDXcyClOO3oP90EDyqY7ubdRoo8aDEHQc4TXpIaw8E_-aX2/exec";

/**
 * Cloud Function ที่ทำหน้าที่เป็น Proxy ส่งต่อ LINE Webhook ไปยัง GAS Web App
 * @param {import('express').Request} req The request object.
 * @param {import('express').Response} res The response object.
 */
exports.lineWebhookProxy = async (req, res) => {
  // 1. ตรวจสอบและรับประกัน 200 OK ทันทีสำหรับ LINE
  if (req.method !== 'POST') {
    res.status(200).send('OK');
    return;
  }

  try {
    // 2. สร้าง Request ใหม่เพื่อส่งต่อ
    const gasResponse = await fetch(GAS_WEBAPP_URL, {
      method: 'POST',
      // ส่งต่อ Header สำคัญ รวมถึง Content-Type และ X-Line-Signature
      headers: {
        'Content-Type': req.headers['content-type'],
        'X-Line-Signature': req.headers['x-line-signature'] || '',
      },
      // ใช้ req.rawBody ในกรณีที่ LINE ส่งข้อมูลที่ไม่ใช่ JSON มาในบางครั้ง
      body: req.rawBody || JSON.stringify(req.body),
    });

    const text = await gasResponse.text();

    // 3. ส่ง 200 OK กลับไปให้ LINE เสมอ เพื่อไม่ให้ LINE Platform ส่ง Request ซ้ำ
    res.status(200).send(text); 

  } catch (error) {
    console.error('GAS Proxy Error:', error);
    // ตอบ 200 OK แม้จะเกิดข้อผิดพลาดในการ Fetch ไป GAS เพื่อไม่ให้ LINE ส่งซ้ำ
    res.status(200).send({ error: 'Proxy failed to reach GAS' });
  }
};