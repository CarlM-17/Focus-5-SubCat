/**
 * ============================================================================
 *  FRESH FOCUS 5 — CAMANAVA sales monitoring + issue log  (single file app)
 * ============================================================================
 *  Backed by Google Sheet "Fresh_5_Focus", 4 tabs:
 *    FocusSubDept      A:H  Month, Store ID, Store Name, Focus Sub-Dept,
 *                           Sales, Sales LY, Diff %, Diff Val
 *    IssuesAndConcerns A:Q  Store ID .. Resolved? [Y/N]  (header is NOT row 1)
 *    ListOfStores      A:F  No, Region, AREA, STORE ID, STORE NAME, Remarks
 *    Focus5List        A    Focus 5 Sub-Dept
 *
 *  Every Google API call uses Node's built-in `https`, NOT the `googleapis`
 *  npm package — on Railway googleapis throws ERR_STREAM_PREMATURE_CLOSE.
 *  IPv4 is forced (family: 4) and requests time out at 30s.
 *
 *  Env vars:
 *    SHEET_ID             defaults to the Fresh_5_Focus id below
 *    GOOGLE_CLIENT_EMAIL  service account email (from its JSON key)
 *    GOOGLE_PRIVATE_KEY   service account private key (literal \n is fine)
 *  The sheet must be shared with GOOGLE_CLIENT_EMAIL as Editor.
 *
 *  NOTE: the whole UI is the HTML string at the bottom of this file. The client
 *  JS inside it deliberately uses string concatenation and never template
 *  literals, so there are no ${ } collisions with the outer template literal.
 * ============================================================================
 */

const express = require('express');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3005;

const SHEET_ID = process.env.SHEET_ID || '1ZDANpTkxJ-42T1RbZogx2z_LbECAwUAfon9V546U8qg';
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || '';

// Pasting a service-account key into a hosting dashboard mangles it in a few
// predictable ways: the surrounding quotes from the JSON value survive, the
// "\n" escapes stay literal, or the real newlines get flattened to spaces.
// Any of those produce "DECODER routines::unsupported" from crypto.sign, so
// normalise all of them back into a well-formed PEM here.
function normalizePrivateKey(raw) {
  let k = String(raw || '').trim();
  if (k.length > 1 && ((k[0] === '"' && k[k.length - 1] === '"') ||
                       (k[0] === "'" && k[k.length - 1] === "'"))) {
    k = k.slice(1, -1);
  }
  k = k.replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\r/g, '');
  const m = k.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return k;
  const body = m[2].replace(/\s+/g, '');            // strip however it was wrapped
  const lines = body.match(/.{1,64}/g) || [];       // and re-wrap at PEM's 64 cols
  return '-----BEGIN ' + m[1] + '-----\n' + lines.join('\n') + '\n-----END ' + m[1] + '-----\n';
}

const PRIVATE_KEY = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY);

const TAB_SALES = 'FocusSubDept';
const TAB_ISSUES = 'IssuesAndConcerns';
const TAB_STORES = 'ListOfStores';
const TAB_FOCUS = 'Focus5List';

// Stores must refresh FocusSubDept weekly; the week is measured from Monday
// 00:00 Manila (UTC+8, no DST). All comparisons run in a single "Manila
// wall-clock" frame (real UTC epoch + 8h) so the server's own timezone and
// the sheet's serial dates line up without any offset juggling at compare time.
const MANILA_OFFSET_MS = 8 * 3600 * 1000;

