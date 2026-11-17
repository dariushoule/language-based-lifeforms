// Plant genomes: everything that makes one plant of the garden unlike another. The sim breeds, names
// and blooms them; the client draws each plant from its genome alone (client/flora.js).
//
// Garden plants live fast. They sprout, bud, flower, go to seed and die within a night or two, and
// what decides whether one ever flowers is the moon: every genome has a window of moonlight (lo to
// hi, on the 0-1 scale of shared/garden.js) in which its flowers stand open. Some want a bright moon,
// some only the dark, some the dimness between.

// Where each form can root: most on open ground, vines at the foot of the wall, lilies on the pond.
export const FORMS = ['bell', 'star', 'trumpet', 'spire', 'umbel', 'fern', 'grass', 'puff', 'bush', 'cap', 'vine', 'lily'];
export const GROUND_FORMS = FORMS.filter((f) => !['cap', 'vine', 'lily'].includes(f));

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

// Per form: height range, petals per flower, sips of nectar it holds, seconds to grow, and seconds it
// lives once grown.
const TRAITS = {
  bell: { h: [70, 150], petals: [4, 6], nectar: [2, 4], grow: [70, 130], life: [420, 800] },
  star: { h: [50, 120], petals: [5, 11], nectar: [2, 4], grow: [55, 110], life: [380, 720] },
  trumpet: { h: [80, 160], petals: [5, 6], nectar: [3, 5], grow: [80, 140], life: [450, 850] },
  spire: { h: [110, 210], petals: [4, 5], nectar: [3, 5], grow: [90, 150], life: [450, 850] },
  umbel: { h: [80, 160], petals: [5, 5], nectar: [2, 4], grow: [70, 120], life: [400, 760] },
  fern: { h: [60, 140], petals: [3, 3], nectar: [1, 2], grow: [60, 120], life: [500, 900] },
  grass: { h: [50, 130], petals: [3, 3], nectar: [1, 2], grow: [40, 90], life: [360, 700] },
  puff: { h: [40, 100], petals: [11, 15], nectar: [1, 3], grow: [45, 90], life: [300, 560] },
  bush: { h: [70, 140], petals: [4, 6], nectar: [3, 5], grow: [100, 160], life: [550, 950] },
  cap: { h: [14, 40], petals: [3, 3], nectar: [0, 0], grow: [12, 28], life: [130, 240] },
  vine: { h: [110, 165], petals: [5, 5], nectar: [2, 4], grow: [200, 320], life: [1100, 1900] },
  lily: { h: [10, 16], petals: [8, 13], nectar: [2, 4], grow: [90, 150], life: [700, 1200] },
};

// The moonlight a plant's flowers open in. Mushrooms glow only in the dark; lilies love the moon.
function lightWindow(form, r) {
  const k = form === 'cap' ? 0.9 : form === 'lily' ? 0.1 : r();
  if (k < 0.45) return { lo: between(r, 0.05, 0.4), hi: 1 };  // opens to the moon
  if (k < 0.8) return { lo: 0, hi: between(r, 0.1, 0.42) };   // opens in the dark
  return { lo: between(r, 0.02, 0.12), hi: between(r, 0.35, 0.7) }; // opens in gentle light
}

export function randomGenome(r = Math.random, form = GROUND_FORMS[Math.floor(r() * GROUND_FORMS.length)]) {
  const t = TRAITS[form];
  const hue2 = Math.floor(r() * 360);
  return {
    form,
    seed: Math.floor(r() * 2 ** 31),
    hue: Math.round(between(r, 95, 205)),   // stems and leaves: greens through blue-greens
    hue2,                                    // flowers and light
    hue3: (hue2 + [0, 25, -30, 160, 180, 200][Math.floor(r() * 6)] + 360) % 360, // the flower's heart
    sat: between(r, 0.55, 1),
    glow: between(r, 0.45, 1),
    pulse: between(r, 0.15, 1.1),            // pulses per second
    height: Math.round(between(r, ...t.h)),
    stems: 1 + Math.floor(r() * 6),
    spread: between(r, 0.2, 1),
    thickness: between(r, 0.6, 1.5),
    curl: between(r, -1, 1),
    sway: between(r, 0.4, 1.3),
    petals: Math.round(between(r, ...t.petals)),
    petalLen: between(r, 0.7, 1.5),
    petalWid: between(r, 0.5, 1.4),
    cup: between(r, 0, 1),                   // 0 opens flat like a daisy, 1 stays a deep cup
    turn: between(r, 0, 1),                  // how far its flowers turn to follow the moon
    ...lightWindow(form, r),
    nectar: Math.round(between(r, ...t.nectar)),
    regen: Math.round(between(r, 25, 60)),   // s to refill a sip
    growTime: Math.round(between(r, ...t.grow)),
    bloomSpan: Math.round(between(r, 150, 380)), // s it can stand open in all before it goes to seed
    lifespan: Math.round(between(r, ...t.life)), // s it lives once grown, flowered or not
    seeds: 2 + Math.floor(r() * 4),
    lightness: between(r, 0.4, 1.3),         // how far the wind carries its seeds
  };
}

