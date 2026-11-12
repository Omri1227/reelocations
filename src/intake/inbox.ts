import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db.ts';
import { nowIso } from '../db.ts';
import type { Http } from '../util/http.ts';
import { normalizeSharedAt, parseShare } from './parse.ts';
import { googleMapsUrl } from '../geo/googlePlaces.ts';
import { CATEGORY_INFO } from '../categories.ts';
import type { Category } from '../types.ts';

export interface InboxItem {
  id: string;                 // idempotency key assigned by the inbox
  row: number;                // monotonically increasing cursor
  kind: 'share' | 'media' | 'review';
  received_at: string;
  shared_at?: string;
  text?: string;
  note?: string;
  input_types?: string;
  reel_url?: string;
  media_ref?: string;
  mime?: string;
  filename?: string;
}

export interface StatusItem {
  reel_key: string; url: string | null; shared_at: string; status: string; reason: string | null;
  places: { name: string; category: string; emoji: string; confidence: string; maps_url: string; cue: string | null; image?: string | null; image_label?: string | null }[];
  /** For Reels in review: the best options, shown as ✓ buttons on the phone page (ref = candidate id). */
  candidates?: { ref: string; name: string; where: string; emoji: string }[];
  updated_at: string;
}

export interface Inbox {
  pull(after: number): Promise<{ items: InboxItem[]; last: number }>;
  fetchMedia(ref: string): Promise<{ mime: string; data: Buffer; filename?: string }>;
  pushStatus(items: StatusItem[]): Promise<void>;
  /** Store a pin image (JPEG) shared by link; returns its URL. Optional (older inboxes lack it). */
  putImage?(jpeg: Buffer, filename: string): Promise<string>;
}

/** Client for the Google Apps Script web app (apps-script/Code.gs) running in the user's own Google account. */
export class AppsScriptInbox implements Inbox {
  private http: Http; private url: string; private token: string;
  constructor(http: Http, url: string, token: string) { this.http = http; this.url = url; this.token = token; }
  private async call<T>(payload: Record<string, unknown>): Promise<T> {
    const r = await this.http.json<any>(this.url, { method: 'POST', body: JSON.stringify({ token: this.token, ...payload }), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, retries: 2, timeoutMs: 60_000 });
    if (!r || r.ok !== true) throw new Error(`inbox ${payload.action} failed: ${r?.error ?? 'unexpected response'}`);
    return r as T;
  }
  async pull(after: number) { const r = await this.call<{ items: InboxItem[]; last: number }>({ action: 'pull', after }); return { items: r.items, last: r.last }; }
  async fetchMedia(ref: string) {
    const r = await this.call<{ mime: string; data: string; filename?: string }>({ action: 'media', id: ref });
    return { mime: r.mime, data: Buffer.from(r.data, 'base64'), filename: r.filename };
  }
  async putImage(jpeg: Buffer, filename: string) { const r = await this.call<{ url: string }>({ action: 'image_put', data: jpeg.toString('base64'), filename }); return r.url; }
  async pushStatus(items: StatusItem[]) { for (let i = 0; i < items.length; i += 50) await this.call({ action: 'status', items: items.slice(i, i + 50) }); }
}

/** MIME type from the file's first bytes (JPEG, PNG, HEIC/HEIF, QuickTime, MP4/M4V); undefined if unknown. */
export function sniffMime(b: Buffer): string | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('latin1');
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  return undefined;
}

export function mediaKind(mime: string | undefined, filename?: string): 'image' | 'video' {
  if (mime?.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(filename ?? '')) return 'video';
  return 'image';
}

/** Who sent an item: the collection it goes to and the contributing user (null = not known, e.g. before accounts). */
export interface IntakeContext { collectionId: number; userId: number | null }
/** Reel keys are per collection: collection 1 keeps the original keys; others are prefixed ("c7/ig:ABC"). */
export const nsKey = (collectionId: number, key: string) => (collectionId === 1 ? key : `c${collectionId}/${key}`);

