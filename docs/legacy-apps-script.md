# Setup (one time, about 30 minutes)

> **Legacy (before accounts, 2026-11-09/10).** This is the original single-user setup: Apps Script inbox + Google Sheet +
> a desktop worker that processed Reels itself. The current setup is in [README.md](../README.md) (hosted server with Google
> Sign-In; the Shortcut gets its personal link from **Setup**) and [HOSTED.md](HOSTED.md). Collection 1 still accepts the
> Apps Script Shortcut, so this page is kept for that path and for the Shortcut-building details.

Everything runs in **your** accounts and on **your** PC. No password or session cookie is sent to any backend.

## 0. Desktop

```powershell
cd "C:\reel-google maps conector"
npm install
copy .env.example .env      # then edit .env as you go through the steps below
npm run doctor
```

## 1. Inbox: Google Apps Script (durable queue, works while the PC is off)

1. Go to <https://script.google.com> → **New project** → name it `reelocations inbox`.
2. Replace `Code.gs` with the contents of `apps-script/Code.gs`. Under Project Settings, tick "Show appsscript.json" and paste `apps-script/appsscript.json`.
3. **Project Settings → Script properties → Add**: `TOKEN` = a long random string. For example, generate one with
   `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
4. **Deploy → New deployment → Web app**. Execute as: **Me**. Who has access: **Anyone**. Authorize it; the script creates a Sheet "reelocations inbox" and a Drive folder "reelocations media" in your account.
5. Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`) into `.env` as `INBOX_URL`, and put the token into `INBOX_TOKEN`.
6. Check it: `curl -L -d "{\"token\":\"<TOKEN>\",\"action\":\"pull\",\"after\":0}" "<INBOX_URL>"` should print `{"ok":true,"items":[],"last":0}`.
7. **Phone index page** (the way back to the Reel — links inside the Google Maps app are not tappable on iPhone): open `<INBOX_URL>?k=<TOKEN>` in Safari and use **Share → Add to Home Screen**.
8. **Updating the code later:** paste the new `Code.gs`, then **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. Do *not* use "New deployment" — that creates a new URL and the Shortcut keeps using the old one.

> "Anyone" access is required because Shortcuts cannot do Google OAuth. Every request must carry the token. Treat the token like a password for this queue only; rotate it by changing the script property.

## 2. iPhone Shortcuts

### Shortcut A: "Save Reel to Map" (share sheet)

Create a new shortcut, then in the details panel (ⓘ) turn on **Show in Share Sheet**. Then add these actions:

1. **Receive** *URLs* and *Text* from **Share Sheet**. If there's no input: **Get Clipboard**.
2. **Get Type** of *Shortcut Input*. Rename the output to `InputType`.
3. **Text**: *Shortcut Input*. Rename it to `Shared`.
4. **Ask for Input**: Text, prompt "Note (optional)", default answer empty. Rename to `Note`. *(Delete this step if you never want the prompt.)*
5. **Format Date**: *Current Date*, Date Format **ISO 8601**, Include Time **on**. Rename to `SharedAt`. ⚠️ Not a time-only format: that sends year `0001` (seen live; the worker then falls back to the time the inbox received the share).
6. **Get Contents of URL**: URL = your `INBOX_URL`. Method **POST**. Request Body **JSON**:
   - `token` (Text) = your token
   - `action` (Text) = `share`
   - `text` (Text) = `Shared`
   - `shared_at` (Text) = `SharedAt`
   - `note` (Text) = `Note`
   - `input_types` (Text) = `InputType`
7. **Get Dictionary Value** `message` from *Contents of URL* → **Show Notification** with that value.

**If the shortcut doesn't appear in any share sheet** (not even Safari's) although *Show in Share Sheet* is on — verified fix (2026-11-10): in the shortcut's **Details** turn *Show in Share Sheet* off → ✓ → on → ✓, force-close Shortcuts, restart the iPhone. Check in Safari first (Share → bottom of the action list, or **Edit Actions…**), then in Instagram.

