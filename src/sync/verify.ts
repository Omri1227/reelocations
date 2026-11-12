import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../db.ts';
import { buildSnapshot } from './kml.ts';
import { MyMapsBrowserSink } from './mymaps.ts';

/**
 * LIVE proof of the riskiest integration, against a DISPOSABLE My Maps map you created for testing.
 * 1. Builds a fixture snapshot (a known place + a short route) in a throwaway DB.
 * 2. Reads the test layer, replaces it via the My Maps UI, closes the browser.
 * 3. Opens a fresh browser session, downloads the layer's KML from Google, and checks ids, Reel link and date.
 * 4. Repeats the replace (retry safety): the feature count must not change.
 * Writes data/live-verification.json. Never touches your real map.
 */
/** Builds the verification fixture in a throwaway DB and writes data/verify/verify.kml. Needs no Google session. */
export function writeVerifyFixture(opts: { layerName: string; dataDir: string }, runTag = new Date().toISOString().slice(0, 19)) {
  const dir =path.join(opts.dataDir, 'verify'); fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, 'verify.sqlite'); try { fs.rmSync(dbFile); } catch { /* fresh */ }
  const store = new Store(dbFile);
  const sharedAt = '2026-11-09T18:22:00+02:00';
  store.addShare({ intake_id: 'verify-1', reel_key: 'ig:VERIFYTEST1', url: 'https://www.instagram.com/reel/VERIFYTEST1/', shortcode: 'VERIFYTEST1', raw_text: null, input_types: 'fixture', shared_at: sharedAt, note: 'verification fixture' });
  store.upsertPlace({ place_id: 'osm:way:5013364', name: 'Eiffel Tower (reel-maps verification)', category: 'attraction', kind: 'point', lat: 48.85837, lon: 2.294481, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'OpenStreetMap', address: 'Paris', google_place_id: null });
  store.linkReelPlace({ reel_key: 'ig:VERIFYTEST1', place_id: 'osm:way:5013364', cue: 'Your note: "verification fixture — the tower at the end (run '+runTag+')"', cue_source: 'note', role: 'featured', decided_by: 'user' });
  store.upsertPlace({ place_id: 'osm:relation:verify-route', name: 'Seine riverside walk (verification route)', category: 'hike', kind: 'route', lat: 48.8584, lon: 2.2945,
    geometry_json: JSON.stringify([[[2.2945, 48.8584], [2.2990, 48.8610], [2.3030, 48.8625], [2.3080, 48.8640]]]), trailhead_json: JSON.stringify({ lat: 48.8584, lon: 2.2945, source: 'fixture' }), confidence: 'approximate', source: 'fixture', address: null, google_place_id: null });
  store.linkReelPlace({ reel_key: 'ig:VERIFYTEST1', place_id: 'osm:relation:verify-route', cue: 'Caption: "fixture route"', cue_source: 'caption', role: 'featured', decided_by: 'auto' });
  const snap = buildSnapshot(store, opts.layerName);
  const kmlFile = path.join(dir, 'verify.kml'); fs.writeFileSync(kmlFile, snap.kml);
  return { dir, store, snap, kmlFile };
}

export async function verifyGoogle(opts: { mapId: string; layerName: string; profileDir: string; chromePath: string; dataDir: string; assist?: boolean }) {
  const runTag = new Date().toISOString().slice(0, 19);
  const { dir, store, snap, kmlFile } = writeVerifyFixture(opts, runTag);
  const report: any = { at: new Date().toISOString(), mapId: opts.mapId, layer: opts.layerName, expected: snap.ids, steps: [] };
  const step = (name: string, ok: boolean, detail?: unknown) => { report.steps.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); return ok; };

  let sink = new MyMapsBrowserSink({ ...opts, debugDir: path.join(dir, 'screens') });
  try {
    const before = await sink.readRemote();
    step('read test layer via KML export (signed-in session)', true, { layerExists: before.layerExists, features: before.features.length });
    if (!step('test layer exists', before.layerExists, before.layerExists ? undefined : `Create a layer named "${opts.layerName}" in the test map, import ${kmlFile} into it once by hand, then re-run.`)) throw new Error('test layer missing (one-time manual setup)');
    await sink.replaceLayer(kmlFile, snap.ids);
    step('layer swap via My Maps UI (new layer imported + verified, old layer deleted)', true);
    await sink.close();
    sink = new MyMapsBrowserSink({ ...opts, debugDir: path.join(dir, 'screens') }); // fresh browser session = "after reload"
    const after = await sink.readRemote();
    step('exactly one test layer remains', after.layerCount === 1, { layers: after.layerCount });
    const got = new Map(after.features.map((f) => [f.rmId, f]));
    const missing = snap.features.filter((f) => !got.has(f.id));
    step('all features present by id after browser restart', missing.length === 0, { found: after.features.length, missing: missing.map((m) => m.id) });
    const pt = after.features.find((f) => f.rmId === 'rm:osm:way:5013364');
    step('title is the place name (not "Untitled")', pt?.name === snap.features.find((f) => f.id === 'rm:osm:way:5013364')?.name, pt?.name);
    step('category icon kept (attraction = ticket-star 1713)', !!pt?.style?.startsWith('#icon-1713-'), pt?.style);
    step('trailhead icon kept (1597)', !!after.features.find((f) => f.rmId?.endsWith('#trailhead'))?.style?.startsWith('#icon-1597-'));
    step('description keeps line breaks (<br>)', !!pt?.description.includes('<br>'));
    step('description keeps Reel URL', !!pt?.description.includes('https://www.instagram.com/reel/VERIFYTEST1/'));
    step('description keeps share date', !!pt?.description.includes('2026-11-09 18:22'));
    step('Google shows this run\'s version (swap really happened)', !!pt?.description.includes(runTag), runTag);
    step('route imported as a line', after.features.some((f) => f.geometry === 'line'));
    await sink.replaceLayer(kmlFile, snap.ids);
    await sink.close();
    sink = new MyMapsBrowserSink({ ...opts, debugDir: path.join(dir, 'screens') });
    const again = await sink.readRemote();
    step('retrying the same sync does not duplicate or remove features', again.layerCount === 1 && again.features.length === after.features.length, { layers: again.layerCount, before: after.features.length, after: again.features.length });
    report.sampleDescription = pt?.description;
  } catch (e) {
    step('run', false, (e as Error).message);
  } finally {
    await sink.close();
    store.close();
    report.ok = report.steps.every((s: any) => s.ok);
    fs.writeFileSync(path.join(opts.dataDir, 'live-verification.json'), JSON.stringify(report, null, 2));
    console.log(`\nReport: ${path.join(opts.dataDir, 'live-verification.json')}\nNext: open the test map in the Google Maps iPhone app (Saved → Maps) and fill in docs/VERIFICATION.md §iPhone checklist.`);
  }
  return report;
}
