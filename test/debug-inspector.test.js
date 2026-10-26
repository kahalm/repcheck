'use strict';

// Debug-Inspector (debug/chessable-inspector.user.js, S1-014): der Dump wandert zum Entwickler. Die Datenschutz-Helfer
// stehen als reiner Block im Userscript (Tampermonkey kennt kein require) und werden hier per Anker herausgeschnitten.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'debug', 'chessable-inspector.user.js'), 'utf8');
const VON = '// ── Datenschutz: nichts Geheimes in den Dump';
const BIS = '// ── Brett-Anker';

function helfer() {
  const a = SRC.indexOf(VON);
  const b = SRC.indexOf(BIS, a);
  assert.ok(a >= 0 && b > a, 'Datenschutz-Block im Inspector nicht gefunden');
  // eslint-disable-next-line no-new-func
  return new Function(SRC.slice(a, b) + '\nreturn { zensiereText, recorderErlaubt, recorderEintrag };')();
}

test('zensiereText: JWT, E-Mail- und IP-Adressen raus, Uhrzeiten bleiben', () => {
  const { zensiereText } = helfer();
  const s = zensiereText('{"email":"felix@example.com","ip":"203.0.113.7","v6":"2a02:8388:1:2::1","t":"08:56:57",'
    + '"jwt":"abcdefghijklmn.opqrstuvwxyzab.cdefghijklmnop"}');
  assert.ok(!s.includes('felix@example.com') && !s.includes('203.0.113.7') && !s.includes('2a02:8388'));
  assert.ok(!s.includes('abcdefghijklmn.opqrstuvwxyzab'));
  assert.ok(s.includes('[email]') && s.includes('[ip]') && s.includes('08:56:57'));
});

test('Netzwerk-Mitschnitt: nur getCourse/getList/getGame/getReview mit Körper', () => {
  const { recorderErlaubt } = helfer();
  for (const u of ['https://www.chessable.com/api/v1/getCourse?bid=1', '/api/v1/getList?lid=2',
    'https://chessable.com/api/v1/getGame?oid=3', '/api/v1/getReview']) {
    assert.equal(recorderErlaubt(u), true, u);
  }
  for (const u of ['https://www.chessable.com/api/v1/getUser', '/api/v1/getProfile?uid=1',
    'https://www.chessable.com/api/v1/account/settings', 'https://other.example/getCourse']) {
    assert.equal(recorderErlaubt(u), false, u);
  }
});

test('Netzwerk-Eintrag: fremde Endpunkte nur mit Pfad, ohne Query und Körper', () => {
  const { recorderEintrag } = helfer();
  const fremd = recorderEintrag('GET', 'https://www.chessable.com/api/v1/getUser?email=felix@example.com', '{"email":"felix@example.com"}');
  assert.equal(fremd.koerper, null);
  assert.ok(!JSON.stringify(fremd).includes('felix@example.com'));
  assert.equal(fremd.url, 'https://www.chessable.com/api/v1/getUser');
  const ok = recorderEintrag('GET', '/api/v1/getGame?oid=3', '{"game":{"by":"a@b.de"}}');
  assert.ok(ok.koerper.includes('"game"') && !ok.koerper.includes('a@b.de'));
  assert.equal(recorderEintrag('GET', 'https://cdn.example/x.js', 'x'), null);
  assert.equal(recorderEintrag('GET', '/static/app.js', 'x'), null);
});
