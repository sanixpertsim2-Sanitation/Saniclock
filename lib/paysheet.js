/**
 * lib/paysheet.js — bi-weekly employer attendance/payroll sheet builder
 * ===========================================================================
 * Replicates Sanixperts' "EMPLOYEE ATTENDANCE SHEET" Excel workbook (G&G IM2 +
 * G&G Clark tabs) directly from enriched punch data, applying the SAME business
 * rules as their Office Script "Process_Timecard v6.5.5" (the Power Automate
 * step that used to hand-populate the workbook from the NGTeco email CSV).
 *
 * Pay period: BI-WEEKLY, Monday -> Sunday, anchored Mon 2026-06-29 (period 1 =
 * 2026-06-29 .. 2026-07-12). Confirmed against the employer's live payroll
 * sheets 2026-07-08.
 *
 * Business rules (from Process_Timecard v6.5.5; overridable via the
 * paysheet-rules.json config passed into buildModel):
 *   - NO_BREAK employees: no 30-min break deduction.
 *   - Clark-forced employees: always the Clark sheet, whatever the shift name.
 *   - Dual-location: named CSV employees' hours ADD onto a target IM2 row.
 *   - Exempt employees: machine hours never written (row shows dashes).
 *   - Tiered rounding: minutes<=downMax round down, <=halfMax -> .5, else up
 *     (default 19/45; per-employee overrides e.g. Delna Cyriac 9/39).
 *   - snapClockIn employees: clock-in snapped to shift start inside windows
 *     06:20-07:30 / 14:20-15:30 / 22:20-23:30 (first 15 min past the hour snap
 *     down to :00, rest snap to :30).
 *   - earlyOut employees: clock-out 14:20-14:59 -> 15:00, then soft-snap to
 *     shift end (up to +60 min: <20 over -> end, else end+30).
 *   - Banding: shift text startsWith aft/night/day (day+"after" -> Afternoon),
 *     else from clock-in time (06:00-10:59 Day, 11:00-18:59 Afternoon, else
 *     Night). Sheets sort Day -> Afternoon -> Night, CT renumbered.
 *   - Name corrections applied for matching AND display.
 *
 * Machine data is the only source of truth: the workbook is fully regenerated
 * from punches each time, so the v6.5 "anti-tamper verification reset" is
 * inherent. Exact-minute figures remain the payroll source of truth
 * (lib/payroll.js CSV); this sheet is the employer's display convention.
 *
 * Pure functions, NO I/O / HTTP / DOM. Dependency-free. Output is a
 * SpreadsheetML 2003 XML workbook string (.xls).
 */
'use strict';

const PERIOD_ANCHOR_ISO = '2026-06-29'; // Monday, period 1 start
const PERIOD_DAYS = 14;

// Defaults mirror Process_Timecard v6.5.5 exactly; paysheet-rules.json overrides.
const DEFAULT_RULES = {
  noBreak: [
    'adarsh kandiyil', 'arjan singh', 'prabhdeep singh', 'paramjit singh',
    'karanpreet singh', 'delna cyriac', 'sahil attri', 'nardeen nissan',
    'jashandeep singh',
  ],
  clarkEmployees: ['delna cyriac', 'sahil attri', 'nardeen nissan'],
  dualLocation: { 'lashodharn t': 'Lashotharan Subramaniam' },
  exempt: ['adarsh kandiyil'],
  nameCorrections: { 'gurpratap': 'gurpartap', 'japhther': 'japhtar', 'antwi atta': 'attawa' },
  rounding: {
    default: { downMax: 19, halfMax: 45 },
    perEmployee: { 'delna cyriac': { downMax: 9, halfMax: 39 } },
  },
  snapClockIn: ['surinder singh'],
  earlyOut: ['khushdeep singh #1'],
};

// --- date helpers (UTC day-index math; date-only, no TZ concerns) -----------

function isoToDayIndex(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return null;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

function dayIndexToISO(idx) {
  const dt = new Date(idx * 86400000);
  const p2 = n => (n < 10 ? '0' : '') + n;
  return dt.getUTCFullYear() + '-' + p2(dt.getUTCMonth() + 1) + '-' + p2(dt.getUTCDate());
}

/** "MM/DD/YYYY" -> ISO | null */
function mdyToISO(mdy) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(mdy || '').trim());
  if (!m) return null;
  const p2 = n => (n < 10 ? '0' : '') + n;
  return m[3] + '-' + p2(+m[1]) + '-' + p2(+m[2]);
}

