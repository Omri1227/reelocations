# Hosted app (Railway) — reelocations

```
iPhone Shortcut ──► POST /api/intake/<personal token>  (or the old Apps Script inbox, still pulled every 60 s)
                        ▼
Railway service (named "reel-maps" in the original deployment): processes every Reel ONCE → Google listing (Place ID) → restaurant subtype → pins
SQLite + media on the /data volume · accounts · collections · live updates (SSE)
                        ▼                                           ▼
Website (Google Sign-In)                       Desktop publisher (sync-only, the owner's own Chrome profile)
https://<your-app>.up.railway.app               GET /api/publisher/export → one My Map per country → report status
```

## Accounts and privacy

- **Sign up / Sign in with Google** (Google Identity Services). The browser receives a Google-signed ID token on
  Google's own screen; the server checks its RS256 signature against Google's keys and that it was issued for our
  client id (`GOOGLE_OAUTH_CLIENT_ID`). No password is ever seen or stored. Sessions: random 256-bit cookie (`rm_s`,
  HttpOnly, Secure, SameSite=Lax), stored hashed, 180 days, sliding. Returning visitors are restored from the cookie;
  if it is gone, Google One Tap signs them in again without repeating setup.
- **Collections** with roles: *owner* invites/removes members, deletes any pin, disconnects any destination; *member*
  contributes, deletes pins only they added, connects/disconnects only their own destination. Every API, image, review
  action and live-update stream checks membership on the server.
- **Collection #1** (an installation migrated from the desktop version) is claimed once by signing in from the old
  `?k=` link. After that `?k=` and the old cookie give no access to the website; `APP_TOKEN` remains only a
  server-admin secret (backup/import).
- **Intake credentials**: Setup → "Create my Shortcut link" (or a one-time 10-minute pairing code redeemed at
  `POST /api/pair`) issues a personal, revocable link; shares are attributed to that user and collection. The original
  Apps Script Shortcut keeps working for collection 1. Provider keys (Google Places, OpenAI) never leave Railway.
- **Reel keys are per collection**: the same Reel in two collections is two Reels; two members of one collection
  sharing the same Reel → processed once.

## Google My Maps (sync-only desktop publisher)

My Maps has no public API; only a browser signed in as the map's owner can write. So each destination is a desktop
publisher that its owner connects explicitly (Setup → "Create desktop code" → `npm run cli -- connect <url> <code>`).
Google Sign-In on the website does **not** grant My Maps access.

- **One map per country**, a layer per city (≤ 9 layers: My Maps allows 10 and the layer swap needs a free slot).
  Any number of countries: the 11th country gets its own map exactly like the first.
- Only maps whose content changed are touched; each country map succeeds or fails on its own and reports
  **up to date / pending / needs attention** (website: header badge, a dot per country, Setup).
- **Deletions** are tombstoned per collection: the pin leaves the website at once and the country map on the next
  publish; re-processing, listing merges or stale data never bring it back.
- `WORKER_MODE=sync-only` in `.env`: the Windows task (`cli.ts run`) only publishes — it never pulls the inbox or
  processes a Reel. It listens to the collection's live events and publishes seconds after a change, for 14 minutes
  per task start (the 15-minute schedule restarts it).

```powershell
npm run cli -- connect https://<your-app>.up.railway.app <code>
npm run cli -- publish --test-map            # rehearse on disposable "TEST · Reels · <country>" maps
npm run cli -- publish                       # real maps once (MYMAPS_REAL_SYNC=true)
npm run cli -- publish --watch               # stay connected and publish on every change
```

## Restaurant subtypes

Restaurants keep the category *Restaurant* and get an optional subtype (Japanese, sushi & omakase, yakiniku, ramen,
izakaya, Thai, Korean, Chinese, Indian, Vietnamese, burgers, Italian, pizza, Mediterranean, Middle Eastern, Mexican,
French, Spanish & tapas, seafood, steakhouse, vegan & vegetarian). Source, best first: a correction in the pin details (stored for that collection only) › the Google listing's types › the place name › the Reel's own text on the lines naming the place. Unclear →
unset. Filter: Restaurant → subtype chips; a yakiniku place is in both "All restaurants" and "Yakiniku".

## Website interactions

Tabs **Places | Nearby** and a **Review Queue · N** button (this collection's Reels waiting for a person; returning
from the queue keeps the country and filters). **Nearby**: the phone's position (asked only after an explanation, used
only in the page, never sent or stored) → saved places under 1 km / 500 m / 250 m / 100 m, nearest first; weak GPS is
said plainly. **New** marks places added since you started using the collection until you open them; **long-press a
place** (right-click / "s" / Shift+F10 on a computer) → **Star**: starred places are listed first in their country.
New and stars are per person.


