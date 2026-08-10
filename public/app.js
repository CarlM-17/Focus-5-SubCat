/* Client code uses string concatenation only (no template literals) so it can
   live inside the server's template literal without escaping traps. */
(function(){
'use strict';

var DATA = { stores: [], focusList: [], sales: [], months: [], today: '' };
var ISSUES = [];
var STORE_BY_ID = {};
// Area-Manager session, held only in this tab's memory for the session.
var AM_SESSION = null;   // { name, areas:[], passcode } once signed in

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
  var cleaned = text.replace(/[,s%₱]/g, '');
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

  var ack = $('qAck').value;
  if (ack === 'ack' && !rec.acknowledgedBy) return false;
  if (ack === 'unack' && rec.acknowledgedBy) return false;

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
  var unackHigh = open.filter(function(r){ return r.priority === 'High' && !r.acknowledgedBy; }).length;
  html += kpi('Unacknowledged High', String(unackHigh),
              unackHigh ? 'awaiting AM acknowledgment' : 'all high acknowledged', unackHigh ? 'down' : 'up');
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

var LOG_VIEW = 'open';   // Consolidated Issue Log sub-tab: 'open' | 'resolved'

function renderIssueTable(rows){
  // Sub-tab counts reflect the filtered set (before the open/resolved split).
  var openN = rows.filter(function(r){ return r.isOpen; }).length;
  $('openCount').textContent = '(' + openN + ')';
  $('resolvedCount').textContent = '(' + (rows.length - openN) + ')';

  var view = rows.filter(function(r){ return LOG_VIEW === 'open' ? r.isOpen : !r.isOpen; });
  var sorted = view.slice().sort(function(a, b){
    // Within a tab everything shares a status, so sort by oldest-open first.
    return (Number(b.daysOpen) || 0) - (Number(a.daysOpen) || 0);
  });

  var html = '<thead><tr>' +
    '<th>Store</th><th>Area</th><th>Date</th><th>Reported by</th><th>Focus 5</th>' +
    '<th>Category</th><th>Description</th><th>Priority</th><th>To Buyer/MRG</th>' +
    '<th>Reported</th><th>Feedback</th><th>Resolution</th><th>Resolved</th>' +
    '<th class="n">Days Open</th><th>Remarks</th><th>Status</th><th>Acknowledged by AM</th>' +
    '</tr></thead><tbody>';

  if (!sorted.length) {
    html += '<tr><td colspan="17" class="empty">No issues match these filters.</td></tr>';
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
      '<td>' + ackCell(r) + '</td>' +
      '</tr>';
  }
  html += '</tbody>';
  $('issueTable').innerHTML = html;
  wireAckButtons();
  makeSortable($('issueTable'));
  $('issueCount').textContent = '(' + sorted.length + ' ' + LOG_VIEW + ')';
}

function clip(s, n){
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '.' : s;
}

/* ------------------------- AM acknowledgment ------------------------- */

function amManagesArea(area){ return !!(AM_SESSION && AM_SESSION.areas.indexOf(area) !== -1); }

function ackCell(r){
  if (r.acknowledgedBy) {
    var undo = amManagesArea(r.area)
      ? ' <span class="undo" data-unack="' + esc(r.ackKey) + '" data-area="' + esc(r.area) + '">undo</span>' : '';
    return '<span class="ack-by">✓ ' + esc(r.acknowledgedBy) +
      (r.acknowledgedAt ? ' <span class="at">' + esc(r.acknowledgedAt) + '</span>' : '') + undo + '</span>';
  }
  // Signed-in AM who doesn't manage this area can't act on it.
  if (AM_SESSION && !amManagesArea(r.area)) return '<span class="ack-pending">—</span>';
  return '<button class="btn-ack" data-ack="' + esc(r.ackKey) + '" data-area="' + esc(r.area) + '">Acknowledge</button>';
}

function wireAckButtons(){
  var tbl = $('issueTable');
  var acks = tbl.querySelectorAll('[data-ack]');
  for (var i = 0; i < acks.length; i++) {
    acks[i].addEventListener('click', function(){
      doAck(this.getAttribute('data-ack'), this.getAttribute('data-area'), true);
    });
  }
  var uns = tbl.querySelectorAll('[data-unack]');
  for (var j = 0; j < uns.length; j++) {
    uns[j].addEventListener('click', function(){
      doAck(this.getAttribute('data-unack'), this.getAttribute('data-area'), false);
    });
  }
}

function doAck(key, area, acknowledge){
  ensureAM(function(){
    if (!amManagesArea(area)) {
      toast('You manage ' + (AM_SESSION.areas.join(', ') || 'no areas') + ', not ' + area + '.', true);
      return;
    }
    api('POST', acknowledge ? '/api/ack' : '/api/unack', { key: key, passcode: AM_SESSION.passcode })
      .then(function(res){
        toast(acknowledge ? 'Acknowledged by ' + res.by : 'Acknowledgment removed');
        return loadIssues();
      })
      .catch(function(e){ toast(e.message, true); });
  });
}

function ensureAM(cb){ if (AM_SESSION) { cb(); return; } amSignIn(cb); }

// The AM session persists in localStorage so sign-in survives page reloads and
// browser restarts — the AM stays signed in until they sign out. It's an
// internal PIN, so keeping it on the AM's own device is acceptable.
var AM_STORE_KEY = 'ff5_am';
function saveAM(){
  try { if (AM_SESSION) localStorage.setItem(AM_STORE_KEY, JSON.stringify(AM_SESSION));
        else localStorage.removeItem(AM_STORE_KEY); } catch (e) {}
}

function amSignIn(cb){
  var code = window.prompt('Enter your Area Manager passcode:');
  if (code === null) return;
  code = code.trim();
  if (!code) return;
  api('POST', '/api/am/verify', { passcode: code }).then(function(res){
    AM_SESSION = { name: res.name, areas: res.areas || [], passcode: code };
    saveAM();
    updateAmStatus();
    renderIssues();
    toast('Signed in as ' + res.name + ' (' + (AM_SESSION.areas.join(', ') || 'no areas') + ')');
    if (cb) cb();
  }).catch(function(e){ toast(e.message || 'Invalid passcode', true); });
}

// On load, restore a saved session and re-check it against the server so a
// passcode that was changed or removed in the AreaManagers tab signs out.
function restoreAM(){
  var raw;
  try { raw = localStorage.getItem(AM_STORE_KEY); } catch (e) { return; }
  if (!raw) return;
  var sess;
  try { sess = JSON.parse(raw); } catch (e) { return; }
  if (!sess || !sess.passcode) return;
  AM_SESSION = sess;            // trust it for immediate render...
  updateAmStatus();
  api('POST', '/api/am/verify', { passcode: sess.passcode }).then(function(res){
    AM_SESSION = { name: res.name, areas: res.areas || [], passcode: sess.passcode };
    saveAM(); updateAmStatus(); renderIssues();
  }).catch(function(){       // ...but sign out if it's no longer valid
    AM_SESSION = null; saveAM(); updateAmStatus(); renderIssues();
  });
}

function updateAmStatus(){
  var el = $('amStatus'), btn = $('amSignBtn');
  if (AM_SESSION) {
    el.innerHTML = '<span class="signed">Signed in: ' + esc(AM_SESSION.name) + '</span> &middot; ' +
      esc(AM_SESSION.areas.join(', ') || 'no areas');
    btn.textContent = 'Sign out';
  } else {
    el.textContent = 'Not signed in as AM';
    btn.textContent = 'AM sign in';
  }
}

$('amSignBtn').addEventListener('click', function(){
  if (AM_SESSION) { AM_SESSION = null; saveAM(); updateAmStatus(); renderIssues(); toast('Signed out'); }
  else amSignIn(null);
});

function renderIssues(){
  var rows = ISSUES.filter(issueMatches);
  renderIssueKpis(rows);
  renderIssueBreakdown(rows);
  renderAging(rows);
  renderIssueTable(rows);
}

$('qArea').addEventListener('change', function(){ buildIssueStoreFilter(); renderIssues(); });
['qStore','qFocus','qCategory','qPriority','qAging','qAck','obBy'].forEach(function(id){
  $(id).addEventListener('change', renderIssues);
});
$('qSearch').addEventListener('input', renderIssues);
$('qReset').addEventListener('click', function(){
  ['qArea','qStore','qFocus','qCategory','qPriority','qAging','qAck'].forEach(function(id){
    $(id).value = '';
  });
  $('qSearch').value = '';
  buildIssueStoreFilter();
  renderIssues();
});

// Consolidated Issue Log sub-tabs: Open / Resolved.
var logSubtabs = document.querySelectorAll('.subtab[data-log]');
for (var _s = 0; _s < logSubtabs.length; _s++) {
  logSubtabs[_s].addEventListener('click', function(){
    LOG_VIEW = this.getAttribute('data-log');
    for (var i = 0; i < logSubtabs.length; i++) logSubtabs[i].classList.remove('active');
    this.classList.add('active');
    renderIssueTable(ISSUES.filter(issueMatches));
  });
}

/* ============================ EXCEL EXPORT ============================
 * Builds a real .xlsx (a ZIP of XML parts) in the browser with no external
 * library, so it opens natively with no format warning. Cell styles mirror
 * the web app: dark-green header with white bold font, priority/status fills,
 * and red/amber day-age + green acknowledgment colouring.
 * ==================================================================== */

// Style indices into the cellXfs list in STYLES_XML below.
var XS = { DEFAULT: 0, HEADER: 1, NUM: 2, HIGH: 3, MED: 4, LOW: 5, OPEN: 6, RESOLVED: 7, DAYS_RED: 8, DAYS_AMBER: 9, ACK: 10 };

var CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

var ROOT_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

var WB_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

var STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="5">' +
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><sz val="11"/><color rgb="FFCC0000"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><sz val="11"/><color rgb="FFB45309"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><sz val="11"/><color rgb="FF2E7D32"/><name val="Calibri"/><family val="2"/></font>' +
  '</fonts>' +
  '<fills count="7">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF38761D"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF4C7C3"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFCE8B2"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFD9EAD3"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFCE5CD"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  '<borders count="2">' +
    '<border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin"><color rgb="FFD0D0D0"/></left><right style="thin"><color rgb="FFD0D0D0"/></right>' +
      '<top style="thin"><color rgb="FFD0D0D0"/></top><bottom style="thin"><color rgb="FFD0D0D0"/></bottom><diagonal/></border>' +
  '</borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="11">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>' +
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>' +
    '<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

function xlColLetter(i){   // 1-based -> A, B, ... AA
  var s = '';
  while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}
function escXml(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function workbookXml(sheetName){
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="' + escXml(sheetName) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
}

function sheetXml(headers, rows, widths){
  var cols = '<cols>';
  for (var w = 0; w < widths.length; w++) {
    cols += '<col min="' + (w + 1) + '" max="' + (w + 1) + '" width="' + widths[w] + '" customWidth="1"/>';
  }
  cols += '</cols>';

  var sd = '<sheetData><row r="1">';
  for (var h = 0; h < headers.length; h++) {
    sd += '<c r="' + xlColLetter(h + 1) + '1" s="1" t="inlineStr"><is><t xml:space="preserve">' +
      escXml(headers[h]) + '</t></is></c>';
  }
  sd += '</row>';
  for (var ri = 0; ri < rows.length; ri++) {
    var rr = ri + 2;
    sd += '<row r="' + rr + '">';
    var row = rows[ri];
    for (var ci = 0; ci < row.length; ci++) {
      var cell = row[ci], ref = xlColLetter(ci + 1) + rr;
      if (cell.t === 'n' && cell.v !== '' && cell.v != null) {
        sd += '<c r="' + ref + '" s="' + cell.s + '"><v>' + cell.v + '</v></c>';
      } else {
        sd += '<c r="' + ref + '" s="' + cell.s + '" t="inlineStr"><is><t xml:space="preserve">' +
          escXml(cell.v) + '</t></is></c>';
      }
    }
    sd += '</row>';
  }
  sd += '</sheetData>';

  var lastCol = xlColLetter(headers.length);
  var views = '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    views + cols + sd + '<autoFilter ref="A1:' + lastCol + (rows.length + 1) + '"/></worksheet>';
}

// --- minimal ZIP (stored, no compression) ---
var CRC_TABLE = (function(){
  var t = [];
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(u8){
  var c = 0xFFFFFFFF;
  for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files){
  var enc = new TextEncoder();
  var u16 = function(n){ return [n & 0xFF, (n >> 8) & 0xFF]; };
  var u32 = function(n){ return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; };
  var chunks = [], central = [], offset = 0;
  files.forEach(function(f){
    var nameBytes = enc.encode(f.name);
    var crc = crc32(f.data), size = f.data.length;
    var local = new Uint8Array([].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0)));
    chunks.push(local, nameBytes, f.data);
    central.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))));
    central.push(nameBytes);
    offset += local.length + nameBytes.length + f.data.length;
  });
  var centralStart = offset, centralSize = 0;
  central.forEach(function(c){ chunks.push(c); centralSize += c.length; });
  chunks.push(new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralSize), u32(centralStart), u16(0))));
  var total = 0; chunks.forEach(function(c){ total += c.length; });
  var out = new Uint8Array(total), p = 0;
  chunks.forEach(function(c){ out.set(c, p); p += c.length; });
  return out;
}

