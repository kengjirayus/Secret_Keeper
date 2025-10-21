/**
 * Secret Keeper - Apps Script (complete)
 * - Stores vaults (Google Doc) and index in a Sheet named "VaultIndex"
 * - LINE webhook: handle "register", "deactivate", and postback "checkin"
 * - Scheduled daily check: scheduledCheck -> activate vaults if overdue
 *
 * IMPORTANT:
 * - Set Script Properties: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET (optional), ADMIN_EMAIL, BASE_WEBAPP_URL, LINE_user_ID, **EMAIL_SENDER_NAME**
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
      'vaultId','ownerEmail','ownerLineId','docId','docUrl','filesFolderId','trustees','checkinDays','graceHours', // เพิ่ม 'filesFolderId' ที่ index 5
      'lastCheckinISO','status','createdAt','lastReminderISO'
    ]);
  }
  return ss.getActiveSheet();
}
function generateId(prefix){
  return prefix + '-' + Utilities.getUuid();
}

/**
 * Helper function to extract a valid Google Drive ID (file or folder) from a URL.
 * @param {string} urlOrId The URL or ID string.
 * @returns {string} The extracted Google Drive ID or null if invalid.
 */
function extractDriveId(urlOrId) {
  if (!urlOrId) return null;
  const match = urlOrId.match(/[-\w]{25,}/);
  return match ? match[0] : null;
}

/* ---------- Web App (HTML serve) ---------- */
function doGet(e) {
  // Check if this is an email/web fallback check-in request
  if (e.parameter.vaultId && e.parameter.email && e.parameter.action === 'checkin') {
    return handleWebCheckin(e);
  }
  
  // Default: serve simple HTML form for onboarding
  const html = HtmlService.createTemplateFromFile('onboard').evaluate()
    .setTitle('Secret Keeper - Create Vault');
  return html;
}

/**
 * Handles web-based check-in request (used for email fallback link).
 */
function handleWebCheckin(e) {
  const vaultId = e.parameter.vaultId;
  const ownerEmail = decodeURIComponent(e.parameter.email);
  
  const result = checkinVault(vaultId, ownerEmail);
  
  if (result.ok) {
    return HtmlService.createHtmlOutput(
      `<div style="font-family: Arial, sans-serif; padding: 30px; text-align: center; background-color: #f7f9fc; border-radius: 8px; max-width: 400px; margin: 50px auto; box-shadow: 0 4px 8px rgba(0,0,0,0.1);">
         <h1 style="color: #38a169; font-size: 24px;">✅ Check-in สำเร็จ!</h1>
         <p style="color: #4a5568; margin-top: 15px;">Vault ID: <strong style="word-break: break-all;">${vaultId}</strong> ได้รับการต่ออายุเรียบร้อยแล้ว</p>
         <p style="color: #718096; font-size: 14px; margin-top: 20px;">คุณสามารถปิดหน้านี้ได้ทันที</p>
       </div>`
    ).setTitle('Check-in Success');
  } else {
    return HtmlService.createHtmlOutput(
      `<div style="font-family: Arial, sans-serif; padding: 30px; text-align: center; background-color: #f7f9fc; border-radius: 8px; max-width: 400px; margin: 50px auto; box-shadow: 0 4px 8px rgba(0,0,0,0.1);">
         <h1 style="color: #e53e3e; font-size: 24px;">❌ Check-in ล้มเหลว</h1>
         <p style="color: #4a5568; margin-top: 15px;">Vault ID: <strong style="word-break: break-all;">${vaultId}</strong></p>
         <p style="color: #e53e3e; font-weight: bold;">สาเหตุ: ${result.error}</p>
         <p style="color: #718096; font-size: 14px; margin-top: 20px;">กรุณาตรวจสอบ Vault Index หรือติดต่อผู้ดูแลระบบ</p>
       </div>`
    ).setTitle('Check-in Failed');
  }
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
  
  // FIX: ตรวจสอบว่า Line ID ใน Properties ตรงกับผู้ใช้ปัจจุบันหรือไม่
  const ownerLineIdFromProps = getScriptProps().getProperty('LINE_user_ID');
  
  if (userId !== ownerLineIdFromProps) {
      replyLine(replyToken, 'ขออภัย ระบบนี้อนุญาตให้เฉพาะเจ้าของบัญชีหลักเท่านั้นที่ใช้งานได้');
      return;
  }
  
  const input = text.toLowerCase().trim();

  // 1. ตรวจสอบสถานะ Vaults
  const activeVaults = data.filter(row => row[2] === userId && row[10] === 'ACTIVE');
  
  if (input === 'register' || input === 'create') {
    // 1.1 ถ้ามี Vault ACTIVE อยู่แล้ว: แนะนำคำสั่ง create
    if (activeVaults.length > 0 && input === 'register') {
      const alreadyFlex = createAlreadyRegisteredFlex(activeVaults.length, webAppUrl);
      replyFlex(replyToken, alreadyFlex);
      return;
    }

    // 1.2 ถ้าพิมพ์ register (และยังไม่มี ACTIVE) หรือพิมพ์ create: ส่ง Flex Message ให้ลงทะเบียน
    const onboardUrl = `${webAppUrl}?ownerLineId=${userId}`;
    const registerFlex = createRegisterFlex(onboardUrl);
    // Use reply if triggered by user message, or push as before if preferred
    replyFlex(replyToken, registerFlex);
    
  } else if (input === 'checkin') {
    // 2. คำสั่ง checkin (LINE: Checkin ALL active vaults)
    checkinByLineId(userId);
    replyLine(replyToken, 'เช็กอินสำเร็จ! Vault ของคุณถูกต่ออายุแล้ว');
    
  } else if (input === 'list') {
    // 3. คำสั่ง list (ใหม่)
    if (activeVaults.length === 0) {
      const defaultFlex = createDefaultFlex(webAppUrl);
      replyFlex(replyToken, defaultFlex);
      return;
    }
    const listFlex = createListFlex(activeVaults);
    replyFlex(replyToken, listFlex);

  } else if (input === 'deactivate') {
    // 4. คำสั่ง deactivate (ใหม่)
    if (activeVaults.length === 0) {
      replyLine(replyToken, 'คุณไม่มี Vault ที่สามารถยกเลิกได้');
      return;
    }
    // ใช้ Flex Message เพื่อให้เลือก Vault ที่ต้องการยกเลิก
    const flexMsg = createDeactivationFlex(activeVaults);
  replyFlex(replyToken, flexMsg);

  } else {
    // 5. ข้อความอื่น ๆ -> Show default Flex with quick actions
    const defaultFlex = createDefaultFlex(webAppUrl);
    replyFlex(replyToken, defaultFlex);
  }
}

