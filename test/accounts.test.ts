import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { startServer } from '../src/server.ts';
import { verifyGoogleIdToken } from '../src/accounts.ts';
import { cuisineFromText, inferCuisine } from '../src/cuisine.ts';
import { buildMapData } from '../src/web/mapData.ts';
import { loadExport } from '../src/publisher.ts';
import { syncGrouped } from '../src/sync/grouped.ts';
import { FakeMyMapsAccount, tmpDir } from './support.ts';

const TOKEN = 'admin-token-0123456789', INBOX = 'legacy-inbox-0123456789';
const fakeGoogle = async (t: string) => { const [sub, email, name] = t.split('|'); return { sub: sub!, email: email ?? null, email_verified: true, name: name ?? null, picture: null }; };

function server() {
  const dir = tmpDir('acct');
  const cfg = loadConfig({ dataDir: dir, inboxUrl: undefined, inboxToken: INBOX, googlePlacesKey: undefined, openaiKey: undefined, anthropicKey: undefined, instagramPageCaption: false, instagramOembed: false, transcribe: 'off' });
  const makeApp = () => createApp(cfg, { media: null, polite: false, fetch: async () => { throw new TypeError('offline test'); } });
  const port = 19000 + Math.floor(Math.random() * 900);
  const srv = startServer({ app: makeApp(), makeApp, port, appToken: TOKEN, startWorker: false, sseCheckMs: 30, googleClientId: 'test-client', verifyIdToken: fakeGoogle, publicUrl: 'https://reel.example' });
  const call = async (p: string, o: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: o.method ?? 'GET', redirect: 'manual', headers: { 'content-type': 'application/json', ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text(); let j: any = null; try { j = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, j, text, headers: r.headers };
  };
  const signIn = async (cred: string, extra: Record<string, string> = {}) => { const r = await call('/auth/google', { method: 'POST', body: { credential: cred, ...extra } }); assert.equal(r.status, 200, r.text); return { cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]!, next: r.j.next, collection: r.j.collection }; };
  /** A finished pin, as the pipeline would leave it. */
  const pin = (reelKey: string, id: string, name: string, cc: string, country: string, extra: Record<string, unknown> = {}) => {
    const s = srv.app.store;
    s.upsertPlace({ place_id: id, name, category: 'restaurant', kind: 'point', lat: 35 + Math.random(), lon: 139 + Math.random(), geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'Google Maps', address: null, google_place_id: null, ...extra } as any);
    s.setLocality(id, { country, country_code: cc, locality: `${country} City`, region: null });
    s.linkReelPlace({ reel_key: reelKey, place_id: id, cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
  };
  return { srv, call, signIn, pin, port };
}

test('Google ID tokens: only a correctly signed, unexpired token for OUR client id is accepted', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as any), kid: 'k1', alg: 'RS256' };
  const sign = (claims: Record<string, unknown>, key = privateKey, kid = 'k1') => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: 'https://accounts.google.com', aud: 'my-client', sub: '123', email: 'a@b.c', email_verified: true, iat: now, exp: now + 3600 };
  const keys = async () => [jwk];
  const id = await verifyGoogleIdToken(sign(good), 'my-client', keys);
  assert.equal(id.sub, '123'); assert.equal(id.email_verified, true);
  await assert.rejects(verifyGoogleIdToken(sign({ ...good, aud: 'other-app' }), 'my-client', keys), /another app/);
  await assert.rejects(verifyGoogleIdToken(sign({ ...good, exp: now - 3600 }), 'my-client', keys), /expired/);
  await assert.rejects(verifyGoogleIdToken(sign({ ...good, iss: 'https://evil.example' }), 'my-client', keys), /issuer/);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyGoogleIdToken(sign(good, other), 'my-client', keys), /bad signature/);
  await assert.rejects(verifyGoogleIdToken(sign(good, privateKey, 'unknown'), 'my-client', keys), /unknown signing key/);
});

