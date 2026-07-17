/**
 * lib/device-live.js — normalizes raw NG-TC4/ZKTeco device records into the
 * SAME row shape parseRawPunchCsv() (lib/punch-pair.js) already produces from
 * a manually-exported "View Attendance Punch" CSV. This is the whole point:
 * a live punch from the physical clock and a punch from a manual CSV export
 * become indistinguishable the moment they're normalized, so pairEvents(),
 * pairingAudit(), time-engine, and paysheet all consume live data with ZERO
 * changes.
 *
 * Field names below are defensive, not confirmed — the zkteco-js library
 * returns loosely-documented records and NGTeco's exact wire format for our
 * unit is still unverified (see device-listener.js header + tc4-probe.ts in
 * the gateway package for the confirmation step). Every plausible field-name
 * alias seen across the ZKTeco JS ecosystem is tried before falling back.
 *
 * Pure functions, NO I/O. Dependency-free (mirrors lib/punch-pair.js style).
 */
'use strict';

function firstDefined(...values) {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** Coerce whatever the device library handed us for a timestamp into a Date. */
function coerceDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * mapZkAttendance(record) -> { pid, dateMDY, hms, verify, source } | null
 * Same field shape parseRawPunchCsv() emits per-row (before pairing), using
 * LOCAL time (the device reports local time; NGTeco's CSV export does too —
 * see SYSTEM-BIBLE, timezones are DST-naive on both sides already).
 *
 * Field names are CONFIRMED against the installed zkteco-js@1.7.2 source
 * (src/helper/utils.js decodeRecordData40 / decodeRecordRealTimeLog18/52),
 * not guessed: backfill (getAttendances) records use `user_id`/`record_time`
 * (record_time is a Date.toString() string); real-time (getRealTimeLogs)
 * records use `userId`/`attTime` (attTime is a raw Date object) — the two
 * paths use DIFFERENT casing/shape in this library version, so both are
 * covered. Older aliases (deviceUserId, uid, userSn, recordTime, timestamp)
 * are kept as a defensive fallback in case a future library version or a
 * device firmware quirk changes the shape again.
 */
function mapZkAttendance(record) {
  if (!record || typeof record !== 'object') return null;

  const pidRaw = firstDefined(
    record.user_id, record.userId, record.deviceUserId, record.uid, record.userSn,
  );
  if (pidRaw === undefined) return null;
  const pid = String(pidRaw);

  const tsRaw = firstDefined(record.attTime, record.record_time, record.recordTime, record.timestamp);
  const d = coerceDate(tsRaw);
  if (!d) return null;

  const dateMDY = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  const hms = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

  const verify = String(firstDefined(record.verifyType, record.verify_type, record.type, '') ?? '');
  const source = String(firstDefined(record.ip, record.deviceIp, record.source, '') ?? '');

  return { pid, dateMDY, hms, verify, source };
}

/** Stable idempotency key for a mapped record — used to dedupe backfill vs
 * already-persisted rows across listener restarts. */
function dedupeKeyFor(mapped) {
  return `${mapped.pid}|${mapped.dateMDY}|${mapped.hms}`;
}

const CSV_HEADER = 'Person ID,Person Name,Punch Date,Attendance record,Verify Type,TimeZone,Source';

/**
 * lib/punch-pair.js's splitCsvLine() is a naive parser (toggles on any `"`,
 * no doubled-quote escaping) — it cannot round-trip a properly RFC4180-quoted
 * field. Sanitize instead of escape: strip commas/quotes/newlines so every
 * row we write is safely re-parsed by the ACTUAL consumer, not a spec it
 * doesn't implement. Device-reported names are plain (no punctuation in
 * practice), so this is a no-op for real data.
 */
function csvEscape(value) {
  const s = String(value == null ? '' : value);
  return s.replace(/["\r\n]/g, '').replace(/,/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Render one CSV row in the exact column order parseRawPunchCsv() expects.
 * personName may be unknown (device only reports the numeric id) — falls
 * back to the pid, matching parseRawPunchCsv's own `get(col.person) ||
 * get(col.pid)` fallback so downstream code never sees a blank name. */
function toRawCsvRow(mapped, personName) {
  const name = personName || mapped.pid;
  return [
    csvEscape(mapped.pid),
    csvEscape(name),
    csvEscape(mapped.dateMDY),
    csvEscape(mapped.hms),
    csvEscape(mapped.verify),
    '',
    csvEscape(mapped.source),
  ].join(',');
}

module.exports = {
  CSV_HEADER,
  mapZkAttendance,
  dedupeKeyFor,
  toRawCsvRow,
};
