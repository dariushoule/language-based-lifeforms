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

// Background = everything reachable from the image border through small color steps.
// Models drift off pure #FF00FF and add vignettes, so no single key color works, but the
// sprite's dark outline is always a hard edge the fill cannot cross.
function backgroundMask(data, w, h) {
  const bg = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  for (const p of stack) bg[p] = 1;
  const close = (p, q) =>
    (data[p * 4] - data[q * 4]) ** 2 + (data[p * 4 + 1] - data[q * 4 + 1]) ** 2 + (data[p * 4 + 2] - data[q * 4 + 2]) ** 2 < 28 ** 2;
  while (stack.length) {
    const p = stack.pop(), x = p % w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q < 0 || q >= w * h || bg[q] || !close(p, q)) continue;
      bg[q] = 1;
      stack.push(q);
    }
  }
  return bg;
}

// Palette index per source pixel, -1 for transparent.
function indexImage(data, w, h, key) {
  const bg = key && backgroundMask(data, w, h);
  const idx = new Int16Array(w * h);
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    idx[p] = data[i + 3] < 128 || (bg && bg[p]) ? -1 : nearest(data[i], data[i + 1], data[i + 2]);
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

// Most common palette index in the inner 50% of the cell [x0,x1) x [y0,y1) (ignores blurry borders).
function cellMode(idx, W, x0, x1, y0, y1) {
  const counts = new Map();
  const xa = x0 + (x1 - x0) * 0.25, xb = x0 + (x1 - x0) * 0.75;
  const ya = y0 + (y1 - y0) * 0.25, yb = y0 + (y1 - y0) * 0.75;
  let total = 0;
  for (let y = Math.floor(ya); y <= Math.ceil(yb) && y < y1; y++)
    for (let x = Math.floor(xa); x <= Math.ceil(xb) && x < x1; x++) {
      const v = idx[y * W + x];
      counts.set(v, (counts.get(v) ?? 0) + 1);
      total++;
    }
  let best = -1, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return { value: best, purity: total ? bestN / total : 1 };
}

// Edge strength per position along one axis: how many pixels change palette index
// between position i-1 and i, summed across the box.
function edgeProfile(idx, W, box, axis) {
  const [len, span] = axis === 'x' ? [box.w, box.h] : [box.h, box.w];
  const e = new Float64Array(len);
  for (let i = 1; i < len; i++)
    for (let j = 0; j < span; j++) {
      const [x, y] = axis === 'x' ? [box.x0 + i, box.y0 + j] : [box.x0 + j, box.y0 + i];
      const [px, py] = axis === 'x' ? [x - 1, y] : [x, y - 1];
      if (idx[y * W + x] !== idx[py * W + px]) e[i]++;
    }
  return e;
}

// Lengths of same-color runs along every row and column of the box. Runs shorter than 3px
// are anti-aliasing slivers, not art pixels.
function runLengths(idx, W, box) {
  const runs = [];
  const scan = (at, n) => {
    let start = 0;
    for (let i = 1; i <= n; i++)
      if (i === n || idx[at(i)] !== idx[at(i - 1)]) { if (i - start >= 3) runs.push(i - start); start = i; }
  };
  for (let y = box.y0; y < box.y0 + box.h; y++) scan((i) => y * W + box.x0 + i, box.w);
  for (let x = box.x0; x < box.x0 + box.w; x++) scan((i) => (box.y0 + i) * W + x, box.h);
  return runs;
}

// The art-pixel size: the most common short run (outlines are exactly one art pixel thick),
// refined by fitting every run of up to 4 art pixels as an integer multiple of it.
function detectPeriod(runs) {
  const hist = new Float64Array(64);
  for (const r of runs) if (r < 63) { hist[r] += 1; hist[r - 1] += 0.5; hist[r + 1] += 0.5; }
  let p0 = 3;
  for (let r = 3; r < 63; r++) if (hist[r] > hist[p0]) p0 = r;
  let sumR = 0, sumK = 0;
  for (const r of runs) {
    const k = Math.round(r / p0);
    if (k >= 1 && k <= 4 && Math.abs(r / p0 - k) < 0.25) { sumR += r; sumK += k; }
  }
  return sumK ? sumR / sumK : p0;
}

// With the period fixed, the phase is where the most edge energy lands on grid lines.
function detectPhase(e, p) {
  let best = 0, bestHit = -1;
  for (let phase = 0; phase < p; phase += 0.25) {
    let hit = 0;
    for (let i = 0; i < e.length; i++) {
      const d = ((i - phase) % p + p) % p;
      if (Math.min(d, p - d) <= 1) hit += e[i];
    }
    if (hit > bestHit) { bestHit = hit; best = phase; }
  }
  return best;
}

// Grid lines at phase + k*p across [0, len], each nudged onto the strongest nearby edge,
// because model pixels drift a little in width.
function gridLines(e, p, phase, len) {
  const lines = [0];
  for (let t = phase; t < len; t += p) {
    let at = Math.round(t), peak = e[at] ?? 0;
    for (let i = Math.round(t - p * 0.3); i <= Math.round(t + p * 0.3); i++)
      if (i > 0 && i < len && e[i] > peak) { peak = e[i]; at = i; }
    if (at - lines.at(-1) >= p * 0.5) lines.push(at);
  }
  if (len - lines.at(-1) >= p * 0.5) lines.push(len); else lines[lines.length - 1] = len;
  return lines;
}

function detectGrid(idx, W, box) {
  const ex = edgeProfile(idx, W, box, 'x'), ey = edgeProfile(idx, W, box, 'y');
  // Art pixels are square, so both axes share one period; phases are found per axis.
  const p = detectPeriod(runLengths(idx, W, box));
  return { p, xs: gridLines(ex, p, detectPhase(ex, p), box.w), ys: gridLines(ey, p, detectPhase(ey, p), box.h) };
}

function uniformLines(n, len) {
  return Array.from({ length: n + 1 }, (_, i) => Math.round((i * len) / n));
}

// Returns the grid fit (0..1). With write=false it only scores, which is how candidates are ranked.
export async function pixelize(asset, { src = `art/raw/${asset.id}.png`, write = true } = {}) {
  const [tw, th] = asset.size;
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const idx = indexImage(data, info.width, info.height, asset.key);
  const box = asset.key ? bbox(idx, info.width, info.height) : { x0: 0, y0: 0, w: info.width, h: info.height };

  // Sprites are sampled on the grid the model actually drew; tiles must fill the canvas exactly.
  const grid = asset.key ? detectGrid(idx, info.width, box) : { xs: uniformLines(tw, box.w), ys: uniformLines(th, box.h) };
  const nx = grid.xs.length - 1, ny = grid.ys.length - 1;

  const cells = Buffer.alloc(nx * ny * 4);
  let tilePurity = 0;
  for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
    const m = cellMode(idx, info.width, box.x0 + grid.xs[cx], box.x0 + grid.xs[cx + 1], box.y0 + grid.ys[cy], box.y0 + grid.ys[cy + 1]);
    tilePurity += m.purity;
    const o = (cy * nx + cx) * 4;
    if (m.value >= 0) { const [r, g, b] = palette[m.value]; cells[o] = r; cells[o + 1] = g; cells[o + 2] = b; cells[o + 3] = 255; }
  }
  tilePurity /= nx * ny;
  if (write && (nx > tw || ny > th))
    throw new Error(`${asset.id}: drawn at ${nx}x${ny} art pixels, larger than its ${tw}x${th} canvas`);
  if (!write) return tilePurity;

  // Bottom-center anchor so every character's feet land on the same baseline.
  const out = await sharp({ create: { width: tw, height: th, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: cells, raw: { width: nx, height: ny, channels: 4 },
      left: Math.floor((tw - nx) / 2), top: th - ny }])
    .png()
    .toBuffer();

  fs.mkdirSync('client/public/sprites', { recursive: true });
  fs.mkdirSync('art/preview', { recursive: true });
  await sharp(out).toFile(`client/public/sprites/${asset.id}.png`);
  await sharp(out).resize(tw * 8, th * 8, { kernel: 'nearest' }).toFile(`art/preview/${asset.id}.png`);

  console.log(`pixelized ${asset.id}: ${nx}x${ny} cells on ${tw}x${th} canvas${grid.p ? ` (art pixel ${grid.p.toFixed(2)}px)` : ''}, grid fit ${(tilePurity * 100).toFixed(1)}%` +
    (tilePurity < 0.9 ? '  <-- low: art does not sit on a clean grid, regenerate' : ''));
  return tilePurity;
}

if (import.meta.main) {
  const only = process.argv[2];
  for (const a of assets) if (!only || a.id === only) await pixelize(a);
}
