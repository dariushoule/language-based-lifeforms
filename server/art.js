// Fish portraits: a pool of POOL_SIZE alien fish, drawn on fal (FLUX.2 klein 4B, about a second and
// $0.0013 each) from random traits and cut out of their magenta background. The pool fills on
// demand, one new fish per newcomer, and after that newcomers get a random portrait from it.
// It lives in data/fish/pool, on the machine only. Needs FAL_API_KEY.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const MODEL = 'fal-ai/flux-2/klein/4b';
const WIDTH = 220; // stored sprite width; the client scales it to the fish's size
const POOL_SIZE = 600;

const TRAITS = [
  ['a long eel-like body', 'a round puffed body', 'a flat disc-shaped body', 'a torpedo-shaped body', 'a spiny urchin-like body',
    'an armored, plated body', 'a translucent jelly-like body', 'a thin ribbon of a body', 'a hammer-shaped head', 'a frilled, many-finned body',
    'a segmented body like a shrimp tail', 'a huge bulbous head and a tiny tail'],
  ['violet and teal', 'copper and gold', 'deep red and orange', 'ice blue and white', 'emerald and lime', 'rose and cream', 'black with cyan',
    'amber and brown', 'indigo and silver', 'sea green and yellow', 'crimson and violet', 'pearl white and lavender'],
  ['feathery fins', 'long trailing streamers', 'tiny fluttering fins', 'a tall sail-like dorsal fin', 'webbed wing-like fins',
    'whisker tendrils', 'a forked ribbon tail', 'spiked fin rays'],
  ['a dangling lantern lure', 'rows of glowing dots', 'glowing stripes', 'a luminous belly', 'glowing rings around its eyes',
    'pulsing spots', 'a glowing heart visible inside it', 'glowing fin edges'],
  ['one huge eye', 'three small eyes', 'large round eyes', 'tiny eyes on stalks', 'mirror-like eyes'],
];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export const artEnabled = () => Boolean(process.env.FAL_API_KEY);

function fishPrompt() {
  const [body, colors, fins, light, eyes] = TRAITS.map(pick);
  return 'A single otherworldly alien sea creature, like a fish from another planet and unlike any Earth species, ' +
    `strict side view facing right, whole body visible. It has ${body}, colored ${colors}, with ${fins}, ${light} and ${eyes}. ` +
    'Bioluminescent glowing markings. Detailed painted digital illustration, rich saturated colors, crisp clean edges, ' +
    'a thin dark outline around the creature. Centered on a perfectly flat solid pure magenta (#FF00FF) background ' +
    'with wide empty margins. No shadow, no water, no bubbles, no text.';
}

