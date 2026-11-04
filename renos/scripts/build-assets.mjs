#!/usr/bin/env node
/**
 * Erzeugt alle Bild-Assets für das Frontend aus den Quellen in `assets/`:
 *   - optimierte App-Icons (256 px) aus dem RenOS-Icon-Paket (assets/source/icons)
 *   - Rasterversionen der ergänzten SVG-Icons (Library, Installer)
 *   - PWA-/Apple-Touch-Icons und Favicons aus assets/svg/renos-icon.svg
 *   - prozedurale Desktop-Hintergründe in iPad-Pro-Auflösung (2732 × 2048) + Vorschaubilder
 *
 * Verwendet das vorhandene Playwright-Chromium als Renderer, damit keine Bildbibliothek nötig ist.
 *   npm run assets
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'assets');
const out = path.join(root, 'apps/web/public');

const ICON_MAP = {
  dateimanager: 'files',
  einstellungen: 'settings',
  terminal: 'terminal',
  texteditor: 'notes',
  papierkorb: 'trash',
  webbrowser: 'web',
};

async function write(file, dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(base64, 'base64'));
  console.log('  ✓', path.relative(root, file));
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body></body></html>');

/** Skaliert ein Bild (data URL) mehrstufig herunter und entfernt Alpha-Rauschen am Rand. */
async function rasterize(dataUrl, size, { full = false } = {}) {
  return page.evaluate(
    async ({ dataUrl, size, full }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      let current = img;
      let w = img.naturalWidth || size;
      let h = img.naturalHeight || size;
      // SVGs direkt in Zielgröße zeichnen, Raster schrittweise halbieren.
      const isSvg = dataUrl.startsWith('data:image/svg');
      if (!isSvg) {
        while (w / 2 >= size) {
          const c = document.createElement('canvas');
          c.width = Math.round(w / 2);
          c.height = Math.round(h / 2);
          const cx = c.getContext('2d');
          cx.imageSmoothingQuality = 'high';
          cx.drawImage(current, 0, 0, c.width, c.height);
          current = c;
          w = c.width;
          h = c.height;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(current, 0, 0, size, size);
      if (!full) {
        const data = ctx.getImageData(0, 0, size, size);
        for (let i = 3; i < data.data.length; i += 4) if (data.data[i] < 12) data.data[i] = 0;
        ctx.putImageData(data, 0, 0);
      }
      return canvas.toDataURL('image/png');
    },
    { dataUrl, size, full },
  );
}

const svgUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

console.log('App-Icons aus dem RenOS-Icon-Paket');
for (const [source, name] of Object.entries(ICON_MAP)) {
  const data = await readFile(path.join(src, 'source/icons', `${source}.png`));
  const url = `data:image/png;base64,${data.toString('base64')}`;
  await write(path.join(out, 'icons/apps', `${name}.png`), await rasterize(url, 256));
}

console.log('Ergänzte Icons (SVG → PNG)');
for (const name of ['library', 'installer']) {
  const svg = await readFile(path.join(src, 'svg', `${name}.svg`), 'utf8');
  await mkdir(path.join(out, 'icons/apps'), { recursive: true });
  await writeFile(path.join(out, 'icons/apps', `${name}.svg`), svg);
  await write(path.join(out, 'icons/apps', `${name}.png`), await rasterize(svgUrl(svg), 256));
}

console.log('RenOS-Logo und PWA-Icons');
const iconSvg = await readFile(path.join(src, 'svg/renos-icon.svg'), 'utf8');
const markSvg = await readFile(path.join(src, 'svg/renos-mark.svg'), 'utf8');
await writeFile(path.join(out, 'icons/renos-mark.svg'), markSvg);
await writeFile(path.join(out, 'favicon.svg'), iconSvg);
// Vollflächige Variante (ohne eigene Rundung): iPadOS und Android maskieren selbst.
const fullBleed = iconSvg
  .replace(/rx="112"/g, 'rx="0"')
  .replace(/<rect x="1\.5"[^>]*\/>/, '')
  .replace('<g fill="none"', '<g transform="translate(256 256) scale(0.86) translate(-256 -256)" fill="none"');
await write(path.join(out, 'icons/icon-192.png'), await rasterize(svgUrl(iconSvg), 192));
await write(path.join(out, 'icons/icon-512.png'), await rasterize(svgUrl(iconSvg), 512));
await write(path.join(out, 'icons/icon-maskable-512.png'), await rasterize(svgUrl(fullBleed), 512, { full: true }));
await write(path.join(out, 'icons/apple-touch-icon.png'), await rasterize(svgUrl(fullBleed), 180, { full: true }));
await write(path.join(out, 'icons/favicon-32.png'), await rasterize(svgUrl(iconSvg), 32));

console.log('Desktop-Hintergründe');
const wallpapers = await page.evaluate(async () => {
  const W = 2732;
  const H = 2048;

  // Deterministischer Zufall, damit die Bilder reproduzierbar sind.
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function smoothNoise(rand, count) {
    const pts = Array.from({ length: count + 3 }, () => rand());
    return (x) => {
      const f = x * count;
      const i = Math.floor(f);
      const t = f - i;
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const p2 = pts[i + 2];
      const p3 = pts[i + 3];
      // Catmull-Rom
      return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    };
  }
  function grain(ctx, rand, amount) {
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * amount;
      d[i] += n;
      d[i + 1] += n;
      d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }
  function canvas() {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return [c, c.getContext('2d')];
  }
  function glow(ctx, x, y, r, color, alpha) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color.replace('A', String(alpha)));
    g.addColorStop(1, color.replace('A', '0'));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  const results = {};

  // 1) Dämmerung – ruhige Bergkämme unter einem dunkelblauen Himmel (Standard)
  {
    const rand = rng(7);
    const [c, ctx] = canvas();
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#1d2533');
    sky.addColorStop(0.55, '#161c27');
    sky.addColorStop(1, '#10141b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    glow(ctx, W * 0.72, H * 0.34, H * 0.8, 'rgba(135,169,232,A)', 0.2);
    glow(ctx, W * 0.2, H * 0.05, H * 0.6, 'rgba(160,172,188,A)', 0.05);
    const layers = [
      { base: 0.52, amp: 0.16, color: '#2c3647', detail: 5 },
      { base: 0.6, amp: 0.13, color: '#232c3b', detail: 6 },
      { base: 0.69, amp: 0.11, color: '#1b2230', detail: 7 },
      { base: 0.79, amp: 0.08, color: '#141a23', detail: 8 },
      { base: 0.89, amp: 0.05, color: '#10151c', detail: 9 },
    ];
    for (const layer of layers) {
      const n1 = smoothNoise(rand, layer.detail);
      const n2 = smoothNoise(rand, layer.detail * 4);
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 4) {
        const u = x / W;
        const y = H * (layer.base - layer.amp * (0.75 * n1(u) + 0.25 * n2(u)));
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = layer.color;
      ctx.fill();
      // leichter Dunst über jedem Kamm
      const haze = ctx.createLinearGradient(0, H * (layer.base - layer.amp), 0, H);
      haze.addColorStop(0, 'rgba(135,169,232,0.035)');
      haze.addColorStop(0.4, 'rgba(135,169,232,0)');
      ctx.fillStyle = haze;
      ctx.fill();
    }
    grain(ctx, rand, 5);
    results.daemmerung = c.toDataURL('image/jpeg', 0.9);
  }

  // 2) Graphit – sanfte, neutrale Wellenbänder
  {
    const rand = rng(21);
    const [c, ctx] = canvas();
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#20242b');
    bg.addColorStop(1, '#13161b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    glow(ctx, W * 0.25, H * 0.2, H * 0.7, 'rgba(200,206,214,A)', 0.05);
    for (let i = 0; i < 9; i += 1) {
      const n = smoothNoise(rand, 4);
      const offset = H * (0.18 + i * 0.1);
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 6) {
        const u = x / W;
        ctx.lineTo(x, offset + Math.sin(u * Math.PI * 1.6 + i * 0.7) * H * 0.06 + (n(u) - 0.5) * H * 0.08);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      const shade = 0.035 + i * 0.012;
      ctx.fillStyle = `rgba(10,12,16,${shade})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(220,226,234,0.035)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    grain(ctx, rand, 5);
    results.graphit = c.toDataURL('image/jpeg', 0.9);
  }

  // 3) Tiefsee – dunkles Blau mit feinen Höhenlinien
  {
    const rand = rng(42);
    const [c, ctx] = canvas();
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#141b28');
    bg.addColorStop(1, '#0d1118');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    glow(ctx, W * 0.5, H * 1.05, H * 0.9, 'rgba(118,191,166,A)', 0.06);
    glow(ctx, W * 0.85, H * 0.15, H * 0.6, 'rgba(135,169,232,A)', 0.08);
    const cx = W * 0.62;
    const cy = H * 0.58;
    const wobble = Array.from({ length: 6 }, () => rand() * Math.PI * 2);
    for (let r = 120; r < W * 1.1; r += 46) {
      ctx.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.02) {
        const k = 1 + 0.08 * Math.sin(a * 3 + wobble[0] + r * 0.002) + 0.05 * Math.sin(a * 5 + wobble[1] - r * 0.003);
        const x = cx + Math.cos(a) * r * k * 1.25;
        const y = cy + Math.sin(a) * r * k;
        if (a === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const alpha = Math.max(0.012, 0.07 - r / (W * 18));
      ctx.strokeStyle = `rgba(160,180,215,${alpha})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    grain(ctx, rand, 5);
    results.tiefsee = c.toDataURL('image/jpeg', 0.9);
  }
  return results;
});

for (const [name, dataUrl] of Object.entries(wallpapers)) {
  await write(path.join(out, 'wallpapers', `${name}.jpg`), dataUrl);
  const thumb = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 384;
    c.height = 288;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }, dataUrl);
  await write(path.join(out, 'wallpapers', `${name}-thumb.jpg`), thumb);
}

await browser.close();
console.log('Fertig.');
