// The Book of the Moon: a title page, contents, and one chapter per question the fireflies ask,
// laid out on facing pages that turn. Myths within a chapter run in the order they were set down,
// so a reader can watch a story get reworked from one generation to the next; each is signed with
// the moon it was set down under.
import { moonSvg } from './moon.js';

const CHAPTERS = {
  'what the moon is': 'What the Moon Is', 'why it changes': 'Why It Changes', 'where it goes': 'Where It Goes', 'what it wants': 'What It Wants of Us',
  'the stars': 'Of the Stars', 'the moon in the water': 'Of the Moon in the Water', 'our own light': 'Of Our Own Light', 'the flowers': 'Of the Flowers',
  'the dark': 'Of the Dark', 'the pale': 'Of the Pale', 'the soil': 'Of the Soil', 'the rising': 'Of the Rising',
};
const THEMES = Object.keys(CHAPTERS);
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const generation = (g) => (g <= ORDINAL.length ? `of the ${ORDINAL[g - 1]} generation` : `of generation ${g}`);
const list = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const ORN = `<div class="orn">${moonSvg(0.14, { ink: true })}</div>`;

export function createBook(root) {
  root.innerHTML = `
    <div class="tome">
      <button class="close" aria-label="Close the book">×</button>
      <div class="page left"><div class="running"></div><div class="body"></div><div class="folio"></div></div>
      <div class="page right"><div class="running"></div><div class="body"></div><div class="folio"></div></div>
    </div>
    <button class="turn prev" aria-label="Previous pages">‹</button>
    <button class="turn next" aria-label="Next pages">›</button>
    <div class="measure page"><div class="body"></div></div>`;
  const tome = root.querySelector('.tome');
  const sides = [...root.querySelectorAll('.tome .page')];
  const measure = root.querySelector('.measure .body');
  let data = null, pages = [], spread = 0, dirty = true;
  const single = () => matchMedia('(max-width: 900px)').matches;
  const perSpread = () => (single() ? 1 : 2);

  // ---------- typesetting ----------

  function blocks() {
    const ts = data.teachings;
    const byId = new Map(ts.map((t) => [t.id, t]));
    const chapters = THEMES.filter((th) => ts.some((t) => t.theme === th));
    const entry = (t, first) => {
      const parent = t.refines && byId.get(t.refines);
      // Where a myth grew from an older one, the margin credits it the way books credit a source.
      const source = t.refinesBy === t.by ? 'After an earlier telling of its own:' : `After ${esc(t.refinesBy)}, who told it so:`;
      const margin = t.refinesText
        ? `<div class="margin">${source} “${esc(t.refinesText)}”${parent && parent.theme !== t.theme ? ` (see <i>${esc(CHAPTERS[parent.theme])}</i>)` : ''}</div>` : '';
      const holders = t.carriers.filter((c) => c.stance !== 'disputes').map((c) => c.name);
      const doubters = t.carriers.filter((c) => c.stance === 'disputes').map((c) => c.name);
      const notes = [
        holders.length ? `Carried now by ${esc(list(holders))}.` : '',
        doubters.length ? `Disputed by ${esc(list(doubters))}.` : '',
      ].filter(Boolean).join(' ');
      // The moon it was set down under, and whether its teller ever saw the moon at all.
      const moon = t.moon ? `, under ${esc(t.moon.words)}${moonSvg(t.moon.phase, { ink: true, absent: !t.moon.up })}` : '';
      return `<div class="entry${holders.length ? '' : ' faded'}${first ? ' first' : ''}" data-id="${t.id}">` +
        `<p>${esc(t.text)}</p><div class="sig">— ${esc(t.by)}, ${generation(t.gen)}${t.sawMoon === false ? ', who never saw it' : ''}${moon}</div>${margin}<div class="note">${notes}</div></div>`;
    };
    const out = [];
    for (const th of chapters) {
      const ch = ts.filter((t) => t.theme === th).sort((a, b) => a.createdAt - b.createdAt);
      out.push({ chapter: th, html: `<div class="chapter-head">${ORN}<h2>${esc(CHAPTERS[th])}</h2><div class="count">${ch.length} myth${ch.length === 1 ? '' : 's'}</div></div>`, start: true });
      ch.forEach((t, i) => out.push({ chapter: th, html: entry(t, i === 0), id: t.id }));
    }
    return { out, chapters };
  }

  // Fills pages block by block, measuring each against a hidden page of the same size.
  function flow(items) {
    const result = [];
    let cur = null;
    for (const b of items) {
      if (!cur || (b.start && cur.html)) { cur = { html: '', chapter: b.chapter, ids: [] }; result.push(cur); }
      measure.innerHTML = cur.html + b.html;
      if (cur.html && measure.scrollHeight > measure.clientHeight + 1) { cur = { html: '', chapter: b.chapter, ids: [] }; result.push(cur); }
      cur.html += b.html;
      if (b.id) cur.ids.push(b.id);
    }
    return result;
  }

  function typeset() {
    if (!data) return;
    const { out, chapters } = blocks();
    const body = flow(out);
    const front = 3; // endpaper, title, contents
    const starts = new Map();
    body.forEach((p, i) => { if (!starts.has(p.chapter)) starts.set(p.chapter, front + i); });
    const best = data.teachings.slice().sort((a, b) => b.standing - a.standing)[0];
    const flies = data.authors, gens = data.generations;
    pages = [
      { html: best ? `<div class="endpaper"><p>“${esc(best.text)}”</p><div class="sig">— ${esc(best.by)}, ${generation(best.gen)}</div></div>` : '<div class="endpaper"></div>' },
      { html: `<div class="titlepage"><div class="small">being the</div><h1>Book of<br>the Moon</h1>${ORN}` +
        `<div class="small">${data.total ? `the myths of ${flies} firefl${flies === 1 ? 'y' : 'ies'}, told over ${gens} generation${gens === 1 ? '' : 's'} in a walled garden, none of whom lived to see the moon go round, and kept here though their lights are out` : 'in which nothing has yet been set down'}</div></div>` },
      { html: `<h3 class="contents-head">Contents</h3><ol class="contents">${chapters.map((th) => `<li data-goto="${starts.get(th)}"><span>${esc(CHAPTERS[th])}</span><i></i><b>${starts.get(th) + 1}</b></li>`).join('')}</ol>`, running: 'Contents' },
      ...body.map((p) => ({ ...p, running: CHAPTERS[p.chapter] })),
    ];
    if (pages.length % 2) pages.push({ html: '<div class="endpaper"></div>', blank: true }); // keeps spreads even
    dirty = false;
  }

  // ---------- display ----------

  function render() {
    if (dirty) typeset();
    const n = perSpread();
    spread = Math.max(0, Math.min(spread, Math.ceil(pages.length / n) - 1));
    sides[1].style.display = n === 1 ? 'none' : '';
    sides.slice(0, n).forEach((side, k) => {
      const i = spread * n + k;
      const p = pages[i] ?? { html: '' };
      side.querySelector('.body').innerHTML = p.html;
      side.querySelector('.running').textContent = p.running ?? '';
      side.querySelector('.folio').textContent = i >= 2 && p.html && !p.blank ? i + 1 : '';
    });
    root.querySelector('.prev').disabled = spread === 0;
    root.querySelector('.next').disabled = (spread + 1) * n >= pages.length;
  }

  function turn(by) {
    const next = spread + by;
    if (next < 0 || next * perSpread() >= pages.length) return;
    tome.classList.remove('turn-next', 'turn-prev');
    void tome.offsetWidth;
    tome.classList.add(by > 0 ? 'turn-next' : 'turn-prev');
    spread = next;
    render();
  }
  const goToPage = (i) => { spread = Math.floor(i / perSpread()); render(); };

  // Swiping the page turns it, like a real book under a finger.
  let touch = null;
  tome.addEventListener('touchstart', (ev) => { const t = ev.touches[0]; touch = { x: t.clientX, y: t.clientY }; }, { passive: true });
  tome.addEventListener('touchend', (ev) => {
    if (!touch) return;
    const t = ev.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) turn(dx < 0 ? 1 : -1);
  });
  root.querySelector('.prev').onclick = () => turn(-1);
  root.querySelector('.next').onclick = () => turn(1);
  root.querySelector('.close').onclick = () => api.close();
  root.addEventListener('click', (ev) => {
    if (ev.target === root) return api.close();
    const go = ev.target.closest('[data-goto]');
    if (go) goToPage(Number(go.dataset.goto));
  });
  addEventListener('keydown', (ev) => {
    if (!api.isOpen) return;
    if (ev.key === 'Escape') api.close();
    else if (ev.key === 'ArrowRight' || ev.key === 'PageDown') turn(1);
    else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') turn(-1);
  });
  addEventListener('resize', () => { dirty = true; if (api.isOpen) render(); });

  const api = {
    isOpen: false,
    update(compendium) { data = compendium; dirty = true; if (api.isOpen) render(); },
    open(mythId) {
      root.classList.add('open');
      api.isOpen = true;
      if (dirty) typeset();
      if (mythId != null) {
        const i = pages.findIndex((p) => p.ids?.includes(mythId));
        if (i >= 0) spread = Math.floor(i / perSpread());
      }
      render();
      if (mythId != null) root.querySelector(`.entry[data-id="${mythId}"]`)?.classList.add('lit');
    },
    close() { root.classList.remove('open'); api.isOpen = false; },
  };
  return api;
}
