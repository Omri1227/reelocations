import type { Store } from '../db.ts';
import type { Candidate, Category, PlaceRow } from '../types.ts';
import { categoriesCompatible, letterSimilarity } from '../resolve/resolver.ts';
import { haversineKm } from './geometry.ts';
import { distinctiveTokens, nameSimilarity, norm, tokens } from '../util/text.ts';
import { CATEGORY_INFO } from '../categories.ts';

/**
 * Find the exact Google Maps listing (incl. the right branch) for a saved pin, using the Google Places Text Search
 * results the pipeline already gets. A listing is only taken when name, place type and location (city/country) agree;
 * branch words from the pin name or the Reel's own text ("2nd Branch", "Ginza") break ties between same-name
 * listings. Anything less clear goes to the existing review queue as options.
 */
export type GoogleSearch = (q: string, bias?: { bbox?: [number, number, number, number]; lat?: number; lon?: number }) => Promise<Candidate[]>;

export type GoogleMatch =
  | { status: 'matched'; cand: Candidate; why: string }
  | { status: 'ambiguous'; options: Candidate[]; why: string }
  | { status: 'none'; why: string };

export interface MatchInput {
  name: string; category: Category; lat: number; lon: number; confidence: string; kind?: string; source?: string;
  country?: string | null; locality?: string | null;
  /** The Reel's own text (caption, OCR, note) — used only to find branch/neighbourhood words next to the name. */
  evidence?: string[];
}

/** Words that mark a particular outlet of a chain. */
const BRANCH = /\b(\d+(st|nd|rd|th)|branch|annex|annexe|honten|bekkan|outlet|location|shop|store|ten)\b|店|号店|本店|支店|別館/i;
const BIG_NATURE: Category[] = ['mountain', 'lake', 'nature_reserve', 'river', 'park', 'hike', 'beach', 'area', 'camping', 'viewpoint', 'waterfall', 'cave', 'hot_spring'];

const splitName = (n: string) => {
  const m = n.match(/^(.*?)\s*[(（]([^)）]+)[)）]\s*$/);
  return m ? { base: m[1]!.trim(), qualifier: m[2]!.trim() } : { base: n.trim(), qualifier: '' };
};

/** How far the listing may be from the pin: tight for confirmed map points, wide for estimates and large features. */
function maxKm(p: MatchInput): number {
  const estimate = p.confidence !== 'confirmed' || /estimate|approx/i.test(p.source ?? '');
  if (BIG_NATURE.includes(p.category)) return estimate ? 60 : 20;
  return estimate ? 40 : 3;
}

function typeOk(pin: Category, g: Candidate): boolean {
  if (g.isStop) return pin === 'transport';
  // An area pin (a district) is often listed as a scenic spot / attraction rather than a district.
  if (pin === 'area') return g.isArea || ['area', 'attraction', 'viewpoint', 'park', 'nature_reserve', 'historic'].includes(g.category);
  if (g.isArea || g.category === 'area') return false;
  if (g.category === 'other') return BIG_NATURE.includes(pin) || pin === 'other' || pin === 'attraction';
  if (pin === 'other') return true;
  if (categoriesCompatible(pin, g.category)) return true;
  // A mountain hut is a hotel and a restaurant; a viewpoint/park is often listed as a tourist attraction.
  if ((pin === 'hotel' && ['restaurant', 'camping', 'bar', 'cafe'].includes(g.category)) || (g.category === 'hotel' && ['restaurant', 'camping'].includes(pin))) return true;
  if (g.category === 'attraction' && BIG_NATURE.includes(pin)) return true;
  // An onsen ryokan is both (an "… Onsen …" inn: hot spring pin, japanese_inn listing).
  if ((pin === 'hot_spring' && g.category === 'hotel') || (pin === 'hotel' && g.category === 'hot_spring')) return true;
  // A historic village (attraction) may be listed as a national park; a sight may be a park, temple, monument, viewpoint…
  const SIGHT: Category[] = ['attraction', 'historic', 'architecture', 'ruins', 'museum', 'temple', 'viewpoint', 'park', 'nature_reserve'];
  if (SIGHT.includes(pin) && SIGHT.includes(g.category)) return true;
  return false;
}

