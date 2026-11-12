export type Category =
  | 'waterfall' | 'river' | 'lake' | 'beach' | 'hot_spring' | 'viewpoint' | 'mountain' | 'cave' | 'hike' | 'park' | 'nature_reserve' | 'camping'
  | 'architecture' | 'ruins' | 'historic' | 'museum' | 'temple' | 'attraction'
  | 'cafe' | 'bakery' | 'restaurant' | 'bar' | 'market' | 'mall' | 'clothing' | 'shop' | 'hotel' | 'transport'
  | 'area' | 'other';

export type SourceKind = 'geotag' | 'note' | 'caption' | 'ocr' | 'transcript' | 'vision' | 'ai' | 'manual';

/** Lifecycle of one Reel. Nothing is ever deleted. */
export type ReelStatus =
  | 'queued'        // waiting for (re)processing
  | 'resolved'      // every location clue resolved (confirmed or explicitly-approximate)
  | 'needs_review'  // something needs a human: no clue, ambiguous candidates, or partially resolved
  | 'not_a_place'   // user said there is nothing to map; kept with link + date
  | 'error';        // repeated technical failure; retried with backoff

export type Confidence = 'confirmed' | 'approximate';

export interface Capabilities {
  url: 'ok' | 'missing' | 'not_instagram';
  caption: 'ok' | 'unavailable' | 'skipped';
  geotag: 'ok' | 'unavailable';
  video: 'attached' | 'unavailable';
  audio: 'transcribed' | 'no_speech' | 'unavailable' | 'skipped';
  images: 'attached' | 'unavailable';
  notes: string[];
}

export interface TextEvidence { source: SourceKind; text: string; ref?: string }

export interface Clue {
  kind: 'place' | 'area' | 'trail' | 'address';
  text: string;
  area?: string;
  categoryHint?: Category;
  sources: SourceKind[];
  explicit: boolean;
  role: 'featured' | 'vantage' | 'listed';
  evidence: string;
  /** Set for clues suggested by the OpenAI fallback: its own confidence, and where in the video it saw the place. */
  aiConfidence?: 'high' | 'medium' | 'low';
  aiCountry?: string;
  /** Other names to search and compare (e.g. the local-script name from the AI fallback). */
  aliases?: string[];
  timestamps?: number[];
}

export interface Candidate {
  ref: string;            // stable id, e.g. osm:relation:123, gplace:..., approx:...
  name: string;
  displayName: string;
  lat: number;
  lon: number;
  category: Category;
  osmType?: 'node' | 'way' | 'relation';
  osmId?: number;
  bbox?: [number, number, number, number]; // south, north, west, east
  isArea: boolean;
  isRoute: boolean;
  /** A public-transport stop (bus stop, platform, tram stop): never auto-confirmed for a place clue. */
  isStop?: boolean;
  /** Google place ID when Google Places found this place (or confirmed an OSM result at the same spot). */
  googlePlaceId?: string;
  importance?: number;
  names: string[];
  score?: number;
  scoreParts?: Record<string, number>;
  clueText?: string;
  /** Google Places types of the listing (e.g. yakiniku_restaurant), used for the restaurant subtype. */
  types?: string[];
  /** A Google listing offered in review for an EXISTING pin: choosing it updates that pin instead of adding one. */
  replacesPlaceId?: string;
  /** An alternative to an APPROXIMATE pin saved for the same clue: choosing it replaces that pin. */
  replacesApproxPlaceId?: string;
  /** The approximate pin itself, offered for confirmation: choosing it marks the pin confirmed. */
  confirmsApproxPlaceId?: string;
}

export interface PlaceRow {
  place_id: string;
  name: string;
  category: Category;
  kind: 'point' | 'route';
  lat: number;
  lon: number;
  geometry_json: string | null;   // [[lon,lat],...][] (multi line)
  trailhead_json: string | null;  // {lat,lon,source}
  confidence: Confidence;
  source: string;
  address: string | null;
  google_place_id: string | null;
  /** When Google-sourced coordinates were fetched (Google allows caching them ≤30 days). */
  coords_fetched_at?: string | null;
  /** Restaurant subtype (see cuisine.ts), where it came from (google | name | reel | user), and the listing's types. */
  cuisine?: string | null;
  cuisine_source?: string | null;
  google_types?: string | null;
  /** Geographic grouping (English names from OSM): country → locality (city/town, or region for rural places). */
  country?: string | null;
  country_code?: string | null;
  locality?: string | null;
  region?: string | null;
  created_at: string;
  updated_at: string;
}
