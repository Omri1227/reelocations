import type { Store } from '../db.ts';
import type { Candidate, Clue, TextEvidence } from '../types.ts';
import { attachRoute, pickCue, scoreCandidate, toPlace, type ResolveDeps } from '../resolve/resolver.ts';
import { bboxDiagonalKm, haversineKm } from '../geo/geometry.ts';
import { nameSimilarity } from '../util/text.ts';
import { applyChosenListing, clearListingOptions, rejectListingsIn } from '../geo/googleMatch.ts';
import { confirmGmapsListing, excludeGmapsPlace } from '../sync/savedListRunner.ts';

function evidenceOf(store: Store, key: string): TextEvidence[] {
  const r = store.getReel(key);
  const ev = r?.evidence_json ? JSON.parse(r.evidence_json) : null;
  const texts: TextEvidence[] = ev?.texts ?? [];
  const notes = store.notesFor(key).map((text) => ({ source: 'note' as const, text }));
  return [...notes, ...texts.filter((t) => t.source !== 'note')];
}

function manualClue(text: string, cand?: Candidate): Clue {
  return { kind: cand?.isRoute || cand?.category === 'hike' ? 'trail' : 'place', text, sources: ['manual'], explicit: true, role: 'featured', evidence: text, categoryHint: cand?.category };
}

/**
 * Which pin of this Reel an option most likely stands for (it replaces that pin), or null when it is another place.
 * The Review Queue pre-selects this; you can change it. Only Reel's pin → that pin; otherwise a pin within 2 km, a
 * same-named pin, or an approximate pin within 25 km (a rough version of the same place).
 */
export function guessReplaced(store: Store, key: string, c: Candidate): string | null {
  if (c.replacesPlaceId || c.confirmsApproxPlaceId || c.replacesApproxPlaceId) return null;
  const links = store.linksForReel(key) as any[];
  if (!links.length) return null;
  if (links.length === 1) return links[0].place_id;
  const scored = links.map((l) => ({ l, km: haversineKm(l, c), sim: Math.max(nameSimilarity(l.name, c.name), c.clueText ? nameSimilarity(l.name, c.clueText) : 0, ...(c.names ?? []).map((n) => nameSimilarity(l.name, n))) }));
  const hit = scored.filter((s) => s.km <= 2 || s.sim >= 0.6 || (s.l.confidence === 'approximate' && s.km <= 25))
    .sort((x, y) => (x.km <= 2 ? 0 : 1) - (y.km <= 2 ? 0 : 1) || y.sim - x.sim || x.km - y.km)[0];
  return hit?.l.place_id ?? null;
}

/** Take a pin off this Reel because you chose another place for it. It stays off when the Reel is re-processed. */
export function removePinFromReel(store: Store, key: string, placeId: string) {
  const cid = store.collectionOf(key);
  if (store.linksForPlaceIn(cid, placeId).some((l) => l.reel_key !== key)) store.unlinkPlace(key, placeId); // another Reel still shows it
  else store.deletePlaceFromCollection(cid, placeId, null);
}

/**
 * The user picks a candidate: it becomes a confirmed place (decided_by=user). With `replace`, it takes the place of that
 * pin of this Reel (the Review Queue pre-selects the likely one); without, it is added as another place.
 */
