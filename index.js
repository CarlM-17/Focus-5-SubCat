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
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
const TAB_AMS = 'AreaManagers';       // Name, Area, Passcode — authorises acknowledgment
const TAB_ACK = 'Acknowledgments';    // Issue Key, Acknowledged By, Acknowledged At (app-written)

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
    // Stable key for acknowledgment: IMPORTRANGE rows have no fixed row number,
    // so identity is a composite of fields that don't change once entered.
    rec.ackKey = issueKey(rec);
    out.push(rec);
  }
  return { headerRow: headerRow + 1, rows: out, importErrors: importErrors };
}

// Composite issue identity — survives row reordering from IMPORTRANGE refreshes.
function issueKey(rec) {
  return [
    txt(rec.storeId),
    txt(rec.dateReported),
    titleCase(rec.focusCategory),
    txt(rec.issueCategory),
    txt(rec.issueDescription).toLowerCase().replace(/\s+/g, ' '),
  ].join('|');
}

// Acknowledgments tab -> { issueKey: { by, at } }. Absent tab => no acks yet.
async function loadAcks() {
  let rows;
  try { rows = await readRange(TAB_ACK + '!A1:C5000'); }
  catch (e) { return {}; }
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const k = txt(r[0]);
    const by = txt(r[1]);
    if (!k || !by) continue;                 // blank / cleared rows are "not acknowledged"
    map[k] = { by: by, at: txt(r[2]) };
  }
  return map;
}

app.get('/api/issues', async (req, res) => {
  try {
    const ttl = req.query.fresh ? 0 : ISSUES_TTL;
    const ref = await cached('reference', DATA_TTL, loadReference);
    const data = await cached('issues', ttl, async () => {
      const [issues, ackMap] = await Promise.all([loadIssues(ref.storeById), loadAcks()]);
      issues.rows.forEach((r) => {
        const a = ackMap[r.ackKey];
        r.acknowledgedBy = a ? a.by : '';
        r.acknowledgedAt = a ? a.at : '';
      });
      return issues;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================================
 *  AREA-MANAGER ACKNOWLEDGMENT
 *  Only an AM (validated against the AreaManagers tab by passcode) may
 *  acknowledge, and only issues from stores in their own area(s). Enforced
 *  here on the server — hiding the button in the UI is not the gate.
 * ==========================================================================*/
function uniqList(arr) {
  const seen = {}, out = [];
  arr.forEach((v) => { if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
  return out;
}

function nowStamp() {
  return frameToText(Date.now() + MANILA_OFFSET_MS);   // Manila local, "YYYY-MM-DD HH:MM"
}

async function loadAMs() {
  let rows;
  try { rows = await readRange(TAB_AMS + '!A1:C500'); }
  catch (e) { return []; }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = txt(r[0]), area = txt(r[1]), pass = txt(r[2]);
    if (!pass) continue;
    out.push({ name: name, area: area, pass: pass });
  }
  return out;
}

// Resolve a passcode to { name, areas }. One AM may manage several areas (one
// row per area, same passcode), so the areas are collected across matches.
async function amByPasscode(passcode) {
  const p = txt(passcode);
  if (!p) return null;
  const ams = await cached('ams', 60000, loadAMs);
  const matches = ams.filter((a) => a.pass === p);
  if (!matches.length) return null;
  return { name: matches[0].name, areas: uniqList(matches.map((m) => m.area)) };
}

// Upsert one acknowledgment row keyed by issue key. by='' clears it (un-ack).
async function writeAck(key, by) {
  let rows;
  try { rows = await readRange(TAB_ACK + '!A1:C5000'); }
  catch (e) {
    throw new Error('Create an "' + TAB_ACK + '" tab first (columns: Issue Key, Acknowledged By, Acknowledged At).');
  }
  const values = [[key, by, by ? nowStamp() : '']];
  let foundRow = -1;
  for (let i = 1; i < rows.length; i++) {
    if (txt((rows[i] || [])[0]) === key) { foundRow = i + 1; break; }
  }
  if (foundRow > 0) {
    await sheetsApi('PUT', '/values/' + encodeURIComponent(TAB_ACK + '!A' + foundRow + ':C' + foundRow) +
      '?valueInputOption=USER_ENTERED', { values: values });
  } else if (by) {
    await sheetsApi('POST', '/values/' + encodeURIComponent(TAB_ACK + '!A:C') +
      ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', { values: values });
  }
  delete CACHE['issues'];   // so the next load reflects the change
}

app.post('/api/am/verify', async (req, res) => {
  try {
    const am = await amByPasscode((req.body || {}).passcode);
    if (!am) return res.status(401).json({ ok: false, error: 'Invalid passcode.' });
    res.json({ ok: true, name: am.name, areas: am.areas });   // never returns the passcode
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function ackHandler(req, res, acknowledge) {
  try {
    const b = req.body || {};
    const am = await amByPasscode(b.passcode);
    if (!am) return res.status(401).json({ error: 'Sign in with a valid Area Manager passcode first.' });
    const key = txt(b.key);
    if (!key) return res.status(400).json({ error: 'Missing issue key.' });
    const storeId = key.split('|')[0];
    const ref = await cached('reference', DATA_TTL, loadReference);
    const store = ref.storeById[storeId];
    const area = store ? store.area : '';
    if (am.areas.indexOf(area) === -1) {
      return res.status(403).json({ error: 'That issue is in ' + (area || 'an unassigned area') +
        '. You manage: ' + (am.areas.join(', ') || '(none)') + '.' });
    }
    await writeAck(key, acknowledge ? am.name : '');
    res.json({ ok: true, by: acknowledge ? am.name : '', at: acknowledge ? nowStamp() : '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
app.post('/api/ack', (req, res) => ackHandler(req, res, true));
app.post('/api/unack', (req, res) => ackHandler(req, res, false));

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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Fresh Focus 5 running on http://localhost:' + PORT);
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    console.log('WARNING: GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY are not set — Google API calls will fail.');
  }
});