export interface Scored { cand: Candidate; name: number; km: number; ok: boolean; reviewable: boolean; why: string }

/** A different facility at the same site: "<Gorge> Scenic Area Ticket Office" is not the gorge. */
const FACILITY = /\b(ticket(?:ing)? office|ticket|parking|car park|entrance|gate|visitor cent(?:er|re)|guest ?house|hostel|hotel|inn|lodge|station|bus stop|shop|store|restaurant|cafe|toilets?|camp ?site)\b/i;

export function scoreListing(p: MatchInput, g: Candidate, branchWords: string[]): Scored {
  // "<Gorge> (<River>–<River> Confluence area)": the qualifier is a name of its own when it carries ≥2 identifying words.
  const sp = splitName(p.name);
  const alts = sp.qualifier && distinctiveTokens(sp.qualifier).length >= 2 && !BRANCH.test(sp.qualifier) ? [sp.base, sp.qualifier.replace(/\b(area|region|zone)\b/gi, '').trim()] : [sp.base];
  let best: Scored | null = null;
  for (const alt of alts) {
    const s = scoreListingAs(p, alt === sp.base ? p.name : alt, g, branchWords);
    if (!best || s.name > best.name) best = s;
  }
  return best!;
}

function scoreListingAs(p: MatchInput, pinName: string, g: Candidate, branchWords: string[]): Scored {
  const { base, qualifier } = splitName(pinName);
  const names = [...new Set([pinName, base])];
  let name = 0;
  for (const n of names) name = Math.max(name, nameSimilarity(n, g.name), letterSimilarity(n, g.name));
  const gText = norm(`${g.name} ${g.displayName}`);
  const gNameTokens = new Set(tokens(g.name)), pinTokens = new Set(tokens(p.name));
  // Branch words wanted by the pin name "(2nd Branch)" or by the Reel's text next to the name.
  const want = [...new Set([...tokens(qualifier), ...branchWords])].filter((t) => t.length >= 2 && !tokens(base).includes(t));
  const gWords = gText.split(' ');
  const wantMarkers = want.filter((t) => BRANCH.test(t));
  const gMarkers = [...gNameTokens].filter((t) => BRANCH.test(t));
  // An outlet the Reel did not name ("… 2nd Branch" when it names the main shop) costs a little,
  if ((gMarkers.length && !gMarkers.some((t) => pinTokens.has(t) || wantMarkers.includes(t))) || (/支店|号店|別館/.test(g.name) && !/支店|号店|別館/.test(p.name) && !wantMarkers.length)) name -= 0.12;
  // and so does a listing WITHOUT the outlet the Reel named;
  if (wantMarkers.length && !wantMarkers.some((t) => gWords.includes(t))) name -= 0.12;
  // other words from the Reel that the listing carries (a neighbourhood: "Ginza") count for it.
  const hit = want.filter((t) => gWords.includes(t)).length;
  if (hit) name += Math.min(0.15, 0.08 * hit);
  // What makes the names the same must be the identifying words, not "Sushi" + "Restaurant": a listing named only
  // with generic words never counts, and the identifying words of both sides must largely agree (the listing's
  // address may supply a neighbourhood the pin name carries, e.g. "Ginza").
  const pinD = distinctiveTokens(base), gD = distinctiveTokens(g.name).filter((t) => !BRANCH.test(t));
  const same = (a: string, b: string) => a === b || (a.length >= 3 && b.length >= 3 && letterSimilarity(a, b) >= 0.66);
  if (!gD.length) name = Math.min(name, 0.5);
  else if (pinD.length) {
    const addr = tokens(g.displayName);
    const cover = pinD.filter((t) => gD.some((x) => same(t, x)) || addr.includes(t)).length / pinD.length;
    const gCover = gD.filter((t) => pinD.some((x) => same(t, x))).length / gD.length;
    name = Math.min(name, (cover + gCover) / 2 + 0.15);
  }
  // A facility the pin is not (a ticket office or guesthouse at a gorge) is a different listing.
  const fac = g.name.match(FACILITY)?.[0];
  if (fac && !norm(pinName).includes(norm(fac)) &&!['hotel', 'restaurant', 'cafe', 'bar', 'shop', 'transport', 'camping', 'hot_spring'].includes(p.category)) name -= 0.3;
  name = Math.min(1, Math.max(0, name));
  const km = haversineKm(p, g);
  // Some addresses carry no country at all ("Nimmoo, 194107" in Ladakh): a near-identical name close by is enough.
  const countryOk = !p.country || norm(g.displayName).includes(norm(p.country)) || km <= 3 || (name >= 0.9 && km <= 15);
  const tOk = typeOk(p.category, g);
  // An estimate (AI, ±50 km) with the exact name inside the same prefecture/region: the listing is the place.
  const estimate = p.confidence !== 'confirmed' || /estimate|approx/i.test(p.source ?? '');
  const near = km <= maxKm(p) || (estimate && name >= 0.95 && km <= 120 && !!p.locality && norm(g.displayName).includes(norm(p.locality)));
  const ok = tOk && near && countryOk;
  const why = !tOk ? `type ${g.category} ≠ ${p.category}` : !near ? `${km.toFixed(1)} km away` : !countryOk ? `not in ${p.country}` : `name ${name.toFixed(2)}, ${km.toFixed(1)} km`;
  // Right type and distance but the address names no country (e.g. a disputed region): ask instead of guessing.
  return { cand: g, name, km, ok, reviewable: tOk && near, why };
}

