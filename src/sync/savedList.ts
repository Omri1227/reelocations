/**
 * Google Maps "Saved" list publisher: saves the ACTUAL Google Maps listing (by Place ID) to a list in the user's own
 * Google account, so the place opens its normal place card in the Google Maps app.
 *
 * There is no Google API for a user's saved lists (checked 2026-11-12: Places API is read-only lookup; My Maps' old
 * API was retired; saved lists are only exportable via Takeout). The only way is the Google Maps web UI in a browser
 * signed in to that account — the same technique as the My Maps publisher, run in the account owner's own session.
 */
import type { Page } from 'playwright-core';
import { nameSimilarity, norm } from '../util/text.ts';

export interface ListingTarget { googlePlaceId: string; name: string; address?: string | null; locality?: string | null }
export interface PlaceCard { url: string; title: string | null; address: string | null; nameMatch: number; branchOk: boolean; why: string }
export interface SaveState { signedIn: boolean | null; saveButton: string | null; saved: boolean | null }

/** Official Maps URL for an exact listing (developers.google.com/maps/documentation/urls). */
export const listingUrl = (t: ListingTarget) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.name || 'place')}&query_place_id=${encodeURIComponent(t.googlePlaceId)}&hl=en`;

async function dismissConsent(page: Page) {
  // EU/consent interstitial (consent.google.com): accept only what is needed to continue.
  if (!/consent\.google\./.test(page.url())) return;
  const b = page.getByRole('button', { name: /reject all|accept all/i }).first();
  if (await b.count()) { await b.click().catch(() => {}); await page.waitForLoadState('domcontentloaded').catch(() => {}); }
}

/** Open the listing and read its place card; checks that it is the expected place and branch. */
export async function openListing(page: Page, t: ListingTarget, timeoutMs = 30_000): Promise<PlaceCard> {
  await page.goto(listingUrl(t), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await dismissConsent(page);
  const h1 = page.locator('h1').filter({ hasText: /\S/ }).first();
  await h1.waitFor({ timeout: timeoutMs }).catch(() => {});
  const title = (await h1.count()) ? (await h1.innerText().catch(() => '')).trim() || null : null;
  const addrBtn = page.locator('button[data-item-id="address"]').first();
  const address = (await addrBtn.count()) ? ((await addrBtn.getAttribute('aria-label')) ?? '').replace(/^Address:\s*/i, '').trim() || null : null;
  const nameMatch = title && t.name ? nameSimilarity(title, t.name) : 0;
  const v = verifyBranch({ title, address }, t);
  return { url: page.url(), title, address, nameMatch: Math.round(nameMatch * 100) / 100, branchOk: v.ok, why: v.why };
}

/**
 * House/street numbers in an address, in order. Postal codes are removed first — "〒605-0802" was read as the numbers
 * 605 and 802 (seen 2026-11-12) — as are long numbers.
 */
const numbersOf = (s: string) => (s.normalize('NFKC')
  .replace(/〒?\s*\d{3}-\d{4}\b/g, ' ')        // Japan
  .replace(/\b\d{5}(?:-\d{4})?\b/g, ' ')         // US ZIP, and 5-digit codes elsewhere
  .replace(/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/gi, ' ') // Canada
  .match(/\d+/g) ?? []).map((n) => String(Number(n)));
/** Does `needle` occur in order (contiguously) inside `hay`? */
const inOrder = (hay: string[], needle: string[]) => needle.length > 0 && hay.some((_, i) => needle.every((n, j) => hay[i + j] === n));

/**
 * Is the opened card the expected place AND branch? (Verified on a chain with two branches 300 m apart, 2026-11-12:
 * shared city words and stray digits made a plain word-overlap check accept the wrong branch.)
 * - Name: similar, and the card carries no extra branch words the expected name lacks ("… Spain-zaka").
 * - Address: the expected street numbers ("1-22-7") appear in the same order on the card; without numbers, the
 *   expected street words (not the city) must all be there.
 */
export function verifyBranch(card: { title: string | null; address: string | null }, t: ListingTarget): { ok: boolean; why: string } {
  if (!card.title) return { ok: false, why: 'the listing did not open (no place card)' };
  // For a pin matched to Google, the stored address starts with Google's own name for the listing.
  const googleName = t.address?.includes(',') ? t.address.split(',')[0]!.trim() : null;
  const sameAsGoogle = !!googleName && norm(googleName) === norm(card.title);
  if (t.name && !sameAsGoogle) {
    const sim = nameSimilarity(card.title, t.name);
    const extra = norm(card.title).split(' ').filter((w) => w.length >= 3 && !norm(t.name).split(' ').includes(w));
    if (sim < 0.6) return { ok: false, why: `the card shows "${card.title}", not "${t.name}"` };
    if (extra.length && !norm(t.address ?? '').split(' ').some((w) => extra.includes(w))) return { ok: false, why: `the card "${card.title}" names another branch than "${t.name}" (${extra.join(' ')})` };
  }
  if (!t.address) return { ok: true, why: 'name matches (no address known to compare)' };
  const want = numbersOf(t.address).filter((n) => n.length <= 4);
  const got = numbersOf(card.address ?? '');
  // Postal codes and other long numbers are not house numbers.
  const street = want.filter((n) => n.length <= 3);
  if (street.length >= 2) return inOrder(got, street) ? { ok: true, why: 'name and street number match' } : { ok: false, why: `the address "${card.address}" has other street numbers than expected (${street.join('-')})` };
  // Street words only: not the place's name, the town, or words address formats spell differently or leave out
  // ("418, Larkin Street, Lower Nob Hill, Tenderloin, California, United States" vs Google's "418 Larkin St, San
  // Francisco, CA 94102" — the same restaurant, seen 2026-11-12).
  const skip = new Set([...norm(t.locality ?? '').split(' '), ...norm(t.name ?? '').split(' '), ...norm(googleName ?? '').split(' ')]);
  const words = norm(t.address).split(' ').filter((w) => w.length >= 4 && !/\d/.test(w) && !skip.has(w) && !GENERIC_ADDRESS_WORDS.has(w));
  const addrN = ` ${norm(card.address ?? '')} `;
  const found = words.filter((w) => addrN.includes(` ${w} `));
  if (street.length === 1) {
    if (!got.includes(street[0]!)) return { ok: false, why: `the address "${card.address}" has another house number than expected (${street[0]})` };
    return found.length || !words.length ? { ok: true, why: 'name, house number and street match' } : { ok: false, why: `the address "${card.address}" has the house number but not the expected street (${words.slice(0, 4).join(', ')})` };
  }
  // No house number at all (rural places): at least a third of the street words, and one if there are any.
  return !words.length || found.length >= Math.max(1, Math.ceil(words.length / 3)) ? { ok: true, why: 'name and street match' } : { ok: false, why: `the address "${card.address}" does not match the expected branch (${words.filter((w) => !found.includes(w)).join(', ')} missing)` };
}
/** Words address formats abbreviate, translate or leave out — never evidence for or against a branch. */
const GENERIC_ADDRESS_WORDS = new Set(['street', 'road', 'avenue', 'lane', 'drive', 'boulevard', 'place', 'square', 'highway', 'route', 'united', 'states', 'kingdom', 'republic', 'district', 'city', 'ward', 'prefecture', 'county', 'province', 'region', 'state', 'chome', 'chōme', 'building', 'floor', 'japan', 'america', 'lower', 'upper', 'north', 'south', 'east', 'west', 'central']);

/** Is this browser signed in, and what does the listing's Save control say? */
export async function readSaveState(page: Page): Promise<SaveState> {
  // The page alone cannot tell: on the server's headless Maps page neither a "Sign in" button nor the account avatar is
  // shown, signed in or not (seen on Railway 2026-11-12). So: avatar → signed in; a visible "Sign in" control → signed
  // out; otherwise unknown (null) — the Save click decides (signed out, it opens Google's sign-in page).
  const avatar = (await page.locator('a[aria-label^="Google Account"], button[aria-label^="Google Account"]').count()) > 0;
  const signIn = (await page.locator('a[aria-label="Sign in"], button[aria-label="Sign in"], a:text-is("Sign in")').count()) > 0;
  const save = page.locator('button[data-value="Save"], button[aria-label^="Save"], button[aria-label^="Saved"]').first();
  const label = (await save.count()) ? ((await save.getAttribute('aria-label')) ?? (await save.innerText().catch(() => ''))).trim() : null;
  return { signedIn: avatar ? true : signIn ? false : null, saveButton: label, saved: label == null ? null : /^saved/i.test(label) };
}

/** Signed-in check by the real action, without saving: open the Save menu, read the list names, close it. */
export async function probeListMenu(page: Page): Promise<{ signedIn: boolean | null; lists: string[]; items?: unknown[]; menuText?: string; detail: string }> {
  try {
    const menu = await openListMenu(page);
    await page.waitForTimeout(1500); // the items fill in after the menu appears
    const items = await menu.locator(ITEM).evaluateAll((els) => els.map((e) => ({
      role: e.getAttribute('role'), label: e.getAttribute('aria-label'), checked: e.getAttribute('aria-checked'),
      text: (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
    })));
    const menuText = ((await menu.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    await page.keyboard.press('Escape').catch(() => {});
    return { signedIn: true, lists: items.map((i) => i.label || i.text).filter(Boolean) as string[], items, menuText, detail: 'the Save menu opened' };
  } catch (e) {
    if ((e as any).code === 'signin') return { signedIn: false, lists: [], detail: (e as Error).message };
    // Not an answer about the sign-in (a slow page, a changed menu): unknown, never "signed out".
    return { signedIn: null, lists: [], detail: `the Save menu did not open: ${(e as Error).message.split('\n')[0]}` };
  }
}

/**
 * What an accounts.google.* address means for the session (null = not a Google account page):
 * - 'signin': Google's sign-in pages — account chooser, e-mail, password, "verify it's you". Only a person can continue.
 * - 'passing': anything else there (the first redirect hop, Google's cookie-rotation page): may return by itself.
 * Seen on Railway 2026-11-13 for a signed-out session: Save → 302 /ServiceLogin → /v3/signin/accountchooser.
 */
export function accountsPageKind(url: string): 'signin' | 'passing' | null {
  let u: URL; try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !/^accounts\.google\.(?:com|[a-z]{2,3}|com?\.[a-z]{2})$/.test(u.hostname)) return null;
  return /\/signin\/|\/accountchooser|\/interactivelogin|\/challenge\//i.test(u.pathname) ? 'signin' : 'passing';
}
const ITEM = '[role="menuitemcheckbox"], [role="menuitemradio"], [role="checkbox"], [role="menuitem"]';

const SAVE_BTN = 'button[data-value="Save"], button[aria-label^="Save"], button[aria-label^="Saved"]';
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The list menu that opens from Save (lists with a checked state, plus "New list"). */
async function openListMenu(page: Page) {
  const menu = page.locator('[role="menu"], [role="dialog"]').filter({ hasText: /new list/i }).last();
  for (let attempt = 0; ; attempt++) {
    await page.locator(SAVE_BTN).first().click({ timeout: 20_000 });
    // Whichever comes first: the list menu (signed in) or a Google account page.
    const first = await Promise.race([
      menu.waitFor({ timeout: 20_000 }).then(() => 'menu' as const),
      page.waitForURL(/^https:\/\/accounts\.google\./, { timeout: 20_000 }).then(() => 'accounts' as const),
    ]).catch(() => 'timeout' as const);
    if (first === 'menu') return menu;
    if (first === 'timeout' && !accountsPageKind(page.url())) throw new Error('the Save menu did not open within 20 s');
    // "Signed out" only when Google STAYS on a sign-in page. A redirect that passes through accounts.google.com and
    // comes back (Google re-checking or rotating the session) is not a sign-out, and an account page that is neither
    // is a failure to retry — never a reason to ask the person to sign in.
    const settled = await settleAccountsPage(page);
    if (settled === 'signin') throw Object.assign(new Error(`not signed in (Save opened Google's sign-in page: ${pathOf(page.url())})`), { code: 'signin' });
    if (settled === 'stuck') throw new Error(`Google's account check did not finish (${pathOf(page.url())})`);
    if (attempt >= 1) throw new Error('Save went to Google\'s account check and back twice without opening the menu');
    await page.locator(SAVE_BTN).first().waitFor({ timeout: 30_000 }); // back on the listing: press Save once more
  }
}
const pathOf = (url: string) => { try { const u = new URL(url); return u.hostname + u.pathname; } catch { return '?'; } };
/** After a redirect to accounts.google.*: 'signin' (a sign-in page for 4 s), 'returned' (left again), or 'stuck'. */
async function settleAccountsPage(page: Page, maxMs = 20_000): Promise<'signin' | 'returned' | 'stuck'> {
  const t0 = Date.now(); let signinSince = 0;
  while (Date.now() - t0 < maxMs) {
    const kind = accountsPageKind(page.url());
    if (kind === null) return 'returned';
    if (kind === 'signin') { signinSince ||= Date.now(); if (Date.now() - signinSince >= 4000) return 'signin'; } else signinSince = 0;
    await page.waitForTimeout(500);
  }
  return 'stuck';
}

