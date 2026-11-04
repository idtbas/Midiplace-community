# RenOS – Status (Version 1.0.0)

Stand dieses Dokuments: entspricht dem eingecheckten Code. „Verifiziert“ heißt: durch einen automatisierten Test in Chromium bestätigt. Nichts davon wurde auf echter iPad-Hardware oder in Safari geprüft.

## Implementiert und verifiziert

| Bereich | Funktion | Nachweis |
| --- | --- | --- |
| PWA | Manifest (standalone, Icons inkl. maskable), Apple-Metaangaben, Apple-Touch-Icon | E2E `pwa.spec.ts` |
| PWA | Installationsseite im Browser-Tab, Smartphone-Hinweis, Standalone-Erkennung | E2E |
| PWA | Service Worker, Offline-Start der Oberfläche, Offline-Zustand bei Serverfunktionen | E2E |
| PWA | Kontrollierte Updates („Update verfügbar → Jetzt aktualisieren“) | implementiert, nicht automatisiert getestet |
| Onboarding | 5 Schritte, Akzentfarbe, Speicherung, erneut aufrufbar | E2E |
| Desktop | Wallpaper (3 eigene + schlicht + eigenes Bild), Systemleiste, Dock, Launcher, Kontextmenü, Dialoge, Toasts, Benachrichtigungen mit Kalender, Schnellaktionen | E2E + Sichtprüfung |
| Window Manager | Öffnen, Fokus, z-Order, Minimieren, Wiederherstellen, Maximieren, Einrasten, Ziehen, Größe ändern, Persistenz, Anpassung an Bildschirmgröße, Fensterwechsel | Unit + E2E |
| Tastatur | Zentraler Shortcut-Manager, Systemkürzel, App-Kürzel, Tippen-zum-Suchen | Unit + E2E |
| Files | Ordner, Umbenennen, Navigation mit Verlauf, Breadcrumbs, Liste/Raster, Suche (Ordner/überall), Import, Export (Datei oder ZIP), Papierkorb, Ausschneiden/Kopieren/Einfügen, Drag & Drop, Vorschau, Speicheranzeige | Unit + E2E |
| Notes | Erstellen, Autosave, Suche, Löschen mit Rückgängig, Export, In Files speichern | Unit + E2E |
| Terminal | 17 interne Befehle, Parser, Verlauf, Vervollständigung, Block-Cursor | Unit + E2E |
| Settings | 8 Kategorien, alle Optionen mit Wirkung, Datensicherung, kontrolliertes Löschen | Unit (Sicherung) + E2E (Auswahl) |
| Installer | Client-Vorprüfung, Upload mit echtem Fortschritt und Abbruch, Server-Prüfung, Ergebnisanzeige, Installation mit Job-Fortschritt, Fehlerzustände, Übergabe aus Files | Server-Tests + E2E |
| Library | Raster mit Covern, Suche, Sortierung, Filter, Details, Cover ändern/entfernen, Umbenennen, Entfernen, Speicherinfo, Leer-/Offline-/Login-Zustände | E2E |
| Player | Getrennter Origin, Sandbox, Bridge, Lade-/Fehlerzustände, immersiver Modus, Steuerleiste, Ressourcenfreigabe | E2E inkl. echter Ren’Py-Laufzeit |
| Ren’Py | Echter Web-Build (Ren’Py 8.6.0) läuft, Tastatur erreicht das Spiel, Spielstände überstehen Schließen + Neuladen | E2E `renpy.spec.ts` |
| **Windows-/Linux-Spiele** | Ren’Py-Builds für Windows/Linux/Mac (und Projektordner) werden auf dem Gerät in Web-Builds umgewandelt: Erkennung von Version und Python-Generation, mitgelieferte Laufzeit **Ren’Py 8.6.0** (Python 3) und **7.8.7** (Python 2), `.rpa`-Archive (RPA-3.0/2.0/1.0) ohne Entpacken, Bilder/Musik/Stimmen/Videos werden nachgeladen, offline spielbar, Laufzeitpakete mit SHA-256-Prüfung | Unit + E2E mit „The Question“ als `-pc.zip` für Ren’Py 8 und 7 (Start, Archiv-Bilder, Musik, Spielstand, offline) |
| Backend | Auth (scrypt, Sessions, CSRF, Origin, Rate Limit), ZIP-Sicherheit, atomare Installation, Game-Host, Cover, Aufräumen | 52 Server-Tests |
| Lokaler Modus | RenOS ohne Server (GitHub Pages): Installation auf dem Gerät (OPFS), Browser-ZIP-Leser mit ZIP64/CRC | Unit + E2E `e2e/local` |
| Eingebauter Spiele-Host | Jedes Spiel im sandboxed iframe mit anonymem Origin, ohne zweite Website: Dateien per MessagePort, IndexedDB-Nachbildung für Ren’Py-Spielstände, Spielstände pro Spiel bei RenOS (Anzeige, Übernahme in neue Version, Löschen mit dem Spiel), kein Netzwerk, offline | Unit + E2E inkl. echter Ren’Py-Laufzeit (Spielstände über Neuladen, offline) |
| Externer Spiele-Host (optional) | statischer Host auf zweiter Adresse mit Service Worker, Einstellungen mit Prüfung | E2E inkl. echter Ren’Py-Laufzeit |
| Echte Visual Novel | **Student Transfer 9.2** (Windows/Linux/ARM-Download, 929 MB, Ren’Py 8.6, sieben .rpa-Archive, eigene Python-Module): Installation in ~100 s, Umwandlung, Start bis in die Intro-Szene | manueller Lauf in Chromium (Playwright, dauerhaftes Profil); nicht auf dem iPad |
| Spiele & Dateien | Platzhalter am echten Pfad (Spiele finden nachladbare Dateien mit os.walk/glob), Datei-Dialoge im Spiel öffnen die Dateiauswahl von RenOS, „Speichern unter“ → Files, vom Spiel angelegte Dateien (z. B. Szenarien) bleiben über Neustarts erhalten; ältere Installationen werden beim Start aktualisiert | Unit + E2E (Ren’Py 8 und 7: Dateiauswahl aus einer Spielaktion, Szenario entpacken, Offline-Neustart, Nachladen aus RenOS, Export) |
| Browser | Webseiten ansehen, Downloads direkt nach Files → Downloads (CORS), Datei-Links auf Webseiten, optionaler eigener Weiterleitungsdienst, Installer „Aus Files wählen“ | Unit + E2E mit nachgebildeten Servern (Seite, CDN mit/ohne Freigabe); Weiterleitungsdienst nur als Unit-Test |
| Große Spiele | 3,2-GB-Archiv lokal installiert (~30 s, +30 MB Speicher); Server-Limits 16 GB Upload / 32 GB entpackt | manuelle Messung in Chromium |
| GitHub | CI-Workflow mit allen Tests (inkl. echter Ren’Py-Laufzeit 8.6.0 und 7.8.7, Server- und lokaler Modus, Windows/Linux-Umwandlung) | CI auf GitHub grün (RenOS CI, Lauf #9: 9/9 lokale E2E-Tests, keiner übersprungen) |
| GitHub | Pages-Workflow (RenOS + Laufzeitpakete + optionaler Spiele-Host) | lokal gebaut; Veröffentlichung erst nach Merge in den Standard-Branch (Umgebungsschutz von `github-pages`), noch nicht auf GitHub gelaufen |
| Deployment | `npm run build && npm start` im Produktionsmodus (CSP, Härtungs-Header, SPA-Fallback, gesperrte Verwaltung ohne Passwort) | manueller Smoke-Test |

## Implementiert, aber nicht verifiziert

- **Lokaler Modus in Safari:** eingebauter Spiele-Host (sandboxed `srcdoc`-iframe, `blob:`-Skripte/Bilder, WebAssembly aus nachgebildeten Antworten, OPFS-Dateien per `MessagePort`), externer Host als fremdes iframe (partitionierter Service Worker/Speicher), `createSyncAccessHandle()` im Worker, BYOB-Reader auf Dateien (sonst automatischer Rückfall), tatsächlich gewährter Speicher für Multi-GB-Spiele.
- **Echte Windows-/Linux-Visual-Novels aus dem Netz:** getestet ist „The Question“ in realistischer Verpackung. Große kommerzielle oder ältere Spiele (mehrere GB, Ren’Py 6, eigene Python-Module, verschlüsselte/abgewandelte Archive, Videos, Spiele mit Netzwerk- oder Steam-Funktionen) wurden nicht getestet.
- **Arbeitsspeicher großer umgewandelter Spiele in Safari:** Skripte und GUI liegen im Speicher, Medien werden nachgeladen und nach kurzer Zeit wieder freigegeben (Ren’Py-Verhalten). Wie viel Safari auf dem iPad zulässt, ist nicht gemessen.
- **Videos und Texteingaben im eingebauten Host:** Video-Adressen werden auf `blob:` umgelenkt, `renpy.input` nutzt ein Formular (`allow-forms`); beides ist implementiert, aber das Testspiel enthält kein Video und keine Texteingabe.
- **Alles auf echter iPad-Hardware** (Magic Keyboard, Trackpad, Touch, Safe-Area, Stage Manager, Home-Bildschirm-Installation). Prüfliste: [TESTING.md](TESTING.md).
- **Safari/WebKit-Verhalten** generell (alle automatisierten Tests laufen in Chromium).
- **Docker-Image und Compose/Caddy-Setup** – das Image konnte in der Entwicklungsumgebung nicht gebaut werden (kein Docker-Daemon).
- **Service-Worker-Update-Ablauf** mit einer neuen Version.
- **Vollbild-Schnellaktion** (nur angezeigt, wenn der Browser die Fullscreen-API anbietet).
- **Langes Drücken** für Kontextmenüs auf Touch-Geräten.
- **Große reale Ren’Py-Spiele** (mehrere hundert MB, progressive Downloads, Audio/Video in Safari).

## Bekannte Einschränkungen (technisch bedingt)

- RenOS ist eine Web-App und **ersetzt iPadOS nicht**; Systemgesten, Statusleiste und reservierte Tastenkürzel bleiben bei iPadOS.
- Es gibt keine zuverlässige Erkennung des Magic Keyboards; RenOS richtet sich nach Zeiger-, Hover- und Tastaturereignissen.
- Akku-, CPU- oder Speicherangaben der Hardware stellt der Browser nicht bereit und werden daher **nicht angezeigt**.
- Das virtuelle Dateisystem ist **nicht** das iPadOS-Dateisystem. Austausch nur per Import (Dateiauswahl, Drag & Drop) und Export (Download).
- iPadOS kann Websitedaten (Notizen, Dateien, Spielstände) unter Speicherdruck entfernen, wenn kein dauerhafter Speicher gewährt wurde → Datensicherung in Settings, Spielstand-Export im Ren’Py-Menü.
- Installierte Web-App und Safari haben **getrennte** Speicher.
- Server-Modus und externer Host: Alle Spiele teilen sich **einen** Spiele-Origin – von RenOS isoliert, untereinander aber nicht (Spielstände trennt Ren’Py über `config.save_directory`). Im eingebauten Host ist jedes Spiel getrennt.
- Eingebauter Host: Spiele haben **keinen Netzwerkzugriff** (CSP). Spiele, die selbst Server kontaktieren, brauchen den externen Host. Spielstände sind nicht Teil der RenOS-Datensicherung (Sicherung über „Export Saves“ im Spiel).
- Für Ren’Py sind im Spieldokument (Spiele-Origin bzw. eingebauter Host) `unsafe-inline`, `unsafe-eval` und `wasm-unsafe-eval` erlaubt – nie für RenOS selbst (siehe ARCHITECTURE.md).
- Die **Umwandlung von Windows-/Linux-/Mac-Builds** gibt es nur im lokalen Modus (RenOS auf GitHub Pages), nicht im Server-Modus. Sie ersetzt die Engine durch die Web-Laufzeit: Spiele mit nativen Python-Modulen, Netzwerk-/Steam-Funktionen oder Funktionen, die Ren’Py im Browser nicht hat, laufen nicht vollständig. Archive in unbekannten Formaten werden übersprungen und gemeldet. Spiele, die mit einer neueren Ren’Py-Version gebaut wurden als die mitgelieferte, laufen meist, aber nicht garantiert.
- Laufzeitpakete (Ren’Py 8.6.0: 43 MB, 7.8.7: 21 MB) werden beim ersten Windows-/Linux-Spiel einmalig geladen; dafür muss das iPad online sein.
- Server-Modus: Große Spiele sind **nicht offlinefähig**; der RenOS-Service-Worker speichert keine Spieldateien. Im **lokalen Modus** liegen Spiele auf dem Gerät und sind nach dem ersten Start offline spielbar.
- Ren’Py lädt die `game.zip` eines Web-Builds vollständig in den Arbeitsspeicher. Sehr große Spiele funktionieren nur, wenn Bilder/Audio als einzelne Dateien nachgeladen werden (Standard beim Ren’Py-Web-Build mit „Progressive Downloading“).
- Lokaler Modus: Veröffentlichung auf GitHub Pages nur vom Standard-Branch (Umgebungsschutz von `github-pages`).

## Bekannte Fehler / offene Punkte

- Keine bekannten reproduzierbaren Fehler in den getesteten Abläufen.
- Deflate-komprimierte Archive belegen beim Entpacken vorübergehend mehr Arbeitsspeicher (gemessen +324 MB bei 1,5 GB) als gespeicherte (+30 MB), weil der Browser-Dekompressor neue Puffer erzeugt.
- `npm audit` meldet Hinweise (moderat/niedrig) in **Build-Werkzeugen** (u. a. `glob`, `minimatch`, `deepmerge` über `workbox-build`). Sie betreffen nicht den ausgelieferten Code; ein Update von Workbox sollte sie beheben.
- `node:sqlite` ist in Node 22 als „experimentell“ markiert (stabil genutzt, Warnung wird unterdrückt). Mit Node 24 entfällt das.
- Wird ein Spielordner außerhalb von RenOS manuell gelöscht, bleibt der Eintrag in der Library bestehen und der Player meldet „Spiele-Server antwortet nicht“. Entfernen über die Library. (Umgekehrt werden Spielordner ohne Datenbankeintrag beim Serverstart entfernt.)

## Assets

Das bereitgestellte Icon-Paket enthielt sechs PNG-Icons (Dateimanager, Einstellungen, Terminal, Texteditor, Papierkorb, Webbrowser). Es enthielt **kein** Wallpaper, keine SVGs, kein Library-/Installer-/Haupticon und keine README. Daher:

- Übernommen (Originale in `assets/source/icons`, optimiert auf 256 px): Files ← Dateimanager, Settings ← Einstellungen, Terminal, Notes ← Texteditor, Papierkorb (Dock/Files), Webbrowser (Player-Symbol).
- Ergänzt im gleichen Stil (SVG in `assets/svg`): Library, Installer, RenOS-Logo und App-Icon.
- Wallpaper „Dämmerung“ (Standard), „Graphit“, „Tiefsee“ prozedural erzeugt (`npm run assets`).
- Sollen später offizielle Varianten verwendet werden: Dateien in `assets/source/icons` bzw. `assets/svg` ersetzen und `npm run assets` ausführen.
