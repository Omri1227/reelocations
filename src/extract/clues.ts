import type { Category, Clue, SourceKind, TextEvidence } from '../types.ts';
import { categoryFromText } from '../categories.ts';
import { norm, splitHashtag } from '../util/text.ts';

const CAP = `[\\p{Lu}][\\p{L}\\p{M}'’&-]*`;                 // Capitalised word (any script with case)
const CONN = '(?:de|del|la|le|du|di|da|do|dos|das|of|the|al|el|y|&)';
const NAME = `${CAP}(?:\\s+(?:${CONN}\\s+)?${CAP}){0,4}`;
const HEB = `[\\u05D0-\\u05EA"'׳״-]+`;

const PLACE_SUFFIX = 'Trail|Trailhead|Loop|Path|Crossing|Track|Circuit|Traverse|Falls|Waterfall|Cascade|Beach|Bay|Cove|Viewpoint|Lookout|Overlook|Park|National Park|Nature Reserve|Reserve|Lake|Canyon|Gorge|Spring|Springs|Peak|Mountain|Mount|Cliffs?|Cave|Forest|Garden|Gardens|Cafe|Café|Coffee|Roasters|Bakery|Restaurant|Bistro|Kitchen|Bar|Market|Pier|Lighthouse|Castle|Fortress|Island|Point|Valley|Ridge|Pools?|Hot Springs';
const PLACE_PREFIX = 'Nahal|Ein|Wadi|Mount|Mt\\.?|Lake|Cape|Har|Lago|Laguna|Lagoa|Lac|Monte|Cerro|Volc[aá]n|Glaciar|Salto|Sentiero|Sendero|Playa|Praia|Cala|Cascada|Cascata|Parque|Café|Cafe|Restaurant|Ristorante|Trattoria|Mirador|Miradouro|Isla|Ilha|Pico';
const HEB_PREFIX = 'נחל|עין|הר|חוף|מפל|שמורת|גן לאומי|בית קפה|קפה|מסעדת|מסעדה|מצפה|תצפית|מערת|ואדי|בריכת|אגם';

