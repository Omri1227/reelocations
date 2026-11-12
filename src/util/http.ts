import crypto from 'node:crypto';
import type { Store } from '../db.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class NetworkError extends Error { constructor(msg: string) { super(msg); this.name = 'NetworkError'; } }
export class HttpError extends Error {
  status: number; body: string;
  constructor(status: number, body: string, url: string) { super(`HTTP ${status} from ${new URL(url).host}: ${body.slice(0, 200)}`); this.name = 'HttpError'; this.status = status; this.body = body; }
}

export interface HttpOptions {
  fetch?: FetchLike;
  userAgent: string;
  store?: Store;
  /** Minimum spacing between requests per host (politeness / provider policy). */
  minIntervalMs?: Record<string, number>;
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOpts {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  /** Cache successful responses in SQLite for this long (only for providers whose terms allow it). */
  cacheTtlMs?: number;
  retries?: number;
  timeoutMs?: number;
  /** Return non-2xx responses instead of throwing for these statuses. */
  acceptStatus?: number[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polite HTTP client: per-host rate limit, bounded exponential backoff on 429/5xx/network, optional cache. */
export class Http {
  private fetchImpl: FetchLike;
  private last = new Map<string, number>();
  private chain = new Map<string, Promise<void>>();
  private o: HttpOptions;
  constructor(o: HttpOptions) { this.o = o; this.fetchImpl = o.fetch ?? ((u, i) => fetch(u, i)); }

  private async throttle(host: string) {
    const min = this.o.minIntervalMs?.[host] ?? 0;
    if (!min) return;
    const prev = this.chain.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.chain.set(host, prev.then(() => mine));
    await prev;
    const wait = (this.last.get(host) ?? 0) + min - Date.now();
    if (wait > 0) await (this.o.sleep ?? defaultSleep)(wait);
    this.last.set(host, Date.now());
    release();
  }

  async text(url: string, opts: RequestOpts = {}): Promise<{ status: number; body: string; headers: Headers }> {
    const cacheKey = opts.cacheTtlMs ? crypto.createHash('sha256').update(`${opts.method ?? 'GET'} ${url} ${opts.body ?? ''}`).digest('hex') : '';
    if (cacheKey && this.o.store) {
      const hit = this.o.store.cacheGet(cacheKey, opts.cacheTtlMs!);
      if (hit !== undefined) return { status: 200, body: hit, headers: new Headers({ 'x-cache': 'hit' }) };
    }
    const host = new URL(url).host;
    const retries = opts.retries ?? 2;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await (this.o.sleep ?? defaultSleep)((this.o.backoffBaseMs ?? 1000) * 2 ** (attempt - 1) * (1 + Math.random() * 0.25));
      await this.throttle(host);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: opts.method ?? 'GET', body: opts.body,
          headers: { 'User-Agent': this.o.userAgent, ...opts.headers },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
          redirect: 'follow',
        });
      } catch (e: any) {
        lastErr = new NetworkError(`${host}: ${e?.cause?.code ?? e?.message ?? e}`);
        continue;
      }
      const body = await res.text();
      if (res.ok || opts.acceptStatus?.includes(res.status)) {
        if (res.ok && cacheKey && this.o.store) this.o.store.cachePut(cacheKey, body);
        return { status: res.status, body, headers: res.headers };
      }
      lastErr = new HttpError(res.status, body, url);
      if (!(res.status === 429 || res.status >= 500)) break; // non-retryable
    }
    throw lastErr!;
  }

  async json<T = any>(url: string, opts: RequestOpts = {}): Promise<T> {
    const r = await this.text(url, opts);
    try { return JSON.parse(r.body) as T; } catch { throw new HttpError(r.status, `invalid JSON: ${r.body.slice(0, 120)}`, url); }
  }
}

export function isOffline(e: unknown): boolean { return e instanceof NetworkError; }