async function generate(prompt) {
  const res = await fetch(`https://fal.run/${MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Key ${process.env.FAL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image_size: { width: 512, height: 512 }, num_images: 1, output_format: 'png', sync_mode: true }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`fal: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const url = (await res.json()).images[0].url;
  return url.startsWith('data:') ? Buffer.from(url.slice(url.indexOf(',') + 1), 'base64') : Buffer.from(await (await fetch(url)).arrayBuffer());
}

function hueOf(r, g, b) {
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// A light, saturated color of hue h, the way light organs glow.
function vivid(h) {
  const f = (n) => { const k = (n + h / 30) % 12; return 0.62 - 0.38 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

// Background = everything reachable from the border that is close to the border's own color.
// The model's dark outline stops the fill; a soft ring just inside it is un-blended from the
// background so no magenta fringe survives.
export async function cutOut(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const px = (p) => [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]];
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  const med = (i) => border.map((p) => data[p * 4 + i]).sort((a, b) => a - b)[border.length >> 1];
  const bg = [med(0), med(1), med(2)];
  const dBg = (p) => { const [r, g, b] = px(p); return Math.hypot(r - bg[0], g - bg[1], b - bg[2]); };
  // Magenta in any brightness (the model's soft shadows and vignettes) also counts as background.
  const magentaBg = bg[0] > 170 && bg[2] > 170 && bg[1] < 90;
  const tinted = (p) => { const [r, g, b] = px(p); return magentaBg && Math.min(r, b) - g > 60 && Math.abs(r - b) < 70; };
  const isBack = (p) => dBg(p) < 110 || tinted(p);

  const isBg = new Uint8Array(w * h);
  const stack = border.filter(isBack);
  for (const p of stack) isBg[p] = 1;
  while (stack.length) {
    const p = stack.pop(), x = p % w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q < 0 || q >= w * h || isBg[q] || !isBack(q)) continue;
      isBg[q] = 1;
      stack.push(q);
    }
  }
  // Distance (in px, up to 3) from the background, for the soft edge.
  const near = new Uint8Array(w * h).fill(9);
  for (let p = 0; p < w * h; p++) if (isBg[p]) near[p] = 0;
  for (let pass = 1; pass <= 3; pass++)
    for (let p = 0; p < w * h; p++) {
      if (near[p] !== 9) continue;
      const x = p % w;
      if ((x > 0 && near[p - 1] === pass - 1) || (x < w - 1 && near[p + 1] === pass - 1) || near[p - w] === pass - 1 || near[p + w] === pass - 1) near[p] = pass;
    }
  const out = Buffer.alloc(w * h * 4);
  let x0 = w, y0 = h, x1 = -1, y1 = -1, fg = 0;
  const hues = new Float64Array(24); // vividness-weighted hue histogram of the bright pixels
  for (let p = 0; p < w * h; p++) {
    if (isBg[p]) continue;
    let [r, g, b] = px(p);
    let a = 1;
    if (near[p] <= 2) {
      a = Math.max(0, Math.min(1, (dBg(p) - 90) / 110));
      if (a < 0.05) continue;
      const un = (c, k) => Math.max(0, Math.min(255, (c - (1 - a) * k) / a));
      r = un(r, bg[0]); g = un(g, bg[1]); b = un(b, bg[2]);
    }
    if (magentaBg && near[p] <= 3) {
      // Whatever magenta still bleeds into the edge is spill, not the creature.
      const spill = Math.min(r, b) - g;
      if (spill > 30) { a *= Math.max(0, 1 - (spill - 30) / 90); r -= spill * 0.7; b -= spill * 0.7; }
      if (a < 0.05) continue;
    }
    out[p * 4] = r; out[p * 4 + 1] = g; out[p * 4 + 2] = b; out[p * 4 + 3] = Math.round(a * 255);
    fg++;
    const x = p % w, y = (p / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    // The glow color: the dominant hue among bright, saturated pixels (the creature's light organs
    // and colors). Averaging colors instead washes every fish out to the same amber.
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 150 && mx - mn > 70) hues[Math.floor(hueOf(r, g, b) / 15) % 24] += ((mx - mn) / 255) * (mx / 255);
  }
  if (fg < w * h * 0.03) throw new Error('nothing left after cutting out the background');
  const peak = hues.reduce((best, v, i) => (v > hues[best] ? i : best), 0);
  const glow = hues[peak] > 5 ? vivid(peak * 15 + 7.5) : '#7fdcff';
  const pad = 4;
  const left = Math.max(0, x0 - pad), top = Math.max(0, y0 - pad);
  const sprite = await sharp(out, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left, top, width: Math.min(w, x1 + pad + 1) - left, height: Math.min(h, y1 + pad + 1) - top })
    .resize({ width: WIDTH, kernel: 'lanczos3' }).png().toBuffer();
  return { sprite, glow };
}

// A portrait for a newcomer: a new one while the pool is filling, a random one after that.
// Returns its public path (/fish/pool/<file>) and glow color, which is kept in the file name.
export async function fishArt(spriteDir) {
  const dir = path.join(spriteDir, 'pool');
  fs.mkdirSync(dir, { recursive: true });
  const pool = fs.readdirSync(dir).filter((f) => /^[0-9a-z]+-[0-9a-f]{6}\.png$/.test(f));
  const art = (file) => ({ sprite: `/fish/pool/${file}`, glow: `#${file.slice(-10, -4)}` });
  if (pool.length >= POOL_SIZE || !artEnabled()) {
    if (!pool.length) throw new Error('the portrait pool is empty and FAL_API_KEY is not set');
    return art(pick(pool));
  }
  // A cut-out occasionally fails when the model paints a scene instead of a creature; try again once.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { sprite, glow } = await cutOut(await generate(fishPrompt()));
      const file = `${Date.now().toString(36)}-${glow.slice(1)}.png`;
      fs.writeFileSync(path.join(dir, file), sprite);
      return art(file);
    } catch (e) { lastErr = e; }
  }
  if (pool.length) return art(pick(pool));
  throw lastErr;
}
