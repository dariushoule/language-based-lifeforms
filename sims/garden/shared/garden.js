// Geometry and sky shared by the sim and the renderer, so both agree on where the ground, the pond
// and the spiral are, and on what the moon is doing at any moment.
// Units are screen pixels of a 1280x720 garden; y grows downward. The wall stands at the back with
// the sky above it; the ground is a plane seen at a slant, from the wall's foot (y = ground) to the
// front edge, so things further down the screen are nearer and drawn larger.

export const WORLD = { width: 1280, height: 720, wallTop: 372, ground: 528, ceiling: 60, floor: 702 };
export const POND = { x: 1065, y: 648, rx: 140, ry: 34 };
// The spiral bed. Once every plot is open at once it flowers for `flowering` seconds.
// A stone lantern stands between the bed and the pond; nothing roots on it or right behind it.
export const LANTERN = { x: 884, y: 604 };
export const SPIRAL = { x: 610, y: 628, rx: 222, ry: 60, plots: 19, turns: 2.5, flowering: 150 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (v) => { v = clamp(v, 0, 1); return v * v * (3 - 2 * v); };
const step = (lo, hi, v) => smooth((v - lo) / (hi - lo));

const inEllipse = (e, x, y, pad) => ((x - e.x) / (e.rx + pad)) ** 2 + ((y - e.y) / (e.ry + pad * 0.4)) ** 2 < 1;
export const inPond = (x, y, pad = 0) => inEllipse(POND, x, y, pad);
export const inSpiral = (x, y, pad = 0) => inEllipse(SPIRAL, x, y, pad);

// How large something rooted at ground height y is drawn: small by the wall, large at the front.
export const depthScale = (y) => 0.8 + 0.55 * clamp((y - WORLD.ground) / (WORLD.height - WORLD.ground), 0, 1);

// A point k of the way (0 to 1) along the spiral path, from its heart out to its mouth at the front.
// Equal steps in k are equal steps along the path.
export function spiralPoint(k) {
  const r = Math.sqrt(k), a = SPIRAL.turns * 2 * Math.PI * r - Math.PI / 2;
  return { x: SPIRAL.x + Math.cos(a) * r * SPIRAL.rx, y: SPIRAL.y + Math.sin(a) * r * SPIRAL.ry };
}
export const plotPos = (i) => spiralPoint((i + 0.5) / SPIRAL.plots);

// ---------- the sky ----------
// Everything overhead is a pure function of garden time, so the sim and every observer see the same
// sky without it being streamed.
//
// A night lasts NIGHT seconds and ends in the pale: the day, squeezed into under a minute, when the
// sky washes out and every flower shuts. The moon goes from new to new in LUNATION nights, and it
// keeps the real moon's habits: a young moon is a thin curve already sinking in the west at dusk, a
// full one crosses the whole night, an old one rises just before the pale, and around the new moon
// there is none at all. Its bright side faces where the sun went.

export const NIGHT = 600;
export const LUNATION = 8;
const START_PHASE = 0.3125; // a new garden opens on a half-grown moon, and its full moons stand high at midnight
export const MOON = { radius: 30, east: 70, west: 1210, horizon: 396, top: 84 };

function hash(n, salt = 0) {
  let x = Math.imul((Math.floor(n) + 0x7f4a7c15 + salt * 0x9e3779b1) | 0, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
// Smooth noise in time: a new random value every `period` seconds, eased between.
function drift(time, period, salt) {
  const s = Math.floor(time / period), f = time / period - s;
  return hash(s, salt) + (hash(s + 1, salt) - hash(s, salt)) * smooth(f);
}

// Wind along the garden, about -1.4 to 1.4 (positive blows toward the west wall): a wandering
// breeze, and every minute or two a gust that sweeps through for a few seconds.
export function windAt(time) {
  const slot = Math.floor(time / 95);
  const start = slot * 95 + hash(slot, 11) * 70, len = 7 + hash(slot, 12) * 6;
  const g = (time - start) / len;
  const gust = g > 0 && g < 1 ? Math.sin(g * Math.PI) ** 2 * (0.7 + 0.5 * hash(slot, 13)) * (hash(slot, 14) < 0.5 ? -1 : 1) : 0;
  return 0.22 * Math.sin(time / 11) + 0.12 * Math.sin(time / 3.7 + 1) + gust;
}

// The clouds: a few banks drifting west, heavier or thinner as the weather turns.
const CLOUDS = Array.from({ length: 6 }, (_, k) => ({
  x0: hash(k, 21) * 2200, v: 5 + hash(k, 22) * 9, y: 110 + hash(k, 23) * 190, w: 260 + hash(k, 24) * 240,
}));
export function cloudsAt(time) {
  const opacity = step(0.3, 0.75, drift(time, 240, 31) ** 1.3);
  return CLOUDS.map((c) => ({ x: ((c.x0 + c.v * time) % 2200) - 460, y: c.y, w: c.w, alpha: opacity }));
}

export function skyAt(time) {
  const nights = time / NIGHT;
  const night = Math.floor(nights), u = nights - night;
  const phase = (nights / LUNATION + START_PHASE) % 1; // 0 new, 0.5 full
  const lit = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  const waxing = phase < 0.5;
  // Where the moon is on its way across: 0 at the east wall, 1 at the west. It runs ahead of or
  // behind the night by its phase, which is what makes a young moon set early and an old one rise late.
  const m = u + 1 - 2 * phase;
  const up = m > 0 && m < 1;
  const alt = up ? Math.sin(Math.PI * m) : 0;
  const x = MOON.east + clamp(m, -0.1, 1.1) * (MOON.west - MOON.east);
  const y = MOON.horizon - Math.sin(Math.PI * clamp(m, -0.1, 1.1)) * (MOON.horizon - MOON.top);

  const pale = smooth(1 - Math.min(u, 1 - u) / 0.05);
  const cloudiness = drift(time, 240, 31) ** 1.3;
  const veil = step(0.75, 0.95, cloudiness) * 0.7; // a sky gone wholly grey
  let bank = 0;
  for (const c of cloudsAt(time)) bank = Math.max(bank, c.alpha * clamp(1.25 - Math.abs(x - c.x) / (c.w * 0.42), 0, 1) * clamp(1.3 - Math.abs(y - c.y) / 70, 0, 1));
  const cover = up ? 1 - (1 - Math.min(1, bank)) * (1 - veil) : 0;
  const rain = step(0.82, 0.95, cloudiness);

  // Now and then the full moon is eclipsed: a rust-red shadow creeps over it for a few minutes. A
  // new garden's first full moon always is.
  const j = Math.round(nights / LUNATION - 0.5 + START_PHASE);
  const full = (j + 0.5 - START_PHASE) * LUNATION * NIGHT;
  const eclipse = j >= 0 && (j === 0 || hash(j, 41) < 0.34) ? smooth(1 - Math.abs(time - full) / 110) : 0;

  // Moonlight reaching the garden, 0 to 1: what the flowers open and close by.
  const light = up ? lit ** 0.8 * (0.35 + 0.65 * alt) * (1 - 0.75 * cover) * (1 - 0.85 * eclipse) * (1 - pale) : 0;
  return {
    night, u, phase, lit, waxing, m, up, alt, x, y, pale, cloudiness, cover, rain, eclipse, light,
    halo: hash(night, 51) > 0.7, wind: windAt(time),
  };
}

// Moonlight in words, as fireflies speak of it and as flowers are described.
export const lightWord = (l) => (l < 0.03 ? 'dark' : l < 0.15 ? 'faint' : l < 0.35 ? 'dim' : l < 0.6 ? 'half-bright' : l < 0.8 ? 'bright' : 'brilliant');
