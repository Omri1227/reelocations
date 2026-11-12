#!/usr/bin/env node
/**
 * Dry run: what would the CURRENT matching rules change in the pins already saved?
 *
 *   node scripts/reprocess-dryrun.ts --db <copy of the live reel-maps.sqlite> [--out private/reprocess]
 *
 * Works on a scratch copy and never touches the database it was given. Automatic decisions are recomputed; everything a
 * person decided is kept as it is and never proposed for change: pins chosen in review (decided_by=user), deleted pins
 * (tombstones), listing answers ("this is the listing" / "none of these") and subtype corrections. The paid OpenAI
 * answers already stored are replayed (no new OpenAI call); OSM/Google lookups come from the stored HTTP cache.
 *
 * Output: a numbered list of proposed changes per Reel (added, removed, moved, listing, type, subtype, approximate),
 * written to <out>/dryrun-<date>.json and .md. The folder is git-ignored: it lists a person's saved places.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { enrichLocalities, processDue } from '../src/pipeline.ts';
import { matchStoredPlaces, LISTING_RULES } from '../src/geo/googleMatch.ts';
import { refineGenericCategories } from '../src/categories.ts';
import { backfillCuisines, backfillGoogleTypes } from '../src/cuisine.ts';
import { haversineKm } from '../src/geo/geometry.ts';
import { nameSimilarity } from '../src/util/text.ts';
import { Store } from '../src/db.ts';

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const src = opt('db');
if (!src || !fs.existsSync(src)) { console.error('usage: node scripts/reprocess-dryrun.ts --db <copy of reel-maps.sqlite> [--out private/reprocess]'); process.exit(2); }
const outDir = path.resolve(opt('out', 'private/reprocess')!);

interface Pin { place_id: string; name: string; category: string; cuisine: string | null; lat: number; lon: number; confidence: string; google_place_id: string | null; decided_by: string; address: string | null }
const pinsOf = (s: Store, key: string): Pin[] => s.db.prepare(`SELECT p.place_id, p.name, p.category, p.cuisine, p.lat, p.lon, p.confidence, p.google_place_id, rp.decided_by, p.address
  FROM reel_places rp JOIN places p USING(place_id) WHERE rp.reel_key=? ORDER BY p.name`).all(key) as any;

// ---- before: the database as it is ----
const before = new Store(src);
const reels = before.db.prepare('SELECT reel_key, url, collection_id, status, status_reason FROM reels ORDER BY first_shared_at').all() as any[];
const beforePins = new Map(reels.map((r) => [r.reel_key, pinsOf(before, r.reel_key)]));
before.close();

// ---- after: the same inputs through the current rules, keeping every human decision ----
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-dryrun-'));
const dbPath = path.join(work, 'reel-maps.sqlite');
fs.copyFileSync(src, dbPath);
const cfg = loadConfig({ dataDir: work, dbPath });
let lookups = 0;
const realFetch = globalThis.fetch;
const app = createApp(cfg, {
  media: { ocrImage: async () => [], extractFrames: async () => [] }, // stored readings are reused
  fetch: (async (url: any, init: any) => { lookups++; return realFetch(url, init); }) as any,
});
const s = app.store;
const get = s.cacheGet.bind(s); (s as any).cacheGet = (k: string) => get(k, Number.MAX_SAFE_INTEGER);
s.db.exec(`
  DELETE FROM reel_places WHERE decided_by <> 'user';
  DELETE FROM places WHERE place_id NOT IN (SELECT place_id FROM reel_places);
  DELETE FROM candidates;
  DELETE FROM kv WHERE k LIKE 'page:tried:%';
  DELETE FROM kv WHERE k LIKE 'gmatch:%' AND k <> 'gmatch:rules' AND v NOT LIKE '%"by":"user"%' AND v NOT LIKE '%"status":"rejected"%';
  UPDATE reels SET status='queued', status_reason=NULL, attempts=0, next_attempt_at=NULL, last_error=NULL, evidence_json=NULL, vision_used=0 WHERE status <> 'not_a_place';
`);
s.setKv('gmatch:rules', String(LISTING_RULES));
const keyByUrl = new Map((s.db.prepare('SELECT reel_key, url FROM reels').all() as any[]).map((r) => [r.url, r.reel_key]));
app.pipeline.ai = (async (input: any) => {
  const k = keyByUrl.get(input.reelUrl); const v = k ? s.getKv(`ai:result:${k}`) : undefined;
  return v ? JSON.parse(v) : { skipped: 'dry run: no stored AI answer (no new paid call is made)' };
}) as any;
app.pipeline.vision = undefined; app.pipeline.pageCaption = undefined; app.pipeline.oembed = undefined; app.pipeline.refreshGoogle = undefined;
app.pipeline.log = () => {};

await processDue(app.pipeline);
for (let i = 0; i < 10; i++) if (!(await enrichLocalities(app.pipeline, 50))) break;
if (app.resolve.google) for (let i = 0; i < 20; i++) { const m = await matchStoredPlaces(s, app.resolve.google, {}); if (!(m.matched + m.review + m.none)) break; }
s.mergeSameListing();
refineGenericCategories(s.db);
backfillGoogleTypes(s);
backfillCuisines(s, (pid) => s.linksForPlace(pid).flatMap((l) => { const r = s.getReel(l.reel_key); const e = r?.evidence_json ? JSON.parse(r.evidence_json) : null; return [...(e?.texts ?? []).map((t: any) => String(t.text ?? '')), ...s.notesFor(l.reel_key)]; }));

// ---- compare ----
interface Change { id: number; reel: string; url: string | null; collection: number; kind: string; before: string | null; after: string | null; detail: string }
const changes: Change[] = [];
const fmt = (p: Pin) => `${p.name} [${p.category}${p.cuisine ? `/${p.cuisine}` : ''}${p.confidence !== 'confirmed' ? ', approximate' : ''}] ${p.lat.toFixed(5)},${p.lon.toFixed(5)}${p.google_place_id ? ` listing ${p.google_place_id}` : ' (no listing)'}`;
const same = (a: Pin, b: Pin) => a.place_id === b.place_id || (!!a.google_place_id && a.google_place_id === b.google_place_id)
  || (haversineKm(a, b) < 0.5 && nameSimilarity(a.name, b.name) >= 0.6) || (haversineKm(a, b) < 3 && nameSimilarity(a.name, b.name) >= 0.85);
const statusChanges: { reel: string; url: string | null; before: string; after: string; reason: string }[] = [];
for (const r of reels) {
  const was = beforePins.get(r.reel_key) ?? [];
  const now = pinsOf(s, r.reel_key);
  const add = (kind: string, b: Pin | null, a: Pin | null, detail: string) => changes.push({ id: changes.length + 1, reel: r.reel_key, url: r.url, collection: r.collection_id, kind, before: b ? fmt(b) : null, after: a ? fmt(a) : null, detail });
  const used = new Set<Pin>();
  for (const b of was) {
    if (b.decided_by === 'user') { const keep = now.find((a) => a.place_id === b.place_id); if (keep) used.add(keep); continue; } // a person's choice: never proposed
    const a = now.find((x) => !used.has(x) && same(b, x));
    if (!a) { add('remove', b, null, 'the current rules would not save this pin'); continue; }
    used.add(a);
    const km = haversineKm(a, b);
    if (a.google_place_id !== b.google_place_id) add('listing', b, a, b.google_place_id ? (a.google_place_id ? 'a different Google listing (branch)' : 'the Google listing would be dropped') : 'a Google listing would be attached');
    else if (km > 0.2) add('move', b, a, `the pin would move ${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`}`);
    if (a.category !== b.category) add('type', b, a, `type ${b.category} → ${a.category}`);
    if ((a.cuisine ?? null) !== (b.cuisine ?? null)) add('subtype', b, a, `restaurant subtype ${b.cuisine ?? 'not set'} → ${a.cuisine ?? 'not set'}`);
    if (a.confidence !== b.confidence) add('approximate', b, a, `${b.confidence} → ${a.confidence}`);
  }
  for (const a of now) if (!used.has(a) && !was.some((b) => b.place_id === a.place_id)) add('add', null, a, a.confidence === 'approximate' ? 'a new APPROXIMATE pin (kept in the Review Queue)' : 'a new pin');
  const after = s.getReel(r.reel_key) as any;
  if (after && after.status !== r.status) statusChanges.push({ reel: r.reel_key, url: r.url, before: r.status, after: after.status, reason: String(after.status_reason ?? '').slice(0, 240) });
}
await app.close();
fs.rmSync(work, { recursive: true, force: true });

// ---- report ----
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const summary = { at: new Date().toISOString(), reels: reels.length, pins_before: [...beforePins.values()].reduce((n, p) => n + p.length, 0), changes: changes.length, by_kind: Object.fromEntries([...new Set(changes.map((c) => c.kind))].map((k) => [k, changes.filter((c) => c.kind === k).length])), status_changes: statusChanges.length, network_lookups: lookups };
fs.writeFileSync(path.join(outDir, `dryrun-${stamp}.json`), JSON.stringify({ summary, changes, statusChanges }, null, 2));
const md = [`# Re-processing dry run (${stamp})`, '', `Reels: ${summary.reels} · pins now: ${summary.pins_before} · proposed changes: ${summary.changes} · Reels whose review status would change: ${summary.status_changes} · uncached lookups made: ${lookups}`, '',
  'Nothing has been changed. Pins you chose, pins you deleted, listing answers and subtype corrections are kept and not listed.', '',
  '| # | Change | Reel | Now | Proposed | Why |', '|---|---|---|---|---|---|',
  ...changes.map((c) => `| ${c.id} | ${c.kind} | ${c.url ?? c.reel} | ${c.before ?? '—'} | ${c.after ?? '—'} | ${c.detail} |`), '',
  '## Review status', '', '| Reel | Now | Proposed | Reason |', '|---|---|---|---|', ...statusChanges.map((x) => `| ${x.url ?? x.reel} | ${x.before} | ${x.after} | ${x.reason.replace(/\|/g, '/')} |`), ''].join('\n');
fs.writeFileSync(path.join(outDir, `dryrun-${stamp}.md`), md);
console.log(JSON.stringify(summary, null, 2));
console.log(`written ${path.join(outDir, `dryrun-${stamp}.md`)}`);
