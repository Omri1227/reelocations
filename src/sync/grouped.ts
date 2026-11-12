import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db.ts';
import { buildSnapshot, toKml, type RemoteFeature, type SnapshotFeature } from './kml.ts';
import type { SyncOutcome } from './sync.ts';

/**
 * Google Maps (iPhone) shows My Maps as: You → Maps → <map>, and inside a map a legend whose sections are the map's
 * layers. My Maps has no nested folders and allows 10 layers per map (support.google.com/mymaps/answer/3024933), so the
 * closest real "Japan → Kyoto / Tokyo" structure is ONE MAP PER COUNTRY with ONE LAYER PER CITY/LOCALITY.
 *
 * Stable assignment (places never jump between layers): within a country, the first 9 localities (by when their first
 * place was saved) get their own layer; every later locality shares the 10th layer "Other places".
 */
export const MAX_LAYERS = 10;
/** The layer swap adds the new layer before deleting the old one, so a map must keep one slot free (live 2026-11-11:
 *  "You have reached the layer limit for this map" once the plan used all 10). */
export const PLANNED_LAYERS = MAX_LAYERS - 1;
export const OTHER_LAYER = 'Other places';

export interface MultiMapSink {
  target(mapId: string, layerName: string): unknown;
  readAllLayers(): Promise<{ name: string; features: RemoteFeature[] }[]>;
  replaceLayer(kmlFile: string, expectIds: string[]): Promise<void>;
  createMap?(title: string): Promise<string>;
  /** Delete every layer with this name from the targeted map. */
  removeLayer?(name: string): Promise<void>;
  close?(): Promise<void>;
}

export interface LayerPlan { name: string; features: SnapshotFeature[]; ids: string[]; kml: string; hash: string }
export interface MapPlan { countryCode: string; country: string; title: string; layers: LayerPlan[]; ids: string[] }

