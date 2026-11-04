# RenOS – Tests

## Überblick

| Ebene | Werkzeug | Umfang | Befehl |
| --- | --- | --- | --- |
| Server: Unit + Integration | Vitest + `fastify.inject` | 52 Tests | `npm test -w @renos/server` |
| Frontend: Unit | Vitest + jsdom + fake-indexeddb | 38 Tests | `npm test -w @renos/web` |
| Browser-E2E | Playwright (Chromium) | 24 Tests, davon 1 mit echter Ren’Py-Laufzeit | `npm run test:e2e` |
| Statische Prüfung | TypeScript 6 (strict), ESLint | alle Pakete + E2E | `npm run typecheck`, `npm run lint` |

Alle oben genannten Tests liefen zuletzt vollständig erfolgreich (Chromium 1.63-Build unter Linux). Sie wurden **nicht** in Safari/WebKit und **nicht** auf einem echten iPad ausgeführt.

## Automatisierte Tests im Detail

### Server (`apps/server/test`)

- **Archiv-Sicherheit** (`archive.test.ts`, eigener ZIP-Writer für bewusst bösartige Archive): Path Traversal, Zip Slip mit Backslashes, absolute Pfade, Symlinks, doppelte und kollidierende Einträge, verschlüsselte Einträge, zu viele Einträge, Zip-Bomb per Kompressionsverhältnis, Überschreitung der entpackten Größe, gefälschte Größenangaben beim Entpacken, Nicht-ZIP-Dateien, Erkennung von Web-Build / Projekt / Desktop-Build / unbekannt / verschachteltem ZIP, gemeinsamer Elternordner, macOS-Metadaten, Warnung bei ausführbaren Dateien, Titelerkennung.
- **API-Integration** (`api.test.ts`): Health, private Bibliothek, nicht autorisierte Uploads, falsches Passwort, Login von fremdem Origin, Cookie-Attribute (HttpOnly, SameSite=Strict, Pfad), CSRF-Pflicht, Origin-Prüfung, falscher Content-Type/Dateiname, abgebrochener Upload ohne Restdateien, unsichere Archive werden nicht gespeichert, atomare Installation, Game-Host-Header (CSP `frame-ancestors`, `connect-src`, `nosniff`), MIME-Typen (`application/wasm` u. a.), Range/HEAD/ETag, Traversal-Versuche auf dem Game-Host, keine Spiele auf dem App-Origin, Cover-Signaturprüfung, Umbenennen, Spielzeit, Speicherinfo, Löschen (sofort nicht mehr ausgeliefert), **fehlgeschlagene Installation hinterlässt kein Spiel**, Logout.
- **Sicherheitskonfiguration** (`security.test.ts`): App- und Spiele-Origin müssen verschieden sein, HTTPS-Pflicht in Produktion, scrypt-Hashing, CSPs, Bridge-Einfügung, **Login-Rate-Limit** (429 nach 8 Fehlversuchen), Härtungs-Header.

### Frontend (`apps/web/src/**/*.test.ts`)

- Window-Manager-Geometrie (Begrenzung, Mindestgrößen, Kaskadierung, Einrasten, Größenänderung) und Store (Öffnen, Fokus, Stapel, Single-Instance, Minimieren, Schließen mit gemerkter Größe, Bildschirmverkleinerung, Fensterwechsel, immersiver Modus).
- Shortcut-Manager (physische Tasten mit ⌥, Mod-Taste, App-Bereich, Textfelder, Systemschalter).
- Terminal-Parser (Anführungszeichen, Escapes, keine Ausführung von `$(…)`/Backticks) und Befehle mit echtem virtuellem Dateisystem (ls, cd, pwd, mkdir, cat, neofetch ohne erfundene Hardwarewerte, games offline, Vervollständigung).
- Virtuelles Dateisystem (Standardordner, Namensprüfung, Kollisionen, Papierkorb, Wiederherstellen, Schutz der Standardordner, rekursives Kopieren/Verschieben, kein Verschieben in sich selbst).
- Notizen, Datensicherung (vollständiger Export/Import-Rundlauf), Launcher-Suche, Bridge-Nachrichtenvalidierung.

### Browser-E2E (`e2e/*.spec.ts`)

`npm run test:e2e` baut alles und startet über `e2e/serve.mjs` einen frischen Server (eigenes Datenverzeichnis, Testpasswort) auf `localhost:4310` (App) und `localhost:4311` (Spiele).

