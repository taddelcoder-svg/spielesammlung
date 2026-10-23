/* Melder der Swimming-Lions-Spielesammlung.
   Wird in jedes Spiel eingebunden:
     <script src="https://…/melder.js" data-spiel="Blaue Stunde" defer></script>
   Er zählt die Spielzeit automatisch und schickt Punkte und Progress an die Rangliste.
   Optional definiert das Spiel window.SLRangAdapter = () => ({ punkte, progress, zeitAlt }).
   Der Melder liest das alle 20 Sekunden aus (auch die alten Werte, die das Spiel schon gespeichert hat).

   Spielstand in der Cloud: Mit data-speicher="präfix" (mehrere mit Komma) sagt das Spiel, welche
   localStorage-Einträge zu seinem Spielstand gehören; data-speicher-ohne="…" nimmt Einträge aus,
   die nur zum Gerät passen (Grafik, Ton). Knöpfe mit dem Attribut data-sl-cloud öffnen den Dialog,
   in dem man Name und PIN eingibt. Danach wird beim Start abgeglichen und alle 20 Sekunden gesichert. */
(function () {
  'use strict';
  var me = document.currentScript;
  var SPIEL = me && me.getAttribute('data-spiel');
  if (!SPIEL || window.SLRang) return;
  var API = new URL(me.src).origin;
  var KEY = 'sl_name';

  // Diagnose: Spiel mit ?sldebug=1 öffnen, dann zeigt eine kleine Anzeige, was der Melder tut
  var DEBUG = /[?&]sldebug/.test(location.search), zeilen = [], tafel = null;
  function dbg(text) {
    if (!DEBUG) return;
    zeilen.push(new Date().toLocaleTimeString() + ' ' + text); zeilen = zeilen.slice(-8);
    if (!document.body) return;
    if (!tafel) {
      tafel = document.createElement('pre');
      tafel.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:2147483647;margin:0;padding:6px 8px;max-width:90vw;white-space:pre-wrap;font:11px/1.3 monospace;background:rgba(0,0,0,.8);color:#7fff7f;border-radius:6px;pointer-events:none';
      document.body.appendChild(tafel);
    }
    tafel.textContent = 'Melder · ' + SPIEL + '\n' + zeilen.join('\n');
  }

  function lesen() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function schreiben(n) { try { localStorage.setItem(KEY, n); } catch (e) {} }

  // Name aus dem Link der Sammlung (?sl=Name) übernehmen
  try {
    var u = new URL(location.href), n = (u.searchParams.get('sl') || '').trim();
    if (n) { schreiben(n.slice(0, 16)); u.searchParams.delete('sl'); history.replaceState(null, '', u.pathname + (u.search || '') + u.hash); }
  } catch (e) {}

  var name = lesen();
  var ruhe = false;          // „Nicht mitzählen“ gilt nur bis zum Neuladen
  var offen = { sekunden: 0, punkte: null, progress: null, zeitAlt: null };
  var gesendet = { punkte: -1, progress: -1, zeitAlt: -1 };

  // Gibt ein Versprechen zurück, das nur bei einer erfolgreichen Antwort erfüllt wird
  function post(pfad, obj, beacon) {
    var body = JSON.stringify(obj);
    if (beacon && navigator.sendBeacon) {
      try { navigator.sendBeacon(API + pfad, new Blob([body], { type: 'text/plain' })); } catch (e) {}
      return null;
    }
    return fetch(API + pfad, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, keepalive: true })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); dbg('OK ' + pfad + ' ' + body.slice(0, 90)); return r.json(); })
      .catch(function (e) { dbg('FEHLER ' + pfad + ' ' + (e && e.message)); throw e; });
  }

  // Wie post, liefert aber auch bei Fehlern { status, j } (für 403/409 beim Spielstand)
  function anfrage(pfad, obj, beacon) {
    return fetch(API + pfad, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(obj), keepalive: !!beacon })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { dbg(r.status + ' ' + pfad); return { status: r.status, j: j }; }); });
  }

  // Erst als gesendet merken, wenn der Server geantwortet hat (der kostenlose Server schläft
  // manchmal und braucht ein paar Sekunden zum Aufwachen). Sonst wird beim nächsten Takt wiederholt.
  function senden(beacon) {
    if (!name || ruhe) return;
    var o = { spiel: SPIEL, spieler: name }, etwas = false;
    var vorher = { p: gesendet.punkte, g: gesendet.progress, z: gesendet.zeitAlt }, sek = 0;
    if (offen.sekunden >= 1) { sek = Math.round(offen.sekunden); o.sekunden = sek; offen.sekunden = 0; etwas = true; }
    if (offen.punkte !== null && offen.punkte > gesendet.punkte) { o.punkte = gesendet.punkte = offen.punkte; etwas = true; }
    if (offen.progress !== null && offen.progress > gesendet.progress) { o.progress = gesendet.progress = offen.progress; etwas = true; }
    if (offen.zeitAlt !== null && offen.zeitAlt > gesendet.zeitAlt) { o.zeitAlt = gesendet.zeitAlt = offen.zeitAlt; etwas = true; }
    if (!etwas) return;
    var p = post('/api/melden', o, beacon);
    if (!p) return;
    p.catch(function () {
      offen.sekunden += sek;
      gesendet.punkte = vorher.p; gesendet.progress = vorher.g; gesendet.zeitAlt = vorher.z;
    });
  }

  function melde(w) {
    if (!w) return;
    if (typeof w.punkte === 'number' && isFinite(w.punkte)) offen.punkte = Math.max(offen.punkte || 0, w.punkte);
    if (typeof w.progress === 'number' && isFinite(w.progress)) offen.progress = Math.max(offen.progress || 0, Math.min(100, w.progress));
    if (typeof w.zeitAlt === 'number' && isFinite(w.zeitAlt)) offen.zeitAlt = Math.max(offen.zeitAlt || 0, w.zeitAlt);
  }
  function adapterLesen() {
    try { if (typeof window.SLRangAdapter === 'function') { var a = window.SLRangAdapter(); dbg('Spielstand ' + JSON.stringify(a)); melde(a); } else dbg('kein Adapter (nur Spielzeit)'); } catch (e) { dbg('Adapter-Fehler ' + e.message); }
  }

  // Spielzeit: jede Sekunde, in der die Seite sichtbar ist
  setInterval(function () { if (name && !ruhe && document.visibilityState === 'visible') offen.sekunden += 1; }, 1000);
  setInterval(function () { adapterLesen(); senden(false); hochladen(); }, 20000);
  addEventListener('pagehide', function () { adapterLesen(); senden(true); hochladen(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { adapterLesen(); senden(true); hochladen(true); }
    else if (Date.now() - letzterAbgleich > 60000) abgleich();   // vielleicht wurde inzwischen woanders gespielt
  });
  setTimeout(function () { adapterLesen(); senden(false); }, 4000);

  // Dialog im Stil der Sammlung: gibt { d, k, feld, knopf, fehler } zurück
  var STIL_FELD = 'width:100%;min-height:44px;font:inherit;padding:0 12px;border-radius:10px;border:1px solid #9bb;margin:0 0 8px;box-sizing:border-box;background:#f3fbfc;color:#13315c';
  function fenster(titel, text) {
    var d = document.createElement('div');
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', titel.replace(/^\S+\s/, ''));
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;background:rgba(8,20,36,.7);font:16px system-ui,-apple-system,sans-serif';
    var k = document.createElement('div');
    k.style.cssText = 'width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;background:#fff;color:#13315c;border-radius:16px;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.4);text-align:left';
    var h = document.createElement('h2'), p = document.createElement('p');
    h.style.cssText = 'margin:0 0 4px;font-size:1.2rem'; h.textContent = titel;
    p.style.cssText = 'margin:0 0 12px;color:#3d5a80;line-height:1.4'; p.textContent = text;
    k.appendChild(h); k.appendChild(p); d.appendChild(k);
    return {
      d: d, k: k,
      feld: function (tag, attr) {
        var e = document.createElement(tag); e.style.cssText = STIL_FELD;
        for (var a in attr) e.setAttribute(a, attr[a]);
        k.appendChild(e); return e;
      },
      knopf: function (text, haupt, f) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = f;
        b.style.cssText = haupt ? 'width:100%;min-height:44px;font:inherit;font-weight:800;border:0;border-radius:10px;background:#13315c;color:#fff;margin:0 0 8px;cursor:pointer'
          : 'width:100%;min-height:44px;font:inherit;border:0;background:none;color:#3d5a80;cursor:pointer;text-decoration:underline';
        k.appendChild(b); return b;
      },
      fehler: function () {
        var e = document.createElement('p'); e.style.cssText = 'color:#c2332b;margin:0 0 8px;min-height:1em'; e.setAttribute('role', 'alert');
        k.appendChild(e); return e;
      },
      zeigen: function () { document.body.appendChild(d); var f = k.querySelector('input,select,button'); if (f) f.focus(); }
    };
  }
  // Liste der Namen aus der Rangliste in ein select füllen
  function namenFuellen(sel, vorwahl) {
    var o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'Name wählen …'; sel.appendChild(o0);
    fetch(API + '/api/rangliste').then(function (r) { return r.json(); }).then(function (j) {
      (j.spieler || []).sort().forEach(function (n) { var o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
      if (vorwahl) sel.value = vorwahl;
    }).catch(function () {});
  }

  // Namenswahl, falls noch kein Name bekannt ist
  function wahlZeigen() {
    var f = fenster('🏆 Wer spielt?', 'Damit dein Ergebnis in die Rangliste der Sammlung kommt.'), d = f.d;
    var sel = f.feld('select', { 'aria-label': 'Name' }), inp = f.feld('input', { placeholder: 'Oder neuer Name', maxlength: '16', 'aria-label': 'Neuer Name' });
    var fehler = f.fehler(), ok = f.knopf('Los', true), nein = f.knopf('Nicht mitzählen', false);
    namenFuellen(sel);
    ok.onclick = function () {
      var n = (inp.value.trim() || sel.value).slice(0, 16);
      if (n.length < 2) { fehler.textContent = 'Bitte einen Namen wählen oder eingeben.'; return; }
      post('/api/spieler', { name: n })
        .then(function (j) { if (!j.ok) { fehler.textContent = j.fehler || 'Hat nicht geklappt.'; return; } name = j.name; schreiben(name); d.remove(); adapterLesen(); senden(false); })
        .catch(function () { fehler.textContent = 'Rangliste gerade nicht erreichbar.'; });
    };
    nein.onclick = function () { ruhe = true; d.remove(); };
    f.zeigen();
  }
  // Als Olympia-Disziplin (Ticket im Link oder in der Sitzung) keine Namensabfrage einblenden
  function inOlymp() {
    try {
      if (/[?&]olymp=/.test(location.search)) return true;
      for (var i = 0; i < sessionStorage.length; i++) if (/olymp/i.test(sessionStorage.key(i))) return true;
    } catch (e) {}
    return false;
  }

  /* ---------- Spielstand in der Cloud ----------
     Auf dem Gerät liegen dafür: sl_pin (die PIN zum Namen) und sl_stand:<Spiel> (Hash und Zeit des
     zuletzt abgeglichenen Stands). Am Hash erkennt der Melder, ob sich der Stand hier, in der Cloud
     oder auf beiden Seiten geändert hat:
       nur hier geändert   -> hochladen
       nur in der Cloud    -> übernehmen und Seite neu laden
       auf beiden Seiten   -> fragen, welcher bleiben soll */
  function liste(attr) { return ((me && me.getAttribute(attr)) || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean); }
  var PRAEFIXE = liste('data-speicher'), OHNE = liste('data-speicher-ohne');
  var KEY_PIN = 'sl_pin', KEY_SYNC = 'sl_stand:' + SPIEL;
  var cloudAus = !PRAEFIXE.length;   // Spiel ohne data-speicher oder als Olympia-Disziplin
  var unterwegs = false, fragtGerade = false, angehalten = false, letzterAbgleich = 0;

  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
    return null;
  }
  function gehoertDazu(k) {
    var i;
    for (i = 0; i < OHNE.length; i++) if (k.indexOf(OHNE[i]) === 0) return false;
    for (i = 0; i < PRAEFIXE.length; i++) if (k.indexOf(PRAEFIXE[i]) === 0) return true;
    return false;
  }
  function standLesen() {
    var w = {}, k = [];
    try { for (var i = 0; i < localStorage.length; i++) if (gehoertDazu(localStorage.key(i))) k.push(localStorage.key(i)); } catch (e) {}
    k.sort().forEach(function (x) { var v = ls(x); if (v !== null) w[x] = v; });
    return w;
  }
  // cyrb53: kurzer, schneller Hash – nur zum Vergleichen, nicht als Schutz
  function hashVon(w) {
    var t = JSON.stringify(w), h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < t.length; i++) { var c = t.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16) + '-' + t.length;
  }
  function syncLesen() { try { return JSON.parse(ls(KEY_SYNC)) || {}; } catch (e) { return {}; } }
  function syncSetzen(hash, zeit) { ls(KEY_SYNC, JSON.stringify({ hash: hash, zeit: zeit || Date.now() })); }
  function cloudAn() { return !cloudAus && !!name && !!ls(KEY_PIN); }
  function zugang(extra) { var o = { name: name, pin: ls(KEY_PIN), spiel: SPIEL }; for (var a in extra) o[a] = extra[a]; return o; }
  function wann(z) { var d = new Date(z); return d.toLocaleDateString('de-DE') + ' um ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'; }

  function hinweis(text) {
    if (!document.body) return;
    var t = document.createElement('div'); t.setAttribute('role', 'status'); t.textContent = text;
    t.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483646;max-width:calc(100vw - 32px);padding:10px 16px;border-radius:12px;background:#13315c;color:#fff;font:15px system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:none';
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 4000);
  }
  // Die PIN stimmt nicht mehr (z. B. zurückgesetzt): abmelden, der Stand auf dem Gerät bleibt
  function pinFalsch() { ls(KEY_PIN, null); ls(KEY_SYNC, null); hinweis('☁️ Die PIN passt nicht mehr – bitte im Spielstand-Menü neu verbinden.'); }

  function hochladen(beacon, basis) {
    if (!cloudAn() || unterwegs || fragtGerade || angehalten) return;
    var w = standLesen(), h = hashVon(w), b = syncLesen().hash || '';
    if (h === b && basis === undefined) return;
    var o = zugang({ werte: w, hash: h, basis: basis !== undefined ? basis : b });
    if (beacon) {   // beim Schließen: ohne auf die Antwort zu warten (keepalive kann nur kleine Mengen)
      if (JSON.stringify(o).length < 60000) anfrage('/api/stand/sichern', o, true).catch(function () {});
      return;
    }
    unterwegs = true;
    return anfrage('/api/stand/sichern', o).then(function (r) {
      unterwegs = false;
      if (r.status === 200) syncSetzen(h, r.j.zeit);
      else if (r.status === 409) abgleich();
      else if (r.status === 403) pinFalsch();
      return r;
    }, function (e) { unterwegs = false; dbg('Sichern ging nicht: ' + e.message); });
  }

  function uebernehmen(s) {
    Object.keys(standLesen()).forEach(function (k) { ls(k, null); });
    Object.keys(s.werte || {}).forEach(function (k) { if (gehoertDazu(k)) ls(k, s.werte[k]); });
    syncSetzen(s.hash, s.zeit);
    try { sessionStorage.setItem('sl_geladen', '1'); } catch (e) {}
    location.reload();
  }

  function abgleich() {
    if (!cloudAn() || unterwegs || fragtGerade || angehalten) return Promise.resolve();
    unterwegs = true; letzterAbgleich = Date.now();
    var vorher = hashVon(standLesen());
    return anfrage('/api/stand/laden', zugang()).then(function (r) {
      unterwegs = false;
      if (r.status === 403) return pinFalsch();
      if (r.status !== 200) return;
      var s = r.j.stand, w = standLesen(), h = hashVon(w), b = syncLesen().hash || '';
      if (!s) return hochladen(false, '');
      if (s.hash === h) return syncSetzen(h, s.zeit);
      var cloudNeu = s.hash !== b, hierNeu = b ? h !== b : Object.keys(w).length > 0;
      if (!cloudNeu) return hochladen();
      // Nur übernehmen, wenn hier während der Anfrage nichts passiert ist
      if (!hierNeu && h === vorher) return uebernehmen(s);
      konfliktZeigen(s);
    }, function (e) { unterwegs = false; dbg('Abgleich ging nicht: ' + e.message); });
  }

  function konfliktZeigen(s) {
    if (fragtGerade) return;
    fragtGerade = true;
    var f = fenster('☁️ Welcher Spielstand?', 'In der Cloud liegt ein anderer Spielstand von ' + name + ' (gesichert am ' + wann(s.zeit) + '). Auf diesem Gerät hat sich aber auch etwas geändert. Welchen willst du behalten? Der andere wird überschrieben.');
    f.knopf('☁️ Den aus der Cloud laden', true, function () { f.d.remove(); fragtGerade = false; uebernehmen(s); });
    f.knopf('💻 Den von diesem Gerät behalten', true, function () { f.d.remove(); fragtGerade = false; hochladen(false, s.hash); });
    f.knopf('Später entscheiden', false, function () { f.d.remove(); fragtGerade = false; angehalten = true; hinweis('☁️ Bis zum Neuladen wird nichts in die Cloud gesichert.'); });
    f.zeigen();
  }

  // Dialog: verbinden oder Status zeigen
  function cloudZeigen() {
    if (cloudAus) return;
    if (cloudAn()) {
      var st = syncLesen();
      var f = fenster('☁️ Spielstand in der Cloud', 'Verbunden als ' + name + '. Dein Spielstand wird automatisch gesichert und auf deinen anderen Geräten geladen.' +
        (st.zeit ? ' Zuletzt abgeglichen am ' + wann(st.zeit) + '.' : ''));
      var fe = f.fehler();
      f.knopf('Fertig', true, function () { f.d.remove(); });
      f.knopf('Jetzt abgleichen', false, function () {
        angehalten = false; fe.textContent = 'Einen Moment …';
        abgleich().then(function () { var z = syncLesen().zeit; fe.textContent = z ? 'Abgeglichen am ' + wann(z) + '.' : 'Cloud gerade nicht erreichbar.'; });
      });
      f.knopf('Auf diesem Gerät abmelden', false, function () { ls(KEY_PIN, null); ls(KEY_SYNC, null); f.d.remove(); hinweis('☁️ Abgemeldet. Der Spielstand auf diesem Gerät bleibt.'); });
      return f.zeigen();
    }
    var g = fenster('☁️ Spielstand auf allen Geräten', 'Mit deinem Namen und einer PIN spielst du auf jedem Gerät mit deinem Spielstand weiter. Beim ersten Mal legst du die PIN selbst fest – merk sie dir gut!');
    var sel = g.feld('select', { 'aria-label': 'Name' }), inp = g.feld('input', { placeholder: 'Oder neuer Name', maxlength: '16', 'aria-label': 'Neuer Name' });
    var pin = g.feld('input', { type: 'password', placeholder: 'PIN (mindestens 4 Zeichen)', maxlength: '32', autocomplete: 'current-password', 'aria-label': 'PIN' });
    var fehler = g.fehler();
    namenFuellen(sel, name);
    g.knopf('Verbinden', true, function () {
      var n = (inp.value.trim() || sel.value).slice(0, 16), p = pin.value;
      if (n.length < 2) { fehler.textContent = 'Bitte einen Namen wählen oder eingeben.'; return; }
      if (p.length < 4) { fehler.textContent = 'Die PIN braucht mindestens 4 Zeichen.'; return; }
      fehler.textContent = 'Einen Moment …';
      anfrage('/api/stand/anmelden', { name: n, pin: p }).then(function (r) {
        if (r.status !== 200) { fehler.textContent = r.j.fehler || 'Hat nicht geklappt.'; return; }
        if (r.j.name !== name) ls(KEY_SYNC, null);   // anderer Name: neu abgleichen
        name = r.j.name; schreiben(name); ls(KEY_PIN, p); angehalten = false;
        g.d.remove();
        hinweis(r.j.neu ? '☁️ PIN festgelegt – dein Spielstand wird jetzt gesichert.' : '☁️ Verbunden als ' + name + '.');
        abgleich();
      }, function () { fehler.textContent = 'Cloud gerade nicht erreichbar. Versuch es gleich nochmal.'; });
    });
    g.knopf('Abbrechen', false, function () { g.d.remove(); });
    g.zeigen();
  }

  function knoepfeAnbinden() {
    if (cloudAus) return;
    var k = document.querySelectorAll('[data-sl-cloud]');
    for (var i = 0; i < k.length; i++) { k[i].hidden = false; k[i].addEventListener('click', cloudZeigen); }
  }

  function start() {
    dbg('gestartet, Name: ' + (name || '(keiner)') + ', Dienst: ' + API);
    if (!name) { if (!inOlymp()) wahlZeigen(); } else { var pr = post('/api/spieler', { name: name, spiel: SPIEL }); if (pr) pr.catch(function () {}); }
    if (inOlymp()) cloudAus = true;
    knoepfeAnbinden();
    try { if (sessionStorage.getItem('sl_geladen')) { sessionStorage.removeItem('sl_geladen'); hinweis('☁️ Spielstand aus der Cloud geladen.'); } } catch (e) {}
    abgleich();
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  window.SLRang = { melde: function (w) { melde(w); }, spiel: SPIEL, cloud: cloudZeigen };
})();