// A seedling resembles its parent: every trait drifts a little, rarely the form itself jumps, and
// now and then one trait leaps somewhere new altogether (a sport), so the garden keeps finding new
// plants. `keepForm` holds the form (vines and lilies breed true: they can't root anywhere else).
export function mutate(g, r = Math.random) {
  const keepForm = !GROUND_FORMS.includes(g.form);
  const drift = (v, amt, lo, hi) => clamp(v + (r() * 2 - 1) * amt, lo, hi);
  if (r() < 0.06) {
    const fresh = randomGenome(r, keepForm ? g.form : undefined);
    const k = SPORTS[Math.floor(r() * SPORTS.length)];
    if (k === 'window') g = { ...g, lo: fresh.lo, hi: fresh.hi };
    else if (k !== 'form' || !keepForm) g = { ...g, [k]: fresh[k], ...(k === 'form' ? { height: fresh.height, petals: fresh.petals } : {}) };
  }
  const form = !keepForm && r() < 0.05 ? GROUND_FORMS[Math.floor(r() * GROUND_FORMS.length)] : g.form;
  const t = TRAITS[form];
  const turnHue = (h, amt) => (Math.round(h + (r() * 2 - 1) * amt) + 360) % 360;
  let lo = g.lo > 0 ? drift(g.lo, 0.04, 0.01, 0.6) : 0, hi = g.hi < 1 ? drift(g.hi, 0.04, 0.08, 0.95) : 1;
  if (hi - lo < 0.08) hi = Math.min(1, lo + 0.08);
  return {
    ...g,
    form,
    seed: Math.floor(r() * 2 ** 31),
    hue: clamp(turnHue(g.hue, 10), 80, 220),
    hue2: turnHue(g.hue2, 20),
    hue3: turnHue(g.hue3, 26),
    sat: drift(g.sat, 0.08, 0.45, 1),
    glow: drift(g.glow, 0.08, 0.35, 1),
    pulse: drift(g.pulse, 0.12, 0.1, 1.3),
    height: Math.round(form === g.form ? drift(g.height, 14, t.h[0] * 0.8, t.h[1] * 1.15) : between(r, ...t.h)),
    stems: Math.round(drift(g.stems, 1.2, 1, 7)),
    spread: drift(g.spread, 0.1, 0.15, 1),
    thickness: drift(g.thickness, 0.12, 0.5, 1.6),
    curl: drift(g.curl, 0.2, -1, 1),
    sway: drift(g.sway, 0.12, 0.3, 1.4),
    petals: Math.round(form === g.form ? drift(g.petals, 0.9, 3, 16) : between(r, ...t.petals)),
    petalLen: drift(g.petalLen, 0.12, 0.6, 1.7),
    petalWid: drift(g.petalWid, 0.12, 0.4, 1.6),
    cup: drift(g.cup, 0.12, 0, 1),
    turn: drift(g.turn, 0.12, 0, 1),
    lo, hi,
    nectar: t.nectar[1] ? Math.round(clamp(g.nectar + (r() * 2 - 1) * 0.8, 1, 6)) : 0,
    regen: Math.round(drift(g.regen, 6, 15, 80)),
    growTime: Math.round(form === g.form ? drift(g.growTime, 14, t.grow[0] * 0.7, t.grow[1] * 1.2) : between(r, ...t.grow)),
    bloomSpan: Math.round(drift(g.bloomSpan, 30, 100, 480)),
    lifespan: Math.round(form === g.form ? drift(g.lifespan, 60, t.life[0] * 0.7, t.life[1] * 1.2) : between(r, ...t.life)),
    seeds: Math.round(drift(g.seeds, 0.8, 1, 6)),
    lightness: drift(g.lightness, 0.12, 0.3, 1.5),
  };
}

const SPORTS = ['form', 'hue2', 'hue3', 'height', 'stems', 'spread', 'curl', 'petals', 'petalLen', 'cup', 'turn', 'window', 'pulse'];
const INTS = new Set(['height', 'stems', 'petals', 'nectar', 'regen', 'growTime', 'bloomSpan', 'lifespan', 'seeds']);
const HUE_KEYS = new Set(['hue', 'hue2', 'hue3']);

