import { readPublicCaption } from './metadata/pagecaption.ts';
import { findChrome } from './sync/mymaps.ts';
import { askOpenAI, pickFrames } from './media/openai.ts';
import { lookupLocality } from './geo/locality.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { Store } from './db.ts';
import { Http, type FetchLike } from './util/http.ts';
import { Nominatim, Overpass } from './geo/osm.ts';
import { GooglePlaces } from './geo/googlePlaces.ts';
import { Budget } from './budget.ts';
import { fetchOembed } from './metadata/instagram.ts';
import type { MediaTools, PipelineDeps } from './pipeline.ts';
import type { ResolveDeps } from './resolve/resolver.ts';
import { Ocr } from './media/ocr.ts';
import { extractAudioPcm, extractFrames, downscale } from './media/ffmpeg.ts';
import { loadTranscriber } from './media/transcribe.ts';
import { describeFrames } from './media/vision.ts';
import { AppsScriptInbox, type Inbox } from './intake/inbox.ts';

export interface App { cfg: Config; store: Store; http: Http; budget: Budget; resolve: ResolveDeps; pipeline: PipelineDeps; inbox?: Inbox; close(): Promise<void> }

export function createApp(cfg: Config, opts: { fetch?: FetchLike; inbox?: Inbox; media?: MediaTools | null; log?: (m: string) => void; polite?: boolean; backoffBaseMs?: number; aiFetch?: typeof fetch; aiSleep?: (ms: number) => Promise<void> } = {}): App {
  const store = new Store(cfg.dbPath);
  const http = new Http({
    fetch: opts.fetch, userAgent: cfg.userAgent, store, backoffBaseMs: opts.backoffBaseMs,
    minIntervalMs: opts.polite === false ? {} : { [new URL(cfg.nominatimUrl).host]: 1100, ...Object.fromEntries(cfg.overpassUrls.map((u) => [new URL(u).host, 1500])), 'graph.facebook.com': 500 },
  });
  const budget = new Budget(store, {
    anthropic_vision: Math.min(cfg.visionMonthlyBudgetUsd, 3),
    ...(cfg.openaiKey ? { openai: cfg.openaiMonthlyBudgetUsd } : {}),
    ...(cfg.googlePlacesKey ? { google_places: 0 } : {}),
  });
  const google = cfg.googlePlacesKey ? new GooglePlaces(http, cfg.googlePlacesKey, budget) : undefined;
  const resolve: ResolveDeps = {
    geocoder: new Nominatim(http, cfg.nominatimUrl),
    routes: new Overpass(http, cfg.overpassUrls),
    google: google ? (q, bias) => google.textSearch(q, bias) : undefined,
    locate: (lat, lon) => lookupLocality(http, cfg.nominatimUrl, lat, lon),
  };
  let ocr: Ocr | undefined;
  const media: MediaTools | undefined = opts.media === null ? undefined : opts.media ?? {
    ocrImage: async (f, o) => { ocr ??= new Ocr(cfg.ocrLangs, path.join(cfg.dataDir, 'tessdata')); return ocr.readEnhanced(f, { thorough: o?.thorough, tmpDir: path.join(cfg.dataDir, 'work', 'ocr') }); },
    extractFrames: (f, dir) => extractFrames(f, dir),
    transcribe: cfg.transcribe === 'off' ? undefined : async (f) => {
      const t = await loadTranscriber(undefined, cfg.transcribeLanguage);
      if (!t) return null;
      const pcm = await extractAudioPcm(f);
      return pcm ? t.transcribe(pcm) : { text: '', segments: [] };
    },
    close: async () => { await ocr?.close(); },
  };
  const visionOn = !!cfg.anthropicKey && cfg.visionMonthlyBudgetUsd > 0;
  const pipeline: PipelineDeps = {
    store, resolve, workDir: path.join(cfg.dataDir, 'work'),
    refreshGoogle: google ? (id) => google.refreshLocation(id) : undefined,
    oembed: cfg.instagramOembed ? (u) => fetchOembed(http, u) : undefined,
    pageCaption: cfg.instagramPageCaption ? (u) => readPublicCaption(u, { chromePath: findChrome(cfg.chromePath) }) : undefined,
    media,
    vision: visionOn ? async (frames) => {
      const dir = path.join(cfg.dataDir, 'work', 'vision'); fs.mkdirSync(dir, { recursive: true });
      const small: string[] = [];
      for (const f of frames.slice(-4)) small.push(await downscale(f, path.join(dir, `${path.basename(f, path.extname(f))}.jpg`)));
      return describeFrames({ apiKey: cfg.anthropicKey!, model: cfg.visionModel, budget, frames: small });
    } : undefined,
    ai: cfg.openaiKey && cfg.openaiMonthlyBudgetUsd > 0 ? async (input) => {
      // Frames are downscaled to ≤768 px wide JPEGs first (cost scales with pixels).
      const dir = path.join(cfg.dataDir, 'work', 'ai'); fs.mkdirSync(dir, { recursive: true });
      const frames = [];
      for (const f of pickFrames(input.frames, cfg.openaiMaxFrames)) frames.push({ ...f, file: await downscale(f.file, path.join(dir, `${path.basename(f.file, path.extname(f.file))}.jpg`)) });
      return askOpenAI({ apiKey: cfg.openaiKey!, model: cfg.openaiModel, budget, detail: cfg.openaiDetail, maxImages: cfg.openaiMaxFrames, dailyCallCap: cfg.openaiDailyCalls, fetch: opts.aiFetch, sleep: opts.aiSleep }, { ...input, frames });
    } : undefined,
    log: opts.log,
  };
  const inbox = opts.inbox ?? (cfg.inboxUrl && cfg.inboxToken ? new AppsScriptInbox(http, cfg.inboxUrl, cfg.inboxToken) : undefined);
  return { cfg, store, http, budget, resolve, pipeline, inbox, close: async () => { await media?.close?.(); store.close(); } };
}

/** Prevent overlapping scheduled runs (Task Scheduler every 15 min). Stale locks (>2h) are taken over. */
export function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T | { locked: true }> {
  const file = path.join(dir, 'run.lock');
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < 2 * 3600_000) return Promise.resolve({ locked: true as const });
  } catch { /* no lock */ }
  fs.writeFileSync(file, String(process.pid));
  return fn().finally(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });
}
