// Authoritative night garden simulation. Runs headless; clients only render snapshots.
// Units are screen pixels of a 1280x720 garden; y grows downward (see shared/garden.js).
//
// Fireflies (the LBLs here) live a night or less. They act through a short queue of high-level
// actions (fly, sip, watch the sky, sow, wake a flower, ...) that the sim executes tick by tick, and
// they talk. A mind (server/index.js relays to the mind service over /mind) decides what to do and
// say; without one, a simple instinct does. When its time comes a firefly rises out of the garden
// into the sky and a newcomer kindles in the grass, carrying some of what it held.
//
// What they are all trying to work out is the moon (shared/garden.js): it changes shape from night to
// night, rises later each night, and some nights isn't there, and no firefly lives long enough to see
// it go round. What outlives them is the book of myths they tell about it: composed, reworked,
// embraced, disputed and passed on, kept with their whole lineage. What they make together is the
// spiral: a bed of nineteen plots they sow from the wild garden, which flowers only when every plot
// stands open at once.

import { WORLD, POND, SPIRAL, LANTERN, plotPos, inPond, inSpiral, depthScale, skyAt, lightWord } from '../shared/garden.js';
import { randomGenome, mutate, cross, speciesName, opensWords, opensIn, hueWord, HEAD_AT, GROUND_FORMS } from '../shared/flora.js';

const POPULATION = 5;
const LIFESPAN = [240, 560];  // s a firefly lives before the height calls it
const FAREWELL = 40;          // s before leaving that a firefly feels the height calling
const PREPARE = 150;          // s before leaving that its successor starts being prepared (a persona takes a minute or two)
const ARRIVAL_TIMEOUT = 150;  // s an empty place waits for a prepared newcomer before taking a plain one
const HEAR = 280;             // px a voice carries
const NEAR = 46;              // px to stop at when visiting another firefly
const COMPANY = 150;          // px within which another firefly is company
const TALK_SECS = 14;         // s two fireflies stay face to face after one speaks to the other
const MAX_WILD = 22;          // plants on open ground, outside the spiral
const MIN_WILD = 12;
const START_WILD = 15;
const MAX_VINES = 3;
const MAX_LILIES = 3;
const MAX_CAPS = 6;
const DRIFT_SEED = 300;       // s between seeds of something entirely new blowing in over the wall, room permitting
const SEEDING = 110;          // s a plant stands in seed, letting its seeds go
const WAKE_SECS = 45;         // s a flower stays open after a firefly wakes it
const KEEP_FLOWERS = 3;       // plots of a spent spiral that sprout again from its own seed
const SPIRALS_KEPT = 40;      // finished spirals remembered after they've gone to seed
const CARRY = 8;              // myths one firefly can carry in mind at once
const COMPOSE_GAP = 75;       // s between new myths from one firefly, so ideas get time to be talked over
const INHERIT = 4;            // myths a newcomer arrives with, from the firefly it follows
const ARCHIVE = 2000;         // myths the book keeps in all (the least regarded forgotten ones go first)
const MEMORY = 40;            // remembered events per firefly
const HEARD = 30;             // remembered lines of conversation per firefly
const CONVERSATION = 14;      // of those, the most recent ones a firefly is reminded of each turn
const NOTES = 6;              // things a firefly has chosen to keep in mind (the mind's `remember`)
const THOUGHTS = 3;           // recent thoughts a firefly is reminded of, so its intentions carry over
const WITNESSED = 7;          // things a firefly has seen in the sky with its own eyes: its evidence
const MIND_TIMEOUT = 150;     // s before a silent mind is ignored and instinct takes over
const THINK_GAP = 1.5;        // s between finishing a plan and asking for the next
const FAIL_GAP = 4;           // s to pause after an action fails
const PLAN_MAX = 4;           // actions per plan
const REASONING_KEEP = 4000;  // chars of streamed reasoning kept per firefly
const SPEECH_MAX = 450;       // chars per spoken turn (under a paragraph)
const SPEECH_STALE = 45;      // s a line can wait for the floor before it's no longer worth saying
const STAR_GAP = [70, 240];   // s between falling stars on a clear night
const EDGE = 56;              // px fireflies keep from the side walls

const ACTIONS = ['fly_to', 'visit', 'follow', 'sip', 'rest', 'wander', 'watch_sky', 'touch_pond', 'sow', 'uproot', 'wake'];
const FEELINGS = ['curious', 'happy', 'content', 'playful', 'lonely', 'uneasy', 'afraid', 'doubtful', 'sleepy', 'thirsty', 'grieving', 'awed'];
const FLASHES = ['slow pulse', 'quick double', 'long glow', 'triple flicker', 'steady ember'];
// The book's chapters: the questions the myths answer.
const THEMES = ['what the moon is', 'why it changes', 'where it goes', 'what it wants', 'the stars', 'the moon in the water',
  'our own light', 'the flowers', 'the dark', 'the pale', 'the soil', 'the rising'];
// Firefly lights, by hue: mostly the yellows and greens of real ones, with a few rarer colors.
const GLOWS = [28, 46, 60, 76, 96, 128, 156, 178, 198, 320, 268];

// ---------- creation ----------

export function createWorld(store = nullStore(), { empty = false } = {}) {
  const world = {
    tick: 0, time: 0, nextId: 1, entities: [], lore: new Map(), nextLoreId: 1, arrivals: [],
    slotOpenAt: null, lastDrift: 0, nextStar: 60, mind: null, store, emit: () => {},
    speech: [], floorUntil: 0, // lines waiting to be said, and when the current one has been read
    spiral: newSpiral(1), spirals: [], omens: [], seen: null,
  };
  if (empty) return world;
  for (let i = 0; i < START_WILD; i++) {
    const at = wildSpot(world);
    if (at) world.entities.push(aged(createPlant(world, at.x, at.y, randomGenome(), null)));
  }
  for (let i = 0; i < 2; i++) sprout(world, randomGenome(Math.random, 'vine'), null, true);
  for (let i = 0; i < 2; i++) sprout(world, randomGenome(Math.random, 'lily'), null, true);
  for (let i = 0; i < POPULATION; i++) queueArrival(world, null);
  world.seen = watchSky(world);
  return world;
}

// The spiral: which plant stands in each plot (by id), and who has tended it.
function newSpiral(number) {
  return { number, plots: Array(SPIRAL.plots).fill(null), floweringAt: null, tenders: {} };
}

function nullStore() {
  return { putLore() {}, dropLore() {}, putFly() {}, event() {} };
}