function buildXlsx(sheetName, headers, rows, widths){
  var enc = new TextEncoder();
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: enc.encode(ROOT_RELS_XML) },
    { name: 'xl/workbook.xml', data: enc.encode(workbookXml(sheetName)) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(WB_RELS_XML) },
    { name: 'xl/styles.xml', data: enc.encode(STYLES_XML) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml(headers, rows, widths)) },
  ]);
}

function exportIssueLog(){
  // Export the current filter across BOTH statuses (a complete log); the Status
  // column distinguishes them. Open first, then oldest.
  var rows = ISSUES.filter(issueMatches).slice().sort(function(a, b){
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
    return (Number(b.daysOpen) || 0) - (Number(a.daysOpen) || 0);
  });
  var headers = ['Store', 'Area', 'Date', 'Reported by', 'Focus 5', 'Issue Category', 'Issue Description',
    'Priority', 'Reported to Buyer/MRG', 'Date Reported', 'Feedback', 'Resolution Details', 'Date Resolved',
    'Days Open', 'Remarks', 'Status', 'Acknowledged by AM'];
  var widths = [20, 16, 12, 14, 10, 13, 42, 10, 20, 13, 24, 24, 13, 11, 22, 11, 24];

  var sc = function(v){ return { v: v == null ? '' : String(v), t: 's', s: XS.DEFAULT }; };
  var data = rows.map(function(r){
    var days = Number(r.daysOpen);
    var hasDays = r.daysOpen !== '' && r.daysOpen != null && !isNaN(days);
    var daysStyle = (r.isOpen && hasDays && days > 30) ? XS.DAYS_RED
                  : (r.isOpen && hasDays && days > 14) ? XS.DAYS_AMBER : XS.NUM;
    var prStyle = r.priority === 'High' ? XS.HIGH : r.priority === 'Medium' ? XS.MED
                : r.priority === 'Low' ? XS.LOW : XS.DEFAULT;
    var ackText = r.acknowledgedBy ? ('✓ ' + r.acknowledgedBy + (r.acknowledgedAt ? ' (' + r.acknowledgedAt + ')' : '')) : '';
    return [
      sc(r.storeId + (r.storeName ? ' - ' + r.storeName : '')), sc(r.area), sc(r.date), sc(r.reportedBy),
      sc(r.focusCategory), sc(r.issueCategory), sc(r.issueDescription),
      { v: r.priority || '', t: 's', s: prStyle },
      sc(r.reportedTo), sc(r.dateReported), sc(r.feedback), sc(r.resolutionDetails), sc(r.dateResolved),
      hasDays ? { v: days, t: 'n', s: daysStyle } : { v: '', t: 's', s: daysStyle },
      sc(r.remarks),
      { v: r.isOpen ? 'Open' : 'Resolved', t: 's', s: r.isOpen ? XS.OPEN : XS.RESOLVED },
      { v: ackText, t: 's', s: r.acknowledgedBy ? XS.ACK : XS.DEFAULT },
    ];
  });

  var bytes = buildXlsx('Issue Log', headers, data, widths);
  var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'Issue_Log_' + (DATA.today || 'export') + '.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
  toast('Exported ' + rows.length + ' issue' + (rows.length === 1 ? '' : 's') + ' to Excel');
}

