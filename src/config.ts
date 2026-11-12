import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Config {
  dataDir: string;
  dbPath: string;
  userAgent: string;
  inboxUrl?: string;
  inboxToken?: string;
  nominatimUrl: string;
  overpassUrls: string[];
  instagramOembed: boolean;
  /** Opt-in: read the caption from the public Reel page with a headless browser (against Instagram's ToS — see pagecaption.ts). */
  instagramPageCaption: boolean;
  googlePlacesKey?: string;
  ocrLangs: string;
  transcribe: 'auto' | 'off';
  transcribeLanguage?: string;
  anthropicKey?: string;
  visionModel: string;
  visionMonthlyBudgetUsd: number;
  /** OpenAI fallback: on whenever a key is set; capped per month (and by the global $3 ceiling in budget.ts). */
  openaiKey?: string;
  openaiModel: string;
  openaiMonthlyBudgetUsd: number;
  openaiDetail: 'low' | 'high';
  openaiMaxFrames: number;
  openaiDailyCalls: number;
  mymapsMapId?: string;
  mymapsTestMapId?: string;
  mymapsLayerName: string;
  /** country = one My Map per country with a layer per city (default); single = the legacy one-layer map (MYMAPS_MAP_ID). */
  mymapsGrouping: 'country' | 'single';
  /** Real (non-TEST) country maps are only written when this is true — turn it on after the TEST maps pass. */
  mymapsRealSync: boolean;
  mymapsTitlePrefix: string;
  /** one-map (default): a single "Reels" map with a layer per country. per-country: a map per country, layer per city. */
  mymapsLayout: 'one-map' | 'per-country';
  mymapsMapTitle: string;
  chromePath?: string;
  chromeProfileDir: string;
  reviewPort: number;
}

/** Minimal .env loader: KEY=VALUE lines, does not override real environment variables. */
export function loadDotEnv(file = path.join(ROOT, '.env')): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export function loadConfig(overrides: Partial<Config> = {}): Config {
  loadDotEnv();
  const e = process.env;
  const dataDir = overrides.dataDir ?? opt(e.REEL_MAPS_DATA_DIR) ?? path.join(ROOT, 'data');
  const cfg: Config = {
    dataDir,
    dbPath: path.join(dataDir, 'reel-maps.sqlite'),
    userAgent: opt(e.USER_AGENT) ?? 'reel-maps/0.1 (single-user personal tool)',
    inboxUrl: opt(e.INBOX_URL),
    inboxToken: opt(e.INBOX_TOKEN),
    nominatimUrl: opt(e.NOMINATIM_URL) ?? 'https://nominatim.openstreetmap.org',
    overpassUrls: (opt(e.OVERPASS_URLS) ?? 'https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // Off by default: Meta's oEmbed terms allow its data only for showing an embed; extracting/persisting the caption is prohibited (checked 2026-11-10).
    instagramOembed: (opt(e.INSTAGRAM_OEMBED) ?? 'false') === 'true',
    instagramPageCaption: opt(e.INSTAGRAM_PAGE_CAPTION) === 'true',
    googlePlacesKey: opt(e.GOOGLE_PLACES_API_KEY),
    ocrLangs: opt(e.OCR_LANGS) ?? 'eng',
    transcribe: opt(e.TRANSCRIBE) === 'off' ? 'off' : 'auto',
    transcribeLanguage: opt(e.TRANSCRIBE_LANGUAGE),
    anthropicKey: opt(e.ANTHROPIC_API_KEY),
    visionModel: opt(e.VISION_MODEL) ?? 'claude-haiku-5-5',
    visionMonthlyBudgetUsd: Number(opt(e.VISION_MONTHLY_BUDGET_USD) ?? '0') || 0,
    openaiKey: opt(e.OPENAI_API_KEY),
    openaiModel: opt(e.OPENAI_MODEL) ?? 'gpt-6-luna',
    openaiMonthlyBudgetUsd: Math.min(3, Number(opt(e.OPENAI_MONTHLY_BUDGET_USD) ?? '3') || 0),
    openaiDetail: opt(e.OPENAI_IMAGE_DETAIL) === 'low' ? 'low' : 'high',
    openaiMaxFrames: Math.max(0, Math.min(16, Number(opt(e.OPENAI_MAX_FRAMES) ?? '8') || 0)),
    openaiDailyCalls: Math.max(1, Number(opt(e.OPENAI_DAILY_CALLS) ?? '30') || 30),
    mymapsMapId: opt(e.MYMAPS_MAP_ID),
    mymapsTestMapId: opt(e.MYMAPS_TEST_MAP_ID),
    mymapsLayerName: opt(e.MYMAPS_LAYER_NAME) ?? 'Reels (auto)',
    mymapsGrouping: opt(e.MYMAPS_GROUPING) === 'single' ? 'single' : 'country',
    mymapsRealSync: opt(e.MYMAPS_REAL_SYNC) === 'true',
    mymapsTitlePrefix: opt(e.MYMAPS_TITLE_PREFIX) ?? 'Reels · ',
    mymapsLayout: opt(e.MYMAPS_LAYOUT) === 'per-country' ? 'per-country' : 'one-map',
    mymapsMapTitle: opt(e.MYMAPS_MAP_TITLE) ?? 'Reels',
    chromePath: opt(e.CHROME_PATH),
    chromeProfileDir: path.join(dataDir, 'chrome-profile'),
    reviewPort: Number(opt(e.REVIEW_PORT) ?? '8787'),
    ...overrides,
  };
  if (overrides.dataDir && !overrides.dbPath) cfg.dbPath = path.join(cfg.dataDir, 'reel-maps.sqlite');
  if (overrides.dataDir && !overrides.chromeProfileDir) cfg.chromeProfileDir = path.join(cfg.dataDir, 'chrome-profile');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}
