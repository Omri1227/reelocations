#!/usr/bin/env node
/**
 * End-to-end checks of Nearby, New, Star, the Review Queue button and the reelocations name/icons, in Chrome's iPhone
 * EMULATION (390×844, touch, iOS Safari UA) and at desktop size. Run against a LOCAL COPY of the data only (it stars,
 * opens and resolves things):
 *   node scripts/local-ui-server.ts <copy dir>/reel-maps.sqlite 18791   → SESSION=…
 *   BASE=http://127.0.0.1:18791 SESSION=… DB=<copy dir>/reel-maps.sqlite node scripts/verify-features.ts [--shots dir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { findChrome } from '../src/sync/mymaps.ts';

const BASE = (process.env.BASE ?? 'http://127.0.0.1:18791').replace(/\/$/, '');
const SESSION = process.env.SESSION ?? '';
const DB = process.env.DB ?? '';
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1]! : '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const IPHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const results: { step: string; ok: boolean; detail?: string }[] = [];
const check = (step: string, ok: boolean, detail?: string) => { results.push({ step, ok, detail }); console.log(`${ok ? '✔' : '✘'} ${step}${detail ? ` — ${detail}` : ''}`); };
const M_PER_DEG = (2 * Math.PI * 6371000) / 360;

async function touch(page: Page, pts: { x: number; y: number }[], holdMs = 0) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0]!.x, y: pts[0]!.y, id: 1 }] });
  if (holdMs) await page.waitForTimeout(holdMs);
  for (const p of pts.slice(1)) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y, id: 1 }] }); await page.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const line = (a: { x: number; y: number }, b: { x: number; y: number }, n = 8) => Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
const center = async (page: Page, sel: string) => { const b = (await page.locator(sel).first().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

async function newCtx(browser: Awaited<ReturnType<typeof chromium.launch>>, opts: any = IPHONE): Promise<BrowserContext> {
  const ctx = await browser.newContext(opts);
  const u = new URL(BASE);
  await ctx.addCookies([{ name: 'rm_s', value: SESSION, domain: u.hostname, path: '/', httpOnly: true, secure: u.protocol === 'https:', sameSite: 'Lax' }]);
  return ctx;
}
async function open(ctx: BrowserContext, hashOrPath = '/') {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => check('no JavaScript errors', false, e.message));
  await page.goto(`${BASE}${hashOrPath}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__state?.data, null, { timeout: 20_000 });
  await page.waitForTimeout(500);
  return page;
}
const data = (page: Page) => page.evaluate(() => (window as any).__state.data);
const shot = async (page: Page, n: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${n}.png`) }); };

const db = DB ? new DatabaseSync(DB) : null;
const browser = await chromium.launch({ executablePath: findChrome(process.env.CHROME_PATH), headless: true });
try {
  // ================= name, icons, install metadata, old links =================
  {
    const ctx = await newCtx(browser); const page = await open(ctx);
    const head = await page.evaluate(() => ({ title: document.title, app: document.querySelector('meta[name=apple-mobile-web-app-title]')?.getAttribute('content'), manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href'), touch: document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href'), h1: document.getElementById('title')!.textContent }));
    check('page title, Home Screen title and header say "reelocations"', head.title === 'reelocations' && head.app === 'reelocations' && /^reelocations/.test(head.h1 ?? ''), JSON.stringify(head));
    const man = await (await fetch(`${BASE}${head.manifest}`)).json() as any;
    check('web app manifest: name, start URL, standalone, icons', man.name === 'reelocations' && man.short_name === 'reelocations' && man.start_url === '/' && man.display === 'standalone' && man.icons.length >= 3, man.icons.map((i: any) => `${i.src} ${i.sizes} ${i.purpose}`).join(', '));
    const ati = await fetch(`${BASE}${head.touch}`); const buf = Buffer.from(await ati.arrayBuffer());
    check('Apple touch icon is a 180×180 PNG', ati.headers.get('content-type') === 'image/png' && buf.readUInt32BE(16) === 180 && buf.readUInt32BE(20) === 180);
    for (const p of ['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/icon.svg', '/favicon.ico']) { const r = await fetch(`${BASE}${p}`); check(`${p} is served`, r.ok && /image\//.test(r.headers.get('content-type') ?? ''), r.headers.get('content-type') ?? ''); }
    const landing = await (await fetch(`${BASE}/signin`)).text();
    check('sign-in page renamed and shows the icon', /<title>reelocations<\/title>/.test(landing) && /icon\.svg/.test(landing) && !/Reel Maps/.test(landing));
    // Existing links keep working: routes are unchanged.
    const st = async (p: string, init?: RequestInit) => (await fetch(`${BASE}${p}`, { redirect: 'manual', ...init })).status;
    check('old routes still answer (/signin, /signup, /setup → sign-in redirect, /review → sign-in redirect, /api/intake)', await st('/signin') === 200 && await st('/signup') === 200 && await st('/setup') === 303 && await st('/review') === 303
      && await st('/api/intake', { method: 'POST', body: '{"token":"x","text":"t"}', headers: { 'content-type': 'application/json' } }) === 200);
    await shot(page, 'f1-home');
    // ================= Review Queue button =================
    const d = await data(page);
    const rq = await page.$eval('#rq', (a) => { const r = a.getBoundingClientRect(); return { text: a.textContent!.trim(), right: r.right, top: r.top, label: a.getAttribute('aria-label'), href: (a as HTMLAnchorElement).getAttribute('href') }; });
    check('Review Queue button in the top bar shows the count, fully visible on iPhone', rq.text === `Review Queue · ${d.review_count}` && rq.right <= 390 && rq.top < 140, `${rq.text} (${rq.label})`);
    // Pick a country and a filter, open the queue, resolve one item, come back.
    const country = (await page.$$eval('.row[data-c]', (r) => r.map((x) => x.getAttribute('data-c'))))[0]!;
    await page.tap(`.row[data-c="${country}"]`); await page.waitForTimeout(300);
    const chip = await page.$$eval('#chips .chip[data-t]', (c) => c.map((x) => x.getAttribute('data-t')).filter((t) => t !== 'all')[0]);
    if (chip) { await page.tap(`#chips .chip[data-t="${chip}"]`); await page.waitForTimeout(200); }
    const before = await page.evaluate(() => ({ c: (window as any).__state.country, t: (window as any).__state.type }));
    await Promise.all([page.waitForURL(/\/review/), page.tap('#rq')]);
    const reviewPage = await page.evaluate(() => ({ h1: document.querySelector('h1')!.textContent, open: Number(document.body.innerHTML.match(/Needs attention \((\d+)\)/)?.[1] ?? -1), title: document.title }));
    check('the button opens this collection\'s Review Queue with the same count', reviewPage.h1 === 'Review Queue' && reviewPage.open === d.review_count, JSON.stringify(reviewPage));
    if (reviewPage.open > 0) {
      await Promise.all([page.waitForEvent('framenavigated'), page.locator('section.needs_review form:has(input[value="nap"]) button, section.error form:has(input[value="nap"]) button').first().tap()]);
      await page.waitForLoadState('domcontentloaded');
      const after = Number((await page.content()).match(/Needs attention \((\d+)\)/)?.[1] ?? -1);
      check('resolving an item ("Not a place") reduces the queue', after === reviewPage.open - 1, `${reviewPage.open} → ${after}`);
      await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.locator('a[href="/"]').first().tap()]);
      await page.waitForFunction(() => (window as any).__state?.data, null, { timeout: 20_000 }); await page.waitForTimeout(600);
      const back = await page.evaluate(() => ({ c: (window as any).__state.country, t: (window as any).__state.type, n: (window as any).__state.data.review_count, txt: document.getElementById('rq')!.textContent!.trim() }));
      check('back on the map: count updated, same country and filter', back.n === reviewPage.open - 1 && back.txt === `Review Queue · ${back.n}` && back.c === before.c && back.t === before.t, JSON.stringify({ before, back }));
    }
    await ctx.close();
  }

  // ================= New indicator (per user; only places added after the user started) =================
  const d0 = await (async () => { const ctx = await newCtx(browser); const p = await open(ctx); const d = await data(p); await ctx.close(); return d; })();
  if (db) {
    // Make the two most recently added pins "new" for this user: move the user's start time just before them.
    const order = [...d0.places].sort((a: any, b: any) => (a.added_at < b.added_at ? -1 : 1));
    const pivot = order[order.length - 2].added_at;
    const uid = (db.prepare("SELECT id FROM users WHERE google_sub='local-owner'").get() as any).id;
    db.prepare('DELETE FROM user_place_state WHERE user_id=?').run(uid);
    db.prepare('INSERT OR REPLACE INTO user_collection_state(user_id, collection_id, new_since) VALUES (?,1,?)').run(uid, new Date(Date.parse(pivot) - 1000).toISOString());
    const ctx = await newCtx(browser); const page = await open(ctx);
    const d = await data(page);
    const fresh = d.places.filter((p: any) => p.is_new);
    check('only places added after the user started are New (2 of ' + d.places.length + ')', fresh.length === 2, fresh.map((p: any) => p.name).join(', '));
    const [a, b] = fresh;
    await page.tap(`.row[data-c="${a.country_code || a.country}"]`); await page.waitForTimeout(300);
    const pill = await page.$(`.row[data-p="${a.id}"] .newb`);
    const pinNew = await page.$(`.pin.isnew[data-id="${a.id}"]`);
    check('New shows beside the place in the list and on its pin', !!pill && !!pinNew);
    await shot(page, 'f2-new');
    // Scrolling past keeps it.
    await page.evaluate(() => { const l = document.getElementById('list')!; l.scrollTop = l.scrollHeight; }); await page.waitForTimeout(200);
    await page.evaluate(() => { document.getElementById('list')!.scrollTop = 0; }); await page.waitForTimeout(200);
    check('scrolling past leaves New in place', !!(await page.$(`.row[data-p="${a.id}"] .newb`)));
    await page.locator(`.row[data-p="${a.id}"]`).scrollIntoViewIfNeeded(); await page.tap(`.row[data-p="${a.id}"]`); await page.waitForTimeout(700);
    check('opening its details from the list clears New (list and pin)', !(await page.$(`.row[data-p="${a.id}"] .newb`)) && !(await page.$(`.pin.isnew[data-id="${a.id}"]`)) && !!(await page.$('.leaflet-popup .pd')));
    // b: open by tapping its PIN on the map.
    await page.evaluate(() => (window as any).__map.closePopup());
    await page.evaluate((cc) => { (window as any).__state.country = cc; }, b.country_code || b.country);
    if ((b.country_code || b.country) !== (a.country_code || a.country)) { await page.tap('#back'); await page.waitForTimeout(300); await page.tap(`.row[data-c="${b.country_code || b.country}"]`); await page.waitForTimeout(500); }
    await page.evaluate((id) => { const w = window as any; w.__map.setView(w.__markers[id].marker.getLatLng(), 15, { animate: false }); }, b.id); await page.waitForTimeout(400);
    await page.locator(`.pin[data-id="${b.id}"]`).click({ force: true }); await page.waitForTimeout(700);
    check('tapping the map pin opens the details and clears New', !(await page.$(`.pin.isnew[data-id="${b.id}"]`)) && !(await page.$(`.row[data-p="${b.id}"] .newb`)));
    await ctx.close();
    // Persisted for this user (new session/device) — and another member still sees them as new.
    const ctx2 = await newCtx(browser); const p2 = await open(ctx2);
    check('opened state persists across sessions/devices', (await data(p2)).places.filter((p: any) => p.is_new).length === 0);
    await ctx2.close();
  }

  // ================= Star (long-press) + Starred section + filters + gestures =================
  {
    const ctx = await newCtx(browser); const page = await open(ctx);
    const d = await data(page);
    // A country with ≥2 city groups.
    const byC = new Map<string, any[]>(); for (const p of d.places) { const k = p.country_code || p.country; byC.set(k, [...(byC.get(k) ?? []), p]); }
    const [ck, ps] = [...byC].sort((x, y) => new Set(y[1].map((p: any) => p.locality)).size - new Set(x[1].map((p: any) => p.locality)).size)[0]!;
    await page.tap(`.row[data-c="${ck}"]`); await page.waitForTimeout(400);
    const target = [...ps].sort((a: any, b: any) => (b.locality ?? '').localeCompare(a.locality ?? ''))[0];   // last city group → must jump up
    await page.locator(`.row[data-p="${target.id}"]`).scrollIntoViewIfNeeded();
    // Normal tap: details, no menu.
    await page.tap(`.row[data-p="${target.id}"]`); await page.waitForTimeout(500);
    check('a normal tap opens the details, not the menu', !!(await page.$('.leaflet-popup .pd')) && await page.$eval('#sheet', (s) => (s as HTMLElement).hidden));
    await page.evaluate(() => (window as any).__map.closePopup());
    // Vertical scroll starting on the row: no menu.
    const c0 = await center(page, `.row[data-p="${target.id}"]`);
    await touch(page, line(c0, { x: c0.x, y: c0.y - 120 }), 0); await page.waitForTimeout(700);
    check('scrolling vertically from a row does not open the menu', await page.$eval('#sheet', (s) => (s as HTMLElement).hidden));
    await page.locator(`.row[data-p="${target.id}"]`).scrollIntoViewIfNeeded();
    // Left swipe: Delete appears, no menu.
    const c1 = await center(page, `.row[data-p="${target.id}"]`);
    if (target.can_delete) {
      await touch(page, line(c1, { x: c1.x - 150, y: c1.y }));
      await page.waitForTimeout(500);
      check('left swipe still reveals Delete (no menu)', await page.$eval(`.swipe[data-sw="${target.id}"]`, (s) => s.classList.contains('open')) && await page.$eval('#sheet', (s) => (s as HTMLElement).hidden));
      await page.tap(`.row[data-p="${target.id}"]`); await page.waitForTimeout(300);   // closes the swipe
    }
    // Long-press → menu → Star.
    const c2 = await center(page, `.row[data-p="${target.id}"]`);
    await touch(page, [c2], 700); await page.waitForTimeout(300);
    const menu = await page.$eval('#sheet', (s) => ({ hidden: (s as HTMLElement).hidden, star: s.querySelector('#sh-star')!.textContent }));
    check('long-press opens the menu with Star', !menu.hidden && /^☆ Star/.test(menu.star ?? ''), menu.star ?? '');
    check('the long-press did not also open the details', !(await page.$('.leaflet-popup .pd')));
    await shot(page, 'f3-longpress');
    await page.tap('#sh-star'); await page.waitForTimeout(500);
    const secs = await page.$$eval('#list .sec, #list .row[data-p]', (els) => els.map((e) => e.classList.contains('sec') ? `#${e.textContent}` : e.getAttribute('data-p')));
    const starIdx = secs.indexOf('#★ Starred'), firstCity = secs.findIndex((s, i) => i > starIdx && s?.startsWith('#'));
    check('starred place moves into "★ Starred" above every city group, shown once', starIdx === 0 && secs[1] === target.id && secs.filter((s) => s === target.id).length === 1 && firstCity > 1, secs.slice(0, 5).join(' | '));
    await shot(page, 'f4-starred');
    // Filter that excludes it hides it from Starred too; a filter that includes it keeps it.
    const other = d.categories.find((c: any) => c.key !== target.category && ps.some((p: any) => p.category === c.key));
    if (other) {
      await page.tap(`#chips .chip[data-t="${other.key}"]`); await page.waitForTimeout(300);
      check('active type filter applies to the Starred section', !(await page.$(`.row[data-p="${target.id}"]`)));
      await page.tap(`#chips .chip[data-t="${target.category}"]`); await page.waitForTimeout(300);
      check('…and the starred place is back at the top under its own type', (await page.$$eval('#list .sec', (s) => s.map((x) => x.textContent)))[0] === '★ Starred');
      await page.tap('#chips .chip[data-t="all"]'); await page.waitForTimeout(300);
    }
    await ctx.close();
    // Persisted for this user.
    const ctx2 = await newCtx(browser); const p2 = await open(ctx2);
    check('star persists (new session/device)', (await data(p2)).places.find((p: any) => p.id === target.id)?.starred === true);
    await p2.tap(`.row[data-c="${ck}"]`); await p2.waitForTimeout(300);
    await touch(p2, [await center(p2, `.row[data-p="${target.id}"]`)], 700); await p2.waitForTimeout(300);
    check('long-press on a starred place offers Unstar', /Unstar/.test(await p2.$eval('#sh-star', (b) => b.textContent ?? '')));
    await p2.tap('#sh-star'); await p2.waitForTimeout(400);
    const city = await p2.evaluate((id) => { let el = document.querySelector(`.row[data-p="${id}"]`)!.closest('.swipe') ?? document.querySelector(`.row[data-p="${id}"]`)!; let s: Element | null = el; while (s && !s.classList.contains('sec')) s = s.previousElementSibling; return s?.textContent; }, target.id);
    check('unstarring returns it to its city group', city === (target.locality || 'Other') && !(await p2.$('#list .sec.starred')), String(city));
    await ctx2.close();
  }

  // ================= desktop: right-click and keyboard =================
  {
    const ctx = await newCtx(browser, { viewport: { width: 1280, height: 800 } }); const page = await open(ctx);
    await page.locator('.row[data-c]').first().click(); await page.waitForTimeout(300);
    const id = await page.$eval('.row[data-p]', (r) => r.getAttribute('data-p')!);
    await page.click(`.row[data-p="${id}"]`, { button: 'right' }); await page.waitForTimeout(200);
    check('desktop: right-click opens the Star menu, focus on Star', !(await page.$eval('#sheet', (s) => (s as HTMLElement).hidden)) && await page.evaluate(() => document.activeElement?.id) === 'sh-star');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    await page.focus(`.row[data-p="${id}"]`); await page.keyboard.press('s'); await page.waitForTimeout(300);
    check('keyboard: "s" on a focused place stars it', (await data(page)).places.find((p: any) => p.id === id).starred === true);
    await page.focus(`.row[data-p="${id}"]`); await page.keyboard.press('Shift+F10'); await page.waitForTimeout(200);
    check('keyboard: Shift+F10 opens the menu (Unstar)', /Unstar/.test(await page.$eval('#sh-star', (b) => b.textContent ?? '')));
    await page.keyboard.press('Enter'); await page.waitForTimeout(300);
    check('…Enter unstars', (await data(page)).places.find((p: any) => p.id === id).starred === false);
    await ctx.close();
  }

  // ================= Nearby =================
  {
    const target = [...d0.places].find((p: any) => p.confidence === 'confirmed' && p.kind !== 'route')!;
    const origin = new URL(BASE).origin;
    const at = (m: number, acc = 10) => ({ latitude: target.lat - m / M_PER_DEG, longitude: target.lon, accuracy: acc });
    // Denied
    {
      const ctx = await newCtx(browser); const page = await open(ctx);
      await page.tap('#tab-nearby'); await page.waitForTimeout(300);
      const intro = await page.$eval('#list', (l) => l.textContent ?? '');
      check('Nearby explains why location is needed before asking', /not saved/.test(intro) && !!(await page.$('#geo-on')));
      await shot(page, 'f5-nearby-intro');
      await page.tap('#geo-on'); await page.waitForTimeout(1500);
      const txt = await page.$eval('#list', (l) => l.textContent ?? '');
      check('denied permission: clear message with iPhone settings steps and Try again', /turned off/.test(txt) && /Website Settings/.test(txt) && /Safari Websites/.test(txt) && !!(await page.$('#geo-retry')));
      await shot(page, 'f6-nearby-denied');
      await ctx.close();
    }
    // Granted
    const ctx = await newCtx(browser, { ...IPHONE, geolocation: at(99), permissions: ['geolocation'] });
    const sent: string[] = [];
    ctx.on('request', (r) => { sent.push(`${r.url()} ${r.postData() ?? ''}`); });
    const page = await open(ctx);
    await page.tap('#tab-nearby'); await page.waitForTimeout(400);
    if (await page.$('#geo-on')) await page.tap('#geo-on');
    await page.waitForSelector('.nbar', { timeout: 10_000 });
    await page.tap('#rchips .chip[data-r="100"]'); await page.waitForTimeout(400);
    const has = async (id: string) => !!(await page.$(`.row[data-p="${id}"]`));
    check('99 m away → listed under 100 m', await has(target.id));
    await ctx.setGeolocation(at(101)); await page.tap('#geo-refresh'); await page.waitForTimeout(1200);
    check('101 m away → not under 100 m', !(await has(target.id)));
    await page.tap('#rchips .chip[data-r="250"]'); await page.waitForTimeout(300);
    check('…but under 250 m', await has(target.id));
    await ctx.setGeolocation(at(249)); await page.tap('#geo-refresh'); await page.waitForTimeout(1200);
    const in250 = await has(target.id);
    await ctx.setGeolocation(at(251)); await page.tap('#geo-refresh'); await page.waitForTimeout(1200);
    check('250 m boundary: 249 m in, 251 m out', in250 && !(await has(target.id)));
    await ctx.setGeolocation(at(480)); await page.tap('#geo-refresh'); await page.waitForTimeout(1200);
    await page.tap('#rchips .chip[data-r="500"]'); await page.waitForTimeout(300);
    const in500 = await has(target.id);
    await page.tap('#rchips .chip[data-r="1000"]'); await page.waitForTimeout(300);
    check('500 m and 1 km: 480 m away is in both', in500 && await has(target.id));
    const consist = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#list .row[data-p]')].map((r) => r.getAttribute('data-p'));
      const pins = [...document.querySelectorAll('.pin[data-id]')].map((p) => p.getAttribute('data-id'));
      const d = [...document.querySelectorAll('#list .dist')].map((x) => parseFloat(x.textContent!.replace(/[^\d.]/g, '')) * (/km/.test(x.textContent!) ? 1000 : 1));
      return { rows, pins, sorted: d.every((v, i) => i === 0 || v >= d[i - 1]!), me: !!document.querySelector('.me') };
    });
    check('map markers = list rows, sorted by distance, your position shown', consist.rows.length > 0 && consist.rows.length === consist.pins.length && consist.rows.every((r) => consist.pins.includes(r)) && consist.sorted && consist.me, `${consist.rows.length} places`);
    await shot(page, 'f7-nearby-1km');
    // Weak GPS
    await ctx.setGeolocation(at(60, 350)); await page.tap('#geo-refresh'); await page.waitForTimeout(1200);
    await page.tap('#rchips .chip[data-r="100"]'); await page.waitForTimeout(300);
    const weak = await page.$eval('#list', (l) => ({ warn: l.querySelector('.warnbox')?.textContent ?? '', dist: l.querySelector('.dist')?.textContent ?? '' }));
    check('weak GPS (±350 m) at "Under 100 m": a clear warning, distances marked ≈', /±350 m/.test(weak.warn) && /wider than/.test(weak.warn) && /^≈/.test(weak.dist), weak.warn.slice(0, 90));
    await shot(page, 'f8-nearby-weak');
    // Back to Places and again to Nearby: position refreshed.
    const t0 = await page.evaluate(() => Date.now());
    await page.tap('#tab-places'); await page.waitForTimeout(300); await page.tap('#tab-nearby'); await page.waitForTimeout(1200);
    const at2 = await page.evaluate(() => (document.querySelector('.nbar')?.textContent ?? ''));
    check('returning to Nearby refreshes the position', /just now/.test(at2) && (await page.evaluate(() => Date.now())) >= t0);
    // Location never leaves the page.
    const lat = target.lat.toFixed(3);
    check('the phone\'s position is never sent to the server', !sent.some((s) => /\/api\//.test(s) && (s.includes(String((target.lat - 60 / M_PER_DEG).toFixed(4))) || /"lat"|latitude/.test(s.split(' ').slice(1).join(' ')))), `${sent.filter((s) => s.includes('/api/')).length} API requests checked (pin lat ${lat})`);
    const stored = db ? (db.prepare("SELECT count(*) n FROM kv WHERE v LIKE ?").get(`%${(target.lat - 60 / M_PER_DEG).toFixed(5)}%`) as any).n : 0;
    check('nothing about the position is stored in the collection data', stored === 0);
    await ctx.close();
  }
} finally {
  await browser.close();
  db?.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  if (bad.length) process.exitCode = 1;
}
