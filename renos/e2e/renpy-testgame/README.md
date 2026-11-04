# RenOS-Testspiel

Ein bewusst minimales, eigenes Ren'Py-Projekt (ohne fremde Assets), mit dem RenOS den
echten Ren'Py-Web-Laufzeitpfad testet: Installation, Start im Player, Tastatureingaben
und dauerhafte Spielstände.

Der Web-Build wird mit `npm run testgame -- <pfad-zum-renpy-sdk>` erzeugt
(siehe `scripts/assemble-renpy-testgame.mjs` und `TESTING.md`). Das Ergebnis liegt in
`e2e/fixtures/generated/` und wird nicht eingecheckt (Ren'Py-Laufzeit ≈ 40 MB).

Alternativ: Projekt im Ren'Py-Launcher öffnen und unter „Web (Beta)“ → „Build Web Application“
bauen; die erzeugte `…-web.zip` lässt sich direkt im RenOS-Installer installieren.