$('exportXlsx').addEventListener('click', exportIssueLog);

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

/* ============================ EXECUTIVE SUMMARY ============================
 * A template-generated narrative: the app composes the prose itself from the
 * decline aggregates plus a keyword classifier that buckets each column-J
 * justification into a factor theme. No AI, always renders, deterministic.
 * ======================================================================= */

// Keyword -> factor theme. First matching theme wins; order matters.
var FACTOR_THEMES = [
  { name: 'Supply / Delivery', keys: ['deliver', 'supply', 'undeliver', 'stockout', 'stock out',
    'out of stock', 'no stock', 'allocat', 'shortage', 'short deliver', 'backorder', 'unavailab', 'late deliver'] },
  { name: 'Pricing / Competition', keys: ['price', 'pricing', 'competitor', 'competition', 'cheaper',
    'undercut', 'promo', 'expensive', 'markdown', 'srp'] },
  { name: 'Quality / Spoilage', keys: ['quality', 'breakage', 'spoil', 'damage', 'temperature',
    'expired', 'expiry', 'reject', 'freshness', 'rotten', 'near expiry'] },
  { name: 'Store Operations', keys: ['staff', 'manpower', 'ordering', 'system', 'downtime', 'renovation',
    'closure', 'closed', 'display', 'pos', 'equipment', 'freezer', 'chiller', 'aircon'] },
  { name: 'Demand / Seasonality', keys: ['demand', 'season', 'weather', 'holiday', 'slow', 'traffic',
    'footfall', 'rainy', 'flood', 'low sales', 'off-peak'] },
];

