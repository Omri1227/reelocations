/**
 * Drives the map at iPhone size (390×844, touch, iOS Safari UA) with the installed Chrome (device EMULATION, not a
 * physical iPhone) and checks the interactions end to end.
 *   BASE=http://127.0.0.1:18791 SESSION=<rm_s cookie> node scripts/verify-ui.ts [--shots <dir>] [--delete]
 * --delete really deletes one pin (use only against a local COPY of the data).
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { findChrome } from '../src/sync/mymaps.ts';

const BASE = (process.env.BASE ?? 'http://127.0.0.1:18791').replace(/\/$/, '');
const SESSION = process.env.SESSION ?? '';
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1]! : '';
if (shots) fs.mkdirSync(shots, { recursive: true });
export const IPHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const results: { step: string; ok: boolean; detail?: string }[] = [];
const check = (step: string, ok: boolean, detail?: string) => { results.push({ step, ok, detail }); console.log(`${ok ? '✔' : '✘'} ${step}${detail ? ` — ${detail}` : ''}`); };

/** Real touch gesture through the Chrome DevTools protocol (Playwright has no touch-move API). */
async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8, holdMs = 0, endHoldMs = 0) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (x: number, y: number) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from.x, from.y) });
  if (holdMs) await page.waitForTimeout(holdMs);
  for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps) }); await page.waitForTimeout(16); }
  if (endHoldMs) await page.waitForTimeout(endHoldMs);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const state = (page: Page) => page.evaluate(() => { const w = window as any; const c = w.__map.getCenter(); return { country: w.__state.country, type: w.__state.type, sub: w.__state.sub, sel: w.__state.sel, zoom: w.__map.getZoom(), center: [+c.lat.toFixed(5), +c.lng.toFixed(5)] }; });

