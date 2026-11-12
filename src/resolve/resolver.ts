import type { Candidate, Category, Clue, Confidence, PlaceRow, SourceKind, TextEvidence } from '../types.ts';
import { extractClues } from '../extract/clues.ts';
import { isNatureArea } from '../categories.ts';
import type { AiPlace } from '../media/openai.ts';
import { distinctiveTokens, isGenericName, nameSimilarity, norm, tokens, truncate } from '../util/text.ts';
import { bboxDiagonalKm, fitLines, haversineKm, inBbox, type LonLat } from '../geo/geometry.ts';
import type { RouteGeometry } from '../geo/osm.ts';

export interface Geocoder { search(q: string, opts?: { limit?: number }): Promise<Candidate[]> }
export interface RouteSource {
  routeGeometry(type: 'relation' | 'way', id: number): Promise<RouteGeometry | null>;
  waysGeometry(ids: number[]): Promise<RouteGeometry | null>;
  findRoutes(name: string, bbox: [number, number, number, number]): Promise<{ type: 'relation' | 'way'; id: number; name: string; lat: number; lon: number }[]>;
  trailheadNear(lat: number, lon: number, radiusM?: number): Promise<{ lat: number; lon: number; name?: string; id: number } | null>;
}
export interface ResolveDeps {
  geocoder: Geocoder; routes?: RouteSource;
  /** Google Places Text Search (optional; needs GOOGLE_PLACES_API_KEY). */
  google?: (q: string, bias?: { bbox?: [number, number, number, number]; lat?: number; lon?: number; lang?: string }) => Promise<Candidate[]>;
  /** Country → city/locality reverse lookup (OSM). Optional: places without it are grouped as "Unsorted". */
  locate?: (lat: number, lon: number) => Promise<import('../geo/locality.ts').Locality>;
}

export type NewPlace = Omit<PlaceRow, 'created_at' | 'updated_at'>;
export interface ResolvedLink { place: NewPlace; cue: string | null; cueSource: SourceKind | null; role: string; clueText: string; bbox?: [number, number, number, number]; contextOnly?: boolean; clue?: Clue }
export interface Resolution {
  status: 'resolved' | 'needs_review';
  reason: string;
  links: ResolvedLink[];
  reviewCandidates: Candidate[];
  clues: Clue[];
  notes: string[];
  /** Lookups that could not run (service busy/offline). A Reel left unresolved because of these is retried, not parked. */
  deferred: string[];
}

/** Categories that may describe the same real place (a clue's hint vs. what OSM calls it). */
const NATURE: Category[] = ['park', 'nature_reserve', 'hike', 'viewpoint', 'waterfall', 'river', 'lake', 'mountain', 'beach', 'cave', 'hot_spring', 'camping'];
const FOOD: Category[] = ['cafe', 'bakery', 'restaurant', 'bar', 'market'];
const CULTURE: Category[] = ['architecture', 'ruins', 'historic', 'museum', 'temple', 'attraction', 'viewpoint'];
const SHOPS: Category[] = ['mall', 'clothing', 'shop', 'market'];
const COMPAT: Partial<Record<Category, Category[]>> = Object.fromEntries(
  ([...new Set([...NATURE, ...FOOD, ...CULTURE, ...SHOPS])] as Category[]).map((c) => [c, [...new Set([NATURE, FOOD, CULTURE, SHOPS].filter((g) => g.includes(c)).flat())].filter((x) => x !== c)]),
);

/** Same category, or categories that may describe the same real place (restaurant ≈ bar, lake ≈ park, …). */
export function categoriesCompatible(a: Category, b: Category): boolean { return a === b || !!COMPAT[a]?.includes(b); }

/** Region words that OSM display names usually omit ("Catamarca Province" → "Catamarca"). */
const REGION_WORD = /\b(province|region|state|prefecture|oblast|department|departamento|county|district|territory)\b/i;
const coreArea = (a: string) => a.replace(/\b(province|region|state|prefecture|oblast|department|departamento|county|district|territory)\b|\b(of|de|del)\b/gi, ' ').replace(/[,\s]+/g, ' ').trim() || a;

interface Ctx { name: string; bbox?: [number, number, number, number]; lat: number; lon: number }

/** "A (B)" names one place twice ("Mountain Name (Local Name)"): compare and search each name. */
/** Letter-level similarity (1 − Levenshtein/len) for OCR-garbled text: "Samar Pedrg de Atacama" ≈ "San Pedro de Atacama". */
export function letterSimilarity(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length]! / Math.max(x.length, y.length);
}

/** Common spelling alternates for a name that found nothing (bounded; each is one cached search). */
export function spellingVariants(text: string): string[] {
  const out = new Set<string>();
  const sub = (re: RegExp, to: string) => { const v = text.replace(re, to); if (v !== text) out.add(v); };
  sub(/d\b/g, 't'); sub(/t\b/g, 'd');
  sub(/ä/g, 'ae'); sub(/ö/g, 'oe'); sub(/ü/g, 'ue'); sub(/ae/g, 'ä'); sub(/oe/g, 'ö'); sub(/ue/g, 'ü');
  sub(/ß/g, 'ss'); sub(/ss/g, 'ß'); sub(/k/g, 'c'); sub(/c(?!h)/g, 'k'); sub(/y/g, 'i');
  sub(/(\p{L})\1/gu, '$1');
  return [...out];
}

/** All names to search/compare for a clue: "A (B)" variants plus aliases (local-script name). */
export const clueNames = (c: Clue): string[] => [...new Set([...nameVariants(c.text), ...(c.aliases ?? [])])];

export function nameVariants(text: string): string[] {
  const m = text.match(/^(.+?)\s*\((.+?)\)\s*$/);
  const out = m ? [text, m[1]!.trim(), m[2]!.trim()] : [text];
  // "<Highway> near <Pass>" (an AI description): the landmark after "near" is searchable on its own.
  for (const t of [...out]) { const n = t.match(/^(.+?)\s+(?:near|at|by)\s+(.{4,})$/i); if (n) out.push(n[2]!.trim()); }
  return [...new Set(out)];
}

/** Google answers in the clue's own script, so "大船山" can match the listing "大船山" (not only "Mt. Taisen"). */
export function languageFor(text: string, area?: string): string | undefined {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) || (/\p{Script=Han}/u.test(text) && /[都道府県]|japan|日本/i.test(area ?? ''))) return 'ja';
  if (/\p{Script=Han}/u.test(text)) return /[都道府県]/u.test(text) ? 'ja' : 'zh';
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  return undefined;
}

export function scoreCandidate(clue: Clue, c: Candidate, ctx: Ctx[]): Candidate {
  const nameSim = Math.max(0, ...clueNames(clue).flatMap((t) => [c.name, ...c.names].map((n) => nameSimilarity(t, n))));
  let ctxScore = 0.5;
  const insideCtx = (a: Ctx) => (a.bbox ? inBbox(c, a.bbox, 3) : haversineKm(a, c) < 25) || norm(c.displayName).includes(norm(coreArea(a.name)));
  if (clue.area) {
    // The clue states its own area: it is a hard constraint, even if the area itself could not be geocoded.
    const own = ctx.filter((a) => a.name === clue.area);
    ctxScore = (own.length ? own.some(insideCtx) : norm(c.displayName).includes(norm(coreArea(clue.area)))) ? 1 : 0;
  } else if (ctx.length) {
    ctxScore = ctx.some(insideCtx) ? 1 : 0;
  }
  const hint = clue.categoryHint;
  const catScore = !hint ? 0.5 : hint === c.category ? 1 : COMPAT[hint]?.includes(c.category) ? 0.6 : c.category === 'other' ? 0.4 : 0.15;
  const corrob = Math.min(1, (clue.sources.filter((s) => s !== 'vision').length - 1) / 2 + (clue.explicit ? 0.5 : 0));
  const score = 0.55 * nameSim + 0.2 * ctxScore + 0.15 * catScore + 0.1 * corrob;
  return { ...c, score: Math.round(score * 1000) / 1000, scoreParts: { nameSim: +nameSim.toFixed(3), context: ctxScore, category: catScore, corroboration: +corrob.toFixed(2) }, clueText: clue.text };
}

