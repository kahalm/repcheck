#!/usr/bin/env node
// Prueft NUR die Chrome-Web-Store-Anmeldung (ohne Upload/Publish):
// tauscht refresh_token -> access_token und liest den Item-Status.
//
// Aufruf (Node 18+):
//   node extension/check-cws-auth.mjs <CLIENT_ID> <CLIENT_SECRET> <REFRESH_TOKEN> <APP_ID>
//
// Erfolg = OAuth + App-ID stimmen, die CI kann hochladen.

const [clientId, clientSecret, refreshToken, appId] = process.argv.slice(2);
if (!clientId || !clientSecret || !refreshToken || !appId) {
  console.error('Aufruf: node check-cws-auth.mjs <CLIENT_ID> <CLIENT_SECRET> <REFRESH_TOKEN> <APP_ID>');
  process.exit(1);
}

// 1) refresh_token -> access_token
const tokRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }),
});
const tok = await tokRes.json();
if (!tok.access_token) {
  console.error('❌ Token-Refresh fehlgeschlagen:', tok);
  process.exit(1);
}
console.log('✅ refresh_token gueltig — access_token erhalten.');

// 2) Item-Status lesen (kein Schreibzugriff)
const itemRes = await fetch(
  `https://www.googleapis.com/chromewebstore/v1.1/items/${appId}?projection=DRAFT`,
  { headers: { Authorization: `Bearer ${tok.access_token}`, 'x-goog-api-version': '2' } }
);
const item = await itemRes.json();
if (!itemRes.ok) {
  console.error(`❌ Item-Abruf fehlgeschlagen (HTTP ${itemRes.status}):`, item);
  console.error('   App-ID falsch, oder Item gehoert nicht zu diesem Google-Konto?');
  process.exit(1);
}
console.log('✅ App-ID erreichbar:', JSON.stringify(item));
console.log('\nAlles gruen — die CI kann beim naechsten Tag hochladen.');
