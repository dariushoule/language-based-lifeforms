// Authoritative aquarium simulation. Runs headless; clients only render snapshots.
// Units are screen pixels of a 1280x720 tank; y grows downward (matches Phaser).
//
// Fish (the LBLs) live a few minutes each. They act through a short queue of high-level actions
// (swim, eat, approach, attack, ...) that the sim executes tick by tick, and they talk. A mind
// (server/index.js relays to the mind service over /mind) decides what to do and say; without
// one, a simple instinct does. When its time comes a fish swims out past the edge of the tank and
// a newcomer swims in, carrying some of what it taught.
//
// What outlives them is the compendium: teachings fish compose, rework, embrace, dispute and
// pass on, kept with their whole lineage of ideas. What gives their days meaning is the mandala:
// fish carry colored sand up from the floor and lay it, grain by grain, into a mirrored mandala on
// the back wall. When it is finished it is admired for a while, then swept away and begun again.

import { WORLD, sandAt, SANDS, depositX, MANDALA, slotsIn, mandalaCells, cellCenter } from '../shared/world.js';
import { randomGenome, mutate, cross, speciesName, FEED_AT } from '../shared/plants.js';

const POPULATION = 5;
const LIFESPAN = [180, 600];  // s a fish lives before the edge calls it
const FAREWELL = 40;          // s before leaving that a fish feels the edge calling
const PREPARE = 150;          // s before leaving that its successor starts being prepared (a persona and art take 1-2 minutes)
const ARRIVAL_TIMEOUT = 150;  // s an empty place waits for a prepared newcomer before taking a plain one
const HEAR = 260;             // px a voice carries
const NEAR = 70;              // px to stop at when approaching another fish
const COMPANY = 160;          // px within which another fish is company
const TALK_SECS = 14;         // s two fish stay face to face after one speaks to the other
const MAX_PLANTS = 18;
const MIN_PLANTS = 10;
const START_PLANTS = 14;
const DRIFT_SPORE = 1200;     // s between spores of something entirely new drifting in, room permitting
const CARRY = 8;              // teachings one fish can carry in mind at once
const COMPOSE_GAP = 75;        // s between new teachings from one fish, so ideas get time to be talked over
const INHERIT = 4;            // teachings a newcomer arrives with, from the fish it follows
const ARCHIVE = 2000;         // teachings the compendium keeps in all (the least regarded forgotten ones go first)
const MEMORY = 40;            // remembered events per fish
const HEARD = 16;             // remembered lines of conversation per fish
const MIND_TIMEOUT = 150;     // s before a silent mind is ignored and instinct takes over
const THINK_GAP = 1.5;        // s between finishing a plan and asking for the next
const FAIL_GAP = 4;           // s to pause after an action fails
const PLAN_MAX = 4;           // actions per plan
const REASONING_KEEP = 4000;  // chars of streamed reasoning kept per fish
const SPEECH_MAX = 450;       // chars per spoken turn (under a paragraph)
const SPEECH_STALE = 45;      // s a line can wait for the floor before it's no longer worth saying
const BITE_GAP = 1.2;         // s between bites
const URCHINS = [[0.25, 28], [0.5, 190], [0.85, 275]]; // where the glowing urchins first rest (fraction of the width), and their hue
const URCHIN_FALL = 17;       // px/s an urchin sinks once it's let go
const WATCH = 420;            // px within which a fish sees an urchin settle
const INSIGHT = 60;           // s a fish who let an urchin fall keeps the moment in mind
const MANDALAS_KEPT = 40;     // finished mandalas remembered (by their cells) after they're swept away

const ACTIONS = ['swim_to', 'eat', 'approach', 'follow', 'attack', 'flee', 'rest', 'wander', 'make_mandala', 'drop_urchin'];
const SAND_NAMES = SANDS.map((c) => c.name);
const FEELINGS = ['curious', 'happy', 'content', 'playful', 'lonely', 'uneasy', 'afraid', 'angry', 'sleepy', 'hungry', 'grieving', 'awed'];
// The compendium's chapters.
const THEMES = ['the light', 'the dark', 'the edge', 'passing on', 'hunger', 'kinship', 'strife', 'memory', 'the surface', 'stillness', 'change', 'the self'];

// ---------- creation ----------

export function createWorld(store = nullStore(), { empty = false } = {}) {
  const world = {
    tick: 0, time: 0, nextId: 1, entities: [], lore: new Map(), nextLoreId: 1, arrivals: [],
    slotOpenAt: null, lastSpore: 0, mind: null, store, emit: () => {},
    speech: [], floorUntil: 0, // lines waiting to be said, and when the current one has been read
    mandala: newMandala(1), mandalas: [],
  };
  if (empty) return world;
  for (let i = 0; i < START_PLANTS; i++) {
    const x = freeSpot(world, 40 + Math.random() * (WORLD.width - 80));
    if (x == null) continue;
    const p = createPlant(world, x, randomGenome(), null);
    // Start the tank at all ages so it doesn't wither in lockstep.
    p.age = Math.random() * (p.genome.growTime + p.genome.lifespan * 0.7);
    p.growth = Math.min(1, p.age / p.genome.growTime);
    p.state = p.growth >= 1 ? 'mature' : 'growing';
    p.food = p.state === 'mature' ? Math.ceil(p.genome.food * Math.random()) : 0;
    world.entities.push(p);
  }
  for (let i = 0; i < POPULATION; i++) queueArrival(world, null);
  addUrchins(world);
  return world;
}

// The glowing sea urchins resting on the sand (a tank always has them; older saved tanks get them too).
function addUrchins(world) {
  if (world.entities.some((e) => e.kind === 'urchin')) return;
  for (const [k, hue] of URCHINS) {
    const x = Math.round(WORLD.width * k);
    world.entities.push({ id: id(world), kind: 'urchin', x, y: sandAt(x) - 10, hue, state: 'resting', carriedBy: null, droppedBy: null, falls: 0 });
  }
}

function newMandala(number) {
  return { number, cells: {}, rev: 0, completedAt: null, makers: {} };
}

function nullStore() {
  return { putLore() {}, dropLore() {}, putFish() {}, event() {} };
}

const id = (world) => world.nextId++;
const fishes = (world) => world.entities.filter((e) => e.kind === 'fish');
const plants = (world) => world.entities.filter((e) => e.kind === 'plant');
const byId = (world, i, kind) => world.entities.find((e) => e.id === i && (!kind || e.kind === kind));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const r2 = (v) => Math.round(v * 100) / 100;

// `from` is where it came from: { gen, parents: [names] } for a seedling, nothing for a spore.
function createPlant(world, x, genome, from) {
  return {
    id: id(world), kind: 'plant', x: Math.round(x), y: sandAt(x), genome, name: speciesName(genome),
    gen: from ? from.gen + 1 : 1, parents: from?.parents ?? [], age: 0, growth: 0.02, state: 'growing',
    food: 0, regenT: 0, wither: 0, fade: 0, given: 0,
  };
}

// Seeds of a form that crowds the tank, or that land among their own kind, often fail to take
// root; rare forms always do. That keeps any one kind of plant from taking over.
function germinate(world, x, genome, from) {
  const others = plants(world).filter((p) => p.state !== 'dead');
  const kin = others.filter((p) => p.genome.form === genome.form);
  const share = others.length ? kin.length / others.length : 0;
  let chance = share > 0.3 ? 0.25 : share > 0.2 ? 0.6 : 1;
  for (const p of kin) if (Math.abs(p.x - x) < 90) chance *= 0.6;
  if (kin.length <= 1 || Math.random() < chance) world.entities.push(createPlant(world, x, genome, from));
}

// An x on the sand with room for one more plant, near `x` if possible.
function freeSpot(world, x, tries = 8, jitter = 0) {
  for (let i = 0; i < tries; i++) {
    const cx = clamp(x + (i ? rand(-jitter - 40 * i, jitter + 40 * i) : 0), 30, WORLD.width - 30);
    if (plants(world).every((p) => Math.abs(p.x - cx) > 34)) return cx;
  }
  return null;
}

function feedPoint(p) {
  return { x: p.x, y: p.y - p.genome.height * p.growth * FEED_AT[p.genome.form] };
}

// ---------- arrivals and departures ----------

const standing = (l) => l.told + 2 * (l.agreed?.length ?? 0) - 2 * (l.disputed?.length ?? 0);

