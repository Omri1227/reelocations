# Result quality — research plan and results

Goal: fewer wrong pins and fewer unnecessary trips to the Review Queue, measured on real Reels, without "improving" by
sending more items to review.

## 1. What is measured

| Metric | Definition |
|---|---|
| **Exact place & branch accuracy** | Required labelled places that got a correct pin. Correct = within the label's tolerance (0.3 km for a restaurant, a few km for a lake or mountain), not a generic "Area/Place" pin when the label is a specific business or landmark, and, when the label names Google listing(s), linked to one of them (this is the *branch* check: a chain restaurant named after its neighbourhood must not get the chain's branch in another district). |
| Location accuracy | Same, but the right spot is enough (no listing / generic-pin requirement). |
| **Precision of automatically saved pins** | Correct pins ÷ all pins the system saved without a person choosing them. A pin that matches no labelled place (e.g. a market mentioned only as the fish supplier) is a false positive. |
| **Multi-location recall** | For Reels that list several places: required places found ÷ required places. |
| **Coverage vs review** | *Coverage*: Reels with a findable place that end **resolved** (no review needed) with every required place exactly right. *Review rate*: Reels left in the Review Queue. Ambiguous Reels (no specific place exists) count as correct only if they produce **no** pin, or only optional ones. |
| **Category filter correctness** | For every correct pin: does it appear under the right type chip (its category is one the label accepts)? Reported as filter inclusion errors (shown under a wrong chip) and exclusion errors (a required place missing from its chip). |
| **Cuisine filter correctness** | Same for restaurant subtypes (Yakiniku, Sushi, …) where the label states one. |

Every number is reported with its sample size and split by case type (restaurant, natural landmark, hiking route,
multi-location, ambiguous/incomplete).

## 2. Evaluation sets

