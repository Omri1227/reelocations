import http from 'node:http';
import type { App } from '../app.ts';
import { addNote, chooseCandidate, guessReplaced, markApproximate, notAPlace, rejectListings, searchCandidates } from './actions.ts';
import { displayDate } from '../intake/parse.ts';
import { CATEGORY_INFO } from '../categories.ts';
import { applyItem } from '../intake/inbox.ts';
import { nowIso } from '../db.ts';
import type { Category } from '../types.ts';
import { googleMapsUrl } from '../geo/googlePlaces.ts';

/** Google Maps for a review candidate: its exact listing when known, otherwise a Maps search for it. */
export function candidateMapsUrl(c: { name: string; displayName?: string | null; googlePlaceId?: string | null; lat?: number; lon?: number }): string {
  if (c.googlePlaceId) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.name)}&query_place_id=${encodeURIComponent(c.googlePlaceId)}`;
  const where = String(c.displayName ?? '').split(',').map((x) => x.trim()).filter((x) => x && x !== c.name).slice(0, 2).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(where ? `${c.name}, ${where}` : c.name)}`;
}

const h = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(app: App, base = '', collectionId?: number, focus?: string): string {
  const s = app.store;
  const all = s.listReels().filter((r: any) => collectionId == null || (r.collection_id ?? 1) === collectionId);
  const reels = focus ? all.filter((r) => r.reel_key === focus) : all;
  const open = reels.filter((r) => r.status === 'needs_review' || r.status === 'error' || r.status === 'queued');
  const done = reels.filter((r) => r.status === 'resolved');
  const other = reels.filter((r) => r.status === 'not_a_place');
  const sync = s.lastSync(); const okSync = s.lastSync('ok');
  const budget = app.budget.report();
  const reelCard = (r: (typeof reels)[number]) => {
    const links = s.linksForReel(r.reel_key) as any[];
    const cands = s.candidatesFor(r.reel_key);
    // A plain option on a Reel that already has pins: replace one of them (pre-selected: the likely one) or add it.
    const replaceSelect = (c: (typeof cands)[number]) => {
      if (!links.length || c.replacesPlaceId || c.confirmsApproxPlaceId || c.replacesApproxPlaceId) return '';
      const guess = guessReplaced(s, r.reel_key, c);
      return `<select name="replace" aria-label="Replace which pin">${links.map((l) => `<option value="${h(l.place_id)}"${l.place_id === guess ? ' selected' : ''}>Replace “${h(l.name)}”</option>`).join('')}<option value=""${guess ? '' : ' selected'}>Add as another place</option></select>`;
    };
    const caps = r.capabilities_json ? JSON.parse(r.capabilities_json) : null;
    return `<section class="card ${h(r.status)}" id="${h(r.reel_key)}">
      <div class="row"><b>${r.url ? `<a href="${h(r.url)}" target="_blank" rel="noopener">${h(r.url)}</a>` : '(no link – media only)'}</b>
      <span class="pill">${h(r.status)}</span></div>
      <div class="muted">Shared ${h(displayDate(r.first_shared_at))} · ${s.sharesFor(r.reel_key).length} share(s)${r.last_error ? ` · last error: ${h(r.last_error)}` : ''}</div>
      ${r.status_reason ? `<div class="reason">${h(r.status_reason)}</div>` : ''}
      ${caps ? `<div class="muted small">caption: ${h(caps.caption)} · geotag: ${h(caps.geotag)} · video: ${h(caps.video)} · audio: ${h(caps.audio)} · images: ${h(caps.images)}</div>` : ''}
      ${links.length ? `<ul>${links.map((l) => `<li id="pin-${h(l.place_id)}">${CATEGORY_INFO[l.category as Category]?.emoji ?? ''} <b>${h(l.name)}</b> <span class="pill ${h(l.confidence)}">${l.confidence === 'approximate' ? 'Approximate' : h(l.confidence)}</span> ${l.kind === 'route' ? '(route)' : ''} <a class="small" href="${h(googleMapsUrl(l))}" target="_blank" rel="noopener">Google Maps</a>${l.confidence === 'approximate' ? `<div class="why"><b>Why approximate:</b> ${h(l.source)}${r.status_reason ? `<br><span class="muted">${h(r.status_reason)}</span>` : ''}</div>` : ''}<br><span class="muted">${h(l.cue ?? 'no cue')}</span> <form method="post" action="${base}/act" class="inline" onsubmit="return confirm('Remove this pin from this Reel?')"><input type="hidden" name="key" value="${h(r.reel_key)}"><input type="hidden" name="op" value="unlink"><input type="hidden" name="q" value="${h(l.place_id)}"><button class="ghost">Wrong pin — remove</button></form></li>`).join('')}</ul>` : ''}
      ${cands.length ? `<details ${r.status === 'needs_review' ? 'open' : ''}><summary>${cands.length} candidate(s)</summary><ol start="0">${cands.map((c, i) => `<li>${CATEGORY_INFO[c.category]?.emoji ?? ''} <b>${h(c.name)}</b> <span class="muted">${h(c.displayName)} · score ${h(c.score)} · from “${h(c.clueText)}”</span> <a class="small" href="${h(candidateMapsUrl(c))}" target="_blank" rel="noopener">${c.googlePlaceId ? 'Open listing in Google Maps' : 'Search in Google Maps'}</a>
        <form method="post" action="${base}/act" class="inline"><input type="hidden" name="key" value="${h(r.reel_key)}"><input type="hidden" name="op" value="choose"><input type="hidden" name="idx" value="${i}">${replaceSelect(c)}<button>${c.replacesPlaceId ? 'This is the listing' : 'This is it'}</button></form></li>`).join('')}</ol>${[...new Set(cands.filter((c) => c.replacesPlaceId).map((c) => c.replacesPlaceId!))].map((pid) => `<form method="post" action="${base}/act" class="inline"><input type="hidden" name="key" value="${h(r.reel_key)}"><input type="hidden" name="op" value="nolisting"><input type="hidden" name="q" value="${h(pid)}"><button class="ghost">None of these is ${h(s.getPlace(pid)?.name)}</button></form>`).join('')}</details>` : ''}
      <div class="actions">
        <form method="post" action="${base}/act"><input type="hidden" name="key" value="${h(r.reel_key)}"><input type="hidden" name="op" value="search"><input name="q" placeholder="Search a place name…" required><button>Search</button></form>
        <form method="post" action="${base}/act"><input type="hidden" name="key" value="${h(r.reel_key)}"><input type="hidden" name="op" value="approx"><input name="q" placeholder="Approximate area (town, park)…" required><button>Save as approximate</button></form>
        <form method="post" action="${base}/act"><input type="hidden" name="key" value="${h(r.reel_key)}"><input type="hidden" name="op" value="note"><input name="q" placeholder="Add a note / memory cue…" required><button>Add note & retry</button></form>
        <form method="post" action="${base}/act"><input type="hidden" name="key" value="${h(r.reel_key)}"><input type="hidden" name="op" value="retry"><button class="ghost">Retry</button></form>
        ${r.status !== 'not_a_place' ? `<form method="post" action="${base}/act"><input type="hidden" name="key" value="${h(r.reel_key)}"><input type="hidden" name="op" value="nap"><button class="ghost">Not a place</button></form>` : ''}
      </div></section>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review Queue · reelocations</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>:root{--bg:#f6f6f4;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--line:#e3e2dd;--acc:#2f6f4f;--warn:#b25b00}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#a3a29c;--card:#22221f;--line:#34332f;--acc:#7cc79f;--warn:#f0a050}}
body{font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:16px;max-width:980px;margin:auto}
a{color:var(--acc);word-break:break-all}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
.row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}.muted{color:var(--mut)}.small{font-size:12px}.reason{margin:6px 0}
.pill{font-size:12px;border:1px solid var(--line);border-radius:99px;padding:1px 8px;white-space:nowrap}.pill.approximate{color:var(--warn);border-color:var(--warn)}.why{margin:4px 0;padding:6px 8px;border-left:3px solid var(--warn);background:color-mix(in srgb,var(--warn) 8%,transparent)}
.actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}form{display:flex;gap:4px;margin:0}.inline{display:inline-flex;margin-left:6px}
select{padding:5px 6px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:inherit;max-width:15em}input{padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;min-width:0}button{padding:5px 10px;border-radius:6px;border:1px solid var(--acc);background:var(--acc);color:var(--card);cursor:pointer}
button.ghost{background:transparent;color:var(--mut);border-color:var(--line)}h2{margin-top:28px}</style></head><body>
<h1>Review Queue</h1>${base ? '<p><a href="/">← Map</a>' + (focus ? ` · <a href="${base}/">All Reels</a>` : '') + '</p>' : ''}${focus && !reels.length ? '<p class="muted">This Reel is not in your collection.</p>' : ''}
${base
  // Hosted: members see only their collection's count; the desktop sync status and the paid API spend (billing) are not sent.
  ? `<p class="muted">${reels.length} Reels</p>`
  : `<p class="muted">${reels.length} Reels · ${s.counts().places} places · last sync: ${sync ? `${h(sync.status)} at ${h(sync.finished_at ?? sync.started_at)}${sync.detail ? ` — ${h(sync.detail)}` : ''}` : 'never'}${okSync ? ` · last successful: ${h(okSync.finished_at)}` : ''} · paid API spend this month: $${budget.total.toFixed(4)} (ceiling $${budget.ceiling})</p>`}
<form method="post" action="${base}/act"><input type="hidden" name="op" value="run"><input type="hidden" name="key" value="-"><button>Process queue now</button></form>
<h2>Needs attention (${open.length})</h2>${open.map(reelCard).join('') || '<p class="muted">Nothing to review.</p>'}
<h2>Saved (${done.length})</h2>${done.map(reelCard).join('')}
${other.length ? `<h2>Not a place (${other.length})</h2>${other.map(reelCard).join('')}` : ''}
</body></html>`;
}

async function readForm(req: http.IncomingMessage): Promise<Record<string, string>> {
  let body = ''; for await (const c of req) { body += c; if (body.length > 1e6) break; }
  if ((req.headers['content-type'] ?? '').includes('application/json')) return JSON.parse(body || '{}');
  return Object.fromEntries(new URLSearchParams(body));
}

/** Serves the review page and its form actions under `base` ('' locally, '/review' on the server). Returns false if not handled. */
export async function handleReview(app: App, req: http.IncomingMessage, res: http.ServerResponse, o: { base?: string; onRun?: () => Promise<unknown>; onChange?: () => void; collectionId?: number; userId?: number | null; canDelete?: (placeId: string) => boolean } = {}): Promise<boolean> {
  const base = o.base ?? '';
  let url = (req.url ?? '/').slice(base.length) || '/';
  if (!url.startsWith('/')) url = `/${url}`; // "/review?k=…" → "/?k=…"
  if (base && !(req.url ?? '').startsWith(base)) return false;
  if (req.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
    const focus = new URL(url, 'http://x').searchParams.get('k') ?? undefined;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page(app, base, o.collectionId, focus)); return true;
  }
  if (req.method === 'POST' && url === '/act') {
    const f = await readForm(req);
    const key = f.key ?? '';
    // Only Reels of the signed-in user's collection can be changed here.
    if (o.collectionId != null && key !== '-' && (!key || !app.store.getReel(key) || app.store.collectionOf(key) !== o.collectionId)) { res.writeHead(403, { 'Content-Type': 'text/plain' }).end('not in your collection'); return true; }
    if (f.op === 'unlink' && o.collectionId != null) {
      if (o.canDelete && !o.canDelete(f.q!)) { res.writeHead(403, { 'Content-Type': 'text/plain' }).end('only the collection owner or the member who added it can delete this pin'); return true; }
      app.store.deletePlaceFromCollection(o.collectionId, f.q!, o.userId ?? null); o.onChange?.(); res.writeHead(303, { Location: `${base}/#${encodeURIComponent(key)}` }); res.end(); return true; }
    if (f.op === 'choose') {
      // Replacing a pin deletes it from this Reel: the same permission as Delete.
      if (f.replace && o.canDelete && !o.canDelete(f.replace)) { res.writeHead(403, { 'Content-Type': 'text/plain' }).end('only the collection owner or the member who added it can replace this pin'); return true; }
      await chooseCandidate(app.store, app.resolve, key, Number(f.idx), { replace: f.replace || null });
    }
    else if (f.op === 'search') await searchCandidates(app.store, app.resolve, key, f.q!);
    else if (f.op === 'approx') await markApproximate(app.store, app.resolve, key, f.q!);
    else if (f.op === 'note') addNote(app.store, key, f.q!);
    else if (f.op === 'nap') notAPlace(app.store, key);
    else if (f.op === 'nolisting') {
      // Only a pin this Reel is asking about.
      if (!app.store.candidatesFor(key).some((c) => c.replacesPlaceId === f.q)) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('no open listing question for that pin'); return true; }
      rejectListings(app.store, f.q!, o.collectionId);
    }
    else if (f.op === 'unlink') app.store.unlinkPlace(key, f.q!);
    else if (f.op === 'retry') app.store.requeue(key, 'retry requested in review');
    else if (f.op === 'run' && o.onRun) await o.onRun();
    o.onChange?.();
    // Back to the single-Reel view when the action came from there (the Approximate button on a pin opens it).
    const fromFocus = /[?&]k=/.test(String(req.headers.referer ?? ''));
    res.writeHead(303, { Location: key && key !== '-' ? (fromFocus ? `${base}/?k=${encodeURIComponent(key)}` : `${base}/#${encodeURIComponent(key)}`) : `${base}/` }); res.end(); return true;
  }
  return false;
}

export function startReviewServer(app: App, port: number, onRun?: () => Promise<unknown>): http.Server {
  const srv = http.createServer(async (req, res) => {
    try {
      if (await handleReview(app, req, res, { onRun })) return;
      if (req.method === 'GET' && req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ counts: app.store.counts(), lastSync: app.store.lastSync(), budget: app.budget.report() })); return;
      }
      if (req.method === 'POST' && req.url === '/api/intake') {
        // Local/LAN intake (same JSON as the Apps Script endpoint). Requires the inbox token.
        const f = await readForm(req);
        if (!app.cfg.inboxToken || f.token !== app.cfg.inboxToken) { res.writeHead(403).end('{"ok":false,"error":"bad token"}'); return; }
        const id = f.id || `local:${f.shared_at ?? nowIso()}:${f.text ?? ''}`;
        const r = applyItem(app.store, { id, row: 0, kind: 'share', received_at: nowIso(), shared_at: f.shared_at, text: f.text, note: f.note, input_types: f.input_types });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, ...r })); return;
      }
      res.writeHead(404).end('not found');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`Error: ${(e as Error).message}\n\n<- back`);
    }
  });
  srv.listen(port, '127.0.0.1');
  return srv;
}
