import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './db.ts';

/**
 * After moving the data folder (desktop → hosted volume), file paths stored in the database may still point to the old
 * location (e.g. C:\…\data\media\x.jpg). Map every such path that no longer exists onto the same relative path inside
 * `dataDir` when that file exists there. Covers media, pin photos and cached media analysis (kv "mediatext:*").
 */
export function repairPaths(store: Store, dataDir: string): number {
  const fixOne = (p: string): string => {
    if (!p || fs.existsSync(p)) return p;
    const n = p.split(String.fromCharCode(92)).join('/');
    const i = n.toLowerCase().lastIndexOf('/data/');
    if (i < 0) return p;
    const cand = path.join(dataDir, ...n.slice(i + '/data/'.length).split('/'));
    return fs.existsSync(cand) ? cand : p;
  };
  let fixed = 0;
  for (const [table, col, key] of [['media', 'local_path', 'media_id'], ['reel_places', 'image_path', 'rowid']] as const) {
    for (const r of store.db.prepare(`SELECT ${key} k, ${col} v FROM ${table} WHERE ${col} IS NOT NULL`).all() as any[]) {
      const v = fixOne(r.v); if (v !== r.v) { store.db.prepare(`UPDATE ${table} SET ${col}=? WHERE ${key}=?`).run(v, r.k); fixed++; }
    }
  }
  const deep = (x: any): any => typeof x === 'string' ? fixOne(x) : Array.isArray(x) ? x.map(deep) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deep(v)])) : x;
  for (const r of store.db.prepare("SELECT k, v FROM kv WHERE k LIKE 'mediatext:%'").all() as any[]) {
    let j: any; try { j = JSON.parse(r.v); } catch { continue; }
    const out = JSON.stringify(deep(j));
    if (out !== r.v) { store.db.prepare('UPDATE kv SET v=? WHERE k=?').run(out, r.k); fixed++; }
  }
  return fixed;
}
