/* Midiplace — core: color science, spring physics, storage and DOM helpers. */
(function () {
  'use strict';
  const MP = (window.MP = window.MP || {});

  MP.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  MP.lerp = (a, b, t) => a + (b - a) * t;
  MP.easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  MP.easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  MP.easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);

  /* Deterministic randomness, so every seeded pin sounds the same on every visit. */
  MP.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  MP.hash = function (str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  /* ---------- OKLCH → sRGB, with chroma reduction to stay in gamut ---------- */
  function oklabToLinear(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }
  const encode = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  const inGamut = (rgb) => rgb[0] >= -1e-4 && rgb[0] <= 1.0001 && rgb[1] >= -1e-4 && rgb[1] <= 1.0001 && rgb[2] >= -1e-4 && rgb[2] <= 1.0001;

  const okCache = new Map();
  MP.oklch = function (L, C, h) {
    const key = ((L * 1000) | 0) + ':' + ((C * 1000) | 0) + ':' + (((h % 360) + 360) % 360 | 0);
    const hit = okCache.get(key);
    if (hit) return hit;
    const hr = (h * Math.PI) / 180, ca = Math.cos(hr), sa = Math.sin(hr);
    let rgb = oklabToLinear(L, C * ca, C * sa);
    if (!inGamut(rgb)) {
      let lo = 0, hi = C;
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        if (inGamut(oklabToLinear(L, mid * ca, mid * sa))) lo = mid;
        else hi = mid;
      }
      rgb = oklabToLinear(L, lo * ca, lo * sa);
    }
    const out = rgb.map((v) => Math.round(MP.clamp(encode(MP.clamp(v, 0, 1)), 0, 1) * 255));
    okCache.set(key, out);
    return out;
  };
  MP.rgba = (rgb, a = 1) =>
    a >= 1 ? 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')' : 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + Math.round(a * 1000) / 1000 + ')';
  MP.hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

  /* ---------- Pitch → color. Hue walks the circle of fifths, starting at a red C. ---------- */
  MP.NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  MP.MAJOR_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  MP.MINOR_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
  MP.pc = (p) => ((p % 12) + 12) % 12;
  MP.fifths = (pc) => (MP.pc(pc) * 7) % 12;
  MP.hueOf = (pc) => (MP.fifths(pc) * 30 + 25) % 360;
  MP.pitchName = (p) => MP.NOTE_NAMES[MP.pc(p)] + (Math.floor(p / 12) - 1);
  MP.keyName = (k) => (k.mode === 'minor' ? MP.MINOR_NAMES : MP.MAJOR_NAMES)[k.tonic] + ' ' + k.mode;
  MP.keyShort = (k) => (k.mode === 'minor' ? MP.MINOR_NAMES[k.tonic] + 'm' : MP.MAJOR_NAMES[k.tonic]);

  /* Midiplace is a night catalogue: dark unless someone explicitly asks for light. */
  MP.theme = function () {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  };

  /* Note color: same hue for a pitch class in every octave, a touch lighter as it rises. */
  MP.noteRgb = function (pitch, theme, lift = 0) {
    const oct = Math.floor(pitch / 12) - 1;
    const base = theme === 'dark' ? 0.74 : 0.665;
    const L = MP.clamp(base + (oct - 4) * 0.028 + lift, 0.48, 0.9);
    return MP.oklch(L, theme === 'dark' ? 0.158 : 0.172, MP.hueOf(pitch));
  };
  MP.noteColor = (pitch, theme, alpha = 1, lift = 0) => MP.rgba(MP.noteRgb(pitch, theme, lift), alpha);
  /* Paper tint for a key: the background every artwork sits on. */
  MP.tintRgb = (tonic, theme, shift = 0) =>
    theme === 'dark' ? MP.oklch(0.225 + shift * 0.03, 0.03 + shift * 0.008, MP.hueOf(tonic) + shift * 14) : MP.oklch(0.958 + shift * 0.022, 0.026 - shift * 0.01, MP.hueOf(tonic) + shift * 14);
  MP.inkRgb = (tonic, theme) => (theme === 'dark' ? MP.oklch(0.92, 0.02, MP.hueOf(tonic)) : MP.oklch(0.3, 0.05, MP.hueOf(tonic)));

  /* ---------- Real spring physics, sampled into a CSS linear() easing ---------- */
  MP.spring = function (stiffness, damping, mass = 1) {
    const w0 = Math.sqrt(stiffness / mass);
    const zeta = damping / (2 * Math.sqrt(stiffness * mass));
    const wd = w0 * Math.sqrt(Math.max(1e-6, 1 - zeta * zeta));
    const x = (t) =>
      zeta < 1
        ? 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
        : 1 - Math.exp(-w0 * t) * (1 + w0 * t);
    let T = 2, calm = 0;
    for (let t = 0; t < 3; t += 1 / 240) {
      if (Math.abs(x(t) - 1) < 0.002) {
        calm += 1 / 240;
        if (calm > 0.08) { T = t; break; }
      } else calm = 0;
    }
    const n = MP.clamp(Math.round(T * 60), 24, 72);
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(Math.round(x((i / n) * T) * 10000) / 10000);
    pts[n] = 1;
    return { duration: Math.round(T * 1000), easing: 'linear(' + pts.join(', ') + ')', fn: x, T };
  };

  MP.reducedMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  MP.supportsLinear = !!(window.CSS && CSS.supports && CSS.supports('transition-timing-function', 'linear(0, 1)'));
  MP.SPRINGS = {
    snappy: MP.spring(420, 32),
    bouncy: MP.spring(300, 19),
    smooth: MP.spring(190, 27),
    gentle: MP.spring(120, 21),
  };
  const FALLBACK = {
    snappy: 'cubic-bezier(.2,.9,.25,1.08)',
    bouncy: 'cubic-bezier(.3,1.35,.45,1)',
    smooth: 'cubic-bezier(.22,1,.36,1)',
    gentle: 'cubic-bezier(.25,1,.4,1)',
  };
  MP.ease = (name) => (MP.supportsLinear ? MP.SPRINGS[name].easing : FALLBACK[name]);
  MP.dur = (name) => (MP.reducedMotion ? 1 : MP.SPRINGS[name].duration);
  if (MP.supportsLinear) {
    const root = document.documentElement.style;
    for (const name of Object.keys(MP.SPRINGS)) {
      root.setProperty('--spring-' + name, MP.SPRINGS[name].easing);
      root.setProperty('--spring-' + name + '-dur', MP.SPRINGS[name].duration + 'ms');
    }
  }

  /* Web Animations with the reduced-motion preference respected in one place. */
  MP.animate = function (el, frames, opts) {
    if (!el || !el.animate) return { finished: Promise.resolve(), cancel() {} };
    const o = Object.assign({ fill: 'none' }, opts);
    if (typeof o.easing === 'string' && MP.SPRINGS[o.easing]) {
      if (o.duration == null) o.duration = MP.SPRINGS[o.easing].duration;
      o.easing = MP.ease(o.easing);
    }
    if (MP.reducedMotion) {
      o.duration = Math.min(o.duration || 0, 120);
      o.delay = 0;
    }
    return el.animate(frames, o);
  };

  /* ---------- Storage: per-browser conveniences only, never required ---------- */
  MP.store = {
    get(k, fallback) {
      try {
        const v = localStorage.getItem('midiplace:' + k);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('midiplace:' + k, JSON.stringify(v));
        return true;
      } catch (e) {
        return false;
      }
    },
  };

  /* ---------- Formatting ---------- */
  MP.fmtTime = function (s) {
    s = Math.max(0, s || 0);
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ':' + String(r).padStart(2, '0');
  };
  MP.fmtCount = (n) => (n < 1000 ? String(n) : n < 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : Math.round(n / 1000) + 'k');
  MP.fmtNumber = (n) => n.toLocaleString('en-US');
  MP.timeAgo = function (ms) {
    const s = Math.max(1, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    const d = Math.floor(s / 86400);
    if (d < 7) return d + (d === 1 ? ' day ago' : ' days ago');
    if (d < 35) return Math.floor(d / 7) + (d < 14 ? ' week ago' : ' weeks ago');
    return Math.floor(d / 30) + (d < 60 ? ' month ago' : ' months ago');
  };
  MP.slug = (s) => (s || 'midiplace').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 48) || 'midiplace';

  /* ---------- DOM ---------- */
  MP.h = function (tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = [].concat(arguments[i]);
      for (const kid of kids) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };

  const ICONS = {
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    play: '<path d="M8.5 5.7v12.6a1 1 0 0 0 1.52.85l10.2-6.3a1 1 0 0 0 0-1.7L10.02 4.85A1 1 0 0 0 8.5 5.7z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6.5" y="5" width="3.8" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.7" y="5" width="3.8" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1v14.06a.5.5 0 0 1-.8.4L12 16.2l-5.2 3.76a.5.5 0 0 1-.8-.4V5.5a1 1 0 0 1 1-1z"/>',
    bookmarkFill: '<path d="M7 4.5h10a1 1 0 0 1 1 1v14.06a.5.5 0 0 1-.8.4L12 16.2l-5.2 3.76a.5.5 0 0 1-.8-.4V5.5a1 1 0 0 1 1-1z" fill="currentColor"/>',
    check: '<path d="m5.5 12.5 4.2 4.2L18.5 8"/>',
    download: '<path d="M12 4.5v10.5m0 0-4.2-4.2M12 15l4.2-4.2M5.5 19.5h13"/>',
    link: '<path d="M10.2 13.8a3.8 3.8 0 0 0 5.37 0l2.85-2.85a3.8 3.8 0 0 0-5.37-5.37l-.9.9"/><path d="M13.8 10.2a3.8 3.8 0 0 0-5.37 0l-2.85 2.85a3.8 3.8 0 0 0 5.37 5.37l.9-.9"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    chevL: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
    chevR: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
    sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3v1.8M12 19.2V21M5.64 5.64l1.27 1.27M17.09 17.09l1.27 1.27M3 12h1.8M19.2 12H21M5.64 18.36l1.27-1.27M17.09 6.91l1.27-1.27"/>',
    moon: '<path d="M19.5 14.6A7.5 7.5 0 0 1 9.4 4.5a7.5 7.5 0 1 0 10.1 10.1z"/>',
    headphones: '<path d="M4.5 15.5V12a7.5 7.5 0 0 1 15 0v3.5"/><rect x="4" y="14" width="4.2" height="6.2" rx="1.6"/><rect x="15.8" y="14" width="4.2" height="6.2" rx="1.6"/>',
    loop: '<path d="m16.5 3.5 3 3-3 3"/><path d="M4.5 11.5v-.5a4.5 4.5 0 0 1 4.5-4.5h10.5"/><path d="m7.5 20.5-3-3 3-3"/><path d="M19.5 12.5v.5a4.5 4.5 0 0 1-4.5 4.5H4.5"/>',
    dice: '<rect x="4.5" y="4.5" width="15" height="15" rx="4"/><circle cx="9.2" cy="9.2" r="1.15" fill="currentColor" stroke="none"/><circle cx="14.8" cy="14.8" r="1.15" fill="currentColor" stroke="none"/><circle cx="14.8" cy="9.2" r="1.15" fill="currentColor" stroke="none"/><circle cx="9.2" cy="14.8" r="1.15" fill="currentColor" stroke="none"/>',
    file: '<path d="M13.5 3.5h-6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-10z"/><path d="M13.5 3.5v5h5"/>',
    arrowUp: '<path d="M12 19V5.5m0 0-5 5m5-5 5 5"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor"/>',
    arrowL: '<path d="M19 12H5.5m0 0 5.5-5.5M5.5 12l5.5 5.5"/>',
    arrowR: '<path d="M5 12h13.5m0 0L13 6.5m5.5 5.5L13 17.5"/>',
    arrowDown: '<path d="M12 5v13.5m0 0-5.5-5.5m5.5 5.5 5.5-5.5"/>',
    share: '<path d="M12 3.5v11m0-11-4 4m4-4 4 4"/><path d="M6.5 11H5.5a1 1 0 0 0-1 1v7a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-7a1 1 0 0 0-1-1h-1"/>',
    minus: '<path d="M5.5 12h13"/>',
    command: '<path d="M9 6.5A2.5 2.5 0 1 0 6.5 9H9V6.5zm0 0V17.5m0-8.5h6m-6 8.5A2.5 2.5 0 1 1 6.5 15H9v2.5zm6-11V9h2.5A2.5 2.5 0 1 0 15 6.5zm0 0V17.5m0 0A2.5 2.5 0 1 0 17.5 15H15v2.5z"/>',
    grid: '<rect x="4.5" y="4.5" width="6" height="6" rx="1.4"/><rect x="13.5" y="4.5" width="6" height="9" rx="1.4"/><rect x="4.5" y="13.5" width="6" height="6" rx="1.4"/><rect x="13.5" y="16.5" width="6" height="3" rx="1.2"/>',
    trash: '<path d="M5 7h14M10 7V5.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V7M7 7l.8 11.2a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7"/>',
    sound: '<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    din: '<circle cx="12" cy="12" r="8.5"/><circle cx="7" cy="12" r="1.05" fill="currentColor" stroke="none"/><circle cx="8.46" cy="8.46" r="1.05" fill="currentColor" stroke="none"/><circle cx="12" cy="7" r="1.05" fill="currentColor" stroke="none"/><circle cx="15.54" cy="8.46" r="1.05" fill="currentColor" stroke="none"/><circle cx="17" cy="12" r="1.05" fill="currentColor" stroke="none"/><path d="M10.6 18.2h2.8"/>',
  };
  MP.icon = function (name, cls) {
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  };

  /* Base64 for persisting uploaded files. */
  MP.toB64 = function (bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  MP.fromB64 = function (b64) {
    const s = atob(b64), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
})();
