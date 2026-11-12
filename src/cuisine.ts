import type { Store } from './db.ts';
import { nameSimilarity, norm, tokens } from './util/text.ts';

/**
 * Restaurant subtype ("cuisine"). Restaurants stay category `restaurant`; the subtype is an extra, filterable label.
 * Sources, best first: the user's correction › the Google listing's types (most specific wins: yakiniku beats japanese)
 * › the place name › the Reel's own text on lines that name the place. Nothing clear → left unset.
 */
export const CUISINES = {
  japanese:      { label: 'Japanese',              emoji: '🍱' },
  sushi:         { label: 'Sushi & omakase',       emoji: '🍣' },
  yakiniku:      { label: 'Yakiniku',              emoji: '🥩' },
  ramen:         { label: 'Ramen',                 emoji: '🍜' },
  izakaya:       { label: 'Izakaya',               emoji: '🏮' },
  thai:          { label: 'Thai',                  emoji: '🍛' },
  korean:        { label: 'Korean',                emoji: '🥢' },
  chinese:       { label: 'Chinese',               emoji: '🥟' },
  indian:        { label: 'Indian',                emoji: '🫓' },
  vietnamese:    { label: 'Vietnamese',            emoji: '🍲' },
  burgers:       { label: 'Burgers',               emoji: '🍔' },
  italian:       { label: 'Italian',               emoji: '🍝' },
  pizza:         { label: 'Pizza',                 emoji: '🍕' },
  mediterranean: { label: 'Mediterranean',         emoji: '🫒' },
  middle_eastern:{ label: 'Middle Eastern',        emoji: '🧆' },
  mexican:       { label: 'Mexican',               emoji: '🌮' },
  french:        { label: 'French',                emoji: '🥖' },
  spanish:       { label: 'Spanish & tapas',       emoji: '🥘' },
  seafood:       { label: 'Seafood',               emoji: '🦐' },
  steakhouse:    { label: 'Steakhouse',            emoji: '🍖' },
  vegan:         { label: 'Vegan & vegetarian',    emoji: '🥗' },
} as const;
export type Cuisine = keyof typeof CUISINES;
export const isCuisine = (c: unknown): c is Cuisine => typeof c === 'string' && c in CUISINES;

/** Google Places (New) primary/other types → cuisine. Order = specificity (first match wins). */
const GOOGLE: [RegExp, Cuisine][] = [
  [/^yakiniku_restaurant$/, 'yakiniku'], [/^(sushi_restaurant|omakase_restaurant)$/, 'sushi'], [/^ramen_restaurant$/, 'ramen'],
  [/^(japanese_izakaya_restaurant|izakaya_restaurant)$/, 'izakaya'], [/^(hamburger_restaurant|burger_restaurant)$/, 'burgers'],
  [/^pizza_restaurant$/, 'pizza'], [/^korean_barbecue_restaurant$/, 'korean'],
  [/^thai_restaurant$/, 'thai'], [/^korean_restaurant$/, 'korean'], [/^(chinese_restaurant|dim_sum_restaurant|cantonese_restaurant|sichuan_restaurant|chinese_noodle_restaurant|dumpling_restaurant)$/, 'chinese'],
  [/^(indian_restaurant|south_indian_restaurant|north_indian_restaurant)$/, 'indian'], [/^vietnamese_restaurant$/, 'vietnamese'],
  [/^italian_restaurant$/, 'italian'], [/^(lebanese_restaurant|middle_eastern_restaurant|israeli_restaurant|turkish_restaurant|persian_restaurant|falafel_restaurant|shawarma_restaurant|afghani_restaurant)$/, 'middle_eastern'],
  [/^(mediterranean_restaurant|greek_restaurant)$/, 'mediterranean'], [/^(mexican_restaurant|tex_mex_restaurant|taco_restaurant)$/, 'mexican'],
  [/^(french_restaurant|bistro)$/, 'french'], [/^(spanish_restaurant|tapas_restaurant)$/, 'spanish'], [/^(seafood_restaurant|oyster_bar_restaurant|fish_and_chips_restaurant)$/, 'seafood'],
  [/^steak_house$/, 'steakhouse'], [/^(vegan_restaurant|vegetarian_restaurant)$/, 'vegan'],
  [/^(japanese_restaurant|tonkatsu_restaurant|udon_noodle_shop|soba_noodle_shop|tempura_restaurant|japanese_curry_restaurant|kaiseki_restaurant|yakitori_restaurant|okonomiyaki_restaurant|teppanyaki_restaurant)$/, 'japanese'],
];
export function cuisineFromGoogle(types: string[] | null | undefined): Cuisine | null {
  for (const [re, c] of GOOGLE) if ((types ?? []).some((t) => re.test(t))) return c;
  return null;
}

