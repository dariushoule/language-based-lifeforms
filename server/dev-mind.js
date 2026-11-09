// `npm run dev:mind`: runs the live simulation's mind (sims/live.js), if it has one and isn't paused.
import { spawn } from 'node:child_process';
import { SIM, SIM_DIR, PAUSED, loadSim } from '../sims/live.js';

const sim = await loadSim();
if (!sim.mind) console.log(`the ${SIM} has no mind`);
else if (PAUSED) console.log(`the ${SIM} is paused, so its mind isn't started (PAUSED=0 runs it)`);
else {
  const [cmd, ...args] = sim.mind;
  const child = spawn(cmd, args, { cwd: SIM_DIR, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}
