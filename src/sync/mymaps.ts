import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import type { BrowserContext, Page, Frame, Locator } from 'playwright-core';
import { parseKml, type RemoteFeature } from './kml.ts';
import type { MapSink } from './sync.ts';

export function findChrome(explicit?: string): string {
  const candidates = [explicit, process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].filter(Boolean) as string[];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('Chrome not found; set CHROME_PATH in .env');
  return hit;
}

/**
 * One-time sign-in: opens a NORMAL (non-automated) Chrome window on a dedicated profile so you can sign in to Google
 * yourself. Your password and cookies never leave this computer; the worker later reuses this local profile.
 */
export function openLoginWindow(chromePath: string, profileDir: string, url = 'https://www.google.com/maps/d/'): void {
  fs.mkdirSync(profileDir, { recursive: true });
  const p = spawn(chromePath, [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', url], { detached: true, stdio: 'ignore' });
  p.unref();
}

export interface MyMapsOptions { mapId: string; layerName: string; profileDir: string; chromePath: string; debugDir: string; headless?: boolean; assist?: boolean }

export class NotSignedInError extends Error { constructor() { super('Not signed in to Google in the worker profile. Run: npm run google:login'); this.name = 'NotSignedInError'; } }

/**
 * Drives the My Maps web editor in a dedicated local Chrome profile (no Google API exists for My Maps).
 * readRemote uses My Maps' own KML export endpoint (same session), which is independent of the editor UI.
 * replaceLayer swaps in a freshly imported layer (Add layer → Import), verifies it, then deletes the old one.
 * UI selectors are best-effort; on any failure a screenshot is saved and the assisted mode can be used.
 */
export class MyMapsBrowserSink implements MapSink {
  private ctx?: BrowserContext;
  private o: MyMapsOptions;
  constructor(o: MyMapsOptions) { this.o = o; }

  /** Point the same browser session at another map/layer (country maps, city layers). */
  target(mapId: string, layerName: string): this { this.o = { ...this.o, mapId, layerName }; return this; }

  /**
   * Create a new My Map with this title (web editor: "Create a new map", then the title dialog) and return its id.
   * The new map has one empty "Untitled layer", which the first replaceLayer() fills instead of adding another.
   */
  async createMap(title: string): Promise<string> {
    const ctx = await this.context();
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('https://www.google.com/maps/d/?hl=en', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    if (/accounts\.google\.com/.test(page.url())) throw new NotSignedInError();
    try {
      await this.mouseAt(page, page.getByText(/create a new map/i).filter({ visible: true }).first(), true);
      // Live 2026-11-10: a notice "Creating a MyMaps map always uploads title, thumbnail, and associated metadata to
      // Drive" with [LEARN MORE] [CREATE] appears first; the editor may open in this tab or a new one.
      const deadline = Date.now() + 60_000;
      let editor: Page | undefined;
      while (!editor && Date.now() < deadline) {
        editor = ctx.pages().find((p) => /[?&]mid=/.test(p.url()));
        if (editor) break;
        const notice = page.getByRole('button', { name: /^create$/i }).filter({ visible: true }).first();
        if (await notice.count().catch(() => 0)) await this.mouseAt(page, notice, true);
        else await page.waitForTimeout(1000);
      }
      if (!editor) throw new Error('no map id in the editor URL');
      if (editor !== page) { await page.close().catch(() => {}); }
      return await this.titleNewMap(editor, title);
    } catch (e) {
      const shot = await this.shot(page.isClosed() ? (ctx.pages()[0] ?? page) : page, 'create-map-failed');
      throw new Error(`could not create the My Maps map "${title}" (${(e as Error).message.split('\n')[0]}). Screenshot: ${shot}.`);
    }
  }

  /** Set the title of a freshly created map (click "Untitled map" → dialog → Save) and return its id. */
  private async titleNewMap(page: Page, title: string): Promise<string> {
    const mid = new URL(page.url()).searchParams.get('mid')!;
    try {
      await this.mouseAt(page, page.getByText('Untitled map', { exact: true }).filter({ visible: true }).first(), true);
      const input = page.locator('input[type=text], textarea').filter({ visible: true }).first();
      await this.mouseAt(page, input, true);
      await page.keyboard.press('Control+A');
      await page.keyboard.type(title);
      await this.mouseAt(page, page.getByRole('button', { name: /^Save$/ }).filter({ visible: true }).first(), true);
      await page.waitForTimeout(2000);
      return mid;
    } catch (e) {
      // The map exists now: keep its id (re-creating it would leave a duplicate). Only the title needs a manual fix.
      const shot = await this.shot(page, 'title-map-failed');
      console.warn(`map created (id kept) but its title could not be set to "${title}" (${(e as Error).message.split('\n')[0]}); rename it in My Maps. Screenshot: ${shot}`);
      return mid;
    }
  }

  private async context(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    const { chromium } = await import('playwright-core');
    fs.mkdirSync(this.o.profileDir, { recursive: true });
    try {
      this.ctx = await chromium.launchPersistentContext(this.o.profileDir, {
        executablePath: this.o.chromePath, headless: this.o.headless ?? false, acceptDownloads: true,
        viewport: { width: 1400, height: 900 }, ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
      });
    } catch (e) {
      throw new Error(`Could not open the worker Chrome profile (close any Chrome window using ${this.o.profileDir}): ${(e as Error).message.split('\n')[0]}`);
    }
    return this.ctx;
  }

  /** Layers named like the target, in map order, each with its features (from Google's KML export). */
  private async readLayers(): Promise<RemoteFeature[][]> {
    const { names, all } = await this.exportMap();
    return names.flatMap((n, i) => (n === this.o.layerName ? [all.filter((f) => f.layerIndex === i)] : []));
  }

  /** Every layer of the current map, in map order (name + features), from Google's KML export. */
  async readAllLayers(): Promise<{ name: string; features: RemoteFeature[] }[]> {
    const { names, all } = await this.exportMap();
    return names.map((name, i) => ({ name, features: all.filter((f) => f.layerIndex === i) }));
  }

  private async exportMap(): Promise<{ names: string[]; all: RemoteFeature[] }> {
    const ctx = await this.context();
    // cb= defeats caching: right after an edit the export briefly served the previous state (seen live 2026-11-10).
    const get = () => ctx.request.get(`https://www.google.com/maps/d/kml?mid=${encodeURIComponent(this.o.mapId)}&forcekml=1&cid=mp&cv=reelmaps&cb=${Date.now()}`, { timeout: 60_000 });
    // Transient network errors (ECONNRESET seen live 2026-11-10) are retried; a real outage still fails after 3 tries.
    let r: Awaited<ReturnType<typeof get>> | undefined;
    for (let i = 1; !r; i++) {
      try { r = await get(); } catch (e) { if (i >= 3 || !/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|ECONNREFUSED/i.test(String(e))) throw e; await new Promise((res) => setTimeout(res, 3000 * i)); }
    }
    const body = await r.text();
    if (!r.ok() || !body.includes('<kml')) {
      if (/accounts\.google\.com|ServiceLogin|<html/i.test(body)) throw new NotSignedInError();
      throw new Error(`My Maps KML export failed: HTTP ${r.status()}`);
    }
    const all = parseKml(body);
    const names = [...body.matchAll(/<Folder>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => m[1]!.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').trim());
    return { names, all };
  }

  async readRemote(): Promise<{ layerExists: boolean; features: RemoteFeature[]; layerCount: number }> {
    const layers = await this.readLayers();
    return { layerExists: layers.length > 0, features: layers.flat(), layerCount: layers.length };
  }

  /** Poll the export until `ok` holds (the export lags the editor by a few seconds). */
  private async waitForExport(what: string, ok: (layers: RemoteFeature[][]) => boolean, ms = 120_000): Promise<RemoteFeature[][]> {
    const deadline = Date.now() + ms;
    let layers: RemoteFeature[][] = [];
    while (Date.now() < deadline) {
      layers = await this.readLayers();
      if (ok(layers)) return layers;
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(`timed out waiting for Google to show ${what} (export shows ${layers.length} "${this.o.layerName}" layer(s) with ${layers.map((l) => l.length).join('/')} feature(s))`);
  }

  private async shot(page: Page, tag: string) {
    fs.mkdirSync(this.o.debugDir, { recursive: true });
    const f = path.join(this.o.debugDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}.png`);
    await page.screenshot({ path: f, fullPage: true }).catch(() => {});
    return f;
  }

  /**
   * Layer SWAP (not "Reimport and merge → Replace all items": that keeps the old table schema and blanks every title,
   * shown as "Untitled" on iPhone — seen live 2026-11-10). Steps:
   *  1. leftovers of an interrupted swap (more than one layer with our name): keep the FIRST, delete the later ones;
   *  2. Add layer → Import the snapshot → it is named after the KML document (= our layer name) and appended last;
   *  3. wait until Google's export shows the NEW layer containing every expected id;
   *  4. only then delete the old layer, and wait until exactly one complete layer remains.
   * A failure at any step leaves the old layer untouched, so places are never lost.
   */
  async replaceLayer(kmlFile: string, expectIds: string[] = []): Promise<void> {
    const ctx = await this.context();
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`https://www.google.com/maps/d/edit?mid=${encodeURIComponent(this.o.mapId)}&hl=en`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    if (/accounts\.google\.com/.test(page.url())) throw new NotSignedInError();
    if (this.o.assist) return this.assisted(page, kmlFile, expectIds);
    const complete = (l: RemoteFeature[] | undefined) => !!l && expectIds.every((id) => l.some((f) => f.rmId === id));
    // Unique tag per upload, appended to each "ref:" line, so the NEW layer can be told apart from an old layer with the
    // same places (ids alone confused a leftover layer with the new import — seen live 2026-11-10).
    const tag = `u:${Date.now().toString(36)}`;
    const upload = kmlFile.replace(/\.kml$/i, '') + '.upload.kml';
    fs.writeFileSync(upload, fs.readFileSync(kmlFile, 'utf8').replace(/ref: (rm:[^\s<\]]+)/g, `ref: $1 ${tag}`));
    const tagged = (l: RemoteFeature[] | undefined) => !!l && l.some((f) => f.description.includes(tag));
    let addedLayer = false;
    try {
      // Only visible layer titles (My Maps also keeps hidden copies of the name in the DOM).
      const titles = () => page.getByText(this.o.layerName, { exact: true }).filter({ visible: true });
      await page.getByText('Add layer', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 45_000 });
      await page.waitForTimeout(2000); // the layer list renders after the toolbar
      for (let n = await titles().count(); n > 1; n--) await this.deleteLayer(page, titles().last(), titles, n);
      const before = await titles().count();
      // A brand-new map comes with one empty "Untitled layer": fill it instead of adding a second one.
      const emptyDefault = before === 0 && (await page.getByText('Untitled layer', { exact: true }).filter({ visible: true }).count()) > 0;
      if (!emptyDefault) {
        await this.mouseAt(page, page.getByText('Add layer', { exact: true }).filter({ visible: true }).first(), true);
        addedLayer = true;
        await page.waitForTimeout(2500);
      }
      // The new, empty "Untitled layer" is appended last and offers an "Import" link.
      // An import occasionally never lands (seen live 2026-11-10: the layer stayed "Untitled", empty). If the new layer is
      // still untitled after a minute, upload once more into it; otherwise keep waiting for the export.
      for (let attempt = 1; ; attempt++) {
        await this.mouseAt(page, page.getByText('Import', { exact: true }).filter({ visible: true }).last(), true);
        await this.uploadInPicker(page, upload);
        await this.waitForImport(page);
        const what = `the new "${this.o.layerName}" layer with all ${expectIds.length} places`;
        const landed = (ls: RemoteFeature[][]) => ls.length === before + 1 && complete(ls.at(-1)) && tagged(ls.at(-1)) && !ls.slice(0, -1).some(tagged);
        try { await this.waitForExport(what, landed, attempt === 1 ? 60_000 : 120_000); break; } catch (e) {
          const stillEmpty = await page.getByText('Untitled layer', { exact: true }).filter({ visible: true }).count();
          if (attempt >= 2 || !stillEmpty) { if (!stillEmpty) { await this.waitForExport(what, landed, 120_000); break; } throw e; }
        }
      }
      await this.waitForCount(titles, before + 1);
      // Delete exactly the old layer(s) — always the first one, whose position is above the new layer.
      for (let n = before + 1; n > 1; n--) await this.deleteLayer(page, titles().first(), titles, n);
      await this.waitForExport('exactly one complete layer (this upload) after removing the old one', (ls) => ls.length === 1 && complete(ls[0]) && tagged(ls[0]));
    } catch (e) {
      const shot = await this.shot(page, 'replace-failed');
      // Remove an empty layer this attempt created (its import never landed). The old layer is never touched here.
      await page.keyboard.press('Escape').catch(() => {});
      const untitled = () => page.getByText('Untitled layer', { exact: true }).filter({ visible: true });
      const n = await untitled().count().catch(() => 0);
      if (addedLayer && n) await this.deleteLayer(page, untitled().last(), untitled, n).catch(() => {});
      throw new Error(`My Maps UI automation failed (${(e as Error).message.split('\n')[0]}). Screenshot: ${shot}. ` +
        `Fallback: run "npm run sync -- --assist" and do the clicks yourself; verification still runs automatically.`);
    }
  }

  /** Delete every layer called `name` from the current map (the grouped sync checks first that nothing is lost). */
  async removeLayer(name: string): Promise<void> {
    const ctx = await this.context();
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`https://www.google.com/maps/d/edit?mid=${encodeURIComponent(this.o.mapId)}&hl=en`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    if (/accounts\.google\.com/.test(page.url())) throw new NotSignedInError();
    try {
      await page.getByText('Add layer', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 45_000 });
      await page.waitForTimeout(2000);
      const titles = () => page.getByText(name, { exact: true }).filter({ visible: true });
      for (let n = await titles().count(); n > 0; n--) await this.deleteLayer(page, titles().first(), titles, n);
    } catch (e) {
      const shot = await this.shot(page, 'remove-layer-failed');
      throw new Error(`My Maps UI automation failed while removing layer "${name}" (${(e as Error).message.split('\n')[0]}). Screenshot: ${shot}`);
    }
  }

  private async waitForCount(titles: () => Locator, n: number, ms = 30_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if ((await titles().count()) === n) return; await new Promise((r) => setTimeout(r, 1000)); }
    throw new Error(`expected ${n} "${this.o.layerName}" layer(s) in the editor, found ${await titles().count()}`);
  }

  /** Layer ⋮ → "Delete this layer" → confirm "Delete"; then wait until the editor shows one layer fewer. */
  private async deleteLayer(page: Page, title: Locator, titles: () => Locator, countBefore: number) {
    const header = title.locator('xpath=ancestor::*[.//*[@aria-label="Layer options" or @data-tooltip="Layer options"]][1]');
    await this.mouseAt(page, header.locator('[aria-label="Layer options"], [data-tooltip="Layer options"]').first(), true);
    await this.mouseAt(page, page.locator('[role=menuitem]').filter({ visible: true, hasText: /^\s*Delete this layer\s*$/ }).first(), true);
    // Live dialog (2026-11-10): "Really delete this layer?" [Delete] [Cancel]
    await this.mouseAt(page, page.locator('[role=dialog], [role=alertdialog]').filter({ visible: true }).getByRole('button', { name: /^Delete$/ }).first(), true);
    await this.waitForCount(titles, countBefore - 1);
  }

  /** Real mouse move (and optional click) at the element's centre; boundingBox is page-relative even inside iframes. */
  private async mouseAt(page: Page, l: Locator, click: boolean) {
    await l.waitFor({ state: 'visible', timeout: 15_000 });
    // The layer panel scrolls once a map has several layers (seen live with 7 countries): bring the element into view.
    await l.evaluate((e: Element) => e.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })).catch(() => {});
    // The panel keeps moving for a moment (it scrolls to a newly added layer by itself — seen live 2026-11-11, a click
    // meant for "Import" landed on another layer's style link): click only once the position is stable.
    let b = await l.boundingBox();
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(250);
      const n = await l.boundingBox();
      const same = !!b && !!n && Math.abs(b.x - n.x) < 1 && Math.abs(b.y - n.y) < 1;
      b = n;
      if (same) break;
      await l.evaluate((e: Element) => e.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })).catch(() => {});
    }
    if (!b) throw new Error('element has no on-screen box');
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.move(x, y, { steps: 5 });
    if (click) await page.mouse.click(x, y);
    await page.waitForTimeout(800);
  }

  private async uploadInPicker(page: Page, kmlFile: string) {
    // Live picker "Choose a file to import" (2026-11-10): tabs Google Drive | Albums | Upload, and it REMEMBERS the last
    // tab. Only the picker's own visible "Browse" button is used — never a bare <input type=file>, because the editor
    // page has unrelated hidden file inputs (setting one of those silently imported nothing).
    const deadline = Date.now() + 60_000;
    let uploadTabClicked = false;
    while (Date.now() < deadline) {
      const frames = [page.mainFrame(), ...page.frames()] as Frame[];
      for (const f of frames) {
        const btn = f.getByRole('button', { name: /^(Browse|Select a file from your device)$/i }).filter({ visible: true }).first();
        if (await btn.count().catch(() => 0)) {
          const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15_000 }), this.mouseAt(page, btn, true)]);
          await chooser.setFiles(kmlFile);
          return;
        }
      }
      if (!uploadTabClicked) {
        for (const f of frames) {
          const tab = f.getByText('Upload', { exact: true }).filter({ visible: true }).first();
          if (await tab.count().catch(() => 0)) { await this.mouseAt(page, tab, true); uploadTabClicked = true; break; }
        }
      }
      await page.waitForTimeout(1000);
    }
    throw new Error('upload dialog not found (no "Browse" button in "Choose a file to import")');
  }

  private async waitForImport(page: Page) {
    // The picker closes and My Maps shows a progress toast while importing; then features render.
    await page.waitForTimeout(3000);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const busy = await page.getByText(/Importing|Uploading|Processing/i).first().isVisible().catch(() => false);
      const err = await page.getByText(/couldn't|could not|failed|error/i).first().isVisible().catch(() => false);
      if (err) throw new Error('My Maps reported an import error');
      if (!busy) { await page.waitForTimeout(4000); return; }
      await page.waitForTimeout(2000);
    }
    throw new Error('import did not finish within 2 minutes');
  }

  /** Human-in-the-loop fallback: the worker opens the map and the file; you click; it verifies. */
  private async assisted(page: Page, kmlFile: string, expectIds: string[]) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\nASSISTED SYNC — in the opened Chrome window:\n  1. Click "Add layer", then "Import" under the new layer, and upload:\n     ${kmlFile}\n  2. Wait until the points appear (the new layer is named "${this.o.layerName}").`);
    await rl.question('Press Enter when the import has finished… ');
    const ls = await this.waitForExport('the new layer with all places', (l) => l.length >= 2 && expectIds.every((id) => l.at(-1)!.some((f) => f.rmId === id)));
    console.log(`✔ Google shows the new layer with ${ls.at(-1)!.length} features.\n  3. Now delete the OLD "${this.o.layerName}" layer (the upper one): ⋮ → Delete this layer → Delete.`);
    await rl.question('Press Enter when the old layer is deleted… ');
    rl.close();
    await page.waitForTimeout(1000);
  }

  async close() { await this.ctx?.close().catch(() => {}); this.ctx = undefined; }
}
