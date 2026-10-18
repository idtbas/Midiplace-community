/* Midiplace — the board, the close-up, the publisher and everything that moves. */
(function () {
  'use strict';
  const MP = window.MP, ART = MP.art, h = MP.h, player = MP.audio.player;
  const $ = (id) => document.getElementById(id);

  const CATEGORIES = ['Piano', 'Chords', 'Melody', 'Lo-fi', 'Ambient', 'Drums', 'Bass', 'Synthwave', 'Cinematic', 'Chiptune', 'Jazz', 'Classical'];
  const SOUNDS = [['original', 'Original'], ['keys', 'Keys'], ['pad', 'Pad'], ['pluck', 'Pluck'], ['chip', 'Chip']];
  const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
  const ME = { name: 'You', handle: 'you', hue: 205, followers: 0, me: true };

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
    theme: 'light',
  };

  /* ---------- Pins ---------- */
  const norm = (s) => String(s).toLowerCase().replace(/♯/g, '#').replace(/♭/g, 'b').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function searchText(pin) {
    const k = pin.key;
    const parts = [pin.title, pin.author.name, '@' + pin.author.handle, pin.author.handle, pin.genre || '', pin.desc || '', ART.LABELS[pin.style], Math.round(pin.bpm) + ' bpm'];
    pin.tags.forEach((t) => parts.push(t, t.replace('-', '')));
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

  function computeVisible() {
    const now = Date.now();
    const score = (p) => (p.fresh ? 1e15 + p.createdAt : state.sort === 'newest' ? p.createdAt : p.saves / Math.pow(1 + (now - p.createdAt) / 86400000 / 14, 0.9));
    return state.pins
      .filter(
        (p) =>
          (state.view !== 'saved' || state.saved.has(p.id)) &&
          (state.category === 'all' || (state.category === 'Yours' ? p.mine : p.tags.indexOf(state.category) >= 0)) &&
          (!state.key || (!p.key.none && p.key.tonic === state.key.tonic && p.key.mode === state.key.mode)) &&
          matches(p, state.query)
      )
      .sort((a, b) => score(b) - score(a));
  }

  function pinFromParsed(parsed, extra) {
    const instruments = {};
    for (const n of parsed.notes) if (instruments[n.ch] == null) instruments[n.ch] = n.ch === 9 ? 'drums' : MP.midi.familyForProgram(parsed.programs[n.ch] || 0);
    const k = MP.midi.detectKey(parsed.notes);
    const pin = Object.assign(
      { notes: parsed.notes, bpm: parsed.bpm, timeSig: parsed.timeSig, programs: parsed.programs, instruments, tracks: parsed.tracks, tags: [], desc: '', saves: 0, plays: 0, createdAt: Date.now(), allowDownload: true, genre: '', key: { tonic: k.tonic, mode: k.mode, none: !!k.none } },
      extra
    );
    if (!pin.style) pin.style = 'roll';
    preparePin(pin);
    if (!extra.style && !pin.melodicCount) pin.style = 'steps';
    return pin;
  }

  function guessTitle(parsed, fileName) {
    const name = (parsed.name || '').trim();
    if (name && name.length <= 60 && !/^(track|untitled|unnamed|seq|sequence|midi)\s*\d*$/i.test(name) && /[a-z]/i.test(name)) return name;
    const base = fileName.replace(/\.(mid|midi|rmi|kar)$/i, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
    return base ? base.charAt(0).toUpperCase() + base.slice(1, 60) : 'Untitled';
  }

  function guessTags(pin) {
    if (!pin.melodicCount) return ['Drums'];
    const tags = [];
    const progs = Object.keys(pin.instruments).filter((c) => +c !== 9).map((c) => pin.programs[c] || 0);
    if (progs.some((p) => p < 8)) tags.push('Piano');
    let poly = 0;
    for (let i = 0; i < 40; i++) {
      const t = (pin.duration * (i + 0.5)) / 40;
      poly += pin.notes.filter((n) => n.ch !== 9 && n.t <= t && t < n.t + n.d).length;
    }
    tags.push(poly / 40 > 2.4 ? 'Chords' : 'Melody');
    if (pin.range[1] < 60) tags.push('Bass');
    if (pin.drumCount && tags.length < 3) tags.push('Drums');
    return tags.slice(0, 3);
  }

  function saveUploads() {
    const list = state.pins.filter((p) => p.mine).map((p) => ({ id: p.id, title: p.title, desc: p.desc, tags: p.tags, style: p.style, allowDownload: p.allowDownload, createdAt: p.createdAt, fileName: p.fileName, b64: MP.toB64(p.bytes) }));
    return MP.store.set('uploads', list);
  }
  function loadUploads() {
    const list = MP.store.get('uploads', []);
    if (!Array.isArray(list)) return [];
    return list
      .map((u) => {
        try {
          const bytes = MP.fromB64(u.b64);
          return pinFromParsed(MP.midi.parse(bytes), { id: u.id, title: u.title, desc: u.desc || '', tags: u.tags || [], style: u.style || 'roll', allowDownload: u.allowDownload !== false, createdAt: u.createdAt || Date.now(), fileName: u.fileName, bytes, mine: true, author: ME });
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  }

  /* ---------- Shared bits ---------- */
  const noteHex = (pc, lift) => MP.hex(MP.noteRgb(60 + pc, state.theme, lift || 0));
  function paintVars(el, pin) {
    const t = state.theme;
    el.style.setProperty('--pin-tint', MP.rgba(MP.tintRgb(pin.key.tonic, t)));
    el.style.setProperty('--pin-glow', MP.noteColor(pin.key.tonic + 60, t, t === 'dark' ? 0.42 : 0.55));
    el.style.setProperty('--dot', pin.key.none ? 'var(--ink-3)' : MP.noteColor(pin.key.tonic + 60, t));
  }
  function avatar(author) {
    const a1 = MP.hex(MP.oklch(0.72, 0.15, author.hue)), a2 = MP.hex(MP.oklch(0.56, 0.17, author.hue + 45));
    const initials = author.me ? 'Y' : author.name.split(/\s+/).map((s) => s[0]).slice(0, 2).join('');
    return h('span', { class: 'avatar', style: '--a1:' + a1 + ';--a2:' + a2, 'aria-hidden': 'true' }, initials);
  }
  const ringSvg = () => '<svg class="ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="ring-fill" cx="22" cy="22" r="20"/></svg>';
  function lockScroll(on) {
    document.documentElement.classList.toggle('is-locked', on);
  }
  function onScreen(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth ? r : null;
  }
  function makeGhost(src, rect, radius, z) {
    const c = h('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    const g = h('div', { class: 'ghost', style: { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', borderRadius: radius + 'px', zIndex: z || 85 } }, c);
    document.body.append(g);
    return g;
  }
  function settleScroll() {
    return new Promise((resolve) => {
      let last = window.scrollY, still = 0, frames = 0;
      (function check() {
        frames++;
        if (Math.abs(window.scrollY - last) < 0.5) still++;
        else still = 0;
        last = window.scrollY;
        if (still > 3 || frames > 70) resolve();
        else requestAnimationFrame(check);
      })();
    });
  }
  function trapFocus(container, e) {
    const items = Array.from(container.querySelectorAll('button:not([disabled]), input:not([type="hidden"]), textarea, [tabindex="0"], label[for]')).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* Segmented control with a sliding pill. */
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
        if (!animate) {
          void ind.offsetWidth;
          ind.style.transition = '';
        }
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
    return api;
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
    MP.animate(t, [{ opacity: 0, transform: 'translateY(18px) scale(0.92)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { easing: 'bouncy' });
    setTimeout(() => {
      MP.animate(t, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(0.95)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' }).finished.then(() => t.remove(), () => t.remove());
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
    if (!quick) MP.animate(tip.el, [{ opacity: 0, translate: '0 -3px', scale: '0.96' }, { opacity: 1, translate: '0 0', scale: '1' }], { duration: 180, easing: 'ease-out' });
  }
  function hideTip() {
    clearTimeout(tip.timer);
    if (!tip.el.hidden) {
      tip.el.hidden = true;
      tip.hiddenAt = performance.now();
    }
    tip.target = null;
  }
  function initTips() {
    document.addEventListener('pointerover', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t || e.pointerType !== 'mouse' || t === tip.target) return;
      tip.target = t;
      clearTimeout(tip.timer);
      const quick = performance.now() - tip.hiddenAt < 450;
      tip.timer = setTimeout(() => showTip(t, quick), quick ? 0 : 520);
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
    if (detail.open && detail.frame(now)) again = true;
    if (island.frame()) again = true;
    if (again || loop.cards.size) loop.raf = requestAnimationFrame(frame);
  }

  /* ---------- Cards ---------- */
  const grid = { el: $('grid'), cards: new Map(), cols: 0, colW: 0, gap: 16 };

  function createCard(pin, opts) {
    opts = opts || {};
    const canvas = h('canvas', { 'aria-hidden': 'true' });
    const open = h('button', { class: 'pin-open', type: 'button', 'aria-label': (opts.preview ? 'Play ' : 'Open ') + pin.title });
    const save = h('button', { class: 'pin-save', type: 'button' });
    const play = h('button', { class: 'pin-play', type: 'button' });
    const art = h('div', { class: 'pin-art' }, canvas, open, h('div', { class: 'pin-chrome' }, save, h('span', { class: 'pin-dur' }, MP.fmtTime(pin.duration)), play));
    const titleText = h('span', null, pin.title);
    const meta = h(
      'div',
      { class: 'pin-meta' },
      h('h3', { class: 'pin-title' }, h('span', { class: 'eq', 'aria-hidden': 'true', html: '<i></i><i></i><i></i>' }), titleText),
      h('div', { class: 'pin-by' }, avatar(pin.author), h('span', { class: 'pin-handle' }, pin.author.handle), h('span', { class: 'pin-key' }, h('i'), pin.key.none ? 'Drums' : MP.keyShort(pin.key), ' · ' + Math.round(pin.bpm)))
    );
    const inner = h('div', { class: 'pin-inner' }, art, meta);
    const el = h('article', { class: 'pin', 'data-id': pin.id }, inner);
    const card = { pin, el, inner, art, canvas, meta, play, save, titleText, x: 0, y: 0, w: 0, artH: 0, placed: false, shown: true, hoverT: null, reveal: null, drawn: null, preview: !!opts.preview };
    paintVars(el, pin);
    renderSave(save, state.saved.has(pin.id));
    syncCard(card);

    open.addEventListener('click', () => (card.preview ? player.toggle(pin, 'click') : openPin(pin, card)));
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      player.toggle(pin, 'click');
    });
    save.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSave(pin, save);
    });
    art.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse' && state.hoverListen && !card.preview) {
        clearTimeout(card.hoverTimer);
        card.hoverTimer = setTimeout(() => {
          if (player.pin !== pin || !player.playing) player.play(pin, 0, 'hover');
        }, 240);
      }
    });
    art.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || !canvas.width) return;
      const r = canvas.getBoundingClientRect(), k = canvas.width / r.width;
      card.hoverT = ART.geometry(pin, pin.style, canvas.width, canvas.height).timeAt((e.clientX - r.left) * k, (e.clientY - r.top) * k);
      wake(card);
    });
    art.addEventListener('pointerleave', () => {
      clearTimeout(card.hoverTimer);
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
    btn.innerHTML = saved ? MP.icon('check') + 'Saved' : 'Save';
  }

  function syncCard(card) {
    const current = player.pin === card.pin, playing = current && player.playing;
    card.el.classList.toggle('is-current', current);
    card.el.classList.toggle('is-playing', playing);
    card.play.innerHTML = ringSvg() + MP.icon(playing ? 'pause' : 'play', playing ? '' : 'icon-play');
    card.play.setAttribute('aria-label', (playing ? 'Pause ' : 'Play ') + card.pin.title);
    card.ring = card.play.querySelector('.ring-fill');
  }

  function drawCard(card, now) {
    const pin = card.pin, c = card.canvas;
    if (!c.width || !card.el.isConnected) return false;
    const theme = state.theme;
    if (player.pin === pin && (player.playing || player.offset > 0)) {
      const t = player.position;
      ART.draw(c, pin, { mode: 'live', t, future: 0.3, active: player.playing, playhead: 1, theme });
      if (card.ring) card.ring.style.strokeDashoffset = String(125.66 * (1 - t / pin.duration));
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
      if (card.ring) card.ring.style.strokeDashoffset = '125.66';
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
    const dpr = ART.DPR(), W = Math.round(colW * dpr), H = Math.round(artH * dpr);
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

  /* Masonry: each pin goes to the shortest column. */
  function layout() {
    const W = grid.el.clientWidth;
    if (!W) return;
    const gap = W < 560 ? 10 : W < 980 ? 14 : 18;
    const min = W < 560 ? 148 : W < 980 ? 190 : 204;
    const cols = MP.clamp(Math.floor((W + gap) / (min + gap)), 2, 8);
    const colW = Math.floor(((W - gap * (cols - 1)) / cols) * 10) / 10;
    grid.cols = cols;
    grid.colW = colW;
    grid.gap = gap;
    grid.el.style.setProperty('--col-w', colW + 'px');
    const list = state.visible.map(cardFor);
    for (const c of list) sizeCard(c, colW);
    const metaH = list.map((c) => c.meta.offsetHeight);
    const heights = new Array(cols).fill(0), vGap = gap + 10;
    const fresh = [];
    list.forEach((c, i) => {
      let col = 0;
      for (let k = 1; k < cols; k++) if (heights[k] < heights[col] - 1) col = k;
      const x = Math.round(col * (colW + gap)), y = Math.round(heights[col]);
      heights[col] += c.artH + metaH[i] + vGap;
      c.col = col;
      c.order = i;
      if (!c.placed) {
        c.el.classList.add('no-anim');
        fresh.push(c);
        c.placed = true;
      }
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
    if (instant || MP.reducedMotion) {
      c.el.hidden = true;
      c.placed = false;
      return;
    }
    const a = MP.animate(c.inner, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.9)' }], { duration: 180, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
    c.hideAnim = a;
    a.finished.then(
      () => {
        if (!c.shown) {
          c.el.hidden = true;
          c.placed = false;
        }
        a.cancel();
      },
      () => {}
    );
  }

  function animateIn(cards, initial) {
    const top = grid.el.getBoundingClientRect().top, vh = window.innerHeight, now = performance.now();
    cards.forEach((c) => {
      if (c.awaitingGhost) {
        c.inner.style.opacity = '0';
        return;
      }
      const y = top + c.y;
      if (y > vh + 60 || y + c.artH < -60) return;
      const delay = initial ? Math.min(950, 140 + c.col * 70 + Math.max(0, c.y) * 0.32) : 40 + Math.min(320, c.order * 16);
      MP.animate(c.inner, [{ opacity: 0, transform: 'translateY(28px) scale(0.965)', filter: 'blur(8px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { duration: initial ? 950 : 640, delay, easing: 'smooth', fill: 'backwards' });
      if (!MP.reducedMotion) {
        c.reveal = { start: now + delay + 60, dur: 1100 + Math.min(700, c.pin.duration * 14) };
        wake(c);
      }
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
    wheel.sync();
    syncEmpty();
  }

  function syncEmpty() {
    const none = state.visible.length === 0;
    $('empty').hidden = !none;
    if (!none) return;
    const savedEmpty = state.view === 'saved' && state.saved.size === 0;
    $('empty-title').textContent = savedEmpty ? 'Nothing saved yet' : state.query ? 'No pins match “' + state.query + '”' : 'No pins match these filters';
    $('empty-text').textContent = savedEmpty ? 'Press Save on any pin and it will wait for you here.' : 'Try another word, key or category.';
  }

  function resetFilters() {
    state.category = 'all';
    state.key = null;
    state.view = 'all';
    setQuery('', true);
    syncSavedToggle();
    render();
  }

  /* ---------- Saving ---------- */
  function toggleSave(pin, fromEl) {
    const was = state.saved.has(pin.id);
    if (was) {
      state.saved.delete(pin.id);
      pin.saves = Math.max(0, pin.saves - 1);
    } else {
      state.saved.add(pin.id);
      pin.saves++;
      if (fromEl) flyToSaved(fromEl, pin);
    }
    MP.store.set('saved', Array.from(state.saved));
    const c = grid.cards.get(pin.id);
    if (c) renderSave(c.save, !was);
    if (detail.pin === pin) detail.syncSave();
    syncSavedCount(was);
    if (state.view === 'saved') render();
  }
  function flyToSaved(fromEl, pin) {
    const target = $('saved-toggle');
    const a = fromEl.getBoundingClientRect(), b = target.getBoundingClientRect();
    if (MP.reducedMotion || !b.width) return;
    const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2, x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
    const cx = (x0 + x1) / 2, cy = Math.min(y0, y1) - 140;
    const dot = h('div', { class: 'fly-dot', style: { background: pin.key.none ? 'var(--ink)' : noteHex(pin.key.tonic) } });
    document.body.append(dot);
    const frames = [];
    for (let i = 0; i <= 18; i++) {
      const t = i / 18, u = 1 - t;
      const x = u * u * x0 + 2 * u * t * cx + t * t * x1, y = u * u * y0 + 2 * u * t * cy + t * t * y1;
      frames.push({ transform: 'translate(' + x + 'px,' + y + 'px) scale(' + (1 + Math.sin(t * Math.PI) * 0.4 - t * 0.55) + ')', opacity: t > 0.88 ? (1 - t) / 0.12 : 1 });
    }
    MP.animate(dot, frames, { duration: 760, easing: 'cubic-bezier(.45,0,.2,1)' }).finished.then(() => {
      dot.remove();
      MP.animate(target, [{ transform: 'scale(1.28)' }, { transform: 'scale(1)' }], { easing: 'bouncy' });
    });
  }
  function syncSavedCount(removed) {
    const n = state.saved.size, badge = $('saved-count');
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? '99+' : String(n);
    if (removed === false && n) MP.animate(badge, [{ transform: 'scale(0.4)' }, { transform: 'scale(1)' }], { easing: 'bouncy', delay: 700 });
  }
  function syncSavedToggle() {
    const on = state.view === 'saved';
    $('saved-toggle').setAttribute('aria-pressed', String(on));
    $('saved-toggle').dataset.tip = on ? 'Show every pin' : 'Saved pins';
  }

  /* ---------- Header ---------- */
  const searchInput = $('search-input');
  let searchTimer = 0;
  function setQuery(q, silent) {
    state.query = q;
    if (searchInput.value !== q) searchInput.value = q;
    $('search').classList.toggle('has-value', !!q);
    $('search-clear').hidden = !q;
    if (!silent) render();
  }
  function initHeader() {
    document.querySelector('.search-icon').innerHTML = MP.icon('search');
    $('search-clear').innerHTML = MP.icon('close');
    $('hover-toggle').innerHTML = MP.icon('headphones');
    $('saved-toggle').insertAdjacentHTML('afterbegin', MP.icon('bookmark'));
    $('publish-btn').insertAdjacentHTML('afterbegin', MP.icon('plus'));
    $('publish-btn').setAttribute('aria-label', 'Publish a MIDI file');
    syncThemeButton();
    syncHoverButton();
    syncSavedToggle();
    syncSavedCount();
    const narrow = window.matchMedia('(max-width: 720px)');
    const placeholder = () => (searchInput.placeholder = narrow.matches ? 'Search Midiplace' : 'Search melodies, chords, keys, people');
    placeholder();
    if (narrow.addEventListener) narrow.addEventListener('change', placeholder);

    const panel = $('search-panel');
    const SUGGEST = [['A minor', 9], ['Lo-fi', null], ['120 bpm', null], ['Arpeggio', 2], ['Waltz', 4], ['@jun_8bit', null], ['Drums', null], ['E♭ major', 3]];
    $('search-suggest').replaceChildren(
      ...SUGGEST.map(([label, pc]) => {
        const b = h('button', { class: 'suggestion', type: 'button' }, h('i', { style: pc == null ? null : '--dot:' + noteHex(pc) }), label);
        b.addEventListener('pointerdown', (e) => e.preventDefault());
        b.addEventListener('click', () => {
          setQuery(label);
          searchInput.blur();
        });
        return b;
      })
    );
    const showPanel = (on) => {
      if (on === !panel.hidden) return;
      if (on) {
        panel.hidden = false;
        MP.animate(panel, [{ opacity: 0, transform: 'translateY(-6px) scale(0.98)' }, { opacity: 1, transform: 'none' }], { easing: 'smooth' });
      } else panel.hidden = true;
    };
    searchInput.addEventListener('focus', () => showPanel(!state.query));
    searchInput.addEventListener('blur', () => showPanel(false));
    searchInput.addEventListener('input', () => {
      const q = searchInput.value;
      $('search').classList.toggle('has-value', !!q);
      $('search-clear').hidden = !q;
      showPanel(!q);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = q.trim();
        render();
      }, 140);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') searchInput.blur();
      if (e.key === 'Escape') {
        if (searchInput.value) setQuery('');
        else searchInput.blur();
        e.stopPropagation();
      }
    });
    $('search-clear').addEventListener('click', () => {
      setQuery('');
      searchInput.focus();
    });

    $('hover-toggle').addEventListener('click', () => {
      state.hoverListen = !state.hoverListen;
      MP.store.set('hoverListen', state.hoverListen);
      MP.audio.ensure();
      syncHoverButton();
      if (!state.hoverListen && player.source === 'hover') player.stop();
      toast(state.hoverListen ? 'Listen on hover is on. Rest the pointer on a pin to hear it.' : 'Listen on hover is off', { icon: 'headphones', color: noteHex(7) });
    });
    $('theme-toggle').addEventListener('click', () => {
      const next = state.theme === 'dark' ? 'light' : 'dark';
      MP.store.set('theme', next);
      document.documentElement.setAttribute('data-theme', next);
      const icon = $('theme-toggle').querySelector('svg');
      if (icon) MP.animate(icon, [{ transform: 'rotate(-90deg) scale(0.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { easing: 'bouncy' });
      themeChanged();
    });
    $('saved-toggle').addEventListener('click', () => {
      state.view = state.view === 'saved' ? 'all' : 'saved';
      syncSavedToggle();
      render();
      scrollToBoard();
    });
    $('publish-btn').addEventListener('click', () => publisher.show());
    $('empty-reset').addEventListener('click', resetFilters);
    $('brand').addEventListener('click', (e) => {
      e.preventDefault();
      if (state.category !== 'all' || state.key || state.query || state.view !== 'all') resetFilters();
      window.scrollTo({ top: 0, behavior: MP.reducedMotion ? 'auto' : 'smooth' });
    });

    for (const id of ['publish-btn', 'hero-publish']) {
      const b = $(id);
      b.addEventListener('pointermove', (e) => {
        const r = b.getBoundingClientRect();
        b.style.setProperty('--mx', e.clientX - r.left + 'px');
        b.style.setProperty('--my', e.clientY - r.top + 'px');
      });
    }

    let ticking = false;
    window.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          const fb = $('filterbar');
          fb.classList.toggle('is-stuck', fb.getBoundingClientRect().top <= $('topbar').getBoundingClientRect().bottom + 0.5 && window.scrollY > 40);
        });
      },
      { passive: true }
    );
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
    b.dataset.tip = dark ? 'Light appearance' : 'Dark appearance';
    b.setAttribute('aria-label', b.dataset.tip);
  }
  function scrollToBoard() {
    const fb = $('filterbar');
    const target = fb.getBoundingClientRect().top + window.scrollY - $('topbar').offsetHeight;
    if (window.scrollY > target + 2 || window.scrollY < target - window.innerHeight * 0.3) window.scrollTo({ top: target, behavior: MP.reducedMotion ? 'auto' : 'smooth' });
  }

  /* ---------- Theme ---------- */
  function themeChanged() {
    const t = MP.theme();
    if (t === state.theme) return;
    state.theme = t;
    syncThemeButton();
    for (const c of grid.cards.values()) {
      paintVars(c.el, c.pin);
      c.drawn = null;
      if (c.shown) wake(c);
    }
    wheel.paint();
    hero.paint();
    paintLegend();
    if (detail.open) detail.repaint();
    if (publisher.card) {
      paintVars(publisher.card.el, publisher.card.pin);
      publisher.card.drawn = null;
      wake(publisher.card);
    }
    island.repaint();
  }

  function paintLegend() {
    const make = (pc) => h('span', { style: '--dot:' + noteHex(pc) }, h('i'), MP.NOTE_NAMES[pc]);
    $('footer-legend').replaceChildren(...FIFTHS.map(make));
    $('swatches').replaceChildren(...FIFTHS.map((pc) => h('span', { style: '--dot:' + noteHex(pc) }, h('i'), MP.NOTE_NAMES[pc])));
  }

  /* ---------- Hero ---------- */
  const ROTATE = [['melody.', 0, 7], ['chord loop.', 9, 4], ['bassline.', 6, 1], ['drum groove.', 8, 3], ['film cue.', 10, 5], ['arpeggio.', 2, 9], ['waltz.', 11, 6]];
  const hero = {
    i: 0,
    word: null,
    init() {
      this.word = $('rotator').querySelector('.rotator-word');
      this.paint();
      const creators = new Set(state.pins.map((p) => p.author.handle)).size;
      const notes = state.pins.reduce((n, p) => n + p.notes.length, 0);
      $('hero-stats').innerHTML = '<b>' + state.pins.length + '</b> pins · <b>' + creators + '</b> creators · <b>' + MP.fmtNumber(notes) + '</b> notes<span class="hide-sm">, all playable</span>';
      $('hero-publish').insertAdjacentHTML('afterbegin', MP.icon('arrowUp'));
      $('hero-publish').addEventListener('click', () => publisher.show());
      const pop = $('colors-pop'), btn = $('colors-btn');
      btn.addEventListener('click', () => (pop.hidden ? this.openPop() : this.closePop()));
      document.addEventListener('pointerdown', (e) => {
        if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) this.closePop();
      });
      if (!MP.reducedMotion) setInterval(() => this.next(), 2900);
    },
    colors(i) {
      const L = state.theme === 'dark' ? 0.75 : 0.66;
      return [MP.hex(MP.oklch(L, 0.2, MP.hueOf(ROTATE[i][1]))), MP.hex(MP.oklch(L, 0.2, MP.hueOf(ROTATE[i][2])))];
    },
    paint() {
      const [c1, c2] = this.colors(this.i);
      this.word.style.setProperty('--c1', c1);
      this.word.style.setProperty('--c2', c2);
    },
    next() {
      if (document.hidden) return;
      this.i = (this.i + 1) % ROTATE.length;
      const old = this.word;
      const word = h('span', { class: 'rotator-word' }, ROTATE[this.i][0]);
      this.word = word;
      this.paint();
      $('rotator').append(word);
      MP.animate(old, [{ opacity: 1, transform: 'none', filter: 'blur(0px)' }, { opacity: 0, transform: 'translateY(-0.32em)', filter: 'blur(12px)' }], { duration: 420, easing: 'cubic-bezier(.4,0,.7,.2)', fill: 'forwards' }).finished.then(() => old.remove(), () => old.remove());
      MP.animate(word, [{ opacity: 0, transform: 'translateY(0.42em)', filter: 'blur(12px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { duration: 1000, delay: 140, easing: 'smooth', fill: 'backwards' });
    },
    openPop() {
      const pop = $('colors-pop'), btn = $('colors-btn');
      pop.hidden = false;
      const r = btn.getBoundingClientRect(), pw = pop.offsetWidth;
      pop.style.top = r.bottom + window.scrollY + 10 + 'px';
      pop.style.left = MP.clamp(r.left + window.scrollX, 16, document.documentElement.clientWidth - pw - 16) + 'px';
      btn.setAttribute('aria-expanded', 'true');
      MP.animate(pop, [{ opacity: 0, transform: 'translateY(-8px) scale(0.96)', transformOrigin: '20% 0' }, { opacity: 1, transform: 'none', transformOrigin: '20% 0' }], { easing: 'bouncy' });
      pop.querySelectorAll('.swatches span').forEach((s, i) => MP.animate(s, [{ opacity: 0, transform: 'translateY(8px) scale(0.8)' }, { opacity: 1, transform: 'none' }], { easing: 'bouncy', delay: 60 + i * 22, fill: 'backwards' }));
    },
    closePop() {
      const pop = $('colors-pop');
      if (pop.hidden) return;
      $('colors-btn').setAttribute('aria-expanded', 'false');
      MP.animate(pop, [{ opacity: 1 }, { opacity: 0, transform: 'scale(0.97)' }], { duration: 140, easing: 'ease-in' }).finished.then(() => (pop.hidden = true), () => (pop.hidden = true));
    },
  };

  /* The circle of fifths, as a key filter. Outer ring major, inner ring relative minor. */
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  };
  const wheel = {
    segs: [],
    hover: null,
    build() {
      const svg = svgEl('svg', { viewBox: '0 0 400 400', role: 'presentation' });
      const C = 200;
      const rings = [{ mode: 'major', r: 162, sw: 36 }, { mode: 'minor', r: 110, sw: 30 }];
      for (const ring of rings) {
        const half = Math.PI / 12 - ring.sw / 2 / ring.r - 3 / ring.r;
        for (let i = 0; i < 12; i++) {
          const maj = (i * 7) % 12;
          const tonic = ring.mode === 'major' ? maj : (maj + 9) % 12;
          const mid = -Math.PI / 2 + (i * Math.PI) / 6, a0 = mid - half, a1 = mid + half;
          const pt = (a) => (C + ring.r * Math.cos(a)).toFixed(2) + ' ' + (C + ring.r * Math.sin(a)).toFixed(2);
          const label = ring.mode === 'major' ? MP.MAJOR_NAMES[tonic] : MP.MINOR_NAMES[tonic] + 'm';
          const g = svgEl('g', { class: 'w-seg is-' + ring.mode, tabindex: '0', role: 'button' });
          g.append(svgEl('path', { d: 'M ' + pt(a0) + ' A ' + ring.r + ' ' + ring.r + ' 0 0 1 ' + pt(a1), 'stroke-width': ring.sw }));
          const text = svgEl('text', { x: (C + ring.r * Math.cos(mid)).toFixed(2), y: (C + ring.r * Math.sin(mid)).toFixed(2) });
          text.textContent = label;
          g.append(text);
          const seg = { g, tonic, mode: ring.mode, i, count: 0 };
          g.addEventListener('click', () => this.pick(seg));
          g.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              this.pick(seg);
            }
          });
          g.addEventListener('pointerenter', () => { this.hover = seg; this.center(); });
          g.addEventListener('pointerleave', () => { this.hover = null; this.center(); });
          svg.append(g);
          this.segs.push(seg);
        }
      }
      const center = svgEl('g', { class: 'w-center', role: 'button', tabindex: '0', 'aria-label': 'Show every key' });
      center.append(svgEl('circle', { cx: C, cy: C, r: 64 }));
      this.c1 = svgEl('text', { class: 'w-c1', x: C, y: C - 4 });
      this.c2 = svgEl('text', { class: 'w-c2', x: C, y: C + 16 });
      center.append(this.c1, this.c2);
      center.addEventListener('click', () => {
        if (state.key) { state.key = null; render(); }
      });
      center.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && state.key) { e.preventDefault(); state.key = null; render(); }
      });
      svg.append(center);
      $('wheel').append(svg);
      this.paint();
      if (!MP.reducedMotion)
        this.segs.forEach((s, k) =>
          MP.animate(s.g, [{ opacity: 0, transform: 'scale(0.82) rotate(-14deg)' }, { opacity: 1, transform: 'none' }], { easing: 'bouncy', duration: 900, delay: 200 + (s.i * 38 + (s.mode === 'minor' ? 110 : 0)), fill: 'backwards' })
        );
    },
    paint() {
      const dark = state.theme === 'dark';
      for (const s of this.segs) {
        const hue = MP.hueOf(s.tonic);
        s.g.style.setProperty('--rest', MP.rgba(dark ? MP.oklch(s.mode === 'major' ? 0.37 : 0.33, 0.075, hue) : MP.oklch(s.mode === 'major' ? 0.915 : 0.94, 0.055, hue)));
        s.g.style.setProperty('--on', MP.noteColor(s.tonic + 60, state.theme));
        s.g.style.setProperty('--glow', MP.noteColor(s.tonic + 60, state.theme, 0.55));
      }
    },
    sync() {
      // Counts honor every filter except the key itself, so the wheel shows where you can go next.
      const saved = state.key;
      state.key = null;
      const pool = state.pins.filter((p) => (state.view !== 'saved' || state.saved.has(p.id)) && (state.category === 'all' || (state.category === 'Yours' ? p.mine : p.tags.indexOf(state.category) >= 0)) && matches(p, state.query));
      state.key = saved;
      this.total = pool.length;
      for (const s of this.segs) {
        s.count = pool.filter((p) => !p.key.none && p.key.tonic === s.tonic && p.key.mode === s.mode).length;
        const on = !!(state.key && state.key.tonic === s.tonic && state.key.mode === s.mode);
        s.g.classList.toggle('is-on', on);
        s.g.classList.toggle('is-empty', s.count === 0 && !on);
        s.g.classList.toggle('is-dim', !!state.key && !on && s.count > 0);
        s.g.setAttribute('aria-pressed', String(on));
        s.g.setAttribute('aria-label', MP.keyName(s) + ', ' + s.count + (s.count === 1 ? ' pin' : ' pins'));
        s.g.setAttribute('tabindex', s.count || on ? '0' : '-1');
      }
      this.center();
    },
    center() {
      const s = this.hover && (this.hover.count || (state.key && this.hover.tonic === state.key.tonic && this.hover.mode === state.key.mode)) ? this.hover : null;
      const k = s || state.key;
      const count = s ? s.count : state.key ? state.visible.length : this.total;
      this.c1.textContent = k ? MP.keyName(k) : 'All keys';
      this.c2.textContent = count + (count === 1 ? ' pin' : ' pins');
    },
    pick(seg) {
      const on = state.key && state.key.tonic === seg.tonic && state.key.mode === seg.mode;
      if (!seg.count && !on) return;
      state.key = on ? null : { tonic: seg.tonic, mode: seg.mode };
      if (!on) {
        const third = seg.mode === 'minor' ? 3 : 4;
        const root = 55 + MP.pc(seg.tonic - 55);
        MP.audio.chord([root - 12, root, root + third, root + 7], 'keys');
      }
      render();
    },
  };

  /* ---------- Filters ---------- */
  const filters = {
    chips: [],
    build() {
      const box = $('chips');
      box.querySelectorAll('.chip').forEach((c) => c.remove());
      const names = ['all'].concat(state.pins.some((p) => p.mine) ? ['Yours'] : [], CATEGORIES);
      this.chips = names.map((name) => {
        const b = h('button', { class: 'chip', type: 'button', role: 'tab', 'aria-selected': 'false', 'data-value': name }, name === 'all' ? 'All' : name);
        b.addEventListener('click', () => {
          if (state.category === name) return;
          state.category = name;
          render();
          if (window.scrollY > $('hero').offsetHeight) scrollToBoard();
        });
        box.append(b);
        return b;
      });
      if (!this.bound) {
        this.bound = true;
        box.addEventListener('scroll', () => box.parentElement.classList.toggle('is-scrolled', box.scrollLeft > 4), { passive: true });
      }
      if (!this.sort) this.sort = makeSeg($('sort'), null, state.sort, (v) => { state.sort = v; render(); });
      this.place(false);
    },
    place(animate) {
      const active = this.chips.find((c) => c.dataset.value === state.category) || this.chips[0];
      const ind = $('chip-indicator');
      if (!active || !active.offsetWidth) return;
      if (!animate) ind.style.transition = 'none';
      ind.style.width = active.offsetWidth + 'px';
      ind.style.transform = 'translateX(' + active.offsetLeft + 'px)';
      if (!animate) {
        void ind.offsetWidth;
        ind.style.transition = '';
      }
      if (this.sort) this.sort.place(false);
    },
    sync() {
      for (const c of this.chips) c.setAttribute('aria-selected', String(c.dataset.value === state.category));
      const active = this.chips.find((c) => c.dataset.value === state.category);
      this.place(true);
      if (active) {
        const box = $('chips');
        if (active.offsetLeft < box.scrollLeft || active.offsetLeft + active.offsetWidth > box.scrollLeft + box.clientWidth - 40) box.scrollTo({ left: active.offsetLeft - 24, behavior: 'smooth' });
      }
      const status = $('filter-status');
      const inner = h('div', { class: 'filter-status-inner' });
      const token = (label, dot, onClear) =>
        h('span', { class: 'token', style: dot ? '--dot:' + dot : null }, dot ? h('i') : null, label, h('button', { type: 'button', 'aria-label': 'Remove filter: ' + label, html: MP.icon('close'), onclick: onClear }));
      if (state.view === 'saved') inner.append(token('Saved pins', null, () => { state.view = 'all'; syncSavedToggle(); render(); }));
      if (state.key) inner.append(token(MP.keyName(state.key), noteHex(state.key.tonic), () => { state.key = null; render(); }));
      if (state.query) inner.append(token('“' + state.query + '”', null, () => setQuery('')));
      const open = inner.children.length > 0;
      if (open) inner.append(h('span', { class: 'result-count' }, state.visible.length + (state.visible.length === 1 ? ' pin' : ' pins')));
      status.replaceChildren(inner);
      status.classList.toggle('is-open', open);
    },
  };

  /* ---------- Now playing ---------- */
  const island = {
    el: $('island'),
    levels: new Array(12).fill(0),
    tmp: new Array(12).fill(0),
    bars: [],
    pin: null,
    init() {
      this.bars = FIFTHS.map((pc) => {
        const i = h('i');
        i.dataset.pc = pc;
        $('island-meter').append(i);
        return i;
      });
      this.repaint();
      $('island-close').innerHTML = MP.icon('close');
      $('island-open').addEventListener('click', () => player.pin && openPin(player.pin));
      $('island-toggle').addEventListener('click', () => player.pin && player.toggle(player.pin, player.source === 'hover' ? 'click' : player.source));
      $('island-close').addEventListener('click', () => player.stop());
    },
    repaint() {
      this.bars.forEach((b) => b.style.setProperty('--c', MP.noteColor(+b.dataset.pc + 60, 'dark')));
      if (this.pin) this.drawArt();
    },
    drawArt() {
      const c = $('island-canvas');
      c.width = c.height = 96;
      ART.draw(c, this.pin, { style: 'orbit', theme: 'dark' });
    },
    sync() {
      const pin = player.pin;
      this.el.dataset.state = pin ? 'shown' : 'hidden';
      $('toasts').classList.toggle('above-island', !!pin);
      this.el.classList.toggle('is-playing', !!(pin && player.playing));
      if (!pin) return;
      if (this.pin !== pin) {
        this.pin = pin;
        $('island-title').textContent = pin.title;
        this.drawArt();
        $('island-open').setAttribute('aria-label', 'Open ' + pin.title);
      }
      $('island-toggle').innerHTML = MP.icon(player.playing ? 'pause' : 'play', player.playing ? '' : 'icon-play');
      $('island-toggle').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
      this.frame();
    },
    frame() {
      const pin = player.pin;
      if (!pin) return false;
      const t = player.position;
      $('island-sub').textContent = MP.fmtTime(t) + ' / ' + MP.fmtTime(pin.duration) + ' · ' + pin.author.handle;
      $('island-progress').style.transform = 'scaleX(' + (t / pin.duration).toFixed(4) + ')';
      ART.activePitchClasses(pin, t, this.tmp);
      let live = false;
      for (let k = 0; k < 12; k++) {
        const target = player.playing ? this.tmp[k] : 0;
        this.levels[k] += (target - this.levels[k]) * (target > this.levels[k] ? 0.55 : 0.16);
        if (this.levels[k] > 0.01) live = true;
      }
      for (const b of this.bars) b.style.transform = 'scaleY(' + (0.12 + this.levels[+b.dataset.pc] * 0.88).toFixed(3) + ')';
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
      if (c) {
        syncCard(c);
        c.drawn = null;
        wake(c);
      }
      if (publisher.card && publisher.card.pin === pin) {
        syncCard(publisher.card);
        publisher.card.drawn = null;
        wake(publisher.card);
      }
    }
    if (kind === 'load' && p.pin) p.pin.plays++;
    island.sync();
    detail.sync();
    wake();
  });

  /* ---------- Close-up ---------- */
  const detail = {
    el: $('detail'),
    sheet: $('detail-sheet'),
    art: $('d-art'),
    canvas: $('d-canvas'),
    tl: $('t-canvas'),
    info: $('d-info'),
    open: false,
    pin: null,
    hoverT: null,
    dragT: null,
    tlHover: null,
    pushed: false,
    anims: [],
    init() {
      this.el.querySelector('.d-close').innerHTML = MP.icon('close');
      $('d-prev').innerHTML = MP.icon('chevL');
      $('d-next').innerHTML = MP.icon('chevR');
      $('t-loop').innerHTML = MP.icon('loop');
      $('d-download').innerHTML = MP.icon('download');
      $('d-link').innerHTML = MP.icon('link');
      $('d-download').setAttribute('aria-label', 'Download .mid');
      $('d-link').setAttribute('aria-label', 'Copy link');
      this.remove = h('button', { class: 'icon-btn', type: 'button', id: 'd-remove', 'data-tip': 'Remove this pin', 'aria-label': 'Remove this pin', html: MP.icon('trash') });
      $('d-link').after(this.remove);
      this.remove.addEventListener('click', () => this.removeClick());
      this.el.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) closeDetail();
      });
      $('d-prev').addEventListener('click', () => this.step(-1));
      $('d-next').addEventListener('click', () => this.step(1));
      $('t-play').addEventListener('click', () => this.pin && player.toggle(this.pin, 'click'));
      $('t-loop').addEventListener('click', () => {
        player.loop = !player.loop;
        $('t-loop').setAttribute('aria-pressed', String(player.loop));
        $('t-loop').dataset.tip = player.loop ? 'Loop: on' : 'Loop';
      });
      $('d-download').addEventListener('click', () => download(this.pin));
      $('d-link').addEventListener('click', () => copyLink(this.pin));
      $('d-save').addEventListener('click', () => toggleSave(this.pin, $('d-save')));
      this.sound = makeSeg($('d-sound'), SOUNDS.map(([value, label]) => ({ value, label })), 'original', (v) => {
        this.pin.sound = v;
        this.syncSoundNote();
        if (player.pin === this.pin) player.restart();
      });

      const art = this.art;
      art.addEventListener('pointermove', (e) => {
        this.hoverT = this.timeAt(e);
        wake();
      });
      art.addEventListener('pointerleave', () => {
        this.hoverT = null;
        this.drawn = null;
        wake();
      });
      art.addEventListener('click', (e) => {
        const t = this.timeAt(e);
        if (player.pin === this.pin) {
          player.seek(t);
          if (!player.playing) player.play(this.pin, t, 'click');
        } else player.play(this.pin, t, 'click');
      });

      const tl = $('t-timeline');
      const fracAt = (e) => {
        const r = tl.getBoundingClientRect();
        return MP.clamp((e.clientX - r.left) / r.width, 0, 1);
      };
      tl.addEventListener('pointerdown', (e) => {
        tl.setPointerCapture(e.pointerId);
        this.dragT = fracAt(e) * this.pin.duration;
        wake();
      });
      tl.addEventListener('pointermove', (e) => {
        const f = fracAt(e);
        this.tlHover = f;
        if (this.dragT != null) this.dragT = f * this.pin.duration;
        const hover = $('t-hover');
        hover.hidden = false;
        hover.textContent = MP.fmtTime(f * this.pin.duration);
        hover.style.left = f * 100 + '%';
        wake();
      });
      const end = () => {
        if (this.dragT == null) return;
        const t = this.dragT;
        this.dragT = null;
        if (player.pin === this.pin) {
          player.seek(t);
          if (!player.playing) player.play(this.pin, t, 'click');
        } else player.play(this.pin, t, 'click');
      };
      tl.addEventListener('pointerup', end);
      tl.addEventListener('pointercancel', () => { this.dragT = null; wake(); });
      tl.addEventListener('pointerleave', () => {
        this.tlHover = null;
        $('t-hover').hidden = true;
        wake();
      });
      tl.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        e.stopPropagation();
        const base = player.pin === this.pin ? player.position : 0;
        const t = MP.clamp(base + (e.key === 'ArrowRight' ? 5 : -5), 0, this.pin.duration);
        if (player.pin === this.pin) player.seek(t);
        else player.play(this.pin, t, 'click');
      });
    },
    timeAt(e) {
      const r = this.canvas.getBoundingClientRect(), k = this.canvas.width / r.width;
      return ART.geometry(this.pin, this.pin.style, this.canvas.width, this.canvas.height).timeAt((e.clientX - r.left) * k, (e.clientY - r.top) * k);
    },
    fill(pin) {
      this.pin = pin;
      this.hoverT = null;
      this.drawn = null;
      paintVars(this.el, pin);
      $('d-title').textContent = pin.title;
      const followBtn = h('button', { class: 'btn btn-follow', type: 'button', 'aria-pressed': String(state.following.has(pin.author.handle)) }, state.following.has(pin.author.handle) ? 'Following' : 'Follow');
      followBtn.addEventListener('click', () => {
        const on = !state.following.has(pin.author.handle);
        if (on) state.following.add(pin.author.handle);
        else state.following.delete(pin.author.handle);
        MP.store.set('following', Array.from(state.following));
        followBtn.setAttribute('aria-pressed', String(on));
        followBtn.textContent = on ? 'Following' : 'Follow';
      });
      const followers = pin.author.followers + (state.following.has(pin.author.handle) ? 1 : 0);
      $('d-by').replaceChildren(
        avatar(pin.author),
        h('div', { class: 'd-by-text' }, h('span', { class: 'd-by-name' }, pin.author.me ? 'You' : pin.author.name), h('span', { class: 'd-by-sub' }, pin.author.me ? 'Published from this browser' : '@' + pin.author.handle + ' · ' + MP.fmtCount(followers) + ' followers')),
        pin.author.me ? null : followBtn
      );
      $('d-desc').textContent = pin.desc || '';
      $('d-desc').hidden = !pin.desc;
      $('d-tags').replaceChildren(
        ...pin.tags.map((t) => {
          const b = h('button', { class: 'tag', type: 'button' }, t);
          b.addEventListener('click', () => {
            state.category = t;
            closeDetail();
            render();
            scrollToBoard();
          });
          return b;
        })
      );
      $('d-tags').hidden = !pin.tags.length;
      const stat = (label, value, dot) => h('div', null, h('dt', null, label), h('dd', null, dot ? h('i', { style: '--dot:' + dot }) : null, value));
      const k = pin.key;
      $('d-stats').replaceChildren(
        stat('Key', k.none ? 'Drums' : MP.keyName(k), k.none ? null : noteHex(k.tonic)),
        stat('Tempo', Math.round(pin.bpm) + ' BPM'),
        stat('Length', MP.fmtTime(pin.duration)),
        stat('Notes', MP.fmtNumber(pin.notes.length)),
        stat('Range', pin.melodicCount ? MP.pitchName(pin.range[0]) + '–' + MP.pitchName(pin.range[1]) : '—'),
        stat('Meter', pin.timeSig[0] + '/' + pin.timeSig[1])
      );
      const max = Math.max.apply(null, pin.chroma) || 1;
      $('d-chroma').replaceChildren(
        ...FIFTHS.map((pc) => h('span', { title: MP.NOTE_NAMES[pc] + ' · ' + Math.round(pin.chroma[pc] * 100) + '%' }, h('i', { style: '--dot:' + noteHex(pc) + ';height:' + Math.max(5, (pin.chroma[pc] / max) * 100) + '%' }), h('b', null, MP.NOTE_NAMES[pc])))
      );
      this.sound.set(pin.sound || 'original');
      this.syncSoundNote();
      $('d-meta').textContent = 'Published ' + MP.timeAgo(pin.createdAt) + ' · ' + MP.fmtCount(pin.plays) + ' plays · ' + MP.fmtCount(pin.saves) + ' saves';
      const canDownload = !(pin.mine && !pin.allowDownload);
      $('d-download').disabled = !canDownload;
      $('d-download').dataset.tip = canDownload ? 'Download .mid' : 'The creator turned off downloads';
      this.remove.hidden = !pin.mine;
      this.resetRemove();
      this.syncSave();
      $('t-dur').textContent = MP.fmtTime(pin.duration);
      $('t-loop').setAttribute('aria-pressed', String(player.loop));
      const i = state.visible.indexOf(pin);
      $('d-prev').disabled = i <= 0;
      $('d-next').disabled = i < 0 || i >= state.visible.length - 1;
      this.fillMore(pin);
      this.sync();
    },
    fillMore(pin) {
      const score = (p) => p.tags.filter((t) => pin.tags.indexOf(t) >= 0).length * 2 + (p.key.mode === pin.key.mode ? 0.6 : 0) + (p.author === pin.author ? 1 : 0) + (p.style === pin.style ? 0.4 : 0) + p.saves / 20000;
      const related = state.pins.filter((p) => p !== pin).sort((a, b) => score(b) - score(a)).slice(0, 10);
      $('d-more').replaceChildren(...related.map(miniCard));
      $('d-more').scrollLeft = 0;
    },
    syncSoundNote() {
      $('d-sound-note').textContent = this.pin.sound && this.pin.sound !== 'original' ? 'Drums keep their kit' : 'Plays with the instruments in the file';
    },
    syncSave() {
      if (!this.pin) return;
      const saved = state.saved.has(this.pin.id);
      const b = $('d-save');
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
      const b = this.remove;
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
      syncSavedCount();
      saveUploads();
      const c = grid.cards.get(pin.id);
      closeDetail();
      setTimeout(() => {
        if (c) {
          c.el.remove();
          grid.cards.delete(pin.id);
        }
        if (!state.pins.some((p) => p.mine)) {
          if (state.category === 'Yours') state.category = 'all';
          filters.build();
        }
        render();
      }, 380);
      toast('Removed “' + pin.title + '”', { icon: 'trash', color: 'var(--ink-3)' });
    },
    resetRemove() {
      clearTimeout(this.removeTimer);
      this.remove.classList.remove('is-confirm');
      this.remove.innerHTML = MP.icon('trash');
      this.remove.dataset.tip = 'Remove this pin';
    },
    sizeArt() {
      const pin = this.pin, aspect = ART.aspect(pin, pin.style);
      const wrap = $('d-art-wrap'), r = wrap.getBoundingClientRect();
      const stacked = window.matchMedia('(max-width: 920px)').matches;
      const availH = stacked ? Math.min(window.innerHeight * 0.56, 620) : r.height;
      const w = Math.max(80, Math.floor(Math.min(r.width, availH / aspect)));
      const hh = Math.floor(w * aspect);
      this.art.style.width = w + 'px';
      this.art.style.height = hh + 'px';
      const dpr = ART.DPR();
      const W = Math.round(w * dpr), H = Math.round(hh * dpr);
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width = W;
        this.canvas.height = H;
      }
      const tr = this.tl.getBoundingClientRect();
      this.tl.width = Math.round(tr.width * dpr);
      this.tl.height = Math.round(tr.height * dpr);
      pin._bins = null;
      this.drawn = null;
    },
    repaint() {
      paintVars(this.el, this.pin);
      this.fill(this.pin);
      this.drawn = null;
      wake();
    },
    frame() {
      const pin = this.pin;
      if (!pin || !this.canvas.width) return false;
      const theme = state.theme, current = player.pin === pin;
      let t = null;
      if (this.dragT != null) t = this.dragT;
      else if (current && (player.playing || player.offset > 0)) t = player.position;
      if (t != null) {
        ART.draw(this.canvas, pin, { mode: 'live', t, future: 0.3, active: (current && player.playing) || this.dragT != null, playhead: 1, theme, large: true });
        this.drawn = 'live';
      } else if (this.hoverT != null) {
        ART.draw(this.canvas, pin, { mode: 'live', t: this.hoverT, future: 0.45, active: true, playhead: 0.8, theme, large: true });
        this.drawn = 'scrub';
      } else if (this.drawn !== 'rest') {
        ART.draw(this.canvas, pin, { theme, large: true });
        this.drawn = 'rest';
      }
      ART.timeline(this.tl, pin, (t || 0) / pin.duration, theme, this.tlHover);
      $('t-time').textContent = MP.fmtTime(t || 0);
      $('t-timeline').setAttribute('aria-valuenow', String(Math.round(((t || 0) / pin.duration) * 100)));
      $('t-timeline').setAttribute('aria-valuetext', MP.fmtTime(t || 0) + ' of ' + MP.fmtTime(pin.duration));
      return (current && player.playing) || this.dragT != null;
    },
    show(pin, card) {
      this.anims.forEach((a) => a.cancel());
      this.anims = [];
      this.prevFocus = document.activeElement;
      this.el.hidden = false;
      this.open = true;
      lockScroll(true);
      $('app').classList.add('is-receded');
      this.fill(pin);
      this.sizeArt();
      this.frame();
      const backdrop = this.el.querySelector('.detail-backdrop');
      MP.animate(backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: 360, easing: 'ease-out' });
      const from = card && card.shown && onScreen(card.art);
      const to = this.art.getBoundingClientRect();
      if (from && to.width && !MP.reducedMotion) {
        const ghost = makeGhost(this.canvas, to, 22, 86);
        this.art.style.visibility = 'hidden';
        card.el.classList.add('is-lifted');
        const s = from.width / to.width;
        MP.animate(this.sheet, [{ opacity: 0, transform: 'scale(0.975)' }, { opacity: 1, transform: 'none' }], { duration: 460, easing: 'smooth' });
        MP.animate(ghost, [{ transform: 'translate(' + (from.left - to.left) + 'px,' + (from.top - to.top) + 'px) scale(' + s + ')', borderRadius: 20 / s + 'px' }, { transform: 'none', borderRadius: '22px' }], { easing: 'gentle' }).finished.then(() => {
          this.art.style.visibility = '';
          ghost.remove();
          card.el.classList.remove('is-lifted');
        });
      } else {
        MP.animate(this.sheet, [{ opacity: 0, transform: 'translateY(24px) scale(0.96)' }, { opacity: 1, transform: 'none' }], { easing: 'smooth' });
      }
      MP.animate($('transport'), [{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }], { easing: 'smooth', delay: 180, fill: 'backwards' });
      this.stagger(90);
      requestAnimationFrame(() => this.sound.place(false));
      this.sheet.focus({ preventScroll: true });
      wake();
    },
    stagger(base) {
      Array.from(this.info.children).forEach((child, i) => {
        if (child.hidden) return;
        MP.animate(child, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { easing: 'smooth', duration: 640, delay: base + i * 32, fill: 'backwards' });
      });
    },
    hide() {
      if (!this.open) return;
      this.open = false;
      const pin = this.pin, card = grid.cards.get(pin.id);
      const to = card && card.shown && onScreen(card.art);
      const from = this.art.getBoundingClientRect();
      $('app').classList.remove('is-receded');
      const backdrop = this.el.querySelector('.detail-backdrop');
      const a1 = MP.animate(this.sheet, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.98)' }], { duration: 240, easing: 'ease-in', fill: 'forwards' });
      const a2 = MP.animate(backdrop, [{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'ease-in', fill: 'forwards' });
      this.anims = [a1, a2];
      let flight = Promise.resolve();
      if (to && from.width && !MP.reducedMotion) {
        const ghost = makeGhost(this.canvas, from, 22, 86);
        this.art.style.visibility = 'hidden';
        card.el.classList.add('is-lifted');
        const s = to.width / from.width;
        flight = MP.animate(ghost, [{ transform: 'none', borderRadius: '22px' }, { transform: 'translate(' + (to.left - from.left) + 'px,' + (to.top - from.top) + 'px) scale(' + s + ')', borderRadius: 20 / s + 'px' }], { easing: 'smooth' }).finished.then(() => {
          ghost.remove();
          card.el.classList.remove('is-lifted');
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
      if (this.prevFocus && document.body.contains(this.prevFocus)) this.prevFocus.focus({ preventScroll: true });
    },
    swap(pin, dir) {
      if (pin === this.pin) return;
      const shift = (dir || 0) * 28;
      const out = MP.animate(this.art, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(' + -shift + 'px) scale(0.97)' }], { duration: 150, easing: 'ease-in', fill: 'forwards' });
      out.finished.then(() => {
        this.fill(pin);
        this.sizeArt();
        this.frame();
        out.cancel();
        this.info.scrollTop = 0;
        MP.animate(this.art, [{ opacity: 0, transform: 'translateX(' + shift + 'px) scale(0.97)' }, { opacity: 1, transform: 'none' }], { easing: 'smooth' });
        this.stagger(0);
        requestAnimationFrame(() => this.sound.place(false));
      }, () => {});
    },
    step(dir) {
      const list = state.visible, i = list.indexOf(this.pin), next = list[i + dir];
      if (next) navigateTo(next, dir);
    },
    resize() {
      if (!this.open) return;
      this.sizeArt();
      this.sound.place(false);
      wake();
    },
  };

  function miniCard(pin) {
    const c = h('canvas', { 'aria-hidden': 'true' });
    const art = h('div', { class: 'mini-art' }, c);
    const b = h('button', { class: 'mini', type: 'button', 'aria-label': 'Open ' + pin.title }, art, h('div', { class: 'mini-title' }, pin.title), h('div', { class: 'mini-sub' }, pin.author.handle));
    paintVars(b, pin);
    const w = 128, hh = Math.round(w * Math.min(1.3, ART.aspect(pin, pin.style)));
    art.style.height = hh + 'px';
    const dpr = ART.DPR();
    c.width = w * dpr;
    c.height = hh * dpr;
    ART.draw(c, pin, { theme: state.theme });
    b.addEventListener('click', () => navigateTo(pin, 0));
    return b;
  }

  function download(pin) {
    if (!pin || (pin.mine && !pin.allowDownload)) return;
    // Sandboxed previews (an embedded frame) cannot save files, so say so instead of failing silently.
    if (window.MIDIPLACE_EMBED) return toast('This preview can’t save files. Downloads work when Midiplace runs on its own site.', { icon: 'info', duration: 4200 });
    const bytes = pin.bytes || MP.midi.write({ notes: pin.notes, bpm: pin.bpm, timeSig: pin.timeSig, programs: pin.programs, name: pin.title });
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
    try {
      navigator.clipboard.writeText(url).then(() => toast('Link copied', { icon: 'link' }), fallback);
    } catch (e) {
      fallback();
    }
  }

  /* ---------- Routing ---------- */
  function openPin(pin, card) {
    if (detail.open) {
      if (detail.pin !== pin) navigateTo(pin, 0);
      return;
    }
    try {
      history.pushState({ mp: pin.id }, '', '#pin-' + pin.id);
      detail.pushed = true;
    } catch (e) {
      detail.pushed = false;
    }
    detail.show(pin, card || grid.cards.get(pin.id));
  }
  function navigateTo(pin, dir) {
    try { history.replaceState({ mp: pin.id }, '', '#pin-' + pin.id); } catch (e) { /* the frame may refuse history changes */ }
    detail.swap(pin, dir);
  }
  function clearHash() {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  }
  function closeDetail() {
    if (!detail.open) return;
    if (detail.pushed && history.state && history.state.mp) {
      detail.pushed = false;
      history.back();
      setTimeout(() => {
        if (detail.open) {
          clearHash();
          detail.hide();
        }
      }, 320);
    } else {
      detail.pushed = false;
      clearHash();
      detail.hide();
    }
  }
  function route() {
    const m = /^#pin-([\w-]+)$/.exec(location.hash);
    const pin = m && state.byId.get(m[1]);
    if (pin) {
      if (!detail.open) detail.show(pin, grid.cards.get(pin.id));
      else if (detail.pin !== pin) detail.swap(pin, 0);
    } else if (detail.open) detail.hide();
  }

  /* ---------- Publisher ---------- */
  const GLYPHS = {
    roll: '<svg viewBox="0 0 30 22" fill="currentColor" aria-hidden="true"><rect x="2" y="3" width="11" height="3.4" rx="1.7"/><rect x="15" y="3" width="8" height="3.4" rx="1.7"/><rect x="8" y="9.3" width="15" height="3.4" rx="1.7"/><rect x="3" y="15.6" width="9" height="3.4" rx="1.7"/><rect x="19" y="15.6" width="9" height="3.4" rx="1.7"/></svg>',
    orbit: '<svg viewBox="0 0 30 22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M15 2.5a8.5 8.5 0 0 1 8.5 8.5"/><path d="M22.4 15.4A8.5 8.5 0 0 1 8.2 16.2"/><path d="M15 6.6a4.4 4.4 0 0 1 4.1 6"/><circle cx="15" cy="11" r="1" fill="currentColor" stroke="none"/></svg>',
    fall: '<svg viewBox="0 0 30 22" fill="currentColor" aria-hidden="true"><rect x="5" y="2" width="3.4" height="8" rx="1.7"/><rect x="11" y="6" width="3.4" height="6" rx="1.7"/><rect x="17" y="1" width="3.4" height="11" rx="1.7"/><rect x="22.6" y="5" width="3.4" height="5" rx="1.7"/><rect x="3" y="15" width="24" height="5" rx="1.6" opacity=".45"/></svg>',
    steps: '<svg viewBox="0 0 30 22" fill="currentColor" aria-hidden="true"><rect x="3" y="2" width="4.5" height="4.5" rx="1.3"/><rect x="9.5" y="2" width="4.5" height="4.5" rx="1.3" opacity=".3"/><rect x="16" y="2" width="4.5" height="4.5" rx="1.3"/><rect x="22.5" y="2" width="4.5" height="4.5" rx="1.3" opacity=".3"/><rect x="3" y="8.7" width="4.5" height="4.5" rx="1.3" opacity=".3"/><rect x="9.5" y="8.7" width="4.5" height="4.5" rx="1.3"/><rect x="16" y="8.7" width="4.5" height="4.5" rx="1.3" opacity=".3"/><rect x="22.5" y="8.7" width="4.5" height="4.5" rx="1.3"/><rect x="3" y="15.4" width="4.5" height="4.5" rx="1.3"/><rect x="9.5" y="15.4" width="4.5" height="4.5" rx="1.3" opacity=".3"/><rect x="16" y="15.4" width="4.5" height="4.5" rx="1.3" opacity=".3"/><rect x="22.5" y="15.4" width="4.5" height="4.5" rx="1.3"/></svg>',
  };

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
      this.el.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) this.hide();
      });
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

      this.style = makeSeg($('pub-style'), ART.STYLES.map((s) => ({ value: s, html: GLYPHS[s] + '<span>' + ART.LABELS[s] + '</span>' })), 'roll', (v) => this.setStyle(v));
      $('pub-tags').replaceChildren(
        ...CATEGORIES.map((c) => {
          const b = h('button', { class: 'tag', type: 'button', 'aria-pressed': 'false', 'data-value': c }, c);
          b.addEventListener('click', () => {
            if (this.tags.has(c)) this.tags.delete(c);
            else if (this.tags.size < 3) this.tags.add(c);
            this.syncTags();
          });
          return b;
        })
      );
      const title = $('pub-title-input');
      title.addEventListener('input', () => {
        $('pub-title-count').textContent = title.value.length + '/60';
        title.closest('.field').classList.remove('has-error');
        $('pub-title-error').hidden = true;
        if (this.card) this.card.titleText.textContent = title.value.trim() || 'Untitled';
      });
      $('pub-form').addEventListener('submit', (e) => {
        e.preventDefault();
        this.submit();
      });
      this.panel.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && this.step === 'edit') {
          e.preventDefault();
          this.submit();
        }
      });
    },
    show(file) {
      if (detail.open) closeDetail();
      hero.closePop();
      if (!this.open) {
        this.open = true;
        this.prevFocus = document.activeElement;
        this.el.hidden = false;
        lockScroll(true);
        this.setStep('drop', true);
        $('pub-error').hidden = true;
        const narrow = window.matchMedia('(max-width: 720px)').matches;
        MP.animate(this.el.querySelector('.sheet-backdrop'), [{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
        MP.animate(this.panel, narrow ? [{ transform: 'translateY(100%)' }, { transform: 'none' }] : [{ opacity: 0, transform: 'translateY(28px) scale(0.96)' }, { opacity: 1, transform: 'none' }], { easing: 'smooth' });
        setTimeout(() => this.panel.focus({ preventScroll: true }), 30);
      }
      if (file) this.load(file);
    },
    hide(quick) {
      if (!this.open) return Promise.resolve();
      this.open = false;
      if (this.draft && player.pin === this.draft && !this.published) player.stop();
      const narrow = window.matchMedia('(max-width: 720px)').matches;
      const a = MP.animate(this.panel, narrow ? [{ transform: 'none' }, { transform: 'translateY(100%)' }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(16px) scale(0.97)' }], { duration: quick ? 200 : 260, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
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
        if (this.card) {
          this.card.el.remove();
          this.card = null;
        }
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
      if (file.size > 2 * 1024 * 1024) return this.error('“' + name + '” is larger than 2 MB. MIDI files are usually far smaller, so check that it’s the right file.');
      let bytes, parsed;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch (e) {
        return this.error('Midiplace couldn’t open “' + name + '”. Try choosing it again.');
      }
      try {
        parsed = MP.midi.parse(bytes);
      } catch (e) {
        return this.error('Midiplace couldn’t read “' + name + '”. ' + e.message);
      }
      $('pub-error').hidden = true;
      if (this.draft && player.pin === this.draft) player.stop();
      const draft = pinFromParsed(parsed, { id: 'draft-' + Date.now().toString(36), title: guessTitle(parsed, name), fileName: name, bytes, mine: true, author: ME });
      this.draft = draft;
      this.tags = new Set(guessTags(draft));
      this.fillForm(file, parsed);
      this.setStep('edit');
      this.renderPreview();
      if (parsed.truncated) toast('This file is very long, so Midiplace kept its first 24,000 notes.', { icon: 'info' });
    },
    fillForm(file, parsed) {
      const d = this.draft;
      const kb = file.size < 1024 ? file.size + ' B' : (file.size / 1024).toFixed(1) + ' KB';
      const replace = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Replace');
      replace.addEventListener('click', () => $('file-input').click());
      const chip = $('file-chip');
      paintVars(chip, d);
      chip.replaceChildren(h('span', { class: 'file-chip-icon', html: MP.icon('file') }), h('span', { class: 'file-chip-text' }, h('span', { class: 'file-chip-name' }, file.name), h('span', { class: 'file-chip-sub' }, kb + ' · format ' + parsed.format + ' · ' + parsed.tracks + (parsed.tracks === 1 ? ' track' : ' tracks'))), replace);
      const ro = (label, value) => h('div', null, h('dt', null, label), h('dd', null, value));
      $('readouts').replaceChildren(ro('Key', d.key.none ? 'Drums' : MP.keyShort(d.key) + (d.key.mode === 'minor' ? '' : ' maj')), ro('Tempo', Math.round(d.bpm) + ' BPM'), ro('Length', MP.fmtTime(d.duration)), ro('Notes', MP.fmtNumber(d.notes.length)), ro('Meter', d.timeSig[0] + '/' + d.timeSig[1]));
      const title = $('pub-title-input');
      title.value = d.title;
      $('pub-title-count').textContent = d.title.length + '/60';
      title.closest('.field').classList.remove('has-error');
      $('pub-title-error').hidden = true;
      $('pub-desc-input').value = '';
      $('pub-download').checked = true;
      this.style.set(d.style);
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
      $('pub-title').textContent = step === 'drop' ? 'Publish a MIDI file' : 'Make it a pin';
      if (instant || !r0.width) return;
      const r1 = panel.getBoundingClientRect();
      MP.animate(panel, [{ width: r0.width + 'px', height: r0.height + 'px' }, { width: r1.width + 'px', height: r1.height + 'px' }], { easing: 'smooth' });
      const section = step === 'drop' ? $('pub-drop') : $('pub-edit');
      MP.animate(section, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { easing: 'smooth', delay: 80, fill: 'backwards' });
      requestAnimationFrame(() => this.style.place(false));
    },
    renderPreview() {
      if (this.card) this.card.el.remove();
      const card = createCard(this.draft, { preview: true });
      this.card = card;
      $('pub-preview').replaceChildren(card.el);
      requestAnimationFrame(() => {
        const w = $('pub-preview').clientWidth || 280;
        sizeCard(card, w);
        card.reveal = { start: performance.now() + 120, dur: 1300 };
        wake(card);
        this.style.place(false);
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
      this.card.reveal = MP.reducedMotion ? null : { start: performance.now() + 40, dur: 900 };
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
      Object.assign(d, {
        id: 'u' + Date.now().toString(36),
        title,
        desc: $('pub-desc-input').value.trim(),
        tags: CATEGORIES.filter((c) => this.tags.has(c)),
        allowDownload: $('pub-download').checked,
        createdAt: Date.now(),
        fresh: true,
      });
      d.search = searchText(d);
      state.pins.unshift(d);
      state.byId.set(d.id, d);
      const persisted = saveUploads();
      this.published = true;

      const fromRect = this.card.art.getBoundingClientRect();
      const ghost = makeGhost(this.card.canvas, fromRect, 20, 96);
      this.card.art.style.visibility = 'hidden';
      this.hide(true);

      state.category = 'all';
      state.key = null;
      state.view = 'all';
      setQuery('', true);
      syncSavedToggle();
      if (!filters.chips.some((c) => c.dataset.value === 'Yours')) filters.build();
      const card = cardFor(d);
      card.awaitingGhost = true;
      render();
      card.awaitingGhost = false;
      const gridTop = grid.el.getBoundingClientRect().top + window.scrollY;
      const offset = $('topbar').offsetHeight + $('filterbar').offsetHeight + 24;
      if (Math.abs(window.scrollY - (gridTop - offset)) > 30) {
        window.scrollTo({ top: Math.max(0, gridTop - offset), behavior: MP.reducedMotion ? 'auto' : 'smooth' });
        await settleScroll();
      }
      const to = card.art.getBoundingClientRect();
      const s = to.width / fromRect.width;
      await MP.animate(ghost, [{ transform: 'none', borderRadius: '20px' }, { transform: 'translate(' + (to.left - fromRect.left) + 'px,' + (to.top - fromRect.top) + 'px) scale(' + s + ')', borderRadius: 20 / s + 'px' }], { easing: 'gentle', duration: 820 }).finished.catch(() => {});
      card.inner.style.opacity = '';
      ghost.remove();
      card.drawn = null;
      wake(card);
      MP.animate(card.meta, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { easing: 'smooth' });
      card.el.classList.add('is-new');
      setTimeout(() => card.el.classList.remove('is-new'), 1700);
      toast(persisted ? 'Published “' + d.title + '”' : 'Published “' + d.title + '” for this visit. Browser storage is full, so it won’t survive a reload.', { color: d.key.none ? null : noteHex(d.key.tonic), duration: persisted ? 3200 : 6000 });
    },
  };

  /* ---------- Drag a file anywhere ---------- */
  const drop = {
    el: $('dropzone'),
    depth: 0,
    shown: false,
    init() {
      const hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
      window.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        this.depth++;
        this.show();
      });
      window.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this.el.style.setProperty('--x', e.clientX + 'px');
        this.el.style.setProperty('--y', e.clientY + 'px');
        const pc = FIFTHS[Math.floor(MP.clamp(e.clientX / window.innerWidth, 0, 0.999) * 12)];
        this.el.style.setProperty('--spot', noteHex(pc));
      });
      window.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        this.depth = Math.max(0, this.depth - 1);
        if (!this.depth) this.hide();
      });
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
      MP.animate(this.el, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      MP.animate(this.el.querySelector('.dropzone-frame'), [{ transform: 'scale(1.04)', opacity: 0 }, { transform: 'none', opacity: 1 }], { easing: 'smooth' });
    },
    hide() {
      if (!this.shown) return;
      this.shown = false;
      MP.animate(this.el, [{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-in' }).finished.then(() => {
        if (!this.shown) this.el.hidden = true;
      }, () => {});
    },
  };

  /* ---------- Keyboard ---------- */
  function initKeys() {
    document.addEventListener('keydown', (e) => {
      const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
      if (e.key === 'Tab') {
        if (publisher.open) trapFocus(publisher.panel, e);
        else if (detail.open) trapFocus(detail.sheet, e);
        return;
      }
      if (e.key === 'Escape') {
        if (!$('colors-pop').hidden) hero.closePop();
        else if (publisher.open) publisher.hide();
        else if (detail.open) closeDetail();
        return;
      }
      if (typing || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/' && !publisher.open && !detail.open) {
        e.preventDefault();
        searchInput.focus();
        return;
      }
      if (publisher.open) return;
      if (detail.open) {
        if (e.key === ' ' && !e.target.closest('button, [role="slider"]')) {
          e.preventDefault();
          player.toggle(detail.pin, 'click');
        } else if (e.key === 'ArrowRight') detail.step(1);
        else if (e.key === 'ArrowLeft') detail.step(-1);
        return;
      }
      if (e.key === ' ' && player.pin && !e.target.closest('button, a, [role="button"]')) {
        e.preventDefault();
        player.toggle(player.pin, player.source === 'hover' ? 'click' : player.source);
      }
    });
  }

  /* ---------- Boot ---------- */
  function boot() {
    const stored = MP.store.get('theme', null);
    if ((stored === 'light' || stored === 'dark') && !document.documentElement.hasAttribute('data-theme')) document.documentElement.setAttribute('data-theme', stored);
    state.theme = MP.theme();

    const seeds = MP.compose.catalog().map(preparePin);
    state.pins = loadUploads().concat(seeds);
    state.pins.forEach((p) => state.byId.set(p.id, p));

    initTips();
    initHeader();
    initKeys();
    island.init();
    detail.init();
    publisher.init();
    drop.init();
    hero.init();
    paintLegend();
    wheel.build();
    filters.build();
    render({ initial: true });
    requestAnimationFrame(() => requestAnimationFrame(() => grid.el.classList.add('is-ready')));
    route();
    window.addEventListener('popstate', route);
    window.addEventListener('hashchange', route);

    if (window.matchMedia) {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', themeChanged);
    }
    new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    let lastW = grid.el.clientWidth, resizeEnd = 0, raf = 0;
    const onResize = () => {
      const W = grid.el.clientWidth;
      if (W === lastW) return;
      lastW = W;
      grid.el.classList.add('is-resizing');
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        layout();
        filters.place(false);
      });
      clearTimeout(resizeEnd);
      resizeEnd = setTimeout(() => grid.el.classList.remove('is-resizing'), 220);
    };
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(grid.el);
    else window.addEventListener('resize', onResize);
    window.addEventListener('resize', () => detail.resize());

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        layout();
        filters.place(false);
        if (detail.open) detail.sound.place(false);
      });
    }
  }

  boot();
})();
