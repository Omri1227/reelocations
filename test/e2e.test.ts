/**
 * End-to-end scenarios. What is real vs. fixture:
 *  REAL   : apps-script/Code.gs (run in a VM behind a real local HTTP server), the worker's HTTP client, SQLite,
 *           clue extraction/ranking, local OCR (tesseract.js), ffmpeg frame extraction, KML generation/parsing.
 *  RECORDED: OpenStreetMap Nominatim/Overpass responses (captured live with RECORD=1, replayed afterwards).
 *  SYNTHETIC: Meta oEmbed responses (no real public Reel was available), the iPhone Shortcut (plain HTTP POSTs),
 *           the My Maps layer (FakeMyMaps implements "Replace all items" semantics incl. outages).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createApp, type App } from '../src/app.ts';
import { runOnce } from '../src/worker.ts';
import { syncToMap } from '../src/sync/sync.ts';
import { buildStatusItems } from '../src/intake/inbox.ts';
import { chooseCandidate } from '../src/review/actions.ts';
import { AppsScriptEmulator, FakeMyMaps, fakeOembed, recordReplayFetch, tmpDir, FIX_DIR } from './support.ts';

const TOKEN = 'e2e-token-0123456789abcdef';
const LAYER = 'Reels (auto)';
const MEDIA = path.join(FIX_DIR, 'media');
const reel = (code: string) => `https://www.instagram.com/reel/${code}/?igsh=MWQ1ZGUxMzBkMA==`;

const OEMBED = fakeOembed({
  VENUE01: { caption: 'Coffee break in Chiado ☕ 📍 A Brasileira, Lisbon — the oldest café in town' },
  VENUE02: { caption: 'Pastel de nata + bica at A Brasileira, Lisbon. Go early, the terrace fills up fast!' },
  TRAIL01: { caption: 'Sunrise hike on the Nahal David trail in Ein Gedi Nature Reserve. The viewpoint above the waterfall at the end is unreal 🤩' },
  LAND01: { caption: 'Golden hour vibes ✨ #nature #israel #sunset' },
  MULTI01: { caption: '3 hidden gems in Lisbon:\n1. Miradouro da Senhora do Monte – best sunset in the city\n2. Praia da Ursa – wild beach, steep path down' },
  SHOT01: { error: { message: 'The requested resource does not exist', code: 24, subcode: 2207045, title: 'Media Not Found' } },
  CLIP01: { caption: 'Day trip 🌿 sound on' },
  OFF01: { caption: '📍 A Brasileira, Lisbon' },
  // GONE01 intentionally missing => "Media Not Found" (private/deleted Reel)
});

let emu: AppsScriptEmulator;
let app: App;
let map: FakeMyMaps;
let desktopOnline = true;
const runs: string[] = [];

async function phoneShare(text: string, sharedAt: string, note = '') {
  // What the iPhone Shortcut does: POST JSON to the Apps Script web app (works while the desktop is off).
  const r = await fetch(emu.url, { method: 'POST', body: JSON.stringify({ token: TOKEN, action: 'share', text, shared_at: sharedAt, note, input_types: 'URL' }) });
  return r.json() as Promise<any>;
}
async function phoneAttach(file: string, reelUrl: string, sharedAt: string, mime: string) {
  const r = await fetch(emu.url, { method: 'POST', body: JSON.stringify({ token: TOKEN, action: 'media', data: fs.readFileSync(file).toString('base64'), mime, filename: path.basename(file), reel_url: reelUrl, shared_at: sharedAt }) });
  return r.json() as Promise<any>;
}
async function cycle(extra: Parameters<typeof runOnce>[1] = {}) {
  const r = await runOnce(app, { sink: map, ...extra });
  runs.push(JSON.stringify(r));
  return r;
}
const reelRow = (code: string) => app.store.getReel(`ig:${code}`)!;
const placesOf = (code: string) => app.store.linksForReel(`ig:${code}`) as any[];

before(async () => {
  emu = new AppsScriptEmulator(TOKEN);
  await emu.listen();
  const dataDir = tmpDir('e2e');
  const cfg = loadConfig({ dataDir, inboxUrl: emu.url, inboxToken: TOKEN, instagramOembed: true, transcribe: process.env.E2E_TRANSCRIBE === '1' ? 'auto' : 'off', anthropicKey: undefined, visionMonthlyBudgetUsd: 0, googlePlacesKey: undefined, openaiKey: undefined, instagramPageCaption: false, mymapsLayerName: LAYER });
  const base = OEMBED(recordReplayFetch());
  app = createApp(cfg, {
    fetch: (u, i) => (desktopOnline ? base(u, i) : Promise.reject(new TypeError('fetch failed (desktop offline)'))),
    polite: process.env.RECORD === '1', backoffBaseMs: 1,
  });
  map = new FakeMyMaps(LAYER);
});
after(async () => { await app.close(); await emu.close(); });

test('1. named venue → confirmed café with Reel link, share date and quoted cue on the map', async () => {
  const sh = await phoneShare(reel('VENUE01'), '2026-11-01T09:15:00+02:00');
  assert.equal(sh.ok, true);
  const r = await cycle();
  assert.match(r.pull, /ok: 1/);
  const row = reelRow('VENUE01');
  assert.equal(row.status, 'resolved', row.status_reason ?? '');
  const [p] = placesOf('VENUE01');
  assert.equal(p.category, 'cafe'); assert.equal(p.confidence, 'confirmed'); assert.match(p.name, /Brasileira/);
  assert.match(p.cue, /^Caption: ".*A Brasileira/);
  assert.equal(r.syncOutcome?.status, 'ok');
  const f = map.layers.get(LAYER)!.find((x) => /Brasileira/.test(x.name))!;
  assert.match(f.name, /^☕ /);
  assert.match(f.description, /🔗 Reel: https:\/\/www\.instagram\.com\/reel\/VENUE01\//);
  assert.match(f.description, /📅 Shared: 2026-11-01 09:15/);
  assert.match(f.description, /✅ Confirmed/);
});

test('2. named trail → mapped OSM route line + honestly-labelled trailhead; containing reserve not pinned separately', async () => {
  await phoneShare(reel('TRAIL01'), '2026-11-02T06:40:00+02:00', 'the viewpoint above the waterfall shown at the end');
  await cycle();
  // Public Overpass is often overloaded. Then either the Reel is retried later (status "error" with backoff) or the hike
  // is saved as a point and its line is added on a later run. Simulate "a later run" up to twice.
  for (let i = 0; i < 2 && (reelRow('TRAIL01').status === 'error' || placesOf('TRAIL01')[0]?.kind === 'point'); i++) {
    if (reelRow('TRAIL01').status === 'error') app.store.requeue('ig:TRAIL01', 'test: later run');
    await cycle();
  }
  const links = placesOf('TRAIL01');
  assert.equal(reelRow('TRAIL01').status, 'resolved', reelRow('TRAIL01').status_reason ?? '');
  assert.equal(links.length, 1, JSON.stringify(links.map((l) => l.name)));
  const t = links[0];
  assert.equal(t.category, 'hike'); assert.equal(t.kind, 'route');
  const lines = JSON.parse(t.geometry_json); assert.ok(lines[0].length >= 5);
  assert.match(JSON.parse(t.trailhead_json).source, /trailhead|not a signed trailhead/);
  assert.equal(t.cue, 'Your note: "the viewpoint above the waterfall shown at the end"');
  const feats = map.layers.get(LAYER)!.filter((x) => x.rmId?.startsWith(`rm:${t.place_id}`));
  assert.ok(feats.some((x) => x.geometry === 'line')); assert.ok(feats.some((x) => /trailhead/.test(x.name)));
});

test('3. ambiguous landscape (+ screenshot without text) → review queue, nothing guessed onto the map', async () => {
  await phoneShare(reel('LAND01'), '2026-11-03T19:05:00+02:00');
  const a = await phoneAttach(path.join(MEDIA, 'landscape-no-text.png'), reel('LAND01'), '2026-11-03T19:06:00+02:00', 'image/png');
  assert.equal(a.ok, true);
  await cycle();
  const row = reelRow('LAND01');
  assert.equal(row.status, 'needs_review');
  assert.equal(placesOf('LAND01').length, 0);
  assert.match(row.status_reason!, /no explicit location clue/);
  assert.equal(JSON.parse(row.capabilities_json!).images, 'attached');
});

test('4. link with unavailable media (deleted/private Reel) → review queue keeps link + original date', async () => {
  await phoneShare(`Look at this ${reel('GONE01')}`, '2026-11-04T12:00:00+02:00');
  await cycle();
  const row = reelRow('GONE01');
  assert.equal(row.status, 'needs_review');
  assert.equal(row.url, 'https://www.instagram.com/reel/GONE01/');
  assert.equal(row.first_shared_at, '2026-11-04T12:00:00+02:00');
  const caps = JSON.parse(row.capabilities_json!);
  assert.equal(caps.caption, 'unavailable'); assert.equal(caps.video, 'unavailable');
  assert.match(caps.notes.join(' '), /Media Not Found/);
  // visible on the phone index page too
  const html = emu.get({ k: TOKEN });
  assert.match(html, /reel\/GONE01/);
  assert.match(html, /<base target="_top">/, 'links must leave the Apps Script iframe (blank page on iPhone otherwise)');
  assert.ok(buildStatusItems(app.store).some((s) => s.reel_key === 'ig:GONE01' && s.status === 'needs_review'));
});

test('5. multiple places in one Reel → each saved with its own category and cue', async () => {
  await phoneShare(reel('MULTI01'), '2026-11-05T21:30:00+00:00');
  await cycle();
  const links = placesOf('MULTI01');
  assert.equal(reelRow('MULTI01').status, 'resolved', reelRow('MULTI01').status_reason ?? '');
  assert.deepEqual(links.map((l) => l.category).sort(), ['beach', 'viewpoint']);
  assert.ok(links.find((l) => l.category === 'beach').cue.includes('Praia da Ursa – wild beach'));
  assert.ok(links.find((l) => l.category === 'viewpoint').cue.includes('Miradouro da Senhora do Monte'));
});

test('6. repeated share + duplicate delivery + a second Reel of the same place → no duplicates, nothing lost', async () => {
  const placesBefore = app.store.counts().places;
  const dup = await phoneShare(reel('VENUE01'), '2026-11-01T09:15:00+02:00'); // Shortcut retried the same request
  assert.equal(dup.duplicate, true);
  const again = await phoneShare(`https://instagram.com/reels/VENUE01`, '2026-11-06T08:00:00+02:00', 'go on a weekday morning');
  assert.equal(again.duplicate, false);
  await phoneShare(reel('VENUE02'), '2026-11-06T08:05:00+02:00');
  const r = await cycle();
  assert.match(r.pull, /repeat_share/);
  assert.equal(app.store.sharesFor('ig:VENUE01').length, 2);
  assert.equal(reelRow('VENUE01').first_shared_at, '2026-11-01T09:15:00+02:00', 'original share time preserved');
  assert.equal(app.store.counts().places, placesBefore, 'same café, no new place');
  const place = placesOf('VENUE01')[0];
  const links = app.store.linksForPlace(place.place_id);
  assert.deepEqual(links.map((l) => l.reel_key).sort(), ['ig:VENUE01', 'ig:VENUE02']);
  const f = map.layers.get(LAYER)!.find((x) => x.rmId === `rm:${place.place_id}`)!;
  assert.match(f.description, /Reel 1 of 2[\s\S]*VENUE01[\s\S]*2026-11-01 09:15[\s\S]*Reel 2 of 2[\s\S]*VENUE02[\s\S]*2026-11-06 08:05/);
  assert.equal(map.layers.get(LAYER)!.filter((x) => x.rmId === `rm:${place.place_id}`).length, 1);
});

test('7. media fallback: screenshot OCR resolves a Reel whose metadata is unavailable; video frames resolve another', async () => {
  await phoneShare(reel('SHOT01'), '2026-11-07T10:00:00+02:00');
  await phoneAttach(path.join(MEDIA, 'screenshot-location-tag.png'), reel('SHOT01'), '2026-11-07T10:01:00+02:00', 'image/png');
  await phoneShare(reel('CLIP01'), '2026-11-07T11:00:00+02:00');
  await phoneAttach(path.join(MEDIA, 'clip-waterfall.mp4'), reel('CLIP01'), '2026-11-07T11:02:00+02:00', 'video/mp4');
  await cycle();
  const shot = placesOf('SHOT01');
  assert.equal(reelRow('SHOT01').status, 'resolved', reelRow('SHOT01').status_reason ?? '');
  assert.equal(shot[0].category, 'beach'); assert.match(shot[0].cue, /^On-screen text: "Praia da Ursa, Sintra"/);
  const clip = placesOf('CLIP01');
  assert.equal(reelRow('CLIP01').status, 'resolved', reelRow('CLIP01').status_reason ?? '');
  assert.equal(clip[0].category, 'waterfall'); assert.match(clip[0].name, /Banias/i);
  assert.equal(JSON.parse(reelRow('CLIP01').capabilities_json!).video, 'attached');
});

test('8. review queue: user picks a candidate → confirmed and synced', async () => {
  await phoneShare(reel('OFF01').replace('OFF01', 'AMBIG1'), '2026-11-08T08:00:00+02:00', 'Nahal David');
  await cycle();
  const row = app.store.getReel('ig:AMBIG1')!;
  assert.equal(row.status, 'needs_review', 'two same-named streams → ambiguous, not guessed');
  const cands = app.store.candidatesFor('ig:AMBIG1');
  assert.ok(cands.length >= 2);
  const idx = cands.findIndex((c) => /Israel/.test(c.displayName) && /Tamar/.test(c.displayName));
  await chooseCandidate(app.store, app.resolve, 'ig:AMBIG1', idx >= 0 ? idx : 0);
  assert.equal(app.store.getReel('ig:AMBIG1')!.status, 'resolved');
  const r = await cycle();
  assert.equal(r.syncOutcome?.status, 'ok');
});

test('9. desktop offline: shares queue in the Sheet, sync fails safely, then recovers with nothing lost or duplicated', async () => {
  const remoteBefore = map.layers.get(LAYER)!.length;
  desktopOnline = false; map.online = false;
  await phoneShare(reel('OFF01'), '2026-11-08T20:00:00+02:00', 'saved while the PC was off');
  const down = await cycle();
  assert.match(down.pull, /deferred/);
  assert.equal(app.store.getReel('ig:OFF01'), undefined, 'not pulled yet, still safe in the Sheet');
  assert.equal(emu.inbox().filter((r) => String(r[5]).includes('OFF01')).length, 1);
  // desktop comes back, but the browser import crashes once mid-sync
  desktopOnline = true; map.online = true; map.failNextReplace = true;
  const crashed = await cycle({ force: true });
  assert.equal(crashed.syncOutcome?.status, 'failed');
  assert.equal(reelRow('OFF01').first_shared_at, '2026-11-08T20:00:00+02:00', 'phone timestamp kept although processed later');
  // backoff: an immediate unforced retry is deferred, a later one succeeds
  const deferred = await cycle();
  assert.equal(deferred.syncOutcome?.status, 'deferred');
  const recovered = await cycle({ now: () => Date.now() + 60 * 60_000 });
  assert.equal(recovered.syncOutcome?.status, 'ok', JSON.stringify(recovered.syncOutcome));
  const remote = map.layers.get(LAYER)!;
  assert.ok(remote.length >= remoteBefore, 'nothing removed');
  assert.equal(new Set(remote.map((f) => f.rmId)).size, remote.length, 'no duplicate features');
  // idempotent: same data → skipped, no Google write
  const calls = map.replaceCalls;
  assert.equal((await cycle()).syncOutcome?.status, 'skipped');
  assert.equal(map.replaceCalls, calls);
});

test('10. safety: a hand-made feature in the synced layer blocks replace-all instead of being deleted', async () => {
  map.layers.get(LAYER)!.push({ layer: LAYER, name: 'My own pin', description: 'added by hand', geometry: 'point' });
  await phoneShare(reel('VENUE02').replace('VENUE02', 'VENUE03'), '2026-11-09T07:00:00+02:00', '📍 A Brasileira, Lisbon');
  const r = await runOnce(app, { sink: map, force: true });
  assert.equal(r.syncOutcome?.status, 'blocked');
  assert.ok(map.layers.get(LAYER)!.some((f) => f.name === 'My own pin'), 'hand-made feature untouched');
  const direct = await syncToMap(app.store, map, { layerName: LAYER, outDir: path.join(app.cfg.dataDir, 'sync'), force: true });
  assert.equal(direct.status, 'blocked');
});
