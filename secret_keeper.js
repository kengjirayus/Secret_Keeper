/**
 * Secret Keeper - Apps Script (complete)
 * - Stores vaults (Google Doc) and index in a Sheet named "VaultIndex"
 * - LINE webhook: handle "register" and postback "checkin"
 * - Scheduled daily check: scheduledCheck -> activate vaults if overdue
 *
 * IMPORTANT:
 * - Set Script Properties: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET (optional), ADMIN_EMAIL, BASE_WEBAPP_URL, **LINE_user_ID**
 * - Deploy web app and set LINE webhook to the web app URL
 */

/* ---------- Utilities ---------- */
function getScriptProps() {
  return PropertiesService.getScriptProperties();
}
function getSheet() {
  const ssName = 'VaultIndex';
  const files = DriveApp.getFilesByName(ssName);
  let ss;
  if (files.hasNext()) {
    const file = files.next();
    ss = SpreadsheetApp.open(file);
  } else {
    ss = SpreadsheetApp.create(ssName);
    // create header row
    const sh = ss.getActiveSheet();
    sh.appendRow([
      'vaultId','ownerEmail','ownerLineId','docId','docUrl','trustees','checkinDays','graceHours',
      'lastCheckinISO','status','createdAt','lastReminderISO'
    ]);
  }
  return ss.getActiveSheet();
}
function generateId(prefix){
  return prefix + '-' + Utilities.getUuid();
}

/* ---------- Web App (HTML serve) ---------- */
function doGet(e) {
  // serve simple HTML form for onboarding
  const html = HtmlService.createTemplateFromFile('onboard').evaluate()
    .setTitle('Secret Keeper - Create Vault');
  return html;
}

/* ---------- Web App (form submission and LINE webhook) ---------- */
function doPost(e) {
  const lineWebhookProxyUrl = getScriptProps().getProperty('BASE_WEBAPP_URL');
  if (e.postData.type === 'application/json') {
    const payload = JSON.parse(e.postData.contents);
    
    // LINE Webhook Handling
    if (payload.events && payload.events.length > 0) {
      payload.events.forEach(event => {
        Logger.log('LINE Event Type: ' + event.type);
        if (event.type === 'message' && event.message.type === 'text') {
          handleTextMessage(event.source.userId, event.replyToken, event.message.text, lineWebhookProxyUrl);
        } else if (event.type === 'postback') {
          handlePostback(event.source.userId, event.replyToken, event.postback.data);
        }
      });
      return ContentService.createTextOutput("OK"); // Return 200 OK for LINE
    }
  }
  return ContentService.createTextOutput("Error: Invalid Request");
}

function handleTextMessage(userId, replyToken, text, webAppUrl) {
  const sh = getSheet();
  const data = sh.getDataRange().getValues();
  
  const ownerLineIdFromProps = getScriptProps().getProperty('LINE_user_ID');
  
  // ตรวจสอบว่า Line ID ใน Properties ตรงกับผู้ใช้ปัจจุบันหรือไม่
  // เนื่องจากระบบนี้ออกแบบมาสำหรับเจ้าของคนเดียว
  if (userId !== ownerLineIdFromProps) {
      replyLine(replyToken, 'ขออภัย ระบบนี้อนุญาตให้เฉพาะเจ้าของบัญชีหลักเท่านั้นที่ใช้งานได้');
      return;
  }
  
  const input = text.toLowerCase().trim();
  const onboardUrl = `${webAppUrl}`; // URL ไม่มี parameter แล้ว

  if (input === 'register') {
    // 1. ตรวจสอบว่ามี Vault ที่ ACTIVE อยู่แล้วหรือไม่
    const existingVault = data.find(row => row[2] === userId && row[9] === 'ACTIVE');
    
    if (existingVault) {
      // 1.1 ถ้ามี Vault อยู่แล้ว: แนะนำให้พิมพ์ "create"
      replyLine(replyToken, 'คุณมี Vault ที่เปิดใช้งานอยู่แล้ว ต้องการสร้างอีกหรือไม่? พิมพ์ **"create"** เพื่อสร้างใหม่');
      return;
    }

    // 1.2 ถ้ายังไม่มี: ส่งลิงก์ให้ลงทะเบียน
    replyLine(replyToken, 'กรุณากรอกข้อมูล Vault ของคุณที่นี่:\n' + onboardUrl);

  } else if (input === 'create') {
    // 2. ถ้าผู้ใช้พิมพ์ "create": ส่งลิงก์ฟอร์มให้เลย โดยไม่ต้องตรวจสอบซ้ำ
    replyLine(replyToken, '✅ ยินดีครับ! กรุณากรอกข้อมูล Vault เพิ่มเติมที่นี่:\n' + onboardUrl);
    
  } else if (input === 'checkin') {
    // 3. คำสั่ง checkin
    checkin(userId);
    replyLine(replyToken, 'เช็กอินสำเร็จ! Vault ของคุณถูกต่ออายุแล้ว');
  } else {
    // 4. ข้อความอื่น ๆ
    replyLine(replyToken, 'ยินดีต้อนรับสู่ Secret Keeper! พิมพ์ **"register"** เพื่อเริ่มสร้าง Vault');
  }
}