export interface Decision {
  confirmed?: Candidate; ranked: Candidate[]; why: string; /** save, but labelled APPROXIMATE */ approximate?: boolean;
  /** Medium confidence: saved as APPROXIMATE and the Reel stays in the Review Queue with the alternatives (2026-11-12). */
  review?: boolean;
}
/** Two same-named options this close are the same neighbourhood: saving the better one as approximate is still useful. */
const MEDIUM_MAX_KM = 25;

/** The same country under its different spellings (OpenStreetMap writes "United States", a Google address ends ", USA"). */
const COUNTRY_ALIASES = [['united states', 'united states of america', 'usa', 'us'], ['united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales'], ['turkey', 'turkiye'],
  ['czechia', 'czech republic'], ['south korea', 'korea', '대한민국', '한국'], ['japan', '日本'], ['china', '中国', '中國'], ['taiwan', '台灣', '台湾', '臺灣'], ['united arab emirates', 'uae'],
  ['netherlands', 'the netherlands', 'holland'], ['vietnam', 'viet nam'], ['myanmar', 'burma'], ['ivory coast', "cote d'ivoire"], ['russia', 'russian federation']];
export function inCountry(displayName: string, country: string): boolean {
  const d = norm(displayName), c = norm(country);
  const names = COUNTRY_ALIASES.find((g) => g.some((a) => norm(a) === c)) ?? [country];
  return names.some((a) => { const n = norm(a); return n.length <= 3 ? new RegExp(`(^|[^\\p{L}])${n}([^\\p{L}]|$)`, 'u').test(d) : d.includes(n); });
}

export function decide(clue: Clue, rankedIn: Candidate[]): Decision {
  // A feature and the park/reserve named after it ("Skogafoss" waterfall + "Skógafoss" nature reserve, seen live
  // 2026-11-10) are one place, not an ambiguity: prefer the specific feature unless the clue asks for the area.
  let ranked = rankedIn;
  const sameNamedContainer = (spec: Candidate, cont: Candidate) => isNatureArea(cont.category) && !isNatureArea(spec.category) && !spec.isArea
    && nameSimilarity(spec.name, cont.name) >= 0.9 && haversineKm(spec, cont) < 25;
  if (ranked[0] && ranked[1] && !(clue.categoryHint && isNatureArea(clue.categoryHint))) {
    if (sameNamedContainer(ranked[1], ranked[0])) ranked = [ranked[1], ranked[0], ...ranked.slice(2)];
    if (sameNamedContainer(ranked[0], ranked[1])) ranked = [ranked[0], ...ranked.slice(2), ranked[1]];
  }
  const exact = (c: Candidate) => clueNames(clue).some((t) => [c.name, ...c.names].some((n) => norm(n) === norm(t)));
  { const ex = ranked.findIndex(exact); if (ex > 0 && ranked[0] && !exact(ranked[0]) && (ranked[0].score ?? 0) - (ranked[ex]!.score ?? 0) < 0.15) ranked = [ranked[ex]!, ...ranked.filter((_, i) => i !== ex)]; }
  // A place clue whose top hit is the village/district of the same name ("山里郷" the village) while the sight itself is
  // listed with that exact name (a village listed by Google as the sight itself) → the sight, not the district.
  if (ranked[0]?.isArea && clue.kind !== 'area') {
    // Only a listed sight (not the village's bus stop or a shop that shares its name).
    const sight = (c: Candidate) => !!c.googlePlaceId && !c.isStop && [...CULTURE, 'park', 'nature_reserve'].includes(c.category);
    const i = ranked.findIndex((c) => !c.isArea && sight(c) && exact(c) && (c.scoreParts?.context ?? 0) >= (ranked[0]!.scoreParts?.context ?? 0));
    if (i > 0) ranked = [ranked[i]!, ...ranked.filter((_, j) => j !== i)];
  }
  const top = ranked[0];
  // Not a real alternative: the same-named reserve around the chosen feature; the same large natural feature mapped
  // twice (OSM's copy of a mountain range vs Google's, 7 km apart — seen live); a same-name place outside the Reel's area
  // when the top one is inside it ("Moraine Lake" in Michigan for a Banff Reel).
  const bigNature = (c: Candidate) => isNatureArea(c.category) || ['mountain', 'lake', 'river', 'nature_reserve', 'park', 'beach', 'hike', 'area', 'attraction'].includes(c.category);
  // Same feature = the other map's copy of it (one from OSM, one from Google) or one lies inside the other's outline.
  // Two same-named OSM features 5 km apart stay a real question (Israel has several "Nahal David"s).
  const sameFeature = (a: Candidate, b: Candidate) => (bigNature(a) || bigNature(b)) && [a, b].every((c) => bigNature(c) || c.category === 'other') && haversineKm(a, b) < 30
    && (!!a.googlePlaceId !== !!b.googlePlaceId || (!!a.bbox && inBbox(b, a.bbox, 2)) || (!!b.bbox && inBbox(a, b.bbox, 2)))
    && Math.max(...[a.name, ...a.names].flatMap((x) => [b.name, ...b.names].map((y) => nameSimilarity(x, y)))) >= 0.85;
  const outsideWhileTopInside = (c: Candidate) => top?.scoreParts?.context === 1 && c.scoreParts?.context === 0;
  const second = top ? ranked.slice(1).find((c) => !sameNamedContainer(top, c) && !sameNamedContainer(c, top) && !sameFeature(top, c) && !outsideWhileTopInside(c)) : undefined;
  if (!top) return { ranked, why: 'no candidates found' };
  const aiOnly = clue.sources.every((s) => s === 'ai');
  if (aiOnly) {
    // Auto-save an AI suggestion only when OSM verifies it strongly: near-exact name, inside the stated city/country,
    // a specific place (not a whole area), not ambiguous, and the model itself was confident. Otherwise: review.
    if (clue.aiConfidence !== 'high' && clue.aiConfidence !== 'medium') return { ranked, why: `AI suggestion "${clue.text}" with ${clue.aiConfidence ?? 'unknown'} confidence — needs your confirmation` };
    const nameSim = top.scoreParts?.nameSim ?? 0;
    if (nameSim < 0.8) return { ranked, why: `AI suggestion "${clue.text}" only loosely matches "${top.name}" on the map` };
    if (top.scoreParts?.context !== 1) return { ranked, why: `AI suggestion "${clue.text}" could not be placed inside ${clue.area ?? 'a stated city/country'}` };
    if (clue.aiCountry && !inCountry(top.displayName, clue.aiCountry)) return { ranked, why: `AI said ${clue.aiCountry}, but the map match "${top.displayName}" is elsewhere` };
    if (top.isArea) return { ranked, why: `AI suggestion "${clue.text}" is a whole area, not a specific place` };
    if (second && haversineKm(top, second) > 1.5 && (second.scoreParts?.nameSim ?? 0) >= 0.85 && (second.scoreParts?.context ?? 0) === 1) {
      const why = `AI suggestion is ambiguous: "${top.displayName}" vs "${second.displayName}"`;
      return haversineKm(top, second) <= MEDIUM_MAX_KM ? { confirmed: top, ranked, approximate: true, review: true, why } : { ranked, why };
    }
    if (nameSim < 0.9) return { confirmed: top, ranked, approximate: true, review: true, why: `AI suggestion "${clue.text}" only partly matches "${top.name}" on the map` };
    // Medium confidence + strong map verification → saved, but labelled APPROXIMATE (your rule, 2026-11-10).
    return { confirmed: top, ranked, approximate: clue.aiConfidence !== 'high', why: clue.aiConfidence === 'high' ? 'AI suggestion verified against OpenStreetMap' : 'AI suggestion (medium confidence) matches OpenStreetMap — saved as approximate' };
  }
  const visionOnly = clue.sources.every((s) => s === 'vision');
  if (visionOnly) return { ranked, why: 'only suggested by the vision model — needs your confirmation' };
  // Checked first so the reason is clear even when the stop's name differs (a listed "…ord" vs an "…ort" stop).
  // Stations too: "visiting Tokyo" matched Tokyo railway station (seen live) — unless the clue itself is about transport.
  if ((top.isStop || top.category === 'transport') && clue.categoryHint !== 'transport' && !/\b(station|airport|terminal|bus stop|ferry|port)\b|駅/i.test(clue.text)) return { ranked, why: `only a public-transport stop matches ("${top.displayName}") — needs your confirmation` };
  if ((top.scoreParts?.nameSim ?? 0) < 0.8) return { ranked, why: `best name match is weak (${top.name})` };
  if (top.scoreParts?.context === 0) return { ranked, why: `best match "${top.displayName}" is outside the area mentioned in the Reel` };
  if ((top.score ?? 0) < 0.68) {
    const why = `low overall score ${top.score}`;
    // Medium band: right name, inside the Reel's area, a specific place → approximate pin + review.
    return (top.score ?? 0) >= 0.6 && top.scoreParts?.context === 1 && !top.isArea && !top.isStop ? { confirmed: top, ranked, approximate: true, review: true, why } : { ranked, why };
  }
  // A bus/tram stop that merely shares (part of) the name is not the place (a listed name vs a stop with a similar name).
  // An explicitly listed village/town (📍 <village>) is a destination: save it if it is small.
  const smallSettlement = top.isArea && clue.explicit && clue.sources.some((x) => x === 'caption' || x === 'note') && !!top.bbox && bboxDiagonalKm(top.bbox) <= 25;
  if (top.isArea && clue.kind !== 'area' && !smallSettlement) return { ranked, why: `${top.name} is a whole area, not a specific place` };
  const competing = second && !(exact(top) && !exact(second)) ? second : undefined; // "<Peak>" (peak) beats "Felsloch <Peak>"
  if (competing && (top.score! - competing.score!) < 0.1 && haversineKm(top, competing) > 1.5 && (competing.scoreParts?.nameSim ?? 0) >= 0.8) {
    const why = `ambiguous: "${top.displayName}" vs "${competing.displayName}"`;
    // Not for towns/areas: two copies of one village are not two places (and a village is no useful "approximate" pin).
    return haversineKm(top, competing) <= MEDIUM_MAX_KM && !top.isArea && !competing.isArea ? { confirmed: top, ranked, approximate: true, review: true, why } : { ranked, why };
  }
  return { confirmed: top, ranked, why: 'confident match' };
}

