#!/usr/bin/env node
/**
 * Result-quality evaluation (see docs/QUALITY-RESEARCH.md).
 *
 *   node scripts/eval-quality.ts --db <copy of the live reel-maps.sqlite> [--name baseline] [--split dev|holdout|all]
 *        [--only real|fixtures] [--offline] [--labels private/eval/real-labels.json] [--out private/eval/quality]
 *   npm run eval:quality -- --only fixtures      ← works in a clean checkout (written captions, live OSM lookups)
 * The real-Reel labels and results describe a person's own saved Reels: they live in private/ (git-ignored).
 *
 * Replays the real pipeline on a scratch copy: places/links/candidates/deletions/listing decisions are wiped; captions,
 * notes, cached OCR and the OpenAI answers already paid for are kept and REPLAYED (the harness never calls OpenAI).
 * OSM/Google answers come from the stored HTTP cache; a lookup that is not cached is made once and kept in a shared
 * cache file next to the database copy (`--offline` refuses those instead).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { enrichLocalities, processDue } from '../src/pipeline.ts';
import { matchStoredPlaces, LISTING_RULES } from '../src/geo/googleMatch.ts';
import { refineGenericCategories } from '../src/categories.ts';
import { backfillCuisines, backfillGoogleTypes } from '../src/cuisine.ts';
import { haversineKm } from '../src/geo/geometry.ts';
import { nowIso } from '../src/db.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const flag = (n: string) => args.includes(`--${n}`);

interface LabelPlace { name: string; lat: number; lon: number; tol_km: number; cat: string[]; cuisine?: (string | null)[]; gid?: string[]; poi?: boolean; optional?: boolean }
interface LabelReel { key: string; kind: string; expect: 'pins' | 'none'; split?: string; caption?: string; confidence?: string; note?: string; places: LabelPlace[] }
interface Pred { place_id: string; name: string; category: string; cuisine: string | null; lat: number; lon: number; confidence: string; google_place_id: string | null; decided_by: string | null }

/** Holdout rule fixed before tuning: first hex digit of sha1(reel_key) in 0–4. */
export const splitOf = (key: string) => (parseInt(crypto.createHash('sha1').update(key).digest('hex')[0]!, 16) <= 4 ? 'holdout' : 'dev');

const quiet = () => {};

