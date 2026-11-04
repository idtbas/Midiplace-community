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

Spiele werden auf dem iPad installiert (OPFS von RenOS). Ausgeführt werden sie standardmäßig im **eingebauten Spiele-Host**; ein **externer Spiele-Host** auf einer zweiten Adresse ist optional.

### Eingebauter Spiele-Host (Standard)

```
┌──────────── iPad: installierte Web-App RenOS (Origin A, z. B. idtbas.github.io) ─────────────┐
│  OPFS renos-games/<id>/…   IndexedDB: Spiele, Cover, saves (pro Spiel)                       │
│                                                                                             │
│  Player ─ <iframe sandbox="allow-scripts allow-forms allow-downloads allow-pointer-lock"     │
│            srcdoc="CSP + <base href=https://renos-game.invalid/> + runtime.js">             │
│              │  Origin: anonym („null“) – kein Zugriff auf RenOS, kein eigener Speicher     │
│              │  ① runtime.js → „ready“ (postMessage an Origin A)                            │
│   MessagePort│  ② RenOS prüft: Absender = eigenes iframe, Origin „null“, Dokument nicht     │
│              │     lesbar → schickt MessagePort + Spielstände dieses Spiels                 │
│   file(path) │  ③ runtime.js lädt index.html des Spiels, übernimmt <head>/<body>, führt     │
│   ◄── File ──┤     Skripte der Reihe nach aus; fetch/XHR/<img>/<video>-Adressen unter der   │
│   saves ────►│     virtuellen Basis werden über den Port beantwortet (nur dieses Spiel)     │
│   ◄── ok ────┘  ④ IndexedDB-Nachbildung für IDBFS: Änderungen → RenOS → Tabelle „saves“      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Isolation:** `sandbox` ohne `allow-same-origin` gibt dem Dokument einen anonymen Origin. Es kann weder DOM noch Speicher, Cookies oder Service Worker von RenOS erreichen; jedes gestartete Spiel bekommt einen neuen anonymen Origin, Spiele sind also auch voneinander getrennt. RenOS bricht ab, falls es das Spieldokument lesen könnte (Gegenprobe beim Handshake). Keine Popups, keine Navigation des Hauptfensters.
- **Keine zweite Website, kein Netzwerk:** Das Dokument entsteht per `srcdoc` aus RenOS selbst und funktioniert offline. Die CSP erlaubt nur `blob:`/`data:` als Quellen; die virtuelle Basis `https://renos-game.invalid/` (reservierte Domain) wird nie aufgelöst – Anfragen darauf beantwortet `runtime.js` aus RenOS. Ren’Py braucht `unsafe-inline`, `unsafe-eval` und `wasm-unsafe-eval` – nur in diesem Dokument.
- **Laufzeit (`src/games/sandbox/runtime.js`):** ersetzt vor jedem Spielcode `fetch`, `XMLHttpRequest`, die `src`-Eigenschaft von Bild/Video/Audio, `indexedDB` (genau der von Emscriptens IDBFS genutzte Umfang), `localStorage`/`sessionStorage` (im Arbeitsspeicher), `navigator.serviceWorker` (nicht vorhanden) und `URL` (Basis `about:srcdoc` → virtuelle Basis). Range-Anfragen und MIME-Typen wie beim externen Host. Statusmeldungen (boot/progress/running/error/exit-request) gehen über denselben Port an den Player.
- **RenOS-Seite (`src/games/sandboxHost.ts`, `src/games/local/saves.ts`):** Alles aus dem iframe gilt als nicht vertrauenswürdig – das Spiel teilt sich den Origin mit der Laufzeit und könnte sie verändern. Dateien: nur für das laufende, installierte Spiel und mit derselben Pfadprüfung wie beim Entpacken. Spielstände: nur für dieses Spiel, Namen/Schlüssel/Typen geprüft, Limits 64 MB pro Eintrag, 1 GB und 50 000 Einträge pro Spiel, Änderungen alles-oder-nichts in einer Transaktion. Beim Entfernen eines Spiels werden seine Spielstände gelöscht; „Spielstände übernehmen von …“ kopiert sie in eine neue Version.

