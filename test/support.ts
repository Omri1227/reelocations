import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../src/util/http.ts';
import type { MapSink } from '../src/sync/sync.ts';
import { parseKml, type RemoteFeature } from '../src/sync/kml.ts';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIX_DIR = path.join(TEST_DIR, 'fixtures');

export function tmpDir(tag: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), `reelmaps-${tag}-`)); }

// ---------------------------------------------------------------------------------------------------------------
// HTTP record/replay for OpenStreetMap services. RECORD=1 hits the live services and stores responses
// (fixtures are therefore real OSM data captured on the recording date); otherwise responses are replayed.
// ---------------------------------------------------------------------------------------------------------------
const HTTP_DIR = path.join(FIX_DIR, 'http');
const keyOf = (url: string, init?: RequestInit) => crypto.createHash('sha1').update(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`).digest('hex').slice(0, 16);

export function recordReplayFetch(): FetchLike {
  const record = process.env.RECORD === '1';
  return async (url, init) => {
    if (url.startsWith('http://127.0.0.1')) return fetch(url, init); // local emulators are always real
    const k = keyOf(url, init);
    const file = path.join(HTTP_DIR, `${k}.json`);
    if (!record) {
      if (!fs.existsSync(file)) throw new TypeError(`fetch failed (no recorded fixture for ${init?.method ?? 'GET'} ${url.slice(0, 160)} ${String(init?.body ?? '').slice(0, 200)}) — run tests once with RECORD=1`);
      const f = JSON.parse(fs.readFileSync(file, 'utf8'));
      return new Response(f.body, { status: f.status, headers: { 'content-type': f.contentType ?? 'application/json' } });
    }
    const res = await fetch(url, init);
    const body = await res.text();
    if (res.ok) {
      fs.mkdirSync(HTTP_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ recordedAt: new Date().toISOString(), method: init?.method ?? 'GET', url, requestBody: init?.body ?? null, status: res.status, contentType: res.headers.get('content-type'), body }, null, 1));
    }
    return new Response(body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? '' } });
  };
}

/** Synthetic Meta oEmbed responses (no real public Reel was available to record). Clearly labelled fixtures. */
export function fakeOembed(byShortcode: Record<string, { caption?: string; error?: { message: string; code: number; subcode: number; title: string } }>): (next: FetchLike) => FetchLike {
  return (next) => async (url, init) => {
    if (!url.startsWith('https://graph.facebook.com/')) return next(url, init);
    const u = decodeURIComponent(new URL(url).searchParams.get('url') ?? '');
    const code = u.match(/reel\/([^/]+)/)?.[1] ?? '';
    const f = byShortcode[code];
    if (!f || f.error) {
      const e = f?.error ?? { message: 'The requested resource does not exist', code: 24, subcode: 2207045, title: 'Media Not Found' };
      return new Response(JSON.stringify({ error: { message: e.message, type: 'OAuthException', code: e.code, error_subcode: e.subcode, is_transient: false, error_user_title: e.title } }), { status: 400 });
    }
    return new Response(JSON.stringify({ version: '1.0', provider_name: 'Instagram', author_name: 'someone_else', title: f.caption, html: '<blockquote class="instagram-media"></blockquote>', thumbnail_url: 'https://example.invalid/thumb.jpg' }), { status: 200 });
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Google Apps Script emulator: runs the REAL apps-script/Code.gs in a VM with in-memory Sheets/Drive.
// ---------------------------------------------------------------------------------------------------------------
class FakeSheet {
  values: any[][] = [];
  appendRow(r: any[]) { this.values.push([...r]); }
  getLastRow() { return this.values.length; }
  getDataRange() { return { getValues: () => this.values.map((r) => [...r]) }; }
  getLastColumn() { return Math.max(0, ...this.values.map((r) => r.length)); }
  getRange(row: number, col: number, _nr = 1, nc = 1) {
    return {
      setValues: (v: any[][]) => { for (let i = 0; i < nc; i++) this.values[row - 1]![col - 1 + i] = v[0]![i]; },
      setValue: (v: any) => { this.values[row - 1]![col - 1] = v; },
      getValues: () => [Array.from({ length: nc }, (_, i) => this.values[row - 1]?.[col - 1 + i] ?? '')],
    };
  }
}
export class AppsScriptEmulator {
  sheets = new Map<string, FakeSheet>();
  files = new Map<string, { name: string; mime: string; bytes: number[] }>();
  props = new Map<string, string>();
  ctx: any;
  server?: http.Server;
  url = '';
  online = true;
  constructor(token: string) {
    this.props.set('TOKEN', token);
    const self = this;
    const toSigned = (buf: Buffer) => [...buf].map((b) => (b > 127 ? b - 256 : b));
    const toBuf = (arr: number[]) => Buffer.from(arr.map((b) => (b < 0 ? b + 256 : b)));
    const ss = { getId: () => 'sheet1', getSheetByName: (n: string) => self.sheets.get(n) ?? null, insertSheet: (n: string) => { const s = new FakeSheet(); self.sheets.set(n, s); return s; } };
    let idn = 0;
    const folder = { getId: () => 'folder1', createFile: (blob: any) => { const id = `file${++idn}`; self.files.set(id, { name: blob.getName(), mime: blob.getContentType(), bytes: blob.getBytes() }); return { getId: () => id, setSharing: () => {} }; } };
    const blobOf = (bytes: number[], mime: string, name: string) => ({ getBytes: () => bytes, getContentType: () => mime, getName: () => name });
    this.ctx = vm.createContext({
      JSON, Date, Number, String, Math,
      SpreadsheetApp: { create: () => ss, openById: () => ss },
      DriveApp: { Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' }, createFolder: () => folder, getFolderById: () => folder, getFileById: (id: string) => { const f = self.files.get(id); if (!f) throw new Error('no file'); return { getName: () => f.name, getBlob: () => blobOf(f.bytes, f.mime, f.name) }; } },
      PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => self.props.get(k) ?? null, setProperty: (k: string, v: string) => self.props.set(k, v) }) },
      LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
      Utilities: {
        DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
        computeDigest: (_a: string, s: string) => toSigned(crypto.createHash('sha256').update(s, 'utf8').digest()),
        base64Decode: (s: string) => toSigned(Buffer.from(s, 'base64')),
        base64Encode: (b: number[]) => toBuf(b).toString('base64'),
        newBlob: blobOf,
      },
      ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (s: string) => ({ content: s, setMimeType() { return this; } }) },
      HtmlService: { createHtmlOutput: (h: string) => ({ html: h, setTitle() { return this; }, addMetaTag() { return this; } }) },
    });
    vm.runInContext(fs.readFileSync(path.join(TEST_DIR, '..', 'apps-script', 'Code.gs'), 'utf8'), this.ctx);
  }
  post(body: unknown): any { return JSON.parse(this.ctx.doPost({ postData: { contents: JSON.stringify(body) } }).content); }
  get(params: Record<string, string>): string { return this.ctx.doGet({ parameter: params }).html; }
  inbox(): any[][] { return this.sheets.get('Inbox')?.values ?? []; }
  /** Real HTTP server so the worker's normal HTTP client (and a curl "Shortcut") can talk to it. */
  async listen(): Promise<string> {
    this.server = http.createServer(async (req, res) => {
      if (!this.online) { req.socket.destroy(); return; }
      let b = ''; for await (const c of req) b += c;
      if (req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(this.post(JSON.parse(b || '{}')))); }
      else { const q = Object.fromEntries(new URL(req.url!, 'http://x').searchParams); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(this.get(q)); }
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as any).port}/exec`;
    return this.url;
  }
  async close() { await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r())); }
}

