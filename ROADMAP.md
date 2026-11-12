# reelocations — Roadmap

> **Historical design notes (2026-11-09).** Written for the first, desktop-only version. The investigation findings and
> the reasoning still hold; the architecture has since moved to a hosted server with accounts — see
> [README.md](README.md) and [docs/HOSTED.md](docs/HOSTED.md).

**Target experience.** Share a Reel on iPhone. Later, open the **official Google Maps app → Saved → Maps → "Reel places"** and find the correctly classified place or trail. Tapping it shows the name, a category icon, the original Reel link, the date you shared it, and a short quoted memory cue. Unidentified Reels wait in a review queue with their link and date.

Evidence labels used throughout:
- **[official]** documented by the vendor.
- **[live]** observed by this project against the real service on 2026-11-09.
- **[report]** third-party or user reports.
- **[assumption]** not yet verified.
- **[fixture]** exercised only against recorded or synthetic data.

---

## 1. Investigation findings (what decided the design)

| Question | Finding | Evidence |
|---|---|---|
| Can My Maps be written programmatically? | No public API for My Maps. The old Maps Engine API was retired. The supported write path is the web editor's **Import** or **Reimport and merge → Replace all items / Update matching items** on a layer. | [official] My Maps help "Import map features"; API absence is background knowledge |
| Does a Sheet/CSV source auto-refresh My Maps? | No. Import is a one-time copy and changes need "Reimport and merge". | [official] same help page |
| Do My Maps appear in the iPhone Google Maps app? | Yes: Saved (or You) → Maps lists maps you created. | [official] Google Maps Help 3045850 (iOS) |
| Are lines shown in the app? Are descriptions shown? Are links tappable? | Lines and descriptions: expected, but **unverified on device**. A 2024 user report says **links in My Maps descriptions are not tappable or copyable in the iOS app** (they work on Android and desktop). | [report] r/GoogleMyMaps; **must be checked on an iPhone** (see docs/HOSTED.md, "What is verified where") |
| What does Instagram's share sheet pass? | Expected: the Reel URL (`https://www.instagram.com/reel/<code>/?igsh=…`) as a URL and/or text. | [assumption]. The Shortcut stores the raw input and its type in the Inbox sheet, so your first share verifies it |
| Supported Reel metadata | **Decision 2026-11-10: oEmbed is OFF** — Meta permits its data only for displaying an embed and prohibits extracting/persisting it. Background: Meta oEmbed has been **tokenless since 2026-06-15** (public content only). It returns embed HTML and attribution; a caption is present only if Meta includes it. **Geotags are not exposed.** | [official] Meta developer blog 2026-06-15; [live] the endpoint accepted a tokenless call (a fake Reel id returned "Media Not Found", not an auth error). No real public Reel was available to inspect, so caption availability is **[assumption]** |
| Video and audio of someone else's Reel | No supported or authorized API to download it. → Only media **you** provide from Photos (screenshot or screen recording) is used. yt-dlp-style downloading is deliberately not implemented. | Instagram terms; design decision |
| Google Places for point lookup | Per-SKU free caps since 2025-03-01: Essentials 10k, Pro 5k and Enterprise 1k per month. **Text Search "IDs only" is listed as unlimited free**, but a billing account is required. | [report] several 2026 pricing guides; verify on Google's pricing page before enabling |
| Can Places data be persisted into My Maps? | Places lat/lng may be cached for **≤30 days**; `place_id` may be stored. → Coordinates stay sourced from **OpenStreetMap** (ODbL, storable with attribution). Google is optional and stores only the `place_id`. | [official] Maps Platform Service Specific Terms |
| OSM services | Nominatim: ≤1 req/s plus an identifying User-Agent. Overpass: ~10k req/day guideline. **Overpass was overloaded during development** (HTTP 502, 40–180 s responses, mirror timeouts). | [official] usage policies; [live] |
| Local media analysis | tesseract.js OCR reads the Reel location overlays in about 5 s per image. Local Whisper (`Xenova/whisper-base` via transformers.js, CPU) transcribed a 7 s clip in about 6 s; it heard "Banias" as "Bannyus". | [live] local runs on this PC |

## 2. Chosen approach

```
iPhone share sheet ──► Shortcut "Save Reel to Map" ──HTTPS POST (token)──► Apps Script web app (your Google account)
                                                                                 └─ Google Sheet "Inbox" (durable queue)
                                                                                 └─ Drive folder (attached media)
                                    ┌──────────────── desktop worker (this repo, Windows Task Scheduler, every 15 min) ───┐
                                    │ pull inbox (cursor) → SQLite (idempotent)                                            │
                                    │ 1. metadata: Meta oEmbed (official)                                                  │
                                    │ 2. lookup: clue extraction → Nominatim + Overpass (OSM) → rank → strict confirm      │
                                    │ 3. escalate only if unresolved: local OCR of frames/screenshots, local Whisper       │
                                    │ 4. optional, budget-gated: Claude Haiku 5.5 vision → *suggestions only* (review)     │
                                    │ 5. review queue: local web UI / CLI (choose candidate, search, approximate, note)    │
                                    │ 6. status → Apps Script "Status" sheet → mobile index page (tappable Reel links)    │
                                    │ 7. sync: full KML snapshot → My Maps layer "Reels (auto)" via a local Chrome profile │
                                    │    (layer swap: import fresh layer → verify → delete old), pre-check + post-reload  │
                                    └──────────────────────────────────────────────────────────────────────────────────────┘
                                                        ▼
                         Google Maps app (iPhone) → Saved → Maps → "Reel places"
```