const id = (world) => world.nextId++;
const flies = (world) => world.entities.filter((e) => e.kind === 'firefly');
const plants = (world) => world.entities.filter((e) => e.kind === 'plant');
const byId = (world, i, kind) => world.entities.find((e) => e.id === i && (!kind || e.kind === kind));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const r2 = (v) => Math.round(v * 100) / 100;
const an = (s) => `${/^[aeiou]/i.test(s) ? 'an' : 'a'} ${s}`;
const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`);
const ageOf = (world, f) => world.time - f.bornAt;
const minutes = (s) => (s < 90 ? `${Math.round(s)} seconds` : `${Math.round(s / 60)} minutes`);

// ---------- plants ----------

// `from` is where it came from: { gen, parents: [names] } for a seedling, nothing for a seed blown in.
// `plot` is its place in the spiral, if it was sown there.
function createPlant(world, x, y, genome, from, plot = null) {
  return {
    id: id(world), kind: 'plant', x: Math.round(x), y: Math.round(y), genome, name: speciesName(genome),
    gen: from ? from.gen + 1 : 1, parents: from?.parents ?? [], plot, scale: r2(depthScale(y) * (plot != null ? 0.7 : 1)),
    age: 0, growth: 0.02, state: 'growing', open: false, flip: 0, openT: 0, wokenUntil: 0,
    nectar: 0, regenT: 0, given: 0, pollen: null, seedsLeft: 0, seedT: 0, seeding: 0, wither: 0, fade: 0,
  };
}

// Starts a garden at all ages, so it doesn't bloom and wither in lockstep.
function aged(p) {
  const g = p.genome;
  p.age = Math.random() * (g.growTime + g.lifespan * 0.6);
  p.growth = Math.min(1, Math.max(0.02, p.age / g.growTime));
  if (p.growth >= 1) { p.state = 'mature'; p.openT = Math.random() * g.bloomSpan * 0.6; p.nectar = Math.round(Math.random() * g.nectar); }
  return p;
}

const wild = (world) => plants(world).filter((p) => p.plot == null && GROUND_FORMS.includes(p.genome.form) && p.state !== 'dead');
const ofForm = (world, form) => plants(world).filter((p) => p.genome.form === form && p.state !== 'dead');

// Open ground with room for one more plant: off the spiral and the pond, not on top of a neighbor.
function wildSpot(world, near = null, tries = 14) {
  for (let i = 0; i < tries; i++) {
    const x = near ? clamp(near.x + rand(-60 - 25 * i, 60 + 25 * i), 24, WORLD.width - 24) : rand(24, WORLD.width - 24);
    const y = near && i < 4 ? clamp(near.y + rand(-30, 30), WORLD.ground + 8, WORLD.floor) : rand(WORLD.ground + 8, WORLD.floor);
    if (inSpiral(x, y, 30) || inPond(x, y, 16) || (Math.abs(x - LANTERN.x) < 36 && y < LANTERN.y + 10)) continue;
    if (plants(world).every((p) => Math.abs(p.x - x) > 30 || Math.abs(p.y - y) > 13)) return { x, y };
  }
  return null;
}

// Where a seed of this form can take root near (x, y), or null. Vines root at the foot of the wall,
// lilies on the pond, everything else on open ground.
function rootSpot(world, genome, x, y) {
  if (genome.form === 'vine') {
    if (ofForm(world, 'vine').length >= MAX_VINES) return null;
    for (let i = 0; i < 8; i++) {
      const vx = clamp(x + rand(-80 * i, 80 * i), 40, WORLD.width - 40);
      if (ofForm(world, 'vine').every((p) => Math.abs(p.x - vx) > 130)) return { x: vx, y: WORLD.ground + 2 };
    }
    return null;
  }
  if (genome.form === 'lily') {
    if (ofForm(world, 'lily').length >= MAX_LILIES) return null;
    for (let i = 0; i < 10; i++) {
      const a = rand(0, Math.PI * 2), k = Math.sqrt(Math.random()) * 0.72;
      const at = { x: POND.x + Math.cos(a) * POND.rx * k, y: POND.y + Math.sin(a) * POND.ry * k };
      if (ofForm(world, 'lily').every((p) => dist(p, at) > 55)) return at;
    }
    return null;
  }
  if (genome.form === 'cap') return ofForm(world, 'cap').length < MAX_CAPS ? wildSpot(world, { x, y }, 6) : null;
  if (wild(world).length >= MAX_WILD) return null;
  // Seeds of a form that crowds the garden, or that land among their own kind, often fail to take
  // root; rare forms always do. That keeps any one kind of plant from taking over.
  const others = wild(world), kin = others.filter((p) => p.genome.form === genome.form);
  const share = others.length ? kin.length / others.length : 0;
  let chance = share > 0.3 ? 0.25 : share > 0.2 ? 0.6 : 1;
  for (const p of kin) if (Math.abs(p.x - x) < 90 && Math.abs(p.y - y) < 40) chance *= 0.6;
  if (kin.length > 1 && Math.random() > chance) return null;
  return wildSpot(world, { x, y }, 6);
}

function sprout(world, genome, from, grown = false, x = rand(40, WORLD.width - 40), y = rand(WORLD.ground + 8, WORLD.floor)) {
  const at = rootSpot(world, genome, x, y);
  if (!at) return null;
  const p = createPlant(world, at.x, at.y, genome, from);
  world.entities.push(grown ? aged(p) : p);
  return p;
}

// Where a plant's flowers are: fireflies sip, wake and gather seed about here.
function headPoint(p) {
  return { x: p.x, y: p.y - p.genome.height * Math.max(0.3, p.growth) * p.scale * HEAD_AT[p.genome.form] - 6 };
}

// A seed let go on the wind: it lifts off the plant, drifts, and takes root where it comes down.
function releaseSeed(world, p, genome, parents) {
  const from = headPoint(p);
  world.entities.push({
    id: id(world), kind: 'seed', x: from.x, y: from.y, vx: rand(-10, 10), vy: rand(-16, -6), hue: genome.hue2,
    landY: rand(WORLD.ground + 8, WORLD.floor), genome, gen: p.gen, parents, age: 0, lightness: genome.lightness,
  });
}

// The seed a plant gives: its own, a little changed, or a hybrid if a firefly brought it pollen.
function seedOf(p) {
  return p.pollen && Math.random() < 0.7
    ? { genome: cross(p.genome, p.pollen.genome), parents: [p.name, p.pollen.name] }
    : { genome: mutate(p.genome), parents: [p.name] };
}

function stepPlants(world, dt, sky) {
  const flowering = world.spiral.floweringAt != null;
  for (const p of plants(world)) {
    const g = p.genome;
    p.age += dt;
    if (p.state === 'growing') {
      p.growth = Math.min(1, p.growth + (dt / g.growTime) * (1 + 1.5 * sky.rain));
      if (p.growth >= 1) p.state = 'mature';
    } else if (p.state === 'mature') {
      // Flowers open and close by the moonlight (and all shut in the pale), a few seconds behind it.
      const want = (flowering && p.plot != null) || world.time < p.wokenUntil || (opensIn(g, sky.light) && sky.pale < 0.25);
      p.flip = want === p.open ? 0 : p.flip + dt;
      if (p.flip > 3) { p.open = want; p.flip = 0; }
      if (p.open) {
        p.openT += dt;
        if (p.nectar < g.nectar && (p.regenT += dt) >= g.regen) { p.regenT = 0; p.nectar++; }
      }
      // A plant in the spiral waits for the Flowering however long it takes. A wild one goes to seed
      // once it has had its fill of flowering; one that never met its moon dies without any.
      if (p.plot == null && (p.openT >= g.bloomSpan || p.age > g.growTime + g.lifespan)) {
        if (p.openT > 20 || g.form === 'cap') goToSeed(p);
        else { p.state = 'withering'; p.open = false; }
      }
    } else if (p.state === 'seeding') {
      p.seeding += dt;
      // Seeds leave one by one, and all the faster in a gust.
      p.seedT -= dt * (1 + 3 * Math.max(0, Math.abs(sky.wind) - 0.5));
      if (p.seedsLeft > 0 && p.seedT <= 0) {
        p.seedsLeft--;
        p.seedT = rand(8, SEEDING / (g.seeds + 1));
        const s = seedOf(p);
        if (g.form === 'lily' || g.form === 'cap') sprout(world, s.genome, { gen: p.gen, parents: s.parents }, false, p.x, p.y);
        else releaseSeed(world, p, s.genome, s.parents);
      }
      if (p.seeding > SEEDING) p.state = 'withering';
    } else if (p.state === 'withering') {
      p.wither = Math.min(1, p.wither + dt / 40);
      if (p.wither >= 1) {
        p.state = 'dead';
        // Glowing caps come up where something has died.
        if (g.form !== 'cap' && Math.random() < 0.3) sprout(world, randomGenome(Math.random, 'cap'), null, false, p.x, p.y);
      }
    } else if (p.state === 'dead') {
      p.fade = Math.min(1, p.fade + dt / 25);
      if (p.fade >= 1) world.entities.splice(world.entities.indexOf(p), 1);
    }
  }
  // Seeds of something new blow in over the wall when the garden gets bare, and now and then anyway.
  const bare = wild(world).length < MIN_WILD;
  if (world.time - world.lastDrift > (bare ? 20 : DRIFT_SEED) && wild(world).length < MAX_WILD) {
    world.lastDrift = world.time;
    const form = Math.random() < 0.12 ? pick(['vine', 'lily']) : undefined;
    const genome = randomGenome(Math.random, form);
    if (form) sprout(world, genome, null);
    else {
      const side = sky.wind < 0 ? WORLD.width + 20 : -20;
      world.entities.push({ id: id(world), kind: 'seed', x: side, y: rand(WORLD.wallTop - 60, WORLD.wallTop + 40), vx: 0, vy: rand(-4, 4), hue: genome.hue2,
        landY: rand(WORLD.ground + 8, WORLD.floor), genome, gen: 0, parents: null, age: 0, lightness: 1.2, blownIn: true });
    }
  }
}

function goToSeed(p) {
  Object.assign(p, { state: 'seeding', open: false, nectar: 0, seedsLeft: p.genome.seeds + (p.pollen ? 1 : 0), seedT: rand(4, 14), seeding: 0 });
}

function stepSeeds(world, dt, sky) {
  for (const s of world.entities.filter((e) => e.kind === 'seed')) {
    s.age += dt;
    // Blown-in seeds always ride into the garden, whichever way the wind is going.
    const push = s.blownIn && s.x < 60 ? 1 : s.blownIn && s.x > WORLD.width - 60 ? -1 : sky.wind;
    s.vx += (push * 70 * s.lightness - s.vx) * Math.min(1, dt * 0.8);
    s.vy = Math.min(22, s.vy + 7 * dt);
    s.x += s.vx * dt + Math.sin(s.age * 1.7 + s.id) * 6 * dt;
    s.y += s.vy * dt;
    if (s.y < s.landY && s.age < 90 && s.x > -60 && s.x < WORLD.width + 60) continue;
    world.entities.splice(world.entities.indexOf(s), 1);
    if (s.x > 20 && s.x < WORLD.width - 20) sprout(world, s.genome, s.parents ? { gen: s.gen, parents: s.parents } : null, false, s.x, s.landY);
  }
}

// ---------- the spiral ----------

const plotPlant = (world, i) => (world.spiral.plots[i] != null ? byId(world, world.spiral.plots[i], 'plant') : null);
const planted = (world) => world.spiral.plots.filter((v) => v != null).length;

function stepSpiral(world, sky) {
  const sp = world.spiral;
  // Plots forget plants that are gone (they can't be, but a saved garden might disagree).
  sp.plots.forEach((v, i) => { if (v != null && !plotPlant(world, i)) sp.plots[i] = null; });
  if (sp.floweringAt == null) {
    const all = sp.plots.map((_, i) => plotPlant(world, i));
    if (all.every((p) => p && p.state === 'mature' && p.open)) beginFlowering(world, sky);
    return;
  }
  if (world.time - sp.floweringAt < SPIRAL.flowering) return;
  // The Flowering is over: every plot goes to seed, its seeds mixed with its neighbors', and the bed
  // is bare again but for a few plots that sprout from the spiral's own seed.
  const spent = sp.plots.map((_, i) => plotPlant(world, i));
  world.spirals.push({
    number: sp.number, finishedAt: Date.now(), tenders: sp.tenders, moon: moonMark(sky),
    flowers: spent.map((p) => ({ name: p.name, form: p.genome.form, hue: p.genome.hue, hue2: p.genome.hue2 })),
  });
  if (world.spirals.length > SPIRALS_KEPT) world.spirals.shift();
  spent.forEach((p, i) => {
    p.pollen ??= { genome: spent[(i + 1) % spent.length].genome, name: spent[(i + 1) % spent.length].name };
    p.plot = null;
    goToSeed(p);
  });
  world.spiral = newSpiral(sp.number + 1);
  for (const p of spent.slice().sort(() => Math.random() - 0.5).slice(0, KEEP_FLOWERS)) {
    const i = sp.plots.indexOf(p.id), at = plotPos(i);
    const child = createPlant(world, at.x, at.y, mutate(p.genome), { gen: p.gen, parents: [p.name] }, i);
    world.entities.push(child);
    world.spiral.plots[i] = child.id;
  }
  for (const f of flies(world)) remember(world, f, `the ${ordinal(sp.number)} spiral's Flowering ended: its flowers shut and went to seed, and the bed is nearly bare again`);
  world.emit({ kind: 'spiral', text: `The ${ordinal(sp.number)} spiral went to seed. A few of its flowers have sprouted again in the bare bed.` });
}

function beginFlowering(world, sky) {
  const sp = world.spiral;
  sp.floweringAt = world.time;
  omen(world, { kind: 'flowering' });
  for (const f of flies(world)) {
    if (f.leaving) continue;
    f.needs.wonder = Math.min(1, f.needs.wonder + 0.35);
    witness(world, f, `the Flowering: all nineteen plots of the spiral stood open at once and the whole bed blazed and poured its light upward (${skyNow(sky)})`);
    interrupt(world, f, 1);
  }
  world.emit({ kind: 'spiral', text: `The ${ordinal(sp.number)} spiral is in full flower: every plot open at once, under ${moonMark(sky).words}.` });
}

// The moonlight in which every planted flower would stand open at once, in words; or which two can't.
function spiralNote(world) {
  const here = world.spiral.plots.map((_, i) => plotPlant(world, i)).filter(Boolean);
  if (world.spiral.floweringAt != null) return `the Flowering: every plot is open; it will last ${minutes(Math.max(0, SPIRAL.flowering - (world.time - world.spiral.floweringAt)))} more, then all goes to seed`;
  if (!here.length) return 'bare: nothing sown yet';
  const needs = here.reduce((a, b) => (b.genome.lo > a.genome.lo ? b : a)), shy = here.reduce((a, b) => (b.genome.hi < a.genome.hi ? b : a));
  const left = SPIRAL.plots - here.length;
  const todo = left ? `${left} plot${left > 1 ? 's' : ''} still empty. ` : '';
  if (needs.genome.lo > shy.genome.hi - 0.02) {
    return `${todo}As sown, these can never all open by themselves at once: the ${needs.name} in plot ${needs.plot} needs more moonlight than the ${shy.name} in plot ${shy.plot} can bear. ` +
      'One of them must be replaced, or woken by a firefly at the right moment.';
  }
  const lo = lightWord(needs.genome.lo + 0.001), hi = lightWord(Math.min(1, shy.genome.hi) - 0.001);
  return `${todo}As sown, they would all stand open together when the moonlight is ${lo === hi ? lo : `between ${lo} and ${hi}`} (right now it is ${lightWord(skyAt(world.time).light)}).`;
}

function describeSpiral(world) {
  const sp = world.spiral;
  const plots = sp.plots.map((_, i) => {
    const p = plotPlant(world, i);
    if (!p) return `${i}: empty`;
    return `${i}: ${p.name} (#${p.id}), ${p.state === 'growing' ? 'still growing' : p.open ? 'OPEN' : 'closed'}; ${opensWords(p.genome)}`;
  });
  const at = plotPos(0);
  return {
    number: sp.number, sown: `${planted(world)} of ${SPIRAL.plots} plots`, open_now: sp.plots.filter((_, i) => plotPlant(world, i)?.open).length,
    plots, note: spiralNote(world), where: `plot 0 is the heart, at (${Math.round(at.x)}, ${Math.round(at.y)}); the plots wind outward to plot ${SPIRAL.plots - 1} at the front`,
  };
}