function handlePostback(userId, replyToken, data) {
  if (data === 'action=checkin') {
    checkinByLineId(userId); // LINE: Checkin ALL active vaults
    replyLine(replyToken, 'เช็กอินสำเร็จ! Vault ของคุณถูกต่ออายุแล้ว');
    return;
  } else if (data === 'action=list') {
    // Return the active vaults list as a Flex message when user taps the 'List' postback button
    const sh = getSheet();
    const allData = sh.getDataRange().getValues();
    const activeVaults = allData.filter(row => row[2] === userId && row[10] === 'ACTIVE');
    if (activeVaults.length === 0) {
      const webAppUrl = getScriptProps().getProperty('BASE_WEBAPP_URL');
      replyFlex(replyToken, createDefaultFlex(webAppUrl));
    } else {
      replyFlex(replyToken, createListFlex(activeVaults));
    }
    return;
  } else if (data.startsWith('action=deactivate&vaultId=')) {
    const vaultId = data.split('=')[2];
    deactivateVault(vaultId, userId);
    replyLine(replyToken, `✅ Vault ID: ${vaultId} ถูกยกเลิก (DEACTIVATED) เรียบร้อยแล้ว`);
  }
}

function deactivateVault(vaultId, ownerLineId) {
  const sh = getSheet();
  const data = sh.getDataRange().getValues();
  
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    // Index 2: ownerLineId, Index 10: status
    if (row[0] === vaultId && row[2] === ownerLineId && row[10] === 'ACTIVE') {
      sh.getRange(r + 1, 11).setValue('DEACTIVATED'); // update status (Col 11)
      Logger.log(`Vault ${vaultId} manually DEACTIVATED by ${ownerLineId}`);
      return true;
    }
  }
  Logger.log(`Deactivation failed: Vault ${vaultId} not found or not ACTIVE for Line ID: ${ownerLineId}`);
  return false;
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

/**
 * Reply with a Flex (or other structured) message using replyToken.
 * messageObject should be a valid LINE message object (e.g. { type: 'flex', altText: '...', contents: {...} })
 */
