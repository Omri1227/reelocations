import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { startServer } from '../src/server.ts';
import { gplaceToCandidate, type GPlace } from '../src/geo/googlePlaces.ts';
import { decideListing, matchStoredPlaces, type GoogleSearch } from '../src/geo/googleMatch.ts';
import { chooseCandidate } from '../src/review/actions.ts';
import { buildMapData } from '../src/web/mapData.ts';
import { tmpDir } from './support.ts';

// Real Places API (New) Text Search response for "Shinjuku Yakiniku Horumon Kaze, Tokyo" (recorded 2026-11-11).
const KAZE: GPlace[] = [
  { id: 'ChIJexampleKazeMain00001', displayName: { text: 'Shinjuku Yakiniku Hormone Kaze' }, formattedAddress: 'Japan, 〒160-0023 Tokyo, Shinjuku City, Nishishinjuku, 7-chōme−11−３ 例ビル 2F', location: { latitude: 35.6951128, longitude: 139.6979488 }, types: ['yakiniku_restaurant', 'japanese_restaurant', 'restaurant', 'food', 'point_of_interest', 'establishment'] },
  { id: 'ChIJexampleKaze2nd000002', displayName: { text: 'Shinjuku Yakiniku Horumon Kaze 2nd Branch' }, formattedAddress: 'Japan, 〒160-0023 Tokyo, Shinjuku City, Nishishinjuku, 8-chōme−9−４ 見本ビル', location: { latitude: 35.6950773, longitude: 139.6916395 }, types: ['yakiniku_restaurant', 'japanese_restaurant', 'restaurant', 'food', 'point_of_interest', 'establishment'] },
];
const cands = KAZE.map(gplaceToCandidate);
const pin = { category: 'restaurant' as const, lat: 35.6938, lon: 139.7034, confidence: 'approximate', source: 'OpenAI estimate from the picture', country: 'Japan', locality: 'Tokyo' };

test('Google listing: the branch named by the Reel wins; the main shop wins when no branch is named', () => {
  const a = decideListing({ ...pin, name: 'Shinjuku Yakiniku Horumon Kaze (2nd Branch)' }, cands);
  assert.equal(a.status, 'matched'); assert.equal(a.status === 'matched' && a.cand.googlePlaceId, 'ChIJexampleKaze2nd000002');
  const b = decideListing({ ...pin, name: 'Shinjuku Yakiniku Horumon Kaze' }, cands);
  assert.equal(b.status, 'matched', JSON.stringify(b)); assert.equal(b.status === 'matched' && b.cand.googlePlaceId, 'ChIJexampleKazeMain00001');
  // Branch words in the Reel's own text next to the name pick the outlet even when the pin name has none.
  const c = decideListing({ ...pin, name: 'Shinjuku Yakiniku Horumon Kaze', evidence: ['Best yakiniku 🔥\n📍 Shinjuku Yakiniku Horumon Kaze — 2nd branch'] }, cands);
  assert.equal(c.status === 'matched' && c.cand.googlePlaceId, 'ChIJexampleKaze2nd000002');
});

test('Google listing: wrong type, wrong country or too far is never matched', () => {
  assert.equal(decideListing({ ...pin, name: 'Shinjuku Yakiniku Horumon Kaze', category: 'park' }, cands).status, 'none');
  assert.equal(decideListing({ ...pin, name: 'Shinjuku Yakiniku Horumon Kaze', lat: 34.69, lon: 135.5, country: 'Japan' }, cands).status, 'none', 'Osaka pin ≠ Tokyo listing');
  assert.equal(decideListing({ ...pin, name: 'Shinjuku Yakiniku Horumon Kaze', confidence: 'confirmed', source: 'OpenStreetMap', lat: 35.70, lon: 139.75 }, cands).status, 'none', 'confirmed map point: listing must be within 3 km');
});

