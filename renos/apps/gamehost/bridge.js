/*
 * RenOS-Bridge für den lokalen Modus. Wird vom Service Worker in die index.html jedes Spiels eingefügt.
 * Meldet nur den Status der Ren'Py-Laufzeit an die Host-Seite (gleicher Origin), die ihn an RenOS weitergibt.
 * Keine UI, keine zusätzlichen Rechte. Einzige weitergeleitete Taste: ⌥⇧Esc.
 */
(function () {
  'use strict';
  if (window.parent === window) return;
  var TARGET = location.origin;
  function post(msg) {
    msg.source = 'renos-bridge';
    msg.v = 1;
    try { window.parent.postMessage(msg, TARGET); } catch { /* ignorieren */ }
  }
  post({ type: 'boot' });

  try {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then(function (p) { post({ type: 'storage', persisted: !!p }); },
        function () { post({ type: 'storage', persisted: null }); });
    } else {
      post({ type: 'storage', persisted: null });
    }
  } catch { post({ type: 'storage', persisted: null }); }

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && e.altKey && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'exit-request' });
    }
  }, true);

  var done = false, sawPresplash = false, lastProgress = -1, calledRunAt = 0, started = Date.now();
  function check() {
    if (done) return;
    try {
      var status = document.getElementById('statusTextDiv');
      var text = status ? (status.textContent || '') : '';
      if (/More information may be available|aborted unexpectedly/i.test(text)) {
        done = true;
        post({ type: 'error', message: text.slice(-400) });
        return;
      }
      var bar = document.getElementById('statusProgress');
      if (bar && bar.style.display === 'block' && bar.max > 0 && bar.value !== lastProgress) {
        lastProgress = bar.value;
        post({ type: 'progress', done: Number(bar.value), total: Number(bar.max) });
      }
      var presplash = document.getElementById('presplash');
      if (presplash) sawPresplash = true;
      var M = window.Module;
      if (M && M.calledRun && !calledRunAt) calledRunAt = Date.now();
      if ((sawPresplash && !presplash) || (!sawPresplash && calledRunAt && Date.now() - calledRunAt > 3000)) {
        done = true;
        post({ type: 'running' });
        return;
      }
    } catch { /* ignorieren */ }
    if (Date.now() - started < 15 * 60 * 1000) setTimeout(check, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
})();
