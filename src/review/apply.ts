import type { Store } from '../db.ts';
import type { ResolveDeps } from '../resolve/resolver.ts';
import { addNote, chooseCandidate, markApproximate, notAPlace } from './actions.ts';

/**
 * Apply review decisions sent from the phone page (✓ candidate, "Find it" with a typed place, "Pin approximately",
 * "Not a place"). "Find it" adds your text as a note and re-runs the whole pipeline on that Reel, so it gets the same
 * caption context, map checks and AI help as a share. Each decision is applied once.
 */
export async function applyReviewDecisions(store: Store, deps: ResolveDeps, log?: (m: string) => void): Promise<number> {
  let n = 0;
  for (const row of store.db.prepare("SELECT k, v FROM kv WHERE k LIKE 'review:pending:%' ORDER BY k").all() as any[]) {
    const id = String(row.k).slice('review:pending:'.length);
    const d = JSON.parse(row.v) as { reelKey: string; action: string; value: string };
    try {
      if (!store.getReel(d.reelKey)) throw new Error(`unknown Reel ${d.reelKey}`);
      if (d.action === 'choose') {
        const idx = store.candidatesFor(d.reelKey).findIndex((c) => c.ref === d.value);
        if (idx < 0) throw new Error('that option is no longer available — type the place instead');
        await chooseCandidate(store, deps, d.reelKey, idx);
      } else if (d.action === 'find') { addNote(store, d.reelKey, d.value); store.requeue(d.reelKey, `you typed: ${d.value}`); }
      else if (d.action === 'approx') await markApproximate(store, deps, d.reelKey, d.value);
      else if (d.action === 'nap') notAPlace(store, d.reelKey);
      else throw new Error(`unknown action ${d.action}`);
      log?.(`review: ${d.action} "${d.value}" applied to ${d.reelKey}`);
      n++;
    } catch (e) {
      store.setReelResult(d.reelKey, { status: 'needs_review', reason: `your decision could not be applied: ${(e as Error).message}` });
      log?.(`review: ${d.action} for ${d.reelKey} failed: ${(e as Error).message}`);
    }
    store.db.prepare('DELETE FROM kv WHERE k=?').run(row.k);
    store.setKv(`review:done:${id}`, new Date().toISOString());
  }
  return n;
}
