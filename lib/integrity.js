/**
 * lib/integrity.js — anomaly / buddy-punch / meal / rounding audit
 * ===========================================================================
 * Phase-1 payroll-integrity detectors for the punch/attendance system.
 * Pure functions over the frozen EnrichedPunch contract (spec §1.3). None throw;
 * every detector returns structured Flag objects (or null / []).
 *
 *   Flag { code, severity:"info"|"warn"|"error", pid, date, message, meta? }
 *
 * Ontario ESA rules encoded here (spec §3):
 *   R2  30-minute eating period after MORE THAN 5 consecutive hours worked
 *       (ESA 2000 s.20(1)) -> mealViolation(): grossMin > 300 && breakMin < 30.
 *   R3  Exact-minute / no unfavourable rounding -> roundingAudit() surfaces CSV
 *       under-crediting (deltaMin > 1) so payroll can correct it.
 *
 * PHASE-2 GAPS (documented limitations — NOT fixed here, do not assume so):
 *   - Meal-BREAK PLACEMENT is unverifiable: the CSV gives only TOTAL break
 *     minutes, not when the break fell. Phase-1 can only confirm a compliant
 *     total exists, not that it landed before the 5th consecutive hour. §2.3.
 *   - DST / timezone correctness: spans are naive 1440-min days (time-engine).
 *   - Midnight hour-splitting: shift-start attribution only.
 *   - Public-holiday / stat premium: out of scope.
 *
 * Dependency graph (spec §6): integrity.js -> requires time-engine.js for the
 * MAX_PLAUSIBLE_SHIFT_MIN constant. The require is soft (local fallback) so this
 * module + its tests run standalone before Squad A lands time-engine.js; both
 * define 960, so they agree once wired together.
 */
'use strict';

// --- Soft dependency on time-engine for the plausibility ceiling ------------
let MAX_PLAUSIBLE_SHIFT_MIN = 16 * 60; // 960 — fallback identical to time-engine
try {
  // eslint-disable-next-line global-require
  const te = require('./time-engine');
  if (te && typeof te.MAX_PLAUSIBLE_SHIFT_MIN === 'number') {
    MAX_PLAUSIBLE_SHIFT_MIN = te.MAX_PLAUSIBLE_SHIFT_MIN;
  }
} catch (_) { /* time-engine not present yet — use fallback */ }

// Categories treated as *daytime* families for the OUT_BEFORE_IN guard. Night
// and P2 legitimately cross midnight, so an out<in read is believed for them.
const DAYTIME_FAMILIES = new Set([
  'Day', 'Afternoon', 'Leadership', 'Clark', 'Janitor', 'Other',
]);

const MEAL_MAX_UNBROKEN_MIN = 300; // 5h — "more than" 5h triggers, exactly 5h does not
const MEAL_MIN_BREAK_MIN = 30;     // required eating period
const ROUNDING_TOLERANCE_MIN = 1;  // > 1 minute against the employee is flagged

// --- helpers ----------------------------------------------------------------

function hasBothPunches(e) {
  return !!(e && e.clockIn && e.clockOut);
}

function mkFlag(code, severity, pid, date, message, meta) {
  const f = { code, severity, pid, date, message };
  if (meta !== undefined) f.meta = meta;
  return f;
}

// --- 2.1 Per-record anomaly detectors --------------------------------------

/**
 * anomalies(enriched) -> Flag[]
 * Per-record structural anomalies. Ordered deterministically.
 */