### Windows-/Linux-/Mac-Builds umwandeln

```
Installer ─► Worker: Analyse ─► Spielordner (…/game/), renpy/vc_version.py → Version, lib/py2|py3 → Python
                               └─► Laufzeit wählen: Python 3 → renpy-8.6.0, Python 2 → renpy-7.8.7
          ─► Worker: Laufzeit laden (einmalig) ─► OPFS renos-runtimes/<id>/ (SHA-256 geprüft)
          ─► Worker: Umwandeln ─► OPFS renos-games/<id>/
               archives/<n>.rpa   .rpa unverändert kopiert; Index (zlib + Pickle) gelesen
               game/<pfad>        lose Bilder/Musik/Stimmen/Videos (bei Bedarf geladen)
               game.zip           Engine (engine.zip des Pakets, Rohdaten übernommen) + Skripte, Schriften,
                                  GUI, kleine Dateien + Platzhalter am echten Pfad jeder nachladbaren Datei
                                  + game/renpyweb_remote_files.txt + Hilfsdateien (renos_web_support.rpy,
                                  _renos_host.py, _renpytfd.py, Modul-Ersatz)
               index.html         Startseite der Laufzeit mit Spieltitel
               renos-web.json     Datei → Archiv-Ausschnitte für nachgeladene Archivinhalte
Player ─► eingebauter Host ─► index.html / game.zip (beim Start zusammengesetzt, s. u.) / Laufzeitdateien /
                              game/<pfad> (aufbewahrte Datei, lose Datei oder Archiv-Ausschnitt)
```

