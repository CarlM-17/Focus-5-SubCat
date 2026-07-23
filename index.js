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
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const TAB_SALES = 'FocusSubDept';
const TAB_ISSUES = 'IssuesAndConcerns';
const TAB_STORES = 'ListOfStores';
const TAB_FOCUS = 'Focus5List';

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

const gidCache = {};
async function getTabGid(title) {
  if (gidCache[title] !== undefined) return gidCache[title];
  const meta = await sheetsApi('GET', '?fields=sheets.properties');
  const all = meta.sheets || [];
  const target = title.trim().toLowerCase();
  const sheet = all.find((s) => s.properties.title === title)
    || all.find((s) => s.properties.title.trim().toLowerCase() === target);
  if (!sheet) throw new Error('Tab "' + title + '" not found. Tabs: ' + all.map((s) => s.properties.title).join(', '));
  gidCache[title] = sheet.properties.sheetId;
  return gidCache[title];
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
  const rows = await readRange(TAB_SALES + '!A1:H5000');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const month = txt(r[0]);
    const storeId = txt(r[1]);
    const sub = txt(r[3]);
    if (!month || !storeId || !sub) continue;
    const sales = num(r[4]);
    const salesLy = num(r[5]);
    const store = storeById[storeId];
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
    });
  }
  return out;
}

