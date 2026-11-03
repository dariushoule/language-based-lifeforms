// Authoritative world simulation. Runs headless; clients only render snapshots.
// Units: 1 world unit = 1 art pixel. Y grows downward (matches Phaser).
//
// LBLs act through a queue of high-level actions (walk, chop, place, take, rest) that the sim
// executes tick by tick. A mind (server/index.js relays to the mind service over /mind) fills the
// queue with a plan; when no mind is connected or it is too slow, a simple instinct does.

export const WORLD = { width: 640, height: 360, groundY: 300, gravity: 900, cell: 8 };

const CELL = WORLD.cell;
const COLS = WORLD.width / CELL;
const WALK_SPEED = 40;     // px/s
const CARRY_LIMIT = 8;     // wood blocks
const CHOP_SECS = 2.5;     // per block of wood
const REGROW_SECS = 90;    // per block of wood, once a tree has been chopped
const MAX_STACK = 12;      // blocks per column
const REACH_UP = 40;       // px above the feet a block's top may be placed at (5 blocks)
const REACH_DOWN = 24;     // px below the feet a column's top may be worked at (3 blocks)
const THINK_GAP = 2;       // s between finishing a plan and asking for the next
const FAIL_GAP = 5;        // s to pause after an action fails
const MIND_TIMEOUT = 300;  // s before a silent mind is ignored and instinct takes over (thinking is slow)
const MEMORY = 40;         // remembered events per LBL
const REASONING_KEEP = 4000; // chars of streamed reasoning kept per LBL
const PLAN_MAX = 8;        // actions per plan

export const ACTIONS = ['walk_to', 'chop_tree', 'place_block', 'take_block', 'rest'];
export const FEELINGS = ['curious', 'happy', 'uneasy', 'lonely', 'sleepy'];

let nextId = 1;

export function createLBL(world, x) {
  return {
    id: nextId++,
    kind: 'lbl',
    name: 'Ada',
    x, y: 40,                // bottom-center anchor (feet)
    vx: 0, vy: 0,
    w: 16, h: 24,
    grounded: false,
    blocked: false,
    bornAt: Date.now(),
    sprite: 'lbl_body',
    // Humanoid drives, 0..1 (1 = fully satisfied)
    needs: { energy: 0.9, hunger: 0.8, social: 0.5, meaning: 0.1 },
    emotion: 'curious',
    feeling: null,           // what the mind says it feels; needs can override it
    background:
      'The first of its kind. Woke up on bare ground with no memory and a vague sense ' +
      'that it ought to be wearing something.',
    thought: 'Where am I?',
    reasoning: '',           // the mind's private reasoning for the latest decision, streamed in
    carrying: { wood: 0 },
    plan: [],                // queued actions
    action: null,            // the action being executed, with its progress
    brain: 'waking',         // 'mind' | 'instinct' | 'thinking' | 'waking'
    seq: 0,                  // id of the latest decision request, so stale plans are ignored
    awaiting: null,          // world time the pending decision was requested
    nextThinkAt: world.time + 1,
    home: Math.min(WORLD.width - 48, x + 40), // where instinct piles its wood
    memory: [],
  };
}

function createTree(x) {
  return {
    id: nextId++, kind: 'tree', x, y: WORLD.groundY, sprite: 'tree',
    wood: 5, maxWood: 5, regrow: 0, given: 0, choppedBy: null,
    background: 'A broad-leafed tree. Its wood comes away in neat square blocks.',
  };
}

export function createWorld() {
  const world = { tick: 0, time: 0, entities: [], cols: new Array(COLS).fill(0), blocks: new Map(), mind: null };
  for (const x of [56, 150, 470, 548, 612]) world.entities.push(createTree(x));
  world.entities.push(createLBL(world, WORLD.width / 2));
  return world;
}

// ---------- world queries ----------

const lbls = (world) => world.entities.filter((e) => e.kind === 'lbl');
const trees = (world) => world.entities.filter((e) => e.kind === 'tree');
const colOf = (x) => Math.max(0, Math.min(COLS - 1, Math.floor(x / CELL)));
const colCenter = (c) => c * CELL + CELL / 2;
const colTop = (world, c) => WORLD.groundY - world.cols[c] * CELL;