// A hybrid of two plants (a firefly carried pollen from one to the other): each trait comes from one
// parent or is blended between them, then the seedling mutates like any other. The form is the
// mother's, so the seed can root where she did.
export function cross(mother, father, r = Math.random) {
  const g = {};
  for (const k of Object.keys(mother)) {
    if (k === 'form' || k === 'seed') g[k] = mother[k];
    else if (r() < 0.55) g[k] = r() < 0.5 ? mother[k] : father[k];
    else if (HUE_KEYS.has(k)) {
      const d = ((father[k] - mother[k] + 540) % 360) - 180; // the short way around the color wheel
      g[k] = Math.round((mother[k] + d / 2 + 360) % 360);
    } else g[k] = INTS.has(k) ? Math.round((mother[k] + father[k]) / 2) : (mother[k] + father[k]) / 2;
  }
  if (g.hi - g.lo < 0.08) { g.lo = mother.lo; g.hi = mother.hi; }
  const t = TRAITS[g.form];
  g.height = clamp(g.height, t.h[0] * 0.8, t.h[1] * 1.15);
  g.petals = clamp(g.petals, 3, 16);
  g.growTime = clamp(g.growTime, t.grow[0] * 0.7, t.grow[1] * 1.2);
  g.lifespan = clamp(g.lifespan, t.life[0] * 0.7, t.life[1] * 1.2);
  if (!t.nectar[1]) g.nectar = 0;
  return mutate(g, r);
}

// Whether a plant's flowers stand open in moonlight `light`.
export const opensIn = (g, light) => light >= g.lo && light <= g.hi;

// The same, in words a firefly can plan by.
export function opensWords(g) {
  if (g.form === 'cap') return 'glows in the dark and under a faint moon';
  if (g.hi >= 1) return g.lo < 0.13 ? 'opens to any moonlight' : g.lo < 0.28 ? 'opens once the moon is fairly bright' : 'opens only to a bright, high moon';
  if (g.lo <= 0) return g.hi < 0.18 ? 'opens only in deep dark' : g.hi < 0.32 ? 'opens in the dark and under a faint moon' : 'opens in the dark and under a dim moon, and shuts when it grows bright';
  return 'opens in gentle light: a thin or low moon, neither full dark nor brightness';
}

const HUES = [
  [15, 'ember'], [35, 'amber'], [55, 'gold'], [80, 'lime'], [120, 'jade'], [160, 'sea-green'],
  [185, 'cyan'], [210, 'azure'], [240, 'indigo'], [270, 'violet'], [300, 'orchid'], [330, 'rose'], [360, 'ember'],
];
const NOUNS = {
  bell: ['moonbell', 'hushbell', 'nodding-bell'], star: ['starwort', 'night-daisy', 'asterlamp'], trumpet: ['duskhorn', 'moonflower', 'pale-trumpet'],
  spire: ['foxlamp', 'candle-spire', 'towerbloom'], umbel: ['lacecap', 'mothlace', 'veilwort'], fern: ['ghostfern', 'fiddlehead', 'curlfrond'],
  grass: ['plume-grass', 'whisper-reed', 'silvertuft'], puff: ['clockflower', 'blowball', 'wishpuff'], bush: ['briar-rose', 'thornlight', 'hedge-lamp'],
  cap: ['glowcap', 'lantern-cap', 'fairy-stool'], vine: ['wall-creeper', 'nightvine', 'lampvine'], lily: ['pond-lamp', 'moon-lily', 'floatbloom'],
};

export const hueWord = (h) => HUES.find(([lim]) => h <= lim)[1];

export function speciesName(g) {
  const r = rng(g.seed ^ 0x5eed);
  const noun = NOUNS[g.form][Math.floor(r() * NOUNS[g.form].length)];
  const habit = g.hi < 0.2 ? 'shade ' : g.lo > 0.28 ? 'moon-hungry ' : g.height > 170 ? 'tall ' : g.glow > 0.9 ? 'blazing ' : '';
  return `${habit}${hueWord(g.hue2)} ${noun}`;
}

// Where along its height a plant's flowers sit, as a fraction (fireflies sip and hover about here).
export const HEAD_AT = { bell: 0.8, star: 0.95, trumpet: 0.9, spire: 0.75, umbel: 0.95, fern: 0.7, grass: 0.9, puff: 0.95, bush: 0.8, cap: 0.9, vine: 0.6, lily: 1 };