// The fish that will follow `pred` (or a first fish, if null). Its personality and portrait are
// prepared outside the sim (server/births.js) before it's needed.
function queueArrival(world, pred) {
  const keep = pred ? pred.lore.filter((k) => k.stance !== 'disputes' && world.lore.has(k.id))
    .sort((a, b) => (b.stance === 'embraces') - (a.stance === 'embraces') || standing(world.lore.get(b.id)) - standing(world.lore.get(a.id)))
    .slice(0, INHERIT) : [];
  const arr = {
    id: id(world), gen: pred ? pred.gen + 1 : 1, predecessorId: pred?.id ?? null, predecessorName: pred?.name ?? null,
    predecessorPersona: pred?.persona ?? null, lineage: pred ? [pred.name, ...(pred.lineage ?? [])].slice(0, 6) : [],
    lore: keep.map((k) => ({ id: k.id, from: pred.name })), status: 'new', persona: null, article: null, sprite: null, glow: null,
    queuedAt: world.time,
  };
  world.arrivals.push(arr);
  if (pred) pred.successor = arr.id;
  return arr;
}

// Called by server/births.js once a newcomer has a personality and art.
export function arrivalReady(world, arrivalId, { persona, article, sprite, glow }) {
  const arr = world.arrivals.find((a) => a.id === arrivalId);
  if (!arr) return false;
  Object.assign(arr, { persona: persona ?? arr.persona, article: article ?? arr.article, sprite: sprite ?? arr.sprite, glow: glow ?? arr.glow, status: 'ready' });
  return true;
}

