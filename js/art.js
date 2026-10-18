/* Midiplace — artwork drawn from notes. Four styles share one set of playback overlays. */
(function () {
  'use strict';
  const MP = window.MP;
  const ART = (MP.art = {});

  ART.STYLES = ['roll', 'orbit', 'fall', 'steps'];
  ART.LABELS = { roll: 'Roll', orbit: 'Orbit', fall: 'Fall', steps: 'Steps' };
  ART.DPR = () => Math.min(2, window.devicePixelRatio || 1);

  const DRUM_NAMES = { 35: 'Kick', 36: 'Kick', 37: 'Rim', 38: 'Snare', 39: 'Clap', 40: 'Snare', 41: 'Tom', 42: 'Hat', 43: 'Tom', 44: 'Pedal', 45: 'Tom', 46: 'Open hat', 47: 'Tom', 48: 'Tom', 49: 'Crash', 50: 'Tom', 51: 'Ride', 53: 'Bell', 57: 'Crash', 59: 'Ride' };
  const DRUM_ORDER = [49, 57, 51, 59, 53, 46, 42, 44, 39, 37, 40, 38, 50, 48, 47, 45, 43, 41, 36, 35];
  const drumLane = (p) => (p === 35 || p === 36 ? 2 : [42, 44, 46, 49, 51, 52, 53, 55, 57, 59].indexOf(p) >= 0 ? 0 : 1);

  /* Derived data, computed once per pin. */
  ART.prepare = function (pin) {
    let lo = 127, hi = 0, mel = 0, drums = 0, maxD = 0, dur = 0, held = 0;
    for (const n of pin.notes) {
      if (n.ch === 9) drums++;
      else {
        mel++;
        held += Math.min(n.d, 4);
        if (n.p < lo) lo = n.p;
        if (n.p > hi) hi = n.p;
      }
      if (n.d > maxD) maxD = n.d;
      if (n.t + n.d > dur) dur = n.t + n.d;
    }
    if (!mel) for (const n of pin.notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
    pin.range = [lo, hi];
    pin.melodicCount = mel;
    pin.drumCount = drums;
    pin.maxDur = Math.min(maxD, 16);
    pin.duration = Math.max(dur, 0.5);
    pin.poly = held / pin.duration;
    pin.bpm = pin.bpm || 120;
    pin.timeSig = pin.timeSig || [4, 4];
    if (!pin.tempos || !pin.tempos.length) pin.tempos = [{ t: 0, bpm: pin.bpm }];
    if (!pin.bars || !pin.bars.length) {
      pin.bars = [];
      const len = (60 / pin.bpm) * pin.timeSig[0];
      for (let t = 0; t <= pin.duration + 0.01 && pin.bars.length < 4000; t += len) pin.bars.push({ t, num: pin.timeSig[0] });
    }
    pin.markers = pin.markers || [];
    if (!pin.parts || !pin.parts.length) {
      const chans = Array.from(new Set(pin.notes.map((n) => n.ch))).sort((a, b) => a - b);
      pin.parts = chans.map((ch) => ({ ch, inst: ch === 9 ? 'drums' : 'keys', program: 0, gm: ch === 9 ? 'Drum Kit' : MP.midi.GM[0], name: ch === 9 ? 'Drums' : 'Part ' + (ch + 1), count: 0 }));
      for (const n of pin.notes) n.part = chans.indexOf(n.ch);
    }
    // Every part gets the color of the pitch class it leans on most, so its LED matches its notes.
    const hist = pin.parts.map(() => new Array(12).fill(0));
    pin.parts.forEach((p) => { p.count = 0; p.lo = 127; p.hi = 0; });
    for (const n of pin.notes) {
      const p = pin.parts[n.part];
      if (!p) continue;
      p.count++;
      p.lo = Math.min(p.lo, n.p);
      p.hi = Math.max(p.hi, n.p);
      hist[n.part][n.p % 12] += Math.min(n.d, 2) * n.v;
    }
    pin.parts.forEach((p, i) => {
      p.drums = p.ch === 9;
      p.pc = hist[i].indexOf(Math.max.apply(null, hist[i]));
    });
    pin.complex = pin.parts.length >= 5 || pin.duration >= 90;
    pin.mix = pin.mix || { mute: new Set(), solo: new Set() };
    const ch = MP.midi.chroma(pin.notes), total = ch.reduce((a, b) => a + b, 0) || 1;
    pin.chroma = ch.map((v) => v / total);
    pin._geo = new Map();
    pin._steps = null;
    pin._bins = null;
    pin._pb = null;
    return pin;
  };

  ART.tempoLabel = function (pin) {
    const a = Math.round(pin.tempos[0].bpm), b = Math.round(pin.tempos[pin.tempos.length - 1].bpm);
    return a === b ? a + ' BPM' : a + ' → ' + b + ' BPM';
  };

  /* Bar and beat at a time, read from the bar map so tempo and meter changes count correctly. */
  ART.barBeat = function (pin, t) {
    const bars = pin.bars;
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    const b = bars[lo];
    const next = bars[lo + 1] ? bars[lo + 1].t : b.t + (lo > 0 ? b.t - bars[lo - 1].t : (60 / pin.bpm) * b.num);
    const beat = Math.min(b.num, Math.floor(((t - b.t) / Math.max(1e-6, next - b.t)) * b.num) + 1);
    return { bar: lo + 1, beat: Math.max(1, beat), num: b.num };
  };

  ART.aspect = function (pin, style) {
    const span = pin.range[1] - pin.range[0];
    if (style === 'orbit') return 1;
    if (style === 'fall') return MP.clamp(1.22 + pin.duration / 110, 1.3, 1.6);
    if (style === 'steps') return MP.clamp(stepsParams(pin).aspect, 0.55, 1.5);
    return MP.clamp(0.6 + span / 42, 0.72, 1.28);
  };

  /* ---------- Geometry ---------- */
  function rollGeo(pin, w, h) {
    const lane = pin.drumCount > 0 && pin.melodicCount > 0;
    const padX = w * 0.07, padT = h * 0.1, padB = h * 0.1;
    const laneH = lane ? h * 0.1 : 0, laneGap = lane ? h * 0.035 : 0;
    const innerW = w - padX * 2, innerH = h - padT - padB - laneH - laneGap;
    let [lo, hi] = pin.range;
    if (hi - lo + 1 < 16) {
      const extra = 16 - (hi - lo + 1);
      lo -= Math.floor(extra / 2);
      hi += Math.ceil(extra / 2);
    }
    const row = innerH / (hi - lo + 1);
    const th = MP.clamp(row * 0.8, 1.5, Math.max(3, w * 0.032));
    const D = pin.duration;
    const X = (t) => padX + (t / D) * innerW;
    const Y = (p) => padT + (hi - p) * row + row / 2;
    const laneTop = padT + innerH + laneGap;
    const shapes = pin.notes.map((n) => {
      if (n.ch === 9 && lane) return { dot: true, cx: X(n.t), cy: laneTop + laneH * (0.2 + drumLane(n.p) * 0.3), rad: MP.clamp((innerW / D) * 0.045, 1, laneH * 0.085) * (0.7 + n.v * 0.5) };
      const x = X(n.t), x2 = X(n.t + n.d);
      return { x, y: Y(n.p) - th / 2, w: Math.max(th, x2 - x - Math.min(th * 0.4, innerW * 0.004)), h: th, r: th / 2 };
    });
    const guides = [];
    for (let p = lo; p <= hi; p++) if (p % 12 === 0) guides.push({ y: Y(p), label: MP.pitchName(p) });
    return { type: 'roll', w, h, padX, padT, padB, innerW, innerH, X, Y, D, shapes, guides, bars: barMarks(pin, X, innerW, w), lane, laneTop, laneH, timeAt: (x) => MP.clamp((x - padX) / innerW, 0, 1) * D };
  }

  function barMarks(pin, X, span, w) {
    const bars = pin.bars;
    if (bars.length < 2) return [];
    const per = ((bars[bars.length - 1].t - bars[0].t) / (bars.length - 1) / pin.duration) * span;
    if (!(per > 0)) return [];
    const every = Math.max(1, Math.ceil((w * 0.035) / per));
    const out = [];
    for (let k = every; k < bars.length; k += every) if (bars[k].t > 0.01 && bars[k].t < pin.duration - 0.01) out.push({ pos: X(bars[k].t), bar: k + 1 });
    return out;
  }

  function orbitGeo(pin, w, h) {
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.5 * 0.84;
    const lane = pin.drumCount > 0 && pin.melodicCount > 0;
    const rOut = lane ? R * 0.86 : R, rIn = R * 0.3;
    let [lo, hi] = pin.range;
    if (hi - lo + 1 < 18) {
      const extra = 18 - (hi - lo + 1);
      lo -= Math.floor(extra / 2);
      hi += Math.ceil(extra / 2);
    }
    const ring = (rOut - rIn) / (hi - lo + 1);
    const lw = MP.clamp(ring * 0.78, 1.4, R * 0.06);
    const D = pin.duration, SWEEP = Math.PI * 2 * 0.96, A0 = -Math.PI / 2 + Math.PI * 0.04;
    const A = (t) => A0 + (t / D) * SWEEP;
    const Rp = (p) => rIn + (p - lo + 0.5) * ring;
    const shapes = pin.notes.map((n) => {
      if (n.ch === 9 && lane) {
        const r = rOut + (R - rOut) * (0.35 + (2 - drumLane(n.p)) * 0.33);
        const a = A(n.t);
        return { dot: true, cx: cx + Math.cos(a) * r, cy: cy + Math.sin(a) * r, rad: lw * 0.42 * (0.7 + n.v * 0.5) };
      }
      const r = Rp(n.p), cap = lw / 2 / r;
      let a0 = A(n.t) + cap, a1 = A(n.t + n.d) - cap;
      if (a1 - a0 < 0.6 / r) {
        const mid = (a0 + a1) / 2;
        a0 = mid - 0.3 / r;
        a1 = mid + 0.3 / r;
      }
      return { r, a0, a1 };
    });
    const guides = [];
    for (let p = lo; p <= hi; p++) if (p % 12 === 0) guides.push({ r: Rp(p), label: MP.pitchName(p) });
    const ticks = barMarks(pin, (t) => A(t), SWEEP * R, w).map((b) => b.pos);
    return {
      type: 'orbit', w, h, cx, cy, R, rIn, rOut, lw, A, A0, SWEEP, D, shapes, guides, ticks,
      timeAt(x, y) {
        let d = Math.atan2(y - cy, x - cx) - A0;
        while (d < 0) d += Math.PI * 2;
        while (d >= Math.PI * 2) d -= Math.PI * 2;
        return MP.clamp(d / SWEEP, 0, 1) * D;
      },
    };
  }

  const isBlack = (p) => [1, 3, 6, 8, 10].indexOf(MP.pc(p)) >= 0;
  function fallGeo(pin, w, h) {
    let lo = Math.floor(pin.range[0] / 12) * 12, hi = Math.floor(pin.range[1] / 12) * 12 + 11;
    while (hi - lo + 1 < 24) { if (lo > 36) lo -= 12; else hi += 12; }
    let whites = 0;
    for (let p = lo; p <= hi; p++) if (!isBlack(p)) whites++;
    const padX = w * 0.06, padT = h * 0.05, padB = h * 0.045;
    const kbH = h * 0.085, kbGap = h * 0.018;
    const innerW = w - padX * 2, ww = innerW / whites, bw = ww * 0.62;
    const keys = [];
    const keyOf = new Map();
    let wi = 0;
    for (let p = lo; p <= hi; p++) {
      const k = isBlack(p) ? { p, x: padX + wi * ww - bw / 2, w: bw, black: true } : { p, x: padX + wi++ * ww, w: ww, black: false };
      keys.push(k);
      keyOf.set(p, k);
    }
    const kbTop = h - padB - kbH, rollBottom = kbTop - kbGap, rollTop = padT, rollH = rollBottom - rollTop;
    const D = pin.duration;
    const Y = (t) => rollBottom - (t / D) * rollH;
    const gap = Math.min(rollH * 0.004, 2.5);
    const drumsOnly = pin.melodicCount === 0;
    const shapes = pin.notes.map((n) => {
      if (n.ch === 9 && !drumsOnly) return null;
      const k = keyOf.get(n.p);
      if (!k) return null;
      const nw = k.black ? bw * 0.84 : ww * 0.7;
      const y0 = Y(n.t + n.d), y1 = Y(n.t) - gap;
      return { x: k.x + (k.w - nw) / 2, y: y0, w: nw, h: Math.max(nw * 0.9, y1 - y0), r: nw / 2 };
    });
    return { type: 'fall', w, h, padX, padT, innerW, keys, keyOf, kbTop, kbH, rollTop, rollBottom, rollH, Y, D, ww, shapes, bars: barMarks(pin, (t) => Y(t), rollH, h), timeAt: (x, y) => MP.clamp((rollBottom - y) / rollH, 0, 1) * D };
  }

  function stepsParams(pin) {
    if (pin._steps) return pin._steps;
    const step = 60 / pin.bpm / 4, spb = pin.timeSig[0] * 4;
    const totalBars = Math.max(1, Math.ceil(pin.duration / (step * spb) - 0.02));
    const drumsOnly = pin.melodicCount === 0;
    const pool = pin.notes.filter((n) => drumsOnly || n.ch !== 9);
    const counts = new Map();
    for (const n of pool) counts.set(n.p, (counts.get(n.p) || 0) + 1);
    let lanes = Array.from(counts.keys());
    if (lanes.length > 28) lanes = lanes.sort((a, b) => counts.get(b) - counts.get(a)).slice(0, 28);
    if (drumsOnly) {
      const rank = (p) => (DRUM_ORDER.indexOf(p) < 0 ? 10 : DRUM_ORDER.indexOf(p));
      lanes.sort((a, b) => rank(a) - rank(b) || b - a);
    } else lanes.sort((a, b) => b - a);
    const bars = Math.min(totalBars, 8);
    let best = null;
    for (const bpl of [1, 2, 4, 8]) {
      if (bpl > bars && bpl > 1) continue;
      const lines = Math.ceil(bars / bpl), cols = bpl * spb;
      const aspect = (lines * lanes.length + (lines - 1) + 4) / (cols + 4);
      const score = Math.abs(Math.log(aspect / 0.92));
      if (!best || score < best.score) best = { bpl, lines, cols, aspect, score };
    }
    pin._steps = Object.assign(best, { step, spb, bars, lanes, drumsOnly, laneIndex: new Map(lanes.map((p, i) => [p, i])), loop: bars * spb * step });
    return pin._steps;
  }

  function stepsGeo(pin, w, h) {
    const P = stepsParams(pin);
    const nL = P.lanes.length;
    const cell = Math.min(w / (P.cols + 4), h / (P.lines * nL + (P.lines - 1) + 4));
    const lineH = (nL + 1) * cell;
    const ox = (w - P.cols * cell) / 2, oy = (h - (P.lines * lineH - cell)) / 2;
    const g = Math.max(0.5, cell * 0.12);
    const per = P.bpl * P.spb, total = P.bars * P.spb;
    const shapes = pin.notes.map((n) => {
      const lane = P.laneIndex.get(n.p);
      if (lane == null || (n.ch === 9 && !P.drumsOnly)) return null;
      const s = Math.round(n.t / P.step);
      if (s >= total) return null;
      const line = Math.floor(s / per), col = s - line * per;
      const len = MP.clamp(Math.round(n.d / P.step), 1, P.cols - col);
      return { x: ox + col * cell + g, y: oy + line * lineH + lane * cell + g, w: len * cell - 2 * g, h: cell - 2 * g, r: (cell - 2 * g) * 0.32, s0: s, s1: s + len };
    });
    return {
      type: 'steps', w, h, P, nL, cell, lineH, ox, oy, g, per, shapes,
      loopT: (t) => (P.loop > 0 ? t % P.loop : t),
      timeAt(x, y) {
        const line = MP.clamp(Math.floor((y - oy) / lineH), 0, P.lines - 1);
        const col = MP.clamp(Math.floor((x - ox) / cell), 0, P.cols - 1);
        return Math.min(pin.duration, (line * per + col) * P.step);
      },
    };
  }

  ART.geometry = function (pin, style, w, h) {
    const key = style + '|' + w + 'x' + h;
    let g = pin._geo.get(key);
    if (!g) {
      g = style === 'orbit' ? orbitGeo(pin, w, h) : style === 'fall' ? fallGeo(pin, w, h) : style === 'steps' ? stepsGeo(pin, w, h) : rollGeo(pin, w, h);
      if (pin._geo.size > 12) pin._geo.delete(pin._geo.keys().next().value);
      pin._geo.set(key, g);
    }
    return g;
  };

  /* ---------- Painting ---------- */
  function rr(path, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    path.moveTo(x + r, y);
    path.lineTo(x + w - r, y);
    path.arcTo(x + w, y, x + w, y + r, r);
    path.lineTo(x + w, y + h - r);
    path.arcTo(x + w, y + h, x + w - r, y + h, r);
    path.lineTo(x + r, y + h);
    path.arcTo(x, y + h, x, y + h - r, r);
    path.lineTo(x, y + r);
    path.arcTo(x, y, x + r, y, r);
    path.closePath();
  }
  function addShape(path, geo, s) {
    if (s.dot) {
      path.moveTo(s.cx + s.rad, s.cy);
      path.arc(s.cx, s.cy, s.rad, 0, Math.PI * 2);
    } else if (geo.type === 'orbit') {
      path.moveTo(geo.cx + Math.cos(s.a0) * s.r, geo.cy + Math.sin(s.a0) * s.r);
      path.arc(geo.cx, geo.cy, s.r, s.a0, s.a1);
    } else rr(path, s.x, s.y, s.w, s.h, s.r);
  }

  let grain = null;
  const grainFor = new WeakMap();
  function grainPattern(ctx) {
    if (!grain) {
      grain = document.createElement('canvas');
      grain.width = grain.height = 128;
      const g = grain.getContext('2d'), img = g.createImageData(128, 128);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }
    let p = grainFor.get(ctx);
    if (!p) grainFor.set(ctx, (p = ctx.createPattern(grain, 'repeat')));
    return p;
  }
  const monoFont = (px, weight) => (weight || 400) + ' ' + Math.round(px) + 'px "Martian Mono", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace';

  function paintBackground(ctx, pin, geo, theme, large) {
    const { w, h } = geo;
    const tonic = pin.key.tonic;
    const bg = ctx.createLinearGradient(0, 0, w * 0.4, h);
    bg.addColorStop(0, MP.rgba(MP.tintRgb(tonic, theme, 1)));
    bg.addColorStop(1, MP.rgba(MP.tintRgb(tonic, theme, -0.6)));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.globalAlpha = theme === 'dark' ? 0.05 : 0.04;
    ctx.globalCompositeOperation = theme === 'dark' ? 'screen' : 'multiply';
    ctx.fillStyle = grainPattern(ctx);
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    const ink = MP.inkRgb(tonic, theme);
    const hair = Math.max(1, w * 0.0022);
    if (geo.type === 'roll') {
      ctx.fillStyle = MP.rgba(ink, 0.045);
      for (const b of geo.bars) ctx.fillRect(b.pos - hair / 2, geo.padT * 0.7, hair, geo.innerH + geo.padT * 0.6);
      ctx.fillStyle = MP.rgba(ink, 0.08);
      for (const g of geo.guides) ctx.fillRect(geo.padX * 0.6, g.y - hair / 2, geo.innerW + geo.padX * 0.8, hair);
      if (geo.lane) {
        const p = new Path2D();
        rr(p, geo.padX * 0.6, geo.laneTop - geo.laneH * 0.08, geo.innerW + geo.padX * 0.8, geo.laneH * 1.0, geo.laneH * 0.3);
        ctx.fillStyle = MP.rgba(ink, 0.04);
        ctx.fill(p);
      }
      if (large) {
        ctx.font = monoFont(Math.max(10, w * 0.016));
        ctx.fillStyle = MP.rgba(ink, 0.42);
        ctx.textBaseline = 'middle';
        for (const g of geo.guides) ctx.fillText(g.label, geo.padX * 0.12, g.y);
        ctx.textBaseline = 'top';
        ctx.fillStyle = MP.rgba(ink, 0.32);
        for (const b of geo.bars) ctx.fillText(String(b.bar), b.pos + 4, geo.padT * 0.35);
      }
    } else if (geo.type === 'orbit') {
      ctx.strokeStyle = MP.rgba(ink, 0.075);
      ctx.lineWidth = hair;
      for (const g of geo.guides) {
        ctx.beginPath();
        ctx.arc(geo.cx, geo.cy, g.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.strokeStyle = MP.rgba(ink, 0.2);
      ctx.lineCap = 'round';
      for (const a of geo.ticks) {
        ctx.beginPath();
        ctx.moveTo(geo.cx + Math.cos(a) * geo.R * 1.06, geo.cy + Math.sin(a) * geo.R * 1.06);
        ctx.lineTo(geo.cx + Math.cos(a) * geo.R * 1.1, geo.cy + Math.sin(a) * geo.R * 1.1);
        ctx.stroke();
      }
      ctx.fillStyle = MP.rgba(ink, 0.35);
      ctx.beginPath();
      ctx.arc(geo.cx + Math.cos(geo.A0) * geo.R * 1.08, geo.cy + Math.sin(geo.A0) * geo.R * 1.08, Math.max(1.5, geo.R * 0.016), 0, Math.PI * 2);
      ctx.fill();
      // The label of a record: key colour at the spindle.
      ctx.fillStyle = MP.rgba(MP.tintRgb(tonic, theme, theme === 'dark' ? 2.2 : 1.6));
      ctx.beginPath();
      ctx.arc(geo.cx, geo.cy, geo.rIn * 0.74, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = pin.key.none ? MP.rgba(ink, 0.25) : MP.noteColor(tonic + 60, theme, 0.95);
      ctx.beginPath();
      ctx.arc(geo.cx, geo.cy, geo.rIn * (large ? 0.08 : 0.16), 0, Math.PI * 2);
      ctx.fill();
      if (large) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = MP.rgba(ink, 0.85);
        ctx.font = Math.round(geo.rIn * 0.24) + 'px "Instrument Serif", Georgia, serif';
        ctx.fillText(pin.key.none ? 'Drums' : MP.keyName(pin.key), geo.cx, geo.cy - geo.rIn * 0.24);
        ctx.font = monoFont(geo.rIn * 0.13);
        ctx.fillStyle = MP.rgba(ink, 0.5);
        ctx.fillText(Math.round(pin.bpm) + ' BPM', geo.cx, geo.cy + geo.rIn * 0.26);
        ctx.textAlign = 'left';
      }
    } else if (geo.type === 'fall') {
      ctx.fillStyle = MP.rgba(ink, 0.045);
      for (const b of geo.bars) ctx.fillRect(geo.padX, b.pos - hair / 2, geo.innerW, hair);
      ctx.fillStyle = MP.rgba(ink, 0.07);
      for (const k of geo.keys) if (k.p % 12 === 0) ctx.fillRect(k.x - hair / 2, geo.rollTop, hair, geo.rollH);
      paintKeyboard(ctx, geo, pin, theme, null);
    } else if (geo.type === 'steps') {
      const P = geo.P;
      const faint = new Path2D(), beat = new Path2D();
      for (let line = 0; line < P.lines; line++) {
        const colsHere = Math.min(P.cols, (P.bars - line * P.bpl) * P.spb);
        for (let lane = 0; lane < geo.nL; lane++)
          for (let c = 0; c < colsHere; c++) {
            const cs = geo.cell - 2 * geo.g;
            rr(c % 4 === 0 ? beat : faint, geo.ox + c * geo.cell + geo.g, geo.oy + line * geo.lineH + lane * geo.cell + geo.g, cs, cs, cs * 0.32);
          }
      }
      ctx.fillStyle = MP.rgba(ink, theme === 'dark' ? 0.07 : 0.055);
      ctx.fill(faint);
      ctx.fillStyle = MP.rgba(ink, theme === 'dark' ? 0.11 : 0.09);
      ctx.fill(beat);
      if (large && P.drumsOnly && geo.ox > geo.cell * 3) {
        ctx.font = monoFont(Math.min(geo.cell * 0.62, w * 0.014));
        ctx.fillStyle = MP.rgba(ink, 0.45);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        P.lanes.forEach((p, i) => ctx.fillText(DRUM_NAMES[p] || String(p), geo.ox - geo.cell * 0.5, geo.oy + i * geo.cell + geo.cell / 2));
        ctx.textAlign = 'left';
      }
    }
  }

  function paintKeyboard(ctx, geo, pin, theme, lit) {
    const r = Math.max(1.5, geo.ww * 0.18), gap = Math.max(1, geo.ww * 0.08);
    const white = theme === 'dark' ? MP.oklch(0.86, 0.012, MP.hueOf(pin.key.tonic)) : [255, 255, 255];
    const black = theme === 'dark' ? MP.oklch(0.17, 0.02, MP.hueOf(pin.key.tonic)) : MP.oklch(0.27, 0.025, MP.hueOf(pin.key.tonic));
    for (const k of geo.keys) {
      if (k.black) continue;
      const p = new Path2D();
      rr(p, k.x + gap / 2, geo.kbTop, k.w - gap, geo.kbH, r);
      const on = lit && lit.get(k.p);
      ctx.fillStyle = on ? MP.rgba(on, 1) : MP.rgba(white, theme === 'dark' ? 0.92 : 0.95);
      ctx.fill(p);
    }
    for (const k of geo.keys) {
      if (!k.black) continue;
      const p = new Path2D();
      rr(p, k.x, geo.kbTop - 0.5, k.w, geo.kbH * 0.6, r * 0.8);
      const on = lit && lit.get(k.p);
      ctx.fillStyle = on ? MP.rgba(on, 1) : MP.rgba(black, 1);
      ctx.fill(p);
    }
  }

  function paintNotes(ctx, pin, geo, theme) {
    const groups = new Map();
    const drumInk = MP.rgba(MP.inkRgb(pin.key.tonic, theme), 0.42);
    const notes = pin.notes;
    for (let i = 0; i < notes.length; i++) {
      const s = geo.shapes[i];
      if (!s) continue;
      const n = notes[i];
      const lv = n.v > 0.66 ? 2 : n.v > 0.4 ? 1 : 0;
      const k = (s.dot ? 'd' : n.p) + ':' + lv;
      let gr = groups.get(k);
      if (!gr) groups.set(k, (gr = { path: new Path2D(), dot: !!s.dot, color: s.dot ? drumInk : MP.noteColor(n.p, theme, [0.6, 0.8, 1][lv]) }));
      addShape(gr.path, geo, s);
    }
    ctx.lineCap = 'round';
    for (const gr of groups.values()) {
      if (geo.type === 'orbit' && !gr.dot) {
        ctx.strokeStyle = gr.color;
        ctx.lineWidth = geo.lw;
        ctx.stroke(gr.path);
      } else {
        ctx.fillStyle = gr.color;
        ctx.fill(gr.path);
      }
    }
  }

  function clipPlayed(ctx, geo, t) {
    ctx.beginPath();
    if (geo.type === 'roll') ctx.rect(0, 0, geo.X(t), geo.h);
    else if (geo.type === 'fall') ctx.rect(0, geo.Y(t), geo.w, geo.h);
    else if (geo.type === 'orbit') {
      if (t > 0) {
        ctx.moveTo(geo.cx, geo.cy);
        ctx.arc(geo.cx, geo.cy, geo.R * 2, geo.A0 - 0.12, geo.A(t));
        ctx.closePath();
      } else ctx.rect(0, 0, 0, 0);
    } else if (geo.type === 'steps') {
      const s = Math.floor(geo.loopT(t) / geo.P.step);
      const line = Math.floor(s / geo.per), col = s - line * geo.per;
      const top = geo.oy + line * geo.lineH;
      ctx.rect(0, 0, geo.w, top);
      ctx.rect(0, top, geo.ox + (col + 1) * geo.cell, geo.lineH);
    }
    ctx.clip();
  }

  function drawPlayhead(ctx, geo, t, theme, alpha) {
    const ink = theme === 'dark' ? [255, 255, 255] : [16, 17, 24];
    const lw = Math.max(1.5, geo.w * 0.0042);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (geo.type === 'roll' || geo.type === 'fall') {
      const vertical = geo.type === 'roll';
      const pos = vertical ? geo.X(t) : geo.Y(t);
      const band = (vertical ? geo.w : geo.h) * 0.08;
      const g = vertical ? ctx.createLinearGradient(pos - band, 0, pos, 0) : ctx.createLinearGradient(0, pos + band, 0, pos);
      g.addColorStop(0, MP.rgba(ink, 0));
      g.addColorStop(1, MP.rgba(ink, theme === 'dark' ? 0.1 : 0.07));
      ctx.fillStyle = g;
      if (vertical) ctx.fillRect(pos - band, 0, band, geo.h);
      else ctx.fillRect(0, pos, geo.w, Math.min(band, geo.rollBottom - pos));
      ctx.fillStyle = MP.rgba(ink, 0.7);
      if (vertical) ctx.fillRect(pos - lw / 2, geo.padT * 0.45, lw, geo.h - geo.padT * 0.45 - geo.padB * 0.45);
      else ctx.fillRect(geo.padX * 0.5, pos - lw / 2, geo.w - geo.padX, lw);
    } else if (geo.type === 'orbit') {
      const a = geo.A(t);
      ctx.strokeStyle = MP.rgba(ink, 0.55);
      ctx.lineWidth = lw * 1.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(geo.cx, geo.cy, geo.R * 1.08, geo.A0, a);
      ctx.stroke();
      ctx.strokeStyle = MP.rgba(ink, 0.7);
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(geo.cx + Math.cos(a) * geo.rIn * 0.8, geo.cy + Math.sin(a) * geo.rIn * 0.8);
      ctx.lineTo(geo.cx + Math.cos(a) * geo.R * 1.08, geo.cy + Math.sin(a) * geo.R * 1.08);
      ctx.stroke();
      ctx.fillStyle = MP.rgba(ink, 0.9);
      ctx.beginPath();
      ctx.arc(geo.cx + Math.cos(a) * geo.R * 1.08, geo.cy + Math.sin(a) * geo.R * 1.08, lw * 1.9, 0, Math.PI * 2);
      ctx.fill();
    } else if (geo.type === 'steps') {
      const s = Math.floor(geo.loopT(t) / geo.P.step);
      const line = Math.floor(s / geo.per), col = s - line * geo.per;
      const p = new Path2D();
      rr(p, geo.ox + col * geo.cell, geo.oy + line * geo.lineH - geo.cell * 0.25, geo.cell, geo.nL * geo.cell + geo.cell * 0.5, geo.cell * 0.5);
      ctx.fillStyle = MP.rgba(ink, theme === 'dark' ? 0.16 : 0.1);
      ctx.fill(p);
    }
    ctx.restore();
  }

  /* Notes sounding at time t. */
  function eachActive(pin, geo, t, fn) {
    const notes = pin.notes;
    if (geo.type === 'steps') {
      const s = Math.floor(geo.loopT(t) / geo.P.step);
      for (let i = 0; i < notes.length; i++) {
        const sh = geo.shapes[i];
        if (sh && s >= sh.s0 && s < sh.s1) fn(i, notes[i], (s - sh.s0) * geo.P.step + (geo.loopT(t) % geo.P.step));
      }
      return;
    }
    let lo = 0, hi = notes.length - 1, last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].t <= t) { last = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (let i = last, seen = 0; i >= 0 && seen < 600; i--, seen++) {
      const n = notes[i];
      if (n.t < t - pin.maxDur - 0.01) break;
      if (t < n.t + n.d) fn(i, n, t - n.t);
    }
  }
  ART.activePitchClasses = function (pin, t, out) {
    out.fill(0);
    let lo = 0, hi = pin.notes.length - 1, last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pin.notes[mid].t <= t) { last = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (let i = last, seen = 0; i >= 0 && seen < 400; i--, seen++) {
      const n = pin.notes[i];
      if (n.t < t - pin.maxDur - 0.01) break;
      if (n.ch !== 9 && t < n.t + n.d) out[n.p % 12] = Math.max(out[n.p % 12], n.v * (1 - Math.min(0.6, (t - n.t) / (n.d * 2 + 0.2))));
    }
    return out;
  };

  function drawActive(ctx, pin, geo, t, theme) {
    const glow = Math.max(5, geo.w * 0.03);
    const lit = geo.type === 'fall' ? new Map() : null;
    ctx.save();
    ctx.lineCap = 'round';
    eachActive(pin, geo, t, (i, n, age) => {
      const s = geo.shapes[i];
      if (!s) return;
      const strike = MP.clamp(1 - age / 0.22, 0, 1);
      const c = s.dot && !(geo.type === 'steps') ? MP.inkRgb(pin.key.tonic, theme) : MP.noteRgb(n.p, theme, 0.06 + strike * 0.08);
      const path = new Path2D();
      addShape(path, geo, s);
      ctx.shadowColor = MP.rgba(c, 0.85);
      ctx.shadowBlur = glow * (0.55 + strike * 0.9);
      if (geo.type === 'orbit' && !s.dot) {
        ctx.strokeStyle = MP.rgba(c, 1);
        ctx.lineWidth = geo.lw * (1 + strike * 0.35);
        ctx.stroke(path);
      } else {
        ctx.fillStyle = MP.rgba(c, 1);
        ctx.fill(path);
      }
      if (strike > 0) {
        ctx.shadowBlur = 0;
        const w = MP.rgba([255, 255, 255], strike * (theme === 'dark' ? 0.5 : 0.42));
        if (geo.type === 'orbit' && !s.dot) { ctx.strokeStyle = w; ctx.stroke(path); }
        else { ctx.fillStyle = w; ctx.fill(path); }
      }
      if (lit) lit.set(n.p, MP.noteRgb(n.p, theme, 0.04));
    });
    ctx.restore();
    if (lit && lit.size) paintKeyboard(ctx, geo, pin, theme, lit);
  }

  /* ---------- Layer cache for animated frames ---------- */
  const layers = new Map();
  function getLayers(pin, style, W, H, theme, large) {
    const key = pin.id + '|' + style + '|' + W + 'x' + H + '|' + theme + (large ? '|L' : '');
    let L = layers.get(key);
    if (L) {
      layers.delete(key);
      layers.set(key, L);
      return L;
    }
    const geo = ART.geometry(pin, style, W, H);
    const bg = document.createElement('canvas'), notes = document.createElement('canvas');
    bg.width = notes.width = W;
    bg.height = notes.height = H;
    paintBackground(bg.getContext('2d'), pin, geo, theme, large);
    paintNotes(notes.getContext('2d'), pin, geo, theme);
    L = { geo, bg, notes };
    layers.set(key, L);
    while (layers.size > 18) layers.delete(layers.keys().next().value);
    return L;
  }
  ART.forget = function (pin) {
    for (const k of Array.from(layers.keys())) if (k.indexOf(pin.id + '|') === 0) layers.delete(k);
    pin._geo.clear();
    pin._steps = null;
  };

  /*
   * Draw a pin into a canvas.
   * o.mode: 'rest' (still) or 'live' (progress at o.t)
   * o.future: opacity of notes not yet reached; o.active: light sounding notes; o.playhead: 0..1
   */
  ART.draw = function (canvas, pin, o) {
    o = o || {};
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    const style = o.style || pin.style, theme = o.theme || MP.theme();
    const ctx = canvas.getContext('2d');
    if (o.mode !== 'live') {
      const geo = ART.geometry(pin, style, W, H);
      paintBackground(ctx, pin, geo, theme, o.large);
      paintNotes(ctx, pin, geo, theme);
      return geo;
    }
    const L = getLayers(pin, style, W, H, theme, o.large);
    ctx.drawImage(L.bg, 0, 0);
    if (o.future > 0) {
      ctx.globalAlpha = o.future;
      ctx.drawImage(L.notes, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.save();
    clipPlayed(ctx, L.geo, o.t);
    ctx.drawImage(L.notes, 0, 0);
    ctx.restore();
    if (o.active) drawActive(ctx, pin, L.geo, o.t, theme);
    if (o.playhead > 0) drawPlayhead(ctx, L.geo, o.t, theme, o.playhead);
    return L.geo;
  };

  /* Density timeline: a waveform for MIDI, each bar colored by the pitch that dominates it. */
  ART.timeline = function (canvas, pin, progress, theme, hover) {
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    const N = Math.max(24, Math.min(140, Math.floor(W / (6 * ART.DPR()))));
    if (!pin._bins || pin._bins.length !== N) {
      const bins = Array.from({ length: N }, () => ({ e: 0, pcs: new Array(12).fill(0) }));
      const span = pin.duration / N;
      for (const n of pin.notes) {
        const a = Math.floor(n.t / span), b = Math.min(N - 1, Math.floor((n.t + Math.min(n.d, 2)) / span));
        for (let i = a; i <= b; i++) {
          bins[i].e += n.v * (n.ch === 9 ? 0.5 : 1);
          bins[i].pcs[n.p % 12] += n.v;
        }
      }
      const max = Math.max.apply(null, bins.map((b) => b.e)) || 1;
      pin._bins = bins.map((b) => ({ e: Math.sqrt(b.e / max), pc: b.pcs.indexOf(Math.max.apply(null, b.pcs)) }));
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const bw = W / N, gap = bw * 0.38, cw = bw - gap;
    for (let i = 0; i < N; i++) {
      const b = pin._bins[i];
      const hh = Math.max(cw, b.e * H * 0.92);
      const played = (i + 0.5) / N <= progress;
      const near = hover != null && Math.abs((i + 0.5) / N - hover) < 0.5 / N;
      const p = new Path2D();
      rr(p, i * bw + gap / 2, (H - hh) / 2, cw, hh, cw / 2);
      ctx.fillStyle = MP.noteColor(b.pc + 60, theme, played ? 1 : near ? 0.75 : 0.3);
      ctx.fill(p);
    }
  };
  /* ---------- Score: a scrolling piano roll that follows time ---------- */
  const audible = (pin, part) => (!pin.mix ? true : pin.mix.solo.size ? pin.mix.solo.has(part) : !pin.mix.mute.has(part));
  function firstNoteFrom(notes, t) {
    let lo = 0, hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /*
   * o.t: time at the playhead · o.span: seconds visible · o.at: playhead position 0..1
   * o.ruler: bar numbers and markers along the top · o.labels: octave names · o.fade: dissolve the edges
   */
  ART.score = function (canvas, pin, o) {
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    const ctx = canvas.getContext('2d');
    const theme = o.theme || MP.theme(), dpr = ART.DPR();
    const span = o.span || 12, at = o.at == null ? 0.3 : o.at;
    const t0 = o.t - span * at, t1 = t0 + span;
    const X = (t) => ((t - t0) / span) * W;
    const ink = theme === 'dark' ? [238, 233, 224] : [20, 19, 17];
    ctx.clearRect(0, 0, W, H);

    const top = o.ruler ? 30 * dpr : H * 0.08, bottom = H - (o.ruler ? 12 * dpr : H * 0.08);
    const lane = pin.drumCount && pin.melodicCount ? Math.min(26 * dpr, (bottom - top) * 0.12) : 0;
    const rollBottom = bottom - lane - (lane ? 8 * dpr : 0);
    let [lo, hi] = pin.range;
    if (hi - lo + 1 < 24) {
      const extra = 24 - (hi - lo + 1);
      lo -= Math.floor(extra / 2);
      hi += Math.ceil(extra / 2);
    }
    lo -= 1;
    hi += 1;
    const row = (rollBottom - top) / (hi - lo + 1);
    const th = MP.clamp(row * 0.8, 1.5 * dpr, 10 * dpr);
    const Y = (p) => top + (hi - p + 0.5) * row;

    // Octave guides
    ctx.fillStyle = MP.rgba(ink, theme === 'dark' ? 0.05 : 0.07);
    for (let p = lo; p <= hi; p++) if (p % 12 === 0) ctx.fillRect(0, Math.round(Y(p) + row / 2), W, Math.max(1, dpr * 0.75));
    if (o.labels) {
      ctx.font = monoFont(9 * dpr);
      ctx.fillStyle = MP.rgba(ink, 0.32);
      ctx.textBaseline = 'middle';
      for (let p = lo; p <= hi; p++) if (p % 12 === 0) ctx.fillText(MP.pitchName(p), 8 * dpr, Y(p));
    }

    // Bars, numbered along a ruler
    const bars = pin.bars;
    let bi = 0;
    {
      let a = 0, b = bars.length - 1;
      while (a < b) {
        const mid = (a + b) >> 1;
        if (bars[mid].t < t0) a = mid + 1; else b = mid;
      }
      bi = Math.max(0, a - 1);
    }
    const barW = bars.length > 1 ? (((bars[bars.length - 1].t - bars[0].t) / (bars.length - 1)) / span) * W : W;
    const labelEvery = Math.max(1, Math.ceil((34 * dpr) / Math.max(1, barW)));
    ctx.font = monoFont(9 * dpr);
    ctx.textBaseline = 'alphabetic';
    for (let i = bi; i < bars.length && bars[i].t <= t1; i++) {
      const x = Math.round(X(bars[i].t));
      if (x < -2) continue;
      const strong = i % 4 === 0;
      ctx.fillStyle = MP.rgba(ink, strong ? 0.085 : 0.045);
      ctx.fillRect(x, top, Math.max(1, dpr * 0.75), rollBottom - top);
      if (o.ruler && i % labelEvery === 0) {
        ctx.fillStyle = MP.rgba(ink, strong ? 0.5 : 0.3);
        ctx.fillRect(x, top - 8 * dpr, Math.max(1, dpr * 0.75), 5 * dpr);
        ctx.fillText(String(i + 1), x + 4 * dpr, top - 4 * dpr);
      }
    }
    if (o.ruler && pin.markers.length) {
      ctx.font = monoFont(9 * dpr, 500);
      for (const m of pin.markers) {
        if (m.t < t0 - span || m.t > t1) continue;
        const x = X(m.t);
        ctx.fillStyle = MP.rgba(ink, 0.75);
        ctx.fillText(m.text.toUpperCase(), Math.max(x, 0) + 4 * dpr, top - 17 * dpr);
      }
    }

    // Notes
    const notes = pin.notes;
    const glow = [];
    const drumInk = MP.rgba(ink, 0.55);
    for (let i = firstNoteFrom(notes, t0 - pin.maxDur); i < notes.length; i++) {
      const n = notes[i];
      if (n.t > t1) break;
      if (n.t + n.d < t0) continue;
      const on = audible(pin, n.part);
      const active = n.t <= o.t && o.t < n.t + n.d;
      const past = n.t + n.d <= o.t;
      if (n.ch === 9 && lane) {
        const x = X(n.t);
        const y = rollBottom + 8 * dpr + lane * (0.2 + drumLane(n.p) * 0.3);
        ctx.fillStyle = on ? (active ? MP.rgba(ink, 1) : past ? MP.rgba(ink, 0.25) : drumInk) : MP.rgba(ink, 0.08);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.2 * dpr, lane * 0.08) * (0.7 + n.v * 0.5) * (active ? 1.4 : 1), 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const x0 = X(n.t), x1 = X(n.t + n.d);
      const w = Math.max(th, x1 - x0 - dpr);
      const alpha = !on ? 0.09 : active ? 1 : past ? 0.32 : 0.8 * (0.6 + n.v * 0.4);
      ctx.fillStyle = MP.noteColor(n.p, theme, alpha, active ? 0.08 : 0);
      ctx.beginPath();
      roundRect(ctx, x0, Y(n.p) - th / 2, w, th, th / 2);
      ctx.fill();
      if (active && on) glow.push(n);
    }
    if (glow.length) {
      ctx.save();
      for (const n of glow) {
        const x0 = X(n.t), w = Math.max(th, X(n.t + n.d) - x0 - dpr);
        const c = MP.noteRgb(n.p, theme, 0.12);
        const strike = MP.clamp(1 - (o.t - n.t) / 0.25, 0, 1);
        ctx.shadowColor = MP.rgba(c, 0.9);
        ctx.shadowBlur = (10 + strike * 14) * dpr;
        ctx.fillStyle = MP.rgba(c, 1);
        ctx.beginPath();
        roundRect(ctx, x0, Y(n.p) - th / 2, w, th, th / 2);
        ctx.fill();
        if (strike > 0) {
          ctx.shadowBlur = 0;
          ctx.fillStyle = MP.rgba([255, 255, 255], strike * 0.55);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Playhead
    const px = Math.round(at * W);
    const bw = 140 * dpr;
    const band = ctx.createLinearGradient(px - bw, 0, px, 0);
    band.addColorStop(0, MP.rgba(ink, 0));
    band.addColorStop(0.7, MP.rgba(ink, theme === 'dark' ? 0.012 : 0.01));
    band.addColorStop(1, MP.rgba(ink, theme === 'dark' ? 0.045 : 0.04));
    ctx.save();
    ctx.fillStyle = band;
    ctx.fillRect(px - bw, top, bw, rollBottom - top);
    ctx.restore();
    ctx.fillStyle = MP.rgba(ink, 0.7);
    ctx.fillRect(px - dpr * 0.75, top - (o.ruler ? 10 * dpr : 0), dpr * 1.5, bottom - top + (o.ruler ? 10 * dpr : 0));
    if (o.ruler) {
      ctx.beginPath();
      ctx.moveTo(px - 5 * dpr, top - 12 * dpr);
      ctx.lineTo(px + 5 * dpr, top - 12 * dpr);
      ctx.lineTo(px, top - 5 * dpr);
      ctx.closePath();
      ctx.fill();
    }

    if (o.fade) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      const fw = Math.min(W * 0.14, 220 * dpr);
      let g = ctx.createLinearGradient(0, 0, fw, 0);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, fw, H);
      g = ctx.createLinearGradient(W - fw, 0, W, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = g;
      ctx.fillRect(W - fw, 0, fw, H);
      ctx.restore();
    }
  };

  /* Activity per part at time t, used for the mixer LEDs. A fresh note flashes brighter. */
  ART.activeParts = function (pin, t, out) {
    out.fill(0);
    const notes = pin.notes;
    let i = firstNoteFrom(notes, t + 1e-6) - 1;
    for (let seen = 0; i >= 0 && seen < 900; i--, seen++) {
      const n = notes[i];
      if (n.t < t - pin.maxDur - 0.01) break;
      if (t < n.t + Math.max(n.d, 0.12)) {
        const strike = MP.clamp(1 - (t - n.t) / 0.3, 0, 1);
        const lv = n.v * (0.35 + 0.65 * strike);
        if (lv > out[n.part]) out[n.part] = lv;
      }
    }
    return out;
  };

  /* Where each part plays across the song, as a small bar chart. */
  ART.partBins = function (pin, N) {
    if (pin._pb && pin._pb.N === N) return pin._pb.bins;
    const bins = pin.parts.map(() => new Float32Array(N));
    for (const n of pin.notes) {
      const a = Math.min(N - 1, Math.floor((n.t / pin.duration) * N));
      const b = Math.min(N - 1, Math.floor(((n.t + Math.min(n.d, 4)) / pin.duration) * N));
      for (let k = a; k <= b; k++) bins[n.part][k] += n.v;
    }
    for (const arr of bins) {
      let max = 0;
      for (const v of arr) max = Math.max(max, v);
      if (max) for (let k = 0; k < N; k++) arr[k] = Math.sqrt(arr[k] / max);
    }
    pin._pb = { N, bins };
    return bins;
  };
  ART.sparkline = function (canvas, pin, part, progress, theme, color) {
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    const dpr = ART.DPR();
    const N = Math.max(16, Math.floor(W / (3 * dpr)));
    const bins = ART.partBins(pin, N)[part];
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const bw = W / N;
    for (let k = 0; k < N; k++) {
      const v = bins[k];
      if (v <= 0) continue;
      const hh = Math.max(dpr, v * H);
      ctx.fillStyle = MP.rgba(color, (k + 0.5) / N <= progress ? 1 : 0.32);
      ctx.fillRect(k * bw + bw * 0.18, (H - hh) / 2, Math.max(dpr, bw * 0.64), hh);
    }
  };
  ART.partColor = function (pin, part, theme) {
    const p = pin.parts[part];
    if (!p || p.drums) return theme === 'dark' ? [238, 233, 224] : [20, 19, 17];
    return MP.noteRgb(60 + p.pc, theme);
  };
})();
