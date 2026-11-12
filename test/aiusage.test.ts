import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { computeAllowance, allowanceFromStore, setBalance, type AllowanceInput } from '../src/aiUsage.ts';

// Fixture costs taken from the live ledger (2026-11-11, gpt-6-luna): $0.00010–$0.00043 per call.
const costs = [0.00035, 0.00032, 0.00016, 0.00033, 0.00038, 0.00033, 0.00030, 0.00034, 0.00036, 0.00043, 0.00010, 0.00031];
const base: AllowanceInput = { balance: { usd: 5, at: '2026-11-01T00:00:00Z' }, spentSinceBalance: 0.01, monthlyCapUsd: 3, spentThisMonthOpenai: 0.0115, spentThisMonthAll: 0.0115, callCosts: costs, callsPerReel: [1, 1, 2, 1, 2, 1, 1, 3, 1, 1], worstReservation: 0.0023, dailyCallCap: 30, callsToday: 4, fundsExhaustedReported: false, month: '2026-11' };

test('AI allowance — normal usage: the app cap ($3) runs out before a $5 prepaid balance', () => {
  const a = computeAllowance(base);
  assert.equal(a.status, 'ok'); assert.equal(a.limitedBy, 'monthly_cap');
  assert.equal(a.moneyLeftUsd!.toFixed(4), (3 - 0.0115).toFixed(4));
  assert.equal(a.perCall.typical, 0.00033); assert.equal(a.perCall.conservative, 0.00038);
  assert.equal(a.calls.typical, Math.floor((3 - 0.0115) / 0.00033));
  assert.equal(a.callsPerReel.typical, 1.4);
  assert.equal(a.reels.typical, Math.floor(Math.floor((3 - 0.0115) / 0.00033) / 1.4));
  assert.ok(a.reels.conservative! < a.reels.typical!, 'conservative = p90 cost × p90 calls per Reel');
  assert.equal(a.capResets, '2026-12-01'); assert.equal(a.todayCallsLeft, 26);
});

test('AI allowance — prepaid balance lower than the cap: the balance is the limit', () => {
  const a = computeAllowance({ ...base, balance: { usd: 0.50, at: '2026-11-10T00:00:00Z' }, spentSinceBalance: 0.02 });
  assert.equal(a.limitedBy, 'prepaid'); assert.equal(a.moneyLeftUsd!.toFixed(2), '0.48'); assert.equal(a.prepaidLeftUsd!.toFixed(2), '0.48');
});

test('AI allowance — balance unknown: estimate from the app cap only, clearly labelled', () => {
  const a = computeAllowance({ ...base, balance: null });
  assert.equal(a.status, 'unknown_balance'); assert.equal(a.limitedBy, 'unknown'); assert.equal(a.balance, null); assert.equal(a.prepaidLeftUsd, null);
  assert.match(a.note, /balance unknown/i);
  assert.ok(a.reels.typical! > 0);
});

test('AI allowance — low funds: under 20 Reels left is flagged; less than one worst-case reservation means 0', () => {
  const low = computeAllowance({ ...base, balance: { usd: 0.01, at: '2026-11-10T00:00:00Z' }, spentSinceBalance: 0.004 });
  assert.equal(low.status, 'low'); assert.ok(low.reels.typical! >= 1 && low.reels.typical! < 20, String(low.reels.typical));
  const tiny = computeAllowance({ ...base, balance: { usd: 0.002, at: '2026-11-10T00:00:00Z' }, spentSinceBalance: 0.0005 });
  assert.equal(tiny.status, 'exhausted'); assert.equal(tiny.reels.typical, 0); assert.match(tiny.note, /worst-case/);
});

test('AI allowance — monthly cap exhausted: 0 Reels until the 1st, even with prepaid money left', () => {
  const a = computeAllowance({ ...base, spentThisMonthOpenai: 3, spentThisMonthAll: 3 });
  assert.equal(a.status, 'exhausted'); assert.equal(a.reels.typical, 0); assert.equal(a.capLeftUsd, 0);
  assert.match(a.note, /resets on 2026-12-01/);
});

test('AI allowance — OpenAI said the credit is used up: exhausted regardless of the entered balance', () => {
  const a = computeAllowance({ ...base, fundsExhaustedReported: true });
  assert.equal(a.status, 'exhausted'); assert.equal(a.moneyLeftUsd, 0); assert.match(a.note, /used up/);
});

