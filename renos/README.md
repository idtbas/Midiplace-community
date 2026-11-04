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
| `npm run test:e2e` | Build + Playwright-Browsertests |
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
| `RENOS_MAX_UPLOAD_MB` / `RENOS_MAX_UNCOMPRESSED_MB` | 2048 / 4096 | Grenzen für Archive |
| `RENOS_MAX_ARCHIVE_ENTRIES` / `RENOS_MAX_COMPRESSION_RATIO` | 20000 / 200 | Schutz vor Zip-Bombs |
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

## Ren’Py-Web-Build importieren

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
- **Spiele-Isolation untereinander:** Alle Spiele teilen sich einen Spiele-Origin. Sie sind vollständig von RenOS isoliert, aber nicht voneinander (Ren’Py trennt Spielstände über `config.save_directory`).
- **Ren’Py-Kompatibilität:** Nicht jeder Web-Build läuft gleich gut in Safari (Speicherbedarf, OGG-Audio, Video). Siehe Ren’Py-Dokumentation „Web / HTML5“.
- **Große Spiele** werden nicht offline vorgehalten; der Service Worker berührt Spieldateien nie.
