import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { Store } from './db.ts';
import { syncGrouped, type MultiMapSink, type MapResult } from './sync/grouped.ts';
import type { CollectionExport } from './destinations.ts';

/**
 * Desktop publisher (sync-only). Railway processes every Reel once; this PC only publishes the finished pins of ONE
 * collection to the user's own Google My Maps, through their signed-in local Chrome profile.
 *
 *  1. GET  /api/publisher/export  (Authorization: Bearer <publisher credential>) → that collection's pins, Reels, links,
 *     per-country content hashes and deletions (tombstones). Nothing of other collections is ever sent here.
 *  2. Mirror them into data/publish/dest-<id>-<mode>.sqlite (keeps the My Maps bookkeeping between runs).
 *  3. One My Map per country (a layer per city): only countries whose content changed are touched; each map succeeds
 *     or fails on its own.
 *  4. POST /api/publisher/report → per country: ok / failed / blocked + the content hash that is now on Google.
 */
const CONTENT = ['reels', 'places', 'reel_places'] as const;

export interface PublishOptions {
  url: string; token: string; mode: 'real' | 'test'; sink: MultiMapSink;
  force?: boolean; onlyCountries?: string[]; log?: (m: string) => void; fetch?: typeof fetch;
  /** Title prefix for the country maps (default: collection 1 → MYMAPS_TITLE_PREFIX, others → "<collection name> · "). */
  titlePrefix?: string;
}
export interface PublishResult { status: string; reason?: string; perMap: MapResult[]; export: CollectionExport; reportOk: boolean; ms: number }

async function api<T>(o: { url: string; token: string; fetch?: typeof fetch }, p: string, init: RequestInit = {}): Promise<T> {
  const r = await (o.fetch ?? fetch)(`${o.url.replace(/\/$/, '')}${p}`, { ...init, headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${p}: HTTP ${r.status} ${text.slice(0, 200)}`), { status: r.status });
  return JSON.parse(text) as T;
}

/** Copy the export into the local mirror store; returns ids that disappeared (to be retracted from the maps). */
export function loadExport(store: Store, ex: CollectionExport, seedFrom?: string): string[] {
  const db = store.db;
  let prev = new Set((db.prepare('SELECT place_id FROM places').all() as any[]).map((r) => r.place_id));
  if (!store.getKv('mirror:seeded')) {
    // First run for collection 1: reuse the owner's existing per-country REAL maps (never the old single "Reels" map).
    if (seedFrom && fs.existsSync(seedFrom) && ex.collection.id === 1) {
      const old = new DatabaseSync(seedFrom, { readOnly: true });
      for (const r of old.prepare("SELECT k, v FROM kv WHERE (k LIKE 'map:real:%' AND k <> 'map:real:all') OR k LIKE 'layers:%' OR k LIKE 'layerhash:%' OR k LIKE 'retracted:%'").all() as any[]) store.setKv(r.k, r.v);
      prev = new Set((old.prepare('SELECT place_id FROM places').all() as any[]).map((r) => r.place_id));
      old.close();
    }
    store.setKv('mirror:seeded', '1');
  }
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    store.tx(() => {
      for (const t of [...CONTENT].reverse()) db.exec(`DELETE FROM ${t}`);
      const put = (t: string, rows: any[]) => {
        const cols = new Set((db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name));
        for (const r of rows) {
          const keys = Object.keys(r).filter((k) => cols.has(k));
          db.prepare(`INSERT OR REPLACE INTO ${t}(${keys.map((k) => `"${k}"`).join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map((k) => (r[k] === undefined ? null : r[k])));
        }
      };
      put('reels', ex.reels); put('places', ex.places); put('reel_places', ex.links);
    });
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
  const now = new Set(ex.places.map((p) => p.place_id));
  const gone = [...new Set([...prev, ...ex.tombstones])].filter((id) => !now.has(id));
  for (const id of gone) store.setKv(`retracted:rm:${id}`, new Date().toISOString());
  return gone;
}