export function flagEmoji(cc: string): string {
  return /^[a-z]{2}$/i.test(cc) ? String.fromCodePoint(...[...cc.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : '🌍';
}

export function mapTitle(prefix: string, country: string, cc: string): string { return `${prefix}${flagEmoji(cc)} ${country}`; }

/** Country maps with city layers; places still waiting for their country/city lookup are returned separately. */
export const OTHER_COUNTRIES = '🌍 Other countries';

/**
 * layout 'one-map' (your choice, 2026-11-10): ONE map titled `mapTitle`, one layer per country ("🇨🇱 Chile"); the first 9
 * countries (by first saved place) get their own layer, later ones share "🌍 Other countries". The city is in each pin's
 * description. layout 'per-country': one map per country, one layer per city.
 */
export function planGroups(store: Store, opts: { titlePrefix: string; layout?: 'one-map' | 'per-country'; mapTitle?: string }): { maps: MapPlan[]; waiting: number } {
  const snap = buildSnapshot(store, 'all');
  const byPlace = new Map(store.listPlaces().map((p) => [p.place_id, p]));
  const placeOf = (f: SnapshotFeature) => byPlace.get(f.id.slice(3).split('#')[0]!);
  const countries = new Map<string, { country: string; feats: { f: SnapshotFeature; locality: string; firstSeen: string }[] }>();
  let waiting = 0;
  for (const f of snap.features) {
    const p = placeOf(f);
    if (!p?.country_code) { waiting++; continue; }
    const c = countries.get(p.country_code) ?? { country: p.country ?? p.country_code.toUpperCase(), feats: [] };
    c.feats.push({ f, locality: p.locality ?? OTHER_LAYER, firstSeen: p.created_at });
    countries.set(p.country_code, c);
  }
  const maps: MapPlan[] = [];
  if ((opts.layout ?? 'one-map') === 'one-map') {
    if (!countries.size) return { maps, waiting };
    const first = (c: { feats: { firstSeen: string }[] }) => c.feats.map((x) => x.firstSeen).sort()[0]!;
    const order = [...countries].sort((a, b) => first(a[1]).localeCompare(first(b[1])) || a[1].country.localeCompare(b[1].country));
    const own = new Set(order.slice(0, PLANNED_LAYERS - 1).map(([cc]) => cc));
    const layers = new Map<string, SnapshotFeature[]>();
    for (const [cc, c] of order) { const name = own.has(cc) ? `${flagEmoji(cc)} ${c.country}` : OTHER_COUNTRIES; layers.set(name, [...(layers.get(name) ?? []), ...c.feats.map((x) => x.f)]); }
    const lp: LayerPlan[] = [...layers].sort((a, b) => (a[0] === OTHER_COUNTRIES ? 1 : b[0] === OTHER_COUNTRIES ? -1 : a[0].replace(/^S+s/, '').localeCompare(b[0].replace(/^S+s/, '')))).map(([name, features]) => {
      const kml = toKml(features, name);
      return { name, features, ids: features.map((f) => f.id), kml, hash: crypto.createHash('sha256').update(kml).digest('hex').slice(0, 16) };
    });
    maps.push({ countryCode: 'all', country: 'All countries', title: opts.mapTitle ?? 'Reels', layers: lp, ids: lp.flatMap((l) => l.ids) });
    return { maps, waiting };
  }
  for (const [cc, c] of [...countries].sort((a, b) => a[1].country.localeCompare(b[1].country))) {
    const firstSeen = new Map<string, string>();
    for (const x of c.feats) if (x.locality !== OTHER_LAYER && (!firstSeen.has(x.locality) || x.firstSeen < firstSeen.get(x.locality)!)) firstSeen.set(x.locality, x.firstSeen);
    const own = new Set([...firstSeen].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])).slice(0, PLANNED_LAYERS - 1).map(([l]) => l));
    const layers = new Map<string, SnapshotFeature[]>();
    for (const x of c.feats) { const l = own.has(x.locality) ? x.locality : OTHER_LAYER; layers.set(l, [...(layers.get(l) ?? []), x.f]); }
    const lp: LayerPlan[] = [...layers].sort((a, b) => (a[0] === OTHER_LAYER ? 1 : b[0] === OTHER_LAYER ? -1 : a[0].localeCompare(b[0]))).map(([name, features]) => {
      const kml = toKml(features, name);
      return { name, features, ids: features.map((f) => f.id), kml, hash: crypto.createHash('sha256').update(kml).digest('hex').slice(0, 16) };
    });
    maps.push({ countryCode: cc, country: c.country, title: mapTitle(opts.titlePrefix, c.country, cc), layers: lp, ids: lp.flatMap((l) => l.ids) });
  }
  return { maps, waiting };
}

const slug = (s: string) => s.normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'layer';

/**
 * Push every country map. Per map: refuse if a managed layer holds something this tool did not create; per layer:
 * skip if unchanged on Google, else the verified layer swap (MyMapsBrowserSink.replaceLayer). Afterwards each map is
 * read back and every layer must appear exactly once with all its places.
 */
export interface MapResult { countryCode: string; title: string; mapId: string | null; status: 'ok' | 'skipped' | 'failed' | 'blocked'; items: number; detail?: string }

