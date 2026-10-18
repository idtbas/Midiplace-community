# Midiplace

A pinboard for MIDI files. It works like Pinterest, but every pin is a `.mid` file, and each pin's picture is drawn from the notes inside it.

## The idea

A MIDI file has no cover art, so Midiplace makes one from the music:

- **Every pitch has a color.** Hues run around the circle of fifths, starting from a red C. Notes that sound good together sit next to each other on the color wheel, so a consonant file comes out in a harmonious palette.
- **The key sets the paper.** A pin's background is tinted by its tonic, so a board of pins in related keys looks related.
- **Four ways to draw a file**, chosen when you publish:
  - **Roll**: a classic piano roll, with a drum lane underneath when the file has drums.
  - **Orbit**: time runs clockwise like a record, pitch is the radius. The key and tempo sit on the label.
  - **Fall**: notes fall onto a small keyboard, and the keys light up as they play.
  - **Steps**: a step-sequencer grid, made for drum patterns.

Hover a pin to scrub through it: the playhead follows your pointer and the notes under it light up. Press play to hear it.

## What you can do

- Browse a masonry board of 42 starter pins, all playable and downloadable as real `.mid` files.
- Filter by category, by search (title, creator, key such as `A minor`, or tempo such as `120 bpm`), or by key on the circle-of-fifths wheel in the header.
- Open a pin for a close-up: a large animated artwork, a seekable density timeline, a pitch-class chart, sound presets, related pins, and keyboard control (Space to play, ← → to move between pins, Esc to close).
- Save pins, follow creators, and turn on **Listen on hover** to hear pins as you pass over them.
- Publish your own: drop a `.mid` file anywhere on the page, or use **Try a generated sample**. Midiplace reads the file, detects key, tempo and meter, and shows a live preview of the pin before you publish.

## Run it

There is no build step and there are no dependencies. Open `index.html` in a browser, or serve the folder:

```sh
npx serve .
```

## How it's built

Plain HTML, CSS and JavaScript, with no frameworks.

| File | What it does |
| --- | --- |
| `js/core.js` | OKLCH color math, pitch-to-color mapping, spring physics sampled into CSS `linear()` easings, storage and DOM helpers |
| `js/midi.js` | Standard MIDI File reader (format 0/1, running status, tempo maps, SMPTE timing), writer, and Krumhansl–Kessler key detection |
| `js/compose.js` | A small seeded composer that writes the starter pins: ballads, lo-fi, jazz ii–V–I, chiptune, General MIDI drum grooves and more |
| `js/audio.js` | Web Audio synth (electric piano, pad, pluck, bell, chip, bass, strings, lead, a synthesized drum kit, generated reverb) and a lookahead player |
| `js/art.js` | The four artwork styles, the playback and scrub overlays, and the density timeline |
| `js/app.js` | The board, masonry layout, close-up, publisher, drop zone, now-playing bar and routing |
| `css/midiplace.css` | Design tokens for light and dark, glass materials, and every component |

Motion uses real spring curves: `core.js` solves a damped spring and samples it into a CSS `linear()` easing, so transitions and Web Animations share the same physics. Everything respects `prefers-reduced-motion`.

## Prototype limits

- There is no server. Pins you publish are stored in your browser's local storage, so only you see them, and only on this device.
- Files up to 2 MB are accepted. Very long files are capped at 24,000 notes.
- Playback uses a built-in synth, not General MIDI samples, so files sound like sketches of themselves.