test('AI allowance from the ledger: costs of the configured model, calls per Reel, spend since the balance was entered', () => {
  const s = new Store(':memory:');
  const add = (o: { usd: number; status?: string; ref?: string; model?: string; at: string; detail?: string }) => s.db.prepare("INSERT INTO budget_ledger(month,provider,reserved_usd,actual_usd,status,detail,created_at,ref,model) VALUES(?, 'openai', 0.0023, ?, ?, ?, ?, ?, ?)").run(o.at.slice(0, 7), o.usd, o.status ?? 'settled', o.detail ?? 'in=1 out=1', o.at, o.ref ?? null, o.model ?? 'gpt-6-luna');
  const now = new Date('2026-11-20T12:00:00Z');
  for (let i = 0; i < 6; i++) { add({ usd: 0.0003, ref: `r${i}`, at: `2026-11-1${i}T10:00:00Z` }); if (i % 2) add({ usd: 0.0004, ref: `r${i}`, at: `2026-11-1${i}T10:05:00Z` }); }
  add({ usd: 0.05, model: 'other-model', at: '2026-11-15T00:00:00Z' }); // another model's cost is not used per call
  setBalance(s, 1, 1);
  s.db.prepare("UPDATE kv SET v=json_set(v,'$.at','2026-11-14T00:00:00Z') WHERE k='openai:balance'").run();
  const a = allowanceFromStore(s, { model: 'gpt-6-luna', monthlyCapUsd: 3, dailyCallCap: 30, now });
  assert.equal(a.perCall.samples, 9); assert.equal(a.perCall.typical, 0.0003);
  assert.equal(a.callsPerReel.samples, 6); assert.equal(a.callsPerReel.typical, 1.5); assert.equal(a.callsPerReel.conservative, 2);
  assert.ok(Math.abs(a.prepaidLeftUsd! - (1 - (0.0003 + 0.0004 + 0.05 + 0.0003))) < 1e-9, 'spend after the balance date is subtracted');
  assert.equal(a.balance!.source, 'entered by you');
  // OpenAI then reports the credit as used up.
  add({ usd: 0.0023, at: '2026-11-19T00:00:00Z', detail: 'error: HTTP 429 insufficient_quota' });
  assert.equal(allowanceFromStore(s, { model: 'gpt-6-luna', monthlyCapUsd: 3, dailyCallCap: 30, now }).status, 'exhausted');
  assert.throws(() => setBalance(s, -1, 1), /US dollars/);
});

test('AI usage endpoint: only the installation owner sees billing; members and other owners get 403; balance is set server-side', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const { createApp } = await import('../src/app.ts');
  const { startServer } = await import('../src/server.ts');
  const { tmpDir } = await import('./support.ts');
  const cfg = loadConfig({ dataDir: tmpDir('ai'), inboxUrl: undefined, inboxToken: 'inbox-token-0123456789', googlePlacesKey: undefined, openaiKey: undefined, anthropicKey: undefined, instagramPageCaption: false, transcribe: 'off' });
  const makeApp = () => createApp(cfg, { media: null, polite: false });
  const port = 20000 + Math.floor(Math.random() * 900);
  const srv = startServer({ app: makeApp(), makeApp, port, appToken: 'admin-token-0123456789', startWorker: false, googleClientId: 't', verifyIdToken: async (t: string) => ({ sub: t, email: `${t}@x.test`, email_verified: true, name: t, picture: null }) });
  const call = async (p: string, o: { method?: string; body?: unknown; cookie?: string } = {}) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: o.method ?? 'GET', headers: { 'content-type': 'application/json', ...(o.cookie ? { cookie: o.cookie } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }); return { status: r.status, j: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] }; };
  try {
    await new Promise((r) => setTimeout(r, 50));
    const owner = await call('/auth/google', { method: 'POST', body: { credential: 'owner', claim: 'admin-token-0123456789' } });
    const inv = (await call('/api/invitations', { method: 'POST', cookie: owner.cookie })).j.code;
    const member = await call('/auth/google', { method: 'POST', body: { credential: 'member', invite: inv } });
    const other = await call('/auth/google', { method: 'POST', body: { credential: 'other' } });
    assert.equal((await call('/api/ai-usage', { cookie: owner.cookie })).status, 200);
    assert.equal((await call('/api/places', { cookie: owner.cookie })).j.billing, true);
    for (const c of [member.cookie, other.cookie]) {
      assert.equal((await call('/api/ai-usage', { cookie: c })).status, 403);
      assert.equal((await call('/api/ai-balance', { method: 'PUT', cookie: c, body: { usd: 100 } })).status, 403);
      assert.equal((await call('/api/places', { cookie: c })).j.billing, false, 'the header indicator is not shown');
    }
    assert.equal((await call('/api/ai-usage', { cookie: owner.cookie })).j.balance, null, 'unknown until entered');
    const set = await call('/api/ai-balance', { method: 'PUT', cookie: owner.cookie, body: { usd: 4.25 } });
    assert.equal(set.j.balance.usd, 4.25); assert.equal(set.j.balance.source, 'entered by you');
  } finally { await srv.close(); }
});
