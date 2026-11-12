/**
 * Google Places integration (SYNTHETIC Google responses in the documented Places API (New) shape; no key needed).
 * A live run needs GOOGLE_PLACES_API_KEY.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReel } from '../src/resolve/resolver.ts';
import { hitToCandidate, type NominatimHit } from '../src/geo/osm.ts';
import { gplaceToCandidate, googleMapsUrl, categoryFromGoogle, type GPlace } from '../src/geo/googlePlaces.ts';
import { Store } from '../src/db.ts';

const LI: NominatimHit = { place_id: 1, osm_type: 'R', osm_id: 1155955, lat: '47.14', lon: '9.55', category: 'boundary', type: 'administrative', name: 'Liechtenstein', display_name: 'Liechtenstein', boundingbox: ['47.0484', '47.2706', '9.4716', '9.6357'], addresstype: 'country' };
const PFAELZER_OSM: NominatimHit = { place_id: 2, osm_type: 'N', osm_id: 222, lat: '47.0713', lon: '9.6133', category: 'tourism', type: 'alpine_hut', name: 'Gratshütte', display_name: 'Gratshütte, Bergdorf, Liechtenstein' };
const osm: Record<string, NominatimHit[]> = { liechtenstein: [LI], gratshütte: [PFAELZER_OSM], tokyo: [{ place_id: 3, osm_type: 'R', osm_id: 3, lat: '35.68', lon: '139.76', category: 'boundary', type: 'administrative', name: 'Tokyo', display_name: 'Tokyo, Japan', boundingbox: ['35.5', '35.9', '139.5', '139.95'], addresstype: 'state' }] };
const g = (id: string, name: string, lat: number, lon: number, types: string[], addr: string): GPlace => ({ id, displayName: { text: name }, formattedAddress: addr, location: { latitude: lat, longitude: lon }, types });
const google: Record<string, GPlace[]> = {
  felsord: [
    g('ChIJstop', 'Felsort', 47.1226, 9.5506, ['bus_stop', 'transit_station', 'point_of_interest'], 'Bergstrasse, 9497 Bergdorf, Liechtenstein'),
    g('ChIJhamlet', 'Felsort', 47.1240, 9.5520, ['sublocality', 'political'], 'Felsort, 9497 Bergdorf, Liechtenstein'),
  ],
  gratshütte: [g('ChIJpfaelzer', 'Gratshütte', 47.0715, 9.6131, ['lodging', 'point_of_interest'], 'Bettlerjoch, 9497 Bergdorf, Liechtenstein')],
  'shinkai grill ben ginza': [g('ChIJbon', 'Shinkai Grill Ben Ginza', 35.6719, 139.7647, ['restaurant', 'food', 'point_of_interest'], '6-chōme Ginza, Chuo City, Tokyo, Japan')],
};
const calls: string[] = [];
const deps = {
  geocoder: { search: async (q: string) => (osm[q.split(',')[0]!.trim().toLowerCase()] ?? []).map(hitToCandidate) },
  google: async (q: string) => { calls.push(q); return (google[q.split(',')[0]!.trim().toLowerCase()] ?? []).map(gplaceToCandidate); },
} as any;

test('Google: "Felsord" is not pinned to the Felsort bus stop or the similar-named neighbourhood — both offered in review', async () => {
  const r = await resolveReel([{ source: 'caption', text: 'Hiking in Liechtenstein\n📍 Felsord\n📍 Gratshütte' }], deps);
  assert.ok(!r.links.some((l) => /Felsort/.test(l.place.name)), 'a similar name alone does not pin a station or area');
  assert.match(r.reason, /"Felsord"/);
  assert.ok(r.reviewCandidates.some((c) => c.ref === 'gplace:ChIJhamlet'), 'the neighbourhood is shown as an option in review');
  // Gratshütte: OSM + Google agree (≤300 m) → the pin takes the Google listing's place ID and location (dated for the 30-day refresh).
  const pf = r.links.find((l) => l.place.name === 'Gratshütte')!;
  assert.equal(pf.place.place_id, 'osm:node:222'); assert.equal(pf.place.google_place_id, 'ChIJpfaelzer');
  assert.match(googleMapsUrl(pf.place), /query_place_id=ChIJpfaelzer/);
  assert.equal(pf.place.lat, 47.0715); assert.equal(pf.place.lon, 9.6131); assert.ok(pf.place.coords_fetched_at);
  assert.ok(calls.some((q) => /^Felsord, Liechtenstein$/.test(q)), `Google searched with the area: ${calls.join(' | ')}`);
});

test('Google: a place only Google knows is pinned at Google\'s location with its place ID; coordinates carry a fetch date (≤30-day rule)', async () => {
  const r = await resolveReel([{ source: 'caption', text: 'Wagyu in Tokyo\n📍 Shinkai Grill Ben Ginza, Tokyo' }], deps);
  const l = r.links.find((x) => /Shinkai/.test(x.place.name))!;
  assert.ok(l, r.reason);
  assert.equal(l.place.place_id, 'gplace:ChIJbon'); assert.equal(l.place.source, 'Google Maps'); assert.equal(l.place.category, 'restaurant');
  assert.equal(l.place.confidence, 'confirmed'); assert.ok(l.place.coords_fetched_at);
  const s = new Store(':memory:'); s.upsertPlace(l.place);
  assert.equal(s.googlePlacesToRefresh(25).length, 0, 'fresh');
  s.db.prepare("UPDATE places SET coords_fetched_at='2026-01-01T00:00:00Z'").run();
  assert.equal(s.googlePlacesToRefresh(25).length, 1, 'due for refresh before 30 days');
  s.setPlaceCoords('gplace:ChIJbon', 35.672, 139.765);
  assert.equal(s.googlePlacesToRefresh(25).length, 0);
});

test('Google types map to the taxonomy; stations and areas are flagged', () => {
  assert.equal(categoryFromGoogle(['cafe', 'food']), 'cafe'); assert.equal(categoryFromGoogle(['clothing_store', 'store']), 'clothing');
  assert.equal(categoryFromGoogle(['hiking_area']), 'hike'); assert.equal(categoryFromGoogle(['shopping_mall']), 'mall');
  const stop = gplaceToCandidate(google.felsord![0]!); assert.equal(stop.isStop, true); assert.equal(stop.category, 'transport');
  const area = gplaceToCandidate(google.felsord![1]!); assert.equal(area.isArea, true);
});
