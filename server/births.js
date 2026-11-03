// Prepares each newcomer before it swims in: a random Wikipedia article, a personality the mind
// invents from it (name, voice, desire, philosophy, memories), and a portrait from the pool.
// Any step can fail; the sim lets a plain newcomer in if an empty place waits too long.
import { randomArticle } from './wiki.js';
import { fishArt } from './art.js';
import { arrivalReady } from './sim.js';

const PERSONA_TIMEOUT = 120_000;
const RETRY_MS = 30_000; // after a failed attempt, before trying a newcomer again
// A nudge for each newcomer, so a tank of fish doesn't all come out alike.
const TEMPERAMENTS = ['gentle', 'bold', 'fierce', 'timid', 'sly', 'playful', 'solemn'];

export function createBirths(world, { spriteDir, log = console.log }) {
  const waiting = new Map(); // arrival id -> resolve(persona)
  const busy = new Set();

  function askMind(arr, article) {
    if (!world.mind) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(arr.id); resolve(null); }, PERSONA_TIMEOUT);
      waiting.set(arr.id, (p) => { clearTimeout(timer); resolve(p); });
      world.mind.send({
        t: 'birth', id: arr.id, generation: arr.gen, temperament: TEMPERAMENTS[Math.floor(Math.random() * TEMPERAMENTS.length)],
        article: { title: article.title, text: article.text },
        predecessor: arr.predecessorPersona && {
          name: arr.predecessorName, personality: arr.predecessorPersona.personality,
          philosophy: arr.predecessorPersona.philosophy,
          teachings: arr.lore.map((l) => world.lore.get(l.id)?.text).filter(Boolean),
        },
      });
    });
  }

  async function prepare(arr) {
    if (busy.has(arr.id)) return;
    busy.add(arr.id);
    try {
      arr.status = 'reading';
      const article = arr.article ?? (await randomArticle().catch((e) => (log(`arrival #${arr.id}: no article (${e.message})`), null)));
      arr.article = article;
      arr.status = 'dreaming';
      const persona = arr.persona ?? (article ? await askMind(arr, article) : null);
      if (persona) arr.persona = persona;
      // It may have swum in plain while it was being imagined; then there's nothing left to draw.
      if (!world.arrivals.includes(arr)) return;
      let art = null;
      if (persona) {
        arr.status = 'forming';
        art = await fishArt(spriteDir).catch((e) => (log(`arrival #${arr.id}: no art (${e.message})`), null));
      }
      if (persona) {
        arrivalReady(world, arr.id, { persona, article, ...art });
        log(`arrival #${arr.id}: ${persona.name}, from "${article?.title}"${art ? '' : ' (no art)'}`);
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