function classifyFactor(text) {
  var t = String(text || '').toLowerCase();
  for (var i = 0; i < FACTOR_THEMES.length; i++) {
    var keys = FACTOR_THEMES[i].keys;
    for (var k = 0; k < keys.length; k++) {
      if (t.indexOf(keys[k]) !== -1) return FACTOR_THEMES[i].name;
    }
  }
  return 'Other';
}

function esScope(){
  var area = $('esArea').value;
  var from = $('esFrom').value === '' ? -1 : parseInt($('esFrom').value, 10);
  var to = $('esTo').value === '' ? 99 : parseInt($('esTo').value, 10);
  return DATA.sales.filter(function(r){
    if (area && r.area !== area) return false;
    if (r.monthIdx < from || r.monthIdx > to) return false;
    return true;
  });
}

function esPeriodLabel(rows){
  var idxs = uniq(rows.map(function(r){ return r.monthIdx; })).sort(function(a, b){ return a - b; });
  if (!idxs.length) return '—';
  return idxs.length === 1 ? MONTHS[idxs[0]] : MONTHS[idxs[0]] + '–' + MONTHS[idxs[idxs.length - 1]];
}
function esAreaLabel(){ return $('esArea').value || 'all CAMANAVA areas'; }

function esCategoryAgg(rows){
  var map = {};
  rows.forEach(function(r){
    if (!map[r.sub]) map[r.sub] = { sub: r.sub, sales: 0, ly: 0, rows: [] };
    map[r.sub].sales += r.sales; map[r.sub].ly += r.salesLy; map[r.sub].rows.push(r);
  });
  var out = [];
  for (var k in map) if (map.hasOwnProperty(k)) {
    var g = map[k];
    g.diff = g.sales - g.ly;
    g.pct = g.ly === 0 ? null : (g.diff / g.ly) * 100;
    out.push(g);
  }
  return out;
}

