/**
 * Ergänzungen, die RenOS in die game.zip umgewandelter Windows-/Linux-Spiele schreibt – gemeinsam
 * genutzt von der Umwandlung (Installations-Worker) und der Reparatur älterer Installationen.
 */

import hostSource from './python/_renos_host.py?raw';
import tfdSource from './python/_renpytfd.py?raw';
import supportRpy from './python/renos_web_support.rpy?raw';
import { crc32 } from './crc32';
import { placeholderPng } from './desktop';

/**
 * Stand der Umwandlung. Bei jeder Änderung, die bereits installierte Spiele betrifft, erhöhen und
 * die Reparatur in `upgrade.ts` ergänzen – dann müssen Spiele nicht neu installiert werden.
 *   1  erste Fassung
 *   2  .rpy neben .rpyc weggelassen, Platzhalter in echter Bildgröße, renos_web_support.rpy, Modul-Ersatz
 *   3  Platzhalter am echten Pfad (os.walk/glob finden nachladbare Dateien), _renos_host.py
 *      (Datei-Dialoge über RenOS, vom Spiel angelegte Dateien bleiben erhalten)
 */
export const CONVERTER_VERSION = 3;

/** Module, die die Web-Laufzeit nicht hat und für die RenOS einen harmlosen Ersatz mitliefert. */
export const STUB_MODULES = ['js', 'pyodide_js', 'pyscript', 'micropip', '_renpysteam', 'steamworks', 'pypresence'] as const;

/** Wird beim Start jedes umgewandelten Spiels geladen (game/renos_web_support.rpy). */
export const WEB_SUPPORT_RPY: string = supportRpy;
/** Verbindung zu RenOS: Platzhalter, Datei-Dialoge, Aufbewahren vom Spiel angelegter Dateien. */
export const RENOS_HOST_PY: string = hostSource;
/** Ersatz für Ren'Pys Datei-Dialoge (_renpytfd) über RenOS. */
export const RENPYTFD_PY: string = tfdSource;

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


export interface SupportFile {
  /** Pfad in der game.zip */
  name: string;
  text: string;
  /** Nur RenOS legt Dateien dieses Namens an – ältere Fassungen dürfen immer ersetzt werden. */
  renosOnly: boolean;
}

/**
 * Hilfsdateien in der game.zip (Unterstützungsskript, Python-Module an Wurzel und in
 * game/python-packages). `own(name)` meldet, ob das Spiel ein Modul selbst mitbringt (dann kein Ersatz).
 */
export function supportFiles(own: (module: string) => boolean): SupportFile[] {
  const files: SupportFile[] = [{ name: 'game/renos_web_support.rpy', text: WEB_SUPPORT_RPY, renosOnly: true }];
  for (const prefix of ['', 'game/python-packages/']) {
    files.push({ name: `${prefix}_renos_webstub.py`, text: WEBSTUB, renosOnly: true });
    files.push({ name: `${prefix}_renos_host.py`, text: RENOS_HOST_PY, renosOnly: true });
    if (!own('_renpytfd')) files.push({ name: `${prefix}_renpytfd.py`, text: RENPYTFD_PY, renosOnly: false });
    for (const module of STUB_MODULES) if (!own(module)) files.push({ name: `${prefix}${module}.py`, text: WEBSTUB_ENTRY, renosOnly: false });
    if (!own('pyodide')) files.push({ name: `${prefix}pyodide/__init__.py`, text: WEBSTUB_ENTRY, renosOnly: false });
  }
  return files;
}

/** Platzhalter für nachladbare Dateien: Bilder als PNG in echter Größe, sonst leer (je Größe nur einmal erzeugt). */
export class PlaceholderCache {
  private readonly cache = new Map<string, { data: Uint8Array; crc: number }>();

  get(meta: string): { data: Uint8Array; crc: number } {
    let key = 'empty';
    let width = 0;
    let height = 0;
    if (meta.startsWith('image ')) {
      [width, height] = meta.slice(6).split(',').map(Number) as [number, number];
      if (width > 0 && height > 0 && width <= 65535 && height <= 65535) key = `${width}x${height}`;
    }
    let entry = this.cache.get(key);
    if (!entry) {
      const data = key === 'empty' ? new Uint8Array(0) : placeholderPng(width, height);
      entry = { data, crc: crc32(data) };
      this.cache.set(key, entry);
    }
    return entry;
  }
}

/** Quelltext (.rpy/.rpym), für den die kompilierte Fassung (.rpyc/.rpymc) vorhanden ist. */
export function hasCompiledTwin(path: string, exists: (path: string) => boolean): boolean {
  return /\.rpym?$/i.test(path) && exists(`${path}c`);
}
