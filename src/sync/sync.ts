import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db.ts';
import { buildSnapshot, type RemoteFeature } from './kml.ts';

export interface MapSink {
  /** Features currently in the target layer, read from Google (fresh load each call). */
  readRemote(): Promise<{ layerExists: boolean; features: RemoteFeature[] }>;
  /** Make the target layer hold exactly this KML file's features (My Maps: verified layer swap). */
  replaceLayer(kmlFile: string, expectIds: string[]): Promise<void>;
  close?(): Promise<void>;
}

export type SyncOutcome =
  | { status: 'ok'; count: number; hash: string; file: string }
  | { status: 'skipped'; reason: string }
  | { status: 'deferred'; reason: string }
  | { status: 'blocked'; reason: string; file: string }
  | { status: 'failed'; reason: string; file?: string };

const backoffMin = (n: number) => Math.min(240, 5 * 2 ** Math.max(0, n - 1));

/**
 * Push the full local snapshot to the My Maps layer. Safe to retry at any time:
 *  - the snapshot always contains EVERY place (the local DB has no delete path), so "replace all" can only add/update;
 *  - before replacing, the remote layer is read and the sync is BLOCKED if it contains anything the snapshot lacks
 *    (e.g. a feature added by hand, or a local DB restored from an old backup) — nothing is ever removed silently;
 *  - after replacing, the layer is re-read from Google and every snapshot id must be present.
 */
export async function syncToMap(store: Store, sink: MapSink, opts: { layerName: string; outDir: string; force?: boolean; allowRemoval?: boolean; now?: () => number }): Promise<SyncOutcome> {
  const now = opts.now ?? Date.now;
  const snap = buildSnapshot(store, opts.layerName);
  fs.mkdirSync(opts.outDir, { recursive: true });
  const file = path.join(opts.outDir, 'reel-places-latest.kml');
  fs.writeFileSync(file, snap.kml);
  fs.writeFileSync(path.join(opts.outDir, `reel-places-${snap.hash}.kml`), snap.kml);

  const lastOk = store.lastSync('ok');
  if (!opts.force && lastOk?.snapshot_hash === snap.hash) return { status: 'skipped', reason: 'Google layer already matches local data' };
  if (!snap.features.length) return { status: 'skipped', reason: 'nothing to sync yet' };
  const fails = store.consecutiveSyncFailures();
  const last = store.lastSync();
  if (!opts.force && fails > 0 && last?.finished_at && now() - Date.parse(last.finished_at) < backoffMin(fails) * 60_000) {
    return { status: 'deferred', reason: `retrying after ${backoffMin(fails)} min backoff (${fails} consecutive failures)` };
  }

  const id = store.startSync();
  try {
    const before = await sink.readRemote();
    if (!before.layerExists) {
      const reason = `layer "${opts.layerName}" not found in the map. One-time setup: create it and import ${file} into it by hand (docs/legacy-apps-script.md §3).`;
      store.finishSync(id, 'blocked', { hash: snap.hash, count: snap.features.length, detail: reason });
      return { status: 'blocked', reason, file };
    }
    {
      const snapIds = new Set(snap.ids);
      const snapNames = new Set(snap.features.map((f) => f.name));
      const extra = before.features.filter((f) => (f.rmId ? !snapIds.has(f.rmId) : !snapNames.has(f.name)));
      if (extra.length && !opts.allowRemoval) {
        const reason = `refusing to replace layer: it contains ${extra.length} feature(s) not in the local snapshot (${extra.slice(0, 5).map((f) => f.name).join(', ')}). Nothing was changed. Move hand-made features to another layer, or restore the local DB.`;
        store.finishSync(id, 'blocked', { hash: snap.hash, count: snap.features.length, detail: reason });
        return { status: 'blocked', reason, file };
      }
    }
    await sink.replaceLayer(file, snap.ids);
    const after = await sink.readRemote();
    const got = new Set(after.features.map((f) => f.rmId ?? f.name));
    const missing = snap.features.filter((f) => !got.has(f.id) && !got.has(f.name));
    if (!after.layerExists || missing.length) throw new Error(`verification after reload failed: ${missing.length} of ${snap.features.length} feature(s) missing (${missing.slice(0, 3).map((f) => f.name).join(', ')})`);
    const warn = snap.features.length > 1800 ? ' — WARNING: approaching the ~2,000-feature My Maps import limit; plan a second layer' : '';
    store.finishSync(id, 'ok', { hash: snap.hash, count: snap.features.length, detail: `verified ${snap.features.length} features after reload${warn}` });
    return { status: 'ok', count: snap.features.length, hash: snap.hash, file };
  } catch (e) {
    const reason = String((e as Error).message ?? e);
    store.finishSync(id, 'failed', { hash: snap.hash, count: snap.features.length, detail: reason });
    return { status: 'failed', reason, file };
  }
}
