import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Store } from './db.ts';
import { nowIso } from './db.ts';
import { removeSessionFiles } from './sync/gmapsBrowser.ts';

/**
 * Accounts, collections, sessions, invitations, pairing codes and revocable credentials.
 *
 * - Sign-in is Google Sign-In only: the browser gets a Google-signed ID token on Google's own screen; the server
 *   verifies its RS256 signature against Google's published keys (aud = our OAuth client id). No password is ever seen.
 * - Every secret we hand out (session, invitation, pairing code, intake/publisher credential) is random and stored only
 *   as a SHA-256 hash, so a database copy cannot be replayed.
 *
 * Roles (per collection):
 *   owner  — invite / remove members, delete any pin, disconnect any map destination of the collection, rename.
 *   member — contribute Reels, delete pins that only they contributed, connect/disconnect their OWN destination.
 */
export type Role = 'owner' | 'member';
export interface User { id: number; google_sub: string; email: string | null; name: string | null; picture: string | null }
export interface Collection { id: number; name: string; owner_user_id: number | null; role?: Role }

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
/** Human-typable code (no 0/O/1/I/L): 8 characters ≈ 40 bits, single use, short-lived. */
export function humanCode(len = 8): string {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len), (b) => A[b % A.length]).join('');
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

// ---------------------------------------------------------------------------------------------------------------
// Google ID token verification
// ---------------------------------------------------------------------------------------------------------------
export interface GoogleIdentity { sub: string; email: string | null; email_verified: boolean; name: string | null; picture: string | null }
type Jwk = crypto.JsonWebKey & { kid: string };
let jwksCache: { at: number; keys: Jwk[] } | null = null;

export async function googleJwks(fetchFn: typeof fetch = fetch): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetchFn('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error(`Google keys unavailable (HTTP ${r.status})`);
  const j = (await r.json()) as { keys: Jwk[] };
  jwksCache = { at: Date.now(), keys: j.keys };
  return j.keys;
}

export async function verifyGoogleIdToken(idToken: string, clientId: string, getKeys: () => Promise<Jwk[]> = () => googleJwks()): Promise<GoogleIdentity> {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, sig] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('unexpected algorithm');
  const key = (await getKeys()).find((k) => k.kid === header.kid);
  if (!key) throw new Error('unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('bad signature');
  const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  if (c.iss !== 'accounts.google.com' && c.iss !== 'https://accounts.google.com') throw new Error('wrong issuer');
  if (c.aud !== clientId) throw new Error('token is for another app');
  const now = Math.floor(Date.now() / 1000);
  if (typeof c.exp !== 'number' || c.exp < now - 30) throw new Error('token expired');
  if (typeof c.iat === 'number' && c.iat > now + 300) throw new Error('token from the future');
  if (!c.sub) throw new Error('no subject');
  return { sub: String(c.sub), email: c.email ?? null, email_verified: c.email_verified === true || c.email_verified === 'true', name: c.name ?? null, picture: c.picture ?? null };
}

// ---------------------------------------------------------------------------------------------------------------
export class Accounts {
  store: Store;
  constructor(store: Store) { this.store = store; }
  private get db() { return this.store.db; }

  // ---------- users & sessions ----------
  upsertUser(g: GoogleIdentity): User {
    const ts = nowIso();
    this.db.prepare(`INSERT INTO users(google_sub,email,name,picture,created_at,last_login_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email, name=excluded.name, picture=excluded.picture, last_login_at=excluded.last_login_at`)
      .run(g.sub, g.email, g.name, g.picture, ts, ts);
    return this.db.prepare('SELECT id, google_sub, email, name, picture FROM users WHERE google_sub=?').get(g.sub) as any;
  }
  user(id: number): User | undefined { return this.db.prepare('SELECT id, google_sub, email, name, picture FROM users WHERE id=?').get(id) as any; }

