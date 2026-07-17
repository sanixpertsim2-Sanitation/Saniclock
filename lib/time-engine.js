'use strict';
/**
 * lib/time-engine.js — Punch System Phase 1, Squad A (correctness core).
 *
 * Cross-midnight attribution + our-own Ontario 44h weekly overtime recompute
 * from raw worked minutes. Pure functions, ZERO dependencies (Node built-ins only).
 * Never trusts the CSV's `otMin` or `workMin` for pay — recomputes from punches.
 *
 * Consumes the RawRecord shape produced by scale.js `loadData()`; produces the
 * frozen EnrichedPunch (§1.3) and WeekBucket (§1.4) contracts.
 *
 * ── Phase-2 gaps deliberately NOT handled here (spec §3), do not assume fixed ──
 *  - DST / timezone correctness: all date math is naive fixed-1440-min days
 *    (via Date.UTC to stay deterministic). A shift crossing a Mar/Nov
 *    America/Toronto DST boundary is off by +/-60 min. ACCEPTED Phase-1 gap.
 *  - Midnight hour-splitting across two calendar days/weeks: Phase-1 uses
 *    SHIFT-START attribution — the whole span is credited to the clock-in day.
 *  - Break placement, public-holiday pay: out of scope for this module.
 */

// ─── 1.1 Constants ──────────────────────────────────────────────────────────
const MINUTES_PER_DAY = 1440;
const OT_WEEKLY_THRESHOLD_MIN = 44 * 60;   // 2640
const MAX_PLAUSIBLE_SHIFT_MIN = 16 * 60;   // 960 — beyond this an overnight read is suspect
const NIGHT_WINDOW = { startMin: 22 * 60, endMin: 6 * 60 }; // 22:00–06:00 wraps midnight

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// ─── 1.1 Small helpers ──────────────────────────────────────────────────────

/**
 * "HH:MM:SS"/"HH:MM" -> integer minutes-since-midnight (0..1439), or null if
 * malformed. Seconds are floored away (whole-minute domain); fractional seconds
 * are only ever carried in scale.js `hmsToMinutes`, never here.
 */
function hmsToMin(hms) {
  if (typeof hms !== 'string') return null;
  const t = hms.trim();
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return null;
  const parts = t.split(':');
  const h = +parts[0], m = +parts[1], s = parts.length > 2 ? +parts[2] : 0;
  if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
  return h * 60 + m; // floor seconds
}

/**
 * Canonical shift-family classifier (ported verbatim from scale.js `catOf`).
 * Substring match on lowercased shift, first hit wins.
 * -> "Day"|"Afternoon"|"Night"|"P2"|"Leadership"|"Clark"|"Janitor"|"Other"
 */
function catOf(shift) {
  const s = (shift || '').toLowerCase();
  if (!s) return 'Other';
  if (s.indexOf('lead') > -1) return 'Leadership';
  if (s.indexOf('clark') > -1) return 'Clark';
  if (s.indexOf('jan') > -1) return 'Janitor';
  if (s.indexOf('p2') > -1) return 'P2';
  if (s.indexOf('night') > -1) return 'Night';
  if (s.indexOf('aft') > -1) return 'Afternoon';
  if (s.indexOf('day') > -1 || s.indexOf('morning') > -1) return 'Day';
  return 'Other';
}

// --- Time-window shift classifier (Ferrero device punches have no roster label) ---
// Buckets a punch into Day/Afternoon/Night by CLOCK-IN time. Mirrors NGTeco day-change
// intent (Day/Afternoon reset 04:00, Night reset ~14:00). Only chooses the shift SHEET;
// never alters worked-minute / OT / night math.
const SHIFT_WINDOWS = { dayStart: 4 * 60, aftStart: 12 * 60, nightStart: 20 * 60 };
function shiftByClockIn(minsSinceMidnight) {
  const m = minsSinceMidnight;
  if (m == null) return 'Other';
  if (m >= SHIFT_WINDOWS.dayStart && m < SHIFT_WINDOWS.aftStart) return 'Day';
  if (m >= SHIFT_WINDOWS.aftStart && m < SHIFT_WINDOWS.nightStart) return 'Afternoon';
  return 'Night';
}

