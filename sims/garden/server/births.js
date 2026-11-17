// Prepares each newcomer before it kindles: a random text (server/texts.js) and a personality the
// mind invents from it (name, voice, desire, a hunch about the moon, memories of the soil).
// Any step can fail; the sim lets a plain newcomer in if an empty place waits too long.
import { randomText } from './texts.js';
import { arrivalReady } from './sim.js';

const PERSONA_TIMEOUT = 120_000;
const RETRY_MS = 30_000; // after a failed attempt, before trying a newcomer again
// A nudge for each newcomer, so a garden of fireflies doesn't all come out alike.
const TEMPERAMENTS = ['gentle', 'bold', 'skeptical', 'timid', 'sly', 'playful', 'solemn', 'devout'];

export function createBirths(world, { log = console.log }) {
  const waiting = new Map(); // arrival id -> resolve(persona)
  const busy = new Set();

  function askMind(arr, article) {
    if (!world.mind) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(arr.id); resolve(null); }, PERSONA_TIMEOUT);
      waiting.set(arr.id, (p) => { clearTimeout(timer); resolve(p); });
      world.mind.send({
        t: 'birth', id: arr.id, generation: arr.gen, temperament: TEMPERAMENTS[Math.floor(Math.random() * TEMPERAMENTS.length)],
        article: { kind: article.kind, title: article.title, by: article.by, text: article.text },
        // Names lately used here, and the ones chosen for newcomers still waiting: no two alike.
        names_taken: [...new Set([...world.names, ...world.arrivals.map((a) => a.persona?.name).filter(Boolean)])],
        predecessor: arr.predecessorName && {
          name: arr.predecessorName,
          myth: arr.lore.map((l) => world.lore.get(l.id)?.text).find(Boolean) ?? null,
        },
      });
    });
  }

  async function prepare(arr) {
    if (busy.has(arr.id)) return;
    busy.add(arr.id);
    try {
      arr.status = 'reading';
      const article = arr.article ?? (await randomText().catch((e) => (log(`arrival #${arr.id}: no text (${e.message})`), null)));
      arr.article = article;
      arr.status = 'dreaming';
      const persona = arr.persona ?? (article ? await askMind(arr, article) : null);
      if (persona) {
        // It may have kindled plain while it was being imagined; then there's nothing left to do.
        if (arrivalReady(world, arr.id, { persona, article })) log(`arrival #${arr.id}: ${persona.name}, from "${article?.title}"`);
      } else {
        arr.status = 'waiting';
        arr.retryAt = Date.now() + RETRY_MS;
      }
    } finally {
      busy.delete(arr.id);
    }
  }

  return {
    // The mind's answer to a birth request.
    born(msg) {
      const resolve = waiting.get(msg.id);
      if (!resolve) return;
      waiting.delete(msg.id);
      resolve(msg.persona && typeof msg.persona.name === 'string' ? msg.persona : null);
    },
    // Newcomers that still need preparing (new ones, ones whose mind wasn't there, and after a restart).
    tend() {
      for (const a of world.arrivals) if (a.status !== 'ready' && !busy.has(a.id) && (a.status === 'new' || (world.mind && Date.now() >= (a.retryAt ?? 0)))) prepare(a);
    },
  };
}
