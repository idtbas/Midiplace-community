/*
 * RenOS Spiele-Host – Service Worker.
 *
 * - /play/<spiel>/<pfad>: Die Datei wird über die Host-Seite bei RenOS angefragt (Speicher des iPads)
 *   und mit korrektem MIME-Typ, Range-Unterstützung und strenger CSP ausgeliefert.
 * - Alle anderen Dateien des Hosts werden für den Offline-Betrieb zwischengespeichert.
 */
'use strict';

var VERSION = 'renos-gamehost-v1';
var SHELL = ['./', 'index.html', 'host.html', 'host.js', 'bridge.js', 'renos-gamehost.json'];
var GAME_ID = /^[a-z0-9]{24}$/;

var MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8',
  wasm: 'application/wasm', data: 'application/octet-stream', zip: 'application/zip', symbols: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif',
  svg: 'image/svg+xml', ico: 'image/x-icon', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf'
};

function mimeFor(path) {
  var base = path.split('/').pop() || '';
  var dot = base.lastIndexOf('.');
  return (dot >= 0 && MIME[base.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

/*
 * Notwendige Ausnahmen für Ren'Py: Inline-Skripte, eval (emscripten_run_script) und WebAssembly.
 * connect-src 'self' verhindert Netzwerkzugriffe auf fremde Server.
 */
function gameCsp(appOrigin) {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    'frame-ancestors ' + ["'self'", appOrigin].filter(Boolean).join(' ')
  ].join('; ');
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) { return cache.addAll(SHELL); }).catch(function () { /* offline-Installation optional */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('renos-gamehost-') === 0 && k !== VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function hostClientFor(gameId) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i += 1) {
      var url = new URL(list[i].url);
      if (/\/host\.html$/.test(url.pathname) && url.searchParams.get('game') === gameId) return list[i];
    }
    return null;
  });
}

function requestFile(client, gameId, path) {
  return new Promise(function (resolve) {
    var channel = new MessageChannel();
    var timer = setTimeout(function () { resolve({ ok: false }); }, 30000);
    channel.port1.onmessage = function (event) {
      clearTimeout(timer);
      resolve(event.data || { ok: false });
    };
    client.postMessage({ type: 'file-request', gameId: gameId, path: path }, [channel.port2]);
  });
}

function notFound(text) {
  return new Response(text || 'Nicht gefunden', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function parseRange(header, size) {
  var match = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  var start, end;
  if (match[1] === '') {
    start = Math.max(size - Number(match[2]), 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start: start, end: end };
}

function serveGameFile(request, gameId, path) {
  return hostClientFor(gameId).then(function (client) {
    if (!client) return notFound('Dieses Spiel kann nur aus RenOS gestartet werden.');
    return requestFile(client, gameId, path).then(function (reply) {
      if (!reply.ok || !reply.file) return notFound();
      var file = reply.file;
      var headers = {
        'Content-Type': mimeFor(path),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Accept-Ranges': 'bytes'
      };
      if (path === 'index.html') {
        return file.text().then(function (html) {
          var tag = '<script src="' + new URL('bridge.js', self.registration.scope).href + '"></script>';
          var head = /<head(\s[^>]*)?>/i.exec(html);
          var out = head ? html.slice(0, head.index + head[0].length) + '\n' + tag + html.slice(head.index + head[0].length) : tag + '\n' + html;
          headers['Content-Security-Policy'] = gameCsp(reply.appOrigin);
          return new Response(out, { status: 200, headers: headers });
        });
      }
      var range = request.headers.get('Range') ? parseRange(request.headers.get('Range'), file.size) : null;
      if (range === 'invalid') {
        headers['Content-Range'] = 'bytes */' + file.size;
        return new Response(null, { status: 416, headers: headers });
      }
      if (range) {
        headers['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + file.size;
        headers['Content-Length'] = String(range.end - range.start + 1);
        return new Response(file.slice(range.start, range.end + 1), { status: 206, headers: headers });
      }
      headers['Content-Length'] = String(file.size);
      return new Response(file, { status: 200, headers: headers });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  var scope = new URL(self.registration.scope);
  if (url.pathname.indexOf(scope.pathname) !== 0) return;
  var rest = url.pathname.slice(scope.pathname.length);

  if (rest.indexOf('play/') === 0) {
    var parts = rest.slice(5).split('/');
    var gameId = parts.shift() || '';
    var path;
    try {
      path = parts.map(decodeURIComponent).join('/');
    } catch {
      event.respondWith(notFound());
      return;
    }
    if (!GAME_ID.test(gameId)) {
      event.respondWith(notFound());
      return;
    }
    if (path === '' || path.slice(-1) === '/') path += 'index.html';
    event.respondWith(serveGameFile(request, gameId, path));
    return;
  }

  // Host-Dateien: aus dem Netz (aktuell) mit Rückfall auf den Offline-Speicher.
  event.respondWith(
    fetch(request).then(function (response) {
      if (response.ok) {
        var copy = response.clone();
        caches.open(VERSION).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    }).catch(function () {
      return caches.match(request, { ignoreSearch: true }).then(function (cached) { return cached || notFound(); });
    })
  );
});
