import type { ReelMetadata } from './instagram.ts';

/**
 * Read the caption a visitor sees on the public Reel page (opt-in: INSTAGRAM_PAGE_CAPTION=true).
 *
 * Verified live 2026-11-10: a plain HTTP GET returns only Instagram's app shell, but a headless browser (no login,
 * fresh profile) gets the rendered <meta property="og:description"> with the full caption in ~7 s
 * ("…Locations: 📍 Village A 📍 Hut B … - @creator on September 29, 2026").
 *
 * ⚠️ Instagram's Terms of Use prohibit collecting information "in an automated way" without permission. This is opt-in,
 * one page load per shared Reel, never logged in, never retried in a loop, cached per Reel. Expect Instagram to show a
 * login wall or rate-limit at times; the pipeline then simply continues without the caption.
 */
export interface PageCaptionOptions { chromePath: string; timeoutMs?: number; launch?: () => Promise<any> }

/** Instagram separates caption lines with characters that arrive as U+FFFD / U+2028 / U+2029 / U+0085 (seen live:
 *  "📍 Example Grill Ginza�Wagyu Beef …"). Turn them into line breaks so each 📍 line stands alone. */
export function normalizeCaption(s: string): string {
  return s.replace(/[\uFFFD\u2028\u2029\u0085]/g, '\n').replace(/[ \t]+\n/g, '\n');
}

/** "caption text - @user on September 29, 2026" → { caption, author } */
export function parseOgDescription(s: string): { caption: string; author?: string } {
  const m = s.match(/^([\s\S]*?)\s+-\s+@([\w.]+)\s+on\s+[A-Z][a-z]+ \d{1,2}, \d{4}\s*$/);
  return m ? { caption: normalizeCaption(m[1]!).trim(), author: m[2] } : { caption: normalizeCaption(s).trim() };
}

export async function readPublicCaption(url: string, o: PageCaptionOptions): Promise<ReelMetadata> {
  const code = url.match(/\/(?:reels?|p)\/([\w-]+)/)?.[1];
  if (!code) return { source: 'page', ok: false, error: 'not a Reel URL' };
  let browser: any;
  try {
    if (o.launch) browser = await o.launch();
    else {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ executablePath: o.chromePath, headless: true });
    }
    const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 430, height: 932 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    const page = await ctx.newPage();
    const timeout = o.timeoutMs ?? 25_000;
    await page.goto(`https://www.instagram.com/reel/${code}/`, { waitUntil: 'domcontentloaded', timeout });
    const deadline = Date.now() + Math.min(timeout, 15_000);
    let og: string | null = null;
    while (!og && Date.now() < deadline) {
      og = await page.evaluate(() => document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? null).catch(() => null);
      if (!og) await page.waitForTimeout(700);
    }
    if (!og) return { source: 'page', ok: false, error: 'caption not visible (login wall or removed Reel)' };
    const { caption, author } = parseOgDescription(og);
    return caption ? { source: 'page', ok: true, caption, author } : { source: 'page', ok: false, error: 'empty caption' };
  } catch (e) {
    return { source: 'page', ok: false, error: `page read failed: ${String((e as Error).message).split('\n')[0]}` };
  } finally {
    await browser?.close().catch(() => {});
  }
}
