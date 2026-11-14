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
import crypto from 'node:crypto';
import { openListing, probeListMenu, readSaveState, saveToList } from './savedList.ts';
import { lockKey, profileOf, removeSessionFiles, tryLock, writeSnapshot } from './gmapsBrowser.ts';

export const DEFAULT_LIST = 'Reelocations';
const MAX_ATTEMPTS = 5;
export const SIGNED_OUT_DETAIL = 'Google signed this session out: open Setup and tap "Sign in to Google"';

/** How an account is remembered: a hash to compare and a masked label to show — never the address itself. */
export const accountHash = (email: string) => crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
export const accountLabel = (email: string) => { const [u, d] = email.trim().toLowerCase().split('@'); return `${(u ?? '').slice(0, 2)}•••@${d ?? ''}`; };

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
  const dcols = new Set((store.db.prepare('PRAGMA table_info(gmaps_destinations)').all() as any[]).map((c) => c.name));
  // last_check_at: when the session was last tested by opening the Save menu. account_*: which Google account it is.
  for (const c of ['last_check_at', 'account_hash', 'account_label']) if (!dcols.has(c)) store.db.exec(`ALTER TABLE gmaps_destinations ADD COLUMN ${c} TEXT`);
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

/**
 * Store (or replace) the session for a collection. The state is validated for shape only; it is never logged.
 * Signing in again keeps everything else: the same destination row (so the same list, queue and saved records) and
 * the original cutoff. `profileDir` is the browser profile the sign-in happened in (Setup → "Sign in to Google"); it
 * becomes the destination's profile. `account` is the signed-in address when Google told us: a destination never
 * silently switches to another Google account (that would start a second list there) — disconnect first to switch.
 */
export function connectGmaps(store: Store, dataDir: string, o: { collectionId: number; userId: number; state: unknown; listName?: string; profileDir?: string; account?: string | null }): number {
  ensureGmapsTables(store);
  const st = o.state as any;
  if (!st || !Array.isArray(st.cookies) || !st.cookies.some((c: any) => /google\./.test(String(c.domain)))) throw Object.assign(new Error('not a Google browser session'), { status: 400 });
  const old = store.db.prepare('SELECT * FROM gmaps_destinations WHERE collection_id=? AND disconnected_at IS NULL').get(o.collectionId) as any;
  if (old?.account_hash && o.account && old.account_hash !== accountHash(o.account)) throw Object.assign(new Error(`this is a different Google account than the connected one (${old.account_label}). To switch accounts, disconnect first.`), { status: 409, code: 'other_account' });
  const listName = (o.listName ?? old?.list_name ?? DEFAULT_LIST).slice(0, 60) || DEFAULT_LIST;
  const id = old ? Number(old.id) : Number(store.db.prepare("INSERT INTO gmaps_destinations(collection_id,user_id,list_name,state_file,status,connected_at) VALUES(?,?,?,?, 'connected', ?)").run(o.collectionId, o.userId, listName, '', nowIso()).lastInsertRowid);
  const file = path.join(gmapsDir(dataDir), `session-${id}.json`);
  writeSnapshot(file, st);
  // The new session replaces the old browser profile (a profile is rebuilt from the snapshot when there is none).
  fs.rmSync(profileOf(file), { recursive: true, force: true });
  if (o.profileDir) fs.renameSync(o.profileDir, profileOf(file));
  store.db.prepare("UPDATE gmaps_destinations SET user_id=?, list_name=?, state_file=?, status='connected', detail=NULL, connected_at=?, last_check_at=NULL, account_hash=COALESCE(?, account_hash), account_label=COALESCE(?, account_label) WHERE id=?")
    .run(o.userId, listName, file, nowIso(), o.account ? accountHash(o.account) : null, o.account ? accountLabel(o.account) : null, id);
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
    removeSessionFiles(d.state_file);
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
  const d = store.db.prepare('SELECT id, list_name, status, detail, connected_at, last_run_at, last_ok_at, last_check_at, account_label FROM gmaps_destinations WHERE collection_id=? AND disconnected_at IS NULL').get(collectionId) as any;
  if (!d) return { connected: false, cutoff_at: gmapsCutoff(store, collectionId) };
  const counts = Object.fromEntries((store.db.prepare('SELECT status, COUNT(*) n FROM gmaps_saves WHERE destination_id=? GROUP BY status').all(d.id) as any[]).map((r) => [r.status, r.n]));
  const failed = store.db.prepare("SELECT name, detail, attempts FROM gmaps_saves WHERE destination_id=? AND status IN ('failed','skipped') ORDER BY updated_at DESC LIMIT 10").all(d.id);
  return { connected: true, ...d, cutoff_at: gmapsCutoff(store, collectionId), counts, problems: failed };
}

