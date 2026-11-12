import type { Category } from './types.ts';

/**
 * One entry per category: readable label, emoji (shown in the place title — the dependable signal everywhere),
 * colour, and `icon` = My Maps stock icon number used in KML style ids as `icon-<number>-<colour>` (My Maps picks the
 * glyph from it). Icon numbers were read from the live My Maps editor on 2026-11-10 (icon file names in comments).
 * Colours group families: water = blues, nature = greens, food & drink = oranges/browns, shopping = purples,
 * culture & history = reds/browns, stay & transport = greys.
 */
export const TRAILHEAD_ICON = 1597; // hiking-trailhead
export const CATEGORY_INFO: Record<Category, { label: string; emoji: string; color: string; icon: number }> = {
  // Water & nature
  waterfall:      { label: 'Waterfall',           emoji: '💦', color: '0288D1', icon: 1892 }, // waterfall
  river:          { label: 'Stream / river',      emoji: '🏞️', color: '0277BD', icon: 1615 }, // kayak
  lake:           { label: 'Lake',                emoji: '🛶', color: '01579B', icon: 1681 }, // sailing-boat
  beach:          { label: 'Beach',               emoji: '🏖️', color: 'FBC02D', icon: 1521 }, // beach
  hot_spring:     { label: 'Hot spring',          emoji: '♨️', color: '00838F', icon: 1811 }, // hotspring-onsen
  viewpoint:      { label: 'Viewpoint',           emoji: '🌄', color: '7B1FA2', icon: 1729 }, // vista
  mountain:       { label: 'Mountain / peak',     emoji: '⛰️', color: '5D4037', icon: 1634 }, // mountain
  cave:           { label: 'Cave',                emoji: '🕳️', color: '4E342E', icon: 1767 }, // cave
  hike:           { label: 'Hiking trail',        emoji: '🥾', color: 'C2185B', icon: 1596 }, // hiking-solo
  park:           { label: 'Park / garden',       emoji: '🌳', color: '388E3C', icon: 1720 }, // tree
  nature_reserve: { label: 'Nature reserve',      emoji: '🌲', color: '1B5E20', icon: 1886 }, // tree-deciduous
  camping:        { label: 'Camping',             emoji: '🏕️', color: '33691E', icon: 1765 }, // camping-tent
  // Culture & history
  architecture:   { label: 'Architecture',        emoji: '🏛️', color: '6D4C41', icon: 1547 }, // city-buildings-pointed
  ruins:          { label: 'Archaeological site / ruins', emoji: '🏺', color: '8D6E63', icon: 1599 }, // historic-monument
  historic:       { label: 'Historic building',   emoji: '🏰', color: 'A1887F', icon: 1598 }, // historic-building
  museum:         { label: 'Museum',              emoji: '🖼️', color: 'AD1457', icon: 1636 }, // museum
  temple:         { label: 'Temple / shrine / church', emoji: '⛩️', color: 'C62828', icon: 1706 }, // temple
  attraction:     { label: 'Attraction',          emoji: '⭐', color: 'F57C00', icon: 1713 }, // ticket-star
  // Food & drink
  cafe:           { label: 'Café',                emoji: '☕', color: '795548', icon: 1534 }, // cafe-cup
  bakery:         { label: 'Bakery',              emoji: '🥐', color: 'A1662F', icon: 1762 }, // cake
  restaurant:     { label: 'Restaurant',          emoji: '🍽️', color: 'E65100', icon: 1577 }, // food-fork-knife
  bar:            { label: 'Bar',                 emoji: '🍸', color: 'BF360C', icon: 1517 }, // bar-cocktail
  market:         { label: 'Market',              emoji: '🧺', color: 'EF6C00', icon: 1578 }, // food-groceries
  // Shopping
  mall:           { label: 'Mall',                emoji: '🛍️', color: '6A1B9A', icon: 1684 }, // shopping-bag
  clothing:       { label: 'Clothing store',      emoji: '👗', color: '8E24AA', icon: 1549 }, // clothing-hanger
  shop:           { label: 'Shop',                emoji: '🏪', color: '9C27B0', icon: 1686 }, // shop
  // Stay & transport
  hotel:          { label: 'Hotel / stay',        emoji: '🛏️', color: '455A64', icon: 1602 }, // hotel-bed
  transport:      { label: 'Station / transport', emoji: '🚉', color: '37474F', icon: 1716 }, // train
  // Broad fallbacks
  area:           { label: 'Area',                emoji: '📍', color: '757575', icon: 1899 }, // plain pin
  other:          { label: 'Place',               emoji: '📌', color: '546E7A', icon: 1899 }, // plain pin
};

