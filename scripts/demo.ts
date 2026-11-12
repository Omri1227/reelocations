#!/usr/bin/env node
/**
 * Local demo with SYNTHETIC data — no Google account, no API keys, no network needed for the data.
 *   npm run demo            → http://127.0.0.1:8090/auth/dev?t=… (open it: you are signed in as "Demo User")
 * Creates data/demo/ (git-ignored) with one collection: well-known public places in 3 countries, three Reels waiting in
 * the Review Queue (one with an Approximate pin and alternatives), one starred and one New place. Map tiles load from openstreetmap.org when online.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { startServer } from '../src/server.ts';
import { applyItem } from '../src/intake/inbox.ts';
import { backfillCuisines } from '../src/cuisine.ts';
import { randomToken } from '../src/accounts.ts';
import { nowIso } from '../src/db.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 8090);
const dataDir = path.join(ROOT, 'data', 'demo');
fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
const cfg = loadConfig({ dataDir, inboxUrl: undefined, inboxToken: undefined, googlePlacesKey: undefined, openaiKey: undefined, anthropicKey: undefined, instagramPageCaption: false, instagramOembed: false, transcribe: 'off', mymapsRealSync: false });
const makeApp = () => createApp(cfg, { media: null, polite: false, fetch: async () => { throw new TypeError('demo: offline'); } });
const app = makeApp();
const s = app.store;

// ---- a user, a collection, a session ----
const user = (s.db.prepare("INSERT INTO users(google_sub,email,name,created_at) VALUES('demo','demo@example.com','Demo User',?) RETURNING id").get(nowIso()) as any).id as number;
const cid = Number(s.db.prepare("INSERT INTO collections(name, owner_user_id, created_at) VALUES('Demo trips', ?, ?)").run(user, nowIso()).lastInsertRowid);
s.db.prepare("INSERT INTO memberships(collection_id,user_id,role,created_at) VALUES(?,?,'owner',?)").run(cid, user, nowIso());

// ---- synthetic Reels and pins (public landmarks; the Reel links are placeholders) ----
type P = { id: string; name: string; category: string; lat: number; lon: number; cc: string; country: string; city: string; types?: string; cue: string; gid?: string; address?: string };
const places: P[] = [
  { id: 'demo:fushimi', name: 'Fushimi Inari Taisha', category: 'temple', lat: 34.9671, lon: 135.7727, cc: 'jp', country: 'Japan', city: 'Kyoto', cue: 'Caption: "the 10,000 torii gates at sunrise"' },
  { id: 'demo:kinkakuji', name: 'Kinkaku-ji', category: 'temple', lat: 35.0394, lon: 135.7292, cc: 'jp', country: 'Japan', city: 'Kyoto', cue: 'Caption: "go before 8 am"' },
  { id: 'demo:ichiran', name: 'Ichiran Shibuya', category: 'restaurant', lat: 35.6617, lon: 139.6998, cc: 'jp', country: 'Japan', city: 'Tokyo', types: 'ramen_restaurant,restaurant', cue: 'Caption: "solo ramen booths"', gid: 'ChIJOWucdKiMGGARbppa4b4CKA8', address: 'ICHIRAN Shibuya, Jinnan 1-22-7, Shibuya, Tokyo, Japan' },
  { id: 'demo:tsukiji', name: 'Tsukiji Outer Market', category: 'market', lat: 35.6655, lon: 139.7707, cc: 'jp', country: 'Japan', city: 'Tokyo', cue: 'Your note: "tamagoyaki stand"' },
  { id: 'demo:braies', name: 'Lago di Braies', category: 'lake', lat: 46.6946, lon: 12.0853, cc: 'it', country: 'Italy', city: 'Braies', cue: 'Caption: "rowing boats at 7 am"' },
  { id: 'demo:seceda', name: 'Seceda', category: 'mountain', lat: 46.6009, lon: 11.7240, cc: 'it', country: 'Italy', city: 'Ortisei', cue: 'Caption: "cable car from Ortisei"' },
  { id: 'demo:skogafoss', name: 'Skógafoss', category: 'waterfall', lat: 63.5321, lon: -19.5114, cc: 'is', country: 'Iceland', city: 'Skógar', cue: 'Caption: "walk behind the rainbow"' },
];
const now = Date.now();
places.forEach((p, i) => {
  const at = new Date(now - (places.length - i) * 86_400_000).toISOString();
  const r = applyItem(s, { id: `demo-${i}`, row: 0, kind: 'share', received_at: at, shared_at: at, text: `https://www.instagram.com/reel/DEMO${i}/` }, { collectionId: cid, userId: user });
  s.upsertPlace({ place_id: p.id, name: p.name, category: p.category as any, kind: 'point', lat: p.lat, lon: p.lon, geometry_json: null, trailhead_json: null, confidence: 'confirmed', source: 'demo', address: null, google_place_id: null, google_types: p.types ?? null } as any);
  s.setLocality(p.id, { country: p.country, country_code: p.cc, locality: p.city, region: null });
  if (p.gid) s.db.prepare('UPDATE places SET google_place_id=?, address=? WHERE place_id=?').run(p.gid, p.address ?? null, p.id);
  s.linkReelPlace({ reel_key: r.reelKey!, place_id: p.id, cue: p.cue, cue_source: 'caption', role: 'featured', decided_by: 'auto' });
  s.setReelResult(r.reelKey!, { status: 'resolved', reason: '1 place(s) confirmed' });
});
s.newSince(user, cid);   // the user starts now: the pins above are not "New"…
// …except the newest one, which arrives after that.
s.db.prepare("UPDATE reel_places SET created_at=? WHERE place_id='demo:skogafoss'").run(new Date(now + 1000).toISOString());
s.setStar(user, cid, 'demo:fushimi', true);
// Two Reels waiting for a person (Review Queue · 2).
for (const [i, why] of [[90, 'no explicit location clue in the available text'], [91, 'only the region "Azores" is known — too large to pin; add the exact place in review']] as const) {
  const r = applyItem(s, { id: `demo-${i}`, row: 0, kind: 'share', received_at: nowIso(), shared_at: nowIso(), text: `https://www.instagram.com/reel/DEMO${i}/` }, { collectionId: cid, userId: user });
  s.setReelResult(r.reelKey!, { status: 'needs_review', reason: why });
}
// A medium-confidence match: saved as an APPROXIMATE pin and kept in the Review Queue with the alternatives.
{
  const at = nowIso();
  const r = applyItem(s, { id: 'demo-92', row: 0, kind: 'share', received_at: at, shared_at: at, text: 'https://www.instagram.com/reel/DEMO92/' }, { collectionId: cid, userId: user });
  const why = 'ambiguous: "Miradouro da Vista do Rei, Sete Cidades" vs "Miradouro do Cerrado das Freiras, Sete Cidades"';
  s.upsertPlace({ place_id: 'demo:vistadorei', name: 'Miradouro da Vista do Rei', category: 'viewpoint' as any, kind: 'point', lat: 37.8414, lon: -25.7905, geometry_json: null, trailhead_json: null, confidence: 'approximate', source: `OpenStreetMap · approximate: ${why}`, address: null, google_place_id: null } as any);
  s.setLocality('demo:vistadorei', { country: 'Portugal', country_code: 'pt', locality: 'Sete Cidades', region: 'Azores' });
  s.linkReelPlace({ reel_key: r.reelKey!, place_id: 'demo:vistadorei', cue: 'Caption: "the twin lakes from above"', cue_source: 'caption', role: 'featured', decided_by: 'auto' });
  const c = (ref: string, name: string, lat: number, lon: number, extra: Record<string, unknown> = {}) => ({ ref, name, displayName: `${name}, Sete Cidades, Azores, Portugal`, lat, lon, category: 'viewpoint' as any, isArea: false, isRoute: false, names: [], clueText: 'Sete Cidades viewpoint', score: 0.66, ...extra });
  s.replaceCandidates(r.reelKey!, [c('confirm:demo:vistadorei', 'Miradouro da Vista do Rei', 37.8414, -25.7905, { confirmsApproxPlaceId: 'demo:vistadorei' }), c('demo:cerrado', 'Miradouro do Cerrado das Freiras', 37.8540, -25.7895, { replacesApproxPlaceId: 'demo:vistadorei' }), c('demo:boca', 'Miradouro da Boca do Inferno', 37.8237, -25.7612)] as any);
  s.setReelResult(r.reelKey!, { status: 'needs_review', reason: `saved as approximate — please check: "Sete Cidades viewpoint": ${why}` });
}
// The demo user also runs this installation, so the AI Balance button shows (no AI calls are made in the demo).
s.db.prepare('UPDATE collections SET owner_user_id=? WHERE id=1').run(user);
s.setKv('openai:balance', JSON.stringify({ usd: 5, at: nowIso(), by: user }));
backfillCuisines(s, () => []);

const token = randomToken();
s.db.prepare('INSERT INTO sessions(token_hash,user_id,collection_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)')
  .run((await import('node:crypto')).createHash('sha256').update(token).digest('hex'), user, cid, nowIso(), new Date(now + 7 * 86_400_000).toISOString(), nowIso());
startServer({ app, makeApp, port, appToken: randomToken(), startWorker: false, googleClientId: '', devSessionToken: token, publicUrl: `http://127.0.0.1:${port}` });
console.log(`reelocations demo (synthetic data in ${path.relative(ROOT, dataDir)})`);
console.log(`Open: http://127.0.0.1:${port}/auth/dev?t=${encodeURIComponent(token)}`);
console.log('Ctrl+C to stop. Nearby: your browser asks for location; the demo places are in Japan, Italy and Iceland.');
