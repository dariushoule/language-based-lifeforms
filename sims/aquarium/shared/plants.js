// Plant genomes: everything that makes one plant unlike another. The sim breeds, names and feeds
// from them; the client draws each plant from its genome alone (client/plants.js).

export const FORMS = ['kelp', 'coral', 'fan', 'anemone', 'lantern', 'fern', 'tube', 'grass', 'orb', 'vine'];

// Small seeded PRNG (mulberry32): the same seed always grows the same plant.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r, lo, hi) => lo + (hi - lo) * r();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Per form: height range, how many food pods it holds, and seconds to regrow one.
const TRAITS = {
  kelp: { h: [150, 320], food: [3, 6], regen: [70, 120] },
  coral: { h: [70, 170], food: [3, 6], regen: [60, 110] },
  fan: { h: [80, 180], food: [2, 4], regen: [50, 90] },
  anemone: { h: [40, 100], food: [2, 4], regen: [45, 80] },
  lantern: { h: [60, 180], food: [2, 5], regen: [55, 100] },
  fern: { h: [80, 200], food: [2, 4], regen: [60, 100] },
  tube: { h: [50, 130], food: [2, 4], regen: [50, 90] },
  grass: { h: [30, 80], food: [1, 3], regen: [35, 60] },
  orb: { h: [90, 230], food: [3, 6], regen: [70, 130] },
  vine: { h: [120, 280], food: [3, 5], regen: [60, 110] },
};

export function randomGenome(r = Math.random) {
  const form = FORMS[Math.floor(r() * FORMS.length)];
  const t = TRAITS[form];
  const hue = Math.floor(r() * 360);
  // Accents are a related or contrasting hue; a few plants glow in one pure color.
  const shift = [0, 30, -40, 150, 180, 200][Math.floor(r() * 6)];
  return {
    form,
    seed: Math.floor(r() * 2 ** 31),
    hue,
    hue2: (hue + shift + 360) % 360,
    sat: between(r, 0.55, 1),
    glow: between(r, 0.45, 1),
    pulse: between(r, 0.2, 1.6),          // pulses per second
    height: Math.round(between(r, ...t.h)),
    stems: 1 + Math.floor(r() * 7),
    spread: between(r, 0.2, 1),
    thickness: between(r, 0.5, 1.6),
    curl: between(r, -1, 1),
    branch: between(r, 0.25, 0.9),        // branch angle (radians)
    depth: 2 + Math.floor(r() * 3),       // recursion depth for branching forms
    sway: between(r, 0.3, 1.2),
    swaySpeed: between(r, 0.25, 0.8),
    podSize: between(r, 0.7, 1.5),
    food: Math.round(between(r, ...t.food)),
    regen: Math.round(between(r, ...t.regen)),
    lifespan: Math.round(between(r, 1800, 4800)), // s of maturity before it withers
    growTime: Math.round(between(r, 180, 420)),   // s from seed to full height
  };
}

// A seedling resembles its parent: every trait drifts a little, rarely the form itself jumps, and
// now and then one trait leaps somewhere new altogether (a sport), so the tank keeps finding new plants.
export function mutate(g, r = Math.random) {
  const drift = (v, amt, lo, hi) => clamp(v + (r() * 2 - 1) * amt, lo, hi);
  if (r() < 0.04) {
    const fresh = randomGenome(r);
    const k = SPORTS[Math.floor(r() * SPORTS.length)];
    g = { ...g, [k]: fresh[k], ...(k === 'form' ? { height: fresh.height } : {}) };
  }
  const form = r() < 0.06 ? FORMS[Math.floor(r() * FORMS.length)] : g.form;
  const t = TRAITS[form];
  return {
    ...g,
    form,
    seed: Math.floor(r() * 2 ** 31),
    hue: (Math.round(g.hue + (r() * 2 - 1) * 18) + 360) % 360,
    hue2: (Math.round(g.hue2 + (r() * 2 - 1) * 24) + 360) % 360,
    sat: drift(g.sat, 0.08, 0.45, 1),
    glow: drift(g.glow, 0.08, 0.35, 1),
    pulse: drift(g.pulse, 0.15, 0.15, 1.8),
    height: Math.round(form === g.form ? drift(g.height, 20, t.h[0] * 0.8, t.h[1] * 1.15) : between(r, ...t.h)),
    stems: Math.round(drift(g.stems, 1.4, 1, 8)),
    spread: drift(g.spread, 0.1, 0.15, 1),
    thickness: drift(g.thickness, 0.15, 0.4, 1.8),
    curl: drift(g.curl, 0.2, -1, 1),
    branch: drift(g.branch, 0.08, 0.2, 1),
    depth: Math.round(drift(g.depth, 0.6, 2, 4)),
    sway: drift(g.sway, 0.12, 0.2, 1.3),
    swaySpeed: drift(g.swaySpeed, 0.08, 0.2, 0.9),
    podSize: drift(g.podSize, 0.12, 0.6, 1.6),
    food: Math.round(drift(g.food, 0.8, 1, 7)),
    regen: Math.round(drift(g.regen, 10, 30, 150)),
    lifespan: Math.round(drift(g.lifespan, 300, 1200, 6000)),
    growTime: Math.round(drift(g.growTime, 30, 150, 480)),
  };
}

