// Generates a small raw image per asset on fal (FLUX.2 klein 4B), then pixelizes it.
// Usage: node tools/gen-art.js [assetId] [--force] [--n=4]
// Needs FAL_API_KEY in .env. Cost at 512x512: ~$0.0013/image, ~$0.0026 with a style reference.
import fs from 'node:fs';
import { pixelize } from './pixelize.js';

process.loadEnvFile?.('.env');
const KEY = process.env.FAL_API_KEY;
if (!KEY) throw new Error('FAL_API_KEY missing from .env');

const T2I = 'fal-ai/flux-2/klein/4b';
const EDIT = 'fal-ai/flux-2/klein/4b/edit';
const SIZE = { width: 512, height: 512 };
// art/style.md holds '## common', '## sprite' and '## tile' sections; each asset gets common + its kind.
const style = Object.fromEntries(fs.readFileSync('art/style.md', 'utf8').split(/^## /m).filter(Boolean)
  .map((s) => [s.slice(0, s.indexOf('\n')).trim(), s.slice(s.indexOf('\n')).trim()]));
const assets = JSON.parse(fs.readFileSync('art/assets.json', 'utf8'));
const force = process.argv.includes('--force');
const n = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 1);
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
// An approved sprite becomes the style anchor for every sprite generated after it.
const STYLE_REF = 'client/public/sprites/lbl_naked.png';

function prompt(a, useRef) {
  return [
    useRef ? 'Draw a new sprite in exactly the same pixel art style, pixel scale, outline and palette as the reference image.' : '',
    style.common,
    a.key ? style.sprite : style.tile,
    a.key
      ? `The object is about ${a.size[0]} pixels wide and ${a.size[1]} pixels tall, drawn with big chunky square pixels.`
      : `The whole canvas is ${a.size[0]}x${a.size[1]} big chunky square pixels.`,
    `Asset: ${a.prompt}`,
  ].filter(Boolean).join('\n');
}

async function fal(model, input) {
  const res = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, image_size: SIZE, num_images: n, output_format: 'png', sync_mode: true }),
  });
  if (!res.ok) throw new Error(`${model}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function toBuffer(url) {
  if (url.startsWith('data:')) return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

fs.mkdirSync('art/raw', { recursive: true });

for (const a of assets) {
  if (only && a.id !== only) continue;
  const out = `art/raw/${a.id}.png`;
  if (fs.existsSync(out) && !force) { console.log(`skip ${a.id} (raw exists; --force to regenerate)`); continue; }
  // Tiles must not inherit a character's outline and side shading, so only sprites get the reference.
  const useRef = a.key && a.id !== 'lbl_naked' && fs.existsSync(STYLE_REF);

  const t0 = Date.now();
  const input = { prompt: prompt(a, useRef) };
  if (useRef) input.image_urls = [`data:image/png;base64,${fs.readFileSync(STYLE_REF).toString('base64')}`];
  const r = await fal(useRef ? EDIT : T2I, input);
  console.log(`generated ${a.id} with ${useRef ? EDIT : T2I} in ${((Date.now() - t0) / 1000).toFixed(1)}s (seed ${r.seed})`);

  // With --n>1, every candidate is kept as <id>.<i>.png and the cleanest grid fit becomes the raw.
  const bufs = await Promise.all(r.images.map((img) => toBuffer(img.url)));
  let best = 0;
  if (bufs.length > 1) {
    const fits = [];
    for (const [i, b] of bufs.entries()) {
      fs.writeFileSync(`art/raw/${a.id}.${i}.png`, b);
      fits.push(await pixelize(a, { src: `art/raw/${a.id}.${i}.png`, write: false }));
    }
    best = fits.indexOf(Math.max(...fits));
    console.log(`  candidate fits ${fits.map((f) => (f * 100).toFixed(1)).join(' / ')} -> #${best}`);
  }
  fs.writeFileSync(out, bufs[best]);
  await pixelize(a);
}
