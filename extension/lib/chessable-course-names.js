'use strict';
// Reine, testbare Spiegel-Logik für die Kursnamen-Auflösung über den Chessable-Bearer.
// Die Laufzeit-Kopien leben inline in extension/chessable-activity.js (isolierte Welt) und
// in repcheck.user.js (initChessableActivityTracking/-FenTools). Hier nur die zwei riskanten
// reinen Bausteine (JWT-uid-Decode + getHomeData-Shape-Parsing) für `node --test`.

// Base64url → String (Padding ergänzen). atob existiert in Node ≥16 global.
function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

// uid steckt im JWT-Payload unter user.uid (wie piratechess/JwtHelper). Gibt die uid als
// String zurück oder null (leerer/kaputter Token, fehlende uid).
function decodeChessableUid(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const o = JSON.parse(b64urlDecode(parts[1]));
    const uid = o && o.user && o.user.uid;
    return (uid != null && /^\d+$/.test(String(uid))) ? String(uid) : null;
  } catch (e) { return null; }
}

// getHomeData-Antwort → { bid(string): name }. Toleriert camelCase/PascalCase-Keys und
// numerische/String-bids; überspringt leere Namen; kappt auf 200 Zeichen.
function parseCourseNameMap(data) {
  const home = data && (data.homeData || data.HomeData);
  const books = home && (home.booksList || home.BooksList);
  if (!Array.isArray(books)) return {};
  const map = {};
  for (const b of books) {
    const bid = b && (b.bid != null ? b.bid : b.Bid);
    const name = b && (b.name != null ? b.name : b.Name);
    if (bid != null && typeof name === 'string' && name.trim())
      map[String(bid)] = name.trim().slice(0, 200);
  }
  return map;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { decodeChessableUid, parseCourseNameMap };
}
