/* Midiplace — Standard MIDI File reader/writer and musical analysis. */
(function () {
  'use strict';
  const MP = window.MP;

  function fail(message) {
    const e = new Error(message);
    e.name = 'MidiError';
    return e;
  }

  /* ---------- Reader ---------- */
  function parse(input) {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    let pos = 0;

    // RIFF-wrapped files (.rmi) carry a normal SMF inside a "data" chunk.
    const tag = (at) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
    if (data.length > 12 && tag(0) === 'RIFF') {
      for (let i = 12; i < data.length - 4; i++) if (tag(i) === 'MThd') { pos = i; break; }
    }
    if (data.length < 14 || tag(pos) !== 'MThd') {
      throw fail("This isn't a Standard MIDI File. Midiplace reads .mid and .midi files.");
    }
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
    const programs = {};
    let name = '', timeSig = null, tracksRead = 0;

    while (pos + 8 <= data.length) {
      const id = tag(pos);
      const len = u32(pos + 4);
      pos += 8;
      const end = Math.min(pos + len, data.length);
      if (id !== 'MTrk') { pos = end; continue; }

      let tick = 0, status = 0;
      const open = new Map();
      const vlq = () => {
        let v = 0, b = 0, n = 0;
        do { b = pos < end ? data[pos++] : 0; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && ++n < 4);
        return v;
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
          else if (type === 0x03 && !name && mlen > 0) {
            try { name = new TextDecoder().decode(data.subarray(at, at + mlen)).replace(/\0/g, '').trim(); } catch (e) { /* keep empty */ }
          } else if (type === 0x58 && !timeSig && mlen >= 2) timeSig = [data[at], Math.pow(2, data[at + 1])];
          else if (type === 0x2f) break;
        } else if (s === 0xf0 || s === 0xf7) {
          pos += vlq();
        } else {
          const kind = s & 0xf0, ch = s & 0x0f;
          const d1 = data[pos++] & 0x7f;
          const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : data[pos++] & 0x7f;
          if (kind === 0x90 && d2 > 0) {
            const k = ch * 128 + d1;
            let stack = open.get(k);
            if (!stack) open.set(k, (stack = []));
            stack.push({ tick, vel: d2 });
          } else if (kind === 0x80 || kind === 0x90) {
            const stack = open.get(ch * 128 + d1);
            if (stack && stack.length) {
              const on = stack.shift();
              raw.push({ a: on.tick, b: tick, p: d1, v: on.vel, ch });
            }
          } else if (kind === 0xc0 && programs[ch] == null) programs[ch] = d1;
        }
      }
      for (const [k, stack] of open) for (const on of stack) raw.push({ a: on.tick, b: Math.max(tick, on.tick + ppq / 4), p: k % 128, v: on.vel, ch: k >> 7 });
      pos = end;
      tracksRead++;
    }

    if (!raw.length) throw fail("This file doesn't contain any notes.");

    // Tempo map: convert ticks to seconds, honoring every tempo change.
    tempos.sort((x, y) => x.tick - y.tick);
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, uspq: 500000 });
    const segs = [];
    let sec = 0;
    for (let i = 0; i < tempos.length; i++) {
      if (i > 0) sec += ((tempos[i].tick - tempos[i - 1].tick) * tempos[i - 1].uspq) / 1e6 / ppq;
      segs.push({ tick: tempos[i].tick, sec, uspq: tempos[i].uspq });
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

    const notes = raw
      .map((n) => {
        const t = toSec(n.a);
        return { t, d: Math.max(0.03, toSec(n.b) - t), p: n.p, v: n.v / 127, ch: n.ch };
      })
      .sort((x, y) => x.t - y.t || x.p - y.p);

    // Drop leading silence so every pin starts on its first note.
    const lead = notes[0].t;
    if (lead > 0.05) for (const n of notes) n.t -= lead;

    const firstTick = raw.reduce((m, n) => Math.min(m, n.a), Infinity);
    let uspq = segs[0].uspq;
    for (const sg of segs) if (sg.tick <= firstTick) uspq = sg.uspq;

    return {
      notes: notes.length > 24000 ? notes.slice(0, 24000) : notes,
      truncated: notes.length > 24000,
      bpm: ticksPerSecond ? 120 : Math.round(60e6 / uspq),
      timeSig: timeSig && timeSig[0] > 0 && timeSig[0] < 33 ? timeSig : [4, 4],
      name,
      programs,
      format,
      tracks: tracksRead || trackCount,
      duration: notes.reduce((m, n) => Math.max(m, n.t + n.d), 0),
    };
  }

  /* ---------- Writer (format 1, one track per channel) ---------- */
  function write(song) {
    const bpm = song.bpm || 120, ppq = 480, tps = (ppq * bpm) / 60;
    const ts = song.timeSig || [4, 4];
    const out = [];
    const push = (arr) => { for (let i = 0; i < arr.length; i++) out.push(arr[i]); };
    const vlq = (n) => {
      const bytes = [n & 0x7f];
      while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
      return bytes;
    };
    const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
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

    const chans = Array.from(new Set(song.notes.map((n) => n.ch))).sort((a, b) => a - b);
    push([0x4d, 0x54, 0x68, 0x64]);
    push(u32(6));
    push([0, 1, ((chans.length + 1) >> 8) & 255, (chans.length + 1) & 255, ppq >> 8, ppq & 255]);

    const name = Array.from(new TextEncoder().encode(song.name || 'Midiplace'));
    const uspq = Math.round(60e6 / bpm);
    track([
      { tick: 0, order: 0, data: [0xff, 0x03].concat(vlq(name.length), name) },
      { tick: 0, order: 1, data: [0xff, 0x51, 0x03, (uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255] },
      { tick: 0, order: 2, data: [0xff, 0x58, 0x04, ts[0], Math.round(Math.log2(ts[1])), 24, 8] },
    ]);
    for (const ch of chans) {
      const ev = [];
      if (ch !== 9) ev.push({ tick: 0, order: 0, data: [0xc0 | ch, (song.programs && song.programs[ch]) & 127 || 0] });
      for (const n of song.notes) {
        if (n.ch !== ch) continue;
        const on = Math.round(n.t * tps);
        const off = Math.max(on + 1, Math.round((n.t + n.d) * tps));
        const vel = MP.clamp(Math.round(n.v * 127), 1, 127);
        ev.push({ tick: on, order: 2, data: [0x90 | ch, n.p & 127, vel] });
        ev.push({ tick: off, order: 1, data: [0x80 | ch, n.p & 127, 0] });
      }
      track(ev);
    }
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

  const FAMILY = [
    [8, 'keys'], [16, 'bell'], [24, 'pad'], [32, 'pluck'], [40, 'bass'], [56, 'strings'],
    [64, 'lead'], [80, 'lead'], [88, 'chip'], [104, 'pad'], [120, 'pluck'], [128, 'pad'],
  ];
  function familyForProgram(p) {
    for (const [limit, fam] of FAMILY) if (p < limit) return fam;
    return 'keys';
  }
  const PROGRAM_FOR = { keys: 4, pad: 89, bell: 10, pluck: 46, pizz: 45, chip: 80, chipbass: 38, bass: 33, strings: 48, lead: 73 };

  MP.midi = { parse, write, detectKey, chroma, familyForProgram, PROGRAM_FOR };
})();
