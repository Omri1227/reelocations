import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShare, displayDate, normalizeSharedAt } from '../src/intake/parse.ts';
import { extractClues } from '../src/extract/clues.ts';
import { nameSimilarity } from '../src/util/text.ts';
import { mergeLines, simplify, fitLines } from '../src/geo/geometry.ts';
import { Store } from '../src/db.ts';
import { Budget, HARD_MONTHLY_CEILING_USD } from '../src/budget.ts';
import { buildSnapshot, parseKml } from '../src/sync/kml.ts';
import { decide, scoreCandidate, pickCue } from '../src/resolve/resolver.ts';
import { describeFrames } from '../src/media/vision.ts';
import { AppsScriptEmulator } from './support.ts';
import type { Candidate, Clue } from '../src/types.ts';

test('share parsing: bare URL, text with URL, tracking params, /reels/ and /p/ forms', () => {
  const a = parseShare('https://www.instagram.com/reel/C9xYz123AbC/?igsh=MWQ1ZGUxMzBkMA==');
  assert.equal(a.url, 'https://www.instagram.com/reel/C9xYz123AbC/');
  assert.equal(a.reelKey, 'ig:C9xYz123AbC');
  const b = parseShare('Check out this reel by someone https://instagram.com/reels/C9xYz123AbC?utm_source=ig_web');
  assert.equal(b.reelKey, 'ig:C9xYz123AbC');
  assert.equal(b.extraText, 'Check out this reel by someone');
  assert.equal(parseShare('https://www.instagram.com/someuser/reel/C9xYz123AbC/').reelKey, 'ig:C9xYz123AbC');
  assert.equal(parseShare('https://www.instagram.com/p/DAbCdEf1234/').reelKey, 'ig:DAbCdEf1234');
  const c = parseShare('https://maps.app.goo.gl/abc?si=xyz');
  assert.equal(c.isInstagram, false); assert.match(c.reelKey, /^url:/);
  assert.equal(parseShare('no url here', 'share:1').reelKey, 'share:1');
  assert.equal(displayDate('2026-11-09T18:22:05+02:00'), '2026-11-09 18:22');
});

test('clue extraction: pin tag with area, lists, trails, vantage vs featured, generic hashtags ignored', () => {
  const v = extractClues([{ source: 'caption', text: '📍 Café Xoho, Tel Aviv — best flat white in town' }]);
  assert.deepEqual(v.clues.find((c) => c.kind === 'place')?.text, 'Café Xoho');
  assert.equal(v.clues.find((c) => c.kind === 'place')?.area, 'Tel Aviv');
  const t = extractClues([{ source: 'caption', text: 'Sunrise hike on the Nahal David trail in Ein Gedi Nature Reserve.' }]);
  assert.equal(t.clues.find((c) => c.text === 'Nahal David')?.kind, 'trail');
  assert.ok(t.isHike);
  const m = extractClues([{ source: 'caption', text: '3 gems in Lisbon:\n1. Miradouro da Senhora do Monte – sunset\n2. Praia da Ursa – wild beach' }]);
  assert.deepEqual(m.clues.filter((c) => c.kind !== 'area').map((c) => c.text).sort(), ['Miradouro da Senhora do Monte', 'Praia da Ursa']);
  const vf = extractClues([{ source: 'caption', text: 'The view of Banias Waterfall from the Hermon Stream lookout' }]);
  assert.equal(vf.clues.find((c) => c.text === 'Banias Waterfall')?.role, 'featured');
  assert.equal(vf.clues.find((c) => c.text.startsWith('Hermon'))?.role, 'vantage');
  assert.equal(extractClues([{ source: 'caption', text: 'Golden hour vibes ✨ #nature #israel #sunset' }]).clues.length, 0);
});

test('name similarity handles transliteration synonyms but not unrelated names', () => {
  assert.ok(nameSimilarity('Nahal David', 'Wadi David') >= 0.99);
  assert.ok(nameSimilarity('Praia da Ursa', 'Ursa Beach') >= 0.99);
  assert.ok(nameSimilarity('Café Xoho', 'Xoho Chinese Cafe') >= 0.9);
  assert.ok(nameSimilarity('Nahal David', 'Nahal Arugot') < 0.6);
});

