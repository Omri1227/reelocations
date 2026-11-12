import fs from 'node:fs';
import type { Store } from '../db.ts';
import type { Category } from '../types.ts';
import { CATEGORY_INFO } from '../categories.ts';
import { googleMapsUrl } from '../geo/googlePlaces.ts';
import { CUISINES, isCuisine } from '../cuisine.ts';
import type { Accounts } from '../accounts.ts';
import { collectionSyncStatus } from '../destinations.ts';

export interface MapReel { url: string | null; shared_at: string; cue: string | null; image: string | null; image_label: string | null; contributor: string | null }
export interface MapPlace {
  id: string; name: string; category: Category; label: string; emoji: string; color: string;
  cuisine: string | null; cuisine_label: string | null; cuisine_emoji: string | null; cuisine_source: string | null;
  lat: number; lon: number; kind: 'point' | 'route'; line: [number, number][][] | null; confidence: string;
  country: string; country_code: string; locality: string | null; address: string | null;
  google_place_id: string | null; maps_url: string; first_shared_at: string; created_at: string; reels: MapReel[];
  can_delete: boolean;
  /** Personal (signed-in user): starred by me; added after I started using the collection and not opened by me yet. */
  starred: boolean; is_new: boolean; added_at: string;
  /** Approximate pins: the Review Queue entry that explains why (and offers the alternatives). */
  review_url: string | null;
}
export interface MapData {
  version: string; generated_at: string; places: MapPlace[];
  categories: { key: Category; label: string; emoji: string; color: string; count: number }[];
  cuisines: { key: string; label: string; emoji: string; count: number }[];
  all_cuisines: { key: string; label: string; emoji: string }[];
  collection?: { id: number; name: string; role: string; shared: boolean; members: number };
  /** The user's own country order (country codes); countries not in it follow, by number of pins. */
  country_order: string[];
  /** Reels of this collection waiting in the Review Queue. */
  review_count: number;
  /** Per country: 'ok' | 'pending' | 'attention' (worst over connected destinations), or absent when no map is connected. */
  sync: { connected: boolean; status: string | null; countries: Record<string, { status: string; detail: string | null }>; destinations: any[]; unsorted: number };
}

/** URL of a Reel's screenshot / pin photo, served by the app itself (membership-checked). */
export const imageUrl = (reelKey: string, placeId: string) => `/img?r=${encodeURIComponent(reelKey)}&p=${encodeURIComponent(placeId)}`;

/** The local file to show for a Reel–pin link: its pin photo, else the Reel's first attached screenshot. */
/** Only files that really exist: a path whose file is gone (moved data folder, cleaned frames) used to give the pin
 *  a thumbnail and a preview that stayed blank. Falls back to the Reel's other screenshots. */
export function imageFileFor(store: Store, reelKey: string, placeId: string): string | null {
  const l = store.db.prepare('SELECT image_path FROM reel_places WHERE reel_key=? AND place_id=?').get(reelKey, placeId) as any;
  if (l?.image_path && fs.existsSync(l.image_path)) return l.image_path;
  for (const m of store.db.prepare("SELECT local_path FROM media WHERE reel_key=? AND kind='image' AND local_path IS NOT NULL ORDER BY created_at").all(reelKey) as any[]) if (fs.existsSync(m.local_path)) return m.local_path;
  return null;
}

export function countryOrder(store: Store, userId: number | null, collectionId: number): string[] {
  if (userId == null) return [];
  try { return JSON.parse(store.getKv(`country_order:${userId}:${collectionId}`) ?? '[]'); } catch { return []; }
}
export function setCountryOrder(store: Store, userId: number, collectionId: number, order: string[] | null) {
  if (!order) { store.db.prepare('DELETE FROM kv WHERE k=?').run(`country_order:${userId}:${collectionId}`); return; }
  store.setKv(`country_order:${userId}:${collectionId}`, JSON.stringify([...new Set(order.map((c) => String(c).slice(0, 40)))].slice(0, 400)));
}