/** Areas that can contain a trail (used as context, not saved twice). */
export const NATURE_AREAS: Category[] = ['park', 'nature_reserve'];
export const isNatureArea = (c: Category) => NATURE_AREAS.includes(c);

/**
 * Keyword hints (EN + HE + a few ES/PT/IT/JA romanisations) for clue categories and the Reel-level category.
 * Order matters: the first match wins, so specific types come before broad ones.
 */
export const CATEGORY_KEYWORDS: [Category, RegExp][] = [
  ['hike', /\b(hike|hiking|trail|trek|trekking|loop|trailhead|walk(?:ing)? route|sendero|sentiero|wanderweg|trilha|alpine crossing|great walk|track|circuit|traverse|path of (?:the )?gods)\b|מסלול|שביל|טיול רגלי/i],
  ['waterfall', /\b(waterfall|falls|cascade|cascada|cascata|cachoeira|taki)\b|מפל/i],
  ['hot_spring', /\b(hot springs?|onsen|thermal bath|termas)\b|מעיינות חמים/i],
  ['river', /\b(river|stream|creek|brook|rio|río|wadi|nahal)\b|נחל|נהר/i],
  ['lake', /\b(lake|lagoon|lago|laguna|pond|reservoir)\b|אגם/i],
  ['beach', /\b(beach|bay|cove|shore|playa|praia|plage)\b|חוף/i],
  ['viewpoint', /\b(viewpoint|lookout|overlook|vista|panorama|sunset spot|view point|mirador|miradouro)\b|תצפית/i],
  ['mountain', /\b(mountains?|peak|summit|volcano|volc[aá]n|cerro|monte|montaña|pico|nevado|serran[ií]a|sierras?|cordillera|mountain range|mount|mt)\b|פסגת|הר /i],
  ['cave', /\b(cave|cavern|grotto|cueva|gruta)\b|מערה|מערת/i],
  ['ruins', /\b(ruins?|archa?eological|excavation|ancient city|roman theat(?:re|er)|amphitheat(?:re|er))\b|עתיקות|חורבות/i],
  ['temple', /\b(temple|shrine|church|cathedral|basilica|mosque|synagogue|monastery|abbey|jinja|taisha|pagoda)\b|בית כנסת|מקדש|כנסיית/i],
  ['museum', /\b(museum|gallery|museo|musée)\b|מוזיאון/i],
  ['historic', /\b(castle|palace|fortress|fort|old town|citadel|historic)\b|מבצר|ארמון|טירה/i],
  ['architecture', /\b(architecture|skyscraper|tower|bridge|building)\b|אדריכלות/i],
  ['bakery', /\b(bakery|patisserie|pastry|boulangerie|panaderia|panadería)\b|מאפייה/i],
  ['cafe', /\b(caf[eé]|coffee|espresso|brunch spot|roastery|kissaten)\b|בית קפה|קפה/i],
  ['bar', /\b(bar|pub|cocktails?|wine bar|brewery|izakaya)\b|פאב|בר /i],
  ['restaurant', /\b(restaurant|bistro|eatery|diner|trattoria|pizzeria|ramen|sushi|taqueria|food|dinner|lunch)\b|מסעדה|מסעדת/i],
  ['market', /\b(market|mercado|marché|bazaar|souk)\b|שוק/i],
  ['mall', /\b(mall|shopping cent(?:er|re)|department store|outlet)\b|קניון/i],
  ['clothing', /\b(clothing|boutique|fashion|vintage store|thrift)\b|בגדים|אופנה/i],
  ['hotel', /\b(hotel|hostel|ryokan|resort|guesthouse|airbnb|cabin)\b|מלון|צימר/i],
  ['camping', /\b(camping|campsite|campground)\b|קמפינג|חניון לילה/i],
  ['nature_reserve', /\b(national park|nature reserve|reserve|parque nacional)\b|שמורת|גן לאומי/i],
  ['park', /\b(park|forest|garden|canyon|spring)\b|פארק|יער|עין/i],
];