function handlePostback(userId, replyToken, data) {
  if (data === 'action=checkin') {
    checkin(userId);
    replyLine(replyToken, 'เช็กอินสำเร็จ! Vault ของคุณถูกต่ออายุแล้ว');
  }
}

function replyLine(replyToken, text) {
  const token = getScriptProps().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    Logger.log('LINE token missing for reply');
    return;
  }
  const payload = {
    replyToken: replyToken,
    messages: [{ type: 'text', text: text }]
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', options);
}

function checkin(lineId) {
  const sh = getSheet();
  const data = sh.getDataRange().getValues();
  const nowISO = new Date().toISOString();
  
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    // Check by Line ID and ensure status is ACTIVE
    if (row[2] === lineId && row[9] === 'ACTIVE') {
      sh.getRange(r + 1, 9).setValue(nowISO); // update lastCheckinISO (Col 9)
      sh.getRange(r + 1, 12).setValue('');    // clear lastReminderISO (Col 12)
      Logger.log(`Vault ${row[0]} checked in by ${lineId}. LastCheckin updated to ${nowISO}`);
      return; // assuming one ACTIVE vault per user for simplicity
    }
  }
  Logger.log(`Checkin failed: No ACTIVE vault found for Line ID: ${lineId}`);
}

function submitVault(data) {
  const sh = getSheet();
  const nowISO = new Date().toISOString();
  
  // FIX: Fetch Line ID from Script Properties using the new name LINE_user_ID
  const ownerLineIdFromProps = getScriptProps().getProperty('LINE_user_ID');
  
  if (!ownerLineIdFromProps) {
      Logger.log('ERROR: LINE_user_ID is missing in Script Properties. Please set it.');
      return { ok: false, error: 'LINE_user_ID is missing. Cannot create Vault.' };
  }
  
  // 1. Create Google Doc
  const doc = DocumentApp.create(data.vaultTitle || 'Untitled Secret Vault');
  doc.getBody().setText(data.secretContent || 'No content provided.');
  
  // 2. Save document data
  const docId = doc.getId();
  const docUrl = doc.getUrl();
  
  // 3. Record metadata in Sheet
  const newRow = [
    generateId('VAULT'),
    Session.getActiveUser().getEmail(), // ownerEmail (GAS deployer)
    ownerLineIdFromProps, // **FIXED: Use ID from Script Properties**
    docId,
    docUrl,
    data.trusteesCSV,
    Number(data.checkinDays) || 30,
    Number(data.graceHours) || 12,
    nowISO, // lastCheckinISO (current time)
    'ACTIVE', // status
    nowISO, // createdAt
    '' // lastReminderISO (empty)
  ];
  
  sh.appendRow(newRow);
  Logger.log(`New Vault created: ${newRow[0]}. Doc URL: ${docUrl}`);

  return { ok: true, docUrl: docUrl };
}