// Classify every declining row's justification; count themes; keep quotes.
function factorBreakdown(declRows){
  var counts = {}, explained = 0, unexplained = 0;
  declRows.forEach(function(r){
    if (r.justification) {
      explained++;
      var th = classifyFactor(r.justification);
      counts[th] = (counts[th] || 0) + 1;
    } else { unexplained++; }
  });
  var themes = [];
  for (var k in counts) if (counts.hasOwnProperty(k)) themes.push({ name: k, n: counts[k] });
  themes.sort(function(a, b){ return b.n - a.n; });
  return { counts: counts, themes: themes, explained: explained, unexplained: unexplained };
}

// Most material justified decline (largest peso drop) as the representative note.
function repQuote(declRows){
  var withJ = declRows.filter(function(r){ return r.justification; });
  if (!withJ.length) return null;
  withJ.sort(function(a, b){ return a.diffVal - b.diffVal; });
  return withJ[0];
}

function esTotals(rows){
  var s = 0, l = 0;
  rows.forEach(function(r){ s += r.sales; l += r.salesLy; });
  return { sales: s, ly: l, diff: s - l, pct: l === 0 ? null : ((s - l) / l) * 100 };
}

function renderExecKpis(rows){
  var t = esTotals(rows);
  var storeCount = uniq(rows.map(function(r){ return r.storeId; })).length;
  var html = '';
  html += kpi('Reporting Period', esPeriodLabel(rows), storeCount + ' store(s), ' + esAreaLabel(), '');
  html += kpi('Sales This Year', fmt(t.sales), 'vs ' + fmt(t.ly) + ' LY', '');
  html += kpi('Growth vs LY', fmtPct(t.pct), fmt(t.diff) + ' variance', cls(t.diff));
  $('esKpis').innerHTML = html;
  $('esTitle').textContent = 'Executive Summary — ' + esPeriodLabel(rows) + ', ' + esAreaLabel();
}

