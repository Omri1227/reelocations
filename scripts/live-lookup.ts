/**
 * LIVE check of the lookup layer against public OpenStreetMap services (Nominatim + Overpass).
 * Usage: node scripts/live-lookup.ts ["custom caption text"]
 * Respects Nominatim's 1 req/s policy and caches responses in data/live-lookup.sqlite.
 */
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { Http } from '../src/util/http.ts';
import { Nominatim, Overpass } from '../src/geo/osm.ts';
import { resolveReel } from '../src/resolve/resolver.ts';

const cfg = loadConfig();
const store = new Store(path.join(cfg.dataDir, 'live-lookup.sqlite'));
const http = new Http({ userAgent: cfg.userAgent, store, minIntervalMs: { 'nominatim.openstreetmap.org': 1100, 'overpass-api.de': 1500, 'overpass.private.coffee': 1500 } });
const deps = { geocoder: new Nominatim(http, cfg.nominatimUrl), routes: new Overpass(http, cfg.overpassUrls) };

const cases = process.argv[2] ? [process.argv[2]] : [
  '📍 Café Xoho, Tel Aviv — best flat white in town',
  'Sunrise hike on the Nahal David trail in Ein Gedi Nature Reserve. The viewpoint above the waterfall at the end is unreal',
  'Golden hour vibes ✨ #nature #israel #sunset',
  '3 hidden gems in Lisbon:\n1. Miradouro da Senhora do Monte – best sunset\n2. Praia da Ursa – wild beach',
  'Weekend in Tel Aviv-Yafo, somewhere by the sea',
];
for (const text of cases) {
  const t0 = Date.now();
  const r = await resolveReel([{ source: 'caption', text }], deps);
  console.log(`\n=== ${JSON.stringify(text.slice(0, 70))}  (${Date.now() - t0} ms)`);
  console.log(`status=${r.status} reason=${r.reason}`);
  for (const l of r.links) {
    const g = l.place.geometry_json ? JSON.parse(l.place.geometry_json) : null;
    console.log(`  ✔ [${l.place.confidence}] ${l.place.category} "${l.place.name}" ${l.place.place_id} @${l.place.lat.toFixed(5)},${l.place.lon.toFixed(5)}${g ? ` route lines=${g.length} pts=${g.flat().length}` : ''}`);
    if (l.place.trailhead_json) console.log(`    trailhead: ${l.place.trailhead_json}`);
    console.log(`    cue: ${l.cue}`);
  }
  for (const c of r.reviewCandidates.slice(0, 4)) console.log(`  ? ${c.score} ${c.category} ${c.displayName.slice(0, 80)} ${JSON.stringify(c.scoreParts)}`);
  for (const n of r.notes) console.log(`  note: ${n}`);
}
store.close();
