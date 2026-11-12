import crypto from 'node:crypto';
import type { Store } from '../db.ts';
import type { Category, PlaceRow } from '../types.ts';
import { CATEGORY_INFO, TRAILHEAD_ICON } from '../categories.ts';
import { displayDate } from '../intake/parse.ts';
import { googleMapsUrl } from '../geo/googlePlaces.ts';
import { imageLabel } from '../intake/inbox.ts';

export interface SnapshotFeature { id: string; name: string; description: string; category: Category; confidence: string; kind: 'point' | 'line'; coords: [number, number][]; data: Record<string, string>; image?: { url: string; label: string } }
export interface Snapshot { features: SnapshotFeature[]; ids: string[]; hash: string; kml: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
/** KML colours are aabbggrr. */
const kmlColor = (rgb: string, alpha = 'ff') => `${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toLowerCase();

export function featureName(p: Pick<PlaceRow, 'name' | 'category' | 'confidence'>): string {
  const e = CATEGORY_INFO[p.category]?.emoji ?? '📌';
  return p.confidence === 'approximate' ? `≈ ${e} ${p.name} (approx.)` : `${e} ${p.name}`;
}

/** Plain-text description, one item per line; toKml turns the lines into <br>-separated HTML. URLs are on their own lines. */
export function describePlace(store: Store, p: PlaceRow): string {
  const info = CATEGORY_INFO[p.category] ?? CATEGORY_INFO.other;
  const links = store.linksForPlace(p.place_id);
  const lines: string[] = [];
  const est = p.source.startsWith('OpenAI estimate') ? p.source.match(/±d+ km/)?.[0] : undefined;
  lines.push(`${info.emoji} ${info.label} · ${p.confidence === 'confirmed' ? '✅ Confirmed location' : est ? `⚠️ APPROXIMATE — estimated by AI from the picture (${est}), not verified` : '⚠️ APPROXIMATE — only the general area is known, not confirmed'}`);
  if (p.locality || p.country) lines.push(`📍 ${[p.locality, p.country].filter((x, i, a) => x && a.indexOf(x) === i).join(', ')}`);
  for (const [i, l] of links.slice(0, 10).entries()) {
    lines.push('');
    if (links.length > 1) lines.push(`Reel ${i + 1} of ${links.length}`);
    lines.push(`🔗 Reel: ${l.url ?? '(no link — shared as media only)'}`);
    lines.push(`📅 Shared: ${displayDate(l.first_shared_at)}`);
    lines.push(`💡 ${l.cue ?? 'No memory cue available (none in the Reel text or your note).'}`);
  }
  if (links.length > 10) lines.push('', `…and ${links.length - 10} more Reels (see the Reel index page).`);
  lines.push('');
  if (p.kind === 'route' && p.trailhead_json) {
    const th = JSON.parse(p.trailhead_json);
    lines.push(`🥾 Trailhead: ${th.lat.toFixed(5)}, ${th.lon.toFixed(5)} — ${th.source}`);
  }
  lines.push(`🗺️ Open in Google Maps: ${googleMapsUrl(p)}`);
  lines.push(`Source: ${p.source.startsWith('OpenStreetMap') ? '© OpenStreetMap contributors (ODbL)' : p.source} · ${p.place_id}`);
  return lines.join('\n');
}

export function buildSnapshot(store: Store, layerName: string): Snapshot {
  const features: SnapshotFeature[] = [];
  for (const p of store.listPlaces()) {
    const links = store.linksForPlace(p.place_id);
    if (!links.length) continue;
    // An approximate area pin steps aside on the map once every Reel that pointed to it has a confirmed exact place
    // (e.g. "≈ <park>" → "<waterfall in the park>"). It stays in the database; nothing is deleted.
    if (p.confidence === 'approximate' && links.every((l: any) => store.linksForReel(l.reel_key).some((x) => x.confidence === 'confirmed' && x.place_id !== p.place_id))) continue;
    const first = links.map((l) => l.first_shared_at).sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
    const data = {
      rm_id: `rm:${p.place_id}`, category: CATEGORY_INFO[p.category]?.label ?? p.category, confidence: p.confidence,
      first_shared: displayDate(first), reel_url: links[0]!.url ?? '', reel_count: String(links.length),
    };
    const description = describePlace(store, p);
    // Pin photo: prefer a frame that shows/names this place over a general Reel preview.
    const withImg = (links as any[]).filter((l) => l.image_url).sort((a, b) => (a.image_kind === 'place' ? 0 : 1) - (b.image_kind === 'place' ? 0 : 1))[0];
    const image = withImg ? { url: withImg.image_url as string, label: imageLabel(withImg) ?? '📸 Reel preview' } : undefined;
    const name = featureName(p);
    if (p.kind === 'route' && p.geometry_json) {
      const lines: [number, number][][] = JSON.parse(p.geometry_json);
      lines.forEach((ln, i) => features.push({ id: i === 0 ? `rm:${p.place_id}` : `rm:${p.place_id}#${i}`, name: i === 0 ? name : `${name} (part ${i + 1})`, description, category: p.category, confidence: p.confidence, kind: 'line', coords: ln, data: { ...data, rm_id: i === 0 ? data.rm_id : `${data.rm_id}#${i}` } }));
      features.push({ id: `rm:${p.place_id}#trailhead`, name: `${name} — trailhead`, description, category: p.category, confidence: p.confidence, kind: 'point', coords: [[p.lon, p.lat]], data: { ...data, rm_id: `rm:${p.place_id}#trailhead` }, image });
    } else {
      features.push({ id: `rm:${p.place_id}`, name, description, category: p.category, confidence: p.confidence, kind: 'point', coords: [[p.lon, p.lat]], data, image });
    }
  }
  features.sort((a, b) => a.id.localeCompare(b.id));
  const kml = toKml(features, layerName);
  const hash = crypto.createHash('sha256').update(kml).digest('hex').slice(0, 16);
  return { features, ids: features.map((f) => f.id), hash, kml };
}

