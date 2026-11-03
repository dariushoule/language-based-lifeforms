// Long-term memory of the aquarium, in SQLite (node:sqlite, no dependencies):
// - state: the live world, saved every few seconds so a restart picks up where it left off
// - fish: every fish that ever lived (the lineage), with its personality and how it left
// - lore: the compendium's teachings, with their lineage of ideas; bounded by the sim (see ARCHIVE)
// - events: the chronicle of what happened (speech, arrivals, departures, teachings), trimmed to EVENTS_KEEP
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const EVENTS_KEEP = 20000;

export function openStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fish (id INTEGER PRIMARY KEY, name TEXT, gen INTEGER, predecessor_id INTEGER, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lore (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, wall INTEGER, kind TEXT, data TEXT NOT NULL);
  `);
  const q = {
    getState: db.prepare('SELECT value FROM state WHERE key = ?'),
    setState: db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    putFish: db.prepare('INSERT INTO fish (id, name, gen, predecessor_id, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
    departed: db.prepare("SELECT data FROM fish WHERE json_extract(data, '$.diedAt') IS NOT NULL ORDER BY id DESC LIMIT ?"),
    departedCount: db.prepare("SELECT COUNT(*) AS n FROM fish WHERE json_extract(data, '$.diedAt') IS NOT NULL"),
    putLore: db.prepare('INSERT INTO lore (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
    dropLore: db.prepare('DELETE FROM lore WHERE id = ?'),
    allLore: db.prepare('SELECT data FROM lore ORDER BY id'),
    event: db.prepare('INSERT INTO events (wall, kind, data) VALUES (?, ?, ?)'),
    trim: db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?'),
  };
  let since = 0;
  return {
    loadWorld: () => q.getState.get('world')?.value ?? null,
    saveWorld: (json) => q.setState.run('world', json),
    putFish: (f) => q.putFish.run(f.id, f.name, f.gen, f.predecessorId ?? null, JSON.stringify(f)),
    // The n fish that most recently swam out (newest first), and how many ever have.
    departed: (n) => ({ recent: q.departed.all(n).map((r) => JSON.parse(r.data)), total: q.departedCount.get().n }),
    putLore: (l) => q.putLore.run(l.id, JSON.stringify(l)),
    dropLore: (ids) => { for (const i of ids) q.dropLore.run(i); },
    loadLore: () => q.allLore.all().map((r) => JSON.parse(r.data)),
    event: (ev) => {
      q.event.run(ev.wall, ev.kind, JSON.stringify(ev));
      if (++since >= 500) { since = 0; q.trim.run(EVENTS_KEEP); }
    },
    close: () => db.close(),
  };
}
