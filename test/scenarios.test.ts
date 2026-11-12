/**
 * "Definition of done" scenarios. What is real vs. fixture:
 *  REAL     : Code.gs in an emulator behind a real local HTTP server, SQLite, clue extraction, OSM scoring/verification,
 *             country/city grouping, ffmpeg downscaling of frames sent to the AI, the OpenAI request builder & budget gate.
 *  RECORDED : OpenStreetMap Nominatim search + reverse responses (captured live with RECORD=1, replayed afterwards).
 *  SYNTHETIC: the OpenAI API (fake server returning the documented Responses shape), per-frame OCR/transcript of the
 *             "montage" video (fake MediaTools: real frame extraction/OCR are covered by e2e test 7 and live runs).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createApp, type App } from '../src/app.ts';
import { runOnce } from '../src/worker.ts';
import { planGroups } from '../src/sync/grouped.ts';
import type { MediaTools } from '../src/pipeline.ts';
import type { AiPlace } from '../src/media/openai.ts';
import { AppsScriptEmulator, recordReplayFetch, tmpDir, FIX_DIR } from './support.ts';

const TOKEN = 'scn-token-0123456789abcdef';
const MEDIA = path.join(FIX_DIR, 'media');
const reel = (code: string) => `https://www.instagram.com/reel/${code}/`;

let emu: AppsScriptEmulator;
let app: App;
let frameDir: string;
const aiCalls: { code: string; body: any }[] = [];
/** Fake OpenAI per Reel shortcode: places to return, or an HTTP error sequence. */
const AI: Record<string, (AiPlace[] | { status: number; code?: string })[]> = {};

const ocrByFrame: Record<string, string[]> = {};
const fakeMedia: MediaTools = {
  async ocrImage(file) { return ocrByFrame[path.basename(file)] ?? []; },
  async extractFrames(_file, dir) {
    // A 12-second "montage": Fushimi Inari in three consecutive shots, then two more stops in two cities.
    fs.mkdirSync(dir, { recursive: true });
    const plan: [number, string[]][] = [
      [0.0, ['Fushimi Inari Taisha, Kyoto']], [1.5, ['Fushimi Inari Taisha, Kyoto']], [3.0, ['Fushimi Inari Taisha, Kyoto']],
      [5.0, ['Kinkaku-ji, Kyoto']], [8.0, ['Senso-ji, Tokyo']], [11.7, ['follow for part 2']],
    ];
    return plan.map(([t, lines], i) => {
      const f = path.join(dir, `frame-${String(i).padStart(2, '0')}-${t.toFixed(1)}s.png`);
      fs.copyFileSync(path.join(MEDIA, 'landscape-no-text.png'), f);
      ocrByFrame[path.basename(f)] = lines;
      return f;
    });
  },
  async transcribe() { return { text: 'Three stops in one day. First the red gates.', segments: [{ t: 0, text: 'Three stops in one day.' }, { t: 1, text: 'First the red gates.' }] }; },
};

function fakeOpenAI(): typeof fetch {
  return (async (url: any, init: any) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body);
    const code = JSON.stringify(body).match(/reel\/([A-Z0-9]+)\//)?.[1] ?? '';
    aiCalls.push({ code, body });
    const next = (AI[code] ?? [[]]).shift() ?? [];
    if (!Array.isArray(next)) return new Response(JSON.stringify({ error: { message: 'x', type: next.code ?? 'server_error', code: next.code ?? null } }), { status: next.status, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({
      id: 'resp_fake', status: 'completed', usage: { input_tokens: 3200, output_tokens: 180 },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ places: next }) }] }],
    }), { status: 200 });
  }) as typeof fetch;
}

