import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createWorld, step, snapshot } from './sim.js';

const PORT = Number(process.env.PORT ?? 8080);
const TICK_HZ = 20;
const SEND_HZ = 10;
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? 'dist');

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

const wss = new WebSocketServer({ server, path: '/ws' });
const world = createWorld();

wss.on('connection', (ws) => ws.send(JSON.stringify(snapshot(world))));

setInterval(() => step(world, 1 / TICK_HZ), 1000 / TICK_HZ);
setInterval(() => {
  const msg = JSON.stringify(snapshot(world));
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}, 1000 / SEND_HZ);

server.listen(PORT, () => console.log(`lbl sim on :${PORT} (${wss.clients.size} observers)`));
