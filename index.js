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
