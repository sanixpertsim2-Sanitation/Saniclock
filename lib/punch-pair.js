/**
 * lib/punch-pair.js — schedule-free punch pairing from the raw NGTeco stream
 * ===========================================================================
 * Consumes the "View Attendance Punch" export (Person ID, Person Name,
 * Punch Date, Attendance record, Verify Type, TimeZone, Source) and pairs
 * punches WITHOUT any day boundary or shift template, eliminating the
 * night-shift Day-Change-Time 10:00 casualty: a night-assigned employee who
 * fluctuates onto a morning/afternoon shift gets full hours automatically.
 *
 * Pairing model (per employee, punches sorted ascending):
 *   1. BURST CLUSTERING — consecutive punches within DEDUP_MIN (15 min) of the
 *      previous punch collapse into one cluster (double-scans, re-badging).
 *   2. ALTERNATION — clusters alternate IN, OUT, IN, OUT. An IN cluster uses
 *      its FIRST punch (earliest = employee-favorable), an OUT cluster its
 *      LAST punch. A pair is accepted when out.last - in.first <= 16h
 *      (MAX_SHIFT_MIN); otherwise the IN is an orphan (missing clock-out) and
 *      the rejected cluster starts the next shift.
 *   3. ATTRIBUTION — the shift belongs to the calendar day of its IN punch
 *      (shift-start attribution, same as lib/time-engine). Band is detected
 *      from the IN time: 06:00–10:59 Day, 11:00–18:59 Afternoon, else Night.
 *   4. A trailing unpaired cluster = an open punch (live worker or missing
 *      clock-out — downstream flags decide).
 *
 * Emitted records use the SAME shape as scale.js loadData() rows, so
 * time-engine.enrichAll / integrity / paysheet consume them unchanged.
 * breakMin defaults to 30 (the company-wide auto-deduction NGTeco applies),
 * so netMin is directly comparable to NGTeco's "Total Work Time".
 *
 * pairingAudit() cross-checks our pairing against NGTeco's paired timecard
 * records and classifies every person-day: MATCH / DIFFER / RECOVERED (we
 * found hours NGTeco dropped) / MISSING_IN_OURS.
 *
 * Pure functions, NO I/O. Dependency-free.
 */
'use strict';

const DEDUP_MIN = 15;          // punches closer than this collapse into one cluster
// Longest believable single shift FOR PAIRING. Real shifts here are 8h/12h
// (max observed ~12.5h + OT margin). Gaps beyond 14h are almost always two
// orphan single-punches (verified on real data: a night-leader's 07:04 out and
// 23:00 next in must NOT pair as one 15h56m shift). time-engine's 16h ceiling
// still governs plausibility of already-paired records.
const MAX_SHIFT_MIN = 14 * 60;
const DEFAULT_BREAK_MIN = 30;  // company-wide auto-deduction (NGTeco convention)
const AUDIT_TOLERANCE_MIN = 2; // |ours - NGTeco| <= this counts as a match

// --- parsing -----------------------------------------------------------------

function splitCsvLine(line) {
  const cols = []; let cur = ''; let inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

function mdyToDayIndex(mdy) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(mdy || '').trim());
  if (!m) return null;
  return Math.round(Date.UTC(+m[3], +m[1] - 1, +m[2]) / 86400000);
}

function hmsToMin(hms) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(hms || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * parseRawPunchCsv(text) -> { ok, events, error? }
 * events: [{ pid, person, dateMDY, hms, absMin, verify, source }] (unsorted)
 */
function parseRawPunchCsv(text) {
  text = String(text == null ? '' : text).replace(/^﻿/, '');
  if (!text.trim()) return { ok: false, error: 'empty raw punch CSV', events: [] };
  const lines = text.trim().split(/\r?\n/);
  const header = splitCsvLine(lines[0]);
  const idx = name => header.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const col = {
    pid: idx('Person ID'), person: idx('Person Name'),
    date: idx('Punch Date'), time: idx('Attendance record'),
    verify: idx('Verify Type'), source: idx('Source'),
  };
  if (col.pid < 0 || col.date < 0 || col.time < 0) {
    return { ok: false, error: 'not a raw punch CSV (need Person ID / Punch Date / Attendance record columns)', events: [] };
  }
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = splitCsvLine(lines[i]);
    const get = j => (j >= 0 && j < c.length ? c[j] : '');
    const dateMDY = get(col.date);
    const hms = get(col.time);
    const di = mdyToDayIndex(dateMDY);
    const tm = hmsToMin(hms);
    if (di === null || tm === null) continue;
    events.push({
      pid: get(col.pid), person: get(col.person) || get(col.pid),
      dateMDY, hms,
      absMin: di * 1440 + tm,
      verify: get(col.verify), source: get(col.source),
    });
  }
  return { ok: true, events };
}

