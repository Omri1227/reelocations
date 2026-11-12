/**
 * Reel Maps inbox — Google Apps Script web app in YOUR Google account.
 * Durable queue between the iPhone Shortcut and the desktop worker, so shares are never lost while the PC is off.
 *
 *  POST {token, action:"share", text, shared_at, note, input_types}     -> {ok, id, duplicate}
 *  POST {token, action:"media", data(base64), mime, filename, reel_url?, shared_at, note?} -> {ok, id}
 *  POST {token, action:"pull", after}                                    -> {ok, items:[...], last}
 *  POST {token, action:"media_get" | "media", id}                         -> {ok, mime, data, filename}  (worker)
 *  POST {token, action:"status", items:[...]}                             -> {ok, updated}
 *  GET  ?k=<token>                                                        -> mobile HTML index of saved Reels
 *
 * Setup: Project Settings → Script properties → TOKEN = <long random string>. Deploy → Web app →
 * Execute as: Me, Who has access: Anyone. Nothing here needs your password; the token only grants access to this queue.
 */
var INBOX = 'Inbox', STATUS = 'Status';
var INBOX_COLS = ['row', 'id', 'kind', 'received_at', 'shared_at', 'text', 'note', 'input_types', 'reel_url', 'media_ref', 'mime', 'filename'];
var STATUS_COLS = ['reel_key', 'url', 'shared_at', 'status', 'reason', 'places_json', 'updated_at', 'candidates_json'];
// Base64 makes uploads ~33% larger and Apps Script caps a request at ~50 MB, so files are limited to 30 MB.
var MAX_MEDIA_BYTES = 30 * 1024 * 1024;

// Errors also carry a human-readable `message`: the iPhone Shortcuts show the `message` field as their notification.
function json_(o) { if (o && o.ok === false && !o.message) o.message = 'Not saved: ' + o.error; return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function sheet_(name, cols) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(cols); return sh; }
  // Older sheets: append header cells for columns added later (e.g. candidates_json).
  var head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  cols.forEach(function (c) { if (head.indexOf(c) < 0) { sh.getRange(1, head.length + 1).setValue(c); head.push(c); } });
  return sh;
}

function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.create('Reel Maps inbox');
  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}

function folder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var f = DriveApp.createFolder('Reel Maps media');
  props.setProperty('FOLDER_ID', f.getId());
  return f;
}

function checkToken_(t) {
  var want = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return !!want && typeof t === 'string' && t.length >= 16 && t === want;
}

function hex_(bytes) {
  return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; }).join('');
}

/** Idempotency key: same payload (text + timestamp) retried by the Shortcut => same id. */
function keyFor_(parts) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, parts.join('|'), Utilities.Charset.UTF_8)).slice(0, 24);
}

function rows_(sh) {
  var v = sh.getDataRange().getValues();
  var head = v[0];
  return v.slice(1).map(function (r) { var o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; });
}