const browser = await chromium.launch({ executablePath: findChrome(process.env.CHROME_PATH), headless: true });
try {
  const ctx = await browser.newContext(IPHONE);
  const u = new URL(BASE);
  await ctx.addCookies([{ name: 'rm_s', value: SESSION, domain: u.hostname, path: '/', httpOnly: true, secure: u.protocol === 'https:', sameSite: 'Lax' }]);
  const page = await ctx.newPage();
  const shot = async (n: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${n}.png`) }); };
  page.on('pageerror', (e) => check('no JavaScript errors', false, e.message));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row[data-c]', { timeout: 20_000 });
  await page.waitForTimeout(800);

  // ---- country screen ----
  const data = await page.evaluate(() => (window as any).__state.data);
  const per = new Map<string, number>(); for (const p of data.places) per.set(p.country_code || p.country, (per.get(p.country_code || p.country) ?? 0) + 1);
  const rows = async () => page.$$eval('.row[data-c]', (rs) => rs.map((r) => ({ key: r.getAttribute('data-c')!, n: Number(r.querySelector('.cnt')!.textContent) })));
  let cs = await rows();
  check(`first screen: every country separately with its count (${cs.length} countries, no cap)`, cs.length === per.size && cs.every((c) => per.get(c.key) === c.n) && !(await page.$('.row[data-p]')), cs.map((c) => `${c.key} ${c.n}`).join(', '));
  const defaultOrder = [...per].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  if (!data.country_order.length) check('default order: by number of places', cs.every((c, i) => per.get(c.key) === per.get(defaultOrder[i]!)));
  await shot('1-countries');

  // ---- AI allowance indicator (this session is the installation owner, so it may see billing) ----
  await page.waitForSelector('#ai:not([hidden])', { timeout: 5000 }).catch(() => {});
  const aiTxt = await page.$eval('#ai', (b) => ({ hidden: (b as HTMLElement).hidden, text: b.textContent!.trim(), w: b.getBoundingClientRect().width }));
  check('header shows "AI Balance" (text, no robot icon) and fits the header', !aiTxt.hidden && /^AI Balance/.test(aiTxt.text) && !/🤖/.test(aiTxt.text) && aiTxt.w < 170, `${aiTxt.text} · ${Math.round(aiTxt.w)} px`);
  await page.tap('#ai'); await page.waitForTimeout(300);
  const panel = await page.$eval('#aip', (o) => ({ open: !(o as HTMLElement).hidden, t: o.textContent ?? '' }));
  check('tapping it opens a short panel: the estimate first, the balance, a field to update it', panel.open && /AI Balance/.test(panel.t) && /Reels left|No Reels left|Not enough data/.test(panel.t) && /Balance/.test(panel.t) && panel.t.length < 400, panel.t.slice(0, 160));
  await shot('1b-ai-panel');
  await page.fill('#aiusd', '4.80'); await page.tap('#aip button:not(.ghost)'); await page.waitForTimeout(600);
  const after = await page.$eval('#aip', (o) => o.textContent ?? '');
  check('saving a balance updates the panel (amount and the date it was entered)', /of \$4\.80 entered/.test(after), after.slice(0, 160));
  await shot('1c-ai-balance');
  await page.tap('#aiclose'); await page.waitForTimeout(200);

  // ---- long-press a country and drag it ----
  const last = cs[cs.length - 1]!.key;
  // Like a person: scroll down to the last country, long-press it, drag it to the top edge of the list and hold there
  // while the list scrolls up, then let go.
  const box = await page.$eval(`.row[data-c="${last}"]`, (el) => { el.scrollIntoView({ block: 'end' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, h: b.height }; });
  const listTop = await page.$eval('#list', (l) => l.getBoundingClientRect().top);
  await swipe(page, { x: box.x, y: box.y }, { x: box.x, y: listTop + 6 }, 24, 600, 2500);
  await page.waitForTimeout(700);
  cs = await rows();
  check(`long-press + drag moves "${last}" to the top`, cs[0]!.key === last, cs.slice(0, 3).map((c) => c.key).join(', '));
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.row[data-c]'); await page.waitForTimeout(600);
  check('the new order is kept after reload (saved on the server)', (await rows())[0]!.key === last);
  await shot('2-reordered');
  // A short tap still opens the country (long-press does not break taps).
  const target = data.places.some((p: any) => p.country_code === 'JP') ? 'JP' : cs[0]!.key;
  await page.tap(`.row[data-c="${target}"]`);
  await page.waitForSelector('.row[data-p]');
  await page.waitForTimeout(500);
  check(`tap opens ${target}: its places and only its pins`, (await page.$$('.row[data-p]')).length === per.get(target) && (await page.$$('.pin[data-id]')).length === per.get(target));

  // ---- restaurant subtypes ----
  if (await page.$('#chips .chip[data-t="restaurant"]')) {
    await page.tap('#chips .chip[data-t="restaurant"]'); await page.waitForTimeout(400);
    const allR = await page.$$eval('.row[data-p]', (r) => r.length);
    const sub = await page.$$eval('#subchips .chip[data-s]', (cs) => cs.map((c) => c.getAttribute('data-s')!).filter((s) => s !== 'all'));
    check('Restaurant shows the subtype chips', !(await page.$eval('#subchips', (e) => (e as HTMLElement).hidden)) && sub.length > 0, sub.join(', '));
    const want = sub.includes('yakiniku') ? 'yakiniku' : sub[0]!;
    await page.tap(`#subchips .chip[data-s="${want}"]`); await page.waitForTimeout(400);
    const exp = data.places.filter((p: any) => p.country_code === target && p.category === 'restaurant' && p.cuisine === want).map((p: any) => p.id).sort();
    const got = (await page.$$eval('.row[data-p]', (r) => r.map((x) => x.getAttribute('data-p')!))).sort();
    const pins = (await page.$$eval('.pin[data-id]', (r) => r.map((x) => x.getAttribute('data-id')!))).sort();
    check(`"${want}" filter: list and map show exactly the ${want} places, which are also in All restaurants (${allR})`, JSON.stringify(got) === JSON.stringify(exp) && JSON.stringify(pins) === JSON.stringify(exp) && exp.length <= allR, got.join(', '));
    await shot('3-subtype');
    await page.tap('#subchips .chip[data-s="all"]'); await page.waitForTimeout(300);
  }

  // ---- list tap → pin + details; delete beside the screenshot; preview ----
  const ids = await page.$$eval('.row[data-p]', (r) => r.map((x) => x.getAttribute('data-p')!));
  const withShot = data.places.find((p: any) => ids.includes(p.id) && p.reels.some((r: any) => r.image))?.id ?? ids[0]!;
  await page.$eval(`.row[data-p="${withShot}"]`, (r) => r.scrollIntoView());
  await page.tap(`.row[data-p="${withShot}"]`);
  await page.waitForSelector(`.leaflet-popup .pd[data-id="${withShot}"]`);
  await page.waitForTimeout(700);
  const pop = await page.evaluate(() => {
    const p = document.querySelector('.leaflet-popup')!, m = document.getElementById('map')!.getBoundingClientRect();
    const bottom = p.querySelector('.bottom'), img = bottom?.querySelector('img.shot') as HTMLImageElement | null, del = bottom?.querySelector('.pdel');
    const ib = img?.getBoundingClientRect(), db = del?.getBoundingClientRect();
    return { hasImg: !!img && img.complete && img.naturalWidth > 0, del: !!del, beside: !!(ib && db && Math.abs((ib.bottom) - (db.bottom)) < 40 && db.left > ib.left), isLast: bottom === p.querySelector('.pd')!.lastElementChild, inMap: p.getBoundingClientRect().top >= m.top - 1 };
  });
  check('tapping a place: its pin is highlighted and details open inside the map', pop.inMap && !!(await page.$(`.pin.sel[data-id="${withShot}"]`)));
  check('details end with Delete beside the Reel screenshot', pop.del && pop.isLast && (pop.hasImg ? pop.beside : true), JSON.stringify(pop));
  await shot('4-details');
  /** Open the preview of the selected pin's screenshot, check its size/position, close it by tapping outside. */
  const preview = async (label: string, shotName: string) => {
    const before = { ...(await state(page)), listTop: await page.$eval('#list', (l) => l.scrollTop) };
    await page.tap('.leaflet-popup .shotwrap'); await page.waitForTimeout(500);
    const lb = await page.evaluate(() => {
      const o = document.getElementById('lb')!, i = o.querySelector('img')!; const r = i.getBoundingClientRect();
      return { open: !o.hidden, w: r.width, h: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2, nw: i.naturalWidth, nh: i.naturalHeight, vw: innerWidth, vh: innerHeight, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
    });
    const ratioOk = Math.abs(lb.w / lb.h - lb.nw / lb.nh) < 0.02 * (lb.nw / lb.nh);
    check(`${label} screenshot: preview ≤ 75% of the screen height, centred, whole image, proportions kept`,
      lb.open && lb.nw > 0 && lb.h <= lb.vh * 0.75 + 1 && lb.w <= lb.vw - 48 + 1 && Math.abs(lb.x - lb.vw / 2) < 3 && ratioOk && lb.inside && lb.h >= lb.vh * 0.3 || (lb.w >= lb.vw - 49 && ratioOk && lb.inside),
      `${Math.round(lb.w)}×${Math.round(lb.h)} px in ${lb.vw}×${lb.vh} (${Math.round((lb.h / lb.vh) * 100)}% of the height), image ${lb.nw}×${lb.nh}`);
    await shot(shotName);
    await page.touchscreen.tap(12, 12 + (await page.evaluate(() => (document.getElementById('lb')!.querySelector('img')!.getBoundingClientRect().top))) / 2); // dimmed area above the image
    await page.waitForTimeout(400);
    const after = { ...(await state(page)), listTop: await page.$eval('#list', (l) => l.scrollTop) };
    check(`${label}: tapping outside closes it; selected pin, filter, map zoom/position and list scroll unchanged`, (await page.$eval('#lb', (o) => (o as HTMLElement).hidden)) && JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
  };
  if (pop.hasImg) {
    await preview('portrait', '5-preview-portrait');
    check('details still open after closing the preview', !!(await page.$(`.leaflet-popup .pd[data-id="${withShot}"]`)));
  }
  // A landscape screenshot (local test copy: one Kyrgyzstan pin carries a 1600×900 image).
  const land = data.places.find((p: any) => p.reels.some((r: any) => r.image) && p.id.startsWith('aiest:42.58'));
  if (land) {
    const s0 = await state(page);
    await page.evaluate((cc) => { location.hash = `c=${cc}`; }, land.country_code); await page.waitForTimeout(600);
    await page.$eval(`.row[data-p="${land.id}"]`, (r) => r.scrollIntoView({ block: 'center' }));
    await page.tap(`.row[data-p="${land.id}"]`); await page.waitForSelector(`.leaflet-popup .pd[data-id="${land.id}"]`); await page.waitForTimeout(700);
    await preview('landscape', '5-preview-landscape');
    await page.evaluate((h) => { location.hash = h; }, `c=${s0.country}&t=${s0.type}`); await page.waitForTimeout(600);
  }
  // Pin tap → list entry selected.
  await page.evaluate(() => (window as any).__map.closePopup());
  const other = ids.find((i) => i !== withShot);
  if (other) {
    await page.evaluate((id) => { const x = (window as any).__markers[id]; (window as any).__map.setView(x.marker.getLatLng(), (window as any).__map.getZoom(), { animate: false }); }, other);
    await page.waitForTimeout(400);
    const b = await page.$eval(`.pin[data-id="${other}"]`, (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.touchscreen.tap(b.x, b.y); await page.waitForTimeout(500);
    check('tapping a pin selects its list entry', !!(await page.$(`.row.sel[data-p="${other}"]`)));
    await page.evaluate(() => (window as any).__map.closePopup());
  }

  // ---- swipe left on a row → Delete; vertical scrolling stays normal ----
  const rowId = ids[0]!;
  const rb = await page.$eval(`.swipe[data-sw="${rowId}"] .row`, (el) => { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const scroll0 = await page.$eval('#list', (l) => l.scrollTop);
  await swipe(page, { x: rb.x, y: rb.y }, { x: rb.x, y: rb.y - 120 }, 10);   // vertical drag
  await page.waitForTimeout(300);
  const vert = await page.$eval(`.swipe[data-sw="${rowId}"]`, (s) => s.classList.contains('open'));
  const scroll1 = await page.$eval('#list', (l) => l.scrollTop);
  check('a vertical drag scrolls the list and does not open Delete', !vert && (scroll1 !== scroll0 || (await page.$eval('#list', (l) => l.scrollHeight <= l.clientHeight + 2))), `scrollTop ${scroll0} → ${scroll1}`);
  const rb2 = await page.$eval(`.swipe[data-sw="${rowId}"] .row`, (el) => { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width - 40, y: r.y + r.height / 2 }; });
  await swipe(page, { x: rb2.x, y: rb2.y }, { x: rb2.x - 150, y: rb2.y + 4 }, 10);
  await page.waitForTimeout(400);
  const opened = await page.$eval(`.swipe[data-sw="${rowId}"]`, (s) => ({ open: s.classList.contains('open'), del: (s.querySelector('.del') as HTMLElement).getBoundingClientRect().width }));
  check('swiping left reveals Delete', opened.open && opened.del > 60);
  await shot('6-swipe');
  await page.tap(`.swipe[data-sw="${rowId}"] .del`); await page.waitForTimeout(300);
  const name = data.places.find((p: any) => p.id === rowId).name;
  const dlg = await page.evaluate(() => ({ open: !(document.getElementById('dlg') as HTMLElement).hidden, t: document.getElementById('dlg-t')!.textContent, p: document.getElementById('dlg-p')!.textContent }));
  check('Delete asks for confirmation and names the place', dlg.open && dlg.t!.includes(name), dlg.t!);
  await shot('7-confirm');
  if (process.argv.includes('--delete')) {
    await page.tap('#dlg-yes'); await page.waitForTimeout(1200);
    const gone = !(await page.$(`.row[data-p="${rowId}"]`)) && !(await page.$(`.pin[data-id="${rowId}"]`));
    check(`confirmed: "${name}" is gone from the list and the map`, gone);
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500);
    check('and stays gone after reload (deleted on the server)', !(await page.evaluate((id) => (window as any).__state.data.places.some((p: any) => p.id === id), rowId)));
  } else {
    await page.tap('#dlg-no'); await page.waitForTimeout(200);
    check('Cancel keeps the place', !!(await page.$(`.row[data-p="${rowId}"]`)));
  }
  await page.goto(`${BASE}/`); await page.waitForSelector('.row[data-c]');
  check('no horizontal page scrolling at 390 px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Reset the order this check made (leave the data as it was).
  await page.evaluate(() => fetch('/api/country-order', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order: null }) }));
} finally { await browser.close(); }
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} UI checks passed (EMULATED iPhone 390×844 in Chrome, not a physical device)`);
process.exitCode = failed ? 1 : 0;