export async function chooseCandidate(store: Store, deps: ResolveDeps, key: string, idx: number, opts: { keepOpen?: boolean; replace?: string | null } = {}) {
  const cands = store.candidatesFor(key);
  const c = cands[idx];
  if (!c) throw new Error(`no candidate #${idx} for ${key} (have ${cands.length})`);
  if (c.replacesPlaceId) {
    const place = applyChosenListing(store, key, c) as any;
    // Held back by the Google Maps list's branch check, now confirmed by you: save it on the next cycle.
    if ((c as any).gmapsConfirm && c.googlePlaceId) confirmGmapsListing(store, store.collectionOf(key), c.googlePlaceId);
    return { place, notes: ['Google listing attached to the existing pin'] };
  }
  // "This is it" on an approximate pin's own entry: the pin is right, it becomes confirmed.
  if (c.confirmsApproxPlaceId) {
    const pid = c.confirmsApproxPlaceId;
    const link = (store.linksForReel(key) as any[]).find((l) => l.place_id === pid);
    if (!link) throw new Error('that pin is no longer on this Reel');
    store.db.prepare("UPDATE places SET confidence='confirmed', source=CASE WHEN instr(source, ' · approximate: ') > 0 THEN substr(source, 1, instr(source, ' · approximate: ') - 1) ELSE source END, updated_at=? WHERE place_id=?").run(new Date().toISOString(), pid);
    store.linkReelPlace({ reel_key: key, place_id: pid, cue: null, cue_source: null, role: link.role, decided_by: 'user' });
    settleApproxQuestion(store, key, pid, cands, `you confirmed ${link.name}`);
    return { place: store.getPlace(pid) as any, notes: ['approximate pin confirmed'] };
  }
  const notes: string[] = [];
  let place = toPlace(c, 'confirmed');
  if (c.category === 'hike' || c.isRoute) place = await attachRoute(place, c, c.clueText ?? c.name, deps, notes);
  const ev = evidenceOf(store, key);
  const clue = manualClue(c.clueText ?? c.name, c);
  const cue = pickCue(place.name, clue, ev, 1); // note first, else a sentence from the Reel's own text naming the place
  place = { ...place, place_id: store.upsertPlace(place).place_id };
  store.linkReelPlace({ reel_key: key, place_id: place.place_id, cue: cue.cue, cue_source: cue.source, role: 'featured', decided_by: 'user' });
  if (opts.replace && opts.replace !== place.place_id && (store.linksForReel(key) as any[]).some((l) => l.place_id === opts.replace)) {
    const old = store.getPlace(opts.replace);
    removePinFromReel(store, key, opts.replace);
    notes.push(`replaced ${old?.name ?? opts.replace}`);
  }
  // An alternative to an approximate pin replaces that pin on this Reel (unless you had confirmed it yourself).
  if (c.replacesApproxPlaceId && c.replacesApproxPlaceId !== place.place_id) {
    const old = (store.linksForReel(key) as any[]).find((l) => l.place_id === c.replacesApproxPlaceId);
    if (old && old.decided_by !== 'user' && old.confidence === 'approximate') removePinFromReel(store, key, old.place_id);
    settleApproxQuestion(store, key, c.replacesApproxPlaceId, store.candidatesFor(key), `you chose ${place.name}`);
    return { place, notes: [...notes, 'approximate pin replaced'] };
  }
  const remaining = cands.filter((x) => x.clueText && x.clueText !== c.clueText && x.ref !== c.ref);
  store.replaceCandidates(key, opts.keepOpen ? cands.filter((x) => x.ref !== c.ref) : remaining);
  const stillOpen = opts.keepOpen || remaining.length > 0;
  store.setReelResult(key, { status: stillOpen ? 'needs_review' : 'resolved', reason: stillOpen ? `you confirmed ${place.name}; other clues still open` : `confirmed by you: ${place.name}` });
  return { place, notes };
}

/** Drop the options of one approximate pin's question; the Reel is resolved when nothing else is open. */
function settleApproxQuestion(store: Store, key: string, pid: string, cands: Candidate[], why: string) {
  const rest = cands.filter((x) => x.confirmsApproxPlaceId !== pid && x.replacesApproxPlaceId !== pid);
  store.replaceCandidates(key, rest);
  const openOther = rest.length > 0;
  store.setReelResult(key, { status: openOther ? 'needs_review' : 'resolved', reason: openOther ? `${why}; other clues still open` : `confirmed by you: ${why.replace(/^you (confirmed|chose) /, '')}` });
}

/** Free-text search from the review UI; results become new candidates for this Reel. */
export async function searchCandidates(store: Store, deps: ResolveDeps, key: string, query: string): Promise<Candidate[]> {
  const hits = await deps.geocoder.search(query, { limit: 8 });
  // Google Places too (when configured): restaurants and shops OSM lacks, each with its exact listing.
  if (deps.google) for (const g of await deps.google(query).catch(() => [])) if (!hits.some((h) => h.googlePlaceId === g.googlePlaceId)) hits.push(g);
  const clue = manualClue(query);
  const scored = hits.map((h) => scoreCandidate(clue, h, [])).sort((a, b) => b.score! - a.score!);
  const prev = store.candidatesFor(key).filter((c) => !scored.some((s) => s.ref === c.ref));
  store.replaceCandidates(key, [...scored, ...prev].slice(0, 20));
  return scored;
}

/** Save only the general area, clearly labelled APPROXIMATE. */
export async function markApproximate(store: Store, deps: ResolveDeps, key: string, areaQuery: string) {
  const [h] = await deps.geocoder.search(areaQuery, { limit: 1 });
  if (!h) throw new Error(`area not found: ${areaQuery}`);
  if (h.bbox && bboxDiagonalKm(h.bbox) > 400) throw new Error(`"${h.name}" is too large to be a useful approximate location`);
  const place = { ...toPlace(h, 'approximate', 'area'), place_id: `approx:${h.ref}` };
  const ev = evidenceOf(store, key);
  const note = ev.find((e) => e.source === 'note');
  const pid = store.upsertPlace(place).place_id;
  store.linkReelPlace({ reel_key: key, place_id: pid, cue: note ? `Your note: "${note.text.slice(0, 180)}"` : null, cue_source: note ? 'note' : null, role: 'featured', decided_by: 'user' });
  store.setReelResult(key, { status: 'resolved', reason: `approximate area chosen by you: ${h.name}` });
  return place;
}

/** "None of these" for the Google listing options of a pin: keep the pin as it is and stop asking. */
export function rejectListings(store: Store, placeId: string, collectionId?: number) {
  if (collectionId != null) { rejectListingsIn(store, collectionId, placeId); excludeGmapsPlace(store, collectionId, placeId); return; }
  store.setKv(`gmatch:${placeId}`, JSON.stringify({ status: 'rejected', by: 'user', at: new Date().toISOString() }));
  clearListingOptions(store, placeId);
}

export function addNote(store: Store, key: string, note: string) { store.addNote(key, note); }
export function notAPlace(store: Store, key: string) { store.setNotAPlace(key); }