Test it from Instagram: Reel → Share (paper plane) → **Share to…** (or "More") → *Save Reel to Map*. Then open the Sheet's **Inbox** tab. The `text` and `input_types` columns show exactly what Instagram passed.

If the phone is offline, the Shortcut shows an error and nothing is saved. Share again later. Repeating a share is always safe: same text and timestamp give the same id, and a second share of the same Reel just adds a share date.

### One tap: automatic screenshot inside "Save Reel to Map" (verified live 2026-11-10)

So that sharing the Reel is all you do, "Save Reel to Map" also uploads a screenshot of the Reel you are sharing:

1. Directly below the **Receive** block add **Take Screenshot** (יצירת צילום מסך). Run from Instagram's share sheet it captures the Reel itself (verified).
2. At the very end add **Convert Image** (Screenshot → **JPEG**) → **Base64 Encode** (Converted Image, *Line Breaks: None*) → a copy of **Get Contents of URL** whose **URL is the blue URL variable** (a duplicated block loses it — the upload then silently goes nowhere), with JSON `action`=`media`, `data`=Base64 Encoded, `reel_url`=Shortcut Input, `filename`=`screenshot.jpg`, `token`, `shared_at`.
3. Tip: tap **more** on the Reel's description before sharing, so the screenshot contains the whole text (place lists, location lines).

