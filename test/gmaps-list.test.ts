import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/db.ts';
import { connectGmaps, eligiblePlaces, gmapsCycle, gmapsStatus } from '../src/sync/savedListRunner.ts';
import { tmpDir } from './support.ts';

const session = { cookies: [{ name: 'SID', value: 'x', domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };

function setup() {
  const dir = tmpDir('gmaps');
  const s = new Store(path.join(dir, 'db.sqlite'));
  const pin = (key: string, id: string, name: string, extra: Record<string, unknown> = {}) => {
    s.addShare({ intake_id: `i-${key}`, reel_key: key, url: `https://www.instagram.com/reel/${key}/`, shortcode: key, raw_text: null, input_types: null, shared_at: '2026-11-12T08:00:00Z', note: null, collection_id: 1, user_id: null } as any);
    s.upsertPlace({ place_id: id, name, category: 'restaurant', kind: 'point', lat: 13.75, lon: 100.5, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'Google Maps', address: '1 Example Rd, Bangkok', google_place_id: null, ...extra } as any);
    s.linkReelPlace({ reel_key: key, place_id: id, cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
    s.setReelResult(key, { status: 'resolved', reason: 'ok' });
  };
  return { dir, s, pin };
}

test('Google Maps list, fresh start: only Reels received after the first connection are saved (never the old ones, also after reconnecting, re-processing or a stale queue row); each listing once; branch mismatch waits for review; expired sign-in is visible', async () => {
  const { dir, s, pin } = setup();
  const ago = (k: string) => s.db.prepare("UPDATE reels SET created_at='2026-11-01T00:00:00.000Z' WHERE reel_key=?").run(k);
  // Before connecting: verified places from older Reels (like the 46 in the live collection).
  pin('OLD1', 'gplace:O1', 'Old Ramen', { google_place_id: 'O1' }); ago('OLD1');
  pin('OLD2', 'gplace:O2', 'Old Cafe', { google_place_id: 'O2' }); ago('OLD2');
  assert.deepEqual(eligiblePlaces(s, 1), [], 'nothing is eligible before an account is connected');

  // Connecting stores the session privately (never in the database) and fixes the cutoff.
  const id = connectGmaps(s, dir, { collectionId: 1, userId: 7, state: session });
  const cutoff = (gmapsStatus(s, 1) as any).cutoff_at;
  assert.ok(cutoff);
  const d = s.db.prepare('SELECT * FROM gmaps_destinations WHERE id=?').get(id) as any;
  assert.ok(fs.existsSync(d.state_file)); assert.ok(d.state_file.includes(path.join('private', 'gmaps')));
  assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM gmaps_destinations').all()).includes('SID'), false);
  assert.throws(() => connectGmaps(s, dir, { collectionId: 1, userId: 7, state: { cookies: [] } }), /not a Google browser session/);
  assert.deepEqual(eligiblePlaces(s, 1), [], 'old Reels stay out after connecting');

  // After connecting: new Reels.
  pin('R1', 'gplace:G1', 'Noodle Shop', { google_place_id: 'G1' });
  pin('R2', 'gplace:G2', 'Chain Cafe Riverside', { google_place_id: 'G2' });
  pin('R3', 'osm:node:3', 'Hill Cafe', { confidence: 'approximate', source: 'OpenStreetMap · approximate: ambiguous' });
  pin('R4', 'osm:node:4', 'No Listing Bar');
  pin('R5', 'gplace:G5', 'Open Question Grill', { google_place_id: 'G5' });
  s.replaceCandidates('R5', [{ ref: 'gplace:G6', name: 'Open Question Grill 2', displayName: 'x', lat: 0, lon: 0, category: 'restaurant', isArea: false, isRoute: false, names: [], replacesPlaceId: 'gplace:G5' } as any]);
  s.setReelResult('R5', { status: 'needs_review', reason: 'Which Google Maps listing…' });
  // An old Reel re-processed after connecting (new link, new pin) is still an old Reel.
  s.upsertPlace({ place_id: 'gplace:O3', name: 'Old Reel New Pin', category: 'restaurant', kind: 'point', lat: 13.7, lon: 100.5, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'Google Maps', address: 'x', google_place_id: 'O3' } as any);
  s.linkReelPlace({ reel_key: 'OLD1', place_id: 'gplace:O3', cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
  assert.deepEqual(eligiblePlaces(s, 1).map((p) => p.google_place_id).sort(), ['G1', 'G2'], 'approximate, no-listing, open-question and old-Reel pins are not saved');
  // A stale queue row for an old place (e.g. from an earlier version) is set aside, never saved.
  s.db.prepare("INSERT INTO gmaps_saves(destination_id, google_place_id, place_id, name, status, updated_at) VALUES (?, 'O2', 'gplace:O2', 'Old Cafe', 'pending', ?)").run(id, new Date().toISOString());

  const lists = new Map<string, Set<string>>(); let signedIn: boolean | null = true; let current = '';
  const ops = {
    openListing: async (_p: any, t: any) => { current = t.googlePlaceId; const branchOk = t.googlePlaceId !== 'G2'; return { url: '', title: t.name, address: '1 Example Rd', nameMatch: 1, branchOk, why: branchOk ? 'name and branch match' : 'the address does not match the expected branch' }; },
    readSaveState: async () => ({ signedIn, saveButton: 'Save', saved: false }),
    saveToList: async (_p: any, name: string) => { const l = lists.get(name) ?? new Set<string>(); lists.set(name, l); const already = l.has(current); l.add(current); return { saved: true, already, created: false, detail: 'saved' }; },
  } as any;
  const launch = async () => ({ page: {}, save: async () => {}, close: async () => {} });
  const r1 = await gmapsCycle(s, launch, { ops });
  assert.deepEqual(r1, { saved: 1, failed: 0, skipped: 1 });
  assert.deepEqual([...lists.get('Reelocations')!], ['G1']);
  assert.equal((s.db.prepare("SELECT status FROM gmaps_saves WHERE google_place_id='O2'").get() as any).status, 'excluded');
  // Second pass: nothing is saved twice.
  assert.deepEqual(await gmapsCycle(s, launch, { ops }), { saved: 0, failed: 0, skipped: 0 });
  const st = gmapsStatus(s, 1) as any;
  assert.equal(st.counts.verified, 1); assert.equal(st.counts.skipped, 1); assert.equal(st.counts.excluded, 1);

  // A new verified pin while the session has expired: the destination says so; the item stays pending.
  pin('R6', 'gplace:G7', 'Late Noodles', { google_place_id: 'G7' });
  signedIn = false;
  await gmapsCycle(s, launch, { ops });
  assert.equal((gmapsStatus(s, 1) as any).status, 'needs_signin');
  // Reconnecting resumes it and keeps the original cutoff; the old places still stay out.
  // The page often shows neither a Sign-in button nor the avatar (unknown): the Save click decides, so it proceeds.
  connectGmaps(s, dir, { collectionId: 1, userId: 7, state: session }); signedIn = null as any;
  assert.equal((gmapsStatus(s, 1) as any).cutoff_at, cutoff, 'reconnecting never moves the cutoff');
  const r3 = await gmapsCycle(s, launch, { ops });
  assert.equal(r3.saved, 1);
  assert.deepEqual([...lists.get('Reelocations')!].sort(), ['G1', 'G7']);
  // Disconnect + connect again (new destination row): still the same cutoff, still no old places.
  const { disconnectGmaps } = await import('../src/sync/savedListRunner.ts');
  disconnectGmaps(s, 1); connectGmaps(s, dir, { collectionId: 1, userId: 7, state: session });
  assert.equal((gmapsStatus(s, 1) as any).cutoff_at, cutoff);
  await gmapsCycle(s, launch, { ops });
  assert.ok(![...lists.get('Reelocations')!].some((g) => g.startsWith('O')), 'no old place was ever saved');
  s.close();
});

test('branch check: a chain\'s other branch 300 m away is refused; the right one, and a pin named differently from Google, pass', async () => {
  const { verifyBranch } = await import('../src/sync/savedList.ts');
  // Place cards read from Google Maps on 2026-11-12 (a well-known ramen chain, two branches in one district).
  const A = { title: 'ICHIRAN Shibuya', address: 'Japan, 〒150-0041 Tokyo, Shibuya, Jinnan, 1 Chome−22−7 岩本ビル B1F' };
  const B = { title: 'ICHIRAN Shibuya Spain-zaka', address: 'Japan, 〒150-0042 Tokyo, Shibuya, Udagawacho, 13−7 コヤスワン B1F' };
  const expA = { googlePlaceId: 'a', name: 'ICHIRAN Shibuya', address: 'ICHIRAN Shibuya, Japan, 〒150-0041 Tokyo, Shibuya, Jinnan, 1-chōme−22−７ 岩本ビル B1F', locality: 'Tokyo' };
  assert.equal(verifyBranch(A, expA).ok, true);
  assert.equal(verifyBranch(B, expA).ok, false);
  assert.equal(verifyBranch(B, { googlePlaceId: 'b', name: 'Ichiran Spain-zaka', address: 'ICHIRAN Shibuya Spain-zaka, Japan, 〒150-0042 Tokyo, Shibuya, Udagawachō, 13−７ コヤスワン B1F' }).ok, true, 'pin name from the Reel, Google name in the stored address');
  assert.equal(verifyBranch({ title: null, address: null }, expA).ok, false);
});

test('list entries in Google\'s Save menu are recognised by name (icon glyph, privacy and count glued on)', async () => {
  const { isListEntry } = await import('../src/sync/savedList.ts');
  // Read from the Save menu on Railway, 2026-11-12 (icon-font glyph first).
  assert.equal(isListEntry('\u{e896}ReelocationsPrivate · 1 place', 'Reelocations'), true);
  assert.equal(isListEntry('\u{e896}ReelocationsPrivate', 'Reelocations'), true);
  assert.equal(isListEntry('Reelocations', 'Reelocations'), true);
  assert.equal(isListEntry('\u{e87d}FavoritesPrivate', 'Reelocations'), false);
  assert.equal(isListEntry('\u{e866}Saved placesPrivate', 'Reelocations'), false);
  assert.equal(isListEntry('\u{e896}Reelocations 2Private', 'Reelocations'), true, 'a name followed by a space counts; Google does not allow two lists with the same name anyway');
  assert.equal(isListEntry('\u{e896}ReelocationsXPrivate', 'Reelocations'), false);
  assert.equal(isListEntry('\u{e896}My ReelocationsPrivate', 'Reelocations'), false);
});

test('branch check: the same restaurant with an OpenStreetMap address vs Google\'s short address passes; another house number does not', async () => {
  const { verifyBranch } = await import('../src/sync/savedList.ts');
  // Seen 2026-11-12: a noodle shop matched via OpenStreetMap, place card read from Google Maps.
  const t = { googlePlaceId: 'm', name: 'Menya Example SF', address: 'Menya Ramen, 418, Larkin Street, Lower Nob Hill, Tenderloin, San Francisco, California, 94102, United States', locality: 'San Francisco' };
  assert.equal(verifyBranch({ title: 'Menya Example SF', address: '418 Larkin St, San Francisco, CA 94102' }, t).ok, true);
  assert.equal(verifyBranch({ title: 'Menya Example SF', address: '1200 Larkin St, San Francisco, CA 94109' }, t).ok, false, 'another house number');
  assert.equal(verifyBranch({ title: 'Menya Example SF', address: '418 Market St, San Francisco, CA 94104' }, t).ok, false, 'same number, other street');
  // Single house number, Google address on both sides.
  assert.equal(verifyBranch({ title: 'Raan Jay Fai', address: '327 Maha Chai Rd, Samran Rat, Phra Nakhon, Bangkok 10200, Thailand' }, { googlePlaceId: 'z', name: 'Raan Jay Fai', address: '327 Maha Chai Rd, Samran Rat, Phra Nakhon, Bangkok 10200, Thailand', locality: 'Bangkok' }).ok, true);
});

test('branch check: a postal code is not a house number (Japanese address, OpenStreetMap vs Google)', async () => {
  const { verifyBranch } = await import('../src/sync/savedList.ts');
  // Seen 2026-11-12: a Kyoto steak house; OSM gives "1, Somecho", Google "Somecho, 7−1", both with 〒605-0802.
  const t = { googlePlaceId: 'k', name: 'Kobe Beef Steak Example Gion', address: 'Kobe Beef Steak Example Gion, 1, Somecho, 辰巳町, Higashiyama Ward, Kyoto, Kyoto Prefecture, 605-0802, Japan', locality: 'Kyoto' };
  assert.equal(verifyBranch({ title: 'Kobe Beef Steak Example Gion', address: 'Japan, 〒605-0802 Kyoto, Higashiyama Ward, Somecho, 7−1 祇園サンプルビル 1F' }, t).ok, true);
  assert.equal(verifyBranch({ title: 'Kobe Beef Steak Example Gion', address: 'Japan, 〒604-8005 Kyoto, Nakagyo Ward, Kiyamachi, 3−4' }, t).ok, false, 'another street');
});

test('Google Maps list: a save held back by the branch check appears in the Review Queue; "This is the listing" saves it, "None of these" keeps it out', async () => {
  const { dir, s, pin } = setup();
  connectGmaps(s, dir, { collectionId: 1, userId: 7, state: session });
  pin('Q1', 'gplace:H1', 'Corner Grill', { google_place_id: 'H1' });
  pin('Q2', 'gplace:H2', 'Harbour Cafe', { google_place_id: 'H2' });
  const lists = new Set<string>(); let current = '';
  const ops = {
    openListing: async (_p: any, t: any) => { current = t.googlePlaceId; return { url: '', title: t.name, address: '9 Other Rd', nameMatch: 1, branchOk: false, why: 'the address "9 Other Rd" does not match the expected branch' }; },
    readSaveState: async () => ({ signedIn: null, saveButton: 'Save', saved: false }),
    saveToList: async () => { lists.add(current); return { saved: true, already: false, created: false, detail: 'saved' }; },
  } as any;
  const launch = async () => ({ page: {}, save: async () => {}, close: async () => {} });
  assert.deepEqual(await gmapsCycle(s, launch, { ops }), { saved: 0, failed: 0, skipped: 2 });
  // Both Reels now wait in the Review Queue with the listing to confirm and the reason.
  for (const k of ['Q1', 'Q2']) {
    assert.equal(s.getReel(k)!.status, 'needs_review');
    assert.match(s.getReel(k)!.status_reason!, /^Google Maps list: not saved yet/);
    const c = s.candidatesFor(k);
    assert.equal(c.length, 1); assert.equal(c[0]!.googlePlaceId, k === 'Q1' ? 'H1' : 'H2'); assert.ok(c[0]!.replacesPlaceId);
  }
  const { chooseCandidate, rejectListings } = await import('../src/review/actions.ts');
  // "This is the listing" → saved on the next cycle, without the automatic check; the Reel is resolved.
  await chooseCandidate(s, { geocoder: { search: async () => [] } } as any, 'Q1', 0);
  assert.equal(s.getReel('Q1')!.status, 'resolved');
  // "None of these" → never saved.
  rejectListings(s, 'gplace:H2', 1);
  assert.equal(s.getReel('Q2')!.status, 'resolved');
  const r = await gmapsCycle(s, launch, { ops });
  assert.equal(r.saved, 1);
  assert.deepEqual([...lists], ['H1']);
  await gmapsCycle(s, launch, { ops });
  assert.deepEqual([...lists], ['H1'], 'the rejected listing is never saved');
  assert.equal((s.db.prepare("SELECT status FROM gmaps_saves WHERE google_place_id='H2'").get() as any).status, 'excluded');
  s.close();
});