// Columns are contiguous stacks from the ground (only the top block can be placed or taken),
// so each is one solid rectangle from its top down to the ground.
function solidBox(world, x0, y0, x1, y1) {
  if (y1 > WORLD.groundY + 1e-6 || x0 < 0 || x1 > WORLD.width) return true;
  for (let c = Math.floor(x0 / CELL); c <= Math.ceil(x1 / CELL) - 1; c++)
    if (world.cols[c] && y1 > colTop(world, c) + 1e-6) return true;
  return false;
}
const solidAt = (world, e, x, y) => solidBox(world, x - e.w / 2, y - e.h, x + e.w / 2, y);

// Highest surface under an entity's footprint: the ground or the tallest column it overlaps.
function floorUnder(world, e, x = e.x) {
  let floor = WORLD.groundY;
  for (let c = Math.floor((x - e.w / 2) / CELL); c <= Math.ceil((x + e.w / 2) / CELL) - 1; c++)
    if (c >= 0 && c < COLS) floor = Math.min(floor, colTop(world, c));
  return floor;
}

function overlapsColumn(e, c, x = e.x) {
  return x + e.w / 2 > c * CELL && x - e.w / 2 < (c + 1) * CELL;
}

const heightAt = (y) => Math.round((WORLD.groundY - y) / CELL);

// The tallest column under the footprint at x: what you'd stand on, or bump into.
function tallestUnder(world, e, x) {
  let best = -1;
  for (let c = Math.floor((x - e.w / 2) / CELL); c <= Math.ceil((x + e.w / 2) / CELL) - 1; c++)
    if (c >= 0 && c < COLS && (best < 0 || world.cols[c] > world.cols[best])) best = c;
  return best;
}

// Why walking onto x from height h is impossible, in words an LBL would use.
function tooTall(world, e, x, h) {
  const c = tallestUnder(world, e, x);
  if (c < 0 || world.cols[c] <= h + 1) return 'something is in my way';
  return `the stack at x=${colCenter(c)} is ${world.cols[c]} high and I'm at height ${h}; I can only step up 1`;
}

// How far an LBL could walk each way right now, following the same rules as physics(): step up at
// most one block, drop any distance. This is what it would see at a glance, so minds get it too.
function walkRange(world, e) {
  const probe = (dir) => {
    let x = Math.round(e.x), y = e.y;
    for (;;) {
      const nx = x + dir;
      if (nx < e.w / 2 || nx > WORLD.width - e.w / 2) return { x, stop: 'the edge of the world' };
      const floor = floorUnder(world, e, nx);
      if (floor < y - CELL - 1e-6) return { x, stop: tooTall(world, e, nx, heightAt(y)) };
      x = nx; y = floor;
    }
  };
  return { left: probe(-1), right: probe(1) };
}

// A repeat of the latest memory just bumps its count, so a stuck LBL can't flood its memory.
function remember(world, e, text) {
  const last = e.memory.at(-1);
  if (last?.text === text) { last.at = world.time; last.n = (last.n ?? 1) + 1; return; }
  e.memory.push({ at: world.time, text });
  if (e.memory.length > MEMORY) e.memory.shift();
}
const recall = (m) => (m.n > 1 ? `${m.text} (${m.n} times)` : m.text);

// ---------- physics ----------

function physics(world, e, dt) {
  e.blocked = false;
  if (e.vx) {
    const nx = e.x + e.vx * dt;
    if (!solidAt(world, e, nx, e.y)) e.x = nx;
    else if (e.grounded && floorUnder(world, e, nx) >= e.y - CELL && !solidAt(world, e, nx, floorUnder(world, e, nx))) {
      e.x = nx;                       // step up onto a single block
      e.y = floorUnder(world, e, nx);
    } else { e.blocked = true; e.blockedAt = nx; }
  }
  const floor = floorUnder(world, e);
  e.vy += WORLD.gravity * dt;
  if (e.y + e.vy * dt >= floor) { e.y = floor; e.vy = 0; e.grounded = true; }
  else { e.y += e.vy * dt; e.grounded = false; }
}

// ---------- actions ----------