function seed(s: Store) {
  s.addShare({ intake_id: 'i1', reel_key: 'ig:AAA', url: 'https://www.instagram.com/reel/AAA/', shortcode: 'AAA', raw_text: null, input_types: null, shared_at: '2026-11-09T18:22:00+02:00', note: null });
  s.upsertPlace({ place_id: 'aiest:35.69,139.70', name: 'Yakiniku Inoue', category: 'restaurant', kind: 'point', lat: 35.6938, lon: 139.7034, geometry_json: null, trailhead_json: null, confidence: 'approximate', source: 'OpenAI estimate from the picture (±2 km, unverified)', address: null, google_place_id: null });
  s.setLocality('aiest:35.69,139.70', { country: 'Japan', country_code: 'jp', locality: 'Tokyo', region: null });
  s.linkReelPlace({ reel_key: 'ig:AAA', place_id: 'aiest:35.69,139.70', cue: 'Caption: "best yakiniku"', cue_source: 'caption', role: 'featured', decided_by: 'auto' });
  s.setLinkImage('ig:AAA', 'aiest:35.69,139.70', { path: '/x/shot.jpg', kind: 'place', t: 5 });
  s.setReelResult('ig:AAA', { status: 'resolved', reason: 'ok' });
}

test('backfill: two equally good branches go to the existing review; choosing one updates the pin in place (link, date, cue, photo kept)', async () => {
  const s = new Store(':memory:'); seed(s);
  const before = s.linksForPlace('aiest:35.69,139.70')[0]!;
  // Two outlets with the same name, no branch words anywhere → ambiguous.
  const twins = [KAZE[0]!, { ...KAZE[0]!, id: 'ChIJother', displayName: { text: 'Yakiniku Inoue' }, location: { latitude: 35.6900, longitude: 139.7000 } }, { ...KAZE[0]!, id: 'ChIJthird', displayName: { text: 'Yakiniku Inoue' } }];
  const search: GoogleSearch = async () => twins.slice(1).map(gplaceToCandidate);
  const r = await matchStoredPlaces(s, search);
  assert.deepEqual(r, { matched: 0, review: 1, none: 0 });
  assert.equal(s.getReel('ig:AAA')!.status, 'needs_review');
  assert.match(s.getReel('ig:AAA')!.status_reason!, /Which Google Maps listing is/);
  const opts = s.candidatesFor('ig:AAA');
  assert.equal(opts.length, 2); assert.ok(opts.every((o) => o.replacesPlaceId === 'aiest:35.69,139.70'));
  assert.equal((await matchStoredPlaces(s, search)).review, 0, 'not asked twice');
  await chooseCandidate(s, { geocoder: { search: async () => [] } }, 'ig:AAA', opts.findIndex((o) => o.googlePlaceId === 'ChIJother'));
  const p = s.getPlace('aiest:35.69,139.70')!;
  assert.equal(p.google_place_id, 'ChIJother'); assert.equal(p.lat, 35.69); assert.equal(p.confidence, 'confirmed'); assert.equal(p.category, 'restaurant');
  assert.ok(p.coords_fetched_at, 'Google coordinates carry a fetch date (30-day refresh)');
  assert.equal(s.listPlaces().length, 1, 'no duplicate pin');
  const after = s.linksForPlace(p.place_id)[0]!;
  assert.equal(after.first_shared_at, before.first_shared_at); assert.equal(after.cue, before.cue); assert.equal((after as any).image_path, '/x/shot.jpg');
  assert.equal(s.getReel('ig:AAA')!.status, 'resolved'); assert.equal(s.candidatesFor('ig:AAA').length, 0);
  assert.match(buildMapData(s).places[0]!.maps_url, /query_place_id=ChIJother/);
});

test('backfill: a clear match updates the existing pin automatically', async () => {
  const s = new Store(':memory:'); seed(s);
  s.db.prepare("UPDATE places SET name='Shinjuku Yakiniku Horumon Kaze (2nd Branch)'").run();
  const r = await matchStoredPlaces(s, async () => cands);
  assert.equal(r.matched, 1);
  const p = s.getPlace('aiest:35.69,139.70')!;
  assert.equal(p.google_place_id, 'ChIJexampleKaze2nd000002'); assert.equal(p.lat, 35.6950773);
  assert.equal(s.getReel('ig:AAA')!.status, 'resolved');
});

// ---------------------------------------------------------------------------------------------------------------
const TOKEN = 'app-token-0123456789', INBOX = 'inbox-token-0123456789';
const req = (port: number, p: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method: o.method ?? 'GET', headers: { 'Content-Type': 'application/json', ...o.headers }, body: o.body === undefined ? undefined : JSON.stringify(o.body), redirect: 'manual' });

