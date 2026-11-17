// The text each firefly's character grows from: usually a random Wikipedia article, sometimes a
// random poem (PoetryDB), so a few of them speak in metre and refrain. Requests go out one at a
// time, at most one every 2 seconds, however many newcomers are waiting.
const GAP_MS = 2000;
const MAX_CHARS = 3500;
const POEM_CHANCE = 0.3;
const WIKI = 'https://en.wikipedia.org/w/api.php?action=query&generator=random&grnnamespace=0&prop=extracts|info' +
  '&explaintext=1&inprop=url&format=json&formatversion=2';
const POEM = 'https://poetrydb.org/random/1';
const UA = 'LanguageBasedLifeforms/0.3 (https://github.com/dariushoule/language-based-lifeforms)';

let chain = Promise.resolve();
let last = 0;

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname}: ${res.status}`);
  return res.json();
}

async function article() {
  const page = (await get(WIKI)).query.pages[0];
  // Stop at the reference sections; they say nothing about the subject.
  const text = (page.extract ?? '').split(/\n==\s*(See also|References|External links|Notes|Further reading)\s*==/)[0]
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CHARS);
  return { kind: 'article', title: page.title, url: page.fullurl, text };
}

async function poem() {
  const [p] = await get(POEM);
  const text = p.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CHARS);
  if (text.length < 200) throw new Error('too short a poem');
  return { kind: 'poem', title: p.title, by: p.author, url: null, text };
}

export function randomText() {
  const run = chain.then(async () => {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    if (Math.random() < POEM_CHANCE) { try { return await poem(); } catch { /* an article will do */ } }
    return article();
  });
  chain = run.catch(() => {});
  return run;
}
