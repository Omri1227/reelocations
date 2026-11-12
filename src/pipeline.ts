import { norm } from './util/text.ts';
import { haversineKm } from './geo/geometry.ts';
import { normalizeCaption } from './metadata/pagecaption.ts';
import crypto from 'node:crypto';
import type { AiInput, AiResult, AiPlace } from './media/openai.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Store, ReelRow, MediaRow } from './db.ts';
import type { Capabilities, TextEvidence } from './types.ts';
import { HttpError, NetworkError } from './util/http.ts';
import type { ReelMetadata } from './metadata/instagram.ts';
import { decodeTarget, fetchRouteFeature, resolveReel, type Resolution, type ResolveDeps } from './resolve/resolver.ts';
import type { VisionResult } from './media/vision.ts';

export interface MediaTools {
  /** thorough = several prepared copies (screenshots); otherwise one extra bright-text pass (video frames). */
  ocrImage(file: string, opts?: { thorough?: boolean }): Promise<string[]>;
  extractFrames(file: string, outDir: string): Promise<string[]>;
  /** Returns transcript text, '' for no speech, or null when transcription is unavailable. */
  transcribe?(file: string): Promise<string | { text: string; segments: { t: number; text: string }[] } | null>;
  close?(): Promise<void>;
}

export interface PipelineDeps {
  store: Store;
  resolve: ResolveDeps;
  workDir: string;
  oembed?: (url: string) => Promise<ReelMetadata>;
  media?: MediaTools;
  vision?: (frames: string[]) => Promise<VisionResult | { skipped: string }>;
  /** OpenAI fallback (budget-gated). Receives frames with timestamps, texts and the Reel URL as context. */
  ai?: (input: AiInput) => Promise<AiResult>;
  /** Re-fetch a Google place's location by ID (keeps cached Google coordinates under 30 days old). */
  refreshGoogle?: (placeId: string) => Promise<{ lat: number; lon: number } | null>;
  /** Opt-in public-page caption reader (headless browser). */
  pageCaption?: (url: string) => Promise<ReelMetadata>;
  log?: (msg: string) => void;
}

interface MediaText {
  ocr: string[]; transcript: string | null; frames: string[]; hasAudio?: boolean; error?: string;
  /** Per-frame timestamps (seconds; undefined for screenshots), OCR lines per frame, and timestamped speech. */
  frameTimes?: (number | undefined)[]; ocrAt?: { t?: number; lines: string[] }[]; segments?: { t: number; text: string }[];
}

/** Frame files are named "frame-03-12.5s.png" by extractFrames: read the time back. */
export const frameTime = (f: string): number | undefined => { const m = f.match(/-(\d+(?:\.\d+)?)s\.\w+$/); return m ? Number(m[1]) : undefined; };

const MAX_ATTEMPTS = 6;

function isTransient(e: unknown): boolean {
  return e instanceof NetworkError || (e instanceof HttpError && (e.status >= 500 || e.status === 429 || e.status === 408));
}