/** Apply one inbox item to the local store. Idempotent: re-delivery of the same id changes nothing. */
export function applyItem(store: Store, it: InboxItem, ctx: IntakeContext = { collectionId: 1, userId: null }): { action: string; reelKey?: string } {
  const sharedAt = normalizeSharedAt(it.shared_at, it.received_at);
  const cid = ctx.collectionId, uid = ctx.userId;
  if (it.kind === 'review') {
    // A decision from the phone page; applied (async) by applyReviewDecisions at the start of the next worker run.
    if (store.getKv(`review:done:${it.id}`)) return { action: 'duplicate_delivery' };
    store.setKv(`review:pending:${it.id}`, JSON.stringify({ reelKey: it.input_types, action: it.text, value: it.note ?? '' }));
    return { action: 'review_decision', reelKey: it.input_types ?? undefined };
  }
  if (it.kind === 'share') {
    const p = parseShare(it.text, `share:${it.id}`);
    const extra = p.extraText && p.extraText.length > 3 && p.extraText !== it.text ? p.extraText : '';
    const note = [it.note?.trim(), extra].filter(Boolean).join('\n') || null;
    const key = nsKey(cid, p.reelKey);
    const r = store.addShare({ intake_id: it.id, reel_key: key, url: p.url, shortcode: p.shortcode, raw_text: it.text ?? null, input_types: it.input_types ?? null, shared_at: sharedAt, note, collection_id: cid, user_id: uid });
    return { action: r.inserted ? (r.newReel ? 'new_reel' : 'repeat_share') : 'duplicate_delivery', reelKey: key };
  }
  // media: attach to the named Reel, else to the most recent share at or before the media upload
  let reelKey: string | undefined;
  if (it.reel_url) {
    const p = parseShare(it.reel_url);
    reelKey = nsKey(cid, p.reelKey);
    if (!store.getReel(reelKey)) store.addShare({ intake_id: `media-share:${it.id}`, reel_key: reelKey, url: p.url, shortcode: p.shortcode, raw_text: it.reel_url, input_types: 'url(from media upload)', shared_at: sharedAt, note: it.note ?? null, collection_id: cid, user_id: uid });
  } else {
    const t = Date.parse(sharedAt);
    // The most recent share of THIS sender in THIS collection (another member's Reel is never the target).
    const shares = (store.db.prepare(`SELECT s.reel_key, s.shared_at FROM shares s JOIN reels r USING(reel_key) WHERE (s.input_types IS NULL OR s.input_types != 'media only') AND r.collection_id=? AND (? IS NULL OR s.user_id IS NULL OR s.user_id=?)`).all(cid, uid, uid) as any[])
      .map((s) => ({ key: s.reel_key as string, t: Date.parse(s.shared_at) })).sort((a, b) => b.t - a.t);
    reelKey = (shares.find((s) => s.t <= t) ?? shares[0])?.key;
    if (!reelKey) {
      reelKey = nsKey(cid, `media:${it.id}`);
      store.addShare({ intake_id: `media-share:${it.id}`, reel_key: reelKey, url: null, shortcode: null, raw_text: null, input_types: 'media only', shared_at: sharedAt, note: it.note ?? null, collection_id: cid, user_id: uid });
    }
  }
  const added = store.addMedia({ media_id: it.id, reel_key: reelKey, kind: mediaKind(it.mime, it.filename), mime: it.mime ?? null, remote_ref: it.media_ref ?? it.id, local_path: null });
  if (added) {
    const r = store.getReel(reelKey);
    if (r && r.status !== 'not_a_place' && (r.status !== 'resolved' || store.linksForReel(reelKey).every((l) => l.confidence !== 'confirmed'))) store.requeue(reelKey, 'media attached');
  }
  return { action: added ? 'media_attached' : 'duplicate_delivery', reelKey };
}

/** Pull everything new from the inbox. The cursor only advances after items are durably stored. */
export async function pullInbox(store: Store, inbox: Inbox): Promise<{ pulled: number; actions: Record<string, number> }> {
  // The Apps Script inbox is the original owner's Shortcut: its items belong to collection 1 and its owner (once claimed).
  const owner = (store.db.prepare('SELECT owner_user_id o FROM collections WHERE id=1').get() as any)?.o ?? null;
  const after = Number(store.getKv('inbox_cursor') ?? '0');
  const { items, last } = await inbox.pull(after);
  const actions: Record<string, number> = {};
  for (const it of items.sort((a, b) => a.row - b.row)) {
    const r = applyItem(store, it, { collectionId: 1, userId: owner });
    actions[r.action] = (actions[r.action] ?? 0) + 1;
    store.setKv('inbox_cursor', String(it.row));
  }
  if (last > after && !items.length) store.setKv('inbox_cursor', String(last));
  return { pulled: items.length, actions };
}

