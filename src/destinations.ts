import crypto from 'node:crypto';
import type { Store } from './db.ts';
import { nowIso } from './db.ts';

/**
 * Map destinations. Google My Maps has no API: only a browser signed in as the map's owner can write to it. So a
 * destination is a desktop *publisher* (that user's local Chrome profile) which the user explicitly connects with a
 * one-time code. Railway never writes to Google; it only tells each publisher what to publish and records what it did.
 *
 * Layout: ONE MAP PER COUNTRY (a layer per city inside), so a collection can hold any number of countries — the 11th
 * country gets its own map exactly like the first. Status per (destination, country):
 *   ok        — the publisher verified this country's current content on Google
 *   pending   — new or changed content not yet published (incl. a new country whose map is not created yet)
 *   attention — the last attempt for this country failed or was blocked (detail says why); other countries continue
 */
export type MapStatus = 'ok' | 'pending' | 'attention';

export interface ExportRows { places: any[]; reels: any[]; links: any[] }
export interface CollectionExport extends ExportRows {
  collection: { id: number; name: string };
  destination_id: number;
  version: string;
  generated_at: string;
  /** country code → content hash; the publisher reports it back for every country it verified. */
  countries: Record<string, { name: string; hash: string; items: number }>;
  /** Pins deleted from this collection: they must leave the maps and never come back. */
  tombstones: string[];
}

export function exportRows(store: Store, collectionId: number): ExportRows {
  const places = store.placesOfCollection(collectionId);
  const ids = new Set(places.map((p) => p.place_id));
  const reels = store.db.prepare('SELECT reel_key, url, shortcode, first_shared_at, status, status_reason, collection_id, contributed_by, created_at, updated_at FROM reels WHERE collection_id=?').all(collectionId) as any[];
  const links = (store.db.prepare('SELECT rp.* FROM reel_places rp JOIN reels r USING(reel_key) WHERE r.collection_id=?').all(collectionId) as any[]).filter((l) => ids.has(l.place_id));
  return { places, reels, links };
}

/** Per-country hash of what a map shows (pins, names, positions, subtypes, Reel links, cues, photos). */
export function countryHashes(rows: ExportRows): Record<string, { name: string; hash: string; items: number }> {
  const byCc = new Map<string, { name: string; parts: string[]; items: number }>();
  const linksOf = new Map<string, any[]>();
  for (const l of rows.links) linksOf.set(l.place_id, [...(linksOf.get(l.place_id) ?? []), l]);
  const reelOf = new Map(rows.reels.map((r) => [r.reel_key, r]));
  for (const p of rows.places) {
    if (!p.country_code) continue; // waits for its country lookup
    const cc = String(p.country_code).toLowerCase();
    const e = byCc.get(cc) ?? { name: p.country ?? cc.toUpperCase(), parts: [] as string[], items: 0 };
    const ls = (linksOf.get(p.place_id) ?? []).map((l) => `${l.reel_key}|${reelOf.get(l.reel_key)?.url ?? ''}|${reelOf.get(l.reel_key)?.first_shared_at ?? ''}|${l.cue ?? ''}|${l.image_url ?? ''}`).sort();
    e.parts.push([p.place_id, p.name, p.category, p.cuisine ?? '', p.confidence, p.kind, p.lat, p.lon, p.locality ?? '', p.google_place_id ?? '', p.geometry_json ? crypto.createHash('sha1').update(p.geometry_json).digest('hex') : '', ...ls].join('~'));
    e.items++;
    byCc.set(cc, e);
  }
  return Object.fromEntries([...byCc].map(([cc, e]) => [cc, { name: e.name, items: e.items, hash: crypto.createHash('sha256').update(e.parts.sort().join('\n')).digest('hex').slice(0, 20) }]));
}

export function buildExport(store: Store, destinationId: number): CollectionExport {
  const d = store.db.prepare('SELECT * FROM destinations WHERE id=?').get(destinationId) as any;
  const c = store.db.prepare('SELECT id, name FROM collections WHERE id=?').get(d.collection_id) as any;
  const rows = exportRows(store, d.collection_id);
  const tombstones = (store.db.prepare('SELECT place_id FROM tombstones WHERE collection_id=?').all(d.collection_id) as any[]).map((r) => r.place_id);
  return { collection: { id: c.id, name: c.name }, destination_id: destinationId, version: store.collectionVersion(d.collection_id), generated_at: nowIso(), ...rows, countries: countryHashes(rows), tombstones };
}