async function mediaText(deps: PipelineDeps, m: MediaRow): Promise<MediaText> {
  // Bump the version when OCR/transcription improves so cached readings are redone once (v2: bright-text OCR passes).
  // v3: per-frame timestamps, scene-change frames, timestamped transcript.
  const key = `mediatext:v3:${m.media_id}`;
  const cached = deps.store.getKv(key);
  if (cached) return JSON.parse(cached);
  const out: MediaText = { ocr: [], transcript: null, frames: [] };
  if (!deps.media || !m.local_path || !fs.existsSync(m.local_path)) return out;
  try {
    if (m.kind === 'image') {
      out.frames = [m.local_path];
      out.frameTimes = [undefined];
      out.ocr = await deps.media.ocrImage(m.local_path, { thorough: true });
      out.ocrAt = [{ lines: out.ocr }];
    } else {
      const dir = path.join(deps.workDir, 'frames', m.media_id.replace(/[^\w-]/g, '_'));
      out.frames = await deps.media.extractFrames(m.local_path, dir);
      out.frameTimes = out.frames.map(frameTime);
      out.ocrAt = [];
      // One place shown in ten frames is still one line here (and one clue): repeated text is merged across frames.
      const seen = new Set<string>();
      for (const f of out.frames) {
        const lines = await deps.media.ocrImage(f);
        out.ocrAt.push({ t: frameTime(f), lines });
        for (const l of lines) {
          const k = l.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
          if (!seen.has(k)) { seen.add(k); out.ocr.push(l); }
        }
      }
      const tr = deps.media.transcribe ? await deps.media.transcribe(m.local_path) : null;
      if (tr && typeof tr === 'object') { out.transcript = tr.text; out.segments = tr.segments; } else out.transcript = tr;
    }
    deps.store.updateMedia(m.media_id, { status: 'processed' });
  } catch (e) {
    out.error = String((e as Error).message);
    deps.store.updateMedia(m.media_id, { status: 'failed', error: out.error });
  }
  deps.store.setKv(key, JSON.stringify(out));
  return out;
}

function fullyResolved(r: Resolution): boolean {
  return r.status === 'resolved' && r.links.some((l) => l.place.confidence === 'confirmed');
}

