#!/usr/bin/env python3
"""
Baut aus „The Question“ (Beispielspiel im Ren'Py-SDK) einen Download, wie ihn Ren'Py für Windows/Linux
erzeugt („<Name>-<Version>-pc.zip“) – als Testfall für die Umwandlung in RenOS.

Wie in echten Veröffentlichungen:
  - kompilierte Skripte (.rpyc) in scripts.rpa, Bilder in images.rpa (RPA-3.0, Schlüssel 0x42424242,
    Index als zlib-komprimierter Pickle wie im Ren'Py-Archiver: Python 3 → höchstes Protokoll, Ren'Py 7 → 2)
  - GUI-Grafiken, Musik und Übersetzungen als lose Dateien, dazu game/cache/ (wird von RenOS ignoriert)
  - Startprogramme (.exe/.sh/.py), lib/py*-<plattform>/ und ein Ausschnitt von renpy/ (Version)

Aus dem SDK wird nichts ausgeführt; es werden nur Dateien gelesen.

  python3 scripts/make_renpy_desktop_fixture.py <sdk-ordner> <ziel.zip> [--python 2|3]
"""

import io
import os
import pickle
import sys
import zipfile
import zlib

KEY = 0x42424242


def rpa(files, protocol):
    """RPA-3.0-Archiv wie renpy/launcher/game/archiver.rpy."""
    out = io.BytesIO()
    out.write(b"RPA-3.0 XXXXXXXXXXXXXXXX XXXXXXXX\n")
    index = {}
    for name, data in sorted(files.items()):
        out.write(b"Made with Ren'Py.")
        offset = out.tell()
        out.write(data)
        prefix = b"" if protocol >= 3 else ""
        index[name] = [(offset ^ KEY, len(data) ^ KEY, prefix)]
    index_offset = out.tell()
    out.write(zlib.compress(pickle.dumps(index, protocol)))
    out.seek(0)
    out.write(b"RPA-3.0 %016x %08x\n" % (index_offset, KEY))
    return out.getvalue()


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    sdk, target = sys.argv[1], sys.argv[2]
    python = 2 if "--python" in sys.argv and sys.argv[sys.argv.index("--python") + 1] == "2" else 3
    project = os.path.join(sdk, "the_question", "game")
    if not os.path.isdir(project):
        sys.exit("the_question/game fehlt im SDK: " + sdk)

    root = "TheQuestion-1.0-pc/"
    protocol = pickle.HIGHEST_PROTOCOL if python == 3 else 2

    scripts, images, loose = {}, {}, {}
    for dirpath, _dirs, names in os.walk(project):
        for name in names:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, project).replace(os.sep, "/")
            with open(full, "rb") as f:
                data = f.read()
            if rel.startswith("images/"):
                images[rel] = data
            elif rel.endswith(".rpyc") and "/" not in rel:
                scripts[rel] = data
            elif rel.endswith(".rpy") and "/" not in rel:
                continue  # Veröffentlichungen enthalten meist nur kompilierte Skripte.
            else:
                loose[rel] = data

    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(root + "game/scripts.rpa", rpa(scripts, protocol))
        z.writestr(root + "game/images.rpa", rpa(images, protocol))
        for rel, data in sorted(loose.items()):
            z.writestr(root + "game/" + rel, data)

        with open(os.path.join(sdk, "renpy.py"), "rb") as f:
            z.writestr(root + "TheQuestion.py", f.read())
        z.writestr(root + "TheQuestion.sh", "#!/bin/sh\nexec \"$(dirname \"$0\")/lib/py%d-linux-x86_64/TheQuestion\" \"$@\"\n" % python)
        z.writestr(root + "TheQuestion.exe", b"MZ" + b"\0" * 62)
        for platform in ("linux-x86_64", "windows-x86_64"):
            z.writestr(root + "lib/py%d-%s/README.txt" % (python, platform), "Platzhalter für die native Laufzeit.\n")
        for rel in ("renpy/__init__.py", "renpy/vc_version.py", "renpy/common/00start.rpy"):
            with open(os.path.join(sdk, rel), "rb") as f:
                z.writestr(root + rel, f.read())
        if python == 2:
            z.writestr(root + "renpy/__init__.pyo", b"\x03\xf3\r\n")

    print("%s: %d Skripte, %d Bilder in Archiven, %d lose Dateien (Python %d)" % (target, len(scripts), len(images), len(loose), python))


if __name__ == "__main__":
    main()
