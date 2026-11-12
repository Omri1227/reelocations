import { stableHash } from '../util/text.ts';

export interface ParsedShare {
  url: string | null;          // canonical URL (Instagram: https://www.instagram.com/reel/<code>/)
  shortcode: string | null;
  reelKey: string;
  isInstagram: boolean;
  extraText: string;           // shared text minus the URL (sometimes contains caption-like text)
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\b(?:www\.)?(?:instagram\.com|instagr\.am)\/[^\s<>"']+/gi;
const IG_RE = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/(?:[A-Za-z0-9._]+\/)?(reels?|p|tv)\/([A-Za-z0-9_-]{5,})/i;

/**
 * Accepts whatever the iOS share sheet hands the Shortcut: a bare URL, or text containing a URL
 * (e.g. "Check out this reel https://www.instagram.com/reel/ABC/?igsh=..."). Tracking params are dropped.
 */
export function parseShare(input: string | null | undefined, fallbackKey?: string): ParsedShare {
  const text = (input ?? '').trim();
  const urls = text.match(URL_RE) ?? [];
  for (const u of urls) {
    const m = u.match(IG_RE);
    if (m) {
      const code = m[2]!;
      return { url: `https://www.instagram.com/reel/${code}/`, shortcode: code, reelKey: `ig:${code}`, isInstagram: true, extraText: text.replace(u, '').trim() };
    }
  }
  if (urls.length) {
    const u = urls[0]!.replace(/[).,;]+$/, '');
    let clean = u;
    try { const p = new URL(u.startsWith('http') ? u : `https://${u}`); p.hash = ''; for (const k of [...p.searchParams.keys()]) if (/^(utm_|igsh|si$|fbclid)/i.test(k)) p.searchParams.delete(k); clean = p.toString(); } catch { /* keep raw */ }
    return { url: clean, shortcode: null, reelKey: `url:${stableHash(clean)}`, isInstagram: false, extraText: text.replace(u, '').trim() };
  }
  return { url: null, shortcode: null, reelKey: fallbackKey ?? `text:${stableHash(text || String(Date.now()))}`, isInstagram: false, extraText: text };
}

/** Normalise the phone timestamp; keep the original offset if present. */
export function normalizeSharedAt(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  const s = String(raw).trim();
  const t = Date.parse(s);
  // A Shortcut "Format Date" set to time-only sends year 0001 (seen live 2026-11-10: "0001-01-01T14:53:05+02:20:54").
  // Anything before 2020 or more than a day in the future is not a real share time → use when the inbox received it.
  if (!Number.isNaN(t) && t >= Date.UTC(2020, 0, 1) && t <= Date.parse(fallback) + 86_400_000) return s;
  return fallback;
}

/** Display "YYYY-MM-DD HH:mm" in the timestamp's own offset (the phone's local time at share). */
export function displayDate(iso: string): string {
  // UTC timestamps (the inbox receipt-time fallback ends in "Z") are shown in this computer's local time zone,
  // so they match the phone's clock instead of reading 2–3 hours early.
  if (/Z$/i.test(iso.trim()) && !Number.isNaN(Date.parse(iso))) {
    const d = new Date(iso), p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace('T', ' ');
}
