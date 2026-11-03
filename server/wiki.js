// Random Wikipedia articles, the seed of every fish's personality. Requests go out one at a time,
// at most one every 2 seconds, however many eggs are waiting.
const GAP_MS = 2000;
const MAX_CHARS = 3500;
const API = 'https://en.wikipedia.org/w/api.php?action=query&generator=random&grnnamespace=0&prop=extracts|info' +
  '&explaintext=1&inprop=url&format=json&formatversion=2';
const UA = 'LanguageBasedLifeforms/0.2 (https://github.com/dariushoule/language-based-lifeforms)';

let chain = Promise.resolve();
let last = 0;

export function randomArticle() {
  const run = chain.then(async () => {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(API, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`wikipedia: ${res.status}`);
    const page = (await res.json()).query.pages[0];
    // Stop at the reference sections; they say nothing about the subject.
    const text = (page.extract ?? '').split(/\n==\s*(See also|References|External links|Notes|Further reading)\s*==/)[0]
      .replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CHARS);
    return { title: page.title, url: page.fullurl, text };
  });
  chain = run.catch(() => {});
  return run;
}