function renderExecOverall(rows){
  if (!rows.length) { $('esOverall').innerHTML = '<p class="narr-empty">No sales data in this selection.</p>'; return; }
  var t = esTotals(rows);
  var cats = esCategoryAgg(rows);
  var declining = cats.filter(function(g){ return g.diff < 0; }).sort(function(a, b){ return a.diff - b.diff; });
  var gaining = cats.filter(function(g){ return g.diff > 0; }).sort(function(a, b){ return b.diff - a.diff; });
  var dir = t.diff < 0 ? 'a decline' : (t.diff > 0 ? 'growth' : 'flat performance');

  var p = '<p>Across <strong>' + esc(esAreaLabel()) + '</strong>, <strong>' + esc(esPeriodLabel(rows)) +
    '</strong> sales reached <strong>' + fmt(t.sales) + '</strong> against <strong>' + fmt(t.ly) +
    '</strong> last year — ' + dir + ' of <strong class="' + cls(t.diff) + '">' + fmtPct(t.pct) +
    '</strong> (' + fmt(t.diff) + '). ';
  if (declining.length) {
    p += '<strong>' + esc(declining[0].sub) + '</strong> was the largest drag at <span class="down">' +
      fmtPct(declining[0].pct) + '</span> (' + fmt(declining[0].diff) + ')';
    if (declining.length > 1) p += ', with ' + esc(declining[1].sub) + ' also below last year';
    p += '. ';
  }
  if (gaining.length) {
    p += '<strong>' + esc(gaining[0].sub) + '</strong> led the gains at <span class="up">' +
      fmtPct(gaining[0].pct) + '</span> (' + fmt(gaining[0].diff) + '). ';
  }
  var declRows = rows.filter(function(r){ return r.diffVal < 0; });
  var fb = factorBreakdown(declRows);
  if (fb.themes.length) {
    p += 'The recurring theme behind the declines is <strong>' + esc(fb.themes[0].name) + '</strong>.';
  }
  p += '</p>';
  $('esOverall').innerHTML = p;
}

function renderExecDeclines(rows){
  var cats = esCategoryAgg(rows).filter(function(g){ return g.diff < 0; });
  cats.sort(function(a, b){ return a.diff - b.diff; });
  if (!cats.length) {
    $('esDeclines').innerHTML = '<p class="narr-empty">No declining categories in this selection — every ' +
      'Focus 5 sub-dept is at or above last year.</p>';
    return;
  }
  var html = '';
  cats.forEach(function(g){
    var decl = g.rows.filter(function(r){ return r.diffVal < 0; });
    var fb = factorBreakdown(decl);
    var storeCount = uniq(decl.map(function(r){ return r.storeId; })).length;
    var p = '<p><strong>' + esc(g.sub) + '</strong> declined <strong class="down">' + fmtPct(g.pct) +
      '</strong> (' + fmt(g.diff) + ') across ' + storeCount + ' store' + (storeCount === 1 ? '' : 's') + '. ';
    if (fb.themes.length) {
      var top = fb.themes[0];
      p += 'The most-cited factor was <strong>' + esc(top.name) + '</strong> (' + top.n + ' of ' +
        fb.explained + ' explained decline' + (fb.explained === 1 ? '' : 's') + ')';
      if (fb.themes.length > 1) p += ', followed by ' + esc(fb.themes[1].name);
      p += '. ';
    } else {
      p += 'No justifications were recorded for these declines. ';
    }
    var q = repQuote(decl);
    if (q) p += 'Representative note — <em>' + esc(q.storeName) + ', ' + esc(q.month) + '</em>: “' +
      esc(q.justification) + '”. ';
    if (fb.unexplained) p += '<span class="down">' + (fb.unexplained === 1
      ? '1 of these declines has' : fb.unexplained + ' of these declines have') + ' no justification.</span>';
    p += '</p>';
    html += p;
  });
  $('esDeclines').innerHTML = html;
}