// Moves toward x; true once there, or once a wall stops us if we're already closeEnough().
// Otherwise a wall fails the action.
function approach(world, e, x, dt, closeEnough) {
  const dx = x - e.x;
  if (Math.abs(dx) < 0.01) { e.x = x; e.vx = 0; return true; }
  if (e.blocked && closeEnough?.()) { e.vx = 0; return true; }
  if (e.blocked) throw new Error(tooTall(world, e, e.blockedAt, heightAt(e.y)));
  // The last step is sized to land exactly on x (it still goes through collision).
  e.vx = Math.sign(dx) * Math.min(WALK_SPEED, Math.abs(dx) / dt);
  return false;
}

// Arms reach over one neighboring column: the gap between our side and column c may be one cell.
function inReach(e, c) {
  const gap = e.x < colCenter(c) ? c * CELL - (e.x + e.w / 2) : e.x - e.w / 2 - (c + 1) * CELL;
  return gap >= 0 && gap <= CELL + 1;
}

// Where to stand to work on column c: beside it, on the side nearer to where we are.
function standBeside(e, c) {
  const off = CELL / 2 + e.w / 2 + 1;
  const left = colCenter(c) - off, right = colCenter(c) + off;
  const ok = (x) => x >= e.w / 2 && x <= WORLD.width - e.w / 2;
  if (!ok(left)) return right;
  if (!ok(right)) return left;
  return Math.abs(e.x - left) <= Math.abs(e.x - right) ? left : right;
}

const RUN = {
  walk_to(world, e, a, dt) {
    return approach(world, e, a.x, dt);
  },

  chop_tree(world, e, a, dt) {
    const tree = world.entities.find((t) => t.id === a.tree_id && t.kind === 'tree');
    if (!tree) throw new Error(`there is no tree #${a.tree_id}`);
    if (e.carrying.wood >= CARRY_LIMIT) {
      if (a.got) return true;
      throw new Error(`my arms are full (${CARRY_LIMIT} wood)`);
    }
    if (tree.wood <= 0) {
      if (a.got) return true;
      throw new Error(`tree #${tree.id} is only a stump now`);
    }
    a.stand ??= Math.abs(e.x - (tree.x - 12)) < Math.abs(e.x - (tree.x + 12)) ? tree.x - 12 : tree.x + 12;
    // Anywhere within arm's reach of the trunk will do if blocks stand where we'd like to be.
    if (!approach(world, e, a.stand, dt, () => Math.abs(e.x - tree.x) <= 20)) return false;
    tree.choppedBy = e.id;
    a.work = (a.work ?? 0) + dt;
    if (a.work < CHOP_SECS) return false;
    a.work = 0;
    tree.wood--; tree.given++;
    e.carrying.wood++;
    a.got = (a.got ?? 0) + 1;
    e.needs.energy = Math.max(0, e.needs.energy - 0.03);
    e.needs.meaning = Math.min(1, e.needs.meaning + 0.01);
    if (a.got >= a.amount || tree.wood <= 0 || e.carrying.wood >= CARRY_LIMIT) {
      remember(world, e, `chopped ${a.got} wood from tree #${tree.id}${tree.wood ? '' : ', leaving a stump'}`);
      return true;
    }
    return false;
  },

  place_block(world, e, a, dt) {
    const c = colOf(a.x);
    if (e.carrying.wood <= 0) throw new Error('I have no wood to place');
    if (world.cols[c] >= MAX_STACK) throw new Error(`the stack at x=${colCenter(c)} is as tall as it can get`);
    a.stand ??= standBeside(e, c);
    if (!approach(world, e, a.stand, dt, () => inReach(e, c))) return false;
    const top = colTop(world, c) - CELL;
    if (top < e.y - REACH_UP) throw new Error(`the top of the stack at x=${colCenter(c)} is out of reach from here`);
    if (colTop(world, c) > e.y + REACH_DOWN) throw new Error(`the ground at x=${colCenter(c)} is too far below me`);
    for (const o of lbls(world)) if (overlapsColumn(o, c) && o.y > top && o.y - o.h < top + CELL)
      throw new Error(`${o.id === e.id ? 'I am' : `${o.name} is`} standing where the block would go`);
    const row = world.cols[c]++;
    const block = {
      id: nextId++, kind: 'block', sprite: 'wood_block', col: c, row,
      x: colCenter(c), y: WORLD.groundY - row * CELL,
      placedBy: e.name, placedAt: Date.now(),
    };
    world.blocks.set(`${c},${row}`, block);
    world.entities.push(block);
    e.carrying.wood--;
    e.needs.meaning = Math.min(1, e.needs.meaning + 0.04);
    remember(world, e, `placed a wood block at x=${block.x} (that stack is now ${world.cols[c]} high)`);
    return true;
  },

  take_block(world, e, a, dt) {
    const c = colOf(a.x);
    if (!world.cols[c]) throw new Error(`there are no blocks at x=${colCenter(c)}`);
    if (e.carrying.wood >= CARRY_LIMIT) throw new Error(`my arms are full (${CARRY_LIMIT} wood)`);
    a.stand ??= standBeside(e, c);
    if (!approach(world, e, a.stand, dt, () => inReach(e, c))) return false;
    if (colTop(world, c) < e.y - REACH_UP) throw new Error(`the top of the stack at x=${colCenter(c)} is out of reach from here`);
    const row = --world.cols[c];
    const block = world.blocks.get(`${c},${row}`);
    world.blocks.delete(`${c},${row}`);
    world.entities.splice(world.entities.indexOf(block), 1);
    e.carrying.wood++;
    remember(world, e, `took the top block from the stack at x=${colCenter(c)}`);
    return true;
  },

  rest(world, e, a, dt) {
    e.vx = 0;
    a.left = (a.left ?? a.seconds) - dt;
    e.needs.energy = Math.min(1, e.needs.energy + 0.03 * dt);
    if (a.left > 0) return false;
    remember(world, e, `rested for ${a.seconds}s`);
    return true;
  },
};