// --- pairing -----------------------------------------------------------------

function bandFromMin(minOfDay) {
  if (minOfDay >= 360 && minOfDay <= 659) return 'Day';
  if (minOfDay >= 660 && minOfDay <= 1139) return 'Afternoon';
  return 'Night';
}

/**
 * pairEvents(events, opts?) -> records[] (loadData-compatible)
 * opts.shiftByPid — optional {pid: timesheetName} map (from the timecard CSV)
 *   used to label records with the employee's assigned template; the DETECTED
 *   band always goes in record.pairedBand.
 */
function pairEvents(events, opts) {
  opts = opts || {};
  const shiftByPid = opts.shiftByPid || {};
  const dedupMin = opts.dedupMin || DEDUP_MIN;
  const maxShiftMin = opts.maxShiftMin || MAX_SHIFT_MIN;

  // group by pid
  const byPid = Object.create(null);
  for (const ev of events || []) {
    if (!byPid[ev.pid]) byPid[ev.pid] = [];
    byPid[ev.pid].push(ev);
  }

  const records = [];
  for (const pid in byPid) {
    const list = byPid[pid].slice().sort((a, b) => a.absMin - b.absMin);

    // 1. burst clustering
    const clusters = [];
    for (const ev of list) {
      const last = clusters[clusters.length - 1];
      if (last && ev.absMin - last.last.absMin <= dedupMin) {
        last.last = ev;
        last.count++;
      } else {
        clusters.push({ first: ev, last: ev, count: 1 });
      }
    }

    // 2. alternate pairing
    let i = 0;
    while (i < clusters.length) {
      const inC = clusters[i];
      const outC = clusters[i + 1] || null;
      const person = inC.first.person;
      const band = bandFromMin(inC.first.absMin % 1440);
      const assigned = shiftByPid[pid] || '';

      if (outC && (outC.last.absMin - inC.first.absMin) <= maxShiftMin) {
        records.push({
          person, pid,
          date: inC.first.dateMDY,
          shift: assigned || band,
          pairedBand: band,
          clockIn: inC.first.hms,
          clockOut: outC.last.hms,
          workMin: null, otMin: null, totalMin: null,
          breakMin: DEFAULT_BREAK_MIN,
          abnormal: '',
          status: 'done',
          pairedByEngine: true,
          punchCount: inC.count + outC.count,
          sourceIn: inC.first.source, sourceOut: outC.last.source,
        });
        i += 2;
      } else {
        // orphan IN — no believable OUT
        records.push({
          person, pid,
          date: inC.first.dateMDY,
          shift: assigned || band,
          pairedBand: band,
          clockIn: inC.first.hms,
          clockOut: '',
          workMin: null, otMin: null, totalMin: null,
          breakMin: 0,
          abnormal: '',
          status: 'in',
          pairedByEngine: true,
          punchCount: inC.count,
          sourceIn: inC.first.source, sourceOut: '',
        });
        i += 1;
      }
    }
  }

  records.sort((a, b) => (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0) ||
    (mdyToDayIndex(a.date) - mdyToDayIndex(b.date)));
  return records;
}

// --- audit: our pairing vs NGTeco's paired timecard ---------------------------

/** gross minutes of a paired record (overnight-aware); null when incomplete */
function grossOf(rec) {
  const ci = hmsToMin(rec.clockIn), co = hmsToMin(rec.clockOut);
  if (ci === null || co === null) return null;
  return co >= ci ? co - ci : (1440 - ci) + co;
}

/**
 * pairingAudit(ourRecords, ngtecoRecords, opts?) -> { summary, items }
 *
 * PAIRING-vs-PAIRING comparison: our gross (in->out span) against NGTeco's
 * gross recomputed from ITS in/out punches — break-deduction conventions
 * differ per template and are applied downstream, so they are deliberately
 * excluded here. Joins on pid + date-of-clock-in.
 *
 * opts.startISO / opts.endISO — clamp both sides to the window BOTH sources
 * fully cover (a stale daily-email CSV vs a fresher raw export would
 * otherwise report every uncovered day as "recovered").
 *
 * Classes:
 *   RECOVERED       — we paired a full shift; NGTeco has no usable in+out pair
 *   DIFFER          — both paired, spans disagree beyond tolerance
 *   MATCH           — agree within tolerance (counted, not emitted)
 *   OPEN            — our orphan IN (no believable OUT) — genuine missing punch
 *   MISSING_IN_OURS — NGTeco paired hours on a day we produced nothing
 */
