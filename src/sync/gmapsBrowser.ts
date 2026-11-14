/**
 * The server's own browser for a Google Maps list destination.
 *
 * Each destination has two things in <dataDir>/private/gmaps/ (mode 700, never logged, never in the database):
 *  - session-<id>.profile/  a persistent Chromium profile. This is the session that is used: Chromium itself keeps the
 *    cookies Google rotates, so a refreshed session survives browser shutdown, restarts and redeploys (the volume).
 *  - session-<id>.json      a snapshot of the cookies, rewritten (atomically) after each run that was signed in. It
 *    rebuilds the profile if the profile is missing or damaged, and it is what the desktop command uploads.
 *
 * Why a profile and not only the snapshot (found 2026-11-13): a session signed in on a Windows PC is bound to that PC
 * (Chrome's Device Bound Session Credentials) — copied to the server it was signed out by Google within hours, twice.
 * A session signed in IN this profile (Setup → "Sign in to Google", src/sync/gmapsSignin.ts) belongs to this browser.
 *
 * One browser per profile at a time: every user of a destination's session (save cycle, session check, operator
 * probe, sign-in) takes the destination's lock first, so nothing can write older state over newer state.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const baseOf = (stateFile: string) => stateFile.replace(/\.json$/, '');
const pointerOf = (stateFile: string) => `${baseOf(stateFile)}.profile-path`;
/**
 * The destination's browser profile: session-<id>.profile, or — after a sign-in on the server — the folder the sign-in
 * happened in (named in session-<id>.profile-path). That browser is still open, and Chromium's folder is not moved.
 */
export const profileOf = (stateFile: string) => {
  try { const p = fs.readFileSync(pointerOf(stateFile), 'utf8').trim(); if (p) return p; } catch { /* default */ }
  return `${baseOf(stateFile)}.profile`;
};

/** Drop a destination's browser profile (closing its live browser first). `use` = the sign-in profile that replaces it. */
export function replaceProfile(stateFile: string, use?: string) {
  discardBrowser(stateFile);
  for (const d of new Set([profileOf(stateFile), `${baseOf(stateFile)}.profile`])) {
    if (use && path.resolve(d) === path.resolve(use)) continue;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
  try { fs.rmSync(pointerOf(stateFile), { force: true }); } catch { /* none */ }
  if (use) fs.writeFileSync(pointerOf(stateFile), use, { mode: 0o600 });
}

/** Forget a destination's session: the snapshot and the browser profile. */
export function removeSessionFiles(stateFile: string | null | undefined) {
  if (!stateFile) return;
  replaceProfile(stateFile);
  try { fs.rmSync(stateFile, { force: true }); } catch { /* gone */ }
}

// ---------------- the live browser: one per destination, kept open ----------------
/**
 * Why the browser stays open (found 2026-11-14): a session signed in on the server was dead on Google's side about a
 * minute later — the cookies were present in the next browser, but Google's own account check listed 0 accounts. The
 * only thing that had happened in between was the handover: the browser that signed in was closed and a new one was
 * started with its cookies. To Google that is a session appearing in another browser (what stolen cookies look like),
 * and the same handover killed every earlier session within minutes to hours. So the browser that signs in is the
 * browser that saves, like a person's own browser that stays open: it is closed only when the server stops (the
 * snapshot is written first) or when the destination signs in again or disconnects.
 */
interface Live { ctx: any; page: any }
const live = new Map<string, Live>();
const keyOf = (stateFile: string) => path.resolve(stateFile);
/** Keep the live cookies as the snapshot — only while they are still a signed-in session (never replace one with nothing). */
async function keepSnapshot(stateFile: string, ctx: any) { const st = await ctx.storageState(); if (hasGoogleSignin(st.cookies)) writeSnapshot(stateFile, st); }
/** This open browser is now the destination's browser (the sign-in hands its browser over). */
export function adoptBrowser(stateFile: string, ctx: any) {
  const k = keyOf(stateFile); const pages = ctx.pages();
  live.set(k, { ctx, page: pages[pages.length - 1] ?? null });
  ctx.on?.('close', () => { if (live.get(k)?.ctx === ctx) live.delete(k); });
}
/** Close a destination's live browser without keeping its cookies (it is being replaced or disconnected). */
export function discardBrowser(stateFile: string) {
  const k = keyOf(stateFile); const l = live.get(k); live.delete(k);
  void l?.ctx.close().catch(() => {});
}
export const hasLiveBrowser = (stateFile: string) => live.has(keyOf(stateFile));
/** Server shutdown: snapshot and close every live browser (Chromium writes its profile on a proper close). */
export async function closeAllBrowsers() {
  const all = [...live.entries()]; live.clear();
  await Promise.all(all.map(async ([k, l]) => { await keepSnapshot(k, l.ctx).catch(() => {}); await l.ctx.close().catch(() => {}); }));
}

// ---------------- one browser per destination ----------------
const busy = new Set<string>();
export const lockKey = (destinationId: number) => `gmaps:${destinationId}`;
/** Take the lock now, or null when another run holds it (the caller skips this pass; it never waits inside a cycle). */
export function tryLock(key: string): (() => void) | null {
  if (busy.has(key)) return null;
  busy.add(key);
  let done = false;
  return () => { if (!done) { done = true; busy.delete(key); } };
}
/** Wait (briefly) for the lock: for a person or operator who asked for something, not for the worker cycle. */
export async function waitLock(key: string, ms: number): Promise<(() => void) | null> {
  const until = Date.now() + ms;
  for (;;) {
    const r = tryLock(key);
    if (r || Date.now() >= until) return r;
    await new Promise((x) => setTimeout(x, 250));
  }
}

// ---------------- launching ----------------
const uaCache = new Map<string, string | undefined>();
/** An ordinary Chrome-on-Linux user agent for the server's headless Chromium (which otherwise says "HeadlessChrome"). */
export function userAgentFor(chromePath: string): string | undefined {
  if (process.platform !== 'linux') return undefined;
  if (!uaCache.has(chromePath)) {
    let ua: string | undefined;
    try {
      const major = execFileSync(chromePath, ['--version'], { timeout: 10_000, encoding: 'utf8' }).match(/(\d+)\.\d+\.\d+/)?.[1];
      if (major) ua = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    } catch { /* keep Chromium's own */ }
    uaCache.set(chromePath, ua);
  }
  return uaCache.get(chromePath);
}

export interface Viewport { width: number; height: number }
export const DESKTOP: Viewport = { width: 1280, height: 900 };

/** Open (or create) a persistent profile. A lock left by a killed container is removed first. */
export async function openProfile(chromePath: string, dir: string, o: { viewport?: Viewport; deviceScaleFactor?: number } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Chromium refuses a profile "in use on another computer" when a redeploy killed it mid-run.
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* none */ } }
  const { chromium } = await import('playwright-core');
  return chromium.launchPersistentContext(dir, {
    executablePath: chromePath, headless: true, locale: 'en-US', viewport: o.viewport ?? DESKTOP, deviceScaleFactor: o.deviceScaleFactor,
    userAgent: userAgentFor(chromePath),
    // The page cache is not part of the session: keep it off the volume.
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', `--disk-cache-dir=${path.join(os.tmpdir(), 'reelocations-chromium-cache')}`],
  });
}

