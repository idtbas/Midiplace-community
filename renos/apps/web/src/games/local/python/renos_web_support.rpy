# RenOS: Ergänzungen für Spiele, die aus Windows-/Linux-Builds umgewandelt wurden (nur Web-Laufzeit).
init -1600 python:
    if renpy.emscripten:
        # Import-Hook für Desktop-/Browser-Module, die es in der Web-Laufzeit nicht gibt.
        try:
            import _renos_webstub
        except Exception:
            pass
        # Nachladbare Dateien, Datei-Dialoge und vom Spiel angelegte Dateien (siehe _renos_host.py).
        try:
            import _renos_host
            _renos_host.install()
        except Exception as _renos_error:
            import sys
            sys.stderr.write("RenOS: Unterstuetzung nicht geladen: %r\n" % (_renos_error,))

init 1600 python:
    if renpy.emscripten:
        try:
            import _renos_host
            _renos_host.after_init()
        except Exception:
            pass
