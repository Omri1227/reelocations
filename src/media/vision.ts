import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import type { Budget } from '../budget.ts';
import { tokenCostUsd } from '../budget.ts';

export interface VisionResult { visibleText: string[]; placeNames: string[]; note?: string }

const PROMPT = `These are frames from a short travel video. Report ONLY what is actually visible.
Return a single JSON object, no prose:
{"visible_text": [verbatim on-screen text that names places, streets, signs, or location tags],
 "place_names": [specific named places you can identify with high confidence from signs or unmistakable landmarks; [] if unsure]}
Never guess a place from generic scenery (beaches, waterfalls, forests, city streets look alike). Empty lists are a good answer.`;

/** Rough worst-case image tokens for a ≤768px-wide frame (≈ width*height/784, 9:16 portrait). */
const IMAGE_TOKENS = 1400;

/**
 * Optional paid fallback (Claude, default claude-haiku-5-5 because the user asked for an inexpensive model).
 * Every call reserves its worst-case cost in the budget ledger first; if the reservation is refused, nothing is sent.
 * Results are treated as *suggestions*: places found only this way always go to the review queue.
 */
export async function describeFrames(opts: { apiKey: string; model: string; budget: Budget; frames: string[]; maxImages?: number; client?: Pick<Anthropic, 'messages'> }): Promise<VisionResult | { skipped: string }> {
  const frames = opts.frames.slice(-(opts.maxImages ?? 4));
  if (!frames.length) return { skipped: 'no frames' };
  const maxOut = 600;
  const worst = tokenCostUsd(opts.model, frames.length * IMAGE_TOKENS + 600, maxOut);
  const res = opts.budget.reserve('anthropic_vision', worst, { dailyCallCap: 20, detail: `${frames.length} frames` });
  if (!res) return { skipped: worst === undefined ? `unknown price for ${opts.model}` : 'monthly vision budget exhausted or not configured' };
  const client: Pick<Anthropic, 'messages'> = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 1, timeout: 60_000 });
  try {
    const content: any[] = frames.map((f) => ({ type: 'image', source: { type: 'base64', media_type: f.endsWith('.png') ? 'image/png' : 'image/jpeg', data: fs.readFileSync(f).toString('base64') } }));
    content.push({ type: 'text', text: PROMPT });
    const params: any = { model: opts.model, max_tokens: maxOut, thinking: { type: 'disabled' }, output_config: { effort: 'low' }, messages: [{ role: 'user', content }] };
    const msg: any = await client.messages.create(params);
    const actual = tokenCostUsd(opts.model, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
    opts.budget.settle(res, actual, `in=${msg.usage?.input_tokens} out=${msg.usage?.output_tokens} stop=${msg.stop_reason}`);
    if (msg.stop_reason === 'refusal') return { skipped: 'model declined' };
    const text = (msg.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 10) : []);
    return { visibleText: arr(json.visible_text), placeNames: arr(json.place_names) };
  } catch (e) {
    opts.budget.settle(res, undefined, `error: ${String((e as Error).message).slice(0, 200)}`); // keep the worst case on the ledger
    return { skipped: `vision call failed: ${(e as Error).message}` };
  }
}