function anomalies(e) {
  const flags = [];
  if (!e) return flags;
  const pid = e.pid;
  const date = e.date;

  // OUTSIDE_WINDOW — a present punch whose stamp is malformed (out of 0..1439).
  // time-engine surfaces this as a null minutes value on a non-empty stamp.
  const inMalformed = !!e.clockIn && (e.clockInMin === null || e.clockInMin === undefined);
  const outMalformed = !!e.clockOut && (e.clockOutMin === null || e.clockOutMin === undefined);
  if (inMalformed || outMalformed) {
    flags.push(mkFlag('OUTSIDE_WINDOW', 'error', pid, date,
      'Punch stamp outside 00:00–23:59 (malformed time value).',
      { clockIn: e.clockIn, clockOut: e.clockOut,
        clockInMin: e.clockInMin, clockOutMin: e.clockOutMin }));
  }

  // MISSING_OUT — clock-in present, clock-out absent.
  if (e.clockIn && !e.clockOut) {
    flags.push(mkFlag('MISSING_OUT', 'warn', pid, date,
      'Clock-in with no clock-out (open/incomplete punch).',
      { clockIn: e.clockIn }));
  }

  // SUB_MINUTE_SHIFT — both punches present but the worked span rounds to 0min
  // (includes clockOut === clockIn, which the engine treats as 0, NOT 24h).
  if (hasBothPunches(e) && e.grossMin !== null && e.grossMin !== undefined && e.grossMin < 1) {
    flags.push(mkFlag('SUB_MINUTE_SHIFT', 'error', pid, date,
      'Worked span is under one minute (likely a mis-punch or immediate re-punch).',
      { grossMin: e.grossMin, clockIn: e.clockIn, clockOut: e.clockOut }));
  }

  // OUT_BEFORE_IN — a DAYTIME shift reading out<in with an implausibly long
  // implied overnight span ⇒ reversed/erroneous punch, not a real night shift.
  if (hasBothPunches(e) &&
      e.clockOutMin !== null && e.clockOutMin !== undefined &&
      e.clockInMin !== null && e.clockInMin !== undefined &&
      e.clockOutMin < e.clockInMin &&
      DAYTIME_FAMILIES.has(e.category) &&
      typeof e.grossMin === 'number' && e.grossMin > MAX_PLAUSIBLE_SHIFT_MIN) {
    flags.push(mkFlag('OUT_BEFORE_IN', 'error', pid, date,
      'Clock-out earlier than clock-in on a daytime shift with an implausible ' +
      'overnight span — likely a reversed or erroneous punch.',
      { clockIn: e.clockIn, clockOut: e.clockOut, category: e.category,
        impliedSpanMin: e.grossMin }));
  }

  // IMPLAUSIBLE_LENGTH — payable span exceeds the plausibility ceiling (16h).
  if (typeof e.netMin === 'number' && e.netMin > MAX_PLAUSIBLE_SHIFT_MIN) {
    flags.push(mkFlag('IMPLAUSIBLE_LENGTH', 'warn', pid, date,
      'Payable span exceeds ' + (MAX_PLAUSIBLE_SHIFT_MIN / 60) + 'h — verify punches.',
      { netMin: e.netMin }));
  }

  return flags;
}

// --- 2.2 Buddy-punch / cross-record detectors ------------------------------

/**
 * buddyPunch(enrichedList) -> Flag[]
 * DUPLICATE_PUNCH  — ≥2 records share pid + date + identical clockIn (same sec).
 * OVERLAPPING_SHIFT — same pid, same date, two intervals overlap in wall-clock.
 */
function buddyPunch(list) {
  const flags = [];
  if (!Array.isArray(list) || list.length === 0) return flags;

  // --- DUPLICATE_PUNCH: group by pid|date|clockIn (exact stamp string) ---
  const dupGroups = new Map();
  for (const e of list) {
    if (!e || !e.clockIn) continue;
    const key = e.pid + '|' + e.date + '|' + e.clockIn;
    if (!dupGroups.has(key)) dupGroups.set(key, []);
    dupGroups.get(key).push(e);
  }
  for (const [, group] of dupGroups) {
    if (group.length >= 2) {
      const g = group[0];
      flags.push(mkFlag('DUPLICATE_PUNCH', 'warn', g.pid, g.date,
        group.length + ' punches share an identical clock-in time (' + g.clockIn +
        ') — possible buddy-punch or double scan.',
        { clockIn: g.clockIn, count: group.length,
          persons: [...new Set(group.map(x => x.person))] }));
    }
  }

  // --- OVERLAPPING_SHIFT: per pid|date, compare interval pairs ---
  // Build wall-clock intervals; overnight spans extend clockOut by 24h so the
  // comparison is in a single monotonic timeline.
  const byPidDate = new Map();
  for (const e of list) {
    if (!hasBothPunches(e)) continue;
    if (e.clockInMin === null || e.clockInMin === undefined) continue;
    if (e.clockOutMin === null || e.clockOutMin === undefined) continue;
    const start = e.clockInMin;
    const end = e.overnight ? e.clockOutMin + 1440 : e.clockOutMin;
    if (end <= start) continue; // zero/negative-length (sub-minute) — skip
    const key = e.pid + '|' + e.date;
    if (!byPidDate.has(key)) byPidDate.set(key, []);
    byPidDate.get(key).push({ e, start, end });
  }
  for (const [, ivals] of byPidDate) {
    if (ivals.length < 2) continue;
    ivals.sort((a, b) => a.start - b.start);
    for (let i = 0; i < ivals.length; i++) {
      for (let j = i + 1; j < ivals.length; j++) {
        const a = ivals[i];
        const b = ivals[j];
        // sorted by start, so a.start <= b.start; overlap iff b starts before a ends
        if (b.start < a.end) {
          flags.push(mkFlag('OVERLAPPING_SHIFT', 'warn', a.e.pid, a.e.date,
            'Two same-day shifts overlap in wall-clock time — a person cannot be ' +
            'in two places at once.',
            { a: { clockIn: a.e.clockIn, clockOut: a.e.clockOut },
              b: { clockIn: b.e.clockIn, clockOut: b.e.clockOut } }));
        }
      }
    }
  }

  return flags;
}

// --- 2.3 Meal / eating-period violation (ESA s.20) -------------------------

/**
 * mealViolation(enriched) -> Flag | null
 * ESA s.20(1): no work of MORE THAN 5 consecutive hours without a 30-min
 * eating period. Phase-1 verifies only that a compliant TOTAL break exists —
 * placement (break before the 5th hour) is unverifiable from this CSV (§2.3).
 */
