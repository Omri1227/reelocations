import type { Http } from '../util/http.ts';
import { HttpError, NetworkError } from '../util/http.ts';

export interface ReelMetadata {
  source: 'oembed' | 'page';
  ok: boolean;
  author?: string;
  caption?: string;
  thumbnailUrl?: string;
  error?: string;
  /** true when the failure is transient (network/5xx) and should be retried rather than recorded as "unavailable". */
  transient?: boolean;
}

function decodeEntities(s: string): string {
  return s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Caption text from the embed HTML blockquote, if Meta included it. */
export function captionFromEmbedHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => decodeEntities(m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim());
  const useful = paras.filter((p) => p && !/^(a post shared by|view this post on instagram)/i.test(p));
  return useful.length ? useful.join('\n') : undefined;
}

/**
 * Official Meta oEmbed (tokenless access announced 2026-06-15). Public Reels only. The response is mainly embed HTML and
 * attribution; a caption is present only if Meta includes it (`title` or the embed blockquote). Geotags are NOT exposed.
 */
export async function fetchOembed(http: Http, reelUrl: string): Promise<ReelMetadata> {
  const url = `https://graph.facebook.com/v25.0/instagram_oembed?url=${encodeURIComponent(reelUrl)}&omitscript=true`;
  try {
    const r = await http.text(url, { acceptStatus: [400, 403, 404], retries: 1, cacheTtlMs: 7 * 86_400_000 });
    const j = JSON.parse(r.body);
    if (j.error) return { source: 'oembed', ok: false, error: `${j.error.error_user_title ?? j.error.message ?? 'error'} (code ${j.error.code}/${j.error.error_subcode ?? '-'})` };
    const caption = (typeof j.title === 'string' && j.title.trim()) ? j.title.trim() : captionFromEmbedHtml(j.html);
    return { source: 'oembed', ok: true, author: j.author_name, caption, thumbnailUrl: j.thumbnail_url };
  } catch (e) {
    const transient = e instanceof NetworkError || (e instanceof HttpError && (e.status >= 500 || e.status === 429));
    return { source: 'oembed', ok: false, error: String((e as Error).message ?? e), transient };
  }
}
