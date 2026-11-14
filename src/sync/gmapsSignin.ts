/**
 * Sign in to Google IN the server's browser, from any device (an iPhone is enough): Setup → "Sign in to Google".
 *
 * The server opens Google's own sign-in page in a headless Chromium with a new profile and shows it in Setup as a
 * picture that is refreshed about once a second; taps and typed text are passed on to that page. When Google Maps
 * opens signed in — checked with the real Save menu — the profile becomes the destination's session.
 *
 * Why here and not on a computer: a session signed in on a PC and copied to the server is signed out by Google within
 * hours (it is bound to that PC). A session that starts in this browser belongs to it.
 *
 * Privacy: what is typed (the Google password too) goes over HTTPS to this server and straight into Google's page. It
 * is never stored and never logged; only the resulting browser profile is kept, in <dataDir>/private/gmaps (mode 700).
 * One sign-in at a time; it ends after 10 minutes, on Cancel, or when it connects.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db.ts';
import { nowIso } from '../db.ts';
import { adoptBrowser, DESKTOP, lockKey, openProfile, waitLock, type Viewport } from './gmapsBrowser.ts';
import { accountsPageKind, signedInEmail } from './savedList.ts';
import { accountHash, connectGmaps, ensureGmapsTables, gmapsDir, probeSession } from './savedListRunner.ts';

export const PHONE: Viewport = { width: 412, height: 780 };
const SIGNIN_URL = 'https://accounts.google.com/ServiceLogin?hl=en&continue=' + encodeURIComponent('https://www.google.com/maps?hl=en');
const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape']);
const TTL_MS = 10 * 60_000;
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

export type SigninStatus = 'waiting' | 'verifying' | 'connected' | 'failed' | 'expired' | 'cancelled';
/** The part of the remote browser this module uses (a Playwright BrowserContext; tests pass a fake). */
export interface RemoteBrowser { pages(): any[]; newPage(): Promise<any>; addCookies(c: any[]): Promise<void>; storageState(): Promise<any>; close(): Promise<void> }

interface Session {
  id: string; collectionId: number; userId: number; status: SigninStatus; detail: string; startedAt: number;
  ctx: RemoteBrowser | null; dir: string; release: (() => void) | null; timer: ReturnType<typeof setInterval> | null;
  expected: string | null; verifying: boolean; viewport: Viewport;
}

export interface SigninOptions {
  store: () => Store; dataDir: () => string; log: (m: string) => void; onConnected: (collectionId: number) => void;
  open: (dir: string, viewport: Viewport) => Promise<RemoteBrowser>;
  probe?: typeof probeSession; email?: typeof signedInEmail; tickMs?: number;
}

export class GmapsSignin {
  private cur: Session | null = null;
  private o: SigninOptions;
  constructor(o: SigninOptions) { this.o = o; }

  private page(s: Session) { const p = s.ctx!.pages(); return p[p.length - 1]; }
  private mine(collectionId: number, userId: number): Session {
    const s = this.cur;
    if (!s || s.collectionId !== collectionId || s.userId !== userId) throw httpError(404, 'no sign-in is open — start again');
    return s;
  }
  private live(collectionId: number, userId: number): Session {
    const s = this.mine(collectionId, userId);
    if (s.status !== 'waiting' || !s.ctx) throw httpError(409, `the sign-in is ${s.status}`);
    return s;
  }

