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

export const profileOf = (stateFile: string) => `${stateFile.replace(/\.json$/, '')}.profile`;

/** Forget a destination's session: the snapshot and the browser profile. */
export function removeSessionFiles(stateFile: string | null | undefined) {
  if (!stateFile) return;
  try { fs.rmSync(stateFile, { force: true }); } catch { /* gone */ }
  try { fs.rmSync(profileOf(stateFile), { recursive: true, force: true }); } catch { /* gone */ }
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
 * Real launcher for the save cycle and the session check: the destination's persistent profile, with the SNAPSHOT as
 * the authority on cookies.
 *
 * Why (found 2026-11-14): Chromium writes cookies to the profile's disk store in batches (about every 30 s) and a
 * browser closed sooner loses the newest ones. The server-side sign-in closes its browser seconds after Google signs
 * in, so the profile on the volume had NO sign-in cookies (SID, __Secure-1PSID, …) while the snapshot had all of them —
 * the very next save run met Google's sign-in page ("needs sign-in" 73 s after a successful sign-in). Cookies Google
 * rotates near the end of a run were lost the same way. So: the snapshot's cookies are put into the browser on every
 * launch, and the snapshot is rewritten from the live browser before every close while it is still signed in.
 */
export function profileLauncher(chromePath: string) {
  return async (stateFile: string) => {
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
    const page = ctx.pages()[0] ?? await ctx.newPage();
    /** Keep the live cookies — only while they are still a signed-in session (never replace a session with nothing). */
    const keep = async () => { const st = await ctx.storageState(); if (hasGoogleSignin(st.cookies)) writeSnapshot(stateFile, st); };
    return {
      page,
      save: keep,
      close: async () => { await keep().catch(() => {}); await ctx.close(); },
    };
  };
}