const RE_PIN = /^\s*(?:📍|📌|🗺️?|📷\s*@?|location\s*[:\-]|where\s*[:\-]|place\s*[:\-]|address\s*[:\-]|מיקום\s*[:\-]|איפה\s*[:\-]|כתובת\s*[:\-])\s*(.+)$/iu;
const RE_PIN_INLINE = /(?:📍|📌)\s*([^#\n]+)/u;
const RE_TRAIL_AFTER = /^\s+(?:trail|hike|loop|path|trek|route)\b/i;
const RE_LIST = /^\s*(?:\d{1,2}[.)]|[•\-–*▪️◾🔹🔸⭐️✅]|\d️⃣)\s+(.+)$/u;
const RE_SUFFIX = new RegExp(`(${NAME}\\s+(?:${PLACE_SUFFIX}))\\b`, 'gu');
const RE_PREFIX = new RegExp(`\\b((?:${PLACE_PREFIX})\\s+(?:${CONN}\\s+)?${NAME})`, 'gu');
/** A short Title-Case line on screen ("Praia da Ursa, Sintra") is usually a location overlay. */
/** Trailing OCR debris after a location line: short symbol runs, 1–2 digit numbers, dots, dashes. */
export const OCR_TAIL = /(?:\s+[^\p{L}\s]{1,4}|\s+\p{N}{1,2}|\s*\.{2,}|\s+[—–-]+|\s+\p{Ll})+\s*$/u;
const RE_OCR_TAG = /^[\p{Lu}][\p{L}'’-]*(?:\s+[\p{L}'’-]+){0,5}(?:,\s*[\p{Lu}][\p{L}'’ -]+)?$/u;
const RE_HEB = new RegExp(`((?:${HEB_PREFIX})\\s+${HEB}(?:\\s+${HEB})?)`, 'gu');
const RE_IN = new RegExp(`\\b(?:in|near|around|outside|above|below)\\s+(${NAME}(?:,\\s*${NAME})?)`, 'gu');
/**
 * Spanish/Portuguese/Italian "… de/del/en/em/di/da <Two Or More Capitalised Words>" ("40 segundos de Parque Nacional Ejemplo",
 * seen on a real Reel 2026-11-10). Needs ≥2 capitalised words and a lowercase word before the preposition, so names
 * such as "Café de Flore" or "Praia da Ursa" are not split. Yields a non-explicit AREA clue only.
 */
const RE_IN_ROMANCE = new RegExp(`(?<=(?:^|[\\s,(])\\p{Ll}[\\p{L}\\p{M}]*\\s)(?:de|del|en|em|di|da|desde)\\s+(${CAP}(?:\\s+(?:${CONN}\\s+)?${CAP}){1,4})`, 'gu');
const RE_ROUTE_NUM = /\b((?:Route|Trail|Ruta|Rota|Weg|Via|Sentiero|Sendero)\s+\d{1,3}[A-Z]?)\b/gu;
const RE_AT = new RegExp(`\\b(?:at|visit(?:ed|ing)?|went to|called)\\s+(${NAME}(?:,\\s*${NAME})?)`, 'gu');
const RE_VIEW = new RegExp(`\\bview\\s+(?:of|over|to)\\s+(?:the\\s+)?(${NAME})\\s+from\\s+(?:the\\s+)?(${NAME})`, 'u');
const RE_ADDR = /\b(\d{1,5}\s+[\p{L}'.-]+(?:\s+[\p{L}'.-]+){0,3}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Lane|Ln|Way|Dr|Drive)\b\.?(?:,\s*[\p{L} ]+)?)/u;
const RE_HASHTAG = /#([\p{L}\p{N}_]{3,40})/gu;
/** "hike to X", "trek to X" (the destination of a walk). */
const RE_HIKE_TO = new RegExp(`\\b(?:hike|hiking|trek|trekking|walk|climb)\\s+(?:up\\s+)?to\\s+(?:the\\s+)?(${NAME})`, 'giu');
/** A caption that opens with a name: "Angels Landing 🥾 one of the scariest hikes…" (≥2 capitalised words, then an emoji or a dash). */
const RE_LEAD = new RegExp(`^\\s*(${CAP}(?:\\s+(?:${CONN}\\s+)?${CAP}){1,4})\\s*(?:[\\p{Extended_Pictographic}]|[—–:]\\s|-\\s)`, 'u');
/** A price or opening time after a name: menu items and hours ("Drink Bar JPY 380", "Weekdays: 11:30 AM–3:00 PM"). */
const PRICE_OR_TIME = /^\s*(?:[-–—:]\s*)?(?:(?:JPY|USD|EUR|THB|¥|\$|€|£|₪)\s*\d|\d[\d,.]*\s*(?:JPY|yen|円|USD|\$|€)|\d{1,2}:\d{2}|approx\.?\s*(?:¥|\$))/i;
/** "selected from <a fish market>": a supplier or comparison, not a place this Reel features. */
const MENTION_BEFORE = /\b(?:from|by|than|like|unlike|inspired by|similar to|sourced at|imported from)\s+(?:the\s+)?$/i;
/** Street addresses ("1-2-3 Somecho, Higashiyama-ku", "2F Example Bldg, 1-2-3 Namba", "福岡市中央区1-2-3"). */
export const ADDRESS_LIKE = /^\s*\d+[-‐–]\d+|\d+[-‐–]\d+[-‐–]\d+|\b\d+F\b|\bB\d+F?\b|\bBldg\b|\bBuilding\b|\d+-ch[oō]me|丁目|\d+[-‐–]\d+\s*$|[都道府県市区町村]\S*\d+[-‐–]\d+/iu;
/** "Located in the heart of Namba" → "Namba". */
const LEAD_VERB = /^(?:located|situated|found|based|nestled|tucked away)\s+(?:right\s+)?(?:in|at|on|near)\s+(?:the\s+heart\s+of\s+|the\s+middle\s+of\s+|central\s+)?/i;
/** "<prefecture>-<mountain>" → the mountain in that prefecture; "<village>【岐阜】" → the village in 岐阜; "滋賀県【<temple> Temple】" → the bracket is the place. */
function splitCjk(s: string): { text: string; area?: string; alias?: string } | null {
  const pref = s.match(/^\s*([\p{Script=Han}]{1,6}[都道府県])\s*[-ー－・]\s*([^\s,]+)/u);
  if (pref) return { text: clean(pref[2]!.replace(/[\p{Extended_Pictographic}️]+/gu, '')), area: pref[1] };
  const br = s.match(/^\s*([^【]*?)\s*【([^】]+)】\s*(.*)$/u);
  if (!br) return null;
  const [, out, inner, rest] = br as unknown as [string, string, string, string];
  // Latin words after the bracket ("Yamaguchi - Example Shrine", "Example Village - Gifu"): the longest part names the place.
  const latin = rest.split(/\s+[-–—]\s+|,\s*/).map((x) => clean(x)).filter((x) => /\p{Script=Latin}{3}/u.test(x)).sort((a, b) => b.length - a.length)[0];
  if (!out.trim() || /[都道府県市]$/u.test(out.trim()) || /\p{Script=Latin}/u.test(inner) || inner.length > 6) {
    // The bracket holds the place ("滋賀県【<temple> Temple】Shiga").
    const lat = inner.match(/\p{Script=Latin}[\p{L} '’-]+$/u)?.[0]?.trim();
    const cjk = clean(inner.replace(/\p{Script=Latin}[\p{L} '’-]+$/u, ''));
    return { text: lat && cjk ? cjk : clean(inner), area: out.trim() ? clean(out) : undefined, alias: lat && cjk ? lat : latin };
  }
  return { text: clean(out), area: clean(inner), alias: latin };
}

/**
 * A whole sentence after a pin emoji is commentary, not a name ("📌 please save this for later", seen live in Japanese).
 * Japanese/Chinese: polite sentence endings, or a long run that is mostly hiragana (names are kanji/katakana).
 * Latin: six or more words that are mostly lower-case.
 */
export function looksLikeSentence(s: string): boolean {
  const t = s.replace(/[\p{Extended_Pictographic}️\s]+/gu, ' ').trim();
  if (/[\p{Script=Hiragana}\p{Script=Han}\p{Script=Katakana}]/u.test(t)) {
    const hira = (t.match(/\p{Script=Hiragana}/gu) ?? []).length, all = [...t.replace(/\s/g, '')].length;
    if (/(?:です|ます|ました|ません|ください|下さい|でした|ですね|ですよ|しょう)[。！!\s]*$/u.test(t)) return true;
    return all >= 12 && hira / all >= 0.5;
  }
  const words = t.split(/\s+/);
  return words.length >= 6 && words.filter((w) => /^\p{Ll}/u.test(w)).length >= words.length * 0.6;
}
/** A bullet that describes instead of naming: "Their signature tendon", "Our tasting menu". */
const DESCRIBES = /^(?:their|our|its|his|her|your|my|this|these|those)\s/i;

/** Words that look capitalised at sentence start but are not places. */
const NOISE = new Set(['the', 'this', 'that', 'i', 'we', 'my', 'our', 'best', 'top', 'amazing', 'beautiful', 'day', 'sunset', 'sunrise', 'save', 'follow', 'link', 'bio', 'reel', 'reels', 'instagram', 'travel', 'nature', 'hiking', 'hike', 'trip', 'explore', 'wanderlust', 'views', 'weekend', 'summer', 'winter', 'spring break', 'fyp', 'viral', 'trending', 'love', 'tag', 'share', 'comment', 'it', 'here', 'there', 'just', 'one', 'part',
  // caption labels ("📍Address", "⏰Opening Hours") — the value is on the next line
  'address', 'opening hours', 'hours', 'location', 'locations', 'price', 'prices', 'menu', 'reservation', 'reservations', 'website', 'booking', 'contact',
  // Instagram's own interface text that OCR picks up from screenshots
  'add comment', 'add a comment', 'followed by', 'following', 'downloading', 'original audio', 'more', 'see translation', 'liked by', 'send message',
  'located', 'weekdays', 'weekends', 'weekday', 'open', 'closed', 'daily', 'lunch', 'dinner', 'breakfast', 'budget', 'featured course', 'featured dishes', 'what we tried', 'we had', 'price range']);
/** Instagram interface phrases that OCR reads from screenshots; lines containing them are not places. */
const UI_LINE = /\b(not interested|interested|a[il] content|a[il] info|followed by|add comment|see translation|original audio|downloading|liked by|suggested for you|sponsored)\b/i;

const GENERIC_HASHTAGS = /^(travel|nature|hike|hiking|hikingadventures|explore|wanderlust|instagood|photooftheday|reels?|fyp|viral|trending|love|beautiful|view|views|sunset|sunrise|adventure|outdoors|traveltheworld|travelgram|naturelovers|mountains|waterfall|waterfalls|beach|beaches|coffee|cafe|food|foodie|brunch|landscape|travelphotography|igers|vacation|holiday|roadtrip|weekend|summer|winter|israel|usa|europe|italy|spain|greece|thailand|japan)$/i;

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/^[\s,.:;–—-]+|[\s,.:;!?–—-]+$/g, '').replace(/\s*[|•].*$/, '').trim();
}

function meaningful(name: string): boolean {
  const n = norm(name);
  // Two characters are a complete name in Chinese/Japanese/Korean (京都, 奈良); in other scripts they are noise.
  if (n.length < (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(n) ? 2 : 3)) return false;
  const first = n.split(' ')[0];
  if (NOISE.has(n) || (n.split(' ').length === 1 && NOISE.has(first))) return false;
  return true;
}

function splitPlaceArea(s: string): { text: string; area?: string } {
  // "Banias Waterfall, Golan Heights" | "Café Xoho, Tel Aviv — best flat white" | "Blue Lagoon (Comino)"
  // A location tag never continues past a dash/sentence end: drop the commentary first.
  const head = s.split(/\s+[—–|]\s+|\s+-\s+|[.!?](?:\s|$)|\s{2,}/u)[0].replace(/[\p{Extended_Pictographic}️]+/gu, ' ').trim();
  const m = head.match(/^(.+?)\s*(?:,|\(|\bin\b)\s*([^()]+?)\)?$/u);
  // "(2nd Branch)", "(Main Store)", "(B1F)" describe the shop, not an area (seen live in a Tokyo food Reel).
  if (m && /\b(branch|store|shop|floor|main|annex|honten|bekkan|outlet)\b|\d/i.test(m[2]) && head.includes('(')) return { text: clean(m[1]) };
  if (m && meaningful(m[1]) && m[2].trim().length >= 2) return { text: clean(m[1]), area: clean(m[2].split(',')[0]) };
  return { text: clean(head) };
}

export interface ExtractResult { clues: Clue[]; reelCategory?: Category; isHike: boolean }

/**
 * Pull explicit location clues out of free text from several sources. Purely extractive: every clue keeps the
 * exact snippet it came from so the UI and memory cue can quote it.
 */
export function extractClues(evidence: TextEvidence[]): ExtractResult {
  const out = new Map<string, Clue>();
  const add = (c: Omit<Clue, 'sources'> & { source: SourceKind }) => {
    if (!meaningful(c.text)) return;
    // A street address is where a named place is, not a place of its own (it is used as context by the resolver).
    if (c.kind === 'place' && ADDRESS_LIKE.test(c.text)) c = { ...c, kind: 'address' };
    // Same name in two different stated areas = two branches/stops ("Blue Bottle, Kyoto" + "Blue Bottle, Tokyo").
    // Key = name + stated area; a mention without an area merges into the existing clue of that name (and vice versa).
    const base = `${c.kind}|${norm(c.text)}`;
    let key = c.area ? `${base}|${norm(c.area)}` : base;
    if (!c.area) key = [...out.keys()].find((k) => k === base || k.startsWith(`${base}|`)) ?? base;
    else if (!out.has(key) && out.has(base) && !out.get(base)!.area) key = base;
    const cur = out.get(key);
    if (cur) {
      if (!cur.sources.includes(c.source)) cur.sources.push(c.source);
      cur.explicit ||= c.explicit;
      cur.area ??= c.area;
      cur.categoryHint ??= c.categoryHint;
      if (c.aliases?.length) cur.aliases = [...new Set([...(cur.aliases ?? []), ...c.aliases])];
      if (cur.role === 'listed' && c.role === 'featured') cur.role = 'featured';
      return;
    }
    // Drop a shorter clue already contained in a longer explicit one from the same pass ("Banias" vs "Banias Waterfall")
    out.set(key, { kind: c.kind, text: c.text, area: c.area, categoryHint: c.categoryHint, sources: [c.source], explicit: c.explicit, role: c.role, evidence: c.evidence, aliases: c.aliases });
  };

  const allText = evidence.map((e) => e.text).join('\n');
  const reelCategory = categoryFromText(allText);
  const isHike = reelCategory === 'hike' || /\b(hike|hiking|trail|trek|trailhead)\b|מסלול|שביל/i.test(allText);

  for (const ev of evidence) {
    const src = ev.source;
    const lines = ev.text.split(/\r?\n/);
    const vantageTexts = new Set<string>();

    // 0) "view of X from Y": X is the featured place, Y is only where the camera stood.
    const v = ev.text.match(RE_VIEW);
    if (v) {
      add({ kind: 'place', text: clean(v[1]), categoryHint: categoryFromText(v[1]), source: src, explicit: true, role: 'featured', evidence: v[0] });
      add({ kind: 'place', text: clean(v[2]), categoryHint: categoryFromText(v[2]), source: src, explicit: true, role: 'vantage', evidence: v[0] });
      vantageTexts.add(norm(clean(v[2])));
    }

    for (const line of lines) {
      // 1) Explicit location markers: 📍 Name, City / "Location: ..."
      // 【Gion Ushi Akari】: a bracketed name anywhere on a line is the place's own name.
      for (const b of line.matchAll(/【([^】]{3,60})】/gu)) {
        if (/[都道府県]$/u.test(b[1]!) || b[1]!.length <= 4) continue;
        const lat = b[1]!.match(/\p{Script=Latin}[\p{L} '’-]+$/u)?.[0]?.trim(); const cjk = clean(b[1]!.replace(/\p{Script=Latin}[\p{L} '’-]+$/u, ''));
        add({ kind: 'place', text: lat && cjk ? cjk : clean(b[1]!), aliases: lat && cjk ? [lat] : undefined, categoryHint: categoryFromText(b[1]!), source: src, explicit: true, role: 'featured', evidence: line.trim() });
      }
      const pin = line.match(RE_PIN) ?? line.match(RE_PIN_INLINE);
      if (pin) {
        let raw = pin[1].replace(/^\s*(?:location|address|where|place)\s*[:：\-]\s*/i, '');
        // "Located in the heart of Namba—don't miss…" → "Namba" (the commentary after a dash is dropped).
        if (LEAD_VERB.test(raw)) raw = raw.replace(LEAD_VERB, '').split(/\s*[—–]\s*|\s+-\s+/)[0]!;
        const cj = splitCjk(raw);
        if (cj) {
          add({ kind: categoryFromText(cj.alias ?? cj.text) === 'hike' ? 'trail' : 'place', text: cj.text, area: cj.area, aliases: cj.alias ? [cj.alias] : undefined, categoryHint: categoryFromText(raw), source: src, explicit: true, role: 'featured', evidence: line.trim() });
          continue;
        }
        const { text, area } = splitPlaceArea(raw);
        // The name part only: "📍 Lake X — at 3,000 m the yurts are…" keeps "Lake X"; a whole sentence is commentary.
        if (looksLikeSentence(text)) continue;
        const kind = categoryFromText(text) === 'hike' ? 'trail' : 'place';
        add({ kind, text, area, categoryHint: categoryFromText(pin[1]), source: src, explicit: true, role: 'featured', evidence: line.trim() });
        if (area && meaningful(area)) add({ kind: 'area', text: area, source: src, explicit: true, role: 'featured', evidence: line.trim() });
        continue;
      }
      // 1b) On-screen location overlays (OCR only). OCR often appends icon debris ("Ladakh, India == —", seen live).
      if (src === 'ocr' && UI_LINE.test(line)) continue;
      const ocrLine = src === 'ocr' ? line.trim().replace(OCR_TAIL, '') : line.trim();
      if (src === 'ocr' && RE_OCR_TAG.test(ocrLine)) {
        const words = ocrLine.split(/\s+/);
        const capitalised = words.filter((w) => /^\p{Lu}/u.test(w)).length;
        if (words.length >= 2 && capitalised >= Math.ceil(words.length / 2)) {
          const { text, area } = splitPlaceArea(ocrLine);
          add({ kind: categoryFromText(text) === 'hike' ? 'trail' : 'place', text, area, categoryHint: categoryFromText(text), source: src, explicit: true, role: 'featured', evidence: ocrLine });
          if (area && meaningful(area)) add({ kind: 'area', text: area, source: src, explicit: true, role: 'featured', evidence: ocrLine });
          continue;
        }
      }
      // 2) Lists "1. Place – description" (multi-place Reels)
      const li = line.match(RE_LIST);
      if (li) {
        const head = clean(li[1].split(/\s+[–—:-]\s+|:\s/u)[0]);
        const rest = li[1].slice(li[1].indexOf(head) + head.length);
        // A menu item, opening hours or a feature bullet ("Traditional ryokan stay with tatami rooms") is not a place.
        const lower = head.split(/\s+/).filter((w) => /^\p{Ll}/u.test(w) && !/^(de|del|la|le|du|di|da|do|dos|das|of|the|al|el|y|and|des|degli|dei)$/i.test(w)).length;
        if (PRICE_OR_TIME.test(rest) || lower >= 2 || DESCRIBES.test(head)) continue;
        // Scripts without capital letters (Japanese, Chinese, Korean, Thai, Arabic): a short item that is not a sentence.
        const caseless = /^[\p{Lo}\p{N}\s・ー·-]{2,14}$/u.test(head) && !looksLikeSentence(head) && !/[\p{Script=Hiragana}]{3}/u.test(head);
        if (head && head.split(' ').length <= 7 && (/\p{Lu}|[א-ת]/u.test(head) || caseless)) {
          const { text, area } = splitPlaceArea(head);
          add({ kind: categoryFromText(text) === 'hike' ? 'trail' : 'place', text, area, categoryHint: categoryFromText(li[1]), source: src, explicit: true, role: 'listed', evidence: line.trim() });
          continue;
        }
      }
    }

    // 3) Named-feature patterns anywhere in the text
    for (const re of [RE_SUFFIX, RE_PREFIX, RE_HEB]) {
      re.lastIndex = 0;
      for (const m of ev.text.matchAll(re)) {
        const t = clean(m[1]).replace(/^(?:the|a|at|in|to|from|visit|visited)\s+/i, '');
        if (vantageTexts.has(norm(t))) continue;
        const after = ev.text.slice((m.index ?? 0) + m[0].length);
        if (PRICE_OR_TIME.test(after) || MENTION_BEFORE.test(ev.text.slice(Math.max(0, (m.index ?? 0) - 30), m.index ?? 0))) continue;
        const cat = RE_TRAIL_AFTER.test(after) ? 'hike' : categoryFromText(t);
        add({ kind: cat === 'hike' ? 'trail' : 'place', text: t, categoryHint: cat, source: src, explicit: false, role: 'featured', evidence: sentenceAround(ev.text, m.index ?? 0) });
      }
    }
    // 4) "at X" (venue) and "in X" (area)
    for (const m of ev.text.matchAll(RE_AT)) {
      const { text: t, area } = splitPlaceArea(clean(m[1]!));
      if (vantageTexts.has(norm(t))) continue;
      const evidence = sentenceAround(ev.text, m.index ?? 0);
      // "at X" names a venue; borrow a category from its own sentence ("... coffee at X") when X itself has none.
      add({ kind: 'place', text: t, area, categoryHint: categoryFromText(t) ?? categoryFromText(evidence), source: src, explicit: false, role: 'featured', evidence });
      if (area && meaningful(area)) add({ kind: 'area', text: area, source: src, explicit: false, role: 'featured', evidence });
    }
    for (const m of ev.text.matchAll(RE_HIKE_TO)) {
      const t = clean(m[1]!);
      add({ kind: 'place', text: t, categoryHint: categoryFromText(t) ?? 'hike', source: src, explicit: false, role: 'featured', evidence: sentenceAround(ev.text, m.index ?? 0) });
    }
    if (src === 'caption' || src === 'note') {
      const lead = ev.text.match(RE_LEAD);
      if (lead && lead[1]!.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w)).length >= 2) {
        const t = clean(lead[1]!); const first = ev.text.split(/\n/)[0]!;
        add({ kind: categoryFromText(first) === 'hike' ? 'trail' : 'place', text: t, categoryHint: categoryFromText(t) ?? categoryFromText(first), source: src, explicit: false, role: 'featured', evidence: first.trim() });
      }
    }
    for (const m of ev.text.matchAll(RE_IN)) {
      add({ kind: 'area', text: clean(m[1]), source: src, explicit: false, role: 'featured', evidence: sentenceAround(ev.text, m.index ?? 0) });
    }
    // Numbered hiking routes ("along Route 66" in a Liechtenstein hiking Reel) — only in a hiking context, so a
    // highway mentioned in a city Reel does not become a trail.
    if (isHike) for (const m of ev.text.matchAll(RE_ROUTE_NUM)) {
      add({ kind: 'trail', text: clean(m[1]!), categoryHint: 'hike', source: src, explicit: false, role: 'featured', evidence: sentenceAround(ev.text, m.index ?? 0) });
    }
    for (const m of ev.text.matchAll(RE_IN_ROMANCE)) {
      add({ kind: 'area', text: clean(m[1]), source: src, explicit: false, role: 'featured', evidence: sentenceAround(ev.text, m.index ?? 0) });
    }
    const addr = ev.text.match(RE_ADDR);
    if (addr) add({ kind: 'address', text: clean(addr[1]), source: src, explicit: true, role: 'featured', evidence: addr[0] });

    // 5) Hashtags are weak: only specific (non-generic) tags, used as area/place hints
    for (const m of ev.text.matchAll(RE_HASHTAG)) {
      if (GENERIC_HASHTAGS.test(m[1])) continue;
      const t = splitHashtag(m[1]);
      if (t.split(' ').length >= 2 || /\p{Lu}/u.test(m[1].slice(1))) add({ kind: 'area', text: t, source: src, explicit: false, role: 'featured', evidence: m[0] });
    }
  }

  // Remove clues subsumed by a longer clue of the same kind ("Banias" when "Banias Waterfall" exists).
  const clues = [...out.values()];
  const keep = clues.filter((c) => !clues.some((o) => o !== c && o.kind !== 'area' && c.kind !== 'area' && norm(o.text).length > norm(c.text).length && ` ${norm(o.text)} `.includes(` ${norm(c.text)} `)));
  // Area clues that duplicate a place clue are not areas.
  const placeNames = new Set(keep.filter((c) => c.kind !== 'area').map((c) => norm(c.text)));
  const final = keep.filter((c) => !(c.kind === 'area' && placeNames.has(norm(c.text))));
  final.sort((a, b) => score(b) - score(a));
  return { clues: final, reelCategory, isHike };
}

function score(c: Clue): number {
  return (c.explicit ? 4 : 0) + c.sources.length + (c.kind === 'area' ? -2 : 0) + (c.role === 'vantage' ? -3 : 0) + (c.sources.every((s) => s === 'vision') ? -3 : 0);
}

export function sentenceAround(text: string, idx: number): string {
  const start = Math.max(text.lastIndexOf('\n', idx), Math.max(text.lastIndexOf('. ', idx), text.lastIndexOf('! ', idx)) + 1, 0);
  const endCandidates = [text.indexOf('\n', idx), text.indexOf('. ', idx), text.indexOf('! ', idx)].filter((n) => n >= 0);
  const end = endCandidates.length ? Math.min(...endCandidates) + 1 : text.length;
  return text.slice(start, end).trim();
}