/** Words the Reel puts right next to the place name ("Inoue 2nd branch, Shinjuku") — used to pick the right outlet. */
export function branchWordsFrom(name: string, evidence: string[] = []): string[] {
  const { base } = splitName(name);
  const baseT = tokens(base);
  if (!baseT.length) return [];
  const out = new Set<string>();
  for (const text of evidence) for (const line of text.split(/\n+/)) {
    const lt = tokens(line);
    const shared = baseT.filter((t) => lt.includes(t)).length;
    if (shared < Math.min(2, baseT.length)) continue;
    for (const t of lt) if (!baseT.includes(t) && t.length >= 3 && !/^\d+$/.test(t)) out.add(t);
  }
  return [...out].slice(0, 12);
}

export function decideListing(p: MatchInput, results: Candidate[]): GoogleMatch {
  if (!results.length) return { status: 'none', why: 'Google returned no listing' };
  const bw = branchWordsFrom(p.name, p.evidence);
  const scored = results.map((g) => scoreListing(p, g, bw)).sort((a, b) => b.name - a.name || a.km - b.km);
  const good = scored.filter((s) => s.ok && s.name >= 0.8);
  const plausible = scored.filter((s) => s.reviewable && s.name >= 0.6);
  if (good.length) {
    // Two listings for one spot ("Base Camp for Peak X" / "… Peak X Expedition", 200 m apart) are one place;
    // among equally good listings the one carrying exactly the pin's name wins.
    const exactName = (s: Scored) => [p.name, splitName(p.name).base].some((n) => norm(n) === norm(s.cand.name));
    const distinct = good.filter((s, i) => !good.slice(0, i).some((o) => haversineKm(o.cand, s.cand) < 0.5 && nameSimilarity(o.cand.name, s.cand.name) >= 0.6));
    const exactOnes = distinct.filter(exactName);
    // Several exact names (a mountain range listed as a peak and as an attraction): the one of the pin's own type wins.
    const sameType = (exactOnes.length > 1 ? exactOnes : []).filter((s) => s.cand.category === p.category);
    if (sameType.length === 1 && distinct[0]!.name - sameType[0]!.name < 0.1) return { status: 'matched', cand: sameType[0]!.cand, why: `${sameType[0]!.cand.name} (exact name and type; ${sameType[0]!.why})` };
    if (distinct.length > 1 && exactOnes.length === 1 && distinct[0]!.name -exactOnes[0]!.name < 0.1) return { status: 'matched', cand: exactOnes[0]!.cand, why: `${exactOnes[0]!.cand.name} (exact name; ${exactOnes[0]!.why})` };
    const [top, second] = distinct;
    if (!second || top!.name - second.name >= 0.1 || top!.cand.googlePlaceId === second.cand.googlePlaceId) {
      return { status: 'matched', cand: top!.cand, why: `${top!.cand.name} (${top!.why})` };
    }
    // A district/town pin is not worth a trip to review: shops and stations share its name.
    if (p.category === 'area') return { status: 'none', why: `several listings are named ${p.name}; an area needs none` };
    return { status: 'ambiguous', options: good.slice(0, 5).map((s) => s.cand), why: `${good.length} listings fit "${p.name}" equally well (e.g. branches): ${good.slice(0, 3).map((s) => s.cand.displayName).join(' | ')}` };
  }
  if (plausible.length && p.category === 'area') return { status: 'none', why: `only similar names (${plausible[0]!.cand.name}); an area needs no listing` };
  if (plausible.length) return { status: 'ambiguous', options: plausible.slice(0, 5).map((s) => s.cand), why: `only a similar name: ${plausible.slice(0, 3).map((s) => `${s.cand.name} (${s.why})`).join(' | ')}` };
  return { status: 'none', why: `no listing fits: ${scored.slice(0, 3).map((s) => `${s.cand.name} (${s.why})`).join(' | ')}` };
}