/** Memory cue: quoted from the user's note or from the Reel's own text. Never generated. */
export function pickCue(placeName: string, clue: Clue, evidence: TextEvidence[], placeCount: number): { cue: string | null; source: SourceKind | null } {
  const label: Record<string, string> = { note: 'Your note', caption: 'Caption', ocr: 'On-screen text', transcript: 'Said in the Reel', geotag: 'Location tag', ai: 'AI, from what you attached' };
  const notes = evidence.filter((e) => e.source === 'note');
  const nameToks = norm(placeName).split(' ').filter((t) => t.length >= 3);
  const mentions = (t: string) => nameToks.some((tok) => norm(t).includes(tok)) || norm(t).includes(norm(clue.text));
  const note = notes.find((n) => placeCount === 1 || mentions(n.text));
  if (note) return { cue: `${label.note}: "${truncate(note.text.trim(), 180)}"`, source: 'note' };
  const src = clue.sources.find((s) => s !== 'vision' && s !== 'manual');
  // OCR lines end in recognition debris from icons ("…Torres del Ejemplo 4 “+ .."): drop trailing tokens without letters.
  const tidy = (s: string, from: SourceKind | string) => (from === 'ocr' ? s.replace(/(?:\s+[^\p{L}\s]{1,4}|\s+\p{N}{1,2}|\s*\.{2,}|\s+[—–-]+)+\s*$/u, '') : s);
  if (src && clue.evidence && clue.evidence.length >= 8) return { cue: `${label[src] ?? src}: "${truncate(tidy(clue.evidence, src), 180)}"`, source: src };
  for (const e of evidence) {
    if (e.source === 'vision' || e.source === 'note') continue;
    const s = e.text.split(/(?<=[.!?…])\s+|\n+/u).find((x) => mentions(x) && x.length >= 8);
    if (s) return { cue: `${label[e.source] ?? e.source}: "${truncate(s.trim(), 180)}"`, source: e.source };
  }
  return { cue: null, source: null };
}

function bestName(c: Candidate, clueText?: string): string {
  if (!clueText) return c.name;
  const all = [c.name, ...c.names];
  const exact = all.find((n) => norm(n) === norm(clueText)); // the spelling the Reel itself used
  if (exact) return exact;
  return all.reduce((b, n) => (nameSimilarity(clueText, n) > nameSimilarity(clueText, b) + 0.05 ? n : b), c.name);
}

export function toPlace(c: Candidate, confidence: Confidence, categoryOverride?: Category): NewPlace {
  return {
    place_id: c.ref, name: bestName(c, c.clueText), category: categoryOverride ?? c.category, kind: 'point', lat: c.lat, lon: c.lon,
    geometry_json: null, trailhead_json: null, confidence, source: c.ref.startsWith('osm:') ? 'OpenStreetMap' : c.ref.startsWith('gplace:') ? 'Google Maps' : c.ref.split(':')[0],
    address: c.displayName, google_place_id: c.googlePlaceId ?? null, google_types: c.types?.length ? c.types.join(',') : null,
    // Google-only pins: coordinates may be cached ≤30 days → remember when they were fetched (refreshed at 25 days).
    coords_fetched_at: c.googlePlaceId ? new Date().toISOString() : null,
  };
}

export type RouteTarget = { type: 'relation'; id: number } | { type: 'ways'; ids: number[] };
export const encodeTarget = (t: RouteTarget) => (t.type === 'relation' ? `relation:${t.id}` : `ways:${t.ids.join(',')}`);
export function decodeTarget(source: string): RouteTarget | null {
  const m = source.match(/route (relation|ways):([\d,]+)/);
  if (!m) return null;
  return m[1] === 'relation' ? { type: 'relation', id: Number(m[2]) } : { type: 'ways', ids: m[2].split(',').map(Number) };
}