/** "MM/DD/YYYY" -> {y,m,d} | null. Naive local wall-clock (no TZ math, §3). */
function parseMDY(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateStr.trim());
  if (!m) return null;
  const mo = +m[1], d = +m[2], y = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/** "MM/DD/YYYY" -> "YYYY-MM-DD" | null */
function toISO(dateStr) {
  const p = parseMDY(dateStr);
  if (!p) return null;
  return p.y + '-' + pad2(p.m) + '-' + pad2(p.d);
}

function isoFromUTCDate(dt) {
  return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
}

/**
 * Work week = MONDAY–SUNDAY, matching Sanixperts' attendance settings: bi-weekly
 * pay periods run Mon→Sun (anchor Mon 2026-06-29 → Sun 2026-07-12). Confirmed
 * against the employer's payroll sheets 2026-07-08. (NGTeco portal's "Saturday"
 * start-day setting is a stale misconfiguration — do not follow it.)
 */

/** -> "YYYY-MM-DD" Monday of the Mon–Sun week containing dateStr, or null. */
function weekStartMonday(dateStr) {
  const p = parseMDY(dateStr);
  if (!p) return null;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); // getUTCDay: 0=Sun..6=Sat
  return isoFromUTCDate(dt);
}

/** -> "YYYY-MM-DD" Sunday of that week, or null. */
function weekEndSunday(dateStr) {
  const p = parseMDY(dateStr);
  if (!p) return null;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7) + 6);
  return isoFromUTCDate(dt);
}

// ─── 1.2 Worked-minute + overnight core ─────────────────────────────────────

/**
 * computeSpan(clockIn, clockOut) -> { overnight, grossMin, clockInMin, clockOutMin }
 *  - either punch missing/malformed -> grossMin null, overnight false.
 *  - out > in  -> same-day span.
 *  - out < in  -> overnight, gross = (1440 - in) + out.
 *  - out === in -> gross 0 (zero-length, NOT 24h).
 * grossMin is always an integer.
 */
function computeSpan(clockIn, clockOut) {
  const inMin = hmsToMin(clockIn);
  const outMin = hmsToMin(clockOut);
  if (inMin === null || outMin === null) {
    return { overnight: false, grossMin: null, clockInMin: inMin, clockOutMin: outMin };
  }
  let overnight = false;
  let grossMin;
  if (outMin > inMin) {
    grossMin = outMin - inMin;
  } else if (outMin < inMin) {
    overnight = true;
    grossMin = (MINUTES_PER_DAY - inMin) + outMin;
  } else {
    grossMin = 0; // equal punch => zero-length
  }
  return { overnight, grossMin, clockInMin: inMin, clockOutMin: outMin };
}

/**
 * Minutes of the real worked interval intersecting the nightly 22:00–06:00 band
 * (band repeats every 24h). `span` is a computeSpan() result with grossMin != null.
 */
