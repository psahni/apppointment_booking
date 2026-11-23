# WhatsApp Booking Test Setup

Use Meta’s test sender as the clinic and your verified WhatsApp number as the patient. The setup was verified when a fresh **Hi** returned the booking menu.

## Local setup

1. On `feat/whatsapp-conversational-booking`, start PostgreSQL with `pnpm db:local` if needed, apply migrations with `pnpm db:migrate`, and run `pnpm dev`. Check that port 3000 serves the booking app. In this test, Remotion initially occupied that port.
2. In Meta’s **Step 1. Try it out**, add your personal number as a verified recipient. Use the Meta test sender’s Phone Number ID for both `WHATSAPP_TEST_PHONE_NUMBER_ID` and `WHATSAPP_PHONE_NUMBER_ID`.
3. In `.env.local`, set `WHATSAPP_CONVERSATION_ENABLED=true`, the sender ID, `WHATSAPP_API_VERSION`, `WHATSAPP_ACCESS_TOKEN` from the test screen, and `WHATSAPP_APP_SECRET` from **App settings → Basic**. Generate `WHATSAPP_VERIFY_TOKEN` with `openssl rand -hex 24`. Use `LOCAL_AUTH_EMAIL_PREVIEW=true` and `AUTH_TEST_MODE=false` to get a generated code in `.local/email-preview.log`. Restart the app after editing the file.

## Webhook and test account

1. Run `cloudflared tunnel --url http://localhost:3000` and keep it running. Append `/api/webhooks/whatsapp` to the current HTTPS URL printed by Cloudflare.
2. In Meta, open **Connect on WhatsApp → Other tools → Tools → Configuration → Webhooks**. Enter the callback URL and the exact `WHATSAPP_VERIFY_TOKEN` from `.env.local`. Click **Verify and save**, then subscribe to `messages`.
3. Subscribe the Meta app to the **test WhatsApp Business Account** as well. For **AI Digest**, the request was `POST https://graph.facebook.com/v25.0/1419477520302012/subscribed_apps` with the app’s bearer token and an empty body. The account ID came from **Messaging account ID** on Meta’s test screen. [Meta’s account subscription instructions](https://www.postman.com/meta/whatsapp-business-platform/request/26gui66/subscribe-to-a-waba)

   Run this from the repo root to check the token’s app, make the same request if needed, and verify the subscription. It reads the token from `.env.local`.

   ```sh
   node --input-type=module <<'JS'
   import { readFileSync } from 'node:fs';
   import dotenv from 'dotenv';

   const { WHATSAPP_ACCESS_TOKEN } = dotenv.parse(readFileSync('.env.local'));
   const base = 'https://graph.facebook.com/v25.0';
   const appId = '1450208193913603';
   const path = '/1419477520302012/subscribed_apps';

   if (!WHATSAPP_ACCESS_TOKEN) throw new Error('Set WHATSAPP_ACCESS_TOKEN in .env.local.');

   async function request(path, method = 'GET') {
     const response = await fetch(base + path, {
       method,
       headers: { Authorization: 'Bearer ' + WHATSAPP_ACCESS_TOKEN },
       redirect: 'error',
       signal: AbortSignal.timeout(10_000),
     });
     const body = await response.json();
     if (!response.ok) {
       throw new Error(method + ' failed with HTTP ' + response.status + ', Meta code ' + (body.error?.code ?? 'unknown'));
     }
     return body;
   }

   const app = await request('/app?fields=id');
   if (app.id !== appId) throw new Error('The access token is for a different Meta app.');

   const isSubscribed = (result) =>
     result.data?.some((entry) => entry.whatsapp_business_api_data?.id === appId);

   if (!isSubscribed(await request(path))) {
     const result = await request(path, 'POST');
     if (result.success !== true) throw new Error('Meta did not confirm the subscription.');
   }
   if (!isSubscribed(await request(path))) throw new Error('AI Digest is missing from the subscription list.');
   console.log('AI Digest subscription verified.');
   JS
   ```

## Test and troubleshoot

Send **Hi** from the verified recipient number to Meta’s test sender. Expect the booking menu. To continue, choose **Book Appointment**, use synthetic patient details, enter the code from `.local/email-preview.log`, choose an open slot, and confirm. Check the chat and clinic agenda for the saved appointment.

- **HTTP 500 during verification.** The verify token was saved as `WHATS_VERIFY_TOKEN`. Correcting it to `WHATSAPP_VERIFY_TOKEN` made both localhost and the tunnel return HTTP 200 with the expected challenge.
- **Meta shows Hi but the app stays silent.** In this test, the callback and `messages` field were already active. The test account listed only Meta’s WA DevX app. Subscribing **AI Digest** to the test account fixed the missing reply.