const share = async (code: string, at: string, note = '') => (await fetch(emu.url, { method: 'POST', body: JSON.stringify({ token: TOKEN, action: 'share', text: reel(code), shared_at: at, note, input_types: 'URL' }) })).json() as Promise<any>;
const attach = async (file: string, code: string, at: string, mime: string) => (await fetch(emu.url, { method: 'POST', body: JSON.stringify({ token: TOKEN, action: 'media', data: fs.readFileSync(file).toString('base64'), filename: path.basename(file), reel_url: reel(code), shared_at: at, mime }) })).json() as Promise<any>;
const links = (code: string) => app.store.linksForReel(`ig:${code}`) as any[];
const place = (id: string) => app.store.getPlace(id)!;
const cycle = () => runOnce(app, { skipSync: true });

before(async () => {
  emu = new AppsScriptEmulator(TOKEN); await emu.listen();
  const dataDir = tmpDir('scenarios'); frameDir = path.join(dataDir, 'frames');
  const cfg = loadConfig({ dataDir, inboxUrl: emu.url, inboxToken: TOKEN, instagramOembed: false, transcribe: 'off', anthropicKey: undefined, visionMonthlyBudgetUsd: 0, googlePlacesKey: undefined,
    openaiKey: 'sk-test-not-a-real-key', instagramPageCaption: false, openaiModel: 'gpt-6-luna', openaiMonthlyBudgetUsd: 3, openaiDetail: 'high', openaiMaxFrames: 8, openaiDailyCalls: 15 });
  app = createApp(cfg, { fetch: recordReplayFetch(), polite: process.env.RECORD === '1', backoffBaseMs: 1, media: fakeMedia, aiFetch: fakeOpenAI(), aiSleep: async () => {} });
});
after(async () => { await app.close(); await emu.close(); });

test('single-place Reel: your note → confirmed temple in Kyoto, Japan, no AI call needed', async () => {
  await share('ONE01', '2026-11-10T09:00:00+09:00', '📍 Kiyomizu-dera, Kyoto');
  await cycle();
  const l = links('ONE01');
  assert.equal(l.length, 1); assert.equal(l[0].category, 'temple'); assert.equal(l[0].confidence, 'confirmed');
  const p = place(l[0].place_id);
  assert.equal(p.country, 'Japan'); assert.equal(p.locality, 'Kyoto');
  assert.equal(aiCalls.filter((c) => c.code === 'ONE01').length, 0, 'fully resolved locally → no paid call');
});

test('montage Reel: three distinct places in two Japanese cities; one place in three frames → one marker', async () => {
  await share('MONT01', '2026-11-10T10:00:00+09:00');
  await attach(path.join(MEDIA, 'clip-waterfall.mp4'), 'MONT01', '2026-11-10T10:01:00+09:00', 'video/mp4');
  await cycle();
  const l = links('MONT01');
  const names = l.map((x) => x.name).join(' | ');
  assert.equal(l.filter((x) => /Fushimi Inari/i.test(x.name)).length, 1, `one Fushimi Inari marker (${names})`);
  assert.ok(l.some((x) => /Kinkaku/i.test(x.name)), names);
  assert.ok(l.some((x) => /Sens[oō]-?ji/i.test(x.name)), names);
  assert.ok(l.length >= 3);
  const cities = new Set(l.map((x) => place(x.place_id).locality));
  assert.ok(cities.has('Kyoto') && cities.has('Tokyo'), `cities: ${[...cities].join(', ')}`);
  const jp = planGroups(app.store, { titlePrefix: '', layout: 'per-country' }).maps.find((m) => m.countryCode === 'jp')!;
  assert.deepEqual(jp.layers.map((x) => x.name), ['Kyoto', 'Tokyo'], 'Japan → Kyoto / Tokyo');
  for (const x of l) assert.equal(app.store.getReel('ig:MONT01')!.first_shared_at, '2026-11-10T10:00:00+09:00', `${x.name} keeps the original share time`);
});

test('partly resolved Reel: the reliable match is kept while the unknown one waits in review', async () => {
  AI.PART01 = [[]]; // the AI fallback finds nothing more
  await share('PART01', '2026-11-10T11:00:00+09:00', '📍 Kinkaku-ji, Kyoto\n📍 Qwzzyx Hidden Kissaten, Kyoto');
  await cycle();
  const r = app.store.getReel('ig:PART01')!;
  assert.equal(r.status, 'needs_review'); assert.match(r.status_reason ?? '', /partially resolved/);
  assert.ok(links('PART01').some((x) => /Kinkaku/i.test(x.name)), 'confirmed place saved despite the open question');
});