/** Process one Reel end-to-end. Never deletes places; links are insert-or-ignore. */
export async function processReel(deps: PipelineDeps, reel: ReelRow): Promise<{ status: string; reason: string }> {
  const { store } = deps;
  const key = reel.reel_key;
  try {
    const caps: Capabilities = { url: reel.url ? (reel.reel_key.startsWith('ig:') ? 'ok' : 'not_instagram') : 'missing', caption: 'skipped', geotag: 'unavailable', video: 'unavailable', audio: 'skipped', images: 'unavailable', notes: [] };
    const evidence: TextEvidence[] = store.notesFor(key).map((text) => ({ source: 'note' as const, text }));

    // 1) Public metadata via official oEmbed (caption only if Meta includes it; geotags are never exposed).
    let meta: ReelMetadata | undefined = reel.metadata_json ? JSON.parse(reel.metadata_json) : undefined;
    if (reel.url && reel.reel_key.startsWith('ig:') && deps.oembed && !(meta?.ok)) {
      meta = await deps.oembed(reel.url);
      if (!meta.ok && meta.transient) throw new NetworkError(`oEmbed: ${meta.error}`);
    }
    const stages = ['metadata'];
    // 1b) Opt-in: the caption a visitor sees on the public Reel page (headless browser, no login). Only when no caption
    //     is known yet; one attempt per Reel (a failure is retried after 7 days), the result is cached with the Reel.
    if (reel.url && reel.reel_key.startsWith('ig:') && deps.pageCaption && !(meta?.ok && meta.caption)) {
      const tried = store.getKv(`page:tried:${key}`);
      if (!tried || Date.now() - Date.parse(tried) > 7 * 86_400_000) {
        stages.push('page-caption');
        const m = await deps.pageCaption(reel.url);
        store.setKv(`page:tried:${key}`, new Date().toISOString());
        if (m.ok) meta = m; else caps.notes.push(`public page: ${m.error}`);
      }
    }
    if (meta) {
      caps.caption = meta.ok && meta.caption ? 'ok' : 'unavailable';
      if (!meta.ok) caps.notes.push(`${meta.source === 'page' ? 'public page' : 'oEmbed'}: ${meta.error}`);
      if (meta.caption) evidence.push({ source: 'caption', text: normalizeCaption(meta.caption) });
    }
    caps.notes.push('Geotag: not exposed by any supported public Instagram endpoint; read it from a screenshot instead.');

    // 2) Regular lookup on text we already have.
    let res = await resolveReel(evidence, deps.resolve);

    // 3) Escalate to local media analysis only if needed.
    const media = store.mediaFor(key).filter((m) => m.local_path);
    const frames: string[] = [];
    const timed: { frames: { file: string; t?: number }[]; ocr: { t?: number; text: string }[]; speech: { t: number; text: string }[] } = { frames: [], ocr: [], speech: [] };
    if (media.some((m) => m.kind === 'video')) caps.video = 'attached';
    if (media.some((m) => m.kind === 'image')) caps.images = 'attached';
    if (!fullyResolved(res) && media.length) {
      stages.push('media');
      for (const m of media) {
        const t = await mediaText(deps, m);
        frames.push(...t.frames);
        t.frames.forEach((f, i) => timed.frames.push({ file: f, t: t.frameTimes?.[i] }));
        for (const o of t.ocrAt ?? []) if (o.lines.length) timed.ocr.push({ t: o.t, text: o.lines.join(' / ') });
        timed.speech.push(...(t.segments ?? []));
        if (t.ocr.length) evidence.push({ source: 'ocr', text: t.ocr.join('\n'), ref: m.media_id });
        if (m.kind === 'video') {
          if (t.transcript === null) caps.audio = deps.media?.transcribe ? 'unavailable' : 'skipped';
          else if (t.transcript.trim()) { caps.audio = 'transcribed'; evidence.push({ source: 'transcript', text: t.transcript, ref: m.media_id }); }
          else caps.audio = 'no_speech';
        }
        if (t.error) caps.notes.push(`media ${m.media_id}: ${t.error}`);
      }
      res = await resolveReel(evidence, deps.resolve);
    }

    // 4) OpenAI fallback: every Reel is eligible once the free/local methods leave it unresolved, partly resolved, or
    //    only approximate. Called again only when the evidence changed (e.g. a new attachment). Results are verified
    //    against OSM by the resolver: strong matches are saved automatically, the rest go to review.
    let aiNote: string | undefined;
    // An explicit list in the caption/note (📍 lines, numbered list) was looked up directly: OpenAI cannot add
    // anything to a listed name that only matches a same-named bus stop — those go to review instead of a paid call.
    // Skip only when the list mostly worked (≥2 found, ≤1 left open — e.g. 5 found, 1 open).
    // If several listed items fail ("📍 Example Grill Wagyu … JPY 7,740"), OpenAI interprets the caption.
    const listed = res.clues.filter((c) => c.explicit && c.kind !== 'area' && c.sources.some((x) => x === 'caption' || x === 'note'));
    // A listed place saved only as APPROXIMATE (medium confidence) still counts as open: OpenAI may pin it exactly.
    const listedOpen = listed.filter((c) => !res.links.some((l) => l.clueText === c.text && l.place.confidence !== 'approximate')).length;
    const explicitList = listed.length >= 2 && listed.length - listedOpen >= 2 && listedOpen <= 1;
    if (explicitList && deps.ai && !fullyResolved(res)) caps.notes.push('AI fallback not needed: the caption/note lists the places explicitly');
    if (!fullyResolved(res) && deps.ai && !explicitList) {
      const texts: AiInput['texts'] = [
        ...evidence.filter((e) => e.source === 'note').map((e) => ({ source: 'note' as const, text: e.text })),
        ...evidence.filter((e) => e.source === 'caption').map((e) => ({ source: 'caption' as const, text: e.text })),
        ...(timed.ocr.length ? timed.ocr.map((o) => ({ source: 'ocr' as const, text: o.text, t: o.t })) : evidence.filter((e) => e.source === 'ocr').map((e) => ({ source: 'ocr' as const, text: e.text }))),
        ...(timed.speech.length ? timed.speech.map((s) => ({ source: 'transcript' as const, text: s.text, t: s.t })) : evidence.filter((e) => e.source === 'transcript').map((e) => ({ source: 'transcript' as const, text: e.text }))),
      ];
      const input: AiInput = { reelUrl: reel.url, videoAvailable: caps.video === 'attached', frames: timed.frames, texts };
      const sig = crypto.createHash('sha256').update(JSON.stringify({ v: 3 /* bump when the AI instructions change */, t: texts, f: timed.frames.map((f) => path.basename(f.file)) })).digest('hex').slice(0, 16);
      if (store.getKv(`ai:sig:${key}`) !== sig) {
        stages.push('openai');
        const r = await deps.ai(input);
        if ('skipped' in r) {
          aiNote = `AI fallback skipped: ${r.skipped}`;
          if (r.retryNextMonth) store.setKv(`ai:wait:${key}`, new Date().toISOString().slice(0, 7));
          else if (r.retryTomorrow) store.setKv(`ai:wait:${key}`, new Date().toISOString().slice(0, 10));
          else store.setKv(`ai:sig:${key}`, sig);
        } else {
          store.setKv(`ai:sig:${key}`, sig);
          store.setKv(`ai:result:${key}`, JSON.stringify(r));
          aiNote = `AI fallback: ${r.places.length} suggestion(s)${r.usage.usd !== undefined ? ` ($${r.usage.usd.toFixed(5)})` : ''}`;
          res = await resolveReel(evidence, deps.resolve, { aiPlaces: r.places });
        }
        if (!input.videoAvailable) caps.notes.push('AI: no video was available — it saw only your note/screenshots and their text');
      } else {
        const prev = store.getKv(`ai:result:${key}`);
        if (prev) { const r = JSON.parse(prev) as { places: AiPlace[] }; res = await resolveReel(evidence, deps.resolve, { aiPlaces: r.places }); }
      }
      if (aiNote) caps.notes.push(aiNote);
    }

    // 5) Optional paid Claude vision (legacy), once per Reel, only when still unresolved and frames exist. Suggestions only.
    if (!fullyResolved(res) && deps.vision && frames.length && !reel.vision_used) {
      stages.push('vision');
      store.markVisionUsed(key);
      const v = await deps.vision(frames);
      if ('skipped' in v) caps.notes.push(`vision skipped: ${v.skipped}`);
      else {
        const lines = [...v.visibleText.map((t) => t), ...v.placeNames.map((p) => `📍 ${p}`)];
        if (lines.length) { evidence.push({ source: 'vision', text: lines.join('\n') }); res = await resolveReel(evidence, deps.resolve); }
      }
    }

    // 5) Persist (insert/enrich only).
    const alreadyLinked = store.linksForReel(key) as any[];
    const savedAs = new Map<string, string>(); // candidate ref → the pin it was saved as
    for (const l of res.links) {
      const ref0 = l.place.place_id;
      // Re-processing (e.g. after the screenshot arrives) can produce a second AI estimate for the SAME place with a
      // different spelling and a slightly different position (a mountain in English vs its Japanese name, seen live 2026-11-11).
      // An approximate estimate within 3 km of a pin this Reel already has, of the same category, is that pin.
      if (l.place.confidence === 'approximate' && !alreadyLinked.some((e) => e.place_id === l.place.place_id)) {
        const twin = alreadyLinked.find((e) => e.category === l.place.category && haversineKm(e, l.place) < 3);
        if (twin) { l.place.place_id = twin.place_id; savedAs.set(ref0, twin.place_id); continue; }
      }
      l.place.place_id = store.upsertPlace(l.place).place_id; // may be an existing pin for the same Google listing
      savedAs.set(ref0, l.place.place_id);
      store.linkReelPlace({ reel_key: key, place_id: l.place.place_id, cue: l.cue, cue_source: l.cueSource, role: l.role, decided_by: l.clue?.sources.every((x) => x === 'ai') ? 'ai+osm' : 'auto' });
    }
    // 5b) A picture for each pin: the frame that names/shows this place, else a general Reel frame ("Reel preview").
    //      Media readings are cached, so this costs nothing extra after the first run.
    if (media.length && res.links.length) {
      const pool: { file: string; t?: number; text: string; screenshot: boolean }[] = [];
      for (const m of media) {
        const t = await mediaText(deps, m);
        t.frames.forEach((f, i) => pool.push({ file: f, t: t.frameTimes?.[i] ?? undefined, text: (t.ocrAt?.[i]?.lines ?? []).join(' '), screenshot: m.kind === 'image' }));
      }
      for (const l of res.links) {
        const names = [l.place.name, l.clueText, ...(l.clue?.aliases ?? [])].filter((x): x is string => !!x && x.length >= 3).map(norm);
        const mention = pool.find((f) => names.some((n) => norm(f.text).includes(n)));
        const ts = l.clue?.timestamps ?? [];
        const timed = !mention && ts.length ? pool.filter((f) => f.t != null).sort((a, b) => Math.abs(a.t! - ts[0]!) - Math.abs(b.t! - ts[0]!))[0] : undefined;
        const pick = mention ?? timed;
        const preview = pool.find((f) => f.screenshot) ?? pool[0];
        if (pick) store.setLinkImage(key, l.place.place_id, { path: pick.file, kind: 'place', t: pick.t });
        else if (preview) store.setLinkImage(key, l.place.place_id, { path: preview.file, kind: 'preview', t: preview.t });
      }
    }
    // Review options for approximate pins point at the pin as saved. A pin that is confirmed by now (by you, or by
    // another Reel) needs no question: its options go, and a Reel open only for that question is resolved.
    let reviewCandidates = res.reviewCandidates.map((c) => ({ ...c, ...(c.confirmsApproxPlaceId ? { confirmsApproxPlaceId: savedAs.get(c.confirmsApproxPlaceId) ?? c.confirmsApproxPlaceId } : {}), ...(c.replacesApproxPlaceId ? { replacesApproxPlaceId: savedAs.get(c.replacesApproxPlaceId) ?? c.replacesApproxPlaceId } : {}) }));
    const settled = (pid: string) => store.getPlace(pid)?.confidence === 'confirmed' || (store.linksForReel(key) as any[]).some((e) => e.place_id === pid && e.decided_by === 'user');
    reviewCandidates = reviewCandidates.filter((c) => { const pid = c.confirmsApproxPlaceId ?? c.replacesApproxPlaceId; return !pid || !settled(pid); });
    let resStatus = res.status;
    if (resStatus === 'needs_review' && res.reason.startsWith('saved as approximate') && !reviewCandidates.some((c) => c.confirmsApproxPlaceId)) resStatus = 'resolved';
    store.replaceCandidates(key, reviewCandidates);
    let reason = resStatus === res.status ? res.reason : `${res.links.length} place(s) saved`;
    if (resStatus === 'needs_review' && !media.length && caps.caption !== 'ok') reason += ' — tip: share the Reel again with Save Reel to Map (it attaches a screenshot), or add a note with the place name';
    // A Reel that already had confirmed places (e.g. chosen by the user) keeps them even if this run found less.
    const existing = store.linksForReel(key);
    const status = resStatus === 'needs_review' && existing.length && res.links.length === 0 && (existing.some((e: any) => e.decided_by === 'user') || !res.clues.some((c) => c.explicit)) ? 'resolved' : resStatus;
    store.setReelResult(key, { status, reason, metadata: meta ?? null, capabilities: caps, evidence: { stages, texts: evidence, clues: res.clues, notes: res.notes } });
    // "Could not check" is not "ambiguous": if a lookup was skipped because a service was busy/offline, retry later.
    if (status === 'needs_review' && res.deferred.length && reel.attempts + 1 < MAX_ATTEMPTS) {
      const why = `will retry: ${res.deferred.join(', ')} unavailable`;
      store.setReelError(key, why);
      deps.log?.(`${key}: ${why}`);
      return { status: 'error', reason: why };
    }
    deps.log?.(`${key}: ${status} — ${reason}`);
    return { status, reason };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (isTransient(e) && reel.attempts + 1 < MAX_ATTEMPTS) {
      store.setReelError(key, msg);
      deps.log?.(`${key}: will retry (${msg})`);
      return { status: 'error', reason: msg };
    }
    // Permanent or exhausted: keep it visible in the review queue with its link and date.
    store.setReelResult(key, { status: 'needs_review', reason: `processing failed: ${msg}` });
    store.log('error', 'pipeline', `${key}: ${msg}`);
    return { status: 'needs_review', reason: msg };
  }
}

