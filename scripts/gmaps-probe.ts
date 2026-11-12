#!/usr/bin/env node
/**
 * Probe: open an exact Google Maps listing by Place ID in headless Chromium and print what the place card shows.
 *   node scripts/gmaps-probe.ts <placeId> [name] [--state <storage-state.json>] [--shot out.png]
 * Without --state it runs signed out (no account): checks that the listing opens, its name/address (branch check) and
 * whether a Save control is present. With --state it also reports whether the session is signed in and the lists offered.
 */
import { chromium } from 'playwright-core';
import { openListing, readSaveState } from '../src/sync/savedList.ts';
import { findChrome } from '../src/sync/mymaps.ts';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const [placeId, name] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')));
if (!placeId) { console.error('usage: node scripts/gmaps-probe.ts <placeId> [name] [--state file] [--shot file]'); process.exit(2); }
const browser = await chromium.launch({ executablePath: findChrome(process.env.CHROME_PATH), headless: true });
try {
  const ctx = await browser.newContext({ locale: 'en-US', storageState: opt('state'), viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const card = await openListing(page, { googlePlaceId: placeId, name: name ?? '' });
  console.log(JSON.stringify(card, null, 2));
  console.log(JSON.stringify(await readSaveState(page), null, 2));
  if (opt('shot')) await page.screenshot({ path: opt('shot')! });
} finally { await browser.close(); }
