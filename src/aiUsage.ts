import type { Store } from './db.ts';
import { HARD_MONTHLY_CEILING_USD } from './budget.ts';

/**
 * "About how many more Reels can I process with AI?"
 *
 * OpenAI offers no supported API that returns an organisation's prepaid credit balance (checked 2026-11-11: only the
 * admin-key Costs/Usage APIs, which report spend, not balance). So the balance is entered by hand (Setup / the header
 * panel) and the estimate subtracts what reelocations itself recorded afterwards (budget_ledger: actual cost of every call).
 *
 *   money left   = min( prepaid balance − spend recorded since it was entered   (if a balance was entered),
 *                       monthly app cap  − spend this month,                     (OPENAI_MONTHLY_BUDGET_USD)
 *                       global $3 ceiling − all paid spend this month )
 *   cost / call  = actual recorded costs for the configured model: median (typical) and 90th percentile (conservative)
 *   calls / Reel = recorded calls per Reel that used AI (re-processing after a screenshot and retries included):
 *                  mean (typical) and 90th percentile (conservative)
 *   Reels left   = floor(money left / (cost per call × calls per Reel)), and 0 whenever money left cannot cover one
 *                  worst-case reservation (the app reserves the worst case before every call), or OpenAI reported that
 *                  the credit is used up.
 */
export interface AllowanceInput {
  /** Hand-entered prepaid balance, or null when unknown. */
  balance: { usd: number; at: string } | null;
  /** USD recorded since the balance was entered (settled actual + open reservations). */
  spentSinceBalance: number;
  monthlyCapUsd: number;
  spentThisMonthOpenai: number;
  spentThisMonthAll: number;
  /** Actual cost of recent calls for the configured model (USD). */
  callCosts: number[];
  /** Calls per Reel that used AI (one entry per Reel). */
  callsPerReel: number[];
  /** Largest worst-case reservation seen (a call is refused when less than this is left). */
  worstReservation: number;
  dailyCallCap: number; callsToday: number;
  /** OpenAI answered "insufficient_quota"/"credit balance exhausted" after the balance was entered. */
  fundsExhaustedReported: boolean;
  month: string;
}
export interface Allowance {
  status: 'ok' | 'low' | 'exhausted' | 'unknown_balance' | 'no_data';
  limitedBy: 'prepaid' | 'monthly_cap' | 'global_ceiling' | 'unknown';
  moneyLeftUsd: number | null;
  prepaidLeftUsd: number | null;
  capLeftUsd: number;
  perCall: { typical: number | null; conservative: number | null; samples: number };
  callsPerReel: { typical: number; conservative: number; samples: number };
  calls: { typical: number | null; conservative: number | null };
  reels: { typical: number | null; conservative: number | null; showConservative: boolean };
  todayCallsLeft: number;
  capResets: string;
  balance: { usd: number; at: string; source: 'entered by you' } | null;
  note: string;
}

const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function computeAllowance(i: AllowanceInput): Allowance {
  const capLeft = Math.max(0, Math.min(i.monthlyCapUsd - i.spentThisMonthOpenai, HARD_MONTHLY_CEILING_USD - i.spentThisMonthAll));
  const capLimitedBy = i.monthlyCapUsd - i.spentThisMonthOpenai <= HARD_MONTHLY_CEILING_USD - i.spentThisMonthAll ? 'monthly_cap' : 'global_ceiling';
  const prepaidLeft = i.balance ? Math.max(0, i.balance.usd - i.spentSinceBalance) : null;
  let money = prepaidLeft == null ? capLeft : Math.min(prepaidLeft, capLeft);
  const limitedBy = prepaidLeft == null ? (i.balance ? capLimitedBy : 'unknown') : prepaidLeft <= capLeft ? 'prepaid' : capLimitedBy;
  if (i.fundsExhaustedReported) money = 0;
  const typical = pct(i.callCosts, 50), conservative = pct(i.callCosts, 90);
  const cprT = i.callsPerReel.length ? mean(i.callsPerReel) : 1, cprC = pct(i.callsPerReel, 90) ?? 1;
  // A call is refused unless the worst case still fits: the last ~worst-case dollars cannot be used.
  const usable = money >= i.worstReservation ? money : 0;
  const calls = (per: number | null) => (per && per > 0 ? Math.floor(usable / per) : null);
  const callsT = calls(typical), callsC = calls(conservative);
  const reelsT = callsT == null ? null : Math.floor(callsT / Math.max(1, cprT)), reelsC = callsC == null ? null : Math.floor(callsC / Math.max(1, cprC));
  const [y, m] = i.month.split('-').map(Number) as [number, number];
  const capResets = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)).toISOString().slice(0, 10);
  let status: Allowance['status'];
  if (i.fundsExhaustedReported || usable === 0) status = 'exhausted';
  else if (!i.callCosts.length) status = 'no_data';
  else if (reelsT != null && reelsT < 20) status = 'low';
  else if (!i.balance) status = 'unknown_balance';
  else status = 'ok';
  const note = i.fundsExhaustedReported ? 'OpenAI reported that the prepaid credit is used up. Top up, then enter the new balance.'
    : usable === 0 && money > 0 ? `Less than one worst-case call ($${i.worstReservation.toFixed(4)}) left this month.`
    : usable === 0 ? (limitedBy === 'prepaid' ? 'Prepaid balance used up (estimate).' : `Monthly AI cap reached; it resets on ${capResets}.`)
    : !i.balance ? 'Prepaid balance unknown: this counts only the app’s monthly cap. Enter your OpenAI balance for a real estimate.'
    : '';
  return {
    status, limitedBy: i.fundsExhaustedReported ? 'prepaid' : limitedBy, moneyLeftUsd: i.fundsExhaustedReported ? 0 : money, prepaidLeftUsd: prepaidLeft, capLeftUsd: capLeft,
    perCall: { typical, conservative, samples: i.callCosts.length },
    callsPerReel: { typical: Math.round(cprT * 100) / 100, conservative: cprC, samples: i.callsPerReel.length },
    calls: { typical: callsT, conservative: callsC },
    reels: { typical: reelsT, conservative: reelsC, showConservative: reelsT != null && reelsC != null && reelsC < reelsT * 0.8 },
    todayCallsLeft: Math.max(0, i.dailyCallCap - i.callsToday), capResets,
    balance: i.balance ? { ...i.balance, source: 'entered by you' } : null, note,
  };
}

