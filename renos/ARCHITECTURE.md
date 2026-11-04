# RenOS – Architektur

## Überblick

```
┌──────────────────────── iPad (Safari / installierte Web-App) ────────────────────────┐
│                                                                                       │
│  RenOS-Oberfläche  (Origin A: https://renos.example.com)                               │
│  ├─ Desktop-Shell: Systemleiste · Dock · Launcher · Menüs · Dialoge · Toasts          │
│  ├─ Window Manager (Zustand-Store, zentrale Fensterzustände)                          │
│  ├─ Apps: Files · Library · Installer · Settings · Terminal · Notes · Player          │
│  ├─ IndexedDB (Dexie): Dateien, Notizen, eigenes Wallpaper   localStorage: Settings   │
│  └─ Service Worker: nur App-Shell (HTML/JS/CSS/Icons/Wallpaper)                       │
│          │ fetch /api (Cookie + CSRF)              ▲ postMessage (nur Statusmeldungen) │
│          ▼                                         │                                   │
│     ┌──────────────┐                     ┌─────────┴─────────────────────────────┐    │
│     │  iframe-frei │                     │ <iframe sandbox …>  Origin B          │    │
│     │              │                     │ https://games.renos.example.com/g/<id>│    │
│     └──────────────┘                     │ Ren’Py-Web-Build + RenOS-Bridge       │    │
│                                          │ IndexedDB (IDBFS): Ren’Py-Spielstände  │    │
│                                          └───────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────────────────┘
                 │ HTTPS                                   │ HTTPS
                 ▼                                         ▼
┌──────────────────────────── Server (ein Node.js-Prozess) ─────────────────────────────┐
│  App-/API-Server (Port 8787)                  Game-Host (Port 8788)                    │
│  ├─ /api/*  Fastify, Auth, Uploads, Jobs      ├─ /g/<id>/*  nur installierte Spiele   │
│  ├─ /*      gebautes Frontend (apps/web/dist) ├─ /__renos/bridge.js                    │
│  └─ GameService ─────────── SQLite (node:sqlite) · data/games · data/uploads · covers │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

## Lokaler Modus (ohne Server, z. B. GitHub Pages)

```
┌──────────── iPad: installierte Web-App RenOS (Origin A, z. B. idtbas.github.io) ─────────────┐
│  Installer ─► Worker: ZIP lesen (Blob.slice, ZIP64, CRC) ─► OPFS  renos-games/<id>/…        │
│               (gleiche Sicherheitsregeln wie der Server: packages/shared/src/archive.ts)    │
│  IndexedDB: Spiel-Metadaten, Cover                                                          │
│                                                                                             │
│  Player ─ iframe ─► Origin B (z. B. idtbas-games.github.io)  host.html?game=<id>            │
│              ▲         │  ① „ready“ → RenOS antwortet mit MessagePort („init“)              │
│   MessagePort│         │  ② registriert sw.js, lädt inneres iframe play/<id>/index.html     │
│   file(path) │         │  ③ sw.js: GET play/<id>/<pfad> → Host-Seite → Port → RenOS         │
│   ◄─ File ───┘         │     liest Datei aus OPFS (nur dieses Spiel, nur lesend) → Response │
│                        │     mit MIME, Range, CSP; index.html bekommt bridge.js             │
│                        └► Ren’Py läuft im Origin B; Spielstände: IDBFS im Origin B         │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Warum die Dateien bei RenOS liegen:** Laut WebKit-Speicherrichtlinie dürfen Home-Bildschirm-Web-Apps bis zu 60 % des Datenträgers nutzen, ein iframe einer anderen Adresse aber nur 10 % davon. Mehrere Gigabyte große Spiele passen deshalb nur in den Speicher von RenOS selbst. Ausgeführt werden sie trotzdem auf Origin B.
- **Spiele-Host** (`apps/gamehost`, rein statisch): `host.html`/`host.js` (Handshake, Weiterleitung), `sw.js` (Dateiauslieferung, Offline-Cache der Host-Dateien), `bridge.js` (Statusmeldungen), `renos-gamehost.json` (Kennung für die Prüfung in den Einstellungen; GitHub Pages erlaubt CORS).
- **Sicherheitsgrenzen:** RenOS nimmt den Handshake nur vom eigenen Player-iframe und vom eingestellten Spiele-Origin an, beantwortet Dateianfragen nur für das laufende Spiel, nur für installierte Spiele (Datenbankeintrag) und mit derselben Pfadprüfung wie beim Entpacken. Die Adresse des Spiele-Hosts muss sich von der RenOS-Adresse unterscheiden (geprüft in Einstellungen und Player). Ren’Pys eigener Service Worker wird nicht registriert, weil die Spielseite bereits vom Host-Service-Worker kontrolliert wird.
- **Installation:** Analyse liest nur das Inhaltsverzeichnis (Millisekunden). Beim Entpacken liest ein BYOB-Reader in einen einzigen wiederverwendeten 4-MB-Puffer und schreibt über `createSyncAccessHandle()` (Rückfall: 4-MB-Abschnitte bzw. `createWritable()`). Gemessen in Chromium: 3,2 GB gespeichert in ~30 s mit +30 MB Arbeitsspeicher; 1,5 GB deflate mit +324 MB. Das Spiel erscheint erst nach erfolgreichem Datenbankeintrag; verwaiste Ordner werden beim Start entfernt.
- **Offline:** RenOS (Workbox) und der Spiele-Host (eigener Service Worker) cachen ihre Shell; Spieldateien liegen ohnehin lokal. Der erste Start eines Spiels braucht eine Verbindung, damit der Host-Service-Worker installiert wird.
- **Modus-Wahl:** zur Build-Zeit über `VITE_RENOS_BACKEND=local`; `src/games/backend.ts` kapselt Server- und lokale Implementierung hinter derselben Schnittstelle.