/** Words in a name or caption line → cuisine. Deliberately conservative ("curry" alone is not Indian: Japanese curry). */
const WORDS: [RegExp, Cuisine][] = [
  [/\b(yakiniku|horumon|hormone|wagyu bbq|jingisukan)\b|焼肉|ホルモン/i, 'yakiniku'],
  [/\b(sushi|omakase|sashimi|nigiri)\b|寿司|鮨|すし|おまかせ/i, 'sushi'],
  [/\b(ramen|tsukemen|tonkotsu)\b|ラーメン|らーめん|拉麺/i, 'ramen'],
  [/\b(izakaya)\b|居酒屋/i, 'izakaya'],
  [/\b(burgers?|smash ?burger)\b/i, 'burgers'],
  [/\b(pizza|pizzeria|neapolitan)\b/i, 'pizza'],
  [/\b(thai|pad thai|tom yum|som tam)\b/i, 'thai'],
  [/\b(korean|bibimbap|samgyeopsal|kimchi)\b/i, 'korean'],
  [/\b(chinese|dim sum|dumplings?|xiao ?long ?bao|peking duck|sichuan|cantonese|hot ?pot)\b/i, 'chinese'],
  [/\b(indian|tandoori?|biryani|masala|dosa|naan)\b/i, 'indian'],
  [/\b(vietnamese|pho|banh mi|bún|bun cha)\b/i, 'vietnamese'],
  [/\b(trattoria|osteria|italian|pasta|risotto)\b/i, 'italian'],
  [/\b(lebanese|falafel|hummus|shawarma|israeli|levantine|mezze|persian|turkish|kebab)\b/i, 'middle_eastern'],
  [/\b(mediterranean|greek|souvlaki)\b/i, 'mediterranean'],
  [/\b(mexican|tacos?|taqueria|burritos?)\b/i, 'mexican'],
  [/\b(french|brasserie|bistrot)\b/i, 'french'],
  [/\b(tapas|spanish|paella)\b/i, 'spanish'],
  [/\b(seafood|oysters?|fish market)\b/i, 'seafood'],
  [/\b(steakhouse|steak house|steaks?)\b|ステーキ/i, 'steakhouse'],
  [/\b(vegan|vegetarian|plant[- ]based)\b/i, 'vegan'],
  [/\b(kaiseki|tempura|tonkatsu|udon|soba|yakitori|okonomiyaki|teppanyaki|unagi)\b|天ぷら|とんかつ|うどん|蕎麦|焼き鳥/i, 'japanese'],
];
export function cuisineFromText(text: string): Cuisine | null {
  const hits = new Set<Cuisine>();
  for (const [re, c] of WORDS) if (re.test(text)) hits.add(c);
  if (!hits.size) return null;
  // Japanese is the generic fallback: "Japanese yakiniku" → yakiniku.
  if (hits.size > 1) hits.delete('japanese');
  // Sushi + yakiniku in one line ("sushi & wagyu") is not one subtype.
  return hits.size === 1 ? [...hits][0]! : null;
}