- **Grundidee:** Ein Desktop-Build enthält dieselben Spieldaten wie ein Web-Build. RenOS ersetzt nur die Engine durch die offizielle Ren’Py-Web-Laufzeit und baut die `game.zip` wie der Ren’Py-Launcher (`launcher/game/web.rpy`, `distribute.rpy`).
- **Laufzeitpakete** (`scripts/build-renpy-runtime.mjs`): beim Deploy aus den offiziellen SDKs (8.6.0, 7.8.7) erzeugt – Web-Laufzeit (`renpy.wasm`/`renpy.data`/`renpy-pre.js` bzw. `index.wasm`/`pythonhome.data`/`pyapp.data`), `engine.zip` (main.py + `renpy/`, bei Python 3 mit Web-Transformation `__pycache__/X.cpython-312.pyc → X.pyc`), `LICENSE.txt`, `runtime.json` mit SHA-256 je Datei. Aus den SDKs wird nichts ausgeführt.
- **Was sofort geladen wird:** Skripte (`.rpyc`/`.rpy`), Schriften, Daten, GUI-Grafiken (bis 160 MB), kleine Bilder (≤ 24 KB, bis 48 MB) und kurze Klänge (≤ 128 KB, bis 48 MB). **Bei Bedarf:** alle anderen Bilder (`image B,H` – Größe aus dem Dateikopf: PNG, JPEG, WebP, AVIF), Musik (`music`), Stimmen (`voice`, Pfade mit „voice“), Videos (`video`). Bilder ohne lesbare Größe werden sofort geladen. Ordner nachgeladener Dateien stehen als Einträge in der `game.zip`, damit Ren’Py sie im Speicher anlegen kann.
- **Archive:** RPA-3.0 (XOR-Schlüssel), RPA-2.0, RPA-1.0 (`.rpi`). Der Index wird mit einem eigenen Pickle-Leser gelesen, der nur Daten kennt; Aufrufe sind bis auf `bytes()`/`_codecs.encode` (Python 3 schreibt so Bytes in Protokoll 2) verboten – ein Archiv kann keinen Code ausführen. Unsichere Pfade im Index werden verworfen. Vorrang wie in Ren’Py: lose Dateien vor Archiven, Archive in absteigender Namensfolge.
- **Ausgelassen:** `game/cache/`, `game/saves/`, `*.rpyb`, `__pycache__`, Programme/Bibliotheken (`.exe`, `.dll`, `.so`, …), Logdateien, die Engine des Spiels (`renpy/`, `lib/`).
- **Platzhalter am echten Pfad:** Jede nachladbare Datei hat in der `game.zip` einen Platzhalter an ihrem Pfad (Bild: transparentes PNG in echter Größe mit privatem Abschnitt `rnOs`; Audio/Video: leer). So finden Spiele sie mit `os.walk`/`glob`/`os.path.exists`. `_renos_host.py` setzt einen Loader-Rückruf vor das Dateisystem: Liegt ein Platzhalter am Pfad, folgt `DownloadNeeded` (Ren’Py lädt nach); Ren’Pys Aufräumen nach 60 s schreibt den Platzhalter zurück, statt die Datei zu löschen. `renpy.file()` liefert für noch nicht geladene Bilder den Platzhalter (für Größenabfragen), ohne Massen-Downloads auszulösen.
- **Datei-Dialoge (`_renpytfd`):** Ersatz für tinyfiledialogs. `openFileDialog` ruft per `emscripten.run_script` `RenOSHost.pickFiles` (sandbox/runtime.js) auf; RenOS zeigt seine Dateiauswahl (`system/filePicker.tsx`), schickt die Datei per MessagePort, die Laufzeit schreibt sie nach `/tmp/renos-picked/…`. Python wartet mit `emscripten.sleep` (Ren’Py 7 nur aus der Hauptschleife möglich). `saveFileDialog` liefert einen Pfad unter `/tmp/renos-export/`; ist die Datei fertig geschrieben, landet sie in Files → Downloads.
- **Vom Spiel angelegte Dateien (`overlay.ts`, `compose.ts`):** `_renos_host.py` vergleicht den Spielordner beim Laden der Skripte (und nach einer Dateiauswahl jede Minute) mit `renos_base.txt`/`renos_overlay.txt` und schickt neue bzw. gelöschte Dateien an RenOS (IndexedDB-Tabelle `overlay`, pro Spiel, Pfade nur unter `game/`, Größen begrenzt). Beim Start setzt RenOS die `game.zip` als Blob zusammen: Einträge der installierten Datei als Ausschnitte (keine Kopie), Reparaturen älterer Umwandlungen, aufbewahrte Skripte direkt, aufbewahrte Medien als Platzhalter plus Eintrag in `renpyweb_remote_files.txt`.
- **Grenzen:** Spiele mit nativen Python-Modulen, Netzwerkzugriffen oder Funktionen, die die Web-Version von Ren’Py nicht kennt, laufen nicht vollständig. Archive in unbekannten Formaten werden übersprungen und gemeldet. Der Server-Modus wandelt nicht um.

### Browser und Downloads (`apps/browser`, `system/downloads.ts`)

- Webseiten in einem iframe (`sandbox` ohne Navigation des Hauptfensters); Adressen auf dem Origin von RenOS werden nicht geöffnet (sie bekämen dessen Rechte).
- Downloads per `fetch` (CORS) mit Fortschritt nach Files → Downloads (≤ 512 MB). Webseiten statt Dateien: Datei-Links werden aus dem HTML gelesen und angeboten. Scheitert der direkte Weg und ist ein eigener Weiterleitungsdienst eingetragen (`tools/download-proxy/worker.js`, Cloudflare Worker, nur für den eingetragenen Origin, nur öffentliche Ziele), läuft der Download darüber; der echte Dateiname kommt aus `X-Final-Url`/`Content-Disposition`.
- Im Server-Modus nicht verfügbar: Die CSP der Oberfläche erlaubt dort keine fremden Rahmen und Verbindungen.