export async function downloadPendingMedia(store: Store, inbox: Inbox, dir: string): Promise<number> {
  let n = 0;
  const rows = store.db.prepare(`SELECT * FROM media WHERE status IN ('pending','failed') AND remote_ref IS NOT NULL`).all() as any[];
  for (const m of rows) {
    try {
      const r = await inbox.fetchMedia(m.remote_ref);
      // The iPhone Shortcut sends no MIME type (Apps Script stores application/octet-stream), so trust the bytes.
      const sniffed = sniffMime(r.data);
      const mime = sniffed ?? r.mime;
      const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('heic') ? 'heic' : mime.includes('quicktime') ? 'mov' : mime.includes('mp4') ? 'mp4' : 'bin';
      const file = path.join(dir, `${m.media_id.replace(/[^\w-]/g, '_')}.${ext}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, r.data);
      store.updateMedia(m.media_id, { status: 'downloaded', local_path: file, error: null, mime, kind: sniffed ? mediaKind(sniffed) : undefined });
      n++;
    } catch (e) {
      store.updateMedia(m.media_id, { status: 'failed', error: String((e as Error).message) });
    }
  }
  return n;
}

/** "📸 From the Reel (0:12)" for a frame that shows/names this place; "📸 Reel preview" for a general frame. */
export function imageLabel(l: { image_kind?: string | null; image_t?: string | null }): string | null {
  if (!l.image_kind) return null;
  if (l.image_kind === 'preview') return '📸 Reel preview';
  const t = l.image_t != null ? Number(l.image_t) : NaN;
  return Number.isFinite(t) ? `📸 From the Reel (${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')})` : '📸 From the Reel';
}

export function buildStatusItems(store: Store, since?: string): StatusItem[] {
  // The Apps Script phone page lives in the original owner's Google account: only collection 1 goes there.
  const reels = since ? (store.db.prepare('SELECT * FROM reels WHERE updated_at > ? AND collection_id=1 ORDER BY first_shared_at').all(since) as any[]) : store.listReels().filter((r: any) => (r.collection_id ?? 1) === 1);
  return reels.map((r) => ({
    reel_key: r.reel_key, url: r.url, shared_at: r.first_shared_at, status: r.status, reason: r.status_reason, updated_at: r.updated_at,
    places: store.linksForReel(r.reel_key).map((l: any) => ({
      name: l.name, category: l.category, emoji: CATEGORY_INFO[l.category as Category]?.emoji ?? '📌', confidence: l.confidence,
      maps_url: googleMapsUrl(l), cue: l.cue, image: l.image_url ?? null, image_label: imageLabel(l),
    })),
    candidates: r.status === 'needs_review' ? store.candidatesFor(r.reel_key).slice(0, 5).map((c) => ({
      ref: c.ref, name: c.name,
      where: `${(c.scoreParts?.nameSim ?? 1) < 0.9 ? '≈ similar name · ' : ''}${c.displayName.split(',').slice(1, 4).map((x) => x.trim()).join(', ')}`, emoji: CATEGORY_INFO[c.category]?.emoji ?? '📌',
    })) : [],
  }));
}

export async function pushStatus(store: Store, inbox: Inbox): Promise<number> {
  const since = store.getKv('status_pushed_at');
  const startedAt = nowIso();
  const items = buildStatusItems(store, since);
  if (items.length) await inbox.pushStatus(items);
  store.setKv('status_pushed_at', startedAt);
  return items.length;
}

/** Upload pin images that have none yet (downscaled to ≤800 px JPEG). Failures are retried on the next run. */
export async function publishImages(store: Store, inbox: Inbox, workDir: string, downscale: (file: string, out: string, width: number) => Promise<string>): Promise<number> {
  if (!inbox.putImage) return 0;
  let n = 0;
  for (const l of store.linksNeedingImageUpload(20)) {
    try {
      if (!fs.existsSync(l.image_path)) continue;
      fs.mkdirSync(workDir, { recursive: true });
      const small = await downscale(l.image_path, path.join(workDir, `pin-${String(l.place_id).replace(/[^\w-]/g, '_')}-${path.basename(l.image_path).replace(/\.\w+$/, '')}.jpg`), 800);
      const url = await inbox.putImage(fs.readFileSync(small), path.basename(small));
      store.setLinkImageUrl(l.reel_key, l.place_id, url);
      n++;
    } catch { /* offline or old inbox version: retry next run */ }
  }
  return n;
}