* **Real set** (`private/eval/real-labels.json`, git-ignored: it lists a person's own saved Reels): all 37 Reels saved in one real collection as of 2026-11-11, labelled
  by hand from the Reel caption, the on-screen text and the stored Google/OSM responses. Correct listings are the
  Google place IDs that match the Reel (branch, street address). Labels marked `"confidence": "medium"` rely on the
  video frames (the AI's reading) rather than on text.
* **Fixture set** (`test/eval/fixtures.json`): 15 written captions covering what the real set lacks — hiking routes,
  more multi-location lists, chain restaurants with branches, and ambiguous captions. These are fixtures, not real
  Reels, and are reported separately.
* **Holdout**: fixed **before tuning** by a rule nobody tunes against: a Reel is in the holdout when the first hex digit
  of `sha1(reel_key)` is 0–4 (≈ 1/3). Fixtures marked `"split": "holdout"` likewise. Tuning looks only at the dev
  split; the holdout is scored once at the end.

## 3. How a run works (no extra AI spend)

`node scripts/eval-quality.ts --db <copy of the live database>` replays the **real pipeline** on a scratch copy:
places, links, candidates, deletions and listing decisions are wiped; captions, notes, cached OCR readings and the
OpenAI answers already paid for are kept and **replayed** (no new OpenAI call is ever made by the harness). OSM and
Google lookups come from the stored HTTP cache; a lookup the new code needs that is not cached is made once (OSM is
free, Google Places "Text Search" stays inside the app's free monthly cap) and cached for every later run. After the
Reels, the same follow-up steps as the server's cycle run (Google listing matching, duplicate merge, category and
subtype backfill). The output is the metrics above plus every failure, written to `private/eval/quality/<name>.json` (git-ignored).

## 4. Targets (set before tuning)

| Target | Value |
|---|---|
| Exact place & branch accuracy, real dev | ≥ 90 % |
| Exact place & branch accuracy, real holdout | ≥ 85 % |
| Precision of automatically saved pins | ≥ 95 % |
| Multi-location recall | ≥ 90 % |
| Coverage (findable Reels resolved with no review needed) | ≥ 75 %, and never below the baseline |
| Ambiguous Reels with no wrong pin | 100 % |
| Category correctness of correct pins | ≥ 95 % |
| Cuisine correctness (labelled restaurants) | ≥ 90 % |

Guard rail: a change that raises accuracy while lowering coverage is rejected unless it removes a wrong pin.

## 5. Method

1. Run the baseline on the current code.
2. Group every failure by stage: clue extraction (what text is treated as a place name), place lookup (OSM/Google
   choice, branch), listing match (Google ID for an existing pin), category/cuisine, AI-estimate verification, and
   review policy (when a Reel is parked).
3. Fix the weakest stages first, rerun on dev after each change, keep a change only if it does not cost coverage.
4. Score the holdout once, report before/after and the remaining failures.

## 6. Results (2026-11-11)

Per-Reel results (before/after, every pin and failure) are in `private/eval/quality/` — git-ignored, because they
list a person's saved Reels. Anyone can rerun the fixture set: `npm run eval:quality -- --only fixtures`. No OpenAI call was made by any run; the uncached OSM/Google lookups during tuning were about 300 in total
(Google Text Search, inside the free monthly cap).

### Real Reels (37, from the live collection)

| Metric | Baseline | Final | Target |
|---|---|---|---|
| Exact place & branch accuracy, all | 76.6 % (36/47) | **95.7 % (45/47)** | — |
| …dev (27 Reels) | 75.0 % (24/32) | **100 % (32/32)** | ≥ 90 % ✅ |
| …holdout (10 Reels), **first blind score** | 80.0 % (12/15) | 80.0 % (12/15) | ≥ 85 % ❌ |
| …holdout after two more fixes (no longer blind, see below) | | 86.7 % (13/15) | |
| Google listing / branch accuracy | 90.0 % (18/20) | **100 % (25/25)** | — |
| Precision of automatically saved pins | 83.0 % (39/47) | **97.9 % (46/47)** | ≥ 95 % ✅ |
| Multi-location recall | 94.1 % (16/17) | 94.1 % (16/17) | ≥ 90 % ✅ |
| Coverage: findable Reels resolved, no review needed | 35.3 % (12/34) | **85.3 % (29/34)** | ≥ 75 % ✅ |
| Review rate (all Reels) | 54.1 % (20/37) | **16.2 % (6/37)** | — |
| Ambiguous Reels with no wrong pin | 100 % (3/3) | 100 % (3/3) | 100 % ✅ |
| Category correct (= type filter) | 92.5 % (37/40) | **100 % (46/46)** | ≥ 95 % ✅ |
| Cuisine correct (restaurant subtype filter) | 81.8 % (9/11) | 90.9 % (10/11) | ≥ 90 % ✅ |
| Filter errors: shown under a wrong chip / missing from its chip | 3 / 10 | 0 / 2 | |

By case type (exact accuracy · pin precision · coverage): natural landmarks (19) 57.9 %·77.8 %·42.1 % → **100 %·100 %·94.7 %**;
restaurants (11) 81.8 %·69.2 %·36.4 % → **90.9 %·90.9 %·90.9 %**; multi-location (4) 94.1 %·100 %·0 % → 94.1 %·100 %·25 %;
ambiguous (3): no wrong pin before and after. The real collection has **no hiking-route Reel**; those are fixtures only.

Honesty note on the holdout: it was scored once after the dev tuning (80.0 %, unchanged from baseline, coverage
22 % → 44 %). Two failures it exposed were general bugs (a place's town not yet known when its Google listing was
looked up; a city sight losing to the same-named village), fixed afterwards — so 86.7 % is no longer a blind number.

### Fixtures (15 written captions, not real Reels)

| Metric | Baseline | Final |
|---|---|---|
| Exact accuracy | 61.1 % (11/18) | 83.3 % (15/18) |
| Hiking routes (4) | 0 % (0/4) | 75 % (3/4) |
| Pin precision | 86.7 % | 94.4 % |
| Coverage | 41.7 % | 75.0 % |

### What was wrong, by stage, and what changed

The examples below are **illustrative descriptions** of the kinds of failures found; the real Reels behind them are in
the git-ignored per-Reel results. The numbers above are measured; the examples are not a sample.

1. **Review policy / clue extraction (the biggest loss of coverage).** Menu items and prices ("Drink Bar JPY 380"),
   opening hours ("Weekdays"), feature bullets ("Traditional ryokan stay…"), street addresses ("2F Example Bldg",
   "福岡市…1-2-3"), the city around a found restaurant, "Located in the heart of <district>", a generic note ("volcano")
   and the same place written in another script each kept a finished Reel in review. Now: prices/hours/lowercase
   bullets are not names; addresses are context only; a city among the hits is context; leftover caption phrases OpenAI
   read and did not list are dropped; copies are matched on their identifying words and the AI's local-script name.
2. **Wrong pins (precision).** A market mentioned only as the supplier was pinned; a dish name matched an unrelated
   restaurant in another district; a street address pinned a whole city quarter instead of the restaurant named in
   【brackets】; an AI estimate for a mountain pass landed 100 km inside the neighbouring country. Now: "selected from X"
   is a mention; 【name】 is a place; an AI estimate must lie in the country the AI named.
3. **Google listing match.** Too strict for: exact names far from an AI estimate (a small shrine), a one-letter typo in
   an onsen inn's name, addresses without a country, duplicate listings 200 m apart, a ticket office competing with the
   gorge it serves, several listings of one mountain range. Now handled; an *area* pin never goes to review for a listing.
4. **Lookup ambiguity.** OSM's and Google's copy of the same large feature (a mountain range, a national park) was
   treated as two candidates; a same-name lake on another continent competed with the one in the Reel's park. Fixed
   (cross-source/contained copies, inside-vs-outside the Reel's area, parks resolved first to give context).
5. **Categories/cuisines.** AI "cave" for a gorge; an OSM building tag beating Google's temple type; Google "izakaya"
   beating the Reel's "yakiniku"; a named hiking path saved as a generic place. Fixed.
6. **Japanese names.** Google is now asked in the clue's own language (a mountain's kanji name finds its "Mt. …" listing).

### Medium-confidence matches (2026-11-12)

Rule: a match that is right by name and inside the Reel's area but not certain — two same-named options within 25 km
(e.g. two branches), a low overall score (0.60–0.68), an AI suggestion that only partly matches the map — is now saved
as an **Approximate** pin and the Reel **stays in the Review Queue** with the pin itself (confirm) and the alternatives
(replace). Towns/areas are excluded, and a listed place saved only as approximate still lets the AI step look for an
exact match.

| Same day, same inputs (2026-11-12) | Before the rule | With the rule |
|---|---|---|
| Real: exact place & branch accuracy | 95.7 % (45/47) | 95.7 % (45/47) |
| Real: pin precision | 97.9 % (46/47) | 97.9 % (46/47) |
| Real: multi-location recall | 94.1 % (16/17) | 94.1 % (16/17) |
| Real: coverage / review rate | 85.3 % / 16.2 % | 85.3 % / 16.2 % |
| Fixtures: exact accuracy | 83.3 % (15/18) | **94.4 % (17/18)** |
| Fixtures: pin precision | 94.4 % (17/18) | 95.0 % (19/20) |
| Fixtures: multi-location recall | 88.9 % (8/9) | **100 % (9/9)** |

The first version of the rule cost real accuracy (95.7 % → 93.6 %): approximate pins counted a listed place as found,
which skipped the AI step that pins it exactly, and a distance-only duplicate check hid a restaurant 30 m from another.
Both were fixed before the numbers above.

### Remaining failures

Real (described, not named): a chain restaurant whose correct branch is listed on Google only in Japanese still gets
another branch; a national park the AI marks as "mentioned" is not pinned; two mountain places wait in review for a
listing choice; one restaurant's subtype is "izakaya" (Google) instead of steak/yakiniku; a hiking Reel waits in review
for two routes OpenStreetMap does not name. Fixtures: a famous restaurant with two real branches, and a dumpling chain
whose original shop is on a road named like another district.

Existing pins are not re-processed automatically; new Reels use the new rules.