test('decide(): far ambiguity, outside-area, vision-only and area results never auto-confirm; near ambiguity is approximate', () => {
  const clue: Clue = { kind: 'place', text: 'Nahal David', sources: ['caption'], explicit: false, role: 'featured', evidence: '' };
  const mk = (ref: string, lat: number, extra: Partial<Candidate> = {}): Candidate => ({ ref, name: 'Nahal David', displayName: `Nahal David, ${ref}`, lat, lon: 35.38, category: 'park', isArea: false, isRoute: false, names: [], ...extra });
  // Two same-named places a few km apart: medium confidence → saved as APPROXIMATE and kept in review (2026-11-12).
  const two = [mk('a', 31.45), mk('b', 31.50)].map((c) => scoreCandidate(clue, c, []));
  const d2 = decide(clue, two);
  assert.equal(d2.confirmed?.ref, 'a'); assert.equal(d2.approximate, true); assert.equal(d2.review, true);
  // Far apart (different regions): never saved, only asked.
  const far = [mk('a', 31.45), mk('b', 32.95)].map((c) => scoreCandidate(clue, c, []));
  assert.equal(decide(clue, far).confirmed, undefined);
  const one = [mk('a', 31.45)].map((c) => scoreCandidate(clue, c, []));
  assert.equal(decide(clue, one).confirmed?.ref, 'a');
  const outside = [scoreCandidate(clue, mk('a', 13.9), [{ name: 'Ein Gedi', lat: 31.45, lon: 35.38, bbox: [31.40, 31.49, 35.33, 35.40] }])];
  assert.equal(decide(clue, outside).confirmed, undefined);
  const visionOnly = { ...clue, sources: ['vision' as const] };
  assert.equal(decide(visionOnly, [scoreCandidate(visionOnly, mk('a', 31.45), [])]).confirmed, undefined);
  assert.equal(decide(clue, [scoreCandidate(clue, mk('a', 31.45, { isArea: true }), [])]).confirmed, undefined);
});

test('memory cue is quoted, never invented', () => {
  const clue: Clue = { kind: 'place', text: 'Praia da Ursa', sources: ['caption'], explicit: true, role: 'listed', evidence: '2. Praia da Ursa – wild beach' };
  assert.equal(pickCue('Praia da Ursa', clue, [{ source: 'caption', text: '...' }], 2).cue, 'Caption: "2. Praia da Ursa – wild beach"');
  assert.equal(pickCue('Praia da Ursa', clue, [{ source: 'note', text: 'the viewpoint above the waterfall shown at the end' }], 1).cue, 'Your note: "the viewpoint above the waterfall shown at the end"');
  const bare: Clue = { ...clue, evidence: '', sources: ['manual'] };
  assert.equal(pickCue('Somewhere', bare, [{ source: 'caption', text: 'Nice day' }], 1).cue, null);
});

test('geometry: merge reversed segments and simplify within budget', () => {
  const merged = mergeLines([[[0, 0], [1, 0]], [[2, 0], [1, 0]], [[2, 0], [3, 1]]]);
  assert.equal(merged.length, 1); assert.equal(merged[0]!.length, 4);
  const line = Array.from({ length: 5000 }, (_, i) => [i * 1e-4, Math.sin(i / 50) * 1e-3] as [number, number]);
  assert.ok(simplify(line, 1e-4).length < line.length);
  assert.ok(fitLines([line], 300)[0]!.length <= 300);
});

test('store: idempotent shares, earliest share date kept, places only ever enriched', () => {
  const s = new Store(':memory:');
  const base = { reel_key: 'ig:A', url: 'https://www.instagram.com/reel/A/', shortcode: 'A', raw_text: 'x', input_types: 'url', note: null };
  assert.equal(s.addShare({ ...base, intake_id: '1', shared_at: '2026-11-09T18:00:00+02:00' }).inserted, true);
  assert.equal(s.addShare({ ...base, intake_id: '1', shared_at: '2026-11-09T18:00:00+02:00' }).inserted, false);
  s.addShare({ ...base, intake_id: '2', shared_at: '2026-11-10T09:00:00+02:00' });
  s.addShare({ ...base, intake_id: '0', shared_at: '2026-11-08T07:00:00Z' });
  assert.equal(s.getReel('ig:A')!.first_shared_at, '2026-11-08T07:00:00Z');
  assert.equal(s.sharesFor('ig:A').length, 3);
  const p = { place_id: 'osm:node:1', name: 'X', category: 'cafe' as const, kind: 'point' as const, lat: 1, lon: 2, geometry_json: null, trailhead_json: null, confidence: 'approximate' as const, source: 'OpenStreetMap', address: null, google_place_id: null };
  s.upsertPlace(p); s.upsertPlace({ ...p, confidence: 'confirmed' }); s.upsertPlace({ ...p, confidence: 'approximate' });
  assert.equal(s.getPlace('osm:node:1')!.confidence, 'confirmed');
});

