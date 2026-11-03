import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createWorld, step, snapshot, applyPlan, mindLost } from './sim.js';

try { process.loadEnvFile('.env'); } catch {}

const PORT = Number(process.env.PORT ?? 8080);
const TICK_HZ = 20;
const SEND_HZ = 10;
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? 'dist');
const MIND_TOKEN = process.env.MIND_TOKEN ?? '';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

// Serves the built client in production; in dev Vite serves it and proxies /ws here.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(STATIC_DIR, path.normalize(url.pathname));
  if (!file.startsWith(STATIC_DIR)) return res.writeHead(403).end();
  if (url.pathname === '/') file = path.join(STATIC_DIR, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }).end(data);
  });
});

const world = createWorld();

// Observers: read-only, receive snapshots.
const viewers = new WebSocketServer({ noServer: true });
viewers.on('connection', (ws) => ws.send(JSON.stringify(snapshot(world))));

// Minds: one trusted service that receives perception and answers with plans.
// The newest connection wins, so restarting the mind service just takes over.
const minds = new WebSocketServer({ noServer: true });
function authorized(req) {
  const got = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${MIND_TOKEN}`);
  return MIND_TOKEN && got.length === want.length && crypto.timingSafeEqual(got, want);
}
minds.on('connection', (ws, req) => {
  if (world.mind) world.mind.ws.close(4000, 'replaced by a newer mind');
  const mind = { ws, send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)) };
  world.mind = mind;
  console.log(`mind connected from ${req.socket.remoteAddress}`);
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.t !== 'plan') return;
    const ok = applyPlan(world, msg);
    const acts = (msg.actions ?? []).map((a) => `${a.type}(${Object.entries(a).filter(([k]) => k !== 'type').map(([, v]) => v).join(',')})`);
    console.log(`[mind] #${msg.id}${ok ? '' : ' (ignored)'} ${acts.join(' ')} | ${msg.feeling ?? '-'} | ${msg.thought ?? ''}`);
  });
  ws.on('close', () => {
    if (world.mind !== mind) return;
    world.mind = null;
    mindLost(world);
    console.log('mind disconnected; LBLs act on instinct');
  });
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws') return viewers.handleUpgrade(req, socket, head, (ws) => viewers.emit('connection', ws, req));
  if (pathname === '/mind' && authorized(req)) return minds.handleUpgrade(req, socket, head, (ws) => minds.emit('connection', ws, req));
  socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
});

setInterval(() => step(world, 1 / TICK_HZ), 1000 / TICK_HZ);
setInterval(() => {
  const msg = JSON.stringify(snapshot(world));
  for (const ws of viewers.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}, 1000 / SEND_HZ);

server.listen(PORT, () => console.log(`lbl sim on :${PORT}${MIND_TOKEN ? '' : ' (MIND_TOKEN unset: minds disabled, instinct only)'}`));
