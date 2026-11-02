export default {
  server: { proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } } },
};