Why this design:
- **The phone never depends on the PC.** Apps Script is free, lives in your own account, and receives shares while the desktop is off. The only credential involved is a random token that grants access to this queue. No Google or Instagram password or cookie is sent anywhere.
- **The PC is the only writer to Google.** It uses a dedicated Chrome profile you sign into yourself (`npm run google:login`), so cookies stay on this machine.
- **Replace-all is made safe:**
  1. The local DB has no delete path for places, so a snapshot always contains every place.
  2. Before replacing, the worker downloads the layer's KML and **blocks** if it contains anything the snapshot lacks.
  3. After replacing, it re-downloads the KML in a fresh request and checks every id.
  4. Unchanged data skips the write entirely.
- **OSM supplies coordinates and route lines** (storable). The Google `place_id` is optional and only adds an "open in Google Maps" link.
- **Honesty rules.** Cues are quoted from your note or the Reel's own text, never generated. Vision output never auto-confirms a place. An area-only result is labelled "≈ … (approx.)" and "⚠️ APPROXIMATE". A candidate outside a stated area, an ambiguous name, or a whole region is never auto-confirmed.

### Alternatives considered

| Option | Verdict |
|---|---|
| Google Maps **Saved lists** via desktop automation | Rejected as primary: no API, **cannot hold route lines**, notes are plain text, and the UI is just as brittle. The fallback is the per-place "Open in Google Maps" URL, from which you can save a place to a list by hand. |
| My Maps sourced from a **Google Sheet** | Rejected: no auto-refresh, and lines need a WKT column (support not verified). KML carries points, lines, styles and ExtendedData ids in one file. |
| **Chrome extension** in your normal profile | Rejected: same UI automation, but it couples to your daily browser and makes overlap and offline queueing harder. The worker profile is isolated. |
| Standalone or embedded map | Out of scope by requirement (it is not the Google Maps app). |
| Cloud worker (Cloud Run, Workers) | Rejected: it would need your Google session in the cloud, which violates the no-cookies-to-a-backend rule. Apps Script covers the always-on part for free. |
| Training a model / CLIP visual matching | Deferred (Phase 7). Scenery-only matching is unreliable without strong priors. Such Reels go to review, as required. |

## 3. Build order, files, and acceptance checks

| Phase | Files | Acceptance check | Status |
|---|---|---|---|
| 0. Riskiest integration probe | `src/sync/mymaps.ts`, `src/sync/verify.ts` | `npm run google:verify` against a **disposable** map: replace-all write, survives a browser restart, ids, Reel URL and date kept, line imported, retry doesn't duplicate | **Code done; needs your sign-in.** Not run live (no Google session available to this agent) |
| 1. Durable intake | `apps-script/Code.gs`, `src/intake/{parse,inbox}.ts` | Token required; repeated payload → same id; pull cursor; media round-trip; index page | ✅ unit and e2e against the **real Code.gs in an emulator**; [assumption] real Apps Script deployment |
| 2. Local store + idempotency | `src/db.ts` | Duplicate delivery is a no-op; repeated share keeps the earliest date; places only enriched | ✅ unit and e2e |
| 3. Metadata + lookup | `src/metadata/instagram.ts`, `src/extract/clues.ts`, `src/geo/{osm,geometry,googlePlaces}.ts`, `src/resolve/resolver.ts` | Venue, trail (route plus trailhead), multiple places, approximate area, ambiguity → review | ✅ **[live] OSM** (scripts/live-lookup.ts) + recorded fixtures; oEmbed [fixture] |
| 4. Media fallback | `src/media/{ffmpeg,ocr,transcribe,vision}.ts`, `src/pipeline.ts` | Screenshot OCR resolves; video frames resolve; vision is budget-gated and suggestion-only | ✅ local OCR and ffmpeg in e2e; Whisper [live-local]; vision [fixture] (no key) |
| 5. Review + status | `src/review/{actions,server}.ts`, `src/cli.ts` | Choose, search, approximate, note, not-a-place; status pushed to the phone index | ✅ e2e (actions), smoke (index page) |
| 6. Sync + recovery | `src/sync/{kml,sync}.ts`, `src/worker.ts` | Offline → queued; crash mid-import → retried with backoff; no duplicates; unchanged → skip; foreign feature → blocked | ✅ e2e with FakeMyMaps [fixture] |
| 7. (later) Visual matching | — | CLIP similarity against Wikimedia images of OSM candidates, used only to *rank* review candidates | Not started |
| 8. (later) Second layer | — | Auto-split above ~1,800 features (warning already emitted) | Not started |