| Datei | Prüft |
| --- | --- |
| `pwa.spec.ts` | Manifest + Icons, Apple-Metaangaben, Installationsseite im Browser-Tab, Standalone-Erkennung (`navigator.standalone`), iPad-Safari-Variante, Smartphone-Hinweis, Service-Worker-Registrierung und **Offline-Start** mit Offline-Zustand der Library |
| `desktop.spec.ts` | Einrichtungsassistent (5 Schritte, Akzentfarbe, gespeichert), Dock, Fokus/z-Order, Minimieren/Wiederherstellen/Schließen, Ziehen und Größenänderung per Zeiger inkl. Persistenz nach Neuladen, Maximieren per Doppelklick, Einrasten am Rand, Launcher (⌥ Leertaste, echte Suche, Enter, Tippen-zum-Suchen), Desktop-Kontextmenü, Einstellungen mit sichtbarer Wirkung (Wallpaper, Dock, Akzent) und Persistenz, ⌥⇥/⌥W |
| `apps.spec.ts` | Files (Ordner, Inline-Umbenennen, Navigation, Import über Dateidialog, Vorschau, Export als Download mit identischem Inhalt, Kontextmenü, Persistenz, Papierkorb, Wiederherstellen, Raster, Suche), Notes (Autosave, Persistenz, Suche, Löschen + Rückgängig), Terminal (echte Daten, unbekannte Befehle, Verlauf, `open`) |
| `installer.spec.ts` | Anmeldepflicht, falsches Passwort, Nicht-ZIP vor Upload abgelehnt, Desktop-Build/Projekt/unsicheres Archiv nicht installierbar, Installation → Library → Game-Origin/MIME → Suche → Entfernen, Player täuscht bei kaputtem Build keinen Erfolg vor |
| `renpy.spec.ts` | **Echte Ren’Py-8.5-Laufzeit**: Installation über die UI, Start im immersiven Modus, Sandbox-Attribute, Isolation (`window.parent.document` → `SecurityError`), Enter-Taste erreicht das Spiel, Spielstand speichern, Spiel schließen, RenOS neu laden, Spielstand und `persistent`-Daten sind erhalten, ⌥⇧Esc verlässt den immersiven Modus |

## Ren’Py-Laufzeittest vorbereiten

Der echte Laufzeittest braucht einen Ren’Py-Web-Build. Das Repository enthält dafür ein eigenes, minimales Testspiel (`e2e/renpy-testgame`, keine fremden Assets). Die Ren’Py-Laufzeit selbst (~40 MB) wird nicht eingecheckt.

1. Ren’Py-SDK und das passende Web-Paket von https://www.renpy.org/latest.html laden (getestet mit **8.5.3**: `renpy-8.5.3-sdk.tar.bz2` und `renpy-8.5.3-web.zip`).
2. Das Web-Paket in den SDK-Ordner entpacken (es entsteht `renpy-8.5.3-sdk/web/`).
3. `npm run testgame -- /pfad/zu/renpy-8.5.3-sdk`

Das Skript kopiert und packt ausschließlich Dateien in derselben Struktur wie der Launcher („Build Web Application“); es führt nichts aus dem SDK aus. Ergebnis: `e2e/fixtures/generated/RenOSTestspiel-1.0-web.zip`. Fehlt die Datei, wird `renpy.spec.ts` **übersprungen** (nicht als bestanden gewertet).

Alternativ das Testspiel im Ren’Py-Launcher öffnen und über „Web (Beta)“ bauen.

## Manuelle Tests auf echtem iPad mit Magic Keyboard

Diese Tests konnten mangels Hardware **nicht** durchgeführt werden. Voraussetzung: RenOS ist per HTTPS erreichbar (z. B. mit `deploy/docker-compose.yml`).

### Installation & Start
- [ ] Safari zeigt die Installationsseite (kein Desktop), Hinweis „Erkannt: Safari auf iPadOS/iOS“.
- [ ] Teilen → Zum Home-Bildschirm → „Als Web-App öffnen“ → Hinzufügen: RenOS-Symbol erscheint (dunkles Icon, kein schwarzer Rand).
- [ ] Start über das Symbol: eigenes Fenster ohne Safari-Leisten, Startbildschirm, Einrichtungsassistent.
- [ ] Statusleiste (Uhrzeit/Akku von iPadOS) überdeckt nichts Wichtiges (Safe-Area).
- [ ] Hochformat zeigt den Querformat-Hinweis; „Trotzdem fortfahren“ funktioniert.
- [ ] Split View / Stage Manager: Fenster bleiben bei Größenänderung erreichbar.