/**
 * periodFor(iso) -> {start, end} — the bi-weekly Mon–Sun period containing iso.
 * Anchored at PERIOD_ANCHOR_ISO; works for dates before the anchor too.
 */
function periodFor(iso) {
  const di = isoToDayIndex(iso);
  const anchor = isoToDayIndex(PERIOD_ANCHOR_ISO);
  if (di === null) return null;
  const off = ((di - anchor) % PERIOD_DAYS + PERIOD_DAYS) % PERIOD_DAYS;
  const start = di - off;
  return { start: dayIndexToISO(start), end: dayIndexToISO(start + PERIOD_DAYS - 1) };
}

// --- name handling (mirrors Office Script norm/normName/corrections) --------

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().trim().replace(/\s+/g, ' ');
}
function normName(s) {
  return norm(s).replace(/\s*\(pt\)\s*/i, '').replace(/\s+pt$/i, '').trim();
}
function applyCorrections(nameLower, corrections) {
  let out = nameLower;
  for (const wrong in corrections) {
    out = out.replace(new RegExp('\\b' + wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), corrections[wrong]);
  }
  return out;
}
function toTitleCase(s) {
  return String(s).replace(/\b\w+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// --- hour computation (mirrors Office Script pipeline) -----------------------

/**
 * roundTiered(netMin, tier) -> hours in 0.5 steps per the employer's rule:
 * leftover minutes <= tier.downMax -> round down; <= tier.halfMax -> +0.5; else +1.
 * (default 19/45; Delna Cyriac 9/39)
 */
function roundTiered(netMin, tier) {
  if (netMin == null || !isFinite(netMin) || netMin <= 0) return 0;
  const t = tier || DEFAULT_RULES.rounding.default;
  const w = Math.floor(netMin / 60);
  const m = netMin - w * 60;
  if (m <= t.downMax) return w;
  if (m <= t.halfMax) return w + 0.5;
  return w + 1;
}

/** snapClockIn windows: 380-450 -> 420/450, 860-930 -> 900/930, 1340-1410 -> 1380/1410 */
function snapClockInMin(ciMin) {
  if (ciMin >= 380 && ciMin <= 450) return ciMin <= 434 ? 420 : 450;   // 7:00 / 7:30
  if (ciMin >= 860 && ciMin <= 930) return ciMin <= 914 ? 900 : 930;   // 15:00 / 15:30
  if (ciMin >= 1340 && ciMin <= 1410) return ciMin <= 1394 ? 1380 : 1410; // 23:00 / 23:30
  return ciMin;
}

/** earlyOut rule: out 14:20-14:59 -> 15:00 (values are minutes, possibly >1440 after overnight wrap) */
function earlyClockOutMin(coMin) {
  if (coMin >= 860 && coMin <= 899) return 900;
  return coMin;
}

/** soft snap to shift end: Day->900, Afternoon->1380, Night->420; within [ref, ref+60] */
function softSnapClockOutMin(coMin, band) {
  let ref = -1;
  if (band === 'Day') ref = 900;
  else if (band === 'Afternoon') ref = 1380;
  else if (band === 'Night') ref = 420;
  if (ref < 0) return coMin;
  const diff = coMin - ref;
  if (diff < 0 || diff > 60) return coMin;
  return diff < 20 ? ref : ref + 30;
}

/** band from shift text per Office Script (startsWith), '' when no signal */
function bandFromShiftText(shift) {
  const s = norm(shift);
  if (!s) return '';
  if (s.startsWith('aft')) return 'Afternoon';
  if (s.startsWith('night')) return 'Night';
  if (s.startsWith('day')) return (s.includes('after') || s.includes('aft')) ? 'Afternoon' : 'Day';
  return '';
}

/** band from clock-in minute: 06:00-10:59 Day, 11:00-18:59 Afternoon, else Night */
function bandFromClockIn(ciMin) {
  if (ciMin == null || !isFinite(ciMin)) return 'Day';
  if (ciMin >= 360 && ciMin <= 659) return 'Day';
  if (ciMin >= 660 && ciMin <= 1139) return 'Afternoon';
  return 'Night';
}

function bandOf(shift, ciMin) {
  return bandFromShiftText(shift) || bandFromClockIn(ciMin);
}

/** Clark location: shift name contains 'clark' OR employee is Clark-forced */
function locationOf(shift, nameKey, rules) {
  const r = rules || DEFAULT_RULES;
  if (/clark/i.test(String(shift || ''))) return 'G&G Clark';
  if ((r.clarkEmployees || []).indexOf(nameKey) >= 0) return 'G&G Clark';
  return 'G&G IM2';
}

/**
 * sheetHours(e, rules) -> {hours, band} for one enriched record, applying the
 * employer's per-employee adjustments. Returns hours 0 when not computable.
 */
function sheetHours(e, rules) {
  const r = rules || DEFAULT_RULES;
  const nameKey = normName(e.person);
  let ci = (typeof e.clockInMin === 'number' && isFinite(e.clockInMin)) ? e.clockInMin : null;
  let co = (typeof e.clockOutMin === 'number' && isFinite(e.clockOutMin)) ? e.clockOutMin : null;
  if (ci === null || co === null) return { hours: 0, band: bandOf(e.shift, ci) };

  if ((r.snapClockIn || []).indexOf(nameKey) >= 0) ci = snapClockInMin(ci);
  if (co < ci) co += 1440; // overnight wrap (before earlyOut, same order as the Office Script)

  const band = bandOf(e.shift, ci >= 1440 ? ci - 1440 : ci);
  if ((r.earlyOut || []).indexOf(nameKey) >= 0) {
    co = earlyClockOutMin(co);
    co = softSnapClockOutMin(co, band);
  }

  const grossMin = co - ci;
  if (grossMin <= 0 || grossMin > 23 * 60) return { hours: 0, band };

  const isNB = (r.noBreak || []).indexOf(nameKey) >= 0;
  const breakMin = isNB ? 0
    : (typeof e.breakMin === 'number' && isFinite(e.breakMin) && e.breakMin > 0) ? e.breakMin : 30;
  const netMin = Math.max(grossMin - breakMin, 0);

  const tier = (r.rounding && r.rounding.perEmployee && r.rounding.perEmployee[nameKey])
    || (r.rounding && r.rounding.default) || DEFAULT_RULES.rounding.default;
  return { hours: roundTiered(netMin, tier), band };
}

const BAND_ORDER = ['Day', 'Afternoon', 'Night'];
const BAND_TIMES = { Day: '(07:00–15:00)', Afternoon: '(15:00–23:00)', Night: '(23:00–07:00)' };

// --- model ---------------------------------------------------------------------

/**
 * buildModel(enrichedList, periodStartISO?, rules?) -> {
 *   start, end, dates: [ISO x14],
 *   sheets: [{ location, bands: [{ band, rows }], dayTotals, grandTotal }],
 * }
 * row = { person, pid, band, hours: [h|null x14], total, exempt?, dual? }
 *
 * Default period = the one containing the latest record date in the list.
 * Rules default to DEFAULT_RULES (Process_Timecard v6.5.5); pass the parsed
 * paysheet-rules.json to override.
 */
function buildModel(enrichedList, periodStartISO, rules) {
  const list = enrichedList || [];
  const r = rules || DEFAULT_RULES;
  const corrections = r.nameCorrections || {};

  let start = periodStartISO || null;
  if (!start) {
    let latest = null;
    for (const e of list) {
      const iso = mdyToISO(e.date);
      if (iso && (!latest || iso > latest)) latest = iso;
    }
    start = latest ? periodFor(latest).start : periodFor(PERIOD_ANCHOR_ISO).start;
  } else {
    start = periodFor(start).start; // snap any date to its period start
  }
  const startIdx = isoToDayIndex(start);
  const dates = [];
  for (let i = 0; i < PERIOD_DAYS; i++) dates.push(dayIndexToISO(startIdx + i));
  const end = dates[PERIOD_DAYS - 1];

  // rowKey -> row accumulator
  // rowKey = location + '|' + corrected normalized name (dual-location targets merge by name)
  const acc = Object.create(null);
  const exemptSet = {};
  for (const n of (r.exempt || [])) exemptSet[n] = true;

  function rowFor(location, displayName, pid, band) {
    const key = location + '|' + normName(applyCorrections(normName(displayName), corrections));
    let row = acc[key];
    if (!row) {
      row = acc[key] = {
        person: displayName, pid: pid || '', band: band || 'Day',
        location, minsAdded: false,
        hoursByDay: Object.create(null), // iso -> hours (already rounded, summed if stacking)
        exempt: false, dual: false,
      };
    }
    return row;
  }

  for (const e of list) {
    if (!e) continue;
    const iso = mdyToISO(e.date);
    if (!iso || iso < start || iso > end) continue;

    const rawName = String(e.person || e.pid || '?');
    const nameKey = normName(rawName);
    const correctedLower = applyCorrections(nameKey, corrections);
    const displayName = toTitleCase(correctedLower);

    // exempt: row exists, machine hours never written
    if (exemptSet[nameKey] || exemptSet[correctedLower]) {
      const band0 = bandOf(e.shift, e.clockInMin);
      const row0 = rowFor('G&G IM2', displayName, e.pid, band0);
      row0.exempt = true;
      continue;
    }

    const { hours, band } = sheetHours(e, r);
    if (hours <= 0) {
      // still surface the employee row (keeps roster visible even w/o hours)
      const loc0 = (r.dualLocation && r.dualLocation[nameKey]) ? 'G&G IM2' : locationOf(e.shift, nameKey, r);
      const nm0 = (r.dualLocation && r.dualLocation[nameKey]) ? r.dualLocation[nameKey] : displayName;
      rowFor(loc0, nm0, e.pid, band);
      continue;
    }

    // dual-location: hours ADD onto the target IM2 row; never a Clark row
    const dualTarget = r.dualLocation ? r.dualLocation[nameKey] : null;
    if (dualTarget) {
      const row = rowFor('G&G IM2', dualTarget, e.pid, band);
      row.dual = true;
      row.hoursByDay[iso] = (row.hoursByDay[iso] || 0) + hours;
      continue;
    }

    const location = locationOf(e.shift, nameKey, r);
    const row = rowFor(location, displayName, e.pid, band);
    row.band = band; // latest record wins (same as re-detection on each run)
    row.hoursByDay[iso] = (row.hoursByDay[iso] || 0) + hours;
  }

  // bucket into sheets/bands
  const sheets = Object.create(null);
  for (const key in acc) {
    const row = acc[key];
    const hours = dates.map(d => (row.hoursByDay[d] > 0 ? row.hoursByDay[d] : null));
    let total = 0;
    for (const h of hours) if (h != null) total += h;
    const out = { person: row.person, pid: row.pid, band: row.band, hours, total, exempt: row.exempt, dual: row.dual };
    if (!sheets[row.location]) sheets[row.location] = Object.create(null);
    if (!sheets[row.location][row.band]) sheets[row.location][row.band] = [];
    sheets[row.location][row.band].push(out);
  }

  const outSheets = [];
  for (const loc of ['G&G IM2', 'G&G Clark']) {
    const byBand = sheets[loc] || Object.create(null);
    const bands = [];
    const dayTotals = new Array(PERIOD_DAYS).fill(0);
    let grandTotal = 0;
    for (const band of BAND_ORDER) {
      const rows = (byBand[band] || []).sort((a, b) => String(a.person).localeCompare(String(b.person)));
      if (!rows.length) continue;
      for (const row of rows) {
        grandTotal += row.total;
        for (let i = 0; i < PERIOD_DAYS; i++) if (row.hours[i] != null) dayTotals[i] += row.hours[i];
      }
      bands.push({ band, rows });
    }
    outSheets.push({
      location: loc,
      bands,
      dayTotals: dayTotals.map(v => (v > 0 ? v : null)),
      grandTotal,
    });
  }

  return { start, end, dates, sheets: outSheets };
}

// --- SpreadsheetML output -------------------------------------------------------

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isoWeekday(iso) {
  return WD_SHORT[new Date(isoToDayIndex(iso) * 86400000).getUTCDay()];
}
function isoDayLabel(iso) { // "29-Jun"
  const dt = new Date(isoToDayIndex(iso) * 86400000);
  return dt.getUTCDate() + '-' + MO_SHORT[dt.getUTCMonth()];
}
function isoLong(iso) { // "June 29, 2026"
  const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dt = new Date(isoToDayIndex(iso) * 86400000);
  return LONG[dt.getUTCMonth()] + ' ' + dt.getUTCDate() + ', ' + dt.getUTCFullYear();
}

/** "G&G Payroll- June 29 July 12 2026.xls" — same convention as the Office Script */
function workbookFilename(model) {
  const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const s = new Date(isoToDayIndex(model.start) * 86400000);
  const e = new Date(isoToDayIndex(model.end) * 86400000);
  return 'G&G Payroll- ' + LONG[s.getUTCMonth()] + ' ' + s.getUTCDate() + ' ' +
    LONG[e.getUTCMonth()] + ' ' + e.getUTCDate() + ' ' + e.getUTCFullYear() + '.xls';
}

function cell(styleId, type, value) {
  return '<Cell' + (styleId ? ' ss:StyleID="' + styleId + '"' : '') + '><Data ss:Type="' + type + '">' + value + '</Data></Cell>';
}
function formulaCell(styleId, formula, cachedValue) {
  return '<Cell' + (styleId ? ' ss:StyleID="' + styleId + '"' : '') + ' ss:Formula="' + formula + '">' +
    '<Data ss:Type="Number">' + cachedValue + '</Data></Cell>';
}
function emptyCell(styleId) {
  return '<Cell' + (styleId ? ' ss:StyleID="' + styleId + '"' : '') + '/>';
}

const BAND_STYLE = { Day: 'bandDay', Afternoon: 'bandAft', Night: 'bandNight' };
const BAND_SYMBOL = { Day: '☀ DAY SHIFT', Afternoon: '☾ AFTERNOON SHIFT', Night: '★ NIGHT SHIFT' };

/**
 * toWorkbookXml(model) -> SpreadsheetML string with one worksheet per location
 * (tab names: "PAYROLL" for G&G IM2 — matching their workbook — and "Clark").
 * Total Hours cells carry a live =SUM(E:R) formula like the original workbook.
 */
function toWorkbookXml(model) {
  const N = PERIOD_DAYS;
  const totalCols = 4 + N + 1; // CT, Name, Location, Shift, days, Total

  const head =
    '<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Styles>' +
    '<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="10"/></Style>' +
    '<Style ss:ID="title"><Font ss:FontName="Calibri" ss:Size="13" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1F3350" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/></Style>' +
    '<Style ss:ID="titleR"><Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Italic="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1F3350" ss:Pattern="Solid"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style>' +
    '<Style ss:ID="bandDay"><Font ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#C9971C" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>' +
    '<Style ss:ID="bandAft"><Font ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#B75B45" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>' +
    '<Style ss:ID="bandNight"><Font ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#3D3466" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>' +
    '<Style ss:ID="wd"><Font ss:Size="9" ss:Color="#54514B"/><Alignment ss:Horizontal="Center"/></Style>' +
    '<Style ss:ID="colhead"><Font ss:Size="9.5" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1F3350" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#3A4E6E"/></Borders></Style>' +
    '<Style ss:ID="name"><Font ss:Size="10" ss:Bold="1"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E7E2"/></Borders></Style>' +
    '<Style ss:ID="txt"><Alignment ss:Horizontal="Left" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E7E2"/></Borders></Style>' +
    '<Style ss:ID="ct"><Font ss:Size="9" ss:Color="#8A877E"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E7E2"/></Borders></Style>' +
    '<Style ss:ID="num"><NumberFormat ss:Format="0.0"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E7E2"/></Borders></Style>' +
    '<Style ss:ID="dash"><Font ss:Color="#B5B2A9"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E7E2"/></Borders></Style>' +
    '<Style ss:ID="tot"><NumberFormat ss:Format="0.0"/><Font ss:Bold="1"/><Interior ss:Color="#FBF3DC" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E7E2"/></Borders></Style>' +
    '<Style ss:ID="totrowlbl"><Font ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1F3350" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>' +
    '<Style ss:ID="totrownum"><NumberFormat ss:Format="0.0"/><Font ss:Bold="1"/><Interior ss:Color="#F3C94F" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>' +
    '</Styles>';

  let sheetsXml = '';
  const tabNames = { 'G&G IM2': 'PAYROLL', 'G&G Clark': 'Clark' };

  for (const sheet of model.sheets) {
    const rows = [];

    // Title row
    let r = '<Row ss:Height="22">';
    r += cell('title', 'String', xmlEsc((sheet.location === 'G&G Clark' ? 'G&G CLARK' : 'G&G IM2') + ' · EMPLOYEE ATTENDANCE SHEET'));
    for (let i = 1; i < totalCols - 2; i++) {
      r += (i === 5)
        ? cell('titleR', 'String', xmlEsc('Employer: SaniXperts Services Ltd'))
        : emptyCell('title');
    }
    r += cell('titleR', 'String', xmlEsc('Pay Period: ' + isoLong(model.start) + ' – ' + isoLong(model.end)));
    r += emptyCell('title');
    r += '</Row>';
    rows.push(r);

    // Weekday row
    r = '<Row>' + emptyCell() + emptyCell() + emptyCell() + emptyCell();
    for (const d of model.dates) r += cell('wd', 'String', isoWeekday(d));
    r += emptyCell();
    r += '</Row>';
    rows.push(r);

    // Column header row
    r = '<Row ss:Height="18">';
    r += cell('colhead', 'String', 'CT') + cell('colhead', 'String', 'Employee Name') +
         cell('colhead', 'String', 'Location') + cell('colhead', 'String', 'Shift');
    for (const d of model.dates) r += cell('colhead', 'String', isoDayLabel(d));
    r += cell('colhead', 'String', 'Total Hours');
    r += '</Row>';
    rows.push(r);

    // Bands
    let ct = 0;
    for (const band of sheet.bands) {
      const bandStyle = BAND_STYLE[band.band] || 'bandDay';
      let br = '<Row ss:Height="18">';
      br += cell(bandStyle, 'String', xmlEsc(
        BAND_SYMBOL[band.band] + ' ' + (BAND_TIMES[band.band] || '') + ' · ' +
        band.rows.length + ' Employee' + (band.rows.length === 1 ? '' : 's')));
      for (let i = 1; i < totalCols; i++) br += emptyCell(bandStyle);
      br += '</Row>';
      rows.push(br);

      for (const row of band.rows) {
        ct++;
        let rr = '<Row>';
        rr += cell('ct', 'Number', ct);
        rr += cell('name', 'String', xmlEsc(row.person + (row.exempt ? ' (manual)' : '')));
        rr += cell('txt', 'String', xmlEsc(sheet.location));
        rr += cell('txt', 'String', xmlEsc(row.band));
        for (const h of row.hours) {
          rr += (h == null) ? cell('dash', 'String', '—') : cell('num', 'Number', h);
        }
        // Live =SUM over the 14 day cells, like the original workbook (R1C1 refs)
        rr += (row.total > 0 || !row.exempt)
          ? formulaCell('tot', '=SUM(RC[-14]:RC[-1])', row.total)
          : cell('dash', 'String', '—');
        rr += '</Row>';
        rows.push(rr);
      }
    }

    // Totals row
    r = '<Row ss:Height="20">';
    r += emptyCell('totrowlbl') + cell('totrowlbl', 'String', 'Total Hours') + emptyCell('totrowlbl') + emptyCell('totrowlbl');
    for (const t of sheet.dayTotals) {
      r += (t == null) ? cell('totrowlbl', 'String', '—') : cell('totrownum', 'Number', t);
    }
    r += (sheet.grandTotal > 0) ? cell('totrownum', 'Number', sheet.grandTotal) : cell('totrowlbl', 'String', '—');
    r += '</Row>';
    rows.push(r);

    sheetsXml +=
      '<Worksheet ss:Name="' + xmlEsc(tabNames[sheet.location] || sheet.location) + '"><Table>' +
      '<Column ss:Width="26"/><Column ss:Width="160"/><Column ss:Width="70"/><Column ss:Width="72"/>' +
      new Array(N).fill('<Column ss:Width="44"/>').join('') +
      '<Column ss:Width="70"/>' +
      rows.join('') +
      '</Table></Worksheet>';
  }

  return head + sheetsXml + '</Workbook>';
}

module.exports = {
  PERIOD_ANCHOR_ISO,
  PERIOD_DAYS,
  DEFAULT_RULES,
  isoToDayIndex,
  dayIndexToISO,
  mdyToISO,
  periodFor,
  normName,
  applyCorrections,
  roundTiered,
  snapClockInMin,
  earlyClockOutMin,
  softSnapClockOutMin,
  bandOf,
  locationOf,
  sheetHours,
  buildModel,
  toWorkbookXml,
  workbookFilename,
};
