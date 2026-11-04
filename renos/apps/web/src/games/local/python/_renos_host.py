# RenOS: Verbindung zwischen umgewandelten Ren'Py-Spielen und RenOS (nur in der Web-Laufzeit aktiv).
#
#  - Nachladbare Dateien: Am echten Pfad liegt bis zum Nachladen ein Platzhalter (transparentes PNG in
#    der echten Groesse bzw. eine leere Datei). So finden Spiele ihre Dateien auch mit os.walk, glob und
#    os.path.exists. Ren'Py laedt trotzdem das echte Bild nach, solange am Pfad ein Platzhalter liegt,
#    und raeumt es nach Gebrauch wieder zum Platzhalter auf (statt die Datei zu loeschen).
#  - Datei-Dialoge (_renpytfd): oeffnen die Dateiauswahl von RenOS; Exporte landen in RenOS (Downloads).
#  - Dateien, die das Spiel selbst im Spielordner anlegt (z. B. installierte Szenarien), schickt diese
#    Datei an RenOS, das sie fuer den naechsten Start aufbewahrt.
#
# Laeuft unter Python 2 (Ren'Py 7) und Python 3 (Ren'Py 8).
import json
import os
import random
import struct
import sys
import time
import zlib

import renpy

try:
    import emscripten  # type: ignore
except ImportError:  # ausserhalb des Browsers
    emscripten = None

MARKER = b"rnOs"
PICK_DIR = "/tmp/renos-picked"
EXPORT_DIR = "/tmp/renos-export"
SYNC_INTERVAL = 60.0
MAX_PERSIST_BYTES = 1024 * 1024 * 1024
SKIP_SUFFIXES = (".log", ".tmp", ".bak", ".rpyb", ".pyc", ".pyo")

_JS = r"""
if (!window.RenOSWeb) window.RenOSWeb = (function () {
  var picks = {};
  var queue = Promise.resolve();
  function host() { return window.RenOSHost || null; }
  function ensureDir(path) {
    var current = '';
    path.split('/').forEach(function (part) {
      if (!part) return;
      current += '/' + part;
      try { FS.mkdir(current); } catch (e) {}
    });
  }
  function bufferOf(data) {
    return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer;
  }
  return {
    available: function () { return host() ? 1 : 0; },
    pick: function (id, optionsJson, dir) {
      var h = host();
      if (!h) { picks[id] = { state: 'unavailable' }; return; }
      picks[id] = { state: 'pending' };
      h.pickFiles(JSON.parse(optionsJson)).then(function (files) {
        if (!files || !files.length) { picks[id] = { state: 'cancelled' }; return; }
        ensureDir(dir);
        var paths = [];
        files.forEach(function (file, i) {
          var name = String(file.name || ('datei-' + i)).replace(/[\/\\\u0000]/g, '_') || ('datei-' + i);
          var path = dir + '/' + name;
          FS.writeFile(path, new Uint8Array(file.data), { canOwn: true });
          paths.push(path);
        });
        picks[id] = { state: 'done', paths: paths };
      }, function (error) {
        picks[id] = { state: 'error', message: String((error && error.message) || error) };
      });
    },
    state: function (id) { return JSON.stringify(picks[id] || { state: 'unknown' }); },
    free: function (id) { delete picks[id]; },
    persist: function (listJson) {
      var h = host();
      if (!h) return 0;
      JSON.parse(listJson).forEach(function (item) {
        queue = queue.then(function () {
          var data;
          try { data = FS.readFile(item[0]); } catch (e) { return undefined; }
          return h.saveGameFile(item[1], bufferOf(data)).catch(function () {});
        });
      });
      return 1;
    },
    forget: function (listJson) {
      var h = host();
      if (h) h.removeGameFiles(JSON.parse(listJson));
    },
    exportFile: function (path, name) {
      var h = host();
      if (!h) return 0;
      var data = FS.readFile(path);
      h.exportFile(name, bufferOf(data));
      return 1;
    }
  };
})();
"""

_state = {
    "installed": False,
    "base": None,
    "overlay": None,
    "last_sync": 0.0,
    "exports": {},
    "last_export_check": 0.0,
    # Regelmaessiger Abgleich erst, nachdem im Spiel eine Datei gewaehlt wurde (sonst nur beim Laden der Skripte).
    "armed": False,
}


def _log(text):
    try:
        sys.stderr.write("RenOS: %s\n" % text)
    except Exception:
        pass


def _gamedir():
    return renpy.config.gamedir


def _rel(path):
    return os.path.relpath(path, _gamedir()).replace(os.sep, "/")


# ---------------------------------------------------------------------------
# Platzhalter
# ---------------------------------------------------------------------------


