'use strict';
/* Panzerpakt – rundenbasiertes Panzer-Diplomatiespiel für die Swimming-Lions-Spielesammlung.
   Jeder Panzer bekommt pro Takt einen Aktionspunkt (AP). Mit AP fährt man, schießt,
   rüstet auf, schenkt AP her oder nutzt die Fähigkeit seiner Klasse. Dazu: Gelände,
   ein schrumpfender Sturm, Nachschubkisten, Ereignisse (Blutmond, Nebel …), der Titan
   in der Kartenmitte, Pakte mit Verrat – und der Geisterrat der Gefallenen.

   Keine Abhängigkeiten außer Node 18+. Speicher: mit SUPABASE_URL und SUPABASE_SERVICE_KEY
   in der Tabelle „panzerpakt_speicher“ (siehe supabase_setup.sql), sonst lokal in partien.json. */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;
const MINUTE = process.env.SCHNELLTEST ? 1000 : 60000;   // zum Testen: 1 „Minute“ = 1 Sekunde
const DATEI = path.join(__dirname, 'partien.json');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const MIT_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);
const TABELLE = `${SUPABASE_URL}/rest/v1/panzerpakt_speicher`;
const KOPF = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };

/* ---------------- Regeln ---------------- */
const KLASSEN = {
  sturm:     { name: 'Sturmbrecher', reichweite: 2, herzen: 4, faehigkeit: 'Sturmlauf', kosten: 1,
               text: 'Fährt für 1 AP bis zu 3 Felder geradeaus. Startet mit 4 Herzen.' },
  artillerie:{ name: 'Donnerrohr',   reichweite: 3, herzen: 3, faehigkeit: 'Granatenhagel', kosten: 3,
               text: 'Trifft für 3 AP alle in einem 3×3-Feld (auch Verbündete). Startet mit Reichweite 3.' },
  spaeher:   { name: 'Schattenläufer', reichweite: 2, herzen: 3, faehigkeit: 'Tarnung', kosten: 2,
               text: 'Für 2 AP bis zum nächsten Takt unsichtbar und nicht angreifbar. Wald schützt doppelt.' },
  ingenieur: { name: 'Schmiedeherz', reichweite: 2, herzen: 3, faehigkeit: 'Reparatur', kosten: 2,
               text: 'Heilt für 2 AP ein Herz bei sich oder einem Panzer in Reichweite – auch über das Maximum.' },
};
const FARBEN = ['#e8483f', '#3fa7e8', '#f2c230', '#5ad16a', '#b46cf0', '#f08a3c', '#3fe0c8', '#f06cb4',
  '#9aa6b2', '#c9e84a', '#6c7bf0', '#e8e8e8'];
const TAKTE = { 1: 'Jede Minute', 5: 'Alle 5 Minuten', 30: 'Alle 30 Minuten', 60: 'Jede Stunde', 1440: 'Einmal am Tag' };
const BOT_NAMEN = ['Eisenzahn', 'Rostkönig', 'Graf Granate', 'Kettenkarl', 'Frau Haubitze', 'Stahlmaus',
  'Donnerdora', 'Kaputtnik', 'Major Matsch', 'Zahnrad-Zoe', 'Bolzen-Bernd'];

const sauber = (t, n = 16) => String(t || '').replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, n);
const zufall = n => Math.floor(Math.random() * n);
const abst = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

let partien = {};
let geaendert = false;

/* ---------------- Karte ---------------- */
function karteBauen(g) {
  const n = g.groesse, t = [];
  for (let y = 0; y < n; y++) { t.push([]); for (let x = 0; x < n; x++) t[y].push('.'); }
  const flecken = (zeichen, anzahl, groesse) => {
    for (let i = 0; i < anzahl; i++) {
      let x = zufall(n), y = zufall(n);
      for (let s = 0; s < groesse; s++) {
        if (x >= 0 && y >= 0 && x < n && y < n) t[y][x] = zeichen;
        x += zufall(3) - 1; y += zufall(3) - 1;
      }
    }
  };
  flecken('W', Math.round(n / 5), n);          // Wälder
  flecken('B', Math.round(n / 6), Math.round(n / 2)); // Berge
  // ein Fluss mit Furten
  const senk = Math.random() < .5; let p = zufall(n - 4) + 2;
  for (let i = 0; i < n; i++) {
    const x = senk ? p : i, y = senk ? i : p;
    t[y][x] = (i % 5 === 2) ? 'F' : '~';
    if (Math.random() < .35) p = Math.max(1, Math.min(n - 2, p + (zufall(3) - 1)));
  }
  // Mitte frei für den Titan
  const m = Math.floor(n / 2);
  for (let y = m - 1; y <= m + 1; y++) for (let x = m - 1; x <= m + 1; x++) t[y][x] = 'R';
  g.karte = t.map(r => r.join(''));
}
const feld = (g, x, y) => (x < 0 || y < 0 || x >= g.groesse || y >= g.groesse) ? '#' : g.karte[y][x];
const befahrbar = (g, x, y) => { const f = feld(g, x, y); return f !== '#' && f !== '~'; };
const besetzt = (g, x, y) => g.spieler.some(s => s.lebt && s.x === x && s.y === y) ||
  (g.titan && g.titan.hp > 0 && abst(g.titan, { x, y }) <= 0);
