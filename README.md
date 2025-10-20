Secret Keeper
==============

Secret Keeper is a Google Apps Script + LINE Official Account (OA) integration that manages "vaults" (Google Docs + optional attachments) and automatically reveals them to trusted contacts if the owner fails to check in within a configured timeframe.

This repository contains:
- `secret_keeper.js` — the main Google Apps Script code (handles vault creation, scheduled checks, LINE webhook handlers, Flex message builders).
- `index.js` — an optional Node.js webhook adapter for use with Cloud Run/GCP when LINE webhook cannot directly hit GAS.
- `package.json` — for Cloud Run deployment.
- `onboard.html` — a simple form used by the webapp onboarding flow (deployed as GAS web app).

This README explains step-by-step setup for Google Apps Script (GAS) deployment and LINE OA configuration, and also documents an alternative: deploying `index.js` on Cloud Run to receive LINE webhooks and forward them to Apps Script or handle logic directly.

Target audience
---------------
This README is written for a developer or admin who will:
- Deploy Google Apps Script as a Web App.
- Configure a LINE Official Account (OA) and its webhook.
- Optionally deploy a Node.js webhook on Cloud Run when direct webhook to GAS is not reliable.

Prereqs
-------
- Google account with access to Google Drive, Google Sheets, Gmail, and Google Apps Script.
- LINE Official Account and access to the LINE Developers Console.
- (Optional for Cloud Run) Google Cloud project with billing enabled and gcloud installed, a Docker environment or ability to use Cloud Build.
- Node.js 16+ for local tests (if you use the Node webhook fallback).

Quick overview of flows
-----------------------
- Primary flow: GAS web app is deployed and used for 1) the onboarding HTML form (creating vaults), 2) the web fallback check-in link, and 3) scheduled checks. The LINE OA webhook events are handled by GAS `doPost` if you configure LINE webhook to the GAS web app URL.
- Fallback flow (if LINE webhook cannot reliably reach GAS): Deploy `index.js` on Cloud Run and point LINE webhook to Cloud Run. The Node webhook will forward events to the GAS web app or perform the same logic directly.

Important Script Properties (GAS)
---------------------------------
Before deploying GAS, set the following Script Properties (File > Project properties > Script properties or via code):
- `LINE_CHANNEL_ACCESS_TOKEN` — LINE channel access token (Messaging API).
- `LINE_CHANNEL_SECRET` — LINE channel secret (optional but recommended).
- `ADMIN_EMAIL` — admin email for notifications (optional).
- `BASE_WEBAPP_URL` — the public URL of your deployed GAS web app (set this after deployment).
- `LINE_user_ID` — the LINE userId of the primary account allowed to control the bot (optional, used as owner check).
- `EMAIL_SENDER_NAME` — friendly name to use when sending emails from GmailApp.

Step A — Deploy Google Apps Script (GAS)
----------------------------------------
1. Open the project
   - Go to script.google.com, create a new project, and paste the contents of `secret_keeper.js` and `onboard.html` (or use the Apps Script CLI to push files).

2. Set Script Properties
   - In Apps Script: File > Project properties > Script properties
   - Add the keys listed above. `BASE_WEBAPP_URL` can be set after you finish deployment.

3. Enable required Services
   - In the Apps Script editor: Services > Add a service
     - Drive API (if advanced access required), or simply enable DriveApp usage.
     - Gmail service (GmailApp) — used to send fallback emails.
     - SpreadsheetApp and DocumentApp are standard. If not present, add them.

4. Deploy Web App
   - Click Deploy > New deployment
   - Choose type: Web app
   - Execute as: Me (the owner) — so the script can access Drive/Gmail as needed
   - Who has access: Anyone (or Anyone with Google account) — because the onboarding link and LINE webhook calls must be able to reach it. If you restrict it too much LINE's webhook cannot call it.
   - Deploy and copy the Web App URL.
   - Paste the URL to Script Properties as `BASE_WEBAPP_URL`.

5. Set up Triggers (the code uses scheduledCheck)
   - In Apps Script: Triggers (clock icon) > Add Trigger
   - Choose `scheduledCheck` as the function to run, and set to run daily or as desired.

6. Testing the GAS endpoints
   - Open the `BASE_WEBAPP_URL` in browser to see the onboarding page.
   - Create a test vault via the onboarding page.

Step B — Configure LINE Official Account (OA)
--------------------------------------------
1. Create/Use a LINE OA in LINE Developers Console
   - Create a Provider and a Messaging API Channel.
   - Note these credentials: Channel Secret and Channel Access Token (long-lived token). Save them.