// Plans come from outside the sim, so every action is checked and clamped here.
export function normalizeAction(raw) {
  if (!raw || !ACTIONS.includes(raw.type)) return null;
  const num = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : dflt);
  switch (raw.type) {
    case 'walk_to': return { type: 'walk_to', x: num(raw.x, 8, WORLD.width - 8, null) };
    case 'chop_tree': return { type: 'chop_tree', tree_id: num(raw.tree_id, 0, 1e9, null), amount: num(raw.amount, 1, CARRY_LIMIT, 1) };
    case 'place_block': return { type: 'place_block', x: num(raw.x, 0, WORLD.width - 1, null) };
    case 'take_block': return { type: 'take_block', x: num(raw.x, 0, WORLD.width - 1, null) };
    case 'rest': return { type: 'rest', seconds: num(raw.seconds, 3, 60, 10) };
  }
}

export function describeAction(a) {
  if (!a) return null;
  switch (a.type) {
    case 'walk_to': return `walking to x=${a.x}`;
    case 'chop_tree': return `chopping tree #${a.tree_id}${a.amount > 1 ? ` for ${a.amount} wood` : ''}`;
    case 'place_block': return `placing a block at x=${a.x}`;
    case 'take_block': return `taking a block from x=${a.x}`;
    case 'rest': return `resting`;
  }
}

// ---------- minds ----------

