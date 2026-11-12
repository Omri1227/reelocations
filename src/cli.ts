#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadConfig, ROOT } from './config.ts';
import { createApp, withLock, type App } from './app.ts';
import { pullInbox, applyItem, mediaKind } from './intake/inbox.ts';
import { runOnce } from './worker.ts';
import { syncToMap } from './sync/sync.ts';
import { syncGrouped } from './sync/grouped.ts';
import { processDue } from './pipeline.ts';
import { MyMapsBrowserSink, findChrome, openLoginWindow } from './sync/mymaps.ts';
import { verifyGoogle, writeVerifyFixture } from './sync/verify.ts';
import { buildSnapshot } from './sync/kml.ts';
import { startReviewServer } from './review/server.ts';
import { addNote, chooseCandidate, markApproximate, notAPlace, searchCandidates } from './review/actions.ts';
import { displayDate, parseShare } from './intake/parse.ts';
import { nowIso } from './db.ts';
import { ffmpegPath } from './media/ffmpeg.ts';
import { mirrorFromHosted } from './remoteMirror.ts';
import { publishOnce, publishWatch } from './publisher.ts';
import { planGroups } from './sync/grouped.ts';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1]!.startsWith('--') && ['note', 'shared-at', 'file', 'only', 'minutes', 'list'].includes(all[i - 1]!.slice(2))));

const log = (m: string) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

function makeSink(app: App): MyMapsBrowserSink | null {
  const { cfg } = app;
  // --test-map: rehearse the real data against MYMAPS_TEST_MAP_ID (the disposable map) instead of the real map.
  const mapId = flag('test-map') ? cfg.mymapsTestMapId : cfg.mymapsMapId;
  if (flag('test-map') && !mapId) throw new Error('--test-map needs MYMAPS_TEST_MAP_ID in .env');
  if (!mapId) return null;
  return browserSink(app, mapId);
}

function browserSink(app: App, mapId: string): MyMapsBrowserSink {
  const { cfg } = app;
  return new MyMapsBrowserSink({ mapId, layerName: cfg.mymapsLayerName, profileDir: cfg.chromeProfileDir, chromePath: findChrome(cfg.chromePath), debugDir: path.join(cfg.dataDir, 'sync', 'screens'), assist: flag('assist'), headless: flag('headless') });
}

/**
 * Where a sync goes. Country grouping (default): --test-map → "TEST Reels · <country>" maps; otherwise the real
 * "Reels · <country>" maps, but only once MYMAPS_REAL_SYNC=true. Single mode: the legacy one-layer map.
 */
function syncTarget(app: App): { sink: MyMapsBrowserSink; grouped?: { mode: 'real' | 'test'; titlePrefix: string; layout: 'one-map' | 'per-country'; mapTitle: string } } | { off: string } {
  const { cfg } = app;
  if (cfg.mymapsGrouping === 'single') { const s = makeSink(app); return s ? { sink: s } : { off: 'MYMAPS_MAP_ID not set — use "export" and import the KML by hand' }; }
  if (flag('test-map')) return { sink: browserSink(app, ''), grouped: { mode: 'test', titlePrefix: `TEST ${cfg.mymapsTitlePrefix}`, layout: cfg.mymapsLayout, mapTitle: `TEST ${cfg.mymapsMapTitle}` } };
  if (!cfg.mymapsRealSync) return { off: 'real maps are off (MYMAPS_REAL_SYNC=false): rehearse with --test-map, then set MYMAPS_REAL_SYNC=true in .env' };
  return { sink: browserSink(app, ''), grouped: { mode: 'real', titlePrefix: cfg.mymapsTitlePrefix, layout: cfg.mymapsLayout, mapTitle: cfg.mymapsMapTitle } };
}

async function cycle(app: App, skipSync: boolean): Promise<void> {
  const t = skipSync ? null : syncTarget(app);
  const sink = t && 'sink' in t ? t.sink : null;
  try {
    const r = await runOnce(app, { sink, grouped: t && 'grouped' in t ? t.grouped : undefined, skipSync, force: flag('force') || flag('assist'), allowRemoval: flag('allow-removal'), log });
    if (t && 'off' in t) log(`sync: ${t.off}`);
    log(`inbox: ${r.pull}`); log(`media: ${r.media}`); log(`process: ${r.process}`); log(`status: ${r.status}`); log(`sync: ${r.sync}`);
  } finally { await sink?.close(); }
}