export async function publishOnce(cfg: Config, o: PublishOptions): Promise<PublishResult> {
  const t0 = Date.now();
  const ex = await api<CollectionExport>(o, '/api/publisher/export');
  const dir = path.join(cfg.dataDir, 'publish');
  fs.mkdirSync(dir, { recursive: true });
  const store = new Store(path.join(dir, `dest-${ex.destination_id}-${o.mode}.sqlite`));
  try {
    const gone = loadExport(store, ex, o.mode === 'real' ? cfg.dbPath : undefined);
    const base = o.titlePrefix ?? (ex.collection.id === 1 ? cfg.mymapsTitlePrefix : `${ex.collection.name} · `);
    const prefix = o.mode === 'test' ? `TEST · ${base}` : base;
    o.log?.(`publish: collection "${ex.collection.name}" — ${ex.places.length} pin(s) in ${Object.keys(ex.countries).length} countr(ies)${gone.length ? `, ${gone.length} removed` : ''}`);
    const r = await syncGrouped(store, o.sink, { mode: o.mode, titlePrefix: prefix, layout: 'per-country', outDir: path.join(dir, `sync-${ex.destination_id}-${o.mode}`), autoCreate: true, force: o.force, onlyCountries: o.onlyCountries, log: o.log });
    const perMap = r.perMap ?? [];
    // A country whose only pins are not shown on My Maps (an approximate pin superseded by an exact place from the same
    // Reel) has nothing to publish: report it as up to date so it never sits in "pending".
    for (const [cc, c] of Object.entries(ex.countries)) {
      if (!perMap.some((m) => m.countryCode === cc) && (!o.onlyCountries || o.onlyCountries.includes(cc))) perMap.push({ countryCode: cc, title: `${prefix}${c.name}`, mapId: null, status: 'skipped', items: 0, detail: 'nothing to show on My Maps (approximate pin only)' });
    }
    let reportOk = false;
    try {
      await api(o, '/api/publisher/report', { method: 'POST', body: JSON.stringify({ mode: o.mode, maps: perMap.map((m) => ({ country_code: m.countryCode, title: m.title, map_id: m.mapId, status: m.status, items: m.items, detail: m.detail ?? null, published_hash: m.status === 'ok' || m.status === 'skipped' ? ex.countries[m.countryCode]?.hash ?? null : null })) }) });
      reportOk = true;
    } catch (e) { o.log?.(`publish: status report failed (${(e as Error).message}); the next run reports again`); }
    return { status: r.status, reason: 'reason' in r ? r.reason : undefined, perMap, export: ex, reportOk, ms: Date.now() - t0 };
  } finally { store.close(); }
}

/**
 * Stay connected to the collection's live events and publish shortly after every change (debounced), plus a full
 * check every `periodicMin` minutes. Ends after `maxMinutes` (the scheduled task starts it again).
 */
export async function publishWatch(cfg: Config, o: PublishOptions & { maxMinutes?: number; debounceMs?: number; periodicMin?: number; onPublished?: (r: PublishResult) => void }): Promise<void> {
  const end = Date.now() + (o.maxMinutes ?? 14) * 60_000;
  let running = false, again = false, timer: NodeJS.Timeout | null = null;
  const run = async (why: string) => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        try { const r = await publishOnce(cfg, o); o.log?.(`publish (${why}): ${r.status}${r.reason ? ` — ${r.reason}` : ''} in ${(r.ms / 1000).toFixed(1)} s`); o.onPublished?.(r); }
        catch (e) { o.log?.(`publish (${why}) failed: ${(e as Error).message}`); }
      } while (again && Date.now() < end);
    } finally { running = false; }
  };
  const schedule = (why: string) => { if (timer) clearTimeout(timer); timer = setTimeout(() => void run(why), o.debounceMs ?? 3000); };
  await run('start');
  const periodic = setInterval(() => void run('periodic'), (o.periodicMin ?? 15) * 60_000);
  let lastVersion = '';
  try {
    while (Date.now() < end) {
      try {
        const ctl = new AbortController();
        const stop = setTimeout(() => ctl.abort(), Math.max(1000, end - Date.now()));
        const r = await (o.fetch ?? fetch)(`${o.url.replace(/\/$/, '')}/api/publisher/events`, { headers: { authorization: `Bearer ${o.token}` }, signal: ctl.signal });
        if (!r.ok || !r.body) throw new Error(`events: HTTP ${r.status}`);
        o.log?.('publish: listening for changes');
        const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf('\n\n')) >= 0) {
            const evt = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = evt.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
            if (!data) continue;
            try { const v = JSON.parse(data).version; if (lastVersion && v !== lastVersion) schedule('change'); lastVersion = v; } catch { /* ping */ }
          }
        }
        clearTimeout(stop);
      } catch (e) { if (Date.now() < end) { o.log?.(`publish: event stream ended (${(e as Error).message}); reconnecting`); await new Promise((r) => setTimeout(r, 5000)); } }
    }
  } finally { clearInterval(periodic); if (timer) clearTimeout(timer); while (running) await new Promise((r) => setTimeout(r, 500)); }
}
