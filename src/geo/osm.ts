import type { Http } from '../util/http.ts';
import { HttpError } from '../util/http.ts';
import type { Candidate } from '../types.ts';
import { categoryFromOsm, isAreaResult } from '../categories.ts';
import { mergeLines, type LonLat } from './geometry.ts';

const DAY = 86_400_000;

export interface NominatimHit {
  place_id: number; osm_type: string; osm_id: number; lat: string; lon: string; category?: string; class?: string; type: string;
  addresstype?: string; name?: string; display_name: string; importance?: number; boundingbox?: string[];
  namedetails?: Record<string, string>; extratags?: Record<string, string>;
}

export function hitToCandidate(h: NominatimHit): Candidate {
  const cls = h.category ?? h.class;
  const osmType = (h.osm_type === 'N' ? 'node' : h.osm_type === 'W' ? 'way' : h.osm_type === 'R' ? 'relation' : h.osm_type) as Candidate['osmType'];
  const names = new Set<string>();
  if (h.name) names.add(h.name);
  for (const [k, v] of Object.entries(h.namedetails ?? {})) if (/^(name|name:[a-z]{2}|alt_name|official_name|short_name|int_name|old_name)/.test(k)) names.add(v);
  const bb = h.boundingbox?.map(Number);
  const isRoute = cls === 'route' || /hiking|foot|walking/.test(h.extratags?.route ?? '');
  return {
    ref: `osm:${osmType}:${h.osm_id}`,
    name: h.namedetails?.['name:en'] ?? h.name ?? h.display_name.split(',')[0],
    displayName: h.display_name,
    lat: Number(h.lat), lon: Number(h.lon),
    category: categoryFromOsm(cls, h.type, h.extratags, h.namedetails?.['name:en'] ?? h.name ?? h.display_name.split(',')[0]),
    osmType, osmId: h.osm_id,
    bbox: bb && bb.length === 4 ? [bb[0], bb[1], bb[2], bb[3]] : undefined,
    isArea: isAreaResult(cls, h.type, h.addresstype),
    isRoute,
    isStop: (cls === 'highway' && h.type === 'bus_stop') || cls === 'public_transport' || (cls === 'railway' && /^(halt|tram_stop|platform|stop)$/.test(h.type)) || (cls === 'amenity' && h.type === 'bus_station'),
    importance: h.importance,
    names: [...names],
  };
}

/** OSM Nominatim (public instance: ≤1 req/s, identifying UA, results cached 30 days). ODbL data may be stored with attribution. */
export class Nominatim {
  private http: Http; private baseUrl: string;
  constructor(http: Http, baseUrl: string) { this.http = http; this.baseUrl = baseUrl; }
  async search(q: string, opts: { limit?: number; viewbox?: [number, number, number, number]; bounded?: boolean } = {}): Promise<Candidate[]> {
    const p = new URLSearchParams({ q, format: 'jsonv2', limit: String(opts.limit ?? 6), extratags: '1', namedetails: '1', 'accept-language': 'en' });
    if (opts.viewbox) { const [s, n, w, e] = opts.viewbox; p.set('viewbox', `${w},${n},${e},${s}`); if (opts.bounded) p.set('bounded', '1'); }
    const hits = await this.http.json<NominatimHit[]>(`${this.baseUrl}/search?${p}`, { cacheTtlMs: 30 * DAY });
    return hits.map(hitToCandidate);
  }
}

export interface RouteGeometry { lines: LonLat[][]; name?: string; tags: Record<string, string> }

/** Overpass API with mirror fallback (public servers are often at capacity). */
export class Overpass {
  private http: Http; private urls: string[];
  constructor(http: Http, urls: string[]) { this.http = http; this.urls = urls; }
  async query<T = any>(q: string): Promise<T> {
    let last: unknown;
    for (const url of this.urls) {
      try {
        return await this.http.json<T>(url, {
          method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          cacheTtlMs: 30 * DAY, retries: 1, timeoutMs: 45_000,
        });
      } catch (e) { last = e; if (e instanceof HttpError && e.status < 429 && e.status !== 408) throw e; }
    }
    throw last;
  }

  async routeGeometry(type: 'relation' | 'way', id: number): Promise<RouteGeometry | null> {
    const r = await this.query<{ elements: any[] }>(`[out:json][timeout:50];${type}(${id});out geom;`);
    const el = r.elements?.[0];
    if (!el) return null;
    const segs: LonLat[][] = [];
    if (el.type === 'way' && el.geometry) segs.push(el.geometry.map((g: any) => [g.lon, g.lat]));
    for (const m of el.members ?? []) if (m.type === 'way' && m.geometry && !/^(stop|platform|guidepost)$/.test(m.role ?? '')) segs.push(m.geometry.map((g: any) => [g.lon, g.lat]));
    if (!segs.length) return null;
    return { lines: mergeLines(segs), name: el.tags?.name, tags: el.tags ?? {} };
  }

  async waysGeometry(ids: number[]): Promise<RouteGeometry | null> {
    if (!ids.length) return null;
    const r = await this.query<{ elements: any[] }>(`[out:json][timeout:50];way(id:${ids.slice(0, 60).join(',')});out geom;`);
    const segs: LonLat[][] = (r.elements ?? []).filter((e) => e.geometry).map((e) => e.geometry.map((g: any) => [g.lon, g.lat]));
    if (!segs.length) return null;
    const tags = r.elements[0].tags ?? {};
    return { lines: mergeLines(segs), name: tags['name:en'] ?? tags.name, tags };
  }

  /** Hiking/foot route relations or named paths whose name resembles `name`, inside a bbox (south,north,west,east). */
  async findRoutes(name: string, bbox: [number, number, number, number]): Promise<{ type: 'relation' | 'way'; id: number; name: string; lat: number; lon: number }[]> {
    const [s, n, w, e] = bbox;
    const words = name.split(/\s+/).filter((x) => x.length >= 3).map((x) => x.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
    if (!words.length) return [];
    const re = words.map((x) => x.replace(/[.*+?^${}()|[\]\\"]/g, '')).join('|');
    const q = `[out:json][timeout:40];(
      relation["route"~"hiking|foot|walking"]["name"~"${re}",i](${s},${w},${n},${e});
      relation["route"~"hiking|foot|walking"]["name:en"~"${re}",i](${s},${w},${n},${e});
      way["highway"~"path|footway|track"]["name"~"${re}",i](${s},${w},${n},${e});
      way["highway"~"path|footway|track"]["name:en"~"${re}",i](${s},${w},${n},${e});
    );out tags center 20;`;
    const r = await this.query<{ elements: any[] }>(q);
    return (r.elements ?? []).map((el) => ({ type: el.type, id: el.id, name: el.tags?.['name:en'] ?? el.tags?.name ?? '', lat: el.center?.lat, lon: el.center?.lon }));
  }

  async trailheadNear(lat: number, lon: number, radiusM = 1500): Promise<{ lat: number; lon: number; name?: string; id: number } | null> {
    const r = await this.query<{ elements: any[] }>(`[out:json][timeout:25];node(around:${radiusM},${lat},${lon})["highway"="trailhead"];out 1;`);
    const el = r.elements?.[0];
    return el ? { lat: el.lat, lon: el.lon, name: el.tags?.name, id: el.id } : null;
  }
}