function replyFlex(replyToken, messageObject) {
  const token = getScriptProps().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    Logger.log('LINE token missing for reply (flex)');
    return;
  }
  const payload = {
    replyToken: replyToken,
    messages: [messageObject]
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

/**
 * Check-in function for LINE (updates ALL active vaults for the given Line ID).
 */
function checkinByLineId(lineId) {
  const sh = getSheet();
  const data = sh.getDataRange().getValues();
  const nowISO = new Date().toISOString();
  
  // Index 10: status, Index 9: lastCheckinISO, Index 12: lastReminderISO
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    // Check by Line ID and ensure status is ACTIVE
    if (row[2] === lineId && row[10] === 'ACTIVE') {
      sh.getRange(r + 1, 10).setValue(nowISO); // update lastCheckinISO (Col 10)
      sh.getRange(r + 1, 13).setValue('');    // clear lastReminderISO (Col 13)
      Logger.log(`Vault ${row[0]} checked in by LINE ID: ${lineId}. LastCheckin updated to ${nowISO}`);
      // ไม่ return เพื่อให้เช็กอินทุก Vault ที่เป็น ACTIVE
    }
  }
  // No explicit message for checkin failed since line bot handles success message
}

/**
 * Check-in function for Web/Email Fallback (updates a SINGLE specific vault).
 * @param {string} vaultId 
 * @param {string} ownerEmail 
 * @returns {Object} {ok: boolean, error: string}
 */
function checkinVault(vaultId, ownerEmail) {
  const sh = getSheet();
  const data = sh.getDataRange().getValues();
  const nowISO = new Date().toISOString();
  
  // Index mapping
  // 0:vaultId, 1:ownerEmail, 10:status, 9:lastCheckinISO, 12:lastReminderISO
  
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (row[0] === vaultId) {
      if (row[1] !== ownerEmail) {
         Logger.log(`Security alert: Attempted checkin on ${vaultId} with wrong email ${ownerEmail}`);
         return { ok: false, error: 'Email verification failed: Owner email mismatch.' };
      }
      if (row[10] === 'ACTIVE') {
         sh.getRange(r + 1, 10).setValue(nowISO); // update lastCheckinISO (Col 10)
         sh.getRange(r + 1, 13).setValue('');    // clear lastReminderISO (Col 13)
         Logger.log(`Vault ${vaultId} checked in via Web/Email by ${ownerEmail}. LastCheckin updated to ${nowISO}`);
         return { ok: true };
      } else {
         return { ok: false, error: `Vault Status is ${row[10]}. Cannot check-in.` };
      }
    }
  }
  return { ok: false, error: 'Vault ID not found.' };
}


function submitVault(data) {
  const sh = getSheet();
  const nowISO = new Date().toISOString();
  
  const ownerLineIdFromProps = getScriptProps().getProperty('LINE_user_ID');
  
  if (!ownerLineIdFromProps) {
      Logger.log('ERROR: LINE_user_ID is missing in Script Properties. Please set it.');
      return { ok: false, error: 'LINE_user_ID is missing. Cannot create Vault.' };
  }
  
  // 1. Create Google Doc
  const doc = DocumentApp.create(data.vaultTitle || 'Untitled Secret Vault');
  doc.getBody().setText(data.secretContent || 'No content provided.');
  const docId = doc.getId();
  const docUrl = doc.getUrl();
  
  // 2. Validate and get Files/Folder ID
  let filesFolderId = '';
  let filesFolderUrl = '';

  if (data.filesFolderUrlOrId) {
    const potentialId = extractDriveId(data.filesFolderUrlOrId);
    if (potentialId) {
      try {
        const resource = DriveApp.getFileById(potentialId) || DriveApp.getFolderById(potentialId);
        filesFolderId = resource.getId();
        filesFolderUrl = resource.getUrl();
      } catch (e) {
        Logger.log('Error validating Drive ID/URL: ' + e.message);
        return { ok: false, error: 'Invalid Drive File/Folder ID or URL. Please ensure it is accessible.' };
      }
    }
  }

  // 3. Record metadata in Sheet
  const newRow = [
    generateId('VAULT'),
    Session.getActiveUser().getEmail(), // ownerEmail (GAS deployer)
    ownerLineIdFromProps,
    docId,
    docUrl,
    filesFolderId, // Files/Folder ID
    data.trusteesCSV,
    Number(data.checkinDays) || 30,
    Number(data.graceHours) || 12,
    nowISO, // lastCheckinISO (current time)
    'ACTIVE', // status
    nowISO, // createdAt
    '' // lastReminderISO (empty)
  ];
  
  sh.appendRow(newRow);
  Logger.log(`New Vault created: ${newRow[0]}. Doc URL: ${docUrl}, Folder ID: ${filesFolderId}`);

  return { ok: true, docUrl: docUrl, filesFolderUrl: filesFolderUrl };
}

