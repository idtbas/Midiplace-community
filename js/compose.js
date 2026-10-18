/* Midiplace — a small, seeded composer that writes the community board's starter pins. */
(function () {
  'use strict';
  const MP = window.MP;

  const MAJ = [0, 2, 4, 5, 7, 9, 11];
  const MIN = [0, 2, 3, 5, 7, 8, 10];
  const PENT_MAJ = [0, 2, 4, 7, 9];
  const PENT_MIN = [0, 3, 5, 7, 10];
  const DR = { kick: 36, rim: 37, snare: 38, clap: 39, hat: 42, pedal: 44, open: 46, tomLo: 45, tomMid: 47, tomHi: 50, crash: 49, ride: 51 };

  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const between = (r, a, b) => a + Math.floor(r() * (b - a + 1));
  const scaleOf = (mode) => (mode === 'minor' ? MIN : MAJ);
  const rootIn = (pc, lo) => lo + MP.pc(pc - lo);

  class Song {
    constructor(bpm, o) {
      o = o || {};
      this.bpm = bpm;
      this.spb = 60 / bpm;
      this.meter = o.meter || 4;
      this.swing = o.swing || 0;
      this.swing16 = o.swing16 || 0;
      this.humanize = o.humanize == null ? 0.008 : o.humanize;
      this.r = o.r;
      this.tempo = [{ beat: 0, bpm }];
      this.notes = [];
    }
    /* A gradual slowdown, written as one tempo event per beat the way a DAW exports it. */
    ritardando(fromBeat, toBeat, toBpm) {
      const from = this.bpmAt(fromBeat);
      for (let b = Math.ceil(fromBeat); b <= toBeat; b++) this.tempo.push({ beat: b, bpm: from + (toBpm - from) * ((b - fromBeat) / (toBeat - fromBeat)) });
      this.tempo.sort((x, y) => x.beat - y.beat);
    }
    bpmAt(beat) {
      let bpm = this.tempo[0].bpm;
      for (const seg of this.tempo) if (seg.beat <= beat) bpm = seg.bpm;
      return bpm;
    }
    sec(beat) {
      if (this.tempo.length === 1) return beat * this.spb;
      let t = 0;
      for (let i = 0; i < this.tempo.length; i++) {
        const a = this.tempo[i].beat, b = i + 1 < this.tempo.length ? this.tempo[i + 1].beat : Infinity;
        if (beat <= a) break;
        t += ((Math.min(beat, b) - a) * 60) / this.tempo[i].bpm;
      }
      return t;
    }
    add(beat, len, p, vel, ch) {
      while (p < 21) p += 12;
      while (p > 108) p -= 12;
      const frac = beat - Math.floor(beat);
      let b = beat;
      if (this.swing && Math.abs(frac - 0.5) < 1e-6) b += this.swing;
      if (this.swing16 && (Math.abs(frac - 0.25) < 1e-6 || Math.abs(frac - 0.75) < 1e-6)) b += this.swing16;
      const jitter = this.r ? (this.r() - 0.5) * this.humanize : 0;
      const t = this.sec(b);
      this.notes.push({ t: Math.max(0, t + jitter), d: Math.max(0.045, this.sec(b + len) - t), p, v: MP.clamp(vel, 0.06, 1), ch: ch || 0 });
    }
  }

  /* Semitone offsets from the tonic for a chord stacked in thirds on scale degree `deg`. */
  function chord(mode, deg, size) {
    const s = scaleOf(mode), out = [];
    for (let k = 0; k < (size || 3); k++) {
      const i = deg + 2 * k;
      out.push(s[i % 7] + 12 * Math.floor(i / 7));
    }
    return out;
  }
  /* Closed voicing: the first `count` chord tones at or above `floor`. */
  function voice(tonic, offsets, floor, count) {
    const pcs = offsets.map((o) => MP.pc(tonic + o));
    const out = [];
    for (let p = floor; out.length < (count || pcs.length) && p < floor + 40; p++) if (pcs.includes(MP.pc(p))) out.push(p);
    return out;
  }
  function ladder(tonic, scale, lo, hi) {
    const out = [];
    for (let p = lo; p <= hi; p++) if (scale.includes(MP.pc(p - tonic))) out.push(p);
    return out;
  }
  function nearest(lad, i, ok, r) {
    for (let d = 0; d < lad.length; d++) {
      const up = i + d, dn = i - d;
      const u = up < lad.length && ok(lad[up]), w = dn >= 0 && ok(lad[dn]);
      if (u && w) return r() < 0.5 ? up : dn;
      if (u) return up;
      if (w) return dn;
    }
    return i;
  }

  const RHYTHMS = {
    sparse: [[[0, 2], [2, 2]], [[0, 3], [3, 1]], [[0, 1.5], [1.5, 2.5]], [[0, 4]], [[0, 1], [1, 3]], [[0.5, 1.5], [2, 2]]],
    medium: [
      [[0, 1], [1, 1], [2, 1.5], [3.5, 0.5]], [[0, 0.5], [0.5, 0.5], [1, 1], [2, 2]], [[0, 1.5], [1.5, 0.5], [2, 1], [3, 1]],
      [[0, 1], [1, 0.5], [1.5, 0.5], [2, 2]], [[0.5, 0.5], [1, 1], [2, 1], [3, 1]], [[0, 0.75], [0.75, 0.75], [1.5, 2.5]],
    ],
    dense: [
      [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 0.5], [2.5, 0.5], [3, 1]],
      [[0, 0.25], [0.25, 0.25], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5]],
      [[0, 0.75], [0.75, 0.25], [1, 0.5], [1.5, 0.5], [2, 0.75], [2.75, 0.25], [3, 1]],
      [[0, 0.5], [0.5, 0.25], [0.75, 0.25], [1, 1], [2, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5]],
    ],
    waltz: [[[0, 2], [2, 1]], [[0, 1], [1, 1], [2, 1]], [[0, 3]], [[0, 1.5], [1.5, 0.5], [2, 1]], [[0, 1], [1, 2]]],
  };

  /* A melody that walks the scale and lands on chord tones on strong beats. */
  function melody(song, r, o) {
    const lad = o.lad, meter = o.meter || 4;
    let i = Math.floor(lad.length * (o.startAt || 0.45));
    let motif = null;
    for (let bar = 0; bar < o.bars; bar++) {
      const pcs = o.chords[bar % o.chords.length];
      let pattern;
      if (motif && bar % 2 === 1 && r() < 0.7) pattern = motif;
      else {
        pattern = pick(r, RHYTHMS[o.density]);
        if (bar % 2 === 0) motif = pattern;
      }
      const last = bar === o.bars - 1;
      if (last && o.endPc != null) pattern = meter === 3 ? [[0, 1], [1, 2]] : [[0, 1], [1, 3]];
      for (let j = 0; j < pattern.length; j++) {
        const off = pattern[j][0], len = pattern[j][1];
        if (off >= meter) continue;
        const strong = off % 1 === 0 && (meter === 3 ? off === 0 : off % 2 === 0);
        if (strong || r() < 0.22) i = nearest(lad, i, (p) => pcs.includes(MP.pc(p)), r);
        else i = MP.clamp(i + pick(r, [-2, -1, -1, 1, 1, 2]), 0, lad.length - 1);
        if (i < lad.length * 0.15) i += 2;
        else if (i > lad.length * 0.88) i -= 2;
        if (last && j === pattern.length - 1 && o.endPc != null) i = nearest(lad, i, (p) => MP.pc(p) === o.endPc, r);
        const v = o.vel[0] + r() * (o.vel[1] - o.vel[0]) + (strong ? 0.05 : 0);
        song.add((o.start || 0) + bar * meter + off, Math.min(len, meter - off) * (o.legato || 0.92), lad[i], v, o.ch);
      }
    }
  }

  const G = {};

  G.ballad = function (r, key) {
    const { tonic, mode } = key;
    const s = new Song(between(r, 66, 82), { r });
    const prog = mode === 'major' ? pick(r, [[0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 5, 4], [5, 3, 0, 4]]) : pick(r, [[0, 5, 2, 6], [0, 3, 6, 5], [0, 6, 5, 4]]);
    const order = pick(r, [[0, 1, 2, 3, 4, 3, 2, 1], [0, 1, 2, 1, 3, 1, 2, 1], [0, 2, 3, 4, 3, 2, 1, 2]]);
    const bars = 8, pcs = [];
    for (let bar = 0; bar < bars; bar++) {
      const deg = bar === bars - 1 ? 0 : prog[bar % 4];
      const off = chord(mode, deg, 3);
      const root = rootIn(tonic + off[0], 38);
      const tones = [root, root + (off[2] - off[0]), root + 12, root + 12 + (off[1] - off[0]), root + 12 + (off[2] - off[0])];
      order.forEach((ti, k) => s.add(bar * 4 + k * 0.5, k === 0 ? 4 : 1.4, tones[ti], k === 0 ? 0.6 : 0.36 + r() * 0.12, 0));
      pcs.push(off.map((o) => MP.pc(tonic + o)));
    }
    melody(s, r, { bars, chords: pcs, lad: ladder(tonic, scaleOf(mode), 64, 84), density: pick(r, ['sparse', 'medium']), ch: 0, vel: [0.6, 0.78], endPc: tonic });
    return { song: s, instruments: { 0: 'keys' } };
  };

  G.lofi = function (r, key) {
    const { tonic, mode } = key;
    const s = new Song(between(r, 72, 86), { r, swing: 0.14, humanize: 0.014 });
    const prog = mode === 'major' ? pick(r, [[1, 4, 0, 5], [3, 2, 1, 0], [0, 5, 1, 4]]) : pick(r, [[0, 3, 6, 2], [5, 4, 0, 0], [0, 6, 5, 4]]);
    const comp = pick(r, [[[0, 1.75], [2.5, 1.5]], [[0, 3.5]], [[0, 1], [1.5, 0.5], [2.5, 1.5]]]);
    const bars = 8, pcs = [];
    for (let bar = 0; bar < bars; bar++) {
      const deg = prog[bar % 4];
      const off = chord(mode, deg, 5);
      const upper = voice(tonic, [off[1], off[3], off[4]], 57, 4);
      for (const [b, len] of comp) upper.forEach((p, k) => s.add(bar * 4 + b + k * 0.03, len, p, 0.42 + r() * 0.1, 0));
      const root = rootIn(tonic + off[0], 36);
      s.add(bar * 4, 1.5, root, 0.7, 1);
      s.add(bar * 4 + 1.5, 0.5, root, 0.5, 1);
      s.add(bar * 4 + 2.5, 1.2, r() < 0.5 ? root + 7 : root, 0.6, 1);
      s.add(bar * 4, 0.25, DR.kick, 0.85, 9);
      s.add(bar * 4 + 2.5, 0.25, DR.kick, 0.75, 9);
      if (r() < 0.4) s.add(bar * 4 + 1.75, 0.25, DR.kick, 0.5, 9);
      s.add(bar * 4 + 1, 0.25, DR.snare, 0.62, 9);
      s.add(bar * 4 + 3, 0.25, DR.snare, 0.66, 9);
      for (let e = 0; e < 8; e++) s.add(bar * 4 + e * 0.5, 0.2, bar % 2 === 1 && e === 7 ? DR.open : DR.hat, e % 2 ? 0.26 : 0.4, 9);
      pcs.push(off.slice(0, 4).map((o) => MP.pc(tonic + o)));
    }
    melody(s, r, { bars, chords: pcs, lad: ladder(tonic, mode === 'minor' ? PENT_MIN : PENT_MAJ, 67, 86), density: 'sparse', ch: 2, vel: [0.45, 0.62] });
    return { song: s, instruments: { 0: 'keys', 1: 'bass', 2: 'pluck', 9: 'drums' } };
  };

  G.ambient = function (r, key) {
    const { tonic, mode } = key;
    const s = new Song(between(r, 60, 70), { r, humanize: 0.02 });
    const prog = mode === 'major' ? pick(r, [[0, 3, 5, 4], [0, 5, 3, 0], [3, 0, 4, 5]]) : pick(r, [[0, 5, 3, 6], [0, 3, 5, 0], [5, 6, 0, 0]]);
    const glint = ladder(tonic, mode === 'minor' ? PENT_MIN : PENT_MAJ, 72, 96);
    for (let c = 0; c < 6; c++) {
      const off = chord(mode, prog[c % 4], 5);
      const root = rootIn(tonic + off[0], 36);
      const at = c * 8;
      s.add(at, 8.4, root, 0.5, 0);
      s.add(at + 0.1, 8.3, root + 7, 0.38, 0);
      voice(tonic, [off[1], off[2], off[4]], 60, 3).forEach((p, k) => s.add(at + 0.2 + k * 0.15, 8.1, p, 0.36 + r() * 0.1, 0));
      const n = between(r, 2, 5);
      for (let k = 0; k < n; k++) s.add(at + Math.floor(r() * 15) * 0.5, 1.5 + r() * 3, pick(r, glint), 0.28 + r() * 0.26, 1);
    }
    return { song: s, instruments: { 0: 'pad', 1: 'bell' } };
  };

  G.synthwave = function (r, key) {
    const { tonic } = key;
    const s = new Song(between(r, 96, 116), { r, humanize: 0.002 });
    const prog = pick(r, [[0, 5, 2, 6], [0, 6, 5, 6], [5, 6, 0, 0], [0, 3, 5, 6]]);
    const pattern = pick(r, [[0, 1, 2, 3, 2, 1, 0, 1], [0, 1, 2, 3, 0, 1, 2, 3], [0, 2, 1, 3, 0, 2, 1, 3], [3, 2, 1, 0, 1, 2, 3, 2]]);
    const drums = r() < 0.6;
    for (let bar = 0; bar < 8; bar++) {
      const off = chord('minor', prog[bar % 4], 3);
      const arp = voice(tonic, off, 60, 4);
      for (let k = 0; k < 16; k++) s.add(bar * 4 + k * 0.25, 0.22, arp[pattern[k % 8]], k % 4 === 0 ? 0.6 : 0.42, 0);
      const root = rootIn(tonic + off[0], 33);
      for (let k = 0; k < 8; k++) s.add(bar * 4 + k * 0.5, 0.42, k % 2 ? root + 12 : root, 0.68, 1);
      voice(tonic, off, 55, 3).forEach((p) => s.add(bar * 4, 4, p, 0.32, 2));
      if (drums) {
        for (let b = 0; b < 4; b++) s.add(bar * 4 + b, 0.25, DR.kick, 0.85, 9);
        s.add(bar * 4 + 1, 0.25, DR.snare, 0.7, 9);
        s.add(bar * 4 + 3, 0.25, DR.snare, 0.72, 9);
        for (let b = 0; b < 4; b++) s.add(bar * 4 + b + 0.5, 0.2, DR.hat, 0.4, 9);
      }
    }
    return { song: s, instruments: { 0: 'pluck', 1: 'bass', 2: 'pad', 9: 'drums' } };
  };

  G.chiptune = function (r, key) {
    const { tonic } = key;
    const s = new Song(between(r, 132, 150), { r, humanize: 0 });
    const prog = pick(r, [[0, 3, 4, 0], [0, 5, 3, 4], [0, 4, 5, 3]]);
    const pcs = [];
    const arps = r() < 0.5;
    for (let bar = 0; bar < 8; bar++) {
      const off = chord('major', bar === 7 ? 0 : prog[bar % 4], 3);
      const root = rootIn(tonic + off[0], 36);
      for (let k = 0; k < 8; k++) s.add(bar * 4 + k * 0.5, 0.42, k % 2 ? root + 12 : root, 0.62, 1);
      if (arps && bar % 2 === 1) {
        const tri = voice(tonic, off, 60, 3);
        for (let k = 0; k < 16; k++) s.add(bar * 4 + k * 0.25, 0.2, tri[k % 3], 0.26, 2);
      }
      pcs.push(off.map((o) => MP.pc(tonic + o)));
    }
    melody(s, r, { bars: 8, chords: pcs, lad: ladder(tonic, MAJ, 69, 88), density: 'dense', ch: 0, vel: [0.68, 0.84], legato: 0.85, endPc: tonic });
    return { song: s, instruments: { 0: 'chip', 1: 'chipbass', 2: 'chip' } };
  };

  const KITS = {
    boombap: { bpm: [86, 94], swing16: 0.06, kick: [[0, 10], [0, 7, 10], [0, 3, 10, 11]], snare: [4, 12], hats: 'eighths', ghost: [7, 15] },
    house: { bpm: [120, 126], kick: [[0, 4, 8, 12]], clap: [4, 12], hats: 'offbeat-open' },
    breakbeat: { bpm: [86, 96], kick: [[0, 2, 10], [0, 2, 10, 11]], snare: [4, 7, 9, 12, 15], hats: 'ride' },
    trap: { bpm: [136, 148], kick: [[0, 3, 10, 11], [0, 7, 10]], clap: [8], hats: 'rolls' },
  };
  G.drums = function (r, key, sub) {
    const kit = KITS[sub] || KITS[pick(r, Object.keys(KITS))];
    const s = new Song(sub === 'house' && key.bpm ? key.bpm : between(r, kit.bpm[0], kit.bpm[1]), { r, swing16: kit.swing16 || 0, humanize: 0.004 });
    const kickA = pick(r, kit.kick), kickB = pick(r, kit.kick);
    const step = (bar, n, note, v) => s.add(bar * 4 + n * 0.25, 0.22, note, v, 9);
    for (let bar = 0; bar < 8; bar++) {
      const fill = bar % 4 === 3;
      if (bar % 4 === 0) step(bar, 0, DR.crash, 0.7);
      for (const n of bar % 2 ? kickB : kickA) if (!(fill && n >= 12)) step(bar, n, DR.kick, n === 0 ? 0.95 : 0.8);
      for (const n of kit.snare || []) if (!(fill && n >= 12)) step(bar, n, DR.snare, n % 4 === 0 ? 0.85 : 0.5);
      for (const n of kit.clap || []) step(bar, n, DR.clap, 0.85);
      for (const n of kit.ghost || []) if (r() < 0.6) step(bar, n, DR.snare, 0.22);
      if (kit.hats === 'eighths') for (let n = 0; n < 16; n += 2) step(bar, n, n === 14 && bar % 2 ? DR.open : DR.hat, n % 4 === 0 ? 0.5 : 0.34);
      if (kit.hats === 'offbeat-open') for (let n = 2; n < 16; n += 4) step(bar, n, r() < 0.3 ? DR.open : DR.hat, 0.55);
      if (kit.hats === 'ride') for (let n = 0; n < 16; n += 2) step(bar, n, DR.ride, n % 4 === 0 ? 0.5 : 0.36);
      if (kit.hats === 'rolls') {
        for (let n = 0; n < 12; n += 2) step(bar, n, DR.hat, 0.45);
        for (let k = 0; k < (bar % 2 ? 8 : 4); k++) s.add(bar * 4 + 3 + k * (bar % 2 ? 0.125 : 0.25), 0.1, DR.hat, 0.3 + k * 0.04, 9);
      }
      if (fill) {
        const toms = pick(r, [[DR.tomHi, DR.tomMid, DR.tomLo, DR.tomLo], [DR.snare, DR.snare, DR.tomMid, DR.tomLo]]);
        toms.forEach((t, k) => step(bar, 12 + k, t, 0.6 + k * 0.08));
      }
    }
    return { song: s, instruments: { 9: 'drums' } };
  };

  G.bass = function (r, key) {
    const { tonic } = key;
    const s = new Song(between(r, 104, 122), { r, humanize: 0.003 });
    const masks = [[0, 3, 6, 8, 11, 14], [0, 2, 3, 6, 7, 10, 12, 14], [0, 3, 4, 7, 10, 11, 13]];
    const A = pick(r, masks), B = pick(r, masks);
    const lad = ladder(tonic, PENT_MIN, 33, 52);
    const roots = pick(r, [[0, 0, 8, 10], [0, 0, 5, 7], [0, 3, 8, 7]]);
    for (let bar = 0; bar < 8; bar++) {
      const mask = bar % 2 ? B : A;
      const root = rootIn(tonic + roots[Math.floor(bar / 2) % 4], 33);
      mask.forEach((n, k) => {
        const next = mask[k + 1] == null ? 16 : mask[k + 1];
        const roll = r();
        let p = roll < 0.5 ? root : roll < 0.65 ? root + 12 : lad[MP.clamp(lad.indexOf(nearestIn(lad, root)) + pick(r, [1, 2, -1, 3]), 0, lad.length - 1)];
        if (bar % 2 === 1 && n >= 12 && r() < 0.5) p = root + 7;
        s.add(bar * 4 + n * 0.25, Math.min(1, (next - n) * 0.25 * 0.8), p, n % 4 === 0 ? 0.82 : 0.64, 0);
      });
      for (let b = 0; b < 4; b++) s.add(bar * 4 + b, 0.25, DR.kick, 0.55, 9);
    }
    return { song: s, instruments: { 0: 'bass', 9: 'drums' } };
  };
  const nearestIn = (lad, p) => lad.reduce((best, q) => (Math.abs(q - p) < Math.abs(best - p) ? q : best), lad[0]);

  G.jazz = function (r, key) {
    const { tonic } = key;
    const s = new Song(between(r, 104, 132), { r, swing: 0.16, humanize: 0.012 });
    const degs = [1, 4, 0, 0, 1, 4, 0, 5];
    const rhythms = [[[0, 1.5]], [[1.5, 0.5], [3, 1]], [[0, 0.75], [1.5, 1.5]], [[0.5, 1], [2.5, 1]]];
    for (let bar = 0; bar < 8; bar++) {
      const off = chord('major', degs[bar], 5);
      const v = voice(tonic, [off[1], off[3], off[4], off[2]], 52, 4);
      for (const [b, len] of pick(r, rhythms)) v.forEach((p) => s.add(bar * 4 + b, len, p, 0.42 + r() * 0.1, 0));
      const root = rootIn(tonic + off[0], 36);
      const nextRoot = rootIn(tonic + chord('major', degs[(bar + 1) % 8], 1)[0], 36);
      const walk = [root, root + (off[1] - off[0]), root + (off[2] - off[0]), nextRoot + (r() < 0.5 ? 1 : -1)];
      walk.forEach((p, b) => s.add(bar * 4 + b, 0.9, p, b === 0 ? 0.72 : 0.62, 1));
      [[0, 0.52], [1, 0.48], [1.5, 0.32], [2, 0.52], [3, 0.48], [3.5, 0.32]].forEach(([b, vel]) => s.add(bar * 4 + b, 0.3, DR.ride, vel, 9));
      s.add(bar * 4 + 1, 0.2, DR.pedal, 0.38, 9);
      s.add(bar * 4 + 3, 0.2, DR.pedal, 0.38, 9);
    }
    return { song: s, instruments: { 0: 'keys', 1: 'bass', 9: 'drums' } };
  };

  G.classical = function (r, key) {
    const { tonic, mode } = key;
    const s = new Song(between(r, 100, 118), { r, humanize: 0.006 });
    const prog = pick(r, [[0, 3, 4, 0, 5, 3, 4, 0], [0, 4, 0, 4, 3, 0, 4, 0], [0, 5, 3, 4, 0, 3, 4, 0]]);
    const pcs = [];
    for (let bar = 0; bar < 8; bar++) {
      const off = chord(mode, prog[bar], 3);
      const [lo, mid, hi] = voice(tonic, off, 48, 3);
      if (bar === 7) s.add(bar * 4, 2, lo - 12 < 36 ? lo : lo - 12, 0.5, 0);
      else [lo, hi, mid, hi, lo, hi, mid, hi].forEach((p, k) => s.add(bar * 4 + k * 0.5, 0.48, p, k % 4 === 0 ? 0.46 : 0.34, 0));
      pcs.push(off.map((o) => MP.pc(tonic + o)));
    }
    const lad = ladder(tonic, scaleOf(mode), 67, 86);
    melody(s, r, { bars: 8, chords: pcs, lad, density: pick(r, ['medium', 'dense']), ch: 0, vel: [0.58, 0.76], endPc: tonic });
    // Bar 4 becomes a scale run, the way a sonatina breathes before its second phrase.
    const from = 12 * s.spb - 0.02, to = 16 * s.spb - 0.02;
    s.notes = s.notes.filter((n) => !(n.p >= 67 && n.t >= from && n.t < to));
    const run = Math.floor(lad.length * 0.3);
    for (let k = 0; k < 8; k++) s.add(12 + k * 0.5, 0.45, lad[run + (k < 5 ? k : 8 - k)], 0.6, 0);
    return { song: s, instruments: { 0: 'keys' } };
  };

  G.cinematic = function (r, key) {
    const { tonic } = key;
    const s = new Song(between(r, 64, 76), { r, humanize: 0.01 });
    const prog = pick(r, [[0, 5, 2, 6], [0, 6, 5, 4], [0, 3, 5, 4], [0, 5, 6, 4]]);
    const bars = 12, pcs = [];
    for (let bar = 0; bar < bars; bar++) {
      const off = chord('minor', bar === bars - 1 ? 0 : prog[bar % 4], 3);
      const root = rootIn(tonic + off[0], 36);
      const swell = bar / bars;
      [root, root + 12, root + 7, root + 12, root, root + 12, root + 7, root + 12].forEach((p, k) => s.add(bar * 4 + k * 0.5, 0.4, p, 0.42 + swell * 0.3 + (k === 0 ? 0.08 : 0), 0));
      if (bar >= 1) voice(tonic, off, 55, 3).forEach((p) => s.add(bar * 4, 4.05, p, 0.26 + swell * 0.36, 1));
      pcs.push(off.map((o) => MP.pc(tonic + o)));
    }
    melody(s, r, { bars: 8, start: 16, chords: pcs.slice(4), lad: ladder(tonic, MIN, 69, 86), density: 'sparse', ch: 2, vel: [0.45, 0.6], legato: 1, endPc: tonic });
    return { song: s, instruments: { 0: 'pizz', 1: 'strings', 2: 'strings' } };
  };

  G.musicbox = function (r, key) {
    const { tonic } = key;
    const s = new Song(between(r, 84, 100), { r, meter: 3, humanize: 0.006 });
    const half = pick(r, [[0, 0, 4, 4, 3, 3, 0, 4], [0, 3, 4, 0, 5, 3, 4, 4], [0, 5, 3, 4, 0, 5, 4, 0]]);
    const prog = half.concat(half.slice(0, 7), [0]);
    const pentatonic = r() < 0.35;
    const pcs = [];
    for (let bar = 0; bar < 16; bar++) {
      const off = chord('major', prog[bar], 3);
      s.add(bar * 3, 1, rootIn(tonic + off[0], 48), 0.46, 0);
      const pair = voice(tonic, [off[1], off[2]], 60, 2);
      if (bar < 15) for (const b of [1, 2]) pair.forEach((p) => s.add(bar * 3 + b, 0.8, p, 0.3, 0));
      pcs.push(off.map((o) => MP.pc(tonic + o)));
    }
    melody(s, r, { bars: 16, meter: 3, chords: pcs, lad: ladder(tonic, pentatonic ? PENT_MAJ : MAJ, 72, 93), density: 'waltz', ch: 0, vel: [0.5, 0.68], endPc: tonic });
    return { song: s, instruments: { 0: 'bell' } };
  };

  G.neosoul = function (r, key) {
    const { tonic, mode } = key;
    const s = new Song(between(r, 76, 90), { r, swing: 0.1, humanize: 0.012 });
    const prog = mode === 'major' ? pick(r, [[1, 4, 0, 0], [3, 2, 1, 4], [0, 3, 1, 4]]) : pick(r, [[0, 3, 6, 2], [5, 4, 0, 3]]);
    const stabs = pick(r, [[[0, 1.5], [2.5, 1], [3.5, 0.5]], [[0, 0.75], [1.5, 0.5], [2, 1.5]], [[0.5, 1], [2, 0.5], [2.5, 1.5]]]);
    for (let bar = 0; bar < 8; bar++) {
      const off = chord(mode, prog[bar % 4], 5);
      const v = voice(tonic, [off[1], off[2], off[3], off[4]], 55, 4);
      for (const [b, len] of stabs) v.forEach((p, k) => s.add(bar * 4 + b + k * 0.02, len, p, 0.4 + r() * 0.12, 0));
      const root = rootIn(tonic + off[0], 36);
      [[0, 1.5, root], [1.75, 0.25, root + 12], [2.5, 1, root + 7]].forEach(([b, len, p]) => s.add(bar * 4 + b, len, p, 0.66, 1));
    }
    return { song: s, instruments: { 0: 'keys', 1: 'bass' } };
  };

  G.melody = function (r, key) {
    const { tonic, mode } = key;
    const s = new Song(between(r, 92, 108), { r });
    const prog = mode === 'major' ? [0, 5, 3, 4] : [0, 5, 6, 4];
    const pcs = prog.map((d) => chord(mode, d, 3).map((o) => MP.pc(tonic + o)));
    melody(s, r, { bars: 8, chords: pcs, lad: ladder(tonic, scaleOf(mode), 62, 83), density: 'medium', ch: 0, vel: [0.6, 0.8], legato: 0.95, endPc: tonic });
    return { song: s, instruments: { 0: 'lead' } };
  };

  /* A full arrangement: sections, eight parts, a pedalled keyboard and a ritardando into the last chord. */
  G.arrangement = function (r, key, sub) {
    const { tonic, mode } = key;
    sub = sub || {};
    const bpm = sub.bpm || between(r, 86, 98);
    const s = new Song(bpm, { r, humanize: 0.008 });
    const plan = sub.plan || [['intro', 4], ['verse', 8], ['chorus', 8], ['verse', 8], ['chorus', 8], ['outro', 4]];
    const total = plan.reduce((a, x) => a + x[1], 0);
    s.ritardando((total - 4) * 4, total * 4, Math.round(bpm * 0.8));
    const PROG = mode === 'major'
      ? { intro: [0, 3], verse: [0, 5, 3, 4], chorus: [3, 4, 0, 5], bridge: [5, 3, 1, 4], outro: [3, 0] }
      : { intro: [0, 5], verse: [0, 5, 2, 6], chorus: [5, 6, 0, 4], bridge: [3, 4, 5, 6], outro: [5, 0] };
    const glints = ladder(tonic, mode === 'minor' ? PENT_MIN : PENT_MAJ, 76, 93);
    const sections = [];
    let bar = 0;
    for (const [kind, len] of plan) {
      const prog = PROG[kind];
      const per = kind === 'intro' || kind === 'outro' ? len / prog.length : 1;
      const pcs = [];
      for (let k = 0; k < len; k++, bar++) {
        const deg = kind === 'outro' && k === len - 1 ? 0 : prog[Math.floor(k / per) % prog.length];
        const off3 = chord(mode, deg, 3), off5 = chord(mode, deg, 5);
        const at = bar * 4, root = rootIn(tonic + off3[0], 36);
        const full = kind === 'chorus';
        pcs.push(off3.map((o) => MP.pc(tonic + o)));
        if (full) {
          const v = voice(tonic, [off5[1], off5[2], off5[3]], 55, 4);
          for (const [b, l] of [[0, 1.5], [1.5, 1], [2.5, 1.5]]) v.forEach((p, i) => s.add(at + b + i * 0.015, l, p, 0.5 + r() * 0.08, 0));
        } else {
          const v = voice(tonic, [off5[0], off5[1], off5[2], off5[3]], 48, 6);
          [0, 1, 2, 3, 4, 5, 4, 3].forEach((vi, i) => s.add(at + i * 0.5, 4.5 - i * 0.5, v[vi], kind === 'outro' ? 0.36 : 0.4 + r() * 0.1, 0));
        }
        if (!(kind === 'intro' && k < 2)) voice(tonic, off3, 52, 3).forEach((p) => s.add(at + 0.05, 4.1, p, full ? 0.42 : 0.3, 1));
        if (kind === 'verse' || kind === 'bridge') {
          s.add(at, 1.8, root, 0.7, 2);
          s.add(at + 2, 1.4, root, 0.6, 2);
          s.add(at + 3.5, 0.5, root + 7, 0.55, 2);
        } else if (full) for (let e = 0; e < 8; e++) s.add(at + e * 0.5, 0.42, e % 4 === 3 ? root + 12 : root, e % 2 ? 0.58 : 0.72, 2);
        else if (kind === 'outro' && k === len - 1) s.add(at, 4, root, 0.6, 2);
        if (kind === 'verse' || kind === 'chorus' || kind === 'bridge') {
          if (k === 0) s.add(at, 0.3, DR.crash, 0.75, 9);
          s.add(at, 0.25, DR.kick, 0.9, 9);
          s.add(at + 2.5, 0.25, DR.kick, 0.75, 9);
          if (full) s.add(at + 1.75, 0.25, DR.kick, 0.55, 9);
          s.add(at + 1, 0.25, full ? DR.snare : DR.rim, full ? 0.75 : 0.5, 9);
          s.add(at + 3, 0.25, full ? DR.snare : DR.rim, full ? 0.78 : 0.52, 9);
          const step = full ? 0.25 : 0.5;
          for (let e = 0; e < 4 / step; e++) s.add(at + e * step, 0.15, DR.hat, e % (full ? 4 : 2) === 0 ? 0.42 : 0.26, 9);
          if (k === len - 1) [DR.tomHi, DR.tomMid, DR.tomLo, DR.snare].forEach((d, i) => s.add(at + 3 + i * 0.25, 0.2, d, 0.6 + i * 0.07, 9));
        }
        if (full) {
          voice(tonic, off3, 64, 3).forEach((p) => s.add(at, 4.05, p, 0.3 + (k / len) * 0.16, 4));
          const a = voice(tonic, off3, 72, 4);
          for (let st = 0; st < 16; st++) s.add(at + st * 0.25, 0.2, a[[0, 1, 2, 3, 2, 1, 0, 1][st % 8]], st % 4 === 0 ? 0.36 : 0.24, 5);
        }
        if (kind === 'intro' || kind === 'outro') for (let g = 0; g < 2; g++) s.add(at + between(r, 0, 7) * 0.5, 2.5, pick(r, glints), 0.3 + r() * 0.15, 6);
      }
      sections.push({ kind, start: bar - len, len, pcs });
    }
    for (const sec of sections) {
      if (sec.kind === 'intro' || sec.kind === 'outro') continue;
      const hi = sec.kind === 'chorus';
      melody(s, r, { bars: sec.len, start: sec.start * 4, chords: sec.pcs, lad: ladder(tonic, scaleOf(mode), hi ? 67 : 62, hi ? 88 : 81), density: hi ? 'medium' : 'sparse', ch: 3, vel: [0.58, 0.78], legato: 0.95 });
    }
    return {
      song: s,
      sections: sections.map((x) => ({ kind: x.kind, bar: x.start, bars: x.len })),
      instruments: { 0: 'keys', 1: 'pad', 2: 'bass', 3: 'lead', 4: 'strings', 5: 'pluck', 6: 'bell', 9: 'drums' },
      names: { 0: 'Rhodes', 1: 'Warm pad', 2: 'Bass', 3: 'Lead', 4: 'Strings', 5: 'Arpeggio', 6: 'Bells', 9: 'Drums' },
    };
  };

  /* ---------- The starter board ---------- */
  const AUTHORS = [
    { name: 'Noa Lindqvist', handle: 'noa.keys' },
    { name: 'Ravi Menon', handle: 'ravimakesloops' },
    { name: 'Inês Carvalho', handle: 'fieldnotes' },
    { name: 'Theo Park', handle: 'theo.wav' },
    { name: 'Mara Okafor', handle: 'maraok' },
    { name: 'Jun Sato', handle: 'jun_8bit' },
    { name: 'Lena Fischer', handle: 'lenafischer' },
    { name: 'Omar Haddad', handle: 'omar.h' },
    { name: 'Sasha Ivanova', handle: 'sasha.iv' },
    { name: 'Kit Morales', handle: 'kitmorales' },
    { name: 'Amara Diallo', handle: 'amaradiallo' },
    { name: 'Felix Grün', handle: 'felixgruen' },
  ];
  AUTHORS.forEach((a) => {
    a.hue = (MP.hash(a.handle) % 12) * 30 + 25;
    a.followers = 120 + (MP.hash(a.name) % 9000);
  });

  const TAGS = {
    ballad: ['Piano', 'Melody'], lofi: ['Lo-fi', 'Chords'], ambient: ['Ambient'], synthwave: ['Synthwave'],
    chiptune: ['Chiptune', 'Melody'], drums: ['Drums'], jazz: ['Jazz', 'Chords'], classical: ['Classical', 'Piano'],
    cinematic: ['Cinematic'], bass: ['Bass'], musicbox: ['Melody'], neosoul: ['Chords', 'Piano'], melody: ['Melody'],
    arrangement: ['Arrangements'],
  };
  const MODE_BIAS = { synthwave: 'minor', cinematic: 'minor', bass: 'minor', chiptune: 'major', jazz: 'major', musicbox: 'major' };

  const DESC = {
    ballad: (k) => `Broken-chord left hand under a simple top line in ${k}. Loops cleanly after eight bars.`,
    lofi: (k, bpm) => `Swung ${k} seventh chords at ${bpm} BPM with a lazy kick and a round bass. Sits well under a vocal chop.`,
    ambient: (k) => `Two-bar pad chords in ${k} with slow, high glints on top. Made for long fades.`,
    synthwave: (k) => `Sixteenth-note arpeggio over ${k}, pushed along by an octave bass.`,
    chiptune: (k) => `Square-wave lead and an octave-jumping bass in ${k}. Very level select.`,
    drums: (k, bpm, sub) => `${{ boombap: 'Boom bap', house: 'House', breakbeat: 'Breakbeat', trap: 'Half-time trap' }[sub] || 'Drum'} groove at ${bpm} BPM on the General MIDI drum map, so it plays on any kit.`,
    jazz: (k) => `ii–V–I in ${k} with rootless voicings, a walking bass and a swung ride.`,
    classical: (k) => `Alberti bass and a singing melody in ${k}, with a scale run before the second phrase.`,
    bass: (k, bpm) => `Syncopated sixteenth-note bassline in ${k} at ${bpm} BPM, locked to a four-on-the-floor kick.`,
    cinematic: (k) => `Pizzicato ostinato under strings that swell for twelve bars in ${k}.`,
    musicbox: (k) => `A small waltz in 3/4 for music box, in ${k}.`,
    neosoul: (k) => `Ninth-chord stabs in ${k} with a slight strum. Bass sits on its own channel.`,
    melody: (k) => `One hook in ${k}, nothing else. Bring your own chords.`,
    arrangement: (k, bpm, sub, m) => `${m.parts.length} parts across ${m.sections.length} sections in ${k}: a pedalled Rhodes, pad, bass, drums, lead, strings, arpeggio and bells. Opens at ${bpm} BPM and slows to ${Math.round(m.tempos[m.tempos.length - 1].bpm)} into the last chord.`,
  };

  // title, generator, artwork style, author, days since posting, key, variant
  const CATALOG = [
    ['Afterhours', 'arrangement', 'roll', 3, 1, 'Em', { bpm: 92, featured: true }],
    ['Glass Harbor Suite', 'arrangement', 'orbit', 2, 9, 'D', { bpm: 84, plan: [['intro', 4], ['verse', 8], ['chorus', 8], ['bridge', 4], ['chorus', 8], ['outro', 4]] }],
    ['Northbound', 'arrangement', 'fall', 8, 16, 'Bm', { bpm: 102 }],
    ['Glasshouse', 'ballad', 'fall', 0, 2],
    ['Late Bus Home', 'lofi', 'roll', 1, 1],
    ['Tidal Hours', 'ambient', 'orbit', 2, 4],
    ['Neon Overpass', 'synthwave', 'roll', 3, 3],
    ['Coin Heaven', 'chiptune', 'steps', 5, 6],
    ['Boom Bap No. 4', 'drums', 'steps', 7, 1, null, 'boombap'],
    ['Velvet ii–V–I', 'jazz', 'roll', 8, 9],
    ['Sonatina in G', 'classical', 'fall', 6, 12, 'G'],
    ['The Long Night Cue', 'cinematic', 'orbit', 4, 5],
    ['Fourth Floor Bass', 'bass', 'roll', 9, 2],
    ['Paper Moon Waltz', 'musicbox', 'orbit', 10, 7],
    ['Neo Soul Stabs', 'neosoul', 'roll', 11, 3],
    ['Rain on the Laundromat', 'lofi', 'orbit', 1, 8],
    ['First Light', 'ballad', 'roll', 0, 14],
    ['Slow Aurora', 'ambient', 'fall', 2, 11],
    ['Night Drive 1986', 'synthwave', 'orbit', 3, 10],
    ['Warehouse 124', 'drums', 'steps', 7, 4, null, 'house'],
    ['Level 4-2', 'chiptune', 'roll', 5, 15],
    ['Blue Hour Comping', 'jazz', 'orbit', 8, 6],
    ['Étude for Small Hands', 'classical', 'roll', 6, 20],
    ['Arrival', 'cinematic', 'fall', 4, 16],
    ['Rubber Band', 'bass', 'steps', 9, 9],
    ['Snow Globe', 'musicbox', 'fall', 10, 25],
    ['Sunday Voicings', 'neosoul', 'orbit', 11, 13],
    ['Whistle Tune', 'melody', 'roll', 2, 5],
    ['Study Hall 3am', 'lofi', 'fall', 1, 18],
    ['Cloud Chamber', 'ambient', 'roll', 2, 22],
    ['Chrome Horizon', 'synthwave', 'fall', 3, 26],
    ['Amen Study', 'drums', 'steps', 7, 19, null, 'breakbeat'],
    ['Pixel Garden', 'chiptune', 'orbit', 5, 28],
    ['Smoke Rings', 'jazz', 'fall', 8, 30],
    ['Minuet for a Window', 'classical', 'orbit', 6, 33],
    ['Embers', 'cinematic', 'roll', 4, 21],
    ['Subway Line', 'bass', 'orbit', 9, 17],
    ['Kitchen Table Hymn', 'ballad', 'orbit', 0, 35],
    ['Gospel Turnaround', 'neosoul', 'fall', 11, 24],
    ['Hook Sketch #12', 'melody', 'orbit', 10, 1],
    ['Rattle & Roll', 'drums', 'steps', 7, 27, null, 'trap'],
    ['Corner Store Tape', 'lofi', 'roll', 1, 40],
    ['Salt Flats', 'ambient', 'orbit', 2, 45],
    ['Lantern Festival', 'musicbox', 'roll', 10, 38],
    ['Overtime', 'synthwave', 'roll', 3, 31],
  ];

  function parseKey(str) {
    const minor = /m$/.test(str);
    const name = minor ? str.slice(0, -1) : str;
    const tonic = MP.MAJOR_NAMES.indexOf(name) >= 0 ? MP.MAJOR_NAMES.indexOf(name) : MP.MINOR_NAMES.indexOf(name);
    return { tonic: Math.max(0, tonic), mode: minor ? 'minor' : 'major' };
  }

  const PART_NAMES = { keys: 'Keys', pad: 'Pad', pluck: 'Pluck', pizz: 'Pizzicato', bell: 'Bells', chip: 'Square lead', chipbass: 'Triangle bass', bass: 'Bass', strings: 'Strings', lead: 'Lead', organ: 'Organ', brass: 'Brass', drums: 'Drums' };

  function build(genre, r, key, sub) {
    const out = G[genre](r, key, sub);
    const song = out.song;
    song.notes.sort((a, b) => a.t - b.t || a.p - b.p);
    const chans = Object.keys(out.instruments).map(Number).sort((a, b) => (a === 9) - (b === 9) || a - b);
    let parts = chans.map((ch) => {
      const inst = out.instruments[ch];
      const program = ch === 9 ? -1 : MP.midi.PROGRAM_FOR[inst] || 0;
      return { ch, inst, program, gm: ch === 9 ? 'Drum Kit' : MP.midi.GM[program], name: (out.names && out.names[ch]) || PART_NAMES[inst] || 'Part', count: 0 };
    });
    for (const n of song.notes) parts[chans.indexOf(n.ch)].count++;
    parts = parts.filter((p) => p.count > 0);
    for (const n of song.notes) n.part = parts.findIndex((p) => p.ch === n.ch);
    const duration = song.notes.reduce((m, n) => Math.max(m, n.t + n.d), 0);
    const tempos = [];
    for (const seg of song.tempo) {
      const t = song.sec(seg.beat), bpm = Math.round(seg.bpm * 10) / 10;
      if (tempos.length && tempos[tempos.length - 1].t === t) tempos[tempos.length - 1].bpm = bpm;
      else tempos.push({ t, bpm });
    }
    const bars = [];
    for (let k = 0; bars.length < 4000; k++) {
      const t = song.sec(k * song.meter);
      if (t > duration + 0.01) break;
      bars.push({ t, num: song.meter });
    }
    const programs = {};
    for (const p of parts) if (p.ch !== 9) programs[p.ch] = p.program;
    const markers = (out.sections || []).map((x) => ({ t: bars[x.bar] ? bars[x.bar].t : song.sec(x.bar * song.meter), text: x.kind.charAt(0).toUpperCase() + x.kind.slice(1) }));
    return { notes: song.notes, bpm: song.bpm, timeSig: [song.meter, 4], parts, tempos, bars, programs, markers, sections: out.sections || null };
  }

  function catalog() {
    const now = Date.now();
    const pins = CATALOG.map(([title, genre, style, ai, days, keyStr, sub]) => {
      const r = MP.rng(MP.hash(title));
      const key = keyStr ? parseKey(keyStr) : { tonic: Math.floor(r() * 12), mode: MODE_BIAS[genre] || (r() < 0.55 ? 'major' : 'minor') };
      if (sub === 'house') key.bpm = 124;
      const music = build(genre, r, key, sub);
      const saves = Math.round(Math.pow(r(), 2.2) * 4200 + 36) + (genre === 'arrangement' ? 900 : 0);
      return Object.assign(music, {
        id: MP.slug(title),
        title,
        genre,
        style,
        featured: !!(sub && sub.featured),
        tags: TAGS[genre].slice(),
        author: AUTHORS[ai],
        key: { tonic: key.tonic, mode: genre === 'drums' ? 'major' : key.mode, none: genre === 'drums' },
        desc: DESC[genre](MP.keyName(key), music.bpm, sub, music),
        saves,
        plays: Math.round(saves * (3 + r() * 9)),
        createdAt: now - days * 86400000 - Math.floor(r() * 80000000),
      });
    });
    // Catalogue numbers follow the order pins were published in.
    pins.slice().sort((a, b) => a.createdAt - b.createdAt).forEach((p, i) => (p.no = i + 1));
    return pins;
  }

  const ADJ = ['Quiet', 'Paper', 'Golden', 'Velvet', 'Hollow', 'Bright', 'Slow', 'Copper', 'Winter', 'Silver', 'Open', 'Low'];
  const NOUN = ['Harbor', 'Window', 'Engine', 'Garden', 'Signal', 'Orchard', 'Lanterns', 'Tides', 'Static', 'Postcard', 'Stairwell', 'Fields'];
  /* A fresh composition as real MIDI bytes, for trying the publisher without a file. */
  function sample() {
    const seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0;
    const r = MP.rng(seed);
    const genre = r() < 0.45 ? 'arrangement' : pick(r, ['ballad', 'lofi', 'ambient', 'synthwave', 'chiptune', 'jazz', 'classical', 'cinematic', 'musicbox', 'neosoul']);
    const key = { tonic: Math.floor(r() * 12), mode: MODE_BIAS[genre] || (r() < 0.5 ? 'major' : 'minor') };
    const music = build(genre, r, key);
    const name = pick(r, ADJ) + ' ' + pick(r, NOUN);
    const bytes = MP.midi.write({ notes: music.notes, tempos: music.tempos, timeSig: music.timeSig, parts: music.parts, name });
    return { bytes, fileName: MP.slug(name) + '.mid', genre };
  }

  MP.compose = { catalog, sample, AUTHORS, TAGS, PART_NAMES };
})();