2. Set webhook URL
   - In LINE Developers > Messaging API > Webhook settings
   - Set the webhook URL to your GAS Web App URL (the one in `BASE_WEBAPP_URL`)
   - Example: `https://script.google.com/macros/s/{DEPLOY_ID}/exec`
   - Enable the webhook (Turn on).

3. Add webhook event handling permissions
   - In the Messaging API > settings, ensure the webhook is enabled and your bot is allowed to reply/push messages.

4. Script Properties
   - Add `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET` into the GAS Script Properties (so the GAS code can call LINE APIs).

5. Test from LINE
   - Using the LINE account set in `LINE_user_ID` (or invite the bot), send 'register', 'list', 'checkin', and confirm the bot replies.

Troubleshooting: LINE webhook cannot reach GAS
---------------------------------------------
- Google Apps Script web apps sometimes have issues accepting POST webhooks from external services due to header constraints, or if the web app is not set to allow access by anyone. If the LINE webhook fails to reach GAS reliably, use the Cloud Run fallback.

Step C — Cloud Run fallback (Node webhook)
------------------------------------------
If you cannot make LINE webhook reliably hit GAS, deploy `index.js` (this repo) as a Cloud Run service and point LINE webhook to it. The Node webhook can either:
- Forward events to the GAS web app (POST), or
- Implement the same logic as GAS (you can adapt `secret_keeper.js` into Node if necessary).

Files included for fallback
- `index.js` — an Express app that can accept LINE webhook events and forward to GAS or process them.
- `package.json` — dependencies and start script.

Basic Cloud Run deployment steps
1. Ensure `gcloud` is installed and authenticated.
2. Build and deploy:

```bash
# from repo root
gcloud builds submit --tag gcr.io/PROJECT-ID/secret-keeper-webhook
gcloud run deploy secret-keeper-webhook --image gcr.io/PROJECT-ID/secret-keeper-webhook --platform managed --region us-central1 --allow-unauthenticated
```

3. Set LINE webhook URL to the Cloud Run URL provided after deployment.

4. Environment variables for Node webhook
   - The Node webhook will need the same LINE credentials:
     - `LINE_CHANNEL_ACCESS_TOKEN`
     - `LINE_CHANNEL_SECRET`
   - If you forward events to GAS, set `GAS_WEBAPP_URL` (the `BASE_WEBAPP_URL`) so `index.js` can POST the events to GAS.

5. Testing Cloud Run webhook
   - Use ngrok locally or deploy to Cloud Run and set the webhook URL in LINE Developers.
   - Test by sending messages to your LINE OA and confirm Cloud Run logs receive events.

Security
--------
- Keep `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET` secret. Use the Apps Script Script Properties for GAS and environment variables or Secret Manager for Cloud Run.
- If you use Cloud Run, consider enabling authentication and using a verification token or signed forwarding to GAS.

Development notes & suggestions
-------------------------------
- Document vault schema: `VaultIndex` sheet columns are expected in this order:
  0. vaultId
  1. ownerEmail
  2. ownerLineId
  3. docId
  4. docUrl
  5. filesFolderId
  6. trustees
  7. checkinDays
  8. graceHours
  9. lastCheckinISO
 10. status
 11. createdAt
 12. lastReminderISO

- The code uses `LINE_user_ID` in Script Properties to restrict bot control. Remove this check if you want multiple users to interact with the bot.

- Flex messages: The repository includes Flex builders for Register, Reminder, Deactivate, List, and default actions. Postback actions are used for checkin and deactivate; URI actions open the onboarding page.

- Drive & Gmail permissions: The GAS project must be authorized to use Drive (to create/read docs, share with trustees) and Gmail (to send fallback emails).

Appendix — Example environment variables and Script Properties
-------------------------------------------------------------
Script Properties (GAS):
- LINE_CHANNEL_ACCESS_TOKEN=xxxxx
- LINE_CHANNEL_SECRET=xxxxx
- ADMIN_EMAIL=admin@example.com
- BASE_WEBAPP_URL=https://script.google.com/macros/s/DEPLOY_ID/exec
- LINE_user_ID=Uxxxxxxxxxxxx
- EMAIL_SENDER_NAME=Secret Keeper Bot

Cloud Run / Node env (example):
- LINE_CHANNEL_ACCESS_TOKEN=xxxxx
- LINE_CHANNEL_SECRET=xxxxx
- GAS_WEBAPP_URL=https://script.google.com/macros/s/DEPLOY_ID/exec

Contact / Maintainer
--------------------
If you need help getting this set up, provide your GAS deployment URL and LINE Developer console settings (do not share secrets). I can help verify the webhook and Flex payloads.