/* ---------- LINE Message Builders and Utils (UPDATED: Added createRegisterFlex) ---------- */

/**
 * Creates a Flex Message for initiating vault registration via Web App.
 * @param {string} url The Web App URL for registration.
 * @returns {Object} Line Flex Message object.
 */
function createRegisterFlex(url) {
  return {
    type: "flex",
    altText: "Secret Keeper: สร้าง Vault ใหม่",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "🔒 Secret Keeper",
            weight: "bold",
            size: "lg",
            color: "#FFFFFF",
            align: "center"
          }
        ],
        backgroundColor: "#1e293b",
        paddingAll: "12px"
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "สร้าง Vault ใหม่",
            weight: "bold",
            size: "md"
          },
          {
            type: "text",
            text: "กดปุ่มด้านล่างเพื่อไปยังหน้าเว็บแอปและกรอกรายละเอียด Vault รวมถึง Trusted Contacts",
            wrap: true,
            margin: "md",
            color: "#4a5568",
            size: "sm"
          },
          {
            type: "separator",
            margin: "md"
          },
          {
            type: "button",
            style: "primary",
            color: "#00B900",
            margin: "md",
            action: {
              type: "uri",
              label: "✨ สร้าง Vault ใหม่",
              uri: url
            }
          },
          {
            type: "text",
            text: "หมายเหตุ: อาจต้องให้สิทธิ์ Google เมื่อเปิดหน้าเว็บครั้งแรก",
            wrap: true,
            size: "xxs",
            color: "#a0aec0",
            margin: "md"
          }
        ],
        spacing: "md",
        paddingAll: "12px"
      }
    }
  }
}

/**
 * Flex shown when user already has active vault(s) and tries to register
 */
function createAlreadyRegisteredFlex(activeCount, webAppUrl) {
  return {
    type: 'flex',
    altText: 'คุณมี Vault อยู่แล้ว',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: '📌 Vault ที่มีอยู่', weight: 'bold', color: '#FFFFFF', align: 'center' }],
        backgroundColor: '#0b74de',
        paddingAll: '12px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: `คุณมี Vault ที่เปิดใช้งานอยู่ ${activeCount} รายการ`, weight: 'bold', size: 'md' },
          { type: 'text', text: 'คุณสามารถสร้าง Vault ใหม่หรือดูรายการ Vault ปัจจุบันได้โดยกดปุ่มด้านล่าง', wrap: true, margin: 'md', color: '#4a5568', size: 'sm' }
        ],
        spacing: 'md',
        paddingAll: '12px'
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#00B900', action: { type: 'uri', label: 'สร้างใหม่', uri: webAppUrl } },
          { type: 'button', style: 'secondary', action: { type: 'postback', label: 'รายการ Vault', data: 'action=list', displayText: 'list' } }
        ],
        paddingAll: '12px'
      }
    }
  };
}

/**
 * Flex to list active vaults with a Deactivate action per item
 */
function createListFlex(activeVaults) {
  const items = activeVaults.slice(0, 12).map((row, idx) => {
    const vaultId = row[0];
    const docUrl = row[4] || '';
    const title = `Vault ${idx + 1}`;
    return {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: title, weight: 'bold', size: 'sm', flex: 2 },
        { type: 'text', text: vaultId, size: 'sm', flex: 3, color: '#4a5568' },
        {
          type: 'button',
          style: 'secondary',
          action: { type: 'postback', label: 'ยกเลิก', data: `action=deactivate&vaultId=${vaultId}`, displayText: `ยกเลิก ${vaultId}` },
          flex: 2
        }
      ],
      spacing: 'sm',
      margin: 'sm'
    };
  });

  return {
    type: 'flex',
    altText: 'รายการ Vault ของคุณ',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '📚 รายการ Vault', size: 'xl', weight: 'bold', color: '#FFFFFF' }], backgroundColor: '#1f2937', paddingAll: '12px' },
      body: { type: 'box', layout: 'vertical', contents: items, spacing: 'md', paddingAll: '12px' }
    }
  };
}

