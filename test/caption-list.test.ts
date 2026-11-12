/**
 * Regression: a Reel whose caption lists its places explicitly (a synthetic caption with the same structure as a
 * real one seen on 2026-11-10: a story paragraph, two route names, then six 📍 lines).
 *  REAL     : processReel (pipeline), clue extraction, ranking/decisions, SQLite, the public-page caption step's wiring.
 *  SYNTHETIC: the page reader (returns the saved caption), the geocoder (answers modelled on live Nominatim results of
 *             2026-11-10, incl. the "Felsort" bus stop), the route source (Overpass was at capacity), the OpenAI fallback
 *             (counts calls; must not be called).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.ts';
import { processReel, type PipelineDeps } from '../src/pipeline.ts';
import { hitToCandidate, type NominatimHit } from '../src/geo/osm.ts';
import { parseOgDescription } from '../src/metadata/pagecaption.ts';
import { FIX_DIR } from './support.ts';

const CAPTION = fs.readFileSync(path.join(FIX_DIR, 'captions', 'liechtenstein-list.txt'), 'utf8');
const URL = 'https://www.instagram.com/reel/TESTLIST01/';
const LI_BBOX = ['47.0484', '47.2706', '9.4716', '9.6357'];
let id = 1000;
const hit = (name: string, cls: string, type: string, lat: number, lon: number, display: string, bbox?: string[], addresstype?: string): NominatimHit =>
  ({ place_id: id, osm_type: 'N', osm_id: id++, lat: String(lat), lon: String(lon), category: cls, type, name, display_name: display, boundingbox: bbox ?? [String(lat - 0.002), String(lat + 0.002), String(lon - 0.002), String(lon + 0.002)], addresstype });

/** Answers modelled on live Nominatim results (2026-11-10). */
const DB: Record<string, NominatimHit[]> = {
  liechtenstein: [hit('Liechtenstein', 'boundary', 'administrative', 47.14, 9.55, 'Liechtenstein', LI_BBOX, 'country')],
  alpweg: [hit('Alpweg', 'place', 'hamlet', 47.1135, 9.5672, 'Alpweg, Bergdorf, Oberland, 9497, Liechtenstein', ['47.105', '47.122', '9.558', '9.578'], 'hamlet')],
  gratshütte: [hit('Gratshütte', 'tourism', 'alpine_hut', 47.0846, 9.6112, 'Gratshütte, Bergdorf, Oberland, Liechtenstein')],
  'zwei brüder': [
    hit('Felsloch Zwei Brüder', 'natural', 'arch', 47.2010, 9.5640, 'Felsloch Zwei Brüder, Hangdorf, Oberland, 9498, Liechtenstein'),
    hit('Zwei Brüder', 'natural', 'peak', 47.2152, 9.5765, 'Zwei Brüder, Frastanz, Bezirk Feldkirch, Vorarlberg, 6820, Austria'),
  ],
  felsord: [hit('Felsort', 'highway', 'bus_stop', 47.1226, 9.5506, 'Felsort, Bergstrasse, Bergdorf, Oberland, 9497, Liechtenstein')],
  talbun: [hit('Talbun', 'place', 'village', 47.1022, 9.6098, 'Talbun, Bergdorf, Oberland, 9497, Liechtenstein', ['47.095', '47.109', '9.598', '9.622'], 'village')],
  rheinstadt: [hit('Rheinstadt', 'boundary', 'administrative', 47.1416, 9.5215, 'Rheinstadt, Oberland, 9490, Liechtenstein', ['47.118', '47.176', '9.497', '9.573'], 'town')],
};
const geocoder = { search: async (q: string) => { const k = q.split(',')[0]!.trim().toLowerCase(); return (DB[k] ?? []).map(hitToCandidate); } };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caplist-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  store.addShare({ intake_id: 'i1', reel_key: 'ig:TESTLIST01', url: URL, shortcode: 'TESTLIST01', raw_text: `${URL}?dlrf=ZW52dzl1am1neThu`, input_types: 'URL', shared_at: '2026-11-10T19:00:00+02:00', note: null });
  const calls = { page: 0, ai: 0 };
  const deps: PipelineDeps = {
    store, workDir: dir,
    resolve: { geocoder, routes: { findRoutes: async () => [], routeGeometry: async () => null, waysGeometry: async () => null, trailheadNear: async () => null } as any },
    pageCaption: async () => { calls.page++; return { source: 'page', ok: true, caption: CAPTION, author: 'creator' }; },
    ai: async () => { calls.ai++; return { places: [], usage: { input: 0, output: 0 } }; },
  };
  return { store, deps, calls };
}

test('og:description from the public page → caption + author (suffix " - @user on <date>" removed)', () => {
  const r = parseOgDescription(`${CAPTION.trim()} - @creator on September 29, 2026`);
  assert.equal(r.author, 'creator'); assert.ok(r.caption.endsWith('Backpacking')); assert.match(r.caption, /📍 Rheinstadt/);
});

test('Liechtenstein caption: 6 places + 2 separate routes extracted; confirmed places saved while others wait in review; no AI, no video', async () => {
  const { store, deps, calls } = setup();
  const out = await processReel(deps, store.getReel('ig:TESTLIST01')!);
  const reel = store.getReel('ig:TESTLIST01')!;
  const ev = JSON.parse(reel.evidence_json!);
  const places = ev.clues.filter((c: any) => c.kind === 'place').map((c: any) => c.text);
  const routes = ev.clues.filter((c: any) => c.kind === 'trail').map((c: any) => c.text);
  assert.deepEqual(places, ['Alpweg', 'Gratshütte', 'Zwei Brüder', 'Felsord', 'Talbun', 'Rheinstadt'], 'all six places extracted, in caption order');
  assert.deepEqual(routes.sort(), ['Alpine Ridge Trail', 'Route 66'], 'the two hiking routes are kept separate from the places');
  assert.equal(calls.page, 1, 'caption read once from the public page');
  assert.equal(calls.ai, 0, 'explicit list → no OpenAI call');
  assert.ok(!ev.stages.includes('media') && !ev.stages.includes('openai'), `no video analysis / AI (stages: ${ev.stages})`);
  const saved = (store.linksForReel('ig:TESTLIST01') as any[]).map((l) => `${l.name}|${l.category}|${l.confidence}`);
  assert.deepEqual(saved.sort(), ['Zwei Brüder|mountain|confirmed', 'Talbun|area|confirmed', 'Gratshütte|hotel|confirmed', 'Alpweg|area|confirmed', 'Rheinstadt|area|confirmed'].sort(),
    'one pin per confirmed place (the summit, not the rock arch)');
  assert.equal(out.status, 'needs_review');
  assert.match(reel.status_reason ?? '', /"Felsord": only a public-transport stop matches/, 'the Felsort bus stop is not accepted for Felsord');
  for (const l of store.linksForReel('ig:TESTLIST01') as any[]) assert.equal(store.linksForPlace(l.place_id)[0]!.url, URL, 'each pin keeps the original Reel URL');
  assert.equal(reel.first_shared_at, '2026-11-10T19:00:00+02:00', 'and the share time');
  // Re-processing does not read the page again or duplicate pins.
  store.requeue('ig:TESTLIST01', 'again');
  await processReel(deps, store.getReel('ig:TESTLIST01')!);
  assert.equal(calls.page, 1); assert.equal(store.linksForReel('ig:TESTLIST01').length, 5);
});
