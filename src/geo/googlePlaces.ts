import type { Http } from '../util/http.ts';
import type { Budget } from '../budget.ts';
import type { Candidate, Category } from '../types.ts';

const DAY = 86_400_000;

/**
 * Google Places API (New) — optional, needs GOOGLE_PLACES_API_KEY (Google Cloud project with billing, key restricted to
 * "Places API (New)").
 *
 * Text Search with a Pro field mask (id, displayName, formattedAddress, location, viewport, types). Google's free
 * monthly allowance for Pro SKUs is 5,000 calls (per-SKU free caps since 2025-03-01); this client refuses calls beyond
 * `monthlyCap` (default 4,500), so it costs $0. Results are cached 25 days.
 *
 * Terms (Maps Platform Service Specific Terms): a place ID may be stored indefinitely; latitude/longitude may be cached
 * for at most 30 consecutive days. So a pin placed at a Google location records when its coordinates were fetched and
 * `refreshLocation()` re-fetches them by place ID before 30 days pass (Place Details, Essentials field `location`).
 */
export class GooglePlaces {
  private http: Http; private key: string; private budget: Budget; private monthlyCap: number;
  constructor(http: Http, key: string, budget: Budget, monthlyCap = 4500) { this.http = http; this.key = key; this.budget = budget; this.monthlyCap = monthlyCap; }

  private allow(detail: string) {
    const used = Number((this.budget as any).store.db.prepare(`SELECT COUNT(*) n FROM budget_ledger WHERE provider='google_places' AND month=?`).get(this.budget.month())?.n ?? 0);
    if (used >= this.monthlyCap) return null;
    return this.budget.reserve('google_places', 0, { detail });
  }

  async textSearch(textQuery: string, bias?: { bbox?: [number, number, number, number]; lat?: number; lon?: number; lang?: string }): Promise<Candidate[]> {
    const res = this.allow(textQuery);
    if (!res) return [];
    try {
      const body: any = { textQuery, pageSize: 10, languageCode: bias?.lang ?? 'en' };
      if (bias?.bbox) { const [s, n, w, e] = bias.bbox; body.locationBias = { rectangle: { low: { latitude: s, longitude: w }, high: { latitude: n, longitude: e } } }; }
      else if (bias?.lat != null && bias.lon != null) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lon }, radius: 20000 } };
      const r = await this.http.json<{ places?: GPlace[] }>('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST', body: JSON.stringify(body), retries: 1, cacheTtlMs: 25 * DAY,
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.viewport,places.types' },
      });
      this.budget.settle(res, 0);
      return (r.places ?? []).filter((p) => p.location).map(gplaceToCandidate);
    } catch (e) {
      this.budget.settle(res, 0, String(e));
      return [];
    }
  }

  /** Current location of a Google place (to keep cached coordinates under 30 days old). */
  async refreshLocation(placeId: string): Promise<{ lat: number; lon: number } | null> {
    const res = this.allow(`refresh ${placeId}`);
    if (!res) return null;
    try {
      const r = await this.http.json<GPlace>(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
        retries: 1, headers: { 'X-Goog-Api-Key': this.key, 'X-Goog-FieldMask': 'location' },
      });
      this.budget.settle(res, 0);
      return r.location ? { lat: r.location.latitude, lon: r.location.longitude } : null;
    } catch (e) { this.budget.settle(res, 0, String(e)); return null; }
  }

  /** Legacy helper kept for callers that only want the id. */
  async findPlaceId(textQuery: string, near?: { lat: number; lon: number }): Promise<string | null> {
    const [c] = await this.textSearch(textQuery, near);
    return c?.googlePlaceId ?? null;
  }
}

export interface GPlace {
  id: string; displayName?: { text: string }; formattedAddress?: string; types?: string[];
  location?: { latitude: number; longitude: number }; viewport?: { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } };
}

const AREA_TYPES = /^(locality|sublocality|sublocality_level_\d|neighborhood|administrative_area_level_\d|country|political|colloquial_area|postal_town|archipelago|continent)$/;
const STOP_TYPES = /^(bus_stop|bus_station|transit_station|train_station|subway_station|light_rail_station|tram_stop|ferry_terminal)$/;

export function categoryFromGoogle(types: string[] = []): Category {
  const has = (re: RegExp) => types.some((t) => re.test(t));
  if (has(/^(bakery)$/)) return 'bakery';
  if (has(/^(cafe|coffee_shop)$/)) return 'cafe';
  if (has(/^(bar|pub|wine_bar|night_club)$/)) return 'bar';
  if (has(/restaurant$|^(meal_takeaway|food_court)$/)) return 'restaurant';
  if (has(/^(market|farmers_market|supermarket|grocery_store)$/)) return 'market';
  if (has(/^(shopping_mall|department_store)$/)) return 'mall';
  if (has(/^(clothing_store|shoe_store|jewelry_store)$/)) return 'clothing';
  if (has(/^(lodging|hotel|hostel|motel|resort_hotel|bed_and_breakfast|guest_house|campground|camping_cabin)$/)) return has(/camp/) ? 'camping' : 'hotel';
  if (has(STOP_TYPES) || has(/^(airport)$/)) return 'transport';
  if (has(/^(museum|art_gallery)$/)) return 'museum';
  if (has(/^(church|hindu_temple|mosque|synagogue|place_of_worship|buddhist_temple|shinto_shrine)$/)) return 'temple';
  if (has(/^(historical_landmark|historical_place|monument|castle)$/)) return 'historic';
  if (has(/^(hiking_area)$/)) return 'hike';
  if (has(/^(national_park|nature_preserve|state_park|wildlife_park)$/)) return 'nature_reserve';
  if (has(/^(park|garden|botanical_garden)$/)) return 'park';
  if (has(/^(beach)$/)) return 'beach';
  if (has(/^(observation_deck|scenic_spot)$/)) return 'viewpoint';
  if (has(/^(tourist_attraction|amusement_park|zoo|aquarium)$/)) return 'attraction';
  if (has(/^(store)$/) || has(/_store$/)) return 'shop';
  if (has(/^(mountain_peak|volcano)$/)) return 'mountain';
  if (has(/^(lake)$/)) return 'lake';
  if (has(/^(river)$/)) return 'river';
  if (has(/^(waterfall)$/)) return 'waterfall';
  if (has(/^(natural_feature)$/)) return 'other';
  if (has(AREA_TYPES)) return 'area';
  return 'other';
}

export function gplaceToCandidate(p: GPlace): Candidate {
  const v = p.viewport;
  return {
    ref: `gplace:${p.id}`, name: p.displayName?.text ?? '', displayName: [p.displayName?.text, p.formattedAddress].filter(Boolean).join(', '),
    lat: p.location!.latitude, lon: p.location!.longitude, category: categoryFromGoogle(p.types),
    bbox: v ? [v.low.latitude, v.high.latitude, v.low.longitude, v.high.longitude] : undefined,
    isArea: (p.types ?? []).some((t) => AREA_TYPES.test(t)) && !(p.types ?? []).some((t) => /establishment|point_of_interest/.test(t)),
    isRoute: false, isStop: (p.types ?? []).some((t) => STOP_TYPES.test(t)),
    names: p.displayName?.text ? [p.displayName.text] : [], googlePlaceId: p.id, types: p.types ?? [],
  };
}

export function googleMapsUrl(p: { name: string; lat: number; lon: number; google_place_id?: string | null }): string {
  if (p.google_place_id) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}&query_place_id=${encodeURIComponent(p.google_place_id)}`;
  return `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
}