const iconStyle = (icon: number, color: string) =>
  `<Style id="icon-${icon}-${color}"><IconStyle><color>${kmlColor(color)}</color><scale>1</scale><Icon><href>https://www.gstatic.com/mapspro/images/stock/503-wht-blank_maps.png</href></Icon></IconStyle><LabelStyle><scale>0</scale></LabelStyle></Style>`;

/**
 * Description as My Maps keeps it (verified live 2026-11-10): plain newlines are flattened to spaces on import,
 * an HTML <br> survives. The feature id goes on the last line ("ref: rm:…") so it round-trips without ExtendedData.
 */
export function descriptionHtml(f: Pick<SnapshotFeature, 'id' | 'description' | 'image'>): string {
  // One item per row with an empty row between rows (requested on iPhone 2026-11-10); blank source lines are dropped.
  // The photo first: My Maps turns an <img> in the description into a photo on the place card (verified live 2026-11-10).
  const img = f.image ? `<img src="${esc(f.image.url)}" width="400"><br>${esc(f.image.label)}<br><br>` : '';
  return img + [...f.description.split('\n').filter((l) => l.trim()), `ref: ${f.id}`].map(esc).join('<br><br>');
}

/**
 * No <ExtendedData>: with it, My Maps imports the layer as a table, turns <name>/<description> into ordinary data
 * columns and leaves the title empty ("Untitled" on iPhone) — seen live on 2026-11-10.
 */
export function toKml(features: SnapshotFeature[], layerName: string): string {
  const styles = Object.entries(CATEGORY_INFO).map(([cat, i]) => [
    `<!-- ${cat} -->`,
    iconStyle(i.icon, i.color),
    ...(cat === 'hike' ? [iconStyle(TRAILHEAD_ICON, i.color)] : []),
    `<Style id="line-${i.color}-4000"><LineStyle><color>${kmlColor(i.color)}</color><width>4</width></LineStyle></Style>`,
  ].join('\n')).join('\n');
  const pm = features.map((f) => {
    const info = CATEGORY_INFO[f.category];
    const icon = f.id.endsWith('#trailhead') ? TRAILHEAD_ICON : info.icon;
    const style = f.kind === 'line' ? `line-${info.color}-4000` : `icon-${icon}-${info.color}`;
    const geom = f.kind === 'line'
      ? `<LineString><tessellate>1</tessellate><coordinates>${f.coords.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)},0`).join(' ')}</coordinates></LineString>`
      : `<Point><coordinates>${f.coords[0]![0].toFixed(6)},${f.coords[0]![1].toFixed(6)},0</coordinates></Point>`;
    return `<Placemark><name>${esc(f.name)}</name><description>${cdata(descriptionHtml(f))}</description><styleUrl>#${style}</styleUrl>${geom}</Placemark>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>${esc(layerName)}</name>
${styles}
${pm}
</Document>
</kml>
`;
}

export interface RemoteFeature { layer: string; layerIndex?: number; name: string; rmId?: string; description: string; style?: string; geometry: 'point' | 'line' | 'polygon' | 'other' }

const unxml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

/** Parse a My Maps KML export (Document > Folder(layer) > Placemark). Placemarks outside folders get layer "". */
export function parseKml(kml: string): RemoteFeature[] {
  const out: RemoteFeature[] = [];
  const folders = [...kml.matchAll(/<Folder>([\s\S]*?)<\/Folder>/g)];
  const chunks = folders.length ? folders.map((m) => m[1]!) : [kml];
  for (const [layerIndex, ch] of chunks.entries()) {
    const layer = folders.length ? unxml(ch.match(/^\s*<name>([\s\S]*?)<\/name>/)?.[1] ?? '').trim() : '';
    for (const pm of ch.matchAll(/<Placemark[^>]*>([\s\S]*?)<\/Placemark>/g)) {
      const body = pm[1]!;
      const name = unxml(body.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? '').trim();
      const description = unxml(body.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '');
      const rm = description.match(/(?:^|[\s>])ref: (rm:[^\s<]+)/)?.[1] ?? body.match(/<Data name="rm_id">\s*<value>([\s\S]*?)<\/value>/)?.[1] ?? description.match(/\b(rm:[^\s<]+)/)?.[1];
      const style = body.match(/<styleUrl>([\s\S]*?)<\/styleUrl>/)?.[1]?.trim();
      const geometry = /<LineString/.test(body) ? 'line' : /<Point/.test(body) ? 'point' : /<Polygon/.test(body) ? 'polygon' : 'other';
      out.push({ layer, layerIndex, name, rmId: rm ? unxml(rm).trim() : undefined, description, style, geometry });
    }
  }
  return out;
}