/** Fetch the mapped line + trailhead for a route target. Throws on network failure (caller decides to retry later). */
export async function fetchRouteFeature(place: NewPlace, target: RouteTarget, clueText: string, routes: RouteSource): Promise<NewPlace | null> {
  const geom = target.type === 'relation' ? await routes.routeGeometry('relation', target.id) : await routes.waysGeometry(target.ids);
  if (!geom || !geom.lines.length) return null;
  const lines = fitLines(geom.lines as LonLat[][]);
  const start = lines[0][0];
  let trailhead: any = { lat: start[1], lon: start[0], source: 'start of the mapped OSM route (not a signed trailhead)' };
  const th = await routes.trailheadNear(start[1], start[0]).catch(() => null);
  if (th) trailhead = { lat: th.lat, lon: th.lon, name: th.name, source: `OSM trailhead node ${th.id}` };
  return { ...place, kind: 'route', category: 'hike', geometry_json: JSON.stringify(lines), trailhead_json: JSON.stringify(trailhead), lat: trailhead.lat, lon: trailhead.lon };
}

/** Display name that keeps the words the Reel used when OSM names it differently ("Valley Of David (Nahal David)"). */
export function aliasName(osmName: string, clueText: string): string {
  return norm(osmName) === norm(clueText) || norm(osmName).includes(norm(clueText)) ? osmName : `${osmName} (${clueText})`;
}

/**
 * Upgrade a confirmed hike to a mapped route (+ trailhead) when OSM has geometry. If Overpass is unavailable the place is
 * kept as a point whose source records the route target, and a later run enriches it (see pipeline.enrichRoutes).
 */
export async function attachRoute(place: NewPlace, cand: Candidate, clueText: string, deps: ResolveDeps, notes: string[]): Promise<NewPlace> {
  if (!deps.routes) return place;
  let target: RouteTarget | null = null;
  let name = place.name;
  try {
    if (cand.isRoute && (cand as any).wayIds) target = { type: 'ways', ids: (cand as any).wayIds };
    else if (cand.isRoute && cand.osmType === 'relation' && cand.osmId) target = { type: 'relation', id: cand.osmId };
    else if (cand.isRoute && cand.osmType === 'way' && cand.osmId) target = { type: 'ways', ids: [cand.osmId] };
    else {
      const bbox: [number, number, number, number] = cand.bbox && bboxDiagonalKm(cand.bbox) < 60 ? cand.bbox
        : [cand.lat - 0.05, cand.lat + 0.05, cand.lon - 0.06, cand.lon + 0.06];
      const found = (await deps.routes.findRoutes(clueText, bbox))
        .map((r) => ({ ...r, sim: nameSimilarity(clueText, r.name) }))
        .filter((r) => r.sim >= 0.8).sort((a, b) => b.sim - a.sim || (a.type === 'relation' ? -1 : 1));
      if (found[0]?.type === 'relation') target = { type: 'relation', id: found[0].id };
      else if (found[0]) target = { type: 'ways', ids: found.filter((r) => r.type === 'way' && tokens(r.name).join(' ') === tokens(found[0].name).join(' ')).map((r) => r.id).sort((x, y) => x - y) };
      if (found[0]) name = found[0].name;
    }
  } catch (e) {
    notes.push(`Route search failed (${(e as Error).message.slice(0, 100)}); saved as a point.`);
    return place;
  }
  if (!target) { notes.push(`No mapped route found in OpenStreetMap for "${clueText}"; saved as a point.`); return place; }
  const routeId = target.type === 'relation' ? `osm:relation:${target.id}` : `osm:way:${target.ids[0]}`;
  const pending: NewPlace = { ...place, place_id: routeId, name: aliasName(name, clueText), category: 'hike', source: `OpenStreetMap route ${encodeTarget(target)}` };
  try {
    const withGeom = await fetchRouteFeature(pending, target, clueText, deps.routes);
    if (withGeom) return withGeom;
    notes.push(`OpenStreetMap route for "${clueText}" has no geometry; saved as a point.`);
  } catch (e) {
    notes.push(`Route geometry download failed (${(e as Error).message.slice(0, 100)}); saved as a point, the line is added on a later run.`);
  }
  return pending;
}

async function findRouteInContext(clue: Clue, ctx: Ctx[], routes: RouteSource, notes: string[], deferred: string[]): Promise<Candidate | null> {
  const box = [...ctx].reverse().find((a) => a.bbox && bboxDiagonalKm(a.bbox) < 80)?.bbox;
  if (!box) return null;
  try {
    const found = (await routes.findRoutes(clue.text, box)).map((r) => ({ ...r, sim: nameSimilarity(clue.text, r.name) })).filter((r) => r.sim >= 0.8);
    if (!found.length) return null;
    const rel = found.filter((r) => r.type === 'relation').sort((a, b) => b.sim - a.sim)[0];
    if (rel) return { ref: `osm:relation:${rel.id}`, name: rel.name, displayName: `${rel.name} (OSM hiking route)`, lat: rel.lat, lon: rel.lon, category: 'hike', osmType: 'relation', osmId: rel.id, isArea: false, isRoute: true, names: [rel.name] };
    const best = found.sort((a, b) => b.sim - a.sim)[0];
    const ids = found.filter((r) => r.type === 'way' && tokens(r.name).join(' ') === tokens(best.name).join(' ')).map((r) => r.id).sort((a, b) => a - b);
    const c: any = { ref: `osm:way:${ids[0]}`, name: best.name, displayName: `${best.name} (OSM path, ${ids.length} segment(s))`, lat: best.lat, lon: best.lon, category: 'hike', osmType: 'way', osmId: ids[0], isArea: false, isRoute: true, names: [best.name], wayIds: ids };
    return c;
  } catch (e) {
    notes.push(`Route search unavailable (${(e as Error).message.slice(0, 80)}); used the place lookup only.`);
    deferred.push(`route search for "${clue.text}"`);
    return null;
  }
}

/**
 * The Reel names the outlet by its neighbourhood ("HOKKAI SUSHI Umeda"), but the best-scored listing is another branch
 * of the same chain (a sushi chain's branch 6 km away — seen live). When several listings carry the chain's own name
 * far apart, look the trailing neighbourhood word(s) up and prefer the listing inside that neighbourhood.
 */