## Repository-Struktur

```
renos/
├─ packages/shared/     Typisierte API-Verträge, Bridge-Protokoll (parseBridgeMessage), Hilfsfunktionen
├─ apps/server/         Fastify-Backend
│  ├─ src/app.ts        Zusammenbau: Sicherheitsheader, Fehlerbehandlung, Rate Limit, Frontend-Auslieferung
│  ├─ src/gameHost.ts   Zweiter Fastify-Server für Spielinhalte (eigener Origin, eigene CSP)
│  ├─ src/auth/         Single-Owner-Auth (scrypt, Sessions, CSRF, Origin-Prüfung)
│  ├─ src/zip/          Pfadprüfung, Archivanalyse, sichere Extraktion
│  ├─ src/games/        GameService (Uploads, Jobs, Installation, Cover), Bridge-Skript
│  └─ test/             Vitest: Archiv-Sicherheit, API-Integration, Sicherheitskonfiguration
├─ apps/web/            React-Frontend
│  └─ src/
│     ├─ system/        Systemkern: Window Manager, Geometrie, App-Registry, Settings, Shortcuts, Dialoge, …
│     ├─ wm/            Fensterrahmen, Fensterebene, Fensterkontext (Header-Slot)
│     ├─ desktop/       Desktop, Systemleiste, Dock, Launcher, Panels, Kontextmenü- und Dialog-Host, Wallpaper
│     ├─ apps/          Files, Library, Installer, Settings, Terminal, Notes, Player
│     ├─ api/           API-Client (fetch + XHR-Upload) und Server-Store
│     ├─ persistence/   Dexie-Datenbank, virtuelles Dateisystem, Datensicherung
│     ├─ pwa/           Service-Worker-Registrierung, dauerhafter Speicher
│     ├─ shell/         Moduswahl (Install/Phone/Desktop), Onboarding, Fehlerbildschirme
│     ├─ ui/            Wiederverwendbare Komponenten (Button, Form, Feedback, LoginForm, AppIcon)
│     ├─ i18n/          Alle Texte (Deutsch), vorbereitet für weitere Sprachen
│     └─ styles/        Design-Tokens (CSS Custom Properties) + Tailwind-Theme
├─ apps/gamehost/       Statischer Spiele-Host für den lokalen Modus (zweiter Origin)
├─ e2e/                 Playwright-Tests (Server- und lokaler Modus), Testserver, eigenes Ren’Py-Testspiel
├─ assets/              Originale des Icon-Pakets und SVG-Quellen der ergänzten Icons
├─ scripts/             Asset-Generator, Passwort-Hash, Testspiel-Assembler
└─ deploy/              Docker Compose + Caddy (HTTPS)
```

