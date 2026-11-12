/**
 * One-time migration of the desktop data (SQLite + Reel screenshots/media) to the hosted app.
 *   node scripts/push-data.ts <app url> [--replace]        (APP_TOKEN from the environment or .env)
 * Sends a consistent copy of the database (VACUUM INTO) and every file it references inside the data folder; the
 * server rewrites the file paths to its own volume. Refuses to overwrite a server that already has Reels unless --replace.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.ts';

const [url] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!url) { console.error('usage: node scripts/push-data.ts <app url> [--replace]'); process.exit(1); }
const cfg = loadConfig();
const token = process.env.APP_TOKEN;
if (!token) { console.error('set APP_TOKEN'); process.exit(1); }

const tmp = path.join(os.tmpdir(), `reel-maps-push-${Date.now()}.sqlite`);
const src = new DatabaseSync(cfg.dbPath);
src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
const paths = new Set<string>();
for (const r of src.prepare("SELECT local_path p FROM media WHERE local_path IS NOT NULL UNION SELECT image_path FROM reel_places WHERE image_path IS NOT NULL").all() as any[]) paths.add(r.p);
src.close();

const root = path.resolve(cfg.dataDir);
const files: { rel: string; data: string }[] = [];
let missing = 0, bytes = 0;
for (const p of paths) {
  const abs = path.resolve(p);
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) { missing++; continue; }
  const b = fs.readFileSync(abs); bytes += b.length;
  files.push({ rel: path.relative(root, abs).split(path.sep).join('/'), data: b.toString('base64') });
}
const db = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true });
console.log(`database ${(db.length / 1024).toFixed(0)} KB · ${files.length} file(s), ${(bytes / 1e6).toFixed(1)} MB${missing ? ` · ${missing} referenced file(s) not found locally` : ''}`);
const res = await fetch(`${url.replace(/\/$/, '')}/api/admin/import`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token },
  body: JSON.stringify({ db: db.toString('base64'), src_data_dir: root, files, replace: process.argv.includes('--replace') }),
});
console.log(res.status, await res.text());
if (!res.ok) process.exitCode = 1;