export async function preferNamedBranch(clue: Clue, ranked: Candidate[], ctx: Ctx[], deps: ResolveDeps): Promise<Candidate[]> {
  const top = ranked[0];
  if (!top || clue.kind === 'area' || clue.kind === 'trail') return ranked;
  const words = clue.text.split(/\s+/);
  if (words.length < 2) return ranked;
  for (const n of [1, 2]) {
    if (words.length <= n) break;
    const hood = words.slice(-n).join(' '), chain = words.slice(0, -n).join(' ');
    const chainD = distinctiveTokens(chain);
    if (!chainD.length || tokens(top.name).includes(norm(hood).split(' ')[0]!)) continue;
    // The chain's own words, or the first two characters of its local name ("北海寿司" ≈ the listing "北海寿し 梅田お初天神店").
    const local = (clue.aliases ?? []).map((a) => a.match(/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2}/u)?.[0]).filter(Boolean) as string[];
    const same = ranked.filter((c) => !c.isArea && (chainD.every((t) => tokens(`${c.name} ${c.names.join(' ')}`).includes(t)) || local.some((l) => c.name.includes(l))));
    if (same.length < 2 || !same.some((c) => haversineKm(c, top) > 1.5)) continue;
    const city = clue.area ?? ctx[0]?.name;
    // A neighbourhood may be mapped as a district or only as a point/station: a point stands for ~1 km around it.
    const hit = (await deps.geocoder.search(city ? `${hood}, ${city}` : hood, { limit: 3 })).find((h) => [h.name, ...h.names].some((n) => nameSimilarity(n, hood) >= 0.8) && (!h.bbox || bboxDiagonalKm(h.bbox) < 8));
    if (!hit) continue;
    const box: [number, number, number, number] = hit.bbox && bboxDiagonalKm(hit.bbox) > 1 ? hit.bbox : [hit.lat - 0.009, hit.lat + 0.009, hit.lon - 0.011, hit.lon + 0.011];
    const area = { bbox: box };
    const inside = same.filter((c) => inBbox(c, area.bbox!, 0.5));
    if (inside.length !== 1 || inside[0] === top) continue;
    const pick = { ...inside[0]!, score: Math.max(inside[0]!.score ?? 0, (top.score ?? 0) + 0.05), scoreParts: { ...(inside[0]!.scoreParts ?? { nameSim: 0, context: 1, category: 0.5, corroboration: 0 }), nameSim: Math.max(0.9, inside[0]!.scoreParts?.nameSim ?? 0), context: 1 } };
    return [pick, ...ranked.filter((c) => c !== inside[0] && !(same.includes(c) && c !== inside[0] && !inBbox(c, area.bbox!, 0.5)))];
  }
  return ranked;
}

/**
 * Resolve the places featured in one Reel from text evidence (note, caption, OCR, transcript, vision suggestions).
 * Confirmation rules are deliberately strict; everything else goes to the review queue with candidates.
 */
