// Draws the sprites that must be exact rather than generated, directly on the pixel grid:
// - the LBL body and its face overlays (a fixed template keeps faces and clothing aligned)
// - the wood block (a building unit; stacked blocks must tile seamlessly)
// - the tree stump, cut from the generated tree's own trunk so the two always match
// Usage: node tools/draw-sprites.js
import sharp from 'sharp';
import fs from 'node:fs';

const C = {
  outline: '181425',
  skin: 'e4a672',
  highlight: 'ead4aa',
  side: 'b86f50',
  feature: '3e2731',
  wood: 'b86f50',
  woodLight: 'c28569',
  woodDark: '733e39',
  cut: 'e8b796',
};

function canvas(w, h) { return { w, h, px: new Uint8Array(w * h * 4) }; }
function put(c, x, y, hex) {
  const o = (y * c.w + x) * 4;
  c.px[o] = parseInt(hex.slice(0, 2), 16); c.px[o + 1] = parseInt(hex.slice(2, 4), 16);
  c.px[o + 2] = parseInt(hex.slice(4, 6), 16); c.px[o + 3] = 255;
}
function rect(c, x0, y0, w, h, hex) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(c, x, y, hex);
}

async function save(c, name) {
  const img = sharp(Buffer.from(c.px), { raw: { width: c.w, height: c.h, channels: 4 } });
  await img.clone().png().toFile(`client/public/sprites/${name}.png`);
  await img.clone().resize(c.w * 8, c.h * 8, { kernel: 'nearest' }).png().toFile(`art/preview/${name}.png`);
}

// --- LBL: a 16x24 cuboid ---
const W = 16, H = 24;
function body() {
  const c = canvas(W, H);
  rect(c, 0, 0, W, H, C.outline);
  rect(c, 1, 1, W - 2, H - 2, C.skin);
  rect(c, 1, 1, W - 5, 1, C.highlight);   // top edge catches the upper-left light
  rect(c, W - 4, 1, 3, H - 2, C.side);     // right side, one shade darker
  for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) c.px[(y * W + x) * 4 + 3] = 0;
  return c;
}

// Front face spans x=1..11; features are mirrored around its center (x=6).
const EYES = {
  open: [[3, 6, 2, 2], [8, 6, 2, 2]],
  closed: [[3, 7, 2, 1], [8, 7, 2, 1]],
};
const FACES = {
  curious: { eyes: 'open', mouth: [[5, 11, 3, 1]] },
  happy: { eyes: 'open', mouth: [[4, 10, 1, 1], [5, 11, 3, 1], [8, 10, 1, 1]] },
  uneasy: { eyes: 'open', mouth: [[4, 11, 1, 1], [5, 10, 1, 1], [6, 11, 1, 1], [7, 10, 1, 1], [8, 11, 1, 1]] },
  lonely: { eyes: 'open', mouth: [[4, 11, 1, 1], [5, 10, 3, 1], [8, 11, 1, 1]] },
  sleepy: { eyes: 'closed', mouth: [[6, 11, 1, 1]] },
};
function face({ eyes, mouth }) {
  const c = canvas(W, H);
  for (const r of [...EYES[eyes], ...mouth]) rect(c, ...r, C.feature);
  return c;
}

// --- Wood block: 8x8, one world cell. A dark rim instead of the black outline, so a wall of
// blocks reads as stacked timber rather than a grid of separate sprites. ---
function woodBlock() {
  const c = canvas(8, 8);
  rect(c, 0, 0, 8, 8, C.woodDark);
  rect(c, 1, 1, 6, 6, C.wood);
  rect(c, 1, 1, 6, 1, C.woodLight);        // lit top edge
  rect(c, 1, 4, 6, 1, C.woodDark);         // plank seam
  put(c, 2, 2, C.woodLight); put(c, 5, 5, C.woodLight); // grain
  return c;
}

// --- Stump: the bottom of the generated tree's trunk with a cut top. ---
async function stump() {
  const src = 'client/public/sprites/tree.png';
  if (!fs.existsSync(src)) { console.log('no tree sprite yet (npm run art tree); skipping stump'); return null; }
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows = 7;
  const c = canvas(info.width, rows);
  c.px.set(data.subarray((info.height - rows) * info.width * 4));
  // Top row becomes an outline cap, the row below it the pale cut face.
  const span = [];
  for (let x = 0; x < c.w; x++) if (c.px[(1 * c.w + x) * 4 + 3]) span.push(x);
  for (let x = 0; x < c.w; x++) c.px[x * 4 + 3] = 0;
  for (const x of span) put(c, x, 0, C.outline);
  for (const x of span.slice(1, -1)) put(c, x, 1, C.cut);
  return c;
}

fs.mkdirSync('client/public/sprites', { recursive: true });
fs.mkdirSync('art/preview', { recursive: true });
const b = body();
await save(b, 'lbl_body');
for (const [name, f] of Object.entries(FACES)) await save(face(f), `face_${name}`);

// Body + default face, used as the style reference for generated clothing and items.
const ref = canvas(W, H);
ref.px.set(b.px);
const f = face(FACES.curious);
for (let i = 0; i < ref.px.length; i += 4) if (f.px[i + 3]) ref.px.set(f.px.subarray(i, i + 4), i);
await save(ref, 'lbl_ref');

await save(woodBlock(), 'wood_block');
const s = await stump();
if (s) await save(s, 'stump');
console.log(`drew lbl_body, lbl_ref, wood_block${s ? ', stump' : ''} and faces: ${Object.keys(FACES).join(', ')}`);
