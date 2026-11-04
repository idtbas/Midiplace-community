/*
 * RenOS – eingebauter Spiele-Host: Laufzeit im Spiel-iframe.
 *
 * Das iframe hat das Attribut sandbox OHNE allow-same-origin und damit einen eigenen, anonymen
 * Origin („opaque origin“). Das Spiel kann weder auf RenOS (DOM, Speicher, Cookies) noch auf andere
 * Spiele zugreifen. Weil ein solcher Origin weder Netzwerk-Origin noch Service Worker noch
 * IndexedDB hat, stellt diese Laufzeit dem Spiel das Nötige bereit:
 *
 *   - Dateien des Spiels: fetch(), XMLHttpRequest, <img>/<video>/<audio> auf die virtuelle Adresse
 *     BASE werden über einen MessagePort bei RenOS angefragt (nur lesend, nur dieses Spiel).
 *   - Spielstände: eine kleine IndexedDB-Nachbildung (genau der Umfang, den Emscriptens IDBFS
 *     nutzt). Änderungen schickt sie an RenOS, das sie pro Spiel getrennt speichert.
 *   - localStorage/sessionStorage im Arbeitsspeicher, kein Service Worker, keine Cookies.
 *
 * Alles, was von hier kommt, behandelt RenOS als nicht vertrauenswürdig – das Spiel läuft im
 * selben Origin wie diese Laufzeit und könnte sie verändern.
 *
 * Wird als Text in das srcdoc des iframes eingesetzt; den Platzhalter in der letzten Zeile ersetzt RenOS
 * durch die Konfiguration (JSON).
 */
