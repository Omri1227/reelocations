/** Desktop-width checks (1280×800, mouse): layout, header indicators, details, preview size, AI panel.
 *   BASE=… SESSION=<rm_s> node scripts/verify-desktop.ts [--shots <dir>] */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from '../src/sync/mymaps.ts';

const BASE = (process.env.BASE ?? 'http://127.0.0.1:18791').replace(/\/$/, '');
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1]! : '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const res: boolean[] = [];
const check = (s: string, ok: boolean, d?: string) => { res.push(ok); console.log(`${ok ? '✔' : '✘'} ${s}${d ? ` — ${d}` : ''}`); };
const b = await chromium.launch({ executablePath: findChrome(process.env.CHROME_PATH), headless: true });
try {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const u = new URL(BASE);
  await ctx.addCookies([{ name: 'rm_s', value: process.env.SESSION ?? '', domain: u.hostname, path: '/', httpOnly: true, secure: u.protocol === 'https:', sameSite: 'Lax' }]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => check('no JavaScript errors', false, e.message));
  await p.goto(`${BASE}/`); await p.waitForSelector('.row[data-c]'); await p.waitForTimeout(800);
  const lay = await p.evaluate(() => { const l = document.getElementById('list')!.getBoundingClientRect(), m = document.getElementById('map')!.getBoundingClientRect(); return { lw: l.width, lx: l.left, mx: m.left, mw: m.width, mh: m.height }; });
  check('desktop layout: list on the left (400 px), map fills the rest', lay.lw === 400 && lay.lx === 0 && lay.mx >= 400 && lay.mw > 800 && lay.mh > 600, JSON.stringify(lay));
  check('header shows the AI and Google Maps indicators', !(await p.$eval('#ai', (e) => (e as HTMLElement).hidden)));
  if (shots) await p.screenshot({ path: path.join(shots, 'd1-countries.png') });
  await p.click('#ai'); await p.waitForTimeout(300);
  const sheet = await p.$eval('#aip .sheet', (e) => { const r = e.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width }; });
  check('AI panel is a centred dialog on desktop', Math.abs(sheet.cx - 640) < 3 && sheet.w <= 560 && Math.abs(sheet.cy - 400) < 120, JSON.stringify(sheet));
  if (shots) await p.screenshot({ path: path.join(shots, 'd2-ai.png') });
  await p.click('#aiclose');
  await p.click('.row[data-c="JP"]'); await p.waitForSelector('.row[data-p]'); await p.waitForTimeout(600);
  const withShot = await p.evaluate(() => (window as any).__state.data.places.find((x: any) => x.country_code === 'JP' && x.reels.some((r: any) => r.image)).id);
  await p.click(`.row[data-p="${withShot}"]`); await p.waitForSelector('.leaflet-popup .pd'); await p.waitForTimeout(800);
  const pd = await p.evaluate(() => { const g = document.querySelector('.leaflet-popup .gm')!.getBoundingClientRect(), bt = document.querySelector('.leaflet-popup .bottom')!.getBoundingClientRect(); return { gmVisible: g.bottom <= bt.top + 1, del: !!document.querySelector('.leaflet-popup .pdel'), shot: !!document.querySelector('.leaflet-popup .shotwrap') }; });
  check('details: Open in Google Maps fully visible above the screenshot + Delete bar', pd.gmVisible && pd.del && pd.shot, JSON.stringify(pd));
  if (shots) await p.screenshot({ path: path.join(shots, 'd3-details.png') });
  await p.click('.leaflet-popup .shotwrap'); await p.waitForTimeout(400);
  const lb = await p.evaluate(() => { const r = document.querySelector('#lb img')!.getBoundingClientRect(); return { h: r.height, w: r.width, cx: r.left + r.width / 2, vh: innerHeight }; });
  check('preview ≤ 75% of the height and centred on desktop', lb.h <= lb.vh * 0.75 + 1 && Math.abs(lb.cx - 640) < 3, `${Math.round(lb.w)}×${Math.round(lb.h)} of ${lb.vh}`);
  if (shots) await p.screenshot({ path: path.join(shots, 'd4-preview.png') });
  await p.mouse.click(20, 20); await p.waitForTimeout(300);
  check('click outside closes the preview; the pin stays selected', await p.$eval('#lb', (e) => (e as HTMLElement).hidden) && !!(await p.$(`.row.sel[data-p="${withShot}"]`)));
  check('no horizontal scrolling', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
} finally { await b.close(); }
console.log(`\n${res.filter(Boolean).length}/${res.length} desktop checks passed (1280×800)`);
process.exitCode = res.every(Boolean) ? 0 : 1;