const imSturm = (g, x, y) => { const m = (g.groesse - 1) / 2; return Math.max(Math.abs(x - m), Math.abs(y - m)) > g.sturmRadius; };

function freiesFeld(g, mitAbstand) {
  for (let v = 0; v < 500; v++) {
    const x = zufall(g.groesse), y = zufall(g.groesse);
    if (!befahrbar(g, x, y) || besetzt(g, x, y) || feld(g, x, y) === 'R') continue;
    if (g.kisten.some(k => k.x === x && k.y === y)) continue;
    if (mitAbstand && g.spieler.some(s => s.lebt && s.x >= 0 && abst(s, { x, y }) < 3) && v < 400) continue;
    if (imSturm(g, x, y) && v < 450) continue;
    return { x, y };
  }
  return { x: 0, y: 0 };
}

/* ---------------- Chronik ---------------- */
function log(g, text, art = 'info', extra = {}) {
  g.chronik.push({ n: ++g.logNr, t: Date.now(), text, art, ...extra });
  if (g.chronik.length > 300) g.chronik.shift();
  geaendert = true;
}
const nameVon = (g, id) => (g.spieler.find(s => s.id === id) || {}).name || '???';

/* ---------------- Partie anlegen ---------------- */
function neuerCode() {
  const z = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c; do { c = ''; for (let i = 0; i < 5; i++) c += z[zufall(z.length)]; } while (partien[c]);
  return c;
}
function neuerSpieler(g, name, klasse, bot = false) {
  const id = crypto.randomBytes(6).toString('hex');
  const k = KLASSEN[klasse] ? klasse : 'sturm';
  const farbe = FARBEN.find(f => !g.spieler.some(s => s.farbe === f)) || FARBEN[zufall(FARBEN.length)];
  const s = { id, token: crypto.randomBytes(16).toString('hex'), name, klasse: k, farbe, bot,
    x: -1, y: -1, herzen: KLASSEN[k].herzen, ruestung: 0, ap: 0, reichweite: KLASSEN[k].reichweite,
    lebt: true, getarnt: false, kills: 0, platz: 0, stimme: null, fluch: null, titanTreffer: 0 };
  g.spieler.push(s);
  return s;
}

/* ---------------- Aktionen ---------------- */
function schaden(g, ziel, menge, quelle) {
  if (ziel === 'titan') {
    g.titan.hp -= menge;
    if (quelle) quelle.titanTreffer += menge;
    if (g.titan.hp <= 0) {
      log(g, `☠️ DER TITAN FÄLLT! ${quelle ? quelle.name : 'Der Sturm'} landet den letzten Treffer und erbeutet seinen Kern: +3 AP und 2 Rüstung.`, 'titan', { ziel: { x: g.titan.x, y: g.titan.y } });
      if (quelle) { quelle.ap += 3; quelle.ruestung += 2; quelle.titanbezwinger = true; }
      g.titan.hp = 0;
    }
    return;
  }
  let rest = menge;
  const abgefangen = Math.min(ziel.ruestung, rest); ziel.ruestung -= abgefangen; rest -= abgefangen;
  ziel.herzen -= rest;
  if (ziel.herzen <= 0) {
    ziel.herzen = 0; ziel.lebt = false; ziel.getarnt = false;
    ziel.platz = g.spieler.filter(s => s.lebt).length + 1;
    ziel.todTakt = g.takt;
    if (quelle && quelle !== ziel) {
      quelle.kills++;
      const beute = ziel.ap;
      quelle.ap += beute;
      log(g, `💥 ${quelle.name} zerstört ${ziel.name}${beute ? ` und plündert ${beute} AP` : ''}. ${ziel.name} tritt dem Geisterrat bei.`, 'tod', { ziel: { x: ziel.x, y: ziel.y } });
    } else log(g, `💥 ${ziel.name} wird vom Sturm zerrissen und tritt dem Geisterrat bei.`, 'tod', { ziel: { x: ziel.x, y: ziel.y } });
    ziel.ap = 0;
    // Pakte lösen sich mit dem Tod
    g.pakte = g.pakte.filter(p => !p.mitglieder.includes(ziel.id));
    pruefeSieg(g);
  }
}

function pruefeSieg(g) {
  const lebende = g.spieler.filter(s => s.lebt);
  if (lebende.length <= 1 && g.status === 'laeuft') {
    g.status = 'vorbei';
    const s = lebende[0];
    if (s) { s.platz = 1; g.sieger = s.id; log(g, `👑 ${s.name} ist der letzte Panzer auf dem Feld und gewinnt die Schlacht!`, 'sieg'); }
    else log(g, 'Niemand hat überlebt. Der Sturm gewinnt.', 'sieg');
  }
}

function inPakt(g, a, b) { return g.pakte.some(p => p.mitglieder.includes(a) && p.mitglieder.includes(b)); }

