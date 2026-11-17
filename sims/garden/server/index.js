// The garden as the host runs it (server/index.js at the repo root): the garden stepping, what its
// observers are sent, the newcomers, the mind's turns, and the garden saved to SQLite.
import path from 'node:path';
import { createWorld, restore, serialize, step, snapshot, applyPlan, mindLost, hearThinking, compendium } from './sim.js';
import { openStore } from './store.js';
import { createSnapshots, createCompendium } from './delta.js';
import { createBirths } from './births.js';

const TICK_HZ = 20;
const SEND_HZ = 10;
const SAVE_SECS = 15;
const RISEN = 12; // fireflies that last rose, listed in the Codex

export function create({ dataDir, broadcast, log }) {
  const store = openStore(path.join(dataDir, 'garden.db'));
  const saved = store.loadWorld();
  const resumed = saved && restore(store, saved, store.loadLore());
  const world = resumed || createWorld(store);
  log(resumed ? `resumed the garden at t=${Math.round(world.time)}s` : 'planted a new garden');

  // What observers hold, as deltas (delta.js): the garden 10 times a second, the book and the
  // fireflies that rose whenever they change. The garden is taken once up front, so it can be shown
  // before it runs (or when it's paused and never does).
  const snapshots = createSnapshots();
  snapshots.next(snapshot(world));
  const book = createCompendium();
  let departed = null; // the last 'departed' message
  // Only what the Codex and a risen firefly's entry show (the persona's voice is for the mind).
  const departedView = (f) => ({
    id: f.id, name: f.name, gen: f.gen, predecessorName: f.predecessorName, diedAt: f.diedAt, cause: f.cause, glow: f.glow, flash: f.flash,
    article: f.article && { title: f.article.title, url: f.article.url, by: f.article.by }, composed: f.composed, sown: f.sown,
    persona: f.persona && { personality: f.persona.personality, desire: f.persona.desire, hunch: f.persona.hunch, temperament: f.persona.temperament, memories: f.persona.memories },
  });
  function culture() {
    const c = book.next(compendium(world));
    if (c) broadcast(c);
    const { recent, total } = store.departed(RISEN);
    const d = JSON.stringify({ t: 'departed', total, recent: recent.map(departedView) });
    if (d !== departed) broadcast((departed = d));
  }
  culture();

  // Everything notable that happens goes into the chronicle in the store (and to the log).
  world.emit = (ev) => {
    const entry = { ...ev, at: world.time, wall: Date.now() };
    store.event(entry);
    if (['arrive', 'depart', 'spiral', 'sky', 'sow', 'uproot'].includes(ev.kind)) log(`[garden] ${ev.text}`);
    else if (ev.kind === 'lore') log(`[garden] ${ev.name} ${ev.refinesBy ? `reworked ${ev.refinesBy}'s myth` : 'set down a myth'} (${ev.theme}): ${ev.text}`);
  };

  const births = createBirths(world, { log });
  const timers = [];

  return {
    welcome: () => [snapshots.full(), book.full(), departed].filter(Boolean),

    start() {
      timers.push(
        setInterval(() => step(world, 1 / TICK_HZ), 1000 / TICK_HZ),
        setInterval(() => broadcast(snapshots.next(snapshot(world))), 1000 / SEND_HZ),
        setInterval(culture, 3000),
        setInterval(() => births.tend(), 2000),
        setInterval(() => store.saveWorld(serialize(world)), SAVE_SECS * 1000),
      );
    },

    // One trusted service that receives perception and answers with decisions. The newest connection
    // wins, so restarting the mind service just takes over.
    mind(ws, req) {
      if (world.mind) {
        world.mind.ws.close(4000, 'replaced by a newer mind');
        mindLost(world); // the old mind won't answer what it was asked, so ask again
      }
      const mind = { ws, send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)) };
      world.mind = mind;
      log(`mind connected from ${req.socket.remoteAddress}`);
      births.tend();
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg.t === 'thinking') return hearThinking(world, msg);
        if (msg.t === 'born') return births.born(msg);
        if (msg.t !== 'plan') return;
        const ok = applyPlan(world, msg);
        const name = world.entities.find((e) => e.id === msg.id)?.name ?? `#${msg.id}`;
        const acts = (msg.actions ?? []).map((a) => `${a.type}(${Object.entries(a).filter(([k]) => k !== 'type').map(([, v]) => v).join(',')})`);
        log(`[mind] ${name}${ok ? '' : ' (ignored)'} ${acts.join(' ')} | ${msg.feeling ?? '-'}${msg.say?.text ? ` | says${msg.say.to ? ` to ${msg.say.to}` : ''}: ${msg.say.text}` : ''}`);
      });
      ws.on('close', () => {
        if (world.mind !== mind) return;
        world.mind = null;
        mindLost(world);
        log('mind disconnected; fireflies act on instinct');
      });
    },

    save: () => store.saveWorld(serialize(world)),
    close() {
      for (const t of timers) clearInterval(t);
      store.close();
    },
  };
}
