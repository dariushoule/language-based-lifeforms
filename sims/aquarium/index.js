// Language Based Lifeforms: the aquarium, as a simulation the host (server/index.js) can run.
// See sims/live.js for what a simulation provides.
export default {
  name: 'aquarium',
  // Shown over the tank, frozen as it was left, while it's paused.
  sleeping: 'the fish are sleeping… check back soon',
  // Fish portraits, drawn as fish hatch and kept in DATA_DIR/fish; their names never change.
  files: { '/fish/': 'fish' },
  // The mind (mind/main.py), run from this directory by `npm run dev`. In production it's its own service.
  mind: ['uv', 'run', '--project', 'mind', 'python', 'mind/main.py'],
  create: async (host) => (await import('./server/index.js')).create(host),
};