function aktion(g, s, b) {
  if (g.status !== 'laeuft') return { fehler: 'Die Schlacht läuft gerade nicht.' };
  const typ = b.typ;
  // Geister dürfen nur abstimmen
  if (!s.lebt) {
    if (typ !== 'stimme') return { fehler: 'Geister können nur im Geisterrat abstimmen.' };
    const ziel = g.spieler.find(x => x.id === b.ziel && x.lebt);
    if (!ziel) return { fehler: 'Ungültiges Ziel.' };
    s.stimme = { ziel: ziel.id, art: b.art === 'fluch' ? 'fluch' : 'segen' };
    geaendert = true;
    return { ok: true };
  }
  const kosten = n => { if (s.ap < n) return false; s.ap -= n; return true; };
  const reichweite = () => s.reichweite + (feld(g, s.x, s.y) === 'B' ? 1 : 0) - (g.ereignis === 'nebel' ? 1 : 0);

  if (typ === 'fahren') {
    const x = s.x + Math.sign(b.dx | 0), y = s.y + Math.sign(b.dy | 0);
    if (x === s.x && y === s.y) return { fehler: 'Keine Richtung.' };
    if (!befahrbar(g, x, y) || besetzt(g, x, y)) return { fehler: 'Da kommst du nicht hin.' };
    const preis = feld(g, x, y) === 'B' ? 2 : 1;
    if (!kosten(preis)) return { fehler: `Dafür brauchst du ${preis} AP.` };
    s.x = x; s.y = y; s.getarnt = false;
    aufsammeln(g, s);
    geaendert = true; return { ok: true };
  }
  if (typ === 'schuss') {
    if (b.ziel === 'titan') {
      if (!g.titan || g.titan.hp <= 0) return { fehler: 'Kein Titan da.' };
      if (abst(s, g.titan) > reichweite()) return { fehler: 'Zu weit weg.' };
      if (!kosten(1)) return { fehler: 'Kein AP übrig.' };
      const dmg = g.ereignis === 'blutmond' ? 2 : 1;
      log(g, `${s.name} feuert auf den Titan (−${dmg}).`, 'schuss', { von: { x: s.x, y: s.y }, ziel: { x: g.titan.x, y: g.titan.y } });
      schaden(g, 'titan', dmg, s);
      s.getarnt = false; return { ok: true };
    }
    const z = g.spieler.find(x => x.id === b.ziel && x.lebt);
    if (!z || z === s) return { fehler: 'Ungültiges Ziel.' };
    if (z.getarnt) return { fehler: `${z.name} ist getarnt.` };
    const d = abst(s, z);
    if (d > reichweite()) return { fehler: 'Zu weit weg.' };
    const waldGrenze = z.klasse === 'spaeher' ? 1 : 2;
    if (feld(g, z.x, z.y) === 'W' && d > waldGrenze) return { fehler: `${z.name} versteckt sich im Wald – komm näher (höchstens ${waldGrenze} Felder).` };
    if (!kosten(1)) return { fehler: 'Kein AP übrig.' };
    const dmg = g.ereignis === 'blutmond' ? 2 : 1;
    const verrat = inPakt(g, s.id, z.id);
    if (verrat) brichPakt(g, s, z, true);
    log(g, `${s.name} schießt auf ${z.name} (−${dmg}).`, 'schuss', { von: { x: s.x, y: s.y }, ziel: { x: z.x, y: z.y } });
    s.getarnt = false;
    schaden(g, z, dmg, s);
    return { ok: true };
  }
  if (typ === 'aufruesten') {
    if (s.reichweite >= 6) return { fehler: 'Mehr Reichweite geht nicht.' };
    if (!kosten(2)) return { fehler: 'Aufrüsten kostet 2 AP.' };
    s.reichweite++;
    log(g, `🔧 ${s.name} rüstet das Rohr auf (Reichweite ${s.reichweite}).`, 'info');
    return { ok: true };
  }
  if (typ === 'schenken') {
    const z = g.spieler.find(x => x.id === b.ziel && x.lebt);
    if (!z || z === s) return { fehler: 'Ungültiges Ziel.' };
    if (abst(s, z) > reichweite()) return { fehler: 'Zu weit weg zum Schenken.' };
    if (!kosten(1)) return { fehler: 'Kein AP übrig.' };
    z.ap++;
    log(g, `🤝 ${s.name} schenkt ${z.name} einen AP.`, 'geschenk', { von: { x: s.x, y: s.y }, ziel: { x: z.x, y: z.y } });
    return { ok: true };
  }
  if (typ === 'faehigkeit') {
    const k = KLASSEN[s.klasse];
    if (s.ap < k.kosten) return { fehler: `${k.faehigkeit} kostet ${k.kosten} AP.` };
    if (s.klasse === 'sturm') {
      const dx = Math.sign(b.dx | 0), dy = Math.sign(b.dy | 0);
      if (!dx && !dy) return { fehler: 'Keine Richtung.' };
      let n = 0;
      while (n < 3 && befahrbar(g, s.x + dx, s.y + dy) && !besetzt(g, s.x + dx, s.y + dy) && feld(g, s.x + dx, s.y + dy) !== 'B') {
        s.x += dx; s.y += dy; n++; aufsammeln(g, s);
      }
      if (!n) return { fehler: 'Der Weg ist blockiert.' };
      s.ap -= k.kosten;
      log(g, `⚡ ${s.name} prescht im Sturmlauf ${n} Felder vor!`, 'info');
      return { ok: true };
    }
    if (s.klasse === 'artillerie') {
      const x = b.x | 0, y = b.y | 0;
      if (abst(s, { x, y }) > reichweite() + 1) return { fehler: 'Zielgebiet zu weit weg.' };
      s.ap -= k.kosten;
      const dmg = g.ereignis === 'blutmond' ? 2 : 1;
      log(g, `🌋 ${s.name} lässt einen Granatenhagel niedergehen!`, 'hagel', { von: { x: s.x, y: s.y }, ziel: { x, y } });
      for (const z of g.spieler.filter(z => z.lebt && z !== s && !z.getarnt && abst(z, { x, y }) <= 1)) {
        if (inPakt(g, s.id, z.id)) brichPakt(g, s, z, true);
        schaden(g, z, dmg, s);
      }
      if (g.titan && g.titan.hp > 0 && abst(g.titan, { x, y }) <= 1) schaden(g, 'titan', dmg, s);
      return { ok: true };
    }
    if (s.klasse === 'spaeher') {
      if (s.getarnt) return { fehler: 'Du bist schon getarnt.' };
      s.ap -= k.kosten; s.getarnt = true;
      log(g, `🌫️ ${s.name} verschwindet in den Schatten.`, 'info');
      return { ok: true };
    }
    if (s.klasse === 'ingenieur') {
      const z = b.ziel ? g.spieler.find(x => x.id === b.ziel && x.lebt) : s;
      if (!z) return { fehler: 'Ungültiges Ziel.' };
      if (abst(s, z) > reichweite()) return { fehler: 'Zu weit weg.' };
      if (z.herzen >= 5) return { fehler: 'Mehr als 5 Herzen geht nicht.' };
      s.ap -= k.kosten; z.herzen++;
      log(g, `🛠️ ${s.name} repariert ${z === s ? 'sich selbst' : z.name} (+1 Herz).`, 'geschenk', { von: { x: s.x, y: s.y }, ziel: { x: z.x, y: z.y } });
      return { ok: true };
    }
  }
  if (typ === 'pakt') {
    const z = g.spieler.find(x => x.id === b.ziel && x.lebt && x !== s);
    if (!z) return { fehler: 'Ungültiges Ziel.' };
    if (inPakt(g, s.id, z.id)) return { fehler: 'Ihr habt schon einen Pakt.' };
    const offen = g.angebote.find(a => a.von === z.id && a.an === s.id);
    if (offen) {
      g.angebote = g.angebote.filter(a => a !== offen);
      g.pakte.push({ mitglieder: [s.id, z.id], seit: g.takt });
      log(g, `🩸 ${s.name} und ${z.name} schließen einen Blutpakt.`, 'pakt');
    } else {
      if (!g.angebote.some(a => a.von === s.id && a.an === z.id)) g.angebote.push({ von: s.id, an: z.id });
      log(g, `📜 ${s.name} bietet ${z.name} einen Pakt an.`, 'pakt', { privat: [s.id, z.id] });
    }
    return { ok: true };
  }
  if (typ === 'paktbruch') {
    const z = g.spieler.find(x => x.id === b.ziel);
    if (!z || !inPakt(g, s.id, z.id)) return { fehler: 'Kein Pakt mit diesem Panzer.' };
    brichPakt(g, s, z, false);
    return { ok: true };
  }
  return { fehler: 'Unbekannte Aktion.' };
}

