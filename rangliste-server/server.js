'use strict';
/* Live-Ranglisten der Swimming-Lions-Spielesammlung.
   Die Spiele melden über melder.js Spielzeit, Punkte und Progress an diesen Dienst,
   die Sammlung zeigt die Ranglisten an. Keine Abhängigkeiten außer Node.

   Speicher: Mit SUPABASE_URL und SUPABASE_SERVICE_KEY liegt alles als eine Zeile in
   der Tabelle „rangliste_speicher“ (siehe supabase_setup.sql) und übersteht Deploys.
   Ohne diese Variablen wird nur lokal in rangliste.json gespeichert. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;
const DB_DATEI = path.join(__dirname, 'rangliste.json');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const MIT_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);
const TABELLE = `${SUPABASE_URL}/rest/v1/rangliste_speicher`;
const KOPF = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };

// Namen müssen genau so heißen wie in der Sammlung
const SPIELE = new Set(['Olympiade', 'Blaue Stunde', 'Löwen-Kart', 'Weltenbummler', 'Weltreiche', 'Futbolero',
  'Pinguin Türmchen', 'Ringfieber', 'Löwenküche', 'Schanzenlöwe',
  'Verräter an Bord', 'Kredithai', 'Knastknacker', 'Crazy Lineup', 'Clash of Taddel']);

let daten = { spieler: {}, werte: {} };
let geaendert = false;

async function laden() {
  if (MIT_SUPABASE) {
    for (let versuch = 1; versuch <= 3; versuch++) {
      try {
        const res = await fetch(`${TABELLE}?id=eq.haupt&select=daten`, { headers: KOPF });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const z = await res.json();
        if (z[0] && z[0].daten) daten = z[0].daten;
        console.log('Daten aus Supabase geladen.');
        return;
      } catch (e) { console.error(`Laden aus Supabase fehlgeschlagen (Versuch ${versuch}):`, e.message); await new Promise(r => setTimeout(r, 1500)); }
    }
    // Ohne erfolgreiches Laden nicht starten, sonst würde der leere Stand die echten Daten überschreiben
    console.error('Abbruch: Supabase nicht erreichbar.'); process.exit(1);
  }
  try { daten = JSON.parse(fs.readFileSync(DB_DATEI, 'utf8')); } catch (e) {}
}

let speichert = false;
async function speichern() {
  if (!geaendert || speichert) return;
  speichert = true; geaendert = false;
  try {
    if (MIT_SUPABASE) {
      const res = await fetch(TABELLE, { method: 'POST',
        headers: { ...KOPF, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id: 'haupt', daten, geaendert_am: new Date().toISOString() }) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } else fs.writeFileSync(DB_DATEI, JSON.stringify(daten));
  } catch (e) { geaendert = true; console.error('Speichern fehlgeschlagen:', e.message); }
  speichert = false;
}
setInterval(speichern, 5000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await speichern(); process.exit(0); });

// Anfragen je IP begrenzen (nur im Arbeitsspeicher)
const zaehler = new Map();
setInterval(() => zaehler.clear(), 60_000).unref();
const ipAus = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function zuViele(req) { const ip = ipAus(req), n = (zaehler.get(ip) || 0) + 1; zaehler.set(ip, n); return n > 240; }

const sauber = t => String(t || '').replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, 16);
const zahl = (v, max) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : null; };

function eintrag(spiel, name) {
  const s = daten.werte[spiel] || (daten.werte[spiel] = {});
  return s[name] || (s[name] = { punkte: 0, progress: 0, zeit: 0, zeitAlt: 0, zuletzt: 0 });
}

const protokoll = [];   // die letzten Meldungen, zur Fehlersuche unter /api/debug
function melden(b) {
  const r = melden2(b);
  protokoll.push({ t: new Date().toISOString().slice(11, 19), spiel: b.spiel, spieler: b.spieler, punkte: b.punkte, progress: b.progress, sek: b.sekunden, ergebnis: r.fehler || 'ok' });
  if (protokoll.length > 40) protokoll.shift();
  return r;
}
function melden2(b) {
  const spiel = String(b.spiel || ''), name = sauber(b.spieler);
  if (!SPIELE.has(spiel)) return { fehler: 'Unbekanntes Spiel' };
  if (name.length < 2) return { fehler: 'Unbekannter Spieler' };
  if (!daten.spieler[name]) {   // Neue Namen werden beim ersten Wert automatisch angelegt
    if (Object.keys(daten.spieler).length >= 200) return { fehler: 'Zu viele Spieler' };
    daten.spieler[name] = { erstellt: Date.now() };
  }
  const e = eintrag(spiel, name);
  const p = zahl(b.punkte, 1e12), g = zahl(b.progress, 100), s = zahl(b.sekunden, 120), za = zahl(b.zeitAlt, 1e8);
  if (p !== null && p > e.punkte) e.punkte = Math.round(p);
  if (g !== null && g > e.progress) e.progress = Math.round(g * 10) / 10;
  if (s !== null) e.zeit += s;
  if (za !== null && za > e.zeitAlt) e.zeitAlt = Math.round(za);
  e.zuletzt = Date.now();
  gesehen(name, spiel);
  geaendert = true;
  return { ok: true };
}

/* Online-Status: Wer zuletzt wann und wo aktiv war. Die Spiele melden alle 20 Sekunden,
   die Sammlung pingt alle 30 Sekunden (spiel = „Sammlung“). */