function append_(sh, cols, obj) {
  sh.appendRow(cols.map(function (c) { return obj[c] === undefined || obj[c] === null ? '' : obj[c]; }));
}

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, error: 'invalid JSON' }); }
  if (!checkToken_(body.token)) return json_({ ok: false, error: 'bad token' });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var now = new Date().toISOString();
    var inbox = sheet_(INBOX, INBOX_COLS);
    if (body.action === 'share') {
      var text = String(body.text || '').slice(0, 5000);
      if (!text) return json_({ ok: false, error: 'empty share' });
      var sharedAt = String(body.shared_at || now);
      var id = 's_' + keyFor_([text, sharedAt]);
      var existing = rows_(inbox).filter(function (r) { return r.id === id; })[0];
      if (existing) return json_({ ok: true, id: id, duplicate: true });
      var row = inbox.getLastRow(); // header is row 1, so first item gets row number 1
      append_(inbox, INBOX_COLS, { row: row, id: id, kind: 'share', received_at: now, shared_at: sharedAt, text: text, note: String(body.note || '').slice(0, 2000), input_types: String(body.input_types || '') });
      return json_({ ok: true, id: id, duplicate: false, message: 'Saved. It will appear on your map after the next sync.' });
    }
    if (body.action === 'media' && body.data) {
      var bytes = Utilities.base64Decode(body.data);
      if (bytes.length > MAX_MEDIA_BYTES) return json_({ ok: false, error: 'file too large (max 30 MB). In the Shortcut, Encode Media at 960×540, trim the clip, or send screenshots' });
      var mid = 'm_' + keyFor_([String(body.filename || ''), String(bytes.length), String(body.shared_at || ''), String(body.reel_url || '')]);
      var dup = rows_(inbox).filter(function (r) { return r.id === mid; })[0];
      if (dup) return json_({ ok: true, id: mid, duplicate: true });
      var blob = Utilities.newBlob(bytes, String(body.mime || 'application/octet-stream'), String(body.filename || mid));
      var file = folder_().createFile(blob);
      append_(inbox, INBOX_COLS, { row: inbox.getLastRow(), id: mid, kind: 'media', received_at: now, shared_at: String(body.shared_at || now), note: String(body.note || ''), reel_url: String(body.reel_url || ''), media_ref: file.getId(), mime: blob.getContentType(), filename: blob.getName() });
      return json_({ ok: true, id: mid, duplicate: false, message: 'Attached.' });
    }
    // A pin image from the desktop worker: stored in the media folder and shared "anyone with the link" so My Maps can
    // fetch it while importing (My Maps then keeps its own copy — verified live 2026-11-10).
    if (body.action === 'image_put' && body.data) {
      var ib = Utilities.base64Decode(body.data);
      if (ib.length > 5 * 1024 * 1024) return json_({ ok: false, error: 'image too large' });
      var img = folder_().createFile(Utilities.newBlob(ib, 'image/jpeg', String(body.filename || 'pin.jpg')));
      img.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return json_({ ok: true, id: img.getId(), url: 'https://drive.google.com/thumbnail?id=' + img.getId() + '&sz=w800' });
    }
    if (body.action === 'pull') {
      var after = Number(body.after || 0);
      var items = rows_(inbox).filter(function (r) { return Number(r.row) > after; }).slice(0, 200);
      var last = items.length ? Number(items[items.length - 1].row) : after;
      return json_({ ok: true, items: items.map(function (r) { r.row = Number(r.row); return r; }), last: last });
    }
    if ((body.action === 'media_get' || body.action === 'media') && body.id) {
      var f = DriveApp.getFileById(String(body.id));
      var b = f.getBlob();
      return json_({ ok: true, mime: b.getContentType(), filename: f.getName(), data: Utilities.base64Encode(b.getBytes()) });
    }
    if (body.action === 'status' && body.items) {
      var st = sheet_(STATUS, STATUS_COLS);
      var all = st.getDataRange().getValues();
      var index = {};
      for (var i = 1; i < all.length; i++) index[all[i][0]] = i + 1;
      var n = 0;
      body.items.forEach(function (it) {
        var rowVals = [it.reel_key, it.url || '', it.shared_at, it.status, it.reason || '', JSON.stringify(it.places || []), it.updated_at, JSON.stringify(it.candidates || [])];
        if (index[it.reel_key]) st.getRange(index[it.reel_key], 1, 1, rowVals.length).setValues([rowVals]);
        else { st.appendRow(rowVals); index[it.reel_key] = st.getLastRow(); }
        n++;
      });
      return json_({ ok: true, updated: n });
    }
    return json_({ ok: false, error: 'unknown action' });
  } finally {
    lock.releaseLock();
  }
}

function esc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/**
 * Review decision from the phone page (called with google.script.run). Stored as an Inbox row of kind "review";
 * the desktop worker applies it on its next run. action: choose (value = candidate ref) | find (value = typed place)
 * | approx (value = area) | nap (not a place).
 */