function brichPakt(g, s, z, verrat) {
  g.pakte = g.pakte.filter(p => !(p.mitglieder.includes(s.id) && p.mitglieder.includes(z.id)));
  if (verrat) { s.verraeter = (s.verraeter || 0) + 1; log(g, `🗡️ VERRAT! ${s.name} fällt ${z.name} in den Rücken. Der Pakt ist zerbrochen.`, 'verrat'); }
  else log(g, `${s.name} kündigt den Pakt mit ${z.name}.`, 'pakt');
}

function aufsammeln(g, s) {
  const i = g.kisten.findIndex(k => k.x === s.x && k.y === s.y);
  if (i < 0) return;
  const k = g.kisten.splice(i, 1)[0];
  const texte = { ap: '+2 AP', herz: '+1 Herz', ruestung: '+1 Rüstung', rohr: '+1 Reichweite' };
  if (k.art === 'ap') s.ap += 2;
  if (k.art === 'herz') s.herzen++;
  if (k.art === 'ruestung') s.ruestung++;
  if (k.art === 'rohr') s.reichweite = Math.min(6, s.reichweite + 1);
  log(g, `📦 ${s.name} knackt eine Nachschubkiste: ${texte[k.art]}.`, 'kiste', { ziel: { x: s.x, y: s.y } });
}

