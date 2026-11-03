import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createWorld, restore, serialize, step, snapshot, applyPlan, mindLost, hearThinking, compendium } from './sim.js';
import { openStore } from './store.js';
import { createBirths } from './births.js';

try { process.loadEnvFile('.env'); } catch {}

const PORT = Number(process.env.PORT ?? 8080);
const TICK_HZ = 20;
const SEND_HZ = 10;
const FULL_EVERY = 10;    // every 10th snapshot (once a second) carries the heavy fields
const SAVE_SECS = 15;
const LINEAGE = 300;      // most recent fish observers are told about
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? 'dist');
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const SPRITE_DIR = path.join(DATA_DIR, 'fish');
const MIND_TOKEN = process.env.MIND_TOKEN ?? '';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

const store = openStore(path.join(DATA_DIR, 'aquarium.db'));
const saved = store.loadWorld();
const resumed = saved && restore(store, saved, store.loadLore());
const world = resumed || createWorld(store);
console.log(resumed ? `resumed the aquarium at t=${Math.round(world.time)}s` : 'filled a new aquarium');

// Serves the built client and generated fish art; in dev Vite serves the client and proxies here.
function serveFile(res, root, rel) {
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('not found');
    const cache = root === SPRITE_DIR ? { 'cache-control': 'public, max-age=31536000, immutable' } : {};
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', ...cache }).end(data);
  });
}
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname.startsWith('/fish/')) return serveFile(res, SPRITE_DIR, pathname.slice(6));
  serveFile(res, STATIC_DIR, pathname === '/' ? 'index.html' : pathname);
});

// Observers: read-only. They get the world and the culture, then live updates.
const viewers = new WebSocketServer({ noServer: true });
const broadcast = (msg) => {
  const s = JSON.stringify(msg);
  for (const ws of viewers.clients) if (ws.readyState === ws.OPEN) ws.send(s);
};
const culture = () => ({ t: 'culture', compendium: compendium(world), lineage: store.lineage(LINEAGE) });
viewers.on('connection', (ws) => {
  ws.send(JSON.stringify(snapshot(world, true)));
  ws.send(JSON.stringify(culture()));
});

// Everything notable that happens goes into the chronicle in the store (and to the log).
let cultureDirty = true;
world.emit = (ev) => {
  const entry = { ...ev, at: world.time, wall: Date.now() };
  store.event(entry);
  if (ev.kind !== 'say' && ev.kind !== 'bite') cultureDirty = true;
  if (ev.kind === 'arrive' || ev.kind === 'depart' || ev.kind === 'death') console.log(`[tank] ${ev.text}`);
  else if (ev.kind === 'lore') console.log(`[tank] ${ev.name} ${ev.refinesBy ? `reworked ${ev.refinesBy}'s teaching` : 'found a teaching'} (${ev.theme}): ${ev.text}`);
};

const births = createBirths(world, { spriteDir: SPRITE_DIR });

// Minds: one trusted service that receives perception and answers with decisions.
// The newest connection wins, so restarting the mind service just takes over.
const minds = new WebSocketServer({ noServer: true });
function authorized(req) {
  const got = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${MIND_TOKEN}`);
  return MIND_TOKEN && got.length === want.length && crypto.timingSafeEqual(got, want);
}
minds.on('connection', (ws, req) => {
  if (world.mind) {
    world.mind.ws.close(4000, 'replaced by a newer mind');
    mindLost(world); // the old mind won't answer what it was asked, so ask again
  }
  const mind = { ws, send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)) };
  world.mind = mind;
  console.log(`mind connected from ${req.socket.remoteAddress}`);
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
    console.log(`[mind] ${name}${ok ? '' : ' (ignored)'} ${acts.join(' ')} | ${msg.feeling ?? '-'}${msg.say?.text ? ` | says${msg.say.to ? ` to ${msg.say.to}` : ''}: ${msg.say.text}` : ''}`);
  });
  ws.on('close', () => {
    if (world.mind !== mind) return;
    world.mind = null;
    mindLost(world);
    console.log('mind disconnected; fish act on instinct');
  });
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws') return viewers.handleUpgrade(req, socket, head, (ws) => viewers.emit('connection', ws, req));
  if (pathname === '/mind' && authorized(req)) return minds.handleUpgrade(req, socket, head, (ws) => minds.emit('connection', ws, req));
  socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
});

let sent = 0;
setInterval(() => step(world, 1 / TICK_HZ), 1000 / TICK_HZ);
setInterval(() => broadcast(snapshot(world, sent++ % FULL_EVERY === 0)), 1000 / SEND_HZ);
setInterval(() => {
  if (!cultureDirty) return;
  cultureDirty = false;
  broadcast(culture());
}, 3000);
setInterval(() => births.tend(), 2000);
setInterval(() => store.saveWorld(serialize(world)), SAVE_SECS * 1000);

function shutdown() {
  store.saveWorld(serialize(world));
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// HOST=127.0.0.1 keeps it private behind a reverse proxy (as in production); by default it listens everywhere.
server.listen(PORT, process.env.HOST, () => console.log(`lbl aquarium on :${PORT}${MIND_TOKEN ? '' : ' (MIND_TOKEN unset: minds disabled, instinct only)'}`));
