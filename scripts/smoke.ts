/**
 * Reproducible smoke test (no Google/Instagram account needed, no network needed):
 *  - starts the Apps Script inbox emulator (real apps-script/Code.gs) on a local port,
 *  - "shares" Reels exactly like the iPhone Shortcut (HTTP POST) and attaches a screenshot,
 *  - runs one worker cycle (pull → lookup with recorded OSM data → local OCR → status → sync to a fake My Maps layer),
 *  - prints what would appear in Google Maps and writes the KML + phone index page to data/smoke/.
 * Usage: npm run smoke
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { runOnce } from '../src/worker.ts';
import { AppsScriptEmulator, FakeMyMaps, fakeOembed, recordReplayFetch, FIX_DIR } from '../test/support.ts';

const TOKEN = 'smoke-token-0123456789abcdef';
const out = path.resolve('data', 'smoke'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const emu = new AppsScriptEmulator(TOKEN); const url = await emu.listen();
const cfg = loadConfig({ dataDir: out, inboxUrl: url, inboxToken: TOKEN, transcribe: 'off', anthropicKey: undefined, visionMonthlyBudgetUsd: 0, openaiKey: undefined, instagramPageCaption: false, mymapsLayerName: 'Reels (auto)' });
const app = createApp(cfg, {
  fetch: fakeOembed({
    VENUE01: { caption: 'Coffee break in Chiado ☕ 📍 A Brasileira, Lisbon — the oldest café in town' },
    TRAIL01: { caption: 'Sunrise hike on the Nahal David trail in Ein Gedi Nature Reserve. The viewpoint above the waterfall at the end is unreal 🤩' },
    SHOT01: { error: { message: 'The requested resource does not exist', code: 24, subcode: 2207045, title: 'Media Not Found' } },
  })(recordReplayFetch()), polite: false, backoffBaseMs: 1,
});
const map = new FakeMyMaps('Reels (auto)');
const post = async (body: object) => (await fetch(url, { method: 'POST', body: JSON.stringify({ token: TOKEN, ...body }) })).json();

console.log('1) iPhone shares (HTTP POST to the inbox, desktop not involved):');
console.log('  ', await post({ action: 'share', text: 'https://www.instagram.com/reel/VENUE01/?igsh=x', shared_at: '2026-11-01T09:15:00+02:00', note: '📍 A Brasileira, Lisbon — the oldest café in town' }));
// Captions are not read (Meta oEmbed terms), so the place names come from the user's Share note, as on the iPhone.
console.log('  ', await post({ action: 'share', text: 'https://www.instagram.com/reel/TRAIL01/', shared_at: '2026-11-02T06:40:00+02:00', note: 'Sunrise hike on the Nahal David trail in Ein Gedi Nature Reserve. The viewpoint above the waterfall at the end is unreal' }));
console.log('  ', await post({ action: 'share', text: 'https://www.instagram.com/reel/SHOT01/', shared_at: '2026-11-07T10:00:00+02:00' }));
console.log('  ', await post({ action: 'media', data: fs.readFileSync(path.join(FIX_DIR, 'media', 'screenshot-location-tag.png')).toString('base64'), mime: 'image/png', filename: 'IMG_0001.PNG', reel_url: 'https://www.instagram.com/reel/SHOT01/', shared_at: '2026-11-07T10:01:00+02:00' }));

console.log('\n2) Desktop worker cycle:');
const r = await runOnce(app, { sink: map });
for (const [k, v] of Object.entries(r)) if (k !== 'syncOutcome') console.log(`   ${k.padEnd(8)} ${v}`);

console.log('\n3) What the My Maps layer now contains:');
for (const f of map.layers.get('Reels (auto)')!) {
  console.log(`\n   ${f.name}   [${f.geometry}]`);
  for (const l of f.description.split(/(?:<br>)+|\n/)) console.log(`     ${l}`);
}
fs.writeFileSync(path.join(out, 'index.html'), emu.get({ k: TOKEN }));
console.log(`\n4) Files: ${path.join(out, 'sync', 'reel-places-latest.kml')}  and phone index page ${path.join(out, 'index.html')}`);
const ok = r.syncOutcome?.status === 'ok' && map.layers.get('Reels (auto)')!.length >= 4;
console.log(ok ? '\nSMOKE TEST PASSED' : '\nSMOKE TEST FAILED');
await app.close(); await emu.close();
process.exitCode = ok ? 0 : 1;