// What an LBL can perceive, sent to the mind with each decision request.
export function perceive(world, e) {
  const r2 = (v) => Math.round(v * 100) / 100;
  const structures = [];
  for (let c = 0; c < COLS; c++) if (world.cols[c]) structures.push({ x: colCenter(c), height: world.cols[c] });
  // The ground right around the LBL as a height profile, column by column, which is much easier
  // to reason about for stepping and stair-building than a list of stacks.
  const here = colOf(e.x);
  const terrain = [];
  for (let c = Math.max(0, here - 6); c <= Math.min(COLS - 1, here + 6); c++)
    terrain.push(`x=${colCenter(c)}: ${world.cols[c]}${overlapsColumn(e, c) ? ' (you)' : ''}`);
  return {
    you: {
      id: e.id, name: e.name, background: e.background, x: Math.round(e.x),
      height: heightAt(e.y),
      carrying_wood: e.carrying.wood, carry_limit: CARRY_LIMIT,
      needs: Object.fromEntries(Object.entries(e.needs).map(([k, v]) => [k, r2(v)])),
      feeling: e.emotion, age_seconds: Math.round((Date.now() - e.bornAt) / 1000),
    },
    world: { width: WORLD.width, block_size: CELL },
    trees: trees(world).map((t) => ({
      id: t.id, x: t.x, distance: Math.round(Math.abs(t.x - e.x)),
      ...(t.wood > 0 ? { wood: t.wood } : { stump: true, regrows_in_seconds: Math.round(REGROW_SECS - t.regrow) }),
    })),
    structures,
    block_heights_near_you: terrain.join(', '),
    can_walk: (({ left, right }) =>
      `from x=${left.x} to x=${right.x} without building. Further left: ${left.stop}. Further right: ${right.stop}.`)(walkRange(world, e)),
    others: lbls(world).filter((o) => o !== e).map((o) => ({ id: o.id, name: o.name, x: Math.round(o.x), feeling: o.emotion, doing: describeAction(o.action) })),
    memory: e.memory.slice(-12).map((m) => `${Math.round(world.time - m.at)}s ago: ${recall(m)}`),
    last_thought: e.thought,
  };
}

// Applies a plan from the mind. Returns false if it was stale or unusable.
export function applyPlan(world, msg) {
  const e = world.entities.find((x) => x.id === msg.id && x.kind === 'lbl');
  if (!e || msg.seq !== e.seq || e.awaiting == null) return false;
  e.awaiting = null;
  const actions = (Array.isArray(msg.actions) ? msg.actions : []).slice(0, PLAN_MAX).map(normalizeAction)
    .filter((a) => a && Object.values(a).every((v) => v != null));
  if (typeof msg.thought === 'string' && msg.thought.trim()) e.thought = msg.thought.trim().slice(0, 280);
  e.feeling = FEELINGS.includes(msg.feeling) ? msg.feeling : null;
  if (!actions.length) {
    remember(world, e, 'my mind went blank');
    return instinct(world, e), false;
  }
  e.plan = actions;
  e.brain = 'mind';
  return true;
}

// Reasoning streamed in while the mind works on a decision; observers see it live.
export function hearThinking(world, msg) {
  const e = world.entities.find((x) => x.id === msg.id && x.kind === 'lbl');
  if (!e || msg.seq !== e.seq || e.awaiting == null || typeof msg.text !== 'string') return;
  e.reasoning = (e.reasoning + msg.text).slice(-REASONING_KEEP);
}

// Forget pending requests (the mind disconnected); those LBLs fall back to instinct.
export function mindLost(world) {
  for (const e of lbls(world)) if (e.awaiting != null) { e.awaiting = null; e.nextThinkAt = world.time; }
}

// Fallback behavior: rest when tired, gather a few logs, then pile them up at home.
function instinct(world, e) {
  e.brain = 'instinct';
  if (e.needs.energy < 0.25) {
    e.plan = [{ type: 'rest', seconds: 20 }];
    e.thought = 'So tired.';
    return;
  }
  if (e.carrying.wood < 3) {
    const t = trees(world).filter((t) => t.wood > 0).sort((a, b) => Math.abs(a.x - e.x) - Math.abs(b.x - e.x))[0];
    if (t) {
      e.plan = [{ type: 'chop_tree', tree_id: t.id, amount: 3 - e.carrying.wood }];
      e.thought = 'Wood. I should gather some wood.';
      return;
    }
  }
  if (e.carrying.wood > 0 && world.time - (e.failedAt ?? -1e9) > 10) {
    // A pyramid around home: column c may rise to 4 - |c - home|, so every step is climbable.
    const c0 = colOf(e.home);
    const spots = [];
    for (let c = Math.max(0, c0 - 3); c <= Math.min(COLS - 1, c0 + 3); c++)
      if (world.cols[c] < 4 - Math.abs(c - c0)) spots.push(c);
    spots.sort((a, b) => world.cols[a] - world.cols[b] || Math.abs(a - c0) - Math.abs(b - c0));
    if (spots.length) {
      e.plan = [{ type: 'place_block', x: colCenter(spots[0]) }];
      e.thought = 'Put it with the others.';
      return;
    }
  }
  const x = Math.round(Math.max(16, Math.min(WORLD.width - 16, e.x + (Math.random() - 0.5) * 160)));
  e.plan = [{ type: 'walk_to', x }, { type: 'rest', seconds: 8 }];
  e.thought = 'Nothing to do but wander.';
}

