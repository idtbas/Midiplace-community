# RenOS

RenOS ist eine Desktop-Umgebung als Progressive Web App für das **iPad mit Magic Keyboard**. Sie fühlt sich an wie ein eigenständiges, ruhiges Linux-Desktop-System – mit Systemleiste, Dock, App-Launcher und echten Fenstern – und ihre wichtigste Aufgabe ist es, **Ren’Py-Webspiele** zu installieren, zu verwalten und auszuführen.

RenOS ersetzt iPadOS nicht. Es läuft als installierte Web-App („Zum Home-Bildschirm“) in einem eigenen Fenster.

**Windows- und Linux-Visual-Novels auf dem iPad:** RenOS installiert die normalen Ren’Py-Downloads für Windows/Linux („…-pc.zip“) und wandelt sie auf dem Gerät in Web-Builds um – mit einer mitgelieferten Ren’Py-Laufzeit (Ren’Py 8.6 für aktuelle Spiele, Ren’Py 7.8 für ältere Python-2-Spiele). Siehe [„Windows- und Linux-Spiele“](#windows--und-linux-spiele).

| Bereich | Inhalt |
| --- | --- |
| Desktop | Wallpaper, Systemleiste (Uhr, Netzwerk-/Serverstatus, Benachrichtigungen, Schnellaktionen), Dock, Launcher mit Suche, Kontextmenüs, Dialoge, Toasts |
| Window Manager | Verschieben, Größe ändern, Minimieren, Maximieren, Einrasten links/rechts, Fokus und Stapelung, gespeicherte Positionen, Anpassung an Multitasking-Größen |
| Apps | **Files** (virtuelles Dateisystem in IndexedDB), **Library**, **Installer**, **Settings**, **Terminal** (sichere interne Befehle), **Notes**, **Player** |
| Spiele | Ren’Py-Web-Builds (ZIP) installieren, Sicherheitsprüfung, atomare Installation, Ausführung **abgeschottet von RenOS** (eingebauter Spiele-Host oder eigener Spiele-Origin), Spielstände pro Spiel, Player mit immersivem Modus |
| PWA | Manifest, Apple-Touch-Icons, Service Worker (Offline-Start der Oberfläche), Installationsseite in Safari, Einrichtungsassistent |

Weitere Dokumente: [ARCHITECTURE.md](ARCHITECTURE.md) · [TESTING.md](TESTING.md) · [STATUS.md](STATUS.md)

RenOS kann auf zwei Arten betrieben werden:

| Modus | Für wen | Spiele liegen … |
| --- | --- | --- |
| **Lokal (GitHub Pages)** | Du hast nur ein iPad | direkt auf dem iPad (kein Upload, kein Server, offline spielbar) |
| **Server** | Du hast einen eigenen Server/VPS | auf dem Server, mehrere Geräte nutzen dieselbe Bibliothek |

---

## RenOS nur mit dem iPad – über GitHub

GitHub kann keinen dauerhaften Server betreiben, aber statische Websites (GitHub Pages) – und mehr braucht RenOS im **lokalen Modus** nicht. Alle Schritte gehen in Safari auf dem iPad.

### 1. RenOS veröffentlichen

GitHub Pages veröffentlicht nur vom **Standard-Branch** (`claude/midiplace-prototype`); andere Branches blockiert die Umgebung „github-pages“. RenOS muss deshalb einmal dorthin gemergt werden:

1. github.com → Repository → **Pull requests** → **New pull request**.
2. **base:** `claude/midiplace-prototype`, **compare:** `claude/renos-desktop-os-bvdtya` → **Create pull request** → **Merge pull request**.

Danach baut `.github/workflows/pages.yml` bei jedem Push auf den Standard-Branch automatisch:

- `https://<dein-name>.github.io/Midiplace-community/renos/` – RenOS
- `https://<dein-name>.github.io/Midiplace-community/renos-games/` – optionaler externer Spiele-Host (nur im Fork sinnvoll, siehe unten)

Midiplace bleibt unverändert unter `https://<dein-name>.github.io/Midiplace-community/`. Prüfen: github.com → Repository → **Actions** → „Deploy to GitHub Pages“ muss grün sein.

### 2. Auf dem iPad installieren

1. `https://<dein-name>.github.io/Midiplace-community/renos/` in **Safari** öffnen.
2. **Teilen** → **Zum Home-Bildschirm** → „Als Web-App öffnen“ eingeschaltet lassen → **Hinzufügen**.
3. RenOS über das neue Symbol starten. (Nur so bekommt RenOS den großen Speicher einer installierten Web-App.)

### 3. Spiele installieren und spielen

1. Das Spiel als ZIP-Datei in die **Dateien-App** des iPads legen (z. B. iCloud Drive, Download in Safari) – den **Windows-/Linux-Download** („…-pc.zip“), die Mac-Version oder einen Web-Build („…-web.zip“).
2. RenOS → **Installer** → **ZIP-Datei auswählen**. Das Archiv wird auf dem iPad geprüft – **nichts wird hochgeladen**, es gibt **kein Größenlimit** außer dem freien Speicher. Windows-/Linux-Builds werden dabei umgewandelt (beim ersten Mal wird einmalig die Ren’Py-Laufzeit geladen, 21–43 MB).
3. Die Library zeigt das Spiel; **Spielen** startet es im **eingebauten Spiele-Host**. Es gibt nichts einzurichten.

### Windows- und Linux-Spiele

Ren’Py-Spiele bestehen aus der Engine (für Windows, Linux oder Mac kompiliert) und dem Ordner `game/` mit Skripten, Bildern, Musik und Stimmen. Die Spieldaten sind auf allen Plattformen gleich – RenOS tauscht deshalb nur die Engine gegen die offizielle **Ren’Py-Web-Laufzeit** aus, so wie es der Ren’Py-Launcher beim Bau eines Web-Builds tut:

- **Erkennung:** Spielordner (auch in Mac-Apps), Ren’Py-Version (`renpy/vc_version.py`), Python-Generation. Ren’Py 8 → Laufzeit **8.6.0**, Ren’Py 6/7 (Python 2) → Laufzeit **7.8.7**.
- **Skripte, Schriften, GUI** kommen in die `game.zip` und werden beim Start geladen.
- **Bilder, Musik, Stimmen, Videos** werden beim Spielen aus dem iPad-Speicher **nachgeladen** (Ren’Pys „Progressive Downloading“) – auch mehrere Gigabyte große Spiele brauchen so nur wenig Arbeitsspeicher.
- **`.rpa`-Archive** (RPA-3.0, 2.0, 1.0) werden nicht entpackt: RenOS liest ihr Inhaltsverzeichnis und liefert Dateien direkt als Ausschnitt des Archivs – kein doppelter Speicherbedarf. Archive, die nur Skripte enthalten, werden nach der Umwandlung gelöscht.
- **Offline:** Laufzeit und Spiel liegen auf dem iPad; umgewandelte Spiele starten ohne Internet.
- **Ältere Installationen:** Verbesserungen der Umwandlung wirken auch für bereits installierte Spiele. RenOS bringt die `game.zip` beim Start auf den neuen Stand (z. B. `.rpy` neben `.rpyc` weglassen, Platzhalter in echter Bildgröße, Ersatz-Module) – ohne Neuinstallation und ohne zusätzlichen Speicher.
- **Dateien im Spielordner:** Nachladbare Bilder, Musik und Videos liegen bis zum Nachladen als Platzhalter an ihrem echten Pfad. Spiele, die ihre Dateien selbst im Dateisystem suchen (`os.walk`, `glob`, `os.path.exists` – z. B. die Szenario-Bilder von Student Transfer), finden sie so. Ren’Py lädt trotzdem das echte Bild nach.
- **Datei-Dialoge im Spiel:** Ruft ein Spiel den Datei-Dialog auf (z. B. „Szenario hinzufügen“ in Student Transfer), öffnet sich die **Dateiauswahl von RenOS** – mit den Orten aus Files und „Vom iPad wählen …“. „Speichern unter“ im Spiel legt die Datei in **Files → Downloads** ab.
- **Vom Spiel angelegte Dateien bleiben erhalten:** Installiert ein Spiel etwas in seinen Spielordner (z. B. ein Szenario aus einer ZIP), bewahrt RenOS diese Dateien pro Spiel auf und gibt sie beim nächsten Start wieder mit – auch offline. Beim Entfernen des Spiels werden sie mit gelöscht.
- **Library:** zeigt bei umgewandelten Spielen Herkunft, Spielversion und Laufzeit; **Settings → Spiele** zeigt die installierten Laufzeiten.

Die Laufzeitpakete entstehen beim Veröffentlichen auf GitHub aus den offiziellen Ren’Py-SDKs von renpy.org (unverändert; Ren’Py steht unter der MIT-Lizenz, enthaltene Bibliotheken u. a. unter LGPL). Jedes Paket enthält die `LICENSE.txt` des SDK (`renos/runtimes/renpy-<version>/LICENSE.txt`).

Grenzen: Spiele, die eigene Python-Module mit nativem Code, Netzwerkzugriffe oder Funktionen nutzen, die es in der Web-Version von Ren’Py nicht gibt (z. B. Steam-Anbindung), laufen nicht oder nur teilweise. Archive in selbst erfundenen Formaten (manche Spiele verschlüsseln sie) werden erkannt, übersprungen und gemeldet. Ein Spiel, das mit einer neueren Ren’Py-Version als der mitgelieferten gebaut wurde, startet meist trotzdem – RenOS weist darauf hin.

### Browser und Downloads

Die App **Browser** zeigt Webseiten in RenOS und lädt Dateien **direkt nach RenOS** (Files → Downloads) statt in die Dateien-App des iPads. Von dort öffnen Spiele sie in ihrer Dateiauswahl, und der Installer kann sie installieren.

- **Herunterladen:** Knopf „Herunterladen“ (aktuelle Seite oder eingefügter Link). Ist die Adresse eine Webseite, zeigt RenOS die darauf gefundenen Datei-Links zur Auswahl. Tipp: Einen Download-Link auf der Seite gedrückt halten → „Link kopieren“ und einfügen.
- **Grenzen des Browsers (nicht von RenOS):** Viele Seiten verbieten das Einbetten (Google Drive, Mediafire, Foren) – dann bleibt der Rahmen leer: „In Safari öffnen“. Downloads klappen direkt, wenn der Server sie Web-Apps erlaubt (CORS, z. B. GitHub, student-transfer.com). Sonst die Datei in Safari laden und in Files importieren – oder:

<details>
<summary>Downloads von allen Seiten: eigener Weiterleitungsdienst (optional, kostenlos)</summary>

Ein kleiner Dienst, der die Datei für RenOS holt – nur für deine RenOS-Adresse, nur lesend, ohne etwas zu speichern. Der Code liegt in [`tools/download-proxy/worker.js`](tools/download-proxy/worker.js).

1. Auf dem iPad in Safari **dash.cloudflare.com** öffnen und kostenlos registrieren.
2. **Workers & Pages → Create → Worker** → Namen vergeben (z. B. `renos-download`) → **Deploy**.
3. **Edit code** → den Inhalt von `worker.js` einfügen → **Deploy**.
4. **Settings → Variables and Secrets → Add**: Name `ALLOWED_ORIGINS`, Wert `https://<dein-name>.github.io` → speichern.
5. Die Adresse des Workers (`https://renos-download.<konto>.workers.dev`) in RenOS eintragen: **Settings → Browser & Downloads → Eigener Weiterleitungsdienst → Prüfen & speichern**.

RenOS nutzt den Dienst nur, wenn der direkte Download scheitert. Die Datei geht dabei durch deinen eigenen Worker – nicht durch fremde Dienste.

</details>

Im Server-Modus ist der Browser aus Sicherheitsgründen nicht verfügbar (die Sicherheitsrichtlinie von RenOS erlaubt dort keine fremden Seiten).

### Der eingebaute Spiele-Host

Spiele enthalten fremdes JavaScript. Damit sie nie mit den Rechten von RenOS laufen, startet RenOS jedes Spiel in einem abgeschotteten Rahmen (iframe mit `sandbox`, ohne `allow-same-origin`). Der Browser gibt ihm einen **eigenen, anonymen Origin**: Das Spiel kann weder RenOS noch andere Spiele lesen oder verändern – dieselbe Trennung wie bei einer zweiten Website, nur ohne zweite Website.

- **Dateien:** RenOS reicht dem Spiel seine Dateien aus dem iPad-Speicher – nur die des laufenden Spiels und nur lesend.
- **Spielstände:** RenOS speichert sie **getrennt pro Spiel** (Library → Spiel → „Spielstände“). Nach dem Installieren einer neuen Version: **„Spielstände übernehmen von …“**. Beim Entfernen eines Spiels werden seine Spielstände mit gelöscht. Zusätzlich sichern: ☰-Menü im Spiel → „Export Saves“.
- **Offline:** Installierte Spiele starten ohne Internet.
- **Kein Netzwerk:** Spiele können keine fremden Server kontaktieren (Content-Security-Policy). Ren’Py-Spiele brauchen das normalerweise nicht.

<details>
<summary>Optional: externer Spiele-Host auf einer zweiten Adresse</summary>

Nur nötig, falls ein Spiel im eingebauten Host nicht läuft (z. B. weil es selbst Netzwerkzugriffe braucht). Auf GitHub bekommt man eine zweite Adresse mit einer kostenlosen Organisation:

1. github.com → Profilbild → **Your organizations** → **New organization** → **Free**. Name z. B. `<dein-name>-games`.
2. Dieses Repository öffnen → **Fork** → als Owner die neue Organisation wählen → **Create fork**. (Erst nach Schritt 1 forken: Der Fork übernimmt nur den Standard-Branch.)
3. Im Fork: **Settings → Pages → Source: GitHub Actions**.
4. Im Fork: **Actions** → Workflows aktivieren → „Deploy to GitHub Pages“ → **Run workflow**.
5. Die Adresse lautet dann `https://<dein-name>-games.github.io/Midiplace-community/renos-games/`.
6. In RenOS: **Settings → Spiele → Externer Spiele-Host** eintragen → **Prüfen & verwenden**. Zurück zum eingebauten Host: dort **Verwenden** antippen.

Beim externen Host liegen die Spielstände im Speicher der zweiten Adresse, und alle Spiele teilen sich diesen Origin. Updates: im Fork **Sync fork** antippen. Die Repository-Variable `RENOS_GAME_HOST_URL` füllt das Eingabefeld vor.

</details>

**Speicher:** Eine installierte Web-App darf unter iPadOS bis zu etwa **60 % des Gerätespeichers** nutzen. RenOS legt die Spiele deshalb im eigenen Speicher ab (nicht im Speicher eines eingebetteten Spiele-Origins, der auf 10 % davon begrenzt wäre) und fordert dauerhaften Speicher an, damit iPadOS große Spiele nicht automatisch entfernt. Freien Platz zeigen Installer und **Settings → Spiele**. Gemessen: Ein 3,2-GB-Archiv wird in rund 30–40 Sekunden installiert, ohne dass der Arbeitsspeicher mitwächst (siehe TESTING.md).

**Große Visual Novels:** Ren’Py lädt im Browser die `game.zip` vollständig in den Arbeitsspeicher; Bilder, Musik und Stimmen werden dagegen einzeln nachgeladen („Progressive Downloading“, Standard im Ren’Py-Launcher). Ein 3-GB-Spiel funktioniert also, wenn der Großteil seiner Daten als einzelne Dateien neben der `game.zip` liegt – so baut der Launcher Web-Builds standardmäßig.

### Tests auf GitHub

`.github/workflows/renos-ci.yml` führt bei jedem Push Typecheck, Lint, alle Unit-Tests und die Browser-Tests aus – inklusive eines echten Ren’Py-8.5-Laufzeittests im Server- **und** im lokalen Modus. Ergebnisse: github.com → **Actions** → „RenOS CI“.

---

## Technologie

| Teil | Stack |
| --- | --- |
| Frontend (`apps/web`) | React 19, TypeScript 6, Vite 8, Tailwind CSS 4, Zustand, Dexie (IndexedDB), Motion, Lucide, vite-plugin-pwa (Workbox), fflate |
| Backend (`apps/server`) | Node.js 22 LTS, Fastify 5, TypeScript, `node:sqlite` (keine nativen Abhängigkeiten), yauzl (ZIP), scrypt (Passwort) |
| Gemeinsam (`packages/shared`) | Typisierte API-Verträge, Bridge-Protokoll, Hilfsfunktionen |
| Tests | Vitest (Server und Frontend), Playwright (Browser-E2E inkl. echter Ren’Py-Laufzeit) |

TypeScript ist bewusst auf **6.0** festgelegt: TypeScript 7 (nativer Compiler) wird von typescript-eslint noch nicht unterstützt.

## Voraussetzungen

- **Node.js ≥ 22.13** (wegen `node:sqlite`; getestet mit 22.23). Node 24 funktioniert ebenfalls.
- npm (mitgeliefert)
- Für Playwright-Tests: Chromium über `npx playwright install chromium`
- Für den Betrieb auf dem iPad: ein Server mit **HTTPS** und zwei Hostnamen (App und Spiele)

## Installation

```sh
cd renos
npm install
cp .env.example .env          # optional, siehe „Backend konfigurieren“
```

## Entwicklung starten

```sh
npm run dev
```

Das startet:

| Dienst | Adresse | Zweck |
| --- | --- | --- |
| Vite (Frontend) | http://localhost:5173 | Oberfläche mit Hot Reload, leitet `/api` an den Server weiter |
| App-/API-Server | http://127.0.0.1:8787 | API (und in Produktion auch das gebaute Frontend) |
| Game-Host | http://localhost:8788 | Spielinhalte auf **eigenem Origin** |

Im normalen Browser-Tab erscheint zunächst die Installationsseite. Für die Entwicklung auf dem Desktop: **„Im Browser öffnen (Entwicklung & Demo)“** oder direkt `http://localhost:5173/?mode=desktop`. Bitte `localhost` verwenden (nicht `127.0.0.1`), weil Origin-Prüfung und Einbettungsregeln auf `RENOS_APP_ORIGIN` abgestimmt sind.

**Owner-Passwort in der Entwicklung:** Ist kein `RENOS_OWNER_PASSWORD_HASH` gesetzt, erzeugt der Server bei jedem Start ein zufälliges Einmal-Passwort und schreibt es in die Konsole. Für ein festes Passwort: `npm run hash-password` und den Hash in `.env` eintragen.

## Produktion bauen

```sh
npm run build        # shared → server → web
npm start            # startet App-/API-Server und Game-Host; liefert apps/web/dist aus
```

Weitere Befehle:

| Befehl | Zweck |
| --- | --- |
| `npm run typecheck` | TypeScript für alle Pakete und E2E-Tests |
| `npm run lint` | ESLint |
| `npm test` | Unit- und Integrationstests (Server + Frontend) |
| `npm run test:e2e` | Build + Playwright-Browsertests (Server-Modus) |
| `npm run build:pages` | Statischer Build für den lokalen Modus (`RENOS_BASE` = Pfad, Standard `/renos/`) |
| `npm run test:e2e:local` | Build + Browsertests des lokalen Modus (wie GitHub Pages, ohne Server) |
| `scripts/fetch-renpy.sh <version> <ordner>` | Offizielles Ren’Py-SDK samt Web-Paket laden (nur Dateien, nichts wird ausgeführt) |
| `RENPY_SDKS=<sdk8>,<sdk7> npm run build:pages` | Statischer Build mit Ren’Py-Laufzeitpaketen (für Windows-/Linux-Spiele) |
| `RENPY_SDKS=<sdk8>,<sdk7> npm run testgame:desktop` | Windows/Linux-Testbuilds („The Question“ mit .rpa-Archiven) für die E2E-Tests |
| `npm run hash-password` | scrypt-Hash für das Owner-Passwort erzeugen |
| `npm run assets` | Icons, PWA-Icons und Wallpaper aus `assets/` neu erzeugen |
| `npm run testgame -- <sdk>` | Ren’Py-Testspiel als Web-Build zusammensetzen (siehe TESTING.md) |

## Backend konfigurieren

Alle Einstellungen kommen aus Umgebungsvariablen (oder `.env` im Ordner `renos/`). Vollständige Liste mit Erklärungen: [`.env.example`](.env.example).

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `RENOS_APP_ORIGIN` | `http://localhost:5173` | Origin, unter dem RenOS im Browser läuft |
| `RENOS_GAME_ORIGIN` | `http://localhost:8788` | Origin der Spielinhalte – **muss sich vom App-Origin unterscheiden** |
| `RENOS_PORT` / `RENOS_GAME_PORT` | 8787 / 8788 | Ports von App-/API-Server und Game-Host |
| `RENOS_DATA_DIR` | `./data` | SQLite-Datenbank, Uploads, installierte Spiele, Cover |
| `RENOS_OWNER_PASSWORD_HASH` | – | scrypt-Hash des Owner-Passworts (`npm run hash-password`) |
| `RENOS_PUBLIC_LIBRARY` | `false` | Spieleliste auch ohne Anmeldung lesbar |
| `RENOS_MAX_UPLOAD_MB` / `RENOS_MAX_UNCOMPRESSED_MB` | 16384 / 32768 | Grenzen für Archive (16 GB / 32 GB) |
| `RENOS_MAX_ARCHIVE_ENTRIES` / `RENOS_MAX_COMPRESSION_RATIO` | 100000 / 200 | Schutz vor Zip-Bombs |
| `RENOS_TRUST_PROXY` | `false` | hinter Caddy/nginx auf `true` |

In Produktion verlangt der Server HTTPS-Origins (außer `localhost`) und startet ohne Owner-Passwort mit gesperrter Verwaltung.

## Games-Host konfigurieren

Hochgeladene Spiele enthalten fremdes JavaScript und WebAssembly. RenOS führt sie deshalb **nie** im eigenen Origin aus, sondern liefert sie über einen zweiten Host aus (gleicher Node-Prozess, zweiter Port):

- Produktion: z. B. `https://renos.example.com` (App) und `https://games.renos.example.com` (Spiele)
- Beide Hosts sollten zur **selben registrierbaren Domain** gehören. Dann behandelt Safari den Speicher der Spiele (Spielstände) nicht als Drittanbieter-Speicher.
- Der Game-Host erlaubt die Einbettung nur durch `RENOS_APP_ORIGIN` (`frame-ancestors`), liefert `.wasm` als `application/wasm` aus und unterstützt Range-Requests.

### Bereitstellung mit Docker und Caddy (kostenloses HTTPS)

```sh
cd renos/deploy
cp renos.env.example renos.env      # Domains und Passwort-Hash eintragen
# Domains in Caddyfile anpassen, DNS-Einträge beider Hosts auf den Server zeigen lassen
docker compose up -d --build
```

Caddy holt die Zertifikate automatisch bei Let’s Encrypt. Ohne Docker: `npm run build && npm start` hinter einem beliebigen Reverse Proxy, der beide Hostnamen per HTTPS auf Port 8787 bzw. 8788 weiterleitet (große Request-Bodies erlauben, z. B. nginx `client_max_body_size 2g`).

## Ren’Py-Web-Build importieren (Server-Modus)

Im lokalen Modus siehe oben „Spiele installieren“.

1. Im **Ren’Py-Launcher** das Projekt wählen → **Web (Beta)** → **Build Web Application**.
2. Die erzeugte Datei `<Projekt>-<Version>-web.zip` aufs iPad bringen (z. B. iCloud Drive).
3. In RenOS den **Installer** öffnen, mit dem Owner-Passwort anmelden, **ZIP-Datei auswählen**.
4. Das Prüfergebnis zeigt, ob es ein installierbarer Web-Build ist. **Installieren** → das Spiel erscheint in der **Library**.

Erkannt werden: unterstützter Ren’Py-Web-Build · Ren’Py-Projektquellen · Ren’Py-Build für Windows/Linux/macOS · unbekannte bzw. ungültige Archive. Der **Server-Modus** installiert nur Web-Builds; die Umwandlung von Windows-/Linux-/Mac-Builds und Projekten gibt es im **lokalen Modus** (RenOS auf GitHub Pages).

**Spielstände:** Ren’Py speichert im Browser (IndexedDB des Spiele-Origins). Über das ☰-Menü oben links im Spiel lassen sich Spielstände exportieren und importieren – empfehlenswert als Sicherung.

## PWA auf dem iPad installieren

1. RenOS in **Safari** über HTTPS öffnen – es erscheint die Installationsseite.
2. **Teilen** antippen (in der Adressleiste oder im Menü „…“).
3. **Zum Home-Bildschirm** wählen, **Als Web-App öffnen** eingeschaltet lassen (falls angezeigt), **Hinzufügen**.
4. RenOS über das neue Symbol starten. Beim ersten Start führt ein kurzer Assistent durch das System.

Installierte Web-Apps haben unter iPadOS einen eigenen Speicher – getrennt von Safari. Notizen und Dateien aus einem Safari-Tab erscheinen deshalb nicht automatisch in der installierten App (Datensicherung in Settings → Speicher nutzen).

## Bekannte Einschränkungen

- **Keine Hardwaretests:** RenOS wurde in Chromium (Playwright) getestet, nicht auf einem echten iPad mit Magic Keyboard. Eine Prüfliste für echte Geräte steht in [TESTING.md](TESTING.md).
- **Safari/WebKit:** Die automatisierten Tests laufen in Chromium. Verhalten von Safari (Speicherlimits, Tastaturereignisse, Fullscreen) ist dokumentiert, aber nicht automatisiert verifiziert.
- **Tastenkürzel:** iPadOS/Safari kann einzelne Kombinationen (vor allem mit ⌘) abfangen. RenOS nutzt deshalb überwiegend ⌥ (Wahltaste).
- **Speicher:** iPadOS kann Websitedaten entfernen (z. B. bei Speicherknappheit). RenOS fordert dauerhaften Speicher an und bietet eine Datensicherung; Spielstände sichert man über das Ren’Py-Menü.
- **Lokaler Modus auf echtem iPad ungetestet:** Installation in den Gerätespeicher, eingebauter Spiele-Host (anonymer Origin, Dateiübergabe per MessagePort) und externer Spiele-Host sind in Chromium getestet, nicht in Safari.
- **Spiele-Isolation untereinander:** Im eingebauten Spiele-Host hat jedes Spiel einen eigenen anonymen Origin und eigene Spielstände. Im Server-Modus und beim externen Host teilen sich alle Spiele einen Spiele-Origin – von RenOS isoliert, aber nicht voneinander (Ren’Py trennt Spielstände über `config.save_directory`).
- **Ren’Py-Kompatibilität:** Nicht jeder Web-Build läuft gleich gut in Safari (Speicherbedarf, OGG-Audio, Video). Siehe Ren’Py-Dokumentation „Web / HTML5“.
- **Server-Modus:** Große Spiele werden nicht offline vorgehalten; der Service Worker berührt Spieldateien nie. Im lokalen Modus liegen sie ohnehin auf dem iPad.
- **Browser:** Webseiten, die das Einbetten verbieten, bleiben leer; Downloads von Servern ohne CORS-Freigabe brauchen Safari oder den eigenen Weiterleitungsdienst. Einzelne Downloads und Dateien in Files sind auf 512 MB begrenzt.
- **Datei-Dialoge in Ren’Py 7:** Die Web-Laufzeit von Ren’Py 7 kann nur aus der Hauptschleife des Spiels heraus auf die Dateiauswahl warten (bei Knöpfen im Spiel ist das der Fall).
