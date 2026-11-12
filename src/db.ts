import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Candidate, Capabilities, Category, Confidence, PlaceRow, ReelStatus, SourceKind } from './types.ts';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS shares (
  intake_id    TEXT PRIMARY KEY,           -- idempotency key from the inbox; repeated delivery is a no-op
  reel_key     TEXT NOT NULL,
  raw_text     TEXT,
  input_types  TEXT,
  shared_at    TEXT NOT NULL,              -- original phone timestamp, never rewritten
  received_at  TEXT NOT NULL,
  note         TEXT
);
CREATE TABLE IF NOT EXISTS reels (
  reel_key         TEXT PRIMARY KEY,       -- ig:<shortcode> | url:<hash> | media:<id>
  url              TEXT,
  shortcode        TEXT,
  first_shared_at  TEXT NOT NULL,
  status           TEXT NOT NULL,
  status_reason    TEXT,
  metadata_json    TEXT,
  capabilities_json TEXT,
  evidence_json    TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT,
  last_error       TEXT,
  vision_used      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS places (
  place_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  lat             REAL NOT NULL,
  lon             REAL NOT NULL,
  geometry_json   TEXT,
  trailhead_json  TEXT,
  confidence      TEXT NOT NULL,
  source          TEXT NOT NULL,
  address         TEXT,
  google_place_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reel_places (
  reel_key    TEXT NOT NULL REFERENCES reels(reel_key),
  place_id    TEXT NOT NULL REFERENCES places(place_id),
  cue         TEXT,
  cue_source  TEXT,
  role        TEXT NOT NULL DEFAULT 'featured',
  decided_by  TEXT NOT NULL,              -- auto | user
  created_at  TEXT NOT NULL,
  PRIMARY KEY (reel_key, place_id)
);
CREATE TABLE IF NOT EXISTS candidates (
  reel_key   TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  clue_text  TEXT,
  json       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (reel_key, idx)
);
CREATE TABLE IF NOT EXISTS media (
  media_id    TEXT PRIMARY KEY,
  reel_key    TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- image | video
  mime        TEXT,
  remote_ref  TEXT,
  local_path  TEXT,
  status      TEXT NOT NULL,              -- pending | downloaded | processed | failed
  error       TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,              -- running | ok | skipped | failed | blocked
  snapshot_hash TEXT,
  feature_count INTEGER,
  detail      TEXT
);
CREATE TABLE IF NOT EXISTS budget_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  month       TEXT NOT NULL,
  provider    TEXT NOT NULL,
  reserved_usd REAL NOT NULL,
  actual_usd  REAL,
  status      TEXT NOT NULL,              -- reserved | settled | released
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS http_cache (
  key        TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL, scope TEXT, message TEXT NOT NULL
);
`;

export const nowIso = () => new Date().toISOString();

export interface ReelRow {
  reel_key: string; url: string | null; shortcode: string | null; first_shared_at: string; status: ReelStatus;
  status_reason: string | null; metadata_json: string | null; capabilities_json: string | null; evidence_json: string | null;
  attempts: number; next_attempt_at: string | null; last_error: string | null; vision_used: number; created_at: string; updated_at: string;
  collection_id?: number; contributed_by?: number | null;
}
export interface ShareRow { intake_id: string; reel_key: string; raw_text: string | null; input_types: string | null; shared_at: string; received_at: string; note: string | null }
export interface MediaRow { media_id: string; reel_key: string; kind: 'image' | 'video'; mime: string | null; remote_ref: string | null; local_path: string | null; status: string; error: string | null; created_at: string }
export interface ReelPlaceRow { reel_key: string; place_id: string; cue: string | null; cue_source: string | null; role: string; decided_by: string; created_at: string }

/** Compare two ISO-8601 timestamps that may carry different UTC offsets. */
export function isoBefore(a: string, b: string): boolean {
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a < b;
  return ta < tb;
}

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive migrations only (columns are never dropped). */
  private migrate() {
    const cols = new Set((this.db.prepare('PRAGMA table_info(places)').all() as any[]).map((c) => c.name));
    // Geographic grouping (country → city/locality), filled by a reverse lookup; NULL = not looked up yet.
    for (const c of ['country', 'country_code', 'locality', 'region', 'coords_fetched_at']) if (!cols.has(c)) this.db.exec(`ALTER TABLE places ADD COLUMN ${c} TEXT`);
    // Pin image per Reel–place link: local file, kind (place = shows/names this place; preview = general Reel frame),
    // time in the video, and the shared URL once uploaded.
    const lc = new Set((this.db.prepare('PRAGMA table_info(reel_places)').all() as any[]).map((c) => c.name));
    for (const c of ['image_path', 'image_kind', 'image_t', 'image_url']) if (!lc.has(c)) this.db.exec(`ALTER TABLE reel_places ADD COLUMN ${c} TEXT`);
    // Restaurant subtype (cuisine) and the Google listing's types it may come from.
    for (const c of ['cuisine', 'cuisine_source', 'google_types']) if (!cols.has(c)) this.db.exec(`ALTER TABLE places ADD COLUMN ${c} TEXT`);
    // Accounts & collections (2026-11-11). Every Reel belongs to one collection; existing data = collection 1.
    const rc = new Set((this.db.prepare('PRAGMA table_info(reels)').all() as any[]).map((c) => c.name));
    if (!rc.has('collection_id')) this.db.exec('ALTER TABLE reels ADD COLUMN collection_id INTEGER NOT NULL DEFAULT 1');
    if (!rc.has('contributed_by')) this.db.exec('ALTER TABLE reels ADD COLUMN contributed_by INTEGER');
    const sc = new Set((this.db.prepare('PRAGMA table_info(shares)').all() as any[]).map((c) => c.name));
    if (!sc.has('user_id')) this.db.exec('ALTER TABLE shares ADD COLUMN user_id INTEGER');
    // Which Reel and model each paid call was for (AI usage estimate: calls per Reel, cost per call for the model).
    const bc = new Set((this.db.prepare('PRAGMA table_info(budget_ledger)').all() as any[]).map((c) => c.name));
    for (const c of ['ref', 'model']) if (!bc.has(c)) this.db.exec(`ALTER TABLE budget_ledger ADD COLUMN ${c} TEXT`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, email TEXT, name TEXT, picture TEXT, created_at TEXT NOT NULL, last_login_at TEXT);
      CREATE TABLE IF NOT EXISTS collections (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_user_id INTEGER, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (collection_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (collection_id, user_id));
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, collection_id INTEGER, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT);
      CREATE TABLE IF NOT EXISTS invitations (code_hash TEXT PRIMARY KEY, collection_id INTEGER NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_by INTEGER, used_at TEXT, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS credentials (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL, collection_id INTEGER NOT NULL, label TEXT, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS pairing_codes (code_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id INTEGER NOT NULL, collection_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, credential_id INTEGER);
      CREATE TABLE IF NOT EXISTS destinations (id INTEGER PRIMARY KEY, collection_id INTEGER NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT, credential_id INTEGER, created_at TEXT NOT NULL, disconnected_at TEXT, last_seen_at TEXT);
      CREATE TABLE IF NOT EXISTS destination_maps (destination_id INTEGER NOT NULL, country_code TEXT NOT NULL, title TEXT, map_id TEXT, status TEXT NOT NULL, items INTEGER, published_hash TEXT, detail TEXT, updated_at TEXT NOT NULL, published_at TEXT, PRIMARY KEY (destination_id, country_code));
      CREATE TABLE IF NOT EXISTS tombstones (collection_id INTEGER NOT NULL, place_id TEXT NOT NULL, name TEXT, deleted_by INTEGER, deleted_at TEXT NOT NULL, PRIMARY KEY (collection_id, place_id));
      INSERT OR IGNORE INTO collections(id, name, owner_user_id, created_at) VALUES (1, 'My Reels', NULL, '2026-11-09T00:00:00Z');
      -- Personal state per signed-in user (never shared with other members): stars and "opened" (clears New).
      CREATE TABLE IF NOT EXISTS user_place_state (user_id INTEGER NOT NULL, collection_id INTEGER NOT NULL, place_id TEXT NOT NULL, starred_at TEXT, seen_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, collection_id, place_id));
      -- Pins added to the collection before this time are never "New" for this user (set on first view: an existing
      -- collection does not light up as new all at once).
      CREATE TABLE IF NOT EXISTS user_collection_state (user_id INTEGER NOT NULL, collection_id INTEGER NOT NULL, new_since TEXT NOT NULL, PRIMARY KEY (user_id, collection_id));
      -- A person's restaurant-subtype correction belongs to their collection: place rows are shared between collections
      -- (one row per Google listing), so writing it onto the place changed it for every other collection too.
      CREATE TABLE IF NOT EXISTS collection_place_cuisine (collection_id INTEGER NOT NULL, place_id TEXT NOT NULL, cuisine TEXT, set_by INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY (collection_id, place_id));
    `);
    if (!this.getKv('migrated:collection_cuisine')) this.tx(() => {
      // Corrections made before: keep them, for the collections that showed the place at the time.
      this.db.exec(`INSERT OR IGNORE INTO collection_place_cuisine(collection_id, place_id, cuisine, updated_at)
        SELECT DISTINCT r.collection_id, p.place_id, p.cuisine, p.updated_at FROM places p JOIN reel_places rp USING(place_id) JOIN reels r USING(reel_key) WHERE p.cuisine_source='user'`);
      // The shared row goes back to the automatic subtype (re-inferred by the next cycle).
      this.db.exec("UPDATE places SET cuisine=NULL, cuisine_source=NULL WHERE cuisine_source='user'");
      this.setKv('migrated:collection_cuisine', nowIso());
    });
  }
  /** The collection's own subtype correction (`null` cuisine = "not set" chosen by a person). */
  setCollectionCuisine(collectionId: number, placeId: string, cuisine: string | null, userId: number | null) {
    this.db.prepare(`INSERT INTO collection_place_cuisine(collection_id, place_id, cuisine, set_by, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(collection_id, place_id) DO UPDATE SET cuisine=excluded.cuisine, set_by=excluded.set_by, updated_at=excluded.updated_at`).run(collectionId, placeId, cuisine, userId, nowIso());
  }

  // ---------- personal state (stars, New) ----------
  /** The user's "new since" time for a collection, created (= now) on first use. */
  newSince(userId: number, collectionId: number): string {
    this.db.prepare('INSERT OR IGNORE INTO user_collection_state(user_id, collection_id, new_since) VALUES (?,?,?)').run(userId, collectionId, nowIso());
    return String((this.db.prepare('SELECT new_since FROM user_collection_state WHERE user_id=? AND collection_id=?').get(userId, collectionId) as any).new_since);
  }
  userPlaceState(userId: number, collectionId: number): Map<string, { starred_at: string | null; seen_at: string | null }> {
    const rows = this.db.prepare('SELECT place_id, starred_at, seen_at FROM user_place_state WHERE user_id=? AND collection_id=?').all(userId, collectionId) as any[];
    return new Map(rows.map((r) => [r.place_id, { starred_at: r.starred_at, seen_at: r.seen_at }]));
  }
  setStar(userId: number, collectionId: number, placeId: string, starred: boolean) {
    const now = nowIso();
    this.db.prepare(`INSERT INTO user_place_state(user_id, collection_id, place_id, starred_at, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, collection_id, place_id) DO UPDATE SET starred_at=excluded.starred_at, updated_at=excluded.updated_at`).run(userId, collectionId, placeId, starred ? now : null, now);
  }
  markSeen(userId: number, collectionId: number, placeId: string) {
    const now = nowIso();
    this.db.prepare(`INSERT INTO user_place_state(user_id, collection_id, place_id, seen_at, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, collection_id, place_id) DO UPDATE SET seen_at=COALESCE(user_place_state.seen_at, excluded.seen_at), updated_at=excluded.updated_at`).run(userId, collectionId, placeId, now, now);
  }
  userStateVersion(userId: number, collectionId: number): string {
    return String((this.db.prepare('SELECT count(*) || \':\' || ifnull(max(updated_at),\'\') v FROM user_place_state WHERE user_id=? AND collection_id=?').get(userId, collectionId) as any).v);
  }
  /** Reels of a collection waiting for a person (the Review Queue): needs review, or failed for good. */
  reviewCount(collectionId: number): number {
    return Number((this.db.prepare("SELECT count(*) n FROM reels WHERE collection_id=? AND status IN ('needs_review','error')").get(collectionId) as any).n);
  }

  // ---------- collections ----------
  collectionOf(reelKey: string): number { return Number((this.db.prepare('SELECT collection_id c FROM reels WHERE reel_key=?').get(reelKey) as any)?.c ?? 1); }
  isTombstoned(collectionId: number, placeId: string): boolean { return !!this.db.prepare('SELECT 1 FROM tombstones WHERE collection_id=? AND place_id=?').get(collectionId, placeId); }
  /** Pins of one collection (linked through its Reels, deleted ones excluded). */
  placesOfCollection(collectionId: number): PlaceRow[] {
    // The collection's own subtype correction wins over the shared place row (see collection_place_cuisine).
    return this.db.prepare(`SELECT p.*, CASE WHEN o.place_id IS NULL THEN p.cuisine ELSE o.cuisine END AS cuisine,
        CASE WHEN o.place_id IS NULL THEN p.cuisine_source ELSE 'user' END AS cuisine_source
      FROM places p LEFT JOIN collection_place_cuisine o ON o.collection_id=? AND o.place_id=p.place_id
      WHERE EXISTS (SELECT 1 FROM reel_places rp JOIN reels r USING(reel_key) WHERE rp.place_id=p.place_id AND r.collection_id=?)
      AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.collection_id=? AND t.place_id=p.place_id) ORDER BY p.created_at`).all(collectionId, collectionId, collectionId) as any;
  }
  linksForPlaceIn(collectionId: number, placeId: string): (ReelPlaceRow & { url: string | null; first_shared_at: string; contributed_by: number | null })[] {
    return this.db.prepare(`SELECT rp.*, r.url, r.first_shared_at, r.contributed_by FROM reel_places rp JOIN reels r USING(reel_key) WHERE rp.place_id=? AND r.collection_id=? ORDER BY r.first_shared_at`).all(placeId, collectionId) as any;
  }
  /** Fingerprint of one collection's map content (pins, links, photos, Reel status, deletions). */
  collectionVersion(collectionId: number): string {
    const r = this.db.prepare(`SELECT (SELECT count(*) || ':' || ifnull(max(rp.created_at),'') || ':' || count(rp.image_path) || ':' || ifnull(max(p.updated_at),'') FROM reel_places rp JOIN reels r USING(reel_key) JOIN places p USING(place_id) WHERE r.collection_id=?) || '|' ||
      (SELECT count(*) || ':' || ifnull(max(updated_at),'') FROM reels WHERE collection_id=?) || '|' || (SELECT count(*) || ':' || ifnull(max(deleted_at),'') FROM tombstones WHERE collection_id=?) || '|' || (SELECT count(*) || ':' || ifnull(max(updated_at),'') FROM collection_place_cuisine WHERE collection_id=?) AS v`).get(collectionId, collectionId, collectionId, collectionId) as any;
    return String(r.v);
  }
  /**
   * Delete a pin from ONE collection (user action; the caller checks permissions). Records a tombstone so re-processing,
   * listing merges or stale publishers never bring it back; drops only this collection's links (the Reels, their other
   * pins and every screenshot file stay); the place row goes when no collection uses it any more.
   */
  deletePlaceFromCollection(collectionId: number, placeId: string, userId: number | null): { name: string; removedLinks: number; placeRowDeleted: boolean } {
    return this.tx(() => {
      const p = this.getPlace(placeId);
      const name = p?.name ?? placeId;
      this.db.prepare('INSERT OR IGNORE INTO tombstones(collection_id, place_id, name, deleted_by, deleted_at) VALUES (?,?,?,?,?)').run(collectionId, placeId, name, userId, nowIso());
      const keys = (this.db.prepare('SELECT rp.reel_key k FROM reel_places rp JOIN reels r USING(reel_key) WHERE rp.place_id=? AND r.collection_id=?').all(placeId, collectionId) as any[]).map((x) => x.k);
      for (const k of keys) {
        this.db.prepare('DELETE FROM reel_places WHERE reel_key=? AND place_id=?').run(k, placeId);
        this.db.prepare('UPDATE reels SET updated_at=? WHERE reel_key=?').run(nowIso(), k);
        // Review options that would re-add this pin are dropped too.
        const cands = this.candidatesFor(k);
        const keep = cands.filter((c) => c.ref !== placeId && c.replacesPlaceId !== placeId);
        if (keep.length !== cands.length) this.replaceCandidatesNoTx(k, keep);
      }
      const left = (this.db.prepare('SELECT COUNT(*) n FROM reel_places WHERE place_id=?').get(placeId) as any).n;
      if (!left && p) { this.db.prepare('DELETE FROM places WHERE place_id=?').run(placeId); this.db.prepare('DELETE FROM kv WHERE k=?').run(`gmatch:${placeId}`); }
      this.log('info', 'delete', `collection ${collectionId}: ${name} (${placeId}) deleted by user ${userId ?? '?'}; ${keys.length} link(s)`);
      return { name, removedLinks: keys.length, placeRowDeleted: !left && !!p };
    });
  }

  /**
   * Remove a whole collection and everything only it holds (account deletion of a sole owner). Place rows another
   * collection still shows stay. Runs inside the caller's transaction; returns the screenshot/media files to delete.
   */
  deleteCollectionData(collectionId: number): string[] {
    const keys = (this.db.prepare('SELECT reel_key k FROM reels WHERE collection_id=?').all(collectionId) as any[]).map((r) => r.k as string);
    const files = new Set<string>();
    const placeIds = new Set<string>();
    for (const k of keys) {
      for (const l of this.db.prepare('SELECT place_id, image_path FROM reel_places WHERE reel_key=?').all(k) as any[]) { placeIds.add(l.place_id); if (l.image_path) files.add(l.image_path); }
      for (const m of this.db.prepare('SELECT local_path FROM media WHERE reel_key=?').all(k) as any[]) if (m.local_path) files.add(m.local_path);
      for (const t of ['reel_places', 'candidates', 'media', 'shares']) this.db.prepare(`DELETE FROM ${t} WHERE reel_key=?`).run(k);
      this.db.prepare('DELETE FROM reels WHERE reel_key=?').run(k);
      this.db.prepare('DELETE FROM events WHERE scope=?').run(`note:${k}`); // notes typed in review
      for (const p of ['ai:sig:', 'ai:result:', 'ai:wait:', 'page:tried:']) this.db.prepare('DELETE FROM kv WHERE k=?').run(p + k);
    }
    // The collection's Google Maps list: the stored Google session, its queue and the fresh-start date. Without this a
    // later collection that gets the same id would inherit a connected Google account.
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gmaps_destinations'").get()) {
      for (const d of this.db.prepare('SELECT id, state_file FROM gmaps_destinations WHERE collection_id=?').all(collectionId) as any[]) {
        if (d.state_file) files.add(d.state_file);
        this.db.prepare('DELETE FROM gmaps_saves WHERE destination_id=?').run(d.id);
      }
      this.db.prepare('DELETE FROM gmaps_destinations WHERE collection_id=?').run(collectionId);
    }
    this.db.prepare('DELETE FROM kv WHERE k=?').run(`gmaps:cutoff:${collectionId}`);
    for (const pid of placeIds) {
      const left = (this.db.prepare('SELECT COUNT(*) n FROM reel_places WHERE place_id=?').get(pid) as any).n;
      if (!left) { this.db.prepare('DELETE FROM places WHERE place_id=?').run(pid); this.db.prepare('DELETE FROM kv WHERE k=?').run(`gmatch:${pid}`); }
    }
    // Files another Reel still uses (none expected: media are per Reel) are kept.
    for (const f of [...files]) if (this.db.prepare('SELECT 1 FROM media WHERE local_path=? UNION SELECT 1 FROM reel_places WHERE image_path=?').get(f, f)) files.delete(f);
    for (const d of (this.db.prepare('SELECT id FROM destinations WHERE collection_id=?').all(collectionId) as any[])) this.db.prepare('DELETE FROM destination_maps WHERE destination_id=?').run(d.id);
    for (const t of ['destinations', 'credentials', 'pairing_codes', 'invitations', 'tombstones', 'collection_place_cuisine', 'user_place_state', 'user_collection_state', 'memberships']) this.db.prepare(`DELETE FROM ${t} WHERE collection_id=?`).run(collectionId);
    this.db.prepare('UPDATE sessions SET collection_id=NULL WHERE collection_id=?').run(collectionId);
    this.db.prepare('DELETE FROM kv WHERE k LIKE ?').run(`country_order:%:${collectionId}`);
    this.db.prepare('DELETE FROM collections WHERE id=?').run(collectionId);
    this.log('info', 'delete', `collection ${collectionId} deleted with ${keys.length} Reel(s)`);
    return [...files];
  }

  /**
   * A Google listing chosen in ONE collection for a pin that other collections show too: that collection's Reels move
   * to a pin for the chosen listing (cues, photos, dates, stars and subtype kept); the shared pin, and any open listing
   * question about it in the other collections, stay as they were. Returns the pin the collection now uses.
   */
  forkPlaceForCollection(collectionId: number, placeId: string, g: { googlePlaceId: string; lat: number; lon: number; address?: string | null; types?: string[] }): string {
    return this.tx(() => {
      const cur = this.getPlace(placeId); if (!cur) throw new Error(`no pin ${placeId}`);
      const ts = nowIso();
      const existing = this.db.prepare('SELECT place_id FROM places WHERE google_place_id=? ORDER BY created_at LIMIT 1').get(g.googlePlaceId) as any;
      let target: string = existing?.place_id;
      if (!target) {
        target = `gplace:${g.googlePlaceId}`;
        if (this.getPlace(target)) target = `gplace:${g.googlePlaceId}:c${collectionId}`;
        const route = cur.kind === 'route';
        this.db.prepare(`INSERT INTO places(place_id,name,category,kind,lat,lon,geometry_json,trailhead_json,confidence,source,address,google_place_id,coords_fetched_at,google_types,
            country,country_code,locality,region,cuisine,cuisine_source,created_at,updated_at)
          SELECT ?, name, category, kind, ?, ?, geometry_json, trailhead_json, 'confirmed',
            CASE WHEN instr(source, 'Google Maps listing') > 0 THEN source ELSE source || ' · Google Maps listing' END, COALESCE(?, address), ?, ?, ?,
            country, country_code, locality, region, cuisine, cuisine_source, created_at, ? FROM places WHERE place_id=?`)
          .run(target, route ? cur.lat : g.lat, route ? cur.lon : g.lon, g.address ?? null, g.googlePlaceId, route ? null : ts, g.types?.length ? g.types.join(',') : cur.google_types ?? null, ts, placeId);
      }
      const keys = (this.db.prepare('SELECT rp.reel_key k FROM reel_places rp JOIN reels r USING(reel_key) WHERE rp.place_id=? AND r.collection_id=?').all(placeId, collectionId) as any[]).map((x) => x.k as string);
      for (const k of keys) {
        this.db.prepare(`INSERT OR IGNORE INTO reel_places(reel_key,place_id,cue,cue_source,role,decided_by,created_at,image_path,image_kind,image_t,image_url)
          SELECT reel_key, ?, cue, cue_source, role, 'user', created_at, image_path, image_kind, image_t, image_url FROM reel_places WHERE reel_key=? AND place_id=?`).run(target, k, placeId);
        this.db.prepare('DELETE FROM reel_places WHERE reel_key=? AND place_id=?').run(k, placeId);
        this.db.prepare('UPDATE reels SET updated_at=? WHERE reel_key=?').run(ts, k);
      }
      for (const t of ['user_place_state', 'collection_place_cuisine']) {
        this.db.prepare(`UPDATE OR IGNORE ${t} SET place_id=? WHERE collection_id=? AND place_id=?`).run(target, collectionId, placeId);
        this.db.prepare(`DELETE FROM ${t} WHERE collection_id=? AND place_id=?`).run(collectionId, placeId);
      }
      this.db.prepare('DELETE FROM tombstones WHERE collection_id=? AND place_id=?').run(collectionId, target);
      this.log('info', 'google-listing', `collection ${collectionId}: ${cur.name} (${placeId}) → its own pin ${target} for the chosen listing; other collections unchanged`);
      return target;
    });
  }

  setLinkImage(reelKey: string, placeId: string, img: { path: string; kind: 'place' | 'preview'; t?: number | null }) {
    // Keep a place-specific image once found; a preview never replaces it.
    this.db.prepare(`UPDATE reel_places SET image_path=?, image_kind=?, image_t=?, image_url=NULL WHERE reel_key=? AND place_id=? AND (image_kind IS NULL OR image_kind='preview' OR ?='place') AND COALESCE(image_path,'')<>?`)
      .run(img.path, img.kind, img.t == null ? null : String(img.t), reelKey, placeId, img.kind, img.path);
  }
  linksNeedingImageUpload(limit = 20): any[] {
    // Uploaded to the original owner's Drive (Apps Script), so only collection 1's photos.
    return this.db.prepare('SELECT rp.reel_key, rp.place_id, rp.image_path FROM reel_places rp JOIN reels r USING(reel_key) WHERE rp.image_path IS NOT NULL AND rp.image_url IS NULL AND r.collection_id=1 LIMIT ?').all(limit) as any[];
  }
  setLinkImageUrl(reelKey: string, placeId: string, url: string) { this.db.prepare('UPDATE reel_places SET image_url=? WHERE reel_key=? AND place_id=?').run(url, reelKey, placeId); }

  /** Pins at Google-sourced coordinates older than `days` (refresh by place ID before Google's 30-day limit). */
  googlePlacesToRefresh(days = 25): PlaceRow[] {
    return this.db.prepare("SELECT * FROM places WHERE google_place_id IS NOT NULL AND (place_id LIKE 'gplace:%' OR coords_fetched_at IS NOT NULL) AND (coords_fetched_at IS NULL OR coords_fetched_at < ?)").all(new Date(Date.now() - days * 86_400_000).toISOString()) as any[];
  }

  /**
   * A clear Google Maps listing match for an existing pin: store the place ID and move the pin to the listing's
   * location. The pin keeps its id, so its Reel links, share dates, category, cue and screenshot stay as they are.
   */
  applyGoogleListing(placeId: string, g: { googlePlaceId: string; lat: number; lon: number; address?: string | null; confirm?: boolean; types?: string[] }) {
    if (g.types?.length) this.db.prepare('UPDATE places SET google_types=? WHERE place_id=?').run(g.types.join(','), placeId);
    const cur = this.getPlace(placeId); if (!cur) return;
    const ts = nowIso();
    const moveCoords = cur.kind !== 'route'; // a route keeps its mapped line and start point
    this.db.prepare(`UPDATE places SET google_place_id=?, lat=?, lon=?, coords_fetched_at=?, address=COALESCE(?, address),
      confidence=CASE WHEN ? AND instr(source, ' · approximate: ') = 0 THEN 'confirmed' ELSE confidence END,
      source=CASE WHEN instr(source, 'Google Maps listing') > 0 OR source='Google Maps' THEN source ELSE source || ' · Google Maps listing' END, updated_at=? WHERE place_id=?`)
      .run(g.googlePlaceId, moveCoords ? g.lat : cur.lat, moveCoords ? g.lon : cur.lon, moveCoords ? ts : null, g.address ?? null, g.confirm ? 1 : 0, ts, placeId);
  }

  /** Monotonic-enough fingerprint of everything the map shows; changes whenever a pin, link, Reel or photo changes. */
  dataVersion(): string {
    const r = this.db.prepare(`SELECT (SELECT count(*) || ':' || ifnull(max(updated_at),'') FROM places) || '|' ||
      (SELECT count(*) || ':' || ifnull(max(created_at),'') || ':' || count(image_path) FROM reel_places) || '|' ||
      (SELECT count(*) || ':' || ifnull(max(updated_at),'') FROM reels) || '|' || (SELECT count(*) FROM media WHERE status IN ('downloaded','processed')) AS v`).get() as any;
    return String(r.v);
  }
  setPlaceCoords(placeId: string, lat: number, lon: number) { this.db.prepare('UPDATE places SET lat=?, lon=?, coords_fetched_at=?, updated_at=? WHERE place_id=?').run(lat, lon, new Date().toISOString(), new Date().toISOString(), placeId); }

  /** Places still missing country/locality (looked up by the worker, ≤1 req/s). */
  placesWithoutLocality(limit = 20): PlaceRow[] {
    return this.db.prepare('SELECT * FROM places WHERE country_code IS NULL ORDER BY created_at LIMIT ?').all(limit) as any[];
  }
  setLocality(placeId: string, g: { country: string | null; country_code: string | null; locality: string | null; region: string | null }) {
    this.db.prepare('UPDATE places SET country=?, country_code=?, locality=?, region=?, updated_at=? WHERE place_id=?')
      .run(g.country, g.country_code, g.locality, g.region, nowIso(), placeId);
  }
  close() { this.db.close(); }

  private txDepth = 0;
  /** Atomic block; nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) { this.txDepth++; try { return fn(); } finally { this.txDepth--; } }
    this.db.exec('BEGIN IMMEDIATE'); this.txDepth = 1;
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } finally { this.txDepth = 0; }
  }

  // ---------- kv / events ----------
  getKv(k: string): string | undefined { return (this.db.prepare('SELECT v FROM kv WHERE k=?').get(k) as any)?.v ?? undefined; }
  setKv(k: string, v: string) { this.db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v); }
  log(level: 'info' | 'warn' | 'error', scope: string, message: string) {
    this.db.prepare('INSERT INTO events(at,level,scope,message) VALUES(?,?,?,?)').run(nowIso(), level, scope, message);
  }
  recentEvents(limit = 50) { return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as any[]; }

  // ---------- shares & reels ----------
  /**
   * Record a share. Idempotent on intake_id. A second share of the same Reel (new intake_id) adds a share row,
   * keeps the earliest first_shared_at, and never duplicates places.
   */
  addShare(s: { intake_id: string; reel_key: string; url: string | null; shortcode: string | null; raw_text: string | null; input_types: string | null; shared_at: string; note: string | null; collection_id?: number; user_id?: number | null }): { inserted: boolean; newReel: boolean } {
    return this.tx(() => {
      const exists = this.db.prepare('SELECT 1 FROM shares WHERE intake_id=?').get(s.intake_id);
      if (exists) return { inserted: false, newReel: false };
      const ts = nowIso();
      this.db.prepare('INSERT INTO shares(intake_id,reel_key,raw_text,input_types,shared_at,received_at,note,user_id) VALUES(?,?,?,?,?,?,?,?)')
        .run(s.intake_id, s.reel_key, s.raw_text, s.input_types, s.shared_at, ts, s.note, s.user_id ?? null);
      const reel = this.getReel(s.reel_key);
      if (!reel) {
        this.db.prepare(`INSERT INTO reels(reel_key,url,shortcode,first_shared_at,status,created_at,updated_at,collection_id,contributed_by) VALUES(?,?,?,?, 'queued', ?, ?, ?, ?)`)
          .run(s.reel_key, s.url, s.shortcode, s.shared_at, ts, ts, s.collection_id ?? 1, s.user_id ?? null);
        return { inserted: true, newReel: true };
      }
      if (isoBefore(s.shared_at, reel.first_shared_at)) {
        this.db.prepare('UPDATE reels SET first_shared_at=?, updated_at=? WHERE reel_key=?').run(s.shared_at, ts, s.reel_key);
      }
      if (!reel.url && s.url) this.db.prepare('UPDATE reels SET url=?, shortcode=? WHERE reel_key=?').run(s.url, s.shortcode, s.reel_key);
      // A new note is new evidence: re-run only if the Reel is not settled yet.
      if (s.note && (reel.status === 'needs_review' || reel.status === 'error')) this.requeue(s.reel_key, 'new note on repeated share');
      return { inserted: true, newReel: false };
    });
  }

  getReel(key: string): ReelRow | undefined { return this.db.prepare('SELECT * FROM reels WHERE reel_key=?').get(key) as any; }
  listReels(status?: ReelStatus): ReelRow[] {
    return (status ? this.db.prepare('SELECT * FROM reels WHERE status=? ORDER BY first_shared_at DESC').all(status)
      : this.db.prepare('SELECT * FROM reels ORDER BY first_shared_at DESC').all()) as any;
  }
  sharesFor(key: string): ShareRow[] { return this.db.prepare('SELECT * FROM shares WHERE reel_key=? ORDER BY shared_at').all(key) as any; }
  latestShare(): ShareRow | undefined { return this.db.prepare('SELECT * FROM shares ORDER BY shared_at DESC, received_at DESC LIMIT 1').get() as any; }
  notesFor(key: string): string[] {
    const seen = new Set<string>(); const out: string[] = [];
    for (const s of this.sharesFor(key)) { const n = (s.note ?? '').trim(); if (n && !seen.has(n)) { seen.add(n); out.push(n); } }
    for (const r of this.db.prepare(`SELECT message FROM events WHERE scope=? ORDER BY id`).all(`note:${key}`) as any[]) {
      const n = String(r.message).trim(); if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
  }
  addNote(key: string, note: string) { this.log('info', `note:${key}`, note); this.requeue(key, 'note added'); }

  dueReels(now = nowIso()): ReelRow[] {
    return this.db.prepare(`SELECT * FROM reels WHERE status='queued' OR (status='error' AND (next_attempt_at IS NULL OR next_attempt_at<=?)) ORDER BY first_shared_at`).all(now) as any;
  }
  requeue(key: string, reason: string) {
    this.db.prepare(`UPDATE reels SET status='queued', status_reason=?, next_attempt_at=NULL, updated_at=? WHERE reel_key=? AND status!='not_a_place'`).run(reason, nowIso(), key);
  }
  setReelResult(key: string, f: { status: ReelStatus; reason: string | null; metadata?: unknown; capabilities?: Capabilities; evidence?: unknown }) {
    this.db.prepare(`UPDATE reels SET status=?, status_reason=?, metadata_json=COALESCE(?,metadata_json), capabilities_json=COALESCE(?,capabilities_json),
      evidence_json=COALESCE(?,evidence_json), last_error=NULL, attempts=0, next_attempt_at=NULL, updated_at=? WHERE reel_key=?`)
      .run(f.status, f.reason, f.metadata === undefined ? null : JSON.stringify(f.metadata), f.capabilities ? JSON.stringify(f.capabilities) : null,
        f.evidence === undefined ? null : JSON.stringify(f.evidence), nowIso(), key);
  }
  setReelError(key: string, err: string, maxDelayMin = 360, attemptsBefore?: number) {
    const r = this.getReel(key); const attempts = (attemptsBefore ?? r?.attempts ?? 0) + 1;
    const delayMin = Math.min(maxDelayMin, 5 * 2 ** (attempts - 1));
    const next = new Date(Date.now() + delayMin * 60_000).toISOString();
    this.db.prepare(`UPDATE reels SET status='error', last_error=?, attempts=?, next_attempt_at=?, updated_at=? WHERE reel_key=?`).run(err, attempts, next, nowIso(), key);
  }
  markVisionUsed(key: string) { this.db.prepare('UPDATE reels SET vision_used=1 WHERE reel_key=?').run(key); }
  setNotAPlace(key: string) { this.db.prepare(`UPDATE reels SET status='not_a_place', status_reason='marked by user', updated_at=? WHERE reel_key=?`).run(nowIso(), key); }

  // ---------- candidates ----------
  replaceCandidatesNoTx(key: string, cands: Candidate[]) {
    this.db.prepare('DELETE FROM candidates WHERE reel_key=?').run(key);
    const ins = this.db.prepare('INSERT INTO candidates(reel_key,idx,clue_text,json,created_at) VALUES(?,?,?,?,?)');
    cands.forEach((c, i) => ins.run(key, i, c.clueText ?? null, JSON.stringify(c), nowIso()));
  }
  replaceCandidates(key: string, cands: Candidate[]) {
    this.tx(() => {
      this.db.prepare('DELETE FROM candidates WHERE reel_key=?').run(key); // review data only, never places
      const ins = this.db.prepare('INSERT INTO candidates(reel_key,idx,clue_text,json,created_at) VALUES(?,?,?,?,?)');
      cands.forEach((c, i) => ins.run(key, i, c.clueText ?? null, JSON.stringify(c), nowIso()));
    });
  }
  candidatesFor(key: string): Candidate[] { return (this.db.prepare('SELECT json FROM candidates WHERE reel_key=? ORDER BY idx').all(key) as any[]).map((r) => JSON.parse(r.json)); }

  // ---------- places (insert/upgrade only — there is no delete) ----------
  upsertPlace(p: Omit<PlaceRow, 'created_at' | 'updated_at'>): PlaceRow {
    const ts = nowIso();
    let cur = this.getPlace(p.place_id);
    // The same Google Maps listing already has a pin (e.g. found earlier from an estimate): enrich that pin instead of
    // adding a second one. Callers must link to the returned place_id.
    if (!cur && p.google_place_id) {
      const same = this.db.prepare('SELECT * FROM places WHERE google_place_id=? ORDER BY created_at LIMIT 1').get(p.google_place_id) as any as PlaceRow | undefined;
      if (same) { p = { ...p, place_id: same.place_id }; cur = same; }
    }
    if (!cur) {
      this.db.prepare(`INSERT INTO places(place_id,name,category,kind,lat,lon,geometry_json,trailhead_json,confidence,source,address,google_place_id,coords_fetched_at,google_types,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.place_id, p.name, p.category, p.kind, p.lat, p.lon, p.geometry_json, p.trailhead_json,
        p.confidence, p.source, p.address, p.google_place_id, p.coords_fetched_at ?? null, p.google_types ?? null, ts, ts);
    } else {
      // Only ever enrich: confirmed beats approximate, geometry/trailhead/google id are filled if missing.
      const confidence: Confidence = cur.confidence === 'confirmed' || p.confidence === 'confirmed' ? 'confirmed' : 'approximate';
      this.db.prepare(`UPDATE places SET confidence=?, geometry_json=COALESCE(geometry_json,?), trailhead_json=COALESCE(trailhead_json,?),
        kind=CASE WHEN ? IS NOT NULL AND geometry_json IS NULL THEN ? ELSE kind END, google_place_id=COALESCE(google_place_id,?), updated_at=? WHERE place_id=?`)
        .run(confidence, p.geometry_json, p.trailhead_json, p.geometry_json, p.kind, p.google_place_id, ts, p.place_id);
      // First Google listing match for an existing point pin: it moves to the listing's location.
      if (!cur.google_place_id && p.google_place_id && p.coords_fetched_at && cur.kind !== 'route') this.applyGoogleListing(p.place_id, { googlePlaceId: p.google_place_id, lat: p.lat, lon: p.lon, types: p.google_types ? p.google_types.split(',') : undefined });
    }
    return this.getPlace(p.place_id)!;
  }
  /**
   * Fold pins that point at the same Google Maps listing into the oldest one: every Reel link (with its cue, share date
   * and photo) moves over, so nothing a Reel showed is lost; only the duplicate pin row goes.
   */
  mergeSameListing(): number {
    let merged = 0;
    for (const g of this.db.prepare('SELECT google_place_id g FROM places WHERE google_place_id IS NOT NULL GROUP BY google_place_id HAVING COUNT(*) > 1').all() as any[]) {
      const rows = this.db.prepare('SELECT * FROM places WHERE google_place_id=? ORDER BY created_at, place_id').all(g.g) as any as PlaceRow[];
      const keep = rows[0]!;
      this.tx(() => {
        for (const dup of rows.slice(1)) {
          this.db.prepare(`INSERT OR IGNORE INTO reel_places(reel_key,place_id,cue,cue_source,role,decided_by,created_at,image_path,image_kind,image_t,image_url)
            SELECT reel_key, ?, cue, cue_source, role, decided_by, created_at, image_path, image_kind, image_t, image_url FROM reel_places rp WHERE place_id=?
              AND NOT EXISTS (SELECT 1 FROM reels r JOIN tombstones t ON t.collection_id=r.collection_id WHERE r.reel_key=rp.reel_key AND t.place_id=?)`).run(keep.place_id, dup.place_id, keep.place_id);
          // A tombstone on the duplicate carries over to the pin it merges into.
          this.db.prepare('INSERT OR IGNORE INTO tombstones(collection_id, place_id, name, deleted_by, deleted_at) SELECT collection_id, ?, name, deleted_by, deleted_at FROM tombstones WHERE place_id=?').run(keep.place_id, dup.place_id);
          // A photo the kept link lacks comes over from the duplicate.
          this.db.prepare(`UPDATE reel_places SET image_path=(SELECT d.image_path FROM reel_places d WHERE d.place_id=? AND d.reel_key=reel_places.reel_key), image_kind=(SELECT d.image_kind FROM reel_places d WHERE d.place_id=? AND d.reel_key=reel_places.reel_key)
            WHERE place_id=? AND image_path IS NULL AND EXISTS (SELECT 1 FROM reel_places d WHERE d.place_id=? AND d.reel_key=reel_places.reel_key AND d.image_path IS NOT NULL)`).run(dup.place_id, dup.place_id, keep.place_id, dup.place_id);
          this.db.prepare('DELETE FROM reel_places WHERE place_id=?').run(dup.place_id);
          this.db.prepare('DELETE FROM places WHERE place_id=?').run(dup.place_id);
          this.db.prepare('DELETE FROM kv WHERE k=?').run(`gmatch:${dup.place_id}`);
          if (dup.confidence === 'confirmed' && keep.confidence !== 'confirmed') this.db.prepare("UPDATE places SET confidence='confirmed', updated_at=? WHERE place_id=?").run(nowIso(), keep.place_id);
          this.log('info', 'merge', `${dup.name} (${dup.place_id}) merged into ${keep.name} (${keep.place_id}): same Google listing`);
          merged++;
        }
      });
    }
    return merged;
  }
  /** User action only ("this pin is wrong"): drop the link; the pin itself goes when no other Reel shows it. */
  unlinkPlace(reelKey: string, placeId: string) {
    this.tx(() => {
      this.db.prepare('DELETE FROM reel_places WHERE reel_key=? AND place_id=?').run(reelKey, placeId);
      const left = (this.db.prepare('SELECT COUNT(*) n FROM reel_places WHERE place_id=?').get(placeId) as any).n;
      const p = this.getPlace(placeId);
      if (!left) { this.db.prepare('DELETE FROM places WHERE place_id=?').run(placeId); this.db.prepare('DELETE FROM kv WHERE k=?').run(`gmatch:${placeId}`); }
      this.db.prepare('UPDATE reels SET updated_at=? WHERE reel_key=?').run(nowIso(), reelKey);
      this.log('info', 'user-remove', `you removed ${p?.name ?? placeId} from ${reelKey}${left ? '' : ' (pin deleted: no other Reel)'}`);
    });
  }
  getPlace(id: string): PlaceRow | undefined { return this.db.prepare('SELECT * FROM places WHERE place_id=?').get(id) as any; }
  listPlaces(): PlaceRow[] { return this.db.prepare('SELECT * FROM places ORDER BY created_at').all() as any; }

  linkReelPlace(l: { reel_key: string; place_id: string; cue: string | null; cue_source: SourceKind | null; role: string; decided_by: 'auto' | 'user' | 'ai+osm' }) {
    // A pin deleted from this Reel's collection stays deleted: automatic re-processing never links it again. Only an
    // explicit user choice in review lifts the tombstone.
    const cid = this.collectionOf(l.reel_key);
    if (this.isTombstoned(cid, l.place_id)) {
      if (l.decided_by !== 'user') return;
      this.db.prepare('DELETE FROM tombstones WHERE collection_id=? AND place_id=?').run(cid, l.place_id);
    }
    // INSERT OR IGNORE: re-processing never rewrites an existing link (keeps the original cue); user decisions upgrade.
    this.db.prepare(`INSERT INTO reel_places(reel_key,place_id,cue,cue_source,role,decided_by,created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(reel_key,place_id) DO UPDATE SET decided_by=CASE WHEN excluded.decided_by='user' THEN 'user' ELSE decided_by END,
      cue=COALESCE(cue, excluded.cue), cue_source=COALESCE(cue_source, excluded.cue_source)`)
      .run(l.reel_key, l.place_id, l.cue, l.cue_source, l.role, l.decided_by, nowIso());
  }
  linksForPlace(id: string): (ReelPlaceRow & { url: string | null; first_shared_at: string })[] {
    return this.db.prepare(`SELECT rp.*, r.url, r.first_shared_at FROM reel_places rp JOIN reels r USING(reel_key) WHERE rp.place_id=? ORDER BY r.first_shared_at`).all(id) as any;
  }
  linksForReel(key: string): (ReelPlaceRow & PlaceRow)[] {
    return this.db.prepare(`SELECT rp.*, p.* FROM reel_places rp JOIN places p USING(place_id) WHERE rp.reel_key=? ORDER BY rp.created_at`).all(key) as any;
  }

  // ---------- media ----------
  addMedia(m: { media_id: string; reel_key: string; kind: 'image' | 'video'; mime: string | null; remote_ref: string | null; local_path: string | null }): boolean {
    const r = this.db.prepare(`INSERT OR IGNORE INTO media(media_id,reel_key,kind,mime,remote_ref,local_path,status,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(m.media_id, m.reel_key, m.kind, m.mime, m.remote_ref, m.local_path, m.local_path ? 'downloaded' : 'pending', nowIso());
    return Number(r.changes) > 0;
  }
  mediaFor(key: string): MediaRow[] { return this.db.prepare('SELECT * FROM media WHERE reel_key=? ORDER BY created_at').all(key) as any; }
  updateMedia(id: string, f: { status: string; local_path?: string; error?: string | null; kind?: 'image' | 'video'; mime?: string }) {
    this.db.prepare('UPDATE media SET status=?, local_path=COALESCE(?,local_path), error=?, kind=COALESCE(?,kind), mime=COALESCE(?,mime) WHERE media_id=?')
      .run(f.status, f.local_path ?? null, f.error ?? null, f.kind ?? null, f.mime ?? null, id);
  }

  // ---------- sync ----------
  startSync(): number { return Number(this.db.prepare(`INSERT INTO sync_runs(started_at,status) VALUES(?, 'running')`).run(nowIso()).lastInsertRowid); }
  finishSync(id: number, status: string, f: { hash?: string; count?: number; detail?: string }) {
    this.db.prepare('UPDATE sync_runs SET finished_at=?, status=?, snapshot_hash=?, feature_count=?, detail=? WHERE id=?')
      .run(nowIso(), status, f.hash ?? null, f.count ?? null, f.detail ?? null, id);
  }
  lastSync(status?: string) {
    return (status ? this.db.prepare('SELECT * FROM sync_runs WHERE status=? ORDER BY id DESC LIMIT 1').get(status)
      : this.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get()) as any;
  }
  consecutiveSyncFailures(): number {
    const rows = this.db.prepare(`SELECT status FROM sync_runs WHERE status IN ('ok','failed') ORDER BY id DESC LIMIT 20`).all() as any[];
    let n = 0; for (const r of rows) { if (r.status === 'failed') n++; else break; } return n;
  }

  // ---------- http cache ----------
  cacheGet(key: string, ttlMs: number): string | undefined {
    const r = this.db.prepare('SELECT body, fetched_at FROM http_cache WHERE key=?').get(key) as any;
    if (!r || Date.now() - r.fetched_at > ttlMs) return undefined;
    return r.body;
  }
  cachePut(key: string, body: string) {
    this.db.prepare('INSERT INTO http_cache(key,body,fetched_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, fetched_at=excluded.fetched_at').run(key, body, Date.now());
  }

  counts() {
    const by = this.db.prepare('SELECT status, COUNT(*) n FROM reels GROUP BY status').all() as any[];
    return { reels: Object.fromEntries(by.map((r) => [r.status, r.n])), places: (this.db.prepare('SELECT COUNT(*) n FROM places').get() as any).n };
  }
}

export type { Category };