### Externer Spiele-Host (optional)

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

- **Warum die Dateien bei RenOS liegen:** Laut WebKit-Speicherrichtlinie dürfen Home-Bildschirm-Web-Apps bis zu 60 % des Datenträgers nutzen, ein iframe einer anderen Adresse aber nur 10 % davon. Mehrere Gigabyte große Spiele passen deshalb nur in den Speicher von RenOS selbst – bei beiden Hosts.
- **Spiele-Host** (`apps/gamehost`, rein statisch): `host.html`/`host.js` (Handshake, Weiterleitung), `sw.js` (Dateiauslieferung, Offline-Cache der Host-Dateien), `bridge.js` (Statusmeldungen), `renos-gamehost.json` (Kennung für die Prüfung in den Einstellungen; GitHub Pages erlaubt CORS).
- **Sicherheitsgrenzen:** RenOS nimmt den Handshake nur vom eigenen Player-iframe und vom eingestellten Spiele-Origin an, beantwortet Dateianfragen nur für das laufende Spiel, nur für installierte Spiele (Datenbankeintrag) und mit derselben Pfadprüfung wie beim Entpacken. Die Adresse des Spiele-Hosts muss sich von der RenOS-Adresse unterscheiden (geprüft in Einstellungen und Player). Ren’Pys eigener Service Worker wird nicht registriert, weil die Spielseite bereits vom Host-Service-Worker kontrolliert wird.
- **Fremde Seiten, die den Spiele-Host einbetten:** Der statische Host kennt die RenOS-Adresse nicht im Voraus und nimmt den Handshake deshalb von jeder einbettenden Seite an. Das gibt dieser Seite keine Rechte über RenOS: Sie kann nur ihre *eigenen* Dateien ausliefern, und Browser trennen Speicher und Service Worker eingebetteter Seiten nach der Hauptseite (Storage Partitioning in Safari, Chrome und Firefox). Spielstände, die unter RenOS entstehen, sind für sie daher nicht erreichbar.
- **Installation:** Analyse liest nur das Inhaltsverzeichnis (Millisekunden). Beim Entpacken liest ein BYOB-Reader in einen einzigen wiederverwendeten 4-MB-Puffer und schreibt über `createSyncAccessHandle()` (Rückfall: 4-MB-Abschnitte bzw. `createWritable()`). Gemessen in Chromium: 3,2 GB gespeichert in ~30 s mit +30 MB Arbeitsspeicher; 1,5 GB deflate mit +324 MB. Das Spiel erscheint erst nach erfolgreichem Datenbankeintrag; verwaiste Ordner werden beim Start entfernt.
- **Offline:** RenOS (Workbox) cacht seine Shell; Spieldateien liegen ohnehin lokal. Der eingebaute Host braucht nie eine Verbindung (E2E-Test startet ein echtes Spiel offline). Beim externen Host braucht der erste Start eine Verbindung, damit dessen Service Worker installiert wird.
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
│     ├─ games/         Spiele-Backends (Server/lokal), Installation ins OPFS, eingebauter Spiele-Host (sandbox/), Spielstände
│     ├─ persistence/   Dexie-Datenbank, virtuelles Dateisystem, Datensicherung
│     ├─ pwa/           Service-Worker-Registrierung, dauerhafter Speicher
│     ├─ shell/         Moduswahl (Install/Phone/Desktop), Onboarding, Fehlerbildschirme
│     ├─ ui/            Wiederverwendbare Komponenten (Button, Form, Feedback, LoginForm, AppIcon)
│     ├─ i18n/          Alle Texte (Deutsch), vorbereitet für weitere Sprachen
│     └─ styles/        Design-Tokens (CSS Custom Properties) + Tailwind-Theme
├─ apps/gamehost/       Optionaler externer Spiele-Host für den lokalen Modus (zweiter Origin)
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