test('budget gate: unknown price refused, caps and global ceiling enforced, worst case reserved', () => {
  const s = new Store(':memory:');
  const b = new Budget(s, { vision: 0.5 }, () => new Date('2026-11-09T10:00:00Z'));
  assert.equal(b.reserve('vision', undefined), null);
  assert.equal(b.reserve('unconfigured', 0.001), null);
  const r = b.reserve('vision', 0.4)!; assert.ok(r);
  assert.equal(b.reserve('vision', 0.2), null, 'would exceed provider cap');
  b.settle(r, 0.01);
  assert.ok(b.reserve('vision', 0.2));
  const g = new Budget(s, { big: 100 }, () => new Date('2026-11-09T10:00:00Z'));
  assert.equal(g.reserve('big', HARD_MONTHLY_CEILING_USD), null, 'global ceiling');
});

test('vision adapter: refused without budget, settles actual cost, suggestions parsed', async () => {
  const s = new Store(':memory:');
  const none = await describeFrames({ apiKey: 'x', model: 'claude-haiku-5-5', budget: new Budget(s, {}), frames: ['f.jpg'] });
  assert.ok('skipped' in none);
  const b = new Budget(s, { anthropic_vision: 0.5 });
  const fakeClient: any = { messages: { create: async (p: any) => { assert.equal(p.model, 'claude-haiku-5-5'); assert.equal(p.messages[0].content.length, 2); return { stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 50 }, content: [{ type: 'text', text: '{"visible_text":["Banias Waterfall"],"place_names":[]}' }] }; } } };
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const f = path.join(os.tmpdir(), 'reelmaps-frame.jpg'); fs.writeFileSync(f, Buffer.from([0xff, 0xd8, 0xff]));
  const r = await describeFrames({ apiKey: 'x', model: 'claude-haiku-5-5', budget: b, frames: [f], client: fakeClient });
  assert.deepEqual(r, { visibleText: ['Banias Waterfall'], placeNames: [] });
  assert.ok(Math.abs(b.spent('anthropic_vision') - (2000 * 0.1 + 50 * 0.5) / 1e6) < 1e-9);
});

