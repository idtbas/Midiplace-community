/* Midiplace — a small Web Audio synth and a lookahead player for MIDI notes. */
(function () {
  'use strict';
  const MP = window.MP;
  const A = (MP.audio = {});

  let ctx = null, comp = null, reverb = null, noise = null;

  A.ensure = function () {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC({ latencyHint: 'interactive' });
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 14;
      comp.ratio.value = 3.2;
      comp.attack.value = 0.004;
      comp.release.value = 0.25;
      const out = ctx.createGain();
      out.gain.value = 0.92;
      comp.connect(out).connect(ctx.destination);
      reverb = ctx.createConvolver();
      reverb.buffer = impulse(2.8);
      const wet = ctx.createGain();
      wet.gain.value = 0.3;
      reverb.connect(wet).connect(comp);
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  A.now = () => (ctx ? ctx.currentTime : 0);

  /* A plate-like reverb: decaying noise that darkens as it fades. */
  function impulse(seconds) {
    const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const k = 0.75 * (1 - t) + 0.06;
        lp += k * (Math.random() * 2 - 1 - lp);
        d[i] = lp * Math.pow(1 - t, 2.6) * (i < rate * 0.01 ? i / (rate * 0.01) : 1);
      }
    }
    return buf;
  }

  function bus() {
    const dry = ctx.createGain(), wet = ctx.createGain();
    dry.connect(comp);
    wet.connect(reverb);
    return {
      dry, wet,
      release(tc) {
        const t = ctx.currentTime;
        for (const g of [dry, wet]) {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(g.gain.value, t);
          g.gain.setTargetAtTime(0, t, tc);
        }
        setTimeout(() => { dry.disconnect(); wet.disconnect(); }, tc * 9000 + 200);
      },
    };
  }

  const freq = (p) => 440 * Math.pow(2, (p - 69) / 12);
  const osc = (type, f, when) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, when);
    return o;
  };
  const gain = (v) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  /* Attack, decay toward a sustain level, release after the note ends. Returns the stop time. */
  function adsr(param, when, end, peak, a, d, s, r) {
    param.setValueAtTime(0.0001, when);
    param.linearRampToValueAtTime(peak, when + a);
    param.setTargetAtTime(peak * s, when + a, d);
    const rel = Math.max(end, when + a);
    param.setTargetAtTime(0.0001, rel, r);
    return rel + r * 7;
  }
  function route(b, node, send) {
    node.connect(b.dry);
    const s = gain(send);
    node.connect(s);
    s.connect(b.wet);
  }
  function run(nodes, when, stopAt) {
    for (const n of nodes) {
      n.start(when);
      n.stop(stopAt);
    }
  }

  const VOICES = {
    keys(b, when, dur, p, v) {
      const f = freq(p), end = when + dur;
      const car = osc('sine', f, when), mod = osc('sine', f, when), mg = gain(0);
      mg.gain.setValueAtTime(f * (0.7 + v * 1.5), when);
      mg.gain.setTargetAtTime(f * 0.1, when, 0.3);
      mod.connect(mg).connect(car.frequency);
      const tine = osc('sine', f * 4, when), tg = gain(0);
      tg.gain.setValueAtTime(0.0001, when);
      tg.gain.linearRampToValueAtTime(0.05 * v, when + 0.003);
      tg.gain.setTargetAtTime(0.0001, when + 0.003, 0.06);
      const amp = gain(0);
      const tilt = MP.clamp(1.1 - (p - 60) / 70, 0.55, 1.25);
      const stop = adsr(amp.gain, when, end, 0.2 * (0.3 + v * 0.8) * tilt, 0.004, 0.5 + Math.max(0, 84 - p) * 0.03, 0.18, 0.14);
      car.connect(amp);
      tine.connect(tg).connect(amp);
      route(b, amp, 0.26);
      run([car, mod, tine], when, stop);
      return stop;
    },
    pad(b, when, dur, p, v) {
      const f = freq(p), end = when + dur;
      const o1 = osc('sawtooth', f, when), o2 = osc('sawtooth', f, when), sub = osc('triangle', f / 2, when);
      o1.detune.value = -9;
      o2.detune.value = 8;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.5;
      lp.frequency.setValueAtTime(280, when);
      lp.frequency.linearRampToValueAtTime(Math.min(4200, f * 4 + 700), when + 0.9);
      lp.frequency.setTargetAtTime(f * 2 + 500, when + 0.9, 1.4);
      const sg = gain(0.35);
      o1.connect(lp); o2.connect(lp); sub.connect(sg).connect(lp);
      const amp = gain(0);
      const stop = adsr(amp.gain, when, end, 0.06 * (0.45 + v * 0.7), 0.5, 1.2, 0.85, 0.9);
      lp.connect(amp);
      route(b, amp, 0.6);
      run([o1, o2, sub], when, stop);
      return stop;
    },
    pluck(b, when, dur, p, v, warm) {
      const f = freq(p), end = when + Math.min(dur, warm ? 0.5 : 1.2);
      const o = osc('triangle', f, when), o2 = osc('sine', f * 2, when);
      const g2 = gain(0.22);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(Math.min(warm ? 3000 : 9000, f * 9), when);
      lp.frequency.setTargetAtTime(f * 1.4 + 200, when, warm ? 0.06 : 0.14);
      o.connect(lp); o2.connect(g2).connect(lp);
      const amp = gain(0);
      const stop = adsr(amp.gain, when, end, 0.22 * (0.35 + v * 0.75), 0.003, warm ? 0.18 : 0.32, 0.0, 0.12);
      lp.connect(amp);
      route(b, amp, warm ? 0.32 : 0.38);
      run([o, o2], when, stop);
      return stop;
    },
    pizz(b, when, dur, p, v) {
      return VOICES.pluck(b, when, dur, p, v, true);
    },
    bell(b, when, dur, p, v) {
      const f = freq(p), end = when + Math.min(dur, 0.25);
      const o = osc('sine', f, when), o2 = osc('sine', f * 3.01, when), o3 = osc('sine', f * 5.4, when);
      const g2 = gain(0.0), g3 = gain(0.0);
      g2.gain.setValueAtTime(0.32, when);
      g2.gain.setTargetAtTime(0.0001, when, 0.4);
      g3.gain.setValueAtTime(0.12, when);
      g3.gain.setTargetAtTime(0.0001, when, 0.12);
      const amp = gain(0);
      const stop = adsr(amp.gain, when, end, 0.16 * (0.35 + v * 0.75), 0.002, 0.9, 0.05, 0.9);
      o.connect(amp); o2.connect(g2).connect(amp); o3.connect(g3).connect(amp);
      route(b, amp, 0.5);
      run([o, o2, o3], when, stop);
      return stop;
    },
    chip(b, when, dur, p, v) {
      const f = freq(p), end = when + dur;
      const o = osc('square', f, when);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 5200;
      const amp = gain(0);
      const stop = adsr(amp.gain, when, end, 0.05 * (0.5 + v * 0.6), 0.002, 0.12, 0.72, 0.025);
      o.connect(lp).connect(amp);
      route(b, amp, 0.14);
      run([o], when, stop);
      return stop;
    },
    chipbass(b, when, dur, p, v) {
      const f = freq(p), end = when + dur;
      const o = osc('triangle', f, when);
      const amp = gain(0);
      const stop = adsr(amp.gain, when, end, 0.2 * (0.5 + v * 0.6), 0.002, 0.2, 0.9, 0.025);
      o.connect(amp);
      route(b, amp, 0.05);
      run([o], when, stop);
      return stop;
    },
    bass(b, when, dur, p, v) {
      const f = freq(p), end = when + dur;
      const o = osc('sawtooth', f, when), sub = osc('sine', f, when);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 3;
      lp.frequency.setValueAtTime(Math.min(2400, f * 12), when);
      lp.frequency.setTargetAtTime(f * 2.5 + 120, when, 0.1);
      const sg = gain(0.7);
      const amp = gain(0);
      const stop = adsr(amp.gain, when, end, 0.15 * (0.45 + v * 0.7), 0.005, 0.35, 0.7, 0.06);
      o.connect(lp).connect(amp);
      sub.connect(sg).connect(amp);
      route(b, amp, 0.06);
      run([o, sub], when, stop);
      return stop;
    },
    strings(b, when, dur, p, v) {
      const f = freq(p), end = when + dur;
      const os = [-11, 0, 10].map((cents) => {
        const o = osc('sawtooth', f, when);
        o.detune.value = cents;
        return o;
      });
      const lfo = osc('sine', 5.3, when), depth = gain(0);
      depth.gain.setValueAtTime(0, when);
      depth.gain.linearRampToValueAtTime(6, when + 0.5);
      lfo.connect(depth);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(3200, f * 5 + 600);
      lp.Q.value = 0.4;
      for (const o of os) { depth.connect(o.detune); o.connect(lp); }
      const amp = gain(0);
      const stop = adsr(amp.gain, when, end, 0.042 * (0.45 + v * 0.75), 0.32, 0.8, 0.88, 0.55);
      lp.connect(amp);
      route(b, amp, 0.55);
      run(os.concat([lfo]), when, stop);
      return stop;
    },
    organ(b, when, dur, p, v) {
      const f = freq(p), end = when + dur;
      // Three drawbars: fundamental, octave and twelfth, with a gentle key click.
      const os = [[1, 0.5], [2, 0.32], [3, 0.18]].map(([m, g]) => {
        const o = osc('sine', f * m, when), gg = gain(g);
        o.connect(gg);
        return [o, gg];
      });
      const amp = gain(0);
      const stop = adsr(amp.gain, when, end, 0.1 * (0.5 + v * 0.5), 0.008, 0.2, 0.95, 0.06);
      for (const [, gg] of os) gg.connect(amp);
      route(b, amp, 0.32);
      run(os.map((x) => x[0]), when, stop);
      return stop;
    },
    brass(b, when, dur, p, v) {
      const f = freq(p), end = when + dur;
      const o = osc('sawtooth', f, when), o2 = osc('sawtooth', f, when);
      o2.detune.value = 6;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 1.2;
      lp.frequency.setValueAtTime(f * 1.2, when);
      lp.frequency.linearRampToValueAtTime(Math.min(5000, f * (3 + v * 4)), when + 0.08);
      lp.frequency.setTargetAtTime(f * 2.5, when + 0.08, 0.3);
      const amp = gain(0);
      const stop = adsr(amp.gain, when, end, 0.07 * (0.45 + v * 0.7), 0.05, 0.4, 0.8, 0.12);
      o.connect(lp); o2.connect(lp); lp.connect(amp);
      route(b, amp, 0.3);
      run([o, o2], when, stop);
      return stop;
    },
    lead(b, when, dur, p, v) {
      const f = freq(p), end = when + dur;
      const o = osc('sine', f, when), o2 = osc('triangle', f, when);
      const lfo = osc('sine', 5.6, when), depth = gain(0);
      depth.gain.setValueAtTime(0, when);
      depth.gain.linearRampToValueAtTime(0, when + 0.18);
      depth.gain.linearRampToValueAtTime(9, when + 0.5);
      lfo.connect(depth);
      depth.connect(o.detune);
      depth.connect(o2.detune);
      const g2 = gain(0.3);
      const amp = gain(0);
      const stop = adsr(amp.gain, when, end, 0.13 * (0.45 + v * 0.7), 0.025, 0.4, 0.8, 0.16);
      o.connect(amp);
      o2.connect(g2).connect(amp);
      route(b, amp, 0.4);
      run([o, o2, lfo], when, stop);
      return stop;
    },
  };

  /* A General MIDI drum kit, synthesized. */
  function noiseHit(b, when, decay, filterType, f, q, level, send) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const flt = ctx.createBiquadFilter();
    flt.type = filterType;
    flt.frequency.value = f;
    flt.Q.value = q;
    const amp = gain(0);
    amp.gain.setValueAtTime(level, when);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    src.connect(flt).connect(amp);
    route(b, amp, send);
    src.start(when);
    src.stop(when + decay + 0.05);
  }
  function toneHit(b, when, f0, f1, sweep, decay, level, type, send) {
    const o = osc(type || 'sine', f0, when);
    o.frequency.exponentialRampToValueAtTime(f1, when + sweep);
    const amp = gain(0);
    amp.gain.setValueAtTime(level, when);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    o.connect(amp);
    route(b, amp, send);
    o.start(when);
    o.stop(when + decay + 0.05);
  }
  function drum(b, when, p, v) {
    const lv = 0.35 + v * 0.65;
    switch (p) {
      case 35: case 36:
        toneHit(b, when, 150, 44, 0.11, 0.45, 0.95 * lv, 'sine', 0.03);
        noiseHit(b, when, 0.012, 'highpass', 3000, 0.7, 0.18 * lv, 0);
        return when + 0.5;
      case 37:
        toneHit(b, when, 820, 800, 0.01, 0.04, 0.3 * lv, 'triangle', 0.1);
        return when + 0.1;
      case 38: case 40:
        toneHit(b, when, 200, 160, 0.05, 0.12, 0.32 * lv, 'triangle', 0.15);
        noiseHit(b, when, 0.2, 'bandpass', 1900, 0.7, 0.55 * lv, 0.22);
        return when + 0.25;
      case 39:
        for (let k = 0; k < 3; k++) noiseHit(b, when + k * 0.011, 0.03, 'bandpass', 1300, 1.2, 0.4 * lv, 0.2);
        noiseHit(b, when + 0.033, 0.22, 'bandpass', 1200, 0.9, 0.42 * lv, 0.3);
        return when + 0.3;
      case 42: case 44:
        noiseHit(b, when, p === 44 ? 0.035 : 0.05, 'highpass', 7600, 0.6, 0.24 * lv, 0.06);
        return when + 0.1;
      case 46:
        noiseHit(b, when, 0.34, 'highpass', 7000, 0.6, 0.2 * lv, 0.12);
        return when + 0.4;
      case 49: case 57:
        noiseHit(b, when, 1.4, 'highpass', 5200, 0.4, 0.2 * lv, 0.3);
        return when + 1.5;
      case 51: case 59: case 53:
        noiseHit(b, when, 0.55, 'highpass', 6800, 0.5, 0.1 * lv, 0.2);
        toneHit(b, when, 3300, 3200, 0.05, 0.4, 0.035 * lv, 'sine', 0.1);
        return when + 0.6;
      default: {
        if (p >= 41 && p <= 50) {
          const f = 70 + (p - 41) * 16;
          toneHit(b, when, f * 1.4, f, 0.18, 0.32, 0.55 * lv, 'sine', 0.12);
          return when + 0.4;
        }
        noiseHit(b, when, 0.06, 'highpass', 6000, 0.6, 0.14 * lv, 0.08);
        return when + 0.1;
      }
    }
  }

  A.instrumentFor = function (pin, n) {
    if (n.ch === 9) return 'drums';
    if (pin.sound && pin.sound !== 'original') return pin.sound;
    const part = pin.parts && pin.parts[n.part];
    return (part && part.inst !== 'drums' && part.inst) || 'keys';
  };
  /* Per-part mute and solo, kept on the pin so the close-up and the player agree. */
  A.audible = function (pin, part) {
    const mix = pin.mix;
    if (!mix) return true;
    return mix.solo.size ? mix.solo.has(part) : !mix.mute.has(part);
  };
  function sound(b, inst, when, dur, p, v) {
    if (inst === 'drums') return drum(b, when, p, v);
    return (VOICES[inst] || VOICES.keys)(b, when, dur, p, v);
  }

  /* Preview a chord, used by the key wheel. */
  A.chord = function (pitches, inst) {
    if (!A.ensure()) return;
    const b = bus();
    const t = ctx.currentTime + 0.02;
    pitches.forEach((p, i) => sound(b, inst || 'keys', t + i * 0.035, 1.1, p, 0.5));
    setTimeout(() => b.release(0.6), 2600);
  };

  /* ---------- Player: one pin at a time, sample-accurate scheduling ---------- */
  class Player {
    constructor() {
      this.pin = null;
      this.playing = false;
      this.offset = 0;
      this.startAt = 0;
      this.cursor = 0;
      this.loop = false;
      this.source = null;
      this.b = null;
      this.timer = 0;
      this.voices = [];
      this.subs = new Set();
    }
    on(fn) {
      this.subs.add(fn);
      return () => this.subs.delete(fn);
    }
    emit(kind) {
      for (const fn of this.subs) fn(this, kind);
    }
    get position() {
      if (!this.pin) return 0;
      if (!this.playing || !ctx) return this.offset;
      return MP.clamp(this.offset + (ctx.currentTime - this.startAt), 0, this.pin.duration);
    }
    play(pin, from, source) {
      if (!A.ensure()) return;
      const changed = this.pin !== pin;
      if (changed) {
        this.halt(0.04);
        this.pin = pin;
        this.offset = 0;
      }
      if (from != null) this.offset = from;
      if (this.offset >= pin.duration - 0.05) this.offset = 0;
      if (source) this.source = source;
      this.halt(0.03);
      this.b = bus();
      // Dense arrangements get headroom so sixteen parts don't push the compressor into pumping.
      const norm = 1 / Math.sqrt(Math.max(1, (pin.poly || 3) / 3.5));
      this.b.dry.gain.value = norm;
      this.b.wet.gain.value = norm;
      this.startAt = ctx.currentTime + 0.05;
      const notes = pin.notes;
      let lo = 0, hi = notes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (notes[mid].t < this.offset - 0.001) lo = mid + 1; else hi = mid;
      }
      this.cursor = lo;
      this.playing = true;
      this.voices = [];
      this.timer = setInterval(() => this.tick(), 25);
      this.tick();
      this.emit(changed ? 'load' : 'play');
    }
    tick() {
      if (!this.playing) return;
      const now = ctx.currentTime;
      const horizon = now + (document.hidden ? 1.2 : 0.16);
      const pin = this.pin, notes = pin.notes;
      this.voices = this.voices.filter((end) => end > now);
      while (this.cursor < notes.length) {
        const n = notes[this.cursor];
        const when = this.startAt + (n.t - this.offset);
        if (when > horizon) break;
        if (when >= now - 0.03 && A.audible(pin, n.part) && (this.voices.length < 72 || n.ch === 9 || n.v > 0.75)) {
          this.voices.push(sound(this.b, A.instrumentFor(pin, n), Math.max(when, now), n.d, n.p, n.v));
        }
        this.cursor++;
      }
      if (this.position >= pin.duration) {
        if (this.loop) this.play(pin, 0);
        else this.finish();
      }
    }
    pause() {
      if (!this.playing) return;
      this.offset = this.position;
      this.halt(0.04);
      this.playing = false;
      this.emit('pause');
    }
    toggle(pin, source) {
      if (this.pin === pin && this.playing) this.pause();
      else this.play(pin, null, source);
    }
    seek(t) {
      if (!this.pin) return;
      this.offset = MP.clamp(t, 0, this.pin.duration);
      if (this.playing) this.play(this.pin, this.offset);
      else this.emit('seek');
    }
    restart() {
      if (this.pin && this.playing) this.play(this.pin, this.position);
    }
    stop() {
      if (!this.pin) return;
      this.halt(0.05);
      this.playing = false;
      this.pin = null;
      this.offset = 0;
      this.source = null;
      this.emit('stop');
    }
    finish() {
      this.halt(0.6);
      this.playing = false;
      this.offset = 0;
      this.emit('end');
    }
    halt(tc) {
      clearInterval(this.timer);
      this.timer = 0;
      if (this.b) {
        this.b.release(tc || 0.04);
        this.b = null;
      }
    }
  }
  A.player = new Player();
})();