(function (CONFIG) {
  'use strict';

  var BASE = CONFIG.base;
  var PARENT_ORIGIN = CONFIG.parentOrigin;
  var NativeURL = window.URL;
  var nativeFetch = window.fetch.bind(window);

  var port = null;
  var nextRequest = 1;
  var waiting = new Map();
  var fileCache = new Map();
  var started = false;

  var MIME = {
    html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
    json: 'application/json', txt: 'text/plain', xml: 'application/xml', wasm: 'application/wasm',
    data: 'application/octet-stream', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', svg: 'image/svg+xml',
    ico: 'image/x-icon', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
    wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
    ogv: 'video/ogg', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf'
  };

  function mimeFor(path) {
    var name = path.split('/').pop() || '';
    var dot = name.lastIndexOf('.');
    return (dot >= 0 && MIME[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
  }

  // ---------------------------------------------------------------------------
  // Verbindung zu RenOS
  // ---------------------------------------------------------------------------

  function toParent(msg) {
    msg.source = 'renos-sandbox';
    msg.v = 1;
    window.parent.postMessage(msg, PARENT_ORIGIN);
  }

  function bridge(payload) {
    payload.source = 'renos-bridge';
    payload.v = 1;
    if (port) port.postMessage({ type: 'bridge', payload: payload });
  }

  function request(msg) {
    return new Promise(function (resolve) {
      if (!port) {
        resolve(null);
        return;
      }
      var id = nextRequest++;
      msg.reqId = id;
      waiting.set(id, resolve);
      port.postMessage(msg);
    });
  }

  function onPortMessage(event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init' && !started) {
      started = true;
      SaveStore.preload(Array.isArray(msg.saves) ? msg.saves : []);
      boot();
      return;
    }
    if (typeof msg.reqId === 'number' && waiting.has(msg.reqId)) {
      var resolve = waiting.get(msg.reqId);
      waiting.delete(msg.reqId);
      resolve(msg);
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || port) return;
    var data = event.data;
    if (!data || data.source !== 'renos' || data.v !== 1 || data.type !== 'init' || !event.ports || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = onPortMessage;
  });

  // ---------------------------------------------------------------------------
  // Dateien des Spiels (virtuelle Adresse BASE)
  // ---------------------------------------------------------------------------

  function resolveUrl(input) {
    try {
      return new NativeURL(String(input), document.baseURI);
    } catch {
      return null;
    }
  }

  /** Pfad innerhalb des Spiels oder null, wenn die Adresse nicht zum Spiel gehört. */
  function gamePath(url) {
    if (!url || url.href.indexOf(BASE) !== 0) return null;
    var rest = url.pathname.slice(new NativeURL(BASE).pathname.length);
    try {
      rest = rest.split('/').map(decodeURIComponent).join('/');
    } catch {
      return null;
    }
    if (rest === '' || rest.slice(-1) === '/') rest += 'index.html';
    return rest;
  }

  function getFile(path) {
    var cached = fileCache.get(path);
    if (cached) return cached;
    var pending = request({ type: 'file', path: path }).then(function (reply) {
      return reply && reply.ok && reply.file instanceof Blob ? reply.file : null;
    });
    fileCache.set(path, pending);
    return pending;
  }

  function headerValue(headers, name) {
    if (!headers) return null;
    try {
      return new Headers(headers).get(name);
    } catch {
      return null;
    }
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

  function gameResponse(path, method, rangeHeader) {
    return getFile(path).then(function (file) {
      if (!file) return new Response('Nicht gefunden', { status: 404, statusText: 'Not Found' });
      var headers = { 'Content-Type': mimeFor(path), 'Accept-Ranges': 'bytes' };
      var range = rangeHeader ? parseRange(rangeHeader, file.size) : null;
      if (range === 'invalid') {
        headers['Content-Range'] = 'bytes */' + file.size;
        return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers: headers });
      }
      if (range) {
        headers['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + file.size;
        headers['Content-Length'] = String(range.end - range.start + 1);
        return new Response(method === 'HEAD' ? null : file.slice(range.start, range.end + 1), { status: 206, statusText: 'Partial Content', headers: headers });
      }
      headers['Content-Length'] = String(file.size);
      return new Response(method === 'HEAD' ? null : file, { status: 200, statusText: 'OK', headers: headers });
    });
  }

  function patchedFetch(input, init) {
    var req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    var url = resolveUrl(req ? req.url : input);
    var path = gamePath(url);
    if (path === null) return nativeFetch(input, init);
    var method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return Promise.resolve(new Response(null, { status: 405, statusText: 'Method Not Allowed' }));
    var range = headerValue(init && init.headers, 'Range') || (req ? req.headers.get('Range') : null);
    return gameResponse(path, method, range);
  }

  // XMLHttpRequest – asynchron, auf Basis von fetch(). Synchrone Anfragen nutzt Ren'Py nur in Workern.
  function VirtualXHR() {
    this.readyState = 0;
    this.status = 0;
    this.statusText = '';
    this.response = null;
    this.responseText = '';
    this.responseType = '';
    this.responseURL = '';
    this.timeout = 0;
    this.withCredentials = false;
    this.upload = { addEventListener: function () {}, removeEventListener: function () {} };
    this.onreadystatechange = null;
    this.onloadstart = null;
    this.onprogress = null;
    this.onload = null;
    this.onerror = null;
    this.onabort = null;
    this.ontimeout = null;
    this.onloadend = null;
    this._listeners = {};
    this._headers = {};
    this._responseHeaders = null;
    this._aborted = false;
  }
  VirtualXHR.UNSENT = 0;
  VirtualXHR.OPENED = 1;
  VirtualXHR.HEADERS_RECEIVED = 2;
  VirtualXHR.LOADING = 3;
  VirtualXHR.DONE = 4;
  VirtualXHR.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  VirtualXHR.prototype.removeEventListener = function (type, fn) {
    var list = this._listeners[type] || [];
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  VirtualXHR.prototype._fire = function (type, loaded, total) {
    var self = this;
    var event = {
      type: type, target: self, currentTarget: self, lengthComputable: total > 0, loaded: loaded || 0, total: total || 0,
      preventDefault: function () {}, stopPropagation: function () {}
    };
    // Fehler in Handlern des Spiels sind keine Netzwerkfehler: wie im Browser asynchron melden.
    var call = function (fn) {
      try {
        fn.call(self, event);
      } catch (error) {
        setTimeout(function () { throw error; }, 0);
      }
    };
    if (typeof self['on' + type] === 'function') call(self['on' + type]);
    (self._listeners[type] || []).slice().forEach(call);
  };
  VirtualXHR.prototype._state = function (state) {
    this.readyState = state;
    this._fire('readystatechange');
  };
  VirtualXHR.prototype.open = function (method, url, async) {
    if (async === false) throw new DOMException('Synchrone Anfragen werden nicht unterstützt.', 'InvalidAccessError');
    this._method = String(method || 'GET').toUpperCase();
    var resolved = resolveUrl(url);
    this._url = resolved ? resolved.href : String(url);
    this._aborted = false;
    this._state(1);
  };
  VirtualXHR.prototype.setRequestHeader = function (name, value) {
    this._headers[name] = value;
  };
  VirtualXHR.prototype.overrideMimeType = function () {};
  VirtualXHR.prototype.getResponseHeader = function (name) {
    return this._responseHeaders ? this._responseHeaders.get(name) : null;
  };
  VirtualXHR.prototype.getAllResponseHeaders = function () {
    if (!this._responseHeaders) return '';
    var out = '';
    this._responseHeaders.forEach(function (value, key) { out += key + ': ' + value + '\r\n'; });
    return out;
  };
  VirtualXHR.prototype.abort = function () {
    if (this.readyState === 0 || this.readyState === 4) return;
    this._aborted = true;
    this.status = 0;
    this._state(4);
    this._fire('abort');
    this._fire('loadend');
  };
  VirtualXHR.prototype.send = function (body) {
    var self = this;
    self._fire('loadstart', 0, 0);
    patchedFetch(self._url, { method: self._method, headers: self._headers, body: body === undefined ? null : body })
      .then(function (response) {
        if (self._aborted) return null;
        self.status = response.status;
        self.statusText = response.statusText;
        self.responseURL = self._url;
        self._responseHeaders = response.headers;
        self._state(2);
        self._state(3);
        var type = self.responseType;
        var read = type === 'arraybuffer' ? response.arrayBuffer() : type === 'blob' ? response.blob() : response.text();
        return read.then(function (value) {
          if (self._aborted) return;
          var size = type === 'arraybuffer' ? value.byteLength : type === 'blob' ? value.size : value.length;
          if (type === 'json') {
            try { self.response = JSON.parse(value); } catch { self.response = null; }
          } else {
            self.response = value;
            if (type === '' || type === 'text') self.responseText = value;
          }
          self._fire('progress', size, size);
          self._state(4);
          self._fire('load', size, size);
          self._fire('loadend', size, size);
        });
      })
      .catch(function () {
        if (self._aborted) return;
        self.status = 0;
        self._state(4);
        self._fire('error');
        self._fire('loadend');
      });
  };

  // <img>, <video>, <audio>, <source>: Adressen des Spiels in blob:-Adressen übersetzen.
  function patchSrc(proto) {
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'src');
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        return this.__renosSrc !== undefined ? this.__renosSrc : desc.get.call(this);
      },
      set: function (value) {
        var el = this;
        var text = String(value);
        var path = text === '' ? null : gamePath(resolveUrl(text));
        if (el.__renosBlob) {
          URL.revokeObjectURL(el.__renosBlob);
          el.__renosBlob = undefined;
        }
        if (path === null) {
          el.__renosSrc = undefined;
          desc.set.call(el, value);
          return;
        }
        var token = {};
        el.__renosToken = token;
        el.__renosSrc = text;
        getFile(path).then(function (file) {
          if (el.__renosToken !== token) return;
          if (!file) {
            desc.set.call(el, 'data:,');
            return;
          }
          el.__renosBlob = URL.createObjectURL(new Blob([file], { type: mimeFor(path) }));
          desc.set.call(el, el.__renosBlob);
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Spielstände: IndexedDB-Nachbildung für Emscriptens IDBFS
  // ---------------------------------------------------------------------------

  function makeEvent(type, target, extra) {
    var event = { type: type, target: target, currentTarget: target, defaultPrevented: false };
    event.preventDefault = function () { event.defaultPrevented = true; };
    event.stopPropagation = function () {};
    if (extra) for (var k in extra) event[k] = extra[k];
    return event;
  }

  function Emitter() {
    this._listeners = {};
  }
  Emitter.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  Emitter.prototype.removeEventListener = function (type, fn) {
    var list = this._listeners[type] || [];
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  Emitter.prototype.dispatch = function (type, extra) {
    var self = this;
    var event = makeEvent(type, self, extra);
    if (typeof self['on' + type] === 'function') self['on' + type](event);
    (self._listeners[type] || []).slice().forEach(function (fn) { fn.call(self, event); });
    return event;
  };
  function inherit(Child) {
    Child.prototype = Object.create(Emitter.prototype);
    Child.prototype.constructor = Child;
  }

  function nameList(map) {
    return {
      get length() { return map.size; },
      contains: function (name) { return map.has(name); },
      item: function (i) { return Array.from(map.keys())[i] || null; }
    };
  }

  function idbError(name, message) {
    try {
      return new DOMException(message, name);
    } catch {
      var err = new Error(message);
      err.name = name;
      return err;
    }
  }

  function validKey(key) {
    return typeof key === 'string' || (typeof key === 'number' && isFinite(key));
  }

  function clone(value) {
    return typeof structuredClone === 'function' ? structuredClone(value) : value;
  }

  var SaveStore = (function () {
    var databases = new Map(); // name -> { version, stores: Map(name -> { records: Map, indexes: Map }) }
    var staged = new Map(); // db name -> Array<{ store, key, value }>

    function preload(entries) {
      entries.forEach(function (e) {
        if (!e || typeof e.db !== 'string' || typeof e.store !== 'string' || !validKey(e.key)) return;
        if (!staged.has(e.db)) staged.set(e.db, []);
        staged.get(e.db).push(e);
      });
    }

    /** Übernimmt gespeicherte Datensätze, sobald das Spiel die Datenbank und ihre Stores angelegt hat. */
    function applyStaged(name, db) {
      var list = staged.get(name);
      if (!list) return;
      staged.delete(name);
      list.forEach(function (e) {
        var store = db.stores.get(e.store);
        if (store) store.records.set(e.key, e.value);
      });
    }

    function FakeRequest(source, transaction) {
      Emitter.call(this);
      this.result = undefined;
      this.error = null;
      this.readyState = 'pending';
      this.source = source || null;
      this.transaction = transaction || null;
      this.onsuccess = null;
      this.onerror = null;
    }
    inherit(FakeRequest);
    FakeRequest.prototype.succeed = function (result) {
      this.readyState = 'done';
      this.result = result;
      this.dispatch('success');
    };
    FakeRequest.prototype.fail = function (error) {
      this.readyState = 'done';
      this.error = error;
      return this.dispatch('error');
    };

    function OpenRequest() {
      FakeRequest.call(this, null, null);
      this.onupgradeneeded = null;
      this.onblocked = null;
    }
    OpenRequest.prototype = Object.create(FakeRequest.prototype);
    OpenRequest.prototype.constructor = OpenRequest;

    function Transaction(connection, names, mode) {
      Emitter.call(this);
      this.db = connection;
      this.mode = mode || 'readonly';
      this.error = null;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this.objectStoreNames = names;
      this._queue = [];
      this._running = false;
      this._done = false;
      this._puts = [];
      this._dels = [];
    }
    inherit(Transaction);
    Transaction.prototype.objectStore = function (name) {
      var store = this.db._data.stores.get(name);
      if (!store) throw idbError('NotFoundError', 'Object store nicht gefunden: ' + name);
      return new StoreHandle(this, name, store);
    };
    Transaction.prototype.abort = function () {
      if (this._done) return;
      this._done = true;
      this._queue = [];
      this.dispatch('abort');
    };
    Transaction.prototype._enqueue = function (fn) {
      if (this._done) throw idbError('TransactionInactiveError', 'Die Transaktion ist beendet.');
      this._queue.push(fn);
      this._schedule();
    };
    Transaction.prototype._schedule = function () {
      var tx = this;
      if (tx._running) return;
      tx._running = true;
      setTimeout(function () { tx._run(); }, 0);
    };
    Transaction.prototype._run = function () {
      var tx = this;
      while (tx._queue.length && !tx._done) {
        var fn = tx._queue.shift();
        try {
          fn();
        } catch (e) {
          tx.error = e;
          tx.dispatch('error');
          tx.abort();
          return;
        }
      }
      tx._running = false;
      if (tx._done) return;
      // Neue Anfragen aus den Callbacks? Dann weiterarbeiten, sonst abschließen.
      setTimeout(function () {
        if (tx._queue.length) tx._schedule();
        else tx._commit();
      }, 0);
    };
    Transaction.prototype._commit = function () {
      var tx = this;
      if (tx._done) return;
      tx._done = true;
      if (tx.mode === 'readonly' || (!tx._puts.length && !tx._dels.length) || tx.mode === 'versionchange') {
        tx.dispatch('complete');
        return;
      }
      request({ type: 'saves', put: tx._puts, del: tx._dels }).then(function (reply) {
        if (reply && reply.ok) {
          tx.dispatch('complete');
        } else {
          tx.error = idbError('QuotaExceededError', (reply && reply.reason) || 'RenOS konnte den Spielstand nicht speichern.');
          tx.dispatch('error');
          tx.dispatch('abort');
        }
      });
    };

    function StoreHandle(transaction, name, store) {
      this.transaction = transaction;
      this.name = name;
      this._store = store;
      this.indexNames = nameList(store.indexes);
      this.keyPath = null;
      this.autoIncrement = false;
    }
    StoreHandle.prototype._request = function (work) {
      var tx = this.transaction;
      var req = new FakeRequest(this, tx);
      tx._enqueue(function () {
        var result;
        try {
          result = work();
        } catch (e) {
          var event = req.fail(e);
          if (!event.defaultPrevented) throw e;
          return;
        }
        req.succeed(result);
      });
      return req;
    };
    StoreHandle.prototype._writable = function () {
      if (this.transaction.mode === 'readonly') throw idbError('ReadOnlyError', 'Die Transaktion ist schreibgeschützt.');
    };
    StoreHandle.prototype.get = function (key) {
      var store = this._store;
      return this._request(function () {
        return store.records.has(key) ? clone(store.records.get(key)) : undefined;
      });
    };
    StoreHandle.prototype.getAllKeys = function () {
      var store = this._store;
      return this._request(function () { return Array.from(store.records.keys()); });
    };
    StoreHandle.prototype.put = function (value, key) {
      this._writable();
      if (!validKey(key)) throw idbError('DataError', 'Ungültiger Schlüssel.');
      var self = this;
      var stored = clone(value);
      return this._request(function () {
        self._store.records.set(key, stored);
        self.transaction._puts.push({ db: self.transaction.db.name, store: self.name, key: key, value: stored });
        return key;
      });
    };
    StoreHandle.prototype.add = StoreHandle.prototype.put;
    StoreHandle.prototype.delete = function (key) {
      this._writable();
      var self = this;
      return this._request(function () {
        self._store.records.delete(key);
        self.transaction._dels.push({ db: self.transaction.db.name, store: self.name, key: key });
        return undefined;
      });
    };
    StoreHandle.prototype.clear = function () {
      this._writable();
      var self = this;
      return this._request(function () {
        self._store.records.forEach(function (_v, key) {
          self.transaction._dels.push({ db: self.transaction.db.name, store: self.name, key: key });
        });
        self._store.records.clear();
        return undefined;
      });
    };
    StoreHandle.prototype.createIndex = function (name, keyPath) {
      if (this.transaction.mode !== 'versionchange') throw idbError('InvalidStateError', 'Indizes nur beim Upgrade.');
      this._store.indexes.set(name, String(keyPath));
      return this.index(name);
    };
    StoreHandle.prototype.index = function (name) {
      if (!this._store.indexes.has(name)) throw idbError('NotFoundError', 'Index nicht gefunden: ' + name);
      return new IndexHandle(this, name, this._store.indexes.get(name));
    };

    function IndexHandle(store, name, keyPath) {
      this.objectStore = store;
      this.name = name;
      this.keyPath = keyPath;
    }
    IndexHandle.prototype._cursor = function (withValue) {
      var storeHandle = this.objectStore;
      var tx = storeHandle.transaction;
      var keyPath = this.keyPath;
      var req = new FakeRequest(this, tx);
      var entries = [];
      var position = 0;
      function step() {
        if (position >= entries.length) {
          req.succeed(null);
          return;
        }
        var entry = entries[position++];
        var cursor = {
          key: entry.key,
          primaryKey: entry.primaryKey,
          source: storeHandle,
          direction: 'next',
          continue: function () { tx._enqueue(step); }
        };
        if (withValue) cursor.value = clone(entry.value);
        req.succeed(cursor);
      }
      tx._enqueue(function () {
        storeHandle._store.records.forEach(function (value, primaryKey) {
          var key = value && typeof value === 'object' ? value[keyPath] : undefined;
          if (key !== undefined) entries.push({ key: key, primaryKey: primaryKey, value: value });
        });
        step();
      });
      return req;
    };
    IndexHandle.prototype.openKeyCursor = function () { return this._cursor(false); };
    IndexHandle.prototype.openCursor = function () { return this._cursor(true); };

    function Connection(name, data) {
      Emitter.call(this);
      this.name = name;
      this._data = data;
      this.onversionchange = null;
      this.onclose = null;
    }
    inherit(Connection);
    Object.defineProperty(Connection.prototype, 'version', { get: function () { return this._data.version; } });
    Object.defineProperty(Connection.prototype, 'objectStoreNames', { get: function () { return nameList(this._data.stores); } });
    Connection.prototype.transaction = function (names, mode) {
      var list = Array.isArray(names) ? names : [names];
      var data = this._data;
      list.forEach(function (n) {
        if (!data.stores.has(n)) throw idbError('NotFoundError', 'Object store nicht gefunden: ' + n);
      });
      return new Transaction(this, list, mode);
    };
    Connection.prototype.createObjectStore = function (name) {
      if (!this._upgrade) throw idbError('InvalidStateError', 'Stores nur beim Upgrade.');
      if (!this._data.stores.has(name)) this._data.stores.set(name, { records: new Map(), indexes: new Map() });
      return new StoreHandle(this._upgrade, name, this._data.stores.get(name));
    };
    Connection.prototype.deleteObjectStore = function (name) {
      if (!this._upgrade) throw idbError('InvalidStateError', 'Stores nur beim Upgrade.');
      this._data.stores.delete(name);
    };
    Connection.prototype.close = function () {};

    var factory = {
      open: function (name, version) {
        var req = new OpenRequest();
        name = String(name);
        setTimeout(function () {
          var data = databases.get(name);
          var oldVersion = data ? data.version : 0;
          var newVersion = version === undefined ? Math.max(oldVersion, 1) : Number(version);
          if (!(newVersion >= 1)) {
            req.fail(idbError('TypeError', 'Ungültige Version.'));
            return;
          }
          if (newVersion < oldVersion) {
            req.fail(idbError('VersionError', 'Die gespeicherte Version ist neuer.'));
            return;
          }
          if (!data) {
            data = { version: 0, stores: new Map() };
            databases.set(name, data);
          }
          var connection = new Connection(name, data);
          if (newVersion > oldVersion) {
            var upgrade = new Transaction(connection, [], 'versionchange');
            connection._upgrade = upgrade;
            data.version = newVersion;
            req.result = connection;
            req.transaction = upgrade;
            req.readyState = 'done';
            try {
              req.dispatch('upgradeneeded', { oldVersion: oldVersion, newVersion: newVersion });
            } catch (e) {
              req.transaction = null;
              req.fail(e);
              return;
            }
            connection._upgrade = null;
            req.transaction = null;
            applyStaged(name, data);
          } else {
            applyStaged(name, data);
          }
          req.succeed(connection);
        }, 0);
        return req;
      },
      deleteDatabase: function (name) {
        var req = new OpenRequest();
        setTimeout(function () {
          var data = databases.get(String(name));
          databases.delete(String(name));
          staged.delete(String(name));
          var dels = [];
          if (data) {
            data.stores.forEach(function (store, storeName) {
              store.records.forEach(function (_v, key) { dels.push({ db: String(name), store: storeName, key: key }); });
            });
          }
          (dels.length ? request({ type: 'saves', put: [], del: dels }) : Promise.resolve({ ok: true })).then(function () {
            req.succeed(undefined);
          });
        }, 0);
        return req;
      },
      cmp: function (a, b) {
        return a < b ? -1 : a > b ? 1 : 0;
      },
      databases: function () {
        return Promise.resolve(Array.from(databases.keys()).map(function (n) { return { name: n, version: databases.get(n).version }; }));
      }
    };

    return { preload: preload, factory: factory };
  })();

  // ---------------------------------------------------------------------------
  // Umgebung des Spiels vorbereiten (vor jedem Spielcode)
  // ---------------------------------------------------------------------------

  function memoryStorage() {
    var data = new Map();
    var api = {
      key: function (i) { return Array.from(data.keys())[i] || null; },
      getItem: function (k) { return data.has(String(k)) ? data.get(String(k)) : null; },
      setItem: function (k, v) { data.set(String(k), String(v)); },
      removeItem: function (k) { data.delete(String(k)); },
      clear: function () { data.clear(); }
    };
    return new Proxy(api, {
      get: function (target, prop) {
        if (prop === 'length') return data.size;
        if (prop in target) return target[prop];
        return typeof prop === 'string' && data.has(prop) ? data.get(prop) : undefined;
      },
      set: function (target, prop, value) {
        if (typeof prop === 'string') data.set(prop, String(value));
        return true;
      },
      deleteProperty: function (target, prop) {
        if (typeof prop === 'string') data.delete(prop);
        return true;
      }
    });
  }

  function define(target, name, descriptor) {
    try {
      descriptor.configurable = true;
      Object.defineProperty(target, name, descriptor);
    } catch {
      /* nicht veränderbar – das Spiel erhält dann die Fehlermeldung des Browsers */
    }
  }

  define(window, 'fetch', { value: patchedFetch, writable: true });
  define(window, 'XMLHttpRequest', { value: VirtualXHR, writable: true });
  define(window, 'indexedDB', { value: SaveStore.factory });
  define(window, 'localStorage', { value: memoryStorage() });
  define(window, 'sessionStorage', { value: memoryStorage() });
  define(navigator, 'serviceWorker', { value: undefined });
  define(document, 'cookie', { get: function () { return ''; }, set: function () {} });

  // new URL(x, window.location) – im srcdoc wäre location „about:srcdoc“ und keine gültige Basis.
  function PatchedURL(url, base) {
    if (base !== undefined && String(base).indexOf('about:') === 0) base = document.baseURI;
    return base === undefined ? new NativeURL(url) : new NativeURL(url, base);
  }
  PatchedURL.prototype = NativeURL.prototype;
  ['createObjectURL', 'revokeObjectURL', 'canParse', 'parse'].forEach(function (name) {
    if (typeof NativeURL[name] === 'function') PatchedURL[name] = NativeURL[name].bind(NativeURL);
  });
  define(window, 'URL', { value: PatchedURL, writable: true });

  patchSrc(window.HTMLMediaElement && HTMLMediaElement.prototype);
  patchSrc(window.HTMLImageElement && HTMLImageElement.prototype);
  patchSrc(window.HTMLSourceElement && HTMLSourceElement.prototype);

  // ---------------------------------------------------------------------------
  // Spiel starten: index.html des Spiels in dieses Dokument übernehmen
  // ---------------------------------------------------------------------------

  var DROP_LINKS = /(^|\s)(manifest|icon|apple-touch-icon|apple-touch-startup-image|preload|prefetch|modulepreload|preconnect|dns-prefetch)(\s|$)/i;

  function fileText(path) {
    return getFile(path).then(function (file) { return file ? file.text() : null; });
  }

  /** Ersetzt src-Attribute mit Adressen des Spiels durch blob:-Adressen (z. B. das Presplash-Bild). */
  function rewriteSources(root) {
    var jobs = [];
    root.querySelectorAll('img[src], video[src], audio[src], source[src], input[type=image][src]').forEach(function (el) {
      var path = gamePath(resolveUrl(el.getAttribute('src')));
      if (path === null) return;
      el.removeAttribute('src');
      jobs.push(getFile(path).then(function (file) {
        if (file) el.setAttribute('src', URL.createObjectURL(new Blob([file], { type: mimeFor(path) })));
      }));
    });
    return Promise.all(jobs);
  }

  function failStart(message) {
    bridge({ type: 'error', message: message });
  }

  function boot() {
    bridge({ type: 'boot' });
    fileText('index.html').then(function (html) {
      if (html === null) {
        failStart('Die index.html des Spiels fehlt.');
        return;
      }
      var parsed = new DOMParser().parseFromString(html, 'text/html');
      parsed.querySelectorAll('base, meta[http-equiv]').forEach(function (el) { el.remove(); });
      parsed.querySelectorAll('link[rel]').forEach(function (el) {
        if (DROP_LINKS.test(el.getAttribute('rel') || '')) el.remove();
      });
      var styles = [];
      parsed.querySelectorAll('link[rel~=stylesheet][href]').forEach(function (el) {
        var path = gamePath(resolveUrl(el.getAttribute('href')));
        var placeholder = parsed.createElement('style');
        el.replaceWith(placeholder);
        if (path !== null) styles.push(fileText(path).then(function (css) { placeholder.textContent = css || ''; }));
      });
      // Skripte durch Platzhalter ersetzen; sie werden danach der Reihe nach ausgeführt.
      var scripts = [];
      parsed.querySelectorAll('script').forEach(function (el) {
        var marker = parsed.createComment('renos-script-' + scripts.length);
        scripts.push({ marker: marker, src: el.getAttribute('src'), type: el.getAttribute('type'), text: el.textContent || '' });
        el.replaceWith(marker);
      });
      return Promise.all(styles.concat([rewriteSources(parsed)])).then(function () {
        var title = parsed.querySelector('title');
        if (title) document.title = title.textContent || '';
        var lang = parsed.documentElement.getAttribute('lang');
        if (lang) document.documentElement.setAttribute('lang', lang);
        Array.from(parsed.head.childNodes).forEach(function (node) {
          if (node.nodeName !== 'TITLE') document.head.appendChild(document.importNode(node, true));
        });
        ['class', 'style'].forEach(function (attr) {
          var value = parsed.body.getAttribute(attr);
          if (value !== null) document.body.setAttribute(attr, value);
        });
        Array.from(parsed.body.childNodes).forEach(function (node) {
          document.body.appendChild(document.importNode(node, true));
        });
        return runScripts(scripts);
      });
    }).then(function () {
      try {
        document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
        window.dispatchEvent(new Event('load'));
      } catch {
        /* ignorieren */
      }
      watch();
    }).catch(function (error) {
      failStart('Das Spiel konnte nicht gestartet werden: ' + (error && error.message ? error.message : String(error)));
    });
  }

  function findMarker(text) {
    var walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
    var node;
    while ((node = walker.nextNode())) if (node.nodeValue === text) return node;
    return null;
  }

  function runScripts(scripts) {
    var index = 0;
    function next() {
      if (index >= scripts.length) return Promise.resolve();
      var current = scripts[index];
      var marker = findMarker('renos-script-' + index);
      index += 1;
      var type = (current.type || '').trim().toLowerCase();
      if (type && type !== 'text/javascript' && type !== 'application/javascript' && type !== 'module') {
        if (marker) marker.remove();
        return next();
      }
      var source;
      if (current.src) {
        var path = gamePath(resolveUrl(current.src));
        source = path === null ? Promise.resolve(null) : fileText(path);
      } else {
        source = Promise.resolve(current.text);
      }
      return source.then(function (code) {
        var el = document.createElement('script');
        if (type === 'module') el.type = 'module';
        el.textContent = code === null ? '' : code;
        if (marker && marker.parentNode) marker.parentNode.replaceChild(el, marker);
        else document.body.appendChild(el);
        return next();
      });
    }
    return next();
  }

  // ---------------------------------------------------------------------------
  // Status an RenOS (wie die Bridge des externen Hosts)
  // ---------------------------------------------------------------------------

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && e.altKey && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      bridge({ type: 'exit-request' });
    }
  }, true);

  function watch() {
    var done = false, sawPresplash = false, lastProgress = -1, calledRunAt = 0, begin = Date.now();
    function check() {
      if (done) return;
      try {
        var status = document.getElementById('statusTextDiv');
        // Farbcodes (ANSI) aus Ren'Pys Fehlermeldungen entfernen.
        var text = (status ? status.textContent || '' : '').replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
        if (/More information may be available|aborted unexpectedly|exited unexpectedly/i.test(text)) {
          done = true;
          bridge({ type: 'error', message: text.slice(-400) });
          return;
        }
        var bar = document.getElementById('statusProgress');
        if (bar && bar.style.display === 'block' && bar.max > 0 && bar.value !== lastProgress) {
          lastProgress = bar.value;
          bridge({ type: 'progress', done: Number(bar.value), total: Number(bar.max) });
        }
        var presplash = document.getElementById('presplash');
        if (presplash) sawPresplash = true;
        var M = window.Module;
        if (M && M.calledRun && !calledRunAt) calledRunAt = Date.now();
        if ((sawPresplash && !presplash) || (!sawPresplash && calledRunAt && Date.now() - calledRunAt > 3000)) {
          done = true;
          bridge({ type: 'running' });
          return;
        }
      } catch {
        /* ignorieren */
      }
      if (Date.now() - begin < 15 * 60 * 1000) setTimeout(check, 250);
    }
    check();
  }

  toParent({ type: 'ready' });
})(__RENOS_CONFIG__);