### Trackpad & Touch
- [ ] Fenster per Trackpad an der Titelleiste ziehen; an Rändern und Ecken Größe ändern (Cursor ändert sich).
- [ ] Zwei-Finger-Klick öffnet Kontextmenüs (Desktop, Dock, Files, Library, Titelleiste).
- [ ] Doppelklick auf die Titelleiste maximiert; Ziehen an linken/rechten Rand rastet ein.
- [ ] Touch: Fenster mit dem Finger ziehen, langes Drücken auf Dock/Desktop öffnet das Menü.
- [ ] Scrollen mit zwei Fingern in Files, Library, Settings und Terminal ist präzise und rutscht nicht in die Seite durch.

### Tastatur (Magic Keyboard)
- [ ] ⌥ Leertaste öffnet die Suche; Tippen, Pfeiltasten, Enter, Esc.
- [ ] ⌥⇥ wechselt Fenster, ⌥W schließt, ⌥M minimiert, ⌃⌥←/→ rastet ein, ⌥, öffnet Settings.
- [ ] Prüfen und dokumentieren, welche Kürzel iPadOS abfängt (insbesondere mit ⌘ und Globe-Taste).
- [ ] Notes: ⌘N, ⌘F; Terminal: ↑/↓ Verlauf, Tab, ⌃L, ⌃C.

### Spiele
- [ ] ZIP-Datei aus der Dateien-App/iCloud Drive im Installer auswählen; Upload-Fortschritt läuft; Abbrechen funktioniert.
- [ ] Ein echtes Ren’Py-Spiel starten: Laden, Ton nach erstem Tippen, Klick/Tap rückt Dialoge vor, Tastatur (Leertaste/Enter/Esc) erreicht das Spiel.
- [ ] Immersiver Modus: Steuerleiste über Griff/oberen Rand, ⌥⇧Esc, „Zurück zur Library“.
- [ ] Spielstand im Spiel speichern → RenOS komplett schließen (App-Umschalter) → neu öffnen → Spielstand laden.
- [ ] ☰ → „Export Saves“ speichert eine ZIP (Safari-Downloaddialog), „Import Saves“ liest sie wieder ein.
- [ ] Player → ⓘ zeigt, ob dauerhafter Speicher gewährt wurde.

### Offline & Updates
- [ ] Flugmodus: RenOS startet, Files/Notes/Terminal/Settings funktionieren, Library zeigt „Server nicht erreichbar“.
- [ ] Neue Version deployen: Benachrichtigung „Update verfügbar“ → „Jetzt aktualisieren“ lädt neu.

### Speicher
- [ ] Settings → Speicher: Angaben plausibel, „Dauerhafter Speicher anfordern“, Sicherung exportieren/importieren.

## Bekannte Testrisiken

- **Nur Chromium:** Safari/WebKit verhält sich bei Tastaturereignissen in iframes, Fullscreen, IndexedDB-Limits, Service-Worker-Lebensdauer und Download-Dialogen teilweise anders.
- **Standalone-Erkennung** wird im Test durch Überschreiben von `navigator.standalone` simuliert.
- **Speicherräumung durch iPadOS** (7-Tage-Regel/Speicherdruck) ist nicht automatisiert testbar.
- **Ren’Py-Vielfalt:** Getestet wurde ein minimales eigenes Spiel. Große Spiele (Speicherbedarf, progressive Downloads, OGG-Audio in Safari, Video) sind nicht abgedeckt.
- **Docker-Image** konnte hier nicht gebaut werden (kein Docker-Daemon in der Testumgebung); `npm run build && npm start` im Produktionsmodus wurde dagegen geprüft.

## Noch nicht durchführbare Tests

- Alles unter „Manuelle Tests auf echtem iPad“.
- Echter HTTPS-Betrieb mit zwei Subdomains und Let’s-Encrypt-Zertifikaten.
- Verhalten bei sehr großen Uploads (mehrere GB) über Mobilfunk/WLAN des iPads.