function renderExecFactors(rows){
  var decl = rows.filter(function(r){ return r.diffVal < 0; });
  var fb = factorBreakdown(decl);
  var list = fb.themes.slice();
  // Include unexplained as its own bucket so the total ties out.
  if (fb.unexplained) list.push({ name: 'No justification', n: fb.unexplained, unexplained: true });

  if (!list.length) {
    $('esFactorChart').innerHTML = '<div class="empty">No declines to attribute in this selection.</div>';
    $('esFactorList').innerHTML = '<p class="narr-empty">Nothing to break down.</p>';
    return;
  }
  var total = 0; list.forEach(function(g){ total += g.n; });
  var max = 1; list.forEach(function(g){ max = Math.max(max, g.n); });

  var rowH = 30, T = 10, B = 12, L = 160, R = 56;
  var W = 620, pw = W - L - R, H = T + B + rowH * list.length;
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">';
  for (var i = 0; i < list.length; i++) {
    var g = list[i];
    var y = T + rowH * i + 5;
    var len = (g.n / max) * pw;
    var color = g.unexplained ? '#54687f' : '#3ea6ff';
    svg += '<text x="' + (L - 10) + '" y="' + (y + 14) + '" fill="#e8eef5" font-size="12" ' +
      'text-anchor="end">' + esc(g.name) + '</text>';
    svg += '<rect x="' + L + '" y="' + y + '" width="' + Math.max(len, 1) + '" height="19" rx="3" fill="' +
      color + '"><title>' + esc(g.name) + ': ' + g.n + '</title></rect>';
    svg += '<text x="' + (L + len + 8) + '" y="' + (y + 14) + '" fill="#93a4b8" font-size="11">' + g.n + '</text>';
  }
  svg += '</svg>';
  $('esFactorChart').innerHTML = svg;

  var html = '';
  list.forEach(function(g){
    var pct = total ? Math.round((g.n / total) * 100) : 0;
    html += '<div class="factor-row"><span' + (g.unexplained ? ' class="down"' : '') + '>' + esc(g.name) +
      '</span><span class="cnt">' + g.n + ' &middot; ' + pct + '%</span></div>';
  });
  $('esFactorList').innerHTML = html;
}

function renderExecBright(rows){
  var cats = esCategoryAgg(rows).filter(function(g){ return g.diff > 0; }).sort(function(a, b){ return b.diff - a.diff; });
  // Top gaining store overall.
  var byStore = {};
  rows.forEach(function(r){
    if (!byStore[r.storeId]) byStore[r.storeId] = { name: r.storeName, id: r.storeId, sales: 0, ly: 0 };
    byStore[r.storeId].sales += r.sales; byStore[r.storeId].ly += r.salesLy;
  });
  var stores = [];
  for (var k in byStore) if (byStore.hasOwnProperty(k)) {
    var s = byStore[k]; s.diff = s.sales - s.ly; s.pct = s.ly === 0 ? null : (s.diff / s.ly) * 100;
    stores.push(s);
  }
  stores.sort(function(a, b){ return b.diff - a.diff; });

  if (!cats.length && (!stores.length || stores[0].diff <= 0)) {
    $('esBright').innerHTML = '<p class="narr-empty">No categories or stores are ahead of last year in this selection.</p>';
    return;
  }
  var p = '<p>';
  if (cats.length) {
    p += '<strong>' + esc(cats[0].sub) + '</strong> grew <strong class="up">' + fmtPct(cats[0].pct) +
      '</strong> (' + fmt(cats[0].diff) + ')';
    if (cats.length > 1) p += ', and <strong>' + esc(cats[1].sub) + '</strong> added ' + fmtPct(cats[1].pct);
    p += '. ';
  }
  if (stores.length && stores[0].diff > 0) {
    p += 'The strongest store was <strong>' + esc(stores[0].id + ' - ' + stores[0].name) +
      '</strong> at <span class="up">' + fmtPct(stores[0].pct) + '</span> (' + fmt(stores[0].diff) + ').';
  }
  p += '</p>';
  $('esBright').innerHTML = p;
}

