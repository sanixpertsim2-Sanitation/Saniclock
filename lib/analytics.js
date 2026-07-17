/**
 * lib/analytics.js — dashboard aggregations (factored out of scale.js)
 * ===========================================================================
 * Pure aggregations over EnrichedPunch[] (spec §1.3). Lets the server pre-compute
 * what the browser used to, so the client stays thin. NO I/O / HTTP / DOM.
 * Dependency-free (Node built-ins only).
 *
 * The "plausibly-live" predicate isLive(enriched, now) is the canonical home for
 * the rule that used to live in scale.js (open punch + real-today + elapsed < 16h),
 * so server and client agree. exceptionsRollup() reuses integrity detectors;
 * integrity is injectable (opts.integrity) or lazily require()d.
 *
 * PHASE-2 GAPS (spec §3) inherited from upstream: naive local time (no DST/TZ),
 * shift-start attribution, break-placement not verified. Do not assume fixed.
 */
'use strict';

const MAX_LIVE_MS = 16 * 3600 * 1000; // 16h — beyond this an open punch is stale, not live

// Canonical shift-family order (mirrors scale.js CATS / time-engine.catOf output)
const CATEGORY_ORDER = ['Day', 'Afternoon', 'Night', 'P2', 'Leadership', 'Clark', 'Janitor', 'Other'];

function lazyRequire(name) { return require(name); }

/** "MM/DD/YYYY" -> {y,m,d} | null (naive local, spec §3 scope-out). */
function parseMDY(dateStr) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  return { y: +m[3], m: +m[1], d: +m[2] };
}

/**
 * isLive(enriched, now) -> boolean.
 * now: Date | ms | undefined (defaults to Date.now()).
 * True only when the punch is open (status "in"), its date is the SAME real
 * calendar day as `now`, and elapsed since clock-in is >= 0 and < 16h.
 */
function isLive(e, now) {
  if (!e || e.status !== 'in') return false;
  const nowMs = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Number(now));
  if (!isFinite(nowMs)) return false;
  const p = parseMDY(e.date);
  if (!p) return false;
  const nd = new Date(nowMs);
  if (!(p.y === nd.getFullYear() && p.m === nd.getMonth() + 1 && p.d === nd.getDate())) return false;
  const tp = String(e.clockIn || '').split(':');
  if (tp.length < 2) return false;
  const inMs = new Date(p.y, p.m - 1, p.d, (+tp[0] || 0), (+tp[1] || 0), (+tp[2] || 0)).getTime();
  const el = nowMs - inMs;
  if (el < 0 || el >= MAX_LIVE_MS) return false;
  return true;
}

/** open punch that is NOT plausibly live => a missing-clock-out exception. */
function isStatMissingOut(e, now) {
  return !!e && e.status === 'in' && !isLive(e, now);
}

/**
 * dayStats(enrichedForDate, now?) -> summary for one date. Supersedes statOf().
 */
function dayStats(list, now) {
  list = list || [];
  const s = {
    scheduled: list.length, present: 0, live: 0, done: 0, absent: 0,
    netMin: 0, overtimeMinCsvRef: 0, breakMin: 0,
    abnormalCount: 0, missingOut: 0, exceptions: 0,
  };
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r.clockIn) s.present++;
    if (isLive(r, now)) s.live++;
    else if (r.status === 'done') s.done++;
    else if (r.status === 'absent') s.absent++;
    const miss = isStatMissingOut(r, now);
    if (miss) s.missingOut++;
    if (typeof r.netMin === 'number' && isFinite(r.netMin)) s.netMin += r.netMin;
    if (typeof r.otMin === 'number' && isFinite(r.otMin)) s.overtimeMinCsvRef += r.otMin;
    if (typeof r.breakMin === 'number' && isFinite(r.breakMin)) s.breakMin += r.breakMin;
    if (r.abnormal) s.abnormalCount++;
    if (miss || r.abnormal) s.exceptions++;
  }
  return s;
}

/**
 * hoursByShift(enrichedForDate) -> [{category, netMin}] desc by netMin,
 * categories with <= 0 payable minutes filtered out.
 */
function hoursByShift(list) {
  list = list || [];
  const acc = Object.create(null);
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const cat = r.category || 'Other';
    const n = (typeof r.netMin === 'number' && isFinite(r.netMin)) ? r.netMin : 0;
    acc[cat] = (acc[cat] || 0) + n;
  }
  const out = [];
  for (const cat in acc) if (acc[cat] > 0) out.push({ category: cat, netMin: acc[cat] });
  out.sort((a, b) => b.netMin - a.netMin || catRank(a.category) - catRank(b.category));
  return out;
}

/**
 * rosterByShift(enrichedForDate) -> { total, items:[{category, count, pct}] }.
 * Counts PRESENT records (has clockIn) per category. pct rounded to int %.
 */