export function categoryFromText(text: string): Category | undefined {
  for (const [c, re] of CATEGORY_KEYWORDS) if (re.test(text)) return c;
  return undefined;
}

/** Map OSM class/type (Nominatim "category"/"type", or tags) to the taxonomy; broad fallbacks when only that is known.
 *  When the tags only say something generic (a car park, toilets…) the place's NAME decides: the car park at the Hornocal
 *  viewpoint is tagged amenity=parking but named after a mountain range (seen live 2026-11-11). */
export function categoryFromOsm(cls: string | undefined, type: string | undefined, rawTags?: Record<string, string> | null, name?: string): Category {
  const c0 = categoryFromOsmTags(cls, type, rawTags);
  return c0 === 'other' && name ? categoryFromName(name) ?? 'other' : c0;
}

/** Category from a place name alone (only the place-type words; food words like "lunch" do not count). */
export function categoryFromName(name: string): Category | undefined {
  // A name that says what the facility is ("… Car Park", "Parking …") is not a hint about the scenery.
  if (/\b(parking|car ?park|parkplatz|estacionamiento|aparcamiento|toilets?|wc)\b/i.test(name)) return undefined;
  const c = categoryFromText(name);
  // "Path of the Gods", "… Trail": the name itself says it is a walking route.
  return c && (c !== 'hike' || /\b(trail|path|sentiero|sendero|wanderweg|track|crossing|circuit|traverse)\b/i.test(name)) ? c : undefined;
}

