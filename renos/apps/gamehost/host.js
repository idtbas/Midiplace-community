/*
 * RenOS Spiele-Host – Host-Seite (läuft im iframe von RenOS, auf dem Spiele-Origin).
 *
 * Ablauf:
 *  1. meldet sich bei RenOS („ready“) und erhält einen MessagePort („init“)
 *  2. registriert den Service Worker (liefert /play/<spiel>/… aus)
 *  3. lädt das Spiel in einem inneren iframe
 *  4. leitet Dateianfragen des Service Workers an RenOS weiter und Statusmeldungen der Bridge zurück
 *
 * Die Spieldateien liegen im Speicher von RenOS (dem iPad), nicht auf diesem Server.
 */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var gameId = params.get('game') || '';
  var port = null;
  var appOrigin = null;
  var frame = null;
  var nextRequest = 1;
  var waiting = new Map();

  function toParent(msg) {
    msg.source = 'renos-host';
    msg.v = 1;
    // Vor dem Handshake ist der Empfänger-Origin noch unbekannt; die Nachricht enthält keine Daten.
    window.parent.postMessage(msg, appOrigin || '*');
  }

  function fail(reason) {
    if (port) port.postMessage({ type: 'host-error', reason: reason });
    else toParent({ type: 'host-error', reason: reason });
  }

  if (window.parent === window || !/^[a-z0-9]{24}$/.test(gameId)) {
    document.body.textContent = 'Dieses Spiel kann nur aus RenOS gestartet werden.';
    return;
  }
  if (!('serviceWorker' in navigator)) {
    toParent({ type: 'host-error', reason: 'no-service-worker' });
    return;
  }

  // Antworten von RenOS (über den MessagePort).
  function onAppMessage(event) {
    var msg = event.data || {};
    if (msg.type === 'file' && waiting.has(msg.reqId)) {
      var reply = waiting.get(msg.reqId);
      waiting.delete(msg.reqId);
      reply.postMessage({ ok: !!msg.ok, file: msg.ok ? msg.file : null, appOrigin: appOrigin });
    }
  }

  // Dateianfragen des Service Workers.
  navigator.serviceWorker.addEventListener('message', function (event) {
    var msg = event.data || {};
    var reply = event.ports && event.ports[0];
    if (msg.type !== 'file-request' || !reply) return;
    if (msg.gameId !== gameId || !port) {
      reply.postMessage({ ok: false, file: null, appOrigin: appOrigin });
      return;
    }
    var reqId = nextRequest++;
    waiting.set(reqId, reply);
    port.postMessage({ type: 'file', reqId: reqId, path: msg.path });
  });
  if (navigator.serviceWorker.startMessages) navigator.serviceWorker.startMessages();

  // Statusmeldungen der Bridge im Spiel (gleicher Origin) an RenOS weitergeben.
  window.addEventListener('message', function (event) {
    if (frame && event.source === frame.contentWindow && event.origin === location.origin) {
      var data = event.data;
      if (data && data.source === 'renos-bridge' && port) port.postMessage({ type: 'bridge', payload: data });
      return;
    }
    if (event.source !== window.parent) return;
    var init = event.data || {};
    if (port || init.source !== 'renos' || init.type !== 'init' || init.gameId !== gameId || !event.ports || !event.ports[0]) return;
    appOrigin = event.origin;
    port = event.ports[0];
    port.onmessage = onAppMessage;
    start();
  });

  // Tastaturfokus an das Spiel weiterreichen.
  window.addEventListener('focus', function () {
    if (frame && frame.contentWindow) frame.contentWindow.focus();
  });

  function whenActive(registration) {
    return new Promise(function (resolve) {
      var worker = registration.active || registration.waiting || registration.installing;
      if (registration.active && registration.active.state === 'activated') return resolve();
      if (!worker) return resolve();
      worker.addEventListener('statechange', function () {
        if (worker.state === 'activated') resolve();
      });
    });
  }

  function start() {
    navigator.serviceWorker
      .register('sw.js', { scope: './' })
      .then(function (registration) {
        return whenActive(registration);
      })
      .then(function () {
        frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads allow-pointer-lock');
        frame.setAttribute('allow', 'autoplay; fullscreen; gamepad');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.title = 'Spiel';
        frame.src = 'play/' + gameId + '/index.html';
        frame.addEventListener('load', function () {
          if (frame.contentWindow) frame.contentWindow.focus();
        });
        document.body.appendChild(frame);
        port.postMessage({ type: 'host-started' });
      })
      .catch(function (error) {
        fail('service-worker: ' + (error && error.message ? error.message : String(error)));
      });
  }

  toParent({ type: 'ready' });
})();