app.get('/api/data', async (req, res) => {
  try {
    const stores = await loadStores();
    const storeById = {};
    stores.forEach((s) => { storeById[s.storeId] = s; });
    const [focusList, sales] = await Promise.all([loadFocusList(), loadSales(storeById)]);
    res.json({ stores: stores, focusList: focusList, sales: sales, months: MONTHS, today: todayISO() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================================
 *  ISSUE LOG
 * ==========================================================================*/

// The IssuesAndConcerns tab does not start at row 1: there is a blank row, the
// header row, a row of input hints ("Enter Store ID", "Auto", ...) and a few
// stray data-validation lists. Find the header row, then keep only rows that
// look like real entries.
async function loadIssues() {
  const rows = await readRange(TAB_ISSUES + '!A1:' + ISSUE_LAST_COL + '2000');
  let headerRow = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    if (txt((rows[i] || [])[0]).toLowerCase() === 'store id') { headerRow = i; break; }
  }
  if (headerRow === -1) throw new Error('Could not find the "Store ID" header row in ' + TAB_ISSUES);

  const out = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const storeId = txt(r[0]);
    if (!storeId) continue;                                   // blank / validation-list rows
    if (storeId.toLowerCase().indexOf('enter ') === 0) continue; // the hint row
    const rec = { row: i + 1 };                               // 1-based sheet row
    ISSUE_FIELDS.forEach((f, idx) => { rec[f] = txt(r[idx]); });
    // Unresolved issues keep counting, so days open is always recomputed.
    rec.daysOpen = computeDaysOpen(rec.dateReported, rec.dateResolved);
    out.push(rec);
  }
  return { headerRow: headerRow + 1, rows: out };
}

function issueToRow(rec) {
  const clean = {};
  ISSUE_FIELDS.forEach((f) => { clean[f] = txt(rec[f]); });
  if (!clean.date) clean.date = todayISO();
  if (clean.resolved.toUpperCase() !== 'Y') clean.dateResolved = '';
  clean.daysOpen = String(computeDaysOpen(clean.dateReported, clean.dateResolved));
  return ISSUE_FIELDS.map((f) => clean[f]);
}

app.get('/api/issues', async (req, res) => {
  try {
    res.json(await loadIssues());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/issues', async (req, res) => {
  try {
    const values = issueToRow(req.body || {});
    if (!values[0]) return res.status(400).json({ error: 'Store ID is required' });
    const result = await sheetsApi(
      'POST',
      '/values/' + encodeURIComponent(TAB_ISSUES + '!A:' + ISSUE_LAST_COL) +
        ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
      { values: [values] }
    );
    res.json({ ok: true, updatedRange: result.updates && result.updates.updatedRange });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/issues/:row', async (req, res) => {
  try {
    const row = parseInt(req.params.row, 10);
    if (!row || row < 2) return res.status(400).json({ error: 'Bad row number' });
    const values = issueToRow(req.body || {});
    if (!values[0]) return res.status(400).json({ error: 'Store ID is required' });
    const range = TAB_ISSUES + '!A' + row + ':' + ISSUE_LAST_COL + row;
    await sheetsApi('PUT', '/values/' + encodeURIComponent(range) + '?valueInputOption=USER_ENTERED',
      { values: [values] });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/issues/:row', async (req, res) => {
  try {
    const row = parseInt(req.params.row, 10);
    if (!row || row < 2) return res.status(400).json({ error: 'Bad row number' });
    const gid = await getTabGid(TAB_ISSUES);
    await sheetsApi('POST', ':batchUpdate', {
      requests: [{
        deleteDimension: {
          range: { sheetId: gid, dimension: 'ROWS', startIndex: row - 1, endIndex: row },
        },
      }],
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const meta = await sheetsApi('GET', '?fields=properties.title,sheets.properties.title');
    res.json({
      ok: true,
      title: meta.properties && meta.properties.title,
      tabs: (meta.sheets || []).map((s) => s.properties.title),
      serviceAccount: CLIENT_EMAIL || '(not set)',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, serviceAccount: CLIENT_EMAIL || '(not set)' });
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
.form-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
@media(max-width:1100px){.form-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:620px){.form-grid{grid-template-columns:1fr}}
.fld-wide{grid-column:1/-1}
.fld small{text-transform:none;letter-spacing:0;color:#6c8099}
.req{color:var(--down)}
.form-actions{grid-column:1/-1;display:flex;align-items:center;gap:12px;margin-top:4px}
.form-msg{font-size:12px;color:var(--muted)}
.issue-filters{display:flex;gap:8px;flex-wrap:wrap}
.issue-filters input{min-width:230px}
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
</section>

<section id="tab-issues" class="tabpane">
  <div class="card">
    <div class="card-head">
      <h2 id="formTitle">New Issue Entry</h2>
      <button id="cancelEdit" class="btn btn-ghost btn-sm hidden" type="button">Cancel edit</button>
    </div>
    <form id="issueForm" class="form-grid" autocomplete="off">
      <label class="fld">Store ID <span class="req">*</span>
        <input id="iStoreId" list="storeIdList" placeholder="e.g. 105" required>
        <datalist id="storeIdList"></datalist>
      </label>
      <label class="fld">Area <small>auto</small><input id="iArea" readonly class="auto"></label>
      <label class="fld">Store Name <small>auto</small><input id="iStoreName" readonly class="auto"></label>
      <label class="fld">Date <small>auto</small><input id="iDate" type="date" readonly class="auto"></label>

      <label class="fld">Reported by<input id="iReportedBy" placeholder="Name"></label>
      <label class="fld">Focus 5 Category<select id="iFocusCategory"></select></label>
      <label class="fld">Issue Category
        <select id="iIssueCategory">
          <option value=""></option><option>Price</option><option>Delivery</option>
          <option>Quality</option><option>CSL</option><option>Other</option>
        </select>
      </label>
      <label class="fld">Priority
        <select id="iPriority">
          <option value=""></option><option>Low</option><option>Medium</option><option>High</option>
        </select>
      </label>

      <label class="fld fld-wide">Issue Description<textarea id="iIssueDescription" rows="2"></textarea></label>

      <label class="fld">Reported to Buyer / MRG<input id="iReportedTo"></label>
      <label class="fld">Date Reported<input id="iDateReported" type="date"></label>
      <label class="fld">Date Resolved<input id="iDateResolved" type="date"></label>
      <label class="fld">Days Open <small>auto</small><input id="iDaysOpen" readonly class="auto"></label>

      <label class="fld fld-wide">Feedback<textarea id="iFeedback" rows="2"></textarea></label>
      <label class="fld fld-wide">Resolution Details<textarea id="iResolutionDetails" rows="2"></textarea></label>
      <label class="fld fld-wide">Remarks / Notes<textarea id="iRemarks" rows="2"></textarea></label>

      <label class="fld">Resolved? [Y/N]
        <select id="iResolved">
          <option value=""></option><option value="Y">Y</option><option value="N">N</option>
        </select>
      </label>

      <div class="form-actions">
        <button id="saveBtn" class="btn btn-primary" type="submit">Save Entry</button>
        <button id="clearBtn" class="btn btn-ghost" type="button">Clear</button>
        <span id="formMsg" class="form-msg"></span>
      </div>
    </form>
  </div>

  <div class="card">
    <div class="card-head">
      <h2>Logged Issues</h2>
      <div class="issue-filters">
        <select id="qResolved">
          <option value="">All status</option><option value="open">Open only</option>
          <option value="closed">Resolved only</option>
        </select>
        <select id="qPriority">
          <option value="">All priority</option><option>High</option>
          <option>Medium</option><option>Low</option>
        </select>
        <input id="qSearch" placeholder="Search store, category, description...">
      </div>
    </div>
    <div class="table-scroll"><table id="issueTable" class="data"></table></div>
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
var EDIT_ROW = null;
var STORE_BY_ID = {};

var MONTHS = ['January','February','March','April','May','June',
              'July','August','September','October','November','December'];
var ISSUE_CATEGORIES = ['Price','Delivery','Quality','CSL','Other'];

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
}

$('fArea').addEventListener('change', function(){ buildStoreFilter(); renderSales(); });
['fStore','fSub','fFrom','fTo','gBy'].forEach(function(id){
  $(id).addEventListener('change', renderSales);
});
$('fReset').addEventListener('click', function(){
  $('fArea').value = ''; $('fSub').value = '';
  buildStoreFilter();
  var idxs = monthsPresent();
  if (idxs.length) { $('fFrom').value = String(idxs[0]); $('fTo').value = String(idxs[idxs.length-1]); }
  renderSales();
});

/* ============================== ISSUE TAB ============================== */

function buildIssueForm(){
  var opts = '<option value=""></option>';
  var subs = DATA.focusList.length ? DATA.focusList : ['Rice','Poultry','Sugar','Eggs','Pork'];
  subs.forEach(function(s){ opts += '<option>' + esc(s) + '</option>'; });
  $('iFocusCategory').innerHTML = opts;

  var dl = '';
  DATA.stores.forEach(function(s){
    dl += '<option value="' + esc(s.storeId) + '">' + esc(s.storeName + ' (' + s.area + ')') + '</option>';
  });
  $('storeIdList').innerHTML = dl;

  $('iDate').value = DATA.today;
}

function lookupStore(){
  var id = $('iStoreId').value.trim();
  var s = STORE_BY_ID[id];
  $('iArea').value = s ? s.area : '';
  $('iStoreName').value = s ? s.storeName : '';
  if (id && !s) $('iStoreName').value = 'Store ID not in ListOfStores';
}

function recalcDays(){
  var start = $('iDateReported').value;
  if (!start) { $('iDaysOpen').value = ''; return; }
  var a = new Date(start);
  var endStr = $('iDateResolved').value;
  var b = endStr ? new Date(endStr) : new Date();
  var d = Math.floor((b - a) / 86400000);
  $('iDaysOpen').value = d < 0 ? 0 : d;
}

$('iStoreId').addEventListener('input', lookupStore);
$('iStoreId').addEventListener('change', lookupStore);
$('iDateReported').addEventListener('change', recalcDays);
$('iDateResolved').addEventListener('change', function(){
  if ($('iDateResolved').value && $('iResolved').value !== 'Y') $('iResolved').value = 'Y';
  recalcDays();
});
$('iResolved').addEventListener('change', function(){
  // An unresolved issue must not carry a resolved date, or days open stops counting.
  if ($('iResolved').value !== 'Y') $('iDateResolved').value = '';
  recalcDays();
});

function formValues(){
  return {
    storeId: $('iStoreId').value.trim(),
    area: $('iArea').value,
    storeName: $('iStoreName').value,
    date: $('iDate').value,
    reportedBy: $('iReportedBy').value,
    focusCategory: $('iFocusCategory').value,
    issueCategory: $('iIssueCategory').value,
    issueDescription: $('iIssueDescription').value,
    priority: $('iPriority').value,
    reportedTo: $('iReportedTo').value,
    dateReported: $('iDateReported').value,
    feedback: $('iFeedback').value,
    resolutionDetails: $('iResolutionDetails').value,
    dateResolved: $('iDateResolved').value,
    daysOpen: $('iDaysOpen').value,
    remarks: $('iRemarks').value,
    resolved: $('iResolved').value
  };
}

function clearForm(){
  EDIT_ROW = null;
  $('issueForm').reset();
  $('iDate').value = DATA.today;
  $('iArea').value = '';
  $('iStoreName').value = '';
  $('iDaysOpen').value = '';
  $('formTitle').textContent = 'New Issue Entry';
  $('saveBtn').textContent = 'Save Entry';
  $('cancelEdit').classList.add('hidden');
  $('formMsg').textContent = '';
}

function loadIntoForm(rec){
  EDIT_ROW = rec.row;
  $('iStoreId').value = rec.storeId;
  $('iArea').value = rec.area;
  $('iStoreName').value = rec.storeName;
  $('iDate').value = toDateInput(rec.date) || DATA.today;
  $('iReportedBy').value = rec.reportedBy;
  $('iFocusCategory').value = rec.focusCategory;
  $('iIssueCategory').value = rec.issueCategory;
  $('iIssueDescription').value = rec.issueDescription;
  $('iPriority').value = rec.priority;
  $('iReportedTo').value = rec.reportedTo;
  $('iDateReported').value = toDateInput(rec.dateReported);
  $('iFeedback').value = rec.feedback;
  $('iResolutionDetails').value = rec.resolutionDetails;
  $('iDateResolved').value = toDateInput(rec.dateResolved);
  $('iRemarks').value = rec.remarks;
  $('iResolved').value = (rec.resolved || '').toUpperCase() === 'Y' ? 'Y' :
                         ((rec.resolved || '').toUpperCase() === 'N' ? 'N' : '');
  recalcDays();
  $('formTitle').textContent = 'Editing row ' + rec.row;
  $('saveBtn').textContent = 'Update Entry';
  $('cancelEdit').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toDateInput(v){
  if (!v) return '';
  var d = new Date(v);
  if (isNaN(d.getTime())) return '';
  var p = function(n){ return String(n).length < 2 ? '0' + n : String(n); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

$('issueForm').addEventListener('submit', function(ev){
  ev.preventDefault();
  var v = formValues();
  if (!v.storeId) { toast('Store ID is required', true); return; }
  if (!STORE_BY_ID[v.storeId]) { toast('Store ID ' + v.storeId + ' is not in ListOfStores', true); return; }
  $('saveBtn').disabled = true;
  $('formMsg').textContent = 'Saving...';
  var p = EDIT_ROW ? api('PUT', '/api/issues/' + EDIT_ROW, v) : api('POST', '/api/issues', v);
  p.then(function(){
    toast(EDIT_ROW ? 'Row updated' : 'Issue logged');
    clearForm();
    return loadIssues();
  }).catch(function(e){
    toast(e.message, true);
    $('formMsg').textContent = e.message;
  }).then(function(){
    $('saveBtn').disabled = false;
  });
});

$('clearBtn').addEventListener('click', clearForm);
$('cancelEdit').addEventListener('click', clearForm);

function issueMatches(rec){
  var st = $('qResolved').value;
  var isClosed = (rec.resolved || '').toUpperCase() === 'Y';
  if (st === 'open' && isClosed) return false;
  if (st === 'closed' && !isClosed) return false;
  var pr = $('qPriority').value;
  if (pr && rec.priority !== pr) return false;
  var q = $('qSearch').value.trim().toLowerCase();
  if (q) {
    var hay = [rec.storeId, rec.storeName, rec.area, rec.focusCategory, rec.issueCategory,
               rec.issueDescription, rec.reportedBy, rec.remarks].join(' ').toLowerCase();
    if (hay.indexOf(q) === -1) return false;
  }
  return true;
}

function renderIssues(){
  var rows = ISSUES.filter(issueMatches);
  var html = '<thead><tr>' +
    '<th>Store</th><th>Area</th><th>Date</th><th>Reported by</th><th>Focus 5</th>' +
    '<th>Category</th><th>Description</th><th>Priority</th><th>To Buyer/MRG</th>' +
    '<th>Reported</th><th>Resolved</th><th class="n">Days Open</th><th>Status</th><th></th>' +
    '</tr></thead><tbody>';

  if (!rows.length) {
    html += '<tr><td colspan="14" class="empty">No issues logged yet.</td></tr>';
  }
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var closed = (r.resolved || '').toUpperCase() === 'Y';
    var desc = r.issueDescription || '';
    if (desc.length > 44) desc = desc.slice(0, 43) + '.';
    var dayCls = closed ? '' : (r.daysOpen > 14 ? 'down' : (r.daysOpen > 7 ? '' : ''));
    html += '<tr>' +
      '<td>' + esc(r.storeId + ' - ' + r.storeName) + '</td>' +
      '<td>' + esc(r.area) + '</td>' +
      '<td>' + esc(r.date) + '</td>' +
      '<td>' + esc(r.reportedBy) + '</td>' +
      '<td>' + esc(r.focusCategory) + '</td>' +
      '<td>' + esc(r.issueCategory) + '</td>' +
      '<td title="' + esc(r.issueDescription) + '">' + esc(desc) + '</td>' +
      '<td>' + (r.priority ? '<span class="pill p-' + esc(r.priority) + '">' + esc(r.priority) + '</span>' : '') + '</td>' +
      '<td>' + esc(r.reportedTo) + '</td>' +
      '<td>' + esc(r.dateReported) + '</td>' +
      '<td>' + esc(r.dateResolved) + '</td>' +
      '<td class="n ' + dayCls + '">' + esc(r.daysOpen) + '</td>' +
      '<td><span class="pill ' + (closed ? 'st-closed">Resolved' : 'st-open">Open') + '</span></td>' +
      '<td><button class="btn btn-ghost btn-sm" data-edit="' + r.row + '" type="button">Edit</button> ' +
      '<button class="btn btn-ghost btn-sm" data-del="' + r.row + '" type="button">Del</button></td>' +
      '</tr>';
  }
  html += '</tbody>';
  $('issueTable').innerHTML = html;

  var eds = $('issueTable').querySelectorAll('[data-edit]');
  for (var e = 0; e < eds.length; e++) {
    eds[e].addEventListener('click', function(){
      var row = parseInt(this.getAttribute('data-edit'), 10);
      var rec = ISSUES.filter(function(x){ return x.row === row; })[0];
      if (rec) loadIntoForm(rec);
    });
  }
  var dels = $('issueTable').querySelectorAll('[data-del]');
  for (var d = 0; d < dels.length; d++) {
    dels[d].addEventListener('click', function(){
      var row = parseInt(this.getAttribute('data-del'), 10);
      if (!confirm('Delete issue row ' + row + ' from the sheet?')) return;
      api('DELETE', '/api/issues/' + row).then(function(){
        toast('Row deleted');
        return loadIssues();
      }).catch(function(err){ toast(err.message, true); });
    });
  }
}

['qResolved','qPriority','qSearch'].forEach(function(id){
  $(id).addEventListener('input', renderIssues);
  $(id).addEventListener('change', renderIssues);
});

function loadIssues(){
  return api('GET', '/api/issues').then(function(j){
    ISSUES = j.rows || [];
    renderIssues();
  }).catch(function(e){ toast('Issues: ' + e.message, true); });
}

/* =============================== BOOT ================================== */

function loadAll(){
  $('syncNote').textContent = 'Loading...';
  return api('GET', '/api/data').then(function(j){
    DATA = j;
    STORE_BY_ID = {};
    DATA.stores.forEach(function(s){ STORE_BY_ID[s.storeId] = s; });
    buildFilters();
    buildIssueForm();
    renderSales();
    $('syncNote').textContent = 'Synced ' + new Date().toLocaleTimeString();
    return loadIssues();
  }).catch(function(e){
    $('syncNote').textContent = 'Load failed';
    toast(e.message, true);
  });
}

$('refreshBtn').addEventListener('click', loadAll);
loadAll();

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