export async function matchListing(p: MatchInput, search: GoogleSearch): Promise<GoogleMatch> {
  const where = [p.locality, p.country].filter((x, i, a) => x && a.indexOf(x) === i).join(', ');
  const q = where ? `${p.name}, ${where}` : p.name;
  const bias = { lat: p.lat, lon: p.lon };
  let results = await search(q, bias);
  const { base, qualifier } = splitName(p.name);
  if (qualifier && !results.length) results = await search(where ? `${base}, ${where}` : base, bias);
  return decideListing(p, results);
}

// ------------------------------------------------------------------------------------------------------------------
// Store integration: backfill pins without a place ID, and hand ambiguous ones to the review queue.
// ------------------------------------------------------------------------------------------------------------------

const RETRY_NONE_DAYS = 30;

function evidenceFor(store: Store, placeId: string): string[] {
  const out: string[] = [];
  for (const l of store.linksForPlace(placeId)) {
    const r = store.getReel(l.reel_key);
    const ev = r?.evidence_json ? JSON.parse(r.evidence_json) : null;
    for (const t of ev?.texts ?? []) out.push(String(t.text ?? ''));
    out.push(...store.notesFor(l.reel_key));
  }
  return out;
}

/** Pins that still need a Google listing lookup (no place ID; not already queued for review; "none" retried monthly). */
export function placesNeedingListing(store: Store, limit = 10): PlaceRow[] {
  const rows = store.db.prepare('SELECT * FROM places WHERE google_place_id IS NULL ORDER BY created_at').all() as any as PlaceRow[];
  const out: PlaceRow[] = [];
  for (const p of rows) {
    const st = store.getKv(`gmatch:${p.place_id}`);
    if (st) {
      const s = JSON.parse(st) as { status: string; at: string };
      if (s.status !== 'none' || Date.now() - Date.parse(s.at) < RETRY_NONE_DAYS * 86_400_000) continue;
    }
    if (!store.linksForPlace(p.place_id).length) continue;
    // Wait for the town/country (filled in by the next cycle): the search uses it, and a miss is cached for 30 days.
    if (!p.country && Date.now() - Date.parse(p.created_at) < 3_600_000) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** Offer the listings as review options on every Reel that shows this pin (the existing ✓ / "This is it" flow). */
export function queueListingReview(store: Store, p: PlaceRow, options: Candidate[], why: string) {
  try { if (JSON.parse(store.getKv(`gmatch:${p.place_id}`) ?? '{}').status === 'rejected') return; } catch { /* no state */ }
  for (const l of store.linksForPlace(p.place_id)) {
    // A collection that answered "none of these" for this pin is not asked again.
    if (store.getKv(`gmatch-rejected:${store.collectionOf(l.reel_key)}:${p.place_id}`)) continue;
    const prev = store.candidatesFor(l.reel_key).filter((c) => c.replacesPlaceId !== p.place_id);
    const opts = options.map((o) => ({ ...o, ref: `gplace:${o.googlePlaceId}`, replacesPlaceId: p.place_id, clueText: `Google listing for ${p.name}`, category: p.category }));
    store.replaceCandidates(l.reel_key, [...opts, ...prev].slice(0, 20));
    const r = store.getReel(l.reel_key);
    const reason = `Which Google Maps listing is ${CATEGORY_INFO[p.category]?.emoji ?? ''} ${p.name}? ${why}`;
    store.setReelResult(l.reel_key, { status: 'needs_review', reason: r?.status === 'needs_review' && r.status_reason && !r.status_reason.startsWith('Which Google Maps listing') ? `${r.status_reason} · ${reason}` : reason });
  }
}

/** The user picked a listing in review: update the existing pin in place (links, dates, category, photos kept). */
export function applyChosenListing(store: Store, reelKey: string, c: Candidate) {
  const pid = c.replacesPlaceId!;
  const cid = store.collectionOf(reelKey);
  // The choice belongs to this collection. A pin row other collections show too is not changed: this collection's
  // Reels move to a pin for the chosen listing, and the others keep their pin and their own open question.
  if (sharedWithOtherCollections(store, pid, cid)) {
    clearListingOptions(store, pid, cid); // while this collection's Reels still show the pin the question is about
    const target = store.forkPlaceForCollection(cid, pid, { googlePlaceId: c.googlePlaceId!, lat: c.lat, lon: c.lon, address: c.displayName, types: c.types });
    unmarkApproximate(store, target);
    store.setKv(`gmatch:${target}`, JSON.stringify({ status: 'matched', by: 'user', at: new Date().toISOString(), id: c.googlePlaceId }));
    return store.getPlace(target)!;
  }
  unmarkApproximate(store, pid);
  store.applyGoogleListing(pid, { googlePlaceId: c.googlePlaceId!, lat: c.lat, lon: c.lon, address: c.displayName, confirm: true, types: c.types });
  store.setKv(`gmatch:${pid}`, JSON.stringify({ status: 'matched', by: 'user', at: new Date().toISOString(), id: c.googlePlaceId }));
  clearListingOptions(store, pid);
  return store.getPlace(pid)!;
}

/** Your listing choice settles it: an approximate (medium-confidence) pin becomes a normal confirmed one. */
function unmarkApproximate(store: Store, pid: string) {
  store.db.prepare("UPDATE places SET confidence='confirmed', source=substr(source, 1, instr(source, ' · approximate: ') - 1) WHERE place_id=? AND instr(source, ' · approximate: ') > 0").run(pid);
}

/** Does any Reel of another collection show this pin? */
export function sharedWithOtherCollections(store: Store, placeId: string, collectionId: number): boolean {
  return !!store.db.prepare('SELECT 1 FROM reel_places rp JOIN reels r USING(reel_key) WHERE rp.place_id=? AND r.collection_id<>? LIMIT 1').get(placeId, collectionId);
}

/**
 * "None of these" in one collection. A pin only this collection shows stops being asked about altogether; a shared
 * pin stops being asked about in this collection only.
 */
export function rejectListingsIn(store: Store, collectionId: number, placeId: string) {
  if (!sharedWithOtherCollections(store, placeId, collectionId)) {
    store.setKv(`gmatch:${placeId}`, JSON.stringify({ status: 'rejected', by: 'user', at: new Date().toISOString() }));
    clearListingOptions(store, placeId);
    return;
  }
  store.setKv(`gmatch-rejected:${collectionId}:${placeId}`, new Date().toISOString());
  clearListingOptions(store, placeId, collectionId);
}

/** Remove the listing options for a pin from every Reel (or one collection's); Reels with nothing else open go back to "resolved". */
export function clearListingOptions(store: Store, placeId: string, onlyCollection?: number) {
  for (const l of store.linksForPlace(placeId)) {
    if (onlyCollection != null && store.collectionOf(l.reel_key) !== onlyCollection) continue;
    const all = store.candidatesFor(l.reel_key);
    const rest = all.filter((c) => c.replacesPlaceId !== placeId);
    if (rest.length === all.length) continue;
    store.replaceCandidates(l.reel_key, rest);
    if (!rest.length && store.linksForReel(l.reel_key).length) { store.setReelResult(l.reel_key, { status: 'resolved', reason: `Google listing settled for ${store.getPlace(placeId)?.name}` }); continue; }
    const r = store.getReel(l.reel_key)!;
    const reason = (r.status_reason ?? '').split(' · ').filter((x) => !x.includes(`listing is `) || rest.some((c) => c.replacesPlaceId && x.includes(store.getPlace(c.replacesPlaceId)?.name ?? ' '))).join(' · ');
    store.setReelResult(l.reel_key, { status: r.status, reason: reason || r.status_reason });
  }
}

export async function matchStoredPlaces(store: Store, search: GoogleSearch, opts: { limit?: number; log?: (m: string) => void } = {}): Promise<{ matched: number; review: number; none: number }> {
  const out = { matched: 0, review: 0, none: 0 };
  for (const p of placesNeedingListing(store, opts.limit ?? 10)) {
    let m: GoogleMatch;
    try { m = await matchListing({ ...p, evidence: evidenceFor(store, p.place_id) }, search); } catch (e) { opts.log?.(`google listing for ${p.name}: deferred (${(e as Error).message})`); continue; }
    const at = new Date().toISOString();
    if (m.status === 'matched') {
      store.applyGoogleListing(p.place_id, { googlePlaceId: m.cand.googlePlaceId!, lat: m.cand.lat, lon: m.cand.lon, address: m.cand.displayName, confirm: true, types: m.cand.types });
      store.setKv(`gmatch:${p.place_id}`, JSON.stringify({ status: 'matched', by: 'auto', at, id: m.cand.googlePlaceId, why: m.why }));
      store.log('info', 'google-listing', `${p.name} → ${m.why}`);
      out.matched++;
    } else if (m.status === 'ambiguous') {
      queueListingReview(store, p, m.options, m.why);
      store.setKv(`gmatch:${p.place_id}`, JSON.stringify({ status: 'review', at, why: m.why }));
      out.review++;
    } else {
      store.setKv(`gmatch:${p.place_id}`, JSON.stringify({ status: 'none', at, why: m.why }));
      out.none++;
    }
    opts.log?.(`google listing for ${p.name}: ${m.status} — ${m.why}`);
  }
  return out;
}

/** Bump when the matching rules get stricter: automatic matches made under older rules are checked again once. */
export const LISTING_RULES = 2;

/**
 * Re-check automatic listing matches made under older rules (Google responses are cached, so this is free). A match the
 * current rules no longer accept loses its place ID (the pin stays where it is) and is retried like any unmatched pin.
 */
export async function recheckListings(store: Store, search: GoogleSearch, log?: (m: string) => void): Promise<number> {
  if (Number(store.getKv('gmatch:rules') ?? '1') >= LISTING_RULES) return 0;
  let dropped = 0;
  for (const r of store.db.prepare("SELECT k, v FROM kv WHERE k LIKE 'gmatch:%' AND k <> 'gmatch:rules'").all() as any[]) {
    const st = JSON.parse(r.v); if (st.status !== 'matched' || st.by !== 'auto') continue;
    const p = store.getPlace(String(r.k).slice('gmatch:'.length)); if (!p?.google_place_id) continue;
    const m = await matchListing({ ...p, evidence: evidenceFor(store, p.place_id) }, search);
    if (m.status === 'matched' && m.cand.googlePlaceId === p.google_place_id) continue;
    store.db.prepare('UPDATE places SET google_place_id=NULL, coords_fetched_at=NULL, updated_at=? WHERE place_id=?').run(new Date().toISOString(), p.place_id);
    store.setKv(r.k, JSON.stringify({ status: 'none', at: new Date().toISOString(), why: `stricter rules: ${m.why}` }));
    store.log('warn', 'google-listing', `${p.name}: listing match withdrawn (${m.why})`);
    log?.(`google listing for ${p.name}: withdrawn — ${m.why}`);
    dropped++;
  }
  store.setKv('gmatch:rules', String(LISTING_RULES));
  return dropped;
}
