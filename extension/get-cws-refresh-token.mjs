#!/usr/bin/env node
// Erzeugt EINMALIG den Chrome-Web-Store refresh_token fuer die CI.
//
// Voraussetzungen:
//   1. Google-Cloud-Projekt mit aktivierter "Chrome Web Store API".
//   2. OAuth-2.0-Client vom Typ "Desktop app" → liefert client_id + client_secret.
//      Dabei MUSS bei "Authorized redirect URIs" http://localhost:8976 stehen
//      (Desktop-Clients akzeptieren localhost-Loopback; OOB ist abgekuendigt).
//
// Aufruf (Node 18+, keine Dependencies noetig):
//   node extension/get-cws-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
//
// Der Browser oeffnet die Google-Zustimmung; nach "Zulassen" faengt das Skript
// den Code auf localhost:8976 ab, tauscht ihn und gibt den refresh_token aus.
// Diesen + client_id/secret + die Extension-App-ID als GitHub-Secrets ablegen:
//   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_APP_ID

import http from 'node:http';
import { exec } from 'node:child_process';

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error('Aufruf: node get-cws-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

const PORT = 8976;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const authUrl =
  'https://accounts.google.com/o/oauth2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // erzwingt, dass ein refresh_token zurueckkommt
  }).toString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('Kein code im Callback.');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Fertig — du kannst dieses Tab schliessen und ins Terminal zurueck.');
  server.close();

  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const data = await resp.json();
    if (!data.refresh_token) {
      console.error('\nKein refresh_token erhalten. Antwort:', data);
      console.error('Tipp: OAuth-Consent ggf. unter myaccount.google.com/permissions');
      console.error('widerrufen und neu durchlaufen (prompt=consent ist gesetzt).');
      process.exit(1);
    }
    console.log('\n=== Als GitHub-Secrets eintragen ===');
    console.log('CWS_REFRESH_TOKEN =', data.refresh_token);
    console.log('CWS_CLIENT_ID     =', clientId);
    console.log('CWS_CLIENT_SECRET =', clientSecret);
    console.log('\n(CWS_APP_ID = die Extension-ID aus der Store-URL separat ergaenzen.)');
    process.exit(0);
  } catch (e) {
    console.error('Token-Tausch fehlgeschlagen:', e);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('Oeffne im Browser (falls er nicht automatisch aufgeht):\n');
  console.log(authUrl, '\n');
  const opener =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${opener} "${authUrl}"`, () => {});
});
