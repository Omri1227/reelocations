import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.ts';
import { planGroups, syncGrouped, PLANNED_LAYERS, OTHER_LAYER, flagEmoji } from '../src/sync/grouped.ts';
import { FakeMyMapsAccount, tmpDir } from './support.ts';
import type { Category } from '../src/types.ts';

function seed(s: Store, id: string, name: string, cat: Category, cc: string | null, country: string | null, locality: string | null, reel = 'ig:R1') {
  s.addShare({ intake_id: `i-${reel}`, reel_key: reel, url: `https://www.instagram.com/reel/${reel.slice(3)}/`, shortcode: reel.slice(3), raw_text: null, input_types: 'url', shared_at: '2026-11-10T10:00:00+02:00', note: null });
  s.upsertPlace({ place_id: id, name, category: cat, kind: 'point', lat: 35, lon: 135, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'OpenStreetMap', address: null, google_place_id: null });
  s.linkReelPlace({ reel_key: reel, place_id: id, cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
  if (cc) s.setLocality(id, { country, country_code: cc, locality, region: null });
}
const out = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rm-grouped-'));

test('grouping: one map per country, one layer per city; a café in Kyoto keeps its café icon', () => {
  const s = new Store(':memory:');
  seed(s, 'osm:node:1', 'Kiyomizu-dera', 'temple', 'jp', 'Japan', 'Kyoto');
  seed(s, 'osm:node:2', '% Arabica', 'cafe', 'jp', 'Japan', 'Kyoto');
  seed(s, 'osm:node:3', 'Senso-ji', 'temple', 'jp', 'Japan', 'Tokyo');
  seed(s, 'osm:node:4', 'Torres del Ejemplo', 'nature_reserve', 'cl', 'Chile', 'Torres del Ejemplo');
  seed(s, 'osm:node:5', 'Somewhere', 'other', null, null, null);
  const { maps, waiting } = planGroups(s, { titlePrefix: 'Reels · ', layout: 'per-country' });
  assert.equal(waiting, 1, 'a place without its country/city lookup waits instead of landing in a temporary bucket');
  assert.deepEqual(maps.map((m) => m.title), [`Reels · ${flagEmoji('cl')} Chile`, `Reels · ${flagEmoji('jp')} Japan`]);
  const jp = maps.find((m) => m.countryCode === 'jp')!;
  assert.deepEqual(jp.layers.map((l) => [l.name, l.ids.length]), [['Kyoto', 2], ['Tokyo', 1]]);
  assert.match(jp.layers[0]!.kml, /<styleUrl>#icon-1534-795548<\/styleUrl>/, 'café icon inside the Kyoto layer');
  assert.match(jp.layers[0]!.kml, /<name>Kyoto<\/name>/, 'KML document name = layer name');
});

test('grouping: more than 8 cities → the 9th layer "Other places" (one slot stays free for the layer swap), and assignment is stable as places are added', () => {
  const s = new Store(':memory:');
  for (let i = 1; i <= 12; i++) seed(s, `osm:node:${i}`, `Spot ${i}`, 'viewpoint', 'it', 'Italy', `City ${String(i).padStart(2, '0')}`);
  const layers = planGroups(s, { titlePrefix: '', layout: 'per-country' }).maps[0]!.layers;
  assert.equal(layers.length, PLANNED_LAYERS);
  assert.equal(layers.at(-1)!.name, OTHER_LAYER); assert.equal(layers.at(-1)!.ids.length, 4, '9th–12th cities share the last layer');
  seed(s, 'osm:node:99', 'Spot 99', 'viewpoint', 'it', 'Italy', 'City 01');
  const again = planGroups(s, { titlePrefix: '', layout: 'per-country' }).maps[0]!.layers;
  assert.deepEqual(again.map((l) => l.name), layers.map((l) => l.name), 'no city changes layer when more places arrive');
});

test('grouped sync: creates country maps, verifies after reload, skips unchanged, survives a crash, refuses foreign items', async () => {
  const s = new Store(':memory:');
  seed(s, 'osm:node:1', 'Kiyomizu-dera', 'temple', 'jp', 'Japan', 'Kyoto');
  seed(s, 'osm:node:3', 'Senso-ji', 'temple', 'jp', 'Japan', 'Tokyo');
  const acct = new FakeMyMapsAccount();
  const o = { mode: 'test' as const, titlePrefix: 'TEST Reels · ', layout: 'per-country' as const, outDir: out(), autoCreate: true };
  const r1 = await syncGrouped(s, acct, o);
  assert.equal(r1.status, 'ok'); assert.equal(acct.created, 1);
  const map = [...acct.maps.values()][0]!;
  assert.equal(map.title, `TEST Reels · ${flagEmoji('jp')} Japan`);
  assert.deepEqual(map.layers.map((l) => l.name).sort(), ['Kyoto', 'Tokyo']);
  assert.equal((await syncGrouped(s, acct, o)).status, 'skipped', 'unchanged data → no Google write');
  // A new place in Kyoto rewrites only the Kyoto layer.
  seed(s, 'osm:node:2', '% Arabica', 'cafe', 'jp', 'Japan', 'Kyoto', 'ig:R2');
  const calls = acct.replaceCalls;
  assert.equal((await syncGrouped(s, acct, o)).status, 'ok');
  assert.equal(acct.replaceCalls - calls, 1, 'only the changed city layer is swapped');
  assert.equal(map.layers.find((l) => l.name === 'Kyoto')!.features.length, 2);
  // A crash mid-import leaves Google as it was; the next run completes; nothing duplicated.
  seed(s, 'osm:node:4', 'Fushimi Inari', 'temple', 'jp', 'Japan', 'Kyoto', 'ig:R3');
  acct.failNextReplace = true;
  assert.equal((await syncGrouped(s, acct, o)).status, 'failed');
  assert.equal(map.layers.find((l) => l.name === 'Kyoto')!.features.length, 2, 'old layer untouched after the crash');
  assert.equal((await syncGrouped(s, acct, o)).status, 'ok');
  assert.equal(map.layers.find((l) => l.name === 'Kyoto')!.features.length, 3);
  assert.equal(acct.created, 1, 'the existing country map is reused');
  // Someone adds a pin by hand to a managed layer → refuse, change nothing.
  map.layers.find((l) => l.name === 'Tokyo')!.features.push({ layer: 'Tokyo', name: 'my own pin', description: '', geometry: 'point' });
  seed(s, 'osm:node:5', 'Shibuya Crossing', 'architecture', 'jp', 'Japan', 'Tokyo', 'ig:R4');
  const blocked = await syncGrouped(s, acct, o);
  assert.equal(blocked.status, 'blocked'); assert.match((blocked as any).reason, /did not create/);
  assert.equal(map.layers.find((l) => l.name === 'Tokyo')!.features.length, 2, 'hand-made pin kept, nothing replaced');
});

test('grouped sync without auto-create: blocked with instructions, nothing written', async () => {
  const s = new Store(':memory:');
  seed(s, 'osm:node:1', 'Kiyomizu-dera', 'temple', 'jp', 'Japan', 'Kyoto');
  const acct = new FakeMyMapsAccount();
  const r = await syncGrouped(s, acct, { mode: 'real', titlePrefix: 'Reels · ', layout: 'per-country', outDir: out(), autoCreate: false });
  assert.equal(r.status, 'blocked'); assert.match((r as any).reason, /register-map jp/); assert.equal(acct.maps.size, 0);
});

test('an approximate area pin is hidden on the map once the same Reel has a confirmed exact place (kept in the DB)', () => {
  const s = new Store(':memory:');
  s.addShare({ intake_id: 'i-tdp', reel_key: 'ig:TDP', url: 'https://www.instagram.com/reel/TDP/', shortcode: 'TDP', raw_text: null, input_types: 'url', shared_at: '2026-11-10T15:46:00+02:00', note: null });
  s.upsertPlace({ place_id: 'approx:osm:relation:1', name: 'Torres del Ejemplo', category: 'area', kind: 'point', lat: -51, lon: -72.9, geometry_json: null, trailhead_json: null, confidence: 'approximate', source: 'OpenStreetMap', address: null, google_place_id: null });
  s.linkReelPlace({ reel_key: 'ig:TDP', place_id: 'approx:osm:relation:1', cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
  s.setLocality('approx:osm:relation:1', { country: 'Chile', country_code: 'cl', locality: 'Torres del Ejemplo', region: null });
  let ids = planGroups(s, { titlePrefix: '', layout: 'per-country' }).maps[0]!.ids;
  assert.deepEqual(ids, ['rm:approx:osm:relation:1'], 'shown while it is the only result');
  seed(s, 'osm:node:9', 'Cascada Ejemplo', 'waterfall', 'cl', 'Chile', 'Torres del Ejemplo', 'ig:TDP');
  ids = planGroups(s, { titlePrefix: '', layout: 'per-country' }).maps[0]!.ids;
  assert.deepEqual(ids, ['rm:osm:node:9'], 'the exact waterfall replaces the area pin on the map');
  assert.ok(s.getPlace('approx:osm:relation:1'), 'still in the database');
});

test('one-map layout (chosen 2026-11-10): one "Reels" map, one layer per country, city in the pin text, 9th+ → Other countries (one slot free for the swap)', async () => {
  const s = new Store(':memory:');
  const cs: [string, string][] = [['cl', 'Chile'], ['pe', 'Peru'], ['kg', 'Kyrgyzstan'], ['in', 'India'], ['tj', 'Tajikistan'], ['ar', 'Argentina'], ['jp', 'Japan'], ['pt', 'Portugal'], ['is', 'Iceland'], ['il', 'Israel'], ['fr', 'France']];
  cs.forEach(([cc, name], i) => seed(s, `osm:node:${i + 1}`, `Spot ${i + 1}`, 'viewpoint', cc, name, `Town ${i + 1}`, `ig:R${i + 1}`));
  const { maps } = planGroups(s, { titlePrefix: '', layout: 'one-map', mapTitle: 'Reels' });
  assert.equal(maps.length, 1); assert.equal(maps[0]!.title, 'Reels');
  const names = maps[0]!.layers.map((l) => l.name);
  assert.equal(names.length, PLANNED_LAYERS);
  assert.ok(names.includes(`${flagEmoji('cl')} Chile`)); assert.equal(names.at(-1), '🌍 Other countries');
  assert.equal(maps[0]!.layers.at(-1)!.ids.length, 3, 'the 9th–11th countries share the last layer');
  assert.match(maps[0]!.layers.find((l) => l.name.endsWith('Chile'))!.kml, /📍 Town 1, Chile/, 'city and country in the pin text');
  const acct = new FakeMyMapsAccount();
  const r = await syncGrouped(s, acct, { mode: 'real', titlePrefix: '', layout: 'one-map', mapTitle: 'Reels', outDir: out(), autoCreate: true });
  assert.equal(r.status, 'ok'); assert.equal(acct.maps.size, 1); assert.equal([...acct.maps.values()][0]!.title, 'Reels');
});

test('phone review buttons: page shows options for a Reel in review; a tap is queued in the Sheet and applied by the worker', async () => {
  const { AppsScriptEmulator } = await import('./support.ts');
  const { pullInbox, pushStatus, AppsScriptInbox } = await import('../src/intake/inbox.ts') as any;
  const { applyReviewDecisions } = await import('../src/review/apply.ts');
  const { Http } = await import('../src/util/http.ts');
  const emu = new AppsScriptEmulator('tok-0123456789abcdef'); await emu.listen();
  try {
    const s = new Store(':memory:');
    const http = new Http({ userAgent: 't', store: s, minIntervalMs: {} });
    const inbox = new AppsScriptInbox(http, emu.url, 'tok-0123456789abcdef');
    emu.post({ token: 'tok-0123456789abcdef', action: 'share', text: 'https://www.instagram.com/reel/REV01/', shared_at: '2026-11-10T20:00:00+02:00' });
    await pullInbox(s, inbox);
    s.setReelResult('ig:REV01', { status: 'needs_review', reason: '"Felsord": only a public-transport stop matches' });
    s.replaceCandidates('ig:REV01', [{ ref: 'osm:node:7', name: 'Felsort', displayName: 'Felsort, Rotenboden, Bergdorf, Liechtenstein', lat: 47.12, lon: 9.55, category: 'area', isArea: true, isRoute: false, names: ['Felsort'], clueText: 'Felsord' } as any]);
    await pushStatus(s, inbox);
    const html = emu.get({ k: 'tok-0123456789abcdef' });
    assert.match(html, /data-a="choose" data-v="osm:node:7"/); assert.match(html, /Type the place/); assert.match(html, /Not a place/);
    // The ✓ tap (google.script.run → reviewDecision) and a typed place.
    emu.ctx.reviewDecision('tok-0123456789abcdef', 'ig:REV01', 'https://www.instagram.com/reel/REV01/', 'choose', 'osm:node:7');
    assert.throws(() => emu.ctx.reviewDecision('wrong-token-0000000000', 'ig:REV01', '', 'nap', ''), /Not authorised/);
    assert.match(emu.get({ k: 'tok-0123456789abcdef' }), /decision sent/);
    await pullInbox(s, inbox);
    const deps = { geocoder: { search: async () => [] } } as any;
    assert.equal(await applyReviewDecisions(s, deps), 1);
    const links = s.linksForReel('ig:REV01') as any[];
    assert.equal(links.length, 1); assert.equal(links[0].name, 'Felsort'); assert.equal(links[0].decided_by, 'user');
    assert.equal(s.getReel('ig:REV01')!.status, 'resolved');
    assert.equal(await applyReviewDecisions(s, deps), 0, 'each decision is applied once');
  } finally { await emu.close(); }
});

test('full map (live 2026-11-11 "layer limit"): an obsolete country layer is deleted first, its places move to "Other countries", and the swap succeeds', async () => {
  const s = new Store(':memory:');
  const cs: [string, string][] = [['cl', 'Chile'], ['pe', 'Peru'], ['kg', 'Kyrgyzstan'], ['in', 'India'], ['tj', 'Tajikistan'], ['ar', 'Argentina'], ['jp', 'Japan'], ['pt', 'Portugal'], ['is', 'Iceland'], ['il', 'Israel']];
  cs.forEach(([cc, name], i) => seed(s, `osm:node:${i + 1}`, `Spot ${i + 1}`, 'viewpoint', cc, name, `Town ${i + 1}`, `ig:R${i + 1}`));
  // The map as the old planner left it: 9 country layers + "Other countries" = 10 = full.
  const g = new FakeMyMapsAccount();
  const id = await g.createMap('Reels');
  s.setKv('map:real:all', id);
  const kmlFeats = (n: number) => [{ rmId: `rm:osm:node:${n}`, name: `Spot ${n}`, description: '', layer: '' } as any];
  g.maps.get(id)!.layers = [...cs.slice(0, 9).map(([cc, name], i) => ({ name: `${flagEmoji(cc)} ${name}`, features: kmlFeats(i + 1) })), { name: '🌍 Other countries', features: kmlFeats(10) }];
  s.setKv(`layers:${id}`, JSON.stringify(g.maps.get(id)!.layers.map((l) => l.name)));
  const out = await syncGrouped(s, g, { mode: 'real', titlePrefix: '', layout: 'one-map', mapTitle: 'Reels', outDir: tmpDir('full'), autoCreate: true });
  assert.equal(out.status, 'ok', 'reason' in out ? out.reason : '');
  const planned = planGroups(s, { titlePrefix: '', layout: 'one-map', mapTitle: 'Reels' }).maps[0]!.layers.map((l) => l.name);
  const before = [...cs.slice(0, 9).map(([cc, name]) => `${flagEmoji(cc)} ${name}`), '🌍 Other countries'];
  assert.deepEqual(g.removed.sort(), before.filter((n) => !planned.includes(n)).sort(), 'exactly the layers the plan no longer uses are removed');
  assert.ok(g.removed.length >= 1);
  const layers = g.maps.get(id)!.layers;
  assert.equal(layers.length, PLANNED_LAYERS);
  assert.equal(layers.flatMap((l) => l.features).length, 10, 'every place is still on the map');
});

test('obsolete layer holding a place the plan does not have is kept (never lose a pin)', async () => {
  const s = new Store(':memory:');
  seed(s, 'osm:node:1', 'Spot 1', 'viewpoint', 'cl', 'Chile', 'Town 1', 'ig:R1');
  const g = new FakeMyMapsAccount(); const id = await g.createMap('Reels'); s.setKv('map:real:all', id);
  g.maps.get(id)!.layers = [{ name: '🇮🇸 Iceland', features: [{ rmId: 'rm:osm:node:404', name: 'Gone?', description: '', layer: '' } as any] }];
  s.setKv(`layers:${id}`, JSON.stringify(['🇮🇸 Iceland']));
  const out = await syncGrouped(s, g, { mode: 'real', titlePrefix: '', layout: 'one-map', mapTitle: 'Reels', outDir: tmpDir('keep'), autoCreate: true, allowRemoval: true });
  assert.equal(out.status, 'ok');
  assert.deepEqual(g.removed, []); assert.ok(g.maps.get(id)!.layers.some((l) => l.name === '🇮🇸 Iceland'));
});
