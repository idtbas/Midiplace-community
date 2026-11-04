## Eigener Testinhalt für RenOS. Prüft Start, Eingaben und Spielstände.

init python:
    # Zählt die Starts des Spiels. Bleibt der Wert nach einem Neustart erhalten,
    # funktioniert die dauerhafte Speicherung (IndexedDB des Spiele-Origins).
    persistent.starts += 1
    renpy.save_persistent()

default weg = "keiner"

## Ohne eigenes Hauptmenü startet das Spiel direkt (vereinfacht automatisierte Tests).
label main_menu:
    return

label start:
    "Willkommen im RenOS-Testspiel."
    "Dieses kleine Spiel wurde für RenOS erstellt, um Laden, Eingaben und Spielstände zu prüfen."
    menu:
        "Welchen Weg nimmst du?"
        "Den Weg am Fluss":
            $ weg = "Fluss"
        "Den Weg über den Hügel":
            $ weg = "Hügel"
    "Du hast den Weg am [weg] gewählt."
    "Speichere jetzt über das Menü, schließe das Spiel und lade den Spielstand erneut."
    "Ende des Tests."
    return