export async function syncGrouped(store: Store, sink: MultiMapSink, opts: { mode: 'real' | 'test'; titlePrefix: string; layout?: 'one-map' | 'per-country'; mapTitle?: string; outDir: string; autoCreate: boolean; force?: boolean; allowRemoval?: boolean; log?: (m: string) => void; onlyCountries?: string[] }): Promise<SyncOutcome & { maps?: { title: string; layers: string[] }[]; waiting?: number; perMap?: MapResult[] }> {
  let { maps, waiting } = planGroups(store, { titlePrefix: opts.titlePrefix, layout: opts.layout, mapTitle: opts.mapTitle });
  if (opts.onlyCountries) maps = maps.filter((m) => opts.onlyCountries!.includes(m.countryCode));
  fs.mkdirSync(opts.outDir, { recursive: true });
  const total = maps.reduce((n, m) => n + m.ids.length, 0);
  const allHash = crypto.createHash('sha256').update(maps.map((m) => `${m.title}|${m.layers.map((l) => `${l.name}:${l.hash}`).join(',')}`).join('\n')).digest('hex').slice(0, 16);
  const wait = waiting ? ` (${waiting} place(s) wait for their country/city lookup)` : '';
  if (!maps.length) return { status: 'skipped', reason: `nothing to sync yet${wait}`, perMap: [] };
  const lastOk = store.getKv(`grouped:${opts.mode}:last_ok_hash`);
  if (!opts.force && lastOk === allHash) return { status: 'skipped', reason: `Google maps already match local data${wait}`, perMap: maps.map((m) => ({ countryCode: m.countryCode, title: m.title, mapId: store.getKv(`map:${opts.mode}:${m.countryCode}`) ?? null, status: 'skipped' as const, items: m.ids.length })) };
  const runId = store.startSync();
  const summary: { title: string; layers: string[] }[] = [];
  const perMap: MapResult[] = [];
  // Each map on its own: one country failing (or waiting for a one-time Google action) never blocks the others.
  for (const m of maps) {
    const key = `map:${opts.mode}:${m.countryCode}`;
    const mapHash = crypto.createHash('sha256').update(`${m.title}|${m.layers.map((l) => `${l.name}:${l.hash}`).join(',')}`).digest('hex').slice(0, 16);
    let mapId = store.getKv(key) ?? null;
    // Unchanged since it was last verified on Google: no read, no import.
    if (!opts.force && mapId && store.getKv(`mapok:${opts.mode}:${m.countryCode}`) === mapHash) { perMap.push({ countryCode: m.countryCode, title: m.title, mapId, status: 'skipped', items: m.ids.length }); summary.push({ title: m.title, layers: m.layers.map((l) => `${l.name} (${l.ids.length})`) }); continue; }
    try {
      if (!mapId) {
        if (!opts.autoCreate || !sink.createMap) {
          perMap.push({ countryCode: m.countryCode, title: m.title, mapId: null, status: 'blocked', items: m.ids.length, detail: `no My Maps map registered for ${m.country}. Create a map titled "${m.title}" and run: npm run cli -- register-map ${m.countryCode} <map id>${opts.mode === 'test' ? ' --test-map' : ''}` });
          continue;
        }
        mapId = await sink.createMap(m.title);
        store.setKv(key, mapId);
        opts.log?.(`created map "${m.title}"`);
      }
      sink.target(mapId, '');
      const remote = await sink.readAllLayers();
      const managed = new Set([...m.layers.map((l) => l.name), ...JSON.parse(store.getKv(`layers:${mapId}`) ?? '[]')]);
      const mine = new Set(m.ids);
      // "Foreign" = not created by this tool. An item whose id is one of OUR places (e.g. an approximate pin that a
      // confirmed place has superseded) may leave the map: the database keeps it, so nothing is lost.
      // ... or one this tool retracted (kv "retracted:<id>": a wrongly matched station, or a pin deleted by its owner).
      const ours = (rmId: string) => mine.has(rmId) || !!store.getPlace(rmId.slice(3).split('#')[0]!) || !!store.getKv(`retracted:${rmId}`) || !!store.getKv(`retracted:rm:${rmId.slice(3).split('#')[0]}`);
      const foreign = remote.filter((l) => managed.has(l.name)).flatMap((l) => l.features).filter((f) => !f.rmId || !ours(f.rmId));
      if (foreign.length && !opts.allowRemoval) {
        perMap.push({ countryCode: m.countryCode, title: m.title, mapId, status: 'blocked', items: m.ids.length, detail: `refusing to change "${m.title}": its layers hold ${foreign.length} item(s) this tool did not create (${foreign.slice(0, 3).map((f) => f.name || '(untitled)').join(', ')}). Nothing was changed. Move them to a layer with another name.` });
        continue;
      }
      // Layers this tool made that the plan no longer uses (e.g. a city now in "Other places"): delete them FIRST, so
      // the swaps below have a free slot. Only when every item on them is placed elsewhere in this plan or is a
      // retracted/superseded pin of ours, so no place can disappear.
      const planned = new Set(m.layers.map((l) => l.name));
      for (const old of remote.filter((l) => managed.has(l.name) && !planned.has(l.name))) {
        const stranded = old.features.filter((f) => !f.rmId || (!mine.has(f.rmId) && !ours(f.rmId)));
        if (stranded.length || !sink.removeLayer) continue;
        sink.target(mapId, '');
        await sink.removeLayer(old.name);
        managed.delete(old.name);
        store.db.prepare('DELETE FROM kv WHERE k=?').run(`layerhash:${mapId}:${old.name}`);
        opts.log?.(`"${m.title}": removed layer "${old.name}" (its ${old.features.length} item(s) now live in other layers or were deleted)`);
      }
      store.setKv(`layers:${mapId}`, JSON.stringify([...managed]));
      for (const l of m.layers) {
        const onGoogle = remote.filter((r) => r.name === l.name);
        const upToDate = onGoogle.length === 1 && store.getKv(`layerhash:${mapId}:${l.name}`) === l.hash && l.ids.every((id) => onGoogle[0]!.features.some((f) => f.rmId === id)) && onGoogle[0]!.features.length === l.ids.length;
        if (upToDate && !opts.force) continue;
        const file = path.join(opts.outDir, `${opts.mode}-${m.countryCode}-${slug(l.name)}.kml`);
        fs.writeFileSync(file, l.kml);
        sink.target(mapId, l.name);
        await sink.replaceLayer(file, l.ids);
        store.setKv(`layerhash:${mapId}:${l.name}`, l.hash);
        opts.log?.(`"${m.title}" → layer "${l.name}": ${l.ids.length} item(s) written`);
      }
      sink.target(mapId, '');
      const after = await sink.readAllLayers();
      for (const l of m.layers) {
        const got = after.filter((r) => r.name === l.name);
        const missing = got.length === 1 ? l.ids.filter((id) => !got[0]!.features.some((f) => f.rmId === id)) : l.ids;
        if (got.length !== 1 || missing.length) throw new Error(`verification failed for "${m.title}" / "${l.name}": ${got.length} layer(s) with that name, ${missing.length} of ${l.ids.length} item(s) missing`);
      }
      // Deleted pins must really be gone from Google too.
      const lingering = after.filter((r) => planned.has(r.name)).flatMap((r) => r.features).filter((f) => f.rmId && !mine.has(f.rmId));
      if (lingering.length) throw new Error(`verification failed for "${m.title}": ${lingering.length} removed item(s) still on Google (${lingering.slice(0, 3).map((f) => f.name).join(', ')})`);
      store.setKv(`mapok:${opts.mode}:${m.countryCode}`, mapHash);
      perMap.push({ countryCode: m.countryCode, title: m.title, mapId, status: 'ok', items: m.ids.length });
      summary.push({ title: m.title, layers: m.layers.map((l) => `${l.name} (${l.ids.length})`) });
    } catch (e) {
      const reason = String((e as Error).message ?? e);
      store.db.prepare('DELETE FROM kv WHERE k=?').run(`mapok:${opts.mode}:${m.countryCode}`);
      perMap.push({ countryCode: m.countryCode, title: m.title, mapId, status: 'failed', items: m.ids.length, detail: reason });
      opts.log?.(`"${m.title}": FAILED — ${reason}`);
    }
  }
  const failed = perMap.filter((p) => p.status === 'failed'), blocked = perMap.filter((p) => p.status === 'blocked');
  if (failed.length || blocked.length) {
    const bad = [...failed, ...blocked];
    const reason = `${bad.length} of ${maps.length} map(s) need attention: ${bad.map((p) => `${p.title}: ${p.detail}`).join(' | ')}`;
    store.finishSync(runId, failed.length ? 'failed' : 'blocked', { hash: allHash, count: total, detail: reason });
    return failed.length ? { status: 'failed', reason, file: opts.outDir, perMap, maps: summary, waiting } : { status: 'blocked', reason, file: opts.outDir, perMap, maps: summary, waiting };
  }
  store.setKv(`grouped:${opts.mode}:last_ok_hash`, allHash);
  store.finishSync(runId, 'ok', { hash: allHash, count: total, detail: `verified ${total} item(s) in ${maps.length} map(s)${wait}` });
  return { status: 'ok', count: total, hash: allHash, file: opts.outDir, maps: summary, waiting, perMap };
}