/**
 * Default Flex shown for unknown messages, with quick actions: register, checkin, list
 */
function createDefaultFlex(webAppUrl) {
  return {
    type: 'flex',
    altText: 'Secret Keeper - เมนูหลัก',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '🔏 Secret Keeper', size: 'xl', weight: 'bold', color: '#FFFFFF', align: 'center' }], backgroundColor: '#0f172a', paddingAll: '12px' },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: 'ยินดีต้อนรับสู่ Secret Keeper', weight: 'bold', size: 'lg' },
          { type: 'text', text: 'เลือกเมนูที่ต้องการ:', wrap: true, margin: 'md', color: '#4a5568', size: 'sm' },
          { type: 'separator', margin: 'md' }
        ],
        spacing: 'md',
        paddingAll: '12px'
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#00B900', action: { type: 'uri', label: 'Register', uri: webAppUrl } },
          { type: 'button', style: 'secondary', action: { type: 'postback', label: 'Check-in', data: 'action=checkin', displayText: 'ฉันยังอยู่ (Check In)' } },
          { type: 'button', style: 'secondary', action: { type: 'postback', label: 'List', data: 'action=list', displayText: 'ขอดูรายการ Vault' } }
        ],
        paddingAll: '12px'
      }
    }
  };
}

function createCheckinReminderFlex(checkinDays, graceHours, sheetUrl) {
  return {
    type: "flex",
    altText: "Secret Keeper: Reminder Check-in",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "⚠️ แจ้งเตือนเช็กอิน ⚠️",
            weight: "bold",
            size: "xl",
            align: "center",
            color: "#FFFFFF"
          }
        ],
        backgroundColor: "#d32f2f",
        paddingAll: "20px"
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: `ไม่พบการเช็กอินของคุณ\nมานาน ${checkinDays} วัน`,
            wrap: true,
            margin: "md",
            align: "center",
            size: "lg"
          },
          {
            type: "text",
            text: `กรุณากด "ยังอยู่" ภายใน ${graceHours} ชั่วโมง ก่อนที่ระบบจะเผยแพร่เอกสารของคุณให้กับ Trusted Contacts`,
            wrap: true,
            color: "#e84e4e",
            size: "md",
            margin: "md",
            align: "center"
          }
        ],
        spacing: "md",
        paddingAll: "20px"
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
              label: "👍 ฉันยังอยู่ (Check In)",
              data: "action=checkin", // This data is handled by handlePostback
              displayText: "ฉันยังอยู่ (Check In)"
            },
            height: "sm"
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "uri",
              label: "เปิดดู/แก้ไข เอกสาร",
              uri: sheetUrl // ใช้ URL ที่รับมา
            },
            height: "sm"
          }
        ]
      },
      styles: {
        body: {
          backgroundColor: "#fff7f7"
        },
        footer: {
          separator: true
        }
      }
    }
  };
}

/**
 * Creates a Flex Message for selecting a vault to deactivate.
 * @param {Array<Array<any>>} activeVaults Array of active vault rows.
 * @returns {Object} Line Flex Message object.
 */
function createDeactivationFlex(activeVaults) {
    const buttons = activeVaults.slice(0, 10).map((row, index) => { // Limit to 10 buttons (LINE constraint)
        const vaultId = row[0];
        const vaultTitle = row[3]; // docId (approximate title) - Should ideally use the doc name
        return {
            type: "button",
            style: "secondary",
            action: {
                type: "postback",
                label: `ยกเลิก: ${vaultTitle.substring(0, 20)}...`,
                data: `action=deactivate&vaultId=${vaultId}`,
                displayText: `ต้องการยกเลิก Vault ID: ${vaultId}`
            }
        };
    });

    const bodyContents = [
        {
            type: "text",
            text: "🔒 เลือก Vault ที่ต้องการยกเลิก",
            weight: "bold",
            size: "md"
        },
        {
            type: "text",
            text: "การยกเลิกจะเปลี่ยนสถานะเป็น DEACTIVATED และ Vault นั้นจะไม่ถูกตรวจสอบอีกต่อไป",
            wrap: true,
            size: "sm",
            margin: "md"
        }
    ];

    return {
        type: "flex",
        altText: "Secret Keeper: Deactivate Vault",
        contents: {
            type: "bubble",
            body: {
                type: "box",
                layout: "vertical",
                contents: bodyContents
            },
            footer: {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                contents: buttons
            }
        }
    };
}


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


