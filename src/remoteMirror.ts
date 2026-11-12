import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { Store } from './db.ts';

/**
 * Sync-only desktop mode: Railway is the only processor of Reels; this PC only publishes the finished pins to My Maps
 * (which needs the local, signed-in Chrome profile). Each run downloads a consistent copy of the hosted database
 * (GET /api/admin/backup) and copies its CONTENT (Reels, shares, places, links) into a separate local mirror database
 * (data/mirror/reel-maps.sqlite) that keeps the My Maps bookkeeping (map ids, layer hashes) between runs. Nothing is
 * ever pulled from the inbox or processed here, and nothing is written back to Railway.
 */
export const CONTENT_TABLES = ['reels', 'places', 'reel_places', 'shares'] as const;
/** My Maps bookkeeping that carries over from the old desktop database on the first mirror run (same maps, no duplicates). */
const SYNC_KV = ['map:%', 'layers:%', 'layerhash:%', 'grouped:%', 'retracted:%'];

export interface MirrorResult { store: Store; places: number; reels: number; retracted: string[]; seeded: boolean; file: string }

export async function mirrorFromHosted(cfg: Config, o: { url: string; token: string; fetch?: typeof fetch; log?: (m: string) => void }): Promise<MirrorResult> {
  const dir = path.join(cfg.dataDir, 'mirror');
  fs.mkdirSync(dir, { recursive: true });
  const dl = path.join(dir, 'railway-latest.sqlite');
  const res = await (o.fetch ?? fetch)(`${o.url.replace(/\/$/, '')}/api/admin/backup`, { headers: { 'x-token': o.token } });
  if (!res.ok) throw new Error(`could not download the hosted data: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('the hosted backup is not a SQLite database');
  fs.writeFileSync(`${dl}.tmp`, buf); fs.renameSync(`${dl}.tmp`, dl);

  const store = new Store(path.join(dir, 'reel-maps.sqlite'));
  const db = store.db;
  const seeded = !store.getKv('mirror:seeded');
  let prevIds: Set<string>;
  if (seeded && fs.existsSync(cfg.dbPath)) {
    const old = new DatabaseSync(cfg.dbPath, { readOnly: true });
    for (const pat of SYNC_KV) for (const r of old.prepare('SELECT k, v FROM kv WHERE k LIKE ?').all(pat) as any[]) store.setKv(r.k, r.v);
    prevIds = new Set((old.prepare('SELECT place_id FROM places').all() as any[]).map((r) => r.place_id));
    old.close();
  } else prevIds = new Set((db.prepare('SELECT place_id FROM places').all() as any[]).map((r) => r.place_id));

  db.exec(`ATTACH DATABASE '${dl.replace(/'/g, "''")}' AS src`);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    store.tx(() => {
      for (const t of [...CONTENT_TABLES].reverse()) db.exec(`DELETE FROM main.${t}`);
      for (const t of CONTENT_TABLES) {
        const mine = new Set((db.prepare(`PRAGMA main.table_info(${t})`).all() as any[]).map((c) => c.name));
        const cols = (db.prepare(`PRAGMA src.table_info(${t})`).all() as any[]).map((c) => c.name).filter((c) => mine.has(c));
        const list = cols.map((c) => `"${c}"`).join(',');
        db.exec(`INSERT INTO main.${t}(${list}) SELECT ${list} FROM src.${t}`);
      }
    });
  } finally { db.exec('PRAGMA foreign_keys = ON'); db.exec('DETACH DATABASE src'); }

  // Pins that are gone on Railway (e.g. removed in review) may leave My Maps; the sync treats them as ours, not foreign.
  const now = new Set((db.prepare('SELECT place_id FROM places').all() as any[]).map((r) => r.place_id));
  const retracted = [...prevIds].filter((id) => !now.has(id));
  for (const id of retracted) store.setKv(`retracted:rm:${id}`, new Date().toISOString());
  store.setKv('mirror:seeded', '1');
  store.setKv('mirror:last', JSON.stringify({ at: new Date().toISOString(), places: now.size }));
  const reels = (db.prepare('SELECT COUNT(*) n FROM reels').get() as any).n;
  o.log?.(`mirror: ${now.size} pin(s), ${reels} Reel(s) from ${o.url}${seeded ? ' (first run: My Maps bookkeeping taken over from the desktop database)' : ''}${retracted.length ? `; ${retracted.length} pin(s) removed on Railway` : ''}`);
  return { store, places: now.size, reels, retracted, seeded, file: dl };
}