test('rural place: Skógafoss → waterfall in Iceland with a readable locality', async () => {
  await share('RURAL01', '2026-11-10T12:00:00+00:00', '📍 Skógafoss, Iceland');
  await cycle();
  const l = links('RURAL01');
  assert.equal(l.length, 1); assert.equal(l[0].category, 'waterfall');
  const p = place(l[0].place_id);
  assert.equal(p.country, 'Iceland'); assert.ok(p.locality && p.locality.length > 2, `locality: ${p.locality}`);
});

test('OpenAI: a clear, verified suggestion is saved automatically; frames and the Reel URL are sent, the URL only as context', async () => {
  AI.AIOK01 = [[{ name: 'Kiyomizu-dera', category: 'temple', country: 'Japan', city: 'Kyoto', role: 'featured', evidence: 'wooden stage on stilts over the hillside, sign 清水寺', timestamps: [], confidence: 'high', lat: null, lon: null, radius_km: null, local_name: null, address: null }]];
  await share('AIOK01', '2026-11-10T13:00:00+09:00');
  await attach(path.join(MEDIA, 'landscape-no-text.png'), 'AIOK01', '2026-11-10T13:01:00+09:00', 'image/png');
  await cycle();
  const call = aiCalls.find((c) => c.code === 'AIOK01')!;
  assert.ok(call, 'AI called because local methods found nothing');
  const content = call.body.input[0].content;
  assert.ok(content.some((c: any) => c.type === 'input_image' && c.image_url.startsWith('data:image/jpeg;base64,') && c.detail === 'high'));
  assert.match(content[0].text, /Reel URL \(context only, not opened\)/); assert.match(content[0].text, /Video: NOT available/);
  assert.equal(call.body.text.format.type, 'json_schema'); assert.equal(call.body.text.format.strict, true);
  const l = links('AIOK01');
  assert.equal(l.length, 1); assert.match(l[0].name, /Kiyomizu/); assert.equal(l[0].decided_by, 'ai+osm'); assert.equal(l[0].confidence, 'confirmed');
  const spent = app.budget.report();
  assert.ok(spent.total > 0 && spent.total < 0.01, `actual cost settled from usage: $${spent.total}`);
});

test('OpenAI: an ambiguous / unverifiable suggestion goes to review with the reason', async () => {
  AI.AIAMB01 = [[{ name: 'Central Park', category: 'park', country: null, city: null, role: 'featured', evidence: 'green park with skyscrapers', timestamps: [2], confidence: 'medium', lat: null, lon: null, radius_km: null, local_name: null, address: null }]];
  await share('AIAMB01', '2026-11-10T14:00:00+09:00');
  await attach(path.join(MEDIA, 'landscape-no-text.png'), 'AIAMB01', '2026-11-10T14:01:00+09:00', 'image/png');
  await cycle();
  const r = app.store.getReel('ig:AIAMB01')!;
  assert.equal(r.status, 'needs_review'); assert.match(r.status_reason ?? '', /AI suggestion/);
  assert.equal(links('AIAMB01').length, 0, 'nothing uncertain on the map');
});