/** Everything the map needs for ONE collection (a few KB per 100 pins). */
export function buildMapData(store: Store, collectionId = 1, viewer?: { userId: number; accounts: Accounts }): MapData {
  const places: MapPlace[] = [];
  const names = new Map<number, string>();
  const nameOf = (id: number | null) => { if (id == null) return null; if (!names.has(id)) { const u = viewer?.accounts.user(id); names.set(id, u?.name ?? u?.email ?? 'member'); } return names.get(id)!; };
  const owner = viewer ? viewer.accounts.role(viewer.userId, collectionId) === 'owner' : true;
  const since = viewer ? store.newSince(viewer.userId, collectionId) : null;
  const mine = viewer ? store.userPlaceState(viewer.userId, collectionId) : new Map();
  for (const p of store.placesOfCollection(collectionId)) {
    const links = store.linksForPlaceIn(collectionId, p.place_id) as any[];
    if (!links.length) continue;
    const info = CATEGORY_INFO[p.category] ?? CATEGORY_INFO.other;
    const reels: MapReel[] = links.map((l) => {
      const hasImg = !!imageFileFor(store, l.reel_key, p.place_id);
      return { url: l.url, shared_at: l.first_shared_at, cue: l.cue, image: hasImg ? imageUrl(l.reel_key, p.place_id) : null, image_label: l.image_kind === 'place' ? '📸 From the Reel' : hasImg ? '📸 Reel screenshot' : null, contributor: nameOf(l.contributed_by) };
    });
    let line: [number, number][][] | null = null;
    if (p.kind === 'route' && p.geometry_json) {
      try { line = (JSON.parse(p.geometry_json) as [number, number][][]).map((seg) => seg.map(([lon, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5] as [number, number])); } catch { line = null; }
    }
    const cu = isCuisine(p.cuisine) ? CUISINES[p.cuisine] : null;
    places.push({
      id: p.place_id, name: p.name, category: p.category, label: info.label, emoji: info.emoji, color: `#${info.color}`,
      cuisine: cu ? p.cuisine! : null, cuisine_label: cu?.label ?? null, cuisine_emoji: cu?.emoji ?? null, cuisine_source: cu ? p.cuisine_source ?? null : null,
      lat: p.lat, lon: p.lon, kind: p.kind, line, confidence: p.confidence,
      country: p.country ?? 'Unsorted', country_code: (p.country_code ?? '').toUpperCase(), locality: p.locality ?? null, address: p.address,
      google_place_id: p.google_place_id, maps_url: googleMapsUrl(p), first_shared_at: reels.map((r) => r.shared_at).sort()[0] ?? p.created_at, created_at: p.created_at, reels,
      can_delete: viewer ? owner || links.every((l) => l.contributed_by === viewer.userId) : true,
      starred: !!mine.get(p.place_id)?.starred_at,
      added_at: links.map((l) => l.created_at).sort()[0] ?? p.created_at,
      review_url: p.confidence === 'approximate' ? `/review?k=${encodeURIComponent(links[0].reel_key)}#pin-${encodeURIComponent(p.place_id)}` : null,
      is_new: !!since && (links.map((l) => l.created_at).sort()[0] ?? p.created_at) > since && !mine.get(p.place_id)?.seen_at,
    });
  }
  const counts = new Map<Category, number>();
  for (const p of places) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const categories = [...counts].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, label: CATEGORY_INFO[key]?.label ?? key, emoji: CATEGORY_INFO[key]?.emoji ?? '📌', color: `#${CATEGORY_INFO[key]?.color ?? '777777'}`, count }));
  const cc = new Map<string, number>();
  for (const p of places) if (p.cuisine) cc.set(p.cuisine, (cc.get(p.cuisine) ?? 0) + 1);
  const cuisines = [...cc].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, label: (CUISINES as any)[key].label, emoji: (CUISINES as any)[key].emoji, count }));
  const st = collectionSyncStatus(store, collectionId);
  const countries: Record<string, { status: string; detail: string | null }> = {};
  const rank = { ok: 0, pending: 1, attention: 2 } as Record<string, number>;
  for (const d of st.destinations) for (const c of d.countries) {
    const k = c.country_code.toUpperCase();
    if (!countries[k] || rank[c.status]! > rank[countries[k]!.status]!) countries[k] = { status: c.status, detail: c.detail };
  }
  const col = viewer ? viewer.accounts.collection(collectionId) : undefined;
  return {
    version: store.collectionVersion(collectionId), generated_at: new Date().toISOString(), places, categories, cuisines,
    all_cuisines: Object.entries(CUISINES).map(([key, v]) => ({ key, label: v.label, emoji: v.emoji })),
    collection: col && viewer ? { id: col.id, name: col.name, role: viewer.accounts.role(viewer.userId, collectionId) ?? 'member', shared: viewer.accounts.members(collectionId).length > 1, members: viewer.accounts.members(collectionId).length } : undefined,
    country_order: countryOrder(store, viewer?.userId ?? null, collectionId),
    review_count: store.reviewCount(collectionId),
    sync: { connected: st.destinations.length > 0, status: st.destinations.length ? (st.destinations.some((d) => d.status === 'attention') ? 'attention' : st.destinations.some((d) => d.status === 'pending') ? 'pending' : 'ok') : null, countries, destinations: st.destinations, unsorted: st.unsorted },
  };
}
