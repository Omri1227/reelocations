/**
 * Two sessions against the deployed app: an emulated iPhone keeps the map open; a desktop Chrome session does a real
 * save in the review page. Measures how long the new pin takes to appear on the phone and checks the phone keeps its
 * screen (country, filter, map position).
 *
 *   BASE=… K=<app token> node scripts/verify-sync.ts chrome --reel <reel_key> --note "<place, city>"
 *       desktop: "Add note & retry" on that Reel, then "Process queue now"; phone stays open (foreground).
 *   BASE=… K=… node scripts/verify-sync.ts background [--timeout 900]
 *       phone goes to the background (page hidden → connection closed), waits until a new pin exists on the server
 *       (e.g. you share a Reel on the iPhone), keeps it hidden 10 s more, then returns to the foreground and measures.
 * The "phone" is Chrome's iPhone emulation (390×844, touch, iOS UA), not a physical iPhone.
 */
import { chromium, type Page } from 'playwright-core';
import { findChrome } from '../src/sync/mymaps.ts';

const BASE = (process.env.BASE ?? '').replace(/\/$/, '');
const K = process.env.K ?? '';
const args = process.argv.slice(2);
const mode = args[0];
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const IPHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const t = () => new Date().toISOString().slice(11, 23);
const api = async () => (await (await fetch(`${BASE}/api/places`, { headers: { 'x-token': K } })).json()) as any;

async function phoneState(p: Page) {
  return p.evaluate(() => {
    const w = window as any; const c = w.__map.getCenter();
    return { country: w.__state.country, type: w.__state.type, zoom: w.__map.getZoom(), center: [+c.lat.toFixed(5), +c.lng.toFixed(5)], ids: w.__state.data.places.map((x: any) => x.id) as string[],
      rows: document.querySelectorAll('.row[data-p]').length, pins: document.querySelectorAll('.pin[data-id]').length, version: w.__version, newAt: w.__lastNewPinAt ?? null, newNames: w.__lastNewPins ?? null, live: document.getElementById('live')!.classList.contains('on') };
  });
}