What the link alone gives: only the Reel ID. Captions and location tags are not available from the link in any permitted way (Meta oEmbed terms; no API for other people's Reels; web search found nothing for real Reels on 2026-11-10). The screenshot is how they get in: local OCR reads the location tag/description/overlay text, and the OpenAI fallback looks at the picture when needed. A screenshot shows one moment — for montages with many stops, type the places in the note when you share.

## 3. Google My Maps: one map per country, one layer per city

What you see on the iPhone: **Google Maps → You → Maps** lists one map per country, e.g. `Reels · 🇯🇵 Japan`. Inside a map, the **legend** (tap a place → the map name → *View map legend*) lists one section per city/locality, e.g. *Kyoto*, *Tokyo*. My Maps has no nested folders and allows 10 layers per map, so the first 9 localities of a country get their own layer and later ones share **Other places** (assignment never changes afterwards).

The worker creates these maps itself (My Maps → *Create a new map* → title) in your signed-in worker profile:

1. **Rehearse on TEST maps first:** `npm run sync -- --test-map` creates/updates `TEST Reels · <flag> <country>` maps.
2. When the TEST maps look right on the iPhone, set `MYMAPS_REAL_SYNC=true` in `.env`. From then on every run updates the real `Reels · <country>` maps. (Before that, real maps are never written.)
3. Prefer to make a map yourself? Create it in My Maps and register it: `npm run cli -- register-map jp <map id>` (add `--test-map` for a TEST map).
4. Places wait one run for their country/city lookup (OpenStreetMap reverse lookup, English names, cached); Tokyo's wards are grouped as *Tokyo*.
5. Category icons and colours come from the KML; don't restyle layers by hand (each sync swaps in a fresh layer). Keep the maps **private**.

> Don't add pins by hand to a city layer the worker manages: sync will *refuse* to run (it never deletes them). Put your own pins in a layer with another name.
>
> Legacy single-layer mode (one map, layer `Reels (auto)`): set `MYMAPS_GROUPING=single` and `MYMAPS_MAP_ID`.

## 4. Sign the worker into Google (on this PC only)

```powershell
npm run google:login      # opens a normal Chrome window on data/chrome-profile — sign in, open the map once, close the window
npm run google:verify     # LIVE test against the disposable map; writes data/live-verification.json
```

If the automated clicks fail (Google changed the UI), use `npm run sync -- --assist`. The worker opens the map and the file, you click "Add layer" → "Import" and upload the file; once the worker confirms Google shows the new layer, you delete the old `Reels (auto)` layer (⋮ → Delete this layer), and the worker verifies.

## 5. Schedule

```powershell
npm run install-task      # every 15 min + at logon; overlapping runs are skipped (lock file)
npm run serve             # review UI at http://127.0.0.1:8787 whenever you want to triage
```

## 6. Optional extras

- **Hebrew or other spoken languages:** set `TRANSCRIBE_LANGUAGE=hebrew` and `OCR_LANGS=eng+heb`.
- **OpenAI fallback (recommended):** set `OPENAI_API_KEY` (platform.openai.com → API keys; buy prepaid credits with auto-recharge **off**, so the cap is also enforced on the billing side). Defaults: `OPENAI_MODEL=gpt-6-luna`, `OPENAI_MONTHLY_BUDGET_USD=3` (the code never exceeds US$3/month in total), `OPENAI_MAX_FRAMES=8`, `OPENAI_IMAGE_DETAIL=high`, `OPENAI_DAILY_CALLS=15`. It runs only after the free local methods leave a Reel unresolved, partly resolved or approximate, at most once per set of evidence. It receives your note, on-screen text, transcript and frames from what you attached; the Reel URL is context only (the model cannot open it). Its suggestions are saved automatically only when OpenStreetMap confirms them (near-exact name, inside the stated city/country, not ambiguous, model confidence "high"); everything else goes to review with the reason.
- **Legacy Claude vision fallback:** `ANTHROPIC_API_KEY` + `VISION_MONTHLY_BUDGET_USD` (suggestions only, never auto-saved).
- **Google Places IDs-only lookup:** set `GOOGLE_PLACES_API_KEY` (billing-enabled key). Restrict the key to "Places API (New)", and add a Cloud budget alert and a per-day quota of 50.

## 7. Captions from the public Reel page (opt-in)

`INSTAGRAM_PAGE_CAPTION=true` lets the worker open the public Reel page once per shared Reel in a **headless browser with no login and a fresh profile** (not your Google worker profile), and read the caption a visitor sees (`og:description`, ~7 s, 25 s timeout). A plain HTTP download does not contain it (Instagram serves an app shell). The result is cached with the Reel; a failure is retried after 7 days at most.

⚠️ Instagram's Terms of Use prohibit collecting information "in an automated way" without their permission. Keep this off if that matters to you; the screenshot path works without it. Meta's oEmbed (`INSTAGRAM_OEMBED`) stays off: its terms prohibit extracting the caption at all.

When the caption lists places explicitly (📍 lines, numbered lists) they are looked up directly — **no OpenAI call and no video analysis**. Hiking routes in the caption ("Route 66" in a hiking Reel, "… Trail") are kept separate and matched to OSM route lines (Overpass; retried automatically when busy). A bus/tram stop that only shares part of a name (a "…ort" stop for a listed "…ord") is never accepted automatically. OpenAI's `web_search` was tested on real Reel links (2026-11-10) and found nothing, so it is not used.

## 8. Phone review buttons, pin photos, Google Places

**Updating the inbox code** (needed once for both features below): paste the new `apps-script/Code.gs`, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy** (same URL).

- **Review buttons on the phone page:** each Reel in review shows ✓ buttons for the best options (similar-name options are marked "≈ similar name"), a box to type the place (**Find it** re-runs the Reel with your text as a note; **Pin approximately** saves the typed area), and **Not a place**. Your tap is stored in the Sheet and applied by the next worker run.
- **Pin photos:** each pin gets a picture — the frame whose on-screen text names that place ("📸 From the Reel (0:05)"), else the automatic share screenshot ("📸 Reel preview"); no picture → the pin is still saved. Images are uploaded to the Drive folder "reelocations media", shared "anyone with the link" (unguessable URL) so My Maps can fetch them; My Maps then shows the photo at the top of the place card (verified in the My Maps editor 2026-11-10).
- **Google Places (optional, `GOOGLE_PLACES_API_KEY`):** Google Cloud console → new project → enable **Places API (New)** → **Credentials → API key** → restrict it to Places API (New) → link a billing account (required by Google even for the free allowance). Text Search (Pro fields) has 5,000 free calls/month; the worker stops at 4,500/month, so it stays $0. Same-place results keep OpenStreetMap coordinates plus the Google place ID ("Open in Google Maps" opens that exact listing); Google-only places use Google's location, re-fetched by place ID every 25 days (Google allows caching coordinates for 30 days). A bus/train stop or a similar name alone is never pinned.