const ONLINE_MS = 75_000;
function gesehen(name, spiel) {
  const sp = daten.spieler[name];
  if (!sp) return;
  sp.zuletzt = Date.now();
  if (SPIELE.has(spiel) || spiel === 'Sammlung') sp.spiel = spiel;
}
function status() {
  const st = {};
  for (const [name, sp] of Object.entries(daten.spieler)) {
    let zuletzt = sp.zuletzt || 0, spiel = sp.spiel || '';
    // Ältere Einträge ohne eigenen Zeitstempel: letzte Meldung aus den Spielen nehmen
    for (const [s, w] of Object.entries(daten.werte)) if (w[name] && w[name].zuletzt > zuletzt) { zuletzt = w[name].zuletzt; spiel = s; }
    if (zuletzt) st[name] = { zuletzt, spiel };
  }
  return st;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const senden = (res, status, obj) => { res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const koerper = req => new Promise(ok => {
  let d = ''; req.on('data', c => { d += c; if (d.length > 4000) req.destroy(); });
  req.on('end', () => { try { ok(JSON.parse(d)); } catch (e) { ok({}); } });
  req.on('error', () => ok({}));
});

const server = http.createServer(async (req, res) => {
  const pfad = new URL(req.url, 'http://x').pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (pfad === '/healthz') return senden(res, 200, { ok: true });
  if (pfad === '/melder.js') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    return fs.createReadStream(path.join(__dirname, 'public', 'melder.js')).pipe(res);
  }
  if (pfad.startsWith('/api/') && zuViele(req)) return senden(res, 429, { fehler: 'Zu viele Anfragen' });
  if (req.method === 'GET' && pfad === '/api/rangliste') return senden(res, 200, { spieler: Object.keys(daten.spieler), werte: daten.werte, status: status(), jetzt: Date.now(), onlineMs: ONLINE_MS });
  if (req.method === 'GET' && pfad === '/api/debug') return senden(res, 200, { spieler: Object.keys(daten.spieler).length, letzte: protokoll });
  if (req.method === 'POST' && pfad === '/api/spieler') {
    const b = await koerper(req), name = sauber(b.name);
    if (name.length < 2) return senden(res, 400, { fehler: 'Name zu kurz' });
    if (!daten.spieler[name] && Object.keys(daten.spieler).length >= 200) return senden(res, 400, { fehler: 'Zu viele Spieler' });
    if (!daten.spieler[name]) { daten.spieler[name] = { erstellt: Date.now() }; geaendert = true; }
    if (b.spiel) { gesehen(name, String(b.spiel)); geaendert = true; }   // Lebenszeichen aus Spiel oder Sammlung
    return senden(res, 200, { ok: true, name });
  }
  if (req.method === 'POST' && pfad === '/api/melden') {
    const r = melden(await koerper(req));
    return senden(res, r.fehler ? 400 : 200, r);
  }
  senden(res, 404, { fehler: 'Nicht gefunden' });
});

laden().then(() => {
  // Alte Stimmen der beendeten Abstimmung löschen
  if (daten.voting) { delete daten.voting; geaendert = true; }
  server.listen(PORT, () => console.log(`Rangliste läuft auf Port ${PORT} (Speicher: ${MIT_SUPABASE ? 'Supabase' : DB_DATEI})`));
});
