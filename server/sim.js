// Authoritative world simulation. Runs headless; clients only render snapshots.
// Units: 1 world unit = 1 art pixel. Y grows downward (matches Phaser).

export const WORLD = { width: 640, height: 360, groundY: 300, gravity: 900 };

let nextId = 1;

export function createLBL(x) {
  return {
    id: nextId++,
    kind: 'lbl',
    name: 'Ada',
    x, y: 40,                // bottom-center anchor (feet)
    vx: 0, vy: 0,
    w: 16, h: 24,
    grounded: false,
    bornAt: Date.now(),
    sprite: 'lbl_body',
    // Humanoid drives, 0..1 (1 = fully satisfied)
    needs: { energy: 0.9, hunger: 0.8, social: 0.5, meaning: 0.1 },
    emotion: 'curious',
    background:
      'The first of its kind. Woke up on bare ground with no memory and a vague sense ' +
      'that it ought to be wearing something.',
    thought: 'Where am I?',
  };
}

export function createWorld() {
  return { tick: 0, time: 0, entities: [createLBL(WORLD.width / 2)] };
}

export function step(world, dt) {
  world.tick++;
  world.time += dt;
  for (const e of world.entities) {
    // Physics: gravity + flat ground. Cuboids make AABB the natural fit.
    e.vy += WORLD.gravity * dt;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    if (e.y >= WORLD.groundY) {
      e.y = WORLD.groundY;
      e.vy = 0;
      e.grounded = true;
    }
    e.x = Math.max(e.w / 2, Math.min(WORLD.width - e.w / 2, e.x));

    // Needs drift slowly; nothing satisfies them yet.
    e.needs.energy = Math.max(0, e.needs.energy - dt * 0.002);
    e.needs.hunger = Math.max(0, e.needs.hunger - dt * 0.003);
    e.needs.social = Math.max(0, e.needs.social - dt * 0.001);
    e.emotion = e.needs.hunger < 0.3 ? 'uneasy' : e.needs.social < 0.3 ? 'lonely' : 'curious';
  }
}

export function snapshot(world) {
  return { t: 'snap', tick: world.tick, time: world.time, world: WORLD, entities: world.entities };
}