/** Fill in route lines for hikes saved as points while Overpass was unavailable. */
export async function enrichRoutes(deps: PipelineDeps, max = 5): Promise<number> {
  if (!deps.resolve.routes) return 0;
  let n = 0;
  const pending = deps.store.db.prepare(`SELECT * FROM places WHERE category='hike' AND geometry_json IS NULL AND source LIKE 'OpenStreetMap route %' LIMIT ?`).all(max) as any[];
  for (const p of pending) {
    const target = decodeTarget(p.source);
    if (!target) continue;
    try {
      const upd = await fetchRouteFeature(p, target, p.name, deps.resolve.routes);
      if (upd) { deps.store.upsertPlace(upd); n++; }
    } catch { /* still offline / busy: try next run */ }
  }
  return n;
}

/** Country → city/locality for places that do not have it yet (one reverse lookup each; failures retry next run). */
export async function enrichLocalities(deps: PipelineDeps, max = 20): Promise<number> {
  if (!deps.resolve.locate) return 0;
  let n = 0;
  for (const p of deps.store.placesWithoutLocality(max)) {
    try {
      const g = await deps.resolve.locate(p.lat, p.lon);
      if (!g.country_code) continue; // nothing usable (sea, outage page): try again later
      deps.store.setLocality(p.place_id, g); n++;
    } catch { /* offline / busy: next run */ }
  }
  return n;
}