def placeholder_png(width, height):
    """Transparentes PNG (1 Bit, Palette) in der echten Bildgroesse, mit RenOS-Kennzeichen."""

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    row = b"\x00" * (1 + (int(width) + 7) // 8)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", int(width), int(height), 1, 3, 0, 0, 0))
        + chunk(MARKER, b"")
        + chunk(b"PLTE", b"\x00\x00\x00")
        + chunk(b"tRNS", b"\x00")
        + chunk(b"IDAT", zlib.compress(row * int(height), 9))
        + chunk(b"IEND", b"")
    )


def is_placeholder(name):
    """Liegt am Pfad (relativ zum Spielordner) noch ein Platzhalter oder gar nichts?"""
    full = os.path.join(_gamedir(), name)
    try:
        size = os.path.getsize(full)
    except OSError:
        return True
    if size == 0:
        return True
    if size > 65536:
        return False
    try:
        with open(full, "rb") as f:
            head = f.read(64)
    except (IOError, OSError):
        return True
    return MARKER in head


def restore_placeholder(name):
    """Schreibt den Platzhalter einer nachladbaren Datei wieder an ihren Pfad."""
    info = renpy.loader.remote_files.get(name)
    if info is None:
        return
    full = os.path.join(_gamedir(), name)
    data = b""
    size = info.get("size")
    if info.get("type") == "image" and isinstance(size, (list, tuple)) and len(size) == 2:
        try:
            data = placeholder_png(size[0], size[1])
        except Exception:
            data = b""
    try:
        parent = os.path.dirname(full)
        if not os.path.isdir(parent):
            os.makedirs(parent)
        with open(full, "wb") as f:
            f.write(data)
    except (IOError, OSError):
        pass


def _load_remote_first(name):
    """Loader-Rueckruf vor dem Dateisystem: Platzhalter -> nachladen statt den Platzhalter liefern."""
    info = renpy.loader.remote_files.get(name)
    if info is None or not is_placeholder(name):
        return None
    raise renpy.webloader.DownloadNeeded(relpath=name, rtype=info["type"], size=info["size"])


_load_remote_first._renos = True


class _WebloaderOs(object):
    """os fuer renpy.webloader: Aufraeumen stellt den Platzhalter wieder her, statt die Datei zu loeschen."""

    def __init__(self, real):
        self._real = real

    def __getattr__(self, name):
        return getattr(self._real, name)

    def unlink(self, path):
        try:
            self._real.unlink(path)
        except OSError:
            pass
        try:
            restore_placeholder(_rel(path))
        except Exception:
            pass


def _file_fallback(orig):
    """renpy.file()/open_file(): noch nicht geladene Bilder liefern ihren Platzhalter (echte Groesse)."""

    def fallback(fn, *args, **kwargs):
        try:
            return orig(fn, *args, **kwargs)
        except renpy.webloader.DownloadNeeded as e:
            if e.rtype != "image":
                raise
            for candidate in (os.path.join(_gamedir(), e.relpath), os.path.join("_placeholders", e.relpath)):
                if os.path.exists(candidate):
                    return open(candidate, "rb")
            raise

    fallback._renos = True
    return fallback


def _install_loader():
    callbacks = renpy.loader.file_open_callbacks
    callbacks[:] = [cb for cb in callbacks if not getattr(cb, "_renos", False)]
    callbacks.insert(0, _load_remote_first)
    if not isinstance(renpy.webloader.os, _WebloaderOs):
        renpy.webloader.os = _WebloaderOs(os)
    import renpy.exports as exports

    for name in ("file", "open_file"):
        orig = getattr(exports, name, None)
        if orig is not None and not getattr(orig, "_renos", False):
            setattr(exports, name, _file_fallback(orig))


# ---------------------------------------------------------------------------
# Verbindung zu RenOS
# ---------------------------------------------------------------------------


def available():
    if emscripten is None:
        return False
    try:
        emscripten.run_script(_JS)
        return emscripten.run_script_int("window.RenOSWeb ? RenOSWeb.available() : 0") == 1
    except Exception:
        return False


def _notify(text):
    try:
        renpy.exports.notify(text)
    except Exception:
        _log(text)


def open_files(title, patterns=None, multiple=False):
    """Oeffnet die Dateiauswahl von RenOS und wartet auf die Wahl. Liefert Pfade oder None."""
    if not available():
        _notify(u"Die Dateiauswahl gibt es nur im eingebauten Spiele-Host von RenOS.")
        return None
    request = "%d%06d" % (int(time.time() * 1000) % 100000000, random.randint(0, 999999))
    target = PICK_DIR + "/" + request
    options = json.dumps({"title": title or "", "patterns": [str(p) for p in (patterns or [])], "multiple": bool(multiple)})
    emscripten.run_script("RenOSWeb.pick(%s, %s, %s)" % (json.dumps(request), json.dumps(options), json.dumps(target)))
    state = {"state": "pending"}
    while state.get("state") == "pending":
        emscripten.sleep(50)
        state = json.loads(emscripten.run_script_string("RenOSWeb.state(%s)" % json.dumps(request)))
    emscripten.run_script("RenOSWeb.free(%s)" % json.dumps(request))
    if state.get("state") == "done":
        _state["armed"] = True
        return list(state.get("paths") or [])
    if state.get("state") == "error":
        _notify(u"Datei konnte nicht \u00fcbernommen werden: %s" % state.get("message", u""))
    return None


