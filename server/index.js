// The host: runs the simulation named in sims/live.js and serves it. It serves the built client and
// the simulation's files over HTTP, streams to any number of read-only observers on /ws, and hands
// the trusted mind (bearer MIND_TOKEN) to the simulation on /mind. A paused simulation is shown as it
// was left, under its note, and never runs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { SIM, PAUSED, loadSim } from '../sims/live.js';

const PORT = Number(process.env.PORT ?? 8080);
const SLOW_VIEWER = 8 * 1024 * 1024; // bytes queued for an observer before it's dropped (it reconnects and resyncs)
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? 'dist');
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const MIND_TOKEN = process.env.MIND_TOKEN ?? '';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.svg': 'image/svg+xml' };

const viewers = new WebSocketServer({ noServer: true });
const broadcast = (s) => {
  for (const ws of viewers.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    // Deltas can't be skipped, so an observer that can't keep up is dropped; it reconnects and resyncs.
    if (ws.bufferedAmount > SLOW_VIEWER) ws.terminate();
    else ws.send(s);
  }
};

const sim = await loadSim();
const running = await sim.create({ dataDir: DATA_DIR, broadcast, log: console.log });
const paused = PAUSED && JSON.stringify({ t: 'paused', text: sim.sleeping ?? 'paused… check back soon' });

viewers.on('connection', (ws) => {
  if (paused) ws.send(paused);
  for (const m of running.welcome()) ws.send(m);
});

// The built client, and the simulation's own files (cached for good, since their names never change).
// In dev Vite serves the client and proxies the rest here.
const files = Object.entries(sim.files ?? {}).map(([prefix, dir]) => [prefix, path.join(DATA_DIR, dir)]);
function serveFile(res, root, rel, cache = {}) {
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', ...cache }).end(data);
  });
}
// A request's path, or null if its target can't be parsed. `new URL` throws on targets such as '//['
// (read as a host), and an exception here would take the whole host down.
function pathOf(req) {
  try { return new URL(req.url, 'http://x').pathname; } catch { return null; }
}
const server = http.createServer((req, res) => {
  const pathname = pathOf(req);
  if (pathname == null) return res.writeHead(400).end();
  for (const [prefix, dir] of files) {
    if (pathname.startsWith(prefix)) return serveFile(res, dir, pathname.slice(prefix.length), { 'cache-control': 'public, max-age=31536000, immutable' });
  }
  serveFile(res, STATIC_DIR, pathname === '/' ? 'index.html' : pathname);
});

// Minds: one trusted service, which the simulation talks to as it likes. A paused one takes none.
const minds = new WebSocketServer({ noServer: true });
minds.on('connection', (ws, req) => running.mind(ws, req));
function authorized(req) {
  const got = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${MIND_TOKEN}`);
  return MIND_TOKEN && got.length === want.length && crypto.timingSafeEqual(got, want);
}
let turnedAway = false;
server.on('upgrade', (req, socket, head) => {
  const pathname = pathOf(req);
  if (pathname === '/ws') return viewers.handleUpgrade(req, socket, head, (ws) => viewers.emit('connection', ws, req));
  if (pathname === '/mind' && authorized(req)) {
    if (!paused) return minds.handleUpgrade(req, socket, head, (ws) => minds.emit('connection', ws, req));
    if (!turnedAway) console.log(`turned a mind away: the ${SIM} is paused`);
    turnedAway = true;
    return socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
  }
  socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
});

if (!paused) running.start();

function shutdown() {
  if (!paused) running.save();
  running.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// HOST=127.0.0.1 keeps it private behind a reverse proxy (as in production); by default it listens everywhere.
server.listen(PORT, process.env.HOST, () => console.log(`lbl ${sim.name} on :${PORT}${paused ? ' (paused: shown as it was left, not running)' : MIND_TOKEN ? '' : ' (MIND_TOKEN unset: minds disabled)'}`));