  /** Open Google's sign-in page in a new server-side profile. Starting again replaces your own unfinished sign-in. */
  async start(collectionId: number, userId: number): Promise<{ id: string; width: number; height: number }> {
    const store = this.o.store(); ensureGmapsTables(store);
    if (this.cur && (this.cur.status === 'waiting' || this.cur.status === 'verifying')) {
      if (this.cur.collectionId !== collectionId || this.cur.userId !== userId) throw httpError(409, 'another Google sign-in is open on this server — try again in a few minutes');
      if (this.cur.status === 'verifying') throw httpError(409, 'the sign-in is being checked — wait a moment');
      await this.end(this.cur, 'cancelled', 'started again');
    }
    const d = store.db.prepare('SELECT * FROM gmaps_destinations WHERE collection_id=? AND disconnected_at IS NULL').get(collectionId) as any;
    // The save cycle may have this destination's browser open: wait for it; from then on the cycle skips it.
    const release = d ? await waitLock(lockKey(d.id), 90_000) : null;
    if (d && !release) throw httpError(409, 'the server is saving places right now — try again in a minute');
    // A folder of its own per sign-in: on success it stays the destination's profile, where its browser keeps running.
    const sid = Math.random().toString(36).slice(2, 10);
    const dir = path.join(gmapsDir(this.o.dataDir()), `signin-c${collectionId}-${sid}.profile`);
    const s: Session = { id: sid, collectionId, userId, status: 'waiting', detail: '', startedAt: Date.now(), ctx: null, dir, release, timer: null, expected: d?.account_hash ?? null, verifying: false, viewport: PHONE };
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      s.ctx = await this.o.open(dir, PHONE);
      // Only Google's "which account" hint from the old session, so its account is offered first. No session cookies.
      if (d?.state_file) { try { const c = (JSON.parse(fs.readFileSync(d.state_file, 'utf8')).cookies as any[]).filter((x) => x.name === 'ACCOUNT_CHOOSER'); if (c.length) await s.ctx.addCookies(c); } catch { /* no hint */ } }
      const page = s.ctx.pages()[0] ?? await s.ctx.newPage();
      await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      // A destination from before accounts were remembered: when Google offers exactly one account, that is the one.
      if (!s.expected) { try { const emails = new Set<string>(((await page.locator('body').innerText({ timeout: 5000 })) as string).toLowerCase().match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []); if (accountsPageKind(page.url()) === 'signin' && emails.size === 1) s.expected = accountHash([...emails][0]!); } catch { /* unknown */ } }
    } catch (e) {
      await s.ctx?.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); release?.();
      throw httpError(502, `the server's browser could not open Google's sign-in page (${(e as Error).message.split('\n')[0]})`);
    }
    this.cur = s;
    s.timer = setInterval(() => { void this.tick(s); }, this.o.tickMs ?? 1500);
    this.o.log(`google maps sign-in opened (collection ${collectionId})`);
    return { id: s.id, width: PHONE.width, height: PHONE.height };
  }

  /** Close the browser and free the destination; a finished sign-in stays readable (its status) until the next one. */
  private async end(s: Session, status: SigninStatus, detail: string, keepProfile = false) {
    if (s.timer) { clearInterval(s.timer); s.timer = null; }
    s.status = status; s.detail = detail;
    const ctx = s.ctx; s.ctx = null;
    await ctx?.close().catch(() => {});
    if (!keepProfile) { try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* gone */ } }
    s.release?.(); s.release = null;
    if (status !== 'connected') this.o.log(`google maps sign-in ${status} (collection ${s.collectionId})${status === 'failed' ? `: ${detail}` : ''}`);
  }

  private async tick(s: Session) {
    if (s.status !== 'waiting' || s.verifying || !s.ctx) return;
    if (Date.now() - s.startedAt > TTL_MS) return void this.end(s, 'expired', 'The sign-in page was open for 10 minutes. Start again.');
    let url = ''; try { url = String(this.page(s).url()); } catch { return; }
    // Google sends the browser on to Maps (the "continue" address) once the sign-in is complete.
    if (!/^https:\/\/www\.google\.[a-z.]+\/maps/.test(url)) return;
    s.verifying = true; s.status = 'verifying';
    try { await this.finish(s); }
    catch (e) { await this.end(s, 'failed', (e as any).code === 'other_account' ? (e as Error).message : `Could not finish: ${(e as Error).message.split('\n')[0]}`); }
  }

  /** Signed in? Proven by the Save menu. Then the profile becomes the collection's session; everything else is kept. */
  private async finish(s: Session) {
    const store = this.o.store();
    const page = this.page(s);
    await page.setViewportSize(DESKTOP);
    const d = store.db.prepare('SELECT id FROM gmaps_destinations WHERE collection_id=? AND disconnected_at IS NULL').get(s.collectionId) as any;
    const last = d ? store.db.prepare("SELECT google_place_id, name FROM gmaps_saves WHERE destination_id=? AND status='verified' ORDER BY verified_at DESC LIMIT 1").get(d.id) as any : null;
    const r = await (this.o.probe ?? probeSession)(page, last ? { googlePlaceId: last.google_place_id, name: last.name ?? 'place' } : { googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', name: 'Google Sydney' });
    if (r.signedIn !== true) return void await this.end(s, 'failed', r.signedIn === false ? 'Google Maps in the server\'s browser is still signed out after the sign-in. Start again.' : `The sign-in could not be checked (${r.detail}). Start again.`);
    const email = await (this.o.email ?? signedInEmail)(page);
    if (s.expected && email && accountHash(email) !== s.expected) return void await this.end(s, 'failed', 'That is a different Google account than the one this list is connected to. Sign in to the same account — or disconnect first to switch accounts.');
    const state = await s.ctx!.storageState();
    // This browser is NOT closed: it becomes the destination's browser (closing it and starting another with its
    // cookies is what got every earlier session signed out by Google — see gmapsBrowser.ts).
    const ctx = s.ctx!;
    const id = connectGmaps(store, this.o.dataDir(), { collectionId: s.collectionId, userId: s.userId, state, profileDir: s.dir, account: email });
    adoptBrowser((store.db.prepare('SELECT state_file FROM gmaps_destinations WHERE id=?').get(id) as any).state_file, ctx);
    s.ctx = null;
    store.db.prepare('UPDATE gmaps_destinations SET last_ok_at=?, last_check_at=? WHERE id=?').run(nowIso(), nowIso(), id);
    await this.end(s, 'connected', 'Connected.', true);
    this.o.log(`google maps list connected by sign-in on the server: destination ${id} (collection ${s.collectionId})`); // never the session or the account
    this.o.onConnected(s.collectionId);
  }

  /** What Setup shows next to the picture. `focus` says what kind of field has the cursor (so the phone can mask a password). */
  async state(collectionId: number, userId: number): Promise<{ id: string; status: SigninStatus; detail: string; focus: 'password' | 'text' | null; width: number; height: number; seconds_left: number }> {
    const s = this.mine(collectionId, userId);
    let focus: 'password' | 'text' | null = null;
    if (s.status === 'waiting' && s.ctx) {
      try { focus = await this.page(s).evaluate(() => { const e = document.activeElement as HTMLInputElement | null; return e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') ? (e.type === 'password' ? 'password' : 'text') : null; }); } catch { /* navigating */ }
    }
    return { id: s.id, status: s.status, detail: s.detail, focus, width: s.viewport.width, height: s.viewport.height, seconds_left: Math.max(0, Math.round((s.startedAt + TTL_MS - Date.now()) / 1000)) };
  }

  /** The sign-in page as a JPEG. Shown only to the person who started it. */
  async screen(collectionId: number, userId: number): Promise<Buffer> {
    const s = this.live(collectionId, userId);
    return await this.page(s).screenshot({ type: 'jpeg', quality: 60, timeout: 10_000 });
  }

  /** A tap, typed text, a key, or scrolling. The content is passed to the page and nothing else. */
  async input(collectionId: number, userId: number, b: any): Promise<void> {
    const s = this.live(collectionId, userId);
    const page = this.page(s);
    if (b?.tap) {
      const x = Number(b.tap.x), y = Number(b.tap.y);
      if (!(x >= 0 && x <= s.viewport.width && y >= 0 && y <= s.viewport.height)) throw httpError(400, 'tap outside the page');
      await page.mouse.click(x, y);
    } else if (typeof b?.text === 'string') {
      if (!b.text || b.text.length > 200) throw httpError(400, 'text must be 1–200 characters');
      await page.keyboard.type(b.text, { delay: 25 });
    } else if (typeof b?.key === 'string') {
      if (!KEYS.has(b.key)) throw httpError(400, 'unknown key');
      await page.keyboard.press(b.key);
    } else if (b?.scroll != null) {
      await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, Number(b.scroll) || 0)));
    } else throw httpError(400, 'nothing to do');
  }

  async cancel(collectionId: number, userId: number): Promise<void> {
    const s = this.mine(collectionId, userId);
    if (s.status === 'waiting') await this.end(s, 'cancelled', 'Cancelled.');
  }

  /** Server shutdown or data import: close the browser. */
  async close(): Promise<void> { const s = this.cur; if (s && (s.status === 'waiting' || s.status === 'verifying')) await this.end(s, 'cancelled', 'the server restarted'); }
}

/** The real remote browser: a phone-sized page in a persistent profile. */
export const remoteBrowser = (chromePath: () => string) => async (dir: string, viewport: Viewport): Promise<RemoteBrowser> =>
  await openProfile(chromePath(), dir, { viewport, deviceScaleFactor: 2 }) as unknown as RemoteBrowser;
