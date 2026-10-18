/* Midiplace — the catalogue, the sleeve, the publisher and everything that moves. */
(function () {
  'use strict';
  const MP = window.MP, ART = MP.art, h = MP.h, player = MP.audio.player;
  const $ = (id) => document.getElementById(id);

  const CATEGORIES = ['Arrangements', 'Piano', 'Chords', 'Melody', 'Lo-fi', 'Ambient', 'Drums', 'Bass', 'Synthwave', 'Cinematic', 'Chiptune', 'Jazz', 'Classical'];
  const PICKABLE = CATEGORIES.filter((c) => c !== 'Arrangements');
  const SOUNDS = [['original', 'Original'], ['keys', 'Keys'], ['pad', 'Pad'], ['pluck', 'Pluck'], ['chip', 'Chip']];
  const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
  const ME = { name: 'You', handle: 'you', hue: 205, followers: 0, me: true };
  const EXPO = 'cubic-bezier(.16,1,.3,1)';
  const MAX_BYTES = 8 * 1024 * 1024;
  const dpr = () => ART.DPR();
  const reduced = MP.reducedMotion;

  const state = {
    pins: [],
    byId: new Map(),
    visible: [],
    category: 'all',
    key: null,
    query: '',
    sort: 'trending',
    view: 'all',
    saved: new Set(MP.store.get('saved', [])),
    following: new Set(MP.store.get('following', [])),
    hoverListen: MP.store.get('hoverListen', false) === true,
    theme: 'dark',
  };

  /* ---------- Pins ---------- */
  const catNo = (pin) => 'MP-' + String(pin.no || 0).padStart(4, '0');
  const norm = (s) => String(s).toLowerCase().replace(/♯/g, '#').replace(/♭/g, 'b').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyLabel = (pin) => (pin.key.none ? 'Drums' : MP.keyName(pin.key));
  const noteHex = (pc, lift) => MP.hex(MP.noteRgb(60 + pc, state.theme, lift || 0));

  function searchText(pin) {
    const k = pin.key;
    const parts = [pin.title, pin.author.name, '@' + pin.author.handle, pin.author.handle, pin.genre || '', pin.desc || '', ART.LABELS[pin.style], Math.round(pin.bpm) + ' bpm', catNo(pin)];
    pin.tags.forEach((t) => parts.push(t, t.replace('-', '')));
    (pin.parts || []).forEach((p) => parts.push(p.name, p.gm));
    if (pin.complex) parts.push('arrangement arrangements');
    if (k.none) parts.push('drums percussion beat');
    else {
      const name = (k.mode === 'minor' ? MP.MINOR_NAMES : MP.MAJOR_NAMES)[k.tonic];
      parts.push(MP.keyName(k), name + ' ' + (k.mode === 'minor' ? 'min' : 'maj'), MP.keyShort(k));
    }
    return ' ' + norm(parts.join(' · ')) + ' ';
  }

  function preparePin(pin) {
    ART.prepare(pin);
    if (!pin.key) {
      const k = MP.midi.detectKey(pin.notes);
      pin.key = { tonic: k.tonic, mode: k.mode, none: !!k.none };
    }
    if (!pin.melodicCount) pin.key.none = true;
    pin.sound = 'original';
    pin.search = searchText(pin);
    return pin;
  }

  function matches(pin, q) {
    const nq = norm(q).trim();
    if (!nq) return true;
    const bpm = /^(\d{2,3})\s*bpm$/.exec(nq);
    if (bpm) return Math.abs(pin.bpm - +bpm[1]) <= 6;
    if (new RegExp('[\\s·@(]' + escapeRe(nq)).test(pin.search)) return true;
    const tokens = nq.split(/\s+/).filter((t) => t.length > 1);
    return tokens.length > 0 && tokens.every((t) => new RegExp('[\\s·@(]' + escapeRe(t)).test(pin.search));
  }

  const inView = (p) => (state.view === 'saved' ? state.saved.has(p.id) : state.view === 'mine' ? !!p.mine : true);
  const inCategory = (p, c) => c === 'all' || (c === 'Arrangements' ? p.complex : p.tags.indexOf(c) >= 0);
  const inKey = (p) => !state.key || (!p.key.none && p.key.tonic === state.key.tonic && p.key.mode === state.key.mode);

  function computeVisible() {
    const now = Date.now();
    const score = (p) => (p.fresh ? 1e15 + p.createdAt : state.sort === 'newest' ? p.createdAt : state.sort === 'longest' ? p.duration : p.saves / Math.pow(1 + (now - p.createdAt) / 86400000 / 14, 0.9));
    return state.pins.filter((p) => inView(p) && inCategory(p, state.category) && inKey(p) && matches(p, state.query)).sort((a, b) => score(b) - score(a));
  }

  function pinFromParsed(parsed, extra) {
    const k = MP.midi.detectKey(parsed.notes);
    const pin = Object.assign(
      {
        notes: parsed.notes, parts: parsed.parts, bpm: parsed.bpm, tempos: parsed.tempos, bars: parsed.bars, markers: parsed.markers,
        timeSig: parsed.timeSig, meterChanges: parsed.meterChanges, pedal: parsed.pedal, format: parsed.format, tracks: parsed.tracks,
        ppq: parsed.ppq, truncated: parsed.truncated, programs: parsed.programs, tags: [], desc: '', saves: 0, plays: 0,
        createdAt: Date.now(), allowDownload: true, genre: '', key: { tonic: k.tonic, mode: k.mode, none: !!k.none },
      },
      extra
    );
    if (!pin.style) pin.style = 'roll';
    preparePin(pin);
    if (!extra.style && !pin.melodicCount) pin.style = 'steps';
    return pin;
  }

  function guessTitle(parsed, fileName) {
    const name = (parsed.name || '').trim();
    if (name && name.length <= 60 && !/^(track|untitled|unnamed|seq|sequence|midi|tempo|conductor)\s*\d*$/i.test(name) && /[a-z]/i.test(name)) return name;
    const base = fileName.replace(/\.(mid|midi|rmi|kar)$/i, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
    return base ? base.charAt(0).toUpperCase() + base.slice(1, 60) : 'Untitled';
  }

  function guessTags(pin) {
    if (!pin.melodicCount) return ['Drums'];
    const tags = [];
    const insts = pin.parts.map((p) => p.inst);
    if (pin.parts.some((p) => !p.drums && p.program >= 0 && p.program < 8)) tags.push('Piano');
    if (pin.poly > 2.6) tags.push('Chords');
    else tags.push('Melody');
    if (insts.indexOf('strings') >= 0 && tags.length < 3) tags.push('Cinematic');
    if (pin.range[1] < 60 && tags.length < 3) tags.push('Bass');
    if (pin.drumCount && tags.length < 3) tags.push('Drums');
    return tags.slice(0, 3);
  }

  /* ---------- Persistence: IndexedDB, so a 6 MB arrangement survives a reload ---------- */
  const vault = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        let req;
        try { req = indexedDB.open('midiplace', 1); } catch (e) { return reject(e); }
        req.onupgradeneeded = () => req.result.createObjectStore('uploads', { keyPath: 'id' });
        req.onsuccess = () => resolve((this.db = req.result));
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      });
    },
    async run(mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('uploads', mode);
        const req = fn(tx.objectStore('uploads'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    all() { return this.run('readonly', (s) => s.getAll()); },
    put(rec) { return this.run('readwrite', (s) => s.put(rec)); },
    remove(id) { return this.run('readwrite', (s) => s.delete(id)); },
  };
  const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  function recToPin(u) {
    try {
      const bytes = u.bytes instanceof Uint8Array ? u.bytes : new Uint8Array(u.bytes);
      return pinFromParsed(MP.midi.parse(bytes), { id: u.id, no: u.no, title: u.title, desc: u.desc || '', tags: u.tags || [], style: u.style || 'roll', allowDownload: u.allowDownload !== false, createdAt: u.createdAt || Date.now(), fileName: u.fileName, bytes, mine: true, author: ME });
    } catch (e) {
      return null;
    }
  }
  async function loadUploads() {
    let recs = [];
    let ok = true;
    try { recs = (await timeout(vault.all(), 1500)) || []; } catch (e) { ok = false; }
    // Pins from the first prototype lived in localStorage; move them over once.
    const legacy = MP.store.get('uploads', null);
    if (Array.isArray(legacy) && legacy.length) {
      for (const u of legacy) {
        if (recs.some((r) => r.id === u.id)) continue;
        try {
          const rec = { id: u.id, title: u.title, desc: u.desc, tags: u.tags, style: u.style, allowDownload: u.allowDownload, createdAt: u.createdAt, fileName: u.fileName, bytes: MP.fromB64(u.b64) };
          recs.push(rec);
          if (ok) await vault.put(rec);
        } catch (e) { /* skip a damaged record */ }
      }
      if (ok) MP.store.set('uploads', null);
    }
    return recs.map(recToPin).filter(Boolean);
  }
  async function persist(pin) {
    try {
      await timeout(vault.put({ id: pin.id, no: pin.no, title: pin.title, desc: pin.desc, tags: pin.tags, style: pin.style, allowDownload: pin.allowDownload, createdAt: pin.createdAt, fileName: pin.fileName, bytes: pin.bytes }), 3000);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- Shared bits ---------- */
  function paintVars(el, pin) {
    const t = state.theme;
    el.style.setProperty('--pin-tint', MP.rgba(MP.tintRgb(pin.key.tonic, t)));
    el.style.setProperty('--pin-glow', MP.noteColor(pin.key.tonic + 60, t, t === 'dark' ? 0.4 : 0.5));
    el.style.setProperty('--pin-glow-soft', MP.noteColor(pin.key.tonic + 60, t, t === 'dark' ? 0.13 : 0.16));
    el.style.setProperty('--dot', pin.key.none ? 'var(--ink-3)' : MP.noteColor(pin.key.tonic + 60, t));
  }
  function avatar(author) {
    const a1 = MP.hex(MP.oklch(0.72, 0.14, author.hue)), a2 = MP.hex(MP.oklch(0.52, 0.15, author.hue + 45));
    const initials = author.me ? 'Y' : author.name.split(/\s+/).map((s) => s[0]).slice(0, 2).join('');
    return h('span', { class: 'avatar', style: '--a1:' + a1 + ';--a2:' + a2, 'aria-hidden': 'true' }, initials);
  }
  const lockScroll = (on) => document.documentElement.classList.toggle('is-locked', on);
  function onScreen(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth ? r : null;
  }
  function makeGhost(src, rect, radius, z) {
    const c = h('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    const g = h('div', { class: 'ghost', style: { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', borderRadius: radius + 'px', zIndex: z || 86 } }, c);
    document.body.append(g);
    return g;
  }
  function settleScroll(el) {
    const read = () => (el ? el.scrollTop : window.scrollY);
    return new Promise((resolve) => {
      let last = read(), still = 0, frames = 0;
      (function check() {
        frames++;
        const now = read();
        still = Math.abs(now - last) < 0.5 ? still + 1 : 0;
        last = now;
        if (still > 3 || frames > 80) resolve();
        else requestAnimationFrame(check);
      })();
    });
  }
  function trapFocus(container, e) {
    const items = Array.from(container.querySelectorAll('button:not([disabled]), input:not([type="hidden"]), textarea, [tabindex="0"], a[href], label[for]')).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function makeOdo(el, digits) {
    el.replaceChildren();
    const cols = [];
    for (let i = 0; i < digits; i++) {
      const col = h('span', { class: 'odo-col' });
      for (let k = 0; k < 10; k++) col.append(h('span', null, String(k)));
      el.append(h('span', { class: 'odo-d' }, col));
      cols.push(col);
    }
    let last = '';
    return {
      set(n) {
        const s = String(Math.max(0, Math.floor(n))).padStart(digits, '0').slice(-digits);
        if (s === last) return;
        last = s;
        for (let i = 0; i < digits; i++) cols[i].style.setProperty('--n', s[i]);
      },
    };
  }
  /* Counts a number up, the way a readout settles. */
  function countUp(el, to, ms) {
    if (reduced || to < 10) { el.textContent = MP.fmtNumber(to); return; }
    const start = performance.now();
    (function step(now) {
      const p = Math.min(1, (now - start) / ms);
      el.textContent = MP.fmtNumber(Math.round(MP.easeOutQuint(p) * to));
      if (p < 1) requestAnimationFrame(step);
    })(start);
  }

  /* Segmented control with a sliding indicator. */
  function makeSeg(el, items, value, onChange) {
    const ind = el.querySelector('.seg-indicator');
    if (items) for (const it of items) el.append(h('button', { type: 'button', role: 'radio', 'data-value': it.value, 'aria-checked': 'false', html: it.html || null }, it.html ? null : it.label));
    const buttons = () => Array.from(el.querySelectorAll('button[data-value]'));
    const api = {
      value,
      set(v) {
        api.value = v;
        for (const b of buttons()) {
          const on = b.dataset.value === v;
          b.setAttribute('aria-checked', String(on));
          b.tabIndex = on ? 0 : -1;
        }
        api.place(true);
      },
      place(animate) {
        const b = buttons().find((x) => x.dataset.value === api.value);
        if (!b || !b.offsetWidth) return;
        if (!animate) ind.style.transition = 'none';
        ind.style.width = b.offsetWidth + 'px';
        ind.style.transform = 'translateX(' + b.offsetLeft + 'px)';
        if (!animate) { void ind.offsetWidth; ind.style.transition = ''; }
      },
    };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b || b.dataset.value === api.value) return;
      api.set(b.dataset.value);
      onChange(b.dataset.value);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const list = buttons(), i = list.findIndex((b) => b.dataset.value === api.value);
      const next = list[MP.clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, list.length - 1)];
      if (next && next.dataset.value !== api.value) {
        api.set(next.dataset.value);
        next.focus();
        onChange(next.dataset.value);
      }
    });
    api.set(value);
    requestAnimationFrame(() => api.place(false));
    // Re-measure whenever the control changes size: fonts loading, panels animating, viewport changes.
    if (window.ResizeObserver) new ResizeObserver(() => api.place(false)).observe(el);
    return api;
  }
  function slideLine(line, target, animate) {
    if (!target || !target.offsetWidth) return;
    if (!animate) line.style.transition = 'none';
    line.style.width = target.offsetWidth - 22 + 'px';
    line.style.transform = 'translateX(' + (target.offsetLeft + 11) + 'px)';
    if (!animate) { void line.offsetWidth; line.style.transition = ''; }
  }

  /* ---------- Toasts and tooltips ---------- */
  function toast(msg, o) {
    o = o || {};
    const box = $('toasts');
    const t = h('div', { class: 'toast' + (o.error ? ' is-error' : ''), role: 'status', html: MP.icon(o.icon || (o.error ? 'info' : 'check')) });
    if (o.color) t.style.setProperty('--toast-c', o.color);
    t.append(h('span', null, msg));
    box.append(t);
    while (box.children.length > 3) box.firstChild.remove();
    MP.animate(t, [{ opacity: 0, transform: 'translateY(14px) scale(0.96)', filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 600, easing: EXPO });
    setTimeout(() => {
      MP.animate(t, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' }).finished.then(() => t.remove(), () => t.remove());
    }, o.duration || 2800);
  }

  const tip = { el: $('tip'), timer: 0, target: null, hiddenAt: 0 };
  function showTip(t, quick) {
    if (!document.body.contains(t) || !t.dataset.tip) return;
    tip.el.textContent = t.dataset.tip;
    tip.el.hidden = false;
    const r = t.getBoundingClientRect(), tw = tip.el.offsetWidth, th = tip.el.offsetHeight;
    const x = MP.clamp(r.left + r.width / 2 - tw / 2, 8, window.innerWidth - tw - 8);
    let y = r.bottom + 8;
    if (y + th > window.innerHeight - 8) y = r.top - th - 8;
    tip.el.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    if (!quick) MP.animate(tip.el, [{ opacity: 0, translate: '0 -3px' }, { opacity: 1, translate: '0 0' }], { duration: 160, easing: 'ease-out' });
  }
  function hideTip() {
    clearTimeout(tip.timer);
    if (!tip.el.hidden) { tip.el.hidden = true; tip.hiddenAt = performance.now(); }
    tip.target = null;
  }
  function initTips() {
    document.addEventListener('pointerover', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t || e.pointerType !== 'mouse' || t === tip.target) return;
      tip.target = t;
      clearTimeout(tip.timer);
      const quick = performance.now() - tip.hiddenAt < 450;
      tip.timer = setTimeout(() => showTip(t, quick), quick ? 0 : 550);
    });
    document.addEventListener('pointerout', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t && !t.contains(e.relatedTarget)) hideTip();
    });
    document.addEventListener('pointerdown', hideTip, true);
    window.addEventListener('scroll', hideTip, { passive: true });
  }

  /* ---------- Animation loop ---------- */
  const loop = { cards: new Set(), raf: 0 };
  function wake(card) {
    if (card) loop.cards.add(card);
    if (!loop.raf) loop.raf = requestAnimationFrame(frame);
  }
  function frame(now) {
    loop.raf = 0;
    let again = false;
    for (const card of loop.cards) {
      if (drawCard(card, now)) again = true;
      else loop.cards.delete(card);
    }
    if (sleeve.open && sleeve.frame(now)) again = true;
    if (dock.frame()) again = true;
    if (!sleeve.open && ribbon.frame(now)) again = true;
    if (again || loop.cards.size) loop.raf = requestAnimationFrame(frame);
  }

  /* ---------- Sleeves on the board ---------- */
  const grid = { el: $('grid'), cards: new Map(), cols: 0, colW: 0, gap: 20 };

  function createCard(pin, opts) {
    opts = opts || {};
    const canvas = h('canvas', { 'aria-hidden': 'true' });
    const open = h('button', { class: 'pin-open', type: 'button', 'aria-label': (opts.preview ? 'Play ' : 'Open ') + pin.title });
    const save = h('button', { class: 'pin-save', type: 'button' });
    const play = h('button', { class: 'pin-play', type: 'button' });
    const prog = h('span');
    const time = h('span', { class: 'pin-time' }, MP.fmtTime(pin.duration));
    const strip = h('div', { class: 'pin-strip' }, play, h('span', { class: 'pin-progress' }, prog), time);
    const light = h('span', { class: 'pin-light', 'aria-hidden': 'true' });
    const art = h('div', { class: 'pin-art' }, canvas, light, open, save, strip);
    const titleText = h('span', null, pin.title);
    const specs = pin.parts.length + (pin.parts.length === 1 ? ' part' : ' parts') + ' · ' + MP.fmtTime(pin.duration);
    const meta = h(
      'div',
      { class: 'pin-meta' },
      h('div', { class: 'pin-row' }, h('span', { class: 'mono-label pin-no' }, h('span', { class: 'eq', 'aria-hidden': 'true', html: '<i></i><i></i><i></i>' }), catNo(pin)), h('span', { class: 'mono-label pin-specs' }, specs)),
      h('h3', { class: 'pin-title' }, titleText),
      h('div', { class: 'pin-by' }, avatar(pin.author), h('span', { class: 'pin-handle' }, pin.author.handle), h('span', { class: 'mono-label pin-key' }, h('i'), pin.key.none ? 'Drums' : MP.keyShort(pin.key), ' · ' + Math.round(pin.bpm)))
    );
    const inner = h('div', { class: 'pin-inner' }, art, meta);
    const el = h('article', { class: 'pin', 'data-id': pin.id }, inner);
    const card = { pin, el, inner, art, canvas, meta, play, save, prog, time, titleText, x: 0, y: 0, w: 0, artH: 0, placed: false, shown: true, hoverT: null, reveal: null, drawn: null, preview: !!opts.preview };
    paintVars(el, pin);
    renderSave(save, state.saved.has(pin.id));
    syncCard(card);

    open.addEventListener('click', () => (card.preview ? player.toggle(pin, 'click') : openPin(pin, card)));
    play.addEventListener('click', (e) => { e.stopPropagation(); player.toggle(pin, 'click'); });
    save.addEventListener('click', (e) => { e.stopPropagation(); toggleSave(pin, save); });
    art.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse' && state.hoverListen && !card.preview) {
        clearTimeout(card.hoverTimer);
        card.hoverTimer = setTimeout(() => { if (player.pin !== pin || !player.playing) player.play(pin, 0, 'hover'); }, 240);
      }
    });
    art.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || !canvas.width) return;
      const r = art.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
      if (!reduced) {
        art.style.setProperty('--ry', ((nx - 0.5) * 5).toFixed(2) + 'deg');
        art.style.setProperty('--rx', ((0.5 - ny) * 4).toFixed(2) + 'deg');
      }
      light.style.setProperty('--lx', (nx * 100).toFixed(1) + '%');
      light.style.setProperty('--ly', (ny * 100).toFixed(1) + '%');
      const k = canvas.width / r.width;
      card.hoverT = ART.geometry(pin, pin.style, canvas.width, canvas.height).timeAt(nx * r.width * k, ny * r.height * k);
      wake(card);
    });
    art.addEventListener('pointerleave', () => {
      clearTimeout(card.hoverTimer);
      art.style.setProperty('--rx', '0deg');
      art.style.setProperty('--ry', '0deg');
      card.hoverT = null;
      card.drawn = null;
      wake(card);
      if (player.pin === pin && player.source === 'hover' && player.playing) player.stop();
    });
    return card;
  }

  function renderSave(btn, saved) {
    btn.classList.toggle('is-saved', saved);
    btn.setAttribute('aria-pressed', String(saved));
    btn.setAttribute('aria-label', saved ? 'Remove from Saved' : 'Save');
    btn.innerHTML = MP.icon(saved ? 'bookmarkFill' : 'bookmark');
  }

  function syncCard(card) {
    const current = player.pin === card.pin, playing = current && player.playing;
    card.el.classList.toggle('is-current', current);
    card.el.classList.toggle('is-playing', playing);
    card.play.innerHTML = MP.icon(playing ? 'pause' : 'play', playing ? '' : 'icon-play');
    card.play.setAttribute('aria-label', (playing ? 'Pause ' : 'Play ') + card.pin.title);
    if (!current) {
      card.prog.style.setProperty('--p', '0');
      card.time.textContent = MP.fmtTime(card.pin.duration);
    }
  }

  function drawCard(card, now) {
    const pin = card.pin, c = card.canvas;
    if (!c.width || !card.el.isConnected) return false;
    const theme = state.theme;
    if (player.pin === pin && (player.playing || player.offset > 0)) {
      const t = player.position;
      ART.draw(c, pin, { mode: 'live', t, future: 0.3, active: player.playing, playhead: 1, theme });
      card.prog.style.setProperty('--p', (t / pin.duration).toFixed(4));
      card.time.textContent = MP.fmtTime(t);
      card.drawn = 'live';
      return player.playing;
    }
    if (card.hoverT != null) {
      ART.draw(c, pin, { mode: 'live', t: card.hoverT, future: 0.42, active: true, playhead: 0.85, theme });
      card.drawn = 'scrub';
      return false;
    }
    if (card.reveal) {
      const p = (now - card.reveal.start) / card.reveal.dur;
      if (p < 1) {
        const e = p <= 0 ? 0 : MP.easeInOutCubic(p);
        ART.draw(c, pin, { mode: 'live', t: e * pin.duration + 0.001, future: 0, playhead: p <= 0 ? 0 : Math.sin(p * Math.PI) * 0.5, theme });
        card.drawn = 'reveal';
        return true;
      }
      card.reveal = null;
    }
    if (card.drawn !== 'rest') {
      ART.draw(c, pin, { theme });
      card.drawn = 'rest';
    }
    return false;
  }

  function sizeCard(card, colW) {
    const artH = Math.round(colW * ART.aspect(card.pin, card.pin.style));
    if (card.w === colW && card.artH === artH) return;
    card.w = colW;
    card.artH = artH;
    card.art.style.height = artH + 'px';
    const W = Math.round(colW * dpr()), H = Math.round(artH * dpr());
    if (card.canvas.width !== W || card.canvas.height !== H) {
      card.canvas.width = W;
      card.canvas.height = H;
      card.drawn = null;
      wake(card);
    }
  }

  function cardFor(pin) {
    let c = grid.cards.get(pin.id);
    if (!c) {
      c = createCard(pin);
      grid.cards.set(pin.id, c);
      grid.el.append(c.el);
    }
    return c;
  }

  /* Masonry: each sleeve goes to the shortest column. */
  function layout() {
    const W = grid.el.clientWidth;
    if (!W) return;
    const gap = W < 560 ? 12 : W < 1000 ? 16 : 22;
    const min = W < 560 ? 150 : W < 1000 ? 200 : 236;
    const cols = MP.clamp(Math.floor((W + gap) / (min + gap)), 2, 7);
    const colW = Math.floor(((W - gap * (cols - 1)) / cols) * 10) / 10;
    grid.cols = cols;
    grid.colW = colW;
    grid.gap = gap;
    grid.el.style.setProperty('--col-w', colW + 'px');
    const list = state.visible.map(cardFor);
    for (const c of list) sizeCard(c, colW);
    const metaH = list.map((c) => c.meta.offsetHeight);
    const heights = new Array(cols).fill(0), vGap = gap + 18;
    const fresh = [];
    list.forEach((c, i) => {
      let col = 0;
      for (let k = 1; k < cols; k++) if (heights[k] < heights[col] - 1) col = k;
      const x = Math.round(col * (colW + gap)), y = Math.round(heights[col]);
      heights[col] += c.artH + metaH[i] + vGap;
      c.col = col;
      c.order = i;
      if (!c.placed) { c.el.classList.add('no-anim'); fresh.push(c); c.placed = true; }
      if (c.x !== x || c.y !== y || fresh.indexOf(c) >= 0) {
        c.x = x;
        c.y = y;
        c.el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
      }
    });
    grid.el.style.height = Math.max(0, Math.max.apply(null, heights) - vGap) + 'px';
    if (fresh.length) {
      void grid.el.offsetWidth;
      fresh.forEach((c) => c.el.classList.remove('no-anim'));
    }
  }

  function hideCard(c, instant) {
    c.shown = false;
    c.hoverT = null;
    if (reveals.io) reveals.io.unobserve(c.el);
    if (instant || reduced) { c.el.hidden = true; c.placed = false; return; }
    const a = MP.animate(c.inner, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.94)' }], { duration: 200, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
    c.hideAnim = a;
    a.finished.then(() => { if (!c.shown) { c.el.hidden = true; c.placed = false; } a.cancel(); }, () => {});
  }

  /* Sleeves rise into place as they scroll into view; the ones on screen at load cascade in. */
  const reveals = {
    io: null,
    batch: [],
    timer: 0,
    init() {
      if (!('IntersectionObserver' in window) || reduced) return;
      this.io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          this.io.unobserve(e.target);
          const c = grid.cards.get(e.target.dataset.id);
          if (c && c.pending) this.batch.push(c);
        }
        if (this.batch.length && !this.timer) this.timer = requestAnimationFrame(() => this.flush());
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0.01 });
    },
    flush() {
      this.timer = 0;
      const list = this.batch.splice(0).sort((a, b) => a.y - b.y || a.x - b.x);
      list.forEach((c, i) => play(c, i * 70));
    },
    hold(c) {
      if (!this.io) return;
      c.pending = true;
      c.inner.style.opacity = '0';
      this.io.observe(c.el);
    },
  };
  function play(c, delay) {
    c.pending = false;
    c.inner.style.opacity = '';
    MP.animate(c.inner, [{ opacity: 0, transform: 'translateY(42px)', clipPath: 'inset(0 0 18% 0 round 6px)' }, { opacity: 1, transform: 'none', clipPath: 'inset(0 0 0% 0 round 6px)' }], { duration: 1000, delay, easing: EXPO, fill: 'backwards' });
    c.reveal = { start: performance.now() + delay + 120, dur: 1100 + Math.min(900, c.pin.duration * 8) };
    wake(c);
  }

  function animateIn(cards, initial) {
    const top = grid.el.getBoundingClientRect().top, vh = window.innerHeight;
    let n = 0;
    cards.sort((a, b) => a.y - b.y || a.x - b.x).forEach((c) => {
      if (c.awaitingGhost) { c.inner.style.opacity = '0'; return; }
      const y = top + c.y;
      if (y > vh - 20) { reveals.hold(c); return; }
      if (y + c.artH < -40) return;
      play(c, (initial ? 1100 : 40) + n++ * (initial ? 80 : 45));
    });
  }

  function render(opts) {
    opts = opts || {};
    const before = new Set(state.visible.map((p) => p.id));
    state.visible = computeVisible();
    const after = new Set(state.visible.map((p) => p.id));
    for (const [id, c] of grid.cards) if (!after.has(id) && c.shown) hideCard(c, opts.initial);
    const entering = [];
    for (const p of state.visible) {
      const c = cardFor(p);
      if (!c.shown) {
        c.shown = true;
        if (c.hideAnim) c.hideAnim.cancel();
        c.el.hidden = false;
      }
      if (!before.has(p.id)) entering.push(c);
    }
    layout();
    animateIn(entering, opts.initial);
    filters.sync();
    keyFilter.sync();
    syncViews();
    syncEmpty();
  }

  function syncEmpty() {
    const none = state.visible.length === 0;
    $('empty').hidden = !none;
    if (!none) return;
    const special = state.view === 'saved' && state.saved.size === 0 ? 'saved' : state.view === 'mine' && !state.pins.some((p) => p.mine) ? 'mine' : null;
    $('empty-title').textContent = special === 'saved' ? 'Nothing saved yet' : special === 'mine' ? 'You haven’t published anything' : state.query ? 'Nothing matches “' + state.query + '”' : 'Nothing matches these filters';
    $('empty-text').textContent = special === 'saved' ? 'Save any entry and it will wait for you here.' : special === 'mine' ? 'Drop a .mid file anywhere on this page to publish your first entry.' : 'Try another word, key or category.';
    $('empty-reset').textContent = special === 'mine' ? 'Upload a MIDI file' : 'Show the whole catalogue';
  }

  function resetFilters() {
    state.category = 'all';
    state.key = null;
    state.view = 'all';
    state.query = '';
    render();
  }

  /* ---------- Saving ---------- */
  function toggleSave(pin, fromEl) {
    const was = state.saved.has(pin.id);
    if (was) { state.saved.delete(pin.id); pin.saves = Math.max(0, pin.saves - 1); }
    else { state.saved.add(pin.id); pin.saves++; if (fromEl) flyToSaved(fromEl, pin); }
    MP.store.set('saved', Array.from(state.saved));
    const c = grid.cards.get(pin.id);
    if (c) renderSave(c.save, !was);
    if (sleeve.pin === pin) sleeve.syncSave();
    syncViews();
    if (state.view === 'saved') render();
  }
  function flyToSaved(fromEl, pin) {
    const target = document.querySelector('.views [data-view="saved"]');
    const tab = document.querySelector('.tabbar [data-tab="saved"]');
    const dest = target && target.offsetParent ? target : tab && tab.offsetParent ? tab : null;
    if (reduced || !dest) return;
    const a = fromEl.getBoundingClientRect(), b = dest.getBoundingClientRect();
    const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2, x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
    const cx = (x0 + x1) / 2, cy = Math.min(y0, y1) - 160;
    const color = pin.key.none ? 'var(--ink)' : noteHex(pin.key.tonic);
    const dot = h('div', { class: 'fly-dot', style: { background: color, boxShadow: '0 0 18px ' + color } });
    document.body.append(dot);
    const frames = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20, u = 1 - t;
      const x = u * u * x0 + 2 * u * t * cx + t * t * x1, y = u * u * y0 + 2 * u * t * cy + t * t * y1;
      frames.push({ transform: 'translate(' + x + 'px,' + y + 'px) scale(' + (1 + Math.sin(t * Math.PI) * 0.5 - t * 0.6) + ')', opacity: t > 0.9 ? (1 - t) / 0.1 : 1 });
    }
    MP.animate(dot, frames, { duration: 820, easing: 'cubic-bezier(.45,0,.2,1)' }).finished.then(() => {
      dot.remove();
      MP.animate(dest, [{ transform: 'translateY(-3px)' }, { transform: 'none' }], { easing: 'bouncy' });
    });
  }

  /* ---------- Header ---------- */
  function initHeader() {
    document.querySelector('.st-icon').innerHTML = MP.icon('search');
    $('hover-toggle').innerHTML = MP.icon('headphones');
    $('publish-btn').insertAdjacentHTML('afterbegin', MP.icon('arrowUp'));
    $('publish-btn').setAttribute('aria-label', 'Upload a MIDI file');
    document.querySelectorAll('.tab-icon').forEach((el) => (el.innerHTML = MP.icon(el.dataset.icon)));
    syncThemeButton();
    syncHoverButton();

    $('views').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (b) setView(b.dataset.view);
    });
    $('tabbar').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      const tab = b.dataset.tab;
      if (tab === 'search') palette.show();
      else if (tab === 'upload') publisher.show();
      else setView(tab === 'saved' ? 'saved' : 'all');
    });
    $('search-trigger').addEventListener('click', () => palette.show());
    $('hover-toggle').addEventListener('click', () => {
      state.hoverListen = !state.hoverListen;
      MP.store.set('hoverListen', state.hoverListen);
      MP.audio.ensure();
      syncHoverButton();
      if (!state.hoverListen && player.source === 'hover') player.stop();
      toast(state.hoverListen ? 'Listen on hover is on. Rest the pointer on a sleeve to hear it.' : 'Listen on hover is off', { icon: 'headphones', color: noteHex(7) });
    });
    $('theme-toggle').addEventListener('click', (e) => switchTheme(state.theme === 'dark' ? 'light' : 'dark', e.currentTarget));
    $('publish-btn').addEventListener('click', () => publisher.show());
    $('hero-publish').addEventListener('click', () => publisher.show());
    $('hero-browse').addEventListener('click', (e) => { e.preventDefault(); scrollToCatalogue(); });
    $('empty-reset').addEventListener('click', () => (state.view === 'mine' && !state.pins.some((p) => p.mine) ? publisher.show() : resetFilters()));
    $('brand').addEventListener('click', (e) => {
      e.preventDefault();
      if (state.category !== 'all' || state.key || state.query || state.view !== 'all') resetFilters();
      window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    });
    for (const id of ['publish-btn', 'hero-publish', 'pub-submit']) {
      const b = $(id);
      b.addEventListener('pointermove', (e) => {
        const r = b.getBoundingClientRect();
        b.style.setProperty('--mx', e.clientX - r.left + 'px');
        b.style.setProperty('--my', e.clientY - r.top + 'px');
      });
    }

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const y = window.scrollY;
        $('bar').classList.toggle('is-solid', y > 6);
        const fb = $('filters');
        fb.classList.toggle('is-stuck', fb.getBoundingClientRect().top <= $('bar').getBoundingClientRect().bottom + 0.5);
        hero.parallax(y);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
  function setView(v) {
    if (state.view === v) { scrollToCatalogue(); return; }
    state.view = v;
    render();
    scrollToCatalogue();
  }
  function syncViews() {
    const saved = state.saved.size, mine = state.pins.filter((p) => p.mine).length;
    $('saved-count').textContent = saved ? String(saved) : '';
    $('mine-count').textContent = mine ? String(mine) : '';
    let active = null;
    for (const b of $('views').querySelectorAll('button[data-view]')) {
      const on = b.dataset.view === state.view;
      b.setAttribute('aria-pressed', String(on));
      if (on) active = b;
    }
    slideLine($('views-line'), active, true);
    for (const b of $('tabbar').querySelectorAll('button[data-tab]')) b.setAttribute('aria-pressed', String((b.dataset.tab === 'all' && state.view !== 'saved') || (b.dataset.tab === 'saved' && state.view === 'saved')));
  }
  function syncHoverButton() {
    const b = $('hover-toggle');
    b.setAttribute('aria-pressed', String(state.hoverListen));
    b.dataset.tip = state.hoverListen ? 'Listen on hover: on' : 'Listen on hover: off';
    b.setAttribute('aria-label', 'Listen on hover');
  }
  function syncThemeButton() {
    const b = $('theme-toggle'), dark = state.theme === 'dark';
    b.innerHTML = MP.icon(dark ? 'sun' : 'moon');
    b.dataset.tip = dark ? 'Daylight' : 'Night';
    b.setAttribute('aria-label', dark ? 'Switch to the light look' : 'Switch to the dark look');
  }
  function scrollToCatalogue() {
    const target = $('catalogue').getBoundingClientRect().top + window.scrollY - 8;
    if (Math.abs(window.scrollY - target) > 4) window.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' });
  }

  /* ---------- Theme ---------- */
  function switchTheme(next, fromEl) {
    MP.store.set('theme', next);
    const apply = () => {
      document.documentElement.setAttribute('data-theme', next);
      themeChanged(true);
    };
    if (!document.startViewTransition || reduced || !fromEl) return apply();
    const r = fromEl.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const vt = document.startViewTransition(apply);
    vt.ready.then(() => {
      document.documentElement.animate({ clipPath: ['circle(0px at ' + x + 'px ' + y + 'px)', 'circle(' + radius + 'px at ' + x + 'px ' + y + 'px)'] }, { duration: 760, easing: EXPO, pseudoElement: '::view-transition-new(root)' });
    }, () => {});
  }
  function themeChanged(sync) {
    const t = MP.theme();
    if (t === state.theme) return;
    state.theme = t;
    document.querySelector('meta[name="theme-color"]').setAttribute('content', t === 'dark' ? '#0c0c0b' : '#f2f1ed');
    syncThemeButton();
    for (const c of grid.cards.values()) {
      paintVars(c.el, c.pin);
      c.drawn = null;
      if (!c.shown) continue;
      if (sync && onScreen(c.art)) drawCard(c, performance.now());
      else wake(c);
    }
    keyFilter.paint();
    paintLegend();
    if (sleeve.open) sleeve.repaint();
    if (publisher.card) { paintVars(publisher.card.el, publisher.card.pin); publisher.card.drawn = null; wake(publisher.card); }
    dock.repaint();
    ribbon.repaint();
    if (sync && !sleeve.open) ribbon.frame(performance.now());
  }
  function paintLegend() {
    $('footer-legend').replaceChildren(...FIFTHS.map((pc) => h('span', { style: '--dot:' + noteHex(pc) }, h('i'), MP.NOTE_NAMES[pc])));
  }

  /* ---------- Hero ---------- */
  const hero = {
    intro() {
      if (reduced) return;
      const bar = $('bar').querySelectorAll('.brand, .views, .bar-actions > *');
      bar.forEach((el, i) => MP.animate(el, [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 800, delay: 60 + i * 50, easing: EXPO, fill: 'backwards' }));
      MP.animate(document.querySelector('.kicker'), [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 900, delay: 120, easing: EXPO, fill: 'backwards' });
      document.querySelectorAll('.display .line > span').forEach((el, i) => MP.animate(el, [{ transform: 'translateY(108%) rotate(2deg)' }, { transform: 'none' }], { duration: 1300, delay: 180 + i * 120, easing: EXPO, fill: 'backwards' }));
      MP.animate(document.querySelector('.hero-side'), [{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }], { duration: 1100, delay: 560, easing: EXPO, fill: 'backwards' });
      MP.animate($('ribbon-canvas'), [{ clipPath: 'inset(0 100% 0 0)', opacity: 0.4 }, { clipPath: 'inset(0 0% 0 0)', opacity: 1 }], { duration: 1800, delay: 520, easing: EXPO, fill: 'backwards' });
      MP.animate(document.querySelector('.ribbon-cap'), [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 900, delay: 1050, easing: EXPO, fill: 'backwards' });
      document.querySelectorAll('.specs > div').forEach((el, i) => MP.animate(el, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 900, delay: 1200 + i * 90, easing: EXPO, fill: 'backwards' }));
    },
    parallax(y) {
      if (reduced || y > 1200) return;
      const head = document.querySelector('.hero-grid');
      head.style.transform = y > 0 ? 'translate3d(0,' + (y * -0.1).toFixed(1) + 'px,0)' : '';
      head.style.opacity = y > 0 ? String(MP.clamp(1 - y / 900, 0.3, 1)) : '';
    },
  };

  /* The featured arrangement plays across the hero as a live score. */
  const ribbon = {
    pin: null,
    t: 6,
    last: 0,
    visible: true,
    canvas: $('ribbon-canvas'),
    odo: null,
    section: null,
    init() {
      const pin = state.pins.find((p) => p.featured) || state.pins.filter((p) => p.complex).sort((a, b) => b.saves - a.saves)[0] || state.pins[0];
      this.pin = pin;
      $('ribbon-no').textContent = catNo(pin) + ' · Featured arrangement';
      $('ribbon-title').textContent = pin.title;
      $('ribbon-facts').textContent = pin.parts.length + ' parts · ' + MP.fmtTime(pin.duration) + ' · ' + ART.tempoLabel(pin) + ' · ' + keyLabel(pin);
      this.odo = makeOdo($('ribbon-bar'), 3);
      $('ribbon-play').innerHTML = MP.icon('play', 'icon-play');
      $('ribbon-open').insertAdjacentHTML('beforeend', MP.icon('arrowR'));
      $('ribbon-play').addEventListener('click', () => {
        if (player.pin === pin) player.toggle(pin, 'click');
        else player.play(pin, MP.clamp(this.t, 0, pin.duration - 0.1), 'click');
      });
      $('ribbon-open').addEventListener('click', () => openPin(pin));
      if ('IntersectionObserver' in window) {
        new IntersectionObserver((entries) => {
          this.visible = entries[0].isIntersecting;
          if (this.visible) wake();
        }).observe($('ribbon'));
      }
      this.size();
      window.addEventListener('resize', () => { this.size(); wake(); });
    },
    size() {
      const r = this.canvas.getBoundingClientRect();
      this.canvas.width = Math.round(r.width * dpr());
      this.canvas.height = Math.round(r.height * dpr());
    },
    sync() {
      const playing = player.pin === this.pin && player.playing;
      $('ribbon-play').innerHTML = MP.icon(playing ? 'pause' : 'play', playing ? '' : 'icon-play');
      $('ribbon-play').setAttribute('aria-label', playing ? 'Pause the featured arrangement' : 'Listen to the featured arrangement');
    },
    repaint() { this.last = 0; },
    frame(now) {
      const pin = this.pin;
      if (!pin || !this.visible || !this.canvas.width) { this.last = 0; return false; }
      let t;
      if (player.pin === pin && (player.playing || player.offset > 0)) {
        t = player.position;
        this.t = t;
      } else {
        const dt = this.last && !reduced ? Math.min(0.1, (now - this.last) / 1000) : 0;
        this.t += dt;
        if (this.t > pin.duration + 2) this.t = -2;
        t = this.t;
      }
      this.last = now;
      const span = MP.clamp(this.canvas.width / dpr() / 80, 7, 22);
      ART.score(this.canvas, pin, { t, span, at: 0.32, ruler: true, fade: true, theme: state.theme });
      this.odo.set(ART.barBeat(pin, Math.max(0, t)).bar);
      let sec = '';
      for (const m of pin.markers) if (m.t <= t + 0.01) sec = m.text;
      if (sec !== this.section) {
        this.section = sec;
        const el = $('ribbon-section');
        el.textContent = sec || '—';
        if (!reduced) MP.animate(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 500, easing: EXPO });
      }
      return !reduced || (player.pin === pin && player.playing);
    },
  };

  /* ---------- Key filter: the circle of fifths in a popover ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  };
  const keyFilter = {
    segs: [],
    hover: null,
    init() {
      const svg = svgEl('svg', { viewBox: '0 0 400 400', role: 'presentation' });
      const C = 200;
      for (const ring of [{ mode: 'major', r: 162, sw: 38 }, { mode: 'minor', r: 108, sw: 30 }]) {
        const half = Math.PI / 12 - ring.sw / 2 / ring.r - 3 / ring.r;
        for (let i = 0; i < 12; i++) {
          const maj = (i * 7) % 12;
          const tonic = ring.mode === 'major' ? maj : (maj + 9) % 12;
          const mid = -Math.PI / 2 + (i * Math.PI) / 6, a0 = mid - half, a1 = mid + half;
          const pt = (a) => (C + ring.r * Math.cos(a)).toFixed(2) + ' ' + (C + ring.r * Math.sin(a)).toFixed(2);
          const g = svgEl('g', { class: 'w-seg is-' + ring.mode, tabindex: '0', role: 'button' });
          g.append(svgEl('path', { d: 'M ' + pt(a0) + ' A ' + ring.r + ' ' + ring.r + ' 0 0 1 ' + pt(a1), 'stroke-width': ring.sw }));
          const text = svgEl('text', { x: (C + ring.r * Math.cos(mid)).toFixed(2), y: (C + ring.r * Math.sin(mid)).toFixed(2) });
          text.textContent = ring.mode === 'major' ? MP.MAJOR_NAMES[tonic] : MP.MINOR_NAMES[tonic] + 'm';
          g.append(text);
          const seg = { g, tonic, mode: ring.mode, i, count: 0 };
          g.addEventListener('click', () => this.pick(seg));
          g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.pick(seg); } });
          g.addEventListener('pointerenter', () => { this.hover = seg; this.center(); });
          g.addEventListener('pointerleave', () => { this.hover = null; this.center(); });
          svg.append(g);
          this.segs.push(seg);
        }
      }
      const center = svgEl('g', { class: 'w-center' });
      center.append(svgEl('circle', { cx: C, cy: C, r: 68 }));
      this.c1 = svgEl('text', { class: 'w-c1', x: C, y: C + 2 });
      this.c2 = svgEl('text', { class: 'w-c2', x: C, y: C + 24 });
      center.append(this.c1, this.c2);
      center.addEventListener('click', () => this.clear());
      svg.append(center);
      $('wheel').append(svg);
      this.paint();
      $('key-btn').addEventListener('click', () => (this.isOpen() ? this.close() : this.open()));
      $('key-clear').addEventListener('click', () => { this.clear(); this.close(); });
      document.addEventListener('pointerdown', (e) => { if (this.isOpen() && !$('keypop').contains(e.target) && !$('key-btn').contains(e.target)) this.close(); });
    },
    isOpen() { return !$('keypop').hidden; },
    open() {
      const pop = $('keypop'), btn = $('key-btn');
      pop.hidden = false;
      const r = btn.getBoundingClientRect(), pw = pop.offsetWidth;
      pop.style.top = r.bottom + window.scrollY + 10 + 'px';
      pop.style.left = MP.clamp(r.right + window.scrollX - pw, 16, document.documentElement.clientWidth - pw - 16) + 'px';
      btn.setAttribute('aria-expanded', 'true');
      MP.animate(pop, [{ opacity: 0, transform: 'translateY(-8px) scale(0.97)', transformOrigin: '85% 0' }, { opacity: 1, transform: 'none', transformOrigin: '85% 0' }], { duration: 520, easing: EXPO });
      if (!reduced) this.segs.forEach((s) => MP.animate(s.g, [{ opacity: 0, transform: 'scale(0.86) rotate(-10deg)' }, { opacity: s.count || this.isOn(s) ? 1 : 0.28, transform: 'none' }], { duration: 820, delay: 40 + s.i * 22 + (s.mode === 'minor' ? 90 : 0), easing: EXPO, fill: 'backwards' }));
    },
    close() {
      const pop = $('keypop');
      if (pop.hidden) return;
      $('key-btn').setAttribute('aria-expanded', 'false');
      MP.animate(pop, [{ opacity: 1 }, { opacity: 0, transform: 'scale(0.98)' }], { duration: 140, easing: 'ease-in' }).finished.then(() => (pop.hidden = true), () => (pop.hidden = true));
    },
    paint() {
      const dark = state.theme === 'dark';
      for (const s of this.segs) {
        const hue = MP.hueOf(s.tonic);
        s.g.style.setProperty('--rest', MP.rgba(dark ? MP.oklch(s.mode === 'major' ? 0.3 : 0.27, 0.05, hue) : MP.oklch(s.mode === 'major' ? 0.92 : 0.945, 0.045, hue)));
        s.g.style.setProperty('--on', MP.noteColor(s.tonic + 60, state.theme));
        s.g.style.setProperty('--glow', MP.noteColor(s.tonic + 60, state.theme, 0.55));
      }
      this.sync();
    },
    isOn(s) { return !!(state.key && state.key.tonic === s.tonic && state.key.mode === s.mode); },
    sync() {
      const pool = state.pins.filter((p) => inView(p) && inCategory(p, state.category) && matches(p, state.query));
      this.total = pool.length;
      for (const s of this.segs) {
        s.count = pool.filter((p) => !p.key.none && p.key.tonic === s.tonic && p.key.mode === s.mode).length;
        const on = this.isOn(s);
        s.g.classList.toggle('is-on', on);
        s.g.classList.toggle('is-empty', s.count === 0 && !on);
        s.g.setAttribute('aria-pressed', String(on));
        s.g.setAttribute('aria-label', MP.keyName(s) + ', ' + s.count + (s.count === 1 ? ' entry' : ' entries'));
        s.g.setAttribute('tabindex', s.count || on ? '0' : '-1');
      }
      this.center();
      const k = state.key;
      $('key-value').textContent = k ? MP.keyShort(k) + (k.mode === 'minor' ? '' : ' major') : 'Any';
      $('key-btn').style.setProperty('--dot', k ? noteHex(k.tonic) : '');
    },
    center() {
      const s = this.hover && (this.hover.count || this.isOn(this.hover)) ? this.hover : null;
      const k = s || state.key;
      const count = s ? s.count : state.key ? state.visible.length : this.total;
      this.c1.textContent = k ? MP.keyName(k) : 'Any key';
      this.c2.textContent = count + (count === 1 ? ' entry' : ' entries');
    },
    pick(seg) {
      const on = this.isOn(seg);
      if (!seg.count && !on) return;
      state.key = on ? null : { tonic: seg.tonic, mode: seg.mode };
      if (!on) {
        const root = 55 + MP.pc(seg.tonic - 55);
        MP.audio.chord([root - 12, root, root + (seg.mode === 'minor' ? 3 : 4), root + 7], 'keys');
      }
      render();
    },
    clear() {
      if (!state.key) return;
      state.key = null;
      render();
    },
  };

  /* ---------- Categories and sorting ---------- */
  const filters = {
    chips: [],
    build() {
      const box = $('cats');
      box.querySelectorAll('.cat').forEach((c) => c.remove());
      this.chips = ['all'].concat(CATEGORIES).map((name) => {
        const b = h('button', { class: 'cat', type: 'button', role: 'tab', 'aria-selected': 'false', 'data-value': name }, name === 'all' ? 'Everything' : name, h('span', { class: 'cat-n' }));
        b.addEventListener('click', () => {
          if (state.category === name) return;
          state.category = name;
          render();
          if (window.scrollY > $('catalogue').offsetTop + 40) scrollToCatalogue();
        });
        box.append(b);
        return b;
      });
      if (!this.sort) this.sort = makeSeg($('sort'), null, state.sort, (v) => { state.sort = v; render(); });
      this.place(false);
    },
    place(animate) {
      const active = this.chips.find((c) => c.dataset.value === state.category) || this.chips[0];
      slideLine($('cats-line'), active, animate);
      if (this.sort) this.sort.place(false);
      let v = null;
      for (const b of $('views').querySelectorAll('button[data-view]')) if (b.dataset.view === state.view) v = b;
      slideLine($('views-line'), v, false);
    },
    sync() {
      const pool = state.pins.filter((p) => inView(p) && inKey(p) && matches(p, state.query));
      for (const c of this.chips) {
        c.setAttribute('aria-selected', String(c.dataset.value === state.category));
        const n = pool.filter((p) => inCategory(p, c.dataset.value)).length;
        c.querySelector('.cat-n').textContent = String(n);
        c.disabled = n === 0 && c.dataset.value !== state.category;
      }
      this.place(true);
      const active = this.chips.find((c) => c.dataset.value === state.category);
      if (active) {
        const box = $('cats');
        if (active.offsetLeft < box.scrollLeft || active.offsetLeft + active.offsetWidth > box.scrollLeft + box.clientWidth - 48) box.scrollTo({ left: active.offsetLeft - 24, behavior: 'smooth' });
      }
      const status = $('filter-status');
      const inner = h('div', { class: 'filter-status-inner' });
      const token = (label, dot, onClear) => h('span', { class: 'token', style: dot ? '--dot:' + dot : null }, dot ? h('i') : null, label, h('button', { type: 'button', 'aria-label': 'Remove filter: ' + label, html: MP.icon('close'), onclick: onClear }));
      if (state.view === 'saved') inner.append(token('Saved', null, () => { state.view = 'all'; render(); }));
      if (state.view === 'mine') inner.append(token('Yours', null, () => { state.view = 'all'; render(); }));
      if (state.key) inner.append(token(MP.keyName(state.key), noteHex(state.key.tonic), () => keyFilter.clear()));
      if (state.query) inner.append(token('“' + state.query + '”', null, () => { state.query = ''; render(); }));
      const open = inner.children.length > 0;
      if (open) inner.append(h('span', { class: 'result-count' }, state.visible.length + (state.visible.length === 1 ? ' entry' : ' entries')));
      status.replaceChildren(inner);
      status.classList.toggle('is-open', open);
      const all = state.pins;
      $('cat-count').innerHTML = '<b>' + all.length + '</b> entries · <b>' + all.filter((p) => p.complex).length + '</b> arrangements · <b>' + MP.fmtNumber(all.reduce((n, p) => n + p.notes.length, 0)) + '</b> notes';
    },
  };

  /* ---------- Search palette ---------- */
  const palette = {
    el: $('palette'),
    input: $('search-input'),
    list: $('palette-list'),
    items: [],
    sel: 0,
    init() {
      this.el.querySelector('.pf-icon').innerHTML = MP.icon('search');
      this.el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) this.hide(); });
      this.input.addEventListener('input', () => this.update());
      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this.select(MP.clamp(this.sel + (e.key === 'ArrowDown' ? 1 : -1), 0, this.items.length - 1), true);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) this.applyQuery();
          else if (this.items[this.sel]) this.items[this.sel].run();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.hide();
        }
      });
    },
    get open() { return !this.el.hidden; },
    show() {
      if (this.open) return;
      if (sleeve.open) closeSleeve();
      keyFilter.close();
      this.prevFocus = document.activeElement;
      this.el.hidden = false;
      lockScroll(true);
      this.input.value = state.query;
      this.update();
      MP.animate(this.el.querySelector('.palette-backdrop'), [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
      MP.animate(this.el.querySelector('.palette-panel'), [{ opacity: 0, transform: 'translateY(-10px) scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: EXPO });
      requestAnimationFrame(() => { this.input.focus(); this.input.select(); });
    },
    hide() {
      if (!this.open) return;
      const panel = this.el.querySelector('.palette-panel');
      MP.animate(panel, [{ opacity: 1 }, { opacity: 0, transform: 'scale(0.985)' }], { duration: 140, easing: 'ease-in' }).finished.then(() => { this.el.hidden = true; }, () => { this.el.hidden = true; });
      lockScroll(false);
      if (this.prevFocus && document.body.contains(this.prevFocus)) this.prevFocus.focus({ preventScroll: true });
    },
    applyQuery() {
      state.query = this.input.value.trim();
      this.hide();
      render();
      scrollToCatalogue();
    },
    parseKey(q) {
      const m = /^([a-g])\s*([#b]?)\s*(m|min|minor|maj|major)?$/i.exec(norm(q).trim());
      if (!m) return null;
      const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
      const tonic = MP.pc(base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0));
      return { tonic, mode: m[3] && /^m(in|inor)?$/i.test(m[3]) ? 'minor' : 'major' };
    },
    update() {
      const q = this.input.value.trim();
      const items = [];
      const groups = [];
      const pinItem = (p) => ({ kind: 'pin', pin: p, run: () => { this.hide(); openPin(p); } });
      if (!q) {
        groups.push(['Suggestions', [
          { kind: 'cat', label: 'Arrangements', sub: 'Entries with five or more parts', run: () => { state.category = 'Arrangements'; this.hide(); render(); scrollToCatalogue(); } },
          { kind: 'key', key: { tonic: 4, mode: 'minor' }, label: 'E minor', sub: 'Filter the catalogue by key' },
          { kind: 'query', label: '120 bpm', sub: 'Tempo within six beats' },
          { kind: 'query', label: 'Piano', sub: 'Category' },
        ]]);
        groups.push(['Most saved', state.pins.slice().sort((a, b) => b.saves - a.saves).slice(0, 4).map(pinItem)]);
      } else {
        const nq = norm(q);
        const hits = state.pins.filter((p) => matches(p, q));
        const rank = (p) => (norm(p.title).indexOf(nq) === 0 ? 0 : norm(p.title).indexOf(nq) > 0 ? 1 : 2) - p.saves / 1e6;
        const top = hits.sort((a, b) => rank(a) - rank(b)).slice(0, 7);
        const k = this.parseKey(q);
        if (k) groups.push(['Key', [{ kind: 'key', key: k, label: MP.keyName(k), sub: 'Filter the catalogue by key' }]]);
        const authors = Array.from(new Set(state.pins.map((p) => p.author))).filter((a) => !a.me && (norm(a.name).indexOf(nq) >= 0 || norm(a.handle).indexOf(nq.replace('@', '')) >= 0));
        if (top.length) groups.push(['Entries', top.map(pinItem)]);
        if (authors.length) groups.push(['Creators', authors.slice(0, 3).map((a) => ({ kind: 'creator', author: a, label: a.name, sub: '@' + a.handle + ' · ' + state.pins.filter((p) => p.author === a).length + ' entries', run: () => { this.input.value = a.handle; this.applyQuery(); } }))]);
        groups.push(['', [{ kind: 'all', label: hits.length ? 'Show all ' + hits.length + (hits.length === 1 ? ' result' : ' results') + ' in the catalogue' : 'Nothing found for “' + q + '”', sub: hits.length ? 'Filters the board below' : 'Try a key like A minor, a tempo like 90 bpm, or a creator', run: () => (hits.length ? this.applyQuery() : null) }]]);
      }
      for (const [, list] of groups) for (const it of list) {
        if (it.kind === 'key') it.run = () => { state.key = it.key; this.hide(); render(); scrollToCatalogue(); };
        if (it.kind === 'query') it.run = () => { this.input.value = it.label; this.applyQuery(); };
        items.push(it);
      }
      this.items = items;
      this.render(groups, q);
      this.select(0, false);
    },
    render(groups, q) {
      const frag = document.createDocumentFragment();
      let idx = 0;
      const nq = norm(q);
      for (const [title, list] of groups) {
        if (!list.length) continue;
        if (title) frag.append(h('p', { class: 'pl-group mono-label' }, title));
        for (const it of list) {
          const i = idx++;
          let thumb, label, sub;
          if (it.kind === 'pin') {
            const c = h('canvas');
            thumb = h('span', { class: 'pl-thumb' }, c);
            paintVars(thumb, it.pin);
            c.width = c.height = Math.round(44 * dpr());
            ART.draw(c, it.pin, { theme: state.theme });
            const t = it.pin.title, at = nq ? norm(t).indexOf(nq) : -1;
            label = h('span', { class: 'pl-title' });
            if (at >= 0) label.append(t.slice(0, at), h('mark', null, t.slice(at, at + q.length)), t.slice(at + q.length));
            else label.textContent = t;
            sub = catNo(it.pin) + ' · ' + it.pin.author.handle + ' · ' + keyLabel(it.pin) + ' · ' + Math.round(it.pin.bpm) + ' BPM · ' + it.pin.parts.length + (it.pin.parts.length === 1 ? ' part' : ' parts');
          } else if (it.kind === 'creator') {
            thumb = h('span', { class: 'pl-glyph' }, avatar(it.author));
            label = h('span', { class: 'pl-title' }, it.label);
            sub = it.sub;
          } else {
            thumb = h('span', { class: 'pl-glyph', html: it.kind === 'key' ? '' : MP.icon(it.kind === 'all' ? 'grid' : it.kind === 'cat' ? 'grid' : 'search') });
            if (it.kind === 'key') { thumb.append(h('i')); thumb.style.setProperty('--dot', noteHex(it.key.tonic)); }
            label = h('span', { class: 'pl-title' }, it.label);
            sub = it.sub;
          }
          const row = h('button', { class: 'pl-item', type: 'button', role: 'option', 'aria-selected': 'false', 'data-i': i, id: 'pl-' + i }, thumb, h('span', { class: 'pl-text' }, label, h('span', { class: 'pl-sub' }, sub)), h('span', { class: 'pl-go', html: MP.icon('arrowR') }));
          row.addEventListener('pointermove', () => { if (this.sel !== i) this.select(i, false); });
          row.addEventListener('click', () => it.run && it.run());
          frag.append(row);
        }
      }
      this.list.replaceChildren(frag);
    },
    select(i, scroll) {
      this.sel = i;
      for (const row of this.list.querySelectorAll('.pl-item')) {
        const on = +row.dataset.i === i;
        row.setAttribute('aria-selected', String(on));
        if (on) {
          this.input.setAttribute('aria-activedescendant', row.id);
          if (scroll) row.scrollIntoView({ block: 'nearest' });
        }
      }
    },
  };

  /* ---------- Now playing ---------- */
  const dock = {
    el: $('dock'),
    leds: [],
    levels: new Array(12).fill(0),
    tmp: new Array(12).fill(0),
    pin: null,
    odo: null,
    init() {
      this.odo = makeOdo($('dock-bar'), 3);
      const order = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
      this.leds = order.map((pc) => {
        const i = h('i');
        i.dataset.pc = pc;
        $('dock-leds').append(i);
        return i;
      });
      this.repaint();
      $('dock-close').innerHTML = MP.icon('close');
      $('dock-open').addEventListener('click', () => player.pin && openPin(player.pin));
      $('dock-toggle').addEventListener('click', () => player.pin && player.toggle(player.pin, player.source === 'hover' ? 'click' : player.source));
      $('dock-close').addEventListener('click', () => player.stop());
    },
    repaint() {
      this.leds.forEach((b) => b.style.setProperty('--c', MP.noteColor(+b.dataset.pc + 60, 'dark')));
      if (this.pin) this.drawArt();
    },
    drawArt() {
      const c = $('dock-canvas');
      c.width = c.height = 96;
      ART.draw(c, this.pin, { style: 'orbit', theme: 'dark' });
      this.el.style.setProperty('--dock-c', this.pin.key.none ? '#eee9e0' : MP.noteColor(this.pin.key.tonic + 60, 'dark'));
    },
    sync() {
      const pin = player.pin;
      const show = !!pin && !sleeve.open;
      this.el.dataset.state = show ? 'shown' : 'hidden';
      $('toasts').classList.toggle('above-dock', show);
      this.el.classList.toggle('is-playing', !!(pin && player.playing));
      if (!pin) return;
      if (this.pin !== pin) {
        this.pin = pin;
        $('dock-title').textContent = pin.title;
        $('dock-no').textContent = catNo(pin) + ' · ' + pin.author.handle;
        this.drawArt();
        $('dock-open').setAttribute('aria-label', 'Open ' + pin.title);
      }
      $('dock-toggle').innerHTML = MP.icon(player.playing ? 'pause' : 'play', player.playing ? '' : 'icon-play');
      $('dock-toggle').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
      this.frame();
    },
    frame() {
      const pin = player.pin;
      if (!pin || sleeve.open) return false;
      const t = player.position;
      $('dock-time').textContent = MP.fmtTime(t) + ' / ' + MP.fmtTime(pin.duration);
      $('dock-progress').style.transform = 'scaleX(' + (t / pin.duration).toFixed(4) + ')';
      this.odo.set(ART.barBeat(pin, t).bar);
      ART.activePitchClasses(pin, t, this.tmp);
      let live = false;
      for (let k = 0; k < 12; k++) {
        const target = player.playing ? this.tmp[k] : 0;
        this.levels[k] += (target - this.levels[k]) * (target > this.levels[k] ? 0.6 : 0.15);
        if (this.levels[k] > 0.01) live = true;
      }
      for (const b of this.leds) b.style.opacity = (0.14 + this.levels[+b.dataset.pc] * 0.86).toFixed(3);
      return player.playing || live;
    },
  };

  let lastPlayed = null;
  player.on((p, kind) => {
    const touched = new Set([lastPlayed, p.pin]);
    lastPlayed = p.pin;
    for (const pin of touched) {
      if (!pin) continue;
      const c = grid.cards.get(pin.id);
      if (c) { syncCard(c); c.drawn = null; wake(c); }
      if (publisher.card && publisher.card.pin === pin) { syncCard(publisher.card); publisher.card.drawn = null; wake(publisher.card); }
    }
    if (kind === 'load' && p.pin) p.pin.plays++;
    dock.sync();
    ribbon.sync();
    sleeve.sync();
    wake();
  });

  /* ---------- The sleeve: a full page for one entry ---------- */
  const STYLE_GLYPHS = {
    roll: '<svg viewBox="0 0 30 22" fill="currentColor" aria-hidden="true"><rect x="2" y="3" width="11" height="3.4" rx="1.7"/><rect x="15" y="3" width="8" height="3.4" rx="1.7"/><rect x="8" y="9.3" width="15" height="3.4" rx="1.7"/><rect x="3" y="15.6" width="9" height="3.4" rx="1.7"/><rect x="19" y="15.6" width="9" height="3.4" rx="1.7"/></svg>',
    orbit: '<svg viewBox="0 0 30 22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M15 2.5a8.5 8.5 0 0 1 8.5 8.5"/><path d="M22.4 15.4A8.5 8.5 0 0 1 8.2 16.2"/><path d="M15 6.6a4.4 4.4 0 0 1 4.1 6"/><circle cx="15" cy="11" r="1" fill="currentColor" stroke="none"/></svg>',
    fall: '<svg viewBox="0 0 30 22" fill="currentColor" aria-hidden="true"><rect x="5" y="2" width="3.4" height="8" rx="1.7"/><rect x="11" y="6" width="3.4" height="6" rx="1.7"/><rect x="17" y="1" width="3.4" height="11" rx="1.7"/><rect x="22.6" y="5" width="3.4" height="5" rx="1.7"/><rect x="3" y="15" width="24" height="5" rx="1.6" opacity=".45"/></svg>',
    steps: '<svg viewBox="0 0 30 22" fill="currentColor" aria-hidden="true"><rect x="3" y="2" width="4.5" height="4.5" rx="1.3"/><rect x="9.5" y="2" width="4.5" height="4.5" rx="1.3" opacity=".3"/><rect x="16" y="2" width="4.5" height="4.5" rx="1.3"/><rect x="22.5" y="2" width="4.5" height="4.5" rx="1.3" opacity=".3"/><rect x="3" y="8.7" width="4.5" height="4.5" rx="1.3" opacity=".3"/><rect x="9.5" y="8.7" width="4.5" height="4.5" rx="1.3"/><rect x="16" y="8.7" width="4.5" height="4.5" rx="1.3" opacity=".3"/><rect x="22.5" y="8.7" width="4.5" height="4.5" rx="1.3"/><rect x="3" y="15.4" width="4.5" height="4.5" rx="1.3"/><rect x="9.5" y="15.4" width="4.5" height="4.5" rx="1.3" opacity=".3"/><rect x="16" y="15.4" width="4.5" height="4.5" rx="1.3" opacity=".3"/><rect x="22.5" y="15.4" width="4.5" height="4.5" rx="1.3"/></svg>',
  };

  const sleeve = {
    el: $('sleeve'),
    scroll: $('sleeve-scroll'),
    art: $('s-art'),
    canvas: $('s-canvas'),
    scoreCanvas: $('score-canvas'),
    overviewCanvas: $('overview-canvas'),
    tl: $('t-canvas'),
    open: false,
    pin: null,
    style: 'roll',
    hoverT: null,
    dragT: null,
    scoreT: null,
    tlHover: null,
    viewT: 0,
    span: 12,
    pushed: false,
    anims: [],
    rows: [],
    levels: new Float32Array(0),
    sparkTick: 0,
    init() {
      this.el.querySelector('.s-back').insertAdjacentHTML('afterbegin', MP.icon('arrowL'));
      $('s-prev').innerHTML = MP.icon('chevL');
      $('s-next').innerHTML = MP.icon('chevR');
      $('s-download').innerHTML = MP.icon('download');
      $('s-link').innerHTML = MP.icon('link');
      $('s-remove').innerHTML = MP.icon('trash');
      $('t-loop').innerHTML = MP.icon('loop');
      $('zoom-out').innerHTML = MP.icon('minus');
      $('zoom-in').innerHTML = MP.icon('plus');
      this.barOdo = makeOdo($('t-bar'), 3);
      this.el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSleeve(); });
      $('s-prev').addEventListener('click', () => this.step(-1));
      $('s-next').addEventListener('click', () => this.step(1));
      $('s-download').addEventListener('click', () => download(this.pin));
      $('s-link').addEventListener('click', () => copyLink(this.pin));
      $('s-save').addEventListener('click', () => toggleSave(this.pin, $('s-save')));
      $('s-remove').addEventListener('click', () => this.removeClick());
      $('t-play').addEventListener('click', () => {
        if (player.pin === this.pin) player.toggle(this.pin, 'click');
        else player.play(this.pin, this.viewT, 'click');
      });
      $('t-loop').addEventListener('click', () => {
        player.loop = !player.loop;
        $('t-loop').setAttribute('aria-pressed', String(player.loop));
        $('t-loop').dataset.tip = player.loop ? 'Loop: on' : 'Loop';
      });
      this.viewSeg = makeSeg($('s-view'), ART.STYLES.map((s) => ({ value: s, html: STYLE_GLYPHS[s].replace('<svg', '<svg width="20" height="14"') + '<span>' + ART.LABELS[s] + '</span>' })), 'roll', (v) => this.setStyle(v));
      this.soundSeg = makeSeg($('s-sound'), SOUNDS.map(([value, label]) => ({ value, label })), 'original', (v) => {
        this.pin.sound = v;
        if (player.pin === this.pin) player.restart();
      });
      $('zoom-in').addEventListener('click', () => this.zoom(1 / 1.5));
      $('zoom-out').addEventListener('click', () => this.zoom(1.5));

      const art = this.art;
      art.addEventListener('pointermove', (e) => { this.hoverT = this.timeAt(e); wake(); });
      art.addEventListener('pointerleave', () => { this.hoverT = null; this.drawn = null; wake(); });
      art.addEventListener('click', (e) => this.playFrom(this.timeAt(e)));

      // Score: drag to move through the song, click to play from a moment, pinch to zoom.
      const score = $('score');
      let drag = null;
      score.addEventListener('pointerdown', (e) => {
        score.setPointerCapture(e.pointerId);
        drag = { x: e.clientX, t: this.scoreTime(), moved: false };
        score.classList.add('is-dragging');
      });
      score.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 4) drag.moved = true;
        if (drag.moved) {
          this.scoreT = MP.clamp(drag.t - (dx / score.clientWidth) * this.span, 0, this.pin.duration);
          wake();
        }
      });
      const end = (e) => {
        if (!drag) return;
        score.classList.remove('is-dragging');
        const r = score.getBoundingClientRect();
        const t = drag.moved ? this.scoreT : MP.clamp(drag.t + ((e.clientX - r.left) / r.width - 0.25) * this.span, 0, this.pin.duration);
        const moved = drag.moved;
        drag = null;
        this.scoreT = null;
        if (!moved && e.type === 'pointerup') return this.playFrom(t);
        this.viewT = t;
        if (player.pin === this.pin) player.seek(t);
        wake();
      };
      score.addEventListener('pointerup', end);
      score.addEventListener('pointercancel', end);
      score.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          this.zoom(Math.exp(e.deltaY * 0.01));
        } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          e.preventDefault();
          const t = MP.clamp(this.scoreTime() + (e.deltaX / score.clientWidth) * this.span, 0, this.pin.duration);
          if (player.pin === this.pin) player.seek(t);
          this.viewT = t;
          wake();
        }
      }, { passive: false });

      const overview = $('overview');
      const ovMove = (e) => {
        const r = overview.getBoundingClientRect();
        const t = MP.clamp((e.clientX - r.left) / r.width, 0, 1) * this.pin.duration;
        if (player.pin === this.pin) player.seek(t);
        this.viewT = t;
        wake();
      };
      overview.addEventListener('pointerdown', (e) => { overview.setPointerCapture(e.pointerId); overview.dragging = true; ovMove(e); });
      overview.addEventListener('pointermove', (e) => { if (overview.dragging) ovMove(e); });
      overview.addEventListener('pointerup', () => (overview.dragging = false));

      const tl = $('t-timeline');
      const fracAt = (e) => { const r = tl.getBoundingClientRect(); return MP.clamp((e.clientX - r.left) / r.width, 0, 1); };
      tl.addEventListener('pointerdown', (e) => { tl.setPointerCapture(e.pointerId); this.dragT = fracAt(e) * this.pin.duration; wake(); });
      tl.addEventListener('pointermove', (e) => {
        const f = fracAt(e);
        this.tlHover = f;
        if (this.dragT != null) this.dragT = f * this.pin.duration;
        const hv = $('t-hover');
        hv.hidden = false;
        hv.textContent = MP.fmtTime(f * this.pin.duration) + ' · bar ' + ART.barBeat(this.pin, f * this.pin.duration).bar;
        hv.style.left = f * 100 + '%';
        wake();
      });
      tl.addEventListener('pointerup', () => {
        if (this.dragT == null) return;
        const t = this.dragT;
        this.dragT = null;
        this.playFrom(t);
      });
      tl.addEventListener('pointercancel', () => { this.dragT = null; wake(); });
      tl.addEventListener('pointerleave', () => { this.tlHover = null; $('t-hover').hidden = true; wake(); });
      tl.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        e.stopPropagation();
        const base = player.pin === this.pin ? player.position : this.viewT;
        this.playFrom(MP.clamp(base + (e.key === 'ArrowRight' ? 5 : -5), 0, this.pin.duration));
      });

      if ('IntersectionObserver' in window && !reduced) {
        this.io = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            this.io.unobserve(e.target);
            e.target.style.opacity = '';
            MP.animate(e.target, [{ opacity: 0, transform: 'translateY(36px)' }, { opacity: 1, transform: 'none' }], { duration: 1000, easing: EXPO });
            if (e.target.contains($('tracks'))) this.rows.forEach((r, i) => MP.animate(r.el, [{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }], { duration: 700, delay: 120 + i * 45, easing: EXPO, fill: 'backwards' }));
          }
        }, { root: this.scroll, threshold: 0.08 });
      }
    },
    timeAt(e) {
      const r = this.canvas.getBoundingClientRect(), k = this.canvas.width / r.width;
      return ART.geometry(this.pin, this.style, this.canvas.width, this.canvas.height).timeAt((e.clientX - r.left) * k, (e.clientY - r.top) * k);
    },
    scoreTime() {
      if (this.scoreT != null) return this.scoreT;
      return player.pin === this.pin && (player.playing || player.offset > 0) ? player.position : this.viewT;
    },
    playFrom(t) {
      this.viewT = t;
      if (player.pin === this.pin) {
        player.seek(t);
        if (!player.playing) player.play(this.pin, t, 'click');
      } else player.play(this.pin, t, 'click');
    },
    zoom(f) {
      this.span = MP.clamp(this.span * f, 3, Math.max(8, Math.min(120, this.pin.duration)));
      $('zoom-value').textContent = (this.span < 10 ? this.span.toFixed(1) : Math.round(this.span)) + ' s';
      wake();
    },
    setStyle(s) {
      if (s === this.style) return;
      const out = MP.animate(this.art, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.97)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
      out.finished.then(() => {
        this.style = s;
        this.sizeArt();
        this.drawn = null;
        this.frame(performance.now());
        out.cancel();
        MP.animate(this.art, [{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: 700, easing: EXPO });
      }, () => {});
    },
    fill(pin) {
      this.pin = pin;
      this.style = pin.style;
      this.hoverT = null;
      this.drawn = null;
      this.viewT = player.pin === pin ? player.position : 0;
      this.span = MP.clamp(pin.duration < 30 ? 8 : 12, 3, Math.max(8, pin.duration));
      $('zoom-value').textContent = Math.round(this.span) + ' s';
      paintVars(this.el, pin);
      $('s-no').textContent = catNo(pin) + ' · ' + (pin.complex ? 'Arrangement' : 'Sketch');
      $('s-kicker').textContent = catNo(pin) + ' · ' + (pin.complex ? 'Arrangement' : 'Sketch') + ' · ' + pin.parts.length + (pin.parts.length === 1 ? ' part' : ' parts');
      const title = $('s-title');
      title.replaceChildren();
      this.words = pin.title.split(/(\s+)/).map((w) => {
        if (/^\s+$/.test(w)) { title.append(w); return null; }
        const inner = h('span', null, w);
        title.append(h('span', { class: 'w' }, inner));
        return inner;
      }).filter(Boolean);
      const following = state.following.has(pin.author.handle);
      const followBtn = h('button', { class: 'btn btn-ghost btn-sm btn-follow', type: 'button', 'aria-pressed': String(following) }, following ? 'Following' : 'Follow');
      followBtn.addEventListener('click', () => {
        const on = !state.following.has(pin.author.handle);
        if (on) state.following.add(pin.author.handle); else state.following.delete(pin.author.handle);
        MP.store.set('following', Array.from(state.following));
        followBtn.setAttribute('aria-pressed', String(on));
        followBtn.textContent = on ? 'Following' : 'Follow';
      });
      $('s-by').replaceChildren(
        avatar(pin.author),
        h('div', { class: 's-by-text' }, h('span', { class: 's-by-name' }, pin.author.me ? 'You' : pin.author.name), h('span', { class: 's-by-sub' }, pin.author.me ? 'Published from this browser' : '@' + pin.author.handle + ' · ' + MP.fmtCount(pin.author.followers + (following ? 1 : 0)) + ' followers')),
        pin.author.me ? null : followBtn
      );
      $('s-desc').textContent = pin.desc || '';
      $('s-desc').hidden = !pin.desc;
      $('s-tags').replaceChildren(...(pin.complex ? ['Arrangements'] : []).concat(pin.tags.filter((t) => t !== 'Arrangements')).map((t) => {
        const b = h('button', { class: 'tag', type: 'button' }, t);
        b.addEventListener('click', () => { state.category = t; closeSleeve(); render(); setTimeout(scrollToCatalogue, 380); });
        return b;
      }));
      $('s-tags').hidden = !pin.tags.length && !pin.complex;

      const spec = (label, value, extra, dot) => h('div', null, h('dt', null, label), h('dd', null, dot ? h('i', { style: '--dot:' + dot }) : null, value, extra ? h('small', null, extra) : null));
      const tc = pin.tempos.length - 1;
      const notesEl = h('span', null, '0');
      $('s-specs').replaceChildren(
        spec('Key', keyLabel(pin), null, pin.key.none ? null : noteHex(pin.key.tonic)),
        spec('Tempo', ART.tempoLabel(pin), tc > 0 ? tc + (tc === 1 ? ' change' : ' changes') : null),
        spec('Meter', pin.timeSig[0] + '/' + pin.timeSig[1], pin.meterChanges ? pin.meterChanges + (pin.meterChanges === 1 ? ' change' : ' changes') : null),
        spec('Length', MP.fmtTime(pin.duration), pin.bars.length + ' bars'),
        spec('Parts', String(pin.parts.length), pin.drumCount ? 'incl. drums' : null),
        spec('Notes', notesEl),
        spec('Range', pin.melodicCount ? MP.pitchName(pin.range[0]) + '–' + MP.pitchName(pin.range[1]) : '—'),
        spec('Pedal', pin.pedal ? MP.fmtNumber(pin.pedal) + ' events' : '—', pin.pedal ? 'sustain' : null),
        spec('Source', pin.mine ? 'Type ' + pin.format + ' file' : 'Starter catalogue', pin.mine ? pin.tracks + ' tracks' : null),
        spec('Published', MP.timeAgo(pin.createdAt), MP.fmtCount(pin.plays) + ' plays')
      );
      countUp(notesEl, pin.notes.length, 900);
      const max = Math.max.apply(null, pin.chroma) || 1;
      $('s-chroma').replaceChildren(...FIFTHS.map((pc) => h('span', { title: MP.NOTE_NAMES[pc] + ' · ' + Math.round(pin.chroma[pc] * 100) + '%' }, h('i', { style: '--dot:' + noteHex(pc) + ';height:' + Math.max(4, (pin.chroma[pc] / max) * 100) + '%' }), h('b', null, MP.NOTE_NAMES[pc]))));
      this.viewSeg.set(this.style);
      this.soundSeg.set(pin.sound || 'original');
      const canDownload = !(pin.mine && !pin.allowDownload);
      $('s-download').disabled = !canDownload;
      $('s-download').dataset.tip = canDownload ? 'Download .mid' : 'The creator turned off downloads';
      $('s-remove').hidden = !pin.mine;
      this.resetRemove();
      this.syncSave();
      $('t-dur').textContent = MP.fmtTime(pin.duration);
      $('t-loop').setAttribute('aria-pressed', String(player.loop));
      const i = state.visible.indexOf(pin);
      $('s-prev').disabled = i <= 0;
      $('s-next').disabled = i < 0 || i >= state.visible.length - 1;
      this.buildTracks(pin);
      this.fillMore(pin);
      this.sync();
    },
    buildTracks(pin) {
      const box = $('tracks');
      const cls = ['', 'track-ch', '', 'track-gm', '', 'track-range', 'track-spark-cell', ''];
      const head = h('div', { class: 'track track-head', role: 'row' }, ...['', 'Ch', 'Part', 'Instrument', 'Notes', 'Range', 'Where it plays', 'M · S'].map((t, i) => h('span', { role: 'columnheader', class: cls[i] || null }, t)));
      this.rows = pin.parts.map((p, i) => {
        const color = ART.partColor(pin, i, state.theme);
        const led = h('span', { class: 'track-led', style: '--c:' + MP.rgba(color) });
        const spark = h('canvas', { class: 'track-spark', 'aria-hidden': 'true' });
        const mute = h('button', { class: 'is-mute', type: 'button', 'aria-pressed': String(pin.mix.mute.has(i)), 'aria-label': 'Mute ' + p.name }, 'M');
        const solo = h('button', { class: 'is-solo', type: 'button', 'aria-pressed': String(pin.mix.solo.has(i)), 'aria-label': 'Solo ' + p.name }, 'S');
        const el = h('div', { class: 'track', role: 'row' },
          led,
          h('span', { class: 'track-ch' }, p.drums ? 'DR' : 'CH ' + String(p.ch + 1).padStart(2, '0')),
          h('span', { class: 'track-name', title: p.name }, p.name),
          h('span', { class: 'track-gm' }, p.gm),
          h('span', { class: 'track-num' }, MP.fmtNumber(p.count)),
          h('span', { class: 'track-num track-range' }, p.drums ? '—' : MP.pitchName(p.lo) + '–' + MP.pitchName(p.hi)),
          h('span', { class: 'track-spark-cell' }, spark),
          h('span', { class: 'track-btns' }, mute, solo));
        const flip = (set, btn) => {
          if (set.has(i)) set.delete(i); else set.add(i);
          btn.setAttribute('aria-pressed', String(set.has(i)));
          this.syncMix();
        };
        mute.addEventListener('click', () => flip(pin.mix.mute, mute));
        solo.addEventListener('click', () => flip(pin.mix.solo, solo));
        return { el, led, spark, color, mute, solo };
      });
      box.replaceChildren(head, ...this.rows.map((r) => r.el));
      this.levels = new Float32Array(pin.parts.length);
      $('tracks-hint').textContent = pin.parts.length + (pin.parts.length === 1 ? ' part.' : ' parts.') + ' Mute and solo work while it plays.';
      this.syncMix();
    },
    syncMix() {
      const pin = this.pin;
      this.rows.forEach((r, i) => r.el.classList.toggle('is-silent', !MP.audio.audible(pin, i)));
    },
    drawSparks() {
      const pin = this.pin, prog = this.currentT() / pin.duration;
      this.rows.forEach((r, i) => ART.sparkline(r.spark, pin, i, prog, state.theme, r.color));
    },
    currentT() {
      return player.pin === this.pin && (player.playing || player.offset > 0) ? player.position : this.viewT;
    },
    fillMore(pin) {
      const score = (p) => p.tags.filter((t) => pin.tags.indexOf(t) >= 0).length * 2 + (p.complex === pin.complex ? 1.2 : 0) + (p.key.mode === pin.key.mode ? 0.5 : 0) + (p.author === pin.author ? 1 : 0) + p.saves / 20000;
      const related = state.pins.filter((p) => p !== pin).sort((a, b) => score(b) - score(a)).slice(0, 10);
      $('s-more').replaceChildren(...related.map(miniCard));
      $('s-more').scrollLeft = 0;
    },
    syncSave() {
      if (!this.pin) return;
      const saved = state.saved.has(this.pin.id);
      const b = $('s-save');
      b.classList.toggle('is-saved', saved);
      b.innerHTML = saved ? MP.icon('check') + 'Saved' : 'Save';
      b.setAttribute('aria-pressed', String(saved));
    },
    sync() {
      if (!this.pin) return;
      const playing = player.pin === this.pin && player.playing;
      $('t-play').innerHTML = MP.icon(playing ? 'pause' : 'play', playing ? '' : 'icon-play');
      $('t-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
      this.drawn = null;
    },
    removeClick() {
      const b = $('s-remove');
      if (!b.classList.contains('is-confirm')) {
        b.classList.add('is-confirm');
        b.innerHTML = MP.icon('trash') + '<span>Remove</span>';
        b.dataset.tip = 'Press again to remove';
        this.removeTimer = setTimeout(() => this.resetRemove(), 3200);
        return;
      }
      const pin = this.pin;
      if (player.pin === pin) player.stop();
      state.pins = state.pins.filter((p) => p !== pin);
      state.byId.delete(pin.id);
      state.saved.delete(pin.id);
      MP.store.set('saved', Array.from(state.saved));
      vault.remove(pin.id).catch(() => {});
      const c = grid.cards.get(pin.id);
      closeSleeve();
      setTimeout(() => {
        if (c) { c.el.remove(); grid.cards.delete(pin.id); }
        render();
      }, 420);
      toast('Removed “' + pin.title + '”', { icon: 'trash', color: 'var(--ink-3)' });
    },
    resetRemove() {
      clearTimeout(this.removeTimer);
      const b = $('s-remove');
      b.classList.remove('is-confirm');
      b.innerHTML = MP.icon('trash');
      b.dataset.tip = 'Remove this entry';
    },
    sizeArt() {
      const pin = this.pin, aspect = ART.aspect(pin, this.style);
      const wrap = $('s-art-wrap'), hero = document.querySelector('.sleeve-hero');
      const stacked = window.matchMedia('(max-width: 960px)').matches;
      const cs = getComputedStyle(hero);
      const inner = hero.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      // On wide screens the art column is exactly as wide as the art, so the liner notes sit right beside it.
      const availW = stacked ? inner : Math.min(inner * 0.6, inner - 360);
      const availH = stacked ? Math.min(window.innerHeight * 0.62, 680) : wrap.getBoundingClientRect().height;
      const w = Math.max(80, Math.floor(Math.min(availW, availH / aspect)));
      wrap.style.width = stacked ? '' : w + 'px';
      document.querySelector('.s-art-tools').style.width = stacked ? '' : Math.max(w, 340) + 'px';
      const hh = Math.floor(w * aspect);
      this.art.style.width = w + 'px';
      this.art.style.height = hh + 'px';
      const W = Math.round(w * dpr()), H = Math.round(hh * dpr());
      if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
      this.drawn = null;
    },
    sizeAll() {
      this.sizeArt();
      for (const c of [this.scoreCanvas, this.overviewCanvas, this.tl]) {
        const r = c.getBoundingClientRect();
        c.width = Math.round(r.width * dpr());
        c.height = Math.round(r.height * dpr());
      }
      for (const row of this.rows) {
        const r = row.spark.getBoundingClientRect();
        row.spark.width = Math.round(r.width * dpr());
        row.spark.height = Math.round(r.height * dpr());
      }
      this.pin._bins = null;
      this.pin._pb = null;
      this.drawSparks();
    },
    repaint() {
      const pin = this.pin;
      paintVars(this.el, pin);
      this.rows.forEach((r, i) => { r.color = ART.partColor(pin, i, state.theme); r.led.style.setProperty('--c', MP.rgba(r.color)); });
      this.fillMore(pin);
      this.drawn = null;
      this.drawSparks();
      this.frame(performance.now());
    },
    frame() {
      const pin = this.pin;
      if (!pin || !this.canvas.width) return false;
      const theme = state.theme, current = player.pin === pin;
      const live = current && (player.playing || player.offset > 0);
      const t = this.dragT != null ? this.dragT : live ? player.position : null;
      if (t != null) {
        ART.draw(this.canvas, pin, { mode: 'live', style: this.style, t, future: 0.3, active: (current && player.playing) || this.dragT != null, playhead: 1, theme, large: true });
        this.drawn = 'live';
      } else if (this.hoverT != null) {
        ART.draw(this.canvas, pin, { mode: 'live', style: this.style, t: this.hoverT, future: 0.45, active: true, playhead: 0.8, theme, large: true });
        this.drawn = 'scrub';
      } else if (this.drawn !== 'rest') {
        ART.draw(this.canvas, pin, { style: this.style, theme, large: true });
        this.drawn = 'rest';
      }
      const st = this.scoreTime();
      ART.score(this.scoreCanvas, pin, { t: st, span: this.span, at: 0.25, ruler: true, labels: true, theme });
      const now = t != null ? t : this.viewT;
      ART.timeline(this.overviewCanvas, pin, st / pin.duration, theme, null);
      const win = $('overview-window');
      const left = MP.clamp((st - this.span * 0.25) / pin.duration, 0, 1), width = Math.min(1 - left, this.span / pin.duration);
      win.style.left = (left * 100).toFixed(3) + '%';
      win.style.width = (Math.max(0.006, width) * 100).toFixed(3) + '%';
      ART.timeline(this.tl, pin, now / pin.duration, 'dark', this.tlHover);
      $('t-time').textContent = MP.fmtTime(now);
      const bb = ART.barBeat(pin, Math.max(0, now));
      this.barOdo.set(bb.bar);
      $('t-beat').textContent = String(bb.beat);
      $('t-timeline').setAttribute('aria-valuenow', String(Math.round((now / pin.duration) * 100)));
      $('t-timeline').setAttribute('aria-valuetext', MP.fmtTime(now) + ' of ' + MP.fmtTime(pin.duration) + ', bar ' + bb.bar);
      // Mixer LEDs flash with each part's notes.
      const playing = current && player.playing;
      const lv = this.levels;
      let lit = false;
      if (playing) ART.activeParts(pin, player.position, lv);
      this.rows.forEach((r, i) => {
        const v = playing ? lv[i] : (r.v || 0) * 0.85;
        r.v = v;
        if (v > 0.01) lit = true;
        r.led.style.opacity = (0.18 + v * 0.82).toFixed(3);
        r.led.style.boxShadow = v > 0.25 ? '0 0 ' + Math.round(4 + v * 10) + 'px var(--c)' : 'none';
      });
      if (playing && ++this.sparkTick % 20 === 0) this.drawSparks();
      return playing || this.dragT != null || this.scoreT != null || lit;
    },
    show(pin, card) {
      this.anims.forEach((a) => a.cancel());
      this.anims = [];
      this.prevFocus = document.activeElement;
      this.el.hidden = false;
      this.open = true;
      lockScroll(true);
      dock.sync();
      this.fill(pin);
      this.scroll.scrollTop = 0;
      this.sizeAll();
      this.frame(performance.now());
      MP.animate(this.el, [{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease-out' });
      const from = card && card.shown && onScreen(card.art);
      const to = this.art.getBoundingClientRect();
      if (from && to.width && !reduced) {
        const ghost = makeGhost(this.canvas, to, 6, 86);
        this.art.style.visibility = 'hidden';
        card.el.classList.add('is-lifted');
        const s = from.width / to.width;
        MP.animate(ghost, [{ transform: 'translate(' + (from.left - to.left) + 'px,' + (from.top - to.top) + 'px) scale(' + s + ')', borderRadius: 6 / s + 'px' }, { transform: 'none', borderRadius: '6px' }], { duration: 900, easing: EXPO }).finished.then(() => {
          this.art.style.visibility = '';
          ghost.remove();
          card.el.classList.remove('is-lifted');
        });
      } else if (!reduced) {
        MP.animate(this.art, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 900, easing: EXPO });
      }
      MP.animate($('transport'), [{ opacity: 0, transform: 'translate(-50%, 30px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 900, delay: 260, easing: EXPO, fill: 'backwards' });
      this.stagger(140);
      this.watchSections();
      requestAnimationFrame(() => { this.viewSeg.place(false); this.soundSeg.place(false); });
      this.scroll.focus({ preventScroll: true });
      wake();
    },
    watchSections() {
      if (!this.io) return;
      this.io.disconnect();
      for (const s of this.scroll.querySelectorAll('.s-section')) {
        s.style.opacity = '0';
        this.io.observe(s);
      }
    },
    stagger(base) {
      if (reduced) return;
      MP.animate($('s-kicker'), [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 800, delay: base, easing: EXPO, fill: 'backwards' });
      this.words.forEach((w, i) => MP.animate(w, [{ transform: 'translateY(110%) rotate(3deg)' }, { transform: 'none' }], { duration: 1100, delay: base + 60 + i * 60, easing: EXPO, fill: 'backwards' }));
      const rest = [$('s-by'), $('s-desc'), $('s-tags')].concat(Array.from($('s-specs').children), [document.querySelector('.s-chroma-block'), document.querySelector('.s-art-tools')]);
      rest.filter((el) => el && !el.hidden).forEach((el, i) => MP.animate(el, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 900, delay: base + 260 + i * 40, easing: EXPO, fill: 'backwards' }));
      $('s-chroma').querySelectorAll('i').forEach((el, i) => MP.animate(el, [{ transform: 'scaleY(0)' }, { transform: 'none' }], { duration: 900, delay: base + 700 + i * 35, easing: EXPO, fill: 'backwards' }));
    },
    hide() {
      if (!this.open) return;
      this.open = false;
      const pin = this.pin, card = grid.cards.get(pin.id);
      const to = card && card.shown && onScreen(card.art);
      const from = this.art.getBoundingClientRect();
      const a1 = MP.animate(this.el, [{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'ease-in', fill: 'forwards' });
      this.anims = [a1];
      let flight = Promise.resolve();
      if (to && from.width && from.bottom > 0 && !reduced) {
        const ghost = makeGhost(this.canvas, from, 6, 86);
        this.art.style.visibility = 'hidden';
        card.el.classList.add('is-lifted');
        const s = to.width / from.width;
        flight = MP.animate(ghost, [{ transform: 'none', borderRadius: '6px' }, { transform: 'translate(' + (to.left - from.left) + 'px,' + (to.top - from.top) + 'px) scale(' + s + ')', borderRadius: 6 / s + 'px' }], { duration: 760, easing: EXPO }).finished.then(() => {
          ghost.remove();
          card.el.classList.remove('is-lifted');
          card.drawn = null;
          wake(card);
        });
      }
      Promise.all([a1.finished, flight]).then(() => {
        if (this.open) return;
        this.el.hidden = true;
        this.art.style.visibility = '';
        this.anims.forEach((a) => a.cancel());
        this.anims = [];
      }, () => {});
      lockScroll(false);
      dock.sync();
      wake();
      if (this.prevFocus && document.body.contains(this.prevFocus)) this.prevFocus.focus({ preventScroll: true });
    },
    swap(pin, dir) {
      if (pin === this.pin) return;
      const shift = (dir || 0) * 30;
      const notes = $('s-notes');
      const out = MP.animate(this.art, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(' + -shift + 'px) scale(0.97)' }], { duration: 170, easing: 'ease-in', fill: 'forwards' });
      MP.animate(notes, [{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'ease-in', fill: 'forwards' });
      out.finished.then(() => {
        this.fill(pin);
        this.scroll.scrollTo({ top: 0 });
        this.sizeAll();
        this.frame(performance.now());
        out.cancel();
        notes.getAnimations().forEach((a) => a.cancel());
        MP.animate(this.art, [{ opacity: 0, transform: 'translateX(' + shift + 'px) scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: 800, easing: EXPO });
        this.stagger(0);
        requestAnimationFrame(() => { this.viewSeg.place(false); this.soundSeg.place(false); });
        wake();
      }, () => {});
    },
    step(dir) {
      const list = state.visible, i = list.indexOf(this.pin), next = list[i + dir];
      if (next) navigateTo(next, dir);
    },
    resize() {
      if (!this.open) return;
      this.sizeAll();
      this.viewSeg.place(false);
      this.soundSeg.place(false);
      wake();
    },
  };

  function miniCard(pin) {
    const c = h('canvas', { 'aria-hidden': 'true' });
    const art = h('div', { class: 'mini-art' }, c);
    const b = h('button', { class: 'mini', type: 'button', 'aria-label': 'Open ' + pin.title }, art, h('span', { class: 'mono-label' }, catNo(pin) + ' · ' + pin.parts.length + (pin.parts.length === 1 ? ' part' : ' parts')), h('div', { class: 'mini-title' }, pin.title));
    paintVars(b, pin);
    const w = 180, hh = Math.round(w * Math.min(1.25, ART.aspect(pin, pin.style)));
    art.style.height = hh + 'px';
    c.width = w * dpr();
    c.height = hh * dpr();
    ART.draw(c, pin, { theme: state.theme });
    b.addEventListener('click', () => navigateTo(pin, 0));
    return b;
  }

  function download(pin) {
    if (!pin || (pin.mine && !pin.allowDownload)) return;
    if (window.MIDIPLACE_EMBED) return toast('This preview can’t save files. Downloads work when Midiplace runs on its own site.', { icon: 'info', duration: 4200 });
    const bytes = pin.bytes || MP.midi.write({ notes: pin.notes, tempos: pin.tempos, timeSig: pin.timeSig, parts: pin.parts, markers: pin.markers, name: pin.title });
    const name = pin.mine && pin.fileName ? pin.fileName : MP.slug(pin.title) + '.mid';
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 6000);
    toast('Downloading ' + name, { icon: 'download', color: pin.key.none ? null : noteHex(pin.key.tonic) });
  }
  function copyLink(pin) {
    const url = location.href.split('#')[0] + '#pin-' + pin.id;
    const fallback = () => {
      const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0' } });
      ta.value = url;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? 'Link copied' : 'Copy this link: ' + url, { icon: 'link', duration: ok ? 2400 : 6000 });
    };
    try { navigator.clipboard.writeText(url).then(() => toast('Link copied', { icon: 'link' }), fallback); } catch (e) { fallback(); }
  }

  /* ---------- Routing ---------- */
  function openPin(pin, card) {
    if (palette.open) palette.hide();
    if (sleeve.open) { if (sleeve.pin !== pin) navigateTo(pin, 0); return; }
    try { history.pushState({ mp: pin.id }, '', '#pin-' + pin.id); sleeve.pushed = true; } catch (e) { sleeve.pushed = false; }
    sleeve.show(pin, card || grid.cards.get(pin.id));
  }
  function navigateTo(pin, dir) {
    try { history.replaceState({ mp: pin.id }, '', '#pin-' + pin.id); } catch (e) { /* the frame may refuse history changes */ }
    sleeve.swap(pin, dir);
  }
  function clearHash() {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  }
  function closeSleeve() {
    if (!sleeve.open) return;
    if (sleeve.pushed && history.state && history.state.mp) {
      sleeve.pushed = false;
      history.back();
      setTimeout(() => { if (sleeve.open) { clearHash(); sleeve.hide(); } }, 320);
    } else {
      sleeve.pushed = false;
      clearHash();
      sleeve.hide();
    }
  }
  function route() {
    const m = /^#pin-([\w-]+)$/.exec(location.hash);
    const pin = m && state.byId.get(m[1]);
    if (pin) {
      if (!sleeve.open) sleeve.show(pin, grid.cards.get(pin.id));
      else if (sleeve.pin !== pin) sleeve.swap(pin, 0);
    } else if (sleeve.open) sleeve.hide();
  }

  /* ---------- Publisher ---------- */
  const publisher = {
    el: $('publish'),
    panel: $('publish-panel'),
    open: false,
    step: 'drop',
    draft: null,
    card: null,
    tags: new Set(),
    init() {
      this.el.querySelector('.sheet-head [data-close]').innerHTML = MP.icon('close');
      $('pub-sample').insertAdjacentHTML('afterbegin', MP.icon('dice'));
      this.el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) this.hide(); });
      $('file-input').addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (f) this.load(f);
      });
      $('pub-sample').addEventListener('click', () => {
        const s = MP.compose.sample();
        this.load(new File([s.bytes], s.fileName, { type: 'audio/midi' }));
      });
      const area = $('drop-area');
      let depth = 0;
      area.addEventListener('dragenter', () => { depth++; area.classList.add('is-over'); });
      area.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) area.classList.remove('is-over'); });
      area.addEventListener('drop', () => { depth = 0; area.classList.remove('is-over'); });
      this.styleSeg = makeSeg($('pub-style'), ART.STYLES.map((s) => ({ value: s, html: STYLE_GLYPHS[s] + '<span>' + ART.LABELS[s] + '</span>' })), 'roll', (v) => this.setStyle(v));
      $('pub-tags').replaceChildren(...PICKABLE.map((c) => {
        const b = h('button', { class: 'tag', type: 'button', 'aria-pressed': 'false', 'data-value': c }, c);
        b.addEventListener('click', () => {
          if (this.tags.has(c)) this.tags.delete(c);
          else if (this.tags.size < 3) this.tags.add(c);
          this.syncTags();
        });
        return b;
      }));
      const title = $('pub-title-input');
      title.addEventListener('input', () => {
        $('pub-title-count').textContent = title.value.length + '/60';
        title.closest('.field').classList.remove('has-error');
        $('pub-title-error').hidden = true;
        if (this.card) this.card.titleText.textContent = title.value.trim() || 'Untitled';
      });
      $('pub-form').addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
      this.panel.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && this.step === 'edit') { e.preventDefault(); this.submit(); }
      });
    },
    show(file) {
      if (sleeve.open) closeSleeve();
      if (palette.open) palette.hide();
      keyFilter.close();
      if (!this.open) {
        this.open = true;
        this.prevFocus = document.activeElement;
        this.el.hidden = false;
        lockScroll(true);
        this.setStep('drop', true);
        $('pub-error').hidden = true;
        const narrow = window.matchMedia('(max-width: 720px)').matches;
        MP.animate(this.el.querySelector('.sheet-backdrop'), [{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
        MP.animate(this.panel, narrow ? [{ transform: 'translateY(100%)' }, { transform: 'none' }] : [{ opacity: 0, transform: 'translateY(28px) scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: 700, easing: EXPO });
        setTimeout(() => this.panel.focus({ preventScroll: true }), 30);
      }
      if (file) this.load(file);
    },
    hide(quick) {
      if (!this.open) return Promise.resolve();
      this.open = false;
      if (this.draft && player.pin === this.draft && !this.published) player.stop();
      const narrow = window.matchMedia('(max-width: 720px)').matches;
      const a = MP.animate(this.panel, narrow ? [{ transform: 'none' }, { transform: 'translateY(100%)' }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(14px) scale(0.98)' }], { duration: quick ? 200 : 260, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
      const b = MP.animate(this.el.querySelector('.sheet-backdrop'), [{ opacity: 1 }, { opacity: 0 }], { duration: 280, easing: 'ease-in', fill: 'forwards' });
      lockScroll(false);
      if (!quick && this.prevFocus && document.body.contains(this.prevFocus)) this.prevFocus.focus({ preventScroll: true });
      return a.finished.then(() => {
        if (this.open) return;
        this.el.hidden = true;
        a.cancel();
        b.cancel();
        this.draft = null;
        this.published = false;
        if (this.card) { this.card.el.remove(); this.card = null; }
      }, () => {});
    },
    error(msg) {
      const box = $('pub-error');
      box.textContent = msg;
      box.hidden = false;
      if (this.step !== 'drop') this.setStep('drop');
      const area = $('drop-area');
      area.classList.remove('is-shaking');
      void area.offsetWidth;
      area.classList.add('is-shaking');
    },
    async load(file) {
      if (!this.open) this.show();
      const name = file.name || 'file';
      if (!/\.(mid|midi|rmi|kar)$/i.test(name) && !/midi/i.test(file.type || '')) return this.error('“' + name + '” isn’t a MIDI file. Choose a .mid or .midi file.');
      if (file.size > MAX_BYTES) return this.error('“' + name + '” is larger than 8 MB. Even long orchestral MIDI files are usually under 1 MB, so check that it’s the right file.');
      let bytes, parsed;
      try { bytes = new Uint8Array(await file.arrayBuffer()); } catch (e) { return this.error('Midiplace couldn’t open “' + name + '”. Try choosing it again.'); }
      try { parsed = MP.midi.parse(bytes); } catch (e) { return this.error('Midiplace couldn’t read “' + name + '”. ' + e.message); }
      $('pub-error').hidden = true;
      if (this.draft && player.pin === this.draft) player.stop();
      const draft = pinFromParsed(parsed, { id: 'draft-' + Date.now().toString(36), title: guessTitle(parsed, name), fileName: name, bytes, mine: true, author: ME, no: nextNo() });
      this.draft = draft;
      this.tags = new Set(guessTags(draft));
      this.fillForm(file, parsed);
      this.setStep('edit');
      this.renderPreview();
      this.report(parsed, draft);
      if (parsed.truncated) toast('This file is very long, so Midiplace kept its first 80,000 notes.', { icon: 'info' });
    },
    report(parsed, d) {
      const rows = [
        ['Header', 'Type ' + parsed.format + ' · ' + parsed.tracks + (parsed.tracks === 1 ? ' track' : ' tracks') + (parsed.ppq ? ' · ' + parsed.ppq + ' PPQ' : '')],
        ['Notes', MP.fmtNumber(d.notes.length) + ' in ' + d.parts.length + (d.parts.length === 1 ? ' part' : ' parts')],
        ['Parts', d.parts.slice(0, 4).map((p) => p.name).join(', ') + (d.parts.length > 4 ? ' and ' + (d.parts.length - 4) + ' more' : '')],
        ['Tempo', ART.tempoLabel(d) + (d.tempos.length > 1 ? ' · ' + (d.tempos.length - 1) + ' changes' : '')],
        ['Meter', d.timeSig[0] + '/' + d.timeSig[1] + (parsed.meterChanges ? ' · ' + parsed.meterChanges + ' changes' : '')],
        ['Length', MP.fmtTime(d.duration) + ' · ' + d.bars.length + ' bars'],
        ['Pedal', parsed.pedal ? MP.fmtNumber(parsed.pedal) + ' events' : 'None'],
        ['Markers', d.markers.length ? d.markers.slice(0, 4).map((m) => m.text).join(', ') + (d.markers.length > 4 ? '…' : '') : 'None'],
        ['Key', keyLabel(d)],
      ];
      const box = $('report');
      box.replaceChildren(...rows.map(([k, v], i) => {
        const row = h('div', { class: 'report-row', style: 'animation-delay:' + (180 + i * 110) + 'ms' }, h('span', { html: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>' }), h('dt', null, k), h('dd', null, v));
        if (!reduced) MP.animate(row, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 600, delay: 140 + i * 110, easing: EXPO, fill: 'backwards' });
        row.querySelector('svg path').style.animationDelay = 180 + i * 110 + 'ms';
        return row;
      }));
      if (!reduced) {
        const fields = Array.from($('pub-form').children);
        fields.forEach((el, i) => MP.animate(el, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 800, delay: 260 + i * 60, easing: EXPO, fill: 'backwards' }));
      }
    },
    fillForm(file, parsed) {
      const d = this.draft;
      const kb = file.size < 1024 ? file.size + ' B' : file.size < 1048576 ? (file.size / 1024).toFixed(1) + ' KB' : (file.size / 1048576).toFixed(2) + ' MB';
      const replace = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Replace');
      replace.addEventListener('click', () => $('file-input').click());
      const chip = $('file-chip');
      paintVars(chip, d);
      chip.replaceChildren(h('span', { class: 'file-chip-icon', html: MP.icon('file') }), h('span', { class: 'file-chip-text' }, h('span', { class: 'file-chip-name' }, file.name), h('span', { class: 'mono-label' }, kb + ' · will be ' + catNo(d))), replace);
      const title = $('pub-title-input');
      title.value = d.title;
      $('pub-title-count').textContent = d.title.length + '/60';
      title.closest('.field').classList.remove('has-error');
      $('pub-title-error').hidden = true;
      $('pub-desc-input').value = '';
      $('pub-download').checked = true;
      this.styleSeg.set(d.style);
      this.syncTags();
    },
    syncTags() {
      for (const b of $('pub-tags').children) {
        const on = this.tags.has(b.dataset.value);
        b.setAttribute('aria-pressed', String(on));
        b.disabled = !on && this.tags.size >= 3;
      }
    },
    setStep(step, instant) {
      const panel = this.panel;
      const r0 = panel.getBoundingClientRect();
      this.step = step;
      $('pub-drop').hidden = step !== 'drop';
      $('pub-edit').hidden = step !== 'edit';
      panel.classList.toggle('is-narrow', step === 'drop');
      $('pub-title').textContent = step === 'drop' ? 'Upload a MIDI file' : 'Make it an entry';
      $('pub-step').textContent = step === 'drop' ? 'Step 1 of 2' : 'Step 2 of 2 · Read in full';
      if (instant || !r0.width) return;
      const r1 = panel.getBoundingClientRect();
      MP.animate(panel, [{ width: r0.width + 'px', height: r0.height + 'px' }, { width: r1.width + 'px', height: r1.height + 'px' }], { duration: 760, easing: EXPO });
      requestAnimationFrame(() => this.styleSeg.place(false));
    },
    renderPreview() {
      if (this.card) this.card.el.remove();
      const card = createCard(this.draft, { preview: true });
      this.card = card;
      $('pub-preview').replaceChildren(card.el);
      requestAnimationFrame(() => {
        const w = $('pub-preview').clientWidth || 280;
        sizeCard(card, w);
        card.reveal = reduced ? null : { start: performance.now() + 160, dur: 1500 };
        wake(card);
        this.styleSeg.place(false);
      });
    },
    setStyle(s) {
      if (!this.draft || !this.card) return;
      this.draft.style = s;
      this.draft.search = searchText(this.draft);
      const w = $('pub-preview').clientWidth || 280;
      this.card.w = 0;
      sizeCard(this.card, w);
      this.card.drawn = null;
      this.card.reveal = reduced ? null : { start: performance.now() + 40, dur: 900 };
      wake(this.card);
    },
    async submit() {
      const d = this.draft;
      if (!d) return;
      const titleEl = $('pub-title-input');
      const title = titleEl.value.trim();
      if (!title) {
        titleEl.closest('.field').classList.add('has-error');
        $('pub-title-error').hidden = false;
        titleEl.focus();
        titleEl.classList.remove('is-shaking');
        void titleEl.offsetWidth;
        titleEl.classList.add('is-shaking');
        return;
      }
      Object.assign(d, { id: 'u' + Date.now().toString(36), title, desc: $('pub-desc-input').value.trim(), tags: PICKABLE.filter((c) => this.tags.has(c)), allowDownload: $('pub-download').checked, createdAt: Date.now(), fresh: true, no: nextNo() });
      d.search = searchText(d);
      state.pins.unshift(d);
      state.byId.set(d.id, d);
      this.published = true;
      const saving = persist(d);

      const fromRect = this.card.art.getBoundingClientRect();
      const ghost = makeGhost(this.card.canvas, fromRect, 6, 96);
      this.card.art.style.visibility = 'hidden';
      this.hide(true);

      state.category = 'all';
      state.key = null;
      state.view = 'all';
      state.query = '';
      const card = cardFor(d);
      card.awaitingGhost = true;
      render();
      card.awaitingGhost = false;
      const gridTop = grid.el.getBoundingClientRect().top + window.scrollY;
      const offset = $('bar').offsetHeight + $('filters').offsetHeight + 28;
      if (Math.abs(window.scrollY - (gridTop - offset)) > 30) {
        window.scrollTo({ top: Math.max(0, gridTop - offset), behavior: reduced ? 'auto' : 'smooth' });
        await settleScroll();
      }
      const to = card.art.getBoundingClientRect();
      const s = to.width / fromRect.width;
      await MP.animate(ghost, [{ transform: 'none', borderRadius: '6px' }, { transform: 'translate(' + (to.left - fromRect.left) + 'px,' + (to.top - fromRect.top) + 'px) scale(' + s + ')', borderRadius: 6 / s + 'px' }], { duration: 1000, easing: EXPO }).finished.catch(() => {});
      card.inner.style.opacity = '';
      ghost.remove();
      card.drawn = null;
      wake(card);
      MP.animate(card.meta, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 800, easing: EXPO });
      card.el.classList.add('is-new');
      setTimeout(() => card.el.classList.remove('is-new'), 1900);
      const persisted = await saving;
      toast(persisted ? 'Published ' + catNo(d) + ' · “' + d.title + '”' : 'Published “' + d.title + '” for this visit. This browser won’t let Midiplace store it, so it won’t survive a reload.', { color: d.key.none ? null : noteHex(d.key.tonic), duration: persisted ? 3400 : 6500 });
    },
  };
  const nextNo = () => state.pins.reduce((m, p) => Math.max(m, p.no || 0), 0) + 1;

  /* ---------- Drag a file anywhere ---------- */
  const drop = {
    el: $('dropzone'),
    depth: 0,
    shown: false,
    init() {
      const hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
      window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); this.depth++; this.show(); });
      window.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this.el.style.setProperty('--x', e.clientX + 'px');
        this.el.style.setProperty('--y', e.clientY + 'px');
        this.el.style.setProperty('--spot', noteHex(FIFTHS[Math.floor(MP.clamp(e.clientX / window.innerWidth, 0, 0.999) * 12)]));
      });
      window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; this.depth = Math.max(0, this.depth - 1); if (!this.depth) this.hide(); });
      window.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        this.depth = 0;
        this.hide();
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) publisher.load(f);
      });
    },
    show() {
      if (this.shown) return;
      this.shown = true;
      this.el.hidden = false;
      MP.animate(this.el, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
      MP.animate(this.el.querySelector('.dropzone-frame'), [{ transform: 'scale(1.03)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 700, easing: EXPO });
    },
    hide() {
      if (!this.shown) return;
      this.shown = false;
      MP.animate(this.el, [{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-in' }).finished.then(() => { if (!this.shown) this.el.hidden = true; }, () => {});
    },
  };

  /* ---------- Keyboard ---------- */
  function initKeys() {
    document.addEventListener('keydown', (e) => {
      const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (palette.open) palette.hide(); else palette.show();
        return;
      }
      if (e.key === 'Tab') {
        if (palette.open) e.preventDefault();
        else if (publisher.open) trapFocus(publisher.panel, e);
        else if (sleeve.open) trapFocus(sleeve.el, e);
        return;
      }
      if (e.key === 'Escape') {
        if (keyFilter.isOpen()) keyFilter.close();
        else if (palette.open) palette.hide();
        else if (publisher.open) publisher.hide();
        else if (sleeve.open) closeSleeve();
        return;
      }
      if (typing || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/' && !publisher.open && !sleeve.open) { e.preventDefault(); palette.show(); return; }
      if (publisher.open || palette.open) return;
      if (sleeve.open) {
        if (e.key === ' ' && !e.target.closest('button, [role="slider"]')) {
          e.preventDefault();
          if (player.pin === sleeve.pin) player.toggle(sleeve.pin, 'click'); else player.play(sleeve.pin, sleeve.viewT, 'click');
        } else if (e.key === 'ArrowRight') sleeve.step(1);
        else if (e.key === 'ArrowLeft') sleeve.step(-1);
        return;
      }
      if (e.key === ' ' && player.pin && !e.target.closest('button, a, [role="button"]')) {
        e.preventDefault();
        player.toggle(player.pin, player.source === 'hover' ? 'click' : player.source);
      }
    });
  }

  /* ---------- Boot ---------- */
  async function boot() {
    const stored = MP.store.get('theme', null);
    if ((stored === 'light' || stored === 'dark') && !document.documentElement.hasAttribute('data-theme')) document.documentElement.setAttribute('data-theme', stored);
    state.theme = MP.theme();
    document.querySelector('meta[name="theme-color"]').setAttribute('content', state.theme === 'dark' ? '#0c0c0b' : '#f2f1ed');

    const seeds = MP.compose.catalog().map(preparePin);
    let uploads = [];
    try { uploads = await loadUploads(); } catch (e) { uploads = []; }
    let n = seeds.reduce((m, p) => Math.max(m, p.no), 0);
    uploads.sort((a, b) => a.createdAt - b.createdAt).forEach((p) => {
      if (!p.no) { p.no = ++n; persist(p); } else n = Math.max(n, p.no);
      p.search = searchText(p);
    });
    state.pins = uploads.concat(seeds);
    state.pins.forEach((p) => state.byId.set(p.id, p));

    initTips();
    initHeader();
    initKeys();
    reveals.init();
    dock.init();
    sleeve.init();
    publisher.init();
    palette.init();
    drop.init();
    ribbon.init();
    keyFilter.init();
    paintLegend();
    filters.build();
    render({ initial: true });
    hero.intro();
    requestAnimationFrame(() => requestAnimationFrame(() => grid.el.classList.add('is-ready')));
    route();
    window.addEventListener('popstate', route);
    window.addEventListener('hashchange', route);
    new MutationObserver(() => themeChanged(false)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    let lastW = grid.el.clientWidth, resizeEnd = 0, raf = 0;
    const onResize = () => {
      const W = grid.el.clientWidth;
      if (W === lastW) return;
      lastW = W;
      grid.el.classList.add('is-resizing');
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { layout(); filters.place(false); });
      clearTimeout(resizeEnd);
      resizeEnd = setTimeout(() => grid.el.classList.remove('is-resizing'), 220);
    };
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(grid.el);
    else window.addEventListener('resize', onResize);
    window.addEventListener('resize', () => sleeve.resize());
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        layout();
        filters.place(false);
        ribbon.size();
        if (sleeve.open) sleeve.resize();
        wake();
      });
    }
    wake();
  }

  boot();
})();