function renderExecWatch(rows){
  var decl = rows.filter(function(r){ return r.diffVal < 0; }).slice();
  decl.sort(function(a, b){ return a.diffVal - b.diffVal; });
  var top = decl.slice(0, 8);

  var html = '<thead><tr><th>Store</th><th>Category</th><th>Month</th><th class="n">Diff Val</th>' +
    '<th class="n">Diff %</th><th>Likely Factor</th></tr></thead><tbody>';
  if (!top.length) {
    html += '<tr><td colspan="6" class="empty">No declines to action in this selection.</td></tr>';
  }
  top.forEach(function(r){
    var factor = r.justification ? classifyFactor(r.justification) : 'Unexplained';
    html += '<tr>' +
      '<td>' + esc(r.storeId + ' - ' + r.storeName) + '</td>' +
      '<td>' + esc(r.sub) + '</td>' +
      '<td>' + esc(r.month) + '</td>' +
      '<td class="n down">' + fmt(r.diffVal) + '</td>' +
      '<td class="n down">' + fmtPct(r.diffPct) + '</td>' +
      '<td' + (r.justification ? '' : ' class="down"') + '>' + esc(factor) + '</td>' +
      '</tr>';
  });
  html += '</tbody>';
  $('esWatchTable').innerHTML = html;
  makeSortable($('esWatchTable'));

  var unexplained = decl.filter(function(r){ return !r.justification; });
  var unexplainedVal = 0; unexplained.forEach(function(r){ unexplainedVal += r.diffVal; });
  var note = '';
  if (unexplained.length) {
    note = '<p><span class="down"><strong>' + fmt(Math.abs(unexplainedVal)) + '</strong> in declines across ' +
      unexplained.length + ' line' + (unexplained.length === 1 ? '' : 's') + ' ' +
      (unexplained.length === 1 ? 'has' : 'have') + ' no justification</span> — ' +
      'follow up with the stores via Compliance Watch so the cause is captured.</p>';
  } else if (decl.length) {
    note = '<p class="up">Every decline in this selection has a recorded justification.</p>';
  }
  $('esWatchNote').innerHTML = note;
}

function renderExec(){
  if (!DATA.sales) return;
  var rows = esScope();
  renderExecKpis(rows);
  renderExecOverall(rows);
  renderExecDeclines(rows);
  renderExecFactors(rows);
  renderExecBright(rows);
  renderExecWatch(rows);
}

function buildExecFilters(){
  var areas = uniq(DATA.stores.map(function(s){ return s.area; })).sort();
  fillSelect($('esArea'), areas.map(function(a){ return { v: a, t: a }; }), 'All areas');
  var idxs = monthsPresent();
  var mopts = idxs.map(function(i){ return { v: String(i), t: MONTHS[i] }; });
  fillSelect($('esFrom'), mopts, '');
  fillSelect($('esTo'), mopts, '');
  if (idxs.length) { $('esFrom').value = String(idxs[0]); $('esTo').value = String(idxs[idxs.length - 1]); }
}

['esArea', 'esFrom', 'esTo'].forEach(function(id){ $(id).addEventListener('change', renderExec); });
$('esReset').addEventListener('click', function(){
  $('esArea').value = '';
  var idxs = monthsPresent();
  if (idxs.length) { $('esFrom').value = String(idxs[0]); $('esTo').value = String(idxs[idxs.length - 1]); }
  renderExec();
});

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
    buildExecFilters();
    renderSales();
    renderExec();
    $('syncNote').textContent = 'Synced ' + new Date().toLocaleTimeString();
    return loadIssues(fresh);
  }).catch(function(e){
    $('syncNote').textContent = 'Load failed';
    toast(e.message, true);
  });
}

$('refreshBtn').addEventListener('click', function(){ loadAll(true); });
restoreAM();      // set AM_SESSION from localStorage before issues render
loadAll(false);

})();