/* ---------- LINE Message Builders ---------- */
function createCheckinReminderFlex(checkinDays, graceHours, sheetUrl) {
  return {
    type: "flex",
    altText: "Secret Keeper: Reminder Check-in",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "🚨 แจ้งเตือนเช็กอิน 🚨",
            weight: "bold",
            size: "md"
          },
          {
            type: "text",
            text: `ระบบตรวจไม่พบการเช็กอินของคุณมานาน ${checkinDays} วัน`,
            wrap: true,
            margin: "md"
          },
          {
            type: "text",
            text: `กรุณากด "ยังอยู่" ภายใน ${graceHours} ชั่วโมง มิฉะนั้นระบบจะเปิดเผยความลับ`,
            wrap: true,
            color: "#e84e4e",
            size: "sm",
            margin: "sm"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#30A900", // Green for positive action
            action: {
              type: "postback",
              label: "✅ ฉันยังอยู่ (Check In)",
              data: "action=checkin", // This data is handled by handlePostback
              displayText: "ฉันยังอยู่ (Check In)"
            }
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "uri",
              label: "เปิด Vault Index (ถ้าต้องการแก้ไข)",
              uri: sheetUrl // ใช้ URL ที่รับมา
            }
          }
        ]
      }
    }
  };
}

/* ---------- LINE push util (UPDATED for Flex Message) ---------- */
function sendLinePush(toLineUserId, payloadContent) {
  const token = getScriptProps().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    Logger.log('LINE token missing');
    return;
  }
  
  let payload;
  if (typeof payloadContent === 'string') {
    // Standard text message
    payload = {
      to: toLineUserId,
      messages: [{ type: 'text', text: payloadContent }]
    };
  } else {
    // Assume it's a Flex Message object (or other message object)
    payload = {
      to: toLineUserId,
      messages: [payloadContent]
    };
  }

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', options);
  Logger.log('LINE Push Response: ' + response.getResponseCode() + ' Body: ' + response.getContentText());
}

