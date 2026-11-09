// Builds and serves the client of the simulation named in sims/live.js. In dev, the websocket and the
// simulation's files are proxied to the host on :8080.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIM_DIR, loadSim } from './sims/live.js';

const sim = await loadSim();
const proxied = Object.keys(sim.files ?? {}).map((prefix) => [prefix.replace(/\/$/, ''), { target: 'http://localhost:8080' }]);

export default {
  root: path.join(SIM_DIR, 'client'),
  build: { outDir: fileURLToPath(new URL('./dist', import.meta.url)), emptyOutDir: true },
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      ...Object.fromEntries(proxied),
    },
  },
};