/** Evidence lines that are about THIS place: the line naming it (and the next line, e.g. "📍 Name\nSushi omakase"). */
export function linesAbout(name: string, texts: string[]): string[] {
  const out: string[] = [];
  const nt = tokens(name);
  for (const t of texts) {
    const lines = t.split(/\n+/);
    lines.forEach((l, i) => {
      const lt = tokens(l);
      if (!nt.length || !lt.length) return;
      const shared = nt.filter((x) => lt.includes(x)).length;
      if (shared >= Math.min(2, nt.length) || nameSimilarity(name, l) >= 0.85 || norm(l).includes(norm(name))) { out.push(l); if (lines[i + 1]) out.push(lines[i + 1]!); }
    });
  }
  return out;
}

export function inferCuisine(p: { name: string; category: string; google_types?: string | string[] | null }, evidence: string[] = []): { cuisine: Cuisine; source: 'google' | 'name' | 'reel' } | null {
  if (p.category !== 'restaurant') return null;
  const types = Array.isArray(p.google_types) ? p.google_types : p.google_types ? String(p.google_types).split(',') : [];
  const g = cuisineFromGoogle(types);
  const n = cuisineFromText(p.name);
  // A specific name beats Google's generic "japanese_restaurant" (a "Yakiniku …" restaurant listed as japanese_restaurant),
  // and Google's "izakaya" is a broad label too: "Wagyu Yakiniku Sukiyaki Gotengo" is listed as an izakaya (seen live).
  const lines = linesAbout(p.name, evidence);
  const fromReel = lines.length ? cuisineFromText(lines.join('\n')) : null;
  const weakGoogle = g === 'japanese' || g === 'izakaya';
  const specific = (c: Cuisine | null) => !!c && c !== 'japanese' && c !== g;
  if (g && !(weakGoogle && (specific(n) || specific(fromReel)))) return { cuisine: g, source: 'google' };
  if (n && !(n === 'japanese' && specific(fromReel))) return { cuisine: n, source: 'name' };
  return fromReel ? { cuisine: fromReel, source: 'reel' } : null;
}

/** Fill the subtype where it is unset and the evidence supports one. A user's choice (cuisine_source='user') is never touched. */
export function backfillCuisines(store: Store, evidenceFor: (placeId: string) => string[]): number {
  let n = 0;
  for (const p of store.db.prepare("SELECT place_id, name, category, google_types, cuisine, cuisine_source FROM places WHERE category='restaurant' AND (cuisine IS NULL OR cuisine_source <> 'user')").all() as any[]) {
    const r = inferCuisine(p, evidenceFor(p.place_id));
    if (!r || (p.cuisine === r.cuisine && p.cuisine_source === r.source)) continue;
    store.db.prepare('UPDATE places SET cuisine=?, cuisine_source=?, updated_at=? WHERE place_id=?').run(r.cuisine, r.source, new Date().toISOString(), p.place_id);
    n++;
  }
  return n;
}

/** Google types for pins matched before types were stored: read them from the cached Places responses (free). */
export function backfillGoogleTypes(store: Store): number {
  let n = 0;
  const need = store.db.prepare("SELECT place_id, google_place_id FROM places WHERE google_place_id IS NOT NULL AND google_types IS NULL").all() as any[];
  if (!need.length) return 0;
  const bodies = (store.db.prepare(`SELECT body FROM http_cache WHERE body LIKE '%"types"%'`).all() as any[]).map((r) => r.body as string);
  for (const p of need) {
    for (const b of bodies) {
      if (!b.includes(p.google_place_id)) continue;
      try {
        const j = JSON.parse(b);
        const hit = (j.places ?? [j]).find((x: any) => x.id === p.google_place_id);
        if (hit?.types?.length) { store.db.prepare('UPDATE places SET google_types=? WHERE place_id=?').run(hit.types.join(','), p.place_id); n++; break; }
      } catch { /* not JSON */ }
    }
  }
  return n;
}