/* ---------------- Takt ---------------- */
const EREIGNISSE = [
  { id: 'ruhe', w: 4, text: null },
  { id: 'blutmond', w: 2, text: '🌕 BLUTMOND! Bis zum nächsten Takt richtet jeder Treffer doppelten Schaden an.' },
  { id: 'nebel', w: 2, text: '🌫️ DICHTER NEBEL! Bis zum nächsten Takt haben alle 1 Reichweite weniger.' },
  { id: 'nachschub', w: 2, text: '🪂 LUFTBRÜCKE! Mehrere Nachschubkisten gehen über dem Schlachtfeld nieder.' },
  { id: 'beben', w: 1, text: '🌍 ERDBEBEN! Alle Panzer werden um ein Feld durchgeschüttelt.' },
];

function takt(g) {
  g.takt++;
  g.naechsterTakt = Date.now() + g.taktMin * MINUTE;
  // Tarnung und Ereignis laufen ab
  for (const s of g.spieler) s.getarnt = false;
  g.ereignis = null;

  // Geisterrat
  const geister = g.spieler.filter(s => !s.lebt && s.stimme);
  if (geister.length) {
    const zaehlen = art => { const z = {}; for (const s of geister) if (s.stimme.art === art && g.spieler.find(x => x.id === s.stimme.ziel && x.lebt)) z[s.stimme.ziel] = (z[s.stimme.ziel] || 0) + 1; return z; };
    const bester = z => { const e = Object.entries(z).sort((a, b) => b[1] - a[1]); return e.length && (e.length === 1 || e[0][1] > e[1][1]) ? e[0] : null; };
    const segen = bester(zaehlen('segen')), fluch = bester(zaehlen('fluch'));
    if (segen) { const s = g.spieler.find(x => x.id === segen[0]); s.ap++; log(g, `👻 Der Geisterrat segnet ${s.name} (${segen[1]} Stimmen): +1 AP.`, 'geist'); }
    if (fluch) { const s = g.spieler.find(x => x.id === fluch[0]); s.ap = Math.max(0, s.ap - 1); log(g, `👻 Der Geisterrat verflucht ${s.name} (${fluch[1]} Stimmen): −1 AP.`, 'geist'); }
    for (const s of g.spieler) s.stimme = null;
  }

  // Alle Lebenden bekommen einen AP
  for (const s of g.spieler) if (s.lebt) s.ap++;

  // Sturm
  if (g.takt % g.sturmTakte === 0 && g.sturmRadius > 1) {
    g.sturmRadius--;
    log(g, `🌪️ Der Sturm zieht sich zusammen! Die sichere Zone schrumpft.`, 'sturm');
  }
  for (const s of g.spieler.filter(s => s.lebt && imSturm(g, s.x, s.y))) {
    log(g, `🌪️ Der Sturm reißt an ${s.name} (−1).`, 'sturm', { ziel: { x: s.x, y: s.y } });
    schaden(g, s, 1, null);
  }
  if (g.status !== 'laeuft') return;

  // Titan
  if (!g.titan && g.takt >= g.titanTakt) {
    const m = Math.floor(g.groesse / 2);
    g.titan = { x: m, y: m, hp: 5 + g.spieler.length, max: 5 + g.spieler.length };
    for (const s of g.spieler.filter(s => s.lebt && abst(s, g.titan) === 0)) { const f = freiesFeld(g); s.x = f.x; s.y = f.y; }
    log(g, '🔥 Die Erde reißt auf – DER TITAN ERWACHT in der Mitte des Schlachtfelds! Wer ihn erlegt, erbeutet seinen Kern.', 'titan', { ziel: { x: m, y: m } });
  } else if (g.titan && g.titan.hp > 0) {
    const ziele = g.spieler.filter(s => s.lebt && !s.getarnt && abst(s, g.titan) <= 3).sort((a, b) => abst(a, g.titan) - abst(b, g.titan));
    for (const z of ziele.slice(0, 2)) {
      log(g, `🔥 Der Titan schleudert Feuer auf ${z.name} (−1).`, 'titan', { von: { x: g.titan.x, y: g.titan.y }, ziel: { x: z.x, y: z.y } });
      schaden(g, z, 1, null);
    }
    if (g.status !== 'laeuft') return;
  }

  // Ereignis würfeln
  const summe = EREIGNISSE.reduce((a, e) => a + e.w, 0); let r = Math.random() * summe;
  const e = EREIGNISSE.find(e => (r -= e.w) < 0) || EREIGNISSE[0];
  if (g.takt > 1 && e.text) {
    g.ereignis = e.id;
    log(g, e.text, 'ereignis', { ereignis: e.id });
    if (e.id === 'nachschub') for (let i = 0; i < 3; i++) kisteAbwerfen(g);
    if (e.id === 'beben') for (const s of g.spieler.filter(s => s.lebt)) {
      const dx = zufall(3) - 1, dy = zufall(3) - 1;
      if (befahrbar(g, s.x + dx, s.y + dy) && !besetzt(g, s.x + dx, s.y + dy)) { s.x += dx; s.y += dy; aufsammeln(g, s); }
    }
  }
  if (g.takt % 2 === 0) kisteAbwerfen(g);

  log(g, `— Takt ${g.takt}: Alle Panzer erhalten 1 AP. —`, 'takt');
  for (const s of g.spieler.filter(s => s.bot && s.lebt)) botZug(g, s);
  geaendert = true;
}