## Frontend

### Darstellungsmodi

`lib/platform.ts` entscheidet beim Start (`detectMode`):

| Modus | Bedingung | Ergebnis |
| --- | --- | --- |
| `phone` | kurze Bildschirmseite < 600 pt und Touch | Hinweis „RenOS ist für das iPad gemacht“ |
| `desktop` | `navigator.standalone === true` (Safari) oder `display-mode: standalone/fullscreen/minimal-ui`, oder Entwicklungsmodus (`?mode=desktop`) | Einrichtungsassistent (einmalig) → Desktop |
| `install` | sonst | Installationsseite mit nicht interaktiver Vorschau |

Installationsseite, Einrichtungsassistent und Desktop werden getrennt nachgeladen; bis dahin bleibt der reine CSS-Startbildschirm aus `index.html` sichtbar.

### Window Manager (`system/windows.ts`, `system/geometry.ts`, `wm/`)

- **Ein zentraler Store** hält alle Fenster: ID, App, Titel, normale Fläche (`rect`), Modus (`normal | maximized | snap-left | snap-right`), Minimiert, Payload (z. B. Ordner, Spiel-ID).
- **Stapelreihenfolge** ist eine Liste `order`; der z-index wird daraus abgeleitet (`10 + Index`). Es gibt keine wachsenden z-index-Ketten.
- **Geometrie** ist rein funktional und getestet: `clampRect` hält mindestens 96 px der Titelleiste sichtbar, `resizeRect` respektiert Mindestgrößen, `initialRect` kaskadiert neue Fenster, `snapTargetFor` erkennt Ränder.
- **Ziehen und Größenänderung** laufen über Pointer Events mit `setPointerCapture`. Während der Bewegung wird nur das DOM-Element per `translate3d` verschoben (kein React-Render pro Frame); erst beim Loslassen wird der Store aktualisiert. Eine transparente Fläche über dem Fensterinhalt verhindert, dass iframes Zeigerereignisse schlucken.
- **Arbeitsfläche** (`bounds`) wird per `ResizeObserver` gemessen (Systemleiste oben, Dock unten). Bei Größenänderungen (Drehung, Split View, Stage Manager) werden alle Fenster neu begrenzt.
- **Persistenz**: Fenster, Reihenfolge und zuletzt genutzte Größen je App liegen in `localStorage` (`renos.windows`). Player-Fenster werden bewusst nicht wiederhergestellt – Spiele starten nie automatisch.
- **DOM-Reihenfolge** der Fenster ist stabil (nach Erstellung sortiert). Fokuswechsel ändern nur den z-index, damit iframes (Spiele) nie neu geladen werden.
- **Immersiver Modus**: Das Player-Fenster wird `position: fixed` über Systemleiste und Dock gelegt – ohne Remount des iframes.

### Anwendungssystem (`system/appMeta.ts`, `system/apps.tsx`)

Jede App hat Metadaten (Name, Icon, Suchbegriffe, Standard- und Mindestgröße, Single-/Multi-Instance) und eine per `React.lazy` nachgeladene Komponente. Apps erhalten `windowId` und `payload`; Titel, Payload und Header-Bedienelemente (`WindowHeader`-Portal) setzen sie über den Window Manager. Gemeinsame Aktionen (App öffnen/aktivieren, Spiel starten, Files an Ort öffnen) liegen in `system/actions.ts`.

