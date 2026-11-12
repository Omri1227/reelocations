/**
 * Server-side Google Maps list publisher (runs on the server, e.g. Railway — no desktop needed).
 *
 * One destination per collection: a Google account's browser session (Playwright storage state) that its owner uploads
 * once with `npm run cli -- gmaps-connect`. The session file lives in <dataDir>/private/gmaps/ (mode 600), is never
 * logged and never leaves the server. Each finished pin with a verified Google listing is saved to the account's list
 * (default "Reelocations") by opening the exact listing by Place ID and using Google Maps' own Save action.
 *
 * Queue rules: only pins whose listing is verified (Google Place ID, not approximate, no open listing/approximate
 * question in the Review Queue); one row per (destination, Place ID), so a listing is never saved twice; statuses
 * pending → verified | failed (retried with back-off) | skipped (branch check failed: stays for review).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db.ts';
import { nowIso } from '../db.ts';
import { openListing, readSaveState, saveToList } from './savedList.ts';

export const DEFAULT_LIST = 'Reelocations';
const MAX_ATTEMPTS = 5;

export function ensureGmapsTables(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS gmaps_destinations (id INTEGER PRIMARY KEY, collection_id INTEGER NOT NULL, user_id INTEGER NOT NULL, list_name TEXT NOT NULL,
      state_file TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, connected_at TEXT NOT NULL, last_run_at TEXT, last_ok_at TEXT, disconnected_at TEXT);
    CREATE TABLE IF NOT EXISTS gmaps_saves (destination_id INTEGER NOT NULL, google_place_id TEXT NOT NULL, place_id TEXT NOT NULL, name TEXT,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, detail TEXT, card_title TEXT, card_address TEXT, updated_at TEXT NOT NULL, verified_at TEXT,
      next_try_at TEXT, PRIMARY KEY (destination_id, google_place_id));
  `);
  const cols = new Set((store.db.prepare('PRAGMA table_info(gmaps_saves)').all() as any[]).map((c) => c.name));
  // 1 = you confirmed this listing in the Review Queue: saved without the automatic branch check.
  if (!cols.has('user_confirmed')) store.db.exec('ALTER TABLE gmaps_saves ADD COLUMN user_confirmed INTEGER NOT NULL DEFAULT 0');
}

/**
 * The save-time branch check failed: ask in the Review Queue too (every Reel of the collection that shows the pin gets
 * the listing as a "This is the listing" option, with its Google Maps link, and the reason).
 */
export function askListingInReview(store: Store, collectionId: number, placeId: string, googlePlaceId: string, card: { title?: string | null; address?: string | null }, why: string) {
  const p = store.getPlace(placeId); if (!p) return;
  for (const l of store.linksForPlaceIn(collectionId, placeId)) {
    const prev = store.candidatesFor(l.reel_key).filter((c) => !(c.replacesPlaceId === placeId && c.googlePlaceId === googlePlaceId));
    const cand = { ref: `gplace:${googlePlaceId}`, name: card.title || p.name, displayName: card.address || p.address || '', lat: p.lat, lon: p.lon, category: p.category, isArea: false, isRoute: false, names: [] as string[],
      googlePlaceId, replacesPlaceId: placeId, clueText: `Google Maps list: is this the listing for ${p.name}?`, gmapsConfirm: true } as any;
    store.replaceCandidates(l.reel_key, [cand, ...prev].slice(0, 20));
    const r = store.getReel(l.reel_key);
    const reason = `Google Maps list: not saved yet — ${why}. If this is the place, choose "This is the listing".`;
    store.setReelResult(l.reel_key, { status: 'needs_review', reason: r?.status === 'needs_review' && r.status_reason && !r.status_reason.startsWith('Google Maps list:') ? `${r.status_reason} · ${reason}` : reason });
  }
}

/** You chose "This is the listing" for a held-back save: save it on the next cycle, without the branch check. */
export function confirmGmapsListing(store: Store, collectionId: number, googlePlaceId: string) {
  ensureGmapsTables(store);
  store.db.prepare("UPDATE gmaps_saves SET status='pending', user_confirmed=1, attempts=0, next_try_at=NULL, detail='confirmed by you in the Review Queue', updated_at=? WHERE google_place_id=? AND status IN ('skipped','failed','excluded','pending') AND destination_id IN (SELECT id FROM gmaps_destinations WHERE collection_id=?)").run(nowIso(), googlePlaceId, collectionId);
}