function kisteAbwerfen(g) {
  if (g.kisten.length > g.groesse) return;
  const f = freiesFeld(g);
  const arten = ['ap', 'ap', 'herz', 'ruestung', 'rohr'];
  g.kisten.push({ x: f.x, y: f.y, art: arten[zufall(arten.length)] });
}

/* ---------------- Bots ---------------- */
function botZug(g, s) {
  for (let n = 0; n < 8 && s.lebt && g.status === 'laeuft' && s.ap > 0; n++) {
    const rw = s.reichweite + (feld(g, s.x, s.y) === 'B' ? 1 : 0) - (g.ereignis === 'nebel' ? 1 : 0);
    const gegner = g.spieler.filter(z => z.lebt && z !== s && !z.getarnt && !inPakt(g, s.id, z.id))
      .filter(z => abst(s, z) <= rw && !(feld(g, z.x, z.y) === 'W' && abst(s, z) > (z.klasse === 'spaeher' ? 1 : 2)))
      .sort((a, b) => a.herzen - b.herzen);
    // Bots sparen ein bisschen, wenn das Ziel viele Herzen hat
    if (gegner.length && (s.ap >= Math.min(gegner[0].herzen + gegner[0].ruestung, 3) || s.ap >= 3)) { aktion(g, s, { typ: 'schuss', ziel: gegner[0].id }); continue; }
    if (s.klasse === 'ingenieur' && s.herzen < 3 && s.ap >= 2) { aktion(g, s, { typ: 'faehigkeit' }); continue; }
    // Paktangebote annehmen, wenn wenige Gegner übrig sind? Nur manchmal.
    const angebot = g.angebote.find(a => a.an === s.id);
    if (angebot && Math.random() < .5) { aktion(g, s, { typ: 'pakt', ziel: angebot.von }); continue; }
    // Ziel: Sturm meiden, Kisten holen, sonst Gegner annähern
    let ziel = null;
    const m = (g.groesse - 1) / 2;
    if (imSturm(g, s.x, s.y)) ziel = { x: Math.round(m), y: Math.round(m) };
    else {
      const kiste = g.kisten.slice().sort((a, b) => abst(s, a) - abst(s, b))[0];
      if (kiste && abst(s, kiste) <= 4) ziel = kiste;
      else if (s.ap >= 3) {
        const nah = g.spieler.filter(z => z.lebt && z !== s && !inPakt(g, s.id, z.id)).sort((a, b) => abst(s, a) - abst(s, b))[0];
        if (nah && abst(s, nah) > rw) ziel = nah;
        else if (s.reichweite < 4 && s.ap >= 2) { aktion(g, s, { typ: 'aufruesten' }); continue; }
      }
    }
    if (!ziel) break;
    const dx = Math.sign(ziel.x - s.x), dy = Math.sign(ziel.y - s.y);
    const versuche = [[dx, dy], [dx, 0], [0, dy], [dx, -dy || 1], [-dx || 1, dy]];
    let ok = false;
    for (const [a, b] of versuche) {
      if (!a && !b) continue;
      const nx = s.x + a, ny = s.y + b;
      if (imSturm(g, nx, ny) && !imSturm(g, s.x, s.y)) continue;
      if (aktion(g, s, { typ: 'fahren', dx: a, dy: b }).ok) { ok = true; break; }
    }
    if (!ok) break;
  }
}

/* ---------------- Ansicht für einen Spieler ---------------- */
function ansicht(g, ich) {
  const lebt = ich && ich.lebt;
  return {
    code: g.code, status: g.status, groesse: g.groesse, karte: g.karte, takt: g.takt, taktMin: g.taktMin,
    naechsterTakt: g.naechsterTakt, sturmRadius: g.sturmRadius, sturmTakte: g.sturmTakte, ereignis: g.ereignis,
    titanTakt: g.titanTakt, titan: g.titan, kisten: g.kisten, host: g.host, sieger: g.sieger, jetzt: Date.now(),
    pakte: g.pakte, angebote: g.angebote.filter(a => ich && (a.an === ich.id || a.von === ich.id)),
    chat: g.chat.filter(c => !c.privat || (ich && c.privat.includes(ich.id))).slice(-80),
    chronik: g.chronik.filter(c => !c.privat || (ich && c.privat.includes(ich.id))).slice(-120),
    ich: ich ? { id: ich.id, stimme: ich.stimme } : null,
    spieler: g.spieler.map(s => {
      const sichtbar = !s.getarnt || (ich && (s.id === ich.id || inPakt(g, s.id, ich.id)));
      return { id: s.id, name: s.name, klasse: s.klasse, farbe: s.farbe, bot: s.bot, lebt: s.lebt,
        x: sichtbar ? s.x : -1, y: sichtbar ? s.y : -1, getarnt: s.getarnt, herzen: s.herzen, ruestung: s.ruestung,
        ap: s.ap, reichweite: s.reichweite, kills: s.kills, platz: s.platz, verraeter: s.verraeter || 0,
        titanbezwinger: !!s.titanbezwinger };
    }),
  };
}

