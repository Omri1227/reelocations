import fs from 'node:fs';
import type { Budget } from '../budget.ts';
import { tokenCostUsd } from '../budget.ts';
import type { Category } from '../types.ts';
import { CATEGORY_INFO } from '../categories.ts';

/**
 * OpenAI fallback (Responses API, verified against developers.openai.com docs on 2026-11-10):
 *  - images go in `input_image` items as base64 data URLs with `detail`;
 *  - strict Structured Outputs via text.format = { type: "json_schema", strict: true };
 *  - the model does NOT accept video, and an Instagram URL is NOT something it can watch: the URL is passed only as
 *    context, together with frames we extracted locally (when the user attached the video/screenshots), OCR text and
 *    the local Whisper transcript. The prompt states plainly when no video was available.
 * Every call reserves its worst-case cost first; usage from the response settles the actual cost.
 */

export interface AiPlace {
  name: string; category: Category; country: string | null; city: string | null;
  role: 'featured' | 'mentioned' | 'vantage'; evidence: string; timestamps: number[]; confidence: 'high' | 'medium' | 'low';
  /** The model's own estimate of where the scene is (used only when no named place can be verified). */
  lat: number | null; lon: number | null; radius_km: number | null;
  /** Name in the local script (e.g. Japanese) — OSM often only has that; street address when the material gives one. */
  local_name: string | null; address: string | null;
}
export interface AiFrame { file: string; t?: number }
export interface AiInput {
  reelUrl: string | null; videoAvailable: boolean; frames: AiFrame[];
  texts: { source: 'note' | 'caption' | 'ocr' | 'transcript'; text: string; t?: number }[];
}
export type AiResult = { places: AiPlace[]; usage: { input: number; output: number; usd?: number } } | { skipped: string; retryNextMonth?: boolean; retryTomorrow?: boolean };

const CATS = Object.keys(CATEGORY_INFO) as Category[];
export const AI_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['places'],
  properties: {
    places: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'category', 'country', 'city', 'role', 'evidence', 'timestamps', 'confidence', 'lat', 'lon', 'radius_km', 'local_name', 'address'],
        properties: {
          name: { type: 'string', description: 'Specific proper name of the place as it would appear on a map' },
          category: { type: 'string', enum: CATS },
          country: { type: ['string', 'null'] },
          city: { type: ['string', 'null'], description: 'City, town, or for rural places the nearest locality/region' },
          role: { type: 'string', enum: ['featured', 'mentioned', 'vantage'], description: 'featured = the Reel shows/recommends it; mentioned = only named in passing; vantage = where the camera stands' },
          evidence: { type: 'string', description: 'What in the provided material supports this (quote on-screen text or speech when possible)' },
          timestamps: { type: 'array', items: { type: 'number' }, description: 'Seconds into the video where it appears' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          lat: { type: ['number', 'null'], description: 'Your best estimate of the latitude of what is shown (decimal degrees), or null' },
          lon: { type: ['number', 'null'], description: 'Your best estimate of the longitude, or null' },
          radius_km: { type: ['number', 'null'], description: 'How far off your lat/lon could be, in km' },
          local_name: { type: ['string', 'null'], description: 'The name in the local language/script if different (e.g. Japanese for a Tokyo restaurant), else null' },
          address: { type: ['string', 'null'], description: 'Street address if the material gives one, else null' },
        },
      },
    },
  },
} as const;

