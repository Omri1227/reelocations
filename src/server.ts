#!/usr/bin/env node
/**
 * The hosted app (Railway): one always-on process that
 *  - receives shares from the iPhone Shortcuts (POST /api/intake, same JSON as the Apps Script inbox) with a personal,
 *    revocable intake credential — and keeps pulling the original Apps Script inbox (owner of collection 1);
 *  - runs the pipeline ONCE per Reel (identify → Google listing → subtype → pins);
 *  - serves accounts (Google Sign-In), collections, the map, live updates, screenshots and review, all scoped by
 *    membership; and the publisher API that desktop workers use to publish finished pins to each user's My Maps.
 * Data (SQLite + media) lives in REEL_MAPS_DATA_DIR, a Railway volume, so it survives restarts and redeploys.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { createApp, type App } from './app.ts';
import { runOnce } from './worker.ts';
import { applyItem, mediaKind, sniffMime, type IntakeContext } from './intake/inbox.ts';
import { handleReview } from './review/server.ts';
import { buildMapData, imageFileFor, setCountryOrder } from './web/mapData.ts';
import { matchStoredPlaces, recheckListings } from './geo/googleMatch.ts';
import { nowIso } from './db.ts';
import { repairPaths } from './repairPaths.ts';
import { Accounts, verifyGoogleIdToken, type GoogleIdentity } from './accounts.ts';
import { backfillCuisines, backfillGoogleTypes, isCuisine } from './cuisine.ts';
import { refineGenericCategories } from './categories.ts';
import { allowanceFromStore, setBalance } from './aiUsage.ts';
import { connectGmaps, disconnectGmaps, ensureGmapsTables, gmapsCheck, gmapsCycle, gmapsStatus } from './sync/savedListRunner.ts';
import { lockKey, profileLauncher, waitLock } from './sync/gmapsBrowser.ts';
import { GmapsSignin, remoteBrowser, type RemoteBrowser } from './sync/gmapsSignin.ts';
import { openListing, probeListMenu, probeNewList, readSaveState, sessionDiagnostics } from './sync/savedList.ts';
import { findChrome } from './sync/mymaps.ts';
import { buildExport, collectionSyncStatus, connectDestination, destinationForCredential, disconnectDestination, recordReport } from './destinations.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

export interface ServerOptions {
  port?: number; appToken?: string; workerIntervalMs?: number; app?: App; makeApp?: () => App; startWorker?: boolean; sseCheckMs?: number;
  /** Google Maps list publisher browser (null = off; default = headless Chromium). */
  gmapsLauncher?: Parameters<typeof gmapsCycle>[1] | null;
  /** The browser for Setup → "Sign in to Google" (default = headless Chromium; tests inject a fake). */
  gmapsSigninBrowser?: (dir: string, viewport: { width: number; height: number }) => Promise<RemoteBrowser>;
  /** Google OAuth client id (GOOGLE_OAUTH_CLIENT_ID); tests inject a verifier instead of Google's keys. */
  googleClientId?: string; verifyIdToken?: (token: string) => Promise<GoogleIdentity>;
  publicUrl?: string;
  /** LOCAL DEMO ONLY (scripts/demo.ts): GET /auth/dev?t=<this> signs the browser in without Google. Never set from env. */
  devSessionToken?: string;
}