/* ---------------- HTTP ---------------- */
const zaehler = new Map();
setInterval(() => zaehler.clear(), 60_000).unref();
const ipAus = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function zuViele(req) { const ip = ipAus(req), n = (zaehler.get(ip) || 0) + 1; zaehler.set(ip, n); return n > 400; }

const TYPEN = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
function senden(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

function api(req, res, pfad, b) {
  if (pfad === '/api/info') return senden(res, 200, { klassen: KLASSEN, takte: TAKTE });

  if (pfad === '/api/erstellen') {
    if (Object.keys(partien).length > 300) return senden(res, 503, { fehler: 'Gerade zu viele Partien.' });
    const name = sauber(b.name); if (name.length < 2) return senden(res, 400, { fehler: 'Name zu kurz.' });
    const code = neuerCode();
    const taktMin = TAKTE[b.taktMin] ? Number(b.taktMin) : 5;
    const g = { code, status: 'lobby', erstellt: Date.now(), zuletzt: Date.now(), taktMin, spieler: [], pakte: [], angebote: [],
      chat: [], chronik: [], logNr: 0, takt: 0, kisten: [], titan: null, ereignis: null, host: null, sieger: null };
    const s = neuerSpieler(g, name, b.klasse);
    g.host = s.id;
    partien[code] = g; geaendert = true;
    log(g, `${name} hat das Feldlager errichtet.`, 'info');
    return senden(res, 200, { code, id: s.id, token: s.token });
  }

  const g = partien[String(b.code || '').toUpperCase()];
  if (!g) return senden(res, 404, { fehler: 'Diese Partie gibt es nicht.' });
  g.zuletzt = Date.now();

  if (pfad === '/api/beitreten') {
    if (g.status !== 'lobby') return senden(res, 400, { fehler: 'Die Schlacht hat schon begonnen.' });
    if (g.spieler.length >= 12) return senden(res, 400, { fehler: 'Das Feldlager ist voll (12).' });
    const name = sauber(b.name); if (name.length < 2) return senden(res, 400, { fehler: 'Name zu kurz.' });
    if (g.spieler.some(s => s.name.toLowerCase() === name.toLowerCase())) return senden(res, 400, { fehler: 'Name schon vergeben.' });
    const s = neuerSpieler(g, name, b.klasse);
    log(g, `${name} zieht ins Feldlager ein.`, 'info');
    return senden(res, 200, { code: g.code, id: s.id, token: s.token });
  }

  const ich = g.spieler.find(s => s.token && s.token === b.token) || null;
  if (pfad === '/api/stand') return senden(res, 200, ansicht(g, ich));
  if (!ich) return senden(res, 403, { fehler: 'Du bist nicht in dieser Partie.' });

  if (pfad === '/api/lobby') {
    if (g.status !== 'lobby') return senden(res, 400, { fehler: 'Zu spät.' });
    if (b.klasse && KLASSEN[b.klasse]) { ich.klasse = b.klasse; ich.herzen = KLASSEN[b.klasse].herzen; ich.reichweite = KLASSEN[b.klasse].reichweite; }
    if (b.farbe && FARBEN.includes(b.farbe) && !g.spieler.some(s => s !== ich && s.farbe === b.farbe)) ich.farbe = b.farbe;
    if (ich.id === g.host && TAKTE[b.taktMin]) g.taktMin = Number(b.taktMin);
    if (ich.id === g.host && b.botDazu && g.spieler.length < 12) {
      const frei = BOT_NAMEN.filter(n => !g.spieler.some(s => s.name === n));
      const k = Object.keys(KLASSEN);
      neuerSpieler(g, frei[zufall(frei.length)] || 'Bot', k[zufall(k.length)], true);
    }
    if (ich.id === g.host && b.botWeg) {
      const i = g.spieler.findIndex(s => s.bot && s.id === b.botWeg); if (i >= 0) g.spieler.splice(i, 1);
    }
    geaendert = true;
    return senden(res, 200, ansicht(g, ich));
  }

  if (pfad === '/api/starten') {
    if (ich.id !== g.host) return senden(res, 403, { fehler: 'Nur der Gastgeber startet.' });
    if (g.status !== 'lobby') return senden(res, 400, { fehler: 'Läuft schon.' });
    if (g.spieler.length < 2) return senden(res, 400, { fehler: 'Mindestens 2 Panzer (gern mit Bots).' });
    g.groesse = Math.min(26, 10 + g.spieler.length * 1.5 | 0);
    if (g.groesse % 2 === 0) g.groesse++;
    karteBauen(g);
    g.sturmRadius = Math.floor(g.groesse / 2);
    g.sturmTakte = Math.max(3, Math.round(16 / Math.max(1, g.sturmRadius - 1)) + 2);
    g.titanTakt = 6;
    g.status = 'laeuft';
    for (const s of g.spieler) { const f = freiesFeld(g, true); s.x = f.x; s.y = f.y; s.ap = 1; }
    for (let i = 0; i < 3; i++) kisteAbwerfen(g);
    g.naechsterTakt = Date.now() + g.taktMin * MINUTE;
    log(g, `⚔️ DIE SCHLACHT BEGINNT! ${g.spieler.length} Panzer, ${TAKTE[g.taktMin].toLowerCase()} gibt es 1 AP. Nur einer kehrt heim.`, 'start');
    return senden(res, 200, ansicht(g, ich));
  }

  if (pfad === '/api/aktion') {
    const r = aktion(g, ich, b);
    if (r.fehler) return senden(res, 400, r);
    return senden(res, 200, ansicht(g, ich));
  }

  if (pfad === '/api/chat') {
    const text = sauber(b.text, 240); if (!text) return senden(res, 400, { fehler: 'Leer.' });
    let privat = null;
    if (b.an) { const z = g.spieler.find(s => s.id === b.an); if (!z) return senden(res, 400, { fehler: 'Unbekannt.' }); privat = [ich.id, z.id]; }
    g.chat.push({ t: Date.now(), von: ich.id, name: ich.name, farbe: ich.farbe, geist: !ich.lebt, text, privat });
    if (g.chat.length > 300) g.chat.shift();
    geaendert = true;
    return senden(res, 200, ansicht(g, ich));
  }
  return senden(res, 404, { fehler: 'Unbekannt.' });
}

const server = http.createServer((req, res) => {
  if (zuViele(req)) { res.writeHead(429); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'POST') return senden(res, 405, { fehler: 'Nur POST.' });
    let roh = '';
    req.on('data', d => { roh += d; if (roh.length > 8000) req.destroy(); });
    req.on('end', () => {
      let b = {}; try { b = JSON.parse(roh || '{}'); } catch (e) {}
      try { api(req, res, url.pathname, b); } catch (e) { console.error(e); senden(res, 500, { fehler: 'Serverfehler.' }); }
    });
    return;
  }
  let datei = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const voll = path.join(__dirname, 'public', path.normalize(datei).replace(/^(\.\.[/\\])+/, ''));
  if (!voll.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(voll, (err, inhalt) => {
    if (err) { res.writeHead(404); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': TYPEN[path.extname(voll)] || 'application/octet-stream' });
    res.end(inhalt);
  });
});

/* ---------------- Takt-Uhr und Speicher ---------------- */
setInterval(() => {
  const jetzt = Date.now();
  for (const [code, g] of Object.entries(partien)) {
    if (g.status === 'laeuft') {
      let n = 0;
      while (g.status === 'laeuft' && jetzt >= g.naechsterTakt && n++ < 50) { const soll = g.naechsterTakt; takt(g); g.naechsterTakt = soll + g.taktMin * MINUTE; }
      if (g.naechsterTakt < jetzt) g.naechsterTakt = jetzt + g.taktMin * MINUTE;
    }
    // Aufräumen: Lobbys nach 2 Tagen, beendete nach 7 Tagen, ohne Besuch nach 30 Tagen
    const alt = jetzt - g.zuletzt;
    if ((g.status === 'lobby' && alt > 2 * 864e5) || (g.status === 'vorbei' && alt > 7 * 864e5) || alt > 30 * 864e5) { delete partien[code]; geaendert = true; }
  }
}, 2000).unref();

async function laden() {
  if (MIT_SUPABASE) {
    for (let v = 1; v <= 3; v++) {
      try {
        const res = await fetch(`${TABELLE}?id=eq.haupt&select=daten`, { headers: KOPF });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const z = await res.json();
        if (z[0] && z[0].daten) partien = z[0].daten;
        return console.log('Partien aus Supabase geladen.');
      } catch (e) { console.error('Laden fehlgeschlagen:', e.message); await new Promise(r => setTimeout(r, 1500)); }
    }
    console.error('Abbruch: Supabase nicht erreichbar.'); process.exit(1);
  }
  try { partien = JSON.parse(fs.readFileSync(DATEI, 'utf8')); } catch (e) {}
}
let speichert = false;
async function speichern() {
  if (!geaendert || speichert) return;
  speichert = true; geaendert = false;
  try {
    if (MIT_SUPABASE) {
      const res = await fetch(TABELLE, { method: 'POST', headers: { ...KOPF, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ id: 'haupt', daten: partien, geaendert_am: new Date().toISOString() }) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } else fs.writeFileSync(DATEI, JSON.stringify(partien));
  } catch (e) { geaendert = true; console.error('Speichern fehlgeschlagen:', e.message); }
  speichert = false;
}
setInterval(speichern, 5000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await speichern(); process.exit(0); });

laden().then(() => server.listen(PORT, () => console.log('Panzerpakt läuft auf Port ' + PORT)));
