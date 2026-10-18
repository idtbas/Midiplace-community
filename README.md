# Midiplace

A public catalogue for MIDI files. It works like a pinboard, but every entry is a `.mid` file, and each entry's artwork is drawn from the notes inside it. Files can be anything from a one-bar sketch to a full arrangement with dozens of tracks.

## The idea

Midiplace treats MIDI the way a record label treats releases:

- **Every file gets a catalogue number** (MP-0042), a sleeve and liner notes.
- **The sleeve is drawn from the notes.** Each pitch has a color that follows the circle of fifths, starting from a red C, so notes that sound good together sit next to each other on the color wheel. The key tints the paper. There are four drawings: Roll, Orbit (time runs clockwise like a record), Fall (notes fall onto a keyboard) and Steps (a sequencer grid).
- **The liner notes are read from the file:** parts and their General MIDI instruments, the tempo map, meter changes, sustain pedal, markers and key.

The interface stays warm and monochrome, so every hue on screen comes from the music. Dark is the house look, and a light look is one click away.

## Built for complex songs

| What the file has | What Midiplace does with it |
| --- | --- |
| Type 0 or type 1, any number of tracks | Splits it into parts by track, channel and instrument, and names them from track names or General MIDI programs |
| Tempo changes | Converts every tick through the full tempo map, so timing stays exact |
| Meter changes | Builds the bar grid from the meter map, so bar numbers stay right after a change to 3/4 |
| Program changes mid-song | Treats each instrument on a channel as its own part |
| Sustain pedal (CC64) | Holds notes until the pedal lifts, including re-struck keys |
| Channel volume and expression (CC7, CC11) | Scales note velocities |
| Markers | Shows them as section names along the score |

Limits: files up to 8 MB, and the first 80,000 notes. A 40,000-note, 17-part, five-minute test file parses in about 80 ms.

In the close-up ("the sleeve") you get a scrolling score with a bar ruler and section markers, an overview you can drag, a bar and beat counter, and a mixer with mute, solo and activity lights for every part. Playback normalises its level to the density of the arrangement, so a dense file doesn't distort.

## What you can do

- Browse the catalogue as a masonry board, filter by category (including **Arrangements**), by key on the circle of fifths, or sort by trending, newest or longest.
- Search with <kbd>⌘K</kbd> or <kbd>/</kbd>: titles, creators, keys like `E minor`, tempos like `120 bpm`.
- Hover a sleeve to scrub through it, press play to hear it, open it for the full close-up. Space plays and pauses, ← and → move between entries, Esc closes.
- Save entries, follow creators, and turn on **Listen on hover**.
- Publish: drop a `.mid` file anywhere on the page, or try a generated arrangement. Midiplace shows what it read from the file before you publish.

## Run it

There is no build step and there are no dependencies. Open `index.html`, or serve the folder:

```sh
npx serve .
```

Pushes to the default branch deploy to GitHub Pages through `.github/workflows/pages.yml` once Pages is set to **GitHub Actions** in the repository settings.

## How it's built

Plain HTML, CSS and JavaScript.

| File | What it does |
| --- | --- |
| `js/core.js` | OKLCH color math, pitch colors, spring physics sampled into CSS `linear()` easings, storage and DOM helpers |
| `js/midi.js` | Standard MIDI File reader and writer: parts, tempo and meter maps, pedal, controllers, markers, key detection |
| `js/compose.js` | A seeded composer for the starter catalogue, including full arrangements with sections and a ritardando |
| `js/audio.js` | Web Audio synth (twelve voices and a synthesized drum kit), a lookahead player, per-part mute and solo |
| `js/art.js` | The four drawings, the scrolling score, playback overlays, part activity and the density timeline |
| `js/app.js` | Catalogue, masonry, sleeve, mixer, search palette, publisher, drop zone, now-playing bar and the motion system |
| `css/midiplace.css` | Design tokens for both looks and every component |

Published files are stored in IndexedDB in your browser, so even large arrangements survive a reload. Everything respects `prefers-reduced-motion`.

## Prototype limits

- There is no server. Files you publish stay in this browser and are only visible to you.
- Playback uses a built-in synth rather than sampled instruments, so files sound like sketches of themselves.