  createSession(userId: number, collectionId: number | null, days = 180): string {
    const token = randomToken();
    this.db.prepare('INSERT INTO sessions(token_hash,user_id,collection_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)').run(sha256(token), userId, collectionId, nowIso(), inDays(days), nowIso());
    return token;
  }
  /** Valid session → user + active collection (sliding 180-day expiry, refreshed at most daily). */
  session(token: string | undefined): { user: User; collectionId: number | null; tokenHash: string } | null {
    if (!token) return null;
    const th = sha256(token);
    const s = this.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(th) as any;
    if (!s || s.expires_at < nowIso()) return null;
    const user = this.user(s.user_id); if (!user) return null;
    if (!s.last_seen_at || Date.now() - Date.parse(s.last_seen_at) > 86_400_000) this.db.prepare('UPDATE sessions SET last_seen_at=?, expires_at=? WHERE token_hash=?').run(nowIso(), inDays(180), th);
    let cid: number | null = s.collection_id;
    if (cid == null || !this.role(user.id, cid)) { cid = this.collectionsOf(user.id)[0]?.id ?? null; this.db.prepare('UPDATE sessions SET collection_id=? WHERE token_hash=?').run(cid, th); }
    return { user, collectionId: cid, tokenHash: th };
  }
  setSessionCollection(tokenHash: string, userId: number, collectionId: number) {
    if (!this.role(userId, collectionId)) throw Object.assign(new Error('not a member of that collection'), { status: 403 });
    this.db.prepare('UPDATE sessions SET collection_id=? WHERE token_hash=?').run(collectionId, tokenHash);
  }
  endSession(tokenHash: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash); }

  // ---------- collections ----------
  createCollection(ownerId: number, name: string): Collection {
    const id = Number(this.db.prepare('INSERT INTO collections(name, owner_user_id, created_at) VALUES(?,?,?)').run(name.slice(0, 80), ownerId, nowIso()).lastInsertRowid);
    this.db.prepare('INSERT INTO memberships(collection_id,user_id,role,created_at) VALUES(?,?,?,?)').run(id, ownerId, 'owner', nowIso());
    return { id, name, owner_user_id: ownerId, role: 'owner' };
  }
  collection(id: number): Collection | undefined { return this.db.prepare('SELECT id, name, owner_user_id FROM collections WHERE id=?').get(id) as any; }
  collectionsOf(userId: number): Collection[] {
    return this.db.prepare('SELECT c.id, c.name, c.owner_user_id, m.role FROM memberships m JOIN collections c ON c.id=m.collection_id WHERE m.user_id=? ORDER BY m.created_at').all(userId) as any;
  }
  role(userId: number, collectionId: number): Role | null { return ((this.db.prepare('SELECT role FROM memberships WHERE user_id=? AND collection_id=?').get(userId, collectionId) as any)?.role ?? null) as Role | null; }
  members(collectionId: number) {
    return this.db.prepare('SELECT u.id, u.email, u.name, u.picture, m.role, m.created_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.collection_id=? ORDER BY m.role DESC, m.created_at').all(collectionId) as any[];
  }
  /** Throws 403 unless the user has (at least) the given role in the collection. */
  require(userId: number, collectionId: number, need: Role | 'any' = 'any'): Role {
    const r = this.role(userId, collectionId);
    if (!r || (need === 'owner' && r !== 'owner')) throw Object.assign(new Error(need === 'owner' ? 'only the collection owner can do that' : 'not a member of this collection'), { status: 403 });
    return r;
  }
  removeMember(ownerId: number, collectionId: number, userId: number) {
    this.require(ownerId, collectionId, 'owner');
    if (userId === ownerId) throw Object.assign(new Error('the owner cannot leave their own collection'), { status: 400 });
    this.db.prepare('DELETE FROM memberships WHERE collection_id=? AND user_id=?').run(collectionId, userId);
    // Their credentials for this collection stop working at once; their own map destination is disconnected.
    this.db.prepare('UPDATE credentials SET revoked_at=? WHERE collection_id=? AND user_id=? AND revoked_at IS NULL').run(nowIso(), collectionId, userId);
    this.db.prepare('UPDATE destinations SET disconnected_at=? WHERE collection_id=? AND user_id=? AND disconnected_at IS NULL').run(nowIso(), collectionId, userId);
    this.dropGmapsOf(userId, collectionId);
    // The invitation they joined with must not let them back in.
    this.db.prepare('UPDATE invitations SET revoked_at=COALESCE(revoked_at, ?) WHERE collection_id=? AND used_by=?').run(nowIso(), collectionId, userId);
  }
  /** The collection's Google Maps list is saved with ONE member's Google session: when that member goes, it stops and the session is deleted. */
  private dropGmapsOf(userId: number, collectionId: number) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gmaps_destinations'").get()) return;
    for (const d of this.db.prepare('SELECT id, state_file FROM gmaps_destinations WHERE collection_id=? AND user_id=? AND disconnected_at IS NULL').all(collectionId, userId) as any[]) {
      removeSessionFiles(d.state_file);
      this.db.prepare("UPDATE gmaps_destinations SET disconnected_at=?, status='disconnected' WHERE id=?").run(nowIso(), d.id);
    }
  }

  /**
   * A member leaves a collection they joined. Their access ends at once (membership, Shortcut/publisher credentials,
   * map destination); their personal state there (stars, New, country order) is removed. Pins they added stay in the
   * collection: they are the collection's content.
   */
  leaveCollection(userId: number, collectionId: number) {
    const r = this.role(userId, collectionId);
    if (!r) throw Object.assign(new Error('not a member of this collection'), { status: 403 });
    if (r === 'owner') throw Object.assign(new Error('the owner cannot leave their own collection (delete your account instead)'), { status: 400 });
    this.store.tx(() => this.detach(userId, collectionId));
    this.store.log('info', 'accounts', `user ${userId} left collection ${collectionId}`);
  }
  private detach(userId: number, collectionId: number) {
    const ts = nowIso();
    this.db.prepare('DELETE FROM memberships WHERE collection_id=? AND user_id=?').run(collectionId, userId);
    this.db.prepare('UPDATE credentials SET revoked_at=COALESCE(revoked_at, ?) WHERE collection_id=? AND user_id=?').run(ts, collectionId, userId);
    this.db.prepare('UPDATE destinations SET disconnected_at=COALESCE(disconnected_at, ?) WHERE collection_id=? AND user_id=?').run(ts, collectionId, userId);
    this.dropGmapsOf(userId, collectionId);
    this.db.prepare('UPDATE invitations SET revoked_at=COALESCE(revoked_at, ?) WHERE collection_id=? AND used_by=?').run(ts, collectionId, userId);
    this.db.prepare('UPDATE sessions SET collection_id=NULL WHERE user_id=? AND collection_id=?').run(userId, collectionId);
    this.db.prepare('DELETE FROM user_place_state WHERE user_id=? AND collection_id=?').run(userId, collectionId);
    this.db.prepare('DELETE FROM user_collection_state WHERE user_id=? AND collection_id=?').run(userId, collectionId);
    this.db.prepare('DELETE FROM kv WHERE k=?').run(`country_order:${userId}:${collectionId}`);
  }

  /**
   * Delete a user's account and personal data.
   * - Collections they joined: they leave them; the pins they added stay, no longer attributed to them.
   * - Collections they own with other members: ownership passes to the longest-standing member; the pins stay.
   * - Collections they own alone: deleted with their Reels, pins and screenshots.
   * Returns what happened, for the confirmation message.
   */
  deleteAccount(userId: number): { left: number; transferred: number; deleted: number } {
    if (!this.user(userId)) throw Object.assign(new Error('no such account'), { status: 404 });
    const out = { left: 0, transferred: 0, deleted: 0 };
    const files: string[] = [];
    this.store.tx(() => {
      for (const c of this.collectionsOf(userId)) {
        if (c.role !== 'owner') { this.detach(userId, c.id); out.left++; continue; }
        const next = this.db.prepare('SELECT user_id FROM memberships WHERE collection_id=? AND user_id<>? ORDER BY created_at, user_id LIMIT 1').get(c.id, userId) as any;
        if (next) {
          this.db.prepare("UPDATE memberships SET role='owner' WHERE collection_id=? AND user_id=?").run(c.id, next.user_id);
          this.db.prepare('UPDATE collections SET owner_user_id=? WHERE id=?').run(next.user_id, c.id);
          this.detach(userId, c.id); out.transferred++;
        } else {
          files.push(...this.store.deleteCollectionData(c.id)); out.deleted++;
        }
      }
      // Attribution in collections that keep the pins.
      this.db.prepare('UPDATE reels SET contributed_by=NULL WHERE contributed_by=?').run(userId);
      this.db.prepare('UPDATE shares SET user_id=NULL WHERE user_id=?').run(userId);
      this.db.prepare('UPDATE tombstones SET deleted_by=NULL WHERE deleted_by=?').run(userId);
      this.db.prepare('UPDATE collection_place_cuisine SET set_by=NULL WHERE set_by=?').run(userId);
      this.db.prepare('UPDATE invitations SET used_by=NULL WHERE used_by=?').run(userId);
      this.db.prepare('DELETE FROM invitations WHERE created_by=?').run(userId);
      // Everything personal.
      for (const id of (this.db.prepare('SELECT id FROM destinations WHERE user_id=?').all(userId) as any[]).map((d) => d.id)) this.db.prepare('DELETE FROM destination_maps WHERE destination_id=?').run(id);
      this.db.prepare('DELETE FROM destinations WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM credentials WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM pairing_codes WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM user_place_state WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM user_collection_state WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM kv WHERE k LIKE ?').run(`country_order:${userId}:%`);
      this.db.prepare('DELETE FROM users WHERE id=?').run(userId);
    });
    for (const f of files) {
      try { fs.rmSync(f, { force: true }); } catch { /* already gone */ }
      if (/session-\d+\.json$/.test(f)) removeSessionFiles(f); // a Google Maps session: its browser profile too
    }
    this.store.log('info', 'accounts', `account ${userId} deleted (left ${out.left}, ownership passed on ${out.transferred}, collections deleted ${out.deleted})`);
    return out;
  }

  /** One-time takeover of the pre-accounts collection #1 by whoever proves knowledge of the legacy admin token. */
  claimLegacy(userId: number, presented: string | undefined, legacyToken: string | undefined): boolean {
    if (!presented || !legacyToken || presented.length !== legacyToken.length || !crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(legacyToken))) return false;
    const c = this.collection(1);
    if (!c || c.owner_user_id != null) return c?.owner_user_id === userId;
    this.store.tx(() => {
      this.db.prepare('UPDATE collections SET owner_user_id=? WHERE id=1 AND owner_user_id IS NULL').run(userId);
      this.db.prepare("INSERT OR IGNORE INTO memberships(collection_id,user_id,role,created_at) VALUES(1,?,'owner',?)").run(userId, nowIso());
      // Reels shared before accounts existed were all the owner's.
      this.db.prepare('UPDATE reels SET contributed_by=? WHERE collection_id=1 AND contributed_by IS NULL').run(userId);
      this.db.prepare("UPDATE shares SET user_id=? WHERE user_id IS NULL AND reel_key IN (SELECT reel_key FROM reels WHERE collection_id=1)").run(userId);
    });
    this.store.log('info', 'accounts', `collection 1 claimed by user ${userId}`);
    return true;
  }

  // ---------- invitations ----------
  createInvitation(ownerId: number, collectionId: number, days = 7): string {
    this.require(ownerId, collectionId, 'owner');
    const code = humanCode(10);
    this.db.prepare('INSERT INTO invitations(code_hash,collection_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?)').run(sha256(normCode(code)), collectionId, ownerId, nowIso(), inDays(days));
    return code;
  }
  /** Single use; joins as member. Returns the collection id. */
  acceptInvitation(userId: number, code: string): number {
    const h = sha256(normCode(code));
    return this.store.tx(() => {
      const inv = this.db.prepare('SELECT * FROM invitations WHERE code_hash=?').get(h) as any;
      if (!inv || inv.revoked_at || inv.expires_at < nowIso()) throw Object.assign(new Error('this invitation is not valid (expired or revoked)'), { status: 400 });
      // Single use: the person who used it may open the link again while still a member; nobody joins with it twice.
      if ((inv.used_by && inv.used_by !== userId) || (inv.used_at && !this.role(userId, inv.collection_id))) throw Object.assign(new Error('this invitation was already used'), { status: 400 });
      if (!this.role(userId, inv.collection_id)) this.db.prepare("INSERT INTO memberships(collection_id,user_id,role,created_at) VALUES(?,?,'member',?)").run(inv.collection_id, userId, nowIso());
      this.db.prepare('UPDATE invitations SET used_by=?, used_at=COALESCE(used_at, ?) WHERE code_hash=?').run(userId, nowIso(), h);
      return Number(inv.collection_id);
    });
  }

  // ---------- pairing codes & credentials ----------
  /** Short-lived single-use code the user types once (Shortcut or desktop publisher) to receive a revocable credential. */
  createPairingCode(userId: number, collectionId: number, kind: 'intake' | 'publisher' | 'gmaps', minutes = 10): { code: string; expires_at: string } {
    this.require(userId, collectionId);
    const code = humanCode(8); const expires_at = inMinutes(minutes);
    this.db.prepare('INSERT INTO pairing_codes(code_hash,kind,user_id,collection_id,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(sha256(normCode(code)), kind, userId, collectionId, nowIso(), expires_at);
    return { code, expires_at };
  }
  redeemPairingCode(code: string, kind: 'intake' | 'publisher' | 'gmaps', label: string): { token: string; credentialId: number; userId: number; collectionId: number } {
    const h = sha256(normCode(code));
    return this.store.tx(() => {
      const pc = this.db.prepare('SELECT * FROM pairing_codes WHERE code_hash=?').get(h) as any;
      if (!pc || pc.kind !== kind || pc.used_at || pc.expires_at < nowIso()) throw Object.assign(new Error('this code is not valid (wrong, expired or already used) — create a new one on the website'), { status: 400 });
      if (!this.role(pc.user_id, pc.collection_id)) throw Object.assign(new Error('no longer a member of that collection'), { status: 403 });
      const token = randomToken();
      const id = Number(this.db.prepare('INSERT INTO credentials(kind,token_hash,user_id,collection_id,label,created_at) VALUES(?,?,?,?,?,?)').run(kind, sha256(token), pc.user_id, pc.collection_id, label.slice(0, 60), nowIso()).lastInsertRowid);
      this.db.prepare('UPDATE pairing_codes SET used_at=?, credential_id=? WHERE code_hash=?').run(nowIso(), id, h);
      return { token, credentialId: id, userId: pc.user_id, collectionId: pc.collection_id };
    });
  }
  /** A credential for the Shortcut set up directly from a signed-in page ("copy my intake link"). */
  issueCredential(userId: number, collectionId: number, kind: 'intake' | 'publisher' | 'gmaps', label: string): { token: string; credentialId: number } {
    this.require(userId, collectionId);
    const token = randomToken();
    const id = Number(this.db.prepare('INSERT INTO credentials(kind,token_hash,user_id,collection_id,label,created_at) VALUES(?,?,?,?,?,?)').run(kind, sha256(token), userId, collectionId, label.slice(0, 60), nowIso()).lastInsertRowid);
    return { token, credentialId: id };
  }
  credential(token: string | undefined, kind: 'intake' | 'publisher'): { id: number; userId: number; collectionId: number } | null {
    if (!token || token.length < 20) return null;
    const c = this.db.prepare('SELECT * FROM credentials WHERE token_hash=? AND kind=? AND revoked_at IS NULL').get(sha256(token), kind) as any;
    if (!c || !this.role(c.user_id, c.collection_id)) return null;
    if (!c.last_used_at || Date.now() - Date.parse(c.last_used_at) > 60_000) this.db.prepare('UPDATE credentials SET last_used_at=? WHERE id=?').run(nowIso(), c.id);
    return { id: c.id, userId: c.user_id, collectionId: c.collection_id };
  }
  credentialsOf(userId: number) {
    return this.db.prepare('SELECT id, kind, collection_id, label, created_at, last_used_at, revoked_at FROM credentials WHERE user_id=? ORDER BY id DESC').all(userId) as any[];
  }
  revokeCredential(userId: number, id: number) {
    const c = this.db.prepare('SELECT * FROM credentials WHERE id=?').get(id) as any;
    if (!c || (c.user_id !== userId && this.role(userId, c.collection_id) !== 'owner')) throw Object.assign(new Error('not your credential'), { status: 403 });
    this.db.prepare('UPDATE credentials SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?').run(nowIso(), id);
    if (c.kind === 'publisher') this.db.prepare('UPDATE destinations SET disconnected_at=COALESCE(disconnected_at, ?) WHERE credential_id=?').run(nowIso(), id);
  }

  /**
   * Billing (the OpenAI prepaid balance and spend) belongs to whoever runs this server: the owner of the original
   * installation (collection 1). Owners of other collections and members never see it.
   */
  isBillingAdmin(userId: number): boolean { return this.collection(1)?.owner_user_id === userId; }

  // ---------- pins ----------
  /** Owner: any pin. Member: only pins whose Reels in this collection were all contributed by them. */
  canDeletePlace(userId: number, collectionId: number, placeId: string): boolean {
    const r = this.role(userId, collectionId);
    if (r === 'owner') return true;
    if (r !== 'member') return false;
    const links = this.store.linksForPlaceIn(collectionId, placeId);
    return links.length > 0 && links.every((l) => l.contributed_by === userId);
  }
}