/** The signed-in account's e-mail address according to Google itself (null when it cannot be read). Never logged. */
export async function signedInEmail(page: Page): Promise<string | null> {
  try {
    const r = await page.context().request.get('https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', { headers: { origin: 'https://www.google.com' }, timeout: 20_000 });
    return (await r.text()).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0]?.toLowerCase() ?? null;
  } catch { return null; }
}
/**
 * Is this Save-menu entry the named list? The entry's text is an icon-font glyph, the name, then its privacy and count
 * glued on: "\u{e896}ReelocationsPrivate · 1 place" (seen on Railway 2026-11-12).
 */
export function isListEntry(text: string, name: string): boolean {
  const t = text.replace(/^[^\p{L}\p{N}]+/u, '');
  return new RegExp(`^${esc(name)}(?:Private|Shared|Public|\\s|·|$)`, 'i').test(t);
}
/** A list's menu item (first match), or a locator that matches nothing. */
const listItem = (menu: ReturnType<Page['locator']>, name: string) => {
  const items = menu.locator(ITEM);
  return {
    count: async () => (await indexOf(items, name)) >= 0 ? 1 : 0,
    at: async () => { const i = await indexOf(items, name); return i >= 0 ? items.nth(i) : null; },
  };
};
const indexOf = async (items: ReturnType<Page['locator']>, name: string) => (await items.evaluateAll((els) => els.map((e) => e.textContent ?? ''))).findIndex((t) => isListEntry(t, name));
type ListItem = ReturnType<typeof listItem>;
const checkedOf = async (item: ListItem) => { const el = await item.at(); return !!el && (await isChecked(el)); };
/** Tap a menu entry at its position (Google's menu controls time out as locator clicks). */
async function tapItem(page: Page, item: ListItem) {
  const el = await item.at(); if (!el) throw new Error('the list entry is gone');
  const box = await el.boundingBox(); if (!box) throw new Error('the list entry has no position');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
const isChecked = async (item: ReturnType<Page['locator']>) => (await item.getAttribute('aria-checked')) === 'true' || (await item.getAttribute('aria-selected')) === 'true' || (await item.locator('[aria-checked="true"]').count()) > 0;

/**
 * Save the open listing to the named list (created if missing). Idempotent: a listing already in the list is left as it
 * is. Verified by reopening the menu and reading the list's checked state.
 */
/** Run one UI step; a failure names the step ("click "New list": Timeout …"). */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw new Error(`${name}: ${(e as Error).message.split('\n')[0]}`); }
}
/**
 * "+ New list" at the bottom of the Save menu is a pill whose text is a plain <span> (no role, no tabindex — seen on
 * Railway 2026-11-12); Playwright's actionability wait on it timed out. Tap its centre like a person does.
 */