export type GmapsLaunch = (stateFile: string) => Promise<{ page: any; save: () => Promise<unknown>; close: () => Promise<void> }>;
const isSignin = (e: unknown) => (e as any)?.code === 'signin';

/**
 * One publishing pass for every connected destination (a few listings per pass; the server cycle calls it).
 * `launch` opens the destination's browser; injected so tests can use a fake.
 *
 * "Needs sign-in" is set only when Google's sign-in page came up twice in a row for the same listing (each time after
 * Google stayed on it, see openListMenu). Everything else — a slow page, a menu that did not open, a changed control —
 * is an ordinary failed attempt that is retried with back-off. The item that met the sign-in page is not counted as
 * failed: it stays pending and is saved after the next sign-in.
 */
export async function gmapsCycle(store: Store, launch: GmapsLaunch, o: { perRun?: number; log?: (m: string) => void; ops?: { openListing: typeof openListing; readSaveState: typeof readSaveState; saveToList: typeof saveToList } } = {}): Promise<{ saved: number; failed: number; skipped: number }> {
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
    if (!due.length) { store.db.prepare('UPDATE gmaps_destinations SET last_run_at=? WHERE id=?').run(nowIso(), d.id); continue; }
    // One browser per session: if a sign-in, a check or a probe has it open, this destination waits for the next pass.
    const release = tryLock(lockKey(d.id));
    if (!release) continue;
    store.db.prepare('UPDATE gmaps_destinations SET last_run_at=? WHERE id=?').run(nowIso(), d.id);
    let b: Awaited<ReturnType<GmapsLaunch>> | undefined;
    try {
      b = await launch(d.state_file);
      let signedOut = false, proven = false;
      for (const it of due) {
        const p = store.getPlace(it.place_id);
        const set = (status: string, detail: string, extra: Record<string, unknown> = {}) => {
          const backoff = status === 'failed' ? new Date(Date.now() + Math.min(24, 2 ** (it.attempts + 1)) * 3600_000).toISOString() : null;
          store.db.prepare('UPDATE gmaps_saves SET status=?, detail=?, attempts=attempts+?, updated_at=?, next_try_at=?, verified_at=COALESCE(?, verified_at), card_title=COALESCE(?, card_title), card_address=COALESCE(?, card_address) WHERE destination_id=? AND google_place_id=?')
            .run(status, detail.slice(0, 300), status === 'verified' ? 0 : 1, nowIso(), backoff, status === 'verified' ? nowIso() : null, (extra.title as string) ?? null, (extra.address as string) ?? null, d.id, it.google_place_id);
        };
        try {
          let card: Awaited<ReturnType<typeof openListing>> | undefined, r: Awaited<ReturnType<typeof saveToList>> | undefined;
          for (let look = 0; ; look++) {
            try {
              card = await ops.openListing(b.page, { googlePlaceId: it.google_place_id, name: p?.name ?? it.name, address: p?.address, locality: (p as any)?.locality });
              if (!card.branchOk && !it.user_confirmed) break;
              const st = await ops.readSaveState(b.page);
              // Only a definite "signed out" stops here; otherwise the Save click decides (it opens Google's sign-in page when signed out).
              if (st.signedIn === false) throw Object.assign(new Error('the Google session is signed out'), { code: 'signin' });
              r = await ops.saveToList(b.page, d.list_name);
              break;
            } catch (e) {
              // Google's sign-in page once is not proof: open the listing again and look a second time.
              if (!isSignin(e) || look >= 1) throw e;
            }
          }
          if (!r) {
            set('skipped', `branch check: ${card!.why}`, card as any); out.skipped++;
            askListingInReview(store, d.collection_id, it.place_id, it.google_place_id, card!, card!.why);
            continue;
          }
          proven = true; // the Save menu opened: this session is signed in
          if (r.saved) { set('verified', r.detail, card as any); out.saved++; } else { set('failed', r.detail, card as any); out.failed++; }
        } catch (e) {
          if (isSignin(e)) {
            signedOut = true;
            store.db.prepare("UPDATE gmaps_destinations SET status='needs_signin', detail=?, last_check_at=? WHERE id=?").run(SIGNED_OUT_DETAIL, nowIso(), d.id);
            o.log?.(`gmaps destination ${d.id}: needs sign-in (Google's sign-in page came up twice for one listing; ${(e as Error).message.split('\n')[0]})`);
            break;
          }
          set('failed', (e as Error).message.split('\n')[0]!); out.failed++;
        }
      }
      if (!signedOut) {
        // Keep the refreshed cookies as a snapshot too — never after a sign-out (that would replace it with nothing useful).
        if (proven) await b.save().catch(() => {});
        store.db.prepare("UPDATE gmaps_destinations SET status='ok', detail=NULL, last_ok_at=COALESCE(?, last_ok_at), last_check_at=COALESCE(?, last_check_at) WHERE id=?").run(proven ? nowIso() : null, proven ? nowIso() : null, d.id);
      }
    } catch (e) {
      // The browser did not start, or closed under us: retried on the next pass. Not a sign-in problem.
      store.db.prepare("UPDATE gmaps_destinations SET status='error', detail=? WHERE id=?").run((e as Error).message.split('\n')[0]!.slice(0, 200), d.id);
    } finally { await b?.close().catch(() => {}); release(); }
  }
  return out;
}

