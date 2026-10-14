/* Melder der Swimming-Lions-Spielesammlung.
   Wird in jedes Spiel eingebunden:
     <script src="https://…/melder.js" data-spiel="Blaue Stunde" defer></script>
   Er zählt die Spielzeit automatisch und schickt Punkte und Progress an die Rangliste.
   Optional definiert das Spiel window.SLRangAdapter = () => ({ punkte, progress, zeitAlt }).
   Der Melder liest das alle 20 Sekunden aus (auch die alten Werte, die das Spiel schon gespeichert hat). */
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
  setInterval(function () { adapterLesen(); senden(false); }, 20000);
  addEventListener('pagehide', function () { adapterLesen(); senden(true); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { adapterLesen(); senden(true); } });
  setTimeout(function () { adapterLesen(); senden(false); }, 4000);

  // Namenswahl, falls noch kein Name bekannt ist
  function wahlZeigen() {
    var d = document.createElement('div');
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Wer spielt?');
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;background:rgba(8,20,36,.7);font:16px system-ui,-apple-system,sans-serif';
    var k = document.createElement('div');
    k.style.cssText = 'width:min(340px,calc(100vw - 32px));background:#fff;color:#13315c;border-radius:16px;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.4)';
    k.innerHTML = '<h2 style="margin:0 0 4px;font-size:1.2rem">🏆 Wer spielt?</h2><p style="margin:0 0 12px;color:#3d5a80">Damit dein Ergebnis in die Rangliste der Sammlung kommt.</p>';
    var sel = document.createElement('select'), inp = document.createElement('input'), ok = document.createElement('button'), nein = document.createElement('button'), fehler = document.createElement('p');
    var stil = 'width:100%;min-height:44px;font:inherit;padding:0 12px;border-radius:10px;border:1px solid #9bb;margin:0 0 8px;box-sizing:border-box;background:#f3fbfc;color:#13315c';
    sel.style.cssText = stil; inp.style.cssText = stil;
    inp.placeholder = 'Oder neuer Name'; inp.maxLength = 16; inp.setAttribute('aria-label', 'Neuer Name');
    ok.textContent = 'Los'; nein.textContent = 'Nicht mitzählen';
    ok.style.cssText = 'width:100%;min-height:44px;font:inherit;font-weight:800;border:0;border-radius:10px;background:#13315c;color:#fff;margin:0 0 8px;cursor:pointer';
    nein.style.cssText = 'width:100%;min-height:44px;font:inherit;border:0;background:none;color:#3d5a80;cursor:pointer;text-decoration:underline';
    fehler.style.cssText = 'color:#c2332b;margin:0 0 8px;min-height:1em'; fehler.setAttribute('role', 'alert');
    var o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'Name wählen …'; sel.appendChild(o0);
    fetch(API + '/api/rangliste').then(function (r) { return r.json(); }).then(function (j) {
      (j.spieler || []).sort().forEach(function (n) { var o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
    }).catch(function () {});
    ok.onclick = function () {
      var n = (inp.value.trim() || sel.value).slice(0, 16);
      if (n.length < 2) { fehler.textContent = 'Bitte einen Namen wählen oder eingeben.'; return; }
      post('/api/spieler', { name: n })
        .then(function (j) { if (!j.ok) { fehler.textContent = j.fehler || 'Hat nicht geklappt.'; return; } name = j.name; schreiben(name); d.remove(); adapterLesen(); senden(false); })
        .catch(function () { fehler.textContent = 'Rangliste gerade nicht erreichbar.'; });
    };
    nein.onclick = function () { ruhe = true; d.remove(); };
    [sel, inp, fehler, ok, nein].forEach(function (x) { k.appendChild(x); });
    d.appendChild(k); document.body.appendChild(d);
  }
  // Als Olympia-Disziplin (Ticket im Link oder in der Sitzung) keine Namensabfrage einblenden
  function inOlymp() {
    try {
      if (/[?&]olymp=/.test(location.search)) return true;
      for (var i = 0; i < sessionStorage.length; i++) if (/olymp/i.test(sessionStorage.key(i))) return true;
    } catch (e) {}
    return false;
  }
  function start() {
    dbg('gestartet, Name: ' + (name || '(keiner)') + ', Dienst: ' + API);
     if (!name) { if (!inOlymp()) wahlZeigen(); } else { var pr = post('/api/spieler', { name: name }); if (pr) pr.catch(function () {}); } }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  window.SLRang = { melde: function (w) { melde(w); }, spiel: SPIEL };
})();