function enter(world, arr) {
  world.arrivals.splice(world.arrivals.indexOf(arr), 1);
  const p = arr.persona ?? fallbackPersona(arr);
  const side = Math.random() < 0.5 ? -1 : 1;
  const x = side < 0 ? -60 : WORLD.width + 60, y = rand(140, 460);
  const f = {
    id: arr.id, kind: 'fish', name: uniqueName(world, p.name), gen: arr.gen,
    predecessorId: arr.predecessorId, predecessorName: arr.predecessorName, lineage: arr.lineage,
    x, y, vx: -side * 40, vy: 0, facing: -side, entering: true, leaving: false,
    size: 0.75, health: 1, needs: { hunger: 0.75, energy: 0.9, social: 0.45, meaning: 0.35 },
    emotion: 'curious', feeling: null, persona: p, article: arr.article, sprite: arr.sprite, glow: arr.glow ?? '#7fdcff',
    bornAt: world.time, lifespan: rand(...LIFESPAN), wallBorn: Date.now(),
    thought: 'Where the water ends, there was more water. And now: light.', reasoning: '',
    plan: [{ type: 'swim_to', x: side < 0 ? rand(140, 360) : WORLD.width - rand(140, 360), y }], action: null,
    brain: 'arriving', seq: 0, awaiting: null, nextThinkAt: world.time + 5, rethinkAt: null, talk: null,
    memory: [], heard: [], impressions: {}, lore: arr.lore.filter((l) => world.lore.has(l.id)).map((l) => ({ ...l, at: world.time, stance: 'holds' })),
    said: null, kills: 0, seeds: [], bitAt: -1e9, bitBy: null, farewelled: false, successor: null,
  };
  world.entities.push(f);
  remember(world, f, 'swam into the tank from beyond its edge');
  if (arr.predecessorName) remember(world, f, `came in as ${arr.predecessorName} swam out, carrying what ${arr.predecessorName} taught`);
  for (const l of f.lore) remember(world, f, `carries from ${arr.predecessorName}: "${world.lore.get(l.id).text}"`);
  world.store.putFish(fishRecord(f));
  world.emit({ kind: 'arrive', id: f.id, name: f.name, glow: f.glow,
    text: `${f.name} swam in from beyond the edge${arr.predecessorName ? `, carrying ${arr.predecessorName}'s teachings` : ''} (generation ${f.gen}).` });
  return f;
}

// Keeps the tank at POPULATION: successors are prepared ahead of time and swim in as places open.
function stepArrivals(world) {
  for (const f of fishes(world)) {
    if (!f.successor && !f.leaving && f.lifespan - ageOf(world, f) < PREPARE) queueArrival(world, f);
  }
  const present = fishes(world).filter((f) => !f.leaving);
  if (present.length >= POPULATION) { world.slotOpenAt = null; return; }
  // Arrivals whose fish is still here are its heirs, waiting their turn; the rest are free to come in.
  const heir = (a) => present.some((f) => f.id === a.predecessorId);
  const free = world.arrivals.filter((a) => !heir(a));
  // Every open place has someone on the way for it (e.g. after the tank grows, or a fish dies young).
  for (let i = present.length + free.length; i < POPULATION; i++) free.push(queueArrival(world, null));
  world.slotOpenAt ??= world.time;
  const waited = world.time - world.slotOpenAt;
  // A ready newcomer comes in; if none is ready in time, the first one waiting comes in plain.
  const next = free.find((a) => a.status === 'ready') ?? (waited > ARRIVAL_TIMEOUT ? free[0] : null);
  if (next) { enter(world, next); world.slotOpenAt = null; }
}

// The edge calls every fish in the end: it swims out of the tank and doesn't come back.
function beginLeaving(world, f) {
  f.leaving = true;
  f.talk = null;
  f.plan = [];
  f.brain = 'leaving';
  const side = f.x < WORLD.width / 2 ? -1 : 1;
  f.action = { type: 'depart', side };
  f.thought = f.thought || 'The edge.';
  for (const o of fishes(world)) if (o !== f && dist(o, f) < HEAR * 2) remember(world, o, `watched ${f.name} swim out past the edge of the tank`);
  world.emit({ kind: 'depart', id: f.id, name: f.name, glow: f.glow, text: `${f.name} swam out past the edge of the tank after ${minutes(ageOf(world, f))}.` });
  if (!f.successor) queueArrival(world, f);
}

function gone(world, f, cause) {
  world.entities.splice(world.entities.indexOf(f), 1);
  world.store.putFish(fishRecord(f, cause));
  pruneLore(world);
}

// What a fish remembers of its life before the tank: whole sentences, only trimmed (at a word,
// with an ellipsis) if the mind wrote something far longer than asked.
function glimmers(f) {
  return (f.persona?.memories ?? []).slice(0, 4).map((m) => {
    const t = String(m).replace(/\s+/g, ' ').trim();
    return t.length <= 500 ? t : `${t.slice(0, 500).replace(/\s+\S*$/, '')}…`;
  });
}

// Two living fish never share a name, so minds can tell them apart.
function uniqueName(world, name) {
  const taken = new Set(fishes(world).map((f) => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (const suffix of [' the Second', ' the Third', ' the Fourth', ' the Younger']) if (!taken.has((name + suffix).toLowerCase())) return name + suffix;
  return `${name} ${world.nextId}`;
}

function fallbackPersona(arr) {
  const syl = ['ka', 'zu', 'mi', 'lo', 've', 'shi', 'ra', 'to', 'ny', 'ee', 'qu', 'bo', 'xi', 'pa'];
  const name = Array.from({ length: 2 + Math.floor(Math.random() * 2) }, () => syl[Math.floor(Math.random() * syl.length)]).join('');
  const subject = arr.article?.title ?? 'the dark';
  return {
    name: name[0].toUpperCase() + name.slice(1),
    personality: `Arrived with a head full of half-remembered ${subject}. Quiet, watchful, and stubborn about it.`,
    voice: 'Short, plain sentences.', voice_sample: 'Water. More water. Then you.', desire: `To find out what ${subject} means.`, philosophy: 'Everything that glows is asking a question.',
    memories: ['Out beyond the edge there was a long dark current, and something in it you still cannot name.'],
    temperament: 'gentle',
  };
}

function fishRecord(f, cause = null) {
  return {
    id: f.id, name: f.name, gen: f.gen, predecessorId: f.predecessorId ?? null, predecessorName: f.predecessorName, bornAt: f.wallBorn,
    diedAt: cause ? Date.now() : null, cause, persona: f.persona, article: f.article, sprite: f.sprite, glow: f.glow,
    kills: f.kills, composed: f.composed ?? 0,
  };
}

// ---------- memory, speech and teachings ----------

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

const findFish = (world, name) => {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  const all = fishes(world);
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

// One fish speaks at a time, and each line holds the floor about as long as it takes to read, so
// observers can follow along. A fish has at most one line waiting: a newer one replaces it.
const readTime = (text) => clamp(2.5 + text.length / 16, 4, 20);

function queueSpeech(world, f, text, toName, loreId) {
  world.speech = world.speech.filter((s) => s.id !== f.id);
  world.speech.push({ id: f.id, text, toName, loreId, at: world.time });
}

function stepSpeech(world) {
  world.speech = world.speech.filter((s) => world.time - s.at < SPEECH_STALE && byId(world, s.id, 'fish'));
  if (world.time < world.floorUntil || !world.speech.length) return;
  const s = world.speech.shift();
  const text = speak(world, byId(world, s.id, 'fish'), s.text, s.toName, s.loreId);
  if (text) world.floorUntil = world.time + readTime(text);
}

// Says something out loud. Everyone in earshot hears it; whoever it's addressed to is prompted to
// answer, and the two turn to face each other. A teaching travels with the words: all who hear learn it.
function speak(world, f, text, toName, loreId) {
  text = trimSpeech(text);
  if (!text) return null;
  const listeners = fishes(world).filter((o) => o !== f && !o.leaving && dist(o, f) <= HEAR);
  const named = findFish(world, toName);
  const to = named !== f ? named : null;
  f.said = { text, to: to?.name ?? null, at: world.time };
  hear(f, { at: world.time, from: f.name, to: to?.name ?? null, text, mine: true });
  f.needs.social = Math.min(1, f.needs.social + 0.05);
  // Who this is said to: the fish named, or else whoever last spoke to us, or else the nearest listener.
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
    o.needs.social = Math.min(1, o.needs.social + (o === partner ? 0.08 : 0.03));
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
  f.needs.meaning = Math.min(1, f.needs.meaning + 0.06);
  remember(world, f, `taught ${learned.join(' and ')}: "${lore.text}"`);
  world.emit({ kind: 'teach', id: f.id, name: f.name, glow: f.glow, to: learned, text: lore.text, loreId });
}

// A fish carries only CARRY teachings; learning another pushes out one it disputes, or else the
// least regarded.
function learn(world, f, loreId, from) {
  if (f.lore.some((l) => l.id === loreId)) return false;
  f.lore.push({ id: loreId, from, at: world.time, stance: 'holds' });
  f.needs.meaning = Math.min(1, f.needs.meaning + 0.04);
  remember(world, f, `learned from ${from}: "${world.lore.get(loreId).text}"`);
  if (f.lore.length > CARRY) {
    const rank = (l) => (l.stance === 'disputes' ? -1e6 : l.stance === 'embraces' ? 1e6 : 0) + standing(world.lore.get(l.id) ?? { told: 0 });
    const forget = f.lore.slice(0, -1).reduce((a, b) => (rank(b) < rank(a) ? b : a));
    f.lore.splice(f.lore.indexOf(forget), 1);
    remember(world, f, `let go of "${world.lore.get(forget.id)?.text}"`);
  }
  return true;
}

function compose(world, f, raw) {
  const text = String(raw.text ?? '').trim().slice(0, 300);
  if (!text || world.time - (f.composedAt ?? -1e9) < COMPOSE_GAP) return null;
  f.composedAt = world.time;
  const parent = world.lore.get(Number(raw.refines_id));
  const lore = {
    id: world.nextLoreId++, text, theme: THEMES.includes(raw.theme) ? raw.theme : 'the self',
    originId: f.id, originName: f.name, originGen: f.gen, glow: f.glow,
    refines: parent?.id ?? null, refinesText: parent?.text ?? null, refinesBy: parent?.originName ?? null,
    createdAt: Date.now(), told: 0, agreed: [f.name], disputed: [],
  };
  world.lore.set(lore.id, lore);
  world.store.putLore(lore);
  f.lore.push({ id: lore.id, from: 'yourself', at: world.time, stance: 'embraces' });
  if (f.lore.length > CARRY) f.lore.shift();
  f.composed = (f.composed ?? 0) + 1;
  f.needs.meaning = Math.min(1, f.needs.meaning + 0.1);
  remember(world, f, parent ? `reworked "${parent.text}" into: "${text}"` : `put into words: "${text}"`);
  world.emit({ kind: 'lore', id: f.id, name: f.name, glow: f.glow, text, theme: lore.theme, loreId: lore.id, refinesText: lore.refinesText, refinesBy: lore.refinesBy });
  pruneLore(world);
  return lore.id;
}

function takeStance(world, f, { teaching_id, agree }) {
  const k = f.lore.find((l) => l.id === Number(teaching_id));
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
  f.needs.meaning = Math.min(1, f.needs.meaning + 0.03); // making up your mind is worth something
  remember(world, f, `${agree ? 'embraced' : 'disputed'}: "${lore.text}"`);
  world.emit({ kind: 'stance', id: f.id, name: f.name, glow: f.glow, agree, text: lore.text, loreId: lore.id });
}

// The compendium keeps teachings long after anyone carries them, up to ARCHIVE; past that, the
// least regarded forgotten ones are let go.
function pruneLore(world) {
  if (world.lore.size <= ARCHIVE) return;
  const carried = new Set();
  for (const f of fishes(world)) for (const l of f.lore) carried.add(l.id);
  for (const a of world.arrivals) for (const l of a.lore) carried.add(l.id);
  const drop = [...world.lore.values()].filter((l) => !carried.has(l.id))
    .sort((a, b) => standing(a) - standing(b) || a.createdAt - b.createdAt).slice(0, world.lore.size - ARCHIVE).map((l) => l.id);
  for (const i of drop) world.lore.delete(i);
  world.store.dropLore(drop);
}

// What observers read: the compendium (the best regarded and newest teachings), who carries what.
export function compendium(world, limit = 300) {
  const carriers = new Map();
  for (const f of fishes(world)) for (const l of f.lore) {
    if (!carriers.has(l.id)) carriers.set(l.id, []);
    carriers.get(l.id).push({ name: f.name, stance: l.stance });
  }
  const all = [...world.lore.values()];
  const pick = all.sort((a, b) => (carriers.has(b.id) - carriers.has(a.id)) || standing(b) - standing(a) || b.createdAt - a.createdAt).slice(0, limit);
  return {
    total: world.lore.size,
    authors: new Set(all.map((l) => l.originName)).size,
    generations: all.reduce((g, l) => Math.max(g, l.originGen), 0),
    teachings: pick.map((l) => ({
      id: l.id, text: l.text, theme: l.theme, by: l.originName, gen: l.originGen, glow: l.glow, createdAt: l.createdAt,
      refines: l.refines, refinesText: l.refinesText, refinesBy: l.refinesBy,
      told: l.told, agreed: l.agreed?.length ?? 0, disputed: l.disputed?.length ?? 0, standing: standing(l),
      carriers: carriers.get(l.id) ?? [],
    })),
  };
}

// ---------- movement ----------

const radius = (f) => 13 * f.size;
const maxSpeed = (f) => 70 * (0.5 + 0.5 * f.needs.energy) * (f.health < 0.3 ? 0.7 : 1);

// Accelerates toward (tx, ty), slowing on arrival; true once within stopAt.
function steer(f, tx, ty, dt, speed, stopAt = 8) {
  f.steering = true;
  const dx = tx - f.x, dy = ty - f.y, d = Math.hypot(dx, dy);
  if (d < stopAt) { f.vx *= 0.9; f.vy *= 0.9; return true; }
  const want = Math.min(speed, d * 1.2 + 8);
  const k = Math.min(1, dt * 2.2);
  f.vx += ((dx / d) * want - f.vx) * k;
  f.vy += ((dy / d) * want - f.vy) * k;
  return false;
}

// Fish are drawn about 85px long and half as tall at size 1 (client/main.js FISH_WIDTH).
const HALF_LENGTH = 43, HALF_HEIGHT = 19;

// Two fish in conversation hold station side by side, nose to nose a little apart, facing each other.
function converse(world, f, o, dt) {
  const side = Math.sign(f.x - o.x) || (f.id < o.id ? -1 : 1);
  const gap = HALF_LENGTH * (f.size + o.size) * 0.9 + 16;
  const mx = (f.x + o.x) / 2, my = (f.y + o.y) / 2;
  steer(f, clamp(mx + (side * gap) / 2, 40, WORLD.width - 40), clamp(my, WORLD.surface + 40, sandAt(mx) - 40), dt, maxSpeed(f) * 0.7, 5);
}

function physics(world, f, dt) {
  // Fish keep their bodies apart (an ellipse as long and tall as they're drawn), and give a much
  // wider berth to fish they aren't talking with, so the tank doesn't clump.
  for (const o of fishes(world)) {
    if (o === f) continue;
    const together = f.talking && f.talk.with === o.id;
    const room = together ? 1 : 1.9;
    const dx = f.x - o.x, dy = f.y - o.y;
    const q = Math.hypot(dx / (HALF_LENGTH * (f.size + o.size) * 0.8 * room), dy / (HALF_HEIGHT * (f.size + o.size) * room));
    if (q > 0 && q < 1) { const d = Math.hypot(dx, dy) || 1; const push = (together ? 90 : 60) * (1 - q) * dt; f.vx += (dx / d) * push; f.vy += (dy / d) * push; }
  }
  f.x += f.vx * dt;
  f.y += f.vy * dt;
  if (!f.steering) { f.vx *= 1 - Math.min(1, dt * 1.5); f.vy *= 1 - Math.min(1, dt * 1.5); }
  const r = radius(f);
  // Arriving and leaving fish are allowed past the side walls.
  if (f.entering && f.x > r && f.x < WORLD.width - r) f.entering = false;
  if (f.entering) f.x = clamp(f.x, -80, WORLD.width + 80);
  else if (!f.leaving) f.x = clamp(f.x, r, WORLD.width - r);
  f.y = clamp(f.y, WORLD.surface + r * 0.6, sandAt(clamp(f.x, 0, WORLD.width)) - r * 0.5);
  const partner = f.talk && byId(world, f.talk.with, 'fish');
  if (partner && f.talking) f.facing = Math.sign(partner.x - f.x) || f.facing;
  else if (Math.abs(f.vx) > 4) f.facing = Math.sign(f.vx);
}

// ---------- actions ----------

const ageOf = (world, f) => world.time - f.bornAt;
const minutes = (s) => (s < 90 ? `${Math.round(s)} seconds` : `${Math.round(s / 60)} minutes`);

const RUN = {
  swim_to(world, f, a, dt) {
    a.t = (a.t ?? 0) + dt;
    if (a.t > 40) throw new Error(`I couldn't get to (${a.x}, ${a.y})`);
    return steer(f, a.x, clamp(a.y, WORLD.surface + 20, sandAt(a.x) - 15), dt, maxSpeed(f), 12);
  },

  eat(world, f, a, dt) {
    const food = byId(world, a.food_id);
    if (!food || (food.kind !== 'plant' && food.kind !== 'corpse')) throw new Error(`there is no food #${a.food_id}`);
    if (food.food <= 0) {
      if (a.got) return true;
      throw new Error(food.kind === 'plant' ? `the ${food.name} (#${food.id}) has no food left` : `nothing is left of ${food.name}`);
    }
    a.t = (a.t ?? 0) + dt;
    if (a.t > 45) throw new Error(`I couldn't reach the ${food.name}`);
    const at = food.kind === 'plant' ? feedPoint(food) : food;
    if (!steer(f, at.x, at.y, dt, maxSpeed(f), 16 + radius(f) * 0.4)) return false;
    f.nibbling = food.id;
    a.work = (a.work ?? 0) + dt;
    if (a.work < 1.6) return false;
    a.work = 0;
    food.food--;
    a.got = (a.got ?? 0) + 1;
    if (food.kind === 'plant') {
      food.given++;
      f.needs.hunger = Math.min(1, f.needs.hunger + 0.22);
      // Fish spread the plants they feed on: some seeds pass through and take root wherever the fish
      // is next, and pollen carried from the last plant it fed on makes some of them hybrids.
      const p = f.pollen;
      if (p && p.id !== food.id && Math.random() < 0.2) {
        f.seeds.push({ at: world.time + rand(40, 120), genome: cross(p.genome, food.genome), gen: Math.max(p.gen, food.gen), parents: [p.name, food.name] });
      } else if (Math.random() < 0.1) {
        f.seeds.push({ at: world.time + rand(40, 120), genome: mutate(food.genome), gen: food.gen, parents: [food.name] });
      }
      f.pollen = { id: food.id, genome: food.genome, name: food.name, gen: food.gen };
    } else {
      f.needs.hunger = Math.min(1, f.needs.hunger + 0.3);
      f.health = Math.min(1, f.health + 0.05);
    }
    if (a.got >= a.amount || food.food <= 0 || f.needs.hunger >= 1) {
      remember(world, f, food.kind === 'plant' ? `ate ${a.got} from the ${food.name} (#${food.id})` : `ate from the remains of ${food.name}`);
      return true;
    }
    return false;
  },

  approach(world, f, a, dt) {
    const o = byId(world, a.fish_id, 'fish');
    if (!o) throw new Error(`there is no fish #${a.fish_id} here any more`);
    if (o === f) return true;
    a.t = (a.t ?? 0) + dt;
    if (a.t > 30) throw new Error(`I couldn't catch up with ${o.name}`);
    const d = dist(f, o);
    if (d < NEAR + radius(o)) { f.vx *= 0.9; f.vy *= 0.9; return true; }
    const k = (NEAR + radius(o) * 0.5) / d;
    return steer(f, o.x + (f.x - o.x) * k, o.y + (f.y - o.y) * k, dt, maxSpeed(f), 10);
  },

  follow(world, f, a, dt) {
    const o = byId(world, a.fish_id, 'fish');
    if (!o) throw new Error(`there is no fish #${a.fish_id} here any more`);
    a.left = (a.left ?? a.seconds) - dt;
    if (o !== f && dist(f, o) > 60 + radius(o)) steer(f, o.x - o.facing * 50, o.y, dt, maxSpeed(f) * 1.1, 6);
    if (a.left > 0) return false;
    remember(world, f, `followed ${o.name} for a while`);
    return true;
  },

  attack(world, f, a, dt) {
    const o = byId(world, a.fish_id, 'fish');
    if (!o || o.leaving) {
      if (a.bites) return true;
      throw new Error(`there is no fish #${a.fish_id} here any more`);
    }
    if (o === f) throw new Error('I can\'t bite myself');
    a.t = (a.t ?? 0) + dt;
    f.needs.energy = Math.max(0, f.needs.energy - dt * 0.006);
    if (a.t > 20) {
      if (a.bites) return true;
      throw new Error(`${o.name} got away from me`);
    }
    steer(f, o.x, o.y, dt, maxSpeed(f) * 1.35, 0);
    if (dist(f, o) > HALF_LENGTH * (f.size + o.size) * 0.6 || world.time - (a.bitAt ?? -1e9) < BITE_GAP) return false;
    a.bitAt = world.time;
    a.bites = (a.bites ?? 0) + 1;
    bite(world, f, o);
    return a.bites >= 3 || !world.entities.includes(o);
  },

  flee(world, f, a, dt) {
    const o = byId(world, a.fish_id, 'fish');
    a.left = (a.left ?? a.seconds) - dt;
    if (o && o !== f) {
      const d = Math.max(1, dist(f, o));
      steer(f, f.x + ((f.x - o.x) / d) * 200, f.y + ((f.y - o.y) / d) * 200, dt, maxSpeed(f) * 1.25, 0);
      f.needs.energy = Math.max(0, f.needs.energy - dt * 0.004);
    }
    if (a.left > 0 && o) return false;
    remember(world, f, o ? `fled from ${o.name}` : 'stopped fleeing');
    return true;
  },

  rest(world, f, a, dt) {
    a.left = (a.left ?? a.seconds) - dt;
    // Drift down and hang just above the sand.
    steer(f, f.x, sandAt(f.x) - radius(f) - 12, dt, 12, 4);
    f.needs.energy = Math.min(1, f.needs.energy + 0.025 * dt);
    if (a.left > 0) return false;
    remember(world, f, `rested for ${a.seconds}s`);
    return true;
  },

  wander(world, f, a, dt) {
    a.left = (a.left ?? a.seconds) - dt;
    if (!a.to || dist(f, a.to) < 20) a.to = openWater(world, f);
    steer(f, a.to.x, a.to.y, dt, maxSpeed(f) * 0.6, 10);
    return a.left <= 0;
  },

  // Fetch a grain of the chosen color from its deposit on the floor, carry it up, and lay it in
  // the nearest of the four mirrored places for (ring, slot).
  make_mandala(world, f, a, dt) {
    a.t = (a.t ?? 0) + dt;
    if (a.t > 70) throw new Error('I lost my way between the sand and the mandala');
    if (world.mandala.completedAt != null) throw new Error('the mandala is finished; it is to be looked at now, not added to');
    if (f.carrying !== a.color) {
      f.carrying = null;
      const x = depositX(SAND_NAMES.indexOf(a.color));
      if (!steer(f, x, sandAt(x) - radius(f) * 0.6 - 6, dt, maxSpeed(f), 14)) return false;
      a.work = (a.work ?? 0) + dt;
      if (a.work < 1.2) return false;
      a.work = 0;
      f.carrying = a.color;
      return false;
    }
    const spot = [0, 1, 2, 3].map((q) => cellCenter(a.ring, a.slot, q)).reduce((best, p) => (dist(f, p) < dist(f, best) ? p : best));
    if (!steer(f, spot.x, spot.y, dt, maxSpeed(f), 10)) return false;
    a.work = (a.work ?? 0) + dt;
    if (a.work < 1) return false;
    laySand(world, f, a.ring, a.slot, a.color);
    f.carrying = null;
    return true;
  },

  // Pick up a glowing urchin from the sand, carry it to the surface and let it go.
  drop_urchin(world, f, a, dt) {
    const u = byId(world, a.urchin_id, 'urchin');
    if (!u) throw new Error(`there is no urchin #${a.urchin_id}`);
    a.t = (a.t ?? 0) + dt;
    if (u.carriedBy !== f.id) {
      if (u.state !== 'resting') throw new Error(u.state === 'falling' ? 'that urchin is already falling' : 'someone else is carrying that urchin');
      if (a.t > 45) throw new Error('I couldn\'t reach the urchin');
      if (!steer(f, u.x, u.y - radius(f) * 0.5, dt, maxSpeed(f), 14)) return false;
      a.work = (a.work ?? 0) + dt;
      if (a.work < 1) return false;
      Object.assign(u, { state: 'carried', carriedBy: f.id });
      remember(world, f, 'picked up a glowing urchin from the sand');
      return false;
    }
    if (!steer(f, f.x, WORLD.surface + 32, dt, maxSpeed(f) * 0.75, 10) && a.t < 90) return false;
    letGo(world, u, f);
    return true;
  },

  // Not something a mind can choose: the end of a life.
  depart(world, f, a, dt) {
    steer(f, a.side < 0 ? -200 : WORLD.width + 200, f.y + Math.sin(world.time) * 5, dt, Math.max(45, maxSpeed(f) * 0.9), 0);
    if (f.x < -90 || f.x > WORLD.width + 90) { gone(world, f, 'swam out past the edge'); return true; }
    return false;
  },
};

// Somewhere a few hundred pixels off with the most room around it: wandering spreads fish out.
function openWater(world, f) {
  let best = null, bestRoom = -1;
  for (let i = 0; i < 6; i++) {
    const x = clamp(f.x + rand(-360, 360), 50, WORLD.width - 50);
    const p = { x, y: rand(WORLD.surface + 50, sandAt(x) - 50) };
    const room = Math.min(...fishes(world).filter((o) => o !== f).map((o) => dist(o, p)), 1e9);
    if (room > bestRoom) { best = p; bestRoom = room; }
  }
  return best;
}

function laySand(world, f, ring, slot, color) {
  const m = world.mandala;
  const key = `${ring}:${slot}`;
  const before = m.cells[key]?.color;
  m.cells[key] = { color, by: f.name };
  m.rev++;
  m.makers[f.name] = (m.makers[f.name] ?? 0) + 1;
  f.needs.meaning = Math.min(1, f.needs.meaning + (before ? 0.08 : 0.14));
  remember(world, f, before ? `replaced the ${before} on ring ${ring} of the mandala with ${color}` : `laid ${color} sand on ring ${ring} of the mandala`);
  for (const o of fishes(world)) if (o !== f && dist(o, f) < HEAR) remember(world, o, `watched ${f.name} lay ${color} sand on ring ${ring} of the mandala`);
  world.emit({ kind: 'sand', id: f.id, name: f.name, glow: f.glow, color, ring, text: `${f.name} laid ${color} sand on ring ${ring}${before ? `, over the ${before}` : ''}.` });
  if (Object.keys(m.cells).length >= mandalaCells()) {
    m.completedAt = world.time;
    for (const o of fishes(world)) remember(world, o, `the mandala is complete: every grain is laid`);
    world.emit({ kind: 'mandala', text: `The ${ordinal(m.number)} mandala is complete. It will stand for ten minutes, then its sand will fall.` });
  }
}

const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`);

// A finished mandala stands for MANDALA.admire seconds, then its sand falls; its pattern is remembered.
function stepMandala(world) {
  const m = world.mandala;
  if (m.completedAt == null || world.time - m.completedAt < MANDALA.admire) return;
  world.mandalas.push({ number: m.number, cells: m.cells, makers: m.makers, finishedAt: Date.now() });
  if (world.mandalas.length > MANDALAS_KEPT) world.mandalas.shift();
  for (const o of fishes(world)) remember(world, o, `the sand of the ${ordinal(m.number)} mandala fell away, and the wall is bare again`);
  world.emit({ kind: 'mandala', text: `The sand of the ${ordinal(m.number)} mandala fell away. The wall is bare again.` });
  world.mandala = newMandala(m.number + 1);
}

// The mandala as a fish sees it: each ring's slots in quadrant one (the rest mirror it).
function describeMandala(world) {
  const m = world.mandala;
  const rings = [];
  for (let r = 0; r < MANDALA.rings; r++) {
    const slots = Array.from({ length: slotsIn(r) }, (_, i) => m.cells[`${r}:${i}`]?.color ?? '.');
    rings.push(`ring ${r} (${slots.length} slot${slots.length > 1 ? 's' : ''}): ${slots.join(' ')}`);
  }
  const laid = Object.keys(m.cells).length;
  return {
    number: m.number, laid: `${laid} of ${mandalaCells()} places filled`,
    ...(m.completedAt != null ? { finished: `complete; its sand will fall in ${minutes(Math.max(0, MANDALA.admire - (world.time - m.completedAt)))}` } : {}),
    rings, sand_colors: SAND_NAMES.join(', '),
  };
}

function letGo(world, u, f) {
  Object.assign(u, { state: 'falling', carriedBy: null, droppedBy: f?.name ?? null, droppedById: f?.id ?? null, releasedAt: world.time });
  if (!f) return;
  const high = u.y < WORLD.surface + 120;
  remember(world, f, high ? 'let a glowing urchin go at the surface' : 'let go of the urchin before I reached the surface');
  world.emit({ kind: 'urchin', id: f.id, name: f.name, glow: f.glow, text: `${f.name} let a glowing urchin go${high ? ' at the surface' : ''}.` });
}

// Carried urchins ride at their fish's mouth; let go, they sink slowly, swaying, to wherever they settle.
// Every fish that watches one settle is moved by it; the one who let it go most of all.
function stepUrchins(world, dt) {
  for (const u of world.entities.filter((e) => e.kind === 'urchin')) {
    if (u.state === 'carried') {
      const f = byId(world, u.carriedBy, 'fish');
      if (!f || f.action?.type !== 'drop_urchin' || f.action.urchin_id !== u.id) { letGo(world, u, f); continue; }
      u.x = f.x + f.facing * HALF_LENGTH * f.size * 0.85;
      u.y = f.y + 4;
    } else if (u.state === 'falling') {
      u.y += URCHIN_FALL * dt;
      u.x = clamp(u.x + Math.sin(world.time * 0.7 + u.id) * 8 * dt, 30, WORLD.width - 30);
      const floor = sandAt(u.x) - 10;
      if (u.y >= floor) settle(world, u, floor);
    }
  }
}

function settle(world, u, floor) {
  Object.assign(u, { state: 'resting', y: floor });
  u.falls++;
  const secs = Math.round(world.time - (u.releasedAt ?? world.time));
  for (const o of fishes(world)) {
    if (o.leaving || (o.id !== u.droppedById && dist(o, u) > WATCH)) continue;
    const mine = o.id === u.droppedById;
    o.needs.meaning = Math.min(1, o.needs.meaning + (mine ? 0.2 : 0.1));
    remember(world, o, mine ? `watched the urchin I let go drift all the way down to the sand (${secs}s)` : `watched ${u.droppedBy ? `${u.droppedBy}'s` : 'a'} glowing urchin drift down to the sand`);
    if (mine) { o.watchedFallAt = world.time; interrupt(world, o, 1); }
  }
  world.emit({ kind: 'urchin', text: `${u.droppedBy ? `${u.droppedBy}'s` : 'A'} glowing urchin settled on the sand after a ${secs}-second fall.` });
}

function bite(world, f, o) {
  const dmg = 0.12 * Math.pow(f.size / o.size, 1.2);
  o.health = Math.max(0, o.health - dmg);
  o.bitAt = world.time;
  o.bitBy = f.id;
  o.talk = null;
  const d = Math.max(1, dist(f, o));
  o.vx += ((o.x - f.x) / d) * 80;
  o.vy += ((o.y - f.y) / d) * 80;
  f.needs.hunger = Math.min(1, f.needs.hunger + 0.06);
  remember(world, f, `bit ${o.name}`);
  remember(world, o, `${f.name} bit me`);
  world.emit({ kind: 'bite', id: f.id, name: f.name, to: o.name, text: `${f.name} bit ${o.name}.` });
  for (const w of fishes(world)) if (w !== f && w !== o && dist(w, f) < HEAR * 1.5) remember(world, w, `saw ${f.name} bite ${o.name}`);
  if (o.health <= 0) {
    f.kills++;
    remember(world, f, `killed ${o.name}`);
    die(world, o, `killed by ${f.name}`);
  } else interrupt(world, o, 0.2);
}

function die(world, f, cause) {
  world.entities.push({
    id: id(world), kind: 'corpse', name: f.name, x: f.x, y: f.y, vy: 0, size: f.size, facing: f.facing,
    sprite: f.sprite, glow: f.glow, food: 2 + Math.round(f.size * 3), age: 0, cause, gen: f.gen,
  });
  for (const o of fishes(world)) {
    if (o === f) continue;
    if (dist(o, f) < HEAR * 1.5) remember(world, o, `saw ${f.name} die (${cause})`);
    if (o.impressions[f.id]) o.needs.social = Math.max(0, o.needs.social - 0.15);
  }
  if (!f.successor) queueArrival(world, f);
  world.emit({ kind: 'death', id: f.id, name: f.name, text: `${f.name} died (${cause}) after ${minutes(ageOf(world, f))}.` });
  gone(world, f, cause);
}

// Plans come from outside the sim, so every action is checked and clamped here.
function normalizeAction(raw) {
  if (!raw || !ACTIONS.includes(raw.type)) return null;
  const num = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : dflt);
  switch (raw.type) {
    case 'swim_to': return { type: 'swim_to', x: num(raw.x, 20, WORLD.width - 20, null), y: num(raw.y, WORLD.surface, WORLD.height, null) };
    case 'eat': return { type: 'eat', food_id: num(raw.food_id, 0, 1e9, null), amount: num(raw.amount, 1, 4, 1) };
    case 'approach': return { type: 'approach', fish_id: num(raw.fish_id, 0, 1e9, null) };
    case 'follow': return { type: 'follow', fish_id: num(raw.fish_id, 0, 1e9, null), seconds: num(raw.seconds, 3, 40, 12) };
    case 'attack': return { type: 'attack', fish_id: num(raw.fish_id, 0, 1e9, null) };
    case 'flee': return { type: 'flee', fish_id: num(raw.fish_id, 0, 1e9, null), seconds: num(raw.seconds, 2, 20, 6) };
    case 'rest': return { type: 'rest', seconds: num(raw.seconds, 3, 60, 15) };
    case 'wander': return { type: 'wander', seconds: num(raw.seconds, 3, 40, 12) };
    case 'drop_urchin': return { type: 'drop_urchin', urchin_id: num(raw.urchin_id, 0, 1e9, null) };
    case 'make_mandala': {
      const ring = num(raw.ring, 0, MANDALA.rings - 1, null);
      return { type: 'make_mandala', color: SAND_NAMES.includes(raw.color) ? raw.color : null, ring, slot: ring == null ? null : num(raw.slot, 0, slotsIn(ring) - 1, 0) };
    }
  }
}

function describeAction(world, a) {
  if (!a) return null;
  const fish = (i) => byId(world, i, 'fish')?.name ?? `#${i}`;
  switch (a.type) {
    case 'swim_to': return `swimming to (${a.x}, ${a.y})`;
    case 'eat': { const t = byId(world, a.food_id); return `eating ${t?.kind === 'corpse' ? `the remains of ${t.name}` : `from the ${t?.name ?? `#${a.food_id}`}`}`; }
    case 'approach': return `swimming over to ${fish(a.fish_id)}`;
    case 'follow': return `following ${fish(a.fish_id)}`;
    case 'attack': return `attacking ${fish(a.fish_id)}`;
    case 'flee': return `fleeing from ${fish(a.fish_id)}`;
    case 'rest': return 'resting';
    case 'wander': return 'wandering';
    case 'depart': return 'swimming out past the edge';
    case 'make_mandala': return `laying ${a.color} sand in the mandala`;
    case 'drop_urchin': return 'carrying a glowing urchin up to the surface';
  }
}

const doingOf = (world, f) =>
  f.leaving ? 'swimming out past the edge' : f.talking ? `talking with ${byId(world, f.talk.with, 'fish')?.name}` : describeAction(world, f.action);

// ---------- minds ----------

const healthWord = (h) => (h > 0.8 ? 'healthy' : h > 0.5 ? 'hurt' : h > 0.25 ? 'badly hurt' : 'near death');
const stage = (world, f) => {
  const left = f.lifespan - ageOf(world, f);
  if (left < FAREWELL + 5) return 'the edge is calling you: you will swim out of the tank in moments';
  const k = ageOf(world, f) / f.lifespan;
  return k < 0.2 ? 'newly arrived' : k < 0.7 ? 'in your prime' : 'growing old';
};

// What a fish can perceive, sent to the mind with each decision request.
function perceive(world, f) {
  const others = fishes(world).filter((o) => o !== f);
  const ago = (t) => `${Math.round(world.time - t)}s ago`;
  const food = [
    ...plants(world).filter((p) => p.food > 0).map((p) => ({ p, d: dist(f, feedPoint(p)) })).sort((a, b) => a.d - b.d).slice(0, 4)
      .map(({ p, d }) => ({ id: p.id, what: p.name, x: p.x, y: Math.round(feedPoint(p).y), distance: Math.round(d), food: p.food })),
    ...world.entities.filter((c) => c.kind === 'corpse' && c.food > 0)
      .map((c) => ({ id: c.id, what: `the remains of ${c.name}`, x: Math.round(c.x), y: Math.round(c.y), distance: Math.round(dist(f, c)), food: c.food })),
  ];
  const remembered = Object.entries(f.impressions).filter(([i]) => !byId(world, Number(i), 'fish')).slice(-4).map(([, v]) => v);
  const partner = f.talking && byId(world, f.talk.with, 'fish');
  return {
    you: {
      id: f.id, name: f.name, voice: f.persona.voice, voice_sample: f.persona.voice_sample,
      generation: f.gen, personality: f.persona.personality, desire: f.persona.desire, philosophy: f.persona.philosophy,
      ...(glimmers(f).length ? { memories_from_beyond_the_edge: glimmers(f) } : {}),
      ...(f.composedAt != null ? { last_set_down_a_teaching: `${Math.round(world.time - f.composedAt)}s ago${world.time - f.composedAt < COMPOSE_GAP ? ' (too soon for another; talk it over first)' : ''}` } : {}),
      time_in_tank: minutes(ageOf(world, f)), life_stage: stage(world, f),
      size: r2(f.size), health: healthWord(f.health), x: Math.round(f.x), y: Math.round(f.y),
      needs: Object.fromEntries(Object.entries(f.needs).map(([k, v]) => [k, r2(v)])), feeling: f.emotion,
      ...(partner ? { talking_with: partner.name } : {}),
      ...(f.carrying ? { carrying_sand: f.carrying } : {}),
      ...(world.time - (f.watchedFallAt ?? -1e9) < INSIGHT ? { just_watched: 'the urchin you let go drift slowly from the surface all the way to the sand. Sit with what it showed you.' } : {}),
      ...(world.speech.some((s) => s.id === f.id) ? { waiting_to_say: world.speech.find((s) => s.id === f.id).text } : {}),
      ...(world.time - f.bitAt < 30 ? { danger: `${byId(world, f.bitBy, 'fish')?.name ?? 'someone'} bit you ${ago(f.bitAt)}` } : {}),
    },
    ...(f.predecessorName ? { lineage: `you came in as ${f.predecessorName} swam out; before them: ${(f.lineage ?? []).slice(1).join(', ') || 'no one remembered'}` } : {}),
    fish: others.map((o) => ({
      id: o.id, name: o.name, x: Math.round(o.x), y: Math.round(o.y), distance: Math.round(dist(f, o)),
      can_hear_you: dist(f, o) <= HEAR && !o.leaving, generation: o.gen, size: r2(o.size), health: healthWord(o.health),
      feeling: o.emotion, doing: doingOf(world, o) ?? 'pausing',
      ...(ageOf(world, o) / o.lifespan > 0.7 ? { looks: 'old' } : ageOf(world, o) < 45 ? { looks: 'just arrived' } : {}),
      ...(f.impressions[o.id] ? { your_impression: f.impressions[o.id] } : {}),
    })),
    food,
    mandala: describeMandala(world),
    urchins: world.entities.filter((e) => e.kind === 'urchin').map((u) => ({
      id: u.id, x: Math.round(u.x), y: Math.round(u.y), distance: Math.round(dist(f, u)),
      state: u.state === 'resting' ? 'resting on the sand' : u.state === 'falling' ? 'drifting down' : `carried by ${byId(world, u.carriedBy, 'fish')?.name}`,
    })),
    conversation: f.heard.slice(-8).map((h) =>
      `${ago(h.at)}, ${h.mine ? 'you' : h.from} said${h.to ? ` to ${h.to === f.name ? 'you' : h.to}` : ''}: "${h.text}"`),
    memory: f.memory.slice(-8).map((m) => `${ago(m.at)}: ${recall(m)}`),
    teachings_you_carry: f.lore.map((k) => ({ k, l: world.lore.get(k.id) })).filter(({ l }) => l).map(({ k, l }) => ({
      id: l.id, text: l.text, theme: l.theme,
      origin: l.originId === f.id ? 'yours' : `${l.originName} (generation ${l.originGen})`,
      ...(l.refinesText ? { reworks: `${l.refinesBy}'s "${l.refinesText.length > 90 ? l.refinesText.slice(0, 90) + '…' : l.refinesText}"` } : {}),
      learned_from: k.from, your_stance: k.stance, embraced_by: l.agreed?.length ?? 0, disputed_by: l.disputed?.length ?? 0,
    })),
    ...(remembered.length ? { fish_you_remember: remembered } : {}),
    last_thought: f.thought,
  };
}

// Applies a decision from the mind. Returns false if it was stale or unusable.
export function applyPlan(world, msg) {
  const f = byId(world, msg.id, 'fish');
  if (!f || msg.seq !== f.seq || f.awaiting == null) return false;
  f.awaiting = null;
  const actions = (Array.isArray(msg.actions) ? msg.actions : []).slice(0, PLAN_MAX).map(normalizeAction)
    .filter((a) => a && Object.values(a).every((v) => v != null));
  if (typeof msg.thought === 'string' && msg.thought.trim()) f.thought = msg.thought.trim().slice(0, 300);
  f.feeling = FEELINGS.includes(msg.feeling) ? msg.feeling : null;
  const about = msg.impression && byId(world, msg.impression.fish_id, 'fish');
  if (about && about !== f && typeof msg.impression.text === 'string') f.impressions[about.id] = `${about.name}: ${msg.impression.text.trim().slice(0, 160)}`;
  if (msg.stance) takeStance(world, f, msg.stance);
  let loreId = f.lore.some((l) => l.id === msg.share_teaching_id) ? msg.share_teaching_id : null;
  if (msg.new_teaching?.text) loreId = compose(world, f, msg.new_teaching) ?? loreId;
  if (typeof msg.say?.text === 'string' && msg.say.text.trim()) queueSpeech(world, f, msg.say.text, msg.say.to, loreId);
  if (f.rethink) { f.rethink = false; f.rethinkAt = world.time + 5; }
  if (f.leaving) return true; // last words only; the edge decides where it goes
  f.action = null;
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
  const f = byId(world, msg.id, 'fish');
  if (!f || msg.seq !== f.seq || f.awaiting == null || typeof msg.text !== 'string') return;
  f.reasoning = (f.reasoning + msg.text).slice(-REASONING_KEEP);
}

// Forget pending requests (the mind disconnected); those fish fall back to instinct.
export function mindLost(world) {
  for (const f of fishes(world)) if (f.awaiting != null) { f.awaiting = null; f.nextThinkAt = world.time; }
}

// Something demands a fresh decision: drop the plan and think again shortly.
function interrupt(world, f, delay) {
  if (f.leaving) return;
  if (f.awaiting != null) { f.rethink = true; return; }
  f.plan = [];
  f.action = null;
  f.nextThinkAt = world.time + delay + Math.random() * 0.6;
}

// Fallback behavior: flee when bitten, rest when tired, eat when hungry, seek company when lonely.
function instinct(world, f) {
  f.brain = 'instinct';
  const n = f.needs;
  if (world.time - f.bitAt < 8 && byId(world, f.bitBy, 'fish')) {
    f.plan = [{ type: 'flee', fish_id: f.bitBy, seconds: 6 }];
    f.thought = 'Get away!';
    return;
  }
  if (n.energy < 0.2) { f.plan = [{ type: 'rest', seconds: 20 }]; f.thought = 'So tired.'; return; }
  if (n.hunger < 0.55) {
    const food = perceive(world, f).food[0];
    if (food) { f.plan = [{ type: 'eat', food_id: food.id, amount: 2 }]; f.thought = 'Food.'; return; }
  }
  const other = fishes(world).filter((o) => o !== f && !o.leaving).sort((a, b) => dist(f, a) - dist(f, b))[0];
  if (n.social < 0.35 && other) {
    f.plan = [{ type: 'approach', fish_id: other.id }, { type: 'follow', fish_id: other.id, seconds: 10 }];
    f.thought = 'Company.';
    return;
  }
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

// ---------- plants ----------

const living = (world) => plants(world).filter((p) => p.state !== 'dead').length;

function stepPlants(world, dt) {
  for (const p of plants(world)) {
    p.age += dt;
    const g = p.genome;
    if (p.state === 'growing') {
      p.growth = Math.min(1, p.growth + dt / g.growTime);
      if (p.growth >= 1) p.state = 'mature';
    } else if (p.state === 'mature') {
      if (p.food < g.food && (p.regenT += dt) >= g.regen) { p.regenT = 0; p.food++; }
      if (p.age > g.growTime + g.lifespan) p.state = 'withering';
    } else if (p.state === 'withering') {
      p.wither = Math.min(1, p.wither + dt / 90);
      if (p.food > 0 && Math.random() < dt / 20) p.food--;
      if (p.wither >= 1) {
        p.state = 'dead';
        p.food = 0;
        // A dying plant scatters seeds; most take root nearby.
        const seeds = 1 + (Math.random() < 0.6 ? 1 : 0);
        for (let i = 0; i < seeds && living(world) < MAX_PLANTS; i++) {
          const x = freeSpot(world, p.x + rand(-140, 140), 6, 20);
          if (x != null) germinate(world, x, mutate(g), { gen: p.gen, parents: [p.name] });
        }
      }
    } else if (p.state === 'dead') {
      p.fade = Math.min(1, p.fade + dt / 60);
      if (p.fade >= 1) world.entities.splice(world.entities.indexOf(p), 1);
    }
  }
  // Seeds fish carried away take root wherever the fish is when they pass.
  for (const f of fishes(world)) {
    while (f.seeds.length && f.seeds[0].at <= world.time) {
      const s = f.seeds.shift();
      const x = living(world) < MAX_PLANTS && f.x > 30 && f.x < WORLD.width - 30 ? freeSpot(world, f.x, 3) : null;
      if (x != null) germinate(world, x, s.genome, { gen: s.gen, parents: s.parents ?? [] });
    }
  }
  // Spores drift in when the tank gets bare, and now and then something entirely new drifts in anyway.
  const bare = living(world) < MIN_PLANTS;
  if (world.time - world.lastSpore > (bare ? 45 : DRIFT_SPORE) && (bare || living(world) < MAX_PLANTS)) {
    world.lastSpore = world.time;
    const x = freeSpot(world, rand(40, WORLD.width - 40), 6, 100);
    if (x != null) world.entities.push(createPlant(world, x, randomGenome(), null));
  }
}

// Remains sink, are picked at, and finally feed the sand: something new grows where a fish fell.
function stepCorpses(world, dt) {
  for (const c of world.entities.filter((e) => e.kind === 'corpse')) {
    c.age += dt;
    const floor = sandAt(c.x) - 10;
    if (c.y < floor) { c.vy = Math.min(20, c.vy + dt * 6); c.y = Math.min(floor, c.y + c.vy * dt); }
    if (c.age > 300 || (c.food <= 0 && c.age > 20)) {
      world.entities.splice(world.entities.indexOf(c), 1);
      const x = living(world) < MAX_PLANTS ? freeSpot(world, c.x, 4) : null;
      if (x != null) world.entities.push(createPlant(world, x, randomGenome(), null));
    }
  }
}

// ---------- fish ----------

function stepFish(world, f, dt) {
  const age = ageOf(world, f);
  if (!f.leaving && age >= f.lifespan) beginLeaving(world, f);
  if (!f.leaving && !f.farewelled && age >= f.lifespan - FAREWELL) {
    f.farewelled = true;
    remember(world, f, 'I feel the edge calling me. Soon I will swim out of the tank, as every fish does');
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

  // While two fish talk they face each other; only eating, fighting and fleeing carry on regardless.
  const partner = f.talk && world.time < f.talk.until && byId(world, f.talk.with, 'fish');
  if (f.talk && (!partner || partner.leaving)) f.talk = null;
  f.talking = Boolean(partner && !partner.leaving && !f.leaving && !['eat', 'attack', 'flee'].includes(f.action?.type));
  f.steering = false;
  f.nibbling = null;
  if (f.talking) converse(world, f, partner, dt);
  else if (f.action) {
    try {
      if (RUN[f.action.type](world, f, f.action, dt)) f.action = null;
    } catch (err) {
      remember(world, f, `gave up ${describeAction(world, f.action)}: ${err.message}`);
      f.action = null;
      f.plan = [];          // the rest of the plan assumed this step would work
      f.failedAt = world.time;
    }
    if (!world.entities.includes(f)) return; // swam out of the tank
    if (!f.action && !f.plan.length) f.nextThinkAt = world.time + (f.failedAt === world.time ? FAIL_GAP : THINK_GAP);
  }

  physics(world, f, dt);

  const n = f.needs;
  const speed = Math.hypot(f.vx, f.vy) / 70;
  n.hunger = Math.max(0, n.hunger - dt * (1 / 500) * (0.8 + 0.6 * speed));
  n.energy = Math.max(0, n.energy - dt * (1 / 900) * (0.6 + speed));
  // Loneliness creeps in over about 12 minutes alone; company only slows it, and it takes a good
  // while of face-to-face talk to fill up. Meaning fades over about 15 minutes unless the fish does
  // something with it.
  n.social = Math.max(0, n.social - dt / 700);
  if (f.talking) n.social = Math.min(1, n.social + dt / 300);
  else if (fishes(world).some((o) => o !== f && !o.leaving && dist(o, f) < COMPANY)) n.social = Math.min(1, n.social + dt / 900);
  n.meaning = Math.max(0, n.meaning - dt / 900);
  if (n.hunger <= 0) f.health -= dt / 120;
  else if (n.hunger > 0.35) f.health = Math.min(1, f.health + dt / 200);
  if (n.hunger > 0.3 && f.size < 1.35) f.size += (dt * 0.55) / f.lifespan;

  f.emotion =
    world.time - f.bitAt < 10 ? (f.feeling === 'angry' ? 'angry' : 'afraid')
    : f.action?.type === 'rest' || n.energy < 0.12 ? 'sleepy'
    : n.hunger < 0.15 ? 'hungry'
    : f.feeling ?? (n.social < 0.25 ? 'lonely' : n.meaning > 0.6 ? 'happy' : 'curious');

  if (f.health <= 0) die(world, f, n.hunger <= 0 ? 'starvation' : 'its wounds');
}

export function step(world, dt) {
  world.tick++;
  world.time += dt;
  stepPlants(world, dt);
  stepCorpses(world, dt);
  stepArrivals(world);
  stepSpeech(world);
  stepMandala(world);
  stepUrchins(world, dt);
  for (const f of fishes(world)) if (world.entities.includes(f)) stepFish(world, f, dt);
}

// ---------- snapshots and persistence ----------

// Fast fields go out 10 times a second; `full` adds the heavy, slow-changing ones.
function view(world, e, full) {
  switch (e.kind) {
    case 'fish': {
      const v = {
        id: e.id, kind: e.kind, name: e.name, x: e.x, y: e.y, vx: e.vx, vy: e.vy, facing: e.facing, size: e.size,
        health: e.health, needs: e.needs, emotion: e.emotion, brain: e.brain, sprite: e.sprite, glow: e.glow,
        doing: doingOf(world, e), said: e.said, bitAt: e.bitAt, gen: e.gen,
        age: ageOf(world, e), lifespan: e.lifespan, leaving: e.leaving, thought: e.thought,
        carrying: e.carrying ? SANDS.find((c) => c.name === e.carrying).color : null,
      };
      if (full) Object.assign(v, {
        persona: { personality: e.persona.personality, desire: e.persona.desire, philosophy: e.persona.philosophy, temperament: e.persona.temperament },
        origins: glimmers(e),
        article: e.article && { title: e.article.title, url: e.article.url },
        predecessorName: e.predecessorName, kills: e.kills,
        plan: e.plan.map((a) => describeAction(world, a)), reasoning: e.reasoning.slice(-500),
        memory: e.memory.slice(-6).map((m) => ({ at: m.at, text: recall(m) })),
        teachings: e.lore.map((k) => ({ k, l: world.lore.get(k.id) })).filter(({ l }) => l).map(({ k, l }) => ({ id: l.id, text: l.text, stance: k.stance, mine: k.from === 'yourself' })),
      });
      return v;
    }
    case 'plant': {
      const v = { id: e.id, kind: e.kind, x: e.x, y: e.y, growth: e.growth, food: e.food, state: e.state, wither: e.wither, fade: e.fade };
      if (full) Object.assign(v, { name: e.name, genome: e.genome, gen: e.gen, parents: e.parents ?? [], given: e.given, age: e.age });
      return v;
    }
    case 'urchin':
      return { id: e.id, kind: e.kind, x: e.x, y: e.y, hue: e.hue, state: e.state, carrier: e.state === 'carried' ? byId(world, e.carriedBy, 'fish')?.name : null, falls: e.falls };
    case 'corpse':
      return { id: e.id, kind: e.kind, x: e.x, y: e.y, name: e.name, size: e.size, facing: e.facing, sprite: e.sprite, glow: e.glow, food: e.food, age: e.age, cause: e.cause, gen: e.gen };
  }
}

export function snapshot(world, full = false) {
  const m = world.mandala;
  const mandala = full
    ? { number: m.number, rev: m.rev, cells: m.cells, completedAt: m.completedAt, makers: m.makers, past: world.mandalas.length }
    : { number: m.number, rev: m.rev };
  return { t: 'snap', full, time: world.time, mandala, entities: world.entities.map((e) => view(world, e, full)) };
}

// Everything needed to pick the world back up after a restart (teachings live in the store).
export function serialize(world) {
  return JSON.stringify({
    version: 2, time: world.time, nextId: world.nextId, nextLoreId: world.nextLoreId, arrivals: world.arrivals, entities: world.entities,
    mandala: world.mandala, mandalas: world.mandalas,
  });
}

export function restore(store, json, lore) {
  const data = JSON.parse(json);
  if (data.version !== 2) return null; // an older kind of tank
  const world = createWorld(store, { empty: true });
  Object.assign(world, { time: data.time, nextId: data.nextId, nextLoreId: data.nextLoreId, arrivals: data.arrivals, entities: data.entities, lastSpore: data.time });
  if (data.mandala) Object.assign(world, { mandala: data.mandala, mandalas: data.mandalas ?? [] });
  addUrchins(world);
  for (const u of world.entities) if (u.kind === 'urchin' && u.state === 'carried') Object.assign(u, { state: 'falling', carriedBy: null });
  for (const l of lore) world.lore.set(l.id, l);
  for (const l of lore) world.nextLoreId = Math.max(world.nextLoreId, l.id + 1);
  for (const a of world.arrivals) if (a.status !== 'ready') a.status = 'new';
  for (const f of fishes(world)) {
    Object.assign(f, { awaiting: null, rethink: false, rethinkAt: null, brain: 'waking', plan: [], action: f.leaving ? f.action : null, nextThinkAt: world.time + 2 + Math.random() * 3 });
  }
  return world;
}