// ---------------------------------------------------------------------------------------------------------------
export function connectDestination(store: Store, o: { collectionId: number; userId: number; credentialId: number; label: string }): number {
  // One active My Maps destination per (collection, Google account): reconnecting replaces the old credential.
  const old = store.db.prepare('SELECT id, credential_id FROM destinations WHERE collection_id=? AND user_id=? AND kind=? AND disconnected_at IS NULL').get(o.collectionId, o.userId, 'mymaps') as any;
  if (old) {
    store.db.prepare('UPDATE credentials SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?').run(nowIso(), old.credential_id);
    store.db.prepare('UPDATE destinations SET credential_id=?, label=?, last_seen_at=NULL WHERE id=?').run(o.credentialId, o.label, old.id);
    return old.id;
  }
  return Number(store.db.prepare('INSERT INTO destinations(collection_id,user_id,kind,label,credential_id,created_at) VALUES(?,?,?,?,?,?)').run(o.collectionId, o.userId, 'mymaps', o.label, o.credentialId, nowIso()).lastInsertRowid);
}
export function destinationForCredential(store: Store, credentialId: number): any {
  return store.db.prepare('SELECT * FROM destinations WHERE credential_id=? AND disconnected_at IS NULL').get(credentialId);
}
export function disconnectDestination(store: Store, destinationId: number) {
  const d = store.db.prepare('SELECT * FROM destinations WHERE id=?').get(destinationId) as any;
  if (!d) return;
  store.db.prepare('UPDATE destinations SET disconnected_at=COALESCE(disconnected_at, ?) WHERE id=?').run(nowIso(), destinationId);
  if (d.credential_id) store.db.prepare('UPDATE credentials SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?').run(nowIso(), d.credential_id);
}

export interface MapReport { country_code: string; title?: string; map_id?: string | null; status: 'ok' | 'failed' | 'blocked' | 'skipped'; items?: number; published_hash?: string | null; detail?: string | null }
export function recordReport(store: Store, destinationId: number, maps: MapReport[]) {
  const ts = nowIso();
  store.db.prepare('UPDATE destinations SET last_seen_at=? WHERE id=?').run(ts, destinationId);
  for (const m of maps) {
    const cc = String(m.country_code).toLowerCase().slice(0, 8);
    const prev = store.db.prepare('SELECT * FROM destination_maps WHERE destination_id=? AND country_code=?').get(destinationId, cc) as any;
    // "skipped" = the publisher checked this country and Google already shows exactly what it would publish (e.g. only
    // a restaurant subtype changed, which My Maps does not show): the current content counts as published.
    if (m.status === 'skipped' && prev) {
      store.db.prepare(`UPDATE destination_maps SET updated_at=?, published_hash=COALESCE(?, published_hash), status=CASE WHEN status IN ('failed','blocked') THEN status ELSE 'ok' END, detail=NULL WHERE destination_id=? AND country_code=?`)
        .run(ts, m.published_hash ?? null, destinationId, cc);
      continue;
    }
    const ok = m.status === 'ok' || m.status === 'skipped';
    store.db.prepare(`INSERT INTO destination_maps(destination_id,country_code,title,map_id,status,items,published_hash,detail,updated_at,published_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(destination_id,country_code) DO UPDATE SET title=COALESCE(excluded.title,title), map_id=COALESCE(excluded.map_id,map_id), status=excluded.status, items=COALESCE(excluded.items,items),
      published_hash=CASE WHEN excluded.status IN ('ok','skipped') THEN excluded.published_hash ELSE published_hash END, detail=excluded.detail, updated_at=excluded.updated_at,
      published_at=CASE WHEN excluded.status='ok' THEN excluded.published_at ELSE published_at END`)
      .run(destinationId, cc, m.title ?? null, m.map_id ?? null, m.status, m.items ?? null, ok ? m.published_hash ?? null : null, m.detail ?? null, ts, m.status === 'ok' ? ts : null);
  }
}

/** Status of every country of a collection on every connected destination (for the website). */
export function collectionSyncStatus(store: Store, collectionId: number) {
  const rows = exportRows(store, collectionId);
  const hashes = countryHashes(rows);
  const dests = store.db.prepare('SELECT d.*, u.email FROM destinations d JOIN users u ON u.id=d.user_id WHERE d.collection_id=? AND d.disconnected_at IS NULL ORDER BY d.id').all(collectionId) as any[];
  const unsorted = rows.places.filter((p) => !p.country_code).length;
  return {
    unsorted,
    destinations: dests.map((d) => {
      const maps = new Map((store.db.prepare('SELECT * FROM destination_maps WHERE destination_id=?').all(d.id) as any[]).map((m) => [m.country_code, m]));
      const online = !!d.last_seen_at && Date.now() - Date.parse(d.last_seen_at) < 20 * 60_000;
      const countries = Object.entries(hashes).map(([cc, h]) => {
        const m = maps.get(cc) as any;
        let status: MapStatus; let detail: string | null = null;
        if (m && (m.status === 'failed' || m.status === 'blocked') ) { status = 'attention'; detail = m.detail; }
        else if (m && m.published_hash === h.hash) status = 'ok';
        else { status = 'pending'; detail = m ? 'changes waiting to be published' : 'new country: its map is created on the next publish'; }
        if (status === 'pending' && !online) detail = `${detail} — the publisher (desktop) is offline`;
        return { country_code: cc, country: h.name, items: h.items, status, detail, map_id: m?.map_id ?? null, title: m?.title ?? null, published_at: m?.published_at ?? null };
      });
      const worst: MapStatus = countries.some((c) => c.status === 'attention') ? 'attention' : countries.some((c) => c.status === 'pending') ? 'pending' : 'ok';
      return { id: d.id, owner: d.email, user_id: d.user_id, label: d.label, last_seen_at: d.last_seen_at, online, status: worst, countries };
    }),
  };
}