function reviewDecision(k, reelKey, url, action, value) {
  if (!checkToken_(k)) throw new Error('Not authorised');
  if (['choose', 'find', 'approx', 'nap'].indexOf(action) < 0) throw new Error('unknown action');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var inbox = sheet_(INBOX, INBOX_COLS);
    var now = new Date().toISOString();
    var id = 'r_' + keyFor_([reelKey, action, String(value || ''), now]);
    append_(inbox, INBOX_COLS, { row: inbox.getLastRow(), id: id, kind: 'review', received_at: now, shared_at: now, text: action, note: String(value || '').slice(0, 300), input_types: reelKey, reel_url: url || '' });
    // Immediate feedback on the page until the worker has applied it.
    var st = sheet_(STATUS, STATUS_COLS); var all = st.getDataRange().getValues();
    for (var i = 1; i < all.length; i++) if (all[i][0] === reelKey) { st.getRange(i + 1, 4).setValue('decision sent — applies on the next run'); break; }
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/** Mobile index (works in Safari): every Reel with a tappable link, date, status, places and Google Maps links. */
function doGet(e) {
  var k = e && e.parameter && e.parameter.k;
  if (!checkToken_(k)) return HtmlService.createHtmlOutput('Not authorised.');
  var st = sheet_(STATUS, STATUS_COLS);
  var inbox = sheet_(INBOX, INBOX_COLS);
  var known = {};
  var items = rows_(st);
  items.forEach(function (r) { known[r.url] = true; });
  // Shares not yet processed by the desktop still show up (with link + date) as "queued".
  rows_(inbox).forEach(function (r) {
    if (r.kind !== 'share') return;
    var m = String(r.text).match(/https?:\/\/\S+/);
    var url = m ? m[0] : '';
    var canon = url.replace(/\?.*$/, '').replace(/\/reels?\/|\/p\//, '/reel/');
    if (!known[url] && !known[canon]) items.push({ url: url, shared_at: r.shared_at, status: 'queued (desktop has not synced yet)', places_json: '[]', reason: '' });
  });
  items.sort(function (a, b) { return String(b.shared_at).localeCompare(String(a.shared_at)); });
  // Apps Script serves this page inside a sandboxed iframe; without target=_top a tap tries to load Instagram INSIDE
  // that frame, which Instagram refuses → blank page (seen on iPhone 2026-11-10). _top hands the link to Safari/iOS.
  var html = '<!doctype html><base target="_top"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reel Maps</title>' +
    '<style>body{font:16px/1.4 -apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#f6f6f4;color:#1d1d1b}' +
    '@media (prefers-color-scheme:dark){body{background:#161615;color:#ecebe6}.c{background:#22221f!important;border-color:#34332f!important}a{color:#7cc79f!important}}' +
    '.c{background:#fff;border:1px solid #e3e2dd;border-radius:10px;padding:10px 12px;margin:10px 0}a{color:#2f6f4f;word-break:break-all}.m{opacity:.7;font-size:14px}</style><h2>Reel Maps</h2>';
  items.forEach(function (r) {
    var places = []; try { places = JSON.parse(r.places_json || '[]'); } catch (x) {}
    html += '<div class="c"><div>' + (r.url ? '<a href="' + esc_(r.url) + '">Open Reel</a>' : '(no link)') + ' · <span class="m">' + esc_(String(r.shared_at).slice(0, 16).replace('T', ' ')) + ' · ' + esc_(r.status) + '</span></div>';
    places.forEach(function (p) {
      html += '<div>' + esc_(p.emoji) + ' <a href="' + esc_(p.maps_url) + '">' + esc_(p.name) + '</a>' + (p.confidence === 'approximate' ? ' <b>≈ approximate</b>' : '') + '<div class="m">' + esc_(p.cue || '') + '</div>' +
        (p.image ? '<img src="' + esc_(p.image) + '" loading="lazy" style="max-width:100%;border-radius:8px;margin-top:6px"><div class="m">' + esc_(p.image_label || '') + '</div>' : '') + '</div>';
    });
    if (r.reason && (!places.length || r.status === 'needs_review')) html += '<div class="m">' + esc_(r.reason) + '</div>';
    if (r.status === 'needs_review' && r.reel_key) {
      var cands = []; try { cands = JSON.parse(r.candidates_json || '[]'); } catch (x) {}
      var rk = esc_(r.reel_key), ru = esc_(r.url || '');
      html += '<div class="rv" data-k="' + rk + '" data-u="' + ru + '">';
      cands.slice(0, 5).forEach(function (c) { html += '<button class="b" data-a="choose" data-v="' + esc_(c.ref) + '">✓ ' + esc_(c.emoji + ' ' + c.name) + '<span class="m"> · ' + esc_(c.where) + '</span></button>'; });
      html += '<div class="row"><input placeholder="Type the place (e.g. a village or trail name)"><button class="b s" data-a="find">Find it</button></div>' +
        '<div class="row"><button class="b s" data-a="approx">📍 Pin approximately (typed area)</button><button class="b s" data-a="nap">Not a place</button></div><div class="m fb"></div></div>';
    }
    html += '</div>';
  });
  html += '<style>.b{display:block;width:100%;text-align:left;margin:6px 0;padding:10px;border-radius:8px;border:1px solid #c9c8c2;background:#f0efe9;font:inherit;color:inherit}.b.s{display:inline-block;width:auto;margin-right:6px}.row{margin:6px 0}.row input{width:100%;box-sizing:border-box;padding:9px;border-radius:8px;border:1px solid #c9c8c2;font:inherit;margin-bottom:6px}@media (prefers-color-scheme:dark){.b,.row input{background:#2c2b27;border-color:#45443f;color:inherit}}</style>' +
    '<script>var K=' + JSON.stringify(k) + ';document.addEventListener("click",function(e){var b=e.target.closest(".b");if(!b)return;var rv=b.closest(".rv");var a=b.getAttribute("data-a");var v=b.getAttribute("data-v")||"";var inp=rv.querySelector("input");if(a==="find"||a==="approx"){v=(inp.value||"").trim();if(!v){inp.focus();return;}}if(a==="nap"&&!confirm("Mark this Reel as not a place?"))return;var fb=rv.querySelector(".fb");fb.textContent="Saving…";rv.querySelectorAll("button").forEach(function(x){x.disabled=true;});google.script.run.withSuccessHandler(function(){fb.textContent="✓ Saved — applies on the next run (within 15 min).";}).withFailureHandler(function(err){fb.textContent="Not saved: "+err.message;rv.querySelectorAll("button").forEach(function(x){x.disabled=false;});}).reviewDecision(K,rv.getAttribute("data-k"),rv.getAttribute("data-u"),a,v);});</script>';
  return HtmlService.createHtmlOutput(html).setTitle('Reel Maps').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