// Issue log columns A..Q, in sheet order.
const ISSUE_FIELDS = [
  'storeId',            // A  Store ID
  'area',               // B  Area                    (auto from ListOfStores)
  'storeName',          // C  Store Name              (auto from ListOfStores)
  'date',               // D  Date                    (auto = entry date)
  'reportedBy',         // E  Reported by
  'focusCategory',      // F  Focus 5 Category        (Focus5List)
  'issueCategory',      // G  Issue Category          (Price/Delivery/Quality/CSL/Other)
  'issueDescription',   // H  Issue Description
  'priority',           // I  Priority                (Low/Medium/High)
  'reportedTo',         // J  Reported to Buyer / MRG
  'dateReported',       // K  Date Reported
  'feedback',           // L  Feedback
  'resolutionDetails',  // M  Resolution Details
  'dateResolved',       // N  Date Resolved
  'daysOpen',           // O  Days Open               (computed)
  'remarks',            // P  Remarks / Notes
  'resolved',           // Q  Resolved? [Y/N]
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/* ============================================================================
 *  LOW-LEVEL: native https + service account JWT
 * ==========================================================================*/
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const opts = Object.assign({ family: 4 }, options); // family:4 forces IPv4
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('Request to Google timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let saTokenCache = { token: null, expiry: 0 };
async function getServiceAccountToken() {
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY environment variables');
  }
  const now = Math.floor(Date.now() / 1000);
  if (saTokenCache.token && now < saTokenCache.expiry - 60) return saTokenCache.token;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = header + '.' + claim;
  const signature = base64url(crypto.sign('RSA-SHA256', Buffer.from(signingInput), PRIVATE_KEY));
  const jwt = signingInput + '.' + signature;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  const r = await httpsRequest({
    method: 'POST',
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  const data = JSON.parse(r.body.toString() || '{}');
  if (!data.access_token) {
    throw new Error('Service account token failed: ' + (data.error_description || data.error || r.status));
  }
  saTokenCache = { token: data.access_token, expiry: now + (data.expires_in || 3600) };
  return data.access_token;
}

async function sheetsApi(method, apiPath, bodyObj) {
  const token = await getServiceAccountToken();
  const body = bodyObj ? JSON.stringify(bodyObj) : null;
  const headers = { 'Authorization': 'Bearer ' + token };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  const r = await httpsRequest({
    method: method,
    hostname: 'sheets.googleapis.com',
    path: '/v4/spreadsheets/' + SHEET_ID + apiPath,
    headers: headers,
  }, body);
  const data = JSON.parse(r.body.toString() || '{}');
  if (r.status >= 400) throw new Error((data.error && data.error.message) || ('Sheets API error ' + r.status));
  return data;
}

async function readRange(a1) {
  const data = await sheetsApi('GET', '/values/' + encodeURIComponent(a1));
  return data.values || [];
}

// Same, but returns raw values: dates come back as sheet serial numbers rather
// than locale-formatted strings, which the update tracker needs to compare.
async function readRangeRaw(a1) {
  const data = await sheetsApi('GET', '/values/' + encodeURIComponent(a1) + '?valueRenderOption=UNFORMATTED_VALUE');
  return data.values || [];
}

/* ============================================================================
 *  HELPERS
 * ==========================================================================*/

// Sheet values arrive as display strings with thousands separators
// ("1,104,147.19") and percent signs. parseFloat alone silently truncates at
// the first comma, so always strip before parsing.
function num(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[,\s%]/g, '').replace(/[()]/g, '');
  if (s === '' || s === '-') return 0;
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function txt(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

// Proper-case a label so casing variants merge into one group. Stores type the
// Focus 5 sub-dept inconsistently ("POULTRY", "poultry", "Poultry"), and
// grouping is case-sensitive, so "POULTRY" would otherwise show as a separate
// sub-dept. Title-casing each word collapses them ("POULTRY" -> "Poultry").
function titleCase(v) {
  return txt(v).toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// Accepts "2026-07-23", "7/23/2026", or a Google Sheets serial number.
function parseDate(v) {
  const s = txt(v);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = new Date((parseFloat(s) - 25569) * 86400000);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function computeDaysOpen(dateReported, dateResolved) {
  const start = parseDate(dateReported);
  if (!start) return '';
  const end = parseDate(dateResolved) || new Date();
  const days = Math.floor((end - start) / 86400000);
  return days < 0 ? 0 : days;
}

const ISSUE_LAST_COL = String.fromCharCode(65 + ISSUE_FIELDS.length - 1); // Q

/* ============================================================================
 *  READ: reference data + sales
 * ==========================================================================*/
async function loadStores() {
  const rows = await readRange(TAB_STORES + '!A1:F500');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const storeId = txt(r[3]);
    if (!storeId) continue;
    out.push({
      no: txt(r[0]), region: txt(r[1]), area: txt(r[2]),
      storeId: storeId, storeName: txt(r[4]), remarks: txt(r[5]),
    });
  }
  return out;
}

async function loadFocusList() {
  const rows = await readRange(TAB_FOCUS + '!A1:A50');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const v = txt((rows[i] || [])[0]);
    if (v) out.push(v);
  }
  return out;
}

async function loadSales(storeById) {
  // A:J. Matches the per-store template: A-H are the entry columns, I is an
  // auto "last edited" timestamp the store's Apps Script stamps on every row
  // edit, J is the manual "Justification for declined performance" text.
  // Read UNFORMATTED so column I arrives as a date serial (not a locale string)
  // and Sales/Sales LY arrive as numbers (no thousands separators to strip).
  const rows = await readRangeRaw(TAB_SALES + '!A1:J5000');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const month = txt(r[0]);
    const storeId = txt(r[1]);
    const sub = titleCase(r[3]);   // normalise so "POULTRY"/"poultry" merge with "Poultry"
    if (!month || !storeId || !sub) continue;
    const sales = num(r[4]);
    const salesLy = num(r[5]);
    const store = storeById[storeId];
    // Column I: the row's last-edited stamp, used for weekly update tracking.
    const stampFrame = (typeof r[8] === 'number' && r[8] > 0) ? serialToFrame(r[8]) : null;
    out.push({
      month: month,
      monthIdx: MONTHS.findIndex((m) => m.toLowerCase() === month.toLowerCase()),
      storeId: storeId,
      storeName: txt(r[2]) || (store ? store.storeName : ''),
      area: store ? store.area : 'Unassigned',
      region: store ? store.region : '',
      sub: sub,
      sales: sales,
      salesLy: salesLy,
      // Recomputed rather than trusting the sheet's Diff % / Diff Val columns.
      diffVal: sales - salesLy,
      diffPct: salesLy === 0 ? null : ((sales - salesLy) / salesLy) * 100,
      stampFrame: stampFrame,
      justification: txt(r[9]),   // column J
    });
  }
  return out;
}

/* ============================================================================
 *  CACHE — Google allows roughly 60 reads/minute for one service account, and
 *  every viewer shares this one account. Without this, 40 people refreshing
 *  would exhaust the quota in seconds. Concurrent callers also share a single
 *  in-flight request, so a burst of viewers costs one Google call, not forty.
 * ==========================================================================*/
const CACHE = {};
function cached(key, ttlMs, loader) {
  const e = CACHE[key];
  if (e && e.inflight) return e.inflight;                       // join the in-flight fetch
  if (e && ttlMs > 0 && Date.now() - e.at < ttlMs) return Promise.resolve(e.value);
  const p = loader().then((v) => {
    CACHE[key] = { value: v, at: Date.now() };
    return v;
  }, (err) => {
    delete CACHE[key];
    throw err;
  });
  CACHE[key] = { inflight: p, value: e && e.value, at: e ? e.at : 0 };
  return p;
}

const DATA_TTL = 120000;   // stores / focus list / monthly sales change rarely
const ISSUES_TTL = 20000;  // the consolidated issue log changes as stores file things

/* ============================================================================
 *  WEEKLY UPDATE TRACKER — reads the UpdateStatus tab (Store ID -> Last
 *  Updated, IMPORTRANGEd from each store copy) and works out who has refreshed
 *  their FocusSubDept data since Monday 00:00 Manila.
 * ==========================================================================*/

// Start of the current week (Monday 00:00 Manila) in the Manila-frame epoch.
function manilaWeekStartFrame() {
  const frame = Date.now() + MANILA_OFFSET_MS;
  const d = new Date(frame);
  const day = d.getUTCDay();                 // 0 Sun .. 6 Sat, in Manila terms
  const sinceMonday = day === 0 ? 6 : day - 1;
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight - sinceMonday * 86400000;
}

// A sheet serial date (days since 1899-12-30, in the sheet's Manila timezone)
// as a Manila-frame epoch, so it compares directly with manilaWeekStartFrame().
function serialToFrame(serial) {
  return (serial - 25569) * 86400000;
}

function frameToText(frameMs) {
  const d = new Date(frameMs);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

// Per-store weekly-update status, derived from the FocusSubDept column-I stamps
// that the per-store template writes on every edit. A store's "last updated" is
// the most recent stamp across all its rows — no separate status tab needed.
function computeUpdates(sales) {
  const weekStart = manilaWeekStartFrame();
  const nowFrame = Date.now() + MANILA_OFFSET_MS;
  const byStore = {};
  let any = false;
  for (let i = 0; i < sales.length; i++) {
    const r = sales[i];
    if (r.stampFrame == null) continue;
    any = true;
    const cur = byStore[r.storeId];
    if (!cur || r.stampFrame > cur.frame) {
      byStore[r.storeId] = {
        frame: r.stampFrame,
        hasStamp: true,
        updatedThisWeek: r.stampFrame >= weekStart,
        daysSince: Math.max(0, Math.floor((nowFrame - r.stampFrame) / 86400000)),
        lastUpdatedText: frameToText(r.stampFrame),
      };
    }
  }
  return { configured: any, weekStart: frameToText(weekStart), byStore: byStore };
}

async function loadReference() {
  const stores = await loadStores();
  const storeById = {};
  stores.forEach((s) => { storeById[s.storeId] = s; });
  const [focusList, sales] = await Promise.all([loadFocusList(), loadSales(storeById)]);
  const updates = computeUpdates(sales);
  return { stores: stores, storeById: storeById, focusList: focusList, sales: sales, updates: updates };
}

app.get('/api/data', async (req, res) => {
  try {
    // The Refresh button sends ?fresh=1; concurrent refreshes still coalesce.
    const ttl = req.query.fresh ? 0 : DATA_TTL;
    const ref = await cached('reference', ttl, loadReference);
    res.json({
      stores: ref.stores, focusList: ref.focusList, sales: ref.sales,
      updates: ref.updates, months: MONTHS, today: todayISO(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================================
 *  ISSUE LOG
 * ==========================================================================*/

// IssuesAndConcerns is fed by IMPORTRANGE from the 31 store copies, so this is
// strictly read-only: writing into a range that holds an IMPORTRANGE formula
// destroys the formula and #REF!s the whole import.
//
// The tab does not start at row 1 (blank row, header row, then a row of input
// hints and some stray validation lists), and IMPORTRANGE adds its own failure
// modes: "#REF!" when access hasn't been granted, "#N/A" while a source is
// still loading. Locate the header, keep only rows that look like entries, and
// report the formula errors rather than presenting them as data.
const SHEET_ERRORS = ['#REF!', '#N/A', '#ERROR!', '#VALUE!', '#NAME?', 'Loading...'];

async function loadIssues(storeById) {
  const rows = await readRange(TAB_ISSUES + '!A1:' + ISSUE_LAST_COL + '5000');
  let headerRow = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    if (txt((rows[i] || [])[0]).toLowerCase() === 'store id') { headerRow = i; break; }
  }
  if (headerRow === -1) throw new Error('Could not find the "Store ID" header row in ' + TAB_ISSUES);

  const out = [];
  const importErrors = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const storeId = txt(r[0]);
    if (!storeId) continue;                                      // blank / validation-list rows
    if (storeId.toLowerCase().indexOf('enter ') === 0) continue; // the hint row
    if (SHEET_ERRORS.indexOf(storeId) !== -1) {                  // a failing IMPORTRANGE
      if (importErrors.indexOf(storeId) === -1) importErrors.push(storeId);
      continue;
    }
    const rec = { row: i + 1 };
    ISSUE_FIELDS.forEach((f, idx) => { rec[f] = txt(r[idx]); });
    // Same Focus 5 vocabulary as sales — normalise casing so it doesn't split.
    rec.focusCategory = titleCase(rec.focusCategory);
    // Store copies may leave Area / Store Name blank, so fill them from
    // ListOfStores, which is the authority for the store roster.
    const store = storeById && storeById[rec.storeId];
    if (store) {
      if (!rec.area) rec.area = store.area;
      if (!rec.storeName) rec.storeName = store.storeName;
    }
    // Unresolved issues keep counting, so days open is always recomputed here
    // rather than trusting whatever the source sheet last calculated.
    rec.daysOpen = computeDaysOpen(rec.dateReported, rec.dateResolved);
    rec.isOpen = rec.resolved.toUpperCase() !== 'Y';
    out.push(rec);
  }
  return { headerRow: headerRow + 1, rows: out, importErrors: importErrors };
}

app.get('/api/issues', async (req, res) => {
  try {
    const ttl = req.query.fresh ? 0 : ISSUES_TTL;
    const ref = await cached('reference', DATA_TTL, loadReference);
    const data = await cached('issues', ttl, () => loadIssues(ref.storeById));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Writes are deliberately refused: the tab is IMPORTRANGE-driven and each store
// files issues in its own copy of the sheet. GET is already answered above, so
// these only ever see POST/PUT/DELETE.
function issuesAreReadOnly(req, res) {
  res.status(405).json({
    error: 'The issue log is read-only here. IssuesAndConcerns is populated by ' +
           'IMPORTRANGE from the store copies — file the issue in the store\'s own sheet.',
  });
}
app.all('/api/issues', issuesAreReadOnly);
app.all('/api/issues/:row', issuesAreReadOnly);

// Reports whether the private key is a usable PEM without ever echoing it.
function keyDiagnostics() {
  if (!PRIVATE_KEY) return { present: false, usable: false, note: 'GOOGLE_PRIVATE_KEY is not set' };
  const d = {
    present: true,
    startsWithHeader: PRIVATE_KEY.indexOf('-----BEGIN') === 0,
    lineCount: PRIVATE_KEY.split('\n').length,
    length: PRIVATE_KEY.length,
  };
  try {
    crypto.createPrivateKey(PRIVATE_KEY);
    d.usable = true;
  } catch (e) {
    d.usable = false;
    d.note = 'Key will not parse (' + e.message + '). Re-copy private_key from the ' +
             'service account JSON, including the BEGIN/END lines.';
  }
  return d;
}

app.get('/api/health', async (req, res) => {
  const base = { serviceAccount: CLIENT_EMAIL || '(not set)', sheetId: SHEET_ID, privateKey: keyDiagnostics() };
  try {
    const meta = await sheetsApi('GET', '?fields=properties.title,sheets.properties.title');
    res.json(Object.assign({ ok: true,
      title: meta.properties && meta.properties.title,
      tabs: (meta.sheets || []).map((s) => s.properties.title),
    }, base));
  } catch (e) {
    res.status(500).json(Object.assign({ ok: false, error: e.message }, base));
  }
});

/* ============================================================================
 *  UI
 * ==========================================================================*/
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(PAGE);
});

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fresh Focus 5 &mdash; CAMANAVA</title>
<style>
:root{
  --bg:#0f1720; --panel:#17222e; --panel2:#1e2b3a; --line:#2b3a4c;
  --ink:#e8eef5; --muted:#93a4b8; --accent:#3ea6ff; --accent2:#7c5cff;
  --up:#2ecc8f; --down:#ff5c72; --warn:#ffb020;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.45 "Segoe UI",Roboto,Helvetica,Arial,sans-serif}
h1,h2{margin:0}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;
  padding:12px 20px;background:linear-gradient(90deg,#16222f,#1b2a3b);
  border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;
  font-weight:700;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff}
.brand h1{font-size:17px;letter-spacing:.3px}
.brand p{margin:2px 0 0;font-size:11px;color:var(--muted)}
.topbar-right{display:flex;align-items:center;gap:10px}
.sync-note{font-size:11px;color:var(--muted)}
.tabs{display:flex;gap:6px;padding:10px 20px 0;background:var(--bg);
  border-bottom:1px solid var(--line);position:sticky;top:63px;z-index:19}
.tab{background:transparent;border:1px solid transparent;border-bottom:none;color:var(--muted);
  padding:9px 18px;border-radius:8px 8px 0 0;cursor:pointer;font-size:13px;font-weight:600}
.tab:hover{color:var(--ink)}
.tab.active{background:var(--panel);border-color:var(--line);color:var(--ink)}
main{padding:16px 20px 60px;max-width:1500px;margin:0 auto}
.tabpane{display:none}
.tabpane.active{display:block}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:14px 16px;margin-bottom:16px}
.card-head{display:flex;justify-content:space-between;align-items:center;
  gap:12px;margin-bottom:12px;flex-wrap:wrap}
.card-head h2{font-size:14px;font-weight:700;letter-spacing:.3px}
.card-head small{font-weight:400;color:var(--muted)}
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;
  background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:12px 14px;margin-bottom:16px}
.filters label,.fld{display:flex;flex-direction:column;gap:4px;font-size:11px;
  color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
select,input,textarea{background:var(--panel2);border:1px solid var(--line);color:var(--ink);
  border-radius:8px;padding:8px 10px;font:inherit;min-width:130px}
textarea{resize:vertical;min-width:100%}
select:focus,input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:-1px}
input.auto{background:#131d27;color:var(--muted)}
.inline-select{min-width:170px}
.btn{border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;border:1px solid var(--line)}
.btn-ghost{background:var(--panel2);color:var(--ink)}
.btn-ghost:hover{background:#25364a}
.btn-primary{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff}
.btn-sm{padding:4px 9px;font-size:12px}
.hidden{display:none !important}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.kpi .k{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.kpi .v{font-size:22px;font-weight:700;margin-top:6px}
.kpi .s{font-size:12px;margin-top:4px;color:var(--muted)}
.up{color:var(--up)} .down{color:var(--down)}
.legend{display:flex;gap:14px;font-size:11px;color:var(--muted)}
.key{display:flex;align-items:center;gap:5px}
.sw{width:11px;height:11px;border-radius:3px;display:inline-block}
.sw-ty{background:var(--accent)} .sw-ly{background:#54687f} .sw-gr{background:var(--warn)}
.chart-wrap{width:100%;overflow-x:auto}
.chart-wrap svg{display:block;width:100%;min-width:520px;height:auto}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:1000px){.grid-2{grid-template-columns:1fr}}
.table-scroll{overflow:auto;max-height:520px}
table.data{width:100%;border-collapse:collapse;font-size:13px}
table.data th,table.data td{padding:7px 9px;border-bottom:1px solid var(--line);
  text-align:left;white-space:nowrap}
table.data th{position:sticky;top:0;background:var(--panel2);z-index:2;
  font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
table.data th.sortable{cursor:pointer;user-select:none;padding-right:16px;position:sticky}
table.data th.sortable:hover{color:var(--ink)}
table.data th.sortable::after{content:"\\2195";opacity:.35;margin-left:4px;font-size:10px}
table.data th.sorted-asc::after{content:"\\2191";opacity:1;color:var(--accent)}
table.data th.sorted-desc::after{content:"\\2193";opacity:1;color:var(--accent)}
table.data td.n,table.data th.n{text-align:right;font-variant-numeric:tabular-nums}
table.data tbody tr:hover{background:#1b2837}
table.data tfoot td{font-weight:700;border-top:2px solid var(--line);background:var(--panel2)}
table.matrix td.cell{text-align:center;font-weight:600}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
.p-High{background:rgba(255,92,114,.18);color:var(--down)}
.p-Medium{background:rgba(255,176,32,.18);color:var(--warn)}
.p-Low{background:rgba(46,204,143,.18);color:var(--up)}
.st-open{background:rgba(255,176,32,.18);color:var(--warn)}
.st-closed{background:rgba(46,204,143,.18);color:var(--up)}
.st-nodata{background:rgba(147,164,184,.18);color:var(--muted)}
.warn-bar{background:rgba(255,176,32,.12);border:1px solid rgba(255,176,32,.4);
  border-left:4px solid var(--warn);color:#ffd88a;border-radius:8px;
  padding:11px 14px;margin-bottom:14px;font-size:13px}
table.data td.wrapcell{white-space:normal;min-width:150px;max-width:280px}
table.data td.warn{color:var(--warn)}
table.data td.missing{color:var(--warn);font-style:italic;white-space:normal;min-width:150px}
.inline-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);
  text-transform:none;letter-spacing:0}
.inline-check input{width:auto;min-width:0}
#qSearch{min-width:210px}
.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(80px);
  background:#101b26;border:1px solid var(--line);border-left:4px solid var(--accent);
  padding:11px 18px;border-radius:8px;font-size:13px;opacity:0;transition:.25s;z-index:99}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.err{border-left-color:var(--down)}
.empty{padding:26px;text-align:center;color:var(--muted);font-size:13px}
</style>
</head>
<body>

<header class="topbar">
  <div class="brand">
    <span class="logo">F5</span>
    <div>
      <h1>Fresh Focus 5</h1>
      <p>CAMANAVA &middot; Rice &middot; Poultry &middot; Sugar &middot; Eggs &middot; Pork</p>
    </div>
  </div>
  <div class="topbar-right">
    <span id="syncNote" class="sync-note"></span>
    <button id="refreshBtn" class="btn btn-ghost" type="button">Refresh</button>
  </div>
</header>

<nav class="tabs">
  <button class="tab active" data-tab="sales" type="button">Sales Monitoring</button>
  <button class="tab" data-tab="issues" type="button">Issue Log</button>
  <button class="tab" data-tab="compliance" type="button">Compliance Watch</button>
</nav>

<main>

<section id="tab-sales" class="tabpane active">
  <div class="filters">
    <label>Area<select id="fArea"></select></label>
    <label>Store<select id="fStore"></select></label>
    <label>Focus Sub-Dept<select id="fSub"></select></label>
    <label>From<select id="fFrom"></select></label>
    <label>To<select id="fTo"></select></label>
    <button id="fReset" class="btn btn-ghost" type="button">Reset</button>
  </div>

  <div id="kpis" class="kpis"></div>

  <div class="card">
    <div class="card-head">
      <h2>Monthly Sales Trend</h2>
      <div class="legend">
        <span class="key"><i class="sw sw-ty"></i>This Year</span>
        <span class="key"><i class="sw sw-ly"></i>Last Year</span>
        <span class="key"><i class="sw sw-gr"></i>Growth %</span>
      </div>
    </div>
    <div id="trendChart" class="chart-wrap"></div>
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="card-head">
        <h2>Growth vs Last Year</h2>
        <select id="gBy" class="inline-select">
          <option value="sub">by Focus Sub-Dept</option>
          <option value="area">by Area</option>
          <option value="store">by Store</option>
        </select>
      </div>
      <div id="breakdownChart" class="chart-wrap"></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Detail</h2></div>
      <div class="table-scroll"><table id="breakdownTable" class="data"></table></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Store &times; Focus Sub-Dept <small>growth % vs last year</small></h2></div>
    <div class="table-scroll"><table id="matrixTable" class="data matrix"></table></div>
  </div>

  <div class="card">
    <div class="card-head">
      <h2>Declined Performance &amp; Justifications <small id="declineCount"></small></h2>
      <label class="inline-check"><input type="checkbox" id="declineUnexplained"> Only declines without a justification</label>
    </div>
    <div class="table-scroll"><table id="declineTable" class="data"></table></div>
  </div>
</section>

<section id="tab-issues" class="tabpane">

  <div id="importWarn" class="warn-bar hidden"></div>

  <div class="filters">
    <label>Area<select id="qArea"></select></label>
    <label>Store<select id="qStore"></select></label>
    <label>Focus 5<select id="qFocus"></select></label>
    <label>Issue Category
      <select id="qCategory">
        <option value="">All categories</option><option>Price</option><option>Delivery</option>
        <option>Quality</option><option>CSL</option><option>Other</option>
      </select>
    </label>
    <label>Priority
      <select id="qPriority">
        <option value="">All priority</option><option>High</option>
        <option>Medium</option><option>Low</option>
      </select>
    </label>
    <label>Status
      <select id="qResolved">
        <option value="">All status</option><option value="open">Open only</option>
        <option value="closed">Resolved only</option>
      </select>
    </label>
    <label>Aging
      <select id="qAging">
        <option value="">Any age</option><option value="7">Open &gt; 7 days</option>
        <option value="14">Open &gt; 14 days</option><option value="30">Open &gt; 30 days</option>
      </select>
    </label>
    <label>Search<input id="qSearch" placeholder="Store, description, remarks..."></label>
    <button id="qReset" class="btn btn-ghost" type="button">Reset</button>
  </div>

  <div id="issueKpis" class="kpis"></div>

  <div class="grid-2">
    <div class="card">
      <div class="card-head">
        <h2>Open Issues</h2>
        <select id="obBy" class="inline-select">
          <option value="issueCategory">by Issue Category</option>
          <option value="focusCategory">by Focus 5 Category</option>
          <option value="area">by Area</option>
          <option value="storeName">by Store</option>
        </select>
      </div>
      <div id="issueBreakdown" class="chart-wrap"></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Aging of Open Issues</h2></div>
      <div id="agingChart" class="chart-wrap"></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <h2>Consolidated Issue Log <small id="issueCount"></small></h2>
      <span class="sync-note">Read-only &middot; stores file issues in their own sheet copy</span>
    </div>
    <div class="table-scroll"><table id="issueTable" class="data"></table></div>
  </div>
</section>

<section id="tab-compliance" class="tabpane">

  <div class="filters">
    <label>Area<select id="cArea"></select></label>
    <label>Scorecard shows
      <select id="cStatus">
        <option value="flagged">Flagged stores only</option>
        <option value="all">All stores</option>
        <option value="overdue">Not updated this week</option>
        <option value="clean">Clean stores</option>
        <option value="nodata">No data</option>
      </select>
    </label>
    <span class="sync-note" style="align-self:center">Strict rule &middot; declines with no justification + issue entries missing any required field</span>
  </div>

  <div id="cKpis" class="kpis"></div>

  <div class="grid-2">
    <div class="card">
      <div class="card-head"><h2>Flags by Area</h2></div>
      <div id="cAreaChart" class="chart-wrap"></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Most-Missed Issue Fields</h2></div>
      <div id="cFieldChart" class="chart-wrap"></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Sales Update Status <small id="cScoreCount"></small></h2></div>
    <div class="table-scroll"><table id="cScoreTable" class="data"></table></div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Unexplained Declines <small id="cDeclineCount"></small></h2></div>
    <div class="table-scroll"><table id="cDeclineTable" class="data"></table></div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Incomplete Issue Entries <small id="cIssueCount"></small></h2></div>
    <div class="table-scroll"><table id="cIssueTable" class="data"></table></div>
  </div>

</section>

</main>

<div id="toast" class="toast"></div>

<script>
/* Client code uses string concatenation only (no template literals) so it can
   live inside the server's template literal without escaping traps. */
(function(){
'use strict';

var DATA = { stores: [], focusList: [], sales: [], months: [], today: '' };
var ISSUES = [];
var STORE_BY_ID = {};

var MONTHS = ['January','February','March','April','May','June',
              'July','August','September','October','November','December'];

function $(id){ return document.getElementById(id); }
function esc(s){
  return String(s === null || s === undefined ? '' : s)
    .split('&').join('&amp;').split('<').join('&lt;')
    .split('>').join('&gt;').split('"').join('&quot;');
}
function fmt(n){
  if (n === null || n === undefined || isNaN(n)) return '-';
  return Math.round(n).toLocaleString('en-US');
}
function fmtShort(n){
  var a = Math.abs(n);
  if (a >= 1000000) return (n/1000000).toFixed(1) + 'M';
  if (a >= 1000) return Math.round(n/1000) + 'K';
  return String(Math.round(n));
}
function fmtPct(p){
  if (p === null || p === undefined || isNaN(p)) return '-';
  return (p > 0 ? '+' : '') + p.toFixed(2) + '%';
}
function cls(n){ return n > 0 ? 'up' : (n < 0 ? 'down' : ''); }

/* ---------------------------------------------------------------------------
 *  Generic table sorting. Every data table rebuilds its innerHTML on render,
 *  so rather than thread sort state through each render function, this works
 *  on the DOM: click a header to sort that column, click again to reverse.
 *  A re-render (e.g. changing a filter) resets the sort, which is fine.
 * ------------------------------------------------------------------------ */

// Numeric value of a cell for sorting: strips commas, %, currency and spaces.
// Returns null when the cell is blank or non-numeric (those sort to the end).
function cellSortValue(td){
  var text = (td.textContent || '').trim();
  if (text === '' || text === '-') return { text: text, num: null };
  var cleaned = text.replace(/[,\s%₱]/g, '');
  var num = (cleaned !== '' && !isNaN(cleaned)) ? parseFloat(cleaned) : null;
  return { text: text, num: num };
}

function makeSortable(table){
  if (!table || !table.tHead || !table.tBodies[0]) return;
  var headCells = table.tHead.rows[0].cells;
  for (var i = 0; i < headCells.length; i++) {
    (function(th, idx){
      if (th.getAttribute('data-nosort') === '1') return;
      th.classList.add('sortable');
      th.onclick = function(){ sortTableByColumn(table, idx, th); };
    })(headCells[i], i);
  }
}

function sortTableByColumn(table, colIdx, th){
  var tbody = table.tBodies[0];
  var rows = [];
  for (var i = 0; i < tbody.rows.length; i++) rows.push(tbody.rows[i]);
  var headerCount = table.tHead.rows[0].cells.length;
  // Bail on the empty-state row (a single cell spanning the whole width).
  if (rows.length < 2) return;
  for (var g = 0; g < rows.length; g++) {
    if (rows[g].cells.length !== headerCount) return;
  }

  var dir = th.getAttribute('data-sort-dir') === 'asc' ? 'desc' : 'asc';
  var heads = table.tHead.rows[0].cells;
  for (var h = 0; h < heads.length; h++) {
    heads[h].removeAttribute('data-sort-dir');
    heads[h].classList.remove('sorted-asc', 'sorted-desc');
  }
  th.setAttribute('data-sort-dir', dir);
  th.classList.add(dir === 'asc' ? 'sorted-asc' : 'sorted-desc');

  // Numeric only if every non-blank cell in the column parses as a number.
  var numeric = true;
  for (var m = 0; m < rows.length; m++) {
    var v = cellSortValue(rows[m].cells[colIdx]);
    if (v.text !== '' && v.text !== '-' && v.num === null) { numeric = false; break; }
  }

  rows.sort(function(a, b){
    var av = cellSortValue(a.cells[colIdx]);
    var bv = cellSortValue(b.cells[colIdx]);
    var r;
    if (numeric) {
      // Blanks always sink to the bottom regardless of direction.
      var an = av.num === null ? (dir === 'asc' ? Infinity : -Infinity) : av.num;
      var bn = bv.num === null ? (dir === 'asc' ? Infinity : -Infinity) : bv.num;
      r = an - bn;
    } else {
      var as = av.text.toLowerCase(), bs = bv.text.toLowerCase();
      r = as < bs ? -1 : (as > bs ? 1 : 0);
    }
    return dir === 'asc' ? r : -r;
  });

  for (var n = 0; n < rows.length; n++) tbody.appendChild(rows[n]);
}

function toast(msg, isErr){
  var t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(function(){ t.className = 'toast'; }, 3200);
}

function api(method, url, body){
  var opt = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (body) opt.body = JSON.stringify(body);
  return fetch(url, opt).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(j){
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    });
  });
}

/* ---------------------------- tab switching ---------------------------- */
var tabBtns = document.querySelectorAll('.tab');
for (var i = 0; i < tabBtns.length; i++) {
  tabBtns[i].addEventListener('click', function(){
    var name = this.getAttribute('data-tab');
    var all = document.querySelectorAll('.tab');
    for (var j = 0; j < all.length; j++) all[j].classList.remove('active');
    this.classList.add('active');
    var panes = document.querySelectorAll('.tabpane');
    for (var k = 0; k < panes.length; k++) panes[k].classList.remove('active');
    $('tab-' + name).classList.add('active');
  });
}

/* ============================== SALES TAB ============================== */

function fillSelect(sel, values, allLabel){
  var html = allLabel ? '<option value="">' + esc(allLabel) + '</option>' : '';
  for (var i = 0; i < values.length; i++) {
    html += '<option value="' + esc(values[i].v) + '">' + esc(values[i].t) + '</option>';
  }
  sel.innerHTML = html;
}

function uniq(arr){
  var seen = {}, out = [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] !== '' && !seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
  }
  return out;
}

function monthsPresent(){
  var idxs = uniq(DATA.sales.map(function(r){ return r.monthIdx; }));
  idxs.sort(function(a,b){ return a-b; });
  return idxs;
}

function buildFilters(){
  var areas = uniq(DATA.stores.map(function(s){ return s.area; })).sort();
  fillSelect($('fArea'), areas.map(function(a){ return { v:a, t:a }; }), 'All areas');

  var subs = DATA.focusList.length ? DATA.focusList
           : uniq(DATA.sales.map(function(r){ return r.sub; })).sort();
  fillSelect($('fSub'), subs.map(function(s){ return { v:s, t:s }; }), 'All sub-depts');

  var idxs = monthsPresent();
  var mopts = idxs.map(function(i){ return { v:String(i), t: MONTHS[i] }; });
  fillSelect($('fFrom'), mopts, '');
  fillSelect($('fTo'), mopts, '');
  if (idxs.length) {
    $('fFrom').value = String(idxs[0]);
    $('fTo').value = String(idxs[idxs.length - 1]);
  }
  buildStoreFilter();
}

function buildStoreFilter(){
  var area = $('fArea').value;
  var list = DATA.stores.filter(function(s){ return !area || s.area === area; });
  // Only offer stores that actually have sales rows.
  var withData = {};
  DATA.sales.forEach(function(r){ withData[r.storeId] = 1; });
  var opts = list.filter(function(s){ return withData[s.storeId]; })
    .map(function(s){ return { v: s.storeId, t: s.storeId + ' - ' + s.storeName }; });
  fillSelect($('fStore'), opts, 'All stores');
}

function filtered(){
  var area = $('fArea').value, store = $('fStore').value, sub = $('fSub').value;
  var from = $('fFrom').value === '' ? -1 : parseInt($('fFrom').value, 10);
  var to = $('fTo').value === '' ? 99 : parseInt($('fTo').value, 10);
  return DATA.sales.filter(function(r){
    if (area && r.area !== area) return false;
    if (store && r.storeId !== store) return false;
    if (sub && r.sub !== sub) return false;
    if (r.monthIdx < from || r.monthIdx > to) return false;
    return true;
  });
}

function totals(rows){
  var s = 0, l = 0;
  for (var i = 0; i < rows.length; i++) { s += rows[i].sales; l += rows[i].salesLy; }
  return { sales: s, ly: l, diff: s - l, pct: l === 0 ? null : ((s - l) / l) * 100 };
}

function groupBy(rows, keyFn, labelFn){
  var map = {};
  for (var i = 0; i < rows.length; i++) {
    var k = keyFn(rows[i]);
    if (!map[k]) map[k] = { key: k, label: labelFn(rows[i]), sales: 0, ly: 0 };
    map[k].sales += rows[i].sales;
    map[k].ly += rows[i].salesLy;
  }
  var out = [];
  for (var k2 in map) if (map.hasOwnProperty(k2)) {
    var g = map[k2];
    g.diff = g.sales - g.ly;
    g.pct = g.ly === 0 ? null : (g.diff / g.ly) * 100;
    out.push(g);
  }
  return out;
}

function renderKpis(rows){
  var t = totals(rows);
  var storeCount = uniq(rows.map(function(r){ return r.storeId; })).length;
  var monthCount = uniq(rows.map(function(r){ return r.monthIdx; })).length;
  var g = groupBy(rows, function(r){ return r.sub; }, function(r){ return r.sub; });
  g.sort(function(a,b){ return (b.pct===null?-1e9:b.pct) - (a.pct===null?-1e9:a.pct); });
  var best = g.length ? g[0] : null;
  var worst = g.length ? g[g.length-1] : null;

  var html = '';
  html += kpi('Sales This Year', fmt(t.sales), monthCount + ' month(s) / ' + storeCount + ' store(s)', '');
  html += kpi('Sales Last Year', fmt(t.ly), 'same period', '');
  html += kpi('Growth vs LY', fmtPct(t.pct), fmt(t.diff) + ' variance', cls(t.diff));
  if (best) html += kpi('Top Sub-Dept', best.label, fmtPct(best.pct), cls(best.pct));
  if (worst) html += kpi('Needs Attention', worst.label, fmtPct(worst.pct), cls(worst.pct));
  $('kpis').innerHTML = html;
}

function kpi(k, v, s, c){
  return '<div class="kpi"><div class="k">' + esc(k) + '</div>' +
    '<div class="v ' + c + '">' + esc(v) + '</div>' +
    '<div class="s">' + esc(s) + '</div></div>';
}

/* ------------------------------ charts -------------------------------- */

function renderTrend(rows){
  var byMonth = {};
  for (var i = 0; i < rows.length; i++) {
    var m = rows[i].monthIdx;
    if (!byMonth[m]) byMonth[m] = { m: m, sales: 0, ly: 0 };
    byMonth[m].sales += rows[i].sales;
    byMonth[m].ly += rows[i].salesLy;
  }
  var pts = [];
  for (var k in byMonth) if (byMonth.hasOwnProperty(k)) pts.push(byMonth[k]);
  pts.sort(function(a,b){ return a.m - b.m; });

  if (!pts.length) { $('trendChart').innerHTML = '<div class="empty">No data for this selection.</div>'; return; }

  var W = 960, H = 340, L = 74, R = 54, T = 18, B = 46;
  var pw = W - L - R, ph = H - T - B;
  var max = 0;
  pts.forEach(function(p){ max = Math.max(max, p.sales, p.ly); });
  max = max || 1;
  var yTop = max * 1.12;

  var gmax = 1;
  pts.forEach(function(p){
    var g = p.ly === 0 ? 0 : ((p.sales - p.ly) / p.ly) * 100;
    gmax = Math.max(gmax, Math.abs(g));
  });
  gmax = Math.ceil(gmax / 10) * 10;

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">';

  // horizontal gridlines + left axis labels
  for (var gi = 0; gi <= 4; gi++) {
    var y = T + ph - (ph * gi / 4);
    svg += '<line x1="' + L + '" y1="' + y + '" x2="' + (L + pw) + '" y2="' + y +
           '" stroke="#2b3a4c" stroke-width="1"/>';
    svg += '<text x="' + (L - 8) + '" y="' + (y + 4) + '" fill="#93a4b8" font-size="11" ' +
           'text-anchor="end">' + fmtShort(yTop * gi / 4) + '</text>';
  }
  // zero line for the growth axis
  var zeroY = T + ph / 2;
  svg += '<line x1="' + L + '" y1="' + zeroY + '" x2="' + (L + pw) + '" y2="' + zeroY +
         '" stroke="#3a4c61" stroke-dasharray="3 4" stroke-width="1"/>';
  svg += '<text x="' + (L + pw + 8) + '" y="' + (zeroY + 4) + '" fill="#ffb020" font-size="11">0%</text>';
  svg += '<text x="' + (L + pw + 8) + '" y="' + (T + 12) + '" fill="#ffb020" font-size="11">+' + gmax + '%</text>';
  svg += '<text x="' + (L + pw + 8) + '" y="' + (T + ph) + '" fill="#ffb020" font-size="11">-' + gmax + '%</text>';

  var slot = pw / pts.length;
  var bw = Math.min(26, slot * 0.32);
  var line = '';

  for (var p2 = 0; p2 < pts.length; p2++) {
    var pt = pts[p2];
    var cx = L + slot * p2 + slot / 2;
    var hTy = (pt.sales / yTop) * ph;
    var hLy = (pt.ly / yTop) * ph;

    svg += '<rect x="' + (cx - bw - 2) + '" y="' + (T + ph - hTy) + '" width="' + bw +
           '" height="' + Math.max(hTy, 0) + '" rx="3" fill="#3ea6ff"><title>' +
           esc(MONTHS[pt.m]) + ' TY: ' + fmt(pt.sales) + '</title></rect>';
    svg += '<rect x="' + (cx + 2) + '" y="' + (T + ph - hLy) + '" width="' + bw +
           '" height="' + Math.max(hLy, 0) + '" rx="3" fill="#54687f"><title>' +
           esc(MONTHS[pt.m]) + ' LY: ' + fmt(pt.ly) + '</title></rect>';

    var gp = pt.ly === 0 ? 0 : ((pt.sales - pt.ly) / pt.ly) * 100;
    var gy = zeroY - (gp / gmax) * (ph / 2);
    line += (p2 === 0 ? 'M' : 'L') + cx + ' ' + gy + ' ';

    svg += '<text x="' + cx + '" y="' + (T + ph + 18) + '" fill="#93a4b8" font-size="11" ' +
           'text-anchor="middle">' + esc(MONTHS[pt.m].slice(0, 3)) + '</text>';
    svg += '<text x="' + cx + '" y="' + (T + ph + 34) + '" fill="' +
           (gp >= 0 ? '#2ecc8f' : '#ff5c72') + '" font-size="10.5" text-anchor="middle">' +
           (gp > 0 ? '+' : '') + gp.toFixed(1) + '%</text>';
  }

  svg += '<path d="' + line + '" fill="none" stroke="#ffb020" stroke-width="2"/>';
  for (var p3 = 0; p3 < pts.length; p3++) {
    var pt3 = pts[p3];
    var cx3 = L + slot * p3 + slot / 2;
    var gp3 = pt3.ly === 0 ? 0 : ((pt3.sales - pt3.ly) / pt3.ly) * 100;
    var gy3 = zeroY - (gp3 / gmax) * (ph / 2);
    svg += '<circle cx="' + cx3 + '" cy="' + gy3 + '" r="3.5" fill="#ffb020"><title>' +
           esc(MONTHS[pt3.m]) + ' growth ' + gp3.toFixed(2) + '%</title></circle>';
  }

  svg += '</svg>';
  $('trendChart').innerHTML = svg;
}

function renderBreakdownChart(groups){
  if (!groups.length) { $('breakdownChart').innerHTML = '<div class="empty">No data.</div>'; return; }
  var sorted = groups.slice().sort(function(a,b){
    return (b.pct === null ? -1e9 : b.pct) - (a.pct === null ? -1e9 : a.pct);
  });
  var rowH = 30, T = 12, B = 24, L = 150, R = 60;
  var H = T + B + rowH * sorted.length;
  var W = 620, pw = W - L - R;
  var max = 1;
  sorted.forEach(function(g){ if (g.pct !== null) max = Math.max(max, Math.abs(g.pct)); });
  var mid = L + pw / 2;

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">';
  svg += '<line x1="' + mid + '" y1="' + T + '" x2="' + mid + '" y2="' + (H - B) +
         '" stroke="#3a4c61" stroke-width="1"/>';
  for (var i = 0; i < sorted.length; i++) {
    var g = sorted[i];
    var y = T + rowH * i + 5;
    var p = g.pct === null ? 0 : g.pct;
    var len = (Math.abs(p) / max) * (pw / 2);
    var x = p >= 0 ? mid : mid - len;
    svg += '<text x="' + (L - 10) + '" y="' + (y + 14) + '" fill="#e8eef5" font-size="12" ' +
           'text-anchor="end">' + esc(g.label.length > 22 ? g.label.slice(0, 21) + '.' : g.label) + '</text>';
    svg += '<rect x="' + x + '" y="' + y + '" width="' + Math.max(len, 1) + '" height="18" rx="3" fill="' +
           (p >= 0 ? '#2ecc8f' : '#ff5c72') + '"><title>' + esc(g.label) + ': ' + fmtPct(g.pct) +
           ' (' + fmt(g.diff) + ')</title></rect>';
    svg += '<text x="' + (p >= 0 ? x + len + 6 : x - 6) + '" y="' + (y + 13) + '" fill="' +
           (p >= 0 ? '#2ecc8f' : '#ff5c72') + '" font-size="11" text-anchor="' +
           (p >= 0 ? 'start' : 'end') + '">' + fmtPct(g.pct) + '</text>';
  }
  svg += '</svg>';
  $('breakdownChart').innerHTML = svg;
}

function renderBreakdownTable(groups, dimLabel){
  var sorted = groups.slice().sort(function(a,b){ return b.sales - a.sales; });
  var t = { sales: 0, ly: 0 };
  sorted.forEach(function(g){ t.sales += g.sales; t.ly += g.ly; });
  var tDiff = t.sales - t.ly;
  var tPct = t.ly === 0 ? null : (tDiff / t.ly) * 100;

  var html = '<thead><tr><th>' + esc(dimLabel) + '</th><th class="n">Sales</th>' +
    '<th class="n">Sales LY</th><th class="n">Diff Val</th><th class="n">Diff %</th></tr></thead><tbody>';
  for (var i = 0; i < sorted.length; i++) {
    var g = sorted[i];
    html += '<tr><td>' + esc(g.label) + '</td>' +
      '<td class="n">' + fmt(g.sales) + '</td>' +
      '<td class="n">' + fmt(g.ly) + '</td>' +
      '<td class="n ' + cls(g.diff) + '">' + fmt(g.diff) + '</td>' +
      '<td class="n ' + cls(g.pct) + '">' + fmtPct(g.pct) + '</td></tr>';
  }
  html += '</tbody><tfoot><tr><td>TOTAL</td><td class="n">' + fmt(t.sales) +
    '</td><td class="n">' + fmt(t.ly) + '</td><td class="n ' + cls(tDiff) + '">' + fmt(tDiff) +
    '</td><td class="n ' + cls(tPct) + '">' + fmtPct(tPct) + '</td></tr></tfoot>';
  $('breakdownTable').innerHTML = html;
  makeSortable($('breakdownTable'));
}

function renderMatrix(rows){
  var subs = DATA.focusList.length ? DATA.focusList.slice()
           : uniq(rows.map(function(r){ return r.sub; })).sort();
  var storeIds = uniq(rows.map(function(r){ return r.storeId; }));
  if (!storeIds.length) { $('matrixTable').innerHTML = '<tbody><tr><td class="empty">No data.</td></tr></tbody>'; return; }

  var cell = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var key = r.storeId + '|' + r.sub;
    if (!cell[key]) cell[key] = { s: 0, l: 0 };
    cell[key].s += r.sales;
    cell[key].l += r.salesLy;
  }

  var meta = {};
  rows.forEach(function(r){ meta[r.storeId] = { name: r.storeName, area: r.area }; });
  storeIds.sort(function(a, b){
    var A = meta[a], B = meta[b];
    if (A.area !== B.area) return A.area < B.area ? -1 : 1;
    return A.name < B.name ? -1 : 1;
  });

  var html = '<thead><tr><th>Area</th><th>Store</th>';
  subs.forEach(function(s){ html += '<th class="n">' + esc(s) + '</th>'; });
  html += '<th class="n">Total</th></tr></thead><tbody>';

  for (var si = 0; si < storeIds.length; si++) {
    var id = storeIds[si];
    html += '<tr><td>' + esc(meta[id].area) + '</td><td>' + esc(id + ' - ' + meta[id].name) + '</td>';
    var rs = 0, rl = 0;
    for (var ci = 0; ci < subs.length; ci++) {
      var c = cell[id + '|' + subs[ci]];
      if (!c) { html += '<td class="cell">-</td>'; continue; }
      rs += c.s; rl += c.l;
      var p = c.l === 0 ? null : ((c.s - c.l) / c.l) * 100;
      html += '<td class="cell ' + cls(p) + '"><span title="' + esc(fmt(c.s) + ' vs ' + fmt(c.l)) +
              '">' + fmtPct(p) + '</span></td>';
    }
    var rp = rl === 0 ? null : ((rs - rl) / rl) * 100;
    html += '<td class="cell n ' + cls(rp) + '">' + fmtPct(rp) + '</td></tr>';
  }
  html += '</tbody>';
  $('matrixTable').innerHTML = html;
  makeSortable($('matrixTable'));
}

// One row per declined Month x Store x Sub-Dept, with the manual justification
// from column J. This is the only per-row (non-aggregated) view on the Sales
// tab, because a justification is text and cannot be summed into the KPIs,
// trend, breakdown or matrix. Declines with no justification are flagged so
// the table doubles as a follow-up list.
function renderDeclines(rows){
  var declines = rows.filter(function(r){ return r.diffVal < 0; });
  var onlyUnexplained = $('declineUnexplained').checked;
  if (onlyUnexplained) {
    declines = declines.filter(function(r){ return !r.justification; });
  }
  declines.sort(function(a, b){ return a.diffPct - b.diffPct; });   // worst first

  var unexplained = rows.filter(function(r){ return r.diffVal < 0 && !r.justification; }).length;
  var totalDeclines = rows.filter(function(r){ return r.diffVal < 0; }).length;
  $('declineCount').textContent = totalDeclines
    ? '(' + totalDeclines + ' decline' + (totalDeclines === 1 ? '' : 's') +
      (unexplained ? ', ' + unexplained + ' unexplained' : '') + ')'
    : '';

  var html = '<thead><tr><th>Month</th><th>Area</th><th>Store</th><th>Focus Sub-Dept</th>' +
    '<th class="n">Sales</th><th class="n">Sales LY</th><th class="n">Diff Val</th>' +
    '<th class="n">Diff %</th><th>Justification</th></tr></thead><tbody>';

  if (!declines.length) {
    html += '<tr><td colspan="9" class="empty">' +
      (onlyUnexplained ? 'Every decline in this selection has a justification.'
                       : 'No declines vs last year in this selection.') + '</td></tr>';
  }
  for (var i = 0; i < declines.length; i++) {
    var r = declines[i];
    var j = r.justification;
    html += '<tr>' +
      '<td>' + esc(r.month) + '</td>' +
      '<td>' + esc(r.area) + '</td>' +
      '<td>' + esc(r.storeId + ' - ' + r.storeName) + '</td>' +
      '<td>' + esc(r.sub) + '</td>' +
      '<td class="n">' + fmt(r.sales) + '</td>' +
      '<td class="n">' + fmt(r.salesLy) + '</td>' +
      '<td class="n down">' + fmt(r.diffVal) + '</td>' +
      '<td class="n down">' + fmtPct(r.diffPct) + '</td>' +
      (j ? '<td class="wrapcell" title="' + esc(j) + '">' + esc(j) + '</td>'
         : '<td class="missing">No justification yet</td>') +
      '</tr>';
  }
  html += '</tbody>';
  $('declineTable').innerHTML = html;
  makeSortable($('declineTable'));
}

function renderSales(){
  var rows = filtered();
  renderKpis(rows);
  renderTrend(rows);

  var by = $('gBy').value, groups, label;
  if (by === 'area') {
    groups = groupBy(rows, function(r){ return r.area; }, function(r){ return r.area; });
    label = 'Area';
  } else if (by === 'store') {
    groups = groupBy(rows, function(r){ return r.storeId; },
      function(r){ return r.storeId + ' - ' + r.storeName; });
    label = 'Store';
  } else {
    groups = groupBy(rows, function(r){ return r.sub; }, function(r){ return r.sub; });
    label = 'Focus Sub-Dept';
  }
  renderBreakdownChart(groups);
  renderBreakdownTable(groups, label);
  renderMatrix(rows);
  renderDeclines(rows);
}

$('fArea').addEventListener('change', function(){ buildStoreFilter(); renderSales(); });
['fStore','fSub','fFrom','fTo','gBy'].forEach(function(id){
  $(id).addEventListener('change', renderSales);
});
$('declineUnexplained').addEventListener('change', function(){ renderDeclines(filtered()); });
$('fReset').addEventListener('click', function(){
  $('fArea').value = ''; $('fSub').value = '';
  buildStoreFilter();
  var idxs = monthsPresent();
  if (idxs.length) { $('fFrom').value = String(idxs[0]); $('fTo').value = String(idxs[idxs.length-1]); }
  renderSales();
});

/* ============================== ISSUE TAB ============================== */

/* The issue log is read-only: IssuesAndConcerns is fed by IMPORTRANGE from the
   31 store copies, and each store files its issues in its own sheet. */

function buildIssueFilters(){
  var areas = uniq(DATA.stores.map(function(s){ return s.area; })).sort();
  fillSelect($('qArea'), areas.map(function(a){ return { v:a, t:a }; }), 'All areas');

  var subs = DATA.focusList.length ? DATA.focusList : ['Rice','Poultry','Sugar','Eggs','Pork'];
  fillSelect($('qFocus'), subs.map(function(s){ return { v:s, t:s }; }), 'All Focus 5');

  buildIssueStoreFilter();
}

function buildIssueStoreFilter(){
  var area = $('qArea').value;
  var opts = DATA.stores.filter(function(s){ return !area || s.area === area; })
    .map(function(s){ return { v: s.storeId, t: s.storeId + ' - ' + s.storeName }; });
  fillSelect($('qStore'), opts, 'All stores');
}

function issueMatches(rec){
  var st = $('qResolved').value;
  if (st === 'open' && !rec.isOpen) return false;
  if (st === 'closed' && rec.isOpen) return false;
  if ($('qArea').value && rec.area !== $('qArea').value) return false;
  if ($('qStore').value && rec.storeId !== $('qStore').value) return false;
  if ($('qFocus').value && rec.focusCategory !== $('qFocus').value) return false;
  if ($('qCategory').value && rec.issueCategory !== $('qCategory').value) return false;
  if ($('qPriority').value && rec.priority !== $('qPriority').value) return false;

  var age = $('qAging').value;
  if (age) {
    if (!rec.isOpen) return false;                       // aging only means anything while open
    if (!(Number(rec.daysOpen) > Number(age))) return false;
  }

  var q = $('qSearch').value.trim().toLowerCase();
  if (q) {
    var hay = [rec.storeId, rec.storeName, rec.area, rec.focusCategory, rec.issueCategory,
               rec.issueDescription, rec.reportedBy, rec.reportedTo, rec.feedback,
               rec.resolutionDetails, rec.remarks].join(' ').toLowerCase();
    if (hay.indexOf(q) === -1) return false;
  }
  return true;
}

function renderIssueKpis(rows){
  var open = rows.filter(function(r){ return r.isOpen; });
  var closed = rows.length - open.length;
  var highOpen = open.filter(function(r){ return r.priority === 'High'; }).length;
  var aged = open.filter(function(r){ return Number(r.daysOpen) > 14; }).length;

  var avg = 0, oldest = 0, oldestStore = '';
  open.forEach(function(r){
    var d = Number(r.daysOpen) || 0;
    avg += d;
    if (d > oldest) { oldest = d; oldestStore = r.storeName || r.storeId; }
  });
  avg = open.length ? Math.round(avg / open.length) : 0;

  var storesAffected = uniq(open.map(function(r){ return r.storeId; })).length;

  var html = '';
  html += kpi('Open Issues', String(open.length), storesAffected + ' store(s) affected',
              open.length ? 'down' : 'up');
  html += kpi('High Priority Open', String(highOpen),
              highOpen ? 'needs escalation' : 'none outstanding', highOpen ? 'down' : 'up');
  html += kpi('Ageing Over 14 Days', String(aged),
              aged ? 'past follow-up window' : 'all within window', aged ? 'down' : 'up');
  html += kpi('Avg Days Open', String(avg), 'across open issues', avg > 14 ? 'down' : '');
  html += kpi('Oldest Open', oldest ? oldest + ' days' : '-', oldestStore || 'nothing open',
              oldest > 14 ? 'down' : '');
  html += kpi('Resolved', String(closed),
              rows.length ? Math.round((closed / rows.length) * 100) + '% of all logged' : '-', 'up');
  $('issueKpis').innerHTML = html;
}

function renderIssueBreakdown(rows){
  var field = $('obBy').value;
  var open = rows.filter(function(r){ return r.isOpen; });
  if (!open.length) {
    $('issueBreakdown').innerHTML = '<div class="empty">No open issues in this selection.</div>';
    return;
  }
  var map = {};
  open.forEach(function(r){
    var k = r[field] || '(blank)';
    if (!map[k]) map[k] = { label: k, total: 0, high: 0 };
    map[k].total++;
    if (r.priority === 'High') map[k].high++;
  });
  var list = [];
  for (var k in map) if (map.hasOwnProperty(k)) list.push(map[k]);
  list.sort(function(a, b){ return b.total - a.total; });

  var rowH = 32, T = 10, B = 22, L = 150, R = 70;
  var W = 620, pw = W - L - R;
  var H = T + B + rowH * list.length;
  var max = 1;
  list.forEach(function(g){ max = Math.max(max, g.total); });

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">';
  for (var i = 0; i < list.length; i++) {
    var g = list[i];
    var y = T + rowH * i + 6;
    var len = (g.total / max) * pw;
    var hiLen = (g.high / max) * pw;
    svg += '<text x="' + (L - 10) + '" y="' + (y + 14) + '" fill="#e8eef5" font-size="12" ' +
           'text-anchor="end">' + esc(g.label.length > 22 ? g.label.slice(0, 21) + '.' : g.label) + '</text>';
    svg += '<rect x="' + L + '" y="' + y + '" width="' + Math.max(len, 1) + '" height="19" rx="3" ' +
           'fill="#3ea6ff"><title>' + esc(g.label) + ': ' + g.total + ' open</title></rect>';
    if (g.high) {
      svg += '<rect x="' + L + '" y="' + y + '" width="' + Math.max(hiLen, 1) + '" height="19" rx="3" ' +
             'fill="#ff5c72"><title>' + esc(g.label) + ': ' + g.high + ' high priority</title></rect>';
    }
    svg += '<text x="' + (L + len + 8) + '" y="' + (y + 14) + '" fill="#93a4b8" font-size="11">' +
           g.total + (g.high ? ' (' + g.high + ' high)' : '') + '</text>';
  }
  svg += '</svg>';
  $('issueBreakdown').innerHTML = svg;
}

function renderAging(rows){
  var open = rows.filter(function(r){ return r.isOpen; });
  if (!open.length) {
    $('agingChart').innerHTML = '<div class="empty">No open issues in this selection.</div>';
    return;
  }
  var buckets = [
    { label: '0-7 days', min: 0, max: 7, color: '#2ecc8f', n: 0 },
    { label: '8-14 days', min: 8, max: 14, color: '#ffb020', n: 0 },
    { label: '15-30 days', min: 15, max: 30, color: '#ff8a3d', n: 0 },
    { label: 'Over 30 days', min: 31, max: 1e9, color: '#ff5c72', n: 0 }
  ];
  open.forEach(function(r){
    var d = Number(r.daysOpen) || 0;
    for (var i = 0; i < buckets.length; i++) {
      if (d >= buckets[i].min && d <= buckets[i].max) { buckets[i].n++; break; }
    }
  });

  var W = 620, H = 260, L = 50, R = 20, T = 16, B = 46;
  var pw = W - L - R, ph = H - T - B;
  var max = 1;
  buckets.forEach(function(b){ max = Math.max(max, b.n); });

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">';
  for (var g = 0; g <= 4; g++) {
    var gy = T + ph - (ph * g / 4);
    svg += '<line x1="' + L + '" y1="' + gy + '" x2="' + (L + pw) + '" y2="' + gy +
           '" stroke="#2b3a4c" stroke-width="1"/>';
    svg += '<text x="' + (L - 8) + '" y="' + (gy + 4) + '" fill="#93a4b8" font-size="11" ' +
           'text-anchor="end">' + Math.round(max * g / 4) + '</text>';
  }
  var slot = pw / buckets.length;
  var bw = Math.min(70, slot * 0.55);
  for (var i2 = 0; i2 < buckets.length; i2++) {
    var b = buckets[i2];
    var cx = L + slot * i2 + slot / 2;
    var h = (b.n / max) * ph;
    svg += '<rect x="' + (cx - bw / 2) + '" y="' + (T + ph - h) + '" width="' + bw +
           '" height="' + Math.max(h, 0) + '" rx="4" fill="' + b.color + '"><title>' +
           esc(b.label) + ': ' + b.n + ' open</title></rect>';
    if (b.n) {
      svg += '<text x="' + cx + '" y="' + (T + ph - h - 6) + '" fill="#e8eef5" font-size="12" ' +
             'font-weight="700" text-anchor="middle">' + b.n + '</text>';
    }
    svg += '<text x="' + cx + '" y="' + (T + ph + 20) + '" fill="#93a4b8" font-size="11" ' +
           'text-anchor="middle">' + esc(b.label) + '</text>';
  }
  svg += '</svg>';
  $('agingChart').innerHTML = svg;
}

function renderIssueTable(rows){
  var sorted = rows.slice().sort(function(a, b){
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;   // open first
    return (Number(b.daysOpen) || 0) - (Number(a.daysOpen) || 0);  // then oldest first
  });

  var html = '<thead><tr>' +
    '<th>Store</th><th>Area</th><th>Date</th><th>Reported by</th><th>Focus 5</th>' +
    '<th>Category</th><th>Description</th><th>Priority</th><th>To Buyer/MRG</th>' +
    '<th>Reported</th><th>Feedback</th><th>Resolution</th><th>Resolved</th>' +
    '<th class="n">Days Open</th><th>Remarks</th><th>Status</th>' +
    '</tr></thead><tbody>';

  if (!sorted.length) {
    html += '<tr><td colspan="16" class="empty">No issues match these filters.</td></tr>';
  }
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    var days = Number(r.daysOpen) || 0;
    var dayCls = r.isOpen ? (days > 30 ? 'down' : (days > 14 ? 'warn' : '')) : '';
    html += '<tr>' +
      '<td>' + esc(r.storeId + (r.storeName ? ' - ' + r.storeName : '')) + '</td>' +
      '<td>' + esc(r.area) + '</td>' +
      '<td>' + esc(r.date) + '</td>' +
      '<td>' + esc(r.reportedBy) + '</td>' +
      '<td>' + esc(r.focusCategory) + '</td>' +
      '<td>' + esc(r.issueCategory) + '</td>' +
      '<td class="wrapcell" title="' + esc(r.issueDescription) + '">' + esc(clip(r.issueDescription, 60)) + '</td>' +
      '<td>' + (r.priority ? '<span class="pill p-' + esc(r.priority) + '">' + esc(r.priority) + '</span>' : '') + '</td>' +
      '<td>' + esc(r.reportedTo) + '</td>' +
      '<td>' + esc(r.dateReported) + '</td>' +
      '<td class="wrapcell" title="' + esc(r.feedback) + '">' + esc(clip(r.feedback, 40)) + '</td>' +
      '<td class="wrapcell" title="' + esc(r.resolutionDetails) + '">' + esc(clip(r.resolutionDetails, 40)) + '</td>' +
      '<td>' + esc(r.dateResolved) + '</td>' +
      '<td class="n ' + dayCls + '">' + esc(r.daysOpen) + '</td>' +
      '<td class="wrapcell" title="' + esc(r.remarks) + '">' + esc(clip(r.remarks, 30)) + '</td>' +
      '<td><span class="pill ' + (r.isOpen ? 'st-open">Open' : 'st-closed">Resolved') + '</span></td>' +
      '</tr>';
  }
  html += '</tbody>';
  $('issueTable').innerHTML = html;
  makeSortable($('issueTable'));
  $('issueCount').textContent = sorted.length === ISSUES.length
    ? '(' + sorted.length + ')'
    : '(' + sorted.length + ' of ' + ISSUES.length + ')';
}

function clip(s, n){
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '.' : s;
}

function renderIssues(){
  var rows = ISSUES.filter(issueMatches);
  renderIssueKpis(rows);
  renderIssueBreakdown(rows);
  renderAging(rows);
  renderIssueTable(rows);
}

$('qArea').addEventListener('change', function(){ buildIssueStoreFilter(); renderIssues(); });
['qStore','qFocus','qCategory','qPriority','qResolved','qAging','obBy'].forEach(function(id){
  $(id).addEventListener('change', renderIssues);
});
$('qSearch').addEventListener('input', renderIssues);
$('qReset').addEventListener('click', function(){
  ['qArea','qStore','qFocus','qCategory','qPriority','qResolved','qAging'].forEach(function(id){
    $(id).value = '';
  });
  $('qSearch').value = '';
  buildIssueStoreFilter();
  renderIssues();
});

function loadIssues(fresh){
  return api('GET', '/api/issues' + (fresh ? '?fresh=1' : '')).then(function(j){
    ISSUES = j.rows || [];
    var warn = $('importWarn');
    // A failing IMPORTRANGE shows up as #REF! / #N/A rows rather than an error,
    // so surface it instead of quietly reporting fewer issues than exist.
    if (j.importErrors && j.importErrors.length) {
      warn.textContent = 'Some IMPORTRANGE sources are not returning data (' +
        j.importErrors.join(', ') + '). Check that every store copy is shared and the ' +
        'ranges are approved — the figures below are incomplete.';
      warn.classList.remove('hidden');
    } else {
      warn.classList.add('hidden');
    }
    renderIssues();
    renderCompliance();   // needs ISSUES + DATA, both available by now
  }).catch(function(e){ toast('Issues: ' + e.message, true); });
}

/* ============================ COMPLIANCE WATCH ============================
 * Flags two kinds of gap, per store:
 *   1. Unexplained declines — a Sub-Dept that fell vs LY with a blank column J.
 *   2. Incomplete issues — an entry missing any STRICT required field.
 * The audience follows up by store, so the store scorecard is the centre.
 * ======================================================================= */

// Strict rule: required on every entry.
var STRICT_REQUIRED = [
  ['reportedBy', 'Reported by'],
  ['reportedTo', 'Reported to Buyer/MRG'],
  ['focusCategory', 'Focus 5'],
  ['issueCategory', 'Issue Category'],
  ['issueDescription', 'Description'],
  ['priority', 'Priority'],
  ['dateReported', 'Date Reported'],
  ['feedback', 'Feedback']
];
// Additionally required once an issue is marked resolved.
var RESOLVED_REQUIRED = [
  ['resolutionDetails', 'Resolution Details'],
  ['dateResolved', 'Date Resolved']
];

function missingFields(issue){
  var miss = [];
  for (var i = 0; i < STRICT_REQUIRED.length; i++) {
    if (!String(issue[STRICT_REQUIRED[i][0]] || '').trim()) miss.push(STRICT_REQUIRED[i][1]);
  }
  if (String(issue.resolved || '').toUpperCase() === 'Y') {
    for (var j = 0; j < RESOLVED_REQUIRED.length; j++) {
      if (!String(issue[RESOLVED_REQUIRED[j][0]] || '').trim()) miss.push(RESOLVED_REQUIRED[j][1]);
    }
  }
  return miss;
}

function complianceScope(){
  var area = $('cArea').value;
  var sales = DATA.sales.filter(function(r){ return !area || r.area === area; });
  var issues = ISSUES.filter(function(r){ return !area || r.area === area; });
  var stores = DATA.stores.filter(function(s){ return !area || s.area === area; });
  return { area: area, sales: sales, issues: issues, stores: stores };
}

function updatesConfigured(){
  return !!(DATA.updates && DATA.updates.configured);
}

// One record per store: gap counts, weekly-update status, and an overall status.
function buildScorecard(scope){
  var configured = updatesConfigured();
  var byStore = {};
  scope.stores.forEach(function(s){
    var u = (DATA.updates && DATA.updates.byStore && DATA.updates.byStore[s.storeId]) || null;
    byStore[s.storeId] = {
      storeId: s.storeId, storeName: s.storeName, area: s.area,
      unexplained: 0, incomplete: 0, hasSales: false, issueCount: 0,
      // Weekly update tracking (only meaningful when the tab is configured).
      hasStamp: u ? u.hasStamp : false,
      updatedThisWeek: u ? u.updatedThisWeek : false,
      daysSince: u ? u.daysSince : null,
      lastUpdatedText: u ? u.lastUpdatedText : '',
    };
  });
  scope.sales.forEach(function(r){
    var row = byStore[r.storeId];
    if (!row) return;
    row.hasSales = true;
    if (r.diffVal < 0 && !r.justification) row.unexplained++;
  });
  scope.issues.forEach(function(r){
    var row = byStore[r.storeId];
    if (!row) return;
    row.issueCount++;
    if (missingFields(r).length) row.incomplete++;
  });
  var out = [];
  for (var id in byStore) if (byStore.hasOwnProperty(id)) {
    var r = byStore[id];
    r.totalFlags = r.unexplained + r.incomplete;
    // Overdue only counts once weekly tracking is set up.
    r.overdue = configured && !r.updatedThisWeek;
    if (configured) {
      r.status = (r.totalFlags || r.overdue) ? 'Flagged' : 'Clean';
    } else if (!r.hasSales && r.issueCount === 0) {
      r.status = 'No data';
    } else {
      r.status = r.totalFlags ? 'Flagged' : 'Clean';
    }
    out.push(r);
  }
  return out;
}

function renderCompliance(){
  if (!DATA.stores || !DATA.stores.length) return;
  var scope = complianceScope();
  var cards = buildScorecard(scope);

  renderComplianceKpis(scope, cards);
  renderComplianceAreaChart(cards);
  renderComplianceFieldChart(scope);
  renderScorecardTable(cards);
  renderComplianceDeclines(scope);
  renderComplianceIssues(scope);
}

function renderComplianceKpis(scope, cards){
  var flagged = cards.filter(function(c){ return c.status === 'Flagged'; }).length;
  var clean = cards.filter(function(c){ return c.status === 'Clean'; }).length;
  var noData = cards.filter(function(c){ return c.status === 'No data'; }).length;

  var declines = scope.sales.filter(function(r){ return r.diffVal < 0; }).length;
  var unexplained = scope.sales.filter(function(r){ return r.diffVal < 0 && !r.justification; }).length;
  var totalIssues = scope.issues.length;
  var incomplete = scope.issues.filter(function(r){ return missingFields(r).length; }).length;

  var issuePct = totalIssues ? Math.round(((totalIssues - incomplete) / totalIssues) * 100) : null;
  var covPct = declines ? Math.round(((declines - unexplained) / declines) * 100) : null;

  var html = '';
  html += kpi('Stores Flagged', flagged + ' of ' + cards.length,
              noData ? noData + ' with no data yet' : 'across ' + cards.length + ' stores',
              flagged ? 'down' : 'up');
  if (updatesConfigured()) {
    var updated = cards.filter(function(c){ return c.updatedThisWeek; }).length;
    var overdue = cards.filter(function(c){ return c.overdue; }).length;
    html += kpi('Updated This Week', updated + ' of ' + cards.length,
                cards.length ? Math.round((updated / cards.length) * 100) + '% on time' : '-',
                overdue ? 'down' : 'up');
    html += kpi('Not Updated', String(overdue),
                overdue ? 'stores overdue this week' : 'everyone is current', overdue ? 'down' : 'up');
  }
  html += kpi('Fully Clean Stores', String(clean),
              cards.length ? Math.round((clean / cards.length) * 100) + '% of stores' : '-', 'up');
  html += kpi('Unexplained Declines', String(unexplained),
              'of ' + declines + ' total declines', unexplained ? 'down' : 'up');
  html += kpi('Incomplete Issues', String(incomplete),
              'of ' + totalIssues + ' logged', incomplete ? 'down' : 'up');
  html += kpi('Issue-Log Completeness', issuePct === null ? '-' : issuePct + '%',
              'entries with every field', (issuePct !== null && issuePct < 80) ? 'down' : 'up');
  html += kpi('Justification Coverage', covPct === null ? '-' : covPct + '%',
              'declines explained', (covPct !== null && covPct < 80) ? 'down' : 'up');
  $('cKpis').innerHTML = html;
}

function renderComplianceAreaChart(cards){
  var byArea = {};
  cards.forEach(function(c){
    if (!byArea[c.area]) byArea[c.area] = { label: c.area, unexplained: 0, incomplete: 0 };
    byArea[c.area].unexplained += c.unexplained;
    byArea[c.area].incomplete += c.incomplete;
  });
  var list = [];
  for (var k in byArea) if (byArea.hasOwnProperty(k)) {
    byArea[k].total = byArea[k].unexplained + byArea[k].incomplete;
    list.push(byArea[k]);
  }
  list.sort(function(a, b){ return b.total - a.total; });
  if (!list.length || list.every(function(g){ return g.total === 0; })) {
    $('cAreaChart').innerHTML = '<div class="empty">No flags in this selection.</div>';
    return;
  }

  var rowH = 32, T = 10, B = 26, L = 150, R = 80;
  var W = 620, pw = W - L - R;
  var H = T + B + rowH * list.length;
  var max = 1;
  list.forEach(function(g){ max = Math.max(max, g.total); });

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">';
  for (var i = 0; i < list.length; i++) {
    var g = list[i];
    var y = T + rowH * i + 6;
    var uLen = (g.unexplained / max) * pw;
    var iLen = (g.incomplete / max) * pw;
    svg += '<text x="' + (L - 10) + '" y="' + (y + 14) + '" fill="#e8eef5" font-size="12" ' +
           'text-anchor="end">' + esc(g.label.length > 22 ? g.label.slice(0, 21) + '.' : g.label) + '</text>';
    svg += '<rect x="' + L + '" y="' + y + '" width="' + Math.max(uLen, 0) + '" height="19" rx="3" ' +
           'fill="#ff8a3d"><title>' + esc(g.label) + ': ' + g.unexplained + ' unexplained declines</title></rect>';
    svg += '<rect x="' + (L + uLen) + '" y="' + y + '" width="' + Math.max(iLen, 0) + '" height="19" rx="3" ' +
           'fill="#7c5cff"><title>' + esc(g.label) + ': ' + g.incomplete + ' incomplete issues</title></rect>';
    svg += '<text x="' + (L + uLen + iLen + 8) + '" y="' + (y + 14) + '" fill="#93a4b8" font-size="11">' +
           g.total + '</text>';
  }
  svg += '<text x="' + L + '" y="' + (H - 8) + '" fill="#ff8a3d" font-size="11">&#9632; Unexplained declines</text>';
  svg += '<text x="' + (L + 190) + '" y="' + (H - 8) + '" fill="#7c5cff" font-size="11">&#9632; Incomplete issues</text>';
  svg += '</svg>';
  $('cAreaChart').innerHTML = svg;
}

function renderComplianceFieldChart(scope){
  var counts = {};
  scope.issues.forEach(function(r){
    missingFields(r).forEach(function(name){ counts[name] = (counts[name] || 0) + 1; });
  });
  var list = [];
  for (var k in counts) if (counts.hasOwnProperty(k)) list.push({ label: k, n: counts[k] });
  list.sort(function(a, b){ return b.n - a.n; });
  if (!list.length) {
    $('cFieldChart').innerHTML = '<div class="empty">No missing fields in this selection.</div>';
    return;
  }

  var rowH = 30, T = 10, B = 12, L = 150, R = 50;
  var W = 620, pw = W - L - R;
  var H = T + B + rowH * list.length;
  var max = 1;
  list.forEach(function(g){ max = Math.max(max, g.n); });

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">';
  for (var i = 0; i < list.length; i++) {
    var g = list[i];
    var y = T + rowH * i + 5;
    var len = (g.n / max) * pw;
    svg += '<text x="' + (L - 10) + '" y="' + (y + 14) + '" fill="#e8eef5" font-size="12" ' +
           'text-anchor="end">' + esc(g.label) + '</text>';
    svg += '<rect x="' + L + '" y="' + y + '" width="' + Math.max(len, 1) + '" height="19" rx="3" ' +
           'fill="#ff5c72"><title>' + esc(g.label) + ' missing on ' + g.n + ' entr' +
           (g.n === 1 ? 'y' : 'ies') + '</title></rect>';
    svg += '<text x="' + (L + len + 8) + '" y="' + (y + 14) + '" fill="#93a4b8" font-size="11">' + g.n + '</text>';
  }
  svg += '</svg>';
  $('cFieldChart').innerHTML = svg;
}

function updatePill(r){
  if (!updatesConfigured()) return '<span class="pill st-nodata">n/a</span>';
  if (r.updatedThisWeek) return '<span class="pill st-closed">✓ This week</span>';
  if (r.hasStamp) return '<span class="pill st-open">Overdue ' + r.daysSince + 'd</span>';
  return '<span class="pill st-open">Never</span>';
}

function renderScorecardTable(cards){
  var show = $('cStatus').value;
  var rows = cards.filter(function(c){
    if (show === 'flagged') return c.status === 'Flagged';
    if (show === 'overdue') return c.overdue;
    if (show === 'clean') return c.status === 'Clean';
    if (show === 'nodata') return c.status === 'No data';
    return true;
  });
  rows.sort(function(a, b){
    // Overdue first, then most flags, then name.
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (b.totalFlags !== a.totalFlags) return b.totalFlags - a.totalFlags;
    return a.storeName < b.storeName ? -1 : 1;
  });

  var flagged = cards.filter(function(c){ return c.status === 'Flagged'; }).length;
  $('cScoreCount').textContent = '(' + flagged + ' flagged of ' + cards.length + ')';

  var showUpd = updatesConfigured();
  var html = '<thead><tr><th>Store</th><th>Area</th>' +
    (showUpd ? '<th>Last Updated</th><th>This Week</th>' : '') +
    '<th class="n">Unexplained Declines</th>' +
    '<th class="n">Incomplete Issues</th><th class="n">Total Flags</th><th>Status</th></tr></thead><tbody>';
  var colCount = showUpd ? 8 : 6;
  if (!rows.length) {
    html += '<tr><td colspan="' + colCount + '" class="empty">No stores in this view.</td></tr>';
  }
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var stCls = r.status === 'Flagged' ? 'st-open' : (r.status === 'Clean' ? 'st-closed' : 'st-nodata');
    html += '<tr>' +
      '<td>' + esc(r.storeId + ' - ' + r.storeName) + '</td>' +
      '<td>' + esc(r.area) + '</td>' +
      (showUpd ? '<td>' + esc(r.lastUpdatedText || '—') + '</td>' +
                 '<td>' + updatePill(r) + '</td>' : '') +
      '<td class="n ' + (r.unexplained ? 'down' : '') + '">' + r.unexplained + '</td>' +
      '<td class="n ' + (r.incomplete ? 'down' : '') + '">' + r.incomplete + '</td>' +
      '<td class="n ' + (r.totalFlags ? 'down' : 'up') + '">' + r.totalFlags + '</td>' +
      '<td><span class="pill ' + stCls + '">' + esc(r.status) + '</span></td>' +
      '</tr>';
  }
  html += '</tbody>';
  $('cScoreTable').innerHTML = html;
  makeSortable($('cScoreTable'));
}

function renderComplianceDeclines(scope){
  var rows = scope.sales.filter(function(r){ return r.diffVal < 0 && !r.justification; });
  rows.sort(function(a, b){ return a.diffPct - b.diffPct; });
  $('cDeclineCount').textContent = '(' + rows.length + ')';

  var html = '<thead><tr><th>Month</th><th>Area</th><th>Store</th><th>Focus Sub-Dept</th>' +
    '<th class="n">Sales</th><th class="n">Sales LY</th><th class="n">Diff Val</th>' +
    '<th class="n">Diff %</th></tr></thead><tbody>';
  if (!rows.length) {
    html += '<tr><td colspan="8" class="empty">Every decline here has a justification.</td></tr>';
  }
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    html += '<tr>' +
      '<td>' + esc(r.month) + '</td><td>' + esc(r.area) + '</td>' +
      '<td>' + esc(r.storeId + ' - ' + r.storeName) + '</td><td>' + esc(r.sub) + '</td>' +
      '<td class="n">' + fmt(r.sales) + '</td><td class="n">' + fmt(r.salesLy) + '</td>' +
      '<td class="n down">' + fmt(r.diffVal) + '</td><td class="n down">' + fmtPct(r.diffPct) + '</td></tr>';
  }
  html += '</tbody>';
  $('cDeclineTable').innerHTML = html;
  makeSortable($('cDeclineTable'));
}

function renderComplianceIssues(scope){
  var rows = [];
  scope.issues.forEach(function(r){
    var miss = missingFields(r);
    if (miss.length) rows.push({ rec: r, miss: miss });
  });
  rows.sort(function(a, b){ return b.miss.length - a.miss.length; });
  $('cIssueCount').textContent = '(' + rows.length + ')';

  var html = '<thead><tr><th>Store</th><th>Area</th><th>Focus 5</th><th>Category</th>' +
    '<th>Description</th><th>Priority</th><th>Reported</th><th>Status</th>' +
    '<th class="n">Missing</th><th>Missing Fields</th></tr></thead><tbody>';
  if (!rows.length) {
    html += '<tr><td colspan="10" class="empty">Every logged issue here is complete.</td></tr>';
  }
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i].rec, miss = rows[i].miss;
    html += '<tr>' +
      '<td>' + esc(r.storeId + (r.storeName ? ' - ' + r.storeName : '')) + '</td>' +
      '<td>' + esc(r.area) + '</td>' +
      '<td>' + esc(r.focusCategory) + '</td>' +
      '<td>' + esc(r.issueCategory) + '</td>' +
      '<td class="wrapcell" title="' + esc(r.issueDescription) + '">' + esc(clip(r.issueDescription, 40)) + '</td>' +
      '<td>' + (r.priority ? '<span class="pill p-' + esc(r.priority) + '">' + esc(r.priority) + '</span>' : '') + '</td>' +
      '<td>' + esc(r.dateReported) + '</td>' +
      '<td><span class="pill ' + (r.isOpen ? 'st-open">Open' : 'st-closed">Resolved') + '</span></td>' +
      '<td class="n down">' + miss.length + '</td>' +
      '<td class="wrapcell missing">' + esc(miss.join(', ')) + '</td>' +
      '</tr>';
  }
  html += '</tbody>';
  $('cIssueTable').innerHTML = html;
  makeSortable($('cIssueTable'));
}

function buildComplianceFilters(){
  var areas = uniq(DATA.stores.map(function(s){ return s.area; })).sort();
  fillSelect($('cArea'), areas.map(function(a){ return { v: a, t: a }; }), 'All areas');
}

$('cArea').addEventListener('change', renderCompliance);
$('cStatus').addEventListener('change', function(){ renderScorecardTable(buildScorecard(complianceScope())); });

/* =============================== BOOT ================================== */

function loadAll(fresh){
  $('syncNote').textContent = 'Loading...';
  return api('GET', '/api/data' + (fresh ? '?fresh=1' : '')).then(function(j){
    DATA = j;
    STORE_BY_ID = {};
    DATA.stores.forEach(function(s){ STORE_BY_ID[s.storeId] = s; });
    buildFilters();
    buildIssueFilters();
    buildComplianceFilters();
    renderSales();
    $('syncNote').textContent = 'Synced ' + new Date().toLocaleTimeString();
    return loadIssues(fresh);
  }).catch(function(e){
    $('syncNote').textContent = 'Load failed';
    toast(e.message, true);
  });
}

$('refreshBtn').addEventListener('click', function(){ loadAll(true); });
loadAll(false);

})();
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log('Fresh Focus 5 running on http://localhost:' + PORT);
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    console.log('WARNING: GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY are not set — Google API calls will fail.');
  }
});