export function startServer(o: ServerOptions = {}) {
  // Never falls back to the Shortcut (intake) token: that one lives on phones, and this one can download the database.
  const appToken = o.appToken ?? process.env.APP_TOKEN;
  if (!appToken || appToken.length < 16) throw new Error('APP_TOKEN (a random secret of ≥16 characters, different from INBOX_TOKEN) is required');
  const cfg = o.app?.cfg ?? loadConfig();
  const makeApp = o.makeApp ?? (() => createApp(cfg, { log }));
  let app = o.app ?? makeApp();
  let accounts = new Accounts(app.store);
  { const n = repairPaths(app.store, app.cfg.dataDir); if (n) log(`startup: ${n} stored file path(s) moved to ${app.cfg.dataDir}`); }
  { const n = app.store.mergeSameListing(); if (n) log(`startup: ${n} duplicate pin(s) for the same Google listing merged`); }
  { const r = refineGenericCategories(app.store.db); if (r.length) log(`startup: category from the name for ${r.map((x) => `${x.name} → ${x.category}`).join(', ')}`); }
  /** Server-admin secret (backup/import/run). Since accounts exist it gives NO access to the website or pins. */
  const legacyIntakeToken = cfg.inboxToken;
  const clientId = o.googleClientId ?? process.env.GOOGLE_OAUTH_CLIENT_ID ?? '';
  const verify = o.verifyIdToken ?? ((t: string) => verifyGoogleIdToken(t, clientId));
  const page = (f: string) => fs.readFileSync(path.join(HERE, 'web', f), 'utf8');
  const mapHtml = page('map.html'), landingHtml = page('landing.html'), setupHtml = page('setup.html');
  const bin = (f: string) => fs.readFileSync(path.join(HERE, 'web', f));
  const png = (f: string) => ({ type: 'image/png', body: bin(f) });
  const ICONS: Record<string, { type: string; body: Buffer }> = {
    '/icon.svg': { type: 'image/svg+xml', body: bin('icon.svg') },
    '/apple-touch-icon.png': png('apple-touch-icon.png'), '/apple-touch-icon-precomposed.png': png('apple-touch-icon.png'),
    '/icon-192.png': png('icon-192.png'), '/icon-512.png': png('icon-512.png'), '/icon-maskable-512.png': png('icon-maskable-512.png'),
    '/favicon-32.png': png('favicon-32.png'), '/favicon.ico': png('favicon-32.png'),
  };
  const MANIFEST = {
    name: 'reelocations', short_name: 'reelocations', description: 'The places from the Reels you save, on one map.',
    id: '/', start_url: '/', scope: '/', display: 'standalone', background_color: '#f6f5f1', theme_color: '#2f7d57',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };

  const gmapsLaunch = () => o.gmapsLauncher ?? profileLauncher(findChrome(app.cfg.chromePath));
  // ---------------- worker: one cycle at a time; a share during a cycle schedules one more ----------------
  let running: Promise<void> | null = null; let again = false; let paused = false;
  const evidenceFor = (pid: string) => app.store.linksForPlace(pid).flatMap((l) => { const r = app.store.getReel(l.reel_key); const e = r?.evidence_json ? JSON.parse(r.evidence_json) : null; return [...(e?.texts ?? []).map((t: any) => String(t.text ?? '')), ...app.store.notesFor(l.reel_key)]; });
  const cycle = (why: string): Promise<void> => {
    if (paused) return Promise.resolve();
    if (process.env.WAIT_FOR_IMPORT === '1' && !app.store.getKv('imported_at')) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        const t0 = Date.now();
        try {
          const r = await runOnce(app, { skipSync: true, log });
          let g = '';
          if (app.resolve.google) { await recheckListings(app.store, app.resolve.google, log); const m = await matchStoredPlaces(app.store, app.resolve.google, { log }); const merged = app.store.mergeSameListing(); if (m.matched + m.review + m.none || merged) g = ` · google listings ${JSON.stringify({ ...m, merged })}`; }
          const refined = refineGenericCategories(app.store.db); if (refined.length) g += ` · category from name: ${refined.map((x) => `${x.name} → ${x.category}`).join(', ')}`;
          const types = backfillGoogleTypes(app.store), cuisines = backfillCuisines(app.store, evidenceFor);
          if (types || cuisines) g += ` · subtypes ${cuisines} (types ${types})`;
          if (!/^ok: 0 item/.test(r.pull) || r.process !== '0 processed {}' || g) log(`cycle (${why}) ${Date.now() - t0} ms · inbox ${r.pull} · ${r.process} · status ${r.status}${g}`);
        } catch (e) { log(`cycle (${why}) failed: ${(e as Error).stack ?? e}`); }
        // Google Maps lists (server-side publisher): a few verified listings per cycle, only when one is connected.
        if (process.env.GMAPS_LIST_SYNC !== 'off' && o.gmapsLauncher !== null) {
          try {
            const launch = gmapsLaunch();
            // Session check first (about hourly per destination): a session that works again continues saving in this same pass.
            await gmapsCheck(app.store, launch, { log, everyMin: Number(process.env.GMAPS_CHECK_MIN ?? 60) || 60 });
            const g = await gmapsCycle(app.store, launch, { log });
            if (g.saved + g.failed + g.skipped) log(`google maps list: ${g.saved} saved, ${g.failed} failed, ${g.skipped} need review`);
          } catch (e) { log(`google maps list failed: ${(e as Error).message}`); }
        }
        notify();
      } while (again && !paused);
    })().finally(() => { running = null; });
    return running;
  };
  const gmapsSignin = new GmapsSignin({
    store: () => app.store, dataDir: () => app.cfg.dataDir, log,
    open: o.gmapsSigninBrowser ?? remoteBrowser(() => findChrome(app.cfg.chromePath)),
    onConnected: () => { setTimeout(() => void cycle('gmaps signed in'), 10); },
  });
  const interval = o.workerIntervalMs ?? Number(process.env.WORKER_INTERVAL_SEC ?? 60) * 1000;
  const timer = o.startWorker === false ? null : setInterval(() => { void cycle('timer'); }, interval);
  if (o.startWorker !== false) setTimeout(() => void cycle('startup'), 1500);

  // ---------------- live updates (server-sent events), per collection ----------------
  const clients = new Map<http.ServerResponse, number>();
  const streamUser = new Map<http.ServerResponse, number>(); // signed-in streams: whose (publisher streams: none)
  const lastByCollection = new Map<number, string>();
  const send = (res: http.ServerResponse, v: string) => res.write(`event: version\ndata: ${JSON.stringify({ version: v })}\n\n`);
  const notify = () => {
    if (!clients.size) return;
    // Someone who left (or was removed, or deleted their account) stops getting updates at once.
    for (const [c, uid] of streamUser) { const cid = clients.get(c); if (cid != null && !accounts.role(uid, cid)) { clients.delete(c); streamUser.delete(c); c.end(); } }
    for (const cid of new Set(clients.values())) {
      let v: string; try { v = app.store.collectionVersion(cid); } catch { continue; }
      if (lastByCollection.get(cid) === v) continue;
      lastByCollection.set(cid, v);
      for (const [c, id] of clients) if (id === cid) send(c, v);
    }
  };
  const sseTimer = setInterval(notify, o.sseCheckMs ?? 1000);
  const pingTimer = setInterval(() => { for (const c of clients.keys()) c.write(`: ping ${Date.now()}\n\n`); }, 20_000);
  const openStream = (req: http.IncomingMessage, res: http.ServerResponse, cid: number, userId?: number) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    send(res, app.store.collectionVersion(cid));
    clients.set(res, cid);
    if (userId != null) streamUser.set(res, userId);
    req.on('close', () => { clients.delete(res); streamUser.delete(res); });
  };

  // ---------------- helpers ----------------
  const readBody = async (req: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> => {
    const chunks: Buffer[] = []; let n = 0;
    for await (const c of req) { n += (c as Buffer).length; if (n > limit) throw httpError(413, 'body too large'); chunks.push(c as Buffer); }
    return Buffer.concat(chunks);
  };
  const readJson = async (req: http.IncomingMessage, limit?: number): Promise<any> => { try { return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}'); } catch (e) { if ((e as any).status) throw e; throw httpError(400, 'invalid JSON'); } };
  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body));
  };
  const html = (res: http.ServerResponse, body: string, headers: Record<string, string> = {}) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers }); res.end(body); };
  const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const cookie = (req: http.IncomingMessage, name: string) => { const c = (req.headers.cookie ?? '').split(/;\s*/).find((x) => x.startsWith(`${name}=`)); return c ? decodeURIComponent(c.slice(name.length + 1)) : undefined; };
  const bearer = (req: http.IncomingMessage) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined;
  const isAdmin = (req: http.IncomingMessage) => { const t = req.headers['x-token'] as string | undefined; return !!t && safeEq(t, appToken); };
  const keyFor = (parts: string[]) => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  const publicUrl = (req: http.IncomingMessage) => o.publicUrl ?? process.env.PUBLIC_URL ?? `${(req.headers['x-forwarded-proto'] as string) ?? 'http'}://${req.headers.host}`;
  const sessionCookie = (token: string) => `rm_s=${encodeURIComponent(token)}; Path=/; Max-Age=${180 * 86400}; HttpOnly; Secure; SameSite=Lax`;

  /** Signed-in user + the collection this request is about (?c= or the session's active one), membership-checked. */
  const auth = (req: http.IncomingMessage, u: URL) => {
    const s = accounts.session(cookie(req, 'rm_s'));
    if (!s) return null;
    const asked = u.searchParams.get('c');
    const cid = asked ? Number(asked) : s.collectionId;
    if (cid != null && !accounts.role(s.user.id, cid)) throw httpError(403, 'not a member of this collection');
    return { ...s, cid };
  };
  const needAuth = (req: http.IncomingMessage, u: URL) => { const a = auth(req, u); if (!a) throw httpError(401, 'sign in first'); if (a.cid == null) throw httpError(409, 'no collection yet'); return a as typeof a & { cid: number }; };

  // ---------------- intake (Shortcuts) ----------------
  /** Same contract as the Apps Script inbox (apps-script/Code.gs), so the Shortcut only needs a new URL. */
  const intake = async (body: any, pathToken?: string): Promise<any> => {
    const presented = pathToken ?? (typeof body?.token === 'string' ? body.token : undefined);
    let ctx: IntakeContext | null = null;
    const cred = accounts.credential(presented, 'intake');
    if (cred) ctx = { collectionId: cred.collectionId, userId: cred.userId };
    else if (presented && legacyIntakeToken && safeEq(presented, legacyIntakeToken)) ctx = { collectionId: 1, userId: accounts.collection(1)?.owner_user_id ?? null };
    if (!ctx) return { ok: false, error: 'bad token', message: 'Not saved: this Shortcut is not connected (open reelocations → Setup to reconnect it)' };
    const now = nowIso();
    if (body.action === 'share' || (!body.action && body.text)) {
      const text = String(body.text ?? '').slice(0, 5000);
      if (!text) return { ok: false, error: 'empty share', message: 'Not saved: empty share' };
      const sharedAt = String(body.shared_at || now);
      const id = `s_${keyFor([text, sharedAt, String(ctx.collectionId), String(ctx.userId ?? '')])}`;
      const r = applyItem(app.store, { id, row: 0, kind: 'share', received_at: now, shared_at: sharedAt, text, note: String(body.note ?? '').slice(0, 2000), input_types: String(body.input_types ?? '') }, ctx);
      void cycle('share');
      return { ok: true, id, duplicate: r.action === 'duplicate_delivery', message: 'Saved. The pin appears on your map in a minute.' };
    }
    if (body.action === 'media' && body.data) {
      const bytes = Buffer.from(String(body.data), 'base64');
      if (bytes.length > 30 * 1024 * 1024) return { ok: false, error: 'file too large (max 30 MB)', message: 'Not saved: file too large (max 30 MB)' };
      const id = `m_${keyFor([String(body.filename ?? ''), String(bytes.length), String(body.shared_at ?? ''), String(body.reel_url ?? ''), String(ctx.collectionId)])}`;
      const mime = sniffMime(bytes) ?? String(body.mime || 'application/octet-stream');
      const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') ? 'jpg' : mime.includes('heic') ? 'heic' : mime.includes('quicktime') ? 'mov' : mime.includes('mp4') ? 'mp4' : 'bin';
      const file = path.join(app.cfg.dataDir, 'media', `${id}.${ext}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
      const r = applyItem(app.store, { id, row: 0, kind: 'media', received_at: now, shared_at: String(body.shared_at || now), note: body.note ? String(body.note) : undefined, reel_url: body.reel_url ? String(body.reel_url) : undefined, media_ref: `local:${id}`, mime, filename: String(body.filename ?? '') }, ctx);
      const m = app.store.db.prepare('SELECT status FROM media WHERE media_id=?').get(id) as any;
      if (m && m.status !== 'processed') app.store.updateMedia(id, { status: 'downloaded', local_path: file, error: null, mime, kind: mediaKind(mime, String(body.filename ?? '')) });
      void cycle('media');
      return { ok: true, id, duplicate: r.action === 'duplicate_delivery', message: 'Attached.' };
    }
    return { ok: false, error: 'unknown action', message: 'Not saved: unknown action' };
  };

  // ---------------- one-time migration (admin) ----------------
  const importData = async (body: any) => {
    const has = (app.store.db.prepare('SELECT COUNT(*) n FROM reels').get() as any).n;
    if (has && body.replace !== true) return { status: 409, body: { ok: false, error: `server already has ${has} Reel(s); pass replace:true to overwrite` } };
    paused = true;
    try {
      if (running) await running;
      const dataDir = app.cfg.dataDir; const dbPath = app.cfg.dbPath;
      await app.close();
      for (const f of body.files ?? []) {
        const rel = String(f.rel).replace(/\\/g, '/');
        const dest = path.resolve(dataDir, rel);
        if (!dest.startsWith(path.resolve(dataDir) + path.sep)) throw new Error(`bad path ${rel}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(String(f.data), 'base64'));
      }
      for (const suf of ['', '-wal', '-shm']) fs.rmSync(dbPath + suf, { force: true });
      fs.writeFileSync(dbPath, Buffer.from(String(body.db), 'base64'));
      app = makeApp(); accounts = new Accounts(app.store);
      const src = String(body.src_data_dir ?? '').replace(/\\/g, '/').replace(/\/$/, '');
      const fix = (p: string | null) => { if (!p || !src) return p; const n = p.replace(/\\/g, '/'); return n.toLowerCase().startsWith(src.toLowerCase() + '/') ? path.join(dataDir, n.slice(src.length + 1)) : p; };
      let fixed = 0;
      for (const [table, col, key] of [['media', 'local_path', 'media_id'], ['reel_places', 'image_path', 'rowid']] as const) {
        for (const r of app.store.db.prepare(`SELECT ${key} k, ${col} v FROM ${table} WHERE ${col} IS NOT NULL`).all() as any[]) {
          const v = fix(r.v); if (v !== r.v) { app.store.db.prepare(`UPDATE ${table} SET ${col}=? WHERE ${key}=?`).run(v, r.k); fixed++; }
        }
      }
      fixed += repairPaths(app.store, dataDir);
      app.store.setKv('imported_at', nowIso());
      const counts = app.store.counts();
      log(`import: ${JSON.stringify(counts)}, ${body.files?.length ?? 0} file(s), ${fixed} path(s) rewritten`);
      return { status: 200, body: { ok: true, counts, files: body.files?.length ?? 0, paths_rewritten: fixed } };
    } finally { paused = false; setTimeout(() => void cycle('after import'), 500); }
  };

  const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.webp': 'image/webp' };
  const setupState = (a: { user: any; cid: number }) => {
    const col = accounts.collection(a.cid)!;
    const intakeCreds = accounts.credentialsOf(a.user.id).filter((c) => c.kind === 'intake' && c.collection_id === a.cid && !c.revoked_at);
    const st = collectionSyncStatus(app.store, a.cid);
    return {
      user: { id: a.user.id, email: a.user.email, name: a.user.name, picture: a.user.picture },
      collection: { id: col.id, name: col.name, role: accounts.role(a.user.id, a.cid) },
      collections: accounts.collectionsOf(a.user.id).map((c) => ({ id: c.id, name: c.name, role: c.role })),
      members: accounts.members(a.cid),
      intake: { connected: intakeCreds.length > 0, credentials: intakeCreds },
      publisher: { destinations: st.destinations.map((d) => ({ id: d.id, owner: d.owner, user_id: d.user_id, label: d.label, online: d.online, last_seen_at: d.last_seen_at, status: d.status })) },
      legacy_collection: a.cid === 1,
    };
  };

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const p = u.pathname;
    try {
      // ---------- public ----------
      if (p === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'POST' && (p === '/api/intake' || p === '/exec' || p.startsWith('/api/intake/'))) {
        return json(res, 200, await intake(await readJson(req), p.startsWith('/api/intake/') ? decodeURIComponent(p.slice('/api/intake/'.length)) : undefined));
      }
      if (req.method === 'POST' && p === '/api/pair') {
        // A Shortcut (or anything on the phone) trades a one-time code from the website for a revocable intake credential.
        const b = await readJson(req);
        const r = accounts.redeemPairingCode(String(b.code ?? ''), 'intake', String(b.label ?? 'iPhone Shortcut'));
        return json(res, 200, { ok: true, token: r.token, intake_url: `${publicUrl(req)}/api/intake/${encodeURIComponent(r.token)}`, message: 'Connected. Shares from this Shortcut now go to your reelocations collection.' });
      }
      if (req.method === 'GET' && p === '/auth/dev' && o.devSessionToken) {
        if (!safeEq(u.searchParams.get('t') ?? '', o.devSessionToken)) throw httpError(403, 'wrong demo link');
        res.writeHead(303, { Location: '/', 'Set-Cookie': `rm_s=${encodeURIComponent(o.devSessionToken)}; Path=/; HttpOnly; SameSite=Lax` }); res.end(); return;
      }
      if (req.method === 'GET' && p === '/auth/config') return json(res, 200, { client_id: clientId || null });
      if (req.method === 'POST' && p === '/auth/google') {
        if (!clientId && !o.verifyIdToken) throw httpError(503, 'Google Sign-In is not configured yet (GOOGLE_OAUTH_CLIENT_ID)');
        const b = await readJson(req);
        const id = await verify(String(b.credential ?? '')).catch((e) => { throw httpError(401, `Google sign-in could not be verified: ${(e as Error).message}`); });
        if (!id.email_verified) throw httpError(401, 'this Google account has no verified email');
        const user = accounts.upsertUser(id);
        let active: number | null = null; let isNew = false; const notes: string[] = [];
        if (b.claim && accounts.claimLegacy(user.id, String(b.claim), appToken)) { active = 1; notes.push('claimed'); }
        if (b.invite) { active = accounts.acceptInvitation(user.id, String(b.invite)); notes.push('joined'); }
        if (active == null) active = accounts.collectionsOf(user.id)[0]?.id ?? null;
        if (active == null) { active = accounts.createCollection(user.id, `${(id.name ?? id.email ?? 'My').split(' ')[0]}'s Reels`).id; isNew = true; }
        const token = accounts.createSession(user.id, active);
        const needsSetup = isNew || notes.includes('joined') || !accounts.credentialsOf(user.id).some((c) => c.kind === 'intake' && c.collection_id === active && !c.revoked_at) && active !== 1;
        log(`sign-in: user ${user.id}${notes.length ? ` (${notes.join(', ')})` : ''}${isNew ? ' (new account)' : ''}`);
        return json(res, 200, { ok: true, next: needsSetup ? '/setup' : '/', collection: active }, { 'Set-Cookie': sessionCookie(token) });
      }
      if (req.method === 'POST' && p === '/auth/signout') {
        const s = accounts.session(cookie(req, 'rm_s')); if (s) accounts.endSession(s.tokenHash);
        return json(res, 200, { ok: true }, { 'Set-Cookie': 'rm_s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
      }

      // ---------- publisher (desktop worker; its own revocable credential) ----------
      if (req.method === 'POST' && p === '/api/publisher/pair') {
        const b = await readJson(req);
        const r = accounts.redeemPairingCode(String(b.code ?? ''), 'publisher', String(b.label ?? 'Desktop publisher'));
        const dest = connectDestination(app.store, { collectionId: r.collectionId, userId: r.userId, credentialId: r.credentialId, label: String(b.label ?? 'Desktop publisher') });
        log(`publisher connected: destination ${dest} (collection ${r.collectionId}, user ${r.userId})`);
        return json(res, 200, { ok: true, token: r.token, destination_id: dest, collection_id: r.collectionId });
      }
      if (p.startsWith('/api/publisher/')) {
        const cred = accounts.credential(bearer(req), 'publisher');
        const dest = cred ? destinationForCredential(app.store, cred.id) : null;
        if (!cred || !dest) throw httpError(401, 'publisher not connected (revoked or unknown) — connect it again from Setup');
        if (req.method === 'GET' && p === '/api/publisher/export') { app.store.db.prepare('UPDATE destinations SET last_seen_at=? WHERE id=?').run(nowIso(), dest.id); return json(res, 200, buildExport(app.store, dest.id)); }
        if (req.method === 'POST' && p === '/api/publisher/report') { const b = await readJson(req); if (b.mode === 'real') recordReport(app.store, dest.id, Array.isArray(b.maps) ? b.maps : []); else app.store.db.prepare('UPDATE destinations SET last_seen_at=? WHERE id=?').run(nowIso(), dest.id); setTimeout(notify, 10); return json(res, 200, { ok: true }); }
        if (req.method === 'GET' && p === '/api/publisher/events') { app.store.db.prepare('UPDATE destinations SET last_seen_at=? WHERE id=?').run(nowIso(), dest.id); return openStream(req, res, dest.collection_id); }
        throw httpError(404, 'not found');
      }

      // ---------- admin (server secret; never used by the website) ----------
      if (p.startsWith('/api/admin/') || p === '/api/run' || p === '/api/status') {
        if (!isAdmin(req)) throw httpError(401, 'admin token required');
        if (req.method === 'POST' && p === '/api/run') { await cycle('api'); return json(res, 200, { ok: true, counts: app.store.counts() }); }
        if (req.method === 'POST' && p === '/api/admin/import') { const r = await importData(await readJson(req, 200 * 1024 * 1024)); return json(res, r.status, r.body); }
        if (req.method === 'POST' && p === '/api/admin/gmaps-retry') {
          // Clear "needs sign-in" without a new session (e.g. after a false alarm); the next cycle tries again.
          const b = await readJson(req); ensureGmapsTables(app.store);
          const r = app.store.db.prepare("UPDATE gmaps_destinations SET status='connected', detail=NULL WHERE collection_id=? AND disconnected_at IS NULL AND status IN ('needs_signin','error')").run(Number(b.collection ?? 1));
          // Failed items wait out their back-off unless the operator asks for a retry now.
          // items_now: failed items skip their back-off; branch-check skips are checked again (after a rule fix).
          const items = b.items_now ? Number(app.store.db.prepare("UPDATE gmaps_saves SET status=CASE WHEN status='skipped' THEN 'pending' ELSE status END, attempts=0, next_try_at=NULL WHERE status IN ('failed','skipped') AND destination_id IN (SELECT id FROM gmaps_destinations WHERE collection_id=?)").run(Number(b.collection ?? 1)).changes) : 0;
          if (b.run !== false) setTimeout(() => void cycle('gmaps retry'), 10);
          return json(res, 200, { ok: true, reset: Number(r.changes), items_now: items });
        }
        if (req.method === 'POST' && p === '/api/admin/gmaps-probe') {
          // Operator check from the server itself: open one listing by Place ID with the collection's session (or none).
          const b = await readJson(req); ensureGmapsTables(app.store);
          const d = b.collection ? app.store.db.prepare('SELECT id, state_file FROM gmaps_destinations WHERE collection_id=? AND disconnected_at IS NULL').get(Number(b.collection)) as any : null;
          const probe = async (page: any) => {
            const card = await openListing(page, { googlePlaceId: String(b.place_id), name: String(b.name ?? ''), address: b.address ?? null });
            return json(res, 200, { card, session: d ? 'collection session' : 'signed out', state: await readSaveState(page), diagnostics: b.diagnostics ? await sessionDiagnostics(page) : undefined, menu: b.menu ? await probeListMenu(page) : undefined, newlist: b.newlist ? await probeNewList(page) : undefined });
          };
          if (d) {
            // The destination's own browser profile, one user at a time (the save cycle waits for the next pass).
            const release = await waitLock(lockKey(d.id), 90_000);
            if (!release) throw httpError(409, 'the session is in use (a save, a check or a sign-in) — try again in a minute');
            let br: Awaited<ReturnType<ReturnType<typeof gmapsLaunch>>> | undefined;
            try { br = await gmapsLaunch()(d.state_file); return await probe(br.page); } finally { await br?.close().catch(() => {}); release(); }
          }
          const { chromium } = await import('playwright-core');
          const browser = await chromium.launch({ executablePath: findChrome(app.cfg.chromePath), headless: true, args: ['--no-sandbox'] });
          try { return await probe(await (await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } })).newPage()); } finally { await browser.close(); }
        }
        if (req.method === 'GET' && p === '/api/admin/backup') {
          const tmp = path.join(app.cfg.dataDir, `backup-${Date.now()}.sqlite`);
          app.store.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
          const buf = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true });
          res.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': 'attachment; filename="reel-maps.sqlite"' }); res.end(buf); return;
        }
        if (req.method === 'GET' && p === '/api/status') return json(res, 200, { memory_mb: Math.round(process.memoryUsage().rss / 1e6), uptime_s: Math.round(process.uptime()), counts: app.store.counts(), events: app.store.recentEvents(20), budget: app.budget.report() });
        throw httpError(404, 'not found');
      }

      // ---------- app icons + install metadata (public; the name and icon a Home Screen install picks up) ----------
      if (req.method === 'GET' && ICONS[p]) { res.writeHead(200, { 'Content-Type': ICONS[p]!.type, 'Cache-Control': 'public, max-age=86400' }); res.end(ICONS[p]!.body); return; }
      if (req.method === 'GET' && p === '/manifest.webmanifest') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
        res.end(JSON.stringify(MANIFEST)); return;
      }

      // ---------- pages ----------
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const a = auth(req, u);
        if (!a || a.cid == null) return html(res, landingHtml);
        return html(res, mapHtml);
      }
      if (req.method === 'GET' && (p === '/signin' || p === '/signup' || p.startsWith('/join/'))) return html(res, landingHtml);
      if (req.method === 'GET' && p === '/setup') { if (!auth(req, u)) { res.writeHead(303, { Location: '/signin' }); res.end(); return; } return html(res, setupHtml); }

      // ---------- signed-in API ----------
      if (req.method === 'GET' && p === '/api/me') { const a = auth(req, u); if (!a) return json(res, 200, { signed_in: false, google_client_id: clientId || null }); if (a.cid == null) return json(res, 200, { signed_in: true, user: a.user, collections: [] }); return json(res, 200, { signed_in: true, ...setupState(a as any) }); }
      if (req.method === 'POST' && p === '/api/session/collection') { const s = accounts.session(cookie(req, 'rm_s')); if (!s) throw httpError(401, 'sign in first'); const b = await readJson(req); accounts.setSessionCollection(s.tokenHash, s.user.id, Number(b.id)); return json(res, 200, { ok: true }); }
      if (req.method === 'GET' && p === '/api/places') {
        const a = needAuth(req, u);
        const d = { ...buildMapData(app.store, a.cid, { userId: a.user.id, accounts }), billing: accounts.isBillingAdmin(a.user.id) };
        const etag = `"${crypto.createHash('sha1').update(`${a.user.id}|${a.cid}|${d.version}|${JSON.stringify(d.sync.countries)}|${d.country_order.join(',')}|${app.store.userStateVersion(a.user.id, a.cid)}|${d.review_count}`).digest('hex').slice(0, 16)}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); res.end(); return; }
        return json(res, 200, d, { ETag: etag, 'Cache-Control': 'no-cache' });
      }
      if (req.method === 'GET' && p === '/api/events') { const a = needAuth(req, u); return openStream(req, res, a.cid, a.user.id); }
      if (req.method === 'GET' && p === '/img') {
        const a = needAuth(req, u);
        const r = u.searchParams.get('r') ?? '';
        if (!app.store.getReel(r) || app.store.collectionOf(r) !== a.cid) throw httpError(404, 'not found');
        const f = imageFileFor(app.store, r, u.searchParams.get('p') ?? '');
        const abs = f ? path.resolve(f) : '';
        if (!abs || !abs.startsWith(path.resolve(app.cfg.dataDir) + path.sep) || !fs.existsSync(abs)) throw httpError(404, 'not found');
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' });
        fs.createReadStream(abs).pipe(res); return;
      }
      const placeRoute = p.match(/^\/api\/places\/([^/]+)(\/cuisine|\/star|\/seen)?$/);
      if (placeRoute && (placeRoute[2] === '/star' || placeRoute[2] === '/seen') && (req.method === 'PUT' || req.method === 'POST')) {
        // Personal state: only this signed-in user's stars / opened places change; other members are unaffected.
        const a = needAuth(req, u);
        const pid = decodeURIComponent(placeRoute[1]!);
        if (!app.store.linksForPlaceIn(a.cid, pid).length) throw httpError(404, 'that place is not in this collection');
        if (placeRoute[2] === '/star') { const b = await readJson(req); app.store.setStar(a.user.id, a.cid, pid, b.starred !== false); return json(res, 200, { ok: true, starred: b.starred !== false }); }
        app.store.markSeen(a.user.id, a.cid, pid);
        return json(res, 200, { ok: true });
      }
      if (placeRoute && req.method === 'DELETE' && !placeRoute[2]) {
        const a = needAuth(req, u);
        const pid = decodeURIComponent(placeRoute[1]!);
        if (!app.store.linksForPlaceIn(a.cid, pid).length) throw httpError(404, 'that place is not in this collection');
        if (!accounts.canDeletePlace(a.user.id, a.cid, pid)) throw httpError(403, 'only the collection owner or the member who added it can delete this pin');
        const r = app.store.deletePlaceFromCollection(a.cid, pid, a.user.id);
        setTimeout(notify, 10);
        return json(res, 200, { ok: true, ...r });
      }
      if (placeRoute && req.method === 'PUT' && placeRoute[2] === '/cuisine') {
        const a = needAuth(req, u);
        const pid = decodeURIComponent(placeRoute[1]!);
        if (!app.store.linksForPlaceIn(a.cid, pid).length) throw httpError(404, 'that place is not in this collection');
        const b = await readJson(req);
        if (b.cuisine !== null && !isCuisine(b.cuisine)) throw httpError(400, 'unknown subtype');
        if (app.store.getPlace(pid)?.category !== 'restaurant') throw httpError(400, 'only restaurants have a subtype');
        // Stored for THIS collection only (a place row can be shared with other collections).
        app.store.setCollectionCuisine(a.cid, pid, b.cuisine, a.user.id);
        setTimeout(notify, 10);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/ai-usage' || p === '/api/ai-balance') {
        const a = needAuth(req, u);
        if (!accounts.isBillingAdmin(a.user.id)) throw httpError(403, 'only the account that runs this reelocations installation can see AI billing');
        if (req.method === 'PUT' && p === '/api/ai-balance') { const b = await readJson(req); setBalance(app.store, b.usd == null || b.usd === '' ? null : Number(b.usd), a.user.id); }
        else if (req.method !== 'GET') throw httpError(405, 'method not allowed');
        return json(res, 200, { model: app.cfg.openaiModel, enabled: !!app.cfg.openaiKey, ...allowanceFromStore(app.store, { model: app.cfg.openaiModel, monthlyCapUsd: app.cfg.openaiMonthlyBudgetUsd, dailyCallCap: app.cfg.openaiDailyCalls }) });
      }
      if (req.method === 'PUT' && p === '/api/country-order') { const a = needAuth(req, u); const b = await readJson(req); setCountryOrder(app.store, a.user.id, a.cid, Array.isArray(b.order) ? b.order.map(String) : null); return json(res, 200, { ok: true }); }
      if (req.method === 'GET' && p === '/api/sync-status') { const a = needAuth(req, u); return json(res, 200, collectionSyncStatus(app.store, a.cid)); }
      if (req.method === 'POST' && p === '/api/pairing-codes') {
        const a = needAuth(req, u); const b = await readJson(req);
        const kind = b.kind === 'publisher' ? 'publisher' : 'intake';
        return json(res, 200, { ok: true, kind, ...accounts.createPairingCode(a.user.id, a.cid, kind) });
      }
      if (req.method === 'POST' && p === '/api/intake-link') {
        // For setting up the Shortcut on the iPhone that is signed in right now: no code to type, just copy the URL.
        const a = needAuth(req, u); const b = await readJson(req);
        const r = accounts.issueCredential(a.user.id, a.cid, 'intake', String(b.label ?? 'iPhone Shortcut'));
        return json(res, 200, { ok: true, intake_url: `${publicUrl(req)}/api/intake/${encodeURIComponent(r.token)}`, credential_id: r.credentialId });
      }
      if (req.method === 'GET' && p === '/api/credentials') { const a = needAuth(req, u); return json(res, 200, accounts.credentialsOf(a.user.id)); }
      const credRoute = p.match(/^\/api\/credentials\/(\d+)$/);
      if (credRoute && req.method === 'DELETE') { const a = needAuth(req, u); accounts.revokeCredential(a.user.id, Number(credRoute[1])); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && p === '/api/invitations') { const a = needAuth(req, u); const code = accounts.createInvitation(a.user.id, a.cid); return json(res, 200, { ok: true, code, url: `${publicUrl(req)}/join/${code}` }); }
      if (req.method === 'GET' && p === '/api/members') { const a = needAuth(req, u); return json(res, 200, accounts.members(a.cid)); }
      const memberRoute = p.match(/^\/api\/members\/(\d+)$/);
      // ---------- Google Maps list (server-side publisher) ----------
      if (req.method === 'POST' && p === '/api/gmaps/code') { const a = needAuth(req, u); return json(res, 200, { ok: true, ...accounts.createPairingCode(a.user.id, a.cid, 'gmaps', 30) }); }
      if (req.method === 'POST' && p === '/api/gmaps/session') {
        // From `npm run cli -- gmaps-connect`: a one-time code from Setup + the browser session it just signed in.
        const b = await readJson(req, 5 * 1024 * 1024);
        const r = accounts.redeemPairingCode(String(b.code ?? ''), 'gmaps', 'Google Maps list');
        const id = connectGmaps(app.store, app.cfg.dataDir, { collectionId: r.collectionId, userId: r.userId, state: b.state, listName: b.list_name ? String(b.list_name) : undefined });
        log(`google maps list connected: destination ${id} (collection ${r.collectionId})`); // never the session itself
        setTimeout(() => void cycle('gmaps connected'), 10);
        return json(res, 200, { ok: true, destination_id: id });
      }
      // Sign in to Google in the server's own browser, from this device (an iPhone is enough). Only the person who
      // started it sees the page or can type into it; nothing typed is stored or logged.
      if (p.startsWith('/api/gmaps/signin/')) {
        const a = needAuth(req, u); const what = p.slice('/api/gmaps/signin/'.length);
        if (req.method === 'POST' && what === 'start') return json(res, 200, { ok: true, ...(await gmapsSignin.start(a.cid, a.user.id)) });
        if (req.method === 'GET' && what === 'state') return json(res, 200, await gmapsSignin.state(a.cid, a.user.id));
        if (req.method === 'GET' && what === 'screen') { const img = await gmapsSignin.screen(a.cid, a.user.id); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); res.end(img); return; }
        if (req.method === 'POST' && what === 'input') { await gmapsSignin.input(a.cid, a.user.id, await readJson(req, 4096)); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && what === 'cancel') { await gmapsSignin.cancel(a.cid, a.user.id); return json(res, 200, { ok: true }); }
        throw httpError(404, 'not found');
      }
      if (req.method === 'GET' && p === '/api/gmaps/status') { const a = needAuth(req, u); return json(res, 200, gmapsStatus(app.store, a.cid)); }
      if (req.method === 'DELETE' && p === '/api/gmaps') { const a = needAuth(req, u); disconnectGmaps(app.store, a.cid); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && p === '/api/collection/leave') {
        const a = needAuth(req, u);
        accounts.leaveCollection(a.user.id, a.cid);
        log(`user ${a.user.id} left collection ${a.cid}`);
        return json(res, 200, { ok: true, next: '/' });
      }
      if (req.method === 'DELETE' && p === '/api/account') {
        const s0 = accounts.session(cookie(req, 'rm_s')); if (!s0) throw httpError(401, 'sign in first');
        const b = await readJson(req);
        if (String(b.confirm ?? '') !== 'DELETE') throw httpError(400, 'type DELETE to confirm');
        const r = accounts.deleteAccount(s0.user.id);
        log(`account ${s0.user.id} deleted`);
        return json(res, 200, { ok: true, ...r }, { 'Set-Cookie': 'rm_s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
      }
      if (memberRoute && req.method === 'DELETE') { const a = needAuth(req, u); accounts.removeMember(a.user.id, a.cid, Number(memberRoute[1])); return json(res, 200, { ok: true }); }
      const destRoute = p.match(/^\/api\/destinations\/(\d+)$/);
      if (destRoute && req.method === 'DELETE') {
        const a = needAuth(req, u);
        const d = app.store.db.prepare('SELECT * FROM destinations WHERE id=? AND collection_id=?').get(Number(destRoute[1]), a.cid) as any;
        if (!d) throw httpError(404, 'not found');
        if (d.user_id !== a.user.id && accounts.role(a.user.id, a.cid) !== 'owner') throw httpError(403, 'only its owner or the collection owner can disconnect this map');
        disconnectDestination(app.store, d.id);
        return json(res, 200, { ok: true });
      }
      if (p === '/review' || p.startsWith('/review/')) {
        const a = auth(req, u);
        if (!a || a.cid == null) { res.writeHead(303, { Location: '/signin' }); res.end(); return; }
        if (await handleReview(app, req, res, { base: '/review', collectionId: a.cid, userId: a.user.id, canDelete: (pid) => accounts.canDeletePlace(a.user.id, a.cid!, pid), onRun: () => cycle('review: run'), onChange: () => setTimeout(notify, 10) })) return;
      }
      throw httpError(404, 'not found');
    } catch (e) {
      const status = (e as any).status ?? 500;
      if (status >= 500) log(`${req.method} ${p} failed: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) json(res, status, { ok: false, error: (e as Error).message });
      else res.end();
    }
  });
  srv.keepAliveTimeout = 65_000;
  const port = o.port ?? Number(process.env.PORT ?? 8080);
  srv.listen(port, '0.0.0.0');
  const close = async () => {
    if (timer) clearInterval(timer); clearInterval(sseTimer); clearInterval(pingTimer);
    for (const c of clients.keys()) c.end();
    paused = true; if (running) await running.catch(() => {});
    await gmapsSignin.close().catch(() => {});
    await new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); });
    await app.close();
  };
  return { server: srv, close, cycle, get app() { return app; }, get accounts() { return accounts; } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = startServer();
  log(`reelocations listening on :${process.env.PORT ?? 8080} (data: ${s.app.cfg.dataDir})`);
  const stop = async (sig: string) => { log(`${sig}: closing (database checkpoint)`); await s.close().catch(() => {}); process.exit(0); };
  process.on('SIGTERM', () => void stop('SIGTERM')); process.on('SIGINT', () => void stop('SIGINT'));
}