test('OpenAI: a 503 is retried once; a quota error is not retried; a link-only Reel is not sent at all', async () => {
  AI.AIRETRY01 = [{ status: 503 }, [{ name: 'Kinkaku-ji', category: 'temple', country: 'Japan', city: 'Kyoto', role: 'featured', evidence: 'golden pavilion', timestamps: [], confidence: 'high', lat: null, lon: null, radius_km: null, local_name: null, address: null }]];
  await share('AIRETRY01', '2026-11-10T15:00:00+09:00');
  await attach(path.join(MEDIA, 'landscape-no-text.png'), 'AIRETRY01', '2026-11-10T15:01:00+09:00', 'image/png');
  AI.AIQUOTA01 = [{ status: 429, code: 'insufficient_quota' }];
  await share('AIQUOTA01', '2026-11-10T15:10:00+09:00');
  await attach(path.join(MEDIA, 'landscape-no-text.png'), 'AIQUOTA01', '2026-11-10T15:11:00+09:00', 'image/png');
  await share('LINKONLY01', '2026-11-10T15:20:00+09:00');
  await cycle();
  assert.equal(aiCalls.filter((c) => c.code === 'AIRETRY01').length, 2);
  assert.ok(links('AIRETRY01').some((x) => /Kinkaku/i.test(x.name)));
  assert.equal(aiCalls.filter((c) => c.code === 'AIQUOTA01').length, 1, 'quota errors are not retried');
  assert.equal(app.store.getReel('ig:AIQUOTA01')!.status, 'needs_review');
  assert.equal(aiCalls.filter((c) => c.code === 'LINKONLY01').length, 0, 'the model cannot open a URL: nothing to send');
});

test('budget: when the monthly cap is reached nothing is sent; the Reel waits in review and is retried next month', async () => {
  // Fill the ledger up to the cap with a settled fake cost.
  const fill = 3 - app.budget.spent() - 1e-6;
  const r = app.budget.reserve('openai', fill, { detail: 'test fill' })!;
  assert.ok(r, 'fill reservation'); app.budget.settle(r, fill);
  const before = aiCalls.length;
  await share('BUDGET01', '2026-11-10T16:00:00+09:00');
  await attach(path.join(MEDIA, 'landscape-no-text.png'), 'BUDGET01', '2026-11-10T16:01:00+09:00', 'image/png');
  await cycle();
  assert.equal(aiCalls.length, before, 'no request once the cap would be exceeded');
  assert.equal(app.store.getReel('ig:BUDGET01')!.status, 'needs_review');
  assert.ok(app.store.getKv('ai:wait:ig:BUDGET01'), 'marked to retry when the next month starts');
  assert.ok(app.budget.report().total <= 3.0001, 'hard ceiling holds');
});

test('repeat share of the same Reel and a re-run: no duplicate places, nothing removed', async () => {
  const before = links('MONT01').length;
  await share('MONT01', '2026-11-12T08:00:00+09:00');
  await cycle(); await cycle();
  assert.equal(links('MONT01').length, before);
  assert.equal(app.store.getReel('ig:MONT01')!.first_shared_at, '2026-11-10T10:00:00+09:00', 'earliest share date kept');
});

test('pin photos: each place in the montage gets the frame that names it (with its time); photos are shared and put on the pin', async () => {
  const { buildSnapshot } = await import('../src/sync/kml.ts');
  const links = app.store.linksForReel('ig:MONT01') as any[];
  const byName = (re: RegExp) => links.find((l) => re.test(l.name));
  const fushimi = byName(/Fushimi/), kinkaku = byName(/Kinkaku/), senso = byName(/Sens[oō]/);
  assert.equal(fushimi.image_kind, 'place'); assert.equal(Number(fushimi.image_t), 0);
  assert.equal(kinkaku.image_kind, 'place'); assert.equal(Number(kinkaku.image_t), 5);
  assert.equal(senso.image_kind, 'place'); assert.equal(Number(senso.image_t), 8);
  // Uploaded through the inbox (emulator: the real Code.gs "image_put") during the worker run.
  await runOnce(app, { skipSync: true });
  const after = app.store.linksForReel('ig:MONT01') as any[];
  assert.ok(after.every((l) => /^https:\/\/drive\.google\.com\/thumbnail\?id=/.test(l.image_url ?? '')), 'every pin photo has a shared URL');
  const kml = buildSnapshot(app.store, 'x').kml;
  assert.match(kml, /<img src="https:\/\/drive\.google\.com\/thumbnail\?id=[^"]+" width="400"><br>📸 From the Reel \(0:05\)/, 'photo + label in the pin description');
});
