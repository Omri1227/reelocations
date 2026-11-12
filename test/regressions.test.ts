/** Bugs found in the 2026-11-12 review, each pinned down by a test. All names and data are made up. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/db.ts';
import { Accounts } from '../src/accounts.ts';
import { applyItem } from '../src/intake/inbox.ts';
import { processReel } from '../src/pipeline.ts';
import { connectGmaps, ensureGmapsTables } from '../src/sync/savedListRunner.ts';
import { chooseCandidate, guessReplaced } from '../src/review/actions.ts';
import { inCountry } from '../src/resolve/resolver.ts';
import { nameSimilarity } from '../src/util/text.ts';
import { extractClues } from '../src/extract/clues.ts';
import { tmpDir } from './support.ts';

const session = { cookies: [{ name: 'SID', value: 'x', domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };
const share = (s: Store, id: string, code: string, cid: number) => applyItem(s, { id, row: 0, kind: 'share', received_at: '2026-11-12T08:00:00Z', shared_at: '2026-11-12T08:00:00Z', text: `https://www.instagram.com/reel/${code}/` }, { collectionId: cid, userId: null }).reelKey!;
const people = (s: Store) => {
  const acc = new Accounts(s);
  const a = acc.upsertUser({ sub: 'g-a', email: 'a@example.com', name: 'Alice', picture: null } as any), b = acc.upsertUser({ sub: 'g-b', email: 'b@example.com', name: 'Bob', picture: null } as any);
  return { acc, a, b, col: acc.createCollection(a.id, 'Trips') };
};

test('a Reel in a collection other than the first still gets its caption looked up (namespaced key)', async () => {
  const s = new Store(':memory:');
  const key = share(s, 'i1', 'ABCDE', 2);
  assert.match(key, /^c2\/ig:/);
  let asked = 0;
  const deps: any = { store: s, workDir: tmpDir('rg'), resolve: { geocoder: { search: async () => [] } }, oembed: async () => { asked++; return { ok: true, source: 'oembed', caption: 'no place here' }; } };
  await processReel(deps, s.getReel(key)!);
  assert.equal(asked, 1);
  assert.equal(JSON.parse(s.getReel(key)!.capabilities_json!).url, 'ok');
});

test('"service unavailable" retries count up to the limit instead of repeating forever', async () => {
  const s = new Store(':memory:');
  const key = share(s, 'i1', 'TRAIL', 1);
  const area = { ref: 'osm:relation:1', name: 'Example Valley', displayName: 'Example Valley, Nowhere', lat: 10, lon: 10, category: 'park', isArea: false, isRoute: false, names: [], bbox: [9.9, 10.1, 9.9, 10.1] };
  const deps: any = { store: s, workDir: tmpDir('rg'), oembed: async () => ({ ok: true, source: 'oembed', caption: 'Hike in Example Valley\n📍 Sample Ridge Trail' }),
    resolve: { geocoder: { search: async (q: string) => (/Valley/.test(q) && !/Ridge/.test(q) ? [area] : []) }, routes: { findRoutes: async () => { throw Object.assign(new Error('overpass busy'), { name: 'NetworkError' }); }, routeGeometry: async () => null, waysGeometry: async () => null, trailheadNear: async () => null } } };
  const seen: number[] = [];
  for (let i = 0; i < 8; i++) { const r = s.getReel(key)!; const o = await processReel(deps, r); seen.push(s.getReel(key)!.attempts); if (o.status !== 'error') break; }
  // Five retries with a growing counter, then it parks in the Review Queue (before the fix: 1,1,1,… forever).
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 0]);
  assert.equal(s.getReel(key)!.status, 'needs_review');
});

test('Google Maps list session ends when its member leaves, is removed, or deletes the account; a new collection never inherits it', () => {
  const dir = tmpDir('rg-gm');
  const s = new Store(path.join(dir, 'db.sqlite')); ensureGmapsTables(s);
  const { acc, a, b, col } = people(s);
  acc.acceptInvitation(b.id, acc.createInvitation(a.id, col.id));
  const file = () => (s.db.prepare('SELECT state_file f FROM gmaps_destinations ORDER BY id DESC LIMIT 1').get() as any).f as string;
  const live = () => s.db.prepare('SELECT COUNT(*) n FROM gmaps_destinations WHERE disconnected_at IS NULL').get() as any;

  connectGmaps(s, dir, { collectionId: col.id, userId: b.id, state: session });
  const f1 = file(); assert.ok(fs.existsSync(f1));
  acc.leaveCollection(b.id, col.id);
  assert.equal(live().n, 0, 'the leaving member\'s Google session is disconnected'); assert.equal(fs.existsSync(f1), false);

  connectGmaps(s, dir, { collectionId: col.id, userId: a.id, state: session });
  const f2 = file();
  const r = acc.deleteAccount(a.id);
  assert.equal(r.deleted, 1);
  for (const f of new Set([f2])) fs.rmSync(f, { force: true }); // the server removes the files deleteAccount reports
  assert.equal((s.db.prepare('SELECT COUNT(*) n FROM gmaps_destinations').get() as any).n, 0);
  assert.equal(s.getKv(`gmaps:cutoff:${col.id}`), undefined);
  // The next collection may get the same id: it must start with nothing.
  const c = acc.upsertUser({ sub: 'g-c', email: 'c@example.com', name: 'Cara', picture: null } as any);
  const col2 = acc.createCollection(c.id, 'New');
  assert.equal((s.db.prepare('SELECT COUNT(*) n FROM gmaps_destinations WHERE collection_id=?').get(col2.id) as any).n, 0);
});

test('an invitation cannot be used again by a member who was removed', () => {
  const s = new Store(':memory:');
  const { acc, a, b, col } = people(s);
  const code = acc.createInvitation(a.id, col.id);
  acc.acceptInvitation(b.id, code);
  assert.equal(acc.acceptInvitation(b.id, code), col.id, 'opening the link again while a member is harmless');
  acc.removeMember(a.id, col.id, b.id);
  assert.throws(() => acc.acceptInvitation(b.id, code), /not valid|already used/);
});

test('Review Queue: replacing a pin also clears that pin\'s own open questions, so the Reel does not stay stuck', async () => {
  const s = new Store(':memory:');
  const key = share(s, 'i1', 'REPL', 1);
  s.upsertPlace({ place_id: 'osm:node:1', name: 'Sample Diner', category: 'restaurant', kind: 'point', lat: 10, lon: 10, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'OpenStreetMap', address: null, google_place_id: null } as any);
  s.linkReelPlace({ reel_key: key, place_id: 'osm:node:1', cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
  const c = (ref: string, name: string, extra: Record<string, unknown> = {}) => ({ ref, name, displayName: name, lat: 10.2, lon: 10.2, category: 'restaurant', isArea: false, isRoute: false, names: [], ...extra });
  s.replaceCandidates(key, [c('osm:node:2', 'Example Bistro', { clueText: 'Example Bistro' }), c('gplace:L1', 'Sample Diner (listing)', { replacesPlaceId: 'osm:node:1', googlePlaceId: 'L1', clueText: 'Which Google Maps listing is Sample Diner?' })] as any);
  s.setReelResult(key, { status: 'needs_review', reason: 'open' });
  await chooseCandidate(s, { geocoder: { search: async () => [] } } as any, key, 0, { replace: 'osm:node:1' });
  assert.deepEqual((s.linksForReel(key) as any[]).map((l) => l.place_id), ['osm:node:2']);
  assert.deepEqual(s.candidatesFor(key), []);
  assert.equal(s.getReel(key)!.status, 'resolved');
});

test('Review Queue: an option for another place the Reel lists is pre-selected as an addition, not as a replacement of the only pin', () => {
  const s = new Store(':memory:');
  const key = share(s, 'i1', 'TWO', 1);
  s.upsertPlace({ place_id: 'osm:node:1', name: 'Sample Diner', category: 'restaurant', kind: 'point', lat: 10, lon: 10, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'OpenStreetMap', address: null, google_place_id: null } as any);
  s.linkReelPlace({ reel_key: key, place_id: 'osm:node:1', cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
  s.setReelResult(key, { status: 'needs_review', reason: 'open', evidence: { clues: [{ text: 'Sample Diner', explicit: true, kind: 'place' }, { text: 'Example Bistro', explicit: true, kind: 'place' }] } });
  const far = { ref: 'osm:node:2', name: 'Example Bistro Uptown', lat: 10.5, lon: 10.5, names: [], clueText: 'Example Bistro' } as any;
  assert.equal(guessReplaced(s, key, far), null);
  // A place you searched yourself (not one of the Reel's own listed names) still replaces the only pin by default.
  assert.equal(guessReplaced(s, key, { ...far, clueText: 'my own search' }), 'osm:node:1');
});

test('country names in different spellings are the same country; short CJK names match and are extracted', () => {
  assert.ok(inCountry('1 Example St, Springfield, IL 62701, USA', 'United States'));
  assert.ok(inCountry('Example Tower, London, UK', 'United Kingdom'));
  assert.ok(inCountry('日本、〒100-0001 東京都千代田区', 'Japan'));
  assert.equal(inCountry('Museum of Sample, Austin, Texas', 'US'), false, '"us" inside a word is not the country');
  assert.equal(inCountry('Example Platz, Wien, Austria', 'Australia'), false);
  assert.ok(nameSimilarity('見本山', '見本山 Mount Example') >= 0.8);
  const names = (text: string) => extractClues([{ source: 'caption', text }]).clues.map((c) => c.text);
  assert.deepEqual(names('📍 京都'), ['京都']);
  assert.deepEqual(names('1. 見本寺\n2. 例示神社'), ['見本寺', '例示神社']);
});