function nightOverlap(span) {
  const start = span.clockInMin;              // absolute minutes from clock-in day 00:00
  const end = start + span.grossMin;          // may exceed 1440 when overnight
  const bandStart = NIGHT_WINDOW.startMin;    // 1320
  const bandLen = (MINUTES_PER_DAY - NIGHT_WINDOW.startMin) + NIGHT_WINDOW.endMin; // 480
  let total = 0;
  // Bands: [k*1440 + 1320, k*1440 + 1320 + 480]. Cover k = -1..2 (grossMin <= ~16h).
  for (let k = -1; k <= 2; k++) {
    const bs = k * MINUTES_PER_DAY + bandStart;
    const be = bs + bandLen;
    const lo = Math.max(start, bs);
    const hi = Math.min(end, be);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

// ─── 1.3 Enrichment — the shared contract output ────────────────────────────

/** enrich(rawRecord) -> EnrichedPunch (RawRecord + derived fields, §1.3). */
const BREAK_ANCHOR = { Day: '10:00', Afternoon: '18:00', Night: '02:00' }; // nominal 30-min meal placement per shift
function enrich(raw) {
  const span = computeSpan(raw.clockIn, raw.clockOut);
  const namedCat = catOf(raw.shift);
  const category = (namedCat === 'Other' && span.clockInMin != null) ? shiftByClockIn(span.clockInMin) : namedCat;
  const shiftSource = (namedCat === 'Other' && span.clockInMin != null) ? 'clockin' : 'roster';
  let breakMin = Math.max(0, Math.round(Number(raw.breakMin) || 0));
  if (breakMin === 0 && span.grossMin !== null && span.grossMin > 300) breakMin = 30; // auto 30-min meal deduction for shifts over 5h
  const netMin = span.grossMin === null ? null : Math.max(0, span.grossMin - breakMin);
  const nightMin = span.grossMin === null ? 0 : nightOverlap(span);
  const missingOut = !!(raw.clockIn && !raw.clockOut);
  const workDate = raw.date;
  const workWeekStart = weekStartMonday(raw.date);
  const valid = span.grossMin !== null && netMin !== null &&
    netMin > 0 && netMin <= MAX_PLAUSIBLE_SHIFT_MIN;

  return Object.assign({}, raw, {
    category,
    breakMin,
    breakAt: BREAK_ANCHOR[category] || null,
    shiftSource,
    overnight: span.overnight,
    grossMin: span.grossMin,
    netMin,
    clockInMin: span.clockInMin,
    clockOutMin: span.clockOutMin,
    nightMin,
    workDate,
    workWeekStart,
    missingOut,
    valid,
  });
}

/** enrichAll(records) -> EnrichedPunch[] */
function enrichAll(records) {
  const arr = Array.isArray(records) ? records : [];
  return arr.map(enrich);
}

// ─── 1.4 Weekly Ontario overtime engine (our own, ignores CSV OT) ───────────

/**
 * weeklyOvertime(enrichedPunches) -> WeekBucket[]
 * Groups VALID punches by pid + workWeekStart, sums netMin, splits at 44h.
 * Threshold is strictly after 44h: exactly 2640 -> 0 OT; 2641 -> 1 OT.
 */
function weeklyOvertime(enrichedPunches) {
  const list = Array.isArray(enrichedPunches) ? enrichedPunches : [];
  const groups = new Map();
  for (const e of list) {
    if (!e || !e.valid) continue;
    const key = e.pid + '|' + e.workWeekStart;
    let g = groups.get(key);
    if (!g) {
      g = {
        pid: e.pid,
        person: e.person,
        weekStart: e.workWeekStart,
        weekEnd: weekEndSunday(e.workDate),
        totalNetMin: 0,
        nightMin: 0,
        dailyNet: {},
        _days: new Set(),
      };
      groups.set(key, g);
    }
    g.totalNetMin += e.netMin;
    g.nightMin += e.nightMin;
    g.dailyNet[e.workDate] = (g.dailyNet[e.workDate] || 0) + e.netMin;
    if (e.netMin > 0) g._days.add(e.workDate);
  }

  const out = [];
  for (const g of groups.values()) {
    const regularMin = g.totalNetMin; // OT disabled per facility policy — extra time folds into regular
    const overtimeMin = 0;
    out.push({
      pid: g.pid,
      person: g.person,
      weekStart: g.weekStart,
      weekEnd: g.weekEnd,
      totalNetMin: g.totalNetMin,
      regularMin,
      overtimeMin,
      nightMin: g.nightMin,
      dayCount: g._days.size,
      dailyNet: g.dailyNet,
    });
  }
  return out;
}

module.exports = {
  // constants
  MINUTES_PER_DAY,
  OT_WEEKLY_THRESHOLD_MIN,
  MAX_PLAUSIBLE_SHIFT_MIN,
  NIGHT_WINDOW,
  // helpers
  hmsToMin,
  catOf,
  shiftByClockIn,
  SHIFT_WINDOWS,
  parseMDY,
  toISO,
  weekStartMonday,
  weekEndSunday,
  // core
  computeSpan,
  nightOverlap,
  enrich,
  enrichAll,
  weeklyOvertime,
};