test('KML snapshot round-trips ids, Reel link, share date and approximate label', () => {
  const s = new Store(':memory:');
  s.addShare({ intake_id: '1', reel_key: 'ig:A', url: 'https://www.instagram.com/reel/A/', shortcode: 'A', raw_text: '', input_types: '', shared_at: '2026-11-09T18:22:00+02:00', note: null });
  s.upsertPlace({ place_id: 'approx:osm:relation:1', name: 'Tel-Aviv', category: 'area', kind: 'point', lat: 32, lon: 34.8, geometry_json: null, trailhead_json: null, confidence: 'approximate', source: 'OpenStreetMap', address: null, google_place_id: null });
  s.linkReelPlace({ reel_key: 'ig:A', place_id: 'approx:osm:relation:1', cue: 'Caption: "somewhere by the sea"', cue_source: 'caption', role: 'featured', decided_by: 'auto' });
  const snap = buildSnapshot(s, 'Reels (auto)');
  const back = parseKml(snap.kml);
  assert.equal(back.length, 1);
  assert.equal(back[0]!.rmId, 'rm:approx:osm:relation:1');
  assert.match(back[0]!.name, /^≈ .*\(approx\.\)$/);
  assert.match(back[0]!.description, /APPROXIMATE/);
  assert.match(back[0]!.description, /https:\/\/www\.instagram\.com\/reel\/A\//);
  assert.match(back[0]!.description, /Shared: 2026-11-09 18:22/);
  assert.equal(buildSnapshot(s, 'Reels (auto)').hash, snap.hash, 'deterministic');
});

test('KML is in the shape My Maps imports with titles: no ExtendedData, category icon ids, <br> line breaks, ref id', () => {
  const s = new Store(':memory:');
  s.addShare({ intake_id: '1', reel_key: 'ig:A', url: 'https://www.instagram.com/reel/A/', shortcode: 'A', raw_text: '', input_types: '', shared_at: '2026-11-09T18:22:00+02:00', note: null });
  s.upsertPlace({ place_id: 'osm:node:1', name: 'Café <Noir> & Co', category: 'cafe', kind: 'point', lat: 32, lon: 34.8, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'OpenStreetMap', address: null, google_place_id: null });
  s.linkReelPlace({ reel_key: 'ig:A', place_id: 'osm:node:1', cue: 'Your note: "flat white"', cue_source: 'note', role: 'featured', decided_by: 'user' });
  s.upsertPlace({ place_id: 'osm:relation:2', name: 'Ridge trail', category: 'hike', kind: 'route', lat: 32.1, lon: 34.9, geometry_json: JSON.stringify([[[34.9, 32.1], [34.91, 32.11]]]), trailhead_json: JSON.stringify({ lat: 32.1, lon: 34.9, source: 'OSM' }), confidence: 'confirmed', source: 'OpenStreetMap', address: null, google_place_id: null });
  s.linkReelPlace({ reel_key: 'ig:A', place_id: 'osm:relation:2', cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
  const snap = buildSnapshot(s, 'Reels (auto)');
  assert.doesNotMatch(snap.kml, /<ExtendedData>/, 'ExtendedData makes My Maps blank the titles');
  const back = parseKml(snap.kml);
  const cafe = back.find((f) => f.rmId === 'rm:osm:node:1')!;
  assert.equal(cafe.name, '☕ Café <Noir> & Co');
  assert.equal(cafe.style, '#icon-1534-795548');
  assert.match(cafe.description, /Confirmed location<br>/);
  assert.match(cafe.description, /Café &lt;Noir&gt;|flat white/, 'text is HTML-escaped inside the <br> description');
  assert.equal(back.find((f) => f.rmId === 'rm:osm:relation:2#trailhead')!.style, '#icon-1597-C2185B');
  assert.equal(back.find((f) => f.rmId === 'rm:osm:relation:2')!.style, '#line-C2185B-4000');
  assert.match(snap.kml, /<Style id="icon-1597-C2185B">/);
});

test('Apps Script inbox (real Code.gs in emulator): token, idempotent share, pull cursor, media, status, index page', () => {
  const emu = new AppsScriptEmulator('tok-0123456789abcdef');
  assert.equal(emu.post({ token: 'wrong', action: 'share', text: 'x' }).ok, false);
  const s1 = emu.post({ token: 'tok-0123456789abcdef', action: 'share', text: 'https://www.instagram.com/reel/A/', shared_at: '2026-11-09T18:22:00+02:00' });
  const s2 = emu.post({ token: 'tok-0123456789abcdef', action: 'share', text: 'https://www.instagram.com/reel/A/', shared_at: '2026-11-09T18:22:00+02:00' });
  assert.equal(s1.id, s2.id); assert.equal(s2.duplicate, true);
  const m = emu.post({ token: 'tok-0123456789abcdef', action: 'media', data: Buffer.from('hello').toString('base64'), mime: 'image/png', filename: 'a.png' });
  assert.equal(m.ok, true);
  const pull = emu.post({ token: 'tok-0123456789abcdef', action: 'pull', after: 0 });
  assert.equal(pull.items.length, 2); assert.equal(pull.last, 2);
  assert.equal(emu.post({ token: 'tok-0123456789abcdef', action: 'pull', after: 2 }).items.length, 0);
  const got = emu.post({ token: 'tok-0123456789abcdef', action: 'media', id: pull.items[1].media_ref });
  assert.equal(Buffer.from(got.data, 'base64').toString(), 'hello');
  emu.post({ token: 'tok-0123456789abcdef', action: 'status', items: [{ reel_key: 'ig:A', url: 'https://www.instagram.com/reel/A/', shared_at: '2026-11-09T18:22:00+02:00', status: 'resolved', places: [{ name: 'A Brasileira', emoji: '☕', confidence: 'confirmed', maps_url: 'https://www.google.com/maps/search/?api=1&query=1,2', cue: 'Caption: "x"' }], updated_at: 'now' }] });
  const html = emu.get({ k: 'tok-0123456789abcdef' });
  assert.match(html, /href="https:\/\/www\.instagram\.com\/reel\/A\/"/);
  assert.match(html, /A Brasileira/);
  assert.equal(emu.get({ k: 'nope' }), 'Not authorised.');
});

test('review UI: renders queue with link + date, token-protected local intake, actions', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const { createApp } = await import('../src/app.ts');
  const { startReviewServer } = await import('../src/review/server.ts');
  const { tmpDir } = await import('./support.ts');
  const app = createApp(loadConfig({ dataDir: tmpDir('ui'), inboxToken: 'ui-token-0123456789abcdef', inboxUrl: undefined }), { media: null, fetch: async () => { throw new TypeError('offline'); } });
  const srv = startReviewServer(app, 0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const bad = await fetch(`${base}/api/intake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope', text: 'x' }) });
    assert.equal(bad.status, 403);
    const ok = await (await fetch(`${base}/api/intake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'ui-token-0123456789abcdef', text: 'https://www.instagram.com/reel/UIREEL01/', shared_at: '2026-11-09T18:22:00+02:00' }) })).json();
    assert.equal(ok.reelKey, 'ig:UIREEL01');
    app.store.setReelResult('ig:UIREEL01', { status: 'needs_review', reason: 'no explicit location clue in the available text' });
    const html = await (await fetch(base)).text();
    assert.match(html, /href="https:\/\/www\.instagram\.com\/reel\/UIREEL01\/"/);
    assert.match(html, /Shared 2026-11-09 18:22/);
    assert.match(html, /Needs attention \(1\)/);
    const r = await fetch(`${base}/act`, { method: 'POST', body: new URLSearchParams({ key: 'ig:UIREEL01', op: 'nap' }), redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(app.store.getReel('ig:UIREEL01')!.status, 'not_a_place');
    assert.equal(app.store.getReel('ig:UIREEL01')!.url, 'https://www.instagram.com/reel/UIREEL01/', 'kept with its link');
  } finally { srv.close(); await app.close(); }
});

