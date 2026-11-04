/**
 * Ergänzungen, die RenOS in die game.zip umgewandelter Windows-/Linux-Spiele schreibt – gemeinsam
 * genutzt von der Umwandlung (Installations-Worker) und der Reparatur älterer Installationen.
 */

/**
 * Stand der Umwandlung. Bei jeder Änderung, die bereits installierte Spiele betrifft, erhöhen und
 * die Reparatur in `upgrade.ts` ergänzen – dann müssen Spiele nicht neu installiert werden.
 *   1  erste Fassung
 *   2  .rpy neben .rpyc weggelassen, Platzhalter in echter Bildgröße, renos_web_support.rpy, Modul-Ersatz
 */
export const CONVERTER_VERSION = 2;

/** Module, die die Web-Laufzeit nicht hat und für die RenOS einen harmlosen Ersatz mitliefert. */
export const STUB_MODULES = ['js', 'pyodide_js', 'pyscript', 'micropip', '_renpytfd', '_renpysteam', 'steamworks', 'pypresence'] as const;

export const WEB_SUPPORT_RPY = `# RenOS: Ergänzungen für Spiele, die aus Windows-/Linux-Builds umgewandelt wurden.
init -1600 python:
    def _renos_web_file_fallback(orig):
        def fallback(fn, *args, **kwargs):
            try:
                return orig(fn, *args, **kwargs)
            except renpy.webloader.DownloadNeeded as e:
                if e.rtype != "image":
                    raise
                import os
                renpy.webloader.enqueue(e.relpath, "image", fn)
                return open(os.path.join("_placeholders", e.relpath), "rb")
        fallback._renos = True
        return fallback

    if renpy.emscripten:
        # Import-Hook für Desktop-/Browser-Module, die es in der Web-Laufzeit nicht gibt.
        try:
            import _renos_webstub
        except Exception:
            pass
        import renpy.exports as _renos_exports
        for _renos_name in ("file", "open_file"):
            _renos_orig = getattr(_renos_exports, _renos_name, None)
            if _renos_orig is not None and not getattr(_renos_orig, "_renos", False):
                setattr(_renos_exports, _renos_name, _renos_web_file_fallback(_renos_orig))
`;

export const WEBSTUB = `# RenOS: Ersatz für Module, die es in der Ren'Py-Web-Laufzeit nicht gibt: Browser-Module aus
# Pyodide/PyScript (js, pyodide, …) und Desktop-Module (Dateidialoge _renpytfd, Steam, Discord),
# die manche Spiele für optionale Funktionen importieren. Die Ren'Py-Web-Laufzeit hat sie nicht.
# Alle Attribute und Aufrufe liefern ein leeres, „falsches“ Objekt; Untermodule entstehen automatisch.
import sys
import types

PREFIXES = ("js", "pyodide", "pyodide_js", "pyscript", "micropip", "_renpytfd", "_renpysteam", "steamworks", "pypresence")


class _JsProxy(object):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _JsProxy()

    def __call__(self, *args, **kwargs):
        return _JsProxy()

    def __getitem__(self, key):
        return _JsProxy()

    def __setitem__(self, key, value):
        pass

    def __bool__(self):
        return False

    __nonzero__ = __bool__

    def __iter__(self):
        return iter(())

    def __len__(self):
        return 0

    def __str__(self):
        return ""


class StubModule(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _JsProxy()


def stub_module(name):
    module = StubModule(name)
    module.__path__ = []
    module.__file__ = "<renos-stub>"
    return module


class _Finder(object):
    def _match(self, fullname):
        return fullname.split(".")[0] in PREFIXES

    # Python 3
    def find_spec(self, fullname, path=None, target=None):
        if not self._match(fullname):
            return None
        import importlib.util
        return importlib.util.spec_from_loader(fullname, self, is_package=True)

    def create_module(self, spec):
        return stub_module(spec.name)

    def exec_module(self, module):
        pass

    # Python 2 (Ren'Py 7)
    def find_module(self, fullname, path=None):
        return self if self._match(fullname) else None

    def load_module(self, fullname):
        module = sys.modules.get(fullname) or stub_module(fullname)
        sys.modules[fullname] = module
        return module


if not any(isinstance(f, _Finder) for f in sys.meta_path):
    sys.meta_path.append(_Finder())
`;

export const WEBSTUB_ENTRY = `import sys
import _renos_webstub

sys.modules[__name__] = _renos_webstub.stub_module(__name__)
`;


/**
 * Ersatz-Module (Pfad in der game.zip ohne „game/python-packages/“-Präfix → Inhalt).
 * `own(name)` meldet, ob das Spiel das Modul selbst mitbringt (dann kein Ersatz).
 */
export function stubFiles(own: (name: string) => boolean): Array<[string, string]> {
  const stubs: Array<[string, string]> = [['_renos_webstub.py', WEBSTUB]];
  for (const name of STUB_MODULES) if (!own(name)) stubs.push([`${name}.py`, WEBSTUB_ENTRY]);
  if (!own('pyodide')) stubs.push(['pyodide/__init__.py', WEBSTUB_ENTRY]);
  return stubs;
}

/** Quelltext (.rpy/.rpym), für den die kompilierte Fassung (.rpyc/.rpymc) vorhanden ist. */
export function hasCompiledTwin(path: string, exists: (path: string) => boolean): boolean {
  return /\.rpym?$/i.test(path) && exists(`${path}c`);
}
