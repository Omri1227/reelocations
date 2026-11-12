#!/usr/bin/env node
/**
 * Renders src/web/icon.svg to the PNG icons the browser and iOS use (iOS ignores SVG for the Home Screen icon):
 *   apple-touch-icon.png (180), icon-192.png, icon-512.png, icon-maskable-512.png (content inside the 80 % safe zone),
 *   favicon-32.png.            node scripts/make-icons.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from '../src/sync/mymaps.ts';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web');
const svg = fs.readFileSync(path.join(WEB, 'icon.svg'), 'utf8');
// Maskable: same art scaled to 86 % so Android's circle/squircle masks never cut the frame.
const maskable = svg.replace(/(<rect width="1024" height="1024" fill="url\(#bg\)"\/>)([\s\S]*)(<\/svg>)/, '$1<g transform="translate(71.7 71.7) scale(0.86)">$2</g>$3');

const browser = await chromium.launch({ executablePath: findChrome(process.env.CHROME_PATH) ?? undefined, headless: true });
const page = await browser.newPage();
const render = async (src: string, size: number, out: string) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><body style="margin:0">${src.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  fs.writeFileSync(path.join(WEB, out), await page.screenshot({ type: 'png', omitBackground: false, clip: { x: 0, y: 0, width: size, height: size } }));
  console.log('wrote', out);
};
await render(svg, 180, 'apple-touch-icon.png');
await render(svg, 192, 'icon-192.png');
await render(svg, 512, 'icon-512.png');
await render(maskable, 512, 'icon-maskable-512.png');
await render(svg, 32, 'favicon-32.png');
await browser.close();