export async function resolveReel(evidence: TextEvidence[], deps: ResolveDeps, opts: { maxClues?: number; aiPlaces?: AiPlace[] } = {}): Promise<Resolution> {
  const { clues, reelCategory, isHike } = extractClues(evidence);
  const notes: string[] = [];
  for (const p of opts.aiPlaces ?? []) {
    if (p.role === 'mentioned') { notes.push(`AI: "${p.name}" is only mentioned in passing — not saved.`); continue; }
    const area = p.city ?? p.country ?? undefined;
    // The same place as a text clue: same name, or the AI's local-script name equals the clue ("Mountたい船山" / 大船山).
    const same = clues.find((c) => (norm(c.text) === norm(p.name) || (!!p.local_name && [c.text, ...(c.aliases ?? [])].some((t) => norm(t) === norm(p.local_name!)))) && (!c.area || !area || norm(c.area) === norm(area) || !!p.local_name));
    if (same) { if (!same.sources.includes('ai')) same.sources.push('ai'); same.area ??= area; same.categoryHint ??= p.category; continue; }
    // The AI called a gorge a "cave" (seen live): a cave is only a cave when the name says so.
    if (p.category === 'cave' && !/\b(cave|caves|grotto|cavern|cueva|gruta|grotte|höhle)\b|洞/i.test(`${p.name} ${p.local_name ?? ''}`)) p.category = /\b(gorge|canyon|valley|ravine)\b|峡/i.test(`${p.name} ${p.local_name ?? ''}`) ? 'attraction' : 'other';
    clues.push({ kind: p.category === 'area' ? 'area' : p.category === 'hike' ? 'trail' : 'place', text: p.name, area, categoryHint: p.category, sources: ['ai'], explicit: false,
      role: p.role === 'vantage' ? 'vantage' : 'featured', evidence: p.evidence, aiConfidence: p.confidence, aiCountry: p.country ?? undefined, timestamps: p.timestamps, aliases: p.local_name ? [p.local_name] : undefined });
  }
  const deferred: string[] = [];
  const links: ResolvedLink[] = [];
  const review: Candidate[] = [];
  const unresolvedSignificant: string[] = [];
  /** Medium-confidence pins saved as approximate whose Reel stays in review (why, per clue). */
  const approxReview: string[] = [];
  const medium: { clue: Clue; d: Decision; ranked: Candidate[]; place: NewPlace; cue: { cue: string | null; source: SourceKind | null } }[] = [];
  const unresolvedClues = new Map<string, Clue>();
  const unresolvedRanked = new Map<string, { why: string; ranked: Candidate[] }>();

  // 1) Context areas ("in Lisbon", "📍 X, Tel Aviv") constrain the specific lookups.
  const ctx: Ctx[] = [];
  const areaNames = new Set<string>();
  for (const c of clues) if (c.area) areaNames.add(c.area);
  for (const c of clues) if (c.kind === 'area') areaNames.add(c.text);
  for (const a of [...areaNames].slice(0, 4)) {
    const hits = await deps.geocoder.search(a, { limit: 3 });
    // "Catamarca Province" must not match the city of Catamarca (seen live): compare core names, and for region words
    // prefer the largest matching area.
    const matches = hits.filter((h) => [h.name, ...h.names].some((n) => nameSimilarity(a, n) >= 0.75 || nameSimilarity(coreArea(a), n) >= 0.75));
    const best = REGION_WORD.test(a) ? [...matches].sort((x, y) => (y.bbox ? bboxDiagonalKm(y.bbox) : 0) - (x.bbox ? bboxDiagonalKm(x.bbox) : 0))[0] : matches[0];
    if (best) ctx.push({ name: a, bbox: best.bbox, lat: best.lat, lon: best.lon });
  }

  // 2) Specific places: non-trail first so a resolved park/reserve can give context to a trail.
  // Up to 15 places per Reel (a caption listing 6 places + 2 routes must not lose the routes — seen live).
  // Parks/reserves first (they give context: "Moraine Lake" inside "Banff National Park"), trails last.
  const order = (c: Clue) => (c.kind === 'trail' ? 2 : /\b(national park|nature reserve|national forest|parque nacional|reserva)\b/i.test(c.text) ? 0 : 1);
  const specific = clues.filter((c) => c.kind !== 'area').sort((a, b) => order(a) - order(b)).slice(0, opts.maxClues ?? 15);
  const featuredCount = specific.filter((c) => c.role !== 'vantage').length;
  const vantage: string[] = [];
  // A street address next to a named place says WHERE that place is (a street address for a
  // restaurant used to become a pin for the whole quarter, seen live): context only, never a pin.
  const named = specific.filter((c) => c.kind !== 'address' && !isGenericName(c.text));
  if (named.length) for (const clue of specific.filter((c) => c.kind === 'address')) {
    notes.push(`"${clue.text}" is the street address — used to locate the place, not pinned on its own.`);
  }
  for (const clue of specific) {
    if (clue.kind === 'address' && named.length) continue;
    // "Sushi restaurant" (Instagram's category label in a screenshot) names no particular place: never pin it.
    if (isGenericName(clue.text) && !(clue.aliases ?? []).some((a) => !isGenericName(a))) { notes.push(`"${clue.text}" is a generic description, not a place name — skipped`); continue; }
    // Each name of "A (B)" is searched on its own, with and without the area.
    const queries = [...new Set(clueNames(clue).flatMap((t) => [clue.area ? `${t}, ${clue.area}` : ctx[0] ? `${t}, ${ctx[0].name}` : null, t]))].filter(Boolean) as string[];
    let hits: Candidate[] = [];
    // Search with AND without the area and rank the union: "<Peak>, <Country>" alone only finds a rock
    // arch; the summit itself sits just across the border (seen live). Cached, so repeats cost nothing.
    { const seen = new Set<string>(); for (const q of queries.slice(0, 4)) for (const h of await deps.geocoder.search(q, { limit: 6 })) if (!seen.has(h.ref)) { seen.add(h.ref); hits.push(h); } }
    // Google Places (optional): same scoring and guards as OSM. A Google result within 300 m of an OSM result with a
    // matching name is the same place: the pin takes the Google listing's location and place ID (exact listing; Google
    // coordinates carry a fetch date and are refreshed by place ID before Google's 30-day caching limit).
    if (deps.google) {
      const area = clue.area ?? ctx[0]?.name;
      const box = ctx.find((a) => a.name === clue.area)?.bbox ?? ctx[0]?.bbox;
      const q0 = clueNames(clue)[0]!, lang = languageFor(q0, area);
      for (const g of await deps.google(area ? `${q0}, ${area}` : q0, box || lang ? { ...(box ? { bbox: box } : {}), ...(lang ? { lang } : {}) } : undefined)) {
        const twin = hits.find((h) => !h.googlePlaceId && haversineKm(h, g) < 0.3 && Math.max(nameSimilarity(h.name, g.name), ...h.names.map((n) => nameSimilarity(n, g.name))) >= 0.75);
        // Google's types are usually more specific than OSM's building tags (a temple: OSM architecture, Google buddhist_temple).
        if (twin) { twin.googlePlaceId = g.googlePlaceId; twin.lat = g.lat; twin.lon = g.lon; twin.types = g.types; if (['other', 'architecture', 'attraction', 'area'].includes(twin.category) && !['other', 'area', 'attraction'].includes(g.category)) twin.category = g.category; } else hits.push(g);
      }
    }
    // Nothing at all: try a few alternate spellings ("-ord" → "-ort"). What they find is only ever offered
    // in review as a similar-name option — decide() never confirms on a weak name match.
    if (!hits.length) {
      const area = clue.area ?? ctx[0]?.name;
      for (const v of spellingVariants(clue.text).slice(0, 4)) for (const h of await deps.geocoder.search(area ? `${v}, ${area}` : v, { limit: 3 })) if (!hits.some((x) => x.ref === h.ref)) hits.push(h);
    }
    let ranked = hits.map((h) => scoreCandidate(clue, h, ctx)).sort((a, b) => b.score! - a.score!);
    ranked = await preferNamedBranch(clue, ranked, ctx, deps);
    let d = decide(clue, ranked);
    if (clue.kind === 'trail' && deps.routes && !clue.sources.every((s) => s === 'vision')) { // vision never auto-confirms
      const routeCand = await findRouteInContext(clue, ctx, deps.routes, notes, deferred);
      if (routeCand) d = { confirmed: scoreCandidate(clue, routeCand, ctx), ranked: [routeCand, ...ranked], why: 'named route inside the mentioned area' };
    }
    const significant = (clue.explicit || !!clue.categoryHint || clue.kind === 'trail') && !clue.sources.every((s) => s === 'vision');
    if (clue.role === 'vantage') {
      vantage.push(clue.text);
      if (!d.confirmed) continue;
      notes.push(`Filmed from ${d.confirmed.name} (camera position, not saved as the featured place).`);
      continue;
    }
    // The "place" is really a region or city (on-screen "Golan Heights", "Tokyo" next to a Tokyo restaurant — Tokyo's
    // top match is the station, but the city is among the hits): use it as context, not as an open question.
    const asArea = d.confirmed ? undefined : ranked.find((c) => c.isArea && (c.scoreParts?.nameSim ?? 0) >= 0.8 && !c.googlePlaceId) ?? (ranked[0]?.isArea && (ranked[0].scoreParts?.nameSim ?? 0) >= 0.8 ? ranked[0] : undefined);
    if (asArea && !(clue.explicit && clue.sources.includes('note') && !asArea.bbox)) {
      if (!ctx.some((a) => a.name === clue.text)) ctx.push({ name: clue.text, bbox: asArea.bbox, lat: asArea.lat, lon: asArea.lon });
      continue;
    }
    if (!d.confirmed) {
      // Offer only options inside the Reel's area (Route 66 in the US is no option for a Liechtenstein hiking Reel).
      const inArea = ranked.filter((c) => (c.scoreParts?.context ?? 0.5) > 0);
      if (significant || inArea.length) review.push(...inArea.slice(0, 3));
      if (significant) { unresolvedSignificant.push(`"${clue.text}": ${d.why}`); unresolvedClues.set(clue.text, clue); unresolvedRanked.set(clue.text, { why: d.why, ranked }); }
      continue;
    }
    if (links.some((l) => l.place.place_id === d.confirmed!.ref)) continue;
    const hikey = clue.kind === 'trail' || (isHike && (d.confirmed.category === 'hike' || isNatureArea(d.confirmed.category)) && clue.categoryHint !== 'waterfall' && clue.categoryHint !== 'viewpoint');
    let place = toPlace(d.confirmed, d.approximate ? 'approximate' : 'confirmed', d.confirmed.category === 'other' && clue.categoryHint ? clue.categoryHint : undefined);
    // Keep a readable Latin name when the listing only has the local script and the Reel gave one.
    if (!/\p{Script=Latin}{2}/u.test(place.name)) { const lat = [d.confirmed.name, ...d.confirmed.names, ...(clue.aliases ?? [])].find((n) => /\p{Script=Latin}{3}/u.test(n)); if (lat) place.name = lat; }
    if (hikey && clue.kind === 'trail') place = await attachRoute(place, d.confirmed, clue.text, deps, notes);
    else if (hikey && d.confirmed.isRoute) place = await attachRoute(place, d.confirmed, clue.text, deps, notes);
    const cue = pickCue(place.name, clue, evidence, featuredCount);
    // Medium confidence: decided after every confident match, so it never takes a confident match's place.
    if (d.review) { medium.push({ clue, d, ranked, place, cue }); continue; }
    links.push({ place, cue: cue.cue, cueSource: cue.source, role: clue.role, clueText: clue.text, clue, bbox: d.confirmed.bbox, contextOnly: clue.kind === 'place' && isNatureArea(d.confirmed.category) && isHike });
    if (d.confirmed.bbox && (isNatureArea(d.confirmed.category) || d.confirmed.category === 'area')) ctx.push({ name: d.confirmed.name, bbox: d.confirmed.bbox, lat: d.confirmed.lat, lon: d.confirmed.lon });
    // A national park mapped as a single point still frames the Reel ("Moraine Lake … Banff National Park").
    else if (/\b(national park|parque nacional|nature reserve|national forest)\b/i.test(clue.text) && isNatureArea(d.confirmed.category)) ctx.push({ name: d.confirmed.name, bbox: [d.confirmed.lat - 0.6, d.confirmed.lat + 0.6, d.confirmed.lon - 0.9, d.confirmed.lon + 0.9], lat: d.confirmed.lat, lon: d.confirmed.lon });
  }
  for (let i = links.length - 1; i >= 0; i--) {
    const l = links[i];
    if (l.contextOnly && l.bbox && links.some((o) => o !== l && o.place.category === 'hike' && inBbox(o.place, l.bbox!, 2))) {
      notes.push(`"${l.place.name}" used as the area containing the trail, not saved as a separate place.`);
      links.splice(i, 1);
    }
  }
  // Cues are picked per place; once duplicates/containers are dropped, a single remaining place may use your note.
  if (links.length === 1 && links[0]!.clue && links[0]!.cueSource !== 'note') {
    const c = pickCue(links[0]!.place.name, links[0]!.clue, evidence, 1);
    if (c.source === 'note') { links[0]!.cue = c.cue; links[0]!.cueSource = c.source; }
  }
  if (vantage.length && links.length) for (const l of links) if (l.role !== 'vantage') l.cue = l.cue ? `${l.cue} (filmed from ${vantage[0]})` : `Filmed from ${vantage[0]}`;

  // 2a) A street address the AI read from the caption ("2-9-5 Azabujuban, Minato-ku, Tokyo"): pin the address itself.
  for (const p of opts.aiPlaces ?? []) {
    if (p.role !== 'featured' || !p.address || p.confidence === 'low') continue;
    if (links.some((l) => l.clueText === p.name || nameSimilarity(l.place.name, p.name) >= 0.85)) continue;
    const hits = await deps.geocoder.search(p.city && !norm(p.address).includes(norm(coreArea(p.city.split(',').pop()!.trim()))) ? `${p.address}, ${p.city}` : p.address, { limit: 3 });
    const h = hits.find((x) => !x.isArea && (!p.country || inCountry(x.displayName, p.country)));
    if (!h) { notes.push(`Address "${p.address}" for "${p.name}" not found on the map.`); continue; }
    const exactAddress = /\b(house|building|residential|commercial|retail)\b/.test(h.category) || /^\d/.test(h.displayName) || h.category === 'other';
    links.push({
      place: { place_id: `addr:${h.ref}`, name: p.name, category: p.category, kind: 'point', lat: h.lat, lon: h.lon, geometry_json: null, trailhead_json: null,
        confidence: exactAddress && p.confidence === 'high' ? 'confirmed' : 'approximate', source: `Address from the Reel, located with OpenStreetMap (${h.displayName.split(',').slice(0, 3).join(',')})`, address: p.address, google_place_id: null },
      cue: `Address in the Reel: ${truncate(p.address, 120)}`, cueSource: 'ai', role: 'featured', clueText: p.name,
    });
    for (let i = unresolvedSignificant.length - 1; i >= 0; i--) if (unresolvedSignificant[i]!.startsWith(`"${p.name}"`)) unresolvedSignificant.splice(i, 1);
  }

  // 2b) OpenAI's own location estimate for featured places nothing could verify (approved by you, 2026-11-10):
  //     an approximate pin, clearly labelled, only if the estimate is reasonably tight and inside the known region.
  for (const p of opts.aiPlaces ?? []) {
    // Region-only Reels: you asked for OpenAI's estimate on the map rather than nothing (2026-11-10) — up to ±100 km,
    // any confidence, always labelled APPROXIMATE with the radius (and "rough guess" when the model was unsure).
    if (p.role !== 'featured' || p.lat == null || p.lon == null || (p.radius_km ?? 999) > 100) continue;
    // Not when the same place was already found on the map (e.g. a valley from OSM + its AI estimate).
    if (links.some((l) => l.clueText === p.name || nameSimilarity(l.place.name, p.name) >= 0.85 || haversineKm(l.place, { lat: p.lat!, lon: p.lon! }) < 1 || (!!p.local_name && [l.clueText, l.place.name, ...(l.clue?.aliases ?? [])].some((t) => norm(t) === norm(p.local_name!))))) continue;
    // The estimate must lie in the country the AI itself named (a mountain-pass estimate landed 100 km inside the neighbouring country — seen live).
    if (p.country && deps.locate) {
      const at = await deps.locate(p.lat, p.lon).catch(() => null);
      if (at?.country && !inCountry(at.country, p.country) && !inCountry(p.country, at.country)) { notes.push(`AI estimate for "${p.name}" lies in ${at.country}, not ${p.country} — ignored.`); continue; }
    }
    // Check against the AI's own city/country (hashtags like "#TokyoFood" were geocoded to tiny unrelated places — seen live).
    const own = [p.city, p.city?.split(',').pop(), p.country].filter(Boolean).map((x) => norm(coreArea(x!.trim())));
    const region = ctx.filter((a) => a.bbox && own.includes(norm(coreArea(a.name)))).sort((x, y) => bboxDiagonalKm(x.bbox!) - bboxDiagonalKm(y.bbox!))[0];
    // Strictly inside the named region/country (a 10 km margin let a Pamir estimate land in China — seen live).
    if (region && !inBbox({ lat: p.lat, lon: p.lon }, region.bbox!, 0)) { notes.push(`AI estimate for "${p.name}" lies outside ${region.name} — ignored.`); continue; }
    const id = `aiest:${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
    links.push({
      place: { place_id: id, name: p.name, category: p.category, kind: 'point', lat: p.lat, lon: p.lon, geometry_json: null, trailhead_json: null, confidence: 'approximate',
        source: `OpenAI estimate from the picture (±${Math.round(p.radius_km ?? 0)} km, unverified)`, address: null, google_place_id: null },
      cue: `AI estimate from the picture (±${Math.round(p.radius_km ?? 0)} km${p.confidence === 'low' ? ', rough guess' : ''}): "${truncate(p.evidence, 160)}"`, cueSource: 'ai', role: 'featured', clueText: p.name,
    });
    for (let i = unresolvedSignificant.length - 1; i >= 0; i--) if (unresolvedSignificant[i]!.startsWith(`"${p.name}"`)) unresolvedSignificant.splice(i, 1);
    notes.push(`"${p.name}": no verifiable map match — saved at OpenAI's estimate (±${Math.round(p.radius_km ?? 0)} km), labelled APPROXIMATE.`);
  }

  // 2c) Medium-confidence matches (2026-11-12): saved as APPROXIMATE, and the Reel stays in the Review Queue with the
  //     pin itself (to confirm) and the alternatives inside the Reel's area (to replace it). Not when it is a copy of a
  //     place already found ("X" next to "X Waterfall").
  for (const m of medium) {
    const found = links.flatMap((l) => [l.place.name, l.clueText ?? '']).filter((n) => n.length >= 3);
    // Distance alone is no copy: neighbouring restaurants can be 30 m apart (two famous Bangkok shops are).
    const copy = links.some((l) => l.place.place_id === m.place.place_id || (haversineKm(l.place, m.place) < 0.3 && nameSimilarity(l.place.name, m.place.name) >= 0.5))
      || found.some((n) => nameSimilarity(m.clue.text, n) >= 0.6 || norm(n).includes(norm(m.clue.text)) || norm(m.clue.text).includes(norm(n)));
    if (copy) { notes.push(`"${m.clue.text}" matches a place already found — not saved separately.`); continue; }
    const top = m.d.confirmed!;
    const alts = m.ranked.filter((c) => c.ref !== top.ref && (c.scoreParts?.context ?? 0.5) > 0).slice(0, 3).map((c) => ({ ...c, clueText: m.clue.text, replacesApproxPlaceId: top.ref }));
    review.push({ ...top, clueText: m.clue.text, confirmsApproxPlaceId: top.ref, ref: `confirm:${top.ref}` }, ...alts);
    approxReview.push(`"${m.clue.text}": ${m.d.why}`);
    links.push({ place: { ...m.place, confidence: 'approximate', source: `${m.place.source} · approximate: ${m.d.why}` }, cue: m.cue.cue, cueSource: m.cue.source, role: m.clue.role, clueText: m.clue.text, clue: m.clue });
  }

  // 3) Only a general area is known → approximate pin, clearly labelled.
  if (!links.length && !unresolvedSignificant.length && ctx.length) {
    // The most specific region we know ("Ladakh" rather than "India").
    const a = [...ctx].sort((x, y) => (x.bbox ? bboxDiagonalKm(x.bbox) : 1e9) - (y.bbox ? bboxDiagonalKm(y.bbox) : 1e9))[0]!;
    const hits = await deps.geocoder.search(a.name, { limit: 1 });
    const h = hits[0];
    if (h && h.bbox && bboxDiagonalKm(h.bbox) <= 150) {
      const place = { ...toPlace(h, 'approximate', reelCategory ?? 'area'), place_id: `approx:${h.ref}` };
      const clue: Clue = clues.find((c) => c.text === a.name || c.area === a.name) ?? { kind: 'area', text: a.name, sources: ['manual'], explicit: false, role: 'featured', evidence: '' };
      const cue = pickCue(place.name, clue, evidence, 1);
      links.push({ place, cue: cue.cue, cueSource: cue.source, role: 'featured', clueText: a.name });
      notes.push(`Only the general area (${h.name}) is known — saved as APPROXIMATE.`);
      return { status: 'resolved', reason: `approximate area only: ${h.name}`, links, reviewCandidates: [], clues, notes, deferred };
    }
    if (h) notes.push(`Area "${a.name}" is too large to pin usefully (${h.bbox ? Math.round(bboxDiagonalKm(h.bbox)) : '?'} km across).`);
  }

  // OCR noise copies of something already found ("Example Gorge QO" — seen live) must not
  // keep a Reel in review: drop an unresolved OCR-only clue that resembles a found place, its area or an AI suggestion.
  // Clear open items that are not really open:
  //  (1) a copy of something already found — garbled OCR ("Example Gorge QO") or a shorter name ("X" when
  //      "X Lake" was pinned, "Y" next to "Y Waterfall");
  //  (2) on-screen/subtitle text that OpenAI has already read and did not list as a place ("This Is More Than Wagyu").
  for (let i = unresolvedSignificant.length - 1; i >= 0; i--) {
    const c = unresolvedClues.get(unresolvedSignificant[i]!.match(/^"(.+?)":/)?.[1] ?? '');
    if (!c || c.sources.includes('note')) continue; // what you typed yourself always stays open until resolved
    const found = [...links.flatMap((l) => [l.place.name, l.clueText]), ...(opts.aiPlaces ?? []).filter((p) => links.some((l) => l.clueText === p.name)).map((p) => p.name)].filter((r) => r && r.length >= 3);
    const ocrOnly = c.sources.every((s) => s === 'ocr');
    const refs = ocrOnly ? [...found, ...ctx.map((a) => a.name), ...(opts.aiPlaces ?? []).flatMap((p) => [p.name, p.city ?? ''])].filter((r) => r && r.length >= 3) : found;
    // Compare the identifying words too: "X-Kol" is the "X-Kul Lake" already pinned (only "lake" differs).
    const core = (s: string) => distinctiveTokens(s).join('');
    const refs2 = [...refs, ...links.flatMap((l) => l.clue?.aliases ?? []), ...(opts.aiPlaces ?? []).filter((p) => links.some((l) => l.clueText === p.name)).map((p) => p.local_name ?? '')].filter((r) => r && r.length >= 2);
    const hit = links.length ? refs2.find((r) => nameSimilarity(c.text, r) >= 0.6 || letterSimilarity(c.text, r) >= 0.75 || norm(c.text).includes(norm(r)) || norm(r).includes(norm(c.text))
      || (core(c.text).length >= 4 && core(r).length >= 4 && letterSimilarity(core(c.text), core(r)) >= 0.75)) : undefined;
    if (hit) { notes.push(`"${c.text}" is a copy of "${hit}" (already found) — not counted separately.`); unresolvedSignificant.splice(i, 1); continue; }
    // (1b) The lookup for this text leads back to a pin this Reel already has (seen live: a dish bullet whose best
    //      match was another branch of the pinned restaurant; a mountain's local-script name that was "ambiguous"
    //      between the pinned peak and a namesake). Only when the text itself did not match a DIFFERENT place well:
    //      a second listed branch ("X Shibuya" next to "X Shinjuku") has a strong match of its own and stays open.
    const ur = unresolvedRanked.get(c.text);
    if (ur && links.length) {
      const isPin = (t: Candidate, nearKm = 0) => links.find((l) => l.place.confidence === 'confirmed' && (l.place.place_id === t.ref || (!!t.googlePlaceId && l.place.google_place_id === t.googlePlaceId) || haversineKm(l.place, t) < nearKm));
      const weak = ur.why.startsWith('best name match is weak'), amb = ur.why.startsWith('ambiguous:');
      const top = ur.ranked[0];
      const back = top && weak ? isPin(top) ?? links.find((l) => l.place.confidence === 'confirmed' && nameSimilarity(l.place.name, top.name) >= 0.6 && haversineKm(l.place, top) < 50)
        : amb ? ur.ranked.slice(0, 2).map((t) => isPin(t, 0.3)).find(Boolean) : undefined;
      if (back) { notes.push(`"${c.text}" leads back to "${back.place.name}" (already pinned) — not counted separately.`); unresolvedSignificant.splice(i, 1); continue; }
    }
    // Caption phrases OpenAI read in full and did not list as places ("Drink Bar" on a menu) — not open questions.
    if (!ocrOnly && opts.aiPlaces?.length && links.length && !c.explicit && !opts.aiPlaces.some((p) => nameSimilarity(p.name, c.text) >= 0.6 || letterSimilarity(p.name, c.text) >= 0.75)) { notes.push(`"${c.text}": OpenAI read the caption and did not list it as a place — ignored.`); unresolvedSignificant.splice(i, 1); continue; }
    if (ocrOnly && opts.aiPlaces && !c.explicit) { notes.push(`On-screen "${c.text}": OpenAI read it and did not list it as a place — ignored.`); unresolvedSignificant.splice(i, 1); continue; }
    if (ocrOnly && opts.aiPlaces && !(opts.aiPlaces ?? []).some((p) => nameSimilarity(p.name, c.text) >= 0.6 || letterSimilarity(p.name, c.text) >= 0.75)) { notes.push(`On-screen "${c.text}": OpenAI read it and did not list it as a place — ignored.`); unresolvedSignificant.splice(i, 1); }
  }
  const dedupReview = [...new Map(review.filter((c) => !links.some((l) => l.place.place_id === c.ref)).map((c) => [c.ref, c])).values()];
  if (links.length && !unresolvedSignificant.length && approxReview.length) return { status: 'needs_review', reason: `saved as approximate — please check: ${approxReview.join('; ')}`, links, reviewCandidates: dedupReview, clues, notes, deferred };
  if (links.length && !unresolvedSignificant.length) return { status: 'resolved', reason: `${links.length} place(s) confirmed`, links, reviewCandidates: [], clues, notes, deferred };
  if (links.length) return { status: 'needs_review', reason: `partially resolved; unresolved: ${[...unresolvedSignificant, ...approxReview.map((x) => `${x} (saved as approximate)`)].join('; ')}`, links, reviewCandidates: dedupReview, clues, notes, deferred };
  const reason = !clues.length ? 'no explicit location clue in the available text'
    : unresolvedSignificant.length ? unresolvedSignificant.join('; ') : notes.find((n) => n.includes('too large to pin'))?.replace(/^Area "(.+?)" is too large to pin usefully \((.+?)\)\.$/, 'only the region "$1" is known ($2) — too large to pin; add the exact place in review') ?? 'clues found but none matched a specific place';
  return { status: 'needs_review', reason, links: [], reviewCandidates: dedupReview, clues, notes, deferred };
}
