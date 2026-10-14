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

  function post(pfad, obj, beacon) {
    var body = JSON.stringify(obj);
    try {
      if (beacon && navigator.sendBeacon) return navigator.sendBeacon(API + pfad, new Blob([body], { type: 'text/plain' }));
      return fetch(API + pfad, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) {}
  }

  function senden(beacon) {
    if (!name || ruhe) return;
    var o = { spiel: SPIEL, spieler: name };
    var etwas = false;
    if (offen.sekunden >= 1) { o.sekunden = Math.round(offen.sekunden); offen.sekunden = 0; etwas = true; }
    if (offen.punkte !== null && offen.punkte > gesendet.punkte) { o.punkte = gesendet.punkte = offen.punkte; etwas = true; }
    if (offen.progress !== null && offen.progress > gesendet.progress) { o.progress = gesendet.progress = offen.progress; etwas = true; }
    if (offen.zeitAlt !== null && offen.zeitAlt > gesendet.zeitAlt) { o.zeitAlt = gesendet.zeitAlt = offen.zeitAlt; etwas = true; }
    if (etwas) post('/api/melden', o, beacon);
  }

  function melde(w) {
    if (!w) return;
    if (typeof w.punkte === 'number' && isFinite(w.punkte)) offen.punkte = Math.max(offen.punkte || 0, w.punkte);
    if (typeof w.progress === 'number' && isFinite(w.progress)) offen.progress = Math.max(offen.progress || 0, Math.min(100, w.progress));
    if (typeof w.zeitAlt === 'number' && isFinite(w.zeitAlt)) offen.zeitAlt = Math.max(offen.zeitAlt || 0, w.zeitAlt);
  }
  function adapterLesen() {
    try { if (typeof window.SLRangAdapter === 'function') melde(window.SLRangAdapter()); } catch (e) {}
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
      fetch(API + '/api/spieler', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ name: n }) })
        .then(function (r) { return r.json(); })
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
  function start() { if (!name) { if (!inOlymp()) wahlZeigen(); } else post('/api/spieler', { name: name }); }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  window.SLRang = { melde: function (w) { melde(w); }, spiel: SPIEL };
})();