/** Write the cookie snapshot without ever leaving a half-written file (a redeploy can stop the process at any time). */
export function writeSnapshot(stateFile: string, state: unknown) {
  const tmp = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

export const readSnapshotCookies = (stateFile: string): any[] => { try { const c = JSON.parse(fs.readFileSync(stateFile, 'utf8')).cookies; return Array.isArray(c) ? c : []; } catch { return []; } };

/** Google's sign-in cookies: without them a state is signed out and must never replace a snapshot that has them. */
const AUTH_COOKIES = new Set(['SID', 'HSID', 'SSID', '__Secure-1PSID', '__Secure-3PSID']);
export const hasGoogleSignin = (cookies: any[]) => cookies.some((c) => AUTH_COOKIES.has(c?.name) && /(^|\.)google\.com$/.test(String(c?.domain ?? '').replace(/^\./, '')));

/**
 * Real launcher for the save cycle, the session check and the operator probe: the destination's LIVE browser (see
 * above). `close` ends the run, not the browser. Only when there is no live browser (after a server restart, a crash,
 * or a session connected with the desktop command) is one started from the profile, with the snapshot's cookies put in:
 * Chromium writes cookies to disk only about every 30 s, so the snapshot is the newer record (found 2026-11-14: the
 * profile held no sign-in cookies at all while the snapshot had them).
 */
export function profileLauncher(chromePath: string) {
  return async (stateFile: string) => {
    let l = live.get(keyOf(stateFile));
    if (!l) {
      const dir = profileOf(stateFile);
      let ctx;
      try { ctx = await openProfile(chromePath, dir); }
      catch (e) {
        if (!fs.existsSync(dir)) throw e;
        // A damaged profile: rebuild it (the cookies come from the snapshot below).
        fs.rmSync(dir, { recursive: true, force: true });
        ctx = await openProfile(chromePath, dir);
      }
      const cookies = readSnapshotCookies(stateFile);
      if (cookies.length) await ctx.addCookies(cookies).catch(() => {});
      adoptBrowser(stateFile, ctx);
      l = live.get(keyOf(stateFile))!;
    }
    const cur = l;
    if (!cur.page || cur.page.isClosed?.()) cur.page = cur.ctx.pages()[0] ?? await cur.ctx.newPage();
    return {
      page: cur.page,
      save: () => keepSnapshot(stateFile, cur.ctx),
      // The browser stays open (and on Google's page, which keeps refreshing the session like a person's open tab).
      close: async () => { await keepSnapshot(stateFile, cur.ctx).catch(() => {}); },
    };
  };
}