/* ---------- Scheduler: daily check ---------- */
function scheduledCheck() {
  const sh = getSheet();
  const props = getScriptProps();
  const data = sh.getDataRange().getValues();
  const now = new Date();
  const webAppUrl = props.getProperty('BASE_WEBAPP_URL');
  
  // *** NEW: Get Sender Name from Script Properties ***
  const SENDER_NAME = props.getProperty('EMAIL_SENDER_NAME') || 'Secret Keeper Default Sender'; 

  // Index mapping
  // 0:vaultId, 1:ownerEmail, 2:ownerLineId, 3:docId, 4:docUrl, 5:filesFolderId, 
  // 6:trustees, 7:checkinDays, 8:graceHours, 9:lastCheckinISO, 10:status, 11:createdAt, 12:lastReminderISO

  for (let r = 1; r < data.length; r++) {
    try {
      const row = data[r];
      const vaultId = row[0];
      const ownerEmail = row[1];
      const ownerLineId = row[2];
      const docId = row[3];
      const docUrl = row[4];
      const filesFolderId = row[5]; 
      const trusteesCSV = row[6] || '';
      const checkinDays = Number(row[7]) || 30;
      const graceHours = Number(row[8]) || 12;
      const lastCheckinISO = row[9];
      const status = row[10]; // Status is at index 10
      const lastReminderISO = row[12];
      
      if (status !== 'ACTIVE') continue;

      const lastCheckin = lastCheckinISO ? new Date(lastCheckinISO) : new Date(row[11]);
      const lastReminderTime = lastReminderISO ? new Date(lastReminderISO) : new Date(0);
      
      const millisThreshold = checkinDays * 24 * 60 * 60 * 1000;
      const millisGrace = graceHours * 60 * 60 * 1000;
      
      const checkinDeadlineTime = new Date(lastCheckin.getTime() + millisThreshold);
      const activationTime = new Date(lastCheckin.getTime() + millisThreshold + millisGrace);
      
      const overdue = now >= checkinDeadlineTime;
      const fullyOverdue = now >= activationTime;
      
      const ssUrl = sh.getParent().getUrl(); 

      if (fullyOverdue) {
        // --- ACTIVATE VAULT (GRACE PERIOD PASSED) ---
        
        const trustees = trusteesCSV.split(',').map(s => s.trim()).filter(Boolean);
        let filesUrl = '';
        
        if (trustees.length > 0) {
          // 1. Share Google Doc
          DriveApp.getFileById(docId).addEditors(trustees);
          
          // 2. Share Attachment Folder/File (if exists)
          if (filesFolderId) {
            try {
              // Try to treat it as a Folder
              const folder = DriveApp.getFolderById(filesFolderId);
              folder.addEditors(trustees); // Share the entire folder
              filesUrl = folder.getUrl();
            } catch (e) {
              try {
                // If not a folder, try to treat it as a single File
                const file = DriveApp.getFileById(filesFolderId);
                file.addEditors(trustees); // Share the single file
                filesUrl = file.getUrl();
              } catch (e) {
                Logger.log(`ERROR: Could not find or share Drive resource ${filesFolderId}: ${e.message}`);
                filesUrl = 'Error: Resource not found/shared.';
              }
            }
          }
          
          // 3. Send Email to Trustees
          let body = `ระบบ Secret Keeper (ระบบจัดส่งเอกสารสั่งเสีย/สั่งลา) ได้เปิดเผยเอกสารตามเงื่อนไขที่ตั้งไว้โดยเจ้าของ (Vault ID: ${vaultId}).\n\n`;
          body += `คุณสามารถเข้าดูที่ผู้สั่งเสียต้องการตาม **เอกสารข้อความหลัก** ได้ที่:\n${docUrl}\n\n`;
          if (filesUrl && !filesUrl.startsWith('Error')) {
            body += `**ไฟล์แนบทั้งหมด (PDF, VDO, รูปถ่าย, ฯลฯ)** อยู่ที่นี่:\n${filesUrl}\n\n`;
          } else if (filesFolderId) {
             // Fallback to URL in case sharing failed but ID is present
             body += `**ไฟล์แนบทั้งหมด (PDF, VDO, รูปถ่าย, ฯลฯ)** อยู่ที่นี่ (อาจต้องขอสิทธิ์เข้าถึง):\nhttps://drive.google.com/open?id=${filesFolderId}\n\n`;
          }
          body += `กฎหมายพินัยกรรมไทยกำหนดให้พินัยกรรมต้องเป็นเอกสารลายมือหรือเอกสารตามกฏหมายเท่านั้น \nไม่ได้ยอมรับวิดีโอหรือไฟล์ดิจิทัลเป็นรูปแบบพินัยกรรมที่ถูกต้องตามกฎหมาย`;

          const subject = `Secret Keeper (ระบบจัดส่งเอกสารสั่งเสีย/สั่งลา) - from ${ownerEmail || 'A'} is activated`;
          
          // *** UPDATED: Use SENDER_NAME from properties ***
          trustees.forEach(t => {
            try { 
              GmailApp.sendEmail(t, subject, body, { name: SENDER_NAME });
              Logger.log(`Email sent to Trustee: ${t} with sender name: ${SENDER_NAME}`);
            } catch(e){ 
              Logger.log('send mail err to ' + t + ': ' + e); 
            }
          });
        }
        
        // update status
        sh.getRange(r+1, 11).setValue('ACTIVATED'); // Status is at Column 11
        Logger.log(`STATUS: Vault ${vaultId} marked as ACTIVATED.`);
        
      } else if (overdue) {
        // --- SEND REMINDER (DEADLINE PASSED, STILL IN GRACE) ---
        const millisSinceLastReminder = now.getTime() - lastReminderTime.getTime();
        const reminderInterval = 24 * 60 * 60 * 1000; // 24 hours
        
        if (millisSinceLastReminder > reminderInterval) {
          
          // 1. Primary Reminder: LINE Flex Message
          if (ownerLineId) {
            const flexMsg = createCheckinReminderFlex(checkinDays, graceHours, ssUrl); 
            sendLinePush(ownerLineId, flexMsg); // send Flex Message object
            Logger.log(`LINE Flex Reminder sent for ${vaultId}`);
          }
          
          // 2. Fallback/Secondary Reminder: Email with Web Check-in Link
          if (ownerEmail) {
            // Construct the secure, vault-specific check-in URL
            const checkinUrl = `${webAppUrl}?action=checkin&vaultId=${vaultId}&email=${encodeURIComponent(ownerEmail)}`;
            
            let emailBody = `ระบบ Secret Keeper (จัดส่งเอกสารสั่งเสีย/สั่งลา) ไม่พบการเช็กอินของคุณสำหรับ Vault ID: ${vaultId} เป็นเวลา ${checkinDays} วัน\n\n`;
            emailBody += `⚠️ นี่คือการแจ้งเตือนฉุกเฉิน กรุณากดลิงก์ด้านล่างเพื่อยืนยันตัวตนของคุณภายใน **${graceHours} ชั่วโมง** ก่อนที่เอกสารความลับจะถูกเปิดเผยก่อนเวลาอันควร:\n\n`;
            emailBody += `🔗 ลิงก์ยืนยันตัวตน (Proof-of-Life) คลิก:\n${checkinUrl}\n\n`;
            emailBody += `(ลิงก์นี้ใช้ได้แม้ว่า LINE OA จะมีปัญหา หรือคุณไม่สะดวกเข้า LINE)\n\n---`;

            const subject = `SECRET KEEPER: Emergency Check-in Reminder for Vault ${vaultId}`;
            // *** UPDATED: Use SENDER_NAME from properties ***
            GmailApp.sendEmail(ownerEmail, subject, emailBody, { name: SENDER_NAME });
            Logger.log(`Email Check-in Fallback sent for ${vaultId} with sender name: ${SENDER_NAME}`);
          }

          sh.getRange(r+1, 13).setValue(new Date().toISOString()); // set lastReminderISO (Col 13)
        }
      }
      
    } catch(err) {
      Logger.log('scheduledCheck row err on row ' + (r+1) + ': ' + err.message);
    }
  }
}

/* ---------- Admin utility: list vaults (for debugging) ---------- */
function listVaults() {
  const sh = getSheet();
  const data = sh.getDataRange().getValues();
  const out = [];
  // Index 10: status
  for (let r = 1; r < data.length; r++){
    out.push({
      vaultId: data[r][0],
      status: data[r][10], 
      ownerLineId: data[r][2]
    });
  }
  Logger.log(JSON.stringify(out, null, 2));
}

function checkinByOwner(ownerLineId) {
  checkinByLineId(ownerLineId);
}
