/* Midiplace — Standard MIDI File reader/writer and musical analysis.
   Built for real arrangements: any number of tracks, tempo maps, meter changes,
   program changes, sustain pedal and channel volume. */
(function () {
  'use strict';
  const MP = window.MP;

  const GM = [
    'Acoustic Grand Piano', 'Bright Piano', 'Electric Grand', 'Honky-tonk Piano', 'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
    'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
    'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
    'Nylon Guitar', 'Steel Guitar', 'Jazz Guitar', 'Clean Guitar', 'Muted Guitar', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
    'Acoustic Bass', 'Finger Bass', 'Pick Bass', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
    'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
    'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
    'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
    'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
    'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
    'Square Lead', 'Saw Lead', 'Calliope Lead', 'Chiff Lead', 'Charang Lead', 'Voice Lead', 'Fifths Lead', 'Bass and Lead',
    'New Age Pad', 'Warm Pad', 'Polysynth Pad', 'Choir Pad', 'Bowed Pad', 'Metallic Pad', 'Halo Pad', 'Sweep Pad',
    'Rain', 'Soundtrack', 'Crystal', 'Atmosphere', 'Brightness', 'Goblins', 'Echoes', 'Sci-fi',
    'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
    'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
    'Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone', 'Helicopter', 'Applause', 'Gunshot',
  ];

  /* The synth voice that best stands in for a General MIDI program. */
  function familyForProgram(p) {
    if (p === 45) return 'pizz';
    if (p === 46 || p === 6 || p === 7) return 'pluck';
    if (p === 47) return 'bass';
    if (p >= 52 && p <= 54) return 'pad';
    if (p === 80) return 'chip';
    if (p < 8) return 'keys';
    if (p < 16) return 'bell';
    if (p < 24) return 'organ';
    if (p < 32) return 'pluck';
    if (p < 40) return 'bass';
    if (p < 56) return 'strings';
    if (p < 64) return 'brass';
    if (p < 88) return 'lead';
    if (p < 104) return 'pad';
    if (p < 112) return 'pluck';
    if (p < 120) return 'bell';
    return 'pad';
  }
  const PROGRAM_FOR = { keys: 4, pad: 89, bell: 10, pluck: 46, pizz: 45, chip: 80, chipbass: 38, bass: 33, strings: 48, lead: 73, organ: 16, brass: 61 };

  function fail(message) {
    const e = new Error(message);
    e.name = 'MidiError';
    return e;
  }

  const MAX_NOTES = 80000;

  /* ---------- Reader ---------- */
  function parse(input) {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    let pos = 0;
    const tag = (at) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
    if (data.length > 12 && tag(0) === 'RIFF') {
      for (let i = 12; i < data.length - 4; i++) if (tag(i) === 'MThd') { pos = i; break; }
    }
    if (data.length < 14 || tag(pos) !== 'MThd') throw fail("This isn't a Standard MIDI File. Midiplace reads .mid and .midi files.");
    const u32 = (at) => ((data[at] << 24) >>> 0) + (data[at + 1] << 16) + (data[at + 2] << 8) + data[at + 3];
    const u16 = (at) => (data[at] << 8) | data[at + 1];

    const headerLen = u32(pos + 4);
    const format = u16(pos + 8);
    const trackCount = u16(pos + 10);
    const division = u16(pos + 12);
    pos += 8 + headerLen;

    let ppq = 480, ticksPerSecond = 0;
    if (division & 0x8000) {
      const fps = 256 - (division >> 8);
      ticksPerSecond = (fps === 29 ? 29.97 : fps) * (division & 0xff);
    } else ppq = division || 480;

    const raw = [];
    const tempos = [];
    const sigs = [];
    const markers = [];
    const firstProgram = {};
    const trackNames = [];
    const trackHasNotes = [];
    let pedalEvents = 0, programChanges = 0, tracksRead = 0, maxTick = 0;
    const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
    const text = (a, b) => {
      try { return decoder ? decoder.decode(data.subarray(a, b)).replace(/\0/g, '').trim() : ''; } catch (e) { return ''; }
    };

    while (pos + 8 <= data.length) {
      const id = tag(pos);
      const len = u32(pos + 4);
      pos += 8;
      const end = Math.min(pos + len, data.length);
      if (id !== 'MTrk') { pos = end; continue; }

      const tr = tracksRead;
      let tick = 0, status = 0, name = '', instrument = '';
      const open = new Map();
      const program = {}, volume = {}, expression = {}, pedal = {}, held = {};
      const vlq = () => {
        let v = 0, b = 0, n = 0;
        do { b = pos < end ? data[pos++] : 0; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && ++n < 4);
        return v;
      };
      const releaseHeld = (ch, at) => {
        if (!held[ch]) return;
        for (const n of held[ch]) n.b = Math.max(n.a + 1, at);
        held[ch] = [];
      };

      while (pos < end) {
        tick += vlq();
        if (pos >= end) break;
        let s = data[pos];
        if (s & 0x80) {
          pos++;
          if (s < 0xf0) status = s;
        } else {
          if (!status) throw fail('The file has a damaged track and could not be read.');
          s = status;
        }

        if (s === 0xff) {
          const type = data[pos++];
          const mlen = vlq();
          const at = pos;
          pos += mlen;
          if (type === 0x51 && mlen === 3) tempos.push({ tick, uspq: (data[at] << 16) | (data[at + 1] << 8) | data[at + 2] });
          else if (type === 0x03 && !name && mlen > 0) name = text(at, at + mlen);
          else if (type === 0x04 && !instrument && mlen > 0) instrument = text(at, at + mlen);
          else if (type === 0x58 && mlen >= 2) sigs.push({ tick, num: data[at], den: Math.pow(2, data[at + 1]) });
          else if (type === 0x06 && mlen > 0 && markers.length < 200) markers.push({ tick, text: text(at, at + mlen) });
          else if (type === 0x2f) break;
        } else if (s === 0xf0 || s === 0xf7) {
          pos += vlq();
        } else {
          const kind = s & 0xf0, ch = s & 0x0f;
          const d1 = data[pos++] & 0x7f;
          const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : data[pos++] & 0x7f;
          if (kind === 0x90 && d2 > 0) {
            // Re-striking a key that the pedal is still holding ends the held note.
            if (held[ch] && held[ch].length) {
              for (let i = held[ch].length - 1; i >= 0; i--) if (held[ch][i].p === d1) { held[ch][i].b = Math.max(held[ch][i].a + 1, tick); held[ch].splice(i, 1); }
            }
            const k = ch * 128 + d1;
            let stack = open.get(k);
            if (!stack) open.set(k, (stack = []));
            const gain = ((volume[ch] == null ? 100 : volume[ch]) / 100) * ((expression[ch] == null ? 127 : expression[ch]) / 127);
            stack.push({ tick, vel: MP.clamp((d2 / 127) * gain, 0.02, 1), prog: program[ch] });
          } else if (kind === 0x80 || kind === 0x90) {
            const stack = open.get(ch * 128 + d1);
            if (stack && stack.length) {
              const on = stack.shift();
              const note = { a: on.tick, b: tick, p: d1, v: on.vel, ch, tr, prog: on.prog };
              if (pedal[ch] && ch !== 9) {
                note.b = null;
                (held[ch] || (held[ch] = [])).push(note);
              }
              raw.push(note);
              trackHasNotes[tr] = true;
            }
          } else if (kind === 0xb0) {
            if (d1 === 64) {
              pedalEvents++;
              const down = d2 >= 64;
              if (!down) releaseHeld(ch, tick);
              pedal[ch] = down;
            } else if (d1 === 7) volume[ch] = d2;
            else if (d1 === 11) expression[ch] = d2;
            else if (d1 === 121) {
              expression[ch] = 127;
              releaseHeld(ch, tick);
              pedal[ch] = false;
            } else if (d1 === 123 || d1 === 120) releaseHeld(ch, tick);
          } else if (kind === 0xc0) {
            program[ch] = d1;
            programChanges++;
            if (firstProgram[ch] == null) firstProgram[ch] = d1;
          }
        }
      }
      for (const [k, stack] of open) {
        for (const on of stack) {
          raw.push({ a: on.tick, b: Math.max(tick, on.tick + ppq / 4), p: k % 128, v: on.vel, ch: k >> 7, tr, prog: on.prog });
          trackHasNotes[tr] = true;
        }
      }
      for (const ch in held) releaseHeld(+ch, tick);
      trackNames[tr] = name || instrument;
      maxTick = Math.max(maxTick, tick);
      pos = end;
      tracksRead++;
    }

    if (!raw.length) throw fail("This file doesn't contain any notes.");

    /* Tempo map: ticks to seconds across every tempo change. */
    tempos.sort((x, y) => x.tick - y.tick);
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, uspq: 500000 });
    const segs = [];
    let sec = 0;
    for (let i = 0; i < tempos.length; i++) {
      if (i > 0) sec += ((tempos[i].tick - tempos[i - 1].tick) * tempos[i - 1].uspq) / 1e6 / ppq;
      if (segs.length && segs[segs.length - 1].tick === tempos[i].tick) segs[segs.length - 1].uspq = tempos[i].uspq;
      else segs.push({ tick: tempos[i].tick, sec, uspq: tempos[i].uspq });
    }
    const toSec = ticksPerSecond
      ? (tk) => tk / ticksPerSecond
      : (tk) => {
          let lo = 0, hi = segs.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (segs[mid].tick <= tk) lo = mid; else hi = mid - 1;
          }
          const sg = segs[lo];
          return sg.sec + ((tk - sg.tick) * sg.uspq) / 1e6 / ppq;
        };

    /* Parts: one per track, channel and instrument, which is how a listener hears an arrangement. */
    const partIndex = new Map();
    const parts = [];
    let notes = raw.map((n) => {
      const prog = n.ch === 9 ? -1 : n.prog != null ? n.prog : firstProgram[n.ch] || 0;
      const key = n.tr + '|' + n.ch + '|' + prog;
      let pi = partIndex.get(key);
      if (pi == null) {
        pi = parts.length;
        partIndex.set(key, pi);
        const useTrackName = trackNames[n.tr] && (format !== 1 || n.tr > 0 || tracksRead === 1);
        parts.push({ tr: n.tr, ch: n.ch, program: prog, gm: n.ch === 9 ? 'Drum Kit' : GM[prog], name: useTrackName ? trackNames[n.tr] : n.ch === 9 ? 'Drums' : GM[prog], inst: n.ch === 9 ? 'drums' : familyForProgram(prog), count: 0 });
      }
      const t = toSec(n.a);
      return { t, d: Math.max(0.03, toSec(n.b) - t), p: n.p, v: n.v, ch: n.ch, part: pi };
    });
    notes.sort((x, y) => x.t - y.t || x.p - y.p);
    const truncated = notes.length > MAX_NOTES;
    if (truncated) notes = notes.slice(0, MAX_NOTES);

    // Parts in score order, with duplicate names told apart by their instrument.
    const order = parts.map((p, i) => i).sort((a, b) => parts[a].tr - parts[b].tr || (parts[a].ch === 9) - (parts[b].ch === 9) || parts[a].ch - parts[b].ch || parts[a].program - parts[b].program);
    const remap = new Array(parts.length);
    const sorted = order.map((old, i) => { remap[old] = i; return parts[old]; });
    for (const n of notes) { n.part = remap[n.part]; sorted[n.part].count++; }
    const seen = {};
    for (const p of sorted) seen[p.name] = (seen[p.name] || 0) + 1;
    for (const p of sorted) if (seen[p.name] > 1 && p.name !== p.gm) p.name = p.name + ' · ' + p.gm;
    const finalParts = sorted.filter((p) => p.count > 0);
    if (finalParts.length !== sorted.length) {
      const keep = sorted.map((p) => p.count > 0);
      const shift = [];
      let k = 0;
      for (let i = 0; i < sorted.length; i++) { shift[i] = k; if (keep[i]) k++; }
      for (const n of notes) n.part = shift[n.part];
    }

    // Drop leading silence so every pin starts on its first note.
    const lead = notes[0].t;
    if (lead > 0.05) for (const n of notes) n.t -= lead;
    const shiftT = lead > 0.05 ? lead : 0;
    const duration = notes.reduce((m, n) => Math.max(m, n.t + n.d), 0);

    /* Bars from the meter map, so the grid stays right through tempo and meter changes. */
    sigs.sort((x, y) => x.tick - y.tick);
    const meter = sigs.filter((s) => s.num > 0 && s.num < 33 && s.den > 0 && s.den <= 32);
    if (!meter.length || meter[0].tick > 0) meter.unshift({ tick: 0, num: 4, den: 4 });
    const bars = [];
    if (ticksPerSecond) {
      for (let t = 0; t <= duration + 2 && bars.length < 4000; t += 2) bars.push({ t: t - shiftT, num: 4 });
    } else {
      let tk = 0, mi = 0;
      while (bars.length < 4000) {
        while (mi + 1 < meter.length && meter[mi + 1].tick <= tk) mi++;
        const t = toSec(tk) - shiftT;
        if (t > duration + 0.01) break;
        bars.push({ t, num: meter[mi].num });
        tk += (ppq * 4 * meter[mi].num) / meter[mi].den;
      }
    }

    const tempoMap = [];
    if (!ticksPerSecond) {
      for (const sg of segs) {
        const t = Math.max(0, sg.sec - shiftT);
        if (t > duration) break;
        const bpm = Math.round((60e6 / sg.uspq) * 10) / 10;
        if (tempoMap.length && Math.abs(tempoMap[tempoMap.length - 1].bpm - bpm) < 0.05) continue;
        if (tempoMap.length && tempoMap[tempoMap.length - 1].t === t) tempoMap[tempoMap.length - 1].bpm = bpm;
        else tempoMap.push({ t, bpm });
      }
    }
    if (!tempoMap.length) tempoMap.push({ t: 0, bpm: 120 });

    const markerList = markers
      .filter((m) => m.text)
      .map((m) => ({ t: toSec(m.tick) - shiftT, text: m.text.slice(0, 32) }))
      .filter((m) => m.t > -0.01 && m.t < duration)
      .sort((a, b) => a.t - b.t);

    return {
      notes,
      parts: finalParts,
      markers: markerList,
      truncated,
      bpm: Math.round(tempoMap[0].bpm),
      tempos: tempoMap,
      bars,
      timeSig: [meter[0].num, meter[0].den],
      meterChanges: meter.length - 1,
      name: format === 1 || tracksRead === 1 ? trackNames[0] || '' : '',
      programs: firstProgram,
      programChanges,
      pedal: pedalEvents,
      format,
      tracks: tracksRead || trackCount,
      ppq,
      duration,
    };
  }

  /* ---------- Writer (format 1, one track per part) ---------- */
  function write(song) {
    const ppq = 480;
    const tempos = song.tempos && song.tempos.length ? song.tempos : [{ t: 0, bpm: song.bpm || 120 }];
    const ts = song.timeSig || [4, 4];
    const secToTick = (t) => {
      let tick = 0;
      for (let i = 0; i < tempos.length; i++) {
        const a = tempos[i].t, b = i + 1 < tempos.length ? tempos[i + 1].t : Infinity;
        if (t <= a) break;
        tick += (Math.min(t, b) - a) * (tempos[i].bpm / 60) * ppq;
      }
      return Math.round(tick);
    };
    const out = [];
    const push = (arr) => { for (let i = 0; i < arr.length; i++) out.push(arr[i]); };
    const vlq = (n) => {
      const bytes = [n & 0x7f];
      while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
      return bytes;
    };
    const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const textEvent = (type, s) => {
      const b = Array.from(new TextEncoder().encode(s || ''));
      return [0xff, type].concat(vlq(b.length), b);
    };
    const track = (events) => {
      events.sort((x, y) => x.tick - y.tick || x.order - y.order);
      const body = [];
      let last = 0;
      for (const e of events) {
        const d = vlq(e.tick - last);
        for (let i = 0; i < d.length; i++) body.push(d[i]);
        for (let i = 0; i < e.data.length; i++) body.push(e.data[i]);
        last = e.tick;
      }
      body.push(0, 0xff, 0x2f, 0);
      push([0x4d, 0x54, 0x72, 0x6b]);
      push(u32(body.length));
      push(body);
    };

    const parts = song.parts && song.parts.length ? song.parts : Array.from(new Set(song.notes.map((n) => n.ch))).map((ch) => ({ ch, name: ch === 9 ? 'Drums' : '', program: (song.programs && song.programs[ch]) || 0 }));
    const partOf = (n) => (song.parts && song.parts.length ? n.part : parts.findIndex((p) => p.ch === n.ch));
    push([0x4d, 0x54, 0x68, 0x64]);
    push(u32(6));
    push([0, 1, ((parts.length + 1) >> 8) & 255, (parts.length + 1) & 255, ppq >> 8, ppq & 255]);

    const conductor = [{ tick: 0, order: 0, data: textEvent(0x03, song.name || 'Midiplace') }, { tick: 0, order: 2, data: [0xff, 0x58, 0x04, ts[0], Math.round(Math.log2(ts[1])), 24, 8] }];
    for (const m of song.markers || []) conductor.push({ tick: secToTick(Math.max(0, m.t)), order: 3, data: textEvent(0x06, m.text) });
    for (const tp of tempos) {
      const uspq = Math.round(60e6 / tp.bpm);
      conductor.push({ tick: secToTick(tp.t), order: 1, data: [0xff, 0x51, 0x03, (uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255] });
    }
    track(conductor);
    parts.forEach((part, pi) => {
      const ch = part.ch & 15;
      const ev = [{ tick: 0, order: 0, data: textEvent(0x03, part.name || '') }];
      if (ch !== 9) ev.push({ tick: 0, order: 1, data: [0xc0 | ch, Math.max(0, part.program || 0) & 127] });
      for (const n of song.notes) {
        if (partOf(n) !== pi) continue;
        const on = secToTick(n.t);
        const off = Math.max(on + 1, secToTick(n.t + n.d));
        const vel = MP.clamp(Math.round(n.v * 127), 1, 127);
        ev.push({ tick: on, order: 3, data: [0x90 | ch, n.p & 127, vel] });
        ev.push({ tick: off, order: 2, data: [0x80 | ch, n.p & 127, 0] });
      }
      track(ev);
    });
    return new Uint8Array(out);
  }

  /* ---------- Analysis ---------- */
  const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function pearson(x, y) {
    const n = x.length;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      num += (x[i] - mx) * (y[i] - my);
      dx += (x[i] - mx) ** 2;
      dy += (y[i] - my) ** 2;
    }
    return dx && dy ? num / Math.sqrt(dx * dy) : 0;
  }
  function chroma(notes) {
    const hist = new Array(12).fill(0);
    for (const n of notes) if (n.ch !== 9) hist[n.p % 12] += Math.min(n.d, 4) * (0.4 + n.v);
    return hist;
  }
  /* Krumhansl–Kessler key finding over a duration-weighted pitch-class histogram. */
  function detectKey(notes) {
    const hist = chroma(notes);
    if (!hist.some((v) => v > 0)) return { tonic: 0, mode: 'major', confidence: 0, none: true };
    let best = { tonic: 0, mode: 'major', confidence: -2 };
    for (let tonic = 0; tonic < 12; tonic++) {
      const rotated = hist.map((_, i) => hist[(i + tonic) % 12]);
      const maj = pearson(rotated, KK_MAJOR), min = pearson(rotated, KK_MINOR);
      if (maj > best.confidence) best = { tonic, mode: 'major', confidence: maj };
      if (min > best.confidence) best = { tonic, mode: 'minor', confidence: min };
    }
    return best;
  }

  MP.midi = { parse, write, detectKey, chroma, familyForProgram, PROGRAM_FOR, GM, MAX_NOTES };
})();