### Eingabe

- **Shortcut-Manager** (`system/shortcuts.ts`): Registry mit Geltungsbereich `global` oder App-ID, Erkennung über `event.code` (Layout-unabhängig, funktioniert mit ⌥), `Mod` = ⌘ oder Ctrl. In Textfeldern greifen nur ausdrücklich erlaubte Kürzel. Systemkürzel lassen sich in den Einstellungen abschalten.
- **Spiele erhalten alle Tasten**: Ein fokussiertes iframe auf fremdem Origin liefert Tastaturereignisse nur an sich selbst; RenOS kann sie weder sehen noch abfangen. Einzige Ausnahme ist ⌥⇧Esc, das die Bridge ausdrücklich an RenOS meldet (Verlassen des immersiven Modus).
- **Kontextmenüs** über Rechtsklick/Zwei-Finger-Klick (`contextmenu`) und langes Drücken auf Touch-Geräten.

### Design-System

Design-Tokens als CSS Custom Properties (`styles/index.css`), über `@theme inline` als Tailwind-Klassen verfügbar. Akzentfarbe, UI-Skalierung, Bewegung (`data-motion`) und Transparenz (`data-transparency`) werden zur Laufzeit gesetzt. Animationen nutzen `transform`/`opacity`; `prefers-reduced-motion` wird respektiert (MotionConfig + CSS-Dauern = 0). Unschärfe nur auf kleinen schwebenden Flächen und abschaltbar.

## Persistenz

| Daten | Ort | Hinweis |
| --- | --- | --- |
| Einstellungen | `localStorage` `renos.settings` | Zustand-persist, validiert beim Laden |
| Fenster | `localStorage` `renos.windows` | ohne Player-Fenster |
| Terminal-Verlauf | `localStorage` `renos.terminal.history` | max. 200 Einträge |
| Dateien | IndexedDB `nodes` + `blobs` | Metadaten und Inhalt getrennt (schnelle Listen) |
| Notizen | IndexedDB `notes` | Titel = erste Zeile, Autosave 400 ms |
| Eigenes Wallpaper | IndexedDB `kv` | Blob |
| Spiele, Cover, Uploads | Server (`data/`) | SQLite + Dateisystem |
| Ren’Py-Spielstände | IndexedDB des **Spiele-Origins** (IDBFS) | von Ren’Py verwaltet, Export über Ren’Py-Menü |

**Datensicherung** (`persistence/backup.ts`): ZIP mit `renos-backup.json` (Einstellungen, Notizen, Dateibaum) und `files/<id>`. Die Wiederherstellung ergänzt (löscht nichts) und legt Dateien in einem neuen Ordner ab.

**Service Worker** (Workbox `generateSW`): Precache der App-Shell, Navigations-Fallback auf `index.html` (außer `/api`), keine Laufzeit-Caches. Updates werden nicht automatisch aktiviert („Update verfügbar → Jetzt aktualisieren“, `skipWaiting` auf Anforderung).

## Backend

### API

| Methode | Pfad | Zugriff |
| --- | --- | --- |
| GET | `/api/health` | öffentlich |
| GET | `/api/auth/session` | öffentlich |
| POST | `/api/auth/login` · `/api/auth/logout` | Origin-Prüfung, Login: 8 Versuche / 15 min |
| GET | `/api/games` · `/api/games/:id` · `/api/games/:id/cover` · `/api/storage` | Owner (oder öffentlich mit `RENOS_PUBLIC_LIBRARY`) |
| POST | `/api/games/:id/played` | Leser |
| PATCH/DELETE | `/api/games/:id` | Owner + CSRF |
| PUT/DELETE | `/api/games/:id/cover` | Owner + CSRF, PNG/JPEG/WebP ≤ 8 MB (Signaturprüfung) |
| POST | `/api/uploads?name=…` | Owner + CSRF, roher ZIP-Stream, `Content-Length` Pflicht |
| GET/DELETE | `/api/uploads/:id` | Owner (+ CSRF) |
| POST | `/api/uploads/:id/install` | Owner + CSRF → Job |
| GET | `/api/jobs/:id` | Owner |