const newListControl = (menu: ReturnType<Page['locator']>) => {
  const span = menu.getByText('New list', { exact: true }).last();
  return {
    click: async (o: { timeout?: number } = {}) => {
      await span.waitFor({ state: 'visible', timeout: o.timeout ?? 15_000 });
      const box = await span.boundingBox();
      if (!box) throw new Error('"New list" has no position on the page');
      await span.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    },
  };
};

/** Probe (operator check): open "New list" and describe the dialog — fields, buttons, a screenshot — then cancel. */
export async function probeNewList(page: Page): Promise<Record<string, unknown>> {
  const menu = await openListMenu(page);
  await page.waitForTimeout(1500);
  const candidates = await menu.locator('*').filter({ hasText: /^\s*New list\s*$/i }).evaluateAll((els) => els.map((e) => ({ tag: e.tagName, role: e.getAttribute('role'), tabindex: e.getAttribute('tabindex'), visible: !!(e as HTMLElement).offsetParent, children: e.children.length })));
  let clicked = 'no';
  try { await newListControl(menu).click({ timeout: 10_000 }); clicked = 'yes'; } catch (e) { clicked = `failed: ${(e as Error).message.split('\n')[0]}`; }
  await page.waitForTimeout(2000);
  const dialog = await page.evaluate(() => ({
    inputs: [...document.querySelectorAll('input, textarea')].filter((e) => (e as HTMLElement).offsetParent).map((e) => ({ tag: e.tagName, type: e.getAttribute('type'), placeholder: e.getAttribute('placeholder'), label: e.getAttribute('aria-label') })),
    buttons: [...document.querySelectorAll('button, [role=button]')].filter((e) => (e as HTMLElement).offsetParent).map((e) => (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 40 && !/account/i.test(t)).slice(-15),
  }));
  const shot = (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64');
  await page.keyboard.press('Escape').catch(() => {}); await page.keyboard.press('Escape').catch(() => {});
  return { newListCandidates: candidates, clicked, dialog, screenshot_jpeg_base64: shot };
}

export async function saveToList(page: Page, listName: string): Promise<{ saved: boolean; already: boolean; created: boolean; detail: string }> {
  let menu = await openListMenu(page);
  await page.waitForTimeout(1500); // the items fill in after the menu appears
  let item = listItem(menu, listName);
  let created = false;
  if (!(await item.count())) {
    // Never create a second list: if the name is anywhere in the menu, it exists but could not be matched — stop.
    const text = ((await menu.textContent()) ?? '') + ' ' + (await menu.locator('[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).join(' ')));
    if (new RegExp(esc(listName), 'i').test(text)) {
      await page.keyboard.press('Escape').catch(() => {});
      throw new Error(`the list "${listName}" exists but its menu entry could not be matched — not creating a duplicate`);
    }
    await step('click "New list"', () => newListControl(menu).click({ timeout: 15_000 }));
    const input = page.locator('input[type="text"]:visible, textarea:visible').last();
    await step('find the list-name field', () => input.waitFor({ timeout: 10_000 }));
    await step('type the list name', () => input.fill(listName, { timeout: 10_000 }));
    // The dialog's Create button, like "New list", times out as a locator click (seen on Railway 2026-11-12): submit with
    // Enter; if the "New list" dialog is still open, tap the visible "Create" text inside it by position.
    await step('submit the new list', async () => {
      await input.press('Enter');
      await page.waitForTimeout(2000);
      const dialog = page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: /New list/ }).filter({ visible: true } as any).last();
      if (await dialog.count()) {
        const create = dialog.getByText('Create', { exact: true }).last();
        const box = await create.boundingBox();
        if (!box) throw new Error('the "Create" button has no position');
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(2000);
        if (await dialog.count()) throw new Error('the "New list" dialog stayed open after Create');
      }
    });
    created = true;
    await page.waitForTimeout(2500);
  } else if (await checkedOf(item)) {
    await page.keyboard.press('Escape');
    return { saved: true, already: true, created: false, detail: `already in "${listName}"` };
  } else {
    await step(`tick "${listName}"`, () => tapItem(page, item));
    await page.waitForTimeout(1500);
  }
  await page.keyboard.press('Escape').catch(() => {});
  // Verify from a fresh menu.
  await page.waitForTimeout(800);
  menu = await openListMenu(page);
  await page.waitForTimeout(1500);
  item = listItem(menu, listName);
  let ok = await checkedOf(item);
  // A list just created may not hold the place yet: tick it now and check once more.
  if (!ok && created && (await item.count())) {
    await step(`tick "${listName}"`, () => tapItem(page, item)); await page.waitForTimeout(1500);
    await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(800);
    menu = await openListMenu(page); await page.waitForTimeout(1500);
    item = listItem(menu, listName);
    ok = await checkedOf(item);
  }
  // A list created from the menu may already contain the place without a checked state shown: accept the Saved label.
  const label = ((await page.locator(SAVE_BTN).first().getAttribute('aria-label')) ?? '').trim();
  await page.keyboard.press('Escape').catch(() => {});
  if (ok || (created && /^saved/i.test(label))) return { saved: true, already: false, created, detail: created ? `list "${listName}" created and the place saved` : `saved to "${listName}"` };
  return { saved: false, already: false, created, detail: `could not confirm the place is in "${listName}" (Save shows "${label || '?'}")` };
}

/**
 * Operator diagnostics for a session (no secrets): Google cookie NAMES with their remaining lifetime, whether Google's
 * own account check sees a signed-in account, and which sign-in / account controls the page shows. Never values.
 */
export async function sessionDiagnostics(page: Page): Promise<Record<string, unknown>> {
  const ctx = page.context();
  const now = Date.now() / 1000;
  const cookies = (await ctx.cookies()).filter((c) => /google\./.test(c.domain));
  const names = cookies.map((c) => `${c.name}@${c.domain}${c.expires > 0 ? ` (${Math.round((c.expires - now) / 3600)} h)` : ' (session)'}`).sort();
  let accounts: string = 'unknown';
  try {
    const r = await ctx.request.get('https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', { timeout: 20_000 });
    const t = await r.text();
    // ["gaia.l.a.r",[["gaia.l.a",1,"<name>","<email>",...]]] when signed in; only the count is reported.
    accounts = `HTTP ${r.status()}, ${(t.match(/"gaia\.l\.a"/g) ?? []).length} signed-in account(s)`;
  } catch (e) { accounts = `error: ${(e as Error).message.split('\n')[0]}`; }
  const controls = await page.evaluate(() => [...document.querySelectorAll('a,button')].map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim())
    .filter((t) => /sign in|google account|account/i.test(t)).map((t) => t.replace(/:.*$/, ': …')).slice(0, 10));
  return { google_cookie_names: names, account_check: accounts, page_controls: controls, url: page.url().replace(/[?#].*$/, '') };
}