// ---------- the sky, as fireflies see it ----------

// The moon's shape in plain sight: fireflies have no names for its phases, only what it looks like.
function moonShape(s) {
  const side = s.waxing ? 'west' : 'east';
  const k = s.lit;
  if (k < 0.04) return `a hair-thin curve of light, its horns pointing ${s.waxing ? 'east' : 'west'}`;
  if (k < 0.22) return `a thin bright curve with two sharp horns, bowed toward the ${side} wall, the rest of its round only a grey ghost`;
  if (k < 0.42) return `a fat curve of light, bright on the side toward the ${side} wall, the rest of its round a grey ghost`;
  if (k < 0.58) return `half a disc, cut straight down the middle, the bright half toward the ${side} wall`;
  if (k < 0.93) return `a nearly round disc with a dark bite out of the side toward the ${s.waxing ? 'east' : 'west'} wall`;
  return 'a full round disc, bright all the way across';
}
function moonPlace(s) {
  if (s.alt > 0.88) return 'at the very top of the sky';
  if (s.m < 0.5) return s.alt < 0.35 ? 'low over the east wall, climbing' : 'partway up the eastern sky, climbing';
  return s.alt < 0.35 ? 'low over the west wall, sinking' : 'partway down the western sky, sinking';
}
function skyNow(s) {
  if (!s.up) return s.pale > 0.2 ? 'no moon; the pale is washing the whole sky out' : `no moon anywhere in the sky; ${s.cloudiness > 0.75 ? 'only cloud' : 'only the small cold stars'}`;
  if (s.cover > 0.8) return `the moon is hidden in cloud: a smear of light ${moonPlace(s)}`;
  return `the moon is ${moonShape(s)}, ${moonPlace(s)}` + (s.eclipse > 0.3 ? ', dimmed to the dull red of rust by a shadow lying across it' : '') +
    (s.cover > 0.35 ? ', veiled by thin cloud' : '') + (s.halo && s.eclipse < 0.3 ? ', with a wide pale ring around it' : '');
}
// The moon a myth was set down under, kept with it in the book.
function moonMark(s) {
  const words = !s.up ? 'a moonless sky' : s.eclipse > 0.3 ? 'a rust-red moon' : s.lit < 0.22 ? 'a thin moon' : s.lit < 0.42 ? 'a fat curve of moon' : s.lit < 0.58 ? 'a half moon' : s.lit < 0.93 ? 'a nearly round moon' : 'a full round moon';
  return { phase: r2(s.phase), up: s.up, eclipse: s.eclipse > 0.3, words };
}

// What the sky is doing, in the few facts whose changes are worth a firefly's notice.
function watchSky(world) {
  const s = skyAt(world.time);
  return { up: s.up, pale: s.pale > 0.3, hidden: s.up && s.cover > 0.8, rust: s.eclipse > 0.3, rain: s.rain > 0.3, gust: Math.abs(s.wind) > 0.75, night: s.night };
}

// Something a firefly saw in the sky with its own eyes: it remembers it, and keeps it as evidence.
function witness(world, f, text) {
  remember(world, f, text);
  (f.witnessed ??= []).push({ at: world.time, text });
  if (f.witnessed.length > WITNESSED) f.witnessed.shift();
}

function stepSky(world, sky) {
  const now = watchSky(world), was = world.seen ?? now;
  world.seen = now;
  const all = (text, wonder = 0) => {
    for (const f of flies(world)) if (!f.leaving) { witness(world, f, text); f.needs.wonder = Math.min(1, f.needs.wonder + wonder); }
  };
  // The moon also comes and goes during the pale (a swelling moon rises before dusk, a shrinking
  // one sets after dawn), and then no one sees it happen.
  const hid = sky.pale > 0.3;
  if (now.up && !was.up) {
    all(hid ? `as the pale thinned, the moon was already standing in the sky, as if it had climbed up behind the pale: ${moonShape(sky)}, ${moonPlace(sky)}`
      : `the moon rose over the east wall: ${moonShape(sky)}`, 0.05);
  }
  if (!now.up && was.up) all(hid ? 'the pale took the moon with it: it was still in the sky when the pale came, and when the pale thinned it was nowhere' : 'the moon sank behind the west wall and was gone');
  if (now.pale && !was.pale) all('the pale came: the whole sky washed out grey and gold, the stars went, and every flower shut');
  if (!now.pale && was.pale) all(`the pale drained away and the dark came back; ${skyNow(sky)}`);
  if (now.rust && !was.rust) { all('a shadow the color of rust crept across the full moon until it hung dim and red as an ember', 0.15); world.emit({ kind: 'sky', text: 'A rust-red shadow crept across the full moon.' }); }
  if (!now.rust && was.rust) all('the rust drew off the moon and it was white again, as if nothing had touched it', 0.05);
  if (now.hidden && !was.hidden && now.up && was.up) all('a cloud swallowed the moon');
  if (!now.hidden && was.hidden && now.up && was.up) all(`the moon came back out of the cloud, the same shape as it went in`);
  if (now.rain && !was.rain) all('rain began to fall on the garden');
  if (!now.rain && was.rain) {
    all('the rain stopped; everything is beaded with water');
    for (let i = 0; i < 3; i++) sprout(world, randomGenome(Math.random, 'cap'), null);
  }
  // A firefly sees the moon for the first time whenever it's first in a clear sky above it.
  for (const f of flies(world)) {
    if (!f.seenMoon && sky.up && sky.cover < 0.8 && sky.pale < 0.5 && !f.entering) {
      f.seenMoon = true;
      witness(world, f, `saw the moon for the first time: ${moonShape(sky)}, ${moonPlace(sky)}`);
      f.needs.wonder = Math.min(1, f.needs.wonder + 0.1);
    }
  }
  // Falling stars, on clear dark nights.
  if (world.time >= world.nextStar) {
    world.nextStar = world.time + rand(...STAR_GAP);
    if (sky.pale < 0.1 && sky.cloudiness < 0.6) {
      const x = rand(120, WORLD.width - 120), y = rand(70, 250), dir = Math.random() < 0.5 ? -1 : 1;
      omen(world, { kind: 'star', x, y, x2: x + dir * rand(120, 260), y2: y + rand(40, 120) });
      for (const f of flies(world)) if (!f.leaving && Math.random() < 0.6) witness(world, f, `a star fell out of the ${x < WORLD.width / 2 ? 'eastern' : 'western'} sky, drew a line of light, and went out before it reached the wall`);
    }
  }
  world.omens = world.omens.filter((o) => world.time - o.at < 12);
}

// Brief things observers see happen (a falling star, rings on the pond, the Flowering beginning).
function omen(world, o) {
  world.omens.push({ id: id(world), at: r2(world.time), ...o });
}

// ---------- arrivals and departures ----------

const standing = (l) => l.told + 2 * (l.agreed?.length ?? 0) - 2 * (l.disputed?.length ?? 0);

// The firefly that will follow `pred` (or a first one, if null). Its personality is prepared
// outside the sim (server/births.js) before it's needed.
function queueArrival(world, pred) {
  const keep = pred ? pred.lore.filter((k) => k.stance !== 'disputes' && world.lore.has(k.id))
    .sort((a, b) => (b.stance === 'embraces') - (a.stance === 'embraces') || standing(world.lore.get(b.id)) - standing(world.lore.get(a.id)))
    .slice(0, INHERIT) : [];
  const arr = {
    id: id(world), gen: pred ? pred.gen + 1 : 1, predecessorId: pred?.id ?? null, predecessorName: pred?.name ?? null,
    lineage: pred ? [pred.name, ...(pred.lineage ?? [])].slice(0, 6) : [],
    lore: keep.map((k) => ({ id: k.id, from: pred.name })), status: 'new', persona: null, article: null, queuedAt: world.time,
  };
  world.arrivals.push(arr);
  if (pred) pred.successor = arr.id;
  return arr;
}

// Called by server/births.js once a newcomer has a personality.
export function arrivalReady(world, arrivalId, { persona, article }) {
  const arr = world.arrivals.find((a) => a.id === arrivalId);
  if (!arr) return false;
  Object.assign(arr, { persona: persona ?? arr.persona, article: article ?? arr.article, status: 'ready' });
  return true;
}