Fehler haben immer die Form `{ "error": { "code": "…", "message": "…" } }` (Codes in `packages/shared`); das Frontend zeigt eigene deutsche Texte je Code.

### Installationsablauf

```
Upload-Stream ──► uploads/<id>.zip.part ──(Länge stimmt)──► uploads/<id>.zip
                                                               │ analyzeArchive (ohne Entpacken)
                     nicht installierbar ◄────────────────────┤
                     (Datei sofort gelöscht)                   │ installierbar → DB-Eintrag „ready“
POST install ──► claimUpload (atomar) ──► staging/<job>/ ◄── extractArchive (Byte-Zählung, 'wx')
                                              │ index.html vorhanden? Presplash → Cover (Signaturprüfung)
                                              ▼
                               rename(staging/<job>, games/<gameId>)   ← atomar, gleiches Dateisystem
                                              ▼
                               DB-Transaktion: Spiel eintragen + Upload entfernen
Fehler in irgendeinem Schritt → Staging/Spielordner/Cover entfernen, Upload freigeben, Job „failed“
```

Beim Start entfernt der Server Teil-Uploads, verwaiste Staging-Ordner und Spielordner ohne Datenbankeintrag (nur mit RenOS-eigenem ID-Format, nur innerhalb des Datenverzeichnisses). Abgelaufene Uploads (1 h) werden alle 10 Minuten bereinigt.

## Spielbereitstellung

- Game-Host liefert nur Spiele aus, die in der Datenbank stehen (gelöschte Spiele sind sofort unerreichbar).
- Pfadprüfung mit derselben Logik wie beim Entpacken, keine Dotfiles, `lstat` (keine Symlinks) und `realpath`-Prüfung.
- MIME-Typen explizit (u. a. `.wasm → application/wasm`, `.data → application/octet-stream`), ETag/Last-Modified, `Range`, `HEAD`.
- `index.html` wird mit eingefügter Bridge (`/__renos/bridge.js`) und `Cache-Control: no-cache` ausgeliefert; alle anderen Dateien sind unveränderlich (`immutable`), weil jede Installation eine neue ID erhält.

### Bridge (`games/bridge.ts`, `parseBridgeMessage`)

Das Bridge-Skript läuft im Spiele-Origin und meldet per `postMessage` an genau `RENOS_APP_ORIGIN`: `boot`, `progress` (aus Ren’Pys Fortschrittsbalken), `running` (Ren’Py entfernt den Presplash über `presplashEnd()`), `error` (Ren’Py-Fehlertext), `storage` (Ergebnis von `navigator.storage.persist()`), `exit-request` (⌥⇧Esc). Der Player akzeptiert Nachrichten nur, wenn `event.origin` dem Spiele-Origin **und** `event.source` dem eigenen iframe entspricht, und validiert jede Nachricht streng (Typ-Whitelist, Längenbegrenzung).

### Player

- `sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-pointer-lock"`, `allow="autoplay; fullscreen; gamepad"`, `referrerpolicy="no-referrer"`.
  - `allow-same-origin` ist nötig (IndexedDB für Spielstände, Ressourcen des eigenen Origins) und sicher, weil der Origin nicht der von RenOS ist. Der Player verweigert den Start, falls die Spiel-URL doch auf dem RenOS-Origin läge.
  - `allow-forms`: Ren’Py-Texteingabe nutzt ein `<form>`; `allow-downloads`: „Export Saves“/„Download Log“.
  - Nicht erlaubt: Popups, Top-Navigation, Modals.
- Zustände: Auflösen → Laden (Fortschritt) → Läuft; Fehler „nicht gefunden“, „nicht erreichbar“ (keine Bridge-Meldung in 15 s), „Laufzeitfehler“ (Ren’Py-Meldung). Lädt es länger als 90 s, erscheint ein Hinweis – ohne Erfolg vorzutäuschen.
- Beim Schließen wird das iframe auf `about:blank` gesetzt und entfernt (Audio, WebAssembly und Speicher werden freigegeben).

