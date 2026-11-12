/** Normalize for comparison: lowercase, strip diacritics/niqqud, keep letters+digits of any script. */
export function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-֑ͯ-ׇ]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const STOP = new Set(['the', 'a', 'an', 'of', 'at', 'in', 'and', 'de', 'la', 'le', 'el', 'da', 'do', 'del', 'di']);
/** Generic geographic words that mean the same thing across languages/transliterations. */
const SYN: Record<string, string> = {
  nahal: 'wadi', nachal: 'wadi', valley: 'wadi', wady: 'wadi', 'נחל': 'wadi', 'ואדי': 'wadi',
  en: 'ein', ayn: 'ein', ain: 'ein', 'עין': 'ein',
  mt: 'mount', mount: 'mount', har: 'mount', monte: 'mount', 'הר': 'mount',
  falls: 'waterfall', cascade: 'waterfall', cascada: 'waterfall', cascata: 'waterfall', 'מפל': 'waterfall',
  cafe: 'cafe', caffe: 'cafe', coffee: 'cafe',
  praia: 'beach', playa: 'beach', plage: 'beach', 'חוף': 'beach',
  miradouro: 'viewpoint', mirador: 'viewpoint', lookout: 'viewpoint', overlook: 'viewpoint', 'תצפית': 'viewpoint',
  trail: 'trail', path: 'trail', 'שביל': 'trail',
};
export function tokens(s: string): string[] { return norm(s).split(' ').filter((t) => t && !STOP.has(t)).map((t) => SYN[t] ?? t); }

/** Name similarity in [0,1]: max of token Dice and (scaled) containment of the shorter name in the longer. */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0; for (const t of sa) if (sb.has(t)) inter++;
  const dice = (2 * inter) / (sa.size + sb.size);
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let contained = 0; for (const t of small) if (big.has(t)) contained++;
  const containment = contained / small.size;
  // containment only counts if the shorter side is meaningful (≥2 tokens or a long single token)
  // …a complete Chinese/Japanese/Korean name is often one short token ("大船山" inside "大船山 Mount Taisen").
  const one = [...small][0]!;
  const meaningful = small.size >= 2 || one.length >= 5 || (one.length >= 2 && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(one));
  return Math.max(dice, meaningful ? 0.92 * containment : 0);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function truncate(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…'; }

/** "#EinGediHike" -> "Ein Gedi Hike" */
export function splitHashtag(tag: string): string {
  return tag.replace(/^#/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').trim();
}

export function stableHash(s: string): string {
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Words that say WHAT a place is, not WHICH one ("Sushi restaurant", "Main Store", "Lake"). After tokens()/SYN. */
const GENERIC = new Set([
  'restaurant', 'restaurante', 'ristorante', 'cafe', 'bistro', 'brasserie', 'diner', 'eatery', 'kitchen', 'grill', 'bbq', 'steakhouse', 'bar', 'pub', 'izakaya',
  'sushi', 'ramen', 'udon', 'soba', 'yakiniku', 'yakitori', 'tempura', 'omakase', 'pizza', 'pizzeria', 'burger', 'burgers', 'bakery', 'patisserie', 'food', 'foods',
  'japanese', 'italian', 'chinese', 'thai', 'korean', 'indian', 'mexican', 'french', 'seafood', 'vegan', 'dessert', 'desserts', 'tea', 'wine', 'beer', 'cocktail',
  'shop', 'store', 'main', 'branch', 'house', 'hotel', 'hostel', 'inn', 'market', 'mall', 'center', 'centre', 'restaurants', 'floor', 'building', 'bldg',
  'waterfall', 'lake', 'mount', 'mountain', 'peak', 'park', 'beach', 'river', 'gorge', 'wadi', 'trail', 'viewpoint', 'national', 'nature', 'natural', 'reserve',
  'area', 'protected', 'protegida', 'volcano', 'volcan', 'הר', 'געש', 'מפל', 'נחל', 'חוף', 'אגם', 'מסעדה', 'קפה', 'ticket', 'office', 'museum', 'temple', 'shrine', 'church', 'castle', 'garden', 'gardens', 'island', 'village', 'old', 'town', 'city', 'best', 'top', 'new',
]);
const isFloor = (t: string) => /^(\d+f|b\d+|\d+(st|nd|rd|th))$/.test(t);
/** The tokens that identify the place: name minus generic words and floor/branch numbers. */
export function distinctiveTokens(s: string): string[] { return tokens(s).filter((t) => !GENERIC.has(t) && !isFloor(t)); }
/** "Sushi restaurant", "Main Store", "1F" — names that do not identify any particular place. */
export function isGenericName(s: string): boolean { return tokens(s).length > 0 && distinctiveTokens(s).length === 0; }