function hostedApp(dataDir: string) {
  const cfg = loadConfig({ dataDir, inboxUrl: undefined, inboxToken: INBOX, googlePlacesKey: undefined, openaiKey: undefined, anthropicKey: undefined, instagramPageCaption: false, instagramOembed: false, transcribe: 'off' });
  return () => createApp(cfg, { media: null, polite: false, fetch: async () => { throw new TypeError('fetch failed (offline test)'); } });
}

/** Test stand-in for Google: "sub|email|name" → a verified identity (the real path checks Google's RS256 signature). */
export const fakeGoogle = async (t: string) => { const [sub, email, name] = t.split('|'); if (!sub) throw new Error('bad'); return { sub: sub!, email: email ?? null, email_verified: true, name: name ?? null, picture: null }; };
export async function signIn(port: number, credential: string, extra: Record<string, string> = {}): Promise<string> {
  const r = await req(port, '/auth/google', { method: 'POST', body: { credential, ...extra } });
  if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${await r.text()}`);
  return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
}

test('hosted server: Google sign-in + claim of the old collection, intake (Apps Script contract), map JSON, live update event, screenshots, migration import', async () => {
  const dir = tmpDir('hosted');
  const makeApp = hostedApp(dir);
  const port = 18000 + Math.floor(Math.random() * 1000);
  const srv = startServer({ app: makeApp(), makeApp, port, appToken: TOKEN, startWorker: false, sseCheckMs: 50, googleClientId: 'test-client', verifyIdToken: fakeGoogle });
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await req(port, '/healthz')).status, 200);
    assert.equal((await req(port, '/api/places')).status, 401, 'map data needs a session');
    assert.match(await (await req(port, '/')).text(), /Sign up<\/button>\s*<button role="tab" id="tab-in" aria-selected="true">Sign in/, 'visitors see Sign up / Sign in');
    assert.equal((await req(port, '/api/places', { headers: { 'x-token': TOKEN } })).status, 401, 'the old admin token no longer opens the map');
    assert.equal((await req(port, '/api/places', { headers: { cookie: `rm_k=${TOKEN}` } })).status, 401, 'nor does the old ?k= cookie');
    // Sign in with Google and claim the existing collection (the old ?k= link).
    const cookie = await signIn(port, 'g-owner|owner@example.com|Owner', { claim: TOKEN });
    for (const p of ['/review', '/review/']) assert.equal((await req(port, p, { headers: { cookie } })).status, 200, `review page at ${p}`);

    // Intake: same JSON as the Apps Script inbox; idempotent.
    const share = { token: INBOX, action: 'share', text: 'https://www.instagram.com/reel/XYZ123/?igsh=abc', shared_at: '2026-11-11T09:00:00+02:00', note: '', input_types: 'URL' };
    assert.equal(((await (await req(port, '/api/intake', { method: 'POST', body: { ...share, token: 'nope-nope-nope-nope' } })).json()) as any).error, 'bad token');
    const a = await (await req(port, '/api/intake', { method: 'POST', body: share })).json() as any;
    const b = await (await req(port, '/api/intake', { method: 'POST', body: share })).json() as any;
    assert.equal(a.ok, true); assert.equal(b.duplicate, true); assert.equal(a.id, b.id);
    assert.ok(srv.app.store.getReel('ig:XYZ123'));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const m = await (await req(port, '/api/intake', { method: 'POST', body: { token: INBOX, action: 'media', data: jpeg.toString('base64'), filename: 'screenshot.jpg', reel_url: share.text, shared_at: share.shared_at } })).json() as any;
    assert.equal(m.ok, true);
    const media = srv.app.store.mediaFor('ig:XYZ123');
    assert.equal(media.length, 1); assert.equal(media[0]!.status, 'downloaded'); assert.ok(fs.existsSync(media[0]!.local_path!));

    // Live updates: an open SSE stream gets a new version as soon as a pin is saved.
    const events: string[] = [];
    const sse = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { cookie } }, (res) => res.on('data', (c) => events.push(String(c))));
    await new Promise((r) => setTimeout(r, 150));
    const n0 = events.join('').split('event: version').length;
    srv.app.store.upsertPlace({ place_id: 'osm:node:1', name: 'Café X', category: 'cafe', kind: 'point', lat: 35.6, lon: 139.7, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'OpenStreetMap', address: null, google_place_id: null });
    srv.app.store.linkReelPlace({ reel_key: 'ig:XYZ123', place_id: 'osm:node:1', cue: null, cue_source: null, role: 'featured', decided_by: 'user' });
    const t0 = Date.now();
    while (events.join('').split('event: version').length === n0 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    sse.destroy();
    assert.ok(events.join('').split('event: version').length > n0, 'version event after the save');

    const d = await (await req(port, '/api/places', { headers: { cookie } })).json() as any;
    assert.equal(d.places.length, 1); assert.equal(d.places[0].reels[0].url, 'https://www.instagram.com/reel/XYZ123/');
    const img = await req(port, d.places[0].reels[0].image, { headers: { cookie } });
    assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/jpeg', 'the Reel screenshot is served');
    const etag = (await req(port, '/api/places', { headers: { cookie } })).headers.get('etag')!;
    assert.equal((await req(port, '/api/places', { headers: { cookie, 'if-none-match': etag } })).status, 304, 'unchanged data costs nothing');

    // Migration import: refuses to overwrite, then replaces and rewrites Windows paths to the volume.
    const src = new Store(':memory:'); seed(src);
    src.db.prepare("UPDATE reel_places SET image_path='C:\\reel\\data\\work\\pins\\shot.jpg'").run();
    // Cached media analysis keeps frame paths too (seen live after the first migration).
    src.setKv('mediatext:v3:m1', JSON.stringify({ ocr: ['x'], frames: ['C:\\reel\\data\\work\\pins\\shot.jpg'] }));
    const tmp = path.join(dir, 'src.sqlite'); src.db.exec(`VACUUM INTO '${tmp}'`); src.close();
    const body = { db: fs.readFileSync(tmp).toString('base64'), src_data_dir: 'C:\\reel\\data', files: [{ rel: 'work/pins/shot.jpg', data: jpeg.toString('base64') }] };
    assert.equal((await req(port, '/api/admin/import', { method: 'POST', body, headers: { 'x-token': TOKEN } })).status, 409);
    const imp = await (await req(port, '/api/admin/import', { method: 'POST', body: { ...body, replace: true }, headers: { 'x-token': TOKEN } })).json() as any;
    assert.equal(imp.ok, true); assert.equal(imp.paths_rewritten, 2, 'pin photo + cached media analysis');
    assert.equal(JSON.parse(srv.app.store.getKv('mediatext:v3:m1')!).frames[0], path.join(dir, 'work', 'pins', 'shot.jpg'));
    const cookie2 = await signIn(port, 'g-owner|owner@example.com|Owner', { claim: TOKEN }); // the imported DB has no accounts yet
    const d2 = await (await req(port, '/api/places', { headers: { cookie: cookie2 } })).json() as any;
    assert.equal(d2.places.length, 1); assert.equal(d2.places[0].name, 'Yakiniku Inoue'); assert.equal(d2.places[0].reels[0].shared_at, '2026-11-09T18:22:00+02:00');
    assert.equal((await req(port, d2.places[0].reels[0].image, { headers: { cookie: cookie2 } })).status, 200, 'migrated screenshot served from the data volume');
  } finally { await srv.close(); }
  // Durability: a new process on the same data directory sees everything.
  const again = makeApp();
  try { assert.equal(again.store.listPlaces()[0]!.name, 'Yakiniku Inoue'); } finally { await again.close(); }
});

test('one pin per Google listing: a new result for an existing listing joins that pin; old duplicates are merged with their links', () => {
  const s = new Store(':memory:'); seed(s);
  s.applyGoogleListing('aiest:35.69,139.70', { googlePlaceId: 'ChIJsame', lat: 35.695, lon: 139.69, confirm: true });
  s.addShare({ intake_id: 'i2', reel_key: 'ig:BBB', url: 'https://www.instagram.com/reel/BBB/', shortcode: 'BBB', raw_text: null, input_types: null, shared_at: '2026-11-11T10:00:00Z', note: null });
  const row = s.upsertPlace({ place_id: 'gplace:ChIJsame', name: 'Inoue', category: 'restaurant', kind: 'point', lat: 35.695, lon: 139.69, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'Google Maps', address: null, google_place_id: 'ChIJsame', coords_fetched_at: new Date().toISOString() });
  assert.equal(row.place_id, 'aiest:35.69,139.70', 'joined the existing pin'); assert.equal(s.listPlaces().length, 1);
  // A duplicate made before this rule existed (seen live): merged, links kept.
  s.db.prepare("INSERT INTO places(place_id,name,category,kind,lat,lon,confidence,source,google_place_id,created_at,updated_at) VALUES('gplace:dup','Inoue','restaurant','point',35.695,139.69,'confirmed','Google Maps','ChIJsame','2026-12-01','2026-12-01')").run();
  s.linkReelPlace({ reel_key: 'ig:BBB', place_id: 'gplace:dup', cue: 'Caption: "again"', cue_source: 'caption', role: 'featured', decided_by: 'auto' });
  assert.equal(s.mergeSameListing(), 1);
  assert.deepEqual(s.listPlaces().map((p) => p.place_id), ['aiest:35.69,139.70']);
  const links = s.linksForPlace('aiest:35.69,139.70');
  assert.deepEqual(links.map((l) => l.reel_key).sort(), ['ig:AAA', 'ig:BBB']);
  assert.equal(links.find((l) => l.reel_key === 'ig:AAA')!.cue, 'Caption: "best yakiniku"'); assert.equal((links.find((l) => l.reel_key === 'ig:AAA') as any).image_path, '/x/shot.jpg');
  assert.equal(links.find((l) => l.reel_key === 'ig:BBB')!.cue, 'Caption: "again"');
});

test('Google listing: identifying words must agree (cases seen live 2026-11-11)', () => {
  const g = (id: string, name: string, addr: string, lat: number, lon: number, types: string[]) => gplaceToCandidate({ id, displayName: { text: name }, formattedAddress: addr, location: { latitude: lat, longitude: lon }, types });
  const osaka = { category: 'restaurant' as const, confidence: 'confirmed', source: 'OpenStreetMap', country: 'Japan', locality: 'Osaka' };
  // A generic listing name never matches ("Sushi Circle Restaurant 1F" ≠ "Sushi Restaurant").
  assert.equal(decideListing({ ...osaka, name: 'Sushi Circle Restaurant 1F', lat: 34.6639, lon: 135.5032 }, [g('x', 'Sushi Restaurant', 'Japan, Osaka, Chuo Ward, Nanbasennichimae', 34.6639, 135.5032, ['sushi_restaurant', 'restaurant'])]).status, 'none');
  // The Reel's "Shinsaibashi Sushi Ume" is Google's "Ume Shinsaibashi Sushi Omakase restaurant", not another Shinsaibashi sushi bar.
  const near = [
    g('akasu', 'Sushi Akasu Shinsaibashi', 'Japan, Osaka, Chuo Ward, Shinsaibashisuji, 2-chōme−3−２', 34.6735, 135.5010, ['sushi_restaurant', 'restaurant']),
    g('en', 'Ume Shinsaibashi Sushi Omakase restaurant', 'Japan, Osaka, Chuo Ward, Higashishinsaibashi, 2-chōme−5−２１', 34.6712, 135.5045, ['sushi_restaurant', 'restaurant']),
    g('hase', 'Sushi Hasegawa – Shinsaibashi Main Branch', 'Japan, Osaka, Chuo Ward, Higashishinsaibashi, 1-chōme−16−２０', 34.6740, 135.5040, ['sushi_restaurant', 'restaurant']),
  ];
  const m = decideListing({ ...osaka, confidence: 'approximate', source: 'OpenAI estimate', name: 'Shinsaibashi Sushi Ume', lat: 34.672, lon: 135.502 }, near);
  assert.equal(m.status === 'matched' && m.cand.googlePlaceId, 'en', JSON.stringify(m));
  // A neighbourhood in the pin name may come from the listing's address ("Grill Ben" in Ginza).
  const gb = decideListing({ ...osaka, locality: 'Tokyo', confidence: 'approximate', source: 'OpenAI estimate', name: 'Shinkai Grill Ben Ginza', lat: 35.6721, lon: 139.7658 }, [g('bon', 'Grill Ben', 'Japan, 〒104-0061 Tokyo, Chuo City, Ginza, 7-chōme−14−１', 35.6680, 139.7620, ['restaurant'])]);
  assert.equal(gb.status, 'matched');
  // Transliteration differences still match ("Kel Tor" ≈ "Köl-Tor").
  const ks = decideListing({ category: 'lake', confidence: 'confirmed', source: 'OpenStreetMap', country: 'Kyrgyzstan', locality: 'Naryn', name: 'Kel Tor', lat: 40.95, lon: 75.62 }, [g('ks', 'Köl-Tor', 'Kyrgyzstan', 40.97, 75.63, ['natural_feature'])]);
  assert.equal(ks.status, 'matched');
});

test('sync-only desktop mirror: copies finished pins from the hosted app, keeps the My Maps bookkeeping, never touches the desktop DB', async () => {
  const { mirrorFromHosted } = await import('../src/remoteMirror.ts');
  const dir = tmpDir('mirror');
  const cfg = loadConfig({ dataDir: dir, inboxUrl: undefined, googlePlacesKey: undefined, openaiKey: undefined, instagramPageCaption: false });
  // Desktop DB: an existing real map + pin A (later removed on Railway) + pin "aiest:35.69,139.70".
  const local = new Store(cfg.dbPath); seed(local);
  local.upsertPlace({ place_id: 'osm:node:A', name: 'Removed later', category: 'cafe', kind: 'point', lat: 1, lon: 1, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'OpenStreetMap', address: null, google_place_id: null });
  local.setKv('map:real:all', 'MAP123'); local.setKv('layerhash:MAP123:🇯🇵 Japan', 'h1'); local.setKv('inbox_cursor', '44');
  const localBefore = local.dataVersion(); local.close();
  // Hosted DB: the same pin plus a new one; A is gone.
  const hosted = new Store(':memory:'); seed(hosted);
  hosted.addShare({ intake_id: 'i9', reel_key: 'ig:NEW', url: 'https://www.instagram.com/reel/NEW/', shortcode: 'NEW', raw_text: null, input_types: null, shared_at: '2026-11-11T10:00:00Z', note: null });
  hosted.upsertPlace({ place_id: 'gplace:X', name: 'New Café', category: 'cafe', kind: 'point', lat: 35.7, lon: 139.7, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'Google Maps', address: null, google_place_id: 'X' });
  hosted.linkReelPlace({ reel_key: 'ig:NEW', place_id: 'gplace:X', cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
  const file = path.join(dir, 'hosted.sqlite'); hosted.db.exec(`VACUUM INTO '${file}'`); hosted.close();
  const calls: string[] = [];
  const fakeFetch = (async (u: string, init: any) => { calls.push(`${u} ${init?.headers?.['x-token']}`); return new Response(fs.readFileSync(file)); }) as any;
  const m = await mirrorFromHosted(cfg, { url: 'https://hosted.example/', token: 'tok', fetch: fakeFetch });
  try {
    assert.deepEqual(calls, ['https://hosted.example/api/admin/backup tok']);
    assert.equal(m.seeded, true); assert.equal(m.places, 2); assert.equal(m.reels, 2);
    assert.deepEqual(m.retracted, ['osm:node:A']);
    assert.equal(m.store.getKv('map:real:all'), 'MAP123', 'same My Map reused'); assert.equal(m.store.getKv('layerhash:MAP123:🇯🇵 Japan'), 'h1');
    assert.equal(m.store.getKv('inbox_cursor'), undefined, 'no inbox state: the mirror never pulls');
    assert.ok(m.store.getKv('retracted:rm:osm:node:A'));
    assert.equal(m.store.linksForPlace('aiest:35.69,139.70')[0]!.cue, 'Caption: "best yakiniku"', 'links with cue copied');
  } finally { m.store.close(); }
  const again = new Store(cfg.dbPath); try { assert.equal(again.dataVersion(), localBefore, 'desktop DB untouched'); } finally { again.close(); }
  // Second run: bookkeeping stays, nothing new retracted.
  const m2 = await mirrorFromHosted(cfg, { url: 'https://hosted.example', token: 'tok', fetch: fakeFetch });
  try { assert.equal(m2.seeded, false); assert.deepEqual(m2.retracted, []); assert.equal(m2.places, 2); } finally { m2.store.close(); }
  await assert.rejects(mirrorFromHosted(cfg, { url: 'https://hosted.example', token: 'bad', fetch: (async () => new Response('{"ok":false}', { status: 401 })) as any }), /HTTP 401/);
});