Countries screen (default order: most places first; **long-press a country and drag** to reorder — saved per user;
"Reset order" restores the default) · type filter + restaurant subtypes · tap a place → pin highlighted and details ·
tap a pin → its row · **swipe a row left → Delete**, or **Delete beside the screenshot** at the bottom of the details;
both confirm with the place's name (shared collections: the warning says it affects everyone and the connected maps) ·
**tap the screenshot** → large preview; tap the dimmed area to close (pin, filter and map position are kept).

## AI usage indicator (header 🤖)

Shown only to the account that runs this installation (owner of collection 1); everyone else gets 403 from
`/api/ai-usage`. OpenAI has **no supported API for the prepaid balance** (only spend/usage via admin keys), so you enter
the balance (tap 🤖 → "Save balance"); reelocations subtracts the AI spend it records afterwards.

- money left = min(prepaid balance − spend since it was entered, app cap `OPENAI_MONTHLY_BUDGET_USD` − spend this month,
  $3 global ceiling − all paid spend this month); 0 if OpenAI answered "insufficient quota", or if less than one
  worst-case call reservation is left.
- cost per call = recorded actual costs for the configured model: median (typical), 90th percentile (conservative).
- calls per Reel = recorded calls per Reel (re-reads after a screenshot and retries included): mean / 90th percentile.
  Calls before 2026-11-11 carry no Reel, so for those the calls are spread over the Reels whose evidence shows AI use.
- Reels left = calls left ÷ calls per Reel. "Low" below 20 Reels; "?" in the header while the balance is unknown.

## Measured (2026-11-11, live)

| Step | Time |
|---|---|
| iPhone share → Railway | < 1 s |
| → pin saved (exact Google listing) | 7.7 s (11.4 s for a Reel that needed the AI estimate) |
| → open website on the phone | ≈ 1 s after the pin (server-sent events) |
| → published on My Maps (sync-only Windows publisher, change → one layer swap) | 92 s after the pin |
| → visible in the Google Maps iPhone app | after going back to *Maps* and opening the map again (an already open map did not refresh by itself) |
| First publish of all 11 country maps | 16.8 min |

## Operations

```powershell
railway up --service reel-maps --detach
railway logs --service reel-maps
npm test                                                     # offline test suite
npm run railway:plan                                         # compare .railway/railway.ts with the live service
npm run demo                                                 # local server with synthetic data, no accounts
$env:BASE="http://127.0.0.1:18791"; $env:SESSION="…"; node scripts/verify-ui.ts --shots <dir>   # iPhone-size UI checks
node scripts/local-ui-server.ts <copy.sqlite> 18791          # LOCAL copy with a test session (never production)
```

Environment (Railway): `APP_TOKEN` (admin only), `GOOGLE_OAUTH_CLIENT_ID`, `PUBLIC_URL`, `INBOX_URL`, `INBOX_TOKEN`,
`GOOGLE_PLACES_API_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_MONTHLY_BUDGET_USD`, `INSTAGRAM_PAGE_CAPTION`,
`USER_AGENT`, `WORKER_INTERVAL_SEC`, `TRANSCRIBE`, `OCR_LANGS`, `WAIT_FOR_IMPORT`, `GMAPS_LIST_SYNC`. The server refuses to start without
`APP_TOKEN` (it never falls back to the Shortcut token).

**Railway configuration (checked 2026-11-12).** `.railway/railway.ts` (Infrastructure as Code) is the only
configuration: Dockerfile build, `/healthz` (120 s), restart ALWAYS, one replica, the `/data` volume. It owns the
service and the volume (`railway config partials list` → partial `reel-maps`), and `railway config migrate status`
reports that no service reads Config as Code. The legacy `railway.json` (which Railway stops reading on 2026-12-01) was
removed on 2026-11-12; `npm run railway:plan` reported "already up to date" before and after.

*Windows note:* `railway config plan` run directly can fail with "This version of railway/iac requires Railway CLI
5.42.1 or newer" even on a current CLI. The `railway` npm SDK checks the CLI by running the executable named in the `_`
environment variable or plain `railway`; an npm-installed CLI is a `.cmd`/`.ps1` wrapper Node cannot start without a
shell, and Git Bash sets `_` to a POSIX path. `npm run railway:plan` (`scripts/railway-config.ts`) passes the real
`railway.exe`; set `RAILWAY_CLI_BIN` if yours is elsewhere.

## Google Maps list (beta)

Goal: share a Reel → the **actual Google Maps listing** (right branch) is saved to a list in the owner's Google account,
with the computer off, so the place opens its normal place card in the Google Maps app.

- **No supported API** (checked 2026-11-12): Google Maps Platform's Places API only looks places up; My Maps' old API was
  retired; saved lists can only be exported (Takeout). So the server uses Google Maps' own **Save** action in headless
  Chromium with the account's browser session — the same technique as the My Maps publisher, run on the server. This is
  automation of a person's own account in their own session; Google may ask for sign-in again or change the page.