function printStatus(app: App) {
  const s = app.store;
  console.log(JSON.stringify(s.counts()));
  for (const r of s.listReels()) {
    const links = s.linksForReel(r.reel_key) as any[];
    console.log(`\n${r.status.padEnd(12)} ${displayDate(r.first_shared_at)}  ${r.url ?? r.reel_key}`);
    if (r.status_reason) console.log(`             ${r.status_reason}`);
    for (const l of links) console.log(`             → ${l.confidence === 'approximate' ? '≈ ' : ''}${l.name} [${l.category}${l.kind === 'route' ? ', route' : ''}] ${l.cue ?? ''}`);
    s.candidatesFor(r.reel_key).slice(0, 5).forEach((c, i) => console.log(`             ? #${i} ${c.name} — ${c.displayName.slice(0, 70)} (score ${c.score})`));
  }
  const sync = s.lastSync(); console.log(`\nlast sync: ${sync ? `${sync.status} ${sync.finished_at ?? ''} ${sync.detail ?? ''}` : 'never'}`);
  console.log(`budget: ${JSON.stringify(app.budget.report())}`);
}

function resolveKey(app: App, ref: string): string {
  if (app.store.getReel(ref)) return ref;
  const p = parseShare(ref);
  if (app.store.getReel(p.reelKey)) return p.reelKey;
  throw new Error(`unknown Reel: ${ref}`);
}

const HELP = `reel-maps <command>
  run [--no-sync] [--assist]     pull inbox → process → push status → sync to My Maps (what the scheduler runs)
  serve                          local review UI at http://127.0.0.1:<REVIEW_PORT> (default 8787)
  status                         list Reels, places, candidates, last sync, budget
  add "<shared text or URL>" [--note "..."] [--shared-at ISO]   local intake (same as the iPhone Shortcut)
  attach <reel url|key> <file>   attach a screenshot/video from this computer to an import
  review choose <reel> <n> | search <reel> "<query>" | approx <reel> "<area>" | note <reel> "<text>" | nap <reel>
  sync [--force] [--assist] [--allow-removal] [--test-map]   push to Google: one My Map per country, a layer per city (--test-map: the TEST maps; real maps need MYMAPS_REAL_SYNC=true)
  register-map <cc> <map id> [--test-map]   use an existing My Maps map for a country (e.g. jp)
  export                         write the KML snapshot to data/sync/ without touching Google
  google:login                   open Chrome on the worker profile so you can sign in to Google yourself
  google:verify [--assist]       LIVE test against MYMAPS_TEST_MAP_ID (disposable map)
  google:verify --kml-only       only write data/verify/verify.kml (seed file for the test layer; no Google)
  connect <app url> <code>       connect this computer as a Google My Maps publisher (code from Setup)
  gmaps-connect <app url> <code> [--list Reelocations]
                                 sign in to Google in a Chrome window and give the SERVER that session, so it saves
                                 each place's real listing to your Google Maps list (code from Setup)
  publish [--test-map] [--watch] [--force] [--only jp,kg]   SYNC-ONLY: publish the collection's finished pins, one map
                                 per country; --watch keeps listening and publishes seconds after each change
  sync-remote [--test-map] [--dry-run] [--force]   (legacy, admin) download the finished pins from the hosted app
                                 (HOSTED_URL + APP_TOKEN) and publish them to My Maps; never pulls or processes Reels.
                                 WORKER_MODE=sync-only makes "run" (the scheduled task) do exactly this.
  install-task                   register a Windows scheduled task (every 15 min + at logon)
  doctor                         check configuration and local tools`;

