/**
 * LOCAL verification only: serve a COPY of a Reel Maps database with a signed-in session for the browser checks
 * (Google's sign-in cannot run in a headless browser). Never used in production.
 *   node scripts/local-ui-server.ts <copy.sqlite> <port>   → prints SESSION=<cookie value>
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { startServer } from '../src/server.ts';
import { backfillCuisines, backfillGoogleTypes } from '../src/cuisine.ts';

const [file, portArg] = process.argv.slice(2);
if (!file) throw new Error('usage: local-ui-server.ts <copy.sqlite> [port]');
const dataDir = path.dirname(path.resolve(file));
if (path.basename(file) !== 'reel-maps.sqlite') fs.copyFileSync(file, path.join(dataDir, 'reel-maps.sqlite'));
const cfg = loadConfig({ dataDir, inboxUrl: undefined, googlePlacesKey: undefined, openaiKey: undefined, anthropicKey: undefined, instagramPageCaption: false, transcribe: 'off' });
const makeApp = () => createApp(cfg, { media: null, polite: false });
const s = startServer({ app: makeApp(), makeApp, port: Number(portArg ?? 18791), appToken: 'local-ui-admin-token-123456', startWorker: false, googleClientId: 'local', verifyIdToken: async () => { throw new Error('local verification server: no Google sign-in'); } });
const a = s.accounts;
backfillGoogleTypes(s.app.store); backfillCuisines(s.app.store, () => []);
const owner = a.upsertUser({ sub: 'local-owner', email: 'owner@local.test', email_verified: true, name: 'Local Owner', picture: null });
// The local copy may already be claimed on Railway; take collection 1 for the check.
s.app.store.db.prepare('UPDATE collections SET owner_user_id=? WHERE id=1').run(owner.id);
s.app.store.db.prepare("INSERT OR REPLACE INTO memberships(collection_id,user_id,role,created_at) VALUES(1,?,'owner',datetime('now'))").run(owner.id);
console.log(`SESSION=${a.createSession(owner.id, 1)}`);
console.log(`listening on http://127.0.0.1:${portArg ?? 18791} (data copy: ${dataDir})`);