async function runSet(set: 'real' | 'fixtures', dbSrc: string | null, labels: LabelReel[], cacheFile: string) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `rm-eval-${set}-`));
  const dbPath = path.join(work, 'reel-maps.sqlite');
  if (dbSrc) fs.copyFileSync(dbSrc, dbPath);
  const cfg = loadConfig({ dataDir: work, dbPath });
  let net = 0; const misses: string[] = [];
  const realFetch = globalThis.fetch;
  const app = createApp(cfg, {
    media: { ocrImage: async () => [], extractFrames: async () => [] },   // readings come from the cache
    fetch: (async (url: any, init: any) => {
      net++; misses.push(String(url).replace(/key=[^&]+/, 'key=…').slice(0, 140));
      if (flag('offline')) throw new Error('offline eval: not cached');
      return realFetch(url, init);
    }) as any,
  });
  const store = app.store;
  // Shared cache of lookups made by earlier eval runs (new code may ask new questions; ask each only once).
  if (fs.existsSync(cacheFile)) {
    store.db.exec(`ATTACH DATABASE '${cacheFile.replace(/'/g, "''")}' AS ec`);
    store.db.exec('INSERT OR REPLACE INTO http_cache SELECT * FROM ec.http_cache');
    store.db.exec('DETACH DATABASE ec');
  }
  // Cached answers never expire inside an evaluation (the same input must give the same output).
  const get = store.cacheGet.bind(store); (store as any).cacheGet = (k: string) => get(k, Number.MAX_SAFE_INTEGER);
  // Wipe every decision; keep the inputs.
  store.db.exec(`DELETE FROM reel_places; DELETE FROM places; DELETE FROM candidates; DELETE FROM tombstones;
    DELETE FROM kv WHERE k LIKE 'gmatch:%' OR k LIKE 'page:tried:%';`);
  store.setKv('gmatch:rules', String(LISTING_RULES));
  if (set === 'fixtures') {
    store.db.exec('DELETE FROM reels; DELETE FROM shares; DELETE FROM media;');
    const now = nowIso();
    for (const l of labels) store.db.prepare(`INSERT INTO reels(reel_key,url,shortcode,first_shared_at,status,metadata_json,created_at,updated_at,collection_id) VALUES(?,?,?,?,?,?,?,?,1)`)
      .run(l.key, null, null, now, 'queued', JSON.stringify({ ok: true, source: 'fixture', caption: l.caption }), now, now);
  } else {
    store.db.exec(`UPDATE reels SET status='queued', status_reason=NULL, attempts=0, next_attempt_at=NULL, last_error=NULL, evidence_json=NULL, vision_used=0`);
    const keys = opt('keys')?.split(',');
    if (keys) for (const r of store.db.prepare('SELECT reel_key FROM reels').all() as any[]) if (!keys.some((k) => r.reel_key.endsWith(k))) store.db.prepare('DELETE FROM reels WHERE reel_key=?').run(r.reel_key);
  }
  // Replay the paid AI answers; never call OpenAI.
  const keyByUrl = new Map((store.db.prepare('SELECT reel_key, url FROM reels').all() as any[]).map((r) => [r.url, r.reel_key]));
  app.pipeline.ai = set === 'fixtures' ? undefined : (async (input: any) => {
    const k = keyByUrl.get(input.reelUrl); const v = k ? store.getKv(`ai:result:${k}`) : undefined;
    return v ? JSON.parse(v) : { skipped: 'eval: no stored AI answer' };
  }) as any;
  app.pipeline.vision = undefined; app.pipeline.pageCaption = undefined; app.pipeline.oembed = undefined; app.pipeline.refreshGoogle = undefined;
  app.pipeline.log = flag('verbose') ? (m) => console.log('  ', m) : quiet;

  const t0 = Date.now();
  await processDue(app.pipeline);
  // Later server cycles fill in every pin's town/country before listings are matched.
  for (let i = 0; i < 10; i++) if (!(await enrichLocalities(app.pipeline, 50))) break;
  // The server's cycle: Google listings for every pin, then merges and backfills.
  if (app.resolve.google) for (let i = 0; i < 20; i++) { const m = await matchStoredPlaces(store, app.resolve.google, {}); if (!(m.matched + m.review + m.none)) break; }
  store.mergeSameListing();
  refineGenericCategories(store.db);
  backfillGoogleTypes(store);
  const evidenceFor = (pid: string) => store.linksForPlace(pid).flatMap((l) => { const r = store.getReel(l.reel_key); const e = r?.evidence_json ? JSON.parse(r.evidence_json) : null; return [...(e?.texts ?? []).map((t: any) => String(t.text ?? '')), ...store.notesFor(l.reel_key)]; });
  backfillCuisines(store, evidenceFor);
  const ms = Date.now() - t0;

  const present = new Set((store.db.prepare('SELECT reel_key FROM reels').all() as any[]).map((r) => r.reel_key));
  const out = labels.filter((l) => present.has(l.key)).map((l) => {
    const r = store.getReel(l.key) as any;
    const preds = store.db.prepare(`SELECT p.place_id, p.name, p.category, p.cuisine, p.lat, p.lon, p.confidence, p.google_place_id, rp.decided_by FROM reel_places rp JOIN places p USING(place_id) WHERE rp.reel_key=?`).all(l.key) as unknown as Pred[];
    return { label: l, status: r?.status ?? 'missing', reason: r?.status_reason ?? '', preds };
  });
  // Keep new lookups for the next run.
  const ec = new DatabaseSync(cacheFile);
  ec.exec('CREATE TABLE IF NOT EXISTS http_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL)');
  ec.close();
  store.db.exec(`ATTACH DATABASE '${cacheFile.replace(/'/g, "''")}' AS ec`);
  store.db.exec('INSERT OR REPLACE INTO ec.http_cache SELECT * FROM main.http_cache');
  store.db.exec('DETACH DATABASE ec');
  await app.close();
  if (flag('keep')) console.log('kept', dbPath); else fs.rmSync(work, { recursive: true, force: true });
  return { results: out, net, misses, ms };
}

