import type { Http } from '../util/http.ts';

const DAY = 86_400_000;

export interface Locality { country: string | null; country_code: string | null; locality: string | null; region: string | null }

/**
 * Metros whose OSM "city" level is a ward/district (seen live 2026-11-10: Senso-ji → city "Taito", Shibuya → "Shibuya",
 * both JP-13). Places there are grouped under the metro so "Tokyo" is not split into 23 layers.
 */
const METRO_BY_ISO: Record<string, string> = {
  'JP-13': 'Tokyo', 'KR-11': 'Seoul', 'CN-BJ': 'Beijing', 'CN-SH': 'Shanghai', 'CN-TJ': 'Tianjin', 'CN-CQ': 'Chongqing',
  'MX-CMX': 'Mexico City', 'TW-TPE': 'Taipei', 'VN-HN': 'Hanoi', 'VN-SG': 'Ho Chi Minh City', 'TH-10': 'Bangkok',
};

/** Administrative suffixes trimmed so one place has one readable name ("Galil Elyon Regional Council" → "Galil Elyon"). */
const SUFFIX = /\s+(Regional Council|Local Council|Municipality|Municipal District|Metropolitan Municipality|City Council|District|Prefecture|Province|Region|County|Subdistrict|Township|Town|Department)$/i;
const PREFIX = /^(Provincia de|Province of|Municipio de|Comuna de|Distrito de|City of|Município de|Departamento de|Departamento|Partido de|Cantón)\s+/i;

export function cleanName(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.replace(PREFIX, '').replace(SUFFIX, '').replace(/\s+/g, ' ').trim();
  return t || null;
}

/** Pick the grouping level from a Nominatim address (accept-language=en). Cities > towns > villages > municipality > county/region. */
export function localityFromAddress(a: Record<string, string> | undefined): Locality {
  if (!a) return { country: null, country_code: null, locality: null, region: null };
  const iso = a['ISO3166-2-lvl4'] ?? a['ISO3166-2-lvl3'];
  const region = cleanName(a.state ?? a.province ?? a.region ?? a.state_district ?? a.county);
  const metro = iso ? METRO_BY_ISO[iso] : undefined;
  const local = metro ?? cleanName(a.city ?? a.town ?? a.municipality ?? a.village ?? a.hamlet ?? a.county ?? a.state_district) ?? region;
  return { country: a.country ?? null, country_code: a.country_code ? a.country_code.toLowerCase() : null, locality: local, region };
}

/** Reverse lookup at city level (zoom=10), English names, cached 90 days (≤1 req/s via the shared polite Http). */
export async function lookupLocality(http: Http, baseUrl: string, lat: number, lon: number): Promise<Locality> {
  const p = new URLSearchParams({ lat: lat.toFixed(5), lon: lon.toFixed(5), zoom: '10', format: 'jsonv2', addressdetails: '1', 'accept-language': 'en' });
  const r = await http.json<{ address?: Record<string, string>; error?: string }>(`${baseUrl}/reverse?${p}`, { cacheTtlMs: 90 * DAY });
  return localityFromAddress(r.address);
}