/** You chose "None of these": never save this pin's listing to the list. */
export function excludeGmapsPlace(store: Store, collectionId: number, placeId: string) {
  ensureGmapsTables(store);
  store.db.prepare("UPDATE gmaps_saves SET status='excluded', detail='you said this is not the listing', updated_at=? WHERE place_id=? AND status <> 'verified' AND destination_id IN (SELECT id FROM gmaps_destinations WHERE collection_id=?)").run(nowIso(), placeId, collectionId);
}

export function gmapsDir(dataDir: string) { const d = path.join(dataDir, 'private', 'gmaps'); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }

/** Store (or replace) the session for a collection. The state is validated for shape only; it is never logged. */
export function connectGmaps(store: Store, dataDir: string, o: { collectionId: number; userId: number; state: unknown; listName?: string }): number {
  ensureGmapsTables(store);
  const st = o.state as any;
  if (!st || !Array.isArray(st.cookies) || !st.cookies.some((c: any) => /google\./.test(String(c.domain)))) throw Object.assign(new Error('not a Google browser session'), { status: 400 });
  const listName = (o.listName ?? DEFAULT_LIST).slice(0, 60) || DEFAULT_LIST;
  const old = store.db.prepare('SELECT * FROM gmaps_destinations WHERE collection_id=? AND disconnected_at IS NULL').get(o.collectionId) as any;
  const id = old ? Number(old.id) : Number(store.db.prepare("INSERT INTO gmaps_destinations(collection_id,user_id,list_name,state_file,status,connected_at) VALUES(?,?,?,?, 'connected', ?)").run(o.collectionId, o.userId, listName, '', nowIso()).lastInsertRowid);
  const file = path.join(gmapsDir(dataDir), `session-${id}.json`);
  fs.writeFileSync(file, JSON.stringify(st), { mode: 0o600 });
  store.db.prepare("UPDATE gmaps_destinations SET user_id=?, list_name=?, state_file=?, status='connected', detail=NULL, connected_at=? WHERE id=?").run(o.userId, listName, file, nowIso(), id);
  // Fresh start: the FIRST successful connection of this collection is the cutoff. Only Reels the server receives
  // after it are saved. Kept for good: reconnecting, disconnecting, retries and redeploys never move it.
  store.db.prepare('INSERT OR IGNORE INTO kv(k, v) VALUES (?, ?)').run(cutoffKey(o.collectionId), nowIso());
  // A new session retries what failed for lack of sign-in.
  store.db.prepare("UPDATE gmaps_saves SET status='pending', attempts=0, next_try_at=NULL WHERE destination_id=? AND status='failed'").run(id);
  return id;
}

export function disconnectGmaps(store: Store, collectionId: number) {
  ensureGmapsTables(store);
  for (const d of store.db.prepare('SELECT * FROM gmaps_destinations WHERE collection_id=? AND disconnected_at IS NULL').all(collectionId) as any[]) {
    try { fs.rmSync(d.state_file, { force: true }); } catch { /* gone */ }
    store.db.prepare("UPDATE gmaps_destinations SET disconnected_at=?, status='disconnected' WHERE id=?").run(nowIso(), d.id);
  }
}

export const cutoffKey = (collectionId: number) => `gmaps:cutoff:${collectionId}`;
/** When this collection first connected a Google account (null = never): only Reels received after it are saved. */
export function gmapsCutoff(store: Store, collectionId: number): string | null { return store.getKv(cutoffKey(collectionId)) ?? null; }

/**
 * Pins of the collection that are ready to save: shown by a Reel the server received after the cutoff (a Reel shared
 * before it never qualifies, even when it is re-processed or its pin changes later), verified Google listing, no open
 * question about them.
 */
