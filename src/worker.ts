import fs from 'node:fs';
import path from 'node:path';
import type { App } from './app.ts';
import { downloadPendingMedia, pullInbox, pushStatus, publishImages } from './intake/inbox.ts';
import { downscale } from './media/ffmpeg.ts';
import { processDue } from './pipeline.ts';
import { applyReviewDecisions } from './review/apply.ts';
import { syncToMap, type MapSink, type SyncOutcome } from './sync/sync.ts';
import { syncGrouped, type MultiMapSink } from './sync/grouped.ts';
import { buildSnapshot } from './sync/kml.ts';
import { isOffline } from './util/http.ts';

export interface RunReport {
  pull: string; media: string; process: string; status: string; sync: string;
  syncOutcome?: SyncOutcome;
}

/**
 * One worker cycle (what the scheduled task runs). Each step is isolated: if the desktop is offline, shares stay in the
 * Google Sheet queue, Reels keep their status with backoff, and the sync is retried later. Nothing is lost or removed.
 */
export async function runOnce(app: App, opts: { sink?: MapSink | MultiMapSink | null; grouped?: { mode: 'real' | 'test'; titlePrefix: string; layout?: 'one-map' | 'per-country'; mapTitle?: string }; force?: boolean; allowRemoval?: boolean; skipSync?: boolean; now?: () => number; log?: (m: string) => void } = {}): Promise<RunReport> {
  const rep: RunReport = { pull: 'skipped', media: 'skipped', process: '', status: 'skipped', sync: 'skipped' };
  if (app.inbox) {
    try { const p = await pullInbox(app.store, app.inbox); rep.pull = `ok: ${p.pulled} item(s) ${JSON.stringify(p.actions)}`; }
    catch (e) { rep.pull = `deferred (${isOffline(e) ? 'offline' : (e as Error).message}) — items stay queued in the Google Sheet`; }
    try { const n = await downloadPendingMedia(app.store, app.inbox, path.join(app.cfg.dataDir, 'media')); rep.media = `ok: ${n} downloaded`; }
    catch (e) { rep.media = `deferred (${(e as Error).message})`; }
  }
  const decided = await applyReviewDecisions(app.store, app.resolve, opts.log);
  const r = await processDue(app.pipeline);
  rep.process = `${decided ? `${decided} phone decision(s) applied; ` : ''}${r.processed} processed ${JSON.stringify(r.byStatus)}${r.routesEnriched ? `, ${r.routesEnriched} route(s) enriched` : ''}${r.localities ? `, ${r.localities} place(s) given country/city` : ''}`;
  if (app.inbox) {
    // Pin photos first, so the phone page and this run's map update already include them.
    try {
      const imgs = await publishImages(app.store, app.inbox, path.join(app.cfg.dataDir, 'work', 'pins'), downscale);
      if (imgs) { rep.media += `; ${imgs} pin photo(s) shared`; app.store.db.prepare("DELETE FROM kv WHERE k='status_pushed_at'").run(); }
    } catch { /* retried next run */ }
    try { rep.status = `ok: ${await pushStatus(app.store, app.inbox)} pushed`; }
    catch (e) { rep.status = `deferred (${(e as Error).message})`; }
  }
  if (!opts.skipSync) {
    if (opts.sink && opts.grouped) {
      const out = await syncGrouped(app.store, opts.sink as MultiMapSink, { ...opts.grouped, outDir: path.join(app.cfg.dataDir, 'sync'), autoCreate: true, force: opts.force, allowRemoval: opts.allowRemoval, log: opts.log });
      rep.syncOutcome = out;
      rep.sync = `${out.status}${'reason' in out ? `: ${out.reason}` : `: ${out.count} item(s) verified in ${out.maps?.length ?? 0} country map(s)${out.waiting ? ` (${out.waiting} waiting for country/city)` : ''}`}`;
    } else if (opts.sink) {
      const out = await syncToMap(app.store, opts.sink as MapSink, { layerName: app.cfg.mymapsLayerName, outDir: path.join(app.cfg.dataDir, 'sync'), force: opts.force, allowRemoval: opts.allowRemoval, now: opts.now });
      rep.syncOutcome = out;
      rep.sync = `${out.status}${'reason' in out ? `: ${out.reason}` : `: ${out.count} features verified`}`;
    } else {
      const snap = buildSnapshot(app.store, app.cfg.mymapsLayerName);
      const f = path.join(app.cfg.dataDir, 'sync', 'reel-places-latest.kml');
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, snap.kml);
      rep.sync = `no map configured: wrote ${snap.features.length} features to ${f}`;
    }
  }
  return rep;
}