const SPORTS = ['form', 'hue', 'hue2', 'height', 'stems', 'spread', 'curl', 'branch', 'sway', 'pulse', 'podSize', 'food', 'regen'];
const INTS = new Set(['height', 'stems', 'depth', 'food', 'regen', 'lifespan', 'growTime']);

// A hybrid of two plants (a fish carried pollen from one to the other): each trait comes from one
// parent or is blended between them, then the seedling mutates like any other.
export function cross(a, b, r = Math.random) {
  const g = {};
  for (const k of Object.keys(a)) {
    if (typeof a[k] !== 'number' || k === 'seed' || r() < 0.6) g[k] = r() < 0.5 ? a[k] : b[k];
    else if (k === 'hue' || k === 'hue2') {
      const d = ((b[k] - a[k] + 540) % 360) - 180; // the short way around the color wheel
      g[k] = Math.round((a[k] + d / 2 + 360) % 360);
    } else g[k] = INTS.has(k) ? Math.round((a[k] + b[k]) / 2) : (a[k] + b[k]) / 2;
  }
  const t = TRAITS[g.form];
  g.height = clamp(g.height, t.h[0] * 0.8, t.h[1] * 1.15);
  return mutate(g, r);
}

const HUES = [
  [15, 'ember'], [35, 'amber'], [55, 'gold'], [80, 'lime'], [120, 'jade'], [160, 'sea-glass'],
  [185, 'cyan'], [210, 'azure'], [240, 'indigo'], [270, 'violet'], [300, 'orchid'], [330, 'rose'], [360, 'ember'],
];
const NOUNS = {
  kelp: ['kelp', 'ribbonweed', 'streamer'], coral: ['coral', 'antler', 'branchwort'], fan: ['fan', 'lacework', 'veil'],
  anemone: ['anemone', 'tendril-cup', 'fingerbloom'], lantern: ['lantern', 'bulbstalk', 'lamp-reed'],
  fern: ['fern', 'fiddlehead', 'curlfrond'], tube: ['tube', 'chimney', 'pipe-sponge'], grass: ['grass', 'tuft', 'bristle'],
  orb: ['orbstring', 'bead-tree', 'pearlstalk'], vine: ['vine', 'twinewort', 'helix'],
};

export const hueWord = (h) => HUES.find(([lim]) => h <= lim)[1];

export function speciesName(g) {
  const r = rng(g.seed ^ 0x5eed);
  const noun = NOUNS[g.form][Math.floor(r() * NOUNS[g.form].length)];
  const habit = g.height > 200 ? 'towering ' : g.sway > 1 ? 'swaying ' : g.pulse > 1.2 ? 'flickering ' : g.glow > 0.85 ? 'blazing ' : '';
  return `${habit}${hueWord(g.hue2)} ${noun}`;
}

// Where along its height a plant's food grows, as a fraction (fish nibble about here).
export const FEED_AT = { kelp: 0.85, coral: 0.8, fan: 0.75, anemone: 0.9, lantern: 0.95, fern: 0.85, tube: 0.95, grass: 0.9, orb: 0.8, vine: 0.85 };