const INSTRUCTIONS = `You identify the real-world places featured in a short travel video (an Instagram Reel).
You receive: optional frames (with their time in seconds), on-screen text read by OCR, a speech transcript, and the
user's own note. The Reel URL is context only: you cannot open it. Use ONLY the provided material.
Rules:
- One entry per distinct place. The same place seen in several frames is ONE entry (list all its timestamps).
  Different branches/locations of a chain are different entries only if the material shows they are different.
- role: "featured" if the Reel shows or recommends it, "mentioned" if only named in passing, "vantage" for the spot
  the camera films from.
- Never guess from generic scenery (beaches, waterfalls, forests and streets look alike). If the material does not
  name or unmistakably show a place, return it with confidence "low" or leave it out. An empty list is a good answer.
- confidence "high" only when a name is visible/spoken or the landmark is unmistakable AND country/city are clear.
- Hiking routes / trails / long-distance paths are separate entries with category "hike" (e.g. "Route 66" in a
  hiking Reel, "Alpine Ridge Trail"); villages, huts, peaks and towns are places, not routes.
- Use English names where common, otherwise the local name in Latin script.
- When only a region/area is named (e.g. "Ladakh", "Chuy Region"), look closely at the pictures and try to identify
  the SPECIFIC spot shown inside that region (a lake, gorge, monastery, pass, viewpoint, beach…) and return that
  specific place as the entry, with the region as "city". If you cannot name it, still return your best estimate of
  where the scene is: lat/lon of the scene and radius_km (how far off you could be). Use null only if you have no idea.
- lat/lon/radius_km are your own estimate; give them for every entry when you can.`;

/** Worst-case image tokens per frame (≤768 px wide portrait at detail=high: 24×43 patches × 1.2 ≈ 1,240; padded). */
const IMAGE_TOKENS = { low: 200, high: 1500 } as const;
const MAX_OUTPUT = 1500;

export interface OpenAiOptions {
  apiKey: string; model: string; budget: Budget; detail?: 'low' | 'high'; maxImages?: number; dailyCallCap?: number;
  fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>;
}

export function buildRequest(model: string, input: AiInput, frames: AiFrame[], detail: 'low' | 'high') {
  const lines: string[] = [];
  lines.push(`Reel URL (context only, not opened): ${input.reelUrl ?? '(none)'}`);
  lines.push(input.videoAvailable ? 'Video: frames below were extracted from the actual video the user attached.' : 'Video: NOT available (the user attached no video). Frames, if any, are screenshots the user took.');
  for (const t of input.texts) lines.push(`${t.source === 'note' ? "User's note" : t.source === 'caption' ? 'Reel caption (public page)' : t.source === 'ocr' ? 'On-screen text (OCR)' : 'Transcript'}${t.t != null ? ` @${t.t.toFixed(1)}s` : ''}: ${t.text.slice(0, 1500)}`);
  const content: any[] = [{ type: 'input_text', text: lines.join('\n') }];
  for (const f of frames) {
    if (f.t != null) content.push({ type: 'input_text', text: `Frame at ${f.t.toFixed(1)} s:` });
    content.push({ type: 'input_image', image_url: `data:${f.file.endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${fs.readFileSync(f.file).toString('base64')}`, detail });
  }
  return {
    model, store: false, instructions: INSTRUCTIONS, reasoning: { effort: 'none' }, max_output_tokens: MAX_OUTPUT,
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_schema', name: 'reel_places', strict: true, schema: AI_SCHEMA } },
  };
}