function rosterByShift(list) {
  list = list || [];
  const acc = Object.create(null);
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r.clockIn) continue;
    const cat = r.category || 'Other';
    acc[cat] = (acc[cat] || 0) + 1;
    total++;
  }
  const items = [];
  for (const cat in acc) items.push({ category: cat, count: acc[cat], pct: total ? Math.round((acc[cat] / total) * 100) : 0 });
  items.sort((a, b) => b.count - a.count || catRank(a.category) - catRank(b.category));
  return { total, items };
}

/**
 * clockInHistogram(enrichedForDate) -> Array(24) of { hour, byCategory, total }.
 * Buckets present records by clock-in hour (0..23), stacked by category.
 */
function clockInHistogram(list) {
  list = list || [];
  const bins = [];
  for (let h = 0; h < 24; h++) bins.push({ hour: h, byCategory: Object.create(null), total: 0 });
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    let hr = null;
    if (typeof r.clockInMin === 'number' && isFinite(r.clockInMin)) hr = Math.floor(r.clockInMin / 60);
    else if (r.clockIn) {
      const tp = String(r.clockIn).split(':');
      if (tp.length >= 2) hr = +tp[0];
    }
    if (hr == null || hr < 0 || hr > 23) continue;
    const cat = r.category || 'Other';
    const bin = bins[hr];
    bin.byCategory[cat] = (bin.byCategory[cat] || 0) + 1;
    bin.total++;
  }
  return bins;
}

/**
 * headcountTrend(enrichedAll, datesAscending) -> [{date, present}].
 * present = count of records with a clockIn for that date (matches presentSeries()).
 */
function headcountTrend(all, datesAscending) {
  all = all || [];
  const dates = datesAscending || [];
  const counts = Object.create(null);
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (r.clockIn && r.date) counts[r.date] = (counts[r.date] || 0) + 1;
  }
  return dates.map(d => ({ date: d, present: counts[d] || 0 }));
}

/**
 * exceptionsRollup(enrichedForDate, opts?) -> {missingOut, abnormal,
 *   mealViolations, anomalies, total, flags}. Uses integrity detectors.
 * opts.integrity injectable; opts.now for live evaluation.
 */
function exceptionsRollup(list, opts) {
  list = list || [];
  opts = opts || {};
  const integ = opts.integrity || lazyRequire('./integrity');
  const now = opts.now;

  const flags = [];
  let mealViolations = 0;
  let anomalies = 0;
  let missingOut = 0;
  let abnormal = 0;

  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r.abnormal) abnormal++;
    const anoms = integ.anomalies ? (integ.anomalies(r) || []) : [];
    for (let k = 0; k < anoms.length; k++) {
      flags.push(anoms[k]);
      anomalies++;
      if (anoms[k].code === 'MISSING_OUT') missingOut++;
    }
    const mv = integ.mealViolation ? integ.mealViolation(r) : null;
    if (mv) { flags.push(mv); mealViolations++; }
  }

  return {
    missingOut,
    abnormal,
    mealViolations,
    anomalies,
    total: flags.length + abnormal,
    flags,
  };
}

function catRank(cat) {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

// Absolute day index since 2000-01-01 (for cross-date arithmetic). No TZ math — date-only.
function dayIndex(dateStr) {
  const p = parseMDY(dateStr);
  if (!p) return null;
  return Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(2000, 0, 1)) / 86400000);
}

function dayIndexISO(isoStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoStr || '').trim());
  if (!m) return null;
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(2000, 0, 1)) / 86400000);
}

/**
 * restViolations(enrichedAll) -> Flag[]
 * Cross-shift Ontario ESA rest-period detectors. Takes the full enriched list
 * (all employees, all dates). Returns Flag objects with {code, severity, pid, date, message}.
 *
 * ESA_REST_11HR (s.18(1)):  gap between clockOut of shift N and clockIn of shift N+1
 *   is < 660 min (11 h). Flag attached to the LATER record (shift N+1).
 *   Skipped when shift N has a missing clock-out.
 *
 * ESA_REST_24HR (s.18(4)):  within each Mon–Sun work week, no 1440-consecutive-minute
 *   window free of work exists for the employee. Flag attached to the last record in
 *   that week for the employee.
 *   Shifts with missing clock-out are treated as running to end of week (conservative).
 *   Only weeks that have fully ended (weekEnd < now) are evaluated — partial weeks
 *   cannot yet be in violation.
 *
 * opts.now — Date | ms | null. Defaults to Date.now(). Used only for 24HR week-end check.
 */