// A light no other living firefly has, as a hue and as the color it's drawn in.
function newGlow(world) {
  const taken = new Set(flies(world).map((f) => f.hue));
  const hue = pick(GLOWS.filter((h) => !taken.has(h)));
  const f = (n) => { const k = (n + hue / 30) % 12; return 0.66 - 0.34 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return { hue, glow: '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('') };
}

function enter(world, arr) {
  world.arrivals.splice(world.arrivals.indexOf(arr), 1);
  const p = arr.persona ?? fallbackPersona(arr);
  // It kindles down in the grass, somewhere on open ground, and lifts off.
  const at = wildSpot(world) ?? { x: rand(60, WORLD.width - 60), y: WORLD.floor - 20 };
  const f = {
    id: arr.id, kind: 'firefly', name: uniqueName(world, p.name), gen: arr.gen, ...newGlow(world),
    flash: FLASHES.includes(p.flash) ? p.flash : pick(FLASHES),
    predecessorId: arr.predecessorId, predecessorName: arr.predecessorName, lineage: arr.lineage,
    x: at.x, y: at.y - 4, vx: 0, vy: -8, facing: Math.random() < 0.5 ? -1 : 1, entering: true, leaving: false,
    needs: { nectar: 0.7, rest: 0.9, company: 0.45, wonder: 0.35 },
    emotion: 'curious', feeling: null, persona: p, article: arr.article,
    bornAt: world.time, lifespan: rand(...LIFESPAN), wallBorn: Date.now(),
    thought: 'Soil, and then no soil. Air. I have a light.', reasoning: '',
    plan: [{ type: 'fly_to', x: Math.round(clamp(at.x + rand(-80, 80), 40, WORLD.width - 40)), y: Math.round(rand(400, 500)) }], action: null,
    brain: 'kindling', seq: 0, awaiting: null, nextThinkAt: world.time + 6, rethinkAt: null, talk: null,
    memory: [], heard: [], notes: [], thoughts: [], witnessed: [], impressions: {}, seenMoon: false,
    lore: arr.lore.filter((l) => world.lore.has(l.id)).map((l) => ({ ...l, at: world.time, stance: 'holds' })),
    said: null, pollen: null, carrying: null, perched: false, farewelled: false, successor: null, composed: 0, sown: 0,
  };
  world.entities.push(f);
  remember(world, f, 'crawled up out of the soil, split my old skin, and found I had wings and a light');
  if (arr.predecessorName) remember(world, f, `kindled as ${arr.predecessorName} rose out of the garden, carrying what ${arr.predecessorName} held to be true`);
  for (const l of f.lore) remember(world, f, `carries from ${arr.predecessorName}: "${world.lore.get(l.id).text}"`);
  world.store.putFly(flyRecord(f));
  world.emit({ kind: 'arrive', id: f.id, name: f.name, glow: f.glow,
    text: `${f.name} kindled in the grass${arr.predecessorName ? `, carrying ${arr.predecessorName}'s myths` : ''} (generation ${f.gen}).` });
  return f;
}

// Keeps the garden at POPULATION: successors are prepared ahead of time and kindle as places open.
function stepArrivals(world) {
  for (const f of flies(world)) {
    if (!f.successor && !f.leaving && f.lifespan - ageOf(world, f) < PREPARE) queueArrival(world, f);
  }
  const present = flies(world).filter((f) => !f.leaving);
  if (present.length >= POPULATION) { world.slotOpenAt = null; return; }
  // Arrivals whose firefly is still here are its heirs, waiting their turn; the rest are free to come.
  const heir = (a) => present.some((f) => f.id === a.predecessorId);
  const free = world.arrivals.filter((a) => !heir(a));
  for (let i = present.length + free.length; i < POPULATION; i++) free.push(queueArrival(world, null));
  world.slotOpenAt ??= world.time;
  const waited = world.time - world.slotOpenAt;
  // A ready newcomer kindles; if none is ready in time, the first one waiting comes plain.
  // (With no mind connected there is nothing to wait for.)
  const next = free.find((a) => a.status === 'ready') ?? (waited > (world.mind ? ARRIVAL_TIMEOUT : 20) ? free[0] : null);
  if (next) { enter(world, next); world.slotOpenAt = null; }
}

// The height calls every firefly in the end: it rises out of the garden and doesn't come back.
function beginLeaving(world, f) {
  f.leaving = true;
  f.talk = null;
  f.plan = [];
  f.brain = 'rising';
  f.perched = false;
  f.carrying = null;
  f.action = { type: 'rise' };
  f.thought = f.thought || 'Up.';
  for (const o of flies(world)) if (o !== f && !o.leaving) remember(world, o, `watched ${f.name} rise out of the garden, higher and higher, until its light was one more among the stars`);
  world.emit({ kind: 'depart', id: f.id, name: f.name, glow: f.glow, text: `${f.name} rose out of the garden after ${minutes(ageOf(world, f))}.` });
  if (!f.successor) queueArrival(world, f);
}

function gone(world, f, cause) {
  world.entities.splice(world.entities.indexOf(f), 1);
  world.store.putFly(flyRecord(f, cause));
  pruneLore(world);
}

// What a firefly remembers of its long time under the soil: whole sentences, only trimmed (at a
// word, with an ellipsis) if the mind wrote something far longer than asked.
function glimmers(f) {
  return (f.persona?.memories ?? []).slice(0, 4).map((m) => {
    const t = String(m).replace(/\s+/g, ' ').trim();
    return t.length <= 500 ? t : `${t.slice(0, 500).replace(/\s+\S*$/, '')}…`;
  });
}

// Two living fireflies never share a name, so minds can tell them apart.
function uniqueName(world, name) {
  const taken = new Set(flies(world).map((f) => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (const suffix of [' the Second', ' the Third', ' the Fourth', ' the Younger']) if (!taken.has((name + suffix).toLowerCase())) return name + suffix;
  return `${name} ${world.nextId}`;
}

function fallbackPersona(arr) {
  const syl = ['li', 'mo', 'ae', 'thi', 'ru', 'ne', 'sol', 'ka', 'wy', 'el', 'ora', 'pim', 'zu', 'fen'];
  const name = Array.from({ length: 2 + Math.floor(Math.random() * 2) }, () => pick(syl)).join('');
  const subject = arr.article?.title ?? 'the dark under the roots';
  return {
    name: name[0].toUpperCase() + name.slice(1),
    personality: `Came up out of the soil with a head full of half-remembered ${subject}. Quiet, watchful, and stubborn about it.`,
    voice: 'Short, plain sentences.', voice_sample: 'Dark. Then a light. Then you.', desire: `To find out what ${subject} has to do with the moon.`,
    hunch: 'The moon is a light like mine, only further off, and it is signalling to someone.',
    memories: ['Down under the soil there was a long dark with roots in it, and something moving past that you still cannot name.'],
    images: ['the dark under the roots', 'a root tip feeling its way', 'the cold of deep soil'],
    temperament: 'gentle', flash: pick(FLASHES),
  };
}

function flyRecord(f, cause = null) {
  return {
    id: f.id, name: f.name, gen: f.gen, predecessorId: f.predecessorId ?? null, predecessorName: f.predecessorName, bornAt: f.wallBorn,
    diedAt: cause ? Date.now() : null, cause, persona: f.persona, article: f.article, glow: f.glow, flash: f.flash,
    composed: f.composed ?? 0, sown: f.sown ?? 0,
  };
}

// ---------- memory, speech and myths ----------

function remember(world, f, text) {
  const last = f.memory.at(-1);
  if (last?.text === text) { last.at = world.time; last.n = (last.n ?? 1) + 1; return; }
  f.memory.push({ at: world.time, text });
  if (f.memory.length > MEMORY) f.memory.shift();
}
const recall = (m) => (m.n > 1 ? `${m.text} (${m.n} times)` : m.text);

function hear(f, line) {
  f.heard.push(line);
  if (f.heard.length > HEARD) f.heard.shift();
}

const findFly = (world, name) => {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  const all = flies(world);
  return all.find((o) => o.name.toLowerCase() === n) ?? all.find((o) => o.name.toLowerCase().startsWith(n)) ?? null;
};

// Over-long turns are cut at the last sentence that fits.
function trimSpeech(text) {
  text = String(text).replace(/\s+/g, ' ').trim();
  if (text.length <= SPEECH_MAX) return text;
  const cut = text.slice(0, SPEECH_MAX);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}

// One firefly speaks at a time, and each line holds the floor about as long as it takes to read, so
// observers can follow along. A firefly has at most one line waiting: a newer one replaces it.
const readTime = (text) => clamp(2.5 + text.length / 16, 4, 20);

function queueSpeech(world, f, text, toName, loreId) {
  world.speech = world.speech.filter((s) => s.id !== f.id);
  world.speech.push({ id: f.id, text, toName, loreId, at: world.time });
}

function stepSpeech(world) {
  world.speech = world.speech.filter((s) => world.time - s.at < SPEECH_STALE && byId(world, s.id, 'firefly'));
  if (world.time < world.floorUntil || !world.speech.length) return;
  const s = world.speech.shift();
  const text = speak(world, byId(world, s.id, 'firefly'), s.text, s.toName, s.loreId);
  if (text) world.floorUntil = world.time + readTime(text);
}

// Says something out loud. Everyone in earshot hears it; whoever it's addressed to is prompted to
// answer, and the two turn to face each other. A myth travels with the words: all who hear learn it.
function speak(world, f, text, toName, loreId) {
  text = trimSpeech(text);
  if (!text) return null;
  const listeners = flies(world).filter((o) => o !== f && !o.leaving && dist(o, f) <= HEAR);
  const named = findFly(world, toName);
  const to = named !== f ? named : null;
  f.said = { text, to: to?.name ?? null, at: world.time };
  hear(f, { at: world.time, from: f.name, to: to?.name ?? null, text, mine: true });
  f.needs.company = Math.min(1, f.needs.company + 0.05);
  // Who this is said to: the one named, or else whoever last spoke to us, or else the nearest listener.
  const lastVoice = [...f.heard].reverse().find((h) => !h.mine && world.time - h.at < 25);
  const replyTo = lastVoice && listeners.find((o) => o.name === lastVoice.from);
  const nearest = listeners.slice().sort((a, b) => dist(f, a) - dist(f, b))[0];
  const partner = to ? (listeners.includes(to) ? to : null) : replyTo ?? nearest ?? null;
  if (partner && !f.leaving) {
    f.talk = { with: partner.id, until: world.time + TALK_SECS };
    partner.talk = { with: f.id, until: world.time + TALK_SECS };
  }
  for (const o of listeners) {
    hear(o, { at: world.time, from: f.name, to: to?.name ?? null, text });
    o.needs.company = Math.min(1, o.needs.company + (o === partner ? 0.08 : 0.03));
    if (o === partner) interrupt(world, o, 0.6);
  }
  if (to && !listeners.includes(to)) remember(world, f, `called out to ${to.name}, but they were too far away to hear`);
  world.emit({ kind: 'say', id: f.id, name: f.name, to: to?.name ?? null, text, glow: f.glow });
  if (loreId != null && world.lore.has(loreId)) teach(world, f, loreId, listeners);
  return text;
}

function teach(world, f, loreId, listeners) {
  const lore = world.lore.get(loreId);
  lore.told++;
  world.store.putLore(lore);
  const learned = [];
  for (const o of listeners) if (learn(world, o, loreId, f.name)) learned.push(o.name);
  if (!learned.length) return;
  f.needs.wonder = Math.min(1, f.needs.wonder + 0.06);
  remember(world, f, `told ${learned.join(' and ')} the myth: "${lore.text}"`);
  world.emit({ kind: 'tell', id: f.id, name: f.name, glow: f.glow, to: learned, text: lore.text, loreId });
}

// A firefly carries only CARRY myths; learning another pushes out one it disputes, or else the
// least regarded.
function learn(world, f, loreId, from) {
  if (f.lore.some((l) => l.id === loreId)) return false;
  f.lore.push({ id: loreId, from, at: world.time, stance: 'holds' });
  f.needs.wonder = Math.min(1, f.needs.wonder + 0.04);
  remember(world, f, `heard from ${from} the myth: "${world.lore.get(loreId).text}"`);
  if (f.lore.length > CARRY) {
    const rank = (l) => (l.stance === 'disputes' ? -1e6 : l.stance === 'embraces' ? 1e6 : 0) + standing(world.lore.get(l.id) ?? { told: 0 });
    const forget = f.lore.slice(0, -1).reduce((a, b) => (rank(b) < rank(a) ? b : a));
    f.lore.splice(f.lore.indexOf(forget), 1);
    remember(world, f, `let go of "${world.lore.get(forget.id)?.text}"`);
  }
  return true;
}

function compose(world, f, raw) {
  const text = String(raw.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 420);
  if (!text || world.time - (f.composedAt ?? -1e9) < COMPOSE_GAP) return null;
  f.composedAt = world.time;
  const parent = world.lore.get(Number(raw.refines_id));
  const lore = {
    id: world.nextLoreId++, text, theme: THEMES.includes(raw.theme) ? raw.theme : 'what the moon is',
    originId: f.id, originName: f.name, originGen: f.gen, glow: f.glow, moon: moonMark(skyAt(world.time)), sawMoon: f.seenMoon,
    refines: parent?.id ?? null, refinesText: parent?.text ?? null, refinesBy: parent?.originName ?? null,
    createdAt: Date.now(), told: 0, agreed: [f.name], disputed: [],
  };
  world.lore.set(lore.id, lore);
  world.store.putLore(lore);
  f.lore.push({ id: lore.id, from: 'yourself', at: world.time, stance: 'embraces' });
  if (f.lore.length > CARRY) f.lore.shift();
  f.composed = (f.composed ?? 0) + 1;
  f.needs.wonder = Math.min(1, f.needs.wonder + 0.1);
  remember(world, f, parent ? `reworked the myth "${parent.text}" into: "${text}"` : `set down a myth: "${text}"`);
  world.emit({ kind: 'lore', id: f.id, name: f.name, glow: f.glow, text, theme: lore.theme, loreId: lore.id, refinesText: lore.refinesText, refinesBy: lore.refinesBy });
  pruneLore(world);
  return lore.id;
}

function takeStance(world, f, { myth_id, agree }) {
  const k = f.lore.find((l) => l.id === Number(myth_id));
  const lore = k && world.lore.get(k.id);
  if (!lore || typeof agree !== 'boolean') return;
  const stance = agree ? 'embraces' : 'disputes';
  if (k.stance === stance) return;
  k.stance = stance;
  lore.agreed = lore.agreed.filter((n) => n !== f.name);
  lore.disputed = lore.disputed.filter((n) => n !== f.name);
  (agree ? lore.agreed : lore.disputed).push(f.name);
  if (lore.agreed.length > 30) lore.agreed.shift();
  if (lore.disputed.length > 30) lore.disputed.shift();
  world.store.putLore(lore);
  f.needs.wonder = Math.min(1, f.needs.wonder + 0.03); // making up your mind is worth something
  remember(world, f, `${agree ? 'embraced' : 'disputed'} the myth: "${lore.text}"`);
  world.emit({ kind: 'stance', id: f.id, name: f.name, glow: f.glow, agree, text: lore.text, loreId: lore.id });
}

// The book keeps myths long after anyone carries them, up to ARCHIVE; past that, the least regarded
// forgotten ones are let go.
function pruneLore(world) {
  if (world.lore.size <= ARCHIVE) return;
  const carried = new Set();
  for (const f of flies(world)) for (const l of f.lore) carried.add(l.id);
  for (const a of world.arrivals) for (const l of a.lore) carried.add(l.id);
  const drop = [...world.lore.values()].filter((l) => !carried.has(l.id))
    .sort((a, b) => standing(a) - standing(b) || a.createdAt - b.createdAt).slice(0, world.lore.size - ARCHIVE).map((l) => l.id);
  for (const i of drop) world.lore.delete(i);
  world.store.dropLore(drop);
}

// What observers read: the book (the best regarded and newest myths), and who carries what.
export function compendium(world, limit = 300) {
  const carriers = new Map();
  for (const f of flies(world)) for (const l of f.lore) {
    if (!carriers.has(l.id)) carriers.set(l.id, []);
    carriers.get(l.id).push({ name: f.name, stance: l.stance });
  }
  const all = [...world.lore.values()];
  const shown = all.sort((a, b) => (carriers.has(b.id) - carriers.has(a.id)) || standing(b) - standing(a) || b.createdAt - a.createdAt).slice(0, limit);
  return {
    total: world.lore.size,
    authors: new Set(all.map((l) => l.originName)).size,
    generations: all.reduce((g, l) => Math.max(g, l.originGen), 0),
    teachings: shown.map((l) => ({
      id: l.id, text: l.text, theme: l.theme, by: l.originName, gen: l.originGen, glow: l.glow, createdAt: l.createdAt, moon: l.moon, sawMoon: l.sawMoon,
      refines: l.refines, refinesText: l.refinesText, refinesBy: l.refinesBy,
      told: l.told, agreed: l.agreed?.length ?? 0, disputed: l.disputed?.length ?? 0, standing: standing(l),
      carriers: carriers.get(l.id) ?? [],
    })),
  };
}

// ---------- movement ----------

const maxSpeed = (f) => 64 * (0.55 + 0.45 * f.needs.rest) * (0.8 + 0.2 * f.needs.nectar);
const groundAt = () => WORLD.floor;

// Accelerates toward (tx, ty), slowing on arrival; true once within stopAt.
function steer(f, tx, ty, dt, speed, stopAt = 8) {
  f.steering = true;
  const dx = tx - f.x, dy = ty - f.y, d = Math.hypot(dx, dy);
  if (d < stopAt) { f.vx *= 0.9; f.vy *= 0.9; return true; }
  const want = Math.min(speed, d * 1.2 + 8);
  const k = Math.min(1, dt * 2.4);
  f.vx += ((dx / d) * want - f.vx) * k;
  f.vy += ((dy / d) * want - f.vy) * k;
  return false;
}

// Two fireflies in conversation hover a little apart, facing each other.
function converse(world, f, o, dt) {
  const side = Math.sign(f.x - o.x) || (f.id < o.id ? -1 : 1);
  const mx = (f.x + o.x) / 2, my = (f.y + o.y) / 2;
  steer(f, clamp(mx + side * 24, EDGE, WORLD.width - EDGE), clamp(my, WORLD.ceiling + 30, groundAt() - 30), dt, maxSpeed(f) * 0.7, 5);
}

function physics(world, f, dt, sky) {
  // Fireflies keep a little air between them, and more from those they aren't talking with.
  for (const o of flies(world)) {
    if (o === f) continue;
    const room = f.talking && f.talk.with === o.id ? 30 : 64;
    const d = dist(f, o);
    if (d > 0 && d < room) { const push = 70 * (1 - d / room) * dt; f.vx += ((f.x - o.x) / d) * push; f.vy += ((f.y - o.y) / d) * push; }
  }
  // The wind carries them a little, gusts more; a perched firefly holds on.
  if (!f.perched) f.vx += sky.wind * 9 * dt;
  f.x += f.vx * dt;
  f.y += f.vy * dt;
  if (!f.steering) { f.vx *= 1 - Math.min(1, dt * 1.5); f.vy *= 1 - Math.min(1, dt * 1.5); }
  if (f.entering && ageOf(world, f) > 4) f.entering = false;
  // Kept well in from the side walls: observers' windows trim a strip off each side of the garden.
  f.x = clamp(f.x, EDGE, WORLD.width - EDGE);
  if (!f.leaving) f.y = clamp(f.y, WORLD.ceiling, groundAt());
  const partner = f.talk && byId(world, f.talk.with, 'firefly');
  if (partner && f.talking) f.facing = Math.sign(partner.x - f.x) || f.facing;
  else if (Math.abs(f.vx) > 4) f.facing = Math.sign(f.vx);
}

// ---------- actions ----------

// How far a flower must be for a firefly to work at it.
const AT_FLOWER = 14;

const RUN = {
  fly_to(world, f, a, dt) {
    a.t = (a.t ?? 0) + dt;
    if (a.t > 40) throw new Error(`I couldn't get to (${a.x}, ${a.y})`);
    return steer(f, a.x, clamp(a.y, WORLD.ceiling, groundAt()), dt, maxSpeed(f), 12);
  },

  visit(world, f, a, dt) {
    const o = byId(world, a.firefly_id, 'firefly');
    if (!o || o.leaving) throw new Error(`there is no firefly #${a.firefly_id} here any more`);
    if (o === f) return true;
    a.t = (a.t ?? 0) + dt;
    if (a.t > 30) throw new Error(`I couldn't catch up with ${o.name}`);
    const d = dist(f, o);
    if (d < NEAR + 8) { f.vx *= 0.9; f.vy *= 0.9; return true; }
    const k = NEAR / d;
    return steer(f, o.x + (f.x - o.x) * k, o.y + (f.y - o.y) * k, dt, maxSpeed(f), 10);
  },

  follow(world, f, a, dt) {
    const o = byId(world, a.firefly_id, 'firefly');
    if (!o || o.leaving) throw new Error(`there is no firefly #${a.firefly_id} here any more`);
    a.left = (a.left ?? a.seconds) - dt;
    if (o !== f && dist(f, o) > 50) steer(f, o.x - o.facing * 36, o.y - 10, dt, maxSpeed(f) * 1.1, 6);
    if (a.left > 0) return false;
    remember(world, f, `followed ${o.name} for a while`);
    return true;
  },

  // Drink from an open flower. Its pollen rides along to the next flower, whose seeds it will mix into.
  sip(world, f, a, dt) {
    const p = byId(world, a.plant_id, 'plant');
    if (!p) throw new Error(`there is no plant #${a.plant_id}`);
    if (p.state !== 'mature' || !p.open) {
      if (a.got) return true;
      throw new Error(p.state === 'mature' ? `the ${p.name} (#${p.id}) is shut: it ${opensWords(p.genome)}` : `the ${p.name} (#${p.id}) is ${p.state === 'growing' ? 'not in flower yet' : 'past flowering'}`);
    }
    if (p.nectar <= 0) {
      if (a.got) return true;
      throw new Error(`the ${p.name} (#${p.id}) has no nectar left for now`);
    }
    a.t = (a.t ?? 0) + dt;
    if (a.t > 45) throw new Error(`I couldn't reach the ${p.name}`);
    const at = headPoint(p);
    if (!steer(f, at.x, at.y, dt, maxSpeed(f), AT_FLOWER)) return false;
    f.sipping = p.id;
    a.work = (a.work ?? 0) + dt;
    if (a.work < 1.6) return false;
    a.work = 0;
    p.nectar--;
    p.given++;
    a.got = (a.got ?? 0) + 1;
    f.needs.nectar = Math.min(1, f.needs.nectar + 0.24);
    if (f.pollen && f.pollen.id !== p.id && p.genome.form !== 'cap') p.pollen = { genome: f.pollen.genome, name: f.pollen.name };
    f.pollen = { id: p.id, genome: p.genome, name: p.name, hue: p.genome.hue2 };
    if (a.got >= a.sips || p.nectar <= 0 || f.needs.nectar >= 1) {
      remember(world, f, `drank ${a.got} sip${a.got > 1 ? 's' : ''} from the ${p.name} (#${p.id})`);
      return true;
    }
    return false;
  },

  // Settle on the nearest leaf, or in the grass, and let the light go low.
  rest(world, f, a, dt) {
    a.left = (a.left ?? a.seconds) - dt;
    if (!a.perch) {
      const near = plants(world).filter((p) => p.state === 'mature' || p.state === 'growing').map((p) => headPoint(p)).sort((p, q) => dist(f, p) - dist(f, q))[0];
      a.perch = near && dist(f, near) < 220 ? { x: near.x + 8, y: near.y + 10 } : { x: f.x, y: groundAt() - 6 };
    }
    f.perched = steer(f, a.perch.x, a.perch.y, dt, maxSpeed(f) * 0.7, 5);
    if (f.perched) f.needs.rest = Math.min(1, f.needs.rest + 0.03 * dt);
    if (a.left > 0) return false;
    f.perched = false;
    remember(world, f, `rested for ${a.seconds}s`);
    return true;
  },

  wander(world, f, a, dt) {
    a.left = (a.left ?? a.seconds) - dt;
    if (!a.to || dist(f, a.to) < 20) a.to = openAir(world, f);
    steer(f, a.to.x, a.to.y, dt, maxSpeed(f) * 0.55, 10);
    return a.left <= 0;
  },

  // Fly up into open air above the flowers and watch what the sky does.
  watch_sky(world, f, a, dt) {
    a.to ??= { x: clamp(f.x + rand(-60, 60), 80, WORLD.width - 80), y: rand(250, 340) };
    if (!a.from) {
      a.t = (a.t ?? 0) + dt;
      if (!steer(f, a.to.x, a.to.y, dt, maxSpeed(f), 14) && a.t < 30) return false;
      a.from = skyAt(world.time);
    }
    steer(f, a.to.x, a.to.y + Math.sin(world.time * 0.8 + f.id) * 6, dt, 14, 2);
    a.left = (a.left ?? a.seconds) - dt;
    if (a.left > 0) return false;
    watched(world, f, a.from, skyAt(world.time), a.seconds);
    return true;
  },

  // Go down to the pond and touch the water, where the moon (or whatever is in it) lies.
  touch_pond(world, f, a, dt) {
    a.t = (a.t ?? 0) + dt;
    if (a.t > 45) throw new Error('I couldn\'t reach the pond');
    const sky = skyAt(world.time);
    // The moon lies in the water on the side it stands in the sky.
    a.to ??= { x: POND.x + (sky.up ? clamp((sky.x - WORLD.width / 2) / 640, -1, 1) * POND.rx * 0.5 : rand(-60, 60)), y: POND.y - 4 };
    if (!steer(f, a.to.x, a.to.y, dt, maxSpeed(f), 8)) return false;
    a.work = (a.work ?? 0) + dt;
    if (a.work < 0.8) return false;
    omen(world, { kind: 'ripple', x: Math.round(a.to.x), y: Math.round(a.to.y + 4) });
    f.needs.wonder = Math.min(1, f.needs.wonder + 0.12);
    const moon = sky.up && sky.cover < 0.8;
    witness(world, f, moon
      ? `touched the moon that lies in the pond (${moonShape(sky)}, the same shape as the one overhead): it broke into rings of light at my touch, and after a few breaths it drew itself whole again; the one in the sky never trembled`
      : `touched the pond: rings ran out across it. There was no moon in the water, ${sky.up ? 'only a smear of cloud-light' : 'just as there is none in the sky'}`);
    f.watchedAt = world.time;
    world.emit({ kind: 'pond', id: f.id, name: f.name, glow: f.glow, text: `${f.name} touched ${moon ? 'the moon in the pond' : 'the pond'}.` });
    return true;
  },

  // Take a seed from a plant that is in seed, carry it to an empty plot of the spiral, and sow it.
  sow(world, f, a, dt) {
    a.t = (a.t ?? 0) + dt;
    if (a.t > 80) throw new Error('I lost my way between the seed and the spiral');
    if (world.spiral.floweringAt != null) throw new Error('the spiral is in its Flowering; it is to be watched now, not sown');
    const taken = plotPlant(world, a.plot);
    if (taken) throw new Error(`plot ${a.plot} already holds the ${taken.name} (#${taken.id}); uproot it first if it doesn't belong`);
    if (!f.carrying || f.carrying.from !== a.plant_id) {
      const p = byId(world, a.plant_id, 'plant');
      if (!p) throw new Error(`there is no plant #${a.plant_id} any more`);
      if (p.state !== 'seeding') throw new Error(`the ${p.name} (#${p.id}) is not in seed${p.state === 'mature' ? ' yet' : ''}`);
      if (!GROUND_FORMS.includes(p.genome.form)) throw new Error(`a ${p.genome.form === 'vine' ? 'vine wants the wall' : p.genome.form === 'lily' ? 'lily wants the water' : 'cap grows only where it likes'}; it won't grow in the spiral`);
      const at = headPoint(p);
      if (!steer(f, at.x, at.y, dt, maxSpeed(f), AT_FLOWER)) return false;
      a.work = (a.work ?? 0) + dt;
      if (a.work < 1.2) return false;
      a.work = 0;
      f.carrying = { from: p.id, ...seedOf(p), gen: p.gen, name: p.name, hue: p.genome.hue2 };
      return false;
    }
    const at = plotPos(a.plot);
    if (!steer(f, at.x, at.y - 8, dt, maxSpeed(f), 9)) return false;
    a.work = (a.work ?? 0) + dt;
    if (a.work < 1.4) return false;
    const s = f.carrying;
    f.carrying = null;
    const child = createPlant(world, at.x, at.y, s.genome, { gen: s.gen, parents: s.parents }, a.plot);
    world.entities.push(child);
    world.spiral.plots[a.plot] = child.id;
    world.spiral.tenders[f.name] = (world.spiral.tenders[f.name] ?? 0) + 1;
    f.sown = (f.sown ?? 0) + 1;
    f.needs.wonder = Math.min(1, f.needs.wonder + 0.14);
    remember(world, f, `sowed a seed of the ${s.name} in plot ${a.plot} of the spiral; it will be ${an(child.name)} that ${opensWords(child.genome)}`);
    for (const o of flies(world)) if (o !== f && dist(o, f) < HEAR) remember(world, o, `watched ${f.name} sow ${an(child.name)} in plot ${a.plot} of the spiral`);
    world.emit({ kind: 'sow', id: f.id, name: f.name, glow: f.glow, plot: a.plot, text: `${f.name} sowed ${an(child.name)} in plot ${a.plot} of the spiral.` });
    return true;
  },

  // Pull up what grows in a plot, to make room for something that belongs there.
  uproot(world, f, a, dt) {
    if (world.spiral.floweringAt != null) throw new Error('the spiral is in its Flowering; nothing is to be pulled up now');
    const p = plotPlant(world, a.plot);
    if (!p) throw new Error(`plot ${a.plot} is already empty`);
    a.t = (a.t ?? 0) + dt;
    if (a.t > 45) throw new Error(`I couldn't reach plot ${a.plot}`);
    if (!steer(f, p.x, p.y - 10, dt, maxSpeed(f), 9)) return false;
    a.work = (a.work ?? 0) + dt;
    if (a.work < 1.5) return false;
    world.spiral.plots[a.plot] = null;
    Object.assign(p, { plot: null, state: 'withering', open: false });
    remember(world, f, `pulled the ${p.name} out of plot ${a.plot} of the spiral`);
    for (const o of flies(world)) if (o !== f && dist(o, f) < HEAR) remember(world, o, `watched ${f.name} pull the ${p.name} out of plot ${a.plot} of the spiral`);
    world.emit({ kind: 'uproot', id: f.id, name: f.name, glow: f.glow, plot: a.plot, text: `${f.name} pulled the ${p.name} out of plot ${a.plot}.` });
    return true;
  },

  // Hover over a shut flower and glow on it until it opens, whatever the moon is doing; a sprout
  // grows faster for it.
  wake(world, f, a, dt) {
    const p = byId(world, a.plant_id, 'plant');
    if (!p) throw new Error(`there is no plant #${a.plant_id}`);
    if (p.state !== 'mature' && p.state !== 'growing') throw new Error(`the ${p.name} (#${p.id}) is past waking`);
    if (p.state === 'mature' && p.open && world.time > p.wokenUntil - 10) return true;
    a.t = (a.t ?? 0) + dt;
    if (a.t > 45) throw new Error(`I couldn't reach the ${p.name}`);
    const at = headPoint(p);
    if (!steer(f, at.x, at.y - 6, dt, maxSpeed(f), AT_FLOWER)) return false;
    f.waking = p.id;
    a.work = (a.work ?? 0) + dt;
    f.needs.rest = Math.max(0, f.needs.rest - 0.012 * dt);
    if (a.work < 3) return false;
    if (p.state === 'growing') p.growth = Math.min(1, p.growth + 0.25);
    else Object.assign(p, { wokenUntil: world.time + WAKE_SECS, open: true, flip: 0 });
    f.needs.wonder = Math.min(1, f.needs.wonder + 0.05);
    remember(world, f, p.state === 'growing' ? `glowed on the sprouting ${p.name} (#${p.id}) and it stretched toward my light`
      : `glowed on the ${p.name} (#${p.id}) until it opened to my light, as it would for the moon; it will stay open a little while`);
    return true;
  },

  // Not something a mind can choose: the end of a life. It climbs toward the moon if there is one.
  rise(world, f, a, dt) {
    const sky = skyAt(world.time);
    steer(f, sky.up ? f.x + (sky.x - f.x) * 0.4 : f.x + Math.sin(world.time * 0.6 + f.id) * 30, -80, dt, 46, 0);
    if (f.y < -30) { gone(world, f, 'rose out of the garden'); return true; }
    return false;
  },
};

// What a firefly brings back from watching the sky: exactly what the moon did in that time.
function watched(world, f, from, to, secs) {
  f.watchedAt = world.time;
  let text;
  if (to.up && to.cover < 0.8) {
    const moved = from.up ? `In that time it crept toward the west wall and ${to.alt > from.alt + 0.004 ? 'climbed' : to.alt < from.alt - 0.004 ? 'sank lower' : 'held its height'}; it did not change shape as I watched.` : 'It rose over the east wall while I watched.';
    text = `watched the moon for ${secs}s: ${moonShape(to)}, ${moonPlace(to)}. ${moved}` +
      (to.eclipse > 0.3 ? ' A rust-red shadow lies across it.' : '') + (to.halo && to.eclipse < 0.3 ? ' A wide pale ring stands around it.' : '') +
      (to.cover > 0.35 ? ' Thin cloud is passing in front of it; the cloud moves, the moon stays.' : '') +
      (to.lit > 0.05 && to.lit < 0.9 ? ` Its bright side faces the ${to.waxing ? 'west wall, where the pale went down' : 'east wall, where the pale comes up'}.` : '');
    f.needs.wonder = Math.min(1, f.needs.wonder + 0.22);
  } else if (to.up) {
    text = `watched the sky for ${secs}s: the moon is somewhere behind the cloud, a smear of light ${moonPlace(to)}`;
    f.needs.wonder = Math.min(1, f.needs.wonder + 0.1);
  } else {
    text = `watched the sky for ${secs}s: no moon anywhere${from.up ? ' (it sank behind the west wall as I watched)' : ''}. ` +
      (to.pale > 0.2 ? 'The pale is washing everything out.' : to.cloudiness > 0.75 ? 'Only cloud.' : 'Only the small cold stars, which keep their places and their shapes.');
    f.needs.wonder = Math.min(1, f.needs.wonder + 0.1);
  }
  witness(world, f, text);
}

// Somewhere a few hundred pixels off with the most room around it, down among the flowers:
// wandering spreads fireflies out.
function openAir(world, f) {
  let best = null, bestRoom = -1;
  for (let i = 0; i < 6; i++) {
    const p = { x: clamp(f.x + rand(-340, 340), EDGE + 20, WORLD.width - EDGE - 20), y: rand(WORLD.wallTop + 30, groundAt() - 30) };
    const room = Math.min(...flies(world).filter((o) => o !== f).map((o) => dist(o, p)), 1e9);
    if (room > bestRoom) { best = p; bestRoom = room; }
  }
  return best;
}

// Plans come from outside the sim, so every action is checked and clamped here.
function normalizeAction(raw) {
  if (!raw || !ACTIONS.includes(raw.type)) return null;
  const num = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : dflt);
  switch (raw.type) {
    case 'fly_to': return { type: 'fly_to', x: num(raw.x, 20, WORLD.width - 20, null), y: num(raw.y, WORLD.ceiling, WORLD.floor, null) };
    case 'visit': return { type: 'visit', firefly_id: num(raw.firefly_id, 0, 1e9, null) };
    case 'follow': return { type: 'follow', firefly_id: num(raw.firefly_id, 0, 1e9, null), seconds: num(raw.seconds, 3, 40, 12) };
    case 'sip': return { type: 'sip', plant_id: num(raw.plant_id, 0, 1e9, null), sips: num(raw.sips, 1, 4, 2) };
    case 'rest': return { type: 'rest', seconds: num(raw.seconds, 3, 60, 15) };
    case 'wander': return { type: 'wander', seconds: num(raw.seconds, 3, 40, 12) };
    case 'watch_sky': return { type: 'watch_sky', seconds: num(raw.seconds, 5, 30, 15) };
    case 'touch_pond': return { type: 'touch_pond' };
    case 'sow': return { type: 'sow', plant_id: num(raw.plant_id, 0, 1e9, null), plot: num(raw.plot, 0, SPIRAL.plots - 1, null) };
    case 'uproot': return { type: 'uproot', plot: num(raw.plot, 0, SPIRAL.plots - 1, null) };
    case 'wake': return { type: 'wake', plant_id: num(raw.plant_id, 0, 1e9, null) };
  }
}

function describeAction(world, a) {
  if (!a) return null;
  const fly = (i) => byId(world, i, 'firefly')?.name ?? `#${i}`;
  const plant = (i) => byId(world, i, 'plant')?.name ?? `plant #${i}`;
  switch (a.type) {
    case 'fly_to': return `flying to (${a.x}, ${a.y})`;
    case 'visit': return `flying over to ${fly(a.firefly_id)}`;
    case 'follow': return `following ${fly(a.firefly_id)}`;
    case 'sip': return `drinking from the ${plant(a.plant_id)}`;
    case 'rest': return 'resting';
    case 'wander': return 'wandering';
    case 'watch_sky': return a.from ? 'watching the sky' : 'flying up to watch the sky';
    case 'touch_pond': return 'going down to touch the pond';
    case 'sow': return `carrying a seed of the ${plant(a.plant_id)} to plot ${a.plot} of the spiral`;
    case 'uproot': return `clearing plot ${a.plot} of the spiral`;
    case 'wake': return `glowing on the ${plant(a.plant_id)} to wake it`;
    case 'rise': return 'rising out of the garden';
  }
}

const doingOf = (world, f) =>
  f.leaving ? 'rising out of the garden' : f.talking ? `talking with ${byId(world, f.talk.with, 'firefly')?.name}` : describeAction(world, f.action);

// ---------- minds ----------

const stage = (world, f) => {
  const left = f.lifespan - ageOf(world, f);
  if (left < FAREWELL + 5) return 'the height is calling you: you will rise out of the garden in moments';
  const k = ageOf(world, f) / f.lifespan;
  return k < 0.2 ? 'newly kindled' : k < 0.7 ? 'in your prime' : 'growing old';
};

const plantState = (p) =>
  p.state === 'growing' ? 'sprouting, not in flower yet' : p.state === 'seeding' ? 'in seed: a seed can be taken from it to sow'
  : p.state === 'mature' ? (p.open ? (p.genome.form === 'cap' ? 'glowing' : p.nectar ? `open, ${p.nectar} sip${p.nectar > 1 ? 's' : ''} of nectar` : 'open, drunk dry for now') : 'shut') : 'withering';

// What a firefly can perceive, sent to the mind with each decision request.
function perceive(world, f) {
  const sky = skyAt(world.time);
  const others = flies(world).filter((o) => o !== f);
  const ago = (t) => `${Math.round(world.time - t)}s ago`;
  const alive = plants(world).filter((p) => p.plot == null && ['growing', 'mature', 'seeding'].includes(p.state));
  const near = alive.map((p) => ({ p, d: dist(f, headPoint(p)) })).sort((a, b) => a.d - b.d);
  // The nearest flowers to drink from, and the nearest plants in seed (the spiral needs those).
  const shown = [...new Set([...near.filter(({ p }) => p.state === 'mature' && p.open && p.nectar > 0).slice(0, 4),
    ...near.filter(({ p }) => p.state === 'seeding' && GROUND_FORMS.includes(p.genome.form)).slice(0, 5), ...near.slice(0, 3)])].sort((a, b) => a.d - b.d);
  const remembered = Object.entries(f.impressions).filter(([i]) => !byId(world, Number(i), 'firefly')).slice(-4).map(([, v]) => v);
  const partner = f.talking && byId(world, f.talk.with, 'firefly');
  const here = new Set(others.map((o) => o.name));
  // The last thing said to this firefly since it last spoke, if the one who said it is still here.
  const lastMine = f.heard.findLastIndex((h) => h.mine);
  const unanswered = f.heard.slice(lastMine + 1).findLast((h) => h.to === f.name && here.has(h.from));
  return {
    you: {
      id: f.id, name: f.name, voice: f.persona.voice, voice_sample: f.persona.voice_sample,
      generation: f.gen, personality: f.persona.personality, desire: f.persona.desire, your_hunch_about_the_moon: f.persona.hunch,
      ...(f.persona.images?.length ? { images: f.persona.images } : {}),
      ...(glimmers(f).length ? { memories_from_under_the_soil: glimmers(f) } : {}),
      ...(f.composedAt != null ? { last_set_down_a_myth: `${Math.round(world.time - f.composedAt)}s ago${world.time - f.composedAt < COMPOSE_GAP ? ' (too soon for another; talk it over first)' : ''}` } : {}),
      time_in_garden: minutes(ageOf(world, f)), life_stage: stage(world, f), x: Math.round(f.x), y: Math.round(f.y),
      needs: Object.fromEntries(Object.entries(f.needs).map(([k, v]) => [k, r2(v)])), feeling: f.emotion,
      ...(partner ? { talking_with: partner.name } : {}),
      ...(f.carrying ? { carrying_a_seed_of: f.carrying.name } : {}),
      ...(f.pollen ? { dusted_with_pollen_of: f.pollen.name } : {}),
      ...(world.time - (f.watchedAt ?? -1e9) < 60 ? { just_watched: 'what you saw is the newest thing in sky.you_have_witnessed. Sit with it: does it fit the myths you carry?' } : {}),
      ...(world.speech.some((s) => s.id === f.id) ? { waiting_to_say: world.speech.find((s) => s.id === f.id).text } : {}),
    },
    ...(f.predecessorName ? { lineage: `you kindled as ${f.predecessorName} rose; before them: ${(f.lineage ?? []).slice(1).join(', ') || 'no one remembered'}` } : {}),
    sky: {
      now: skyNow(sky), moonlight_in_the_garden: lightWord(sky.light),
      weather: sky.rain > 0.3 ? 'raining' : sky.cloudiness > 0.75 ? 'overcast' : sky.cloudiness > 0.4 ? 'clouds drifting west' : 'clear',
      ...(Math.abs(sky.wind) > 0.75 ? { wind: `a gust is blowing toward the ${sky.wind > 0 ? 'west' : 'east'} wall` } : {}),
      you_have_witnessed: f.witnessed?.length ? f.witnessed.map((w) => `${ago(w.at)}: ${w.text}`) : ['nothing yet'],
      ...(!f.seenMoon ? { note: 'you have never seen the moon with your own eyes; all you know of it is what others say and the myths you carry' } : {}),
    },
    fireflies: others.map((o) => ({
      id: o.id, name: o.name, x: Math.round(o.x), y: Math.round(o.y), distance: Math.round(dist(f, o)),
      can_hear_you: dist(f, o) <= HEAR && !o.leaving, generation: o.gen, feeling: o.emotion, doing: doingOf(world, o) ?? 'hovering',
      ...(ageOf(world, o) / o.lifespan > 0.7 ? { looks: 'old, its light gone amber at the edges' } : ageOf(world, o) < 45 ? { looks: 'newly kindled' } : {}),
      ...(f.impressions[o.id] ? { your_impression: f.impressions[o.id] } : {}),
    })),
    plants: shown.map(({ p, d }) => ({
      id: p.id, what: p.name, x: p.x, y: Math.round(headPoint(p).y), distance: Math.round(d), state: plantState(p),
      ...(p.genome.form !== 'cap' ? { flowers: `${hueWord(p.genome.hue2)}; ${opensWords(p.genome)}` } : {}),
    })),
    spiral: describeSpiral(world),
    pond: { x: POND.x, y: POND.y, holds: sky.rain > 0.3 ? 'rain rings' : sky.up && sky.cover < 0.8 ? 'a second moon, trembling a little' : 'no moon; stars, when the sky is clear' },
    conversation: f.heard.slice(-CONVERSATION).map((h) =>
      `${ago(h.at)}, ${h.mine ? 'you' : h.from}${!h.mine && !here.has(h.from) ? ' (since risen)' : ''} said${h.to ? ` to ${h.to === f.name ? 'you' : h.to}` : ''}: "${h.text}"`),
    ...(unanswered ? { said_to_you_and_not_yet_answered: `${unanswered.from}, ${ago(unanswered.at)}: "${unanswered.text}"` } : {}),
    ...(f.notes?.length ? { notes_to_self: f.notes.map((n) => `${ago(n.at)}: ${n.text}`) } : {}),
    memory: f.memory.slice(-8).map((m) => `${ago(m.at)}: ${recall(m)}`),
    myths_you_carry: f.lore.map((k) => ({ k, l: world.lore.get(k.id) })).filter(({ l }) => l).map(({ k, l }) => ({
      id: l.id, text: l.text, about: l.theme,
      origin: l.originId === f.id ? 'yours' : `${l.originName} (generation ${l.originGen}), set down under ${l.moon?.words ?? 'an unknown sky'}`,
      ...(l.refinesText ? { reworks: `${l.refinesBy}'s "${l.refinesText.length > 90 ? l.refinesText.slice(0, 90) + '…' : l.refinesText}"` } : {}),
      heard_from: k.from, your_stance: k.stance,
      ...((l.agreed?.length ?? 0) > 1 ? { embraced_by_others: true } : {}), ...((l.disputed?.length ?? 0) > 0 ? { disputed_by_some: true } : {}),
    })),
    ...(remembered.length ? { fireflies_you_remember: remembered } : {}),
    recent_thoughts: f.thoughts?.length ? f.thoughts.map((t) => `${ago(t.at)}: ${t.text}`) : [f.thought],
  };
}

// Applies a decision from the mind. Returns false if it was stale or unusable.
export function applyPlan(world, msg) {
  const f = byId(world, msg.id, 'firefly');
  if (!f || msg.seq !== f.seq || f.awaiting == null) return false;
  f.awaiting = null;
  const actions = (Array.isArray(msg.actions) ? msg.actions : []).slice(0, PLAN_MAX).map(normalizeAction)
    .filter((a) => a && Object.values(a).every((v) => v != null));
  if (typeof msg.thought === 'string' && msg.thought.trim()) {
    f.thought = msg.thought.trim().slice(0, 300);
    (f.thoughts ??= []).push({ at: world.time, text: f.thought });
    if (f.thoughts.length > THOUGHTS) f.thoughts.shift();
  }
  if (typeof msg.remember === 'string' && msg.remember.trim()) {
    (f.notes ??= []).push({ at: world.time, text: msg.remember.trim().slice(0, 200) });
    if (f.notes.length > NOTES) f.notes.shift();
  }
  f.feeling = FEELINGS.includes(msg.feeling) ? msg.feeling : null;
  const about = msg.impression && byId(world, msg.impression.firefly_id, 'firefly');
  if (about && about !== f && typeof msg.impression.text === 'string') f.impressions[about.id] = `${about.name}: ${msg.impression.text.trim().slice(0, 160)}`;
  if (msg.stance) takeStance(world, f, msg.stance);
  let loreId = f.lore.some((l) => l.id === msg.share_myth_id) ? msg.share_myth_id : null;
  if (msg.new_myth?.text) loreId = compose(world, f, msg.new_myth) ?? loreId;
  if (typeof msg.say?.text === 'string' && msg.say.text.trim()) queueSpeech(world, f, msg.say.text, msg.say.to, loreId);
  if (f.rethink) { f.rethink = false; f.rethinkAt = world.time + 5; }
  if (f.leaving) return true; // last words only; the height decides where it goes
  f.action = null;
  f.perched = false;
  if (!actions.length) {
    if (msg.say?.text) { f.plan = [{ type: 'wander', seconds: 6 }]; f.brain = 'mind'; return true; }
    remember(world, f, 'my mind went blank');
    return instinct(world, f), false;
  }
  f.plan = actions;
  f.brain = 'mind';
  return true;
}

// Reasoning streamed in while the mind works on a decision; observers see it live.
export function hearThinking(world, msg) {
  const f = byId(world, msg.id, 'firefly');
  if (!f || msg.seq !== f.seq || f.awaiting == null || typeof msg.text !== 'string') return;
  f.reasoning = (f.reasoning + msg.text).slice(-REASONING_KEEP);
}

// Forget pending requests (the mind disconnected); those fireflies fall back to instinct.
export function mindLost(world) {
  for (const f of flies(world)) if (f.awaiting != null) { f.awaiting = null; f.nextThinkAt = world.time; }
}

// Something demands a fresh decision: drop the plan and think again shortly.
function interrupt(world, f, delay) {
  if (f.leaving) return;
  if (f.awaiting != null) { f.rethink = true; return; }
  f.plan = [];
  f.action = null;
  f.perched = false;
  f.nextThinkAt = world.time + delay + Math.random() * 0.6;
}

// Fallback behavior: rest when tired, drink when thirsty, seek company when lonely; otherwise tend
// the spiral, watch the sky, or drift. A garden with no mind still gets sown and flowers.
function instinct(world, f) {
  f.brain = 'instinct';
  const n = f.needs;
  const near = (list) => list.sort((a, b) => dist(f, a) - dist(f, b))[0];
  if (n.rest < 0.2) { f.plan = [{ type: 'rest', seconds: 20 }]; f.thought = 'So tired.'; return; }
  if (n.nectar < 0.5) {
    const p = near(plants(world).filter((p) => p.state === 'mature' && p.open && p.nectar > 0));
    if (p) { f.plan = [{ type: 'sip', plant_id: p.id, sips: 2 }]; f.thought = 'Sweetness.'; return; }
  }
  const other = near(flies(world).filter((o) => o !== f && !o.leaving));
  if (n.company < 0.3 && other) {
    f.plan = [{ type: 'visit', firefly_id: other.id }, { type: 'follow', firefly_id: other.id, seconds: 10 }];
    f.thought = 'Another light.';
    return;
  }
  const roll = Math.random();
  const empty = world.spiral.plots.map((v, i) => (v == null ? i : -1)).filter((i) => i >= 0);
  const seeder = near(plants(world).filter((p) => p.state === 'seeding' && GROUND_FORMS.includes(p.genome.form)));
  if (roll < 0.4 && empty.length && seeder && world.spiral.floweringAt == null) {
    f.plan = [{ type: 'sow', plant_id: seeder.id, plot: empty[0] }];
    f.thought = 'A seed for the spiral.';
    return;
  }
  const shut = near(world.spiral.plots.map((_, i) => plotPlant(world, i)).filter((p) => p && p.state === 'mature' && !p.open));
  if (roll < 0.55 && shut && !empty.length) { f.plan = [{ type: 'wake', plant_id: shut.id }]; f.thought = 'Open.'; return; }
  if (roll < 0.7) { f.plan = [{ type: 'watch_sky', seconds: 14 }]; f.thought = 'Up there.'; return; }
  f.plan = [{ type: 'wander', seconds: 12 }];
  f.thought = 'Drifting.';
}

function think(world, f) {
  if (world.mind) {
    f.seq++;
    f.awaiting = world.time;
    f.brain = 'thinking';
    f.reasoning = '';
    world.mind.send({ t: 'decide', id: f.id, seq: f.seq, perception: perceive(world, f) });
  } else instinct(world, f);
}

// ---------- fireflies ----------

function stepFly(world, f, dt, sky) {
  const age = ageOf(world, f);
  if (!f.leaving && age >= f.lifespan) beginLeaving(world, f);
  if (!f.leaving && !f.farewelled && age >= f.lifespan - FAREWELL) {
    f.farewelled = true;
    remember(world, f, 'I feel the height calling me. Soon I will rise out of the garden, as every firefly does');
    interrupt(world, f, 0.5);
  }
  if (f.awaiting != null && world.time - f.awaiting > MIND_TIMEOUT) {
    f.awaiting = null;
    if (!f.leaving) {
      remember(world, f, 'my mind wandered and I acted on instinct');
      instinct(world, f);
    }
  }
  if (f.rethinkAt != null && world.time >= f.rethinkAt && f.awaiting == null) { f.rethinkAt = null; interrupt(world, f, 0); }
  if (!f.leaving) {
    if (!f.action && f.plan.length) f.action = f.plan.shift();
    if (!f.action && f.awaiting == null && world.time >= f.nextThinkAt) think(world, f);
  }

  // While two fireflies talk they face each other; only work already in hand at a flower carries on.
  const partner = f.talk && world.time < f.talk.until && byId(world, f.talk.with, 'firefly');
  if (f.talk && (!partner || partner.leaving)) f.talk = null;
  f.talking = Boolean(partner && !partner.leaving && !f.leaving && !['sip', 'wake', 'sow', 'uproot', 'touch_pond'].includes(f.action?.type));
  f.steering = false;
  f.sipping = null;
  f.waking = null;
  if (f.talking) { f.perched = false; converse(world, f, partner, dt); }
  else if (f.action) {
    try {
      if (RUN[f.action.type](world, f, f.action, dt)) f.action = null;
    } catch (err) {
      remember(world, f, `gave up ${describeAction(world, f.action)}: ${err.message}`);
      f.action = null;
      f.plan = [];          // the rest of the plan assumed this step would work
      f.perched = false;
      f.failedAt = world.time;
    }
    if (!world.entities.includes(f)) return; // rose out of the garden
    if (!f.action && !f.plan.length) f.nextThinkAt = world.time + (f.failedAt === world.time ? FAIL_GAP : THINK_GAP);
  }

  physics(world, f, dt, sky);

  const n = f.needs;
  const speed = Math.hypot(f.vx, f.vy) / 64;
  n.nectar = Math.max(0, n.nectar - dt * (1 / 420) * (0.8 + 0.6 * speed));
  n.rest = Math.max(0, n.rest - dt * (1 / 700) * (0.6 + speed));
  // Loneliness creeps in over about ten minutes alone; company only slows it, and it takes a good
  // while of face-to-face talk to fill up. Wonder fades over about twelve minutes unless the firefly
  // does something with it.
  n.company = Math.max(0, n.company - dt / 600);
  if (f.talking) n.company = Math.min(1, n.company + dt / 300);
  else if (flies(world).some((o) => o !== f && !o.leaving && dist(o, f) < COMPANY)) n.company = Math.min(1, n.company + dt / 900);
  n.wonder = Math.max(0, n.wonder - dt / 720);

  f.emotion =
    f.action?.type === 'rest' || n.rest < 0.12 ? 'sleepy'
    : n.nectar < 0.12 ? 'thirsty'
    : f.feeling ?? (n.company < 0.25 ? 'lonely' : n.wonder > 0.6 ? 'awed' : 'curious');
}

export function step(world, dt) {
  world.tick++;
  world.time += dt;
  const sky = skyAt(world.time);
  stepPlants(world, dt, sky);
  stepSeeds(world, dt, sky);
  stepSpiral(world, sky);
  stepSky(world, sky);
  stepArrivals(world);
  stepSpeech(world);
  for (const f of flies(world)) if (world.entities.includes(f)) stepFly(world, f, dt, sky);
}

// ---------- snapshots and persistence ----------

// What observers see of an entity. server/delta.js only sends what changed, so ages are whole seconds.
function view(world, e) {
  switch (e.kind) {
    case 'firefly':
      return {
        id: e.id, kind: e.kind, name: e.name, x: e.x, y: e.y, vx: e.vx, vy: e.vy, facing: e.facing,
        needs: e.needs, emotion: e.emotion, brain: e.brain, glow: e.glow, flash: e.flash,
        doing: doingOf(world, e), said: e.said, gen: e.gen, age: Math.floor(ageOf(world, e)), lifespan: e.lifespan, leaving: e.leaving, thought: e.thought,
        perched: e.perched, waking: e.waking ?? null, sipping: e.sipping ?? null, carrying: e.carrying ? e.carrying.hue : null, pollen: e.pollen ? e.pollen.hue : null,
        persona: { personality: e.persona.personality, desire: e.persona.desire, hunch: e.persona.hunch, temperament: e.persona.temperament },
        origins: glimmers(e), article: e.article && { title: e.article.title, url: e.article.url, by: e.article.by },
        predecessorName: e.predecessorName, seenMoon: e.seenMoon, sown: e.sown ?? 0,
        plan: e.plan.map((a) => describeAction(world, a)), reasoning: e.reasoning.slice(-500),
        memory: e.memory.slice(-6).map((m) => ({ at: m.at, text: recall(m) })),
        witnessed: (e.witnessed ?? []).slice(-4), notes: e.notes ?? [],
        myths: e.lore.map((k) => ({ k, l: world.lore.get(k.id) })).filter(({ l }) => l).map(({ k, l }) => ({ id: l.id, text: l.text, stance: k.stance, mine: k.from === 'yourself' })),
      };
    case 'plant':
      return {
        id: e.id, kind: e.kind, x: e.x, y: e.y, scale: e.scale, growth: e.growth, state: e.state, open: e.open, nectar: e.nectar, seedsLeft: e.seedsLeft,
        wither: e.wither, fade: e.fade, plot: e.plot, woken: world.time < e.wokenUntil,
        name: e.name, genome: e.genome, gen: e.gen, parents: e.parents ?? [], given: e.given, age: Math.floor(e.age), hybrid: Boolean(e.pollen),
      };
    case 'seed':
      return { id: e.id, kind: e.kind, x: e.x, y: e.y, hue: e.hue };
  }
}

export function snapshot(world) {
  const sp = world.spiral;
  return {
    t: 'snap', time: world.time, entities: world.entities.map((e) => view(world, e)),
    top: {
      spiral: { number: sp.number, plots: sp.plots, floweringAt: sp.floweringAt, tenders: sp.tenders, past: world.spirals.length, note: spiralNote(world),
        last: world.spirals.at(-1) ?? null },
      omens: world.omens,
    },
  };
}

// Everything needed to pick the world back up after a restart (myths live in the store).
export function serialize(world) {
  return JSON.stringify({
    version: 1, time: world.time, nextId: world.nextId, nextLoreId: world.nextLoreId, arrivals: world.arrivals, entities: world.entities,
    spiral: world.spiral, spirals: world.spirals, lastDrift: world.lastDrift, nextStar: world.nextStar,
  });
}

export function restore(store, json, lore) {
  const data = JSON.parse(json);
  if (data.version !== 1) return null; // an older kind of garden
  const world = createWorld(store, { empty: true });
  Object.assign(world, {
    time: data.time, nextId: data.nextId, nextLoreId: data.nextLoreId, arrivals: data.arrivals, entities: data.entities,
    spiral: data.spiral, spirals: data.spirals ?? [], lastDrift: data.lastDrift ?? data.time, nextStar: data.nextStar ?? data.time + 60,
  });
  for (const l of lore) world.lore.set(l.id, l);
  for (const l of lore) world.nextLoreId = Math.max(world.nextLoreId, l.id + 1);
  for (const a of world.arrivals) if (a.status !== 'ready') a.status = 'new';
  for (const f of flies(world)) {
    Object.assign(f, { awaiting: null, rethink: false, rethinkAt: null, brain: 'waking', plan: [], action: f.leaving ? f.action : null, perched: false, carrying: null,
      nextThinkAt: world.time + 2 + Math.random() * 3 });
  }
  world.seen = watchSky(world);
  return world;
}