/** Gather the inputs from the database (server-side only; no billing request ever leaves the server). */
export function allowanceFromStore(store: Store, o: { model: string; monthlyCapUsd: number; dailyCallCap: number; now?: Date }): Allowance {
  const now = o.now ?? new Date();
  const month = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
  const db = store.db;
  const cost = "CASE WHEN status='settled' THEN actual_usd WHEN status='reserved' THEN reserved_usd ELSE 0 END";
  let balance: AllowanceInput['balance'] = null;
  try { const b = JSON.parse(store.getKv('openai:balance') ?? 'null'); if (b && Number.isFinite(b.usd)) balance = { usd: Number(b.usd), at: String(b.at) }; } catch { /* none */ }
  const spentSinceBalance = balance ? Number((db.prepare(`SELECT COALESCE(SUM(${cost}),0) s FROM budget_ledger WHERE provider='openai' AND created_at > ?`).get(balance.at) as any).s) : 0;
  const spentThisMonthOpenai = Number((db.prepare(`SELECT COALESCE(SUM(${cost}),0) s FROM budget_ledger WHERE provider='openai' AND month=?`).get(month) as any).s);
  const spentThisMonthAll = Number((db.prepare(`SELECT COALESCE(SUM(${cost}),0) s FROM budget_ledger WHERE month=?`).get(month) as any).s);
  const callCosts = (db.prepare(`SELECT actual_usd v FROM budget_ledger WHERE provider='openai' AND status='settled' AND actual_usd > 0 AND (model IS NULL OR model=?) ORDER BY id DESC LIMIT 200`).all(o.model) as any[]).map((r) => Number(r.v));
  // Calls per Reel: from calls recorded with their Reel; older calls (before 2026-11-11) are spread over the Reels whose
  // evidence shows AI use.
  let callsPerReel = (db.prepare(`SELECT COUNT(*) n FROM budget_ledger WHERE provider='openai' AND ref IS NOT NULL AND status <> 'released' GROUP BY ref`).all() as any[]).map((r) => Number(r.n));
  if (callsPerReel.length < 5) {
    const legacyCalls = Number((db.prepare(`SELECT COUNT(*) n FROM budget_ledger WHERE provider='openai' AND ref IS NULL AND status <> 'released'`).get() as any).n);
    const aiReels = Number((db.prepare(`SELECT COUNT(*) n FROM reels WHERE evidence_json LIKE '%"source":"ai"%'`).get() as any).n);
    if (legacyCalls && aiReels) { const avg = legacyCalls / aiReels; callsPerReel = [...callsPerReel, ...Array.from({ length: aiReels }, (_, k) => (k < legacyCalls % aiReels ? Math.ceil(avg) : Math.floor(avg)) || 1)]; }
  }
  const worstReservation = Number((db.prepare(`SELECT COALESCE(MAX(reserved_usd),0) w FROM budget_ledger WHERE provider='openai' AND id IN (SELECT id FROM budget_ledger WHERE provider='openai' ORDER BY id DESC LIMIT 50)`).get() as any).w);
  const callsToday = Number((db.prepare(`SELECT COUNT(*) n FROM budget_ledger WHERE provider='openai' AND substr(created_at,1,10)=?`).get(day) as any).n);
  const fundsExhaustedReported = !!db.prepare(`SELECT 1 FROM budget_ledger WHERE provider='openai' AND created_at > ? AND (detail LIKE '%insufficient_quota%' OR detail LIKE '%credit_balance%' OR detail LIKE '%billing_hard_limit%') LIMIT 1`).get(balance?.at ?? '0000');
  return computeAllowance({ balance, spentSinceBalance, monthlyCapUsd: o.monthlyCapUsd, spentThisMonthOpenai, spentThisMonthAll, callCosts, callsPerReel, worstReservation, dailyCallCap: o.dailyCallCap, callsToday, fundsExhaustedReported, month });
}

export function setBalance(store: Store, usd: number | null, userId: number) {
  if (usd == null) { store.db.prepare("DELETE FROM kv WHERE k='openai:balance'").run(); return; }
  if (!Number.isFinite(usd) || usd < 0 || usd > 100_000) throw Object.assign(new Error('enter the balance in US dollars, e.g. 9.85'), { status: 400 });
  store.setKv('openai:balance', JSON.stringify({ usd: Math.round(usd * 100) / 100, at: new Date().toISOString(), by: userId }));
}