function restViolations(enrichedAll, opts) {
  opts = opts || {};
  const flags = [];
  if (!enrichedAll || !enrichedAll.length) return flags;

  // Current time as absolute minute — used to skip the 24HR check on in-progress weeks
  const nowMs = opts.now == null ? Date.now() : (opts.now instanceof Date ? opts.now.getTime() : Number(opts.now));
  const nowDayIndex = Math.floor(nowMs / 86400000) - Math.round((Date.UTC(2000, 0, 1)) / 86400000);

  // Group by pid
  const byPid = Object.create(null);
  for (let i = 0; i < enrichedAll.length; i++) {
    const e = enrichedAll[i];
    const pid = e.pid || e.person || '';
    if (!byPid[pid]) byPid[pid] = [];
    byPid[pid].push(e);
  }

  for (const pid in byPid) {
    // Stamp absolute minutes for each shift that has a clock-in
    const stamped = [];
    const shifts = byPid[pid];
    for (let i = 0; i < shifts.length; i++) {
      const e = shifts[i];
      const di = dayIndex(e.date);
      if (di === null) continue;
      const inMin = (typeof e.clockInMin === 'number' && isFinite(e.clockInMin)) ? e.clockInMin : null;
      if (inMin === null) continue;
      const outMin = (typeof e.clockOutMin === 'number' && isFinite(e.clockOutMin)) ? e.clockOutMin : null;
      const absIn = di * 1440 + inMin;
      // Overnight shift: clockOut < clockIn means the out is on the next calendar day
      const absOut = outMin !== null
        ? di * 1440 + (outMin < inMin ? outMin + 1440 : outMin)
        : null;
      stamped.push({ e, absIn, absOut });
    }

    // Sort by absIn ascending
    stamped.sort((a, b) => a.absIn - b.absIn);

    // --- ESA s.18(1): 11-hour inter-shift rest ---
    for (let i = 1; i < stamped.length; i++) {
      const prev = stamped[i - 1];
      const curr = stamped[i];
      if (prev.absOut === null) continue; // missing clock-out on prior shift → can't compute gap
      const gap = curr.absIn - prev.absOut;
      if (gap < 0 || gap >= 660) continue; // compliant or overlapping (overlap flag handles the latter)
      const h = Math.floor(gap / 60);
      const m = gap % 60;
      flags.push({
        code: 'ESA_REST_11HR',
        severity: 'error',
        pid: curr.e.pid,
        date: curr.e.date,
        message: 'Inter-shift rest only ' + h + 'h' + (m ? ' ' + m + 'm' : '') + ' (ESA s.18(1) requires 11h)',
      });
    }

    // --- ESA s.18(4): 24-hour weekly rest ---
    const byWeek = Object.create(null);
    for (let i = 0; i < stamped.length; i++) {
      const { e, absIn, absOut } = stamped[i];
      const ws = e.workWeekStart || '';
      if (!ws) continue;
      if (!byWeek[ws]) byWeek[ws] = { weekStartMin: null, items: [] };
      byWeek[ws].items.push({ e, absIn, absOut });
      if (byWeek[ws].weekStartMin === null) {
        const di2 = dayIndexISO(ws);
        if (di2 !== null) byWeek[ws].weekStartMin = di2 * 1440;
      }
    }

    for (const ws in byWeek) {
      const { weekStartMin, items } = byWeek[ws];
      if (weekStartMin === null) continue;
      const weekEndMin = weekStartMin + 7 * 1440;
      // Skip weeks that haven't ended yet — a partial week can't be in violation
      if (nowDayIndex * 1440 < weekEndMin) continue;

      // Build busy intervals clamped to week. Missing clock-out → treated as busy until week end.
      const busy = [];
      for (let i = 0; i < items.length; i++) {
        const { absIn, absOut } = items[i];
        const start = Math.max(absIn, weekStartMin);
        const end = absOut !== null ? Math.min(absOut, weekEndMin) : weekEndMin;
        if (end > start) busy.push([start, end]);
      }

      // Merge overlapping intervals
      busy.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (let i = 0; i < busy.length; i++) {
        if (!merged.length || busy[i][0] > merged[merged.length - 1][1]) {
          merged.push([busy[i][0], busy[i][1]]);
        } else {
          merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], busy[i][1]);
        }
      }

      // Find the longest free gap (including start-of-week and end-of-week gaps)
      let maxGap = 0;
      let prev = weekStartMin;
      for (let i = 0; i < merged.length; i++) {
        const gap = merged[i][0] - prev;
        if (gap > maxGap) maxGap = gap;
        prev = merged[i][1];
      }
      if (weekEndMin - prev > maxGap) maxGap = weekEndMin - prev;

      if (maxGap < 1440) {
        // Attach to the last record in this week for this employee
        const last = items[items.length - 1];
        flags.push({
          code: 'ESA_REST_24HR',
          severity: 'error',
          pid: last.e.pid,
          date: last.e.date,
          message: 'No 24h consecutive rest in work week ' + ws +
            ' — longest free gap ' + Math.floor(maxGap / 60) + 'h (ESA s.18(4))',
        });
      }
    }
  }

  return flags;
}

module.exports = {
  MAX_LIVE_MS,
  CATEGORY_ORDER,
  parseMDY,
  dayIndex,
  dayIndexISO,
  isLive,
  dayStats,
  hoursByShift,
  rosterByShift,
  clockInHistogram,
  headcountTrend,
  exceptionsRollup,
  restViolations,
};