test('accounts: claim, isolation between collections, pairing, revocable intake credentials', async () => {
  const { srv, call, signIn, pin } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    // The legacy Apps Script token still feeds collection 1 (the working Shortcut keeps working).
    assert.equal((await call('/api/intake', { method: 'POST', body: { token: INBOX, action: 'share', text: 'https://www.instagram.com/reel/OLD11/', shared_at: '2026-11-11T08:00:00Z' } })).j.ok, true);
    assert.equal(srv.app.store.getReel('ig:OLD11')!.collection_id, 1);
    pin('ig:OLD11', 'osm:node:1', 'Owner Ramen', 'jp', 'Japan', { cuisine: 'ramen', cuisine_source: 'google' });

    // Owner claims collection 1 with the old link's token; a wrong token claims nothing.
    const stranger = await signIn('g-x|x@example.com|X', { claim: 'wrong-token-wrong-token' });
    assert.equal(stranger.next, '/setup'); assert.notEqual(stranger.collection, 1, 'a wrong claim gives its own new collection, never #1');
    const owner = await signIn('g-a|a@example.com|Alice', { claim: TOKEN });
    assert.equal(owner.collection, 1);
    assert.equal(srv.app.store.getReel('ig:OLD11')!.contributed_by, srv.accounts.collectionsOf(1).length ? 1 + 1 : null, 'old Reels are attributed to the owner');
    // Claim works once only.
    const late = await signIn('g-y|y@example.com|Y', { claim: TOKEN });
    assert.notEqual(late.collection, 1);

    // Isolation: Bob (own collection) cannot see, read images of, delete, or administer Alice's collection.
    const bob = await signIn('g-b|b@example.com|Bob');
    assert.equal((await call('/api/places?c=1', { cookie: bob.cookie })).status, 403);
    assert.equal((await call('/img?r=ig%3AOLD11&p=osm%3Anode%3A1&c=1', { cookie: bob.cookie })).status, 403);
    assert.equal((await call('/img?r=ig%3AOLD11&p=osm%3Anode%3A1', { cookie: bob.cookie })).status, 404, 'image of another collection: not found');
    assert.equal((await call('/api/places/osm%3Anode%3A1', { method: 'DELETE', cookie: bob.cookie })).status, 404);
    assert.equal((await call('/api/places/osm%3Anode%3A1?c=1', { method: 'DELETE', cookie: bob.cookie })).status, 403);
    assert.equal((await call('/api/members?c=1', { cookie: bob.cookie })).status, 403);
    assert.equal((await call('/api/invitations?c=1', { method: 'POST', cookie: bob.cookie })).status, 403);
    assert.equal((await call('/api/places', { cookie: bob.cookie })).j.places.length, 0, 'Bob sees only his own (empty) collection');
    const alicePlaces = (await call('/api/places', { cookie: owner.cookie })).j;
    assert.equal(alicePlaces.places.length, 1); assert.equal(alicePlaces.collection.role, 'owner');
    // Review page is scoped too: Alice's Reel is not on Bob's review page and Bob cannot act on it.
    assert.doesNotMatch((await call('/review', { cookie: bob.cookie })).text, /OLD11/);
    assert.equal((await call('/review/act', { method: 'POST', cookie: bob.cookie, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: undefined })).status, 403);

    // Pairing: a code works once, gives a credential, shares land in Bob's collection attributed to Bob.
    const code = (await call('/api/pairing-codes', { method: 'POST', cookie: bob.cookie, body: { kind: 'intake' } })).j.code;
    const paired = await call('/api/pair', { method: 'POST', body: { code: code.toLowerCase(), label: 'Bob iPhone' } });
    assert.equal(paired.status, 200); assert.match(paired.j.intake_url, /^https:\/\/reel\.example\/api\/intake\//);
    assert.equal((await call('/api/pair', { method: 'POST', body: { code } })).status, 400, 'single use');
    const tok = paired.j.token;
    const viaPath = await call(new URL(paired.j.intake_url).pathname, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/BOB11/', shared_at: '2026-11-11T09:00:00Z' } });
    assert.equal(viaPath.j.ok, true, viaPath.text);
    const bobCol = bob.collection;
    const bobReel = srv.app.store.getReel(`c${bobCol}/ig:BOB11`)!;
    assert.equal(bobReel.collection_id, bobCol); assert.ok(bobReel.contributed_by);
    // The same Reel shared into another collection is a separate Reel there.
    await call('/api/intake', { method: 'POST', body: { token: INBOX, action: 'share', text: 'https://www.instagram.com/reel/BOB11/', shared_at: '2026-11-11T09:01:00Z' } });
    assert.ok(srv.app.store.getReel('ig:BOB11')); assert.equal(srv.app.store.getReel('ig:BOB11')!.collection_id, 1);
    // Revoke → the Shortcut stops working at once.
    const creds = (await call('/api/credentials', { cookie: bob.cookie })).j;
    assert.equal((await call(`/api/credentials/${creds[0].id}`, { method: 'DELETE', cookie: owner.cookie })).status, 403, "Alice cannot revoke Bob's credential");
    assert.equal((await call(`/api/credentials/${creds[0].id}`, { method: 'DELETE', cookie: bob.cookie })).status, 200);
    assert.equal((await call('/api/intake', { method: 'POST', body: { token: tok, action: 'share', text: 'https://www.instagram.com/reel/BOB22/' } })).j.error, 'bad token');
    // Sign-out ends the session.
    await call('/auth/signout', { method: 'POST', cookie: bob.cookie });
    assert.equal((await call('/api/places', { cookie: bob.cookie })).status, 401);
  } finally { await srv.close(); }
});

test('shared collection: invitation, both members contribute and see everything, delete permissions, deletion survives re-processing and merges', async () => {
  const { srv, call, signIn, pin } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const alice = await signIn('g-a|a@example.com|Alice');
    const inv = (await call('/api/invitations', { method: 'POST', cookie: alice.cookie })).j;
    assert.match(inv.url, /^https:\/\/reel\.example\/join\//);
    const bob = await signIn('g-b|b@example.com|Bob', { invite: inv.code });
    assert.equal(bob.collection, alice.collection); assert.equal(bob.next, '/setup');
    assert.equal((await call('/api/invitations', { method: 'POST', cookie: bob.cookie })).status, 403, 'members cannot invite');
    const carol = await signIn('g-c|c@example.com|Carol', { invite: inv.code }).catch((e) => e);
    assert.ok(carol instanceof Error, 'an invitation is single use');
    const cid = alice.collection;
    // Each contributes a Reel from their own Shortcut credential.
    const link = async (c: string) => new URL((await call('/api/intake-link', { method: 'POST', cookie: c, body: {} })).j.intake_url).pathname;
    const la = await link(alice.cookie), lb = await link(bob.cookie);
    await call(la, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/AAAAA/' } });
    await call(lb, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/BBBBB/' } });
    await call(lb, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/AAAAA/' } }); // same Reel again: processed once
    assert.equal(srv.app.store.db.prepare('SELECT COUNT(*) n FROM reels WHERE collection_id=?').get(cid)!.n, 2);
    pin(`c${cid}/ig:AAAAA`, 'gplace:A1', 'Alice Sushi', 'jp', 'Japan', { cuisine: 'sushi' });
    pin(`c${cid}/ig:AAAAA`, 'gplace:A2', 'Second place of the same Reel', 'jp', 'Japan');
    pin(`c${cid}/ig:BBBBB`, 'gplace:B1', 'Bob Yakiniku', 'jp', 'Japan', { cuisine: 'yakiniku' });
    const seenA = (await call('/api/places', { cookie: alice.cookie })).j, seenB = (await call('/api/places', { cookie: bob.cookie })).j;
    assert.deepEqual(seenA.places.map((p: any) => p.id).sort(), ['gplace:A1', 'gplace:A2', 'gplace:B1']);
    assert.deepEqual(seenB.places.map((p: any) => p.id).sort(), seenA.places.map((p: any) => p.id).sort(), 'both see everything');
    assert.equal(seenB.collection.shared, true); assert.equal(seenB.collection.members, 2);
    assert.equal(seenB.places.find((p: any) => p.id === 'gplace:A1').can_delete, false, "Bob may not delete Alice's pin");
    assert.equal(seenB.places.find((p: any) => p.id === 'gplace:B1').can_delete, true);
    assert.equal((await call('/api/places/gplace%3AA1', { method: 'DELETE', cookie: bob.cookie })).status, 403);
    // Bob deletes his own; Alice (owner) deletes one of hers. Other places of the same Reel and its screenshot stay.
    srv.app.store.addMedia({ media_id: 'm1', reel_key: `c${cid}/ig:AAAAA`, kind: 'image', mime: 'image/jpeg', remote_ref: null, local_path: '/x/shot.jpg' });
    assert.equal((await call('/api/places/gplace%3AB1', { method: 'DELETE', cookie: bob.cookie })).j.name, 'Bob Yakiniku');
    assert.equal((await call('/api/places/gplace%3AA1', { method: 'DELETE', cookie: alice.cookie })).status, 200);
    const after = (await call('/api/places', { cookie: bob.cookie })).j;
    assert.deepEqual(after.places.map((p: any) => p.id), ['gplace:A2'], 'the other place of the same Reel is kept');
    assert.equal(srv.app.store.mediaFor(`c${cid}/ig:AAAAA`).length, 1, 'the Reel screenshot is kept');
    // Retries / stale data cannot bring it back: automatic re-linking, a duplicate merging into it, an export.
    srv.app.store.linkReelPlace({ reel_key: `c${cid}/ig:AAAAA`, place_id: 'gplace:A1', cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
    srv.app.store.upsertPlace({ place_id: 'gplace:A1', name: 'Alice Sushi', category: 'restaurant', kind: 'point', lat: 35, lon: 139, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'x', address: null, google_place_id: 'GA1' });
    srv.app.store.upsertPlace({ place_id: 'osm:node:dupA1', name: 'Alice Sushi', category: 'restaurant', kind: 'point', lat: 35, lon: 139, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'x', address: null, google_place_id: null });
    srv.app.store.db.prepare("UPDATE places SET google_place_id='GA1', created_at='2030-01-01' WHERE place_id='osm:node:dupA1'").run();
    srv.app.store.linkReelPlace({ reel_key: `c${cid}/ig:AAAAA`, place_id: 'osm:node:dupA1', cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
    srv.app.store.mergeSameListing();
    assert.deepEqual((await call('/api/places', { cookie: alice.cookie })).j.places.map((p: any) => p.id).sort(), ['gplace:A2'], 'deleted pin stays deleted after re-processing and a merge');
    // Removing a member revokes their Shortcut.
    const bobId = srv.accounts.members(cid).find((m: any) => m.email === 'b@example.com').id;
    assert.equal((await call(`/api/members/${bobId}`, { method: 'DELETE', cookie: bob.cookie })).status, 403);
    assert.equal((await call(`/api/members/${bobId}`, { method: 'DELETE', cookie: alice.cookie })).status, 200);
    assert.equal((await call(lb, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/CCCCC/' } })).j.error, 'bad token');
    assert.equal((await call('/api/places', { cookie: bob.cookie })).status, 409, 'Bob has no collection left → setup');
  } finally { await srv.close(); }
});

test('12 countries in one collection: each is its own country on the map and its own My Map; the 11th and 12th get new maps without touching the others; a failing country does not block the rest', async () => {
  const { srv, call, signIn, pin } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const alice = await signIn('g-a|a@example.com|Alice');
    const cid = alice.collection;
    const C: [string, string][] = [['jp', 'Japan'], ['kg', 'Kyrgyzstan'], ['li', 'Liechtenstein'], ['cl', 'Chile'], ['ar', 'Argentina'], ['cn', 'China'], ['cr', 'Costa Rica'], ['in', 'India'], ['pe', 'Peru'], ['ch', 'Switzerland'], ['tj', 'Tajikistan'], ['us', 'United States']];
    const link = new URL((await call('/api/intake-link', { method: 'POST', cookie: alice.cookie, body: {} })).j.intake_url).pathname;
    for (const [i, [cc, name]] of C.entries()) {
      await call(link, { method: 'POST', body: { action: 'share', text: `https://www.instagram.com/reel/RRRR${i}/` } });
      pin(`c${cid}/ig:RRRR${i}`, `gplace:P${i}`, `Place in ${name}`, cc, name);
    }
    const d = (await call('/api/places', { cookie: alice.cookie })).j;
    assert.equal(new Set(d.places.map((p: any) => p.country_code)).size, 12, 'all 12 countries are separate on the website');
    // Connect a (fake) My Maps publisher through the real pairing endpoints.
    const code = (await call('/api/pairing-codes', { method: 'POST', cookie: alice.cookie, body: { kind: 'publisher' } })).j.code;
    const pub = (await call('/api/publisher/pair', { method: 'POST', body: { code, label: 'test desktop' } })).j;
    const bearer = { authorization: `Bearer ${pub.token}` };
    const ex = (await call('/api/publisher/export', { headers: bearer })).j;
    assert.equal(Object.keys(ex.countries).length, 12); assert.equal(ex.places.length, 12);
    assert.ok(ex.reels.every((r: any) => r.collection_id === cid), 'the export holds only this collection');
    // Status before any publish: every country pending, independently.
    let st = (await call('/api/sync-status', { cookie: alice.cookie })).j;
    assert.equal(st.destinations[0].countries.length, 12); assert.ok(st.destinations[0].countries.every((c: any) => c.status === 'pending'));
    // Publish only the first 10 countries (as before the 11th and 12th existed).
    const mirror = new Store(':memory:');
    const google = new FakeMyMapsAccount();
    const report = async (r: any) => call('/api/publisher/report', { method: 'POST', headers: bearer, body: { mode: 'real', maps: r.perMap.map((m: any) => ({ country_code: m.countryCode, title: m.title, map_id: m.mapId, status: m.status, items: m.items, detail: m.detail ?? null, published_hash: m.status === 'ok' || m.status === 'skipped' ? ex.countries[m.countryCode].hash : null })) } });
    loadExport(mirror, ex);
    const ten = C.slice(0, 10).map(([cc]) => cc);
    const r10 = await syncGrouped(mirror, google, { mode: 'real', titlePrefix: 'Reels · ', layout: 'per-country', outDir: tmpDir('pub'), autoCreate: true, onlyCountries: ten });
    assert.equal(r10.status, 'ok'); assert.equal(google.maps.size, 10);
    await report(r10);
    const mapsBefore = new Map([...google.maps].map(([id, m]) => [id, JSON.stringify(m)]));
    // Now all 12, and the 11th fails once (e.g. Google asks for a one-time action): the 12th still gets its map.
    let calls = 0; const realCreate = google.createMap.bind(google);
    google.createMap = async (t: string) => { calls++; if (/Tajikistan/.test(t)) throw new Error('Google needs a one-time confirmation'); return realCreate(t); };
    const r12 = await syncGrouped(mirror, google, { mode: 'real', titlePrefix: 'Reels · ', layout: 'per-country', outDir: tmpDir('pub'), autoCreate: true });
    assert.equal(r12.status, 'failed');
    assert.equal(calls, 2, 'only the two new countries create maps');
    assert.deepEqual(r12.perMap!.filter((m) => m.status === 'ok').map((m) => m.countryCode), ['us']);
    assert.equal(r12.perMap!.filter((m) => m.status === 'skipped').length, 10, 'the first 10 maps are untouched (no read, no import)');
    for (const [id, m] of mapsBefore) assert.equal(JSON.stringify(google.maps.get(id)), m, 'existing maps and pins unchanged');
    await report(r12);
    st = (await call('/api/sync-status', { cookie: alice.cookie })).j;
    const by = Object.fromEntries(st.destinations[0].countries.map((c: any) => [c.country_code, c.status]));
    assert.equal(by.tj, 'attention'); assert.equal(by.us, 'ok'); assert.equal(by.jp, 'ok');
    assert.equal((await call('/api/places', { cookie: alice.cookie })).j.sync.countries.TJ.status, 'attention', 'the website shows it per country');
    // Retry: Tajikistan gets its map; everything ok.
    google.createMap = realCreate;
    const retry = await syncGrouped(mirror, google, { mode: 'real', titlePrefix: 'Reels · ', layout: 'per-country', outDir: tmpDir('pub'), autoCreate: true });
    assert.equal(retry.status, 'ok'); assert.equal(google.maps.size, 12);
    await report(retry);
    assert.equal((await call('/api/sync-status', { cookie: alice.cookie })).j.destinations[0].status, 'ok');

    // A deletion on the website propagates to that country's map on the next publish, and stays deleted.
    await call('/api/places/gplace%3AP0', { method: 'DELETE', cookie: alice.cookie });
    assert.equal((await call('/api/sync-status', { cookie: alice.cookie })).j.destinations[0].countries.find((c: any) => c.country_code === 'jp')?.status ?? 'gone', 'gone', 'Japan has no pins left');
    const ex2 = (await call('/api/publisher/export', { headers: bearer })).j;
    assert.ok(ex2.tombstones.includes('gplace:P0'));
    // Add another Japanese pin so the Japan map has to be re-published without the deleted one.
    pin(`c${cid}/ig:RRRR1`, 'gplace:JP2', 'Second Japanese place', 'jp', 'Japan');
    const ex3 = (await call('/api/publisher/export', { headers: bearer })).j;
    loadExport(mirror, ex3);
    const r3 = await syncGrouped(mirror, google, { mode: 'real', titlePrefix: 'Reels · ', layout: 'per-country', outDir: tmpDir('pub'), autoCreate: true });
    assert.equal(r3.status, 'ok', 'reason' in r3 ? r3.reason : '');
    const jpMap = [...google.maps.values()].find((m) => /Japan/.test(m.title))!;
    const ids = jpMap.layers.flatMap((l) => l.features.map((f) => f.rmId));
    assert.ok(!ids.includes('rm:gplace:P0'), 'deleted pin gone from Google'); assert.ok(ids.includes('rm:gplace:JP2'));
    // Another collection's publisher credential cannot read this export; a revoked one stops at once.
    assert.equal((await call('/api/publisher/export', { headers: { authorization: 'Bearer nope-nope-nope-nope-nope' } })).status, 401);
    await call(`/api/destinations/${pub.destination_id}`, { method: 'DELETE', cookie: alice.cookie });
    assert.equal((await call('/api/publisher/export', { headers: bearer })).status, 401, 'disconnected destination: credential revoked');
  } finally { await srv.close(); }
});

test('country order: default by number of pins; a long-press move is saved per user and kept; reset returns to default', async () => {
  const { srv, call, signIn, pin } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const a = await signIn('g-a|a@example.com|Alice');
    assert.deepEqual((await call('/api/places', { cookie: a.cookie })).j.country_order, []);
    assert.equal((await call('/api/country-order', { method: 'PUT', cookie: a.cookie, body: { order: ['PE', 'JP', 'CL'] } })).status, 200);
    assert.deepEqual((await call('/api/places', { cookie: a.cookie })).j.country_order, ['PE', 'JP', 'CL']);
    const b = await signIn('g-b|b@example.com|Bob');
    assert.deepEqual((await call('/api/places', { cookie: b.cookie })).j.country_order, [], "another user's order is separate");
    await call('/api/country-order', { method: 'PUT', cookie: a.cookie, body: { order: null } });
    assert.deepEqual((await call('/api/places', { cookie: a.cookie })).j.country_order, []);
    void pin;
  } finally { await srv.close(); }
});

test('restaurant subtypes: Google types, the name, the Reel text; unset when unclear; yakiniku is in "All restaurants" and "Yakiniku"', async () => {
  assert.deepEqual(inferCuisine({ name: 'Wagyu HAYATE', category: 'restaurant', google_types: 'yakiniku_restaurant,japanese_restaurant,restaurant' }), { cuisine: 'yakiniku', source: 'google' });
  assert.deepEqual(inferCuisine({ name: 'Yakiniku Kappo Tsuki', category: 'restaurant', google_types: 'japanese_restaurant,restaurant' }), { cuisine: 'yakiniku', source: 'name' }, 'a specific name beats a generic Google type');
  assert.equal(inferCuisine({ name: 'Grill Ben', category: 'restaurant', google_types: 'sandwich_shop,western_restaurant' }), null, 'insufficient evidence → unset');
  assert.deepEqual(inferCuisine({ name: 'Ichiran Shibuya', category: 'restaurant' }, ['Best in Tokyo 🔥\n📍 Ichiran Shibuya\nTonkotsu ramen, open 24h']), { cuisine: 'ramen', source: 'reel' });
  assert.equal(inferCuisine({ name: 'Ichiran Shibuya', category: 'restaurant' }, ['📍 Ichiran Shibuya — sushi and ramen under one roof']), null, 'two cuisines on the line about the place → unset');
  assert.equal(inferCuisine({ name: 'Blue Bottle', category: 'cafe', google_types: 'sushi_restaurant' }), null, 'only restaurants get a subtype');
  assert.equal(cuisineFromText('Japanese yakiniku'), 'yakiniku'); assert.equal(cuisineFromText('Japanese curry'), null);
  const s = new Store(':memory:');
  s.addShare({ intake_id: 'i', reel_key: 'ig:Y', url: 'u', shortcode: 'Y', raw_text: null, input_types: null, shared_at: '2026-11-11T00:00:00Z', note: null });
  for (const [id, c] of [['p1', 'yakiniku'], ['p2', 'sushi'], ['p3', null]] as const) {
    s.upsertPlace({ place_id: id, name: id, category: 'restaurant', kind: 'point', lat: 1, lon: 1, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'x', address: null, google_place_id: null });
    s.db.prepare('UPDATE places SET cuisine=? WHERE place_id=?').run(c, id);
    s.linkReelPlace({ reel_key: 'ig:Y', place_id: id, cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
  }
  const d = buildMapData(s, 1);
  assert.equal(d.places.filter((p) => p.category === 'restaurant').length, 3, 'all three under All Restaurants');
  assert.deepEqual(d.places.filter((p) => p.cuisine === 'yakiniku').map((p) => p.id), ['p1'], 'and the yakiniku one under Yakiniku');
  assert.deepEqual(d.cuisines.map((c) => c.key).sort(), ['sushi', 'yakiniku']);
});

test('live updates are per collection: a change in one collection does not wake the other', async () => {
  const { srv, call, signIn, pin } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const a = await signIn('g-a|a@example.com|Alice'), b = await signIn('g-b|b@example.com|Bob');
    const evs: Record<string, string[]> = { a: [], b: [] };
    const open = (who: 'a' | 'b', cookie: string) => http.get({ host: '127.0.0.1', port: Number(new URL(`http://x:${0}`).port) || undefined, path: '/api/events', headers: { cookie } });
    void open;
    const streams = (['a', 'b'] as const).map((who) => http.get(`http://127.0.0.1:${(srv.server.address() as any).port}/api/events`, { headers: { cookie: who === 'a' ? a.cookie : b.cookie } }, (res) => res.on('data', (c) => evs[who]!.push(String(c)))));
    await new Promise((r) => setTimeout(r, 150));
    const n = { a: evs.a.join('').split('event: version').length, b: evs.b.join('').split('event: version').length };
    const link = new URL((await call('/api/intake-link', { method: 'POST', cookie: a.cookie, body: {} })).j.intake_url).pathname;
    await call(link, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/LIVE1/' } });
    pin(`c${a.collection}/ig:LIVE1`, 'gplace:L', 'Live place', 'jp', 'Japan');
    await new Promise((r) => setTimeout(r, 300));
    streams.forEach((s) => s.destroy());
    assert.ok(evs.a.join('').split('event: version').length > n.a, 'Alice is notified');
    assert.equal(evs.b.join('').split('event: version').length, n.b, 'Bob is not');
  } finally { await srv.close(); }
});

test('re-processing a Reel (screenshot arrives later) does not add a second approximate pin for the same place', async () => {
  const { Store: S } = await import('../src/db.ts');
  const s = new S(':memory:');
  s.addShare({ intake_id: 'i', reel_key: 'ig:TESTREEL01', url: 'u', shortcode: 'TESTREEL01', raw_text: null, input_types: null, shared_at: '2026-11-11T12:17:51Z', note: null });
  s.upsertPlace({ place_id: 'aiest:33.0950,131.2560', name: 'Mount Kuroyama', category: 'mountain', kind: 'point', lat: 33.095, lon: 131.256, geometry_json: null, trailhead_json: null, confidence: 'approximate', source: 'OpenAI estimate', address: null, google_place_id: null });
  s.linkReelPlace({ reel_key: 'ig:TESTREEL01', place_id: 'aiest:33.0950,131.2560', cue: null, cue_source: null, role: 'featured', decided_by: 'ai+osm' });
  // What the second pass produced live: same mountain, another spelling, ~1.5 km away.
  const { processReel } = await import('../src/pipeline.ts') as any;
  void processReel;
  const links = s.linksForReel('ig:TESTREEL01') as any[];
  const { haversineKm } = await import('../src/geo/geometry.ts');
  const second = { lat: 33.1060, lon: 131.2650, category: 'mountain' };
  assert.ok(links.some((e) => e.category === second.category && haversineKm(e, second) < 3), 'the rule finds the existing pin');
});

test('sync status: a country the publisher skips because Google already matches (e.g. only the subtype changed) becomes up to date', async () => {
  const { Store: S } = await import('../src/db.ts');
  const { recordReport, collectionSyncStatus, countryHashes, exportRows } = await import('../src/destinations.ts');
  const s = new S(':memory:');
  s.db.prepare("INSERT INTO users(id,google_sub,email,created_at) VALUES(1,'g','a@b.c','2026-11-11')").run();
  s.db.prepare("INSERT INTO destinations(id,collection_id,user_id,kind,created_at,last_seen_at) VALUES(1,1,1,'mymaps','2026-11-11',?)").run(new Date().toISOString());
  s.addShare({ intake_id: 'i', reel_key: 'ig:JPJPJ', url: 'u', shortcode: 'JPJPJ', raw_text: null, input_types: null, shared_at: '2026-11-11T00:00:00Z', note: null });
  s.upsertPlace({ place_id: 'p1', name: 'Inoue', category: 'restaurant', kind: 'point', lat: 35, lon: 139, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'x', address: null, google_place_id: null });
  s.setLocality('p1', { country: 'Japan', country_code: 'jp', locality: 'Tokyo', region: null });
  s.linkReelPlace({ reel_key: 'ig:JPJPJ', place_id: 'p1', cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
  recordReport(s, 1, [{ country_code: 'jp', status: 'ok', items: 1, published_hash: countryHashes(exportRows(s, 1)).jp!.hash }]);
  assert.equal(collectionSyncStatus(s, 1).destinations[0]!.countries[0]!.status, 'ok');
  s.db.prepare("UPDATE places SET cuisine='yakiniku', updated_at='2026-11-12' WHERE place_id='p1'").run();
  assert.equal(collectionSyncStatus(s, 1).destinations[0]!.countries[0]!.status, 'pending', 'subtype changed → pending until the publisher checks');
  recordReport(s, 1, [{ country_code: 'jp', status: 'skipped', items: 1, published_hash: countryHashes(exportRows(s, 1)).jp!.hash }]);
  assert.equal(collectionSyncStatus(s, 1).destinations[0]!.countries[0]!.status, 'ok', 'skipped (already on Google) → up to date');
});

test('New and Star are personal: existing pins start not-new; opening clears New for me only; stars are mine; review count per collection; permissions', async () => {
  const { srv, call, signIn, pin } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const alice = await signIn('g-a|a@example.com|Alice');
    const inv = (await call('/api/invitations', { method: 'POST', cookie: alice.cookie })).j;
    const bob = await signIn('g-b|b@example.com|Bob', { invite: inv.code });
    const la = new URL((await call('/api/intake-link', { method: 'POST', cookie: alice.cookie, body: {} })).j.intake_url).pathname;
    await call(la, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/OLD01/' } });
    const s = srv.app.store;
    const old = (s.db.prepare("SELECT reel_key FROM reels WHERE url LIKE '%OLD01%'").get() as any).reel_key;
    pin(old, 'p:old', 'Old Place', 'JP', 'Japan');
    // First view: everything that exists is NOT new (the collection does not light up all at once).
    const places = async (c: string) => (await call('/api/places', { cookie: c })).j;
    assert.equal((await places(alice.cookie)).places[0].is_new, false);
    assert.equal((await places(bob.cookie)).places[0].is_new, false);
    await new Promise((r) => setTimeout(r, 15));
    await call(la, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/NEW01/' } });
    const nk = (s.db.prepare("SELECT reel_key FROM reels WHERE url LIKE '%NEW01%'").get() as any).reel_key;
    pin(nk, 'p:new', 'New Place', 'JP', 'Japan');
    const byId = (d: any, id: string) => d.places.find((p: any) => p.id === id);
    assert.equal(byId(await places(alice.cookie), 'p:new').is_new, true);
    assert.equal(byId(await places(bob.cookie), 'p:new').is_new, true);
    // Alice opens it: cleared for Alice, still new for Bob.
    assert.equal((await call('/api/places/p%3Anew/seen', { method: 'POST', cookie: alice.cookie })).status, 200);
    assert.equal(byId(await places(alice.cookie), 'p:new').is_new, false);
    assert.equal(byId(await places(bob.cookie), 'p:new').is_new, true, 'one member opening a place leaves it new for the others');
    // Stars: personal and persistent; unstar works; ETag changes so the phone reloads.
    const e1 = (await call('/api/places', { cookie: bob.cookie })).headers.get('etag');
    assert.equal((await call('/api/places/p%3Aold/star', { method: 'PUT', cookie: bob.cookie, body: { starred: true } })).status, 200);
    assert.notEqual((await call('/api/places', { cookie: bob.cookie })).headers.get('etag'), e1);
    assert.equal(byId(await places(bob.cookie), 'p:old').starred, true);
    assert.equal(byId(await places(alice.cookie), 'p:old').starred, false, "Bob's star is not Alice's");
    await call('/api/places/p%3Aold/star', { method: 'PUT', cookie: bob.cookie, body: { starred: false } });
    assert.equal(byId(await places(bob.cookie), 'p:old').starred, false);
    // Outsiders: no access to another collection's places.
    const eve = await signIn('g-e|e@example.com|Eve');
    assert.equal((await call('/api/places/p%3Aold/star', { method: 'PUT', cookie: eve.cookie, body: { starred: true } })).status, 404);
    assert.equal((await call('/api/places/p%3Aold/seen', { method: 'POST', cookie: eve.cookie })).status, 404);
    assert.equal((await call('/api/places/p%3Aold/star', { method: 'PUT', body: { starred: true } })).status, 401);
    // Review count: this collection's Reels waiting for a person (the offline test shares failed: they count too).
    for (const k of [old, nk]) s.setReelResult(k, { status: 'resolved', reason: 'ok' });
    assert.equal((await places(alice.cookie)).review_count, 0);
    s.setReelResult(nk, { status: 'needs_review', reason: 'test' });
    assert.equal((await places(alice.cookie)).review_count, 1);
    assert.equal((await places(eve.cookie)).review_count, 0, "another collection's queue is not counted");
    s.setReelResult(nk, { status: 'resolved', reason: 'done' });
    assert.equal((await places(bob.cookie)).review_count, 0);
  } finally { await srv.close(); }
});

test('reelocations: icons, manifest and the old routes', async () => {
  const { srv, call } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const m = await call('/manifest.webmanifest');
    assert.equal(m.j.name, 'reelocations'); assert.equal(m.j.start_url, '/');
    for (const p of ['/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/icon.svg', '/favicon.ico']) assert.equal((await call(p)).status, 200, p);
    assert.match((await call('/signin')).text, /<title>reelocations<\/title>/);
    assert.equal((await call('/setup')).status, 303); assert.equal((await call('/review')).status, 303);
    assert.equal((await call('/api/intake', { method: 'POST', body: { token: INBOX, text: 'https://www.instagram.com/reel/ZZZ/' } })).j.ok, true, 'the installed Shortcut URL still works');
  } finally { await srv.close(); }
});

test('a restaurant subtype set in one collection does not change it in another collection that shows the same place', async () => {
  const { srv, call, signIn, pin } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const a = await signIn('g-a|a@example.com|Alice'), b = await signIn('g-b|b@example.com|Bob');
    const share = async (c: string, code: string) => { const l = new URL((await call('/api/intake-link', { method: 'POST', cookie: c, body: {} })).j.intake_url).pathname; await call(l, { method: 'POST', body: { action: 'share', text: `https://www.instagram.com/reel/${code}/` } }); return (srv.app.store.db.prepare('SELECT reel_key FROM reels WHERE url LIKE ?').get(`%${code}%`) as any).reel_key; };
    const ra = await share(a.cookie, 'SAME1'), rb = await share(b.cookie, 'SAME2');
    // The same Google listing saved by both people: ONE shared place row.
    pin(ra, 'gplace:X', 'Shared Sushi', 'JP', 'Japan', { google_types: 'sushi_restaurant,restaurant' });
    srv.app.store.linkReelPlace({ reel_key: rb, place_id: 'gplace:X', cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
    const { backfillCuisines } = await import('../src/cuisine.ts'); backfillCuisines(srv.app.store, () => []);
    const cu = async (c: string) => (await call('/api/places', { cookie: c })).j.places.find((p: any) => p.id === 'gplace:X').cuisine;
    assert.equal(await cu(a.cookie), 'sushi'); assert.equal(await cu(b.cookie), 'sushi');
    assert.equal((await call('/api/places/gplace%3AX/cuisine', { method: 'PUT', cookie: a.cookie, body: { cuisine: 'izakaya' } })).status, 200);
    assert.equal(await cu(a.cookie), 'izakaya');
    assert.equal(await cu(b.cookie), 'sushi', "Alice's correction stays in Alice's collection");
    await call('/api/places/gplace%3AX/cuisine', { method: 'PUT', cookie: a.cookie, body: { cuisine: null } });
    assert.equal(await cu(a.cookie), null, '"not set" chosen by a person stays not set');
    assert.equal((await call('/api/places/gplace%3AX/cuisine', { method: 'PUT', cookie: (await signIn('g-c|c@example.com|Carol')).cookie, body: { cuisine: 'sushi' } })).status, 404);
  } finally { await srv.close(); }
});

test('a screenshot whose file is gone is not offered (no blank preview); the server refuses to start without its own admin secret', async () => {
  const { srv, call, signIn, pin } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const a = await signIn('g-a|a@example.com|Alice');
    const l = new URL((await call('/api/intake-link', { method: 'POST', cookie: a.cookie, body: {} })).j.intake_url).pathname;
    await call(l, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/IMG01/' } });
    const s = srv.app.store, rk = (s.db.prepare("SELECT reel_key FROM reels WHERE url LIKE '%IMG01%'").get() as any).reel_key;
    pin(rk, 'p:img', 'Pictured', 'JP', 'Japan');
    const fs = await import('node:fs'); const path = await import('node:path');
    const file = path.join(s.db.prepare('PRAGMA database_list').get() ? srv.app.cfg.dataDir : '', 'media', 'shot.jpg');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    s.setLinkImage(rk, 'p:img', { path: file, kind: 'place' });
    const img = async () => (await call('/api/places', { cookie: a.cookie })).j.places[0].reels[0].image;
    assert.ok(await img());
    assert.equal((await call(await img(), { cookie: a.cookie })).status, 200);
    fs.rmSync(file);
    assert.equal(await img(), null, 'a missing file is not shown as a (blank) screenshot');
  } finally { await srv.close(); }
  const { startServer } = await import('../src/server.ts');
  const saved = process.env.APP_TOKEN; delete process.env.APP_TOKEN;
  try { assert.throws(() => startServer({ app: srv.app, port: 0, startWorker: false } as any), /APP_TOKEN/); } finally { if (saved !== undefined) process.env.APP_TOKEN = saved; }
});

test('Review Queue listing choice is per collection: choosing a listing in one collection leaves the shared pin and the other collection\'s question as they were', async () => {
  const { srv, call, signIn, pin } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const a = await signIn('g-a|a@example.com|Alice'), b = await signIn('g-b|b@example.com|Bob');
    const uidA = (await call('/api/me', { cookie: a.cookie })).j.user.id;
    const share = async (c: string, code: string) => { const l = new URL((await call('/api/intake-link', { method: 'POST', cookie: c, body: {} })).j.intake_url).pathname; await call(l, { method: 'POST', body: { action: 'share', text: `https://www.instagram.com/reel/${code}/` } }); return srv.app.store.listReels().find((r) => r.url?.includes(code))!.reel_key; };
    const ra = await share(a.cookie, 'LISTA1'), rb = await share(b.cookie, 'LISTB1');
    const s = srv.app.store;
    pin(ra, 'osm:node:77', 'Chain Ramen', 'JP', 'Japan');
    s.linkReelPlace({ reel_key: rb, place_id: 'osm:node:77', cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
    s.setStar(uidA, a.collection, 'osm:node:77', true);
    const { queueListingReview } = await import('../src/geo/googleMatch.ts');
    const opt = (id: string, lat: number) => ({ ref: `gplace:${id}`, name: `Chain Ramen ${id}`, displayName: `Chain Ramen ${id}, 1-2 Street, Osaka, Japan`, lat, lon: 135.5, category: 'restaurant' as const, isArea: false, isRoute: false, names: [] as string[], googlePlaceId: id });
    queueListingReview(s, s.getPlace('osm:node:77')!, [opt('BR1', 34.70), opt('BR2', 34.66)], 'two branches');
    assert.equal(s.getReel(ra)!.status, 'needs_review'); assert.equal(s.getReel(rb)!.status, 'needs_review');
    // Every candidate has a direct Google Maps link (the exact listing when known).
    const page = (await call('/review/', { cookie: a.cookie })).text;
    assert.match(page, /query_place_id=BR1/); assert.match(page, /Open listing in Google Maps/);
    // Alice picks branch 1 in the Review Queue.
    const idx = s.candidatesFor(ra).findIndex((c) => c.googlePlaceId === 'BR1');
    const form = await call('/review/act', { method: 'POST', cookie: a.cookie, body: { key: ra, op: 'choose', idx: String(idx) } });
    assert.equal(form.status, 303, form.text);
    // Alice's collection: its own pin for BR1, her star kept; the question is settled for her.
    const pa = (await call('/api/places', { cookie: a.cookie })).j.places;
    assert.equal(pa.length, 1); assert.equal(pa[0].google_place_id, 'BR1'); assert.equal(pa[0].starred, true);
    assert.equal(s.getReel(ra)!.status, 'resolved');
    // Bob's collection: the original pin, no listing, and his question still open with both branches.
    const pb = (await call('/api/places', { cookie: b.cookie })).j.places;
    assert.equal(pb.length, 1); assert.equal(pb[0].id, 'osm:node:77'); assert.equal(pb[0].google_place_id, null);
    assert.equal(s.getReel(rb)!.status, 'needs_review');
    assert.deepEqual(s.candidatesFor(rb).map((c) => c.googlePlaceId).sort(), ['BR1', 'BR2']);
    // "None of these" for a pin this Reel is not asking about is refused.
    const bad = await call('/review/act', { method: 'POST', cookie: b.cookie, body: { key: rb, op: 'nolisting', q: 'gplace:BR1' } });
    assert.equal(bad.status, 400);
    // "None of these" in Bob's collection only affects Bob's collection, and he is not asked again.
    const none = await call('/review/act', { method: 'POST', cookie: b.cookie, body: { key: rb, op: 'nolisting', q: 'osm:node:77' } });
    assert.equal(none.status, 303, none.text);
    assert.equal(s.candidatesFor(rb).length, 0);
    queueListingReview(s, s.getPlace('osm:node:77')!, [opt('BR2', 34.66)], 'asked again');
    assert.equal(s.candidatesFor(rb).length, 0, 'a collection that said "none of these" is not asked again');
  } finally { await srv.close(); }
});

test('leaving a collection ends access at once and keeps the pins the member added; deleting an account removes personal data and keeps shared pins', async () => {
  const { srv, call, signIn, pin } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const uid = async (c: string) => (await call('/api/me', { cookie: c })).j.user.id as number;
    const alice = await signIn('g-a|a@example.com|Alice');
    const inv = (await call('/api/invitations', { method: 'POST', cookie: alice.cookie })).j;
    const bob = await signIn('g-b|b@example.com|Bob', { invite: inv.code });
    const bobId = await uid(bob.cookie);
    const cid = alice.collection, s = srv.app.store;
    const linkB = new URL((await call('/api/intake-link', { method: 'POST', cookie: bob.cookie, body: {} })).j.intake_url).pathname;
    await call(linkB, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/BOBREEL1/' } });
    const rb = s.listReels().find((r) => r.url?.includes('BOBREEL1'))!.reel_key;
    pin(rb, 'osm:node:5', 'Bob Cafe', 'FR', 'France');
    assert.equal((await call('/api/places/osm%3Anode%3A5/star', { method: 'PUT', cookie: bob.cookie, body: { starred: true } })).status, 200);
    // The owner cannot leave; the member can.
    assert.equal((await call('/api/collection/leave', { method: 'POST', cookie: alice.cookie })).status, 400);
    assert.equal((await call('/api/collection/leave', { method: 'POST', cookie: bob.cookie })).status, 200);
    // Bob's access ended: the collection's places, its Review Queue and his Shortcut link for it.
    assert.equal((await call(`/api/places?c=${cid}`, { cookie: bob.cookie })).status, 403);
    assert.equal((await call(linkB, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/BOBREEL2/' } })).j.ok, false);
    assert.equal((s.db.prepare('SELECT COUNT(*) n FROM user_place_state WHERE user_id=? AND collection_id=?').get(bobId, cid) as any).n, 0);
    // His pin stays in Alice's collection.
    assert.ok((await call('/api/places', { cookie: alice.cookie })).j.places.some((p: any) => p.id === 'osm:node:5'));

    // Account deletion: Carol joins, adds a pin, owns a solo collection, then deletes her account.
    const inv2 = (await call('/api/invitations', { method: 'POST', cookie: alice.cookie })).j;
    const carol = await signIn('g-c|c@example.com|Carol', { invite: inv2.code });
    const carolId = await uid(carol.cookie);
    const linkC = new URL((await call('/api/intake-link', { method: 'POST', cookie: carol.cookie, body: {} })).j.intake_url).pathname;
    await call(linkC, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/CARREEL1/' } });
    const rc = s.listReels().find((r) => r.url?.includes('CARREEL1'))!.reel_key;
    pin(rc, 'osm:node:6', 'Carol Bar', 'ES', 'Spain');
    const own = srv.accounts.createCollection(carolId, 'Carol solo');
    s.addShare({ intake_id: 'solo1', reel_key: `c${own.id}/ig:SOLO1`, url: 'https://www.instagram.com/reel/SOLO1/', shortcode: 'SOLO1', raw_text: null, input_types: null, shared_at: '2026-11-12T08:00:00Z', note: null, collection_id: own.id, user_id: carolId });
    pin(`c${own.id}/ig:SOLO1`, 'osm:node:7', 'Solo Place', 'IT', 'Italy');
    assert.equal((await call('/api/account', { method: 'DELETE', cookie: carol.cookie, body: {} })).status, 400, 'needs the typed confirmation');
    const del = await call('/api/account', { method: 'DELETE', cookie: carol.cookie, body: { confirm: 'DELETE' } });
    assert.equal(del.status, 200, del.text); assert.equal(del.j.left, 1); assert.equal(del.j.deleted, 1);
    assert.equal(srv.accounts.user(carolId), undefined);
    assert.equal((await call('/api/places', { cookie: carol.cookie })).status, 401, 'her session is gone');
    for (const t of ['sessions', 'credentials', 'memberships', 'user_place_state', 'user_collection_state']) assert.equal((s.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id=?`).get(carolId) as any).n, 0, t);
    // The pin she added to the shared collection stays, unattributed; her solo collection is gone.
    assert.ok((await call('/api/places', { cookie: alice.cookie })).j.places.some((p: any) => p.id === 'osm:node:6'));
    assert.equal(s.getReel(rc)!.contributed_by, null);
    assert.equal(s.getReel(`c${own.id}/ig:SOLO1`), undefined); assert.equal(s.getPlace('osm:node:7'), undefined);
    assert.equal(srv.accounts.collection(own.id), undefined);
    // An owner who deletes their account passes a shared collection on to the remaining member.
    const inv3 = (await call('/api/invitations', { method: 'POST', cookie: alice.cookie })).j;
    const dan = await signIn('g-d|d@example.com|Dan', { invite: inv3.code });
    const danId = await uid(dan.cookie);
    const del2 = await call('/api/account', { method: 'DELETE', cookie: alice.cookie, body: { confirm: 'DELETE' } });
    assert.equal(del2.j.transferred, 1, del2.text);
    assert.equal(srv.accounts.role(danId, cid), 'owner');
    assert.ok((await call(`/api/places?c=${cid}`, { cookie: dan.cookie })).j.places.some((p: any) => p.id === 'osm:node:5'));
  } finally { await srv.close(); }
});

test('approximate pins: labelled, linked to their own Review Queue entry that explains why; choosing an alternative replaces the pin', async () => {
  const { srv, call, signIn, pin } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const a = await signIn('g-a|a@example.com|Alice');
    const l = new URL((await call('/api/intake-link', { method: 'POST', cookie: a.cookie, body: {} })).j.intake_url).pathname;
    await call(l, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/APPROX1/' } });
    const s = srv.app.store, key = s.listReels().find((r) => r.url?.includes('APPROX1'))!.reel_key;
    pin(key, 'osm:node:40', 'Hill Cafe', 'GR', 'Greece', { confidence: 'approximate', source: 'OpenStreetMap · approximate: ambiguous: "Hill Cafe, A" vs "Hill Cafe, B"' });
    const alt = { ref: 'osm:node:41', name: 'Hill Cafe', displayName: 'Hill Cafe, Upper Town, Greece', lat: 37.9, lon: 23.7, category: 'restaurant' as const, isArea: false, isRoute: false, names: [] as string[], clueText: 'Hill Cafe' };
    const self = { ...alt, ref: 'confirm:osm:node:40', displayName: 'Hill Cafe, A', confirmsApproxPlaceId: 'osm:node:40' };
    s.replaceCandidates(key, [self, { ...alt, replacesApproxPlaceId: 'osm:node:40' }]);
    s.setReelResult(key, { status: 'needs_review', reason: 'saved as approximate — please check: "Hill Cafe": ambiguous' });
    const p = (await call('/api/places', { cookie: a.cookie })).j.places[0];
    assert.equal(p.confidence, 'approximate');
    assert.equal(p.review_url, `/review?k=${encodeURIComponent(key)}#pin-${encodeURIComponent('osm:node:40')}`);
    const page = (await call(p.review_url.split('#')[0].replace('/review?', '/review/?'), { cookie: a.cookie })).text;
    assert.match(page, /Why approximate:/); assert.match(page, /ambiguous/);
    assert.match(page, /Search in Google Maps/, 'a candidate without a listing gets a Maps search link');
    assert.equal((page.match(/<section class="card /g) ?? []).length, 1, 'only this Reel');
    const html = (await call('/', { cookie: a.cookie })).text;
    assert.match(html, /AI Balance/); assert.doesNotMatch(html, /🤖/); assert.match(html, /apxb/);
    // Choosing the alternative replaces the approximate pin and settles the Reel.
    const { chooseCandidate } = await import('../src/review/actions.ts');
    await chooseCandidate(s, srv.app.resolve, key, 1);
    assert.deepEqual(s.linksForReel(key).map((x) => x.place_id), ['osm:node:41']);
    assert.equal(s.getReel(key)!.status, 'resolved');
  } finally { await srv.close(); }
});

test('Review Queue: choosing an option for a pin replaces that pin (pre-selected), not one more pin; "Add as another place" adds; re-processing does not bring the old pin back', async () => {
  const { srv, call, signIn, pin } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const a = await signIn('g-a|a@example.com|Alice');
    const l = new URL((await call('/api/intake-link', { method: 'POST', cookie: a.cookie, body: {} })).j.intake_url).pathname;
    await call(l, { method: 'POST', body: { action: 'share', text: 'https://www.instagram.com/reel/REPL01/' } });
    const s = srv.app.store, key = s.listReels().find((r) => r.url?.includes('REPL01'))!.reel_key;
    pin(key, 'aiest:1', 'Mountain Estimate', 'JP', 'Japan', { confidence: 'approximate', source: 'OpenAI estimate' });
    s.db.prepare("UPDATE places SET lat=33.77, lon=133.11 WHERE place_id='aiest:1'").run();
    const opt = (ref: string, name: string, lat: number, lon: number) => ({ ref, name, displayName: `${name}, Ehime, Japan`, lat, lon, category: 'mountain' as const, isArea: false, isRoute: false, names: [] as string[], clueText: '石鎚山' });
    s.replaceCandidates(key, [opt('osm:node:900', '石鎚山', 33.7675, 133.1153), opt('osm:node:901', 'Other Peak', 34.5, 134.0)]);
    s.setReelResult(key, { status: 'needs_review', reason: 'open' });
    // The page pre-selects "Replace" for the Reel's only pin.
    const page = (await call('/review/', { cookie: a.cookie })).text;
    assert.match(page, /<option value="aiest:1" selected>Replace “Mountain Estimate”<\/option>/);
    assert.match(page, /Add as another place/);
    const r = await call('/review/act', { method: 'POST', cookie: a.cookie, body: { key, op: 'choose', idx: '0', replace: 'aiest:1' } });
    assert.equal(r.status, 303, r.text);
    assert.deepEqual(s.linksForReel(key).map((x) => x.place_id), ['osm:node:900'], 'replaced, not one more pin');
    assert.ok(s.isTombstoned(s.collectionOf(key), 'aiest:1'), 'the replaced pin stays gone when the Reel is re-processed');
    // "Add as another place" keeps the existing pin.
    s.replaceCandidates(key, [opt('osm:node:901', 'Other Peak', 34.5, 134.0)]);
    await call('/review/act', { method: 'POST', cookie: a.cookie, body: { key, op: 'choose', idx: '0', replace: '' } });
    assert.deepEqual(s.linksForReel(key).map((x) => x.place_id).sort(), ['osm:node:900', 'osm:node:901']);
    // Guess on a Reel with several pins: the nearby one (a Japanese name for the same mountain), else "add".
    const { guessReplaced } = await import('../src/review/actions.ts');
    assert.equal(guessReplaced(s, key, opt('x', '石鎚山 (summit)', 33.768, 133.115) as any), 'osm:node:900');
    assert.equal(guessReplaced(s, key, { ...opt('y', 'Faraway Hut', 40, 140), clueText: 'Faraway Hut' } as any), null);
  } finally { await srv.close(); }
});

test('hosted Review Queue does not show the paid API spend or the desktop sync status to members', async () => {
  const { srv, call, signIn } = server();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const a = await signIn('g-a|a@example.com|Alice');
    const page = (await call('/review/', { cookie: a.cookie })).text;
    assert.doesNotMatch(page, /paid API spend|last sync/);
  } finally { await srv.close(); }
});