/** Reels that waited for the AI budget get another chance once a new month (= fresh budget) starts. */
export function requeueAiWaiting(store: Store): number {
  const month = new Date().toISOString().slice(0, 7);
  let n = 0;
  for (const r of store.db.prepare(`SELECT k, v FROM kv WHERE k LIKE 'ai:wait:%'`).all() as any[]) {
    // Values are a month ("2026-11": budget) or a day ("2026-11-10": daily call cap).
    if (String(r.v).length === 10 ? r.v >= new Date().toISOString().slice(0, 10) : r.v >= month) continue;
    const key = String(r.k).slice('ai:wait:'.length);
    store.db.prepare('DELETE FROM kv WHERE k=?').run(r.k);
    if (store.getReel(key)?.status === 'needs_review') { store.requeue(key, 'new month: AI budget available again'); n++; }
  }
  return n;
}

export async function processDue(deps: PipelineDeps): Promise<{ processed: number; byStatus: Record<string, number>; routesEnriched: number; localities: number }> {
  requeueAiWaiting(deps.store);
  const due = deps.store.dueReels();
  const byStatus: Record<string, number> = {};
  for (const r of due) { const o = await processReel(deps, r); byStatus[o.status] = (byStatus[o.status] ?? 0) + 1; }
  const routesEnriched = await enrichRoutes(deps);
  const localities = await enrichLocalities(deps);
  // Google-sourced pins: refresh coordinates by place ID before Google's 30-day caching limit.
  if (deps.refreshGoogle) for (const p of deps.store.googlePlacesToRefresh(25).slice(0, 50)) {
    const loc = await deps.refreshGoogle(p.google_place_id ?? p.place_id.slice('gplace:'.length)).catch(() => null);
    if (loc) deps.store.setPlaceCoords(p.place_id, loc.lat, loc.lon);
  }
  return { processed: due.length, byStatus, routesEnriched, localities };
}
