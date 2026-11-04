/**
 * Die RenOS-Bridge wird vom Game-Host in die `index.html` jedes Spiels eingefügt.
 *
 * Sie läuft im Origin des Spiels (nicht in RenOS) und hat keine zusätzlichen Rechte.
 * Aufgaben:
 *   - Ladefortschritt, Start und Fehler der Ren'Py-Laufzeit an RenOS melden
 *   - dauerhaften Speicher für Spielstände anfordern (best effort)
 *   - genau eine dokumentierte Tastenkombination (⌥ ⇧ Esc) an RenOS weiterleiten, alle anderen Tasten
 *     bleiben unangetastet beim Spiel
 * Nachrichten gehen ausschließlich an den konfigurierten RenOS-Origin.
 */
export function bridgeScript(appOrigin: string): string {
  return `/* RenOS bridge – nur Statusmeldungen, keine UI. */
(function () {
  'use strict';
  var TARGET = ${JSON.stringify(appOrigin)};
  if (window.parent === window) return;
  function post(msg) {
    msg.source = 'renos-bridge';
    msg.v = 1;
    try { window.parent.postMessage(msg, TARGET); } catch (e) { /* ignorieren */ }
  }
  post({ type: 'boot' });

  try {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then(function (p) { post({ type: 'storage', persisted: !!p }); },
        function () { post({ type: 'storage', persisted: null }); });
    } else {
      post({ type: 'storage', persisted: null });
    }
  } catch (e) { post({ type: 'storage', persisted: null }); }

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && e.altKey && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'exit-request' });
    }
  }, true);

  var done = false;
  var sawPresplash = false;
  var lastProgress = -1;
  var calledRunAt = 0;
  var started = Date.now();
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
    } catch (e) { /* ignorieren */ }
    if (Date.now() - started < 15 * 60 * 1000) setTimeout(check, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
})();
`;
}

/** Fügt das Bridge-Skript möglichst früh in den `<head>` der Spielseite ein. */
export function injectBridge(html: string, scriptPath: string): string {
  const tag = `<script src="${scriptPath}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}\n${tag}${html.slice(at)}`;
  }
  return `${tag}\n${html}`;
}
