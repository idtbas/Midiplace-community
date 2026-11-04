# RenOS

RenOS ist eine Desktop-Umgebung als Progressive Web App für das **iPad mit Magic Keyboard**. Sie fühlt sich an wie ein eigenständiges, ruhiges Linux-Desktop-System – mit Systemleiste, Dock, App-Launcher und echten Fenstern – und ihre wichtigste Aufgabe ist es, **Ren’Py-Webspiele** zu installieren, zu verwalten und auszuführen.

RenOS ersetzt iPadOS nicht. Es läuft als installierte Web-App („Zum Home-Bildschirm“) in einem eigenen Fenster.

| Bereich | Inhalt |
| --- | --- |
| Desktop | Wallpaper, Systemleiste (Uhr, Netzwerk-/Serverstatus, Benachrichtigungen, Schnellaktionen), Dock, Launcher mit Suche, Kontextmenüs, Dialoge, Toasts |
| Window Manager | Verschieben, Größe ändern, Minimieren, Maximieren, Einrasten links/rechts, Fokus und Stapelung, gespeicherte Positionen, Anpassung an Multitasking-Größen |
| Apps | **Files** (virtuelles Dateisystem in IndexedDB), **Library**, **Installer**, **Settings**, **Terminal** (sichere interne Befehle), **Notes**, **Player** |
| Spiele | Upload von Ren’Py-Web-Builds (ZIP), Sicherheitsprüfung, atomare Installation, Auslieferung über einen **getrennten Spiele-Origin**, Player mit immersivem Modus |
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

Der Workflow `.github/workflows/pages.yml` baut bei jedem Push auf `claude/midiplace-prototype` (Standard-Branch) und auf dem RenOS-Branch automatisch:

- `https://<dein-name>.github.io/Midiplace-community/renos/` – RenOS
- `https://<dein-name>.github.io/Midiplace-community/renos-games/` – Spiele-Host (wird nur im Fork genutzt, siehe Schritt 3)

Midiplace bleibt unverändert unter `https://<dein-name>.github.io/Midiplace-community/`. Prüfen: github.com → Repository → **Actions** → „Deploy to GitHub Pages“ muss grün sein.

### 2. Auf dem iPad installieren

1. `https://<dein-name>.github.io/Midiplace-community/renos/` in **Safari** öffnen.
2. **Teilen** → **Zum Home-Bildschirm** → „Als Web-App öffnen“ eingeschaltet lassen → **Hinzufügen**.
3. RenOS über das neue Symbol starten. (Nur so bekommt RenOS den großen Speicher einer installierten Web-App.)

### 3. Spiele-Host einrichten (einmalig, kostenlos)

Spiele enthalten fremdes JavaScript. Damit sie nie mit den Rechten von RenOS laufen, braucht der Spiele-Host eine **zweite Adresse**. Auf GitHub bekommt man die mit einer kostenlosen Organisation:

1. github.com → Profilbild → **Your organizations** → **New organization** → **Free**. Name z. B. `<dein-name>-games`.
2. Dieses Repository öffnen → **Fork** → als Owner die neue Organisation wählen → **Create fork**.
3. Im Fork: **Settings → Pages → Source: GitHub Actions**.
4. Im Fork: **Actions** → Workflows aktivieren → „Deploy to GitHub Pages“ → **Run workflow**.
5. Die Adresse lautet dann `https://<dein-name>-games.github.io/Midiplace-community/renos-games/`.
6. In RenOS: **Settings → Spiele → Spiele-Host** eintragen → **Prüfen & speichern**.

Optional: Im Original-Repository unter **Settings → Secrets and variables → Actions → Variables** die Variable `RENOS_GAME_HOST_URL` mit dieser Adresse anlegen – dann ist sie in neuen Installationen schon vorbelegt. Updates des Spiele-Hosts: im Fork **Sync fork** antippen.

### 4. Spiele installieren

1. Ren’Py-Web-Build (`…-web.zip`) in die **Dateien-App** des iPads legen (z. B. iCloud Drive, Download in Safari).
2. RenOS → **Installer** → **ZIP-Datei auswählen**. Das Archiv wird auf dem iPad geprüft und entpackt – **nichts wird hochgeladen**, es gibt **kein Größenlimit** außer dem freien Speicher.
3. Die Library zeigt das Spiel; **Spielen** startet es isoliert über den Spiele-Host.

**Speicher:** Eine installierte Web-App darf unter iPadOS bis zu etwa **60 % des Gerätespeichers** nutzen. RenOS legt die Spiele deshalb im eigenen Speicher ab (nicht im Speicher des Spiele-iframes, der auf 10 % davon begrenzt wäre) und fordert dauerhaften Speicher an, damit iPadOS große Spiele nicht automatisch entfernt. Freien Platz zeigen Installer und **Settings → Spiele**. Gemessen: Ein 3,2-GB-Archiv wird in rund 30–40 Sekunden installiert, ohne dass der Arbeitsspeicher mitwächst (siehe TESTING.md).

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

Erkannt werden: unterstützter Ren’Py-Web-Build · Ren’Py-Projektquellen (nicht direkt lauffähig) · Ren’Py-Desktop-Build (Windows/Linux/macOS, im Browser nicht lauffähig) · unbekannte bzw. ungültige Archive. Eine automatische Konvertierung von Projektquellen ist **nicht** enthalten.

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
- **Lokaler Modus auf echtem iPad ungetestet:** Installation in den Gerätespeicher, Spiele-Host im fremden iframe (Service Worker, partitionierter Speicher) und Dateiübergabe sind in Chromium getestet, nicht in Safari.
- **Spiele-Isolation untereinander:** Alle Spiele teilen sich einen Spiele-Origin. Sie sind vollständig von RenOS isoliert, aber nicht voneinander (Ren’Py trennt Spielstände über `config.save_directory`).
- **Ren’Py-Kompatibilität:** Nicht jeder Web-Build läuft gleich gut in Safari (Speicherbedarf, OGG-Audio, Video). Siehe Ren’Py-Dokumentation „Web / HTML5“.
- **Große Spiele** werden nicht offline vorgehalten; der Service Worker berührt Spieldateien nie.
