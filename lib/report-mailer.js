/**
 * lib/report-mailer.js — branded payroll-report email + attachments
 * ===========================================================================
 * Builds the three artifacts SaniXperts sends alongside a payroll period:
 *   1. One SpreadsheetML (.xls) workbook per department (dependency-free,
 *      same technique as lib/paysheet.js — Excel opens it natively).
 *   2. A single self-contained, searchable HTML "punch card viewer" —
 *      every clock-in/out for the period, filterable by employee, no
 *      server round-trip (all data is inlined as JSON in the file).
 *   3. The branded HTML email body itself (navy header, pay-period banner,
 *      per-department summary table, attachments list, viewer callout) —
 *      matching SaniXperts' existing payroll-document identity (#1F3350
 *      navy / #F3C94F gold, the same palette lib/paysheet.js uses).
 *
 * Pure functions, no I/O. Callers pass already-loaded data.
 */
'use strict';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function xmlEsc(s) { return esc(s); }
function fmtHM(min) {
  if (min == null || !isFinite(min)) min = 0;
  min = Math.round(min);
  if (min < 0) min = 0;
  return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0');
}
function fmtDec(min) { return (Math.max(0, min || 0) / 60).toFixed(1); }
function fmtDateLong(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
function fmtDateShort(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// --- 1. Department workbook (SpreadsheetML 2003, .xls) ---------------------

function cell(styleId, type, value) {
  return '<Cell' + (styleId ? ' ss:StyleID="' + styleId + '"' : '') + '><Data ss:Type="' + type + '">' + value + '</Data></Cell>';
}
function emptyCell(styleId) { return '<Cell' + (styleId ? ' ss:StyleID="' + styleId + '"' : '') + '/>'; }

/**
 * buildDeptWorkbookXml(deptName, periodStartISO, periodEndISO, rows) -> xml string
 * rows: [{pid, person, regularMin, overtimeMin, totalNetMin}], pre-sorted.
 */
function buildDeptWorkbookXml(deptName, periodStartISO, periodEndISO, rows) {
  const head =
    '<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Styles>' +
    '<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="10"/></Style>' +
    '<Style ss:ID="title"><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1F3350" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/></Style>' +
    '<Style ss:ID="titleR"><Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Italic="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1F3350" ss:Pattern="Solid"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style>' +
    '<Style ss:ID="colhead"><Font ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#2A4568" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>' +
    '<Style ss:ID="name"><Font ss:Size="10" ss:Bold="1"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E7E2"/></Borders></Style>' +
    '<Style ss:ID="txt"><Alignment ss:Horizontal="Left" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E7E2"/></Borders></Style>' +
    '<Style ss:ID="num"><NumberFormat ss:Format="0.00"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E7E2"/></Borders></Style>' +
    '<Style ss:ID="totlbl"><Font ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1F3350" ss:Pattern="Solid"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style>' +
    '<Style ss:ID="totnum"><NumberFormat ss:Format="0.00"/><Font ss:Bold="1"/><Interior ss:Color="#F3C94F" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>' +
    '</Styles>';

  const rowsXml = [];
  rowsXml.push(
    '<Row ss:Height="24">' + cell('title', 'String', xmlEsc(deptName + ' — Employee Hours')) +
    emptyCell('title') + emptyCell('title') +
    cell('titleR', 'String', xmlEsc('Pay Period: ' + fmtDateLong(periodStartISO) + ' – ' + fmtDateLong(periodEndISO))) + emptyCell('title') + '</Row>'
  );
  rowsXml.push('<Row/>');
  rowsXml.push(
    '<Row ss:Height="18">' +
    cell('colhead', 'String', 'Person ID') + cell('colhead', 'String', 'Employee Name') +
    cell('colhead', 'String', 'Regular (hrs)') + cell('colhead', 'String', 'Overtime (hrs)') + cell('colhead', 'String', 'Total (hrs)') +
    '</Row>'
  );

  let totalReg = 0, totalOt = 0, totalNet = 0;
  for (const r of rows) {
    totalReg += r.regularMin || 0; totalOt += r.overtimeMin || 0; totalNet += r.totalNetMin || 0;
    rowsXml.push(
      '<Row>' +
      cell('txt', 'String', xmlEsc(r.pid)) + cell('name', 'String', xmlEsc(r.person)) +
      cell('num', 'Number', fmtDec(r.regularMin)) + cell('num', 'Number', fmtDec(r.overtimeMin)) + cell('num', 'Number', fmtDec(r.totalNetMin)) +
      '</Row>'
    );
  }
  rowsXml.push(
    '<Row>' + cell('totlbl', 'String', 'TOTAL') + emptyCell('totlbl') +
    cell('totnum', 'Number', fmtDec(totalReg)) + cell('totnum', 'Number', fmtDec(totalOt)) + cell('totnum', 'Number', fmtDec(totalNet)) +
    '</Row>'
  );

  const sheetName = String(deptName).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1';
  const sheet =
    '<Worksheet ss:Name="' + xmlEsc(sheetName) + '"><Table>' +
    '<Column ss:Width="90"/><Column ss:Width="200"/><Column ss:Width="90"/><Column ss:Width="90"/><Column ss:Width="90"/>' +
    rowsXml.join('') + '</Table></Worksheet>';

  return head + sheet + '</Workbook>';
}

function workbookFilename(deptName, periodStartISO, periodEndISO) {
  const label = fmtDateShort(periodStartISO).replace(' ', '_') + '-' + fmtDateShort(periodEndISO).replace(' ', '_') + '_' + periodEndISO.slice(0, 4);
  return 'SaniClock_Payroll_' + String(deptName).replace(/[^a-z0-9]+/gi, '_') + '_' + label + '.xls';
}

// --- 2. Punch card viewer (self-contained searchable HTML) ------------------

/**
 * buildPunchCardHtml(periodStartISO, periodEndISO, facilityName, punches) -> html string
 * punches: [{pid, person, date (MM/DD/YYYY), clockIn, clockOut, category, netMin, missingOut}]
 */
function buildPunchCardHtml(periodStartISO, periodEndISO, facilityName, punches) {
  const byPid = new Map();
  for (const p of punches) {
    if (!p.pid) continue;
    if (!byPid.has(p.pid)) byPid.set(p.pid, { pid: p.pid, person: p.person || p.pid, rows: [] });
    byPid.get(p.pid).rows.push({
      date: p.date || '', shift: p.category || '', in: p.clockIn || '—', out: p.clockOut || (p.missingOut ? 'MISSING' : '—'),
      hrs: p.netMin != null ? fmtHM(p.netMin) : '—', miss: !!p.missingOut,
    });
  }
  const employees = Array.from(byPid.values()).sort((a, b) => String(a.person).localeCompare(String(b.person)));
  for (const e of employees) e.rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const dataJson = JSON.stringify(employees).replace(/</g, '\\u003c');

  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>' +
    '<title>Punch Card Viewer — ' + esc(facilityName) + '</title><style>' +
    ':root{--navy:#1f3350;--navy2:#2a4568;--gold:#f3c94f;--ink:#1a2233;--ink2:#5c6b85;--line:#e5e9f0;--bg:#f6f8fb}' +
    '*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}' +
    'header{background:var(--navy);color:#fff;padding:22px 28px}header h1{font-size:19px;font-weight:800;letter-spacing:-.2px}header p{font-size:13px;color:#b9c6dc;margin-top:4px}' +
    '.wrap{max-width:920px;margin:0 auto;padding:22px 20px 60px}' +
    '.search{position:relative;margin-bottom:18px}.search input{width:100%;height:46px;border:1px solid var(--line);border-radius:10px;padding:0 16px;font-size:15px;outline:none;background:#fff}' +
    '.search input:focus{border-color:var(--navy2);box-shadow:0 0 0 3px rgba(42,69,104,.12)}' +
    '.count{font-size:12.5px;color:var(--ink2);margin-bottom:14px}' +
    '.card{background:#fff;border:1px solid var(--line);border-radius:12px;margin-bottom:14px;overflow:hidden}' +
    '.card .h{display:flex;align-items:center;gap:10px;padding:12px 16px;background:#fafbfd;border-bottom:1px solid var(--line);cursor:pointer}' +
    '.card .h b{font-size:14.5px}.card .h span{font-size:12px;color:var(--ink2)}.card .h .grow{flex:1}' +
    '.card table{width:100%;border-collapse:collapse;font-size:13px}.card th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink2);padding:8px 16px;border-bottom:1px solid var(--line)}' +
    '.card td{padding:8px 16px;border-bottom:1px solid #f1f3f7}.card tr:last-child td{border-bottom:0}' +
    '.miss{color:#b3261e;font-weight:700}.rows{display:none}.card.open .rows{display:block}.chev{transition:transform .15s}.card.open .chev{transform:rotate(180deg)}' +
    '.empty{padding:40px;text-align:center;color:var(--ink2);font-size:14px}' +
    '</style></head><body>' +
    '<header><h1>Punch Card Viewer</h1><p>' + esc(facilityName) + ' &middot; Pay period ' + esc(fmtDateLong(periodStartISO)) + ' &ndash; ' + esc(fmtDateLong(periodEndISO)) + '</p></header>' +
    '<div class="wrap"><div class="search"><input id="q" type="search" placeholder="Search by employee name or ID…" autocomplete="off"/></div>' +
    '<div class="count" id="count"></div><div id="list"></div></div>' +
    '<script>var DATA=' + dataJson + ';\n' +
    'var list=document.getElementById("list"),q=document.getElementById("q"),count=document.getElementById("count");\n' +
    'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}\n' +
    'function render(filter){\n' +
    '  var f=(filter||"").toLowerCase();\n' +
    '  var rows=DATA.filter(function(e){return !f||e.person.toLowerCase().indexOf(f)>=0||e.pid.toLowerCase().indexOf(f)>=0;});\n' +
    '  count.textContent=rows.length+" of "+DATA.length+" employees";\n' +
    '  if(!rows.length){list.innerHTML=\'<div class="empty">No employees match &ldquo;\'+esc(filter)+\'&rdquo;</div>\';return;}\n' +
    '  list.innerHTML=rows.map(function(e,i){\n' +
    '    var trs=e.rows.map(function(r){return "<tr><td>"+esc(r.date)+"</td><td>"+esc(r.shift)+"</td><td>"+esc(r.in)+"</td><td"+(r.miss?\' class="miss"\':"")+">"+esc(r.out)+"</td><td>"+esc(r.hrs)+"</td></tr>";}).join("");\n' +
    '    return \'<div class="card" data-i="\'+i+\'"><div class="h" onclick="this.parentElement.classList.toggle(\\\'open\\\')"><b>\'+esc(e.person)+\'</b><span>\'+esc(e.pid)+\' &middot; \'+e.rows.length+\' punches</span><span class="grow"></span><svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></div><div class="rows"><table><thead><tr><th>Date</th><th>Shift</th><th>Clock In</th><th>Clock Out</th><th>Hours</th></tr></thead><tbody>\'+trs+\'</tbody></table></div></div>\';\n' +
    '  }).join("");\n' +
    '}\n' +
    'q.addEventListener("input",function(){render(q.value);});\n' +
    'render("");\n' +
    '</script></body></html>';
}

// --- 3. Branded report email --------------------------------------------

/**
 * buildReportEmailHtml(opts) -> {html, text}
 * opts: {facilityName, periodStartISO, periodEndISO, deptRows: [{name,employees,worked,totalMin}],
 *        totals: {employees,worked,totalMin}, attachments: [{name,desc}], viewerName}
 */
function buildReportEmailHtml(opts) {
  const o = opts || {};
  const deptRowsHtml = (o.deptRows || []).map((d, i) =>
    '<tr' + (i % 2 ? ' style="background:#fafbfd"' : '') + '>' +
    '<td style="padding:12px 16px;font-size:14px;color:#1a2233;border-bottom:1px solid #eef1f6"><span style="display:inline-block;width:3px;height:14px;background:#2a4568;margin-right:9px;vertical-align:-2px;border-radius:2px"></span>' + esc(d.name) + '</td>' +
    '<td style="padding:12px 16px;font-size:14px;color:#3d4a63;text-align:right;border-bottom:1px solid #eef1f6">' + d.employees + '</td>' +
    '<td style="padding:12px 16px;font-size:14px;color:#3d4a63;text-align:right;border-bottom:1px solid #eef1f6">' + d.worked + '</td>' +
    '<td style="padding:12px 16px;font-size:14px;font-weight:700;color:#1a2233;text-align:right;border-bottom:1px solid #eef1f6">' + fmtDec(d.totalMin) + '</td>' +
    '</tr>'
  ).join('');

  const t = o.totals || { employees: 0, worked: 0, totalMin: 0 };
  const attachRows = (o.attachments || []).map((a) =>
    '<tr><td style="padding:10px 14px;border-bottom:1px solid #eef1f6"><span style="display:inline-block;width:3px;height:26px;background:' + (a.color || '#2a4568') + ';margin-right:11px;vertical-align:-8px;border-radius:2px"></span>' +
    '<span style="font-size:13.5px;color:#1a2233">' + esc(a.name) + '</span></td></tr>'
  ).join('');

  const html =
    '<div style="background:#eef1f6;padding:28px 14px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">' +
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 24px rgba(20,30,50,.08)">' +
    '<div style="background:#1f3350;padding:26px 28px">' +
    '<div style="font-size:19px;font-weight:800;color:#ffffff;letter-spacing:-.2px">' + esc(o.facilityName || 'SaniClock') + ' Payroll — Employee Hours</div>' +
    '<div style="font-size:12.5px;color:#a9b8d1;margin-top:4px">SaniXperts Services Ltd.</div>' +
    '</div>' +
    '<div style="background:#2a4568;padding:11px 28px;display:flex">' +
    '<span style="font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8fa3c4">Pay Period</span>' +
    '<span style="font-size:12.5px;font-weight:700;color:#f3c94f;margin-left:10px">' + esc(fmtDateLong(o.periodStartISO)) + ' – ' + esc(fmtDateLong(o.periodEndISO)) + '</span></div>' +
    '<div style="padding:26px 28px 8px">' +
    '<p style="font-size:14px;color:#1a2233;line-height:1.6;margin:0 0 6px">Hi Team,</p>' +
    '<p style="font-size:14px;color:#3d4a63;line-height:1.6;margin:0">Please find the payroll hours for the period above. Figures were generated directly from live SaniClock attendance data at the time of sending.</p>' +
    '</div>' +
    '<div style="padding:6px 28px 22px"><table style="width:100%;border-collapse:collapse">' +
    '<thead><tr>' +
    '<th style="padding:9px 16px;text-align:left;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#ffffff;background:#1f3350">Department</th>' +
    '<th style="padding:9px 16px;text-align:right;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#ffffff;background:#1f3350">Employees</th>' +
    '<th style="padding:9px 16px;text-align:right;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#ffffff;background:#1f3350">Worked</th>' +
    '<th style="padding:9px 16px;text-align:right;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#ffffff;background:#1f3350">Total Hours</th>' +
    '</tr></thead><tbody>' + deptRowsHtml +
    '<tr style="background:#fdf6e3">' +
    '<td style="padding:12px 16px;font-size:14px;font-weight:800;color:#7a5b06">Total</td>' +
    '<td style="padding:12px 16px;font-size:14px;font-weight:800;color:#7a5b06;text-align:right">' + t.employees + '</td>' +
    '<td style="padding:12px 16px;font-size:14px;font-weight:800;color:#7a5b06;text-align:right">' + t.worked + '</td>' +
    '<td style="padding:12px 16px;font-size:14px;font-weight:800;color:#7a5b06;text-align:right">' + fmtDec(t.totalMin) + '</td>' +
    '</tr></tbody></table></div>' +
    '<div style="padding:0 28px 8px"><div style="font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8a94a6;margin-bottom:8px">Attachments</div>' +
    '<table style="width:100%;border-collapse:collapse;background:#fafbfd;border-radius:8px;overflow:hidden">' + attachRows + '</table></div>' +
    '<div style="margin:16px 28px 22px;padding:14px 16px;background:#eef4ee;border-radius:10px;font-size:13px;color:#2f4a34;line-height:1.55">' +
    '<b>Punch Card Viewer</b> — open the HTML attachment in any browser to search an employee by name and see every clock in / clock out for this pay period, including miss punches and the payroll hours calculated from them.</div>' +
    '<div style="padding:0 28px 28px"><p style="font-size:14px;color:#3d4a63;line-height:1.6;margin:0">Please review and process at your convenience.</p>' +
    '<p style="font-size:14px;color:#3d4a63;line-height:1.6;margin:16px 0 0">Thanks,<br/>SaniXperts Team</p></div>' +
    '<div style="padding:16px 28px;border-top:1px solid #eef1f6;font-size:11.5px;color:#9aa5b8">Sent automatically by SaniClock &middot; saniclock.anubhavflow.com</div>' +
    '</div></div>';

  const text = (o.facilityName || 'SaniClock') + ' Payroll — ' + fmtDateLong(o.periodStartISO) + ' to ' + fmtDateLong(o.periodEndISO) +
    '\n\n' + (o.deptRows || []).map((d) => d.name + ': ' + d.employees + ' employees, ' + d.worked + ' worked, ' + fmtDec(d.totalMin) + ' total hours').join('\n') +
    '\n\nTotal: ' + t.employees + ' employees, ' + t.worked + ' worked, ' + fmtDec(t.totalMin) + ' hours\n\nSee attachments for the full breakdown.\n\nSaniXperts Team';

  return { html, text };
}

module.exports = { buildDeptWorkbookXml, workbookFilename, buildPunchCardHtml, buildReportEmailHtml, fmtHM, fmtDec, fmtDateLong, fmtDateShort };