// ---------------- scoring ----------------
type Result = Awaited<ReturnType<typeof runSet>>['results'][number];
interface Score {
  reels: number; required: number; exact: number; located: number; listingChecked: number; listingOk: number;
  preds: number; correctPreds: number; multiRequired: number; multiFound: number;
  findable: number; covered: number; review: number; ambiguous: number; ambiguousClean: number;
  catChecked: number; catOk: number; cuiChecked: number; cuiOk: number; filterIn: number; filterOut: number;
  failures: string[];
}
const empty = (): Score => ({ reels: 0, required: 0, exact: 0, located: 0, listingChecked: 0, listingOk: 0, preds: 0, correctPreds: 0, multiRequired: 0, multiFound: 0, findable: 0, covered: 0, review: 0, ambiguous: 0, ambiguousClean: 0, catChecked: 0, catOk: 0, cuiChecked: 0, cuiOk: 0, filterIn: 0, filterOut: 0, failures: [] });

function scoreReel(res: Result, s: Score) {
  const l = res.label; s.reels++;
  if (res.status === 'needs_review' || res.status === 'error') s.review++;
  // Greedy one-to-one assignment by distance.
  const pairs: { pi: number; li: number; d: number }[] = [];
  res.preds.forEach((p, pi) => l.places.forEach((lp, li) => { const d = haversineKm(p, lp); if (d <= lp.tol_km) pairs.push({ pi, li, d }); }));
  pairs.sort((a, b) => a.d - b.d);
  const pOf = new Map<number, number>(), lOf = new Map<number, number>();
  for (const x of pairs) if (!pOf.has(x.pi) && !lOf.has(x.li)) { pOf.set(x.pi, x.li); lOf.set(x.li, x.pi); }
  const generic = (c: string) => c === 'area' || c === 'other';
  const ok = (p: Pred, lp: LabelPlace) => !(lp.poi && generic(p.category));
  s.preds += res.preds.length;
  res.preds.forEach((p, pi) => {
    const li = pOf.get(pi);
    if (li == null) { s.failures.push(`${l.key} [${l.kind}] wrong pin: ${p.name} (${p.category}) ${p.lat.toFixed(4)},${p.lon.toFixed(4)}`); return; }
    const lp = l.places[li]!;
    if (ok(p, lp)) s.correctPreds++; else s.failures.push(`${l.key} [${l.kind}] generic pin for ${lp.name}: ${p.name} (${p.category})`);
    s.catChecked++;
    if (lp.cat.includes(p.category)) s.catOk++; else { s.filterIn++; s.failures.push(`${l.key} [${l.kind}] category ${p.category} for ${lp.name} (expected ${lp.cat.join('/')})`); }
    if (lp.cuisine) { s.cuiChecked++; if (lp.cuisine.includes(p.cuisine)) s.cuiOk++; else s.failures.push(`${l.key} [${l.kind}] cuisine ${p.cuisine} for ${lp.name} (expected ${lp.cuisine.join('/')})`); }
  });
  let allExact = true;
  l.places.forEach((lp, li) => {
    if (lp.optional) return;
    s.required++;
    if (l.kind === 'multi') s.multiRequired++;
    const pi = lOf.get(li); const p = pi == null ? null : res.preds[pi]!;
    if (!p) { allExact = false; s.filterOut++; s.failures.push(`${l.key} [${l.kind}] missing: ${lp.name}`); return; }
    s.located++;
    if (l.kind === 'multi') s.multiFound++;
    let exact = ok(p, lp);
    if (lp.gid) { s.listingChecked++; if (p.google_place_id && lp.gid.includes(p.google_place_id)) s.listingOk++; else { exact = false; s.failures.push(`${l.key} [${l.kind}] listing ${p.google_place_id ?? 'none'} for ${lp.name} (expected ${lp.gid[0]}${lp.gid.length > 1 ? ' …' : ''})`); } }
    if (!lp.cat.includes(p.category)) s.filterOut++;
    if (exact) s.exact++; else allExact = false;
  });
  if (l.expect === 'none') {
    s.ambiguous++;
    if (res.preds.every((_, pi) => pOf.has(pi))) s.ambiguousClean++;
  } else {
    s.findable++;
    if (allExact && res.status === 'resolved') s.covered++;
    else if (res.status !== 'resolved') s.failures.push(`${l.key} [${l.kind}] left for review: ${res.reason.slice(0, 220)}`);
  }
}