export function eligiblePlaces(store: Store, collectionId: number): { place_id: string; google_place_id: string; name: string; address: string | null; locality: string | null }[] {
  const cutoff = gmapsCutoff(store, collectionId);
  if (!cutoff) return [];
  const rows = store.placesOfCollection(collectionId).filter((p) => p.google_place_id && p.confidence === 'confirmed' && !String(p.source).includes(' · approximate: '));
  return rows.filter((p) => {
    const links = store.linksForPlaceIn(collectionId, p.place_id);
    if (!links.some((l) => { const r = store.getReel(l.reel_key); return !!r && Date.parse(r.created_at) >= Date.parse(cutoff); })) return false;
    for (const l of store.linksForPlaceIn(collectionId, p.place_id)) {
      const r = store.getReel(l.reel_key);
      if (r?.status !== 'needs_review') continue;
      if (store.candidatesFor(l.reel_key).some((c) => c.replacesPlaceId === p.place_id || c.confirmsApproxPlaceId === p.place_id || c.replacesApproxPlaceId === p.place_id)) return false;
    }
    return true;
  }).map((p) => ({ place_id: p.place_id, google_place_id: p.google_place_id!, name: p.name, address: p.address ?? null, locality: (p as any).locality ?? null }));
}

/** Add newly eligible listings to the queue (idempotent per Place ID). */
export function queueGmaps(store: Store, destinationId: number, collectionId: number): number {
  let n = 0;
  for (const p of eligiblePlaces(store, collectionId)) {
    n += Number(store.db.prepare("INSERT OR IGNORE INTO gmaps_saves(destination_id, google_place_id, place_id, name, status, updated_at) VALUES (?,?,?,?, 'pending', ?)").run(destinationId, p.google_place_id, p.place_id, p.name, nowIso()).changes);
    // Set aside earlier (e.g. while still under review) but eligible now: back in the queue.
    store.db.prepare("UPDATE gmaps_saves SET status='pending', detail=NULL, place_id=?, updated_at=? WHERE destination_id=? AND google_place_id=? AND status='excluded' AND COALESCE(detail,'') <> 'you said this is not the listing'").run(p.place_id, nowIso(), destinationId, p.google_place_id);
  }
  return n;
}

export function gmapsStatus(store: Store, collectionId: number) {
  ensureGmapsTables(store);
  const d = store.db.prepare('SELECT id, list_name, status, detail, connected_at, last_run_at, last_ok_at FROM gmaps_destinations WHERE collection_id=? AND disconnected_at IS NULL').get(collectionId) as any;
  if (!d) return { connected: false, cutoff_at: gmapsCutoff(store, collectionId) };
  const counts = Object.fromEntries((store.db.prepare('SELECT status, COUNT(*) n FROM gmaps_saves WHERE destination_id=? GROUP BY status').all(d.id) as any[]).map((r) => [r.status, r.n]));
  const failed = store.db.prepare("SELECT name, detail, attempts FROM gmaps_saves WHERE destination_id=? AND status IN ('failed','skipped') ORDER BY updated_at DESC LIMIT 10").all(d.id);
  return { connected: true, ...d, cutoff_at: gmapsCutoff(store, collectionId), counts, problems: failed };
}

/**
 * One publishing pass for every connected destination (a few listings per pass; the server cycle calls it).
 * `launch` opens a headless browser with the given storage state; injected so tests can use a fake.
 */