def save_target(default_path):
    """Ziel fuer "Speichern unter": Die Datei geht nach dem Schreiben an RenOS (Files -> Downloads)."""
    name = os.path.basename(default_path or "") or "export"
    if not os.path.isdir(EXPORT_DIR):
        os.makedirs(EXPORT_DIR)
    path = os.path.join(EXPORT_DIR, name)
    _state["exports"][path] = None
    return path


def _check_exports():
    for path in list(_state["exports"]):
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        last = _state["exports"][path]
        if size > 0 and last == size:
            try:
                emscripten.run_script("RenOSWeb.exportFile(%s, %s)" % (json.dumps(path), json.dumps(os.path.basename(path))))
                _notify(u"\u201e%s\u201c wurde in RenOS gespeichert (Files \u2192 Downloads)." % os.path.basename(path))
            except Exception as e:
                _log("Export fehlgeschlagen: %s" % e)
            del _state["exports"][path]
            try:
                os.unlink(path)
            except OSError:
                pass
        else:
            _state["exports"][path] = size


# ---------------------------------------------------------------------------
# Vom Spiel angelegte Dateien aufbewahren
# ---------------------------------------------------------------------------


def _read_lines(name):
    path = os.path.join(_gamedir(), name)
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        return [line for line in f.read().decode("utf-8").split("\n") if line]


def _base():
    if _state["base"] is None:
        lines = _read_lines("renos_base.txt")
        _state["base"] = set(lines) if lines is not None else False
    return _state["base"]


def _overlay():
    if _state["overlay"] is None:
        overlay = {}
        for line in _read_lines("renos_overlay.txt") or []:
            rel, _sep, size = line.partition("\t")
            try:
                overlay[rel] = int(size)
            except ValueError:
                overlay[rel] = -1
        _state["overlay"] = overlay
    return _state["overlay"]


def scan():
    """Dateien im Spielordner, die nicht aus der game.zip stammen: (neu/geaendert, entfernt)."""
    base = _base()
    if not base:
        return [], []
    overlay = _overlay()
    gamedir = _gamedir()
    current = {}
    for root, dirs, files in os.walk(gamedir):
        rel_root = _rel(root)
        if rel_root == ".":
            rel_root = ""
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "__pycache__" and not (rel_root == "" and d in ("cache", "saves"))]
        for name in files:
            if name.startswith(".") or name.endswith(SKIP_SUFFIXES):
                continue
            rel = rel_root + "/" + name if rel_root else name
            if rel in base and rel not in overlay:
                continue
            if rel.endswith((".rpyc", ".rpymc")) and rel[:-1] in base:
                continue
            current[rel] = os.path.join(root, name)
    added = []
    for rel, full in current.items():
        try:
            size = os.path.getsize(full)
        except OSError:
            continue
        if size > MAX_PERSIST_BYTES:
            continue
        known = overlay.get(rel)
        if known is None or (known >= 0 and known != size):
            added.append((rel, full, size))
    removed = [rel for rel in overlay if rel not in current and not os.path.exists(os.path.join(gamedir, rel))]
    return added, removed


def sync():
    if not available():
        return
    _state["last_sync"] = time.time()
    try:
        added, removed = scan()
    except Exception as e:
        _log("Abgleich fehlgeschlagen: %s" % e)
        return
    overlay = _overlay()
    if added:
        emscripten.run_script("RenOSWeb.persist(%s)" % json.dumps(json.dumps([[full, "game/" + rel] for rel, full, _size in added])))
        for rel, _full, size in added:
            overlay[rel] = size
    if removed:
        emscripten.run_script("RenOSWeb.forget(%s)" % json.dumps(json.dumps(["game/" + rel for rel in removed])))
        for rel in removed:
            overlay.pop(rel, None)


def _periodic():
    now = time.time()
    if _state["exports"] and now - _state["last_export_check"] > 2.0:
        _state["last_export_check"] = now
        _check_exports()
    if _state["armed"] and now - _state["last_sync"] > SYNC_INTERVAL:
        sync()


def install():
    """Wird bei jedem Laden der Skripte aufgerufen (init -1600)."""
    if emscripten is None:
        return
    _install_loader()
    if _periodic not in renpy.config.periodic_callbacks:
        renpy.config.periodic_callbacks.append(_periodic)


def after_init():
    """Nach dem init des Spiels (init 1600): z. B. gerade installierte Szenarien an RenOS uebergeben."""
    if emscripten is None:
        return
    sync()