const pct = (a: number, b: number) => (b ? `${(100 * a / b).toFixed(1)}% (${a}/${b})` : 'n/a');
function summary(s: Score) {
  return {
    reels: s.reels,
    exact_place_branch_accuracy: pct(s.exact, s.required),
    location_accuracy: pct(s.located, s.required),
    listing_branch_accuracy: pct(s.listingOk, s.listingChecked),
    auto_pin_precision: pct(s.correctPreds, s.preds),
    multi_location_recall: pct(s.multiFound, s.multiRequired),
    coverage_resolved_no_review: pct(s.covered, s.findable),
    review_rate: pct(s.review, s.reels),
    ambiguous_no_wrong_pin: pct(s.ambiguousClean, s.ambiguous),
    category_correct: pct(s.catOk, s.catChecked),
    cuisine_correct: pct(s.cuiOk, s.cuiChecked),
    filter_inclusion_errors: s.filterIn, filter_exclusion_errors: s.filterOut,
  };
}

async function main() {
  const name = opt('name', 'run')!;
  const which = opt('split', 'all');
  const only = opt('only');
  const dbSrc = opt('db');
  const cacheFile = path.resolve(opt('cache', dbSrc ? path.join(path.dirname(dbSrc), 'eval-http-cache.sqlite') : path.join(os.tmpdir(), 'rm-eval-http-cache.sqlite'))!);
  const report: any = { name, at: new Date().toISOString(), sets: {} };
  const sets: ['real' | 'fixtures', LabelReel[], string | null][] = [];
  if (only !== 'fixtures') {
    if (!dbSrc) throw new Error('--db <copy of the live database> is required for the real set (or --only fixtures)');
    const real = JSON.parse(fs.readFileSync(path.resolve(opt('labels', path.join(ROOT, 'private/eval/real-labels.json'))!), 'utf8')).reels as LabelReel[];
    real.forEach((r) => { r.split = splitOf(r.key); });
    sets.push(['real', real, dbSrc]);
  }
  if (only !== 'real') sets.push(['fixtures', JSON.parse(fs.readFileSync(path.join(ROOT, 'test/eval/fixtures.json'), 'utf8')).reels, null]);
  for (const [set, labels, src] of sets) {
    const run = await runSet(set, src, labels, cacheFile);
    const bySplit: Record<string, Score> = {}, byKind: Record<string, Score> = {};
    const all = empty();
    for (const r of run.results) {
      const sp = r.label.split ?? 'dev';
      if (which !== 'all' && sp !== which) continue;
      scoreReel(r, all);
      scoreReel(r, bySplit[sp] ??= empty());
      scoreReel(r, byKind[r.label.kind] ??= empty());
    }
    report.sets[set] = {
      network_lookups: run.net, ms: run.ms, misses: run.misses.slice(0, 40),
      all: summary(all), by_split: Object.fromEntries(Object.entries(bySplit).map(([k, v]) => [k, summary(v)])),
      by_kind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, summary(v)])),
      failures: all.failures,
      reels: run.results.map((r) => ({ key: r.label.key, split: r.label.split ?? 'dev', kind: r.label.kind, status: r.status, reason: r.reason, pins: r.preds.map((p) => `${p.name} | ${p.category}${p.cuisine ? '/' + p.cuisine : ''} | ${p.confidence} | ${p.google_place_id ?? '-'} | ${p.lat.toFixed(4)},${p.lon.toFixed(4)}`) })),
    };
    console.log(`\n== ${set} (${run.results.length} Reels, ${run.net} uncached lookups, ${(run.ms / 1000).toFixed(1)} s)`);
    console.table(Object.fromEntries([['all', summary(all)], ...Object.entries(bySplit).map(([k, v]) => [k, summary(v)])]));
    console.table(Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, summary(v)])));
    if (flag('failures')) for (const f of all.failures) console.log('  ✗', f);
  }
  const dir = path.resolve(opt('out', path.join(ROOT, 'private', 'eval', 'quality'))!); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(report, null, 2));
  console.log(`\nwritten ${path.join(dir, name)}.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