export async function gmapsCycle(store: Store, launch: (stateFile: string) => Promise<{ page: any; save: () => Promise<unknown>; close: () => Promise<void> }>, o: { perRun?: number; log?: (m: string) => void; ops?: { openListing: typeof openListing; readSaveState: typeof readSaveState; saveToList: typeof saveToList } } = {}): Promise<{ saved: number; failed: number; skipped: number }> {
  const ops = o.ops ?? { openListing, readSaveState, saveToList };
  ensureGmapsTables(store);
  const out = { saved: 0, failed: 0, skipped: 0 };
  for (const d of store.db.prepare("SELECT * FROM gmaps_destinations WHERE disconnected_at IS NULL AND status IN ('connected','ok','error')").all() as any[]) {
    queueGmaps(store, d.id, d.collection_id);
    // Belt and braces: anything queued that is not (or no longer) eligible is set aside, never saved.
    const ok = new Set(eligiblePlaces(store, d.collection_id).map((p) => p.google_place_id));
    for (const it of store.db.prepare("SELECT google_place_id FROM gmaps_saves WHERE destination_id=? AND status IN ('pending','failed')").all(d.id) as any[]) {
      if (!ok.has(it.google_place_id)) store.db.prepare("UPDATE gmaps_saves SET status='excluded', detail='not from a Reel shared after connecting (or no longer verified)', updated_at=? WHERE destination_id=? AND google_place_id=?").run(nowIso(), d.id, it.google_place_id);
    }
    const due = store.db.prepare("SELECT * FROM gmaps_saves WHERE destination_id=? AND status IN ('pending','failed') AND attempts < ? AND (next_try_at IS NULL OR next_try_at <= ?) ORDER BY updated_at LIMIT ?").all(d.id, MAX_ATTEMPTS, nowIso(), o.perRun ?? 5) as any[];
    store.db.prepare('UPDATE gmaps_destinations SET last_run_at=? WHERE id=?').run(nowIso(), d.id);
    if (!due.length) continue;
    let b: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      b = await launch(d.state_file);
      for (const it of due) {
        const p = store.getPlace(it.place_id);
        const set = (status: string, detail: string, extra: Record<string, unknown> = {}) => {
          const backoff = status === 'failed' ? new Date(Date.now() + Math.min(24, 2 ** (it.attempts + 1)) * 3600_000).toISOString() : null;
          store.db.prepare('UPDATE gmaps_saves SET status=?, detail=?, attempts=attempts+?, updated_at=?, next_try_at=?, verified_at=COALESCE(?, verified_at), card_title=COALESCE(?, card_title), card_address=COALESCE(?, card_address) WHERE destination_id=? AND google_place_id=?')
            .run(status, detail.slice(0, 300), status === 'verified' ? 0 : 1, nowIso(), backoff, status === 'verified' ? nowIso() : null, (extra.title as string) ?? null, (extra.address as string) ?? null, d.id, it.google_place_id);
        };
        try {
          const card = await ops.openListing(b.page, { googlePlaceId: it.google_place_id, name: p?.name ?? it.name, address: p?.address, locality: (p as any)?.locality });
          if (!card.branchOk && !it.user_confirmed) {
            set('skipped', `branch check: ${card.why}`, card as any); out.skipped++;
            askListingInReview(store, d.collection_id, it.place_id, it.google_place_id, card, card.why);
            continue;
          }
          const st = await ops.readSaveState(b.page);
          // Only a definite "signed out" stops here; otherwise the Save click decides (it opens Google's sign-in page when signed out).
          if (st.signedIn === false) throw Object.assign(new Error('the Google session is signed out'), { code: 'signin' });
          const r = await ops.saveToList(b.page, d.list_name);
          if (r.saved) { set('verified', r.detail, card as any); out.saved++; } else { set('failed', r.detail, card as any); out.failed++; }
        } catch (e) {
          if ((e as any).code === 'signin') {
            store.db.prepare("UPDATE gmaps_destinations SET status='needs_signin', detail=? WHERE id=?").run('Google sign-in expired: reconnect with npm run cli -- gmaps-connect', d.id);
            o.log?.(`gmaps destination ${d.id}: needs sign-in`);
            break;
          }
          set('failed', (e as Error).message.split('\n')[0]!); out.failed++;
        }
      }
      // Keep the rotated cookies for next time (sessions last longer when refreshed).
      await b.save().catch(() => {});
      const cur = store.db.prepare('SELECT status FROM gmaps_destinations WHERE id=?').get(d.id) as any;
      if (cur.status !== 'needs_signin') store.db.prepare("UPDATE gmaps_destinations SET status='ok', detail=NULL, last_ok_at=? WHERE id=?").run(nowIso(), d.id);
    } catch (e) {
      store.db.prepare("UPDATE gmaps_destinations SET status='error', detail=? WHERE id=?").run((e as Error).message.split('\n')[0]!.slice(0, 200), d.id);
    } finally { await b?.close().catch(() => {}); }
  }
  return out;
}

/** Real launcher: headless Chromium with the stored session; `save` writes the refreshed session back (mode 600). */
export function chromiumLauncher(chromePath: string) {
  return async (stateFile: string) => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
    const ctx = await browser.newContext({ storageState: stateFile, locale: 'en-US', viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    return {
      page,
      save: async () => { const st = await ctx.storageState(); fs.writeFileSync(stateFile, JSON.stringify(st), { mode: 0o600 }); },
      close: async () => { await browser.close(); },
    };
  };
}