/** A listing to open for a session check: the destination's latest saved place, else a well-known one. */
function probeTarget(store: Store, destinationId: number): { googlePlaceId: string; name: string } {
  const r = store.db.prepare("SELECT google_place_id, name FROM gmaps_saves WHERE destination_id=? AND status='verified' ORDER BY verified_at DESC LIMIT 1").get(destinationId) as any;
  // Google's own example Place ID (developers.google.com/maps/documentation/places/web-service/place-id).
  return r ? { googlePlaceId: r.google_place_id, name: r.name ?? 'place' } : { googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', name: 'Google Sydney' };
}

/** Is this session signed in? Decided by the real action without saving: open a listing, open its Save menu, close it. */
export async function probeSession(page: any, target: { googlePlaceId: string; name: string }): Promise<{ signedIn: boolean | null; detail: string }> {
  let last: { signedIn: boolean | null; detail: string } = { signedIn: null, detail: 'not checked' };
  for (let look = 0; look < 2; look++) {
    try { await openListing(page, target); last = await probeListMenu(page); }
    catch (e) { last = { signedIn: null, detail: (e as Error).message.split('\n')[0]! }; }
    if (last.signedIn === true) break; // "signed out" and "unknown" are both looked at twice
  }
  return { signedIn: last.signedIn, detail: last.detail };
}

/**
 * Session check, independent of saving (the server cycle calls it every pass; it does something about once an hour
 * per destination). It keeps the session in use while no Reels arrive, notices a sign-out when it happens rather than
 * at the next save, and — the other way round — clears "needs sign-in" by itself when the session turns out to work:
 * the next save pass then continues with the pending places. An inconclusive check changes nothing.
 */
export async function gmapsCheck(store: Store, launch: GmapsLaunch, o: { everyMin?: number; signedOutEveryMin?: number; log?: (m: string) => void; probe?: typeof probeSession } = {}): Promise<{ checked: number; recovered: number; signedOut: number }> {
  ensureGmapsTables(store);
  const probe = o.probe ?? probeSession;
  const out = { checked: 0, recovered: 0, signedOut: 0 };
  const every = (o.everyMin ?? 60) * 60_000, everyOut = (o.signedOutEveryMin ?? 360) * 60_000;
  for (const d of store.db.prepare("SELECT * FROM gmaps_destinations WHERE disconnected_at IS NULL AND status IN ('connected','ok','error','needs_signin')").all() as any[]) {
    const last = Math.max(Date.parse(d.last_check_at ?? '') || 0, d.status === 'needs_signin' ? 0 : Date.parse(d.last_ok_at ?? '') || 0);
    if (Date.now() - last < (d.status === 'needs_signin' ? everyOut : every)) continue;
    const release = tryLock(lockKey(d.id));
    if (!release) continue;
    let b: Awaited<ReturnType<GmapsLaunch>> | undefined;
    try {
      store.db.prepare('UPDATE gmaps_destinations SET last_check_at=? WHERE id=?').run(nowIso(), d.id);
      b = await launch(d.state_file);
      const r = await probe(b.page, probeTarget(store, d.id));
      out.checked++;
      if (r.signedIn === true) {
        await b.save().catch(() => {});
        store.db.prepare("UPDATE gmaps_destinations SET status='ok', detail=NULL, last_ok_at=? WHERE id=?").run(nowIso(), d.id);
        if (d.status === 'needs_signin') { out.recovered++; o.log?.(`gmaps destination ${d.id}: the session works (Save menu opened) — "needs sign-in" cleared, pending places continue`); }
        else o.log?.(`gmaps destination ${d.id}: session check ok (signed in)`);
      } else if (r.signedIn === false) {
        if (d.status !== 'needs_signin') { out.signedOut++; o.log?.(`gmaps destination ${d.id}: needs sign-in (session check: ${r.detail})`); }
        else o.log?.(`gmaps destination ${d.id}: still signed out (${r.detail})`);
        store.db.prepare("UPDATE gmaps_destinations SET status='needs_signin', detail=? WHERE id=?").run(SIGNED_OUT_DETAIL, d.id);
      } else o.log?.(`gmaps destination ${d.id}: session check inconclusive, nothing changed (${r.detail})`);
    } catch (e) {
      o.log?.(`gmaps destination ${d.id}: session check could not run (${(e as Error).message.split('\n')[0]})`);
    } finally { await b?.close().catch(() => {}); release(); }
  }
  return out;
}

