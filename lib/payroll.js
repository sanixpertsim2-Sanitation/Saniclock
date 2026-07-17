/**
 * lib/payroll.js — per-employee per-period payroll summary + RFC-4180 CSV builder
 * ===========================================================================
 * Phase-1 payroll roll-up. Consumes the FROZEN contracts from the Phase-1 spec:
 *   - EnrichedPunch[]  (from time-engine.enrichAll)   §1.3
 *   - WeekBucket[]     (from time-engine.weeklyOvertime) §1.4
 *   - Flag[]           (from integrity.auditAll)       §2
 *
 * Emits MINUTES as the payroll source of truth; h:mm columns are human mirrors.
 * NO I/O, NO HTTP, NO DOM — pure functions. Dependency-free (Node built-ins only).
 *
 * Dependency injection: periodSummary() pulls week buckets from time-engine and
 * exceptions from integrity. Both can be injected via opts (for tests / stubbing
 * before Squad A/B land); otherwise they are lazily require()d at call time so
 * this module loads even when the sibling modules are not yet present.
 *
 * PHASE-2 GAPS (spec §3) — NOT handled here, do not assume fixed:
 *   - No DST / timezone resolution (naive 1440-min days upstream).
 *   - Shift-start attribution only (no midnight hour-splitting).
 *   - Pay is emitted in MINUTES; dollar multipliers (1.5x OT, night premium)
 *     are applied downstream, not in Phase-1.
 *   - No public-holiday / stat-premium pay.
 */
'use strict';

// --- small pure helpers (kept local so toCsv/fmtHM need no sibling modules) --

/**
 * fmtHM(min) -> "H:MM"  (e.g. 487 -> "8:07", 2640 -> "44:00", 360 -> "6:00").
 * Never emits NaN/undefined; null/negative/non-finite clamp to "0:00".
 */
function fmtHM(min) {
  if (min == null || !isFinite(min)) min = 0;
  min = Math.round(min);
  if (min < 0) min = 0;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + ':' + String(m).padStart(2, '0');
}

/** "MM/DD/YYYY" -> "YYYY-MM-DD" | null (local, no TZ math — spec §3 scope-out). */
function mdyToISO(dateStr) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  return m[3] + '-' + String(+m[1]).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0');
}

/** RFC-4180 field quoting: wrap in quotes iff it contains , " CR or LF. */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function lazyRequire(name) {
  // Deferred so the module loads even if the sibling file is absent until called.
  return require(name);
}

// --- distinct exception codes for one employee-week --------------------------

/**
 * Distinct Flag codes (first-seen order) whose Flag.date falls inside
 * [week.weekStart, week.weekEnd] (ISO inclusive). ";"-joined, else "".
 */
function weekExceptionCodes(exceptions, week) {
  const seen = Object.create(null);
  const out = [];
  const list = exceptions || [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f || !f.code) continue;
    const iso = mdyToISO(f.date);
    if (iso == null) continue;
    if (iso >= week.weekStart && iso <= week.weekEnd) {
      if (!seen[f.code]) { seen[f.code] = true; out.push(f.code); }
    }
  }
  return out.join(';');
}

// --- periodSummary -----------------------------------------------------------

/**
 * periodSummary(enrichedList, opts?) -> PayrollSummary  (spec §4)
 *
 * opts.periodStart / opts.periodEnd — optional "YYYY-MM-DD" clamp applied to
 *   WeekBucket.weekStart (inclusive). Default = all weeks present.
 * opts.engine     — inject time-engine (must expose weeklyOvertime). Default: require('./time-engine').
 * opts.integrity  — inject integrity   (must expose auditAll).       Default: require('./integrity').
 */
function periodSummary(enrichedList, opts) {
  opts = opts || {};
  const engine = opts.engine || lazyRequire('./time-engine');
  const integ = opts.integrity || lazyRequire('./integrity');

  let weeks = engine.weeklyOvertime(enrichedList) || [];
  // Overlap semantics: include any week whose [weekStart, weekEnd] overlaps [periodStart, periodEnd]
  if (opts.periodStart) weeks = weeks.filter(w => w.weekEnd >= opts.periodStart);
  if (opts.periodEnd) weeks = weeks.filter(w => w.weekStart <= opts.periodEnd);

  const audit = integ.auditAll(enrichedList) || { flags: [], byPid: {}, counts: {} };
  const byPid = audit.byPid || {};

  const byEmployee = Object.create(null);
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i];
    let e = byEmployee[w.pid];
    if (!e) {
      e = byEmployee[w.pid] = {
        pid: w.pid, person: w.person,
        regularMin: 0, overtimeMin: 0, nightMin: 0, totalNetMin: 0,
        weeks: [], exceptions: [],
      };
    }
    e.regularMin += w.regularMin || 0;
    e.overtimeMin += w.overtimeMin || 0;
    e.nightMin += w.nightMin || 0;
    e.totalNetMin += w.totalNetMin || 0;
    e.weeks.push(w);
  }

  // attach this pid's exceptions from the integrity roll-up
  for (const pid in byEmployee) {
    byEmployee[pid].exceptions = byPid[pid] ? byPid[pid].slice() : [];
    // deterministic weekly order for CSV emission
    byEmployee[pid].weeks.sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0));
  }

  const totals = { regularMin: 0, overtimeMin: 0, nightMin: 0, totalNetMin: 0, employees: 0 };
  for (const pid in byEmployee) {
    const e = byEmployee[pid];
    totals.regularMin += e.regularMin;
    totals.overtimeMin += e.overtimeMin;
    totals.nightMin += e.nightMin;
    totals.totalNetMin += e.totalNetMin;
    totals.employees += 1;
  }

  return { weeks, byEmployee, totals };
}

// --- toCsv -------------------------------------------------------------------

const CSV_HEADER = [
  'Person ID', 'Person Name', 'Week Start', 'Week End',
  'Regular (h:mm)', 'Overtime (h:mm)', 'Night (h:mm)', 'Total Net (h:mm)',
  'Regular Min', 'Overtime Min', 'Night Min', 'Total Net Min', 'Exceptions',
];

/**
 * toCsv(payrollSummary) -> string  (RFC-4180, header row + one row per
 * employee-week, exact column order per spec §4). CRLF line endings.
 */
function toCsv(summary) {
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  const byEmployee = (summary && summary.byEmployee) || {};

  const pids = Object.keys(byEmployee).sort();
  for (let p = 0; p < pids.length; p++) {
    const e = byEmployee[pids[p]];
    const weeks = e.weeks || [];
    for (let w = 0; w < weeks.length; w++) {
      const wk = weeks[w];
      const exc = weekExceptionCodes(e.exceptions, wk);
      const row = [
        e.pid, e.person, wk.weekStart, wk.weekEnd,
        fmtHM(wk.regularMin), fmtHM(wk.overtimeMin), fmtHM(wk.nightMin), fmtHM(wk.totalNetMin),
        wk.regularMin, wk.overtimeMin, wk.nightMin, wk.totalNetMin,
        exc,
      ];
      lines.push(row.map(csvCell).join(','));
    }
  }
  return lines.join('\r\n');
}

module.exports = {
  fmtHM,
  mdyToISO,
  csvCell,
  weekExceptionCodes,
  periodSummary,
  toCsv,
  CSV_HEADER,
};