## 4. Operating cost (100 shared Reels/month, 1 user, total cap US$3/month)

Prices: OpenAI Standard rates for `gpt-6-luna` — $0.10 / 1M input tokens, $0.50 / 1M output (developers.openai.com/api/docs/pricing, checked 2026-11-10). Image tokens: patches = ceil(w/32)·ceil(h/32) × 1.2; a 768×1365 frame ≈ **1,240 tokens at detail=high**, ≈ 173 at low (**estimate** from the documented formula for the GPT-5.6 Luna family; the first live call's `usage` will confirm). Text part ≈ 2,000 tokens (instructions + JSON schema + note/OCR/transcript).

| Scenario (labelled estimates) | Fallback rate | Frames | Input / output tokens per call | Per Reel | Per month (100 Reels) |
|---|---|---|---|---|---|
| **Normal**: screenshot or 30–60 s clip, 1–2 places | 30% | 8 @ high | 11,920 / 300 | $0.0013 | **$0.04** |
| All 100 need OpenAI | 100% | 8 @ high | 11,920 / 300 | $0.0013 | **$0.13** |
| All 100, heavier: long transcript, ~5 places each | 100% | 8 @ high | 13,420 / 1,200 | $0.0019 | **$0.19** |
| Worst-case **reservation** the code books per call | 100% | 8 @ high | 15,080 / 1,500 | $0.0023 | $0.23 |
| Cheaper variant (OPENAI_IMAGE_DETAIL=low) | 100% | 8 @ low | 4,884 / 1,200 | $0.0011 | $0.11 |
| Absolute ceiling from the daily cap (15 calls × 30 days × worst case) | — | — | — | — | $1.02 |

Even the heaviest case is ~6% of the $3 cap, so no extra frame limits are needed; `OPENAI_MAX_FRAMES` (default 8, max 16) and `OPENAI_IMAGE_DETAIL` are the levers if prices change.

| Other item | Cost | Notes |
|---|---|---|
| Transcription | $0 | local Whisper (`Xenova/whisper-base`, CPU). OpenAI `gpt-4o-mini-transcribe` would be ~$0.003/min — not used |
| Geocoding / country-city lookup / routes | $0 | OpenStreetMap Nominatim + Overpass, ≤1 req/s, cached 30–90 days |
| Hosting (inbox, queue, phone index page) | $0 | Apps Script + Google Sheet in your account |
| Storage | $0 | Drive (15 GB free). Videos ≤30 MB each: 100 clips ≈ 0.5–1.5 GB/month — delete old files in Drive's "reelocations media" folder now and then |
| Google Places IDs-only (off) | $0 | unchanged |
| Web search tool | not used | would be $10 / 1,000 calls — deliberately not enabled |
| **Total expected** | **≈ $0.04–0.19/month** | hard ceiling $3 in code |

**How the cap is enforced (budget.ts, media/openai.ts):** before every call the worst-case cost is *reserved* in the SQLite ledger inside a `BEGIN IMMEDIATE` transaction (so the scheduled run and the review UI cannot both spend the last cents); the call is refused if the provider cap (`OPENAI_MONTHLY_BUDGET_USD`, ≤3) or the global ceiling ($3 across all paid services) would be exceeded, or the daily call cap is hit; the actual cost is settled from the response's `usage`. Retries: one retry for 429 rate limits (honouring Retry-After) and 5xx, inside the same reservation; quota/billing errors are not retried; a failed call keeps its worst case on the ledger. **When the budget is exhausted** nothing is sent: the Reel stays in review with its link and date, marked to be requeued automatically when the next month starts.

## 5. Setup

Superseded by the hosted version: see [README.md](README.md) and [docs/HOSTED.md](docs/HOSTED.md).

## 6. Known risks

- **My Maps UI automation can break** when Google changes the editor. Mitigations: text-based locators, a screenshot on failure, `npm run sync -- --assist` (you click and the worker verifies), and a KML always written to `data/sync/`.
- **Description links are not tappable or copyable in iOS Google Maps** [live, iPhone, 2026-11-10]. Mitigation: the Apps Script **index page** (add it to your Home Screen) lists every Reel with tappable links and Google Maps links. The Reel URL is still shown in the description text.
- **Overpass overload** delays route lines. The hike is saved as a point and the line is added on a later run (`enrichRoutes`).
- **OSM coverage gaps** (e.g. a café missing in OSM) go to review, never to a guess. Optional Google `place_id` lookup helps you open the place.
- **Category icons**: per-category My Maps icon numbers in the KML style ids plus colours plus an emoji in the name [live in My Maps 2026-11-10]. "Replace all items" was dropped because it blanked titles; the sync now swaps layers, so the map briefly holds two `Reels (auto)` layers during a sync.
