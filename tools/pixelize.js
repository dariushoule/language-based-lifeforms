// Deterministically snaps an AI image onto the real pixel grid:
// key out background -> crop to content -> detect the AI's pseudo-pixel cell size ->
// sample one palette color per cell -> binary alpha -> place on a fixed canvas.
// Usage: node tools/pixelize.js [assetId]   (reads art/raw/<id>.png, writes client/public/sprites/<id>.png)
import sharp from 'sharp';
import fs from 'node:fs';

const assets = JSON.parse(fs.readFileSync('art/assets.json', 'utf8'));
const palette = JSON.parse(fs.readFileSync('art/palette.json', 'utf8')).colors.map((h) => [
  parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
]);

function nearest(r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    // Weighted RGB distance; good enough for a 32-color palette.
    const d = 2 * (r - p[0]) ** 2 + 4 * (g - p[1]) ** 2 + 3 * (b - p[2]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Palette index per source pixel, -1 for transparent.
function indexImage(data, w, h, key) {
  const idx = new Int16Array(w * h);
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    const magenta = key && r > 150 && b > 150 && g < 110 && Math.abs(r - b) < 90;
    idx[p] = a < 128 || magenta ? -1 : nearest(r, g, b);
  }
  return idx;
}

function bbox(idx, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (idx[y * w + x] < 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Most common palette index in the inner 50% of a cell (ignores blurry cell borders).
function cellMode(idx, W, box, cx, cy, cw, ch) {
  const counts = new Map();
  const xa = box.x0 + (cx + 0.25) * cw, xb = box.x0 + (cx + 0.75) * cw;
  const ya = box.y0 + (cy + 0.25) * ch, yb = box.y0 + (cy + 0.75) * ch;
  let total = 0;
  for (let y = Math.floor(ya); y <= Math.ceil(yb); y += Math.max(1, Math.floor(ch / 8)))
    for (let x = Math.floor(xa); x <= Math.ceil(xb); x += Math.max(1, Math.floor(cw / 8))) {
      const v = idx[y * W + x];
      counts.set(v, (counts.get(v) ?? 0) + 1);
      total++;
    }
  let best = -1, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return { value: best, purity: bestN / total };
}

// The model's pseudo-pixels are only roughly even, so we impose the grid: the largest
// whole-cell size that fits the content inside the canvas while keeping its aspect ratio.
// Within ~25% below that, pick the grid whose cells are most uniform: it best matches the
// resolution the model actually drew at. (Unbounded, flat regions would favor tiny grids.)
function fitGrid(idx, W, box, tw, th) {
  const scale = Math.min(tw / box.w, th / box.h);
  const maxNx = Math.max(1, Math.min(tw, Math.round(box.w * scale)));
  let best = null;
  for (let nx = maxNx; nx >= Math.max(1, Math.ceil(maxNx * 0.75)); nx--) {
    const cw = box.w / nx;
    const ny = Math.max(1, Math.min(th, Math.round(box.h / cw)));
    const ch = box.h / ny;
    let purity = 0;
    for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) purity += cellMode(idx, W, box, cx, cy, cw, ch).purity;
    purity /= nx * ny;
    if (!best || purity > best.purity + 0.002) best = { nx, ny, cw, ch, purity };
  }
  return best;
}

export async function pixelize(asset) {
  const [tw, th] = asset.size;
  const { data, info } = await sharp(`art/raw/${asset.id}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const idx = indexImage(data, info.width, info.height, asset.key);
  const box = asset.key ? bbox(idx, info.width, info.height) : { x0: 0, y0: 0, w: info.width, h: info.height };

  // Tiles fill the canvas exactly; sprites keep their aspect inside it.
  const grid = asset.key
    ? fitGrid(idx, info.width, box, tw, th)
    : { nx: tw, ny: th, cw: box.w / tw, ch: box.h / th };
  if (grid.ny > th) throw new Error(`${asset.id}: detected ${grid.nx}x${grid.ny} grid exceeds ${tw}x${th}`);

  const cells = Buffer.alloc(grid.nx * grid.ny * 4);
  let tilePurity = 0;
  for (let cy = 0; cy < grid.ny; cy++) for (let cx = 0; cx < grid.nx; cx++) {
    const m = cellMode(idx, info.width, box, cx, cy, grid.cw, grid.ch);
    tilePurity += m.purity;
    const o = (cy * grid.nx + cx) * 4;
    if (m.value >= 0) { const [r, g, b] = palette[m.value]; cells[o] = r; cells[o + 1] = g; cells[o + 2] = b; cells[o + 3] = 255; }
  }
  tilePurity /= grid.nx * grid.ny;

  // Bottom-center anchor so every character's feet land on the same baseline.
  const out = await sharp({ create: { width: tw, height: th, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: cells, raw: { width: grid.nx, height: grid.ny, channels: 4 },
      left: Math.floor((tw - grid.nx) / 2), top: th - grid.ny }])
    .png()
    .toBuffer();

  fs.mkdirSync('client/public/sprites', { recursive: true });
  fs.mkdirSync('art/preview', { recursive: true });
  await sharp(out).toFile(`client/public/sprites/${asset.id}.png`);
  await sharp(out).resize(tw * 8, th * 8, { kernel: 'nearest' }).toFile(`art/preview/${asset.id}.png`);

  console.log(`pixelized ${asset.id}: ${grid.nx}x${grid.ny} cells on ${tw}x${th} canvas, grid fit ${(tilePurity * 100).toFixed(1)}%` +
    (tilePurity < 0.9 ? '  <-- low: art does not sit on a clean grid, regenerate' : ''));
}

if (import.meta.main) {
  const only = process.argv[2];
  for (const a of assets) if (!only || a.id === only) await pixelize(a);
}
