// The night garden: fireflies working out what the moon is, as a simulation the host
// (server/index.js) can run. See sims/live.js for what a simulation provides.
export default {
  name: 'garden',
  // Shown over the garden, frozen as it was left, while it's paused.
  sleeping: 'the garden is sleeping… check back soon',
  // The mind (mind/main.py), run from this directory by `npm run dev`. In production it's its own service.
  mind: ['uv', 'run', '--project', 'mind', 'python', 'mind/main.py'],
  create: async (host) => (await import('./server/index.js')).create(host),
};