test('sync: missing layer → blocked with setup instructions; unchanged data → skipped without a Google write', async () => {
  const { syncToMap } = await import('../src/sync/sync.ts');
  const { FakeMyMaps, tmpDir } = await import('./support.ts');
  const s = new Store(':memory:');
  s.addShare({ intake_id: '1', reel_key: 'ig:AAAAA', url: 'https://www.instagram.com/reel/AAAAA/', shortcode: 'AAAAA', raw_text: '', input_types: '', shared_at: '2026-11-09T18:22:00+02:00', note: null });
  s.upsertPlace({ place_id: 'osm:node:1', name: 'X', category: 'cafe', kind: 'point', lat: 1, lon: 2, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'OpenStreetMap', address: null, google_place_id: null });
  s.linkReelPlace({ reel_key: 'ig:AAAAA', place_id: 'osm:node:1', cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
  const out = tmpDir('sync');
  const noLayer = new FakeMyMaps('Reels (auto)', { createLayer: false });
  const r1 = await syncToMap(s, noLayer, { layerName: 'Reels (auto)', outDir: out });
  assert.equal(r1.status, 'blocked'); assert.equal(noLayer.replaceCalls, 0);
  const map = new FakeMyMaps('Reels (auto)');
  assert.equal((await syncToMap(s, map, { layerName: 'Reels (auto)', outDir: out, force: true })).status, 'ok');
  assert.equal((await syncToMap(s, map, { layerName: 'Reels (auto)', outDir: out })).status, 'skipped');
  assert.equal(map.replaceCalls, 1);
});

test('resolver: a trail named only by the vision model is never auto-confirmed, even if a route exists', async () => {
  const { resolveReel } = await import('../src/resolve/resolver.ts');
  const cand = { ref: 'osm:relation:9', name: 'Ein Gedi', displayName: 'Ein Gedi, Israel', lat: 31.45, lon: 35.38, category: 'park' as const, isArea: false, isRoute: false, names: [], bbox: [31.40, 31.49, 35.33, 35.40] as [number, number, number, number] };
  const deps: any = {
    geocoder: { search: async () => [cand] },
    routes: { findRoutes: async () => [{ type: 'relation', id: 5, name: 'Nahal David Trail', lat: 31.46, lon: 35.39 }], routeGeometry: async () => null, waysGeometry: async () => null, trailheadNear: async () => null },
  };
  const r = await resolveReel([{ source: 'vision', text: '📍 Nahal David Trail' }, { source: 'caption', text: 'Hike in Ein Gedi' }], deps);
  assert.ok(!r.links.some((l) => l.place.category === 'hike'), JSON.stringify(r.links.map((l) => l.place.name)));
});

test('share time from the iPhone: real values kept; time-only Shortcut output (year 0001) falls back to inbox receipt time', () => {
  const recv = '2026-11-10T12:53:11.236Z';
  assert.equal(normalizeSharedAt('2026-11-10T14:53:05+02:00', recv), '2026-11-10T14:53:05+02:00');
  assert.equal(normalizeSharedAt('0001-01-01T14:53:05+02:00', recv), recv);
  assert.equal(normalizeSharedAt('0001-01-01T14:53:05+02:20:54', recv), recv);
  assert.equal(normalizeSharedAt('2030-01-01T00:00:00Z', recv), recv);
  assert.equal(normalizeSharedAt('', recv), recv);
  const p = parseShare('https://www.instagram.com/reel/TESTSKARDU1/?exln=ZXhhbXBsZQ==');
  assert.equal(p.url, 'https://www.instagram.com/reel/TESTSKARDU1/'); assert.equal(p.reelKey, 'ig:TESTSKARDU1');
});

test('attachments from the iPhone carry no MIME type: the worker recognises JPEG, PNG, HEIC, MOV and MP4 from their bytes', async () => {
  const { sniffMime, mediaKind } = await import('../src/intake/inbox.ts');
  const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp' + brand, 'latin1'), Buffer.alloc(8)]);
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(sniffMime(ftyp('heic')), 'image/heic');
  assert.equal(sniffMime(ftyp('qt  ')), 'video/quicktime');
  assert.equal(sniffMime(ftyp('mp42')), 'video/mp4');
  assert.equal(sniffMime(Buffer.from('hello')), undefined);
  assert.equal(mediaKind('video/quicktime'), 'video'); assert.equal(mediaKind('image/heic'), 'image');
});

test('Spanish/Portuguese caption "… de <Two Capitalised Words>" yields an area clue; names like "Café de Flore" stay whole', () => {
  const k = (s: string) => extractClues([{ source: 'ocr', text: s }]).clues.map((c) => `${c.kind}:${c.text}:${c.explicit}`);
  assert.deepEqual(k('40 segundos de Torres del Ejemplo 4 “+ ... —'), ['area:Torres del Ejemplo:false']);
  assert.ok(!k('Café de Flore is lovely').some((c) => c.startsWith('area:Flore')));
  assert.deepEqual(k('foto de Juan'), []);
});

test('country → city grouping from real OSM reverse results: Tokyo wards merge, rural places get a readable locality', async () => {
  const { localityFromAddress } = await import('../src/geo/locality.ts');
  // Addresses as returned live by Nominatim /reverse?zoom=10&accept-language=en on 2026-11-10.
  const taito = localityFromAddress({ city: 'Taito', 'ISO3166-2-lvl4': 'JP-13', country: 'Japan', country_code: 'jp' });
  const shibuya = localityFromAddress({ city: 'Shibuya', 'ISO3166-2-lvl4': 'JP-13', country: 'Japan', country_code: 'jp' });
  assert.equal(taito.locality, 'Tokyo'); assert.equal(shibuya.locality, 'Tokyo'); assert.equal(taito.country, 'Japan');
  assert.equal(localityFromAddress({ city: 'Kyoto', province: 'Kyoto Prefecture', 'ISO3166-2-lvl4': 'JP-26', country: 'Japan', country_code: 'jp' }).locality, 'Kyoto');
  assert.equal(localityFromAddress({ city: 'Osaka', province: 'Osaka Prefecture', 'ISO3166-2-lvl4': 'JP-27', country: 'Japan', country_code: 'jp' }).locality, 'Osaka');
  assert.equal(localityFromAddress({ city: 'Galil Elyon Regional Council', state_district: 'Safed Subdistrict', state: 'North District', country: 'Israel', country_code: 'il' }).locality, 'Galil Elyon');
  const tdp = localityFromAddress({ city: 'Torres del Ejemplo', county: 'Provincia de Última Esperanza', state: 'Magallanes and Chilean Antarctica Region', country: 'Chile', country_code: 'cl' });
  assert.equal(tdp.locality, 'Torres del Ejemplo'); assert.equal(tdp.country_code, 'cl');
  assert.equal(localityFromAddress({ suburb: 'Santa Maria Maior', village: 'Madalena', city: 'Lisbon', county: 'Lisbon', country: 'Portugal', country_code: 'pt' }).locality, 'Lisbon');
  assert.equal(localityFromAddress({ state: 'Wadi Rum Protected Area', country: 'Jordan', country_code: 'jo' }).locality, 'Wadi Rum Protected Area', 'rural: falls back to the region');
});

test('multi-place: the same chain in two cities stays two clues; the same place repeated stays one', () => {
  const r = extractClues([{ source: 'ocr', text: '📍 Blue Bottle Coffee, Kyoto\n📍 Blue Bottle Coffee, Tokyo\n📍 Blue Bottle Coffee, Kyoto' }]);
  const places = r.clues.filter((c) => c.kind === 'place').map((c) => `${c.text}@${c.area}`);
  assert.deepEqual(places.sort(), ['Blue Bottle Coffee@Kyoto', 'Blue Bottle Coffee@Tokyo']);
});

test('AI estimate: no verifiable map match → approximate pin at the model\'s estimate (tight radius only), clearly labelled', async () => {
  const { resolveReel } = await import('../src/resolve/resolver.ts');
  const deps = { geocoder: { search: async () => [] } } as any;
  const base = { category: 'lake' as const, country: 'India', city: 'Ladakh', role: 'featured' as const, evidence: 'turquoise high-altitude lake with barren hills', timestamps: [], local_name: null, address: null };
  const ok = await resolveReel([], deps, { aiPlaces: [{ ...base, name: 'Pangong Tso', confidence: 'medium', lat: 33.75, lon: 78.67, radius_km: 15 }] });
  assert.equal(ok.links.length, 1); assert.equal(ok.links[0]!.place.confidence, 'approximate');
  assert.match(ok.links[0]!.place.place_id, /^aiest:/); assert.match(ok.links[0]!.cue ?? '', /AI estimate from the picture \(±15 km\)/);
  assert.equal(ok.status, 'resolved');
  const vague = await resolveReel([], deps, { aiPlaces: [{ ...base, name: 'Somewhere in Ladakh', confidence: 'medium', lat: 34, lon: 77.5, radius_km: 200 }] }); // > ±100 km
  assert.equal(vague.links.length, 0, 'a vague estimate (±200 km) stays off the map');
  const low = await resolveReel([], deps, { aiPlaces: [{ ...base, name: 'Pangong Tso', confidence: 'low', lat: 33.75, lon: 78.67, radius_km: 60 }] });
  assert.equal(low.links.length, 1, 'a rough guess (±60 km) is still pinned, as requested');
  assert.match(low.links[0]!.cue ?? '', /±60 km, rough guess/);
});

test('category: a place OSM only knows as a car park takes its category from its name (live 2026-11-11: Serranía de Ejemplo)', async () => {
  const { categoryFromOsm, refineGenericCategories } = await import('../src/categories.ts');
  assert.equal(categoryFromOsm('amenity', 'parking', { amenity: 'parking' }, 'Serranía de Ejemplo'), 'mountain');
  assert.equal(categoryFromOsm('amenity', 'parking', { amenity: 'parking' }, 'Mirador del Ejemplo'), 'viewpoint');
  assert.equal(categoryFromOsm('amenity', 'parking', { amenity: 'parking' }, 'Range Rover Car Park'), 'other', 'a name that says parking is not a scenery hint');
  assert.equal(categoryFromOsm('amenity', 'cafe', {}, 'Mount Café'), 'cafe', 'real tags win over the name');
  const { Store } = await import('../src/db.ts');
  const s = new Store(':memory:');
  s.upsertPlace({ place_id: 'osm:way:499204315', name: 'Serranía de Ejemplo', category: 'other', kind: 'point', lat: -23.2, lon: -65.2, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'OpenStreetMap', address: null, google_place_id: null });
  s.upsertPlace({ place_id: 'osm:node:9', name: 'Plaza Mayor', category: 'other', kind: 'point', lat: 1, lon: 1, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'OpenStreetMap', address: null, google_place_id: null });
  assert.deepEqual(refineGenericCategories(s.db).map((x) => [x.name, x.category]), [['Serranía de Ejemplo', 'mountain']]);
  assert.equal(s.getPlace('osm:node:9')!.category, 'other', 'no keyword in the name → unchanged');
});

test('quality: menu items, hours, feature bullets, suppliers and street addresses are not places; bracket and prefecture names are', async () => {
  const { extractClues } = await import('../src/extract/clues.ts');
  const t = (text: string) => extractClues([{ source: 'caption', text }]).clues;
  const names = (text: string) => t(text).filter((c) => c.kind !== 'area' && c.kind !== 'address').map((c) => c.text);
  assert.ok(!names('• Weekdays: 11:30 AM–3:00 PM\n• Wagyu Sushi – ¥1,200').length);
  assert.ok(!names('Dip Sauce Potato JPY 1,180 Drink Bar JPY 380').includes('Drink Bar'));
  assert.ok(!names('- Traditional ryokan stay with tatami rooms\n- Kaiseki dinner and Japanese breakfast included').length);
  assert.ok(!names('fresh seafood carefully selected from Minato Fish Market').includes('Minato Fish Market'));
  assert.equal(t('📍82-7 Somecho, Higashiyama-ku, Kyoto').find((c) => c.text.startsWith('82-7'))?.kind, 'address');
  assert.ok(names('Reservations available ✅ 【Gion Ushi Akari】').includes('Gion Ushi Akari'));
  const sh = t('📍 山里郷【岐阜】 Yamasato-go - Gifu').find((c) => c.text === '山里郷');
  assert.equal(sh?.area, '岐阜'); assert.deepEqual(sh?.aliases, ['Yamasato-go']);
  assert.equal(t('📍location:大分県-大船山🍁').find((c) => c.text === '大船山')?.area, '大分県');
  assert.ok(names('📍 Located in the heart of Namba—don’t miss this local Wagyu gem!').every((n) => !/miss|Located/.test(n)));
  assert.ok(names('Tongariro Alpine Crossing — 19.4 km across volcanic craters').includes('Tongariro Alpine Crossing'));
});

test('clues: a sentence after a pin emoji and a "their/our …" bullet are not place names; the name before a dash still is', () => {
  const names = (text: string) => extractClues([{ source: 'caption', text }]).clues.map((c) => c.text);
  assert.deepEqual(names('📌ぜひ保存して参考にしていただけると嬉しいです🍁'), []);
  assert.deepEqual(names('What you can expect:\n• Their signature Example Tendon\n• Our Famous Tasting Menu'), []);
  assert.deepEqual(names('📍 Example Lake — at 3,016 m the yurts are open from june to september and the road up is rough'), ['Example Lake']);
  assert.ok(names('📍見本公園｜長野').length === 1);
});

test('resolver: a leftover clue whose lookup leads back to a pin this Reel already has does not keep the Reel in review', async () => {
  const { resolveReel } = await import('../src/resolve/resolver.ts');
  const c = (ref: string, name: string, lat: number, lon: number) => ({ ref, name, displayName: `${name}, Tokyo, Japan`, lat, lon, category: 'restaurant' as const, isArea: false, isRoute: false, names: [] });
  const main = c('osm:node:1', 'Tendon Example Hanbei Tsukiji', 35.6655, 139.7707), other = c('osm:node:2', 'Tendon Example Hanbei Nihonbashi', 35.6840, 139.7745), diner = c('osm:node:3', 'Corner Diner', 35.70, 139.70);
  const deps: any = { geocoder: { search: async (q: string) => (/Hanbei/.test(q) ? [main] : /Edomae/.test(q) ? [other] : /Kitchen/.test(q) ? [diner] : []) } };
  // "Signature Edomae Tendon" is a dish; searching it finds another branch of the restaurant already pinned.
  const r = await resolveReel([{ source: 'caption', text: '📍 Tendon Example Hanbei Tsukiji\n• Signature Edomae Tendon' }], deps);
  assert.deepEqual(r.links.map((l) => l.place.name), ['Tendon Example Hanbei Tsukiji']);
  assert.equal(r.status, 'resolved', r.reason);
  assert.ok(r.notes.some((n) => n.includes('leads back to')));
  // A second listed name that leads somewhere else stays an open question.
  const open = await resolveReel([{ source: 'caption', text: '📍 Tendon Example Hanbei Tsukiji\n• Sample Kitchen Ueno' }], deps);
  assert.equal(open.status, 'needs_review', open.reason);
});