const browser = await chromium.launch({ executablePath: findChrome(process.env.CHROME_PATH), headless: true });
try {
  const phone = await (await browser.newContext(IPHONE)).newPage();
  await phone.goto(`${BASE}/?k=${encodeURIComponent(K)}`, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('.row[data-c]', { timeout: 30_000 });
  // Put the phone on a country screen with a filter and a hand-moved map, like a person using it.
  const country = opt('country') ?? 'JP';
  await phone.tap(`.row[data-c="${country}"]`); await phone.waitForSelector('.row[data-p]');
  await phone.tap('#chips .chip[data-t="all"]');
  await phone.evaluate(() => { const m = (window as any).__map; m.setView(m.getCenter(), m.getZoom() + 1, { animate: false }); m.panBy([30, -20], { animate: false }); });
  await phone.waitForTimeout(1500);
  const before = await phoneState(phone);
  console.log(`${t()} phone open on ${before.country}, filter ${before.type}, zoom ${before.zoom}, ${before.ids.length} places, live connection: ${before.live}`);

  if (mode === 'chrome') {
    const reel = opt('reel')!, note = opt('note')!;
    const desk = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    desk.on('response', (r) => { if (r.request().method() === 'POST' || r.status() >= 300) console.log(`${t()} desktop ${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`); });
    await desk.goto(`${BASE}/review?k=${encodeURIComponent(K)}`, { waitUntil: 'domcontentloaded' });
    const card = desk.locator(`section.card[id="${reel}"]`);
    await card.locator('form:has(input[name=op][value=note]) input[name=q]').fill(note);
    await Promise.all([desk.waitForURL((u) => u.pathname === '/review/', { timeout: 60_000 }), card.locator('form:has(input[name=op][value=note]) button').click()]);
    console.log(`${t()} desktop Chrome: note "${note}" added to ${reel} (Reel re-queued)`);
    const tClick = Date.now();
    console.log(`${t()} desktop Chrome: clicking "Process queue now"`);
    await desk.locator('form:has(input[name=op][value=run]) button').click({ noWaitAfter: true });
    let tSaved = 0, tPhone = 0, newIds: string[] = [];
    const deadline = Date.now() + 5 * 60_000;
    // Watch the phone (what the person sees) and, separately, the server (when the save committed).
    const serverWatch = (async () => { while (!tSaved && Date.now() < deadline) { const d = await api(); const n = d.places.filter((p: any) => !before.ids.includes(p.id)); if (n.length) { tSaved = Date.now(); newIds = n.map((p: any) => p.id); console.log(`${t()} server: new pin(s) saved: ${n.map((p: any) => `${p.name} [${p.google_place_id ?? 'no place id'}]`).join(', ')}`); } else await new Promise((r) => setTimeout(r, 250)); } })();
    while (!tPhone && Date.now() < deadline) { const s = await phoneState(phone); if (s.ids.some((id) => !before.ids.includes(id))) tPhone = Date.now(); else await phone.waitForTimeout(100); }
    await serverWatch;
    await desk.waitForLoadState('domcontentloaded').catch(() => {});
    const after = await phoneState(phone);
    if (!tPhone) { console.log('✘ no new pin reached the phone within 5 min'); process.exitCode = 1; }
    else {
      console.log(`${t()} phone: new pin visible (${after.newNames?.join(', ')})`);
      console.log(`RESULT chrome-save → phone: ${((tPhone - tClick) / 1000).toFixed(1)} s total after the click (processing ${((tSaved - tClick) / 1000).toFixed(1)} s, server → phone ${((tPhone - tSaved) / 1000).toFixed(1)} s; server watcher polls every 0.25 s)`);
      const kept = after.country === before.country && after.type === before.type && after.zoom === before.zoom && after.center.join() === before.center.join();
      console.log(`${kept ? '✔' : '✘'} phone kept its screen: country ${after.country}, filter ${after.type}, zoom ${after.zoom}, centre ${after.center} (before ${before.center})`);
      console.log(`${after.rows > before.rows || !newIds.some((id) => after.ids.includes(id)) ? '✔' : '–'} list ${before.rows} → ${after.rows} rows, map ${before.pins} → ${after.pins} pins on this country screen`);
    }
  } else if (mode === 'background') {
    await phone.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    console.log(`${t()} phone → background (page hidden; live connection closed: ${!(await phoneState(phone)).live})`);
    const timeout = Number(opt('timeout') ?? 900) * 1000, deadline = Date.now() + timeout;
    let fresh: any[] = [];
    while (!fresh.length && Date.now() < deadline) { const d = await api(); fresh = d.places.filter((p: any) => !before.ids.includes(p.id)); if (!fresh.length) await new Promise((r) => setTimeout(r, 2000)); }
    if (!fresh.length) { console.log('✘ no new pin on the server within the timeout'); process.exitCode = 1; }
    else {
      console.log(`${t()} server: new pin(s) while the phone was in the background: ${fresh.map((p: any) => `${p.name} (${p.country}) [${p.google_place_id ?? 'no place id'}] created ${p.created_at}`).join(', ')}`);
      await phone.waitForTimeout(10_000);
      const hiddenState = await phoneState(phone);
      console.log(`${hiddenState.ids.length === before.ids.length ? '✔' : '✘'} still hidden 10 s later: the phone has NOT updated (${hiddenState.ids.length} places)`);
      const tFg = Date.now();
      await phone.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      let after = await phoneState(phone);
      while (!fresh.every((p) => after.ids.includes(p.id)) && Date.now() - tFg < 30_000) { await phone.waitForTimeout(50); after = await phoneState(phone); }
      const ok = fresh.every((p) => after.ids.includes(p.id));
      console.log(`${ok ? '✔' : '✘'} RESULT foreground → new pin on the phone in ${((Date.now() - tFg) / 1000).toFixed(2)} s (${after.newNames?.join(', ')})`);
      console.log(`${after.country === before.country && after.type === before.type && after.zoom === before.zoom ? '✔' : '✘'} kept country ${after.country}, filter ${after.type}, zoom ${after.zoom}`);
      await phone.waitForTimeout(2000);
      console.log(`${(await phoneState(phone)).live ? '✔' : '✘'} live connection re-opened after returning to the foreground`);
      if (!ok) process.exitCode = 1;
    }
  } else { console.log('usage: verify-sync.ts chrome --reel <key> --note "<text>" | background [--timeout s]'); process.exitCode = 1; }
} finally { await browser.close(); }