function think(world, e) {
  if (world.mind) {
    e.seq++;
    e.awaiting = world.time;
    e.brain = 'thinking';
    e.reasoning = '';
    world.mind.send({ t: 'decide', id: e.id, seq: e.seq, perception: perceive(world, e) });
  } else instinct(world, e);
}

// ---------- step ----------

function stepLBL(world, e, dt) {
  // Decide when idle; a mind that stays silent too long is ignored.
  if (e.awaiting != null && world.time - e.awaiting > MIND_TIMEOUT) {
    e.awaiting = null;
    remember(world, e, 'my mind wandered and I acted on instinct');
    instinct(world, e);
  }
  if (!e.action && e.plan.length) e.action = e.plan.shift();
  if (!e.action && e.awaiting == null && world.time >= e.nextThinkAt) think(world, e);

  e.vx = 0;
  if (e.action) {
    try {
      if (RUN[e.action.type](world, e, e.action, dt)) e.action = null;
    } catch (err) {
      remember(world, e, `gave up ${describeAction(e.action)}: ${err.message}`);
      e.action = null;
      e.plan = [];          // the rest of the plan assumed this step would work
      e.vx = 0;
      e.failedAt = world.time;
    }
    if (!e.action && !e.plan.length) e.nextThinkAt = world.time + (e.failedAt === world.time ? FAIL_GAP : THINK_GAP);
  }

  physics(world, e, dt);

  const n = e.needs;
  const working = e.action && e.action.type !== 'rest';
  n.energy = Math.max(0, n.energy - dt * (working ? 0.002 : 0.0008));
  n.hunger = Math.max(0, n.hunger - dt * 0.0003); // nothing to eat yet, so this drifts slowly
  n.social = Math.max(0, n.social - dt * 0.0005);
  n.meaning = Math.max(0, n.meaning - dt * 0.0003);
  e.emotion =
    e.action?.type === 'rest' || n.energy < 0.15 ? 'sleepy'
    : n.hunger < 0.2 ? 'uneasy'
    : e.feeling ?? (n.social < 0.3 ? 'lonely' : n.meaning > 0.6 ? 'happy' : 'curious');
}

export function step(world, dt) {
  world.tick++;
  world.time += dt;
  for (const t of trees(world)) {
    t.choppedBy = null;
    if (t.wood < t.maxWood && (t.regrow += dt) >= REGROW_SECS) { t.regrow = 0; t.wood++; }
  }
  for (const e of lbls(world)) stepLBL(world, e, dt);
}

// ---------- snapshot ----------

function view(e) {
  switch (e.kind) {
    case 'lbl':
      return {
        id: e.id, kind: e.kind, name: e.name, x: e.x, y: e.y, w: e.w, h: e.h, sprite: e.sprite,
        bornAt: e.bornAt, needs: e.needs, emotion: e.emotion, background: e.background, thought: e.thought,
        carrying: e.carrying, brain: e.brain, moving: e.vx !== 0, reasoning: e.reasoning.slice(-500),
        doing: describeAction(e.action), plan: e.plan.map(describeAction),
        memory: e.memory.slice(-5).map((m) => ({ at: m.at, text: recall(m) })),
      };
    case 'tree':
      return { id: e.id, kind: e.kind, x: e.x, y: e.y, sprite: e.wood > 0 ? 'tree' : 'stump', wood: e.wood, maxWood: e.maxWood, given: e.given, choppedBy: e.choppedBy, background: e.background };
    case 'block':
      return { id: e.id, kind: e.kind, x: e.x, y: e.y, sprite: e.sprite, row: e.row, placedBy: e.placedBy, placedAt: e.placedAt };
  }
}

export function snapshot(world) {
  return { t: 'snap', tick: world.tick, time: world.time, world: WORLD, entities: world.entities.map(view) };
}
