// Draws the LBL body and its face overlays procedurally, exactly on the pixel grid.
// The body is a plain cuboid, which is cheaper and cleaner to draw than to generate, and a
// fixed template keeps faces and clothing layers aligned. Usage: node tools/lbl-body.js
import sharp from 'sharp';
import fs from 'node:fs';

const W = 16, H = 24;
const C = {
  outline: '181425',
  skin: 'e4a672',
  highlight: 'ead4aa',
  side: 'b86f50',
  feature: '3e2731',
};

function canvas() { return new Uint8Array(W * H * 4); }
function put(px, x, y, hex) {
  const o = (y * W + x) * 4;
  px[o] = parseInt(hex.slice(0, 2), 16); px[o + 1] = parseInt(hex.slice(2, 4), 16);
  px[o + 2] = parseInt(hex.slice(4, 6), 16); px[o + 3] = 255;
}
function rect(px, x0, y0, w, h, hex) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(px, x, y, hex);
}

function body() {
  const px = canvas();
  rect(px, 0, 0, W, H, C.outline);
  rect(px, 1, 1, W - 2, H - 2, C.skin);
  rect(px, 1, 1, W - 5, 1, C.highlight);   // top edge catches the upper-left light
  rect(px, W - 4, 1, 3, H - 2, C.side);     // right side, one shade darker
  for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) px[(y * W + x) * 4 + 3] = 0;
  return px;
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
  const px = canvas();
  for (const r of [...EYES[eyes], ...mouth]) rect(px, ...r, C.feature);
  return px;
}

async function save(px, name) {
  const img = sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 4 } });
  await img.clone().png().toFile(`client/public/sprites/${name}.png`);
  await img.clone().resize(W * 8, H * 8, { kernel: 'nearest' }).png().toFile(`art/preview/${name}.png`);
}

fs.mkdirSync('client/public/sprites', { recursive: true });
fs.mkdirSync('art/preview', { recursive: true });
const b = body();
await save(b, 'lbl_body');
for (const [name, f] of Object.entries(FACES)) await save(face(f), `face_${name}`);

// Body + default face, used as the style reference for generated clothing and items.
const ref = Uint8Array.from(b);
const f = face(FACES.curious);
for (let i = 0; i < ref.length; i += 4) if (f[i + 3]) ref.set(f.subarray(i, i + 4), i);
await save(ref, 'lbl_ref');
console.log(`drew lbl_body, lbl_ref and faces: ${Object.keys(FACES).join(', ')}`);