function pairingAudit(ourRecords, ngtecoRecords, opts) {
  opts = opts || {};
  const startDi = opts.startISO ? Math.round(Date.parse(opts.startISO + 'T00:00:00Z') / 86400000) : null;
  const endDi = opts.endISO ? Math.round(Date.parse(opts.endISO + 'T00:00:00Z') / 86400000) : null;
  const inWindow = mdy => {
    const di = mdyToDayIndex(mdy);
    if (di === null) return false;
    if (startDi !== null && di < startDi) return false;
    if (endDi !== null && di > endDi) return false;
    return true;
  };

  const ng = Object.create(null);
  for (const r of ngtecoRecords || []) {
    if (!inWindow(r.date)) continue;
    ng[(r.pid || '') + '|' + (r.date || '')] = r;
  }
  const ourKeys = Object.create(null);

  const items = [];
  let match = 0, differ = 0, recovered = 0, open = 0, recoveredMin = 0, ourShifts = 0;

  for (const r of ourRecords || []) {
    if (!inWindow(r.date)) continue;
    ourShifts++;
    const key = (r.pid || '') + '|' + (r.date || '');
    ourKeys[key] = true;
    const gross = grossOf(r);

    if (gross === null) {
      open++;
      // A pre-14:00 orphan on the window's FIRST day is usually the OUT of a
      // shift that started before the export window — an artifact, not a miss.
      const di = mdyToDayIndex(r.date);
      const edge = startDi !== null && di === startDi && (hmsToMin(r.clockIn) || 0) < 840;
      items.push({ class: 'OPEN', pid: r.pid, person: r.person, date: r.date,
        band: r.pairedBand, ourIn: r.clockIn, ourOut: '', windowEdge: edge,
        note: edge
          ? 'window edge — likely the OUT of a shift that started before the export begins'
          : 'unpaired punch — genuine missing clock-out/in, needs mending' });
      continue;
    }
    const n = ng[key];
    const ngGross = n ? grossOf(n) : null;

    if (ngGross === null) {
      recovered++;
      recoveredMin += gross;
      items.push({ class: 'RECOVERED', pid: r.pid, person: r.person, date: r.date,
        band: r.pairedBand, ourIn: r.clockIn, ourOut: r.clockOut, ourGrossMin: gross,
        ngtecoIn: n ? n.clockIn : '', ngtecoOut: n ? n.clockOut : '',
        note: 'we paired ' + Math.floor(gross / 60) + 'h' + String(gross % 60).padStart(2, '0') +
          ' — NGTeco has no usable pair for this day' });
      continue;
    }
    if (Math.abs(gross - ngGross) <= AUDIT_TOLERANCE_MIN) { match++; continue; }
    differ++;
    items.push({ class: 'DIFFER', pid: r.pid, person: r.person, date: r.date,
      band: r.pairedBand, ourIn: r.clockIn, ourOut: r.clockOut, ourGrossMin: gross,
      ngtecoIn: n.clockIn, ngtecoOut: n.clockOut, ngtecoGrossMin: ngGross,
      deltaMin: gross - ngGross });
  }

  for (const key in ng) {
    if (ourKeys[key]) continue;
    const n = ng[key];
    if (grossOf(n) !== null) {
      items.push({ class: 'MISSING_IN_OURS', pid: n.pid, person: n.person, date: n.date,
        ngtecoIn: n.clockIn, ngtecoOut: n.clockOut, ngtecoGrossMin: grossOf(n),
        note: 'NGTeco paired hours on a day our pairing produced none' });
    }
  }

  const order = { RECOVERED: 0, DIFFER: 1, MISSING_IN_OURS: 2, OPEN: 3 };
  items.sort((a, b) => (order[a.class] - order[b.class]) ||
    String(a.person).localeCompare(String(b.person)));

  return {
    summary: {
      ourShifts, match, differ, recovered, open,
      missingInOurs: items.filter(x => x.class === 'MISSING_IN_OURS').length,
      recoveredMin,
      window: { start: opts.startISO || null, end: opts.endISO || null },
    },
    items,
  };
}

module.exports = {
  DEDUP_MIN,
  MAX_SHIFT_MIN,
  DEFAULT_BREAK_MIN,
  parseRawPunchCsv,
  pairEvents,
  pairingAudit,
  bandFromMin,
  grossOf,
  mdyToDayIndex,
};
