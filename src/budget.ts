import type { Store } from './db.ts';
import { nowIso } from './db.ts';

/** Price table for optional paid calls (USD). Unknown provider/model => calls are refused (local/review path instead). */
export const PRICES: Record<string, { inPerMTok: number; outPerMTok: number } | undefined> = {
  // Anthropic first-party list prices (claude-api skill table cached 2026-10-06; ≤100K-token prompts)
  'claude-haiku-5-5': { inPerMTok: 0.10, outPerMTok: 0.50 },
  'claude-sonnet-5-5': { inPerMTok: 2.0, outPerMTok: 10.0 },
  'claude-opus-5-5': { inPerMTok: 4.0, outPerMTok: 20.0 },
  // OpenAI Standard rates (developers.openai.com/api/docs/pricing, checked 2026-11-10). Image input is billed as input tokens.
  'gpt-6-luna': { inPerMTok: 0.10, outPerMTok: 0.50 },
  'gpt-5.6-luna': { inPerMTok: 0.20, outPerMTok: 1.20 },
  'gpt-5.4-nano': { inPerMTok: 0.20, outPerMTok: 1.25 },
};

/** Hard ceiling regardless of configuration: the whole system must stay under US$3/month. */
export const HARD_MONTHLY_CEILING_USD = 3.0;

export interface Reservation { id: number; provider: string; usd: number }

export class Budget {
  private store: Store; private caps: Record<string, number>; private now: () => Date;
  constructor(store: Store, caps: Record<string, number>, now: () => Date = () => new Date()) { this.store = store; this.caps = caps; this.now = now; }

  month(): string { return this.now().toISOString().slice(0, 7); }

  spent(provider?: string): number {
    const m = this.month();
    const row = (provider
      ? this.store.db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN actual_usd WHEN status='reserved' THEN reserved_usd ELSE 0 END),0) s FROM budget_ledger WHERE month=? AND provider=?`).get(m, provider)
      : this.store.db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN actual_usd WHEN status='reserved' THEN reserved_usd ELSE 0 END),0) s FROM budget_ledger WHERE month=?`).get(m)) as any;
    return Number(row.s);
  }
  callsToday(provider: string): number {
    const day = this.now().toISOString().slice(0, 10);
    return Number((this.store.db.prepare(`SELECT COUNT(*) n FROM budget_ledger WHERE provider=? AND substr(created_at,1,10)=?`).get(provider, day) as any).n);
  }

  /**
   * Reserve the *worst-case* cost before calling. Returns null (=> do not call) if the price is unknown,
   * the provider has no cap configured, the cap or the global ceiling would be exceeded, or the daily call cap is hit.
   */
  reserve(provider: string, worstCaseUsd: number | undefined, opts: { dailyCallCap?: number; detail?: string; ref?: string | null; model?: string | null } = {}): Reservation | null {
    // Check-and-insert in one IMMEDIATE transaction: a second process (review UI + scheduled task) cannot overspend.
    return this.store.tx(() => this.reserveUnlocked(provider, worstCaseUsd, opts));
  }

  private reserveUnlocked(provider: string, worstCaseUsd: number | undefined, opts: { dailyCallCap?: number; detail?: string; ref?: string | null; model?: string | null }): Reservation | null {
    if (worstCaseUsd === undefined || !Number.isFinite(worstCaseUsd) || worstCaseUsd < 0) return null;
    const cap = this.caps[provider];
    if (cap === undefined) return null;
    if (worstCaseUsd > 0 && (this.spent(provider) + worstCaseUsd > cap || this.spent() + worstCaseUsd > HARD_MONTHLY_CEILING_USD)) return null;
    if (opts.dailyCallCap !== undefined && this.callsToday(provider) >= opts.dailyCallCap) return null;
    const r = this.store.db.prepare(`INSERT INTO budget_ledger(month,provider,reserved_usd,status,detail,created_at,ref,model) VALUES(?,?,?,'reserved',?,?,?,?)`)
      .run(this.month(), provider, worstCaseUsd, opts.detail ?? null, nowIso(), opts.ref ?? null, opts.model ?? null);
    return { id: Number(r.lastInsertRowid), provider, usd: worstCaseUsd };
  }

  /** Record the actual cost (or keep the reserved worst case if the actual is unknown). */
  settle(r: Reservation, actualUsd: number | undefined, detail?: string) {
    this.store.db.prepare(`UPDATE budget_ledger SET status='settled', actual_usd=?, detail=COALESCE(?,detail) WHERE id=?`)
      .run(actualUsd ?? r.usd, detail ?? null, r.id);
  }

  report() {
    const m = this.month();
    const rows = this.store.db.prepare(`SELECT provider, COUNT(*) calls, COALESCE(SUM(COALESCE(actual_usd,reserved_usd)),0) usd FROM budget_ledger WHERE month=? GROUP BY provider`).all(m) as any[];
    return { month: m, caps: this.caps, ceiling: HARD_MONTHLY_CEILING_USD, byProvider: rows, total: this.spent() };
  }
}

export function tokenCostUsd(model: string, inTok: number, outTok: number): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  return (inTok * p.inPerMTok + outTok * p.outPerMTok) / 1_000_000;
}