/** Update KEY=VALUE lines in .env (adds missing keys), so a connection survives restarts. */
function setEnv(vals: Record<string, string>) {
  const file = path.join(ROOT, '.env');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [k, v] of Object.entries(vals)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.replace(/\s*$/, '')}\n${k}=${v}\n`;
    process.env[k] = v;
  }
  fs.writeFileSync(file, text);
}

async function publishCmd(cfg: ReturnType<typeof loadConfig>, watch: boolean): Promise<void> {
  const url = process.env.HOSTED_URL, token = process.env.PUBLISHER_TOKEN;
  if (!url || !token) throw new Error('not connected: open reelocations → Setup → "Create desktop code", then run: npm run cli -- connect <url> <code>');
  const test = flag('test-map');
  if (!test && !cfg.mymapsRealSync) { log('real maps are off (MYMAPS_REAL_SYNC=false): rehearse with --test-map, then set MYMAPS_REAL_SYNC=true'); return; }
  const sink = new MyMapsBrowserSink({ mapId: '', layerName: cfg.mymapsLayerName, profileDir: cfg.chromeProfileDir, chromePath: findChrome(cfg.chromePath), debugDir: path.join(cfg.dataDir, 'sync', 'screens'), assist: flag('assist'), headless: flag('headless') });
  const only = opt('only')?.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const o = { url, token, mode: (test ? 'test' : 'real') as 'test' | 'real', sink, force: flag('force'), onlyCountries: only, log };
  try {
    if (watch) await publishWatch(cfg, { ...o, maxMinutes: Number(opt('minutes') ?? 14) });
    else {
      const r = await publishOnce(cfg, o);
      log(`publish ${r.status}${r.reason ? `: ${r.reason}` : ''} in ${(r.ms / 1000).toFixed(1)} s`);
      for (const m of r.perMap) log(`  ${m.status.padEnd(7)} ${m.title} (${m.items} item(s))${m.detail ? ` — ${m.detail}` : ''}`);
      if (r.status === 'failed' || r.status === 'blocked') process.exitCode = 1;
    }
  } finally { await sink.close(); }
}

async function syncRemote(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const url = process.env.HOSTED_URL, token = process.env.APP_TOKEN;
  if (!url || !token) throw new Error('sync-remote needs HOSTED_URL and APP_TOKEN in .env');
  const test = flag('test-map');
  if (!test && !cfg.mymapsRealSync && !flag('dry-run')) { log('real maps are off (MYMAPS_REAL_SYNC=false): use --test-map, or set MYMAPS_REAL_SYNC=true'); return; }
  const m = await mirrorFromHosted(cfg, { url, token, log });
  const grouped = { mode: (test ? 'test' : 'real') as 'test' | 'real', titlePrefix: test ? `TEST ${cfg.mymapsTitlePrefix}` : cfg.mymapsTitlePrefix, layout: cfg.mymapsLayout, mapTitle: test ? `TEST ${cfg.mymapsMapTitle}` : cfg.mymapsMapTitle };
  try {
    if (flag('dry-run')) {
      const { maps, waiting } = planGroups(m.store, grouped);
      for (const mp of maps) log(`plan "${mp.title}" (${m.store.getKv(`map:${grouped.mode}:${mp.countryCode}`) ? 'existing map' : 'NEW map'}): ${mp.layers.map((l) => `${l.name} (${l.ids.length})`).join(', ')}`);
      if (waiting) log(`${waiting} pin(s) wait for their country/city`);
      if (m.retracted.length) log(`removed on Railway, will leave My Maps: ${m.retracted.join(', ')}`);
      log('dry run: nothing was written to Google');
      return;
    }
    const sink = new MyMapsBrowserSink({ mapId: '', layerName: cfg.mymapsLayerName, profileDir: cfg.chromeProfileDir, chromePath: findChrome(cfg.chromePath), debugDir: path.join(cfg.dataDir, 'sync', 'screens'), assist: flag('assist'), headless: flag('headless') });
    try {
      const r = await syncGrouped(m.store, sink, { ...grouped, outDir: path.join(cfg.dataDir, 'mirror', 'sync'), autoCreate: true, force: flag('force'), allowRemoval: flag('allow-removal'), log });
      log(`sync ${r.status}: ${'reason' in r ? r.reason : `${r.count} item(s) verified on Google${r.waiting ? ` (${r.waiting} waiting for country/city)` : ''}`}`);
      for (const mp of ('maps' in r && r.maps) || []) log(`  ${mp.title}: ${mp.layers.join(', ')}`);
      if (r.status !== 'ok' && r.status !== 'skipped') process.exitCode = 1;
    } finally { await sink.close(); }
  } finally { m.store.close(); }
}

async function main() {
  const cfg = loadConfig();
  if (cmd === 'help' || cmd === '--help') { console.log(HELP); return; }
  if (cmd === 'google:login') {
    openLoginWindow(findChrome(cfg.chromePath), cfg.chromeProfileDir);
    console.log(`Opened Chrome with the worker profile (${cfg.chromeProfileDir}).\nSign in to Google there, open your map once, then CLOSE that window before running sync.`); return;
  }
  if (cmd === 'google:verify') {
    if (flag('kml-only')) {
      const f = writeVerifyFixture({ layerName: cfg.mymapsLayerName, dataDir: cfg.dataDir }); f.store.close();
      console.log(`Wrote ${f.kmlFile}\nImport it once by hand into the test map's "${cfg.mymapsLayerName}" layer, then run: npm run google:verify`); return;
    }
    if (!cfg.mymapsTestMapId) throw new Error('Set MYMAPS_TEST_MAP_ID in .env to a disposable test map (see docs/legacy-apps-script.md).');
    const r = await verifyGoogle({ mapId: cfg.mymapsTestMapId, layerName: cfg.mymapsLayerName, profileDir: cfg.chromeProfileDir, chromePath: findChrome(cfg.chromePath), dataDir: cfg.dataDir, assist: flag('assist') });
    process.exitCode = r.ok ? 0 : 1; return;
  }
  if (cmd === 'install-task') {
    const node = process.execPath, cli = path.join(ROOT, 'src', 'cli.ts');
    const tr = `"${node}" "${cli}" run`;
    for (const [name, sched] of [['ReelMaps-every15min', ['/SC', 'MINUTE', '/MO', '15']], ['ReelMaps-atlogon', ['/SC', 'ONLOGON']]] as const) {
      const a = ['/Create', '/F', '/TN', name, '/TR', tr, ...sched];
      if (flag('dry-run')) console.log(`schtasks ${a.map((x) => (x.includes(' ') ? `"${x}"` : x)).join(' ')}`);
      else {
        try { execFileSync('schtasks', a, { stdio: 'inherit' }); }
        // A logon trigger needs administrator rights ("Access is denied" otherwise); the 15-minute task covers it anyway.
        catch (e) { if (name === 'ReelMaps-atlogon') console.log('note: the at-logon task needs administrator rights — skipped; the every-15-minutes task still runs within 15 min of logon.'); else throw e; }
      }
    }
    return;
  }
  if (cmd === 'gmaps-connect') {
    // A fresh, temporary Chrome profile: you sign in (Google's own page; use a dedicated account at first), then only the
    // resulting browser session is sent to YOUR server over HTTPS, stored there in private storage, and deleted here.
    const [url, code] = positional;
    if (!url || !code) throw new Error('usage: gmaps-connect <app url> <code from Setup> [--list Reelocations]');
    const { chromium } = await import('playwright-core');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reelocations-gmaps-'));
    const ctx = await chromium.launchPersistentContext(dir, { executablePath: findChrome(cfg.chromePath), headless: false, viewport: { width: 1200, height: 860 },
      ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'] });
    try {
      const page = ctx.pages()[0] ?? await ctx.newPage();
      await page.goto('https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2Fmaps%3Fhl%3Den');
      log('Sign in to the Google account in the Chrome window (a dedicated test account is recommended at first). Waiting up to 10 minutes…');
      const until = Date.now() + 10 * 60_000;
      let ok = false;
      while (Date.now() < until && !ok) {
        await new Promise((r) => setTimeout(r, 3000));
        const p = ctx.pages().find((x) => /google\.[a-z.]+\/maps/.test(x.url()));
        if (p && await p.locator('a[aria-label^="Google Account"], button[aria-label^="Google Account"]').count()) ok = true;
      }
      if (!ok) throw new Error('no signed-in Google Maps page within 10 minutes');
      const state = await ctx.storageState();
      const r = await fetch(`${url.replace(/\/$/, '')}/api/gmaps/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, state, list_name: opt('list') }) });
      const j: any = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      log(`connected: the server now saves this collection's verified places to the Google Maps list "${opt('list') ?? 'Reelocations'}" (destination ${j.destination_id}).`);
    } finally { await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    return;
  }
  // Sync-only desktop: Railway processes everything; this PC only publishes finished pins to My Maps.
  if (cmd === 'connect') {
    // One-time: trade the code from the website (Setup → "Create desktop code") for a revocable publisher credential.
    const [url, code] = positional;
    if (!url || !code) throw new Error('usage: connect <app url> <code from Setup>');
    const r = await fetch(`${url.replace(/\/$/, '')}/api/publisher/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, label: `${process.env.COMPUTERNAME ?? 'desktop'} (Chrome)` }) });
    const j: any = await r.json();
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    setEnv({ HOSTED_URL: url.replace(/\/$/, ''), PUBLISHER_TOKEN: j.token });
    log(`connected: this computer now publishes collection ${j.collection_id} to your Google My Maps (destination ${j.destination_id}). Saved in .env.`);
    log('Next: npm run cli -- publish --test-map   (rehearse on disposable TEST maps first)');
    return;
  }
  if (cmd === 'publish' || (cmd === 'run' && process.env.WORKER_MODE === 'sync-only')) {
    // Sync-only: Railway is the sole processor of Reels; this only publishes finished pins to My Maps.
    const watch = flag('watch') || cmd === 'run';
    const r = await withLock(cfg.dataDir, () => publishCmd(cfg, watch));
    if (r && typeof r === 'object' && 'locked' in r) log('another run is in progress — skipped');
    return;
  }
  if (cmd === 'sync-remote') {
    const r = await withLock(cfg.dataDir, () => syncRemote(cfg));
    if (r && typeof r === 'object' && 'locked' in r) log('another run is in progress — skipped');
    return;
  }
  const app = createApp(cfg, { log });
  try {
    switch (cmd) {
      case 'run': {
        const r = await withLock(cfg.dataDir, () => cycle(app, flag('no-sync')));
        if (r && typeof r === 'object' && 'locked' in r) log('another run is in progress — skipped');
        break;
      }
      case 'process': log(JSON.stringify(await processDue(app.pipeline))); break;
      case 'pull': if (!app.inbox) throw new Error('inbox not configured'); log(JSON.stringify(await pullInbox(app.store, app.inbox))); break;
      case 'sync': {
        const t = syncTarget(app);
        if ('off' in t) { log(t.off); break; }
        try {
          if (t.grouped) {
            const r = await syncGrouped(app.store, t.sink, { ...t.grouped, outDir: path.join(cfg.dataDir, 'sync'), autoCreate: true, force: flag('force') || flag('assist'), allowRemoval: flag('allow-removal'), log });
            log(`sync ${r.status}: ${'reason' in r ? r.reason : `${r.count} item(s) verified on Google${r.waiting ? ` (${r.waiting} waiting for country/city)` : ''}`}`);
            for (const m of ('maps' in r && r.maps) || []) log(`  ${m.title}: ${m.layers.join(', ')}`);
            if (r.status !== 'ok' && r.status !== 'skipped') process.exitCode = 1;
          } else {
            const r = await syncToMap(app.store, t.sink, { layerName: cfg.mymapsLayerName, outDir: path.join(cfg.dataDir, 'sync'), force: flag('force') || flag('assist'), allowRemoval: flag('allow-removal') });
            log(`sync ${r.status}: ${'reason' in r ? r.reason : `${r.count} features verified on Google`}`);
            if (r.status !== 'ok' && r.status !== 'skipped') process.exitCode = 1;
          }
        } finally { await t.sink.close(); }
        break;
      }
      case 'register-map': {
        const [cc, mid] = positional;
        if (!cc || !/^[a-z]{2}$/i.test(cc) || !mid) { console.log('usage: register-map <country code, e.g. jp> <map id> [--test-map]'); process.exitCode = 1; break; }
        app.store.setKv(`map:${flag('test-map') ? 'test' : 'real'}:${cc.toLowerCase()}`, mid);
        log(`registered ${flag('test-map') ? 'TEST ' : ''}map for ${cc.toUpperCase()}`);
        break;
      }
      case 'export': { const s = buildSnapshot(app.store, cfg.mymapsLayerName); const f = path.join(cfg.dataDir, 'sync', 'reel-places-latest.kml'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s.kml); log(`wrote ${s.features.length} features → ${f}`); break; }
      case 'status': printStatus(app); break;
      case 'metrics': {
        // Per Reel: candidate places (clues that are places or routes, not areas), and how they ended up.
        let tot = { cand: 0, conf: 0, approx: 0, open: 0 };
        for (const r of app.store.listReels()) {
          const ev = r.evidence_json ? JSON.parse(r.evidence_json) : { clues: [] };
          const cands = (ev.clues ?? []).filter((c: any) => c.kind !== 'area').length;
          const links = app.store.linksForReel(r.reel_key) as any[];
          const conf = links.filter((l) => l.confidence === 'confirmed').length, approx = links.filter((l) => l.confidence === 'approximate').length;
          const open = r.status === 'needs_review' || r.status === 'error' ? (String(r.status_reason ?? '').match(/"[^"]+":/g) ?? []).length || (links.length ? 0 : 1) : 0;
          tot = { cand: tot.cand + cands, conf: tot.conf + conf, approx: tot.approx + approx, open: tot.open + open };
          console.log(`${r.reel_key.padEnd(16)} candidates ${String(cands).padStart(2)} · confirmed ${conf} · approximate ${approx} · unresolved ${open}`);
        }
        console.log(`TOTAL            candidates ${tot.cand} · confirmed ${tot.conf} · approximate ${tot.approx} · unresolved ${tot.open}`);
        break;
      }
      case 'serve': {
        startReviewServer(app, cfg.reviewPort, () => cycle(app, true));
        log(`review UI: http://127.0.0.1:${cfg.reviewPort}  (Ctrl+C to stop)`);
        await new Promise(() => {});
        break;
      }
      case 'add': {
        const text = positional[0]; if (!text) throw new Error('usage: add "<url or text>" [--note ...]');
        const sharedAt = opt('shared-at') ?? new Date().toISOString();
        const id = `local:${crypto.createHash('sha256').update(`${text}|${sharedAt}`).digest('hex').slice(0, 16)}`;
        log(JSON.stringify(applyItem(app.store, { id, row: 0, kind: 'share', received_at: nowIso(), shared_at: sharedAt, text, note: opt('note'), input_types: 'cli' })));
        break;
      }
      case 'attach': {
        const [ref, file] = positional; if (!ref || !file) throw new Error('usage: attach <reel url|key> <file>');
        const key = resolveKey(app, ref);
        const dest = path.join(cfg.dataDir, 'media', `${Date.now()}-${path.basename(file)}`); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(file, dest);
        const id = `local-media:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)}`;
        app.store.addMedia({ media_id: id, reel_key: key, kind: mediaKind(undefined, file), mime: null, remote_ref: null, local_path: dest });
        app.store.requeue(key, 'media attached');
        log(`attached ${path.basename(file)} to ${key}; run "process" or "run" to analyse`);
        break;
      }
      case 'review': {
        const [sub, ref, arg] = positional; const key = resolveKey(app, ref ?? '');
        if (sub === 'choose') log(JSON.stringify((await chooseCandidate(app.store, app.resolve, key, Number(arg))).place.name));
        else if (sub === 'search') (await searchCandidates(app.store, app.resolve, key, arg!)).forEach((c, i) => console.log(`#${i} ${c.name} — ${c.displayName} (${c.score})`));
        else if (sub === 'approx') log(`saved approximate: ${(await markApproximate(app.store, app.resolve, key, arg!)).name}`);
        else if (sub === 'note') { addNote(app.store, key, arg!); log('note added; Reel re-queued'); }
        else if (sub === 'nap') { notAPlace(app.store, key); log('marked as not a place (kept with link and date)'); }
        else throw new Error('review choose|search|approx|note|nap');
        break;
      }
      case 'doctor': {
        const ok = (b: unknown) => (b ? '✔' : '✘');
        console.log(`${ok(cfg.inboxUrl && cfg.inboxToken)} inbox (Apps Script) ${cfg.inboxUrl ?? ''}`);
        console.log(`${ok(cfg.mymapsMapId)} My Maps map id ${cfg.mymapsMapId ?? '(not set: sync writes KML only)'}; layer "${cfg.mymapsLayerName}"`);
        let chrome = ''; try { chrome = findChrome(cfg.chromePath); } catch { /* missing */ }
        console.log(`${ok(chrome)} Chrome ${chrome}`);
        console.log(`${ok(fs.existsSync(path.join(cfg.chromeProfileDir, 'Default')))} worker Chrome profile ${cfg.chromeProfileDir} (run google:login once)`);
        console.log(`${ok(ffmpegPath())} ffmpeg ${ffmpegPath() ?? ''}`);
        let tr = false; try { await import('@huggingface/transformers' as string); tr = true; } catch { /* optional */ }
        console.log(`${tr ? '✔' : '–'} local transcription ${tr ? 'available' : '(optional: npm i @huggingface/transformers)'}`);
        console.log(`${cfg.anthropicKey && cfg.visionMonthlyBudgetUsd > 0 ? '✔' : '–'} paid vision fallback ${cfg.anthropicKey ? `budget $${cfg.visionMonthlyBudgetUsd}/month` : 'disabled'}`);
        console.log(`${cfg.googlePlacesKey ? '✔' : '–'} Google Places IDs-only lookup ${cfg.googlePlacesKey ? 'enabled' : 'disabled'}`);
        break;
      }
      default: console.log(HELP); process.exitCode = 1;
    }
  } finally { if (cmd !== 'serve') await app.close(); }
}

main().catch((e) => { console.error(`error: ${(e as Error).message}`); process.exitCode = 1; });