export async function askOpenAI(o: OpenAiOptions, input: AiInput): Promise<AiResult> {
  const hasEvidence = input.frames.length > 0 || input.texts.some((t) => t.text.trim().length >= 3);
  if (!hasEvidence) return { skipped: 'nothing to analyse (link only: no note, screenshot, video or speech) — the model cannot open the Reel URL' };
  const detail = o.detail ?? 'high';
  const frames = pickFrames(input.frames, o.maxImages ?? 8);
  const textTok = Math.ceil(input.texts.reduce((n, t) => n + Math.min(t.text.length, 1500) + 40, 0) / 3) + 1200; // + instructions & schema
  const worst = tokenCostUsd(o.model, textTok + frames.length * IMAGE_TOKENS[detail] + frames.length * 10, MAX_OUTPUT);
  // Daily call cap reached → try again tomorrow (not next month).
  if (o.budget.callsToday('openai') >= (o.dailyCallCap ?? 30)) return { skipped: 'daily AI call cap reached — will retry tomorrow', retryTomorrow: true };
  const res = o.budget.reserve('openai', worst, { dailyCallCap: o.dailyCallCap ?? 30, detail: `${frames.length} frame(s), ${input.texts.length} text(s)`, ref: input.reelUrl ?? null, model: o.model });
  if (!res) return worst === undefined ? { skipped: `unknown price for ${o.model} — not called` } : { skipped: 'monthly AI budget or daily call cap reached — waiting for next month', retryNextMonth: true };
  const body = JSON.stringify(buildRequest(o.model, input, frames, detail));
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let r: Response;
    try {
      r = await f('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(90_000) });
    } catch (e) { lastErr = `network: ${(e as Error).message}`; if (attempt < 2) { await sleep(3000); continue; } break; }
    const text = await r.text();
    if (!r.ok) {
      let code = ''; try { code = JSON.parse(text)?.error?.code ?? JSON.parse(text)?.error?.type ?? ''; } catch { /* not json */ }
      lastErr = `HTTP ${r.status}${code ? ` ${code}` : ''}`;
      // Quota/billing errors are not retried; rate limits and server errors get one retry honouring Retry-After.
      const retryable = (r.status === 429 && !/insufficient_quota|billing|credit/i.test(code + text)) || r.status >= 500;
      if (retryable && attempt < 2) { await sleep(Math.min(30_000, (Number(r.headers.get('retry-after')) || 2) * 1000)); continue; }
      break;
    }
    const j = JSON.parse(text);
    const inTok = j.usage?.input_tokens ?? 0, outTok = j.usage?.output_tokens ?? 0;
    const usd = tokenCostUsd(o.model, inTok, outTok);
    o.budget.settle(res, usd, `in=${inTok} out=${outTok} status=${j.status}`);
    const parts = (j.output ?? []).flatMap((it: any) => it.content ?? []);
    if (parts.some((p: any) => p.type === 'refusal')) return { skipped: 'model declined', };
    const out = parts.filter((p: any) => p.type === 'output_text').map((p: any) => p.text).join('');
    if (j.status === 'incomplete') return { skipped: `incomplete response (${j.incomplete_details?.reason ?? 'unknown'})` };
    try {
      const parsed = JSON.parse(out);
      return { places: sanitize(parsed.places), usage: { input: inTok, output: outTok, usd } };
    } catch { return { skipped: 'unparseable model output' }; }
  }
  // Failed calls are normally not billed: release the reservation to 0 only when nothing was charged is unknown, so keep the worst case.
  o.budget.settle(res, undefined, `error: ${lastErr}`);
  return { skipped: `OpenAI call failed: ${lastErr}` };
}

function sanitize(v: unknown): AiPlace[] {
  if (!Array.isArray(v)) return [];
  return v.filter((p: any) => p && typeof p.name === 'string' && p.name.trim().length >= 2).slice(0, 12).map((p: any) => ({
    name: String(p.name).trim(), category: CATS.includes(p.category) ? p.category : 'other',
    country: p.country ? String(p.country).trim() : null, city: p.city ? String(p.city).trim() : null,
    role: ['featured', 'mentioned', 'vantage'].includes(p.role) ? p.role : 'featured',
    evidence: String(p.evidence ?? '').trim().slice(0, 300),
    timestamps: Array.isArray(p.timestamps) ? p.timestamps.filter((x: unknown) => typeof x === 'number' && Number.isFinite(x)).slice(0, 20) : [],
    confidence: ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : 'low',
    lat: typeof p.lat === 'number' && Math.abs(p.lat) <= 90 ? p.lat : null,
    lon: typeof p.lon === 'number' && Math.abs(p.lon) <= 180 ? p.lon : null,
    radius_km: typeof p.radius_km === 'number' && p.radius_km > 0 ? p.radius_km : null,
    local_name: typeof p.local_name === 'string' && p.local_name.trim() ? p.local_name.trim() : null,
    address: typeof p.address === 'string' && p.address.trim().length >= 6 ? p.address.trim() : null,
  }));
}

/** Spread frames over the timeline (keep first/last), at most `max`. */
export function pickFrames(frames: AiFrame[], max: number): AiFrame[] {
  if (frames.length <= max) return frames;
  return Array.from({ length: max }, (_, i) => frames[Math.round((i * (frames.length - 1)) / (max - 1))]!);
}