- **Connect:** Setup → *Create Google Maps code* (30 minutes, single use) → on a computer with Chrome:
  `npm run cli -- gmaps-connect https://<your-app> <code> [--list Reelocations]`. A temporary Chrome profile opens; you
  sign in on Google's own page; the CLI sends only the browser session (cookies) to `POST /api/gmaps/session` and deletes
  the temporary profile. The server stores it as `/data/private/gmaps/session-<id>.json` (mode 600). It is never logged
  and never written to the database. Reconnect the same way; Setup → *Disconnect* deletes it.
- **Fresh start:** the collection's FIRST successful connection is the cutoff (`kv gmaps:cutoff:<collection>`). Only
  Reels the server receives after it are saved; places from earlier Reels never are — also after reconnecting,
  disconnecting, retries, redeploys or re-processing an old Reel. A stale queue row for an old place is marked `excluded`.
- **What is saved:** pins with a Google Place ID that are confirmed (not approximate) and have no open listing or
  approximate question in the Review Queue. One row per (destination, Place ID) in `gmaps_saves`: `pending` →
  `verified` | `failed` (retried with back-off, up to 5 times) | `skipped` (branch check failed: the Reel goes to the
  Review Queue with the listing to confirm; *This is the listing* saves it without the check, *None of these* marks it
  `excluded`) | `excluded`. Before
  saving, the server opens the listing by Place ID (`/maps/search/?api=1&query=…&query_place_id=…`) and checks the card:
  the name (no extra branch words) and the street/house numbers (postal codes ignored; with a single house number, the
  street name too). A listing already in the list is left alone; a second list with the same name is never created.
- **Session health:** signed out, Save opens Google's sign-in page; that marks the destination **needs sign-in** (Setup
  shows it) and items wait until you reconnect. The server's headless Maps page shows neither a "Sign in" button nor
  the account avatar, so the page itself is not used to decide. The session file is on the volume and survives
  restarts and redeploys (verified: one connection, about ten redeploys, saves kept working).
- **Operator tools (admin token):** `POST /api/admin/gmaps-probe` `{collection, place_id, name, address?, menu?,
  newlist?, diagnostics?}` opens a listing with the collection's session and reports the card, the Save menu's lists
  (`menu`), the New-list dialog with a screenshot (`newlist`, cancelled) or cookie names/expiry (`diagnostics`, never
  values) — it never saves. `POST /api/admin/gmaps-retry` `{collection, items_now?}` clears "needs sign-in" and, with
  `items_now`, retries failed and held-back items at once.
- **Verified (2026-11-12, Railway, a dedicated test account):** six restaurant Reels shared from an iPhone after
  connecting (Kyoto, Tokyo, San Francisco) were saved to **Reelocations** as their real listings; the list was created by
  the first save; Google's own Save menu then showed "Reelocations · 6 places"; the list and the normal place cards were
  checked in the Google Maps iPhone app; none of the earlier places were queued. Three saves needed a code fix on the
  way (Google's "New list"/"Create" controls ignore normal clicks; list entries start with an icon-font character;
  OpenStreetMap-style addresses tripped the branch check) — all covered by tests now. The branch check refuses a chain's
  other branch 300 m away.
- **Cost:** no new service; Chromium is already in the image. It starts only when listings are waiting (a few per
  60-second cycle) and uses ~0.3–0.5 GB for well under a minute per run — at Railway's usage prices that is cents per
  month (estimate, not measured).
- **Fallback:** the desktop My Maps publisher (custom pins at the listing's coordinates, needs the computer on).

## Cost

Railway Hobby **$5/month minimum** (includes $5 usage; this service ≈ 0.15–0.3 GB RAM). Google Sign-In: free.
Google Places: within the free monthly cap (code stops at 4,500 calls). OpenAI: ≤ $3/month in code. No new paid
infrastructure was added for accounts, sharing or sync.

## What is verified where

| Behaviour | reelocations web app | Google My Maps | Google Maps iPhone app |
|---|---|---|---|
| New pin appears | live (server-sent events, ≈1 s) — verified on a real iPhone | next publish (≈90 s) — verified | after reopening the map — verified on a real iPhone |
| Edit (subtype, listing) | live — verified in emulation | next publish — verified on test maps | **not yet checked on the iPhone** |
| Delete | at once — verified on a real iPhone (swipe) | next publish — verified on test maps | **not yet checked on the iPhone** |
| Nearby, New, Star, Review Queue | verified in Chrome iPhone emulation only | n/a | n/a |
| Desktop offline / interrupted publish | map shows pending for the countries not published | stays as it was; the next run catches up (tests) | follows My Maps |
| Approximate pins, AI Balance panel, leave / delete account | verified in Chrome iPhone emulation and tests | n/a | n/a |
| Shortcut sends the Reel link + automatic screenshot | the 12 most recent real shares (2026-11-11/12) each arrived with both, 1–2 s apart | n/a | n/a |
| Google Maps list (beta): listing by Place ID, branch check, Save → Reelocations | n/a | n/a | verified from Railway with a test account (6 Reels) |
| Google Maps list (beta): the list and place cards on the iPhone | n/a | n/a | verified on a real iPhone |