## Sicherheitsmodell

| Risiko | Maßnahme |
| --- | --- |
| Fremder Spielcode greift auf RenOS zu | Getrennter Origin, iframe-Sandbox, CSP `frame-ancestors` nur RenOS, RenOS-CSP `frame-src` nur Spiele-Origin |
| Spiel leitet Daten aus | Game-CSP `connect-src 'self'`, keine Popups/Top-Navigation |
| Gefälschte Nachrichten an RenOS | Origin- und Source-Prüfung, strikte Nachrichtenvalidierung |
| Path Traversal / Zip Slip | Pfadprüfung (absolut, `..`, Backslash, Steuerzeichen, leere Segmente, Tiefe, Länge), `resolveInside`, `wx`-Flag |
| Symlinks, Gerätedateien | Unix-Modus aus externen Attributen → abgelehnt |
| Zip-Bombs | Gesamtgröße, Kompressionsverhältnis, Einträge; beim Entpacken echte Byte-Zählung (`validateEntrySizes` + eigene Zählung) |
| Doppelte/kollidierende Einträge | Groß-/Kleinschreibung-unabhängige Prüfung, Datei-vs.-Ordner-Konflikte |
| Ausführbare Dateien | `.exe`, `.dll`, `.sh`, `.app/…` usw. werden nie installiert |
| Halbfertige Installationen | Staging + atomares `rename` + DB-Transaktion, Aufräumen bei Fehlern und beim Start |
| Unbefugte Verwaltung | Single-Owner-Passwort (scrypt), HttpOnly-/SameSite=Strict-Cookie (Pfad `/api`), Session-Token nur gehasht gespeichert, CSRF-Token + Origin-Prüfung, Login-Rate-Limit |
| Bösartige Cover-Bilder | Signaturprüfung (PNG/JPEG/WebP), Auslieferung mit `nosniff` und `CSP: sandbox` |
| Geheimnisse im Code | keine; Passwort-Hash nur über Umgebungsvariable; Fehlermeldungen ohne interne Details |
| Terminal | ausschließlich interne Befehle, kein `eval`, keine Server-Shell |

### Notwendige CSP-Ausnahmen für Ren’Py (Game-Origin)

`'unsafe-inline'` (Inline-Skripte und `javascript:`-Links in Ren’Pys `index.html`), `'unsafe-eval'` (Ren’Py ruft JavaScript über `emscripten_run_script`/`eval` auf, z. B. `presplashEnd()`), `'wasm-unsafe-eval'` (WebAssembly), `blob:`/`data:` (Save-Export, Medien). Diese Ausnahmen gelten nur für den Spiele-Origin; die RenOS-Oberfläche erlaubt ausschließlich eigene Skripte (`script-src 'self'`).

## Spielstände – Analyse

Ren’Py-Web (8.x) bindet `~/.renpy` per Emscripten-IDBFS ein und synchronisiert nach dem Speichern (`renpy.savelocation.syncfs`) in die IndexedDB-Datenbank `/home/web_user/.renpy` – **im Origin des Spiels**. Daraus folgt:

- Spielstände überstehen Schließen und Neustart (im E2E-Test mit echtem Ren’Py 8.5 nachgewiesen).
- Alle Spiele teilen sich diese Datenbank; Ren’Py trennt sie über den Unterordner `config.save_directory`.
- Unter iPadOS gilt der Speicher als Teil der installierten Web-App. Er kann bei Speicherknappheit entfernt werden, falls kein dauerhafter Speicher gewährt wurde. Die Bridge fordert `navigator.storage.persist()` im Spiele-Origin an und zeigt das Ergebnis im Player.
- Sicherung: Ren’Pys eigenes ☰-Menü → „Export Saves“ (ZIP) / „Import Saves“. RenOS erfindet keine eigene Cloud-Speicherung.