function categoryFromOsmTags(cls: string | undefined, type: string | undefined, rawTags?: Record<string, string> | null): Category {
  const tags = rawTags ?? {};
  const c = cls ?? '', t = type ?? '';
  const is = (k: string, re: RegExp) => (c === k && re.test(t)) || (tags[k] !== undefined && re.test(tags[k]));
  if (is('shop', /^(bakery|pastry|confectionery)$/)) return 'bakery';
  if (is('amenity', /^cafe$/) || is('shop', /^coffee$/)) return 'cafe';
  if (is('amenity', /^(bar|pub|biergarten|nightclub)$/) || is('craft', /^(brewery|winery)$/)) return 'bar';
  if (is('amenity', /^(restaurant|fast_food|food_court|ice_cream)$/)) return 'restaurant';
  if (is('amenity', /^marketplace$/) || is('shop', /^(market|greengrocer|farm)$/)) return 'market';
  if (is('shop', /^(mall|department_store)$/)) return 'mall';
  if (is('shop', /^(clothes|shoes|boutique|fashion|fashion_accessories|second_hand|bag|jewelry)$/)) return 'clothing';
  if (t === 'waterfall' || is('waterway', /^waterfall$/) || is('natural', /^waterfall$/)) return 'waterfall';
  if (is('natural', /^hot_spring$/) || is('amenity', /^public_bath$/) || is('bath:type', /onsen|thermal/)) return 'hot_spring';
  if (is('waterway', /^(river|stream|wadi|canal|brook)$/) || is('natural', /^(stream)$/)) return 'river';
  if (is('natural', /^water$/) || is('water', /^(lake|pond|reservoir|lagoon|oxbow)$/)) return 'lake';
  if (is('natural', /^beach$/) || is('leisure', /^beach_resort$/)) return 'beach';
  if (is('tourism', /^viewpoint$/)) return 'viewpoint';
  if (is('natural', /^(peak|volcano|ridge|saddle|mountain_range|cliff)$/)) return 'mountain';
  if (is('natural', /^cave_entrance$/)) return 'cave';
  if ((c === 'route' && /hiking|foot|walking/.test(t)) || (tags.route !== undefined && /hiking|foot/.test(tags.route)) || (c === 'highway' && /^(path|footway|track|trailhead)$/.test(t))) return 'hike';
  if (is('leisure', /^nature_reserve$/) || is('boundary', /^(national_park|protected_area)$/)) return 'nature_reserve';
  if (is('leisure', /^(park|garden)$/) || is('natural', /^(wood|spring|valley|wetland|bay)$/)) return 'park';
  if (is('tourism', /^(camp_site|caravan_site)$/)) return 'camping';
  if (is('historic', /^(archaeological_site|ruins|tomb)$/)) return 'ruins';
  if (is('amenity', /^place_of_worship$/) || is('building', /^(temple|shrine|church|cathedral|mosque|synagogue|chapel|monastery)$/) || is('historic', /^(church|monastery|wayside_shrine)$/)) return 'temple';
  if (is('tourism', /^(museum|gallery)$/)) return 'museum';
  if (is('historic', /^(castle|fort|palace|manor|city_gate|building|monument|memorial|citywalls)$/)) return 'historic';
  if (is('man_made', /^(tower|bridge|lighthouse)$/) || c === 'bridge' || c === 'building' || tags['building:architecture'] !== undefined) return 'architecture';
  if (is('tourism', /^(hotel|hostel|guest_house|motel|apartment|chalet|alpine_hut|wilderness_hut)$/)) return 'hotel';
  if (is('railway', /^(station|halt)$/) || is('public_transport', /^station$/) || is('amenity', /^(bus_station|ferry_terminal)$/) || is('aeroway', /^aerodrome$/)) return 'transport';
  if (c === 'shop') return 'shop';
  if (c === 'tourism' || c === 'historic' || is('amenity', /^(theatre|arts_centre)$/) || is('leisure', /^(theme_park|water_park)$/)) return 'attraction';
  if (c === 'place' || (c === 'boundary' && t === 'administrative')) return 'area';
  return 'other';
}

/** Nominatim results that describe a region rather than a specific spot. */
export function isAreaResult(cls: string | undefined, type: string | undefined, addresstype?: string): boolean {
  if (cls === 'place' && /^(city|town|village|hamlet|suburb|neighbourhood|quarter|region|state|county|province|island|archipelago|locality|municipality|district)$/.test(type ?? '')) return true;
  if (cls === 'boundary' && type === 'administrative') return true;
  if (/^(city|town|village|state|region|county|country|municipality|district|province)$/.test(addresstype ?? '')) return true;
  return false;
}

/** Pins stuck on the generic "other" (e.g. matched to a car park) get the category their name states; nothing else changes. */
export function refineGenericCategories(db: { prepare(sql: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } }): { place_id: string; name: string; category: Category }[] {
  const changed: { place_id: string; name: string; category: Category }[] = [];
  for (const p of db.prepare("SELECT place_id, name FROM places WHERE category='other'").all() as { place_id: string; name: string }[]) {
    const c = categoryFromName(p.name);
    if (!c || c === 'other') continue;
    db.prepare('UPDATE places SET category=?, updated_at=? WHERE place_id=? AND category=?').run(c, new Date().toISOString(), p.place_id, 'other');
    changed.push({ place_id: p.place_id, name: p.name, category: c });
  }
  return changed;
}