// ---------------------------------------------------------------------------------------------------------------
// Fake My Maps layer: after replaceLayer it holds exactly the file's features (like the live layer swap), plus outage injection.
// ---------------------------------------------------------------------------------------------------------------
export class FakeMyMaps implements MapSink {
  layers = new Map<string, RemoteFeature[]>();
  online = true;
  failNextReplace = false;
  replaceCalls = 0;
  layerName: string;
  constructor(layerName: string, opts: { createLayer?: boolean } = {}) { this.layerName = layerName; if (opts.createLayer !== false) this.layers.set(layerName, []); }
  private check() { if (!this.online) throw new TypeError('fetch failed (desktop offline)'); }
  async readRemote() { this.check(); const l = this.layers.get(this.layerName); return { layerExists: !!l, features: l ? l.map((f) => ({ ...f })) : [] }; }
  async replaceLayer(file: string) {
    this.check(); this.replaceCalls++;
    if (this.failNextReplace) { this.failNextReplace = false; throw new Error('simulated browser crash during import'); }
    const feats = parseKml(fs.readFileSync(file, 'utf8')).map((f) => ({ ...f, layer: this.layerName }));
    this.layers.set(this.layerName, feats);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fake My Maps account with several maps (one per country) and named layers, for the grouped sync. Same semantics as
// the live layer swap: after replaceLayer the named layer holds exactly the file's features.
// ---------------------------------------------------------------------------------------------------------------
export class FakeMyMapsAccount {
  maps = new Map<string, { title: string; layers: { name: string; features: RemoteFeature[] }[] }>();
  private cur = { mapId: '', layer: '' };
  replaceCalls = 0; created = 0; failNextReplace = false;
  target(mapId: string, layerName: string) { this.cur = { mapId, layer: layerName }; return this; }
  async createMap(title: string) { const id = `fake-${++this.created}`; this.maps.set(id, { title, layers: [] }); return id; }
  async readAllLayers() {
    const m = this.maps.get(this.cur.mapId); if (!m) throw new Error('no such map');
    return m.layers.map((l) => ({ name: l.name, features: l.features.map((f) => ({ ...f })) }));
  }
  removed: string[] = [];
  async replaceLayer(file: string) {
    this.replaceCalls++;
    if (this.failNextReplace) { this.failNextReplace = false; throw new Error('simulated browser crash during import'); }
    const m = this.maps.get(this.cur.mapId)!;
    // Live (2026-11-11): the swap ADDS the new layer before deleting the old one, and My Maps allows 10 layers per map.
    if (m.layers.length >= 10) throw new Error('Could not add layer: You have reached the layer limit for this map.');
    const feats = parseKml(fs.readFileSync(file, 'utf8')).map((f) => ({ ...f, layer: this.cur.layer }));
    const i = m.layers.findIndex((l) => l.name === this.cur.layer);
    if (i >= 0) m.layers[i] = { name: this.cur.layer, features: feats }; else m.layers.push({ name: this.cur.layer, features: feats });
  }
  async removeLayer(name: string) {
    const m = this.maps.get(this.cur.mapId)!;
    m.layers = m.layers.filter((l) => l.name !== name); this.removed.push(name);
  }
}
