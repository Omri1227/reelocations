/**
 * Google Maps list: the session's life. Found on Railway 2026-11-13: Google signed a session out that had been signed
 * in on a PC and copied to the server (Save → /ServiceLogin → /v3/signin/accountchooser, the account "Signed out").
 * These tests cover what the server does about it: it only says "needs sign-in" when Google really stays on a sign-in
 * page, it checks and recovers by itself, signing in again keeps everything, and the sign-in can be done from a phone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/db.ts';
import { connectGmaps, disconnectGmaps, gmapsCheck, gmapsCycle, gmapsStatus } from '../src/sync/savedListRunner.ts';
import { closeAllBrowsers, hasLiveBrowser, lockKey, profileOf, tryLock } from '../src/sync/gmapsBrowser.ts';
import { accountsPageKind } from '../src/sync/savedList.ts';
import { GmapsSignin } from '../src/sync/gmapsSignin.ts';
import { tmpDir } from './support.ts';

const session = { cookies: [{ name: 'SID', value: 'x', domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }, { name: 'ACCOUNT_CHOOSER', value: 'y', domain: 'accounts.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };
const signin = () => Object.assign(new Error('not signed in (Save opened Google\'s sign-in page)'), { code: 'signin' });

function setup() {
  const dir = tmpDir('gmaps-session');
  const s = new Store(path.join(dir, 'db.sqlite'));
  const pin = (key: string, gid: string, name: string) => {
    s.addShare({ intake_id: `i-${key}`, reel_key: key, url: `https://www.instagram.com/reel/${key}/`, shortcode: key, raw_text: null, input_types: null, shared_at: '2026-11-12T08:00:00Z', note: null, collection_id: 1, user_id: null } as any);
    s.upsertPlace({ place_id: `gplace:${gid}`, name, category: 'restaurant', kind: 'point', lat: 13.75, lon: 100.5, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'Google Maps', address: '1 Example Rd, Bangkok', google_place_id: gid } as any);
    s.linkReelPlace({ reel_key: key, place_id: `gplace:${gid}`, cue: null, cue_source: null, role: 'featured', decided_by: 'auto' });
    s.setReelResult(key, { status: 'resolved', reason: 'ok' });
  };
  // A fake Google: `mode` is what the Save click meets.
  const g = { mode: 'ok' as 'ok' | 'signin' | 'signin-once' | 'timeout', list: [] as string[], current: '', saves: 0, launches: 0, snapshots: 0 };
  const ops = {
    openListing: async (_p: any, t: any) => { g.current = t.googlePlaceId; return { url: '', title: t.name, address: '1 Example Rd', nameMatch: 1, branchOk: true, why: 'ok' }; },
    readSaveState: async () => ({ signedIn: null, saveButton: 'Save', saved: false }),
    saveToList: async () => {
      if (g.mode === 'signin') throw signin();
      if (g.mode === 'signin-once') { g.mode = 'ok'; throw signin(); }
      if (g.mode === 'timeout') throw new Error('the Save menu did not open within 20 s');
      const already = g.list.includes(g.current); if (!already) g.list.push(g.current); g.saves++;
      return { saved: true, already, created: false, detail: 'saved' };
    },
  } as any;
  const launch = async () => { g.launches++; return { page: {}, save: async () => { g.snapshots++; }, close: async () => {} }; };
  const dest = () => s.db.prepare('SELECT * FROM gmaps_destinations WHERE disconnected_at IS NULL').get() as any;
  const item = (gid: string) => s.db.prepare('SELECT * FROM gmaps_saves WHERE google_place_id=?').get(gid) as any;
  return { dir, s, pin, g, ops, launch, dest, item };
}

test('which Google account pages mean "signed out": sign-in pages do, pass-through pages and Maps do not', () => {
  assert.equal(accountsPageKind('https://accounts.google.com/v3/signin/accountchooser?continue=x&dsh=y'), 'signin');
  assert.equal(accountsPageKind('https://accounts.google.com/v3/signin/identifier?continue=x'), 'signin');
  assert.equal(accountsPageKind('https://accounts.google.com/v3/signin/challenge/pwd?TL=x'), 'signin');
  assert.equal(accountsPageKind('https://accounts.google.co.il/AccountChooser?continue=x'), 'signin');
  assert.equal(accountsPageKind('https://accounts.google.com/ServiceLogin?hl=en&continue=x'), 'passing', 'the first hop redirects on, either way');
  assert.equal(accountsPageKind('https://accounts.google.com/RotateCookiesPage?og_pid=1&rot=3'), 'passing', 'Google refreshing the session by itself');
  assert.equal(accountsPageKind('https://www.google.com/maps/place/x'), null);
  assert.equal(accountsPageKind('https://accounts.google.com.evil.example/v3/signin/identifier'), null);
});

test('"needs sign-in" only when Google\'s sign-in page comes up twice for one listing; a single one, or a timeout, stays in the retry flow', async () => {
  const { dir, s, pin, g, ops, launch, dest, item } = setup();
  connectGmaps(s, dir, { collectionId: 1, userId: 7, state: session });
  pin('A1', 'GA1', 'Noodle Shop');

  // Once, then the menu opens on the second look: saved, never flagged.
  g.mode = 'signin-once';
  assert.deepEqual(await gmapsCycle(s, launch, { ops }), { saved: 1, failed: 0, skipped: 0 });
  assert.equal(dest().status, 'ok'); assert.equal(item('GA1').status, 'verified'); assert.equal(g.snapshots, 1);

  // The Save menu does not open (slow page, changed menu): a failed attempt with a retry time — not a sign-out.
  pin('A2', 'GA2', 'Slow Cafe'); g.mode = 'timeout';
  assert.deepEqual(await gmapsCycle(s, launch, { ops }), { saved: 0, failed: 1, skipped: 0 });
  assert.equal(dest().status, 'ok'); assert.equal(item('GA2').status, 'failed'); assert.ok(item('GA2').next_try_at);
  assert.equal(g.snapshots, 1, 'no snapshot from a run that did not prove the sign-in');
  s.db.prepare("UPDATE gmaps_saves SET next_try_at=NULL WHERE google_place_id='GA2'").run();

  // Twice in a row: signed out. The item is not counted as failed; the snapshot is not overwritten.
  g.mode = 'signin';
  const logs: string[] = [];
  await gmapsCycle(s, launch, { ops, log: (m) => logs.push(m) });
  assert.equal(dest().status, 'needs_signin'); assert.match(dest().detail, /Sign in to Google/);
  assert.equal(item('GA2').status, 'failed'); assert.equal(item('GA2').attempts, 1, 'the sign-in page does not use up an attempt');
  assert.equal(g.snapshots, 1); assert.equal(logs.length, 1); assert.match(logs[0]!, /needs sign-in/);
  // While signed out, the save cycle does not open the browser at all.
  const n = g.launches; await gmapsCycle(s, launch, { ops }); assert.equal(g.launches, n);
  s.close();
});

test('session check: clears a wrong "needs sign-in" by itself and the pending place is saved; an inconclusive check changes nothing; a real sign-out is noticed without a save', async () => {
  const { dir, s, pin, g, ops, launch, dest, item } = setup();
  connectGmaps(s, dir, { collectionId: 1, userId: 7, state: session });
  pin('B1', 'GB1', 'First'); await gmapsCycle(s, launch, { ops });
  pin('B2', 'GB2', 'Pending Place');
  s.db.prepare("UPDATE gmaps_destinations SET status='needs_signin', detail='x', last_check_at=NULL").run();
  const seen: any[] = [];
  const probe = (answer: boolean | null) => async (_p: any, t: any) => { seen.push(t.googlePlaceId); return { signedIn: answer, detail: 'test' }; };

  // Inconclusive: still "needs sign-in", and it is not asked again right away.
  assert.deepEqual(await gmapsCheck(s, launch, { probe: probe(null) }), { checked: 1, recovered: 0, signedOut: 0 });
  assert.equal(dest().status, 'needs_signin');
  assert.deepEqual(await gmapsCheck(s, launch, { probe: probe(true) }), { checked: 0, recovered: 0, signedOut: 0 }, 'a signed-out session is re-checked every few hours, not every minute');
  // The session works after all: cleared, and the next pass saves what was waiting — once, to the same list.
  s.db.prepare('UPDATE gmaps_destinations SET last_check_at=NULL').run();
  assert.deepEqual(await gmapsCheck(s, launch, { probe: probe(true) }), { checked: 1, recovered: 1, signedOut: 0 });
  assert.equal(dest().status, 'ok'); assert.equal(seen.at(-1), 'GB1', 'the check opens the latest saved listing');
  assert.deepEqual(await gmapsCycle(s, launch, { ops }), { saved: 1, failed: 0, skipped: 0 });
  assert.deepEqual(g.list, ['GB1', 'GB2']); assert.equal(item('GB2').status, 'verified');

  // Signed in and recently proven: nothing to do. An hour later, with nothing to save, it checks — and notices a sign-out.
  assert.equal((await gmapsCheck(s, launch, { probe: probe(false) })).checked, 0);
  s.db.prepare("UPDATE gmaps_destinations SET last_check_at='2026-11-01T00:00:00.000Z', last_ok_at='2026-11-01T00:00:00.000Z'").run();
  assert.deepEqual(await gmapsCheck(s, launch, { probe: probe(false) }), { checked: 1, recovered: 0, signedOut: 1 });
  assert.equal(dest().status, 'needs_signin');

  // One browser per session: while something else has it open, neither the check nor the save cycle starts another.
  s.db.prepare("UPDATE gmaps_destinations SET status='ok', last_check_at=NULL, last_ok_at=NULL").run();
  pin('B3', 'GB3', 'Later');
  const release = tryLock(lockKey(dest().id))!; const n = g.launches;
  assert.equal((await gmapsCheck(s, launch, { probe: probe(true) })).checked, 0);
  assert.deepEqual(await gmapsCycle(s, launch, { ops }), { saved: 0, failed: 0, skipped: 0 });
  assert.equal(g.launches, n); assert.equal(item('GB3').status, 'pending');
  release();
  assert.equal((await gmapsCycle(s, launch, { ops })).saved, 1);
  s.close();
});

test('signing in again keeps the destination, list, cutoff, queue and saved records; another Google account is refused; disconnecting forgets the profile', async () => {
  const { dir, s, pin, g, ops, launch, dest, item } = setup();
  const id = connectGmaps(s, dir, { collectionId: 1, userId: 7, state: session, listName: 'My Food', account: 'Someone@Example.com' });
  const cutoff = (gmapsStatus(s, 1) as any).cutoff_at;
  pin('C1', 'GC1', 'Saved Before'); await gmapsCycle(s, launch, { ops });
  pin('C2', 'GC2', 'Waiting'); g.mode = 'signin'; await gmapsCycle(s, launch, { ops });
  assert.equal(dest().status, 'needs_signin');
  assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM gmaps_destinations').all()).toLowerCase().includes('someone@example.com'), false, 'the address itself is never stored');
  assert.equal((gmapsStatus(s, 1) as any).account_label, 'so•••@example.com');

  // Another account: refused, nothing changes.
  assert.throws(() => connectGmaps(s, dir, { collectionId: 1, userId: 7, state: session, account: 'other@example.com' }), /different Google account/);
  assert.equal(dest().status, 'needs_signin');

  // The same account, signed in in a server-side profile: that profile becomes the session.
  const prof = path.join(dir, 'signin.profile'); fs.mkdirSync(prof); fs.writeFileSync(path.join(prof, 'Cookies'), 'native');
  const id2 = connectGmaps(s, dir, { collectionId: 1, userId: 7, state: session, profileDir: prof, account: 'someone@example.com' });
  assert.equal(id2, id, 'the same destination'); assert.equal(dest().list_name, 'My Food'); assert.equal(dest().status, 'connected');
  assert.equal((gmapsStatus(s, 1) as any).cutoff_at, cutoff);
  assert.equal(fs.readFileSync(path.join(profileOf(dest().state_file), 'Cookies'), 'utf8'), 'native'); assert.equal(path.resolve(profileOf(dest().state_file)), path.resolve(prof), 'used where it is (its browser is still open)');
  g.mode = 'ok';
  assert.deepEqual(await gmapsCycle(s, launch, { ops }), { saved: 1, failed: 0, skipped: 0 });
  assert.deepEqual(g.list, ['GC1', 'GC2'], 'the waiting place is saved once; the saved one is not saved again');
  assert.equal(g.saves, 2); assert.equal(item('GC1').status, 'verified');
  assert.equal((s.db.prepare('SELECT COUNT(*) n FROM gmaps_destinations').get() as any).n, 1);

  const f = dest().state_file; disconnectGmaps(s, 1);
  assert.equal(fs.existsSync(f), false); assert.equal(fs.existsSync(profileOf(f)), false); assert.equal(fs.existsSync(prof), false, 'the sign-in profile is forgotten too');
  s.close();
});

test('sign-in from a phone: the server\'s browser shows Google\'s page, taps and typing are passed on, and a proven sign-in reconnects the same list', async () => {
  const { dir, s, pin, g, ops, launch, dest, item } = setup();
  connectGmaps(s, dir, { collectionId: 1, userId: 7, state: session });
  pin('D1', 'GD1', 'Saved Before'); await gmapsCycle(s, launch, { ops });
  pin('D2', 'GD2', 'Waiting'); g.mode = 'signin'; await gmapsCycle(s, launch, { ops });
  assert.equal(dest().status, 'needs_signin');

  const web = { url: 'about:blank', body: 'Choose an account Someone someone@example.com Signed out', taps: [] as number[][], typed: [] as string[], keys: [] as string[], seeded: [] as string[], closed: 0, opened: [] as any[] };
  const open = async (d: string, viewport: any) => {
    fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'Cookies'), 'signed-in-on-the-server'); web.opened.push(viewport);
    const page = {
      url: () => web.url, goto: async () => { web.url = 'https://accounts.google.com/v3/signin/accountchooser?continue=x'; },
      locator: () => ({ innerText: async () => web.body }), setViewportSize: async () => {}, evaluate: async () => 'password', screenshot: async () => Buffer.from('jpeg'),
      mouse: { click: async (x: number, y: number) => { web.taps.push([x, y]); }, wheel: async () => {} },
      keyboard: { type: async (t: string) => { web.typed.push(t); }, press: async (k: string) => { web.keys.push(k); } },
    };
    return { pages: () => [page], newPage: async () => page, addCookies: async (c: any[]) => { web.seeded = c.map((x) => x.name); }, storageState: async () => session, close: async () => { web.closed++; } };
  };
  const logs: string[] = []; let connected = 0; let account = 'someone@example.com'; let menu: boolean | null = true;
  const si = new GmapsSignin({ store: () => s, dataDir: () => dir, log: (m) => logs.push(m), onConnected: () => { connected++; }, open, tickMs: 10,
    probe: async () => ({ signedIn: menu, detail: 'test' }), email: async () => account });
  const until = async (status: string) => { for (let i = 0; i < 300; i++) { if ((await si.state(1, 7)).status === status) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail(`sign-in never became ${status}: ${JSON.stringify(await si.state(1, 7))}`); };

  const r = await si.start(1, 7);
  assert.deepEqual([r.width, r.height], [412, 780]);
  assert.deepEqual(web.seeded, ['ACCOUNT_CHOOSER'], 'only the which-account hint is carried over, no session cookies');
  // While the sign-in is open the save cycle leaves this destination's browser alone.
  s.db.prepare("UPDATE gmaps_destinations SET status='ok'").run(); const n = g.launches;
  await gmapsCycle(s, launch, { ops }); assert.equal(g.launches, n);
  s.db.prepare("UPDATE gmaps_destinations SET status='needs_signin'").run();

  assert.equal((await si.state(1, 7)).focus, 'password');
  assert.equal((await si.screen(1, 7)).toString(), 'jpeg');
  await si.input(1, 7, { tap: { x: 200, y: 300 } }); await si.input(1, 7, { text: 'hunter2' }); await si.input(1, 7, { key: 'Enter' });
  assert.deepEqual([web.taps, web.typed, web.keys], [[[200, 300]], ['hunter2'], ['Enter']]);
  await assert.rejects(si.input(1, 7, { key: 'F12' }), /unknown key/);
  await assert.rejects(si.input(1, 7, { tap: { x: 5000, y: 1 } }), /outside/);
  // Only the person who started it, in that collection.
  await assert.rejects(si.screen(1, 8), /no sign-in is open/); await assert.rejects(si.input(2, 7, { text: 'x' }), /no sign-in is open/);
  await assert.rejects(si.start(1, 8), /another Google sign-in is open/);
  assert.equal(logs.join('\n').includes('hunter2'), false, 'nothing typed is logged');

  // A different account than the connected one: refused; the old state stays as it was.
  account = 'other@example.com'; web.url = 'https://www.google.com/maps?hl=en';
  await until('failed');
  assert.match((await si.state(1, 7)).detail, /different Google account/); assert.equal(dest().status, 'needs_signin'); assert.equal(connected, 0);

  // Google Maps opens but the Save menu still asks to sign in: not connected.
  account = 'someone@example.com'; menu = false; web.url = 'about:blank';
  await si.start(1, 7); web.url = 'https://www.google.com/maps?hl=en'; await until('failed');
  assert.equal(dest().status, 'needs_signin');

  // The same account, proven by the Save menu: connected; the waiting place is saved by the next pass.
  menu = true; web.url = 'about:blank';
  await si.start(1, 7); web.url = 'https://www.google.com/maps?hl=en'; await until('connected');
  assert.equal(connected, 1); assert.equal(dest().status, 'connected'); assert.ok(dest().last_ok_at);
  assert.equal(fs.readFileSync(path.join(profileOf(dest().state_file), 'Cookies'), 'utf8'), 'signed-in-on-the-server');
  const closedBefore = web.closed;
  assert.equal(hasLiveBrowser(dest().state_file), true, 'the browser that signed in stays open as the destination browser');
  assert.equal(web.closed, closedBefore);
  assert.equal((s.db.prepare('SELECT COUNT(*) n FROM gmaps_destinations').get() as any).n, 1, 'no second destination');
  g.mode = 'ok';
  assert.equal((await gmapsCheck(s, launch, { probe: async () => assert.fail('just proven: no extra check') })).checked, 0);
  assert.deepEqual(await gmapsCycle(s, launch, { ops }), { saved: 1, failed: 0, skipped: 0 });
  assert.deepEqual(g.list, ['GD1', 'GD2']); assert.equal(item('GD2').status, 'verified');
  assert.equal(JSON.stringify(logs).includes('example.com'), false, 'the account is not logged');
  await si.close(); await closeAllBrowsers(); assert.equal(web.closed, closedBefore + 1, 'closed at shutdown'); s.close();
});

// Found on Railway 2026-11-14: Chromium writes cookies to disk only every ~30 s (a profile had no sign-in cookies while the
// snapshot had them), and a session moved from one browser to a new one was signed out by Google. So the browser stays
// open between runs; after a restart it starts from the snapshot, which is kept up to date on every run.
test('Google Maps list: the browser stays open between runs; after a restart the snapshot cookies are used', async (t) => {
  const { hasGoogleSignin, profileLauncher, readSnapshotCookies, writeSnapshot } = await import('../src/sync/gmapsBrowser.ts');
  assert.equal(hasGoogleSignin(session.cookies), true);
  assert.equal(hasGoogleSignin([{ name: 'NID', domain: '.google.com' }, { name: 'ACCOUNT_CHOOSER', domain: 'accounts.google.com' }]), false, 'a signed-out state never replaces a session');
  assert.equal(hasGoogleSignin([{ name: 'SID', domain: '.example.com' }]), false);
  let chrome = '';
  try { chrome = (await import('../src/sync/mymaps.ts')).findChrome(process.env.CHROME_PATH); } catch { /* none */ }
  if (!chrome) return t.skip('no Chrome/Chromium on this machine');
  const dir = tmpDir('gmaps-profile');
  const file = path.join(dir, 'session-1.json');
  const sid = { name: 'SID', value: 'abc', domain: '.google.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: true, sameSite: 'Lax' as const };
  writeSnapshot(file, { cookies: [sid], origins: [] });
  fs.mkdirSync(profileOf(file), { recursive: true }); // an existing profile WITHOUT the cookies (what the volume held)
  const launch = profileLauncher(chrome);
  try {
    const b = await launch(file);
    assert.ok((await b.page.context().cookies('https://www.google.com')).some((c: any) => c.name === 'SID' && c.value === 'abc'), 'the snapshot cookies are in the browser although the profile lacked them');
    await b.page.context().addCookies([{ ...sid, value: 'rotated' }]); // Google rotates a cookie
    await b.close();
    assert.equal(readSnapshotCookies(file).find((c) => c.name === 'SID')?.value, 'rotated', 'every run keeps the newest cookies');
    const b2 = await launch(file);
    assert.equal(b2.page, b.page, 'the next run uses the same open browser');
    assert.equal(hasLiveBrowser(file), true);
    await b2.page.context().addCookies([{ ...sid, value: 'rotated-2' }]);
    await closeAllBrowsers(); // server shutdown
    assert.equal(hasLiveBrowser(file), false);
    assert.equal(readSnapshotCookies(file).find((c) => c.name === 'SID')?.value, 'rotated-2', 'shutdown keeps the newest cookies');
    const b3 = await launch(file); // after the restart
    assert.equal((await b3.page.context().cookies('https://www.google.com')).find((c: any) => c.name === 'SID')?.value, 'rotated-2');
    await b3.page.context().clearCookies(); // Google cleared the sign-in cookies
    await b3.close();
    assert.equal(readSnapshotCookies(file).find((c) => c.name === 'SID')?.value, 'rotated-2', 'a signed-out state never replaces the snapshot');
  } finally { await closeAllBrowsers(); }
});