function mealViolation(e) {
  if (!e) return null;
  if (typeof e.grossMin !== 'number') return null;
  const brk = typeof e.breakMin === 'number' ? e.breakMin : 0;
  if (e.grossMin > MEAL_MAX_UNBROKEN_MIN && brk < MEAL_MIN_BREAK_MIN) {
    return mkFlag('MEAL_PERIOD', 'warn', e.pid, e.date,
      'Worked ' + e.grossMin + ' min (>5h) with only ' + brk +
      ' min break — below the 30-min ESA eating period.',
      { grossMin: e.grossMin, breakMin: brk,
        note: 'Total-break check only; break placement not verifiable in Phase-1.' });
  }
  return null;
}

// --- 2.35 NGTeco night-boundary shift-mismatch detector ----------------------

/**
 * shiftMismatch(enriched) -> Flag | null
 * NGTeco night-shift day-boundary casualty detector. A pure-Night-assigned
 * employee whose clock-IN lands in the day/afternoon window (06:00–18:59)
 * "fluctuated" onto a day shift. NGTeco's Night timesheet has Day Change Time
 * 10:00, so their pre-10:00 punch is attributed to the PREVIOUS attendance day
 * and First-and-Last pairing truncates/loses the real day's hours — the case
 * that historically needed manual mending.
 *
 * Only PURE night templates are checked ("Night Shift", "P2 Night",
 * "Night ( Leadership )", "Night Clark"). Mixed templates (containing day/aft
 * or a "/") legitimately span bands and are skipped.
 */
function shiftMismatch(e) {
  if (!e || !e.clockIn) return null;
  if (typeof e.clockInMin !== 'number' || !isFinite(e.clockInMin)) return null;
  const s = String(e.shift || '').toLowerCase();
  const pureNight = s.indexOf('night') > -1 &&
    s.indexOf('day') === -1 && s.indexOf('aft') === -1 && s.indexOf('/') === -1;
  if (!pureNight) return null;
  const ci = e.clockInMin;
  // 06:00–17:59 = genuine day/afternoon start. 18:00+ is treated as a normal
  // early arrival for a 19:00 night shift, not a fluctuation.
  if (ci < 360 || ci > 1079) return null;
  const band = ci <= 659 ? 'Day' : 'Afternoon';
  return mkFlag('SHIFT_MISMATCH', 'warn', e.pid, e.date,
    'Clock-in ' + e.clockIn + ' is a ' + band + ' start but assigned shift is "' +
    (e.shift || '?') + '" — NGTeco\'s 10:00 night day-boundary may have cut this day\'s hours; verify punches',
    { clockInMin: ci, detectedBand: band });
}

// --- 2.4 Rounding-neutrality audit -----------------------------------------

/**
 * roundingAudit(enriched) -> Flag | null
 * Compares CSV-provided workMin against our exact-minute netMin. A positive
 * delta means the CSV credited the employee LESS than exact time worked.
 * Flags ROUNDING_UNFAVORABLE when deltaMin > 1.
 */
function roundingAudit(e) {
  if (!e) return null;
  if (typeof e.netMin !== 'number') return null;          // no payable minutes to compare
  if (typeof e.workMin !== 'number') return null;         // no CSV reference
  const deltaMin = e.netMin - e.workMin;
  if (deltaMin > ROUNDING_TOLERANCE_MIN) {
    return mkFlag('ROUNDING_UNFAVORABLE', 'warn', e.pid, e.date,
      'CSV credited ' + e.workMin + ' min but exact time worked is ' + e.netMin +
      ' min — employee under-credited by ' + deltaMin + ' min.',
      { csvMin: e.workMin, computedMin: e.netMin, deltaMin });
  }
  return null;
}

// --- 2.5 Roll-up convenience -----------------------------------------------

/**
 * auditAll(enrichedList) -> { flags, byPid, counts }
 * Runs every per-record detector plus cross-record buddyPunch over the list.
 */
function auditAll(list) {
  const flags = [];
  if (Array.isArray(list)) {
    for (const e of list) {
      for (const f of anomalies(e)) flags.push(f);
      const meal = mealViolation(e);
      if (meal) flags.push(meal);
      const sm = shiftMismatch(e);
      if (sm) flags.push(sm);
      const round = roundingAudit(e);
      if (round) flags.push(round);
    }
    for (const f of buddyPunch(list)) flags.push(f);
  }

  const byPid = {};
  const counts = {};
  for (const f of flags) {
    if (!byPid[f.pid]) byPid[f.pid] = [];
    byPid[f.pid].push(f);
    counts[f.code] = (counts[f.code] || 0) + 1;
  }
  return { flags, byPid, counts };
}

module.exports = {
  anomalies,
  buddyPunch,
  mealViolation,
  shiftMismatch,
  roundingAudit,
  auditAll,
  // exported for cross-module consistency / testing
  MAX_PLAUSIBLE_SHIFT_MIN,
  DAYTIME_FAMILIES,
};
