#!/usr/bin/env node
/**
 * README screenshots from the DEMO (synthetic data only — never run this against a real database).
 *   npm run demo            (in another terminal; it prints http://127.0.0.1:8090/auth/dev?t=…)
 *   node scripts/screenshots.ts "<that link>" [docs/screenshots]
 * iPhone-size Chrome emulation, light theme. Nearby uses a fixed position in Kyoto (the demo has places there).
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { findChrome } from '../src/sync/mymaps.ts';

const [link, outArg] = process.argv.slice(2);
if (!link || !/\/auth\/dev\?t=/.test(link)) { console.error('usage: node scripts/screenshots.ts "<demo /auth/dev?t=… link>" [out dir]'); process.exit(2); }
const out = path.resolve(outArg ?? 'docs/screenshots');
fs.mkdirSync(out, { recursive: true });
const base = new URL(link).origin;

const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  geolocation: { latitude: 34.9690, longitude: 135.7750, accuracy: 20 }, permissions: ['geolocation'],
});
const page = await ctx.newPage();
const shot = async (name: string, p: Page = page) => { await p.waitForTimeout(1200); await p.screenshot({ path: path.join(out, `${name}.png`) }); console.log('wrote', `${name}.png`); };

await page.goto(link);                                   // signs in as Demo User, lands on the map
await page.waitForSelector('.row[data-c]');
await page.waitForLoadState('networkidle').catch(() => {});
await shot('1-countries');

await page.tap('.row[data-c="JP"]').catch(async () => { await page.locator('.row[data-c]').first().tap(); });
await page.waitForTimeout(800);

await page.locator('.row[data-p="demo:ichiran"]').tap();
await page.waitForTimeout(900);
await shot('3-place');

await page.goto(base + '/');
await page.waitForSelector('.row[data-c]');
await page.locator('[data-tab="nearby"], button:has-text("Nearby")').first().tap();
await page.waitForTimeout(1500);
await page.locator('.chip[data-r="1000"]').tap().catch(() => {});
await shot('4-nearby');

await page.goto(base + '/');
await page.waitForSelector('.row[data-c]');
await page.locator('.row[data-c="PT"]').tap();
await page.waitForTimeout(800);
await page.locator('.row[data-p="demo:vistadorei"]').tap();
await shot('5-approximate');

const review = await ctx.newPage();
await review.goto(base + '/review/');
await review.locator('details').evaluateAll((ds) => ds.forEach((d) => ((d as HTMLDetailsElement).open = true)));
const card = review.locator('section.card').filter({ hasText: 'Vista do Rei' }).first();
await card.scrollIntoViewIfNeeded();
await card.screenshot({ path: path.join(out, '6-review.png') }); console.log('wrote 6-review.png');

const setup = await ctx.newPage();
await setup.goto(base + '/setup');
await setup.waitForSelector('#s-shortcut');
await shot('7-setup', setup);

await browser.close();
