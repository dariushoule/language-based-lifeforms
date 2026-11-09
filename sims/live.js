// Which simulation runs, and whether it's paused. Each one lives in sims/<name>, and the host
// (server/index.js), the client build (vite.config.js) and `npm run dev` all run the one named here.
//
// A paused simulation is loaded as it was left and shown frozen, under its `sleeping` note: it
// doesn't step or save, and minds are turned away. SIM and PAUSED in the environment (or .env)
// override this, e.g. PAUSED=0 to run it locally anyway. Pausing or waking only needs a restart;
// switching to another simulation also needs the client rebuilt.
//
// A simulation's index.js exports:
//   name        what the logs call it
//   sleeping    the note shown over it while it's paused
//   files       optional { '/url-prefix/': 'dir under DATA_DIR' }, served by the host and cached for good
//   mind        optional command (run from the sim's directory) that `npm run dev` starts beside it
//   create(host) -> the running simulation, given host = { dataDir, broadcast(message), log }:
//     welcome()   messages (strings) a new observer is sent, so it holds what the others do
//     start()     begin stepping, broadcasting and saving; never called while paused
//     mind(ws, req)  a mind connected on /mind (already authorized with MIND_TOKEN)
//     save()      persist now (on shutdown)
//     close()     stop and let go of everything
// and its client/ is the web page, which gets observers' messages on /ws. While paused, every
// observer is first sent {"t":"paused","text":<sleeping>}, then the welcome, and nothing after.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LIVE = { sim: 'aquarium', paused: true };

try { process.loadEnvFile('.env'); } catch {}
const env = (k) => process.env[k]?.trim() || null;

export const SIM = env('SIM') ?? LIVE.sim;
if (!/^[a-z0-9-]+$/.test(SIM)) throw new Error(`SIM must name a directory in sims/, not ${JSON.stringify(SIM)}`);
export const PAUSED = env('PAUSED') == null ? LIVE.paused : !['0', 'false', 'no', 'off'].includes(env('PAUSED').toLowerCase());
export const SIM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), SIM);

export const loadSim = async () => (await import(pathToFileURL(path.join(SIM_DIR, 'index.js')).href)).default;