/* ---------- Scheduler: daily check (WITH LOGGER AND FLEX MESSAGE) ---------- */
function scheduledCheck() {
  // This should be set as a time-driven trigger (daily)
  const sh = getSheet();
  const ssUrl = sh.getParent().getUrl(); 
  
  const data = sh.getDataRange().getValues();
  const now = new Date();
  Logger.log('--- STARTING scheduledCheck ---');
  Logger.log('Current Time (Now): ' + now.toISOString());

  for (let r = 1; r < data.length; r++) {
    try {
      const row = data[r];
      const vaultId = row[0];
      const ownerEmail = row[1];
      const ownerLineId = row[2];
      const docUrl = row[4];
      const trusteesCSV = row[5] || '';
      const checkinDays = Number(row[6]) || 30;
      const graceHours = Number(row[7]) || 12;
      const lastCheckinISO = row[8];
      const status = row[9];
      const lastReminderISO = row[11];
      
      Logger.log(`\n--- Vault Row ${r+1}: ${vaultId} ---`);
      
      if (status !== 'ACTIVE') {
        Logger.log(`Status is not ACTIVE (${status}). Skipping row.`);
        continue;
      }

      // 1. Convert Dates and Calculate Time Thresholds
      const lastCheckin = lastCheckinISO ? new Date(lastCheckinISO) : new Date(row[10]); // Fallback to createdAt
      const lastReminderTime = lastReminderISO ? new Date(lastReminderISO) : new Date(0); // Epoch if no reminder sent
      
      const millisThreshold = checkinDays * 24 * 60 * 60 * 1000;
      const millisGrace = graceHours * 60 * 60 * 1000;
      
      const checkinDeadlineTime = new Date(lastCheckin.getTime() + millisThreshold);
      const activationTime = new Date(lastCheckin.getTime() + millisThreshold + millisGrace);
      
      const overdue = now >= checkinDeadlineTime;
      const fullyOverdue = now >= activationTime;

      Logger.log(`Checkin Days: ${checkinDays}, Grace Hours: ${graceHours}`);
      Logger.log(`Last Checkin: ${lastCheckin.toISOString()}`);
      Logger.log(`Checkin Deadline: ${checkinDeadlineTime.toISOString()}`);
      Logger.log(`Activation Time: ${activationTime.toISOString()}`);

      if (fullyOverdue) {
        // --- 2. ACTIVATE VAULT (GRACE PERIOD PASSED) ---
        Logger.log('ACTION: Vault is FULLY OVERDUE. Initiating Activation.');
        
        const trustees = trusteesCSV.split(',').map(s => s.trim()).filter(Boolean);
        
        // send email to trustees
        if (trustees.length > 0) {
          const subject = `Secret Keeper - Vault from ${ownerEmail || 'A'} is activated`;
          const body = `ระบบ Secret Keeper ได้เปิดเผยเอกสารตามเงื่อนไขที่ตั้งไว้โดยเจ้าของ (Vault ID: ${vaultId}).\n\nคุณสามารถเข้าดูเอกสารได้ที่:\n${docUrl}\n\nถ้าต้องการความช่วยเหลือ ติดต่อผู้ดูแลระบบ.`;
          trustees.forEach(t => {
            try { 
              GmailApp.sendEmail(t, subject, body); 
              Logger.log(`Email sent to Trustee: ${t}`);
            } catch(e){ 
              Logger.log('send mail err to ' + t + ': ' + e); 
            }
          });
        }
        
        // update status
        sh.getRange(r+1, 10).setValue('ACTIVATED');
        Logger.log(`STATUS: Vault ${vaultId} marked as ACTIVATED.`);
        
      } else if (overdue) {
        // --- 1. SEND REMINDER (DEADLINE PASSED, STILL IN GRACE) ---
        Logger.log('ACTION: Vault is OVERDUE but within Grace Period. Checking Reminder status.');

        const millisSinceLastReminder = now.getTime() - lastReminderTime.getTime();
        const reminderInterval = 24 * 60 * 60 * 1000; // 24 hours
        
        if (millisSinceLastReminder > reminderInterval) {
          Logger.log(`Sending Reminder. Time since last reminder: ${millisSinceLastReminder}ms.`);
          
          // Use FLEX MESSAGE for LINE reminder
          if (ownerLineId) {
            const flexMsg = createCheckinReminderFlex(checkinDays, graceHours, ssUrl); 
            sendLinePush(ownerLineId, flexMsg); // send Flex Message object
            Logger.log('LINE Flex Reminder sent.');
          } else if (ownerEmail) {
            // fallback: send email to owner (if LINE ID is missing)
            GmailApp.sendEmail(ownerEmail, 'Secret Keeper - Final Check-in Reminder',
              `ระบบตรวจไม่พบการเช็กอินเป็นเวลา ${checkinDays} วัน\nกรุณาเข้าสู่ระบบและยืนยันภายใน ${graceHours} ชั่วโมง`);
            Logger.log('Email Reminder sent (LINE ID missing).');
          }
          sh.getRange(r+1, 12).setValue(new Date().toISOString()); // set lastReminderISO
          Logger.log('Last Reminder ISO updated.');
          
        } else {
          Logger.log(`Skipping Reminder. Last reminder sent recently (${lastReminderTime.toISOString()}).`);
        }
      } else {
         Logger.log('STATUS: Vault is still within Check-in interval. Skipping.');
      }
      
    } catch(err) {
      Logger.log('scheduledCheck row err on row ' + (r+1) + ': ' + err.message);
    }
  }
  Logger.log('--- ENDING scheduledCheck ---');
}

/* ---------- Admin utility: list vaults (for debugging) ---------- */
function listVaults() {
  const sh = getSheet();
  const data = sh.getDataRange().getValues();
  const out = [];
  for (let r = 1; r < data.length; r++){
    out.push({
      vaultId: data[r][0],
      status: data[r][9],
      ownerLineId: data[r][2]
    });
  }
  Logger.log(JSON.stringify(out, null, 2));
}

function checkinByOwner(ownerLineId) {
  checkin(ownerLineId);
}
