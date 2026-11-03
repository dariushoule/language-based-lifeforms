// What observers are sent, as deltas. Every broadcast carries, for each entity, only the fields that
// changed since the previous broadcast (plus its id, so the client knows it's still there); new
// entities go out whole. A newcomer gets everything observers hold as of the last broadcast, so the
// deltas that follow apply to it exactly.
// Numbers are cut to two decimals: nothing on screen needs more, and it keeps the messages short.

const round = (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v);
const json = (v) => JSON.stringify(v, round) ?? 'null';
const entityJson = (fields) => `{${[...fields].map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}`;

// Snapshots: { time, mandala, entities: [{ id, ...fields }] } in, delta messages (strings) out.
export function createSnapshots() {
  let sent = new Map(); // id -> Map(field -> json), as observers hold it
  let mandala = 'null';
  let time = 0;
  return {
    // The delta from the last broadcast to `snap`, as a message string; and observers now hold `snap`.
    next(snap) {
      const now = new Map(), parts = [];
      for (const e of snap.entities) {
        const before = sent.get(e.id);
        const fields = new Map();
        const changed = [];
        for (const k of Object.keys(e)) {
          const v = json(e[k]);
          fields.set(k, v);
          if (!before || before.get(k) !== v) changed.push([k, v]);
        }
        // A field that disappeared is sent as null, so the client doesn't keep a stale value.
        if (before) for (const k of before.keys()) if (!fields.has(k) && before.get(k) !== 'null') { fields.set(k, 'null'); changed.push([k, 'null']); }
        if (before && !changed.some(([k]) => k === 'id')) changed.unshift(['id', fields.get('id')]);
        now.set(e.id, fields);
        parts.push(entityJson(changed));
      }
      sent = now;
      time = snap.time;
      const m = json(snap.mandala);
      const mandalaPart = m !== mandala ? `,"mandala":${m}` : '';
      mandala = m;
      return `{"t":"snap","time":${json(time)}${mandalaPart},"entities":[${parts.join(',')}]}`;
    },
    // Everything observers hold, for a new one.
    full() {
      return `{"t":"snap","full":true,"time":${json(time)},"mandala":${mandala},"entities":[${[...sent.values()].map(entityJson).join(',')}]}`;
    },
  };
}

// The compendium: the teachings it shows change one at a time (a new one, one told again, a new
// carrier), so after the first message only the changed teachings go out, with the ids of all shown.
export function createCompendium() {
  let sent = new Map(); // id -> json
  let head = null;
  return {
    // A message for what changed since the last call, or null if nothing did.
    next(c) {
      const now = new Map(), upsert = [];
      for (const t of c.teachings) {
        const v = json(t);
        now.set(t.id, v);
        if (sent.get(t.id) !== v) upsert.push(v);
      }
      const h = json({ total: c.total, authors: c.authors, generations: c.generations });
      const same = !upsert.length && h === head && now.size === sent.size && [...now.keys()].every((id) => sent.has(id));
      sent = now;
      head = h;
      return same ? null : message(false, upsert);
    },
    full: () => (head ? message(true, [...sent.values()]) : null),
  };
  function message(full, upsert) {
    return `{"t":"compendium","full":${full},"head":${head},"ids":${JSON.stringify([...sent.keys()])},"upsert":[${upsert.join(',')}]}`;
  }
}
