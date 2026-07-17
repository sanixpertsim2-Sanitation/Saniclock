/**
 * SaniClock Dashboard — FINAL (flagship synthesis)
 * (formerly "Punch System Dashboard" — renamed 2026-07-09, same engine)
 * ===========================================================================
 * A single-file, ZERO-dependency (Node built-ins only: http, fs, path) live
 * attendance / punch console for a ~100-person facility. Synthesises the best
 * of four candidate directions into one superior dashboard:
 *
 *   • DATA LAYER  — the proven RFC-4180 quote-aware parser + loader from
 *                   scale.js, ported verbatim (672 records / 7 dates verified).
 *                   The CSV is re-read on every /api/punches so a fresh export
 *                   appears live without a restart.
 *   • CHARTS      — four hand-drawn inline-SVG charts (no libraries):
 *                   7-day headcount trend, roster-by-shift donut with an
 *                   interactive legend, hours-worked-by-shift bars, and a
 *                   clock-in activity histogram stacked by shift.
 *   • LIVE FLOOR  — "Currently on the floor" grid with emerald live language,
 *                   shift filter chips (per-shift counts) that filter floor +
 *                   table, keyboard nav (/ focus, Esc clear, r refresh, Arrow
 *                   date walk), 3-state live indicator, 30s auto-refresh.
 *   • POLISH      — refined type scale + spacing, colourful gradient avatars
 *                   (robust initials — never emits "undefined"), progress bar
 *                   under Present, flawless light AND dark (prefers-color-scheme
 *                   + manual toggle, color-scheme + theme-color).
 *   • EXCEPTIONS  — a clear, filterable exceptions surface combining
 *                   missing-clock-outs and abnormal situations. The Exceptions
 *                   KPI is clickable to filter the table.
 *
 * Bug fixes baked in (all candidates shared these):
 *   A. No fake "on shift" elapsed timers. Live elapsed is computed ONLY when
 *      the selected date is the real current local date AND elapsed is
 *      plausible (>=0 and < 16h). An open punch that is not plausibly live is
 *      treated as a MISSING CLOCK-OUT exception, not "on shift".
 *   B. Dedicated, filterable Exceptions section (missing clock-out + abnormal).
 *   C. Every CSV-derived string is HTML-escaped before injection.
 *
 * Endpoints:  GET /  ·  GET /api/punches  ·  GET /health
 * Config (env):  PORT (default 8020)  ·  PUNCH_CSV (path to the CSV)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- Phase-1 payroll-grade modules (local, dependency-free) ----------------
// Our own math is authoritative; the CSV is a reference we audit against.
const timeEngine = require('./lib/time-engine');   // enrich + Ontario weekly-44 OT
const integrity = require('./lib/integrity');      // meal / anomaly / missing / rounding
const payroll = require('./lib/payroll');          // per-employee period summary + CSV
const analytics = require('./lib/analytics');     // cross-shift ESA rest flags + aggregations
const paysheet = require('./lib/paysheet');       // bi-weekly employer attendance sheet (.xls)
const punchPair = require('./lib/punch-pair');
const ngteco = require('./lib/ngteco-api');
const empAuth = require('./lib/emp-auth');
const mailer = require('./lib/mailer');
const reportMailer = require('./lib/report-mailer');           // per-employee self-service auth       // NGTeco cloud bridge: push employees, enroll fingerprints, real enrolled status    // schedule-free pairing from raw punch stream
const deviceLive = require('./lib/device-live');  // CSV_HEADER/toRawCsvRow — reused so an
                                                   // approved mend-punch is indistinguishable
                                                   // from a real device/CSV punch downstream.
// analytics.js is available for server aggregations; the client keeps its own
// thin renderers, so we require it only where needed (kept for parity/future use).

const PORT = Number(process.env.PORT) || 8000;

// ---- Mend Punch store: manual punch corrections, Add -> pending -> Approve/
// Reject workflow (mirrors NGTeco's own "Mend Attendance Punch" page, which
// SaniClock's dashboard didn't have until now). A flat JSON array — same
// zero-dependency, flat-file philosophy as the rest of this file. Approving a
// record appends it to the resolved raw punch CSV via deviceLive.toRawCsvRow,
// so it flows through punch-pair/time-engine/paysheet identically to a real
// device punch — no special-casing needed anywhere else in the pipeline. -----
const MEND_STORE = path.join(__dirname, 'data', 'mend-punches.json');
function loadMendPunches() {
  try { return JSON.parse(fs.readFileSync(MEND_STORE, 'utf8')); } catch { return []; }
}
function saveMendPunches(list) {
  fs.mkdirSync(path.dirname(MEND_STORE), { recursive: true });
  fs.writeFileSync(MEND_STORE, JSON.stringify(list, null, 2));
}
function newMendId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
const ABSENCE_STORE = path.join(__dirname, 'data', 'absence-requests.json');
function loadAbsences() { try { return JSON.parse(fs.readFileSync(ABSENCE_STORE, 'utf8')); } catch { return []; } }
function saveAbsences(list) { fs.mkdirSync(path.dirname(ABSENCE_STORE), { recursive: true }); fs.writeFileSync(ABSENCE_STORE, JSON.stringify(list, null, 2)); }

// ---- Standalone management stores (Group / Device / Settings) --------------
// SaniClock as a self-owned platform for a NEW facility: employees and devices
// are created and managed HERE, not pulled from NGTeco. Same zero-dependency
// flat-JSON philosophy as the mend store. ------------------------------------
function makeStore(fileName, seed) {
  const file = path.join(__dirname, 'data', fileName);
  return {
    file,
    load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return seed(); } },
    save(v) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v, null, 2)); },
  };
}
const employeeStore = makeStore('employees.json', () => []);
const deviceStore = makeStore('devices.json', () => []);
const settingsStore = makeStore('settings.json', () => ({
  facilityName: 'New Facility', timezone: 'America/Toronto',
  payPeriod: 'bi-weekly', weekStart: 'Monday', otThresholdWeekly: 44, breakMinutes: 30,
}));
function newId(prefix) { return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ---- Session auth (branded in-app login, zero-dependency, node crypto) ------
// Credentials + HMAC secret live in data/.auth.json (0600). Password is stored
// as an scrypt hash — never in plaintext. Sessions are stateless signed tokens
// (payload.HMAC-SHA256) in an HttpOnly/Secure cookie, so no server-side store.
const crypto = require('crypto');
const AUTH_FILE = path.join(__dirname, 'data', '.auth.json');
function seedAuth() {
  const salt = crypto.randomBytes(16).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const user = process.env.SANICLOCK_USER || 'admin';
  const pass = process.env.SANICLOCK_PASS || 'Saniclock2026!';
  const hash = crypto.scryptSync(pass, salt, 64).toString('hex');
  const cfg = { user, salt, hash, secret, seededDefault: !process.env.SANICLOCK_PASS };
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}
function loadAuth() { try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return seedAuth(); } }
let AUTH = loadAuth();
function verifyPassword(pass) {
  try {
    const h = crypto.scryptSync(String(pass || ''), AUTH.salt, 64);
    const stored = Buffer.from(AUTH.hash, 'hex');
    return h.length === stored.length && crypto.timingSafeEqual(h, stored);
  } catch { return false; }
}
const SESSION_HOURS = 12;
function signSession() {
  const payload = Buffer.from(JSON.stringify({ u: AUTH.user, exp: Date.now() + SESSION_HOURS * 3600e3 })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH.secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifySession(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return false;
  const dot = token.lastIndexOf('.');
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', AUTH.secret).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}
function parseCookies(req) {
  const out = {}; (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}
function isAuthed(req) { return verifySession(parseCookies(req).sc_session); }
function changePassword(newPass) {
  const salt = crypto.randomBytes(16).toString('hex');
  AUTH.salt = salt; AUTH.hash = crypto.scryptSync(String(newPass), salt, 64).toString('hex'); AUTH.seededDefault = false;
  fs.writeFileSync(AUTH_FILE, JSON.stringify(AUTH, null, 2), { mode: 0o600 });
}
/** Append an approved mend-punch to whatever raw punch CSV is currently
 * resolved, in the exact "View Attendance Punch" schema, so it's picked up
 * by the normal pairing pipeline on the next read — no separate code path. */
function appendApprovedPunchToCsv(rec) {
  const csvPath = resolveRawPunchCsv();
  const targetPath = csvPath || path.join(__dirname, 'data', 'live-punches.csv');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (!fs.existsSync(targetPath)) fs.writeFileSync(targetPath, deviceLive.CSV_HEADER + '\n');
  const mapped = { pid: rec.pid, dateMDY: rec.dateMDY, hms: rec.hms, verify: 'Mend', source: 'SaniClock-mend' };
  fs.appendFileSync(targetPath, deviceLive.toRawCsvRow(mapped, rec.person) + '\n');
}

// ---- CSV resolution: env override, then sensible defaults ------------------
const CSV_CANDIDATES = [
  process.env.PUNCH_CSV,
  path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads', 'Timecard Report.csv'),
  path.join(__dirname, 'data', 'Timecard Report.csv'),
  path.join(__dirname, 'Timecard Report.csv'),
].filter(Boolean);

function resolveCsvPath() {
  for (const p of CSV_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

// ---- CSV parsing (RFC-4180-ish: quoted fields & embedded commas) -----------
// Ported verbatim from the proven scale.js data layer.
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // swallow; \n handles the row break
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
}

function hmsToMinutes(hms) {
  if (!hms || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(hms.trim())) return 0;
  const [h, m, s] = hms.trim().split(':').map(Number);
  return h * 60 + m + (s || 0) / 60;
}

// ---- Raw punch CSV resolution ("View Attendance Punch" export) --------------
// Fixed candidates first; then the newest Downloads CSV whose header matches
// the raw-punch signature (NGTeco downloads use GUID filenames).
const RAW_PUNCH_HEADER = 'Person ID,Person Name,Punch Date,Attendance record';
function resolveRawPunchCsv() {
  const fixed = [
    process.env.RAW_PUNCH_CSV,
    path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads', 'Punch Report.csv'),
    path.join(__dirname, 'data', 'Punch Report.csv'),
  ].filter(Boolean);
  for (const p of fixed) { try { if (fs.existsSync(p)) return p; } catch (_) { } }
  try {
    const dl = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads');
    const files = fs.readdirSync(dl)
      .filter(f => f.toLowerCase().endsWith('.csv'))
      .map(f => { const p = path.join(dl, f); return { p, m: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => b.m - a.m)
      .slice(0, 25);
    for (const x of files) {
      try {
        const fd = fs.openSync(x.p, 'r');
        const buf = Buffer.alloc(80);
        fs.readSync(fd, buf, 0, 80, 0);
        fs.closeSync(fd);
        if (buf.toString('utf8').replace(/^﻿/, '').startsWith(RAW_PUNCH_HEADER)) return x.p;
      } catch (_) { }
    }
  } catch (_) { }
  return null;
}

function loadData() {
  const csvPath = resolveCsvPath();
  if (!csvPath) return { ok: false, error: 'No CSV found', candidates: CSV_CANDIDATES, records: [], dates: [], count: 0 };
  let raw;
  try { raw = fs.readFileSync(csvPath, 'utf8'); }
  catch (e) { return { ok: false, error: String(e), records: [], dates: [], count: 0 }; }

  const rows = parseCsv(raw);
  if (!rows.length) return { ok: false, error: 'Empty CSV', csvPath, records: [], dates: [], count: 0 };

  const header = rows[0].map(h => h.trim());
  const idx = name => header.indexOf(name);
  const col = {
    person: idx('Person Name'), pid: idx('Person ID'), date: idx('Date'),
    shift: idx('Timesheet'), in: idx('Clock In'), out: idx('Clock Out'),
    work: idx('Total Work Time(h)'), ot: idx('Total Overtime Time(h)'),
    total: idx('Total Time(h)'), brk: idx('Total Break Time(h)'),
    abnormal: idx('Abnormal Situation'),
  };

  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = i => (i >= 0 && i < row.length ? (row[i] || '').trim() : '');
    const clockIn = get(col.in);
    const clockOut = get(col.out);
    if (!get(col.person) && !get(col.date)) continue;
    records.push({
      person: get(col.person),
      pid: get(col.pid),
      date: get(col.date),
      shift: get(col.shift),
      clockIn, clockOut,
      workMin: hmsToMinutes(get(col.work)),
      otMin: hmsToMinutes(get(col.ot)),
      totalMin: hmsToMinutes(get(col.total)),
      breakMin: hmsToMinutes(get(col.brk)),
      abnormal: get(col.abnormal),
      status: clockIn && !clockOut ? 'in' : (clockIn && clockOut ? 'done' : 'absent'),
    });
  }

  const dates = [...new Set(records.map(r => r.date).filter(Boolean))].sort((a, b) => {
    const pa = a.split('/'), pb = b.split('/');
    return new Date(+pb[2], +pb[0] - 1, +pb[1]) - new Date(+pa[2], +pa[0] - 1, +pa[1]);
  });

  return { ok: true, csvPath, records, dates, count: records.length };
}

// ---- LIVE mode: source records from raw device punches instead of an NGTeco
// timecard export. For a new facility whose clock pushes into SaniClock's own
// iclock receiver, there IS no vendor timecard.csv — only the raw punch stream.
// We pair it with our own engine (identical output shape to loadData rows) and
// fill names/shifts from the managed employee roster. Gated by SANICLOCK_LIVE=1
// so the existing CSV-export path is untouched until we flip it on. ----------
function loadLiveData() {
  const rawPath = resolveRawPunchCsv() || path.join(__dirname, 'data', 'live-punches.csv');
  let rawText = '';
  try { rawText = fs.readFileSync(rawPath, 'utf8'); }
  catch (e) { return { ok: true, csvPath: rawPath, records: [], dates: [], count: 0 }; } // no punches yet = empty, not error
  const parsed = punchPair.parseRawPunchCsv(rawText);
  const emps = employeeStore.load();
  const shiftByPid = {}, nameByPid = {};
  for (const e of emps) { if (e.pid != null) { shiftByPid[String(e.pid)] = e.shift || ''; nameByPid[String(e.pid)] = e.person || ''; } }
  const records = punchPair.pairEvents(parsed.events || [], { shiftByPid });
  for (const r of records) { if ((!r.person || r.person === r.pid) && nameByPid[r.pid]) r.person = nameByPid[r.pid]; }
  const dates = [...new Set(records.map(r => r.date).filter(Boolean))].sort((a, b) => {
    const pa = a.split('/'), pb = b.split('/');
    return new Date(+pb[2], +pb[0] - 1, +pb[1]) - new Date(+pa[2], +pa[0] - 1, +pa[1]);
  });
  return { ok: true, csvPath: rawPath, records, dates, count: records.length };
}

// ---- Enrichment: server pre-computes our-own math so the client stays thin --
// Produces EnrichedPunch records (netMin, nightMin, overnight, category,
// workWeekStart, valid, …) each carrying a per-record flags[] ({code,severity,
// message}) from the integrity detectors, plus a facility-wide weeks[] block
// (WeekBucket[] with our Ontario weekly-44 overtime). CSV figures are preserved
// on each record as reference (workMin/otMin).
function buildPayload() {
  const d = process.env.SANICLOCK_LIVE === '1' ? loadLiveData() : loadData();
  if (!d.ok) {
    return { ok: false, records: [], dates: [], count: 0, weeks: [], csvPath: d.csvPath || null, error: d.error || 'load failed' };
  }
  const enriched = timeEngine.enrichAll(d.records);

  // per-record structural + meal + rounding flags
  for (const e of enriched) {
    const fl = integrity.anomalies(e) || [];
    const mv = integrity.mealViolation(e); if (mv) fl.push(mv);
    const sm = integrity.shiftMismatch(e); if (sm) fl.push(sm);
    const rd = integrity.roundingAudit(e); if (rd) fl.push(rd);
    e.flags = fl.map(f => ({ code: f.code, severity: f.severity, message: f.message }));
    e.shiftFamily = timeEngine.catOf(e.shift); // canonical from lib/time-engine.js
    // Live mode: the raw punch stream has no NGTeco timecard totals — fill them
    // from our own engine so every screen shows hours (work=net, total=net+break).
    if (e.workMin == null && e.netMin != null) { e.workMin = e.netMin; if (e.otMin == null) e.otMin = 0; if (e.totalMin == null) e.totalMin = e.netMin + (e.breakMin || 0); }
  }

  // cross-record buddy-punch flags → attach to every record sharing pid+date
  const buddy = integrity.buddyPunch(enriched) || [];
  if (buddy.length) {
    const byKey = new Map();
    for (const e of enriched) {
      const k = e.pid + '|' + e.date;
      let arr = byKey.get(k);
      if (!arr) { arr = []; byKey.set(k, arr); }
      arr.push(e);
    }
    for (const f of buddy) {
      const arr = byKey.get(f.pid + '|' + f.date);
      if (!arr) continue;
      for (const e of arr) e.flags.push({ code: f.code, severity: f.severity, message: f.message });
    }
  }

  // cross-shift ESA rest flags (s.18(1) 11h inter-shift, s.18(4) 24h weekly) → attach to target record
  const restFlags = analytics.restViolations(enriched) || [];
  if (restFlags.length) {
    const byPidDate = new Map();
    for (const e of enriched) {
      const k = (e.pid || '') + '|' + (e.date || '');
      let arr = byPidDate.get(k);
      if (!arr) { arr = []; byPidDate.set(k, arr); }
      arr.push(e);
    }
    for (const f of restFlags) {
      const arr = byPidDate.get((f.pid || '') + '|' + (f.date || ''));
      if (!arr) continue;
      for (const e of arr) e.flags.push({ code: f.code, severity: f.severity, message: f.message });
    }
  }

  const weeks = timeEngine.weeklyOvertime(enriched);
  return { ok: true, records: enriched, dates: d.dates, count: d.count, weeks, csvPath: d.csvPath, error: null };
}

// Accept both MM/DD/YYYY (task/UI native) and YYYY-MM-DD; -> "YYYY-MM-DD" | null.
function normalizeToISO(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return timeEngine.toISO(t); // MM/DD/YYYY -> ISO (or null)
}

// ===========================================================================
// HTML  — one template literal. The client script uses string concatenation
// only (no template literals / no ${…}) so it survives embedding verbatim.
// ===========================================================================
function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<meta name="color-scheme" content="light dark"/>
<meta name="theme-color" content="#f6f6f4" media="(prefers-color-scheme: light)"/>
<meta name="theme-color" content="#0a0b0d" media="(prefers-color-scheme: dark)"/>
<link rel="manifest" href="/manifest.webmanifest"/>
<link rel="icon" href="/icon.svg?v=2" type="image/svg+xml"/>
<link rel="apple-touch-icon" href="/icon-180.png"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<meta name="apple-mobile-web-app-title" content="SaniClock"/>
<title>SaniClock · Time &amp; Attendance</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700,800&f[]=satoshi@400,500,700&display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
/* ============================ Design tokens ============================ */
:root{
  color-scheme: light dark;
  --bg:#f7f7f5; --bg-tint:#eef0ee; --grid:#ececec;
  --surface:#ffffff; --surface-2:#fafafa; --surface-3:#f2f2f0; --surface-hover:#f6f5f3;
  --border:#e2e8f0; --border-strong:#d3dae4;
  --text:#090a0b; --text-2:#475569; --text-3:#94a3b8;
  --accent:#0044ff; --accent-2:#0033cc; --accent-weak:rgba(0,68,255,.08); --accent-line:rgba(0,68,255,.26);
  --emerald:#0f9d63; --emerald-weak:rgba(15,157,99,.12); --emerald-line:rgba(15,157,99,.30); --emerald-glow:rgba(15,157,99,.34);
  --blue:#2563eb; --blue-weak:rgba(37,99,235,.11);
  --amber:#b45309; --amber-weak:rgba(180,83,9,.12);
  --red:#dc2626; --red-weak:rgba(220,38,38,.10); --red-line:rgba(220,38,38,.34);
  --shadow-sm:0 1px 2px rgba(20,18,15,.05);
  --shadow:0 1px 2px rgba(20,18,15,.04), 0 6px 20px -6px rgba(20,18,15,.10);
  --shadow-lg:0 2px 4px rgba(20,18,15,.05), 0 16px 40px -12px rgba(20,18,15,.16);
  /* shift-family colour system (ties charts, chips, dots together) */
  --c-day:#e08a00; --c-aft:#e05b3b; --c-night:#4f46e5; --c-p2:#0ea5b7;
  --c-lead:#9333ea; --c-clark:#0f9d58; --c-jan:#db2777; --c-other:#7b859b;
  --radius:16px; --radius-sm:12px; --radius-xs:9px;
  --serif:"Cabinet Grotesk","Satoshi",ui-sans-serif,system-ui,sans-serif;
  --sans:"Satoshi",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0a0b0d; --bg-tint:#14161b; --grid:#141a29;
    --surface:#101318; --surface-2:#14171d; --surface-3:#1a1f27; --surface-hover:#1a1f27;
    --border:#20242c; --border-strong:#2c323c;
    --text:#e9ecf1; --text-2:#a3aab6; --text-3:#6c7480;
    --accent:#59a6ff; --accent-2:#8fd0ff; --accent-weak:rgba(89,166,255,.16); --accent-line:rgba(89,166,255,.36);
    --emerald:#34d399; --emerald-weak:rgba(52,211,153,.14); --emerald-line:rgba(52,211,153,.32); --emerald-glow:rgba(52,211,153,.5);
    --blue:#7aa2f7; --blue-weak:rgba(122,162,247,.15);
    --amber:#fbbf24; --amber-weak:rgba(251,191,36,.15);
    --red:#f87171; --red-weak:rgba(248,113,113,.14); --red-line:rgba(248,113,113,.34);
    --shadow-sm:0 1px 2px rgba(0,0,0,.4);
    --shadow:0 1px 2px rgba(0,0,0,.45), 0 10px 30px -10px rgba(0,0,0,.55);
    --shadow-lg:0 2px 6px rgba(0,0,0,.5), 0 24px 50px -16px rgba(0,0,0,.6);
    --c-day:#f5a524; --c-aft:#fb7a54; --c-night:#818cf8; --c-p2:#22d3ee;
    --c-lead:#c084fc; --c-clark:#34d399; --c-jan:#f472b6; --c-other:#94a3b8;
  }
}
/* Manual theme override wins in BOTH directions */
:root[data-theme="light"]{
  color-scheme: light;
  --bg:#f7f7f5; --bg-tint:#eef0ee; --grid:#ececec;
  --surface:#ffffff; --surface-2:#fafafa; --surface-3:#f2f2f0; --surface-hover:#f6f5f3;
  --border:#e2e8f0; --border-strong:#d3dae4;
  --text:#090a0b; --text-2:#475569; --text-3:#94a3b8;
  --accent:#0044ff; --accent-2:#0033cc; --accent-weak:rgba(0,68,255,.08); --accent-line:rgba(0,68,255,.26);
  --emerald:#0f9d63; --emerald-weak:rgba(15,157,99,.12); --emerald-line:rgba(15,157,99,.30); --emerald-glow:rgba(15,157,99,.34);
  --blue:#2563eb; --blue-weak:rgba(37,99,235,.11);
  --amber:#b45309; --amber-weak:rgba(180,83,9,.12);
  --red:#dc2626; --red-weak:rgba(220,38,38,.10); --red-line:rgba(220,38,38,.34);
  --shadow-sm:0 1px 2px rgba(20,18,15,.05);
  --shadow:0 1px 2px rgba(20,18,15,.04), 0 6px 20px -6px rgba(20,18,15,.10);
  --shadow-lg:0 2px 4px rgba(20,18,15,.05), 0 16px 40px -12px rgba(20,18,15,.16);
  --c-day:#e08a00; --c-aft:#e05b3b; --c-night:#4f46e5; --c-p2:#0ea5b7;
  --c-lead:#9333ea; --c-clark:#0f9d58; --c-jan:#db2777; --c-other:#7b859b;
}
:root[data-theme="dark"]{
  color-scheme: dark;
  --bg:#08090c; --bg-tint:#0e1015; --grid:#151922;
  --surface:#0f1218; --surface-2:#141824; --surface-3:#1a1f2b; --surface-hover:#161b26;
  --border:#20242e; --border-strong:#2c333f;
  --text:#f3f5f9; --text-2:#9aa4b4; --text-3:#5b6473;
  --accent:#4f8cff; --accent-2:#7db0ff; --accent-weak:rgba(79,140,255,.14); --accent-line:rgba(79,140,255,.34);
  --emerald:#34d399; --emerald-weak:rgba(52,211,153,.14); --emerald-line:rgba(52,211,153,.32); --emerald-glow:rgba(52,211,153,.5);
  --blue:#7aa2f7; --blue-weak:rgba(122,162,247,.15);
  --amber:#fbbf24; --amber-weak:rgba(251,191,36,.15);
  --red:#f87171; --red-weak:rgba(248,113,113,.14); --red-line:rgba(248,113,113,.34);
  --shadow-sm:0 1px 2px rgba(0,0,0,.4);
  --shadow:0 1px 2px rgba(0,0,0,.45), 0 10px 30px -10px rgba(0,0,0,.55);
  --shadow-lg:0 2px 6px rgba(0,0,0,.5), 0 24px 50px -16px rgba(0,0,0,.6);
  --c-day:#f5a524; --c-aft:#fb7a54; --c-night:#818cf8; --c-p2:#22d3ee;
  --c-lead:#c084fc; --c-clark:#34d399; --c-jan:#f472b6; --c-other:#94a3b8;
}

/* ============================== Reset ================================= */
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--text);
  font-family:var(--sans); font-size:15px; line-height:1.5;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  background-image:radial-gradient(900px 520px at 84% -8%, var(--accent-weak), transparent 58%),radial-gradient(680px 480px at 6% 4%, var(--accent-weak), transparent 52%),radial-gradient(720px 640px at 50% 116%, var(--blue-weak), transparent 55%);
  background-attachment:fixed;
}
.tnum{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}.fp-badge{font:inherit;font-size:12px;font-weight:600;padding:5px 11px;border-radius:999px;border:1px solid var(--border-strong);cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s;background:var(--surface-3);color:var(--text-3)}.fp-badge.fp-on{background:var(--emerald-weak);color:var(--emerald);border-color:var(--emerald-line)}.fp-badge.fp-off{background:transparent;color:var(--text-3)}.fp-badge:hover{border-color:var(--accent-line);color:var(--accent)}.fp-badge.fp-on:hover{filter:brightness(1.08)}.fpWho{font-size:14px;color:var(--text-2);margin-bottom:14px}.fpWho b{color:var(--text)}.fpOk{color:var(--emerald)}.fpFingers{display:flex;flex-wrap:wrap;gap:8px}.fpFingers .fchip{font:inherit;font-size:12.5px;font-weight:600;padding:7px 12px;border-radius:999px;border:1px solid var(--border-strong);background:var(--surface-3);color:var(--text-2);cursor:pointer;transition:all .15s}.fpFingers .fchip.on{background:var(--accent-weak);color:var(--accent);border-color:var(--accent-line)}.fpSteps{margin:16px 0 4px 18px;padding:0;color:var(--text-2);font-size:13px;line-height:1.7}.fpNote{font-size:12.5px;color:var(--text-3);margin-top:8px;min-height:16px}.fpNote.ok{color:var(--emerald)}.fpNote.warn{color:var(--amber)}
::selection{background:var(--accent-weak)}
a{color:inherit}
button,input,select{font:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}

/* ============================== Header ================================ */
header{
  position:sticky; top:0; z-index:30;
  background:color-mix(in srgb, var(--bg) 80%, transparent);
  backdrop-filter:saturate(170%) blur(16px); -webkit-backdrop-filter:saturate(170%) blur(16px);
  border-bottom:1px solid var(--border);
}
.head-in{max-width:1700px;margin:0 auto;padding:13px 28px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:11px;min-width:0}
.mark{
  width:66px;height:66px;border-radius:13px;flex:none;display:grid;place-items:center;
  background:transparent;
  box-shadow:none; color:#fff;
}
.mark svg{width:19px;height:19px}
.wordmark{display:flex;flex-direction:column;line-height:1.05;min-width:0}
.wordmark b{font-family:var(--serif);font-weight:700;font-size:40px;letter-spacing:-.4px;display:flex;align-items:center;gap:1px;line-height:1}
.oclock{display:inline-grid;place-items:center;width:.76em;height:.76em;margin:0 .01em;vertical-align:-.07em;color:var(--text)}
.oclock svg{width:100%;height:100%;display:block}
.oclock .hh,.oclock .mh,.oclock .sh{transform-origin:20px 20px;transform-box:view-box}
.oclock .hh{animation:ocSpin 43200s linear infinite}
.oclock .mh{animation:ocSpin 3600s linear infinite}
.oclock .sh{animation:ocSpin 60s linear infinite}
@keyframes ocSpin{to{transform:rotate(360deg)}}
.wordmark > span{font-size:12.5px;color:var(--text-3);letter-spacing:.2em;text-transform:uppercase;font-weight:600;margin-top:3px}
.spacer{flex:1}
.live{
  display:inline-flex;align-items:center;gap:8px;padding:6px 12px 6px 10px;
  border:1px solid var(--border);border-radius:999px;background:var(--surface);
  font-size:12px;font-weight:600;color:var(--text-2);box-shadow:var(--shadow-sm);white-space:nowrap;
  letter-spacing:.02em;transition:border-color .3s ease,color .3s ease;
}
.live .beat{width:8px;height:8px;border-radius:50%;background:var(--text-3);position:relative;flex:none}
.live .beat::after{content:"";position:absolute;inset:-4px;border-radius:50%;background:var(--emerald);opacity:0;animation:beat 2.3s ease-out infinite}
@keyframes beat{0%{transform:scale(.6);opacity:.5}70%{transform:scale(1.9);opacity:0}100%{opacity:0}}
.live.ok{border-color:var(--emerald-line);color:var(--emerald)} .live.ok .beat{background:var(--emerald)} .live.ok .beat::after{opacity:.4}
.live.sync{border-color:var(--accent-line);color:var(--accent)} .live.sync .beat{background:var(--accent)} .live.sync .beat::after{background:var(--accent);opacity:.4}
.live.degraded{border-color:var(--amber-weak);color:var(--amber)} .live.degraded .beat{background:var(--amber)} .live.degraded .beat::after{opacity:0}
.live.down{border-color:var(--red-line);color:var(--red)} .live.down .beat{background:var(--red)} .live.down .beat::after{opacity:0}
.clock{font-variant-numeric:tabular-nums;color:var(--text-2);font-size:13px;font-weight:500;white-space:nowrap}
.icon-btn{
  width:38px;height:38px;flex:none;display:grid;place-items:center;cursor:pointer;
  background:var(--surface);border:1px solid var(--border);border-radius:10px;color:var(--text-2);
  box-shadow:var(--shadow-sm);transition:transform .15s ease,color .15s ease,border-color .15s ease,background .15s ease;
}
.icon-btn:hover{color:var(--text);border-color:var(--border-strong);transform:translateY(-1px)}
.icon-btn:active{transform:translateY(0)}
.icon-btn svg{width:18px;height:18px}
.icon-btn.spin svg{animation:spin .7s linear}
@keyframes spin{to{transform:rotate(360deg)}}
.icon-btn .moon{display:none}
:root[data-theme="dark"] .icon-btn .sun{display:none} :root[data-theme="dark"] .icon-btn .moon{display:block}
@media (prefers-color-scheme: dark){.icon-btn .sun{display:none}.icon-btn .moon{display:block}}
:root[data-theme="light"] .icon-btn .sun{display:block} :root[data-theme="light"] .icon-btn .moon{display:none}

/* =============================== Main ================================= */
main{max-width:1700px;margin:0 auto;padding:24px 28px 64px}
.page-title{margin:2px 0 20px}
.page-title h1{font-family:var(--serif);font-weight:600;font-size:26px;letter-spacing:.2px;margin:0}
.page-title p{margin:5px 0 0;color:var(--text-2);font-size:14px}

/* ============================= Toolbar =============================== */
.toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:16px}
.dates{display:flex;gap:6px;overflow-x:auto;padding:4px;background:var(--surface);border:1px solid var(--border);
  border-radius:13px;box-shadow:var(--shadow-sm);scrollbar-width:none;max-width:100%}
.dates::-webkit-scrollbar{display:none}
.date-pill{
  appearance:none;border:1px solid transparent;background:transparent;cursor:pointer;white-space:nowrap;
  padding:7px 13px;border-radius:9px;color:var(--text-2);font-size:13px;font-weight:600;line-height:1.1;
  display:flex;flex-direction:column;align-items:center;gap:2px;transition:color .15s ease,background .15s ease;
}
.date-pill small{font-size:10.5px;font-weight:600;color:var(--text-3);letter-spacing:.02em}
.date-pill:hover{background:var(--surface-hover);color:var(--text)}
.date-pill[aria-selected="true"]{background:var(--accent);color:#fff;box-shadow:0 4px 12px -4px var(--accent-line)}
.date-pill[aria-selected="true"] small{color:rgba(255,255,255,.82)}
.grow{flex:1;min-width:170px;display:flex;justify-content:flex-end}
.search{position:relative;width:100%;max-width:340px}
.search .si{position:absolute;left:12px;top:50%;transform:translateY(-50%);width:16px;height:16px;color:var(--text-3);pointer-events:none}
.search input{
  width:100%;padding:10px 40px 10px 36px;border:1px solid var(--border);border-radius:11px;
  background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm);transition:border-color .15s ease,box-shadow .15s ease;
}
.search input::placeholder{color:var(--text-3)}
.search input:focus{outline:none;border-color:var(--accent-line);box-shadow:0 0 0 3px var(--accent-weak)}
.search kbd{position:absolute;right:9px;top:50%;transform:translateY(-50%);font:11px var(--mono);color:var(--text-3);
  border:1px solid var(--border-strong);border-radius:5px;padding:1px 6px;background:var(--surface-2);transition:opacity .15s}
.search input:not(:placeholder-shown)+.si+kbd,.search input:focus+.si+kbd{opacity:0}

/* ============================= Shift chips ========================== */
.chips{display:flex;gap:7px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px;margin-bottom:20px}
.chips::-webkit-scrollbar{display:none}
.chip{
  font:inherit;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:8px;
  padding:6px 12px;border:1px solid var(--border);border-radius:999px;background:var(--surface);
  color:var(--text-2);box-shadow:var(--shadow-sm);transition:.15s ease;
}
.chip:hover{border-color:var(--border-strong);color:var(--text)}
.chip .sw{width:9px;height:9px;border-radius:3px;flex:none}
.chip .ct{font-family:var(--mono);font-size:11px;color:var(--text-3);background:var(--surface-3);border-radius:999px;padding:1px 7px;transition:.15s}
.chip[aria-pressed="true"]{border-color:var(--accent-line);color:var(--text);background:var(--accent-weak)}
.chip[aria-pressed="true"] .ct{background:color-mix(in srgb,var(--accent) 20%,transparent);color:var(--accent)}

/* ============================== KPIs ================================= */
.kpis{display:grid;grid-template-columns:repeat(8,1fr);gap:12px;margin-bottom:22px}
@media(max-width:1100px){.kpis{grid-template-columns:repeat(4,1fr)}}
@media(max-width:680px){.kpis{grid-template-columns:repeat(2,1fr);gap:10px}}
.kpi{
  position:relative;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:14px 15px 13px;box-shadow:var(--shadow);overflow:hidden;min-width:0;
  transition:transform .18s cubic-bezier(.3,.8,.4,1),box-shadow .18s ease,border-color .18s ease;
}
.kpi.clickable{cursor:pointer}
.kpi.clickable:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg);border-color:var(--border-strong)}
.kpi.active{border-color:var(--accent-line);box-shadow:0 0 0 1px var(--accent-line),var(--shadow)}
.kpi .kl{font-size:10.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);
  display:flex;align-items:center;gap:6px}
.kpi .kdot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--text-3)}
.kpi .kv{font-size:27px;font-weight:700;letter-spacing:-.02em;margin-top:8px;line-height:1;font-variant-numeric:tabular-nums}
.kpi .kv small{font-size:14px;font-weight:600;color:var(--text-3);margin-left:1px}
.kpi .kd{margin-top:6px;font-size:11.5px;color:var(--text-3);display:flex;align-items:center;gap:5px;min-height:15px}
.kpi .kd b{font-weight:700}
.delta-up{color:var(--emerald)} .delta-dn{color:var(--red)} .delta-flat{color:var(--text-3)}
.kpi .spark{position:absolute;right:11px;bottom:11px;width:60px;height:22px;opacity:.9}
.kpi .meter{margin-top:9px;height:6px;border-radius:999px;background:var(--bg-tint);overflow:hidden}
.kpi .meter>i{display:block;height:100%;border-radius:999px;
  background:linear-gradient(90deg,var(--emerald),color-mix(in srgb,var(--emerald) 55%,var(--accent)));transition:width .6s cubic-bezier(.3,.8,.4,1)}
.kpi.hero{background:linear-gradient(155deg,var(--emerald-weak),transparent 62%),var(--surface);border-color:var(--emerald-line)}
.kpi.hero .kv,.kpi.hero .kdot{color:var(--emerald)} .kpi.hero .kdot{background:var(--emerald);box-shadow:0 0 8px var(--emerald-glow)}
.kpi.amber .kv{color:var(--amber)} .kpi.amber .kdot{background:var(--amber)}
.kpi.blue .kv{color:var(--blue)} .kpi.blue .kdot{background:var(--blue)}
.kpi.red .kv{color:var(--red)} .kpi.red .kdot{background:var(--red)}

/* ============================ Panels / charts ======================= */
.panels{display:grid;grid-template-columns:1.5fr 1fr;gap:14px;margin-bottom:14px}
.panels.two{grid-template-columns:1fr 1fr}
@media(max-width:900px){.panels,.panels.two{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);
  padding:16px 18px 14px;min-width:0}
.ptitle{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:2px}
.ptitle h3{font-size:13px;font-weight:700;letter-spacing:-.01em;margin:0}
.ptitle .note{font-size:11.5px;color:var(--text-3);font-variant-numeric:tabular-nums}
.psub{font-size:11.5px;color:var(--text-3);margin:0 0 12px}
.chart{width:100%;display:block;overflow:visible}
.chart text{fill:var(--text-3);font-size:10.5px;font-family:inherit}
.chart .grline{stroke:var(--border);stroke-width:1}
.chart .val{fill:var(--text-2);font-weight:600;font-variant-numeric:tabular-nums}
.chart .barlabel{fill:var(--text);font-weight:600}
.bar-track{fill:var(--grid)}
.bar-seg,.hist-seg,.donut-seg,.dot,.area-line,.area-fill{transition:opacity .2s}
.dim{opacity:.2}
.donut-wrap{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.donut-hole .big{fill:var(--text);font-size:26px;font-weight:700}
.donut-hole .lbl{fill:var(--text-3);font-size:9.5px;letter-spacing:.08em;text-transform:uppercase}
.legend{display:flex;flex-direction:column;gap:3px;flex:1 1 150px;min-width:150px}
.lgi{display:flex;align-items:center;gap:9px;padding:5px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent;transition:.13s;font-size:12.5px}
.lgi:hover{background:var(--surface-hover);border-color:var(--border)}
.lgi.active{background:var(--accent-weak);border-color:var(--accent-line)}
.lgi .sw{width:10px;height:10px;border-radius:3px;flex:none}
.lgi .nm{flex:1;color:var(--text-2);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lgi.active .nm{color:var(--text)}
.lgi .ct{font-weight:700;font-variant-numeric:tabular-nums;color:var(--text)}
.lgi .pct{color:var(--text-3);font-size:11px;font-variant-numeric:tabular-nums;width:34px;text-align:right}

/* ========================== Section heads =========================== */
.sec-head{display:flex;align-items:center;gap:11px;margin:26px 2px 13px}
.sec-head h2{font-family:var(--serif);font-weight:600;font-size:18px;letter-spacing:.2px;margin:0}
.count-badge{font-size:12px;font-weight:650;color:var(--text-2);background:var(--surface);border:1px solid var(--border);
  padding:2px 9px;border-radius:999px;font-variant-numeric:tabular-nums}
.count-badge.hot{color:var(--red);border-color:var(--red-line);background:var(--red-weak)}
.sec-head .hint{margin-left:auto;font-size:12px;color:var(--text-3)}

/* =========================== Currently on floor ===================== */
.people{display:grid;grid-template-columns:repeat(auto-fill,minmax(244px,1fr));gap:12px}
.person{
  position:relative;display:flex;gap:12px;align-items:center;background:var(--surface);
  border:1px solid var(--border);border-radius:14px;padding:13px 15px;box-shadow:var(--shadow-sm);overflow:hidden;
  transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease;
}
.person::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--sc,var(--emerald))}
.person:hover{transform:translateY(-2px);box-shadow:var(--shadow);border-color:var(--border-strong)}
.person.exc::before{background:var(--amber)}
.av{width:42px;height:42px;border-radius:12px;flex:none;display:grid;place-items:center;font-weight:700;font-size:14px;
  color:#fff;letter-spacing:.02em;box-shadow:inset 0 1px 0 rgba(255,255,255,.22)}
.person .meta{min-width:0;flex:1}
.person .nm{font-weight:650;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.person .sh{font-size:12px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;display:flex;align-items:center;gap:6px}
.person .sh .sdot{width:7px;height:7px;border-radius:50%;flex:none}
.person .dur{margin-top:7px;display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:650;
  color:var(--emerald);background:var(--emerald-weak);padding:2px 8px;border-radius:999px;font-variant-numeric:tabular-nums}
.person .dur .d{width:6px;height:6px;border-radius:50%;background:var(--emerald);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.person .tagx{margin-top:7px;display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:650;
  color:var(--amber);background:var(--amber-weak);padding:2px 8px;border-radius:999px}
.person .since{margin-left:auto;text-align:right;flex:none}
.person .since .t{font-family:var(--mono);font-weight:700;font-size:13px;color:var(--emerald)}
.person .since .k{font-size:9.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em}

/* ============================== Table =============================== */
.roster{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
.roster-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--border)}
.segbar{display:inline-flex;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:2px;gap:2px}
.seg{border:0;background:transparent;color:var(--text-3);font:inherit;font-size:11.5px;font-weight:650;cursor:pointer;
  padding:6px 11px;border-radius:8px;transition:.13s;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
.seg .n{font-variant-numeric:tabular-nums;opacity:.75}
.seg:hover{color:var(--text)}
.seg.active{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm)}
.seg.exc.active{color:var(--amber)}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:840px}
thead th{
  position:sticky;top:0;z-index:1;text-align:left;padding:11px 16px;background:var(--surface-2);
  border-bottom:1px solid var(--border);font-size:10.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);
  white-space:nowrap;cursor:pointer;user-select:none;transition:color .15s ease}
thead th.r{text-align:right}
thead th:hover{color:var(--text-2)}
thead th .car{opacity:0;margin-left:5px;font-size:9px;transition:opacity .15s}
thead th[aria-sort]{color:var(--text)} thead th[aria-sort] .car{opacity:1;color:var(--accent)}
tbody td{padding:12px 16px;border-bottom:1px solid var(--border);white-space:nowrap;font-size:14px}
tbody tr:last-child td{border-bottom:0}
tbody tr{transition:background .12s ease}
tbody tr:hover{background:var(--surface-hover)}
td.r{text-align:right;font-variant-numeric:tabular-nums}
td.z{color:var(--text-3)}
.emp{display:flex;align-items:center;gap:11px}
.emp .dot{width:30px;height:30px;border-radius:9px;flex:none;display:grid;place-items:center;font-size:11px;font-weight:700;color:#fff}
.emp .en{font-weight:600;color:var(--text)}
.emp .ep{font-size:11px;color:var(--text-3)}
.shiftcell{display:inline-flex;align-items:center;gap:7px}
.shiftcell .sdot{width:8px;height:8px;border-radius:50%;flex:none}
.shift-tag{font-size:12.5px;color:var(--text-2)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 9px 3px 8px;border-radius:999px;font-weight:650;white-space:nowrap}
.pill .d{width:6px;height:6px;border-radius:50%}
.pill.in{background:var(--emerald-weak);color:var(--emerald)} .pill.in .d{background:var(--emerald);box-shadow:0 0 6px var(--emerald-glow)}
.pill.done{background:var(--blue-weak);color:var(--blue)} .pill.done .d{background:var(--blue)}
.pill.absent{background:var(--bg-tint);color:var(--text-3)} .pill.absent .d{background:var(--text-3)}
.pill.warn{background:var(--amber-weak);color:var(--amber)} .pill.warn .d{background:var(--amber)}
.flag{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:650;color:var(--amber);
  background:var(--amber-weak);border-radius:6px;padding:2px 7px;margin-left:6px}
.ot-hot{color:var(--amber);font-weight:700}
td.payable b{font-weight:700;color:var(--text)}
td .ndot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--c-night);margin-right:6px;vertical-align:middle}

/* ===================== Phase-1 additive (design §8) ================= */
/* provenance badges */
.badge-ours{font:600 9.5px/1 var(--sans);letter-spacing:.06em;text-transform:uppercase;
  color:var(--accent);background:var(--accent-weak);border:1px solid var(--accent-line);
  border-radius:5px;padding:1px 5px;margin-left:6px}
.badge-csv{color:var(--text-3);background:transparent;border:1px solid var(--border)}
/* KPI: night variant + provenance note + weekly caption */
.kpi.night .kv{color:var(--c-night)} .kpi.night .kdot{background:var(--c-night)}
.kpi .kcap{margin-left:auto;font-size:9.5px;font-weight:600;color:var(--text-3);letter-spacing:.02em;text-transform:none}
.kpi-note{grid-column:1/-1;margin:-8px 2px 20px;font-size:11.5px;color:var(--text-3);line-height:1.4}
/* severity flag chips (extend existing .tagx) */
.tagx.err{color:var(--red);background:var(--red-weak)}
.tagx.info{color:var(--text-3);background:var(--surface-3)}
.fcode{font:600 10px var(--mono);letter-spacing:.02em;opacity:.85;margin-right:5px}
.person.exc.error::before{background:var(--red)}
/* primary button (export) — sibling of .mark */
.btn-primary{display:inline-flex;align-items:center;gap:8px;cursor:pointer;white-space:nowrap;
  padding:10px 15px;border:0;border-radius:11px;color:#fff;font-weight:650;font-size:13.5px;
  background:transparent;
  box-shadow:0 4px 14px -4px var(--accent-line),inset 0 1px 0 rgba(255,255,255,.22);
  transition:transform .15s ease,box-shadow .15s ease}
.btn-primary:hover{transform:translateY(-1px)}
.btn-primary:disabled{opacity:.55;cursor:default;transform:none}
.btn-primary svg{width:16px;height:16px}
.btn-primary.spin svg{animation:spin .7s linear}
.export-wrap{position:relative;display:inline-flex}
.caret-btn{display:inline-grid;place-items:center;cursor:pointer;width:38px;height:38px;margin-left:6px;
  background:var(--surface);border:1px solid var(--border);border-radius:10px;color:var(--text-2);box-shadow:var(--shadow-sm);
  transition:color .15s ease,border-color .15s ease}
.caret-btn:hover{color:var(--text);border-color:var(--border-strong)}
.caret-btn svg{width:16px;height:16px}
/* range popover */
.pop{position:absolute;right:0;z-index:40;margin-top:8px;min-width:264px;background:var(--surface);
  border:1px solid var(--border-strong);border-radius:var(--radius-sm);box-shadow:var(--shadow-lg);padding:14px}
.pop label{display:flex;align-items:center;gap:9px;padding:7px 6px;border-radius:8px;font-size:13px;cursor:pointer}
.pop label:hover{background:var(--surface-hover)}
.pop .receipt{font-size:11.5px;color:var(--text-3);margin:8px 2px 12px;font-variant-numeric:tabular-nums}
.pop .customrow{display:flex;gap:8px;margin:2px 2px 10px}
.pop .customrow input{flex:1;min-width:0;padding:7px 9px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text)}
.pop .note{font-size:11.5px;color:var(--amber);margin:2px 2px 8px}
.pop .btn-primary{width:100%;justify-content:center;margin-top:4px}

/* ============================== Tabs (legacy, kept for compatibility) ============================== */
.tabs{display:flex;gap:4px;margin:2px 0 18px;border-bottom:1px solid var(--border)}
.tab{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;
  padding:10px 4px;margin-right:22px;border:0;background:transparent;color:var(--text-3);
  font-weight:650;font-size:14px;font-family:inherit;border-bottom:2px solid transparent;
  transition:color .15s ease,border-color .15s ease}
.tab:hover{color:var(--text-2)}
.tab.active{color:var(--text);border-bottom-color:var(--accent)}
.tab-badge{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;
  border-radius:999px;background:var(--amber-weak);color:var(--amber);font-size:11px;font-weight:700;
  font-variant-numeric:tabular-nums}

/* ============================== App shell: sidebar + content ============================== */
.appShell{display:flex;align-items:flex-start;max-width:1440px;margin:0 auto;gap:0}
.sidebar{
  position:sticky; top:65px; align-self:flex-start;
  width:248px; flex:none; padding:20px 12px 40px;
  height:calc(100vh - 65px); overflow-y:auto;
  border-right:1px solid var(--border);
}
.sidebar::-webkit-scrollbar{width:6px}
.sidebar::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:99px}
.navGroup{margin-bottom:4px}
.navGroupLabel{padding:14px 12px 6px;font-size:10.5px;font-weight:700;letter-spacing:.09em;
  text-transform:uppercase;color:var(--text-3)}
.navItem{
  display:flex;align-items:center;gap:11px;width:100%;text-align:left;
  padding:9px 12px;border-radius:10px;border:0;background:transparent;cursor:pointer;
  font:inherit;font-size:13.5px;font-weight:600;color:var(--text-2);
  transition:background .14s ease,color .14s ease;position:relative;
}
.navItem svg{width:17px;height:17px;flex:none;opacity:.8;stroke-width:1.9}
.navItem:hover{background:var(--surface-hover);color:var(--text)}
.navItem.active{background:var(--accent-weak);color:var(--accent)}
.navItem.active svg{opacity:1}
.navItem .navLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.navItem .extIcon{width:12px;height:12px;opacity:.55;flex:none}
.navItem .navCount{font-size:11px;font-weight:700;color:var(--text-3);
  background:var(--surface-3);border-radius:999px;padding:1px 7px;font-variant-numeric:tabular-nums}
.navItem.active .navCount{background:var(--accent);color:#fff}
.navSub{padding-left:14px;margin-top:1px;margin-bottom:2px;
  border-left:1px solid var(--border);margin-left:22px}
.navSub .navItem{padding:7px 10px;font-size:13px;font-weight:550}
.navSub .navItem svg{width:14px;height:14px}
.navDivider{height:1px;background:var(--border);margin:10px 4px}
.extBadge{font-size:9.5px;font-weight:700;letter-spacing:.04em;color:var(--text-3);
  background:var(--surface-3);border-radius:5px;padding:1px 5px;flex:none}
.content{flex:1;min-width:0;padding:24px 28px 56px}
.sidebarToggle{display:none}
@media(max-width:980px){
  .sidebar{position:fixed;left:0;top:0;height:100vh;z-index:80;background:var(--bg);
    box-shadow:var(--shadow-lg);transform:translateX(-100%);transition:transform .2s ease;padding-top:76px}
  .sidebar.open{transform:translateX(0)}
  .sidebarToggle{display:inline-flex}
  .sidebarScrim{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:70}
  .sidebarScrim.open{display:block}
  .content{padding:20px 16px 56px}
}

/* ============================== Data-view tables (View Punch / Timecard / Report) ============================== */
.dvTable{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}
.dvTable thead th{position:sticky;top:0;background:var(--surface-2);z-index:2;
  text-align:left;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
  color:var(--text-3);padding:11px 14px;border-bottom:1px solid var(--border-strong);white-space:nowrap}
.dvTable tbody td{padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text-2);white-space:nowrap}
.dvTable tbody tr:hover{background:var(--surface-hover)}
.dvTable tbody tr:last-child td{border-bottom:0}
.dvTable .dvName{color:var(--text);font-weight:600}
.dvWrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);
  box-shadow:var(--shadow);overflow:auto;max-height:70vh}
.dvToolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.dvToolbar .search{max-width:280px}
.dvPill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;
  font-size:11.5px;font-weight:650;background:var(--surface-3);color:var(--text-2)}
.dvPill.ot{background:var(--amber-weak);color:var(--amber)}

/* ============================== Modal / overlay (Add Punch) ============================== */
.overlay[hidden]{display:none!important;}  /* respect the hidden attr; author display:grid was overriding UA [hidden]{display:none} */
.overlay{position:fixed;inset:0;z-index:100;display:grid;place-items:center;
  background:color-mix(in srgb, #000 55%, transparent);backdrop-filter:blur(2px);
  animation:fadeIn .15s ease}
.modal{width:min(420px,92vw);background:var(--surface);border:1px solid var(--border-strong);
  border-radius:var(--radius-sm);box-shadow:var(--shadow-lg);padding:22px;
  animation:modalIn .18s cubic-bezier(.2,.9,.3,1.2)}
.modal h3{margin:0 0 16px;font-family:var(--serif);font-weight:600;font-size:19px}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes modalIn{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
.field{margin-bottom:14px}
.field label{display:block;font-size:12.5px;font-weight:650;color:var(--text-2);margin-bottom:6px}
.field label .opt{font-weight:400;color:var(--text-3)}
.field input,.field select,.field textarea{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border);
  border-radius:9px;background:var(--surface-2);color:var(--text);font:inherit;font-size:14px;
  transition:border-color .15s ease,box-shadow .15s ease}
.field input:focus,.field select:focus,.field textarea:focus{outline:none;border-color:var(--accent-line);
  box-shadow:0 0 0 3px var(--accent-weak)}
.field textarea{resize:vertical;min-height:44px}
.modal-err{padding:9px 12px;margin-bottom:12px;border-radius:9px;background:var(--red-weak);
  color:var(--red);font-size:13px;border:1px solid var(--red-line)}
.modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:6px}
.btn-ghost{padding:10px 15px;border-radius:11px;border:1px solid var(--border);background:transparent;
  color:var(--text-2);font-weight:600;font-size:13.5px;cursor:pointer;font-family:inherit;
  transition:background .15s ease,border-color .15s ease}
.btn-ghost:hover{background:var(--surface-hover);border-color:var(--border-strong)}

/* ============================== Mend Punch status pills + row actions ============================== */
.mend-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;
  font-size:12px;font-weight:650}
.mend-pill.pending{background:var(--amber-weak);color:var(--amber)}
.mend-pill.approved{background:var(--emerald-weak);color:var(--emerald)}
.mend-pill.rejected{background:var(--red-weak);color:var(--red)}
.mend-actions{display:flex;gap:8px}
.mend-actions button{padding:6px 12px;border-radius:8px;border:1px solid var(--border);
  background:var(--surface-2);color:var(--text-2);font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;
  transition:background .15s ease,border-color .15s ease,color .15s ease}
.mend-actions .approve:hover{background:var(--emerald-weak);border-color:var(--emerald-line);color:var(--emerald)}
.mend-actions .reject:hover{background:var(--red-weak);border-color:var(--red-line);color:var(--red)}
.mend-actions .del:hover{background:var(--red-weak);border-color:var(--red-line);color:var(--red)}

/* ============================== States ============================== */
.empty{padding:38px 22px;text-align:center;color:var(--text-3)}
.empty svg{width:28px;height:28px;opacity:.55;margin-bottom:9px}
.empty .t{color:var(--text-2);font-weight:600}
.alert{display:flex;gap:11px;align-items:flex-start;background:var(--red-weak);border:1px solid var(--red-line);
  color:var(--text);padding:13px 16px;border-radius:13px;margin-bottom:18px;font-size:13.5px}
.alert svg{width:18px;height:18px;color:var(--red);flex:none;margin-top:1px}
.alert b{color:var(--red)}
.sk{border-radius:14px;background:var(--surface);border:1px solid var(--border);height:104px;position:relative;overflow:hidden}
.sk::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--text) 6%,transparent),transparent);
  transform:translateX(-100%);animation:sweep 1.4s ease-in-out infinite}
@keyframes sweep{100%{transform:translateX(100%)}}

/* ============================== Footer ============================== */
footer{max-width:1280px;margin:30px auto 0;padding:18px 24px;color:var(--text-3);font-size:12px;
  border-top:1px solid var(--border);display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:center}
footer .sep{width:3px;height:3px;border-radius:50%;background:var(--border-strong)}
footer code{font-family:var(--mono);font-size:11px;color:var(--text-2);background:var(--surface);border:1px solid var(--border);
  padding:1px 6px;border-radius:5px;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom}

/* ============================ Responsive ============================ */
@media(max-width:560px){
  .head-in{padding:12px 16px;gap:10px} main{padding:20px 16px 56px} footer{padding:16px}
  .clock{display:none} .wordmark > span{display:none}
  .page-title h1{font-size:22px} .kpi .kv{font-size:23px} .kpi .spark{display:none}
}
/* Table reflows to stacked cards on phones — NO horizontal scroll */
@media(max-width:480px){
  .roster{background:transparent;border:0;box-shadow:none;overflow:visible}
  .roster-top{background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:10px}
  .segbar{overflow-x:auto;max-width:100%;scrollbar-width:none}
  .segbar::-webkit-scrollbar{display:none}
  .seg{padding:6px 9px}
  .tablewrap{overflow:visible}
  table{min-width:0}
  thead{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);border:0}
  tbody tr{display:block;background:var(--surface);border:1px solid var(--border);border-radius:14px;
    box-shadow:var(--shadow-sm);margin-bottom:11px;padding:6px 2px 8px}
  tbody tr:hover{background:var(--surface)}
  tbody td{display:flex;justify-content:space-between;align-items:center;gap:14px;border:0;
    padding:7px 15px;white-space:normal;text-align:right;font-size:13.5px}
  tbody td::before{content:attr(data-label);color:var(--text-3);font-weight:650;text-transform:uppercase;
    font-size:10.5px;letter-spacing:.05em;text-align:left;flex:none}
  tbody td.r{text-align:right}
  tbody td.cell-emp{padding-top:11px}
  tbody td.cell-emp::before{display:none}
  tbody td.cell-emp{justify-content:flex-start}
}
/* ===== Alabaster Authority overrides ===== */
body{background:var(--bg)}
/* ---- ambient cinematic background (theme-aware) ---- */
body::before,body::after{content:"";position:fixed;z-index:-1;pointer-events:none;border-radius:50%;filter:blur(80px);will-change:transform}
body::before{width:58vw;height:58vw;left:-16vw;top:-20vw;background:radial-gradient(circle at 35% 35%,var(--accent-weak),transparent 66%);animation:ambA 44s ease-in-out infinite alternate}
body::after{width:50vw;height:50vw;right:-14vw;bottom:-18vw;background:radial-gradient(circle at 62% 62%,var(--emerald-weak),transparent 62%);animation:ambB 56s ease-in-out infinite alternate}
@keyframes ambA{0%{transform:translate3d(0,0,0) scale(1)}55%{transform:translate3d(10vw,8vh,0) scale(1.16)}100%{transform:translate3d(3vw,15vh,0) scale(.94)}}
@keyframes ambB{0%{transform:translate3d(0,0,0) scale(1)}55%{transform:translate3d(-9vw,-7vh,0) scale(1.12)}100%{transform:translate3d(-2vw,-13vh,0) scale(1.03)}}
@media (max-width:860px){body::before,body::after{display:none}}
header{background:rgba(10,12,16,.72);backdrop-filter:saturate(160%) blur(14px);-webkit-backdrop-filter:saturate(160%) blur(14px);border-bottom:1px solid var(--border)}
.kpi,.panel{position:relative;background:var(--surface);box-shadow:none;border:1px solid var(--border);border-radius:var(--radius-sm);transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease}
.kpi::after,.panel::after{content:none}
.kpi.clickable:hover,.panel:hover{transform:translateY(-2px);border-color:var(--border-strong);box-shadow:var(--shadow)}
.kpi .kv{font-family:var(--serif);font-weight:800;letter-spacing:-.03em}
.page-title{animation:premIn .5s cubic-bezier(.16,1,.3,1) both}
.page-title h1{font-family:var(--serif);font-weight:800;letter-spacing:-.02em;color:var(--text);-webkit-text-fill-color:currentColor;background:none}
@keyframes premIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
/* ---- waiting-state radar ---- */
.waitcard{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:46px 20px 42px;gap:12px;position:relative}
.waitcard .radar{position:relative;width:76px;height:76px;margin-bottom:2px}
.waitcard .radar i{position:absolute;left:50%;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:var(--accent);box-shadow:0 0 16px var(--accent-line)}
.waitcard .radar span{position:absolute;inset:0;border-radius:50%;border:1.5px solid var(--accent-line);opacity:0;animation:radarRing 3.2s cubic-bezier(.2,.6,.36,1) infinite}
.waitcard .radar span:nth-child(2){animation-delay:1.05s}
.waitcard .radar span:nth-child(3){animation-delay:2.1s}
@keyframes radarRing{0%{transform:scale(.16);opacity:.9}100%{transform:scale(1.06);opacity:0}}
.waitcard .wt{font-size:13.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
.waitcard .ws{font-size:14px;color:var(--text-2);max-width:460px;line-height:1.55}
h1,h2,h3{font-family:var(--serif);font-weight:800;letter-spacing:-.02em}
.brand .mark{box-shadow:none!important;border:1px solid var(--border)}
.brand .wordmark b{font-family:var(--serif);font-weight:800;letter-spacing:-.02em}
.brand .wordmark span{letter-spacing:.18em;font-weight:700}
.navItem{position:relative;transition:background .18s ease,color .18s ease}
.navItem::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%) scaleY(0);width:3px;height:64%;border-radius:0 3px 3px 0;background:var(--accent);transition:transform .25s cubic-bezier(.16,1,.3,1)}
.navItem.active::before{transform:translateY(-50%) scaleY(1)}
.navItem.active{background:var(--accent-weak)!important;color:var(--accent)!important;font-weight:700;box-shadow:none}
.navItem.active svg{color:var(--accent)}
.navItem:not(.active):not(.soon):hover{background:var(--surface-hover)}
.navItem.soon{opacity:.5;cursor:not-allowed;pointer-events:none}
.navSoon{margin-left:auto;font-size:8.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);background:var(--accent-weak);padding:3px 8px;border-radius:999px}
.navCount{background:var(--accent);color:#fff}
.clock.tnum{font-family:var(--mono);font-weight:600;letter-spacing:0}
.kpi,.panel{animation:premIn .5s cubic-bezier(.16,1,.3,1) both}
.kpi:nth-child(2){animation-delay:.05s}.kpi:nth-child(3){animation-delay:.1s}.kpi:nth-child(4){animation-delay:.15s}
button,.btn,.icon-btn,.fp-badge,.seg,.navItem{transition:transform .12s ease,background .18s ease,color .18s ease,border-color .18s ease,box-shadow .18s ease}
button:not([disabled]):active,.btn:active,.icon-btn:active,.seg:active,.fp-badge:active{transform:scale(.96)}
.brand .mark{box-shadow:none!important;border:0!important;background:none!important;filter:drop-shadow(0 2px 10px rgba(79,140,255,.55))}
tbody tr{animation:rowIn .45s cubic-bezier(.16,1,.3,1) both}
@keyframes rowIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

/* ---- agentic pill + live aurora + oclock boost ---- */
.agent-pill{display:flex;align-items:center;gap:8px;margin-left:10px;padding:7px 13px;border-radius:999px;border:1px solid rgba(129,140,248,.35);background:rgba(99,102,241,.10);font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#a5b4fc;white-space:nowrap}
.agent-pill b{font-weight:600;color:var(--text-3)}
.agent-pill .ap-dot{width:6px;height:6px;border-radius:50%;background:#818cf8;box-shadow:0 0 8px rgba(129,140,248,.8);animation:apPulse 2.2s ease-in-out infinite}
@keyframes apPulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (max-width:1100px){.agent-pill{display:none}}
.wordmark .oclock{display:inline-grid;place-items:center;width:.88em;height:.88em;margin:0 .02em;flex:none;filter:drop-shadow(0 0 7px var(--accent-line))}
.wordmark .oclock svg{width:100%;height:100%;display:block}
#bgfx{display:none;position:fixed;inset:0;z-index:-1;pointer-events:none}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) #bgfx{display:block}}
:root[data-theme="dark"] #bgfx{display:block}
:root[data-theme="light"] #bgfx{display:none!important}

/* ---- cinematic dark backdrop (Canva artwork) + glass panels ---- */
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]) body{background-color:#07090f;background-image:linear-gradient(160deg,rgba(4,7,15,.60),rgba(4,7,15,.40) 55%,rgba(4,7,15,.55)),url("/stage-bg.png?v=2");background-size:cover;background-position:center;background-attachment:fixed;background-repeat:no-repeat}
  :root:not([data-theme="light"]) .kpi,:root:not([data-theme="light"]) .panel{background:rgba(13,16,22,.58);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
}
:root[data-theme="dark"] body{background-color:#07090f;background-image:linear-gradient(160deg,rgba(4,7,15,.60),rgba(4,7,15,.40) 55%,rgba(4,7,15,.55)),url("/stage-bg.png?v=2");background-size:cover;background-position:center;background-attachment:fixed;background-repeat:no-repeat}
:root[data-theme="dark"] .kpi,:root[data-theme="dark"] .panel{background:rgba(13,16,22,.58);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<canvas id="bgfx" aria-hidden="true"></canvas>
<header>
  <div class="head-in">
    <div class="brand">
      <img class="mark" src="/brand-mark.png" alt="SaniClock" width="52" height="60" style="object-fit:contain"/>
      <div class="wordmark"><b role="img" aria-label="SaniClock">SaniCl<span class="oclock" aria-hidden="true"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="16.5" fill="none" stroke="currentColor" stroke-width="3.6"/><g stroke="currentColor" stroke-width="2" opacity=".45"><line x1="20" y1="6.5" x2="20" y2="9.5"/><line x1="20" y1="30.5" x2="20" y2="33.5"/><line x1="6.5" y1="20" x2="9.5" y2="20"/><line x1="30.5" y1="20" x2="33.5" y2="20"/></g><line class="hh" x1="20" y1="21" x2="20" y2="13" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><line class="mh" x1="20" y1="21" x2="20" y2="9.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><line class="sh" x1="20" y1="22.5" x2="20" y2="8" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/><circle cx="20" cy="20" r="2" fill="var(--accent)"/></svg></span>ck</b><span>Time &amp; Attendance</span></div>
    </div>
    <div class="spacer"></div>
    <div class="clock tnum" id="clock" aria-hidden="true">--:--:--</div>
    <div class="live" id="live" role="status" aria-live="polite"><span class="beat"></span><span id="liveTxt">Connecting…</span></div>
    <div class="agent-pill" title="Agentic operations layer — AI oversight coming online"><span class="ap-dot"></span>Agentic&nbsp;OS <b>initializing</b></div>
    <button class="icon-btn sidebarToggle" id="sidebarToggle" title="Menu" aria-label="Toggle navigation">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    </button>
    <button class="icon-btn" id="refresh" title="Refresh (R)" aria-label="Refresh data">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg>
    </button>
    <button class="icon-btn" id="themeBtn" title="Toggle theme" aria-label="Toggle colour theme">
      <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/></svg>
      <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.2A8.3 8.3 0 1 1 9.8 3.5a6.5 6.5 0 0 0 10.7 10.7z"/></svg>
    </button>
    <a class="icon-btn" href="/api/logout" id="logoutBtn" title="Sign out" aria-label="Sign out">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>
    </a>
  </div>
</header>

<main>
<div class="sidebarScrim" id="sidebarScrim"></div>
<div class="appShell">
  <aside class="sidebar" id="sidebar">
    <div class="navGroup">
      <button class="navItem active" id="navDashboard" data-view="dashboard">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
        <span class="navLabel">Dashboard</span>
      </button>
    </div>

    <div class="navGroup">
      <div class="navGroupLabel">Report</div>
      <button class="navItem" id="navViewPunch" data-view="viewpunch">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
        <span class="navLabel">View Attendance Punch</span>
      </button>
      <button class="navItem" id="navTimecard" data-view="timecard">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/></svg>
        <span class="navLabel">Timecard Management</span>
      </button>
      <button class="navItem" id="navReport" data-view="report">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-6 3 4 5-8"/></svg>
        <span class="navLabel">Attendance Report</span>
      </button>
      <button class="navItem" id="navMend" data-view="mend">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
        <span class="navLabel">Mend Attendance Punch</span>
        <span class="navCount" id="mendPendingBadge" hidden>0</span>
      </button>
      <button class="navItem" id="navAbsence" data-view="absence" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/><path d="M9 16l2 2 4-4"/></svg>
        <span class="navLabel">Absence Requests</span>
        <span class="navCount" id="absPendingBadge" hidden>0</span>
      </button>
    </div>

    <div class="navDivider"></div>
    <div class="navGroup">
      <div class="navGroupLabel">Management</div>
      <button class="navItem" id="navGroups" data-view="groups">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 20v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        <span class="navLabel">Group Management</span>
        <span class="navCount" id="empCountBadge" hidden>0</span>
      </button>
      <button class="navItem" id="navDevices" data-view="devices">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M12 18h.01"/></svg>
        <span class="navLabel">Device Management</span>
        <span class="navCount" id="devCountBadge" hidden>0</span>
      </button>
      <button class="navItem" id="navSettings" data-view="settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span class="navLabel">Settings</span>
      </button>
    </div>
  </aside>

  <div class="content">
  <div id="dashboardView">
  <div class="page-title">
    <h1 id="dayTitle">Attendance overview</h1>
    <p id="daySub">Loading timecards…</p>
  </div>

  <div class="toolbar">
    <div class="dates" id="dates" role="tablist" aria-label="Select date"></div>
    <div class="grow" style="gap:10px;align-items:center">
      <div class="search" style="max-width:300px">
        <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-3.6-3.6"/></svg>
        <input id="q" type="search" placeholder="Search employee…" autocomplete="off" spellcheck="false" aria-label="Search by employee name"/>
        <kbd>/</kbd>
      </div>
      <div class="export-wrap">
        <button class="btn-primary" id="exportBtn" title="Export payroll CSV for this week" aria-label="Export payroll">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
          <span>Export payroll</span>
        </button>
        <button class="caret-btn" id="exportCaret" title="Choose export range" aria-label="Choose export range" aria-haspopup="true" aria-expanded="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div id="exportPop" class="pop" role="dialog" aria-label="Payroll export range" hidden>
          <label><input type="radio" name="exrange" value="week" checked/> This week</label>
          <label><input type="radio" name="exrange" value="all"/> All dates</label>
          <label><input type="radio" name="exrange" value="custom"/> Custom…</label>
          <div class="customrow" hidden id="exCustom">
            <input type="date" id="exStart" aria-label="Start date"/>
            <input type="date" id="exEnd" aria-label="End date"/>
          </div>
          <div class="receipt" id="exReceipt"></div>
          <div class="note" id="exNote" hidden></div>
          <button class="btn-primary" id="exConfirm">Export CSV</button>
          <button class="btn-primary" id="exPaysheet" title="Bi-weekly attendance sheet (Excel) for the pay period containing the selected date" style="margin-top:6px">Pay-period sheet (.xls)</button>
          <button class="btn-primary" id="exEmailReport" title="Email a branded payroll report with per-department workbooks + a punch card viewer" style="margin-top:6px">Email report&hellip;</button>
        </div>
      </div>
    </div>
  </div>

  <div class="chips" id="chips" role="group" aria-label="Filter by shift"></div>

  <div id="alert"></div>
  <div class="kpis" id="kpis"></div>
  <div class="kpi-note" id="kpiNote"></div>

  <div class="panels">
    <div class="panel">
      <div class="ptitle"><h3>Headcount Trend</h3><span class="note" id="trendNote"></span></div>
      <p class="psub">People present (clocked in) across the last 7 report days</p>
      <div id="chartTrend"></div>
    </div>
    <div class="panel">
      <div class="ptitle"><h3>Roster by Shift</h3><span class="note" id="donutNote"></span></div>
      <p class="psub">Tap a shift to filter the floor &amp; table below</p>
      <div class="donut-wrap"><div id="chartDonut"></div><div class="legend" id="donutLegend"></div></div>
    </div>
  </div>

  <div class="panels two">
    <div class="panel">
      <div class="ptitle"><h3>Hours Worked by Shift</h3><span class="note" id="hoursNote"></span></div>
      <p class="psub">Payable minutes (our engine), colour-coded by shift family</p>
      <div id="chartHours"></div>
    </div>
    <div class="panel">
      <div class="ptitle"><h3>Clock-in Activity</h3><span class="note" id="histNote"></span></div>
      <p class="psub">When people punched in, stacked by shift — reveals the shift waves</p>
      <div id="chartHist"></div>
    </div>
  </div>

  <section id="floorSec">
    <div class="sec-head">
      <h2>Currently on the floor</h2><span class="count-badge" id="inCount">0</span>
      <span class="hint">Live headcount · clocked in, not out</span>
    </div>
    <div id="floor"></div>
  </section>

  <section id="excSec">
    <div class="sec-head">
      <h2>Compliance &amp; Exceptions</h2><span class="count-badge" id="excCount">0</span>
      <span class="count-badge" id="excSev">0 error · 0 warn</span>
      <span class="hint">Missing punches · meal-period (total-break ≥30 min only; break placement before 5th hour unverifiable) · anomalies · rounding</span>
    </div>
    <div class="segbar" id="excSeg" role="group" aria-label="Filter compliance flags" style="margin:0 2px 12px;overflow-x:auto">
      <button class="seg active" data-ex="all">All <span class="n" id="ex-all">0</span></button>
      <button class="seg" data-ex="missing">Missing punch <span class="n" id="ex-missing">0</span></button>
      <button class="seg" data-ex="meal">Meal <span class="n" id="ex-meal">0</span></button>
      <button class="seg" data-ex="anomaly">Anomaly <span class="n" id="ex-anomaly">0</span></button>
      <button class="seg" data-ex="rounding">Rounding <span class="n" id="ex-rounding">0</span></button>
    </div>
    <div id="exceptions"></div>
  </section>

  <section>
    <div class="sec-head">
      <h2>Timecards</h2><span class="count-badge" id="tcCount">0</span>
      <span class="hint">Click a column to sort</span>
    </div>
    <div class="roster">
      <div class="roster-top">
        <div class="segbar" id="statusSeg" role="group" aria-label="Filter timecards by status">
          <button class="seg active" data-seg="all">All <span class="n" id="c-all">0</span></button>
          <button class="seg" data-seg="live">On floor <span class="n" id="c-live">0</span></button>
          <button class="seg" data-seg="done">Completed <span class="n" id="c-done">0</span></button>
          <button class="seg exc" data-seg="exception">Exceptions <span class="n" id="c-exc">0</span></button>
        </div>
        <div style="flex:1"></div>
        <span id="filterChip"></span>
      </div>
      <div class="tablewrap">
        <table><thead><tr id="thead"></tr></thead><tbody id="rows"></tbody></table>
      </div>
    </div>
  </section>

  <footer id="foot"><span>Connecting…</span></footer>
  </div>

  <div id="mendView" hidden>
    <div class="page-title">
      <h1>Mend Punch</h1>
      <p>Manually add a punch someone forgot, then approve it into the record — or reject it. Approved entries flow into pairing and payroll exactly like a real device punch.</p>
    </div>
    <div class="toolbar">
      <div class="segbar" id="mendSeg" role="group" aria-label="Filter mend punches">
        <button class="seg active" data-mseg="pending">Pending <span class="n" id="m-pending">0</span></button>
        <button class="seg" data-mseg="approved">Approved <span class="n" id="m-approved">0</span></button>
        <button class="seg" data-mseg="rejected">Rejected <span class="n" id="m-rejected">0</span></button>
        <button class="seg" data-mseg="all">All <span class="n" id="m-all">0</span></button>
        <button class="seg" data-mseg="absence">Absence approvals <span class="n" id="m-absence">0</span></button>
      </div>
      <div class="grow"></div>
      <button class="btn-primary" id="addPunchBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        <span>Add Punch</span>
      </button>
    </div>
    <section>
      <div class="roster">
        <div class="tablewrap">
          <table>
            <thead><tr><th>Employee</th><th>Date</th><th>Time</th><th>Remarks</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody id="mendRows"></tbody>
          </table>
        </div>
      </div>
    </section>
  </div>

  <div id="absenceView" hidden>
    <div class="page-title">
      <h1>Absence Requests</h1>
      <p>Employees request time off from their portal. Approve or reject here — approved leave is recorded against the employee.</p>
    </div>
    <div class="toolbar">
      <div class="segbar" id="absSeg" role="group" aria-label="Filter absence requests">
        <button class="seg active" data-aseg="pending">Pending <span class="n" id="a-pending">0</span></button>
        <button class="seg" data-aseg="approved">Approved <span class="n" id="a-approved">0</span></button>
        <button class="seg" data-aseg="rejected">Rejected <span class="n" id="a-rejected">0</span></button>
        <button class="seg" data-aseg="all">All <span class="n" id="a-all">0</span></button>
      </div>
      <div class="grow"></div>
    </div>
    <section>
      <div class="roster">
        <div class="tablewrap">
          <table>
            <thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th>Reason</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody id="absRows"></tbody>
          </table>
        </div>
      </div>
    </section>
  </div>

  <div id="viewPunchView" hidden>
    <div class="page-title">
      <h1>View Attendance Punch</h1>
      <p>Every raw punch exactly as scanned at the clock — unpaired, one row per scan.</p>
    </div>
    <div class="dvToolbar">
      <div class="search">
        <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-3.6-3.6"/></svg>
        <input id="vpQ" type="search" placeholder="Search by Person ID / Person Name…" autocomplete="off" spellcheck="false"/>
      </div>
      <span class="dvPill" id="vpCount">0 punches</span>
      <div class="grow"></div>
      <button class="btn-ghost" id="vpRefresh">Refresh</button>
    </div>
    <div class="dvWrap">
      <table class="dvTable">
        <thead><tr><th>Person Name</th><th>Person ID</th><th>Punch Date</th><th>Attendance record</th><th>Verify Type</th><th>Source</th></tr></thead>
        <tbody id="vpRows"></tbody>
      </table>
    </div>
  </div>

  <div id="timecardView" hidden>
    <div class="page-title">
      <h1>Timecard Management</h1>
      <p>Paired shifts from our re-pairing engine — clock in/out, work time, overtime, and break for every day.</p>
    </div>
    <div class="dvToolbar">
      <div class="search">
        <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-3.6-3.6"/></svg>
        <input id="tcQ" type="search" placeholder="Search by Person ID / Person Name…" autocomplete="off" spellcheck="false"/>
      </div>
      <span class="dvPill" id="tcCount2">0 rows</span>
      <div class="grow"></div>
      <button class="btn-ghost" id="tcRefresh">Refresh</button>
    </div>
    <div class="dvWrap">
      <table class="dvTable">
        <thead><tr><th>Person Name</th><th>Person ID</th><th>Date</th><th>Timesheet</th><th>Clock In</th><th>Clock Out</th><th>Total Work Time</th><th>Total Overtime</th><th>Total Time</th><th>Total Break</th><th>Status</th></tr></thead>
        <tbody id="tcRows"></tbody>
      </table>
    </div>
  </div>

  <div id="reportView" hidden>
    <div class="page-title">
      <h1>Attendance Report</h1>
      <p>Period totals per employee across every loaded date — work, overtime, and break hours.</p>
    </div>
    <div class="dvToolbar">
      <div class="search">
        <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-3.6-3.6"/></svg>
        <input id="rpQ" type="search" placeholder="Search by Person ID / Person Name…" autocomplete="off" spellcheck="false"/>
      </div>
      <span class="dvPill" id="rpCount">0 employees</span>
      <div class="grow"></div>
      <button class="btn-ghost" id="rpRefresh">Refresh</button>
    </div>
    <div class="dvWrap">
      <table class="dvTable">
        <thead><tr><th>Person ID</th><th>Person Name</th><th>Days Worked</th><th>Days Absent</th><th>Total Break Hour(s)</th><th>Total Work Hour(s)</th><th>Total Overtime Hour(s)</th><th>Total Hour(s)</th></tr></thead>
        <tbody id="rpRows"></tbody>
      </table>
    </div>
  </div>

  <div id="groupsView" hidden>
    <div class="page-title">
      <h1>Group Management</h1>
      <p>Employees for this facility — add, edit, and organize your own roster, managed entirely within SaniClock.</p>
    </div>
    <div class="dvToolbar">
      <div class="search">
        <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-3.6-3.6"/></svg>
        <input id="empQ" type="search" placeholder="Search employees…" autocomplete="off" spellcheck="false"/>
      </div>
      <span class="dvPill" id="empCount">0 employees</span>
      <div class="grow"></div>
      <button class="btn-primary" id="empAddBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg><span>Add Employee</span></button>
    </div>
    <div id="ngBar" style="display:flex;align-items:center;gap:10px;margin:0 0 14px;padding:10px 14px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);font-size:13px;flex-wrap:wrap"><span id="ngDot" style="width:9px;height:9px;border-radius:50%;background:var(--text-3);flex:none"></span><span id="ngStat" style="color:var(--text-2)">Devices: checking…</span><div class="grow"></div><button class="btn-ghost" id="ngSyncBtn">Sync fingerprint status</button><button class="btn-primary" id="ngPushBtn">Sync all to devices</button></div>
    <div class="dvWrap">
      <table class="dvTable">
        <thead><tr><th>Employee</th><th>Person ID</th><th>Department</th><th>Shift</th><th>Email</th><th>Role</th><th>Fingerprint</th><th>Actions</th></tr></thead>
        <tbody id="empRows"></tbody>
      </table>
    </div>
  </div>

  <div id="devicesView" hidden>
    <div class="page-title">
      <h1>Device Management</h1>
      <p>Time clocks for this facility. Register your new machine here, then point it at SaniClock as its server.</p>
    </div>
    <div class="alert" id="devNote" style="background:var(--accent-weak);border-color:var(--accent-line);color:var(--text)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>
      <div><b>Your TC4 syncs via secure cloud-pull.</b> Punches flow into SaniClock automatically — within about a minute of each clock-in. Nothing to set up here. <span style="opacity:.72">(A “custom server address / ADMS” is a faster direct-push method that only matters if you add a new screen-based clock — this cloud-locked TC4 can't use it, and doesn't need to.)</span></div>
    </div>
    <div class="dvToolbar">
      <span class="dvPill" id="devCount">0 devices</span>
      <div class="grow"></div>
      <button class="btn-primary" id="devAddBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg><span>Add Device</span></button>
    </div>
    <div class="dvWrap">
      <table class="dvTable">
        <thead><tr><th>Device</th><th>Serial (SN)</th><th>Model</th><th>IP Address</th><th>Site</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody id="devRows"></tbody>
      </table>
    </div>
  </div>

  <div id="settingsView" hidden>
    <div class="page-title">
      <h1>Settings</h1>
      <p>Facility and payroll configuration for this SaniClock instance.</p>
    </div>
    <div class="dvWrap" style="max-width:640px;padding:22px">
      <div class="field"><label>Facility name</label><input id="setFacility" type="text"/></div>
      <div class="field"><label>Timezone</label><input id="setTz" type="text" placeholder="America/Toronto"/></div>
      <div class="field"><label>Pay period</label><input id="setPeriod" type="text" placeholder="bi-weekly"/></div>
      <div class="field"><label>Work-week start day</label><input id="setWeekStart" type="text" placeholder="Monday"/></div>
      <div class="field"><label>Weekly OT threshold (hours)</label><input id="setOt" type="number"/></div>
      <div class="field"><label>Auto break deduction (minutes)</label><input id="setBreak" type="number"/></div>
      <div class="modal-actions"><button class="btn-primary" id="setSave">Save settings</button></div>
      <div class="dvPill" id="setStatus" style="margin-top:10px" hidden></div>
    </div>
  </div>

  </div><!-- /.content -->
</div><!-- /.appShell -->

  <div class="overlay" id="empOverlay" hidden>
    <div class="modal" role="dialog" aria-modal="true">
      <h3 id="empModalTitle">Add Employee</h3>
      <input type="hidden" id="empId"/>
      <div class="field"><label>Person ID <span class="opt">*</span></label><input id="empPid" placeholder="e.g. ABHISHEK"/></div>
      <div class="field"><label>Full name <span class="opt">*</span></label><input id="empName" placeholder="e.g. Abhishek Attri"/></div>
      <div class="field"><label>Department</label><select id="empDept"></select></div>
      <div class="field"><label>Shift / Timesheet</label><select id="empShift"></select></div>
      <div class="field"><label>Email <span class="opt">(optional)</span></label><input id="empEmail" type="email"/></div>
      <div class="field"><label>Role</label><input id="empRole" placeholder="Normal user"/></div>
      <div class="modal-err" id="empErr" hidden></div>
      <div class="modal-actions"><button class="btn-ghost" id="empCancel">Cancel</button><button class="btn-primary" id="empSave">Save</button></div>
    </div>
  </div>

  <div class="overlay" id="fpOverlay" hidden>
    <div class="modal" role="dialog" aria-modal="true">
      <h3>Enroll fingerprint</h3>
      <div class="fpWho" id="fpWho"></div>
      <div class="field"><label>Finger</label><div class="fpFingers" id="fpFingers"></div></div>
      <ol class="fpSteps">
        <li>Pick the finger above.</li>
        <li>Click <b>Start on device</b> - the TC4 enters enrollment mode for this person.</li>
        <li>Have them press that finger on the reader <b>3 times</b>.</li>
        <li>Click <b>Mark enrolled</b> to confirm it took.</li>
      </ol>
      <div class="fpNote" id="fpNote"></div>
      <div class="modal-actions">
        <button class="btn-ghost" id="fpReset">Reset</button>
        <button class="btn-ghost" id="fpCancel">Close</button>
        <button class="btn-primary" id="fpStart">Start on device</button>
        <button class="btn-primary" id="fpMark">Mark enrolled</button>
      </div>
    </div>
  </div>
  <div class="overlay" id="devOverlay" hidden>
    <div class="modal" role="dialog" aria-modal="true">
      <h3 id="devModalTitle">Add Device</h3>
      <input type="hidden" id="devId"/>
      <div class="field"><label>Serial number (SN) <span class="opt">*</span></label><input id="devSn" placeholder="e.g. CDQ4252201233"/></div>
      <div class="field"><label>Device alias</label><input id="devAlias" placeholder="e.g. Main Entrance"/></div>
      <div class="field"><label>Model</label><input id="devModel" placeholder="e.g. NG-TC4 / ZKTeco K40"/></div>
      <div class="field"><label>IP Address</label><input id="devIp" placeholder="e.g. 192.168.1.77"/></div>
      <div class="field"><label>Site</label><input id="devSite" placeholder="e.g. Main Facility"/></div>
      <div class="field"><label>Status</label><input id="devStatus" placeholder="Not connected"/></div>
      <div class="modal-err" id="devErr" hidden></div>
      <div class="modal-actions"><button class="btn-ghost" id="devCancel">Cancel</button><button class="btn-primary" id="devSave">Save</button></div>
    </div>
  </div>

  <div class="overlay" id="mendOverlay" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mendModalTitle">
      <h3 id="mendModalTitle">Add Punch</h3>
      <div class="field">
        <label for="mPerson">Employee</label>
        <input id="mPerson" list="mPersonList" placeholder="Start typing a name…" autocomplete="off"/>
        <datalist id="mPersonList"></datalist>
      </div>
      <div class="field">
        <label for="mDate">Date</label>
        <input id="mDate" type="date"/>
      </div>
      <div class="field">
        <label for="mTime">Time</label>
        <input id="mTime" type="time" step="1"/>
      </div>
      <div class="field">
        <label for="mRemarks">Remarks <span class="opt">(optional)</span></label>
        <textarea id="mRemarks" rows="2" placeholder="Why this punch is being added…"></textarea>
      </div>
      <div class="modal-err" id="mendErr" hidden></div>
      <div class="modal-actions">
        <button class="btn-ghost" id="mendCancel">Cancel</button>
        <button class="btn-primary" id="mendConfirm">Confirm</button>
      </div>
    </div>
  </div>
</main>

<script>
(function(){
  var oc=document.querySelector(".wordmark .oclock svg");
  if(!oc)return;
  var d=new Date(),sec=d.getSeconds(),mi=d.getMinutes()+sec/60,hr=(d.getHours()%12)+mi/60;
  var hh=oc.querySelector(".hh"),mh=oc.querySelector(".mh"),sh=oc.querySelector(".sh");
  var red=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(red){
    hh.setAttribute("transform","rotate("+(hr*30)+" 20 20)");
    mh.setAttribute("transform","rotate("+(mi*6)+" 20 20)");
    sh.setAttribute("transform","rotate("+(sec*6)+" 20 20)");
  }else{
    hh.style.animationDelay=(-hr*3600)+"s";
    mh.style.animationDelay=(-mi*60)+"s";
    sh.style.animationDelay=(-sec)+"s";
  }
})();
(function(){
  var cv=document.getElementById("bgfx");
  if(!cv||!cv.getContext)return;
  var t0=document.documentElement.getAttribute("data-theme");
  var dark=t0==="dark"||(t0!=="light"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);
  if(!dark)return;
  var cx=cv.getContext("2d");
  var DPR=Math.min(window.devicePixelRatio||1,2),W=0,H=0;
  function size(){W=Math.max(1,window.innerWidth);H=Math.max(1,window.innerHeight);cv.width=W*DPR;cv.height=H*DPR;cx.setTransform(DPR,0,0,DPR,0,0);}
  size();window.addEventListener("resize",size);
  var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var RIBS=[
    {y:.24,amp:26,f1:.9,f2:2.3,sp:.05,ph:0,rgb:"79,140,255",al:.10,th:150},
    {y:.66,amp:34,f1:1.1,f2:1.8,sp:.036,ph:2.2,rgb:"89,166,255",al:.07,th:190}
  ];
  var MOTES=[],i;
  for(i=0;i<48;i++)MOTES.push({x:Math.random(),y:Math.random(),r:.6+Math.random()*1.3,v:6+Math.random()*18,ph:Math.random()*6.28,tw:.3+Math.random()*.5});
  function drawRib(t,rb){
    var seg=8,top=[],bot=[],k,x,y;
    for(k=0;k<=seg;k++){
      x=-W*.08+W*1.16*k/seg;
      y=H*rb.y+Math.sin(t*rb.sp*6+k*rb.f1+rb.ph)*rb.amp+Math.sin(t*rb.sp*3.7+k*rb.f2+rb.ph*1.7)*rb.amp*.5;
      top.push([x,y]);bot.push([x,y+rb.th+Math.sin(t*rb.sp*3+k*1.3+rb.ph)*rb.th*.2]);
    }
    var g=cx.createLinearGradient(0,H*rb.y-rb.amp,0,H*rb.y+rb.th+rb.amp);
    g.addColorStop(0,"rgba("+rb.rgb+",0)");g.addColorStop(.45,"rgba("+rb.rgb+","+rb.al+")");g.addColorStop(1,"rgba("+rb.rgb+",0)");
    cx.fillStyle=g;cx.beginPath();cx.moveTo(top[0][0],top[0][1]);
    for(k=1;k<=seg;k++){var p0=top[k-1],p1=top[k];cx.quadraticCurveTo(p0[0],p0[1],(p0[0]+p1[0])/2,(p0[1]+p1[1])/2);}
    cx.lineTo(bot[seg][0],bot[seg][1]);
    for(k=seg;k>=1;k--){var q0=bot[k],q1=bot[k-1];cx.quadraticCurveTo(q0[0],q0[1],(q0[0]+q1[0])/2,(q0[1]+q1[1])/2);}
    cx.closePath();cx.fill();
  }
  function paint(t,dt){
    cx.clearRect(0,0,W,H);
    cx.globalCompositeOperation="lighter";
    for(var j=0;j<RIBS.length;j++)drawRib(t,RIBS[j]);
    for(var m2=0;m2<MOTES.length;m2++){
      var o=MOTES[m2];
      o.y-=o.v*dt/Math.max(1,H);
      if(o.y<-.03){o.y=1.03;o.x=Math.random();}
      var a=o.tw*(.45+.55*Math.sin(t*1.4+o.ph));
      if(a<=0)continue;
      cx.beginPath();cx.arc(o.x*W,o.y*H,o.r,0,6.283);
      cx.fillStyle="rgba(157,212,255,"+(a*.4).toFixed(3)+")";cx.fill();
    }
    cx.globalCompositeOperation="source-over";
  }
  if(reduce){paint(1.5,0);return;}
  var last=0,run=true;
  function frame(now){
    if(!run)return;
    var dt=Math.min(.05,(now-last)/1000||.016);last=now;
    paint(now/1000,dt);
    requestAnimationFrame(frame);
  }
  document.addEventListener("visibilitychange",function(){
    if(document.hidden){run=false;}
    else if(!run){run=true;last=performance.now();requestAnimationFrame(frame);}
  });
  requestAnimationFrame(frame);
})();
</script>
<script>
(function(){
"use strict";
var $=function(s){return document.querySelector(s);};
var DATA={ok:false,records:[],dates:[],count:0,weeks:[],csvPath:""};
var state={date:null,q:"",shift:null,seg:"all",excFilter:"all",sort:{key:"status",dir:1},lastOk:0,firstLoad:true,view:"dashboard",mendSeg:"pending"};
var MEND=[];

/* ---- shift-family colour system (charts, chips, dots) ---- */
var CATS=[
  {k:"Day",v:"--c-day"},{k:"Afternoon",v:"--c-aft"},{k:"Night",v:"--c-night"},
  {k:"P2",v:"--c-p2"},{k:"Leadership",v:"--c-lead"},{k:"Clark",v:"--c-clark"},
  {k:"Janitor",v:"--c-jan"},{k:"Other",v:"--c-other"}];
var CVAR={};CATS.forEach(function(c){CVAR[c.k]=c.v;});
// catOf: server stamps r.shiftFamily via timeEngine.catOf (lib/time-engine.js — canonical).
// Call catOf(r.shift, r) to use the pre-computed value; catOf(sh) falls back to local mirror.
function catOf(sh,rec){if(rec&&rec.shiftFamily)return rec.shiftFamily;
  var s=(sh||"").toLowerCase();
  if(!s)return "Other";
  if(s.indexOf("lead")>-1)return "Leadership";
  if(s.indexOf("clark")>-1)return "Clark";
  if(s.indexOf("jan")>-1)return "Janitor";
  if(s.indexOf("p2")>-1)return "P2";
  if(s.indexOf("night")>-1)return "Night";
  if(s.indexOf("aft")>-1)return "Afternoon";
  if(s.indexOf("day")>-1)return "Day";
  return "Other";}
function cv(k){return "var("+(CVAR[k]||"--c-other")+")";}

/* ---- helpers ---- */
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];});}
function initials(n){var p=String(n||"").trim().split(/\\s+/).filter(Boolean);
  if(!p.length)return "?";
  if(p.length===1)return (p[0].slice(0,2)||"?").toUpperCase();
  return (p[0].charAt(0)+p[p.length-1].charAt(0)).toUpperCase();}
function hue(n){var h=0,s=String(n||"");for(var i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))>>>0;}return h%360;}
function avatarStyle(n){var h=hue(n);return "background:linear-gradient(145deg,hsl("+h+" 62% 55%),hsl("+((h+40)%360)+" 60% 47%))";}
function hm(min){min=Math.max(0,Math.round(min||0));var h=Math.floor(min/60);var m=min%60;
  if(h>=100)return (Math.round(min/6)/10)+"h";return h+"h "+m+"m";}
function hmShort(min){min=Math.max(0,Math.round(min||0));var h=Math.floor(min/60),m=min%60;return h+"h "+(m<10?"0":"")+m+"m";}
function clk(t){if(!t)return "";var p=String(t).split(":");return p.length>=2?p[0]+":"+p[1]:t;}
function pad(n){return n<10?"0"+n:""+n;}
var WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
var MO=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function parseDate(d){var p=String(d||"").split("/");if(p.length<3)return null;return new Date(+p[2],+p[0]-1,+p[1]);}
function dLabel(d){var dt=parseDate(d);return dt?WD[dt.getDay()]:"";}
function dSub(d){var dt=parseDate(d);return dt?(MO[dt.getMonth()]+" "+dt.getDate()):d;}
function fullDate(d){var dt=parseDate(d);return dt?WD[dt.getDay()]+", "+MO[dt.getMonth()]+" "+dt.getDate()+", "+dt.getFullYear():d;}

/* ---- BUG A: only truly-live open punches count as "on shift" ---- */
function sameAsRealToday(d){var p=parseDate(d);if(!p)return false;var n=new Date();
  return p.getFullYear()===n.getFullYear()&&p.getMonth()===n.getMonth()&&p.getDate()===n.getDate();}
function clockInMs(r){var dp=parseDate(r.date);if(!dp)return null;
  var tp=String(r.clockIn||"").split(":");if(tp.length<2)return null;
  return new Date(dp.getFullYear(),dp.getMonth(),dp.getDate(),+tp[0]||0,+tp[1]||0,+(tp[2]||0)).getTime();}
var MAX_LIVE_MS=16*3600*1000;
// returns elapsed ms if the punch is *plausibly live*, else null
function liveElapsed(r){
  if(r.status!=="in")return null;
  if(!sameAsRealToday(r.date))return null;      // not the real current local date
  var ms=clockInMs(r);if(ms==null)return null;
  var e=Date.now()-ms;
  if(e<0||e>=MAX_LIVE_MS)return null;           // impossible / stale (>16h)
  return e;}
function isLive(r){return liveElapsed(r)!=null;}
function isMissingOut(r){return r.status==="in"&&!isLive(r);}   // open but not live => missing clock-out

/* ---- Phase-1 flags (from our engine, delivered per-record) ---- */
var FCODE={MISSING_OUT:"MISSING",MEAL_PERIOD:"MEAL",OUT_BEFORE_IN:"OUT<IN",SUB_MINUTE_SHIFT:"SUB-MIN",
  IMPLAUSIBLE_LENGTH:"LONG",OUTSIDE_WINDOW:"WINDOW",DUPLICATE_PUNCH:"DUP",OVERLAPPING_SHIFT:"OVERLAP",
  ROUNDING_UNFAVORABLE:"ROUND",ABNORMAL:"ABN",
  ESA_REST_11HR:"11H-REST",ESA_REST_24HR:"24H-REST",SHIFT_MISMATCH:"SHIFT≠IN"};
function fPrefix(code){return FCODE[code]||String(code||"").replace(/_/g,"·");}
function fBucket(code){
  if(code==="MISSING_OUT")return "missing";
  if(code==="MEAL_PERIOD")return "meal";
  if(code==="ROUNDING_UNFAVORABLE")return "rounding";
  return "anomaly";}
/* combined display flags for a record: engine flags (minus a false missing-out
   for a plausibly-live worker) + the vendor Abnormal Situation as a chip. */
function recFlags(r){
  var out=[];var fl=r.flags||[];
  for(var i=0;i<fl.length;i++){var f=fl[i];
    if(f.code==="MISSING_OUT"&&isLive(r))continue; // live worker isn't a missing-out
    out.push(f);}
  if(r.abnormal)out.push({code:"ABNORMAL",severity:"warn",message:String(r.abnormal)});
  return out;}
function isException(r){return recFlags(r).length>0;}

/* weekly OT (OURS) + CSV OT for the Mon–Sun week containing a given date */
function weekOtForDate(dstr){
  var recs=recsFor(dstr);var wws=null;
  for(var i=0;i<recs.length;i++){if(recs[i].workWeekStart){wws=recs[i].workWeekStart;break;}}
  var ot=0,csv=0;
  if(wws){
    var wk=DATA.weeks||[];for(var j=0;j<wk.length;j++)if(wk[j].weekStart===wws)ot+=(wk[j].overtimeMin||0);
    var all=DATA.records||[];for(var m=0;m<all.length;m++)if(all[m].workWeekStart===wws)csv+=(all[m].otMin||0);
  }
  return {ot:ot,csv:csv,ws:wws};}
function isoLabel(iso){if(!iso)return "";var p=String(iso).split("-");if(p.length<3)return iso;
  var dt=new Date(+p[0],+p[1]-1,+p[2]);return MO[dt.getMonth()]+" "+dt.getDate();}

/* ---- data slices ---- */
function recsFor(date){var a=DATA.records||[],o=[];for(var i=0;i<a.length;i++)if(a[i].date===date)o.push(a[i]);return o;}
function statOf(recs){var s={sched:recs.length,present:0,live:0,done:0,absent:0,work:0,ot:0,brk:0,abn:0,miss:0,
    net:0,night:0,flags:0,fMiss:0,fMeal:0,fAnom:0,fRound:0};
  for(var i=0;i<recs.length;i++){var r=recs[i];
    if(r.clockIn)s.present++;
    if(isLive(r))s.live++;else if(r.status==="done")s.done++;else if(r.status==="absent")s.absent++;
    if(isMissingOut(r))s.miss++;
    s.work+=r.workMin;s.ot+=r.otMin;s.brk+=r.breakMin;if(r.abnormal)s.abn++;
    if(typeof r.netMin==="number")s.net+=r.netMin;
    if(typeof r.nightMin==="number")s.night+=r.nightMin;
    var fl=recFlags(r);s.flags+=fl.length;
    for(var k=0;k<fl.length;k++){var b=fBucket(fl[k].code);
      if(b==="missing")s.fMiss++;else if(b==="meal")s.fMeal++;else if(b==="rounding")s.fRound++;else s.fAnom++;}}
  s.exc=recs.filter(isException).length;
  return s;}
function presentSeries(){var asc=(DATA.dates||[]).slice().reverse();
  return asc.map(function(d){var rc=recsFor(d),p=0;for(var i=0;i<rc.length;i++)if(rc[i].clockIn)p++;return {date:d,present:p};});}

/* ================= CHARTS (hand-drawn SVG) ================= */
function svg(w,h,inner){return '<svg class="chart" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="xMidYMid meet" role="img">'+inner+'</svg>';}

function trendChart(){
  var data=presentSeries();var W=560,H=210,PL=34,PR=16,PT=18,PB=34;var iw=W-PL-PR,ih=H-PT-PB;
  var max=1;data.forEach(function(d){if(d.present>max)max=d.present;});max=Math.ceil(max/10)*10||10;
  var n=data.length;var x=function(i){return PL+(n<=1?iw/2:iw*i/(n-1));};var y=function(v){return PT+ih-(v/max)*ih;};
  var g="";var steps=4;
  for(var s=0;s<=steps;s++){var val=max*s/steps;var yy=y(val);
    g+='<line class="grline" x1="'+PL+'" y1="'+yy.toFixed(1)+'" x2="'+(W-PR)+'" y2="'+yy.toFixed(1)+'"/>';
    g+='<text x="'+(PL-7)+'" y="'+(yy+3).toFixed(1)+'" text-anchor="end">'+Math.round(val)+'</text>';}
  var line="",area="";
  data.forEach(function(d,i){var px=x(i).toFixed(1),py=y(d.present).toFixed(1);line+=(i?"L":"M")+px+" "+py+" ";area+=(i?"L":"M")+px+" "+py+" ";});
  area="M"+x(0).toFixed(1)+" "+(PT+ih)+" "+area.replace(/^M/,"L")+"L"+x(n-1).toFixed(1)+" "+(PT+ih)+" Z";
  g+='<defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity="0.30"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>';
  g+='<path class="area-fill" d="'+area+'" fill="url(#tg)"/>';
  g+='<path class="area-line" d="'+line+'" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
  data.forEach(function(d,i){var px=x(i),py=y(d.present);var sel=(d.date===state.date);
    if(sel)g+='<line x1="'+px.toFixed(1)+'" y1="'+PT+'" x2="'+px.toFixed(1)+'" y2="'+(PT+ih)+'" stroke="var(--accent)" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>';
    g+='<circle class="dot" cx="'+px.toFixed(1)+'" cy="'+py.toFixed(1)+'" r="'+(sel?4.8:3.2)+'" fill="var(--surface)" stroke="var(--accent)" stroke-width="'+(sel?3:2)+'"><title>'+dLabel(d.date)+" "+dSub(d.date)+" — "+d.present+' present</title></circle>';
    g+='<text x="'+px.toFixed(1)+'" y="'+(H-13)+'" text-anchor="middle" '+(sel?'style="fill:var(--text);font-weight:600"':'')+'>'+dLabel(d.date)+'</text>';
    g+='<text x="'+px.toFixed(1)+'" y="'+(H-2)+'" text-anchor="middle" style="font-size:9px">'+dSub(d.date)+'</text>';
    if(sel)g+='<g transform="translate('+px.toFixed(1)+','+(py-14).toFixed(1)+')"><rect x="-15" y="-14" width="30" height="18" rx="5" fill="var(--accent)"/><text x="0" y="-1" text-anchor="middle" style="fill:#fff;font-weight:700;font-size:11px">'+d.present+'</text></g>';});
  $("#chartTrend").innerHTML=svg(W,H,g);
  var arr=data.map(function(d){return d.present;});
  $("#trendNote").textContent="peak "+Math.max.apply(null,arr)+" · low "+Math.min.apply(null,arr);}

function hoursChart(recs){
  var by={};CATS.forEach(function(c){by[c.k]=0;});recs.forEach(function(r){by[catOf(r.shift,r)]+=(typeof r.netMin==="number"?r.netMin:0);});
  var rows=CATS.map(function(c){return {k:c.k,v:by[c.k]};}).filter(function(d){return d.v>0;}).sort(function(a,b){return b.v-a.v;});
  if(!rows.length){$("#chartHours").innerHTML='<div class="empty">No hours logged for this day.</div>';$("#hoursNote").textContent="";return;}
  var max=0;rows.forEach(function(d){if(d.v>max)max=d.v;});
  var W=560,rowH=30,PT=6,PL=90,PR=66,barMax=W-PL-PR;var H=PT*2+rows.length*rowH;var g="";
  rows.forEach(function(d,i){var by2=PT+i*rowH+rowH/2;var w=Math.max(3,(d.v/max)*barMax);var dim=(state.shift&&state.shift!==d.k)?" dim":"";
    g+='<text class="barlabel" x="'+(PL-10)+'" y="'+(by2+3.5)+'" text-anchor="end" style="font-size:11.5px">'+d.k+'</text>';
    g+='<rect class="bar-track" x="'+PL+'" y="'+(by2-8)+'" width="'+barMax+'" height="16" rx="5"/>';
    g+='<rect class="bar-seg'+dim+'" x="'+PL+'" y="'+(by2-8)+'" width="'+w.toFixed(1)+'" height="16" rx="5" fill="'+cv(d.k)+'"><title>'+d.k+" — "+hmShort(d.v)+'</title></rect>';
    g+='<text class="val" x="'+(PL+w+8)+'" y="'+(by2+3.5)+'">'+hm(d.v)+'</text>';});
  $("#chartHours").innerHTML=svg(W,H,g);
  $("#hoursNote").textContent=hm(rows.reduce(function(a,d){return a+d.v;},0))+" total";}

function donutChart(recs){
  var by={};CATS.forEach(function(c){by[c.k]=0;});recs.forEach(function(r){by[catOf(r.shift,r)]++;});
  var items=CATS.map(function(c){return {k:c.k,v:by[c.k]};}).filter(function(d){return d.v>0;});
  var total=items.reduce(function(a,d){return a+d.v;},0)||0;
  var S=176,cx=S/2,cy=S/2,r=64,sw=22,C=2*Math.PI*r;
  var g='<g transform="rotate(-90 '+cx+' '+cy+')"><circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="var(--grid)" stroke-width="'+sw+'"/>';
  var acc=0;
  items.forEach(function(d){var frac=total?d.v/total:0;var len=frac*C;var gap=items.length>1?1.5:0;var dim=(state.shift&&state.shift!==d.k)?" dim":"";
    g+='<circle class="donut-seg'+dim+'" cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+cv(d.k)+'" stroke-width="'+sw+'" stroke-dasharray="'+Math.max(0,len-gap).toFixed(2)+' '+(C-Math.max(0,len-gap)).toFixed(2)+'" stroke-dashoffset="'+(-acc).toFixed(2)+'" stroke-linecap="butt"><title>'+d.k+" — "+d.v+" ("+Math.round(frac*100)+'%)</title></circle>';
    acc+=len;});
  g+='</g><g class="donut-hole"><text class="big" x="'+cx+'" y="'+(cy-2)+'" text-anchor="middle">'+total+'</text><text class="lbl" x="'+cx+'" y="'+(cy+16)+'" text-anchor="middle">on roster</text></g>';
  $("#chartDonut").innerHTML=svg(S,S,g);
  $("#donutNote").textContent=items.length+" shifts";
  var lg="";items.slice().sort(function(a,b){return b.v-a.v;}).forEach(function(d){
    var act=state.shift===d.k?" active":"";var pct=total?Math.round(d.v/total*100):0;
    lg+='<div class="lgi'+act+'" data-shift="'+esc(d.k)+'" role="button" tabindex="0" aria-pressed="'+(state.shift===d.k)+'">'+
      '<span class="sw" style="background:'+cv(d.k)+'"></span><span class="nm">'+d.k+'</span><span class="ct">'+d.v+'</span><span class="pct">'+pct+'%</span></div>';});
  $("#donutLegend").innerHTML=lg;}

function histChart(recs){
  var bins=[];for(var h=0;h<24;h++)bins.push({});var maxTot=0;
  recs.forEach(function(r){if(!r.clockIn)return;var hr=parseInt(String(r.clockIn).split(":")[0],10);
    if(isNaN(hr)||hr<0||hr>23)return;var k=catOf(r.shift,r);bins[hr][k]=(bins[hr][k]||0)+1;});
  bins.forEach(function(b){var t=0;for(var kk in b)t+=b[kk];if(t>maxTot)maxTot=t;});
  if(maxTot===0){$("#chartHist").innerHTML='<div class="empty">No clock-ins recorded.</div>';$("#histNote").textContent="";return;}
  var W=560,H=180,PL=24,PR=10,PT=12,PB=26;var iw=W-PL-PR,ih=H-PT-PB;var bw=iw/24;var g="";
  var steps=3;for(var s=0;s<=steps;s++){var val=Math.round(maxTot*s/steps);var yy=PT+ih-(val/maxTot)*ih;
    g+='<line class="grline" x1="'+PL+'" y1="'+yy.toFixed(1)+'" x2="'+(W-PR)+'" y2="'+yy.toFixed(1)+'"/>';
    g+='<text x="'+(PL-4)+'" y="'+(yy+3).toFixed(1)+'" text-anchor="end" style="font-size:9px">'+val+'</text>';}
  var peakHr=0,peakVal=0;var order=CATS.map(function(c){return c.k;});
  for(var hr=0;hr<24;hr++){var b=bins[hr];var x0=PL+hr*bw;var yBase=PT+ih;var tot=0;
    for(var oi=0;oi<order.length;oi++){var k=order[oi];var c=b[k]||0;if(!c)continue;var hgt=(c/maxTot)*ih;yBase-=hgt;tot+=c;
      var dim=(state.shift&&state.shift!==k)?" dim":"";
      g+='<rect class="hist-seg'+dim+'" x="'+(x0+1.2).toFixed(1)+'" y="'+yBase.toFixed(1)+'" width="'+(bw-2.4).toFixed(1)+'" height="'+hgt.toFixed(1)+'" fill="'+cv(k)+'" rx="1.5"><title>'+pad(hr)+':00 — '+k+" "+c+'</title></rect>';}
    if(tot>peakVal){peakVal=tot;peakHr=hr;}}
  for(var t2=0;t2<24;t2+=3){var lx=PL+t2*bw+bw/2;g+='<text x="'+lx.toFixed(1)+'" y="'+(H-9)+'" text-anchor="middle" style="font-size:9px">'+pad(t2)+'</text>';}
  $("#chartHist").innerHTML=svg(W,H,g);
  $("#histNote").textContent="peak "+pad(peakHr)+":00 ("+peakVal+")";}

/* ================= KPI ROW ================= */
function spark(arr,selIdx){
  var W=60,H=22,n=arr.length;var max=Math.max.apply(null,arr)||1,min=Math.min.apply(null,arr);var rng=(max-min)||1;
  var x=function(i){return n<=1?W/2:2+(W-4)*i/(n-1);};var y=function(v){return 2+(H-4)*(1-(v-min)/rng);};
  var p="";arr.forEach(function(v,i){p+=(i?"L":"M")+x(i).toFixed(1)+" "+y(v).toFixed(1)+" ";});
  var g='<path d="'+p+'" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>';
  if(selIdx>=0)g+='<circle cx="'+x(selIdx).toFixed(1)+'" cy="'+y(arr[selIdx]).toFixed(1)+'" r="2.4" fill="var(--accent)"/>';
  return '<svg class="spark" viewBox="0 0 '+W+' '+H+'" aria-hidden="true">'+g+'</svg>';}
function deltaN(cur,prev){
  if(prev==null)return '<span class="delta-flat">no prior day</span>';
  var d=cur-prev;if(d===0)return '<span class="delta-flat">no change vs prev</span>';
  var up=d>0;return '<span class="'+(up?"delta-up":"delta-dn")+'"><b>'+(up?"▲":"▼")+" "+Math.abs(d)+'</b></span> vs prev';}
function deltaH(cur,prev){
  if(prev==null)return '<span class="delta-flat">no prior day</span>';
  var d=cur-prev;if(Math.abs(d)<1)return '<span class="delta-flat">flat vs prev</span>';
  var up=d>0;return '<span class="'+(up?"delta-up":"delta-dn")+'"><b>'+(up?"▲":"▼")+" "+hm(Math.abs(d))+'</b></span> vs prev';}

var OURS='<span class="badge-ours" aria-hidden="true">OURS</span>';
function renderKpis(recs){
  var s=statOf(recs);
  var dates=DATA.dates||[];var si=dates.indexOf(state.date);
  var prev=(si>=0&&si<dates.length-1)?statOf(recsFor(dates[si+1])):null;
  var series=presentSeries();var arr=series.map(function(d){return d.present;});
  var selIdx=series.map(function(d){return d.date;}).indexOf(state.date);
  var rate=s.sched?Math.round(s.present/s.sched*100):0;
  var floorSub=s.live?(s.live+" on shift now"):(sameAsRealToday(state.date)?"floor is clear":"not a live date");

  /* Tile 5 — Payable Hours (OURS netMin) vs CSV workMin reference */
  var payDelta=s.net-s.work; // >1 => CSV under-credited, <-1 => CSV over-counted
  var paySub=(payDelta>1)
    ? '<span class="delta-dn"><b>CSV short '+hm(payDelta)+'</b></span>'
    : (payDelta<-1)
    ? '<span class="delta-dn"><b>CSV over-counts '+hm(-payDelta)+' — verify overnight attribution</b></span>'
    : '<span class="delta-flat">CSV logged '+hm(s.work)+'</span>';

  /* Tile 6 — Weekly OT · all staff (OURS weekly-44, facility total) vs CSV OT for the same week */
  var wk=weekOtForDate(state.date);var otDiv;
  if(wk.ot>wk.csv)otDiv='<span class="delta-dn"><b>▲ '+hm(wk.ot-wk.csv)+'</b></span> over CSV';
  else if(wk.ot===wk.csv)otDiv='<span class="delta-flat">matches CSV</span>';
  else otDiv='<span class="delta-flat">CSV over-counted '+hm(wk.csv-wk.ot)+'</span>';
  otDiv+='<br><span style="font-size:0.78em;opacity:0.7">total across all employees (see Payroll export for per-person)</span>';
  var otCap=wk.ws?'week of '+isoLabel(wk.ws)+' (Mon–Sun)':'';
  // Blocker fix: warn when missing-punch records may under-state weekly OT
  var wkMissPids={};
  if(wk.ws){var _all=DATA.records||[];for(var _i=0;_i<_all.length;_i++){var _r=_all[_i];
    if(_r.workWeekStart===wk.ws&&recFlags(_r).some(function(f){return f.code==="MISSING_OUT";}))wkMissPids[_r.pid||_r.person]=true;}}
  var wkMissCount=Object.keys(wkMissPids).length;
  if(wkMissCount>0)otDiv+='<br><span class="delta-dn" style="font-size:0.78em">⚠ '+wkMissCount+' employee'+(wkMissCount>1?'s':'')+' have open punches — OT may be understated</span>';

  /* Tile 8 — Compliance (total flag count) */
  var compSub=s.flags?(s.fMiss+' missing · '+s.fMeal+' meal · '+s.fAnom+' anomaly'):'all clear';

  var tiles=[
    {l:"Scheduled",v:s.sched,d:"roster for this day"},
    {l:"Present",v:s.present,d:'<span class="delta-flat">'+rate+'% attendance</span>',cls:"hero",meter:rate,seg:"all",spark:spark(arr,selIdx)},
    {l:"On Floor",v:s.live,d:floorSub,cls:s.live?"hero":"",seg:"live"},
    {l:"Completed",v:s.done,d:deltaN(s.done,prev&&prev.done),cls:"blue",seg:"done"},
    {l:"Payable Hours",v:hm(s.net),d:paySub,badge:OURS},
    {l:"Break Time",v:hm(recs.reduce(function(a,r){return a+((r&&r.valid)?(r.breakMin||0):0);},0)),d:"30-min meal · auto-deducted",cls:"blue",badge:OURS},
    {l:"Night",v:hm(s.night),d:"22:00–06:00 band",cls:"night",badge:OURS},
    {l:"Compliance",v:s.flags,d:compSub,cls:s.flags?"red":"hero",seg:"exception"}
  ];
  $("#kpis").innerHTML=tiles.map(function(t){
    var click=t.seg?" clickable"+(state.seg===t.seg&&t.seg!=="all"?" active":""):"";
    return '<div class="kpi'+(t.cls?" "+t.cls:"")+click+'"'+(t.seg?' data-seg="'+t.seg+'" role="button" tabindex="0"':'')+'>'+
      '<div class="kl"><span class="kdot"></span>'+t.l+(t.badge||"")+(t.cap?'<span class="kcap">'+esc(t.cap)+'</span>':'')+'</div>'+
      '<div class="kv tnum">'+t.v+'</div>'+
      '<div class="kd">'+t.d+'</div>'+
      (t.meter!=null?'<div class="meter"><i style="width:'+t.meter+'%"></i></div>':'')+
      (t.spark||"")+'</div>';
  }).join("");
  var noteEl=$("#kpiNote");
  if(noteEl)noteEl.textContent="Payable and Night hours are computed by our engine — exact minute, 30-minute meal auto-deducted, work week Monday–Sunday. CSV columns are the vendor's reference figures.";}

/* ================= currently on floor ================= */
function renderFloor(recs){
  var list=filterBase(recs).filter(isLive);
  list.sort(function(a,b){return String(a.clockIn).localeCompare(String(b.clockIn));});
  $("#inCount").textContent=list.length;
  if(!list.length){
    var msg=(state.shift||state.q)?"No one on the floor matches this filter"
      :(sameAsRealToday(state.date)?"No one is currently clocked in":"This is a past report date — no live shifts");
    $("#floor").innerHTML='<div class="panel"><div class="empty">'+
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'+
      '<div class="t">'+msg+'</div><div>All punches for this day are closed out.</div></div></div>';
    return;}
  $("#floor").innerHTML='<div class="people">'+list.map(function(r){var k=catOf(r.shift,r);var e=liveElapsed(r);var ms=clockInMs(r);
    return '<div class="person" style="--sc:'+cv(k)+'">'+
      '<div class="av" style="'+avatarStyle(r.person)+'">'+esc(initials(r.person))+'</div>'+
      '<div class="meta"><div class="nm">'+esc(r.person)+'</div>'+
      '<div class="sh"><span class="sdot" style="background:'+cv(k)+'"></span>'+esc(r.shift||k)+' · in '+esc(clk(r.clockIn))+'</div>'+
      (r.abnormal?'<span class="tagx">! '+esc(r.abnormal)+'</span>':'')+'</div>'+
      '<div class="since"><div class="t js-el" data-start="'+ms+'">'+dur(e)+'</div><div class="k">on shift</div></div>'+
    '</div>';}).join("")+'</div>';}

function dur(ms){var m=Math.max(0,Math.floor((ms||0)/60000));var h=Math.floor(m/60);m=m%60;return h+"h "+pad(m)+"m";}

/* ================= exceptions ================= */
function renderExceptions(recs){
  var base=filterBase(recs);
  var cards=[];var totalFlags=0,errC=0,warnC=0;
  var cnt={all:0,missing:0,meal:0,anomaly:0,rounding:0};
  base.forEach(function(r){var fl=recFlags(r);if(!fl.length)return;
    cards.push({r:r,fl:fl});
    fl.forEach(function(f){totalFlags++;cnt.all++;cnt[fBucket(f.code)]++;
      if(f.severity==="error")errC++;else if(f.severity==="warn")warnC++;});});
  cards.sort(function(a,b){return String(a.r.person).localeCompare(String(b.r.person));});
  // seg counts + active state
  ["all","missing","meal","anomaly","rounding"].forEach(function(kk){var el=$("#ex-"+kk);if(el)el.textContent=cnt[kk];});
  Array.prototype.forEach.call(document.querySelectorAll("#excSeg .seg"),function(b){b.classList.toggle("active",b.getAttribute("data-ex")===state.excFilter);});
  // header badges
  var badge=$("#excCount");badge.textContent=totalFlags;badge.className="count-badge"+(totalFlags?" hot":"");
  var sev=$("#excSev");if(sev){sev.textContent=errC+" error · "+warnC+" warn";sev.style.display=totalFlags?"":"none";}
  // apply sub-filter
  var shown=(state.excFilter==="all")?cards:cards.filter(function(x){
    return x.fl.some(function(f){return fBucket(f.code)===state.excFilter;});});
  if(!shown.length){
    var clean=(state.excFilter==="all");
    $("#exceptions").innerHTML='<div class="panel"><div class="empty">'+
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'+
      '<div class="t">'+(clean?'No compliance issues for this day':'No flags in this category')+'</div>'+
      '<div>'+(clean?'Every punch is complete, meal-compliant, and reconciles with the CSV.':'Try another filter above.')+'</div></div></div>';
    return;}
  $("#exceptions").innerHTML='<div class="people">'+shown.map(function(x){var r=x.r,k=catOf(r.shift,r);
    var hasErr=x.fl.some(function(f){return f.severity==="error";});
    var chips=x.fl.map(function(f){
      var sc=f.severity==="error"?" err":(f.severity==="info"?" info":"");
      var msg=f.message;
      if(f.code==="MEAL_PERIOD")msg+=" (total-break check only — break placement unverifiable)";
      return '<span class="tagx'+sc+'"><span class="fcode">'+esc(fPrefix(f.code))+'</span>'+esc(msg)+'</span>';}).join("");
    return '<div class="person exc'+(hasErr?" error":"")+'">'+
      '<div class="av" style="'+avatarStyle(r.person)+'">'+esc(initials(r.person))+'</div>'+
      '<div class="meta"><div class="nm">'+esc(r.person)+'</div>'+
      '<div class="sh"><span class="sdot" style="background:'+cv(k)+'"></span>'+esc(r.shift||k)+'</div>'+chips+'</div>'+
    '</div>';}).join("")+'</div>';}

/* ================= table ================= */
var COLS=[
  {k:"person",t:"Employee"},{k:"shift",t:"Shift"},{k:"clockIn",t:"Clock in"},{k:"clockOut",t:"Clock out"},
  {k:"netMin",t:"Payable",r:true,title:"Our exact-minute payable time (clock span minus break)."},
  {k:"workMin",t:"Worked · CSV",r:true,title:"Imported source figure — reference only."},
  {k:"otMin",t:"OT · CSV",r:true,title:"Imported source figure. Authoritative OT is weekly — see Payroll export."},
  {k:"nightMin",t:"Night",r:true,title:"Our minutes worked in the 22:00–06:00 premium band."},
  {k:"breakMin",t:"Break",r:true},{k:"status",t:"Status"}];
var NUMK={netMin:1,workMin:1,otMin:1,nightMin:1,breakMin:1};
var STORDER={in:0,done:1,absent:2};
function renderHead(){
  $("#thead").innerHTML=COLS.map(function(c){var on=state.sort.key===c.k;
    var aria=on?' aria-sort="'+(state.sort.dir>0?"ascending":"descending")+'"':'';
    var car=on?(state.sort.dir>0?"↑":"↓"):"↕";
    var ttl=c.title?' title="'+esc(c.title)+'"':'';
    return '<th class="'+(c.r?"r":"")+'" data-k="'+c.k+'"'+aria+ttl+'>'+esc(c.t)+'<span class="car">'+car+'</span></th>';}).join("");}
function filterBase(recs){ // shift + search only (used by floor / exceptions / seg counts)
  var q=state.q.toLowerCase();
  return recs.filter(function(r){
    if(state.shift&&catOf(r.shift,r)!==state.shift)return false;
    if(q&&String(r.person).toLowerCase().indexOf(q)<0)return false;
    return true;});}
function segMatch(r){
  if(state.seg==="live")return isLive(r);
  if(state.seg==="done")return r.status==="done";
  if(state.seg==="exception")return isException(r);
  return true;}
function visible(recs){return filterBase(recs).filter(segMatch);}
function sortRecs(recs){
  var k=state.sort.key,dir=state.sort.dir;var arr=recs.slice();
  arr.sort(function(a,b){var va,vb;
    if(k==="status"){va=STORDER[a.status];vb=STORDER[b.status];}
    else if(NUMK[k]){va=(typeof a[k]==="number"?a[k]:-1);vb=(typeof b[k]==="number"?b[k]:-1);}
    else{va=String(a[k]||"").toLowerCase();vb=String(b[k]||"").toLowerCase();}
    if(va<vb)return -1*dir;if(va>vb)return 1*dir;return String(a.person).localeCompare(String(b.person));});
  return arr;}
function statusPill(r){
  if(isLive(r))return '<span class="pill in"><span class="d"></span>On shift</span>';
  if(isMissingOut(r))return '<span class="pill warn"><span class="d"></span>Missing out</span>';
  if(r.status==="done")return '<span class="pill done"><span class="d"></span>Done</span>';
  return '<span class="pill absent"><span class="d"></span>Absent</span>';}
function renderTable(recs){
  var base=filterBase(recs);
  var cnt={all:base.length,live:0,done:0,exc:0};
  base.forEach(function(r){if(isLive(r))cnt.live++;if(r.status==="done")cnt.done++;if(isException(r))cnt.exc++;});
  $("#c-all").textContent=cnt.all;$("#c-live").textContent=cnt.live;$("#c-done").textContent=cnt.done;$("#c-exc").textContent=cnt.exc;
  var rows=sortRecs(visible(recs));
  $("#tcCount").textContent=rows.length;
  if(!rows.length){$("#rows").innerHTML='<tr><td colspan="10"><div class="empty">'+
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-3.6-3.6"/></svg>'+
    '<div class="t">No timecards match</div><div>Try clearing the search, shift, or status filter.</div></div></td></tr>';return;}
  $("#rows").innerHTML=rows.map(function(r){var k=catOf(r.shift,r);
    var warn=(r.abnormal&&!isMissingOut(r))?'<span class="flag" title="'+esc(r.abnormal)+'">! '+esc(r.abnormal)+'</span>':'';
    var payable=(typeof r.netMin==="number")?'<b>'+hmShort(r.netMin)+'</b>':'<span class="z">—</span>';
    var night=(typeof r.nightMin==="number"&&r.nightMin>0)?'<span class="ndot"></span>'+hmShort(r.nightMin):'<span class="z">—</span>';
    return '<tr>'+
      '<td class="cell-emp" data-label="Employee"><div class="emp"><span class="dot" style="'+avatarStyle(r.person)+'">'+esc(initials(r.person))+'</span><div><div class="en">'+esc(r.person||"—")+'</div>'+(r.pid?'<div class="ep">'+esc(r.pid)+'</div>':'')+'</div>'+warn+'</div></td>'+
      '<td data-label="Shift"><span class="shiftcell"><span class="sdot" style="background:'+cv(k)+'"></span><span class="shift-tag">'+esc(r.shift||k)+'</span></span></td>'+
      '<td class="r'+(r.clockIn?"":" z")+'" data-label="Clock in">'+(r.clockIn?esc(clk(r.clockIn)):"—")+'</td>'+
      '<td class="r'+(r.clockOut?"":" z")+'" data-label="Clock out">'+(r.clockOut?esc(clk(r.clockOut)):"—")+'</td>'+
      '<td class="r payable" data-label="Payable">'+payable+'</td>'+
      '<td class="r z" data-label="Worked · CSV">'+hmShort(r.workMin)+'</td>'+
      '<td class="r z" data-label="OT · CSV">'+hmShort(r.otMin)+'</td>'+
      '<td class="r" data-label="Night">'+night+'</td>'+
      '<td class="r'+(r.breakMin?"":" z")+'" data-label="Break">'+hmShort(r.breakMin)+'</td>'+
      '<td data-label="Status">'+statusPill(r)+'</td>'+
    '</tr>';}).join("");}

/* ================= filter chip (active shift) ================= */
function renderFilterChip(){var el=$("#filterChip");
  if(!state.shift){el.innerHTML="";return;}
  el.innerHTML='<button class="chip" id="clearShift" style="padding:5px 10px"><span class="sw" style="background:'+cv(state.shift)+'"></span>'+esc(state.shift)+' <span style="color:var(--text-3)">✕</span></button>';
  $("#clearShift").addEventListener("click",function(){state.shift=null;render();});}

/* ================= chips ================= */
function renderChips(recs){
  var by={};CATS.forEach(function(c){by[c.k]=0;});recs.forEach(function(r){by[catOf(r.shift,r)]++;});
  var order=CATS.filter(function(c){return by[c.k]>0;});
  var html='<button class="chip" data-sh="ALL" aria-pressed="'+(!state.shift)+'">All shifts<span class="ct">'+recs.length+'</span></button>';
  html+=order.map(function(c){return '<button class="chip" data-sh="'+esc(c.k)+'" aria-pressed="'+(state.shift===c.k)+'"><span class="sw" style="background:'+cv(c.k)+'"></span>'+c.k+'<span class="ct">'+by[c.k]+'</span></button>';}).join("");
  $("#chips").innerHTML=html;}

/* ================= dates ================= */
function renderDates(){
  $("#dates").innerHTML=(DATA.dates||[]).map(function(d){
    return '<button class="date-pill" role="tab" data-d="'+esc(d)+'" aria-selected="'+(d===state.date)+'"><small>'+dLabel(d)+'</small>'+dSub(d)+'</button>';}).join("");
  var active=$('#dates [aria-selected="true"]');if(active)active.scrollIntoView({inline:"center",block:"nearest"});}

/* ================= master render ================= */
function render(){
  if(!DATA.ok){$("#alert").innerHTML='<div class="alert"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg><div><b>Data unavailable.</b> '+esc(DATA.error||"Could not read the CSV export.")+'</div></div>';}
  else{$("#alert").innerHTML="";}
  var dates=DATA.dates||[];
  if(!dates.length){
    $("#dayTitle").textContent="No attendance yet";
    $("#daySub").textContent="Punches appear here within about a minute of the first clock-in at the device.";
    $("#kpis").innerHTML='<div class="kpi waitcard" style="grid-column:1/-1"><div class="radar"><span></span><span></span><span></span><i></i></div><div class="wt">Waiting for the first punch</div><div class="ws">Your device is online and SaniClock syncs every minute. The moment someone clocks in, their attendance appears here — no refresh needed.</div></div>';
    var _n=$("#kpiNote");if(_n)_n.textContent="";
    $("#foot").innerHTML="Live · syncing every minute · no punches recorded yet";
    return;
  }
  if(!state.date||dates.indexOf(state.date)<0)state.date=dates[0];
  var recs=recsFor(state.date);var all=recs.length;var q=state.q.trim();
  $("#dayTitle").textContent=fullDate(state.date);
  $("#daySub").textContent=all+" scheduled shift"+(all===1?"":"s")+(q?' · matching "'+q+'"':"");
  renderDates();renderChips(recs);renderKpis(recs);
  trendChart();donutChart(recs);hoursChart(recs);histChart(recs);
  renderFloor(recs);renderExceptions(recs);
  renderHead();renderFilterChip();renderTable(recs);
  var segs=document.querySelectorAll("#statusSeg .seg");
  Array.prototype.forEach.call(segs,function(b){b.classList.toggle("active",b.getAttribute("data-seg")===state.seg);});
  var d=DATA;
  $("#foot").innerHTML='Showing '+recs.length+' timecards for <b>'+esc(dLabel(state.date)+" "+dSub(state.date))+'</b>'+
    '<span class="sep"></span>'+(d.count||0)+' records · '+dates.length+' days'+
    '<span class="sep"></span>updated <span id="ago">just now</span>'+
    '<span class="sep"></span><code title="'+esc(d.csvPath||"")+'">'+esc(d.csvPath||"—")+'</code>';}

/* ================= live indicator / clocks ================= */
function setLive(cls,txt){$("#live").className="live"+(cls?" "+cls:"");$("#liveTxt").textContent=txt;}
function tick(){
  var n=new Date();
  $("#clock").textContent=pad(n.getHours())+":"+pad(n.getMinutes())+":"+pad(n.getSeconds());
  Array.prototype.forEach.call(document.querySelectorAll(".js-el"),function(el){var s=+el.getAttribute("data-start");if(s)el.textContent=dur(Date.now()-s);});
  var ago=$("#ago");
  if(ago&&state.lastOk){var sec=Math.round((Date.now()-state.lastOk)/1000);
    ago.textContent=sec<3?"just now":(sec<60?sec+"s ago":Math.floor(sec/60)+"m ago");
    var live=$("#live");
    if(sec>90&&live.classList.contains("ok")){setLive("degraded","Stale · "+Math.floor(sec/60)+"m");}}}

/* ================= fetch ================= */
function load(manual){
  if(manual){var b=$("#refresh");b.classList.remove("spin");void b.offsetWidth;b.classList.add("spin");setLive("sync","Syncing");}
  return fetch("/api/punches",{cache:"no-store"}).then(function(r){return r.json();}).then(function(j){
    DATA=j;state.lastOk=Date.now();
    setLive(DATA.ok?"ok":"degraded",DATA.ok?"Live":"Degraded");
    state.firstLoad=false;render();
  }).catch(function(){setLive("down","Offline");
    if(state.firstLoad)$("#alert").innerHTML='<div class="alert"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"/></svg><div>Could not reach the server. Retrying…</div></div>';});}

/* ================= events ================= */
$("#dates").addEventListener("click",function(e){var b=e.target.closest(".date-pill");if(!b)return;state.date=b.getAttribute("data-d");render();});
$("#chips").addEventListener("click",function(e){var b=e.target.closest(".chip");if(!b)return;var s=b.getAttribute("data-sh");state.shift=(s==="ALL")?null:s;render();});
$("#donutLegend").addEventListener("click",function(e){var b=e.target.closest(".lgi");if(!b)return;var s=b.getAttribute("data-shift");state.shift=state.shift===s?null:s;render();});
$("#donutLegend").addEventListener("keydown",function(e){if(e.key!=="Enter"&&e.key!==" ")return;var b=e.target.closest(".lgi");if(!b)return;e.preventDefault();var s=b.getAttribute("data-shift");state.shift=state.shift===s?null:s;render();});
$("#statusSeg").addEventListener("click",function(e){var b=e.target.closest(".seg");if(!b)return;state.seg=b.getAttribute("data-seg");render();});
$("#kpis").addEventListener("click",function(e){var t=e.target.closest(".kpi[data-seg]");if(!t)return;state.seg=t.getAttribute("data-seg");render();
  var tbl=$(".roster");if(tbl&&state.seg==="exception")$("#excSec").scrollIntoView({behavior:"smooth",block:"start"});});
$("#kpis").addEventListener("keydown",function(e){if(e.key!=="Enter"&&e.key!==" ")return;var t=e.target.closest(".kpi[data-seg]");if(!t)return;e.preventDefault();state.seg=t.getAttribute("data-seg");render();});
$("#thead").addEventListener("click",function(e){var th=e.target.closest("th");if(!th)return;var k=th.getAttribute("data-k");
  if(state.sort.key===k)state.sort.dir*=-1;else{state.sort.key=k;state.sort.dir=NUMK[k]?-1:1;}
  renderHead();renderTable(recsFor(state.date));});
$("#q").addEventListener("input",function(e){state.q=e.target.value.trim();render();});
$("#refresh").addEventListener("click",function(){load(true);});

/* ---- compliance sub-filter ---- */
$("#excSeg").addEventListener("click",function(e){var b=e.target.closest(".seg");if(!b)return;
  state.excFilter=b.getAttribute("data-ex");renderExceptions(recsFor(state.date));});

/* ================= payroll export ================= */
function mdyOf(dt){return pad(dt.getMonth()+1)+"/"+pad(dt.getDate())+"/"+dt.getFullYear();}
function weekRangeMDY(dstr){var dt=parseDate(dstr);if(!dt)return null;
  var s=new Date(dt.getFullYear(),dt.getMonth(),dt.getDate());s.setDate(s.getDate()-((s.getDay()+6)%7)); // Monday start
  var e=new Date(s.getFullYear(),s.getMonth(),s.getDate());e.setDate(e.getDate()+6);
  return {start:mdyOf(s),end:mdyOf(e),sd:s,ed:e};}
function fmtDayLabel(dt){return WD[dt.getDay()]+" "+MO[dt.getMonth()]+" "+dt.getDate();}
function rangeEmployees(sd,ed){var recs=DATA.records||[],seen={},cnt=0;
  var edEnd=ed?new Date(ed.getFullYear(),ed.getMonth(),ed.getDate(),23,59,59):null;
  for(var i=0;i<recs.length;i++){var dt=parseDate(recs[i].date);if(!dt)continue;
    if(sd&&dt<sd)continue;if(edEnd&&dt>edEnd)continue;
    var pid=recs[i].pid||recs[i].person;if(!seen[pid]){seen[pid]=1;cnt++;}}
  return cnt;}
function doExport(startMDY,endMDY){
  var u="/api/payroll.csv";var qs=[];
  if(startMDY)qs.push("start="+encodeURIComponent(startMDY));
  if(endMDY)qs.push("end="+encodeURIComponent(endMDY));
  if(qs.length)u+="?"+qs.join("&");
  var a=document.createElement("a");a.href=u;a.setAttribute("download","");
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setLive("sync","Preparing export…");
  setTimeout(function(){setLive(DATA.ok?"ok":"degraded",DATA.ok?"Live":"Degraded");},1400);}
function selectedExMode(){var el=document.querySelector('input[name="exrange"]:checked');return el?el.value:"week";}
function updateExportUI(){
  var mode=selectedExMode();$("#exCustom").hidden=(mode!=="custom");
  var sd=null,ed=null;
  if(mode==="week"){var wr=weekRangeMDY(state.date);if(wr){sd=wr.sd;ed=wr.ed;}}
  else if(mode==="all"){var ds=DATA.dates||[];if(ds.length){ed=parseDate(ds[0]);sd=parseDate(ds[ds.length-1]);}}
  else{var s=$("#exStart").value,e=$("#exEnd").value;
    if(s){var ps=s.split("-");sd=new Date(+ps[0],+ps[1]-1,+ps[2]);}
    if(e){var pe=e.split("-");ed=new Date(+pe[0],+pe[1]-1,+pe[2]);}}
  var cnt=(sd||ed||mode==="all")?rangeEmployees(sd,ed):0;
  var rec;
  if(sd&&ed)rec=fmtDayLabel(sd)+" – "+fmtDayLabel(ed)+" · "+cnt+" employee"+(cnt===1?"":"s");
  else if(mode==="all")rec=cnt+" employees · all dates";
  else rec="Choose a start and end date";
  $("#exReceipt").textContent=rec;
  var empty=(!!sd&&!!ed&&cnt===0);
  var noteEl=$("#exNote");noteEl.hidden=!empty;if(empty)noteEl.textContent="No timecards in this range";
  $("#exConfirm").disabled=empty||(mode==="custom"&&(!sd||!ed));}
function openExportPop(){$("#exportPop").hidden=false;$("#exportCaret").setAttribute("aria-expanded","true");updateExportUI();}
function closeExportPop(){$("#exportPop").hidden=true;$("#exportCaret").setAttribute("aria-expanded","false");}
$("#exportBtn").addEventListener("click",function(){var wr=weekRangeMDY(state.date);if(wr)doExport(wr.start,wr.end);else doExport(null,null);});
$("#exportCaret").addEventListener("click",function(e){e.stopPropagation();if($("#exportPop").hidden)openExportPop();else closeExportPop();});
$("#exportPop").addEventListener("click",function(e){e.stopPropagation();});
$("#exportPop").addEventListener("change",updateExportUI);
$("#exStart").addEventListener("input",updateExportUI);
$("#exEnd").addEventListener("input",updateExportUI);
$("#exConfirm").addEventListener("click",function(){
  var mode=selectedExMode();
  if(mode==="week"){var wr=weekRangeMDY(state.date);if(wr)doExport(wr.start,wr.end);}
  else if(mode==="all"){doExport(null,null);}
  else{var s=$("#exStart").value,e=$("#exEnd").value;if(!s||!e)return;doExport(s,e);}
  closeExportPop();});
$("#exPaysheet").addEventListener("click",function(){
  // Bi-weekly employer sheet for the pay period containing the selected day
  var u="/api/paysheet.xls";
  if(state.date)u+="?start="+encodeURIComponent(state.date);
  var a=document.createElement("a");a.href=u;a.setAttribute("download","");
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setLive("sync","Preparing pay sheet…");
  setTimeout(function(){setLive(DATA.ok?"ok":"degraded",DATA.ok?"Live":"Degraded");},1400);
  closeExportPop();});
$("#exEmailReport").addEventListener("click",function(){
  var mode=selectedExMode(),start=null,end=null;
  if(mode==="week"){var wr=weekRangeMDY(state.date);if(wr){start=wr.start;end=wr.end;}}
  else if(mode==="custom"){start=$("#exStart").value;end=$("#exEnd").value;if(!start||!end){alert("Choose a start and end date first.");return;}}
  var to=prompt("Send the payroll report to which email address?","");
  if(!to)return;
  var btn=this;btn.disabled=true;var oldTxt=btn.textContent;btn.textContent="Sending…";
  fetch("/api/report/email",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({start:start,end:end,to:to})})
    .then(function(r){return r.json();})
    .then(function(j){
      btn.disabled=false;btn.textContent=oldTxt;
      if(j.ok)alert("\u2713 Report emailed to "+j.sentTo+" ("+j.employees+" employees, "+j.totalHours+" total hours).");
      else alert("Could not send: "+(j.error||"failed")+(j.error&&j.error.indexOf("not set up")>=0?"":"\\n\\nIf email isn\u2019t set up yet, open /connect/mail first."));
    })
    .catch(function(){btn.disabled=false;btn.textContent=oldTxt;alert("Network error.");});
  closeExportPop();
});
document.addEventListener("click",function(){if($("#exportPop")&&!$("#exportPop").hidden)closeExportPop();});
document.addEventListener("keydown",function(e){if(e.key==="Escape"&&$("#exportPop")&&!$("#exportPop").hidden)closeExportPop();});

/* theme toggle */
(function(){var saved=null;try{saved=localStorage.getItem("punch-theme");}catch(e){}
  document.documentElement.setAttribute("data-theme",saved||"dark");
  $("#themeBtn").addEventListener("click",function(){
    var cur=document.documentElement.getAttribute("data-theme");
    if(!cur)cur=(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light";
    var next=cur==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",next);
    try{localStorage.setItem("punch-theme",next);}catch(e){}});})();

/* keyboard nav */
document.addEventListener("keydown",function(e){
  var t=e.target,typing=t&&(t.tagName==="INPUT"||t.tagName==="TEXTAREA"||t.tagName==="SELECT");
  if(e.key==="/"&&!typing){e.preventDefault();$("#q").focus();$("#q").select();return;}
  if(e.key==="Escape"&&t&&t.id==="q"){t.value="";state.q="";render();t.blur();return;}
  if(typing)return;
  if((e.key==="r"||e.key==="R")&&!e.metaKey&&!e.ctrlKey){e.preventDefault();load(true);return;}
  if(e.key==="ArrowLeft"||e.key==="ArrowRight"){var i=(DATA.dates||[]).indexOf(state.date);if(i<0)return;
    var ni=i+(e.key==="ArrowRight"?-1:1); // dates are newest-first: Right = newer, Left = older
    if(ni>=0&&ni<DATA.dates.length){state.date=DATA.dates[ni];e.preventDefault();render();}}});

/* skeleton, then boot */
(function(){var s="";for(var i=0;i<8;i++)s+='<div class="sk"></div>';$("#kpis").innerHTML=s;})();
/* ================= Mend Punch (Add -> pending -> Approve/Reject) ================= */
var VIEWS=["dashboard","mend","absence","viewpunch","timecard","report","groups","devices","settings"];
var VIEW_EL={dashboard:"dashboardView",mend:"mendView",absence:"absenceView",viewpunch:"viewPunchView",timecard:"timecardView",report:"reportView",groups:"groupsView",devices:"devicesView",settings:"settingsView"};
var VIEW_NAV={dashboard:"navDashboard",mend:"navMend",absence:"navAbsence",viewpunch:"navViewPunch",timecard:"navTimecard",report:"navReport",groups:"navGroups",devices:"navDevices",settings:"navSettings"};
function setView(v){
  state.view=v;
  VIEWS.forEach(function(name){
    var el=$("#"+VIEW_EL[name]); if(el)el.hidden=(v!==name);
    var nav=$("#"+VIEW_NAV[name]); if(nav)nav.classList.toggle("active",v===name);
  });
  if(v==="mend")loadMend();
  if(v==="absence"||v==="mend")loadAbsences();
  if(v==="viewpunch")loadViewPunch();
  if(v==="timecard")renderTimecardView();
  if(v==="report")renderReportView();
  if(v==="groups")loadEmployees();
  if(v==="devices")loadDevices();
  if(v==="settings")loadSettings();
  closeSidebarMobile();
}
function closeSidebarMobile(){
  $("#sidebar").classList.remove("open");$("#sidebarScrim").classList.remove("open");
}
function mendPill(status){
  return '<span class="mend-pill '+status+'">'+status.charAt(0).toUpperCase()+status.slice(1)+'</span>';
}
function renderMendTable(){
  var seg=state.mendSeg;
  var by={pending:0,approved:0,rejected:0};
  MEND.forEach(function(r){if(by[r.status]!==undefined)by[r.status]++;});
  $("#m-pending").textContent=by.pending;$("#m-approved").textContent=by.approved;
  $("#m-rejected").textContent=by.rejected;$("#m-all").textContent=MEND.length;
  var apn=(typeof ABS!=="undefined"&&ABS?ABS:[]).filter(function(r){return r.status==="pending";}).length;
  var mab=$("#m-absence");if(mab)mab.textContent=apn;
  var badge=$("#mendPendingBadge");
  if(by.pending>0){badge.hidden=false;badge.textContent=by.pending;}else{badge.hidden=true;}
  if(seg==="absence"){
    var arows=(typeof ABS!=="undefined"&&ABS?ABS:[]).filter(function(r){return r.status==="pending";});
    if(!arows.length){
      $("#mendRows").innerHTML='<tr><td colspan="6"><div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg><div class="t">Nothing waiting for approval</div><div>Employee absence requests appear here the moment they arrive.</div></div></td></tr>';
      return;
    }
    $("#mendRows").innerHTML=arows.map(function(r){
      var dr=r.startDate===r.endDate?r.startDate:(r.startDate+" → "+r.endDate);
      return '<tr>'+
        '<td data-label="Employee"><div class="emp"><span class="dot" style="'+avatarStyle(r.person)+'">'+esc(initials(r.person))+'</span><div><div class="en">'+esc(r.person||r.pid)+'</div><div class="ep">'+esc(r.pid)+'</div></div></div></td>'+
        '<td data-label="Date" class="tnum">'+esc(dr)+'</td>'+
        '<td data-label="Time" class="tnum">'+esc(r.days)+'d</td>'+
        '<td data-label="Remarks">'+esc(r.type)+(r.reason?' · '+esc(r.reason):'')+'</td>'+
        '<td data-label="Status">'+mendPill(r.status)+'</td>'+
        '<td data-label="Actions"><div class="mend-actions"><button class="approve" data-aact="approve" data-id="'+esc(r.id)+'">Approve</button><button class="reject" data-aact="reject" data-id="'+esc(r.id)+'">Reject</button></div></td>'+
      '</tr>';
    }).join("");
    return;
  }
  var rows=MEND.filter(function(r){return seg==="all"?true:r.status===seg;});
  if(!rows.length){
    $("#mendRows").innerHTML='<tr><td colspan="6"><div class="empty">'+
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg>'+
      '<div class="t">No '+(seg==="all"?"":seg+" ")+'mend punches</div><div>Add one with the button above.</div></div></td></tr>';
    return;
  }
  $("#mendRows").innerHTML=rows.map(function(r){
    var actions=r.status==="pending"?
      '<div class="mend-actions">'+
        '<button class="approve" data-act="approve" data-id="'+esc(r.id)+'">Approve</button>'+
        '<button class="reject" data-act="reject" data-id="'+esc(r.id)+'">Reject</button>'+
        '<button class="del" data-act="delete" data-id="'+esc(r.id)+'">Delete</button>'+
      '</div>' : '<span class="hint">—</span>';
    return '<tr>'+
      '<td data-label="Employee"><div class="emp"><span class="dot" style="'+avatarStyle(r.person)+'">'+esc(initials(r.person))+'</span><div><div class="en">'+esc(r.person||r.pid)+'</div><div class="ep">'+esc(r.pid)+'</div></div></div></td>'+
      '<td data-label="Date">'+esc(r.dateMDY)+'</td>'+
      '<td data-label="Time" class="tnum">'+esc(r.hms)+'</td>'+
      '<td data-label="Remarks">'+(r.remarks?esc(r.remarks):'<span class="z">—</span>')+'</td>'+
      '<td data-label="Status">'+mendPill(r.status)+'</td>'+
      '<td data-label="Actions">'+actions+'</td>'+
    '</tr>';}).join("");
}
function loadMend(){
  return fetch("/api/mend-punches",{cache:"no-store"}).then(function(r){return r.json();}).then(function(j){
    MEND=(j&&j.items)||[];renderMendTable();
  }).catch(function(){});
}
function uniquePersons(){
  var seen={},out=[];
  (DATA.records||[]).forEach(function(r){
    if(!r.pid||seen[r.pid])return;seen[r.pid]=1;out.push({pid:r.pid,person:r.person||r.pid});});
  out.sort(function(a,b){return String(a.person).localeCompare(String(b.person));});
  return out;
}
function openMendModal(){
  $("#mPersonList").innerHTML=uniquePersons().map(function(p){return '<option value="'+esc(p.person)+'" data-pid="'+esc(p.pid)+'">';}).join("");
  $("#mPerson").value="";$("#mDate").value="";$("#mTime").value="";$("#mRemarks").value="";
  $("#mendErr").hidden=true;
  $("#mendOverlay").hidden=false;
  $("#mPerson").focus();
}
function closeMendModal(){$("#mendOverlay").hidden=true;}
function mdyFromInputDate(v){ // <input type=date> gives YYYY-MM-DD -> M/D/YYYY
  var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(v||"");if(!m)return null;
  return (+m[2])+"/"+(+m[3])+"/"+m[1];
}
function submitMendPunch(){
  var nameTyped=$("#mPerson").value.trim();
  var match=uniquePersons().find(function(p){return p.person.toLowerCase()===nameTyped.toLowerCase();});
  var dateMDY=mdyFromInputDate($("#mDate").value);
  var hms=$("#mTime").value; // HH:MM or HH:MM:SS from <input type=time>
  var remarks=$("#mRemarks").value.trim();
  var err=$("#mendErr");
  if(!match){err.textContent="Pick an employee from the list (start typing their name).";err.hidden=false;return;}
  if(!dateMDY){err.textContent="Pick a date.";err.hidden=false;return;}
  if(!hms){err.textContent="Pick a time.";err.hidden=false;return;}
  err.hidden=true;
  var btn=$("#mendConfirm");btn.disabled=true;btn.textContent="Adding…";
  fetch("/api/mend-punches",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({pid:match.pid,person:match.person,dateMDY:dateMDY,hms:hms,remarks:remarks})})
    .then(function(r){return r.json();})
    .then(function(j){
      btn.disabled=false;btn.textContent="Confirm";
      if(!j.ok){err.textContent=j.error||"Could not add punch.";err.hidden=false;return;}
      closeMendModal();loadMend();
    }).catch(function(){btn.disabled=false;btn.textContent="Confirm";err.textContent="Network error — try again.";err.hidden=false;});
}
function decideMend(id,action){
  if(action==="delete"){
    if(!confirm("Delete this pending mend-punch? This cannot be undone."))return;
    fetch("/api/mend-punches?id="+encodeURIComponent(id),{method:"DELETE"}).then(function(){loadMend();});
    return;
  }
  fetch("/api/mend-punches/"+action,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})})
    .then(function(r){return r.json();})
    .then(function(j){if(j.ok){loadMend();if(action==="approve")load(false);}else{alert(j.error||"Could not "+action+".");}});
}
/* ================= View Attendance Punch (raw log) ================= */
var RAWPUNCH=[];
function hhmm(min){if(min==null)return "0:00";min=Math.max(0,Math.round(min));var h=Math.floor(min/60),m=min%60;return h+":"+(m<10?"0":"")+m;}
function loadViewPunch(){
  return fetch("/api/raw-punches",{cache:"no-store"}).then(function(r){return r.json();}).then(function(j){
    RAWPUNCH=(j&&j.events)||[];renderViewPunch();
  }).catch(function(){});
}
function renderViewPunch(){
  var q=($("#vpQ").value||"").toLowerCase();
  var rows=RAWPUNCH.filter(function(e){
    if(!q)return true;
    return (e.pid||"").toLowerCase().indexOf(q)>=0||(e.person||"").toLowerCase().indexOf(q)>=0;
  });
  $("#vpCount").textContent=rows.length+" punch"+(rows.length===1?"":"es");
  if(!rows.length){
    $("#vpRows").innerHTML='<tr><td colspan="6"><div class="empty"><div class="t">No punches found</div></div></td></tr>';
    return;
  }
  $("#vpRows").innerHTML=rows.slice(0,500).map(function(e){
    return '<tr>'+
      '<td class="dvName">'+esc(e.person||e.pid)+'</td>'+
      '<td class="tnum">'+esc(e.pid)+'</td>'+
      '<td class="tnum">'+esc(e.dateMDY)+'</td>'+
      '<td class="tnum">'+esc(e.hms)+'</td>'+
      '<td>'+(e.verify?esc(e.verify):'<span class="z">—</span>')+'</td>'+
      '<td>'+(e.source?esc(e.source):'<span class="z">—</span>')+'</td>'+
    '</tr>';}).join("");
}

/* ================= Timecard Management (paired, NGTeco-style columns) ================= */
function renderTimecardView(){
  var q=($("#tcQ").value||"").toLowerCase();
  var rows=(DATA.records||[]).filter(function(r){
    if(!q)return true;
    return (r.pid||"").toLowerCase().indexOf(q)>=0||(r.person||"").toLowerCase().indexOf(q)>=0;
  }).slice().sort(function(a,b){
    if(a.person!==b.person)return String(a.person).localeCompare(String(b.person));
    return String(b.date).localeCompare(String(a.date));
  });
  $("#tcCount2").textContent=rows.length+" row"+(rows.length===1?"":"s");
  if(!rows.length){
    $("#tcRows").innerHTML='<tr><td colspan="11"><div class="empty"><div class="t">No timecards found</div></div></td></tr>';
    return;
  }
  $("#tcRows").innerHTML=rows.map(function(r){
    var statusPill=r.status==="absent"?'<span class="dvPill">Absent</span>':
      r.status==="in"?'<span class="dvPill ot">On floor</span>':
      '<span class="dvPill">Complete</span>';
    return '<tr>'+
      '<td class="dvName">'+esc(r.person||r.pid)+'</td>'+
      '<td class="tnum">'+esc(r.pid)+'</td>'+
      '<td class="tnum">'+esc(r.date)+'</td>'+
      '<td>'+esc(r.shift||"—")+'</td>'+
      '<td class="tnum">'+(r.clockIn?esc(r.clockIn):'<span class="z">—</span>')+'</td>'+
      '<td class="tnum">'+(r.clockOut?esc(r.clockOut):'<span class="z">—</span>')+'</td>'+
      '<td class="tnum">'+(r.workMin?hhmm(r.workMin):'<span class="z">—</span>')+'</td>'+
      '<td class="tnum">'+(r.otMin?hhmm(r.otMin):'<span class="z">—</span>')+'</td>'+
      '<td class="tnum">'+(r.workMin?hhmm(r.workMin+30):'<span class="z">—</span>')+'</td>'+
      '<td class="tnum">'+(r.status==="done"?"0:30":'<span class="z">—</span>')+'</td>'+
      '<td>'+statusPill+'</td>'+
    '</tr>';}).join("");
}

/* ================= Attendance Report (period totals per employee) ================= */
function renderReportView(){
  var q=($("#rpQ").value||"").toLowerCase();
  var byPid={};
  (DATA.records||[]).forEach(function(r){
    if(!r.pid)return;
    if(!byPid[r.pid])byPid[r.pid]={pid:r.pid,person:r.person||r.pid,worked:0,absent:0,workMin:0,otMin:0};
    var g=byPid[r.pid];
    if(r.status==="absent"){g.absent++;return;}
    if(r.status==="done"||r.status==="in"){g.worked++;g.workMin+=(r.workMin||0);g.otMin+=(r.otMin||0);}
  });
  var rows=Object.keys(byPid).map(function(k){return byPid[k];}).filter(function(g){
    if(!q)return true;
    return g.pid.toLowerCase().indexOf(q)>=0||g.person.toLowerCase().indexOf(q)>=0;
  }).sort(function(a,b){return a.person.localeCompare(b.person);});
  $("#rpCount").textContent=rows.length+" employee"+(rows.length===1?"":"s");
  if(!rows.length){
    $("#rpRows").innerHTML='<tr><td colspan="8"><div class="empty"><div class="t">No data</div></div></td></tr>';
    return;
  }
  $("#rpRows").innerHTML=rows.map(function(g){
    var breakMin=g.worked*30;
    return '<tr>'+
      '<td class="tnum">'+esc(g.pid)+'</td>'+
      '<td class="dvName">'+esc(g.person)+'</td>'+
      '<td class="tnum">'+g.worked+'</td>'+
      '<td class="tnum">'+g.absent+'</td>'+
      '<td class="tnum">'+hhmm(breakMin)+'</td>'+
      '<td class="tnum">'+hhmm(g.workMin)+'</td>'+
      '<td class="tnum">'+(g.otMin?'<span class="dvPill ot">'+hhmm(g.otMin)+'</span>':hhmm(0))+'</td>'+
      '<td class="tnum" style="font-weight:700;color:var(--text)">'+hhmm(g.workMin+breakMin)+'</td>'+
    '</tr>';}).join("");
}

/* ================= Group Management (employees CRUD) ================= */
var EMP=[];
function loadEmployees(){
  return fetch("/api/employees",{cache:"no-store"}).then(function(r){return r.json();}).then(function(j){
    EMP=(j&&j.items)||[];renderEmployees();if(typeof ngStatus==="function")ngStatus();
    var b=$("#empCountBadge");if(EMP.length){b.hidden=false;b.textContent=EMP.length;}else b.hidden=true;
  }).catch(function(){});
}
function renderEmployees(){
  var q=($("#empQ").value||"").toLowerCase();
  var rows=EMP.filter(function(e){return !q||e.pid.toLowerCase().indexOf(q)>=0||e.person.toLowerCase().indexOf(q)>=0;});
  var fpN=EMP.filter(function(x){return x.fpEnrolled;}).length;$("#empCount").textContent=rows.length+" employee"+(rows.length===1?"":"s")+" \u00b7 "+fpN+"/"+EMP.length+" fingerprints enrolled";
  if(!rows.length){$("#empRows").innerHTML='<tr><td colspan="8"><div class="empty"><div class="t">No employees yet</div><div>Click “Add Employee” to build your roster.</div></div></td></tr>';return;}
  $("#empRows").innerHTML=rows.map(function(e){
    return '<tr>'+
      '<td><div class="emp"><span class="dot" style="'+avatarStyle(e.person)+'">'+esc(initials(e.person))+'</span><span class="dvName">'+esc(e.person)+'</span></div></td>'+
      '<td class="tnum">'+esc(e.pid)+'</td>'+
      '<td>'+(e.department?esc(e.department):'<span class="z">—</span>')+'</td>'+
      '<td>'+(e.shift?esc(e.shift):'<span class="z">—</span>')+'</td>'+
      '<td>'+(e.email?esc(e.email):'<span class="z">—</span>')+'</td>'+
      '<td>'+esc(e.role||"Normal user")+'</td>'+'<td><button class="fp-badge '+(e.fpEnrolled?'fp-on':'fp-off')+'" data-eact="fp" data-id="'+esc(e.id)+'" title="Fingerprint is enrolled on the TC4 device. Click to update.">'+(e.fpEnrolled?'&#10003; Enrolled':'Not enrolled')+'</button></td>'+
      '<td><div class="mend-actions">'+(e.email?'<button class="approve" data-eact="email" data-id="'+esc(e.id)+'" title="Email their login">Email</button>':'')+'<button class="approve" data-eact="edit" data-id="'+esc(e.id)+'">Edit</button><button class="del" data-eact="delete" data-id="'+esc(e.id)+'">Delete</button></div></td>'+
    '</tr>';}).join("");
}
function openEmpModal(rec){
  $("#empModalTitle").textContent=rec?"Edit Employee":"Add Employee";
  $("#empId").value=rec?rec.id:"";$("#empPid").value=rec?rec.pid:"";$("#empName").value=rec?rec.person:"";
  var _shifts=[["Morning","Morning · 07:00–15:00"],["Afternoon","Afternoon · 15:00–23:00"],["Night","Night · 23:00–07:00"]];var _cs=rec&&rec.shift?rec.shift:"";if(_cs&&!_shifts.some(function(x){return x[0]===_cs;}))_shifts.unshift([_cs,_cs]);$("#empShift").innerHTML=_shifts.map(function(x){return '<option value="'+esc(x[0])+'">'+esc(x[1])+'</option>';}).join("");var _dp=["Ferrero","DC Plant"];var _cd=rec&&rec.department?rec.department:"";if(_cd&&_dp.indexOf(_cd)<0)_dp.unshift(_cd);$("#empDept").innerHTML=_dp.map(function(d){return '<option value="'+esc(d)+'">'+esc(d)+'</option>';}).join("");$("#empDept").value=_cd||"Ferrero";$("#empShift").value=_cs||"Morning";
  $("#empEmail").value=rec?rec.email||"":"";$("#empRole").value=rec?rec.role||"Normal user":"Normal user";
  $("#empErr").hidden=true;$("#empOverlay").hidden=false;$("#empPid").focus();
}
function saveEmp(){
  var body={id:$("#empId").value||undefined,pid:$("#empPid").value.trim(),person:$("#empName").value.trim(),
    department:$("#empDept").value.trim(),shift:$("#empShift").value.trim(),email:$("#empEmail").value.trim(),role:$("#empRole").value.trim()};
  var err=$("#empErr");if(!body.pid||!body.person){err.textContent="Person ID and name are required.";err.hidden=false;return;}
  fetch("/api/employees",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
    .then(function(r){return r.json();}).then(function(j){
      if(!j.ok){err.textContent=j.error||"Could not save.";err.hidden=false;return;}
      if(j.ngteco&&String(j.ngteco).indexOf("failed")===0){err.textContent="Saved in SaniClock, but device push failed - use \u201cSync all to devices\u201d to retry.";err.hidden=false;loadEmployees();return;}if(j.tempPassword){alert(j.mailed?("\u2713 Employee added \u2014 their login and app link were emailed to "+body.email+".\\n\\nBackup temporary password: "+j.tempPassword):("Employee login created\\n\\nUsername (email): "+body.email+"\\nTemporary password: "+j.tempPassword+"\\n\\nThe invite email didn\u2019t send \u2014 use the Email button on their row, or hand these over manually."));}$("#empOverlay").hidden=true;loadEmployees();
    }).catch(function(){err.textContent="Network error.";err.hidden=false;});
}

/* ================= Device Management (devices CRUD) ================= */
var DEV=[];
function loadDevices(){
  return fetch("/api/devices",{cache:"no-store"}).then(function(r){return r.json();}).then(function(j){
    DEV=(j&&j.items)||[];renderDevices();
    var b=$("#devCountBadge");if(DEV.length){b.hidden=false;b.textContent=DEV.length;}else b.hidden=true;
  }).catch(function(){});
}
function devStatusPill(s){
  var cls=/online|connected/i.test(s)&&!/not/i.test(s)?"ot":"";
  return '<span class="dvPill '+cls+'">'+esc(s||"Not connected")+'</span>';
}
function renderDevices(){
  $("#devCount").textContent=DEV.length+" device"+(DEV.length===1?"":"s");
  if(!DEV.length){$("#devRows").innerHTML='<tr><td colspan="7"><div class="empty"><div class="t">No devices yet</div><div>Register your new machine with “Add Device”.</div></div></td></tr>';return;}
  $("#devRows").innerHTML=DEV.map(function(d){
    return '<tr>'+
      '<td class="dvName">'+esc(d.alias||d.sn)+'</td>'+
      '<td class="tnum">'+esc(d.sn)+'</td>'+
      '<td>'+(d.model?esc(d.model):'<span class="z">—</span>')+'</td>'+
      '<td class="tnum">'+(d.ip?esc(d.ip):'<span class="z">—</span>')+'</td>'+
      '<td>'+(d.site?esc(d.site):'<span class="z">—</span>')+'</td>'+
      '<td>'+devStatusPill(d.status)+'</td>'+
      '<td><div class="mend-actions"><button class="approve" data-dact="edit" data-id="'+esc(d.id)+'">Edit</button><button class="del" data-dact="delete" data-id="'+esc(d.id)+'">Delete</button></div></td>'+
    '</tr>';}).join("");
}
function openDevModal(rec){
  $("#devModalTitle").textContent=rec?"Edit Device":"Add Device";
  $("#devId").value=rec?rec.id:"";$("#devSn").value=rec?rec.sn:"";$("#devAlias").value=rec?rec.alias||"":"";
  $("#devModel").value=rec?rec.model||"":"";$("#devIp").value=rec?rec.ip||"":"";$("#devSite").value=rec?rec.site||"":"";
  $("#devStatus").value=rec?rec.status||"Not connected":"Not connected";
  $("#devErr").hidden=true;$("#devOverlay").hidden=false;$("#devSn").focus();
}
function saveDev(){
  var body={id:$("#devId").value||undefined,sn:$("#devSn").value.trim(),alias:$("#devAlias").value.trim(),
    model:$("#devModel").value.trim(),ip:$("#devIp").value.trim(),site:$("#devSite").value.trim(),status:$("#devStatus").value.trim()};
  var err=$("#devErr");if(!body.sn){err.textContent="Serial number is required.";err.hidden=false;return;}
  fetch("/api/devices",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
    .then(function(r){return r.json();}).then(function(j){
      if(!j.ok){err.textContent=j.error||"Could not save.";err.hidden=false;return;}
      $("#devOverlay").hidden=true;loadDevices();
    }).catch(function(){err.textContent="Network error.";err.hidden=false;});
}

/* ================= Settings ================= */
function loadSettings(){
  return fetch("/api/settings",{cache:"no-store"}).then(function(r){return r.json();}).then(function(j){
    var s=(j&&j.settings)||{};
    $("#setFacility").value=s.facilityName||"";$("#setTz").value=s.timezone||"";$("#setPeriod").value=s.payPeriod||"";
    $("#setWeekStart").value=s.weekStart||"";$("#setOt").value=s.otThresholdWeekly||44;$("#setBreak").value=s.breakMinutes||30;
  }).catch(function(){});
}
function saveSettings(){
  var body={facilityName:$("#setFacility").value.trim(),timezone:$("#setTz").value.trim(),payPeriod:$("#setPeriod").value.trim(),
    weekStart:$("#setWeekStart").value.trim(),otThresholdWeekly:+$("#setOt").value||44,breakMinutes:+$("#setBreak").value||30};
  fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
    .then(function(r){return r.json();}).then(function(j){
      var st=$("#setStatus");st.hidden=false;st.textContent=j.ok?"Saved ✓":"Save failed";
      setTimeout(function(){st.hidden=true;},2200);
    }).catch(function(){});
}

/* ================= Sidebar navigation ================= */
Array.prototype.forEach.call(document.querySelectorAll(".sidebar .navItem[data-view]"),function(btn){
  btn.addEventListener("click",function(){setView(btn.getAttribute("data-view"));});
});
$("#empQ").addEventListener("input",renderEmployees);
$("#empAddBtn").addEventListener("click",function(){openEmpModal(null);});
$("#empDept").addEventListener("change",function(){if(this.value==="__new__"){var n=(prompt("New department name:")||"").trim();if(n){var o=document.createElement("option");o.value=n;o.textContent=n;this.insertBefore(o,this.querySelector('option[value="__new__"]'));this.value=n;}else{this.value="";}}});
$("#empCancel").addEventListener("click",function(){$("#empOverlay").hidden=true;});
$("#empSave").addEventListener("click",saveEmp);$("#empPid").addEventListener("input",function(){var p=this.selectionStart;this.value=this.value.toUpperCase();try{this.setSelectionRange(p,p);}catch(e){}});
$("#empOverlay").addEventListener("click",function(e){if(e.target.id==="empOverlay")$("#empOverlay").hidden=true;});
$("#empRows").addEventListener("click",function(e){var b=e.target.closest("button[data-eact]");if(!b)return;
  var id=b.getAttribute("data-id"),act=b.getAttribute("data-eact");
  if(act==="fp"){openFpModal(id);} else if(act==="email"){emailLogin(id);} else if(act==="edit"){openEmpModal(EMP.find(function(x){return x.id===id;}));}
  else if(act==="delete"){if(confirm("Delete this employee? This also removes them (and their fingerprint) from the device."))fetch("/api/employees?id="+encodeURIComponent(id),{method:"DELETE"}).then(function(r){return r.json();}).then(function(j){loadEmployees();if(j&&j.ngteco&&String(j.ngteco).indexOf("failed")===0)alert("Removed from SaniClock, but device removal failed: "+j.ngteco.replace("failed: ",""));});}
});
var fpCur=null,fpFinger=null;
var FINGERS=["Right thumb","Right index","Right middle","Left thumb","Left index","Left middle"];
function emailLogin(id){var e=EMP.find(function(x){return x.id===id;});if(!e)return;if(!e.email){alert("This employee has no email on file. Add one via Edit first.");return;}if(!confirm("Email login details to "+e.person+" ("+e.email+")?\\n\\nThey get a fresh one-time password and the app link."))return;fetch("/api/mail/invite",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pid:e.pid})}).then(function(r){return r.json();}).then(function(j){if(j.ok)alert("\u2713 Login emailed to "+j.sentTo);else alert("Could not send: "+(j.error||"failed")+"\\\\n\\\\nIf email isn\u2019t set up yet, open /connect/mail first.");}).catch(function(){alert("Network error.");});}
function fpSet(body,cb){fetch("/api/employees/fp-set",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(j){loadEmployees();if(cb)cb(j);}).catch(function(){});}
function openFpModal(id){fpCur=EMP.find(function(x){return x.id===id;});if(!fpCur)return;fpFinger=fpCur.fpFinger||null;
  var who='Employee: <b>'+esc(fpCur.person)+'</b> &middot; ID '+esc(fpCur.pid);
  if(fpCur.fpEnrolled){who+=' &middot; <span class="fpOk">&#10003; Enrolled'+(fpCur.fpFinger?' ('+esc(fpCur.fpFinger)+')':'')+'</span>';}
  $("#fpWho").innerHTML=who;
  $("#fpFingers").innerHTML=FINGERS.map(function(f){return '<button type="button" class="fchip'+(f===fpFinger?' on':'')+'" data-f="'+esc(f)+'">'+esc(f)+'</button>';}).join("");
  var nt=$("#fpNote");nt.className="fpNote";nt.textContent="";$("#fpOverlay").hidden=false;}
$("#fpFingers").addEventListener("click",function(e){var b=e.target.closest(".fchip");if(!b)return;fpFinger=b.getAttribute("data-f");Array.prototype.forEach.call(document.querySelectorAll("#fpFingers .fchip"),function(c){c.classList.toggle("on",c===b);});});
$("#fpCancel").addEventListener("click",function(){$("#fpOverlay").hidden=true;});
$("#fpOverlay").addEventListener("click",function(e){if(e.target.id==="fpOverlay")$("#fpOverlay").hidden=true;});
$("#fpStart").addEventListener("click",function(){var nt=$("#fpNote");if(!fpFinger){nt.className="fpNote warn";nt.textContent="Pick a finger first.";return;}var fidMap={"Right thumb":5,"Right index":6,"Right middle":7,"Left thumb":4,"Left index":3,"Left middle":2};nt.className="fpNote";nt.textContent="Sending to device\u2026";fetch("/api/ngteco/enroll",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pid:fpCur.pid,fid:(fidMap[fpFinger]!=null?fidMap[fpFinger]:4)})}).then(function(r){return r.json();}).then(function(j){if(j.ok){fpSet({id:fpCur.id,finger:fpFinger,status:"pending"},function(){nt.className="fpNote ok";nt.textContent="\u2713 "+j.message+" \u2014 press that finger 3\u00d7, then Mark enrolled.";});}else{nt.className="fpNote warn";nt.textContent="Device: "+(j.error||j.message||"failed");}}).catch(function(){nt.className="fpNote warn";nt.textContent="Network error contacting device.";});});
$("#fpMark").addEventListener("click",function(){var nt=$("#fpNote");if(!fpFinger){nt.className="fpNote warn";nt.textContent="Pick the finger that was enrolled.";return;}fpSet({id:fpCur.id,finger:fpFinger,enrolled:true,status:"enrolled"},function(){$("#fpOverlay").hidden=true;});});
$("#fpReset").addEventListener("click",function(){fpSet({id:fpCur.id,enrolled:false,status:""},function(){$("#fpOverlay").hidden=true;});});
function ngStatus(){var d=$("#ngDot"),s=$("#ngStat");if(!d||!s)return;fetch("/api/ngteco/status").then(function(r){return r.json();}).then(function(j){if(j.ok){var on=j.device&&(String(j.device.online)==="1");d.style.background=on?"var(--emerald)":"var(--red)";s.innerHTML="Devices: "+(on?("<b>"+esc((j.device&&j.device.sn)||"")+"</b> online"):"device offline")+" \u00b7 "+EMP.length+" employees \u00b7 <b>"+EMP.filter(function(x){return x.fpEnrolled;}).length+"</b> fingerprints enrolled";}else{d.style.background="var(--amber)";s.textContent="Devices: "+(j.error||"unavailable");}}).catch(function(){});}
$("#ngPushBtn")&&$("#ngPushBtn").addEventListener("click",function(){var b=this,s=$("#ngStat");b.disabled=true;s.textContent="Syncing to devices\u2026";fetch("/api/ngteco/push-all",{method:"POST"}).then(function(r){return r.json();}).then(function(j){b.disabled=false;if(j.ok){s.innerHTML="\u2713 Pushed: <b>"+j.created+"</b> created, "+j.skipped+" already there"+(j.failed?(", "+j.failed+" failed"):"");ngStatus();}else{s.textContent="Push failed: "+(j.error||"error");}}).catch(function(){b.disabled=false;s.textContent="Network error.";});});
$("#ngSyncBtn")&&$("#ngSyncBtn").addEventListener("click",function(){var b=this,s=$("#ngStat");b.disabled=true;s.textContent="Syncing fingerprint status\u2026";fetch("/api/ngteco/sync-enrolled",{method:"POST"}).then(function(r){return r.json();}).then(function(j){b.disabled=false;if(j.ok){s.innerHTML="\u2713 Synced \u00b7 <b>"+j.enrolled+"</b> enrolled ("+j.updated+" updated)";loadEmployees();}else{s.textContent="Sync failed: "+(j.error||"error");}}).catch(function(){b.disabled=false;s.textContent="Network error.";});});
$("#devAddBtn").addEventListener("click",function(){openDevModal(null);});
$("#devCancel").addEventListener("click",function(){$("#devOverlay").hidden=true;});
$("#devSave").addEventListener("click",saveDev);
$("#devOverlay").addEventListener("click",function(e){if(e.target.id==="devOverlay")$("#devOverlay").hidden=true;});
$("#devRows").addEventListener("click",function(e){var b=e.target.closest("button[data-dact]");if(!b)return;
  var id=b.getAttribute("data-id"),act=b.getAttribute("data-dact");
  if(act==="edit"){openDevModal(DEV.find(function(x){return x.id===id;}));}
  else if(act==="delete"){if(confirm("Delete this device?"))fetch("/api/devices?id="+encodeURIComponent(id),{method:"DELETE"}).then(function(){loadDevices();});}
});
$("#setSave").addEventListener("click",saveSettings);
$("#vpQ").addEventListener("input",renderViewPunch);
$("#vpRefresh").addEventListener("click",loadViewPunch);
$("#tcQ").addEventListener("input",renderTimecardView);
$("#tcRefresh").addEventListener("click",function(){load(true).then(renderTimecardView);});
$("#rpQ").addEventListener("input",renderReportView);
$("#rpRefresh").addEventListener("click",function(){load(true).then(renderReportView);});
$("#sidebarToggle").addEventListener("click",function(){
  $("#sidebar").classList.toggle("open");$("#sidebarScrim").classList.toggle("open");
});
$("#sidebarScrim").addEventListener("click",closeSidebarMobile);
$("#mendSeg").addEventListener("click",function(e){var b=e.target.closest(".seg");if(!b)return;state.mendSeg=b.getAttribute("data-mseg");
  Array.prototype.forEach.call($("#mendSeg").querySelectorAll(".seg"),function(x){x.classList.toggle("active",x===b);});renderMendTable();});
$("#addPunchBtn").addEventListener("click",openMendModal);
$("#mendCancel").addEventListener("click",closeMendModal);
$("#mendOverlay").addEventListener("click",function(e){if(e.target.id==="mendOverlay")closeMendModal();});
document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!$("#mendOverlay").hidden)closeMendModal();});
$("#mendConfirm").addEventListener("click",submitMendPunch);
$("#mendRows").addEventListener("click",function(e){var b=e.target.closest("button[data-act]");if(!b)return;decideMend(b.getAttribute("data-id"),b.getAttribute("data-act"));});
/* ---- Absence requests (admin) ---- */
var ABS=[];state.absSeg="pending";
function renderAbsTable(){
  var seg=state.absSeg;var by={pending:0,approved:0,rejected:0};
  ABS.forEach(function(r){if(by[r.status]!==undefined)by[r.status]++;});
  $("#a-pending").textContent=by.pending;$("#a-approved").textContent=by.approved;$("#a-rejected").textContent=by.rejected;$("#a-all").textContent=ABS.length;
  var badge=$("#absPendingBadge");if(badge){if(by.pending>0){badge.hidden=false;badge.textContent=by.pending;}else{badge.hidden=true;}}
  var rows=ABS.filter(function(r){return seg==="all"?true:r.status===seg;});
  if(!rows.length){$("#absRows").innerHTML='<tr><td colspan="7"><div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg><div class="t">No '+(seg==="all"?"":seg+" ")+'requests</div><div>Time-off requests from employees show up here.</div></div></td></tr>';return;}
  $("#absRows").innerHTML=rows.map(function(r){
    var actions=r.status==="pending"?'<div class="mend-actions"><button class="approve" data-aact="approve" data-id="'+esc(r.id)+'">Approve</button><button class="reject" data-aact="reject" data-id="'+esc(r.id)+'">Reject</button><button class="del" data-aact="delete" data-id="'+esc(r.id)+'">Delete</button></div>':'<span class="hint">—</span>';
    var dr=r.startDate===r.endDate?r.startDate:(r.startDate+' → '+r.endDate);
    return '<tr><td data-label="Employee"><div class="emp"><span class="dot" style="'+avatarStyle(r.person)+'">'+esc(initials(r.person))+'</span><div><div class="en">'+esc(r.person||r.pid)+'</div><div class="ep">'+esc(r.pid)+'</div></div></div></td>'+
      '<td data-label="Type">'+esc(r.type)+'</td>'+
      '<td data-label="Dates" class="tnum">'+esc(dr)+'</td>'+
      '<td data-label="Days">'+esc(r.days)+'</td>'+
      '<td data-label="Reason">'+(r.reason?esc(r.reason):'<span class="z">—</span>')+'</td>'+
      '<td data-label="Status">'+mendPill(r.status)+'</td>'+
      '<td data-label="Actions">'+actions+'</td></tr>';
  }).join("");
}
function loadAbsences(){return fetch("/api/absence-requests",{cache:"no-store"}).then(function(r){return r.json();}).then(function(j){ABS=(j&&j.items)||[];renderAbsTable();if(typeof state!=="undefined"&&state.mendSeg==="absence"){renderMendTable();}else{var mab2=$("#m-absence");if(mab2)mab2.textContent=ABS.filter(function(r){return r.status==="pending";}).length;}}).catch(function(){});}
function decideAbs(id,action){
  if(action==="delete"){if(!confirm("Delete this request? This cannot be undone."))return;fetch("/api/absence-requests?id="+encodeURIComponent(id),{method:"DELETE"}).then(function(){loadAbsences();});return;}
  fetch("/api/absence-requests/"+action,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})}).then(function(r){return r.json();}).then(function(){loadAbsences();}).catch(function(){});
}
$("#absSeg").addEventListener("click",function(e){var b=e.target.closest(".seg");if(!b)return;state.absSeg=b.getAttribute("data-aseg");Array.prototype.forEach.call($("#absSeg").querySelectorAll(".seg"),function(x){x.classList.toggle("active",x===b);});renderAbsTable();});
$("#absRows").addEventListener("click",function(e){var b=e.target.closest("button[data-aact]");if(!b)return;decideAbs(b.getAttribute("data-id"),b.getAttribute("data-aact"));});
$("#mendRows").addEventListener("click",function(e){var b=e.target.closest("button[data-aact]");if(!b)return;decideAbs(b.getAttribute("data-id"),b.getAttribute("data-aact"));});
loadAbsences();

setInterval(tick,1000);tick();
setInterval(function(){load(false);},30000);
load(false);
})();
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){});}
</script>
<style id="prem-motion">
:root{--ease-expo:cubic-bezier(.16,1,.3,1);--ease-quint:cubic-bezier(.22,1,.36,1)}
.kpis.prem-in > .kpi{opacity:0;transform:translateY(12px);animation:kpiIn .55s var(--ease-expo) both;animation-delay:calc(var(--i,0) * 45ms)}
@keyframes kpiIn{to{opacity:1;transform:none}}
.panel.prem-draw .donut-seg{animation:segIn .7s var(--ease-quint) both;animation-delay:calc(var(--i,0) * 40ms)}
.panel.prem-draw .bar-seg,.panel.prem-draw .hist-seg{transform-box:fill-box;transform-origin:bottom;animation:barIn .55s var(--ease-quint) both;animation-delay:calc(var(--bi,0) * 28ms)}
.panel.prem-draw .area-line{stroke-dasharray:1600;stroke-dashoffset:1600;animation:lineIn 1s var(--ease-quint) forwards}
.panel.prem-draw .area-fill{opacity:0;animation:fadeIn .85s .22s var(--ease-quint) forwards}
.panel.prem-draw .dot{animation:segIn .5s var(--ease-quint) both;animation-delay:.5s}
@keyframes segIn{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}
@keyframes barIn{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes lineIn{to{stroke-dashoffset:0}}
@keyframes fadeIn{to{opacity:1}}
.btn-primary,.date-pill,.kpi.clickable,.fp-badge,.icon-btn{transition:transform .12s var(--ease-expo),box-shadow .18s ease,background .15s ease,border-color .15s ease,color .15s ease}
.btn-primary:active,.kpi.clickable:active,.icon-btn:active{transform:translateY(0) scale(.98)}
@media (prefers-reduced-motion:reduce){
  .kpis.prem-in > .kpi,.panel.prem-draw .donut-seg,.panel.prem-draw .bar-seg,.panel.prem-draw .hist-seg,.panel.prem-draw .area-line,.panel.prem-draw .area-fill,.panel.prem-draw .dot{animation:none!important;opacity:1!important;transform:none!important;stroke-dashoffset:0!important}
}
</style>
<script>
(function(){
  var RM=window.matchMedia&&matchMedia("(prefers-reduced-motion:reduce)").matches;
  var EO=function(t){return 1-Math.pow(1-t,4);};
  var last={};
  function countUp(el,key,to){
    var from=last[key]!=null?last[key]:0;
    if(RM||from===to){el.textContent=""+to;last[key]=to;return;}
    var dur=Math.min(900,320+Math.abs(to-from)*35),t0=0;
    function step(ts){if(!t0)t0=ts;var p=(ts-t0)/dur;if(p>1)p=1;el.textContent=""+Math.round(from+(to-from)*EO(p));if(p<1)requestAnimationFrame(step);else el.textContent=""+to;}
    requestAnimationFrame(step);last[key]=to;
  }
  function scan(){
    var box=document.getElementById("kpis");
    if(box){
      var tiles=box.querySelectorAll(".kpi");
      for(var i=0;i<tiles.length;i++){
        tiles[i].style.setProperty("--i",i);
        var kv=tiles[i].querySelector(".kv");if(!kv)continue;
        var raw=(kv.textContent||"").trim();
        var lab=tiles[i].querySelector(".kl");var key=(lab&&lab.textContent)||("k"+i);
        if(/^[0-9]+$/.test(raw))countUp(kv,key,parseInt(raw,10));
      }
      if(!box.__i){box.__i=1;box.classList.add("prem-in");setTimeout(function(){box.classList.remove("prem-in");},1300);}
    }
    var panels=document.querySelectorAll(".panel");
    for(var j=0;j<panels.length;j++){
      var p=panels[j];if(p.__d)continue;if(!p.querySelector(".chart"))continue;p.__d=1;
      var bars=p.querySelectorAll(".bar-seg,.hist-seg");for(var b=0;b<bars.length;b++)bars[b].style.setProperty("--bi",b);
      var segs=p.querySelectorAll(".donut-seg");for(var d=0;d<segs.length;d++)segs[d].style.setProperty("--i",d);
      if(!RM){p.classList.add("prem-draw");(function(pp){setTimeout(function(){pp.classList.remove("prem-draw");},1600);})(p);}
    }
  }
  var box=document.getElementById("kpis");
  if(box&&window.MutationObserver){new MutationObserver(scan).observe(box,{childList:true});}
  if(document.readyState!=="loading")setTimeout(scan,60);else document.addEventListener("DOMContentLoaded",function(){setTimeout(scan,60);});
  setTimeout(scan,700);
})();

/* ---- running clock inside the wordmark o ---- */
(function(){
  var oc=document.querySelector(".oclock svg");if(!oc)return;
  var d=new Date(),sec=d.getSeconds(),mi=d.getMinutes()+sec/60,hr=(d.getHours()%12)+mi/60;
  var hh=oc.querySelector(".hh"),mh=oc.querySelector(".mh"),sh=oc.querySelector(".sh");
  if(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches){
    hh.setAttribute("transform","rotate("+(hr*30)+" 20 20)");
    mh.setAttribute("transform","rotate("+(mi*6)+" 20 20)");
    sh.setAttribute("transform","rotate("+(sec*6)+" 20 20)");
    return;
  }
  hh.style.animationDelay=(-hr*3600)+"s";
  mh.style.animationDelay=(-mi*60)+"s";
  sh.style.animationDelay=(-sec)+"s";
})();
</script>
</body>
</html>`;
}

// ===========================================================================
// Server
// ===========================================================================
/** Collect and JSON.parse a request body. Rejects on invalid JSON or a body
 * over 64KB (mend-punch payloads are a handful of short fields — anything
 * larger is a malformed/malicious request, not a legitimate use). */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 65536) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// SaniClock brand mark — vector recreation of the flame-droplet-in-hands badge
// (blue gradient droplet, flowing internal strokes, silver + neon-blue ring).
// Scales razor-sharp from favicon to 512px PWA icon; theme-independent.
const SANICLOCK_ICON_SVG = `<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="SaniXperts"><image href="data:image/png;base64,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" width="256" height="256"/></svg>`;
const SANICLOCK_ME_MANIFEST = JSON.stringify({ name:'SaniClock', short_name:'SaniClock', description:'Your timesheet and hours.', start_url:'/me', scope:'/me', display:'standalone', orientation:'portrait-primary', background_color:'#05070e', theme_color:'#05070e', icons:[{src:'/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'},{src:'/icon-maskable-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'}] });
const SANICLOCK_MANIFEST = JSON.stringify({
  name: 'SaniClock — Attendance & Payroll', short_name: 'SaniClock',
  description: 'Attendance and payroll command center.',
  start_url: '/m', scope: '/', display: 'standalone', orientation: 'portrait-primary',
  background_color: '#05070e', theme_color: '#05070e',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  ],
});

// ---- Mobile PWA app (installable, touch-first). Shares login + /api. --------
const MOBILE_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<meta name="theme-color" content="#05070e"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<title>SaniClock</title>
<link rel="manifest" href="/manifest.webmanifest"/>
<link rel="icon" href="/icon.svg?v=2" type="image/svg+xml"/>
<link rel="apple-touch-icon" href="/icon-180.png"/>
<style>
:root{--bg:#05070e;--bg2:#080c18;--surface:rgba(18,22,33,.62);--surface2:rgba(32,38,54,.55);--line:rgba(120,160,255,.13);--line2:rgba(143,208,255,.24);--text:#eaf0fb;--text2:#93a1bd;--text3:#8493ad;--accent:#2f7bff;--accent2:#59a6ff;--emerald:#34d399;--amber:#fbbf24;--rose:#fb7185;--radius:18px;--glow:rgba(47,123,255,.5)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;margin:0;padding:0}
html{background:var(--bg)}
body{color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:15px;overscroll-behavior-y:none;min-height:100vh;background:radial-gradient(900px 520px at 82% -8%,rgba(47,123,255,.16),transparent 58%),radial-gradient(680px 520px at 4% 4%,rgba(89,166,255,.12),transparent 52%),radial-gradient(760px 660px at 50% 118%,rgba(47,123,255,.10),transparent 55%),linear-gradient(170deg,var(--bg2),var(--bg) 55%);background-attachment:fixed}body::before{content:"";position:fixed;inset:0;z-index:-1;background:url("/stage-bg.png?v=2") center/cover no-repeat;opacity:.3;pointer-events:none}
body{padding-bottom:calc(78px + env(safe-area-inset-bottom))}
.top{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(14px);border-bottom:1px solid var(--line);padding:calc(env(safe-area-inset-top) + 12px) 18px 12px;display:flex;align-items:center;gap:11px}
.top img{width:34px;height:34px;border-radius:50%;filter:drop-shadow(0 0 10px var(--glow))}
.top .ttl{font-weight:800;font-size:22px;letter-spacing:-.3px;background:linear-gradient(180deg,#fff,#bcd2ff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ttl .oclock{display:inline-grid;place-items:center;width:.92em;height:.92em;margin:0 .02em;vertical-align:-.09em;filter:drop-shadow(0 0 5px rgba(79,140,255,.5))}
.ttl .oclock svg{width:100%;height:100%;display:block}
.oclock .hh,.oclock .mh,.oclock .sh{transform-origin:20px 20px;transform-box:view-box}
.oclock .hh{animation:mocSpin 43200s linear infinite}
.oclock .mh{animation:mocSpin 3600s linear infinite}
.oclock .sh{animation:mocSpin 60s linear infinite}
@keyframes mocSpin{to{transform:rotate(360deg)}}
.agb{display:flex;align-items:center;gap:5px;margin-top:3px;font-family:ui-monospace,Menlo,monospace;font-size:8.5px;font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:#8fd0ff}
.agb i{width:4px;height:4px;border-radius:50%;background:#34d399;animation:magp 2.4s ease-in-out infinite}
@keyframes magp{0%,100%{opacity:1}50%{opacity:.3}}
.apcard{display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(15,18,24,.55);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:13px;padding:12px 13px;margin-bottom:9px}
.apinfo{min-width:0}
.apinfo b{display:block;font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apinfo span{display:block;font-size:11.5px;color:#93a1bd;margin-top:2px;font-family:ui-monospace,Menlo,monospace}
.apbtns{display:flex;gap:7px;flex:none}
.apbtns button{border-radius:10px;padding:9px 13px;font-size:12px;font-weight:700;cursor:pointer;min-height:38px}
.apok{background:rgba(52,211,153,.16);color:#6ee7b7;border:1px solid rgba(52,211,153,.35)}
.apno{background:rgba(251,113,133,.13);color:#fda4af;border:1px solid rgba(251,113,133,.32)}
.apempty{color:#5b6473;font-size:12.5px;padding:8px 2px 4px}
.nav button{position:relative}
.nbadge{position:absolute;top:5px;right:16px;min-width:16px;height:16px;border-radius:99px;background:#fb7a54;color:#fff;font-size:9px;font-weight:800;display:grid;place-items:center;padding:0 4px}
.nbadge[hidden]{display:none}
body .kpi,body .row{background:rgba(15,18,24,.55);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.top .sub{font-size:11px;color:var(--text3);margin-top:1px}
.top .hclk{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:1px}.top .clk{font-size:15px;font-weight:800;color:var(--text);font-variant-numeric:tabular-nums;letter-spacing:-.3px}.top .live{font-size:10px;font-weight:700;color:var(--emerald);display:flex;align-items:center;gap:5px;text-transform:uppercase;letter-spacing:.08em}
.top .live::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--emerald);box-shadow:0 0 0 0 rgba(52,211,153,.5);animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}70%{box-shadow:0 0 0 7px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.wrap{padding:16px}
.page{display:none}.page.on{display:block;animation:fade .25s ease}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.h{font-size:13px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--text3);margin:6px 2px 10px}
.kpis{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:18px}
.kpi{background:var(--surface);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid var(--line);border-radius:var(--radius);padding:15px 16px;box-shadow:0 1px 0 rgba(255,255,255,.05) inset}
.kpi .n{font-size:30px;font-weight:800;letter-spacing:-1px;line-height:1}
.kpi .l{font-size:12px;color:var(--text2);margin-top:6px;font-weight:500}
.kpi.g .n{color:var(--emerald)}.kpi.a .n{color:var(--amber)}.kpi.b .n{color:var(--accent)}
.tabs{display:flex;gap:8px;overflow-x:auto;padding:2px 0 14px;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}
.tab{flex:none;padding:8px 15px;border-radius:999px;background:var(--surface);border:1px solid var(--line);color:var(--text2);font-size:13px;font-weight:600;white-space:nowrap}
.tab.on{background:var(--accent);border-color:var(--accent);color:#fff}
.search{position:relative;margin-bottom:14px}
.search input{width:100%;background:var(--surface);border:1px solid var(--line);border-radius:14px;color:var(--text);font-size:16px;padding:13px 14px 13px 42px;outline:none}
.search svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);width:17px;height:17px;color:var(--text3)}
.row{display:flex;align-items:center;gap:12px;background:var(--surface);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--line);border-radius:15px;padding:12px 14px;margin-bottom:9px}
.av{width:40px;height:40px;border-radius:12px;flex:none;display:grid;place-items:center;font-weight:700;font-size:14px;color:#fff}
.row .nm{font-weight:600;font-size:15px}
.row .mt{font-size:12px;color:var(--text3);margin-top:2px;display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.row .rt{margin-left:auto;text-align:right;flex:none}
.badge{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px}
.badge.in{background:rgba(52,211,153,.14);color:var(--emerald)}
.badge.done{background:rgba(47,123,255,.16);color:var(--accent2)}
.badge.absent{background:rgba(107,114,128,.16);color:var(--text3)}
.tag{font-size:11px;padding:2px 8px;border-radius:7px;background:var(--surface2);color:var(--text2)}
.tnum{font-variant-numeric:tabular-nums}.fp{font-size:11px;font-weight:700;padding:2px 8px;border-radius:7px}.fp.y{background:rgba(52,211,153,.15);color:var(--emerald)}.fp.n{background:var(--surface2);color:var(--text3)}
.empty{text-align:center;color:var(--text3);padding:44px 20px}
.empty .t{font-weight:600;color:var(--text2);margin-bottom:5px}
.fab{position:fixed;right:18px;bottom:calc(90px + env(safe-area-inset-bottom));width:54px;height:54px;border-radius:17px;background:linear-gradient(135deg,var(--accent2),var(--accent));border:none;color:#fff;display:grid;place-items:center;box-shadow:0 12px 30px -8px var(--glow);z-index:25}
.fab svg{width:24px;height:24px}
.nav{position:fixed;bottom:0;left:0;right:0;z-index:30;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(16px);border-top:1px solid var(--line);display:flex;padding:8px 6px calc(8px + env(safe-area-inset-bottom))}
.nav button{flex:1;background:none;border:none;color:var(--text3);display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:6px 0}
.nav button svg{width:23px;height:23px}
.nav button.on{color:var(--accent)}a:focus-visible,button:focus-visible,input:focus-visible,.tab:focus-visible,.nav button:focus-visible{outline:2px solid var(--accent2);outline-offset:2px;border-radius:8px}
.sk{background:linear-gradient(90deg,var(--surface) 25%,var(--surface2) 50%,var(--surface) 75%);background-size:200% 100%;animation:sh 1.3s infinite;border-radius:15px;height:64px;margin-bottom:9px}
@keyframes sh{to{background-position:-200% 0}}
.prow{display:flex;gap:9px;align-items:stretch;margin-bottom:12px}
.prow .search{flex:1;margin:0}
.addbtn{flex:none;width:46px;border:0;border-radius:13px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,var(--brand2),var(--brand));box-shadow:0 10px 24px -12px var(--glow);cursor:pointer}
.addbtn svg{width:22px;height:22px}
.row.tap{cursor:pointer}
.row.tap:active{transform:scale(.99)}
.fgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:6px 0 4px}
.fgrid button{border:1px solid var(--line);background:var(--surface2);color:var(--text);border-radius:11px;padding:11px;font-size:13px;font-weight:600;cursor:pointer;min-height:44px}
.fgrid button:active{background:rgba(47,123,255,.2);border-color:var(--brand)}
.btn.del{color:#ffb4c0;border:1px solid rgba(251,113,133,.3);background:rgba(251,113,133,.08)}
.msg{font-size:13px;line-height:1.5;margin:8px 0 4px;padding:10px 12px;border-radius:10px;display:none}
.msg.ok{display:block;background:rgba(52,211,153,.14);color:#8ef0c6;border:1px solid rgba(52,211,153,.3)}
.msg.err{display:block;background:rgba(251,113,133,.12);color:#ffb4c0;border:1px solid rgba(251,113,133,.3)}
.ov{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.6);display:none;align-items:flex-end}
.ov.on{display:flex}
.sheet{width:100%;background:var(--surface);border-radius:22px 22px 0 0;border-top:1px solid var(--line);padding:20px 18px calc(22px + env(safe-area-inset-bottom));animation:up .28s cubic-bezier(.16,1,.3,1)}
@keyframes up{from{transform:translateY(100%)}to{transform:none}}
.sheet h3{font-size:18px;margin-bottom:14px}
.fld{margin-bottom:12px}.fld label{display:block;font-size:12px;color:var(--text2);margin-bottom:6px;font-weight:600}
.fld input{width:100%;background:var(--surface2);border:1px solid var(--line);border-radius:12px;color:var(--text);font-size:16px;padding:12px 13px;outline:none}
.btn{width:100%;background:var(--accent);border:none;color:#fff;font-size:16px;font-weight:700;padding:14px;border-radius:14px;margin-top:6px}
.btn.ghost{background:var(--surface2);color:var(--text2);margin-top:8px}
.err{color:var(--rose);font-size:13px;margin-top:8px;display:none}
</style></head>
<body>
<div class="top">
  <img src="/icon.svg?v=2" alt=""/>
  <div><div class="ttl" role="img" aria-label="SaniClock">SaniCl<span class="oclock" aria-hidden="true"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="16.5" fill="none" stroke="#dbe7ff" stroke-width="3.6"/><g stroke="#dbe7ff" stroke-width="2" opacity=".45"><line x1="20" y1="6.5" x2="20" y2="9.5"/><line x1="20" y1="30.5" x2="20" y2="33.5"/><line x1="6.5" y1="20" x2="9.5" y2="20"/><line x1="30.5" y1="20" x2="33.5" y2="20"/></g><line class="hh" x1="20" y1="21" x2="20" y2="13" stroke="#e8f0ff" stroke-width="3" stroke-linecap="round"/><line class="mh" x1="20" y1="21" x2="20" y2="9.5" stroke="#e8f0ff" stroke-width="2.2" stroke-linecap="round"/><line class="sh" x1="20" y1="22.5" x2="20" y2="8" stroke="#59a6ff" stroke-width="1.5" stroke-linecap="round"/><circle cx="20" cy="20" r="2" fill="#59a6ff"/></svg></span>ck</div><div class="sub" id="today">—</div><div class="agb"><i></i>Agentic OS &middot; initializing</div></div>
  <div class="hclk"><span class="clk" id="clk">--:--</span><span class="live">Live</span></div>
</div>

<div class="wrap">
  <!-- TODAY -->
  <div class="page on" id="pgToday">
    <div class="kpis" id="kpis"><div class="sk"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>
    <div class="h">Attendance</div>
    <div class="tabs" id="tabs"></div>
    <div id="attList"></div>
  </div>
  <!-- PEOPLE -->
  <div class="page" id="pgPeople">
    <div class="prow"><div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-3.6-3.6"/></svg><input id="pq" aria-label="Search employees" placeholder="Search employees…" autocomplete="off"/></div><button class="addbtn" id="addEmpBtn" aria-label="Add employee"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button></div>
    <div id="peopleList"></div>
  </div>
  <!-- DEVICES -->
  <div class="page" id="pgDevices">
    <div class="h">Devices</div>
    <div id="devList"></div>
  </div>
  <!-- APPROVALS -->
  <div class="page" id="pgApprove">
    <div class="h">Punch corrections</div>
    <div id="apMend"></div>
    <div class="h" style="margin-top:18px">Absence requests</div>
    <div id="apAbs"></div>
  </div>
</div>

<button class="fab" id="fab" title="Add punch" aria-label="Add punch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>

<div class="nav">
  <button class="on" data-pg="Today"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l9-9 9 9M5 10v10h14V10"/></svg>Today</button>
  <button data-pg="People"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/></svg>People</button>
  <button data-pg="Devices"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>Devices</button>
  <button data-pg="Approve"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>Approvals<span class="nbadge" id="apBadge" hidden></span></button>
  <button onclick="location.href='/'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>Full</button>
</div>

<div class="ov" id="mendOv">
  <div class="sheet">
    <h3>Add Punch</h3>
    <div class="fld"><label for="mPid">Employee ID</label><input id="mPid" placeholder="e.g. 42"/></div>
    <div class="fld"><label for="mDate">Date</label><input id="mDate" type="date"/></div>
    <div class="fld"><label for="mTime">Time</label><input id="mTime" type="time"/></div>
    <div class="err" id="mErr"></div>
    <button class="btn" id="mSave">Submit for approval</button>
    <button class="btn ghost" id="mCancel">Cancel</button>
  </div>
</div>

<div class="ov" id="empOv"><div class="sheet">
  <h3>Add employee</h3>
  <div class="fld"><label for="eqPid">Person ID</label><input id="eqPid" placeholder="e.g. 42" autocomplete="off"/></div>
  <div class="fld"><label for="eqName">Full name</label><input id="eqName" placeholder="First Last" autocomplete="off"/></div>
  <div class="fld"><label for="eqDept">Department</label><input id="eqDept" placeholder="Ferrero / DC Plant" value="Ferrero" autocomplete="off"/></div>
  <div class="fld"><label for="eqEmail">Email (optional — sends app invite)</label><input id="eqEmail" type="email" placeholder="name@sanixperts.ca" autocomplete="off"/></div>
  <div class="msg" id="eqMsg"></div>
  <button class="btn" id="eqSave">Add employee</button>
  <button class="btn ghost" id="eqCancel">Cancel</button>
</div></div>

<div class="ov" id="actOv"><div class="sheet">
  <h3 id="actName">Edit employee</h3>
  <div class="msg" id="actMsg"></div>
  <div class="fld"><label for="edPid">Person ID</label><input id="edPid" readonly/></div>
  <div class="fld"><label for="edName">Full name</label><input id="edName" autocomplete="off"/></div>
  <div class="fld"><label for="edDept">Department</label><input id="edDept" autocomplete="off"/></div>
  <div class="fld"><label for="edEmail">Email</label><input id="edEmail" type="email" autocomplete="off"/></div>
  <button class="btn" id="edSave">Save changes</button>
  <button class="btn ghost" id="edEnrollToggle"><span id="edEnrollLbl">Enroll fingerprint</span></button>
  <div id="edEnrollBox" hidden>
    <div style="font-size:12px;color:var(--text2);margin:8px 0 6px">Pick which finger, then press it on the device.</div>
    <div class="fgrid">
      <button data-fid="4">L thumb</button><button data-fid="5">R thumb</button>
      <button data-fid="3">L index</button><button data-fid="6">R index</button>
      <button data-fid="2">L middle</button><button data-fid="7">R middle</button>
    </div>
  </div>
  <button class="btn ghost del" id="edDelete">Delete employee</button>
  <button class="btn ghost" id="actClose">Close</button>
</div></div>

<script>
var $=function(s){return document.querySelector(s)},PUNCH=[],EMP=[],DEV=[],band="All";
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function ini(n){return (n||"").split(/\\s+/).slice(0,2).map(function(w){return w[0]||""}).join("").toUpperCase()}
function hue(n){var h=0;for(var i=0;i<(n||"").length;i++)h=(h*31+n.charCodeAt(i))%360;return h}
function av(n){return 'background:linear-gradient(135deg,hsl('+hue(n)+' 55% 42%),hsl('+((hue(n)+40)%360)+' 55% 38%))'}
function j(u,o){return fetch(u,Object.assign({cache:"no-store"},o||{})).then(function(r){if(r.status===401){location.href="/login";throw 0}return r.json()})}
function go(pg){["Today","People","Devices","Approve"].forEach(function(p){$("#pg"+p).classList.toggle("on",p===pg)});
  Array.prototype.forEach.call(document.querySelectorAll(".nav button[data-pg]"),function(b){b.classList.toggle("on",b.getAttribute("data-pg")===pg)});
  $("#fab").style.display=pg==="Today"?"grid":"none";
  if(pg==="People"&&!EMP.length)loadPeople(); if(pg==="Devices")loadDevices(); if(pg==="Approve")loadApprovals();}
Array.prototype.forEach.call(document.querySelectorAll(".nav button[data-pg]"),function(b){b.addEventListener("click",function(){go(b.getAttribute("data-pg"))})});

/* ---- add employee ---- */
function openEmpSheet(){$("#eqPid").value="";$("#eqName").value="";$("#eqEmail").value="";$("#eqDept").value="Ferrero";$("#eqMsg").className="msg";$("#empOv").classList.add("on");}
$("#addEmpBtn")&&$("#addEmpBtn").addEventListener("click",openEmpSheet);
$("#eqCancel")&&$("#eqCancel").addEventListener("click",function(){$("#empOv").classList.remove("on");});
$("#empOv")&&$("#empOv").addEventListener("click",function(e){if(e.target.id==="empOv")$("#empOv").classList.remove("on");});
$("#eqSave")&&$("#eqSave").addEventListener("click",function(){
  var pid=$("#eqPid").value.trim(),person=$("#eqName").value.trim(),dept=$("#eqDept").value.trim(),email=$("#eqEmail").value.trim();
  var msg=$("#eqMsg");
  if(!pid||!person){msg.className="msg err";msg.textContent="Person ID and name are required.";return;}
  var btn=this;btn.disabled=true;msg.className="msg";msg.textContent="";
  j("/api/employees",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pid:pid,person:person,department:dept,shift:"Morning",email:email,role:"Normal user"})})
    .then(function(r){
      btn.disabled=false;
      if(r.ok){var extra=r.mailed?" · invite emailed":(email?" · email invite failed, use desktop":"");msg.className="msg ok";msg.textContent="\u2713 "+person+" added"+extra+".";EMP=[];loadPeople();setTimeout(function(){$("#empOv").classList.remove("on");},1400);}
      else{msg.className="msg err";msg.textContent=r.error||"Could not add employee.";}
    }).catch(function(){btn.disabled=false;msg.className="msg err";msg.textContent="Network error.";});
});

/* ---- employee edit + fingerprint enroll ---- */
var actEmp=null;
document.addEventListener("click",function(e){
  var row=e.target.closest(".row.tap");if(!row)return;
  var pid=row.getAttribute("data-pid");
  actEmp=EMP.filter(function(x){return String(x.pid)===String(pid);})[0]||{pid:pid};
  $("#actName").textContent="Edit "+(actEmp.person||pid);
  $("#edPid").value=actEmp.pid||pid;
  $("#edName").value=actEmp.person||"";
  $("#edDept").value=actEmp.department||"";
  $("#edEmail").value=actEmp.email||"";
  $("#edEnrollLbl").textContent=actEmp.fpEnrolled?"Re-enroll fingerprint":"Enroll fingerprint";
  $("#edEnrollBox").hidden=true;
  $("#actMsg").className="msg";$("#actMsg").textContent="";
  $("#actOv").classList.add("on");
});
$("#actClose")&&$("#actClose").addEventListener("click",function(){$("#actOv").classList.remove("on");});
$("#actOv")&&$("#actOv").addEventListener("click",function(e){if(e.target.id==="actOv")$("#actOv").classList.remove("on");});
$("#edEnrollToggle")&&$("#edEnrollToggle").addEventListener("click",function(){$("#edEnrollBox").hidden=!$("#edEnrollBox").hidden;});
$("#edSave")&&$("#edSave").addEventListener("click",function(){
  if(!actEmp)return;var msg=$("#actMsg");
  var name=$("#edName").value.trim();if(!name){msg.className="msg err";msg.textContent="Name is required.";return;}
  var body={id:actEmp.id,pid:actEmp.pid,person:name,department:$("#edDept").value.trim(),shift:actEmp.shift||"Morning",email:$("#edEmail").value.trim(),role:actEmp.role||"Normal user"};
  var btn=this;btn.disabled=true;msg.className="msg";msg.textContent="Saving…";
  j("/api/employees",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
    .then(function(r){btn.disabled=false;if(r.ok){msg.className="msg ok";msg.textContent="\u2713 Saved.";EMP=[];loadPeople();setTimeout(function(){$("#actOv").classList.remove("on");},900);}else{msg.className="msg err";msg.textContent=r.error||"Could not save.";}})
    .catch(function(){btn.disabled=false;msg.className="msg err";msg.textContent="Network error.";});
});
$("#edDelete")&&$("#edDelete").addEventListener("click",function(){
  if(!actEmp||!actEmp.id)return;
  if(!confirm("Delete "+(actEmp.person||actEmp.pid)+"? This also removes them from the device."))return;
  var msg=$("#actMsg");msg.className="msg";msg.textContent="Deleting…";
  j("/api/employees?id="+encodeURIComponent(actEmp.id),{method:"DELETE"})
    .then(function(){EMP=[];loadPeople();$("#actOv").classList.remove("on");})
    .catch(function(){msg.className="msg err";msg.textContent="Network error.";});
});
Array.prototype.forEach.call(document.querySelectorAll("#edEnrollBox .fgrid button"),function(b){b.addEventListener("click",function(){
  if(!actEmp)return;var fid=b.getAttribute("data-fid"),msg=$("#actMsg");
  msg.className="msg";msg.textContent="Sending to device…";
  Array.prototype.forEach.call(document.querySelectorAll("#edEnrollBox .fgrid button"),function(x){x.disabled=true;});
  j("/api/ngteco/enroll",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pid:actEmp.pid,fid:+fid})})
    .then(function(r){
      Array.prototype.forEach.call(document.querySelectorAll("#edEnrollBox .fgrid button"),function(x){x.disabled=false;});
      if(r.ok){msg.className="msg ok";msg.textContent="\u2713 "+(r.message||"Press the finger on the device now.");}
      else{msg.className="msg err";msg.textContent=r.error||r.message||"Enroll failed.";}
    }).catch(function(){Array.prototype.forEach.call(document.querySelectorAll("#edEnrollBox .fgrid button"),function(x){x.disabled=false;});msg.className="msg err";msg.textContent="Network error.";});
});});

function loadToday(){
  j("/api/punches").then(function(d){
    PUNCH=(d.records||[]).filter(function(r){return r.date===latestDate(d.records)});
    var present=PUNCH.filter(function(r){return r.status==="done"||r.status==="in"}).length;
    var onFloor=PUNCH.filter(function(r){return r.status==="in"}).length;
    var absent=PUNCH.filter(function(r){return r.status==="absent"}).length;
    var roster=PUNCH.length;
    $("#today").textContent=fmtDate(latestDate(d.records));
    $("#kpis").innerHTML=
      kpi("b",roster,"On roster")+kpi("g",present,"Present")+kpi("a",onFloor,"On floor now")+kpi("",absent,"Absent");
    renderTabs();renderAtt();
  }).catch(function(){});
}
function latestDate(recs){var mx="";(recs||[]).forEach(function(r){if(r.date>mx)mx=r.date});return mx}
function fmtDate(d){if(!d)return"—";var p=d.split("/");var dt=new Date(+p[2],+p[0]-1,+p[1]);return dt.toLocaleDateString(undefined,{weekday:"long",month:"short",day:"numeric"})}
function kpi(c,n,l){return '<div class="kpi '+c+'"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'}
function renderTabs(){var bands=["All"];PUNCH.forEach(function(r){var b=(r.shift||"").replace(/ Shift/,"");if(b&&bands.indexOf(b)<0)bands.push(b)});
  $("#tabs").innerHTML=bands.map(function(b){return '<button class="tab'+(b===band?" on":"")+'" data-b="'+esc(b)+'">'+esc(b)+'</button>'}).join("");
  Array.prototype.forEach.call(document.querySelectorAll("#tabs .tab"),function(t){t.addEventListener("click",function(){band=t.getAttribute("data-b");renderTabs();renderAtt()})});}
function renderAtt(){
  var rows=PUNCH.filter(function(r){return band==="All"||(r.shift||"").replace(/ Shift/,"")===band});
  rows.sort(function(a,b){var o={in:0,done:1,absent:2};return (o[a.status]||3)-(o[b.status]||3)});
  if(!rows.length){$("#attList").innerHTML='<div class="empty"><div class="t">No records</div>Punches will appear here as they come in.</div>';return}
  $("#attList").innerHTML=rows.map(function(r){
    var st=r.status==="in"?'<span class="badge in">On floor</span>':r.status==="done"?'<span class="badge done">Done</span>':'<span class="badge absent">Absent</span>';
    var t=r.clockIn?('<span class="tnum">'+esc(r.clockIn.slice(0,5))+(r.clockOut?" – "+esc(r.clockOut.slice(0,5)):"")+'</span>'):"";
    return '<div class="row"><span class="av" style="'+av(r.person)+'">'+esc(ini(r.person))+'</span>'+
      '<div><div class="nm">'+esc(r.person)+'</div><div class="mt"><span class="tag">'+esc((r.shift||"").replace(/ Shift/,"")||"—")+'</span>'+t+'</div></div>'+
      '<div class="rt">'+st+'</div></div>';
  }).join("");
}
function loadPeople(){j("/api/employees").then(function(d){EMP=d.items||[];renderPeople()}).catch(function(){})}
function renderPeople(){var q=($("#pq").value||"").toLowerCase();
  var rows=EMP.filter(function(e){return !q||e.person.toLowerCase().indexOf(q)>=0||String(e.pid).indexOf(q)>=0});
  if(!rows.length){$("#peopleList").innerHTML='<div class="empty"><div class="t">No employees</div></div>';return}
  $("#peopleList").innerHTML=rows.map(function(e){
    return '<div class="row tap" data-pid="'+esc(e.pid)+'"><span class="av" style="'+av(e.person)+'">'+esc(ini(e.person))+'</span>'+
      '<div><div class="nm">'+esc(e.person)+'</div><div class="mt"><span class="tag">ID '+esc(e.pid)+'</span><span class="tag">'+esc(e.shift||"—")+'</span>'+(e.department?'<span class="tag">'+esc(e.department)+'</span>':"")+(e.fpEnrolled?'<span class="fp y">&#10003; FP</span>':'')+'</div></div></div>';
  }).join("");}
$("#pq").addEventListener("input",renderPeople);
function loadDevices(){j("/api/devices").then(function(d){DEV=d.items||[];
  if(!DEV.length){$("#devList").innerHTML='<div class="empty"><div class="t">No devices yet</div>Register a machine from the full dashboard.</div>';return}
  $("#devList").innerHTML=DEV.map(function(v){var on=/online|connected/i.test(v.status)&&!/not/i.test(v.status);
    return '<div class="row"><span class="av" style="background:var(--surface2)"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#8b93a3" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/></svg></span>'+
      '<div><div class="nm">'+esc(v.alias||v.sn)+'</div><div class="mt"><span class="tag">'+esc(v.sn)+'</span>'+(v.ip?'<span class="tag">'+esc(v.ip)+'</span>':"")+'</div></div>'+
      '<div class="rt"><span class="badge '+(on?"in":"absent")+'">'+esc(v.status||"Offline")+'</span></div></div>';
  }).join("")}).catch(function(){})}
// Add punch sheet
$("#fab").addEventListener("click",function(){var n=new Date();$("#mDate").value=n.toISOString().slice(0,10);$("#mTime").value=n.toTimeString().slice(0,5);$("#mErr").style.display="none";$("#mendOv").classList.add("on")});
$("#mCancel").addEventListener("click",function(){$("#mendOv").classList.remove("on")});
$("#mendOv").addEventListener("click",function(e){if(e.target.id==="mendOv")$("#mendOv").classList.remove("on")});
$("#mSave").addEventListener("click",function(){
  var pid=$("#mPid").value.trim(),d=$("#mDate").value,t=$("#mTime").value,err=$("#mErr");
  if(!pid||!d||!t){err.textContent="All fields are required.";err.style.display="block";return}
  var p=d.split("-"),dateMDY=(+p[1])+"/"+(+p[2])+"/"+p[0];
  j("/api/mend-punches",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pid:pid,dateMDY:dateMDY,hms:t+":00"})})
    .then(function(r){if(!r.ok){err.textContent=r.error||"Failed";err.style.display="block";return}$("#mendOv").classList.remove("on");$("#mPid").value="";alert("Punch submitted for approval.")})
    .catch(function(){err.textContent="Network error.";err.style.display="block"});
});
function tick(){var c=$("#clk");if(!c)return;var d=new Date(),h=d.getHours(),m=d.getMinutes();c.textContent=(h<10?"0":"")+h+":"+(m<10?"0":"")+m;}tick();setInterval(tick,1000);loadToday();setInterval(loadToday,60000);
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(function(){});
var APM=[],APA=[];
function apRow(t1,t2,btns){return '<div class="apcard"><div class="apinfo"><b>'+t1+'</b><span>'+t2+'</span></div>'+btns+'</div>'}
function apBtns(kind,id){return '<div class="apbtns"><button class="apok" data-k="'+kind+'" data-a="approve" data-id="'+esc(id)+'">Approve</button><button class="apno" data-k="'+kind+'" data-a="reject" data-id="'+esc(id)+'">Reject</button></div>'}
function renderApprovals(){
  var mp=APM.filter(function(r){return r.status==="pending"});
  var ap=APA.filter(function(r){return r.status==="pending"});
  var em=$("#apMend"),ea=$("#apAbs");
  if(em)em.innerHTML=mp.length?mp.map(function(r){return apRow(esc(r.person||r.pid),esc(r.dateMDY)+" · "+esc(r.hms),apBtns("mend",r.id))}).join(""):'<div class="apempty">No punch corrections waiting.</div>';
  if(ea)ea.innerHTML=ap.length?ap.map(function(r){var dr=r.startDate===r.endDate?r.startDate:(r.startDate+" → "+r.endDate);return apRow(esc(r.person||r.pid),esc(r.type)+" · "+esc(dr)+" · "+esc(r.days)+"d",apBtns("abs",r.id))}).join(""):'<div class="apempty">No absence requests waiting.</div>';
  var n=mp.length+ap.length,bd=$("#apBadge");
  if(bd){if(n>0){bd.hidden=false;bd.textContent=n}else{bd.hidden=true}}
}
function loadApprovals(){
  j("/api/mend-punches").then(function(d){APM=(d&&d.items)||[];renderApprovals()}).catch(function(){});
  j("/api/absence-requests").then(function(d){APA=(d&&d.items)||[];renderApprovals()}).catch(function(){});
}
document.addEventListener("click",function(e){
  var b=e.target.closest("button[data-k]");if(!b)return;
  var k=b.getAttribute("data-k"),act=b.getAttribute("data-a"),id=b.getAttribute("data-id");
  var u=k==="mend"?"/api/mend-punches/":"/api/absence-requests/";
  b.disabled=true;
  j(u+act,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})}).then(function(){loadApprovals()}).catch(function(){b.disabled=false});
});
loadApprovals();
(function(){
  var oc=document.querySelector(".ttl .oclock svg");if(!oc)return;
  var d=new Date(),sec=d.getSeconds(),mi=d.getMinutes()+sec/60,hr=(d.getHours()%12)+mi/60;
  var hh=oc.querySelector(".hh"),mh=oc.querySelector(".mh"),sh=oc.querySelector(".sh");
  if(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches){
    hh.setAttribute("transform","rotate("+(hr*30)+" 20 20)");
    mh.setAttribute("transform","rotate("+(mi*6)+" 20 20)");
    sh.setAttribute("transform","rotate("+(sec*6)+" 20 20)");
    return;
  }
  hh.style.animationDelay=(-hr*3600)+"s";
  mh.style.animationDelay=(-mi*60)+"s";
  sh.style.animationDelay=(-sec)+"s";
})();
</script></body></html>`;
const SANICLOCK_SW = `const C='saniclock-v5';
self.addEventListener('install',function(e){e.waitUntil(caches.open(C).then(function(c){return c.addAll(['/m','/icon.svg','/manifest.webmanifest']);}).then(function(){return self.skipWaiting();}).catch(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==C}).map(function(k){return caches.delete(k)}))})]));});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  var u=new URL(e.request.url);
  e.respondWith(fetch(e.request).then(function(r){
    if(u.pathname==='/m'||u.pathname==='/icon.svg'||u.pathname==='/manifest.webmanifest'){var cp=r.clone();caches.open(C).then(function(c){c.put(e.request,cp);});}
    return r;
  }).catch(function(){return caches.match(e.request).then(function(h){return h||(e.request.mode==='navigate'?caches.match('/m'):undefined);});}));
});`;

const LOGIN_HTML = "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"UTF-8\"/><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>\n<title>SaniClock · Sign in</title>\n<link rel=\"icon\" href=\"/icon.svg?v=2\" type=\"image/svg+xml\"/>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"/>\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin/>\n<link href=\"https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700,800&f[]=satoshi@400,500,700&display=swap\" rel=\"stylesheet\"/>\n<link href=\"https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap\" rel=\"stylesheet\"/>\n<style>\n:root{\n  --bg:#04070f; --panel:#080d18; --card:#0a101d; --card2:#0d1424;\n  --line:rgba(120,160,255,.11); --line2:rgba(143,208,255,.22);\n  --text:#eef3fb; --text2:#8fa0be; --text3:#7c8dae;\n  --brand:#2f7bff; --brand2:#59a6ff; --brand3:#9dd4ff;\n  --emerald:#34d399; --glow:rgba(47,123,255,.5);\n  --c-day:#f5a524; --c-aft:#fb7a54; --c-night:#818cf8;\n  --sans:\"Satoshi\",-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;\n  --disp:\"Cabinet Grotesk\",\"Satoshi\",sans-serif;\n  --mono:\"JetBrains Mono\",ui-monospace,Menlo,Consolas,monospace;\n}\n*{box-sizing:border-box;margin:0;padding:0}\nhtml,body{height:100%}\nbody{font-family:var(--sans);background:var(--bg);color:var(--text);display:flex;overflow:hidden}\n@media (max-width:960px){body{flex-direction:column;overflow:auto}}\n\n/* ===================== LEFT: access panel ===================== */\n.panel{width:min(32%,470px);min-width:360px;flex:none;background:var(--panel);border-right:1px solid var(--line);\n  display:flex;flex-direction:column;padding:36px 40px;position:relative;z-index:2}\n.brand{display:flex;align-items:center;gap:14px}\n.brand img{width:76px;height:76px;border-radius:50%;filter:drop-shadow(0 0 16px var(--glow));animation:breathe 4.5s ease-in-out infinite}\n@keyframes breathe{0%,100%{filter:drop-shadow(0 0 10px rgba(47,123,255,.35))}50%{filter:drop-shadow(0 0 22px rgba(89,166,255,.65))}}\n.brand .bt b{display:flex;align-items:center;gap:10px;font-family:var(--disp);font-size:37px;font-weight:800;letter-spacing:-.5px;line-height:1.05}\n.oclock{display:inline-grid;place-items:center;width:.95em;height:.95em;margin:0 .02em;align-self:center;color:var(--text);filter:drop-shadow(0 0 6px rgba(89,166,255,.5))}\n.oclock svg{width:100%;height:100%;display:block}\n.oclock .hh,.oclock .mh,.oclock .sh{transform-origin:20px 20px;transform-box:view-box}\n.oclock .hh{animation:ocSpin 43200s linear infinite}\n.oclock .mh{animation:ocSpin 3600s linear infinite}\n.oclock .sh{animation:ocSpin 60s linear infinite}\n@keyframes ocSpin{to{transform:rotate(360deg)}}\n.brand .bt .new{font-size:9px;font-weight:800;letter-spacing:.14em;color:#04070f;background:linear-gradient(135deg,var(--brand3),var(--brand2));padding:3px 8px;border-radius:999px}\n.brand .bt i{display:block;font-style:normal;font-size:12px;font-weight:700;letter-spacing:.26em;text-transform:uppercase;color:var(--brand2);margin-top:5px}\n.auth{margin:auto 0;background:rgba(255,255,255,.025);border:1px solid var(--line2);border-radius:20px;padding:30px 26px;box-shadow:0 26px 60px -28px rgba(0,0,0,.7),0 0 40px -18px var(--glow)}\n.eyebrow{font-size:10.5px;font-weight:700;letter-spacing:.26em;text-transform:uppercase;color:var(--text3);margin-bottom:12px}\n.auth h1{font-family:var(--disp);font-size:38px;font-weight:800;letter-spacing:-.7px;margin-bottom:10px}\n.auth .sub{font-size:14.5px;color:var(--text2);line-height:1.5;margin-bottom:28px}\n.field{margin-bottom:16px}\n.field label{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text2);margin-bottom:8px}\n.inp{position:relative}\n.inp svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);width:16px;height:16px;color:var(--text3);transition:color .2s}\n.inp:focus-within svg{color:var(--brand2)}\n.inp input{width:100%;height:54px;background:rgba(255,255,255,.035);border:1px solid var(--line);border-radius:13px;color:var(--text);\n  font-size:15px;padding:0 15px 0 42px;outline:none;transition:border-color .2s,background .2s,box-shadow .2s}\n.inp input:focus{border-color:var(--brand);background:rgba(47,123,255,.06);box-shadow:0 0 0 4px rgba(47,123,255,.13)}\n.inp input::placeholder{color:#4a5975}\n.inp .pv{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:38px;height:38px;display:grid;place-items:center;background:none;border:0;color:var(--text3);cursor:pointer;border-radius:9px}\n.inp .pv:hover{color:var(--brand2)}\n.inp .pv:focus-visible{outline:2px solid var(--brand);outline-offset:1px}\n.inp .pv svg{width:17px;height:17px}\n.btn{width:100%;height:54px;margin-top:14px;border:0;border-radius:13px;cursor:pointer;font-size:16px;font-weight:700;color:#fff;\n  background:linear-gradient(135deg,var(--brand2),var(--brand));background-size:200% 200%;\n  box-shadow:0 16px 38px -14px var(--glow),0 1px 0 rgba(255,255,255,.2) inset;\n  transition:transform .18s,box-shadow .18s,background-position .5s;display:flex;align-items:center;justify-content:center;gap:8px}\n.btn:hover{transform:translateY(-2px);box-shadow:0 22px 48px -14px var(--glow);background-position:100% 0}\n.btn:active{transform:translateY(0)}\n.btn[disabled]{opacity:.65;cursor:default;transform:none}\n.hint{margin-top:16px;font-size:12px;color:var(--text3)}\n.err{background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.3);color:#ffb1b1;font-size:12.5px;padding:10px 13px;border-radius:11px;margin-bottom:16px;display:none}\n.feats{display:flex;flex-direction:column;gap:10px;margin-top:24px;margin-bottom:20px}\n.feat{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:13px;padding:11px 13px;animation:featIn .6s cubic-bezier(.16,1,.3,1) backwards}\n.feat:nth-child(1){animation-delay:.15s}.feat:nth-child(2){animation-delay:.3s}.feat:nth-child(3){animation-delay:.45s}\n@keyframes featIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}\n.feat .fi{width:34px;height:34px;flex:none;border-radius:10px;display:grid;place-items:center;background:rgba(47,123,255,.10);color:var(--brand2)}\n.feat .fi svg{width:17px;height:17px}\n.feat .ft b{display:block;font-size:12.5px;font-weight:800;letter-spacing:-.1px}\n.feat .ft span{display:block;font-size:11px;color:var(--text3);margin-top:2px;line-height:1.4}\n.rotator{margin-bottom:18px;min-height:38px;font-size:13px;line-height:1.5;color:var(--text2)}\n.rotator .rq{color:var(--brand2);font-size:17px;font-weight:800;margin-right:2px}\n.rotator #rot{transition:opacity .45s ease}\n.rotator #rot.fade{opacity:0}\n.tick{display:flex;overflow:hidden;margin-top:4px;padding-top:8px;border-top:1px solid var(--line);\n  mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)}\n.tick .tk{flex:none;white-space:nowrap;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.22em;text-transform:uppercase;color:var(--text3);animation:tkm 42s linear infinite}\n@keyframes tkm{to{transform:translateX(-100%)}}\n@media (max-width:960px){.feats{display:none}.rotator{display:none}}\n.pfoot{font-size:11px;color:var(--text3);display:flex;align-items:center;gap:7px}\n.pfoot svg{width:12px;height:12px}\n.spin{width:16px;height:16px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:sp .6s linear infinite}\n@keyframes sp{to{transform:rotate(360deg)}}\n\n/* ===================== RIGHT: live stage ===================== */\n.stage{flex:1;min-width:0;position:relative;overflow:hidden;display:flex;background:linear-gradient(160deg,rgba(4,7,15,.46),rgba(4,7,15,.20) 55%,rgba(4,7,15,.40)),url(\"/stage-bg.png?v=2\") center/cover no-repeat}\n.stage::after{content:\"\";position:absolute;inset:0;z-index:0;pointer-events:none;opacity:.45;\n  background-image:linear-gradient(rgba(143,208,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(143,208,255,.04) 1px,transparent 1px);\n  background-size:56px 56px;mask-image:radial-gradient(ellipse 85% 75% at 50% 40%,#000,transparent 92%);\n  -webkit-mask-image:radial-gradient(ellipse 85% 75% at 50% 40%,#000,transparent 92%)}\n#fx{position:absolute;inset:0;z-index:0;pointer-events:none}\n.inner{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;gap:18px;padding:34px 52px 22px;width:100%}\n\n.top{display:flex;align-items:center;justify-content:space-between;gap:18px}\n.pip{width:7px;height:7px;border-radius:50%;background:var(--emerald);display:inline-block;margin-right:9px;vertical-align:1px;\n  box-shadow:0 0 0 0 rgba(52,211,153,.5);animation:pulse 2.4s infinite}\n@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}70%{box-shadow:0 0 0 8px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}\n.clock{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;font-size:clamp(58px,7.2vw,102px);font-weight:250;letter-spacing:-2px;line-height:.92;\n  background:linear-gradient(180deg,#fff,#a9c8ff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}\n.clock .sec{font-weight:300;color:var(--brand2);-webkit-text-fill-color:var(--brand2);font-size:.5em;letter-spacing:0;vertical-align:.28em;margin-left:.12em}\n.date{margin-top:8px;font-size:15px;color:var(--text2);font-weight:500}\n.chips{display:flex;gap:10px;flex:none;margin-top:6px}\n.chip{display:flex;align-items:center;gap:10px;background:rgba(10,16,29,.5);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:14px;padding:12px 16px}\n.chip svg{width:19px;height:19px;color:var(--brand2);flex:none}\n.chip b{display:block;font-size:14px;font-weight:800;letter-spacing:-.2px}\n.chip span{display:block;font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text3)}\n\n.statement{flex:1;min-width:0;padding:0 3.5vw}\n.statement h2{font-family:var(--disp);font-size:clamp(26px,2.9vw,46px);font-weight:800;letter-spacing:-.02em;line-height:1.1;text-wrap:balance;text-shadow:0 1px 14px rgba(4,7,15,.85)}\n.statement h2 em{font-style:normal;background:linear-gradient(90deg,var(--brand2),#c9e6ff,var(--brand2));background-size:200% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:emShine 7s linear infinite}\n@keyframes emShine{to{background-position:200% 0}}\n.statement p{margin-top:9px;font-size:14.5px;color:var(--text2);line-height:1.5;max-width:520px;text-shadow:0 1px 10px rgba(4,7,15,.9)}\n\n.card{background:rgba(10,16,29,.58);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid var(--line);border-radius:18px;padding:18px 20px 12px;flex:1;min-height:0;display:flex;flex-direction:column;\n  box-shadow:0 24px 60px -30px rgba(0,0,0,.7)}\n.ch{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px}\n.ch b{font-size:15px;font-weight:800;letter-spacing:-.2px;display:block}\n.ch span{font-size:12px;color:var(--text3);display:block;margin-top:2px}\n.pill{flex:none;font-size:9.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--brand3);\n  border:1px solid var(--line2);background:rgba(47,123,255,.08);padding:5px 11px;border-radius:999px}\n#wave{width:100%;flex:1;min-height:150px}\n\n.shifts{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}\n.scard{background:rgba(10,16,29,.52);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--line);border-radius:15px;padding:14px 16px;transition:border-color .3s,box-shadow .3s}\n.scard .sh{display:flex;align-items:center;justify-content:space-between;gap:8px}\n.scard .sh b{font-size:14.5px;font-weight:800;color:var(--text3);transition:color .3s}\n.scard .onpill{display:none;font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--brand3);\n  border:1px solid var(--line2);padding:3px 9px;border-radius:999px}\n.scard .rng{font-family:var(--mono);font-size:12px;color:var(--text3);margin-top:5px}\n.scard .bar{height:3px;border-radius:99px;background:rgba(255,255,255,.07);margin-top:12px;overflow:hidden}\n.scard .bar i{display:block;height:100%;width:100%;border-radius:99px;background:linear-gradient(90deg,var(--brand2),var(--brand));transform:scaleX(0);transform-origin:left;transition:transform 1s ease}\n.scard .meta{font-size:11px;color:var(--text3);margin-top:9px;font-family:var(--mono)}\n.scard.on{border-color:var(--line2);box-shadow:0 0 0 1px rgba(47,123,255,.14),0 14px 36px -18px var(--glow)}\n.scard.on .sh b{color:var(--text)}\n.scard.on .onpill{display:inline-block}\n.scard.on .meta{color:var(--brand2)}\n.scard.day.on .bar i{background:linear-gradient(90deg,var(--c-day),#ffd27a)}\n.scard.aft.on .bar i{background:linear-gradient(90deg,var(--c-aft),#ffb49b)}\n.scard.night.on .bar i{background:linear-gradient(90deg,var(--c-night),#b9bffc)}\n\n.sf{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--text3)}\n.sf b{color:var(--text2);font-weight:700}\n\n@media (max-width:1250px){.chips{display:none}}\n@media (max-width:960px){\n  .panel{width:100%;min-width:0;border-right:0;border-bottom:1px solid var(--line);padding:26px 24px}\n  .auth{padding:22px 18px}\n  .inner{padding:26px 22px 18px;gap:16px}\n  .statement{display:none}\n  .shifts{display:none}\n  .sf{display:none}\n  .clock{font-size:clamp(44px,11vw,58px)}\n  #wave{min-height:130px}\n}\n@media (max-width:640px){.stage{display:none}}\n@media (prefers-reduced-motion:reduce){*{animation:none!important}}\n</style></head>\n<body>\n\n<aside class=\"panel\">\n  <div class=\"brand\">\n    <img src=\"/icon.svg?v=2\" alt=\"SaniXperts\"/>\n    <div class=\"bt\"><b role=\"img\" aria-label=\"SaniClock\">SaniCl<span class=\"oclock\" aria-hidden=\"true\"><svg viewBox=\"0 0 40 40\"><circle cx=\"20\" cy=\"20\" r=\"16.5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"3.6\"/><g stroke=\"currentColor\" stroke-width=\"2\" opacity=\".45\"><line x1=\"20\" y1=\"6.5\" x2=\"20\" y2=\"9.5\"/><line x1=\"20\" y1=\"30.5\" x2=\"20\" y2=\"33.5\"/><line x1=\"6.5\" y1=\"20\" x2=\"9.5\" y2=\"20\"/><line x1=\"30.5\" y1=\"20\" x2=\"33.5\" y2=\"20\"/></g><line class=\"hh\" x1=\"20\" y1=\"21\" x2=\"20\" y2=\"13\" stroke=\"currentColor\" stroke-width=\"3\" stroke-linecap=\"round\"/><line class=\"mh\" x1=\"20\" y1=\"21\" x2=\"20\" y2=\"9.5\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"/><line class=\"sh\" x1=\"20\" y1=\"22.5\" x2=\"20\" y2=\"8\" stroke=\"#59a6ff\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><circle cx=\"20\" cy=\"20\" r=\"2\" fill=\"var(--brand2)\"/></svg></span>ck <span class=\"new\">New</span></b><i>Powered by SaniXperts</i></div>\n  </div>\n  <div class=\"auth\">\n    <div class=\"eyebrow\">Workspace access</div>\n    <h1>Welcome back.</h1>\n    <p class=\"sub\">Sign in to your attendance &amp; payroll command center.</p>\n    <div class=\"err\" id=\"err\"></div>\n    <form id=\"f\">\n      <div class=\"field\"><label for=\"u\">Username</label><div class=\"inp\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/></svg><input id=\"u\" name=\"u\" autocomplete=\"username\" placeholder=\"username\" autofocus/></div></div>\n      <div class=\"field\"><label for=\"p\">Password</label><div class=\"inp\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"4\" y=\"11\" width=\"16\" height=\"10\" rx=\"2\"/><path d=\"M8 11V7a4 4 0 0 1 8 0v4\"/></svg><input id=\"p\" name=\"p\" type=\"password\" autocomplete=\"current-password\" placeholder=\"••••••••\" style=\"padding-right:46px\"/><button type=\"button\" class=\"pv\" id=\"pv\" aria-label=\"Show password\" aria-pressed=\"false\"><svg class=\"eye\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/></svg><svg class=\"eyeoff\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"display:none\"><path d=\"M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68\"/><path d=\"M6.61 6.61A13.526 13.526 0 0 0 2 11s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61\"/><line x1=\"2\" y1=\"2\" x2=\"22\" y2=\"22\"/></svg></button></div></div>\n      <button class=\"btn\" id=\"btn\" type=\"submit\"><span id=\"btxt\">Sign in</span></button>\n    </form>\n    <div class=\"hint\">Forgot your password? <a href=\"mailto:Sanixpertsadmin@sanixperts.ca\" style=\"color:var(--brand2);text-decoration:underline;text-underline-offset:3px\">Contact your administrator</a>.</div>\n  </div>\n  <div class=\"feats\">\n    <div class=\"feat\"><span class=\"fi\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 8V4H8\"/><rect x=\"4\" y=\"8\" width=\"16\" height=\"12\" rx=\"2\"/><path d=\"M2 14h2M20 14h2M15 13v2M9 13v2\"/></svg></span><div class=\"ft\"><b>Agentic workflow</b><span>An AI agent verifies every punch in real time</span></div></div>\n    <div class=\"feat\"><span class=\"fi\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M13 2 3 14h9l-1 8 10-12h-9l1-8z\"/></svg></span><div class=\"ft\"><b>Self-computing payroll</b><span>Hours, breaks and overtime settle themselves</span></div></div>\n    <div class=\"feat\"><span class=\"fi\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M17.5 19a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 14.9\"/><path d=\"m12 12v9\"/><path d=\"m8 17 4 4 4-4\"/></svg></span><div class=\"ft\"><b>Zero-touch sync</b><span>Cloud-linked devices &mdash; no manual imports, ever</span></div></div>\n  </div>\n  <div class=\"rotator\" aria-hidden=\"true\"><span class=\"rq\">&ldquo;</span><span id=\"rot\">Payroll that computes itself.</span></div>\n  <div class=\"pfoot\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"4\" y=\"11\" width=\"16\" height=\"10\" rx=\"2\"/><path d=\"M8 11V7a4 4 0 0 1 8 0v4\"/></svg> Secure company access &middot; 256-bit encrypted session</div>\n</aside>\n\n<main class=\"stage\">\n  <canvas id=\"fx\" aria-hidden=\"true\"></canvas>\n  <div class=\"inner\">\n    <header class=\"top\">\n      <div>\n        <div class=\"eyebrow\"><span class=\"pip\"></span>Live facility time</div>\n        <div class=\"clock\" id=\"clock\">--:--<span class=\"sec\" id=\"sec\">--</span></div>\n        <div class=\"date\" id=\"date\">&mdash;</div>\n      </div>\n      <div class=\"statement\">\n        <h2>Every shift, in <em>sharp focus</em>.</h2>\n        <p>Live attendance and automatic payroll for the entire Ferrero floor &mdash; one workspace.</p>\n      </div>\n      <div class=\"chips\">\n        <div class=\"chip\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 12a9 9 0 1 1-9-9\"/><path d=\"M21 3v6h-6\"/></svg><div><b>24 / 7</b><span>Coverage</span></div></div>\n        <div class=\"chip\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M16 3h5v5\"/><path d=\"M8 21H3v-5\"/><path d=\"M21 3l-7.5 7.5\"/><path d=\"M3 21l7.5-7.5\"/></svg><div><b>3 shifts</b><span>Rotating</span></div></div>\n        <div class=\"chip\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M16 2v4M8 2v4M3 10h18\"/><path d=\"m9 16 2 2 4-4\"/></svg><div><b>Auto</b><span>Payroll</span></div></div>\n      </div>\n    </header>\n\n    <section class=\"card\">\n      <div class=\"ch\">\n        <div><b>Attendance rhythm</b><span>Clock-in volume across a typical 24 hours</span></div>\n        <span class=\"pill\">Live sync</span>\n      </div>\n      <canvas id=\"wave\"></canvas>\n      <div class=\"tick\" aria-hidden=\"true\"><div class=\"tk\">Agentic workflow online &middot; AI reconciles every punch &middot; Payroll computes itself &middot; Shifts balance automatically &middot; Zero-touch timecards &middot; Live device sync &middot;&nbsp;</div><div class=\"tk\">Agentic workflow online &middot; AI reconciles every punch &middot; Payroll computes itself &middot; Shifts balance automatically &middot; Zero-touch timecards &middot; Live device sync &middot;&nbsp;</div></div>\n    </section>\n\n    <section class=\"shifts\">\n      <div class=\"scard day\" data-s=\"day\"><div class=\"sh\"><b>Day</b><span class=\"onpill\">On now</span></div><div class=\"rng\">07:00 &ndash; 15:00</div><div class=\"bar\"><i></i></div><div class=\"meta\">8-hour shift &middot; standby</div></div>\n      <div class=\"scard aft\" data-s=\"aft\"><div class=\"sh\"><b>Afternoon</b><span class=\"onpill\">On now</span></div><div class=\"rng\">15:00 &ndash; 23:00</div><div class=\"bar\"><i></i></div><div class=\"meta\">8-hour shift &middot; standby</div></div>\n      <div class=\"scard night\" data-s=\"night\"><div class=\"sh\"><b>Night</b><span class=\"onpill\">On now</span></div><div class=\"rng\">23:00 &ndash; 07:00</div><div class=\"bar\"><i></i></div><div class=\"meta\">8-hour shift &middot; standby</div></div>\n    </section>\n\n    <footer class=\"sf\"><span>Every shift, accounted for.</span><span><b>Ferrero</b> &middot; Attendance &amp; Payroll</span></footer>\n  </div>\n</main>\n\n<script>\nvar $=function(s){return document.querySelector(s)};\nvar WD=[\"Sunday\",\"Monday\",\"Tuesday\",\"Wednesday\",\"Thursday\",\"Friday\",\"Saturday\"];\nvar MO=[\"Jan\",\"Feb\",\"Mar\",\"Apr\",\"May\",\"Jun\",\"Jul\",\"Aug\",\"Sep\",\"Oct\",\"Nov\",\"Dec\"];\nfunction p2(n){return (n<10?\"0\":\"\")+n}\nvar reduce=window.matchMedia&&window.matchMedia(\"(prefers-reduced-motion: reduce)\").matches;\n\n/* ---- clock ---- */\nfunction tick(){\n  var d=new Date();\n  $(\"#clock\").firstChild.nodeValue=p2(d.getHours())+\":\"+p2(d.getMinutes());\n  $(\"#sec\").textContent=p2(d.getSeconds());\n  $(\"#date\").textContent=WD[d.getDay()]+\", \"+MO[d.getMonth()]+\" \"+d.getDate()+\", \"+d.getFullYear();\n}\ntick();setInterval(tick,1000);\n\n/* ---- shift cards: active state + live progress ---- */\nfunction fmtHM(min){min=Math.max(0,Math.round(min));return Math.floor(min/60)+\"h \"+p2(min%60)+\"m\";}\nfunction shiftTick(){\n  var d=new Date(),h=d.getHours();\n  var cur=(h>=7&&h<15)?\"day\":(h>=15&&h<23)?\"aft\":\"night\";\n  var start=new Date(d);\n  if(cur===\"day\")start.setHours(7,0,0,0);\n  else if(cur===\"aft\")start.setHours(15,0,0,0);\n  else{start.setHours(23,0,0,0);if(h<23)start.setDate(start.getDate()-1);}\n  var elapsed=(d-start)/60000,total=480,left=total-elapsed;\n  var cards=document.querySelectorAll(\".scard\");\n  for(var i=0;i<cards.length;i++){\n    var c=cards[i],on=c.getAttribute(\"data-s\")===cur;\n    c.classList.toggle(\"on\",on);\n    var bar=c.querySelector(\".bar i\"),meta=c.querySelector(\".meta\");\n    if(on){\n      bar.style.transform=\"scaleX(\"+Math.min(1,elapsed/total)+\")\";\n      meta.textContent=fmtHM(elapsed)+\" elapsed · \"+fmtHM(left)+\" left\";\n    }else{\n      bar.style.transform=\"scaleX(0)\";\n      meta.textContent=\"8-hour shift · standby\";\n    }\n  }\n}\nshiftTick();setInterval(shiftTick,30000);\n\n/* ---- attendance rhythm wave ---- */\n(function(){\n  var cv=$(\"#wave\");if(!cv||!cv.getContext)return;\n  var cx=cv.getContext(\"2d\");\n  var DPR=Math.min(window.devicePixelRatio||1,2),W=0,H=0;\n  function size(){var r=cv.getBoundingClientRect();W=Math.max(1,r.width);H=Math.max(1,r.height);cv.width=W*DPR;cv.height=H*DPR;cx.setTransform(DPR,0,0,DPR,0,0);}\n  size();window.addEventListener(\"resize\",function(){size();if(reduce)draw(1,1);});\n  function vol(h,t){\n    var v=0,peaks=[7,15,23,-1];\n    for(var i=0;i<peaks.length;i++){var d=h-peaks[i];v+=Math.exp(-d*d/(2*2.4*2.4));}\n    return v*(1+ (reduce?0:0.05*Math.sin(t*.7+h*.9)));\n  }\n  function draw(t,prog){\n    var padL=8,padR=8,padT=14,padB=26;\n    var iw=W-padL-padR,ih=H-padT-padB;\n    cx.clearRect(0,0,W,H);\n    /* gridlines */\n    cx.strokeStyle=\"rgba(143,160,190,.08)\";cx.lineWidth=1;\n    for(var g=1;g<=2;g++){var gy=padT+ih*g/3;cx.beginPath();cx.moveTo(padL,gy);cx.lineTo(W-padR,gy);cx.stroke();}\n    /* x labels */\n    cx.font=\"500 10px \"+\"'JetBrains Mono',monospace\";\n    cx.fillStyle=\"rgba(88,106,136,.9)\";cx.textAlign=\"center\";cx.textBaseline=\"top\";\n    for(var lx=0;lx<=24;lx+=4){cx.fillText(p2(lx),padL+iw*lx/24,H-padB+9);}\n    /* wave path */\n    var pts=[],n=140,maxv=0,i,h,v;\n    for(i=0;i<=n;i++){h=24*i/n;v=vol(h,t);if(v>maxv)maxv=v;pts.push([h,v]);}\n    var endH=24*prog;\n    cx.beginPath();\n    var started=false,px2=0,py2=0;\n    for(i=0;i<=n;i++){\n      h=pts[i][0];if(h>endH)break;\n      v=pts[i][1];\n      var x=padL+iw*h/24,y=padT+ih-(v/maxv)*ih*.86;\n      if(!started){cx.moveTo(x,y);started=true;}else{cx.lineTo(x,y);}\n      px2=x;py2=y;\n    }\n    var lg=cx.createLinearGradient(padL,0,W-padR,0);\n    lg.addColorStop(0,\"#818cf8\");lg.addColorStop(.5,\"#59a6ff\");lg.addColorStop(1,\"#9dd4ff\");\n    cx.strokeStyle=lg;cx.lineWidth=2.5;cx.lineJoin=\"round\";cx.lineCap=\"round\";\n    cx.shadowColor=\"rgba(89,166,255,.45)\";cx.shadowBlur=10;\n    cx.stroke();cx.shadowBlur=0;\n    /* area fill */\n    cx.lineTo(px2,padT+ih);cx.lineTo(padL,padT+ih);cx.closePath();\n    var ag=cx.createLinearGradient(0,padT,0,padT+ih);\n    ag.addColorStop(0,\"rgba(89,166,255,.16)\");ag.addColorStop(1,\"rgba(89,166,255,0)\");\n    cx.fillStyle=ag;cx.fill();\n    /* now marker */\n    var d=new Date(),nh=d.getHours()+d.getMinutes()/60+d.getSeconds()/3600;\n    if(nh<=endH){\n      var nx=padL+iw*nh/24,nv=vol(nh,t),ny=padT+ih-(nv/maxv)*ih*.86;\n      cx.strokeStyle=\"rgba(143,160,190,.22)\";cx.lineWidth=1;\n      cx.beginPath();cx.moveTo(nx,padT);cx.lineTo(nx,padT+ih);cx.stroke();\n      var hp=reduce?.5:.5+.5*Math.sin(t*2.2);\n      cx.shadowColor=\"rgba(157,212,255,.9)\";cx.shadowBlur=12+8*hp;\n      cx.fillStyle=\"#cfe6ff\";\n      cx.beginPath();cx.arc(nx,ny,4+1.2*hp,0,6.283);cx.fill();\n      cx.shadowBlur=0;\n      cx.strokeStyle=\"rgba(157,212,255,.5)\";cx.lineWidth=1.5;\n      cx.beginPath();cx.arc(nx,ny,8+3*hp,0,6.283);cx.stroke();\n    }\n  }\n  if(reduce){draw(1,1);return;}\n  var t0=null,run=true;\n  function frame(now){\n    if(!run)return;\n    if(t0===null)t0=now;\n    var el=(now-t0)/1000;\n    var prog=Math.min(1,el/1.1);prog=1-Math.pow(1-prog,3);\n    draw(now/1000,prog);\n    requestAnimationFrame(frame);\n  }\n  document.addEventListener(\"visibilitychange\",function(){\n    if(document.hidden){run=false;}\n    else if(!run){run=true;requestAnimationFrame(frame);}\n  });\n  requestAnimationFrame(frame);\n})();\n\n/* ---- ambient aurora (subtle, behind content) ---- */\n(function(){\n  var stage=document.querySelector(\".stage\"),cv=$(\"#fx\");\n  if(!stage||!cv||!cv.getContext)return;\n  var cx=cv.getContext(\"2d\");\n  var DPR=Math.min(window.devicePixelRatio||1,2),W=0,H=0;\n  function size(){var r=stage.getBoundingClientRect();W=Math.max(1,r.width);H=Math.max(1,r.height);cv.width=W*DPR;cv.height=H*DPR;cx.setTransform(DPR,0,0,DPR,0,0);}\n  size();window.addEventListener(\"resize\",size);\n  var RIBS=[\n    {y:.20,amp:26,f1:.9,f2:2.3,sp:.05,ph:0,rgb:\"47,123,255\",al:.12,th:150},\n    {y:.62,amp:34,f1:1.1,f2:1.8,sp:.036,ph:2.2,rgb:\"89,166,255\",al:.09,th:190}\n  ];\n  var MOTES=[],i;\n  for(i=0;i<64;i++)MOTES.push({x:Math.random(),y:Math.random(),r:.6+Math.random()*1.3,v:6+Math.random()*20,ph:Math.random()*6.28,tw:.3+Math.random()*.5});\n  function drawRib(t,rb){\n    var seg=8,top=[],bot=[],k,x,y;\n    for(k=0;k<=seg;k++){\n      x=-W*.08+W*1.16*k/seg;\n      y=H*rb.y+Math.sin(t*rb.sp*6+k*rb.f1+rb.ph)*rb.amp+Math.sin(t*rb.sp*3.7+k*rb.f2+rb.ph*1.7)*rb.amp*.5;\n      top.push([x,y]);bot.push([x,y+rb.th+Math.sin(t*rb.sp*3+k*1.3+rb.ph)*rb.th*.2]);\n    }\n    var g=cx.createLinearGradient(0,H*rb.y-rb.amp,0,H*rb.y+rb.th+rb.amp);\n    g.addColorStop(0,\"rgba(\"+rb.rgb+\",0)\");g.addColorStop(.45,\"rgba(\"+rb.rgb+\",\"+rb.al+\")\");g.addColorStop(1,\"rgba(\"+rb.rgb+\",0)\");\n    cx.fillStyle=g;cx.beginPath();cx.moveTo(top[0][0],top[0][1]);\n    for(k=1;k<=seg;k++){var p0=top[k-1],p1=top[k];cx.quadraticCurveTo(p0[0],p0[1],(p0[0]+p1[0])/2,(p0[1]+p1[1])/2);}\n    cx.lineTo(bot[seg][0],bot[seg][1]);\n    for(k=seg;k>=1;k--){var q0=bot[k],q1=bot[k-1];cx.quadraticCurveTo(q0[0],q0[1],(q0[0]+q1[0])/2,(q0[1]+q1[1])/2);}\n    cx.closePath();cx.fill();\n  }\n  function paint(t,dt){\n    cx.clearRect(0,0,W,H);\n    cx.globalCompositeOperation=\"lighter\";\n    for(var j=0;j<RIBS.length;j++)drawRib(t,RIBS[j]);\n    for(var m2=0;m2<MOTES.length;m2++){\n      var o=MOTES[m2];\n      o.y-=o.v*dt/Math.max(1,H);\n      if(o.y<-.03){o.y=1.03;o.x=Math.random();}\n      var a=o.tw*(.45+.55*Math.sin(t*1.4+o.ph));\n      if(a<=0)continue;\n      cx.beginPath();cx.arc(o.x*W,o.y*H,o.r,0,6.283);\n      cx.fillStyle=\"rgba(157,212,255,\"+(a*.55).toFixed(3)+\")\";cx.fill();\n    }\n    cx.globalCompositeOperation=\"source-over\";\n  }\n  if(reduce){paint(1.5,0);return;}\n  var last=0,run=true;\n  function frame(now){\n    if(!run)return;\n    var dt=Math.min(.05,(now-last)/1000||.016);last=now;\n    paint(now/1000,dt);\n    requestAnimationFrame(frame);\n  }\n  document.addEventListener(\"visibilitychange\",function(){\n    if(document.hidden){run=false;}\n    else if(!run){run=true;last=performance.now();requestAnimationFrame(frame);}\n  });\n  requestAnimationFrame(frame);\n})();\n\n/* ---- running clock inside the wordmark o ---- */\n(function(){\n  var oc=document.querySelector(\".oclock svg\");if(!oc)return;\n  var d=new Date(),sec=d.getSeconds(),mi=d.getMinutes()+sec/60,hr=(d.getHours()%12)+mi/60;\n  var hh=oc.querySelector(\".hh\"),mh=oc.querySelector(\".mh\"),sh=oc.querySelector(\".sh\");\n  if(window.matchMedia&&window.matchMedia(\"(prefers-reduced-motion: reduce)\").matches){\n    hh.setAttribute(\"transform\",\"rotate(\"+(hr*30)+\" 20 20)\");\n    mh.setAttribute(\"transform\",\"rotate(\"+(mi*6)+\" 20 20)\");\n    sh.setAttribute(\"transform\",\"rotate(\"+(sec*6)+\" 20 20)\");\n    return;\n  }\n  hh.style.animationDelay=(-hr*3600)+\"s\";\n  mh.style.animationDelay=(-mi*60)+\"s\";\n  sh.style.animationDelay=(-sec)+\"s\";\n})();\n\n/* ---- rotating agentic tagline ---- */\n(function(){\n  var el=document.getElementById(\"rot\");if(!el)return;\n  var LINES=[\n    \"Payroll that computes itself.\",\n    \"AI agents reconcile timecards around the clock.\",\n    \"From punch to payslip — zero human error.\",\n    \"The most agent-driven attendance platform on the market.\"\n  ];\n  var i=0;\n  if(window.matchMedia&&window.matchMedia(\"(prefers-reduced-motion: reduce)\").matches)return;\n  setInterval(function(){\n    el.classList.add(\"fade\");\n    setTimeout(function(){i=(i+1)%LINES.length;el.textContent=LINES[i];el.classList.remove(\"fade\");},460);\n  },4600);\n})();\n\n/* ---- show/hide password ---- */\nvar pv=$(\"#pv\"),pin=$(\"#p\");\nif(pv){pv.addEventListener(\"click\",function(){\n  var show=pin.type===\"password\";\n  pin.type=show?\"text\":\"password\";\n  pv.querySelector(\".eye\").style.display=show?\"none\":\"block\";\n  pv.querySelector(\".eyeoff\").style.display=show?\"block\":\"none\";\n  pv.setAttribute(\"aria-label\",show?\"Hide password\":\"Show password\");\n  pv.setAttribute(\"aria-pressed\",show?\"true\":\"false\");\n  pin.focus();\n});}\n\n/* ---- sign in ---- */\nvar f=$(\"#f\"),err=$(\"#err\"),btn=$(\"#btn\"),btxt=$(\"#btxt\");\nf.addEventListener(\"submit\",function(e){\n  e.preventDefault();err.style.display=\"none\";btn.disabled=true;btxt.innerHTML='<span class=\"spin\"></span>';\n  fetch(\"/api/login\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({user:$(\"#u\").value,pass:$(\"#p\").value})})\n  .then(function(r){return r.json();}).then(function(j){\n    if(j.ok){var nx=null;try{nx=new URLSearchParams(location.search).get(\"next\");}catch(e2){}window.location.href=(nx&&nx.charAt(0)===\"/\"&&nx.charAt(1)!==\"/\")?nx:\"/\";}\n    else{err.textContent=j.error||\"Sign in failed.\";err.style.display=\"block\";btn.disabled=false;btxt.textContent=\"Sign in\";}\n  }).catch(function(){err.textContent=\"Network error. Try again.\";err.style.display=\"block\";btn.disabled=false;btxt.textContent=\"Sign in\";});\n});\n</script>\n</body></html>\n";
const ME_HTML = "<!DOCTYPE html>\n<html lang=\"en\"><head>\n<meta charset=\"UTF-8\"/>\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\"/>\n<meta name=\"theme-color\" content=\"#05070e\"/>\n<title>My Timesheet · SaniClock</title>\n<link rel=\"icon\" href=\"/icon.svg\" type=\"image/svg+xml\"/>\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\"/>\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"black-translucent\"/>\n<meta name=\"apple-mobile-web-app-title\" content=\"SaniClock\"/>\n<link rel=\"manifest\" href=\"/manifest-me.webmanifest\"/>\n<link rel=\"apple-touch-icon\" href=\"/icon-180.png\"/>\n<style>\n:root{--bg:#05070e;--bg2:#080c18;--surface:rgba(18,22,33,.66);--surface2:rgba(32,38,54,.5);--line:rgba(120,160,255,.14);--line2:rgba(143,208,255,.24);--text:#eaf0fb;--text2:#93a1bd;--text3:#8493ad;--brand:#2f7bff;--brand2:#59a6ff;--emerald:#34d399;--amber:#fbbf24;--rose:#fb7185;--c-day:#f5a524;--c-aft:#fb7a54;--c-night:#818cf8;--glow:rgba(47,123,255,.5)}\n*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;margin:0;padding:0}\nhtml{background:var(--bg)}\nbody{color:var(--text);font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Inter,sans-serif;font-size:15px;min-height:100vh;overscroll-behavior-y:none;\n  background:radial-gradient(900px 520px at 82% -8%,rgba(47,123,255,.16),transparent 58%),radial-gradient(680px 520px at 4% 4%,rgba(89,166,255,.12),transparent 52%),linear-gradient(170deg,rgba(11,13,18,.74),rgba(8,9,12,.82) 55%),url(\"/stage-bg.png?v=2\") center/cover no-repeat;background-attachment:fixed}\n.wrap{max-width:560px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 18px) 16px calc(28px + env(safe-area-inset-bottom))}\n.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}\n.brand img{width:56px;height:56px;border-radius:50%;filter:drop-shadow(0 0 12px var(--glow))}\n.brand b{font-size:25px;font-weight:800;letter-spacing:-.3px;display:block;line-height:1.05}\n.brand div > span{font-size:10.5px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--brand2)}\n.card{background:var(--surface);backdrop-filter:blur(22px) saturate(150%);-webkit-backdrop-filter:blur(22px) saturate(150%);border:1px solid var(--line);border-radius:20px;padding:24px 22px;box-shadow:0 30px 70px -30px rgba(0,0,0,.8)}\nh1{font-size:22px;font-weight:800;letter-spacing:-.4px;margin-bottom:5px}\n.sub{font-size:13.5px;color:var(--text2);margin-bottom:22px}\nlabel{display:block;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text2);margin:14px 0 7px}\ninput{width:100%;height:48px;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:13px;color:var(--text);font-size:16px;padding:0 14px;outline:none;transition:border-color .2s,box-shadow .2s}\ninput:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(47,123,255,.14)}\ninput::placeholder{color:#4f5c76}\n.btn{width:100%;height:49px;margin-top:20px;border:0;border-radius:13px;cursor:pointer;font-size:15px;font-weight:700;color:#fff;background:linear-gradient(135deg,var(--brand2),var(--brand));box-shadow:0 14px 34px -12px var(--glow);transition:transform .18s,box-shadow .18s;display:flex;align-items:center;justify-content:center;gap:8px}\n.btn:hover{transform:translateY(-2px)}.btn:active{transform:none}.btn[disabled]{opacity:.6}\n.btn.ghost{background:var(--surface2);color:var(--text2);box-shadow:none;margin-top:10px}.btn.correction{background:linear-gradient(135deg,rgba(47,123,255,.18),rgba(47,123,255,.05));color:var(--brand2);border:1px solid var(--line2);box-shadow:0 8px 26px -14px var(--glow);margin-top:16px;gap:10px}.btn.correction:hover{transform:translateY(-2px);border-color:var(--brand);box-shadow:0 14px 32px -14px var(--glow)}.btn.correction svg{width:19px;height:19px}.installbar{display:flex;align-items:center;gap:11px;background:var(--surface);border:1px solid var(--line2);border-radius:15px;padding:11px 13px;margin-bottom:16px;box-shadow:0 8px 26px -18px var(--glow)}.installbar.hidden{display:none}.installbar .ii{width:36px;height:36px;flex:none;border-radius:11px;display:grid;place-items:center;background:linear-gradient(135deg,var(--brand2),var(--brand));color:#fff}.installbar .ii svg{width:19px;height:19px}.installbar .it{flex:1;min-width:0}.installbar .it b{display:block;font-size:13.5px}.installbar .it span{font-size:11.5px;color:var(--text3)}.installbar .go{flex:none;background:var(--brand);border:0;color:#fff;font-size:13px;font-weight:700;border-radius:11px;padding:9px 15px;cursor:pointer}.installbar .x{flex:none;background:none;border:0;color:var(--text3);font-size:20px;cursor:pointer;padding:2px 6px;line-height:1}.areq{display:flex;align-items:center;gap:11px;background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:11px 13px;margin-bottom:8px}.areq .ac{flex:1;min-width:0}.areq .ac b{font-size:14px;font-weight:700;display:block}.areq .ac span{font-size:11.5px;color:var(--text3)}.apill{flex:none;font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:4px 10px;border-radius:999px}.apill.pending{background:rgba(251,191,36,.14);color:var(--amber)}.apill.approved{background:rgba(52,211,153,.14);color:var(--emerald)}.apill.rejected{background:rgba(251,113,133,.14);color:var(--rose)}.iosSheet{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.62);display:none;align-items:flex-end}.iosSheet.on{display:flex}.iosSheet .card{width:100%;max-width:560px;margin:0 auto;background:#0b1120;border:1px solid var(--line);border-radius:22px 22px 0 0;padding:24px 20px calc(28px + env(safe-area-inset-bottom));animation:up .3s cubic-bezier(.16,1,.3,1)}.iosSheet h3{font-size:18px;margin:0 0 4px}.iosSheet .s{color:var(--text2);font-size:13.5px;margin-bottom:14px}.iosStep{display:flex;gap:12px;align-items:center;padding:11px 0;border-bottom:1px solid var(--line)}.iosStep:last-child{border-bottom:0}.iosStep .n{width:26px;height:26px;flex:none;border-radius:50%;background:var(--brand);color:#fff;font-weight:800;font-size:13px;display:grid;place-items:center}.iosStep .tx{font-size:14px}.iosStep .tx b{color:var(--brand2)}\n.err{background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.3);color:#ffb4b4;font-size:12.5px;padding:9px 12px;border-radius:11px;margin-top:14px;display:none}\n.ok{background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.3);color:#8ef0c6;font-size:12.5px;padding:9px 12px;border-radius:11px;margin-top:14px;display:none}\n.hidden{display:none}\n/* portal */\n.top{display:flex;align-items:center;gap:12px;margin-bottom:18px}\n.top .who{flex:1;min-width:0}\n.top .who b{font-size:18px;font-weight:800;letter-spacing:-.3px;display:block}\n.top .who span{font-size:12px;color:var(--text3)}\n.top .out{flex:none;background:var(--surface2);border:1px solid var(--line);color:var(--text2);border-radius:11px;height:38px;padding:0 14px;font-size:13px;font-weight:600;cursor:pointer}\n.period{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:9px 12px;margin-bottom:16px}\n.period .nav{width:34px;height:34px;flex:none;border-radius:10px;border:1px solid var(--line);background:var(--surface2);color:var(--text);font-size:17px;cursor:pointer;display:grid;place-items:center}\n.period .nav[disabled]{opacity:.35;cursor:default}\n.period .lbl{flex:1;text-align:center}.period .lbl b{display:block;font-size:14.5px;font-weight:700}.period .lbl span{font-size:11px;color:var(--text3)}\n.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}\n.tile{background:rgba(15,18,24,.55);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid var(--line);border-radius:15px;padding:13px 12px;text-align:center}\n.tile .n{font-size:23px;font-weight:800;letter-spacing:-.5px;line-height:1;font-variant-numeric:tabular-nums}\n.tile .l{font-size:10.5px;color:var(--text3);margin-top:6px;font-weight:600;letter-spacing:.02em}\n.tile.h .n{color:var(--brand2)}\n.h2{font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--text3);margin:6px 2px 10px}\n.day{background:rgba(15,18,24,.5);border:1px solid var(--line);border-radius:14px;padding:13px 15px;margin-bottom:9px}\n.day .dh{display:flex;align-items:center;gap:8px;margin-bottom:9px}\n.day .dot{width:8px;height:8px;border-radius:50%;flex:none}\n.day.day .dot{background:var(--c-day)}.day.aft .dot{background:var(--c-aft)}.day.night .dot{background:var(--c-night)}\n.day .dd{font-weight:700;font-size:14.5px}.day .dw{font-size:11.5px;color:var(--text3);margin-left:auto}\n.day .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}\n.day .cell .cl{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;font-weight:600}\n.day .cell .cv{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px}\n.day .cell .cv.em{color:var(--brand2)}\n.day .mrow{display:flex;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}\n.day .net{font-size:13px;color:var(--text2)}.day .net b{color:var(--text);font-size:15px}\n.day .fix{margin-left:auto;background:none;border:0;color:var(--brand2);font-size:12.5px;font-weight:700;cursor:pointer}\n.empty{text-align:center;color:var(--text3);padding:40px 20px}.empty b{display:block;color:var(--text2);margin-bottom:5px}\n/* mend sheet */\n.ov{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.62);display:none;align-items:flex-end}\n.ov.on{display:flex}\n.sheet{width:100%;max-width:560px;margin:0 auto;background:#0b1120;border-radius:22px 22px 0 0;border-top:1px solid var(--line);padding:22px 18px calc(24px + env(safe-area-inset-bottom));animation:up .28s cubic-bezier(.16,1,.3,1)}\n@keyframes up{from{transform:translateY(100%)}to{transform:none}}\n.sheet h3{font-size:18px;margin-bottom:4px}.sheet .sh-sub{font-size:12.5px;color:var(--text3);margin-bottom:14px}\n@media (prefers-reduced-motion:reduce){*{animation:none!important}}\n.brand .oclock{display:inline-grid;place-items:center;width:.9em;height:.9em;margin:0 .02em;vertical-align:-.09em;color:var(--text);filter:drop-shadow(0 0 5px rgba(79,140,255,.45))}\n.brand .oclock svg{width:100%;height:100%;display:block}\n.oclock .hh,.oclock .mh,.oclock .sh{transform-origin:20px 20px;transform-box:view-box}\n.oclock .hh{animation:ocSpin 43200s linear infinite}\n.oclock .mh{animation:ocSpin 3600s linear infinite}\n.oclock .sh{animation:ocSpin 60s linear infinite}\n@keyframes ocSpin{to{transform:rotate(360deg)}}\n.agb{display:flex;align-items:center;gap:6px;margin-top:5px;font-family:ui-monospace,Menlo,monospace;font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--brand2)}\n.agb i{width:5px;height:5px;border-radius:50%;background:var(--emerald);animation:agp 2.4s ease-in-out infinite}\n@keyframes agp{0%,100%{opacity:1}50%{opacity:.3}}\n.isub{font-size:13px;color:var(--text2);line-height:1.5;margin:6px 0 16px}\n.ihint{display:none;font-size:12px;color:var(--text2);line-height:1.55;margin-top:12px;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:11px;padding:10px 12px}\n.btn.later{background:rgba(255,255,255,.06);color:var(--text2);margin-top:10px}\n</style></head>\n<body>\n<div class=\"wrap\">\n  <div class=\"brand\"><img src=\"/icon.svg\" alt=\"\"/><div><b role=\"img\" aria-label=\"SaniClock\">SaniCl<span class=\"oclock\" aria-hidden=\"true\"><svg viewBox=\"0 0 40 40\"><circle cx=\"20\" cy=\"20\" r=\"16.5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"3.6\"/><g stroke=\"currentColor\" stroke-width=\"2\" opacity=\".45\"><line x1=\"20\" y1=\"6.5\" x2=\"20\" y2=\"9.5\"/><line x1=\"20\" y1=\"30.5\" x2=\"20\" y2=\"33.5\"/><line x1=\"6.5\" y1=\"20\" x2=\"9.5\" y2=\"20\"/><line x1=\"30.5\" y1=\"20\" x2=\"33.5\" y2=\"20\"/></g><line class=\"hh\" x1=\"20\" y1=\"21\" x2=\"20\" y2=\"13\" stroke=\"currentColor\" stroke-width=\"3\" stroke-linecap=\"round\"/><line class=\"mh\" x1=\"20\" y1=\"21\" x2=\"20\" y2=\"9.5\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"/><line class=\"sh\" x1=\"20\" y1=\"22.5\" x2=\"20\" y2=\"8\" stroke=\"var(--brand2)\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><circle cx=\"20\" cy=\"20\" r=\"2\" fill=\"var(--brand2)\"/></svg></span>ck</b><span>My Timesheet</span><span class=\"agb\"><i></i>Agentic OS &middot; your timesheet reconciles itself</span></div></div>\n\n  <!-- LOGIN -->\n  <div class=\"card\" id=\"loginView\">\n    <h1>Sign in</h1>\n    <div class=\"sub\">Use your work email and the password you were given.</div>\n    <form id=\"loginForm\">\n      <label for=\"em\">Email or Person ID</label>\n      <input id=\"em\" type=\"text\" autocomplete=\"username\" autocapitalize=\"off\" spellcheck=\"false\" placeholder=\"you@sanixperts.ca or Person ID\" autofocus/>\n      <label for=\"pw\">Password</label>\n      <input id=\"pw\" type=\"password\" autocomplete=\"current-password\" placeholder=\"••••••••\"/>\n      <div class=\"err\" id=\"loginErr\"></div>\n      <button class=\"btn\" id=\"loginBtn\" type=\"submit\">Sign in</button>\n    </form>\n  </div>\n\n  <!-- CHANGE PASSWORD (first login) -->\n  <div class=\"card hidden\" id=\"pwView\">\n    <h1>Set your password</h1>\n    <div class=\"sub\">Choose a new password before you continue.</div>\n    <form id=\"pwForm\">\n      <label for=\"np\">New password</label>\n      <input id=\"np\" type=\"password\" autocomplete=\"new-password\" placeholder=\"At least 6 characters\"/>\n      <label for=\"np2\">Confirm password</label>\n      <input id=\"np2\" type=\"password\" autocomplete=\"new-password\" placeholder=\"Repeat it\"/>\n      <div class=\"err\" id=\"pwErr\"></div>\n      <div class=\"ok\" id=\"pwOk\"></div>\n      <button class=\"btn\" id=\"pwBtn\" type=\"submit\">Save &amp; continue</button>\n    </form>\n  </div>\n\n  <!-- PORTAL -->\n  <div class=\"hidden\" id=\"portalView\">\n    <div class=\"top\">\n      <div class=\"who\"><b id=\"whoName\">—</b><span id=\"whoId\"></span></div>\n      <button class=\"out\" id=\"logoutBtn\">Log out</button>\n    </div>\n    <div class=\"installbar hidden\" id=\"installBar\"><span class=\"ii\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 3v11M8 10l4 4 4-4\"/><path d=\"M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2\"/></svg></span><div class=\"it\"><b>Add SaniClock to your home screen</b><span>One tap to your timesheet — no browser.</span></div><button class=\"go\" id=\"installBtn\">Add</button><button class=\"x\" id=\"installX\" aria-label=\"Dismiss\">×</button></div>\n    <div class=\"period\">\n      <button class=\"nav\" id=\"prevP\" aria-label=\"Previous period\">‹</button>\n      <div class=\"lbl\"><b id=\"pLbl\">—</b><span id=\"pRange\"></span></div>\n      <button class=\"nav\" id=\"nextP\" aria-label=\"Next period\">›</button>\n    </div>\n    <div class=\"tiles\">\n      <div class=\"tile h\"><div class=\"n\" id=\"tHours\">0</div><div class=\"l\">Total hours</div></div>\n      <div class=\"tile\"><div class=\"n\" id=\"tDays\">0</div><div class=\"l\">Days worked</div></div>\n      <div class=\"tile\"><div class=\"n\" id=\"tBreak\">0</div><div class=\"l\">Break (min)</div></div>\n    </div>\n    <div class=\"h2\">Daily attendance</div>\n    <div id=\"dayList\"></div>\n    <button class=\"btn correction\" id=\"openMend\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z\"/></svg><span>Request a punch correction</span></button>\n    <button class=\"btn correction\" id=\"openAbs\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M8 2v4M16 2v4M3 10h18\"/><rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\"/></svg><span>Request absence or leave</span></button>\n    <div class=\"h2\" id=\"absH2\" style=\"display:none;margin-top:20px\">My leave requests</div>\n    <div id=\"absList\"></div>\n  </div>\n</div>\n\n<!-- MEND SHEET -->\n<div class=\"ov\" id=\"mendOv\">\n  <div class=\"sheet\">\n    <h3>Request a correction</h3>\n    <div class=\"sh-sub\">Missed a punch? Submit it — your manager approves it before it counts.</div>\n    <label for=\"mDate\">Date</label><input id=\"mDate\" type=\"date\"/>\n    <label for=\"mTime\">Time</label><input id=\"mTime\" type=\"time\"/>\n    <label for=\"mRem\">Reason (optional)</label><input id=\"mRem\" placeholder=\"e.g. forgot to punch out\"/>\n    <div class=\"err\" id=\"mErr\"></div>\n    <div class=\"ok\" id=\"mOk\"></div>\n    <button class=\"btn\" id=\"mSubmit\">Submit for approval</button>\n    <button class=\"btn ghost\" id=\"mCancel\">Cancel</button>\n  </div>\n</div>\n\n<div class=\"ov\" id=\"absOv\">\n  <div class=\"sheet\">\n    <h3>Request absence or leave</h3>\n    <div class=\"sh-sub\">Tell us the type and dates. Your manager reviews it before it's confirmed.</div>\n    <label for=\"aType\">Type</label><select id=\"aType\"><option>Vacation</option><option>Sick</option><option>Personal</option><option>Bereavement</option><option>Unpaid</option></select>\n    <label for=\"aStart\">Start date</label><input id=\"aStart\" type=\"date\"/>\n    <label for=\"aEnd\">End date</label><input id=\"aEnd\" type=\"date\"/>\n    <label for=\"aReason\">Reason (optional)</label><input id=\"aReason\" placeholder=\"e.g. family vacation\"/>\n    <div class=\"err\" id=\"aErr\"></div>\n    <div class=\"ok\" id=\"aOk\"></div>\n    <button class=\"btn\" id=\"aSubmit\">Submit for approval</button>\n    <button class=\"btn ghost\" id=\"aCancel\">Cancel</button>\n  </div>\n</div>\n\n<div class=\"iosSheet\" id=\"iosSheet\"><div class=\"card\"><h3>Add to Home Screen</h3><div class=\"s\">Two taps and SaniClock lives on your home screen like any app.</div><div class=\"iosStep\"><span class=\"n\">1</span><div class=\"tx\">Tap the <b>Share</b> button at the bottom of Safari.</div></div><div class=\"iosStep\"><span class=\"n\">2</span><div class=\"tx\">Scroll down and tap <b>Add to Home Screen</b>.</div></div><div class=\"iosStep\"><span class=\"n\">3</span><div class=\"tx\">Tap <b>Add</b> — done.</div></div><button class=\"btn ghost\" id=\"iosClose\" style=\"margin-top:16px\">Got it</button></div></div>\n\n<script>\nvar $=function(s){return document.querySelector(s)};\nvar WD=[\"Sun\",\"Mon\",\"Tue\",\"Wed\",\"Thu\",\"Fri\",\"Sat\"],MO=[\"Jan\",\"Feb\",\"Mar\",\"Apr\",\"May\",\"Jun\",\"Jul\",\"Aug\",\"Sep\",\"Oct\",\"Nov\",\"Dec\"];\nvar ANCHOR=Date.UTC(2026,5,29); // Mon 2026-06-29, bi-weekly pay-period anchor\nvar DAYMS=864e5, PERIODMS=14*DAYMS;\nvar STATE={pid:null,name:\"\",offset:0,records:[]};\n\nfunction show(id){[\"loginView\",\"pwView\",\"portalView\"].forEach(function(v){$(\"#\"+v).classList.toggle(\"hidden\",v!==id);});}\nfunction msg(el,txt,kind){el.textContent=txt;el.style.display=txt?\"block\":\"none\";el.className=kind||\"err\";}\nfunction p2(n){return (n<10?\"0\":\"\")+n}\nfunction mdyToUTC(mdy){var p=(mdy||\"\").split(\"/\");if(p.length<3)return null;return Date.UTC(+p[2],+p[0]-1,+p[1]);}\nfunction fmtHM(min){min=Math.max(0,Math.round(min||0));return Math.floor(min/60)+\"h \"+(min%60)+\"m\";}\nfunction hms5(t){return t?String(t).slice(0,5):\"—\";}\n\n/* pay period math (bi-weekly, anchored Mon 2026-06-29) */\nfunction currentIndex(){return Math.floor((Date.now()-ANCHOR)/PERIODMS);}\nfunction periodBounds(off){var idx=currentIndex()+off;var start=ANCHOR+idx*PERIODMS;return {start:start,end:start+PERIODMS-DAYMS};}\nfunction fmtD(utc){var d=new Date(utc);return MO[d.getUTCMonth()]+\" \"+d.getUTCDate();}\nfunction catOf(shift){var s=(shift||\"\").toLowerCase();if(s.indexOf(\"night\")>-1)return\"night\";if(s.indexOf(\"aft\")>-1)return\"aft\";return\"day\";}\n\nfunction login(e){\n  e.preventDefault();var b=$(\"#loginBtn\");b.disabled=true;msg($(\"#loginErr\"),\"\");\n  fetch(\"/api/emp-login\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({email:$(\"#em\").value.trim(),pass:$(\"#pw\").value})})\n  .then(function(r){return r.json();}).then(function(j){\n    b.disabled=false;\n    if(!j.ok){msg($(\"#loginErr\"),j.error||\"Sign in failed.\");return;}\n    STATE.pid=j.pid;\n    if(j.mustChange){show(\"pwView\");}else{enterPortal();}\n  }).catch(function(){b.disabled=false;msg($(\"#loginErr\"),\"Network error. Try again.\");});\n}\nfunction changePw(e){\n  e.preventDefault();var n=$(\"#np\").value,n2=$(\"#np2\").value;msg($(\"#pwErr\"),\"\");msg($(\"#pwOk\"),\"\");\n  if(n.length<6){msg($(\"#pwErr\"),\"Password must be at least 6 characters.\");return;}\n  if(n!==n2){msg($(\"#pwErr\"),\"Passwords do not match.\");return;}\n  var b=$(\"#pwBtn\");b.disabled=true;\n  fetch(\"/api/emp-change-password\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({next:n})})\n  .then(function(r){return r.json();}).then(function(j){b.disabled=false;if(!j.ok){msg($(\"#pwErr\"),j.error||\"Could not save.\");return;}enterPortal();})\n  .catch(function(){b.disabled=false;msg($(\"#pwErr\"),\"Network error.\");});\n}\nfunction enterPortal(){show(\"portalView\");STATE.offset=0;loadPunches();loadMyAbs();}\nfunction loadPunches(){\n  fetch(\"/api/my-punches\",{cache:\"no-store\"}).then(function(r){if(r.status===401){show(\"loginView\");throw 0;}return r.json();})\n  .then(function(j){STATE.records=(j&&j.records)||[];STATE.pid=j.pid||STATE.pid;\n    var nm=(STATE.records[0]&&STATE.records[0].person)||(\"ID \"+STATE.pid);STATE.name=nm;\n    $(\"#whoName\").textContent=nm;$(\"#whoId\").textContent=\"Person ID \"+STATE.pid;renderPeriod();\n  }).catch(function(){});\n}\nfunction renderPeriod(){\n  var pb=periodBounds(STATE.offset);\n  var todayEnd=Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate());\n  var viewEnd=Math.min(pb.end,STATE.offset===0?todayEnd:pb.end);\n  $(\"#pLbl\").textContent=STATE.offset===0?\"Current pay period\":(fmtD(pb.start)+\" – \"+fmtD(pb.end));\n  $(\"#pRange\").textContent=fmtD(pb.start)+\" – \"+fmtD(pb.end)+\", \"+new Date(pb.end).getUTCFullYear();\n  $(\"#nextP\").disabled=(STATE.offset>=0);\n  var rows=STATE.records.filter(function(r){var u=mdyToUTC(r.date);return u!==null&&u>=pb.start&&u<=viewEnd;});\n  rows.sort(function(a,b){return mdyToUTC(b.date)-mdyToUTC(a.date);});\n  var totNet=0,totBreak=0,days={};\n  rows.forEach(function(r){totNet+=(r.netMin||0);totBreak+=(r.breakMin||0);if((r.netMin||0)>0)days[r.date]=1;});\n  $(\"#tHours\").textContent=fmtHM(totNet);$(\"#tDays\").textContent=Object.keys(days).length;$(\"#tBreak\").textContent=totBreak;\n  if(!rows.length){$(\"#dayList\").innerHTML='<div class=\"empty\"><b>No attendance yet</b>Your punches for this period will appear here.</div>';return;}\n  $(\"#dayList\").innerHTML=rows.map(function(r){\n    var c=catOf(r.shift||r.category);var u=mdyToUTC(r.date);var wd=WD[new Date(u).getUTCDay()];\n    return '<div class=\"day '+c+'\"><div class=\"dh\"><span class=\"dot\"></span><span class=\"dd\">'+fmtD(u)+'</span><span class=\"dw\">'+wd+' · '+esc(r.shift||r.category||\"\")+'</span></div>'+\n      '<div class=\"grid\"><div class=\"cell\"><div class=\"cl\">Punch in</div><div class=\"cv\">'+hms5(r.clockIn)+'</div></div>'+\n      '<div class=\"cell\"><div class=\"cl\">Punch out</div><div class=\"cv\">'+(r.clockOut?hms5(r.clockOut):'<span style=\"color:var(--amber)\">missing</span>')+'</div></div>'+\n      '<div class=\"cell\"><div class=\"cl\">Break</div><div class=\"cv em\">'+(r.breakMin||0)+'m</div></div></div>'+\n      '<div class=\"mrow\"><span class=\"net\">Worked <b>'+fmtHM(r.netMin)+'</b></span><button class=\"fix\" data-date=\"'+esc(r.date)+'\">Fix a punch</button></div></div>';\n  }).join(\"\");\n}\nfunction esc(s){return String(s==null?\"\":s).replace(/[&<>\"]/g,function(c){return{\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':'&quot;'}[c]})}\n\n/* mend */\nfunction openMend(prefDate){var n=new Date();$(\"#mDate\").value=(prefDate||n.toISOString().slice(0,10));$(\"#mTime\").value=n.toTimeString().slice(0,5);msg($(\"#mErr\"),\"\");msg($(\"#mOk\"),\"\");$(\"#mendOv\").classList.add(\"on\");}\nfunction submitMend(){\n  var d=$(\"#mDate\").value,t=$(\"#mTime\").value;msg($(\"#mErr\"),\"\");msg($(\"#mOk\"),\"\");\n  if(!d||!t){msg($(\"#mErr\"),\"Pick a date and time.\");return;}\n  var p=d.split(\"-\"),dateMDY=(+p[1])+\"/\"+(+p[2])+\"/\"+p[0];\n  var b=$(\"#mSubmit\");b.disabled=true;\n  fetch(\"/api/mend-punches\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({pid:STATE.pid,person:STATE.name,dateMDY:dateMDY,hms:t+\":00\",remarks:$(\"#mRem\").value.trim()})})\n  .then(function(r){return r.json();}).then(function(j){b.disabled=false;if(!j.ok){msg($(\"#mErr\"),j.error||\"Could not submit.\");return;}msg($(\"#mOk\"),\"Submitted. Your manager will review it.\",\"ok\");setTimeout(function(){$(\"#mendOv\").classList.remove(\"on\");},1400);})\n  .catch(function(){b.disabled=false;msg($(\"#mErr\"),\"Network error.\");});\n}\n\n$(\"#loginForm\").addEventListener(\"submit\",login);\n$(\"#pwForm\").addEventListener(\"submit\",changePw);\n$(\"#logoutBtn\").addEventListener(\"click\",function(){fetch(\"/api/emp-logout\",{method:\"POST\"}).then(function(){show(\"loginView\");$(\"#pw\").value=\"\";});});\n$(\"#prevP\").addEventListener(\"click\",function(){STATE.offset--;renderPeriod();});\n$(\"#nextP\").addEventListener(\"click\",function(){if(STATE.offset<0){STATE.offset++;renderPeriod();}});\n$(\"#openMend\").addEventListener(\"click\",function(){openMend(null);});\n$(\"#dayList\").addEventListener(\"click\",function(e){var b=e.target.closest(\".fix\");if(!b)return;var d=b.getAttribute(\"data-date\").split(\"/\");openMend(d[2]+\"-\"+p2(+d[0])+\"-\"+p2(+d[1]));});\n$(\"#mCancel\").addEventListener(\"click\",function(){$(\"#mendOv\").classList.remove(\"on\");});\n$(\"#mSubmit\").addEventListener(\"click\",submitMend);\n$(\"#mendOv\").addEventListener(\"click\",function(e){if(e.target.id===\"mendOv\")$(\"#mendOv\").classList.remove(\"on\");});\n\n/* absence / leave */\nfunction openAbs(){var n=new Date().toISOString().slice(0,10);$(\"#aStart\").value=n;$(\"#aEnd\").value=n;$(\"#aReason\").value=\"\";$(\"#aType\").value=\"Vacation\";msg($(\"#aErr\"),\"\");msg($(\"#aOk\"),\"\");$(\"#absOv\").classList.add(\"on\");}\nfunction submitAbs(){\n  var type=$(\"#aType\").value,st=$(\"#aStart\").value,en=$(\"#aEnd\").value;msg($(\"#aErr\"),\"\");msg($(\"#aOk\"),\"\");\n  if(!st||!en){msg($(\"#aErr\"),\"Pick a start and end date.\");return;}\n  if(en<st){msg($(\"#aErr\"),\"End date can't be before the start date.\");return;}\n  var b=$(\"#aSubmit\");b.disabled=true;\n  fetch(\"/api/my-absence-requests\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({type:type,person:STATE.name,startDate:st,endDate:en,reason:$(\"#aReason\").value.trim()})})\n  .then(function(r){return r.json();}).then(function(j){b.disabled=false;if(!j.ok){msg($(\"#aErr\"),j.error||\"Could not submit.\");return;}msg($(\"#aOk\"),\"Submitted. Your manager will review it.\",\"ok\");loadMyAbs();setTimeout(function(){$(\"#absOv\").classList.remove(\"on\");},1300);})\n  .catch(function(){b.disabled=false;msg($(\"#aErr\"),\"Network error.\");});\n}\nfunction loadMyAbs(){\n  fetch(\"/api/my-absence-requests\",{cache:\"no-store\"}).then(function(r){return r.status===200?r.json():null;}).then(function(j){\n    var items=(j&&j.items)||[];var h=$(\"#absH2\");if(h)h.style.display=items.length?\"block\":\"none\";\n    $(\"#absList\").innerHTML=items.map(function(a){\n      var dr=a.startDate===a.endDate?a.startDate:(a.startDate+\" → \"+a.endDate);\n      return '<div class=\"areq\"><div class=\"ac\"><b>'+esc(a.type)+' · '+a.days+'d</b><span>'+esc(dr)+(a.reason?' · '+esc(a.reason):\"\")+'</span></div><span class=\"apill '+a.status+'\">'+a.status+'</span></div>';\n    }).join(\"\");\n  }).catch(function(){});\n}\n$(\"#openAbs\").addEventListener(\"click\",openAbs);\n$(\"#aSubmit\").addEventListener(\"click\",submitAbs);\n$(\"#aCancel\").addEventListener(\"click\",function(){$(\"#absOv\").classList.remove(\"on\");});\n$(\"#absOv\").addEventListener(\"click\",function(e){if(e.target.id===\"absOv\")$(\"#absOv\").classList.remove(\"on\");});\n\n/* auto-enter if session already valid */\nfetch(\"/api/my-punches\",{cache:\"no-store\"}).then(function(r){return r.status===200?r.json():null;}).then(function(j){if(j&&j.ok){STATE.pid=j.pid;enterPortal();}}).catch(function(){});\nvar deferredPrompt=null;\nfunction isStandalone(){return window.matchMedia(\"(display-mode: standalone)\").matches||window.navigator.standalone===true;}\nfunction isIOS(){return /iphone|ipad|ipod/i.test(navigator.userAgent);}\nfunction maybeShowInstall(){if(isStandalone())return;if(deferredPrompt||isIOS())$(\"#installBar\").classList.remove(\"hidden\");}\nwindow.addEventListener(\"beforeinstallprompt\",function(e){e.preventDefault();deferredPrompt=e;maybeShowInstall();});\nsetTimeout(maybeShowInstall,1400);\n$(\"#installBtn\").addEventListener(\"click\",function(){if(deferredPrompt){deferredPrompt.prompt();deferredPrompt.userChoice.then(function(){deferredPrompt=null;$(\"#installBar\").classList.add(\"hidden\");});}else if(isIOS()){$(\"#iosSheet\").classList.add(\"on\");}else{$(\"#instOv\").classList.add(\"on\");$(\"#instHint\").style.display=\"block\";}});\n$(\"#installX\").addEventListener(\"click\",function(){$(\"#installBar\").classList.add(\"hidden\");});\n$(\"#iosClose\").addEventListener(\"click\",function(){$(\"#iosSheet\").classList.remove(\"on\");});\n$(\"#iosSheet\").addEventListener(\"click\",function(e){if(e.target.id===\"iosSheet\")$(\"#iosSheet\").classList.remove(\"on\");});\n(function(){\n  var oc=document.querySelector(\".brand .oclock svg\");if(!oc)return;\n  var d=new Date(),sec=d.getSeconds(),mi=d.getMinutes()+sec/60,hr=(d.getHours()%12)+mi/60;\n  var hh=oc.querySelector(\".hh\"),mh=oc.querySelector(\".mh\"),sh=oc.querySelector(\".sh\");\n  if(window.matchMedia&&window.matchMedia(\"(prefers-reduced-motion: reduce)\").matches){\n    hh.setAttribute(\"transform\",\"rotate(\"+(hr*30)+\" 20 20)\");\n    mh.setAttribute(\"transform\",\"rotate(\"+(mi*6)+\" 20 20)\");\n    sh.setAttribute(\"transform\",\"rotate(\"+(sec*6)+\" 20 20)\");\n    return;\n  }\n  hh.style.animationDelay=(-hr*3600)+\"s\";\n  mh.style.animationDelay=(-mi*60)+\"s\";\n  sh.style.animationDelay=(-sec)+\"s\";\n})();\n</script>\n<div class=\"ov\" id=\"instOv\"><div class=\"sheet\">\n  <h3>Add SaniClock to your home screen</h3>\n  <p class=\"isub\">One tap and your timesheet lives on your phone like a real app &mdash; full screen, one touch away.</p>\n  <button class=\"btn\" id=\"instGo\">Install SaniClock</button>\n  <div class=\"ihint\" id=\"instHint\">If nothing happened, open this page in <b>Chrome</b>, or tap the browser menu (&#8942;) and choose <b>&ldquo;Add to Home screen&rdquo;</b>.</div>\n  <button class=\"btn later\" id=\"instLater\">Maybe later</button>\n</div></div>\n<script>\n(function(){\n  var fromMail=location.search.indexOf(\"install=1\")>=0;\n  if(!fromMail||isStandalone())return;\n  setTimeout(function(){\n    if(isIOS()){$(\"#iosSheet\").classList.add(\"on\");}\n    else{$(\"#instOv\").classList.add(\"on\");}\n  },650);\n  $(\"#instGo\").addEventListener(\"click\",function(){\n    if(deferredPrompt){\n      deferredPrompt.prompt();\n      deferredPrompt.userChoice.then(function(){deferredPrompt=null;$(\"#instOv\").classList.remove(\"on\");$(\"#installBar\").classList.add(\"hidden\");});\n    }else{\n      $(\"#instHint\").style.display=\"block\";\n    }\n  });\n  $(\"#instLater\").addEventListener(\"click\",function(){$(\"#instOv\").classList.remove(\"on\");});\n  $(\"#instOv\").addEventListener(\"click\",function(e){if(e.target.id===\"instOv\")$(\"#instOv\").classList.remove(\"on\");});\n  window.addEventListener(\"appinstalled\",function(){$(\"#instOv\").classList.remove(\"on\");$(\"#installBar\").classList.add(\"hidden\");});\n})();\nif(\"serviceWorker\" in navigator){window.addEventListener(\"load\",function(){navigator.serviceWorker.register(\"/sw.js\").catch(function(){});});}\n</script>\n</body></html>";

function MAIL_SETUP_HTML(m){ return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Email Setup · SaniClock</title><style>
:root{--bg:#05070e;--surface:rgba(18,22,33,.66);--line:rgba(120,160,255,.14);--text:#eaf0fb;--text2:#93a1bd;--brand:#2f7bff;--brand2:#59a6ff}
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:grid;place-items:center;padding:24px;background-image:radial-gradient(800px 500px at 80% -8%,rgba(47,123,255,.16),transparent 58%)}
.card{width:min(470px,94vw);background:var(--surface);backdrop-filter:blur(22px);border:1px solid var(--line);border-radius:20px;padding:30px 28px;box-shadow:0 30px 70px -30px rgba(0,0,0,.8)}
h1{font-size:21px;font-weight:800;letter-spacing:-.3px;margin-bottom:4px}.sub{color:var(--text2);font-size:13.5px;margin-bottom:22px;line-height:1.5}
label{display:block;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text2);margin:14px 0 6px}
input{width:100%;height:46px;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:12px;color:var(--text);font-size:15px;padding:0 13px;outline:none}
input:focus{border-color:var(--brand)}
.row{display:flex;gap:10px}.row>div{flex:1}
.btn{width:100%;height:47px;margin-top:20px;border:0;border-radius:12px;font-size:15px;font-weight:700;color:#fff;background:linear-gradient(135deg,var(--brand2),var(--brand));cursor:pointer}
.btn.ghost{background:rgba(255,255,255,.06);color:var(--text2);margin-top:10px}
.btn[disabled]{opacity:.6}
.msg{margin-top:16px;padding:11px 13px;border-radius:11px;font-size:13px;line-height:1.45;display:none}
.msg.ok{background:rgba(52,211,153,.12);color:#8ef0c6;border:1px solid rgba(52,211,153,.3);display:block}
.msg.err{background:rgba(251,113,133,.1);color:#ffb4c0;border:1px solid rgba(251,113,133,.3);display:block}
.hint{color:var(--text2);font-size:12px;line-height:1.55;margin-top:16px}.hint b{color:var(--text)}
</style></head><body><div class="card">
<h1>Email setup</h1><div class="sub">Send employee invites from your own mailbox. Your password is stored locked on this server (root-only) — never shown to anyone.</div>
<label>SMTP host</label><input id="host" value="${m.host||'smtp.office365.com'}"/>
<div class="row"><div><label>Port</label><input id="port" value="${m.port||'587'}"/></div><div><label>From name</label><input id="fromName" value="${m.fromName||'SaniClock'}"/></div></div>
<label>From address (login email)</label><input id="from" type="email" value="${m.from||m.user||'Sanixpertsadmin@sanixperts.ca'}"/>
<label>App password ${m.hasPass?'(leave blank to keep saved)':''}</label><input id="pass" type="password" placeholder="${m.hasPass?'saved — leave blank to keep':'Outlook app password'}"/>
<button class="btn" id="save">Save &amp; verify connection</button>
<button class="btn ghost" id="test">Send test email to myself</button>
<div class="msg" id="msg"></div>
<div class="hint"><b>Outlook / Microsoft 365:</b> host <b>smtp.office365.com</b>, port <b>587</b>. If 2-factor is on, create an <b>app password</b> at aka.ms/apppassword instead of your normal password. If Microsoft has SMTP disabled on the account, switch to a free Gmail here: host <b>smtp.gmail.com</b>, port <b>465</b>.</div>
</div><script>
var $=function(s){return document.querySelector(s)};
function cfg(){return {host:$("#host").value.trim(),port:$("#port").value.trim(),from:$("#from").value.trim(),user:$("#from").value.trim(),fromName:$("#fromName").value.trim(),secure:$("#port").value.trim()==="465",pass:$("#pass").value};}
function msg(t,ok){var m=$("#msg");m.textContent=t;m.className="msg "+(ok?"ok":"err");}
$("#save").addEventListener("click",function(){var b=this;b.disabled=true;msg("Saving and testing the connection…",true);fetch("/api/mail/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(cfg())}).then(function(r){return r.json();}).then(function(j){b.disabled=false;if(j.ok)msg("Connected — SMTP works. You can send invites now.",true);else msg("Could not connect: "+(j.error||"failed")+". If this is Outlook, SMTP may be disabled on the account — try a Gmail instead.",false);}).catch(function(){b.disabled=false;msg("Network error.",false);});});
$("#test").addEventListener("click",function(){var b=this;b.disabled=true;msg("Sending a test email…",true);fetch("/api/mail/test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({to:$("#from").value.trim()})}).then(function(r){return r.json();}).then(function(j){b.disabled=false;if(j.ok)msg("Test sent to "+j.to+" — check your inbox (and spam).",true);else msg("Send failed: "+(j.error||"failed"),false);}).catch(function(){b.disabled=false;msg("Network error.",false);});});
</script></body></html>`; }

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  // ---- Auth gate: everything except the login surface requires a session ----
  const PUBLIC_ROUTES = new Set(['/login', '/api/login', '/api/logout', '/favicon.ico', '/manifest.webmanifest', '/sw.js', '/icon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/login-bg.jpg', '/stage-bg.jpg', '/stage-bg.png', '/brand-badge.png', '/brand-flame.png', '/brand-white.png', '/brand-mark.png', '/api/emp-login', '/api/emp-logout', '/api/my-punches', '/api/my-absence-requests', '/api/emp-change-password', '/me', '/manifest-me.webmanifest']);
  if (!PUBLIC_ROUTES.has(url) && !isAuthed(req)) {
    if (url.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'authentication required' }));
    } else {
      res.writeHead(302, { Location: '/login' + (req.method === 'GET' && url && url !== '/' ? '?next=' + encodeURIComponent(url) : '') });
      res.end();
    }
    return;
  }

  if (url === '/me' || url === '/me/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(ME_HTML); return; }
  if (url === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(LOGIN_HTML);
    return;
  }
  if (url === '/login-bg.jpg' || url === '/stage-bg.jpg' || url === '/stage-bg.png') {
    try { const buf = fs.readFileSync(path.join(__dirname, 'data', url.slice(1))); res.writeHead(200, { 'Content-Type': url.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'public, max-age=604800' }); res.end(buf); }
    catch (e) { res.writeHead(404); res.end(); }
    return;
  }
  if (url === '/brand-badge.png' || url === '/brand-flame.png' || url === '/brand-white.png' || url === '/brand-mark.png') {
    try { const buf = fs.readFileSync(path.join(__dirname, 'data', url.slice(1))); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' }); res.end(buf); }
    catch (e) { res.writeHead(404); res.end(); }
    return;
  }
  if (url === '/icon-180.png' || url === '/icon-192.png' || url === '/icon-512.png' || url === '/icon-maskable-512.png') {
    try { const buf = fs.readFileSync(path.join(__dirname, 'data', url.slice(1))); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' }); res.end(buf); }
    catch (e) { res.writeHead(404); res.end(); }
    return;
  }
  if (url === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=300' });
    res.end(SANICLOCK_ICON_SVG);
    return;
  }
  if (url === '/m' || url === '/m/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(MOBILE_HTML);
    return;
  }
  if (url === '/manifest-me.webmanifest') { res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' }); res.end(SANICLOCK_ME_MANIFEST); return; }
  if (url === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' });
    res.end(SANICLOCK_MANIFEST);
    return;
  }
  if (url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' });
    res.end(SANICLOCK_SW);
    return;
  }
  if (url === '/api/login' && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      const user = String((body && body.user) || '').trim();
      const pass = String((body && body.pass) || '');
      if (user.toLowerCase() === String(AUTH.user).toLowerCase() && verifyPassword(pass)) {
        const token = signSession();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `sc_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
        });
        res.end(JSON.stringify({ ok: true, mustChange: !!AUTH.seededDefault }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid username or password.' }));
      }
    }).catch(() => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'bad request' })); });
    return;
  }
  if (url === '/api/logout') {
    res.writeHead(302, { 'Set-Cookie': 'sc_session=; HttpOnly; Path=/; Max-Age=0', Location: '/login' });
    res.end();
    return;
  }
  // ---- Employee self-service auth (scoped to own pid) ----
  if (url === '/api/emp-login' && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      const email = String((body && body.email) || '').trim();
      const pass = String((body && body.pass) || '');
      let acc = empAuth.verify(email, pass);
      if (!acc) { try { const byP = empAuth.byPid(String(email).trim().toUpperCase()); if (byP && byP.email) acc = empAuth.verify(byP.email, pass); } catch (_e) {} }
      if (!acc) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid login or password.' })); return; }
      const token = empAuth.signSession(acc.pid);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'esid=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + (12 * 3600) });
      res.end(JSON.stringify({ ok: true, pid: acc.pid, mustChange: acc.mustChange }));
    }).catch(() => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'bad request' })); });
    return;
  }
  if (url === '/api/emp-logout' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'esid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url === '/api/my-punches' && req.method === 'GET') {
    const emp = empAuth.verifySession(parseCookies(req).esid);
    if (!emp) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not logged in' })); return; }
    const d = buildPayload();
    const same = (a) => String(a).toUpperCase() === String(emp.pid).toUpperCase();
    const records = (d.records || []).filter((r) => same(r.pid));
    const weeks = (d.weeks || []).filter((w) => same(w.pid));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, pid: emp.pid, records: records, weeks: weeks }));
    return;
  }
  if (url === '/api/emp-change-password' && req.method === 'POST') {
    const emp = empAuth.verifySession(parseCookies(req).esid);
    if (!emp) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not logged in' })); return; }
    readJsonBody(req).then((body) => {
      const next = String((body && body.next) || '');
      if (next.length < 6) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Password must be at least 6 characters.' })); return; }
      empAuth.changePassword(emp.pid, next);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    }).catch(() => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'bad request' })); });
    return;
  }
  if (url === '/api/change-password' && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      const cur = String((body && body.current) || ''); const next = String((body && body.next) || '');
      if (!verifyPassword(cur)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Current password is incorrect.' })); return; }
      if (next.length < 8) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'New password must be at least 8 characters.' })); return; }
      changePassword(next);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    }).catch(() => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'bad request' })); });
    return;
  }

  if (url === '/api/punches') {
    const d = buildPayload();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: d.ok, records: d.records, dates: d.dates, count: d.count || 0, weeks: d.weeks || [], csvPath: d.csvPath || null, error: d.error || null }));
    return;
  }

  // ---- Mend Punch: manual correction workflow (Add -> pending -> Approve/Reject) ----
  if (url === '/api/mend-punches' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, items: loadMendPunches() }));
    return;
  }
  if (url === '/api/mend-punches' && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      const pid = String((body && body.pid) || '').trim();
      const person = String((body && body.person) || '').trim();
      const dateMDY = String((body && body.dateMDY) || '').trim();
      const hms = String((body && body.hms) || '').trim();
      const remarks = String((body && body.remarks) || '').trim();
      if (!pid || !dateMDY || !hms || !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateMDY) || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(hms)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'pid, dateMDY (M/D/YYYY), and hms (H:MM) are required.' }));
        return;
      }
      const rec = { id: newMendId(), pid, person: person || pid, dateMDY, hms, remarks, status: 'pending', createdAt: new Date().toISOString(), decidedAt: null };
      const list = loadMendPunches();
      list.unshift(rec);
      saveMendPunches(list);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, item: rec }));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message || 'bad request body' }));
    });
    return;
  }
  if ((url === '/api/mend-punches/approve' || url === '/api/mend-punches/reject') && req.method === 'POST') {
    const approving = url === '/api/mend-punches/approve';
    readJsonBody(req).then((body) => {
      const id = String((body && body.id) || '');
      const list = loadMendPunches();
      const rec = list.find((r) => r.id === id);
      if (!rec) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'no mend-punch with that id' }));
        return;
      }
      if (rec.status !== 'pending') {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'already ' + rec.status + ' — decisions are final, delete and re-add instead' }));
        return;
      }
      rec.status = approving ? 'approved' : 'rejected';
      rec.decidedAt = new Date().toISOString();
      if (approving) appendApprovedPunchToCsv(rec);
      saveMendPunches(list);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, item: rec }));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message || 'bad request body' }));
    });
    return;
  }
  if (url === '/api/mend-punches' && req.method === 'DELETE') {
    const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
    const id = qs.get('id') || '';
    const list = loadMendPunches();
    const rec = list.find((r) => r.id === id);
    if (!rec) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'no mend-punch with that id' }));
      return;
    }
    if (rec.status !== 'pending') {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'only pending (undecided) entries can be deleted — approved/rejected are a permanent audit trail' }));
      return;
    }
    saveMendPunches(list.filter((r) => r.id !== id));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url === '/api/payroll.csv') {
    // Streams the payroll CSV as a downloadable attachment.
    // GET /api/payroll.csv?start=MM/DD/YYYY&end=MM/DD/YYYY  (YYYY-MM-DD also OK).
    // No params => full dataset span. Clamp is on WeekBucket.weekStart (ISO).
    const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
    const startISO = normalizeToISO(qs.get('start'));
    const endISO = normalizeToISO(qs.get('end'));
    const d = loadData();
    const enriched = timeEngine.enrichAll(d.records || []);
    const opts = {};
    if (startISO) opts.periodStart = startISO;
    if (endISO) opts.periodEnd = endISO;
    const summary = payroll.periodSummary(enriched, opts);
    const csv = payroll.toCsv(summary);
    const fname = 'payroll_' + (startISO || 'all') + '_' + (endISO || 'all') + '.csv';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + fname + '"',
      'Cache-Control': 'no-store',
    });
    res.end(csv);
    return;
  }
  if (url === '/api/raw-punches') {
    // Mirrors NGTeco's "View Attendance Punch" — the un-paired raw punch
    // stream, one row per physical scan. Same parser/source as pairing-audit.
    const rawPath = resolveRawPunchCsv();
    if (!rawPath) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'No raw punch CSV found. Set RAW_PUNCH_CSV.', events: [] }));
      return;
    }
    let rawText;
    try { rawText = fs.readFileSync(rawPath, 'utf8'); }
    catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: String(e), events: [] }));
      return;
    }
    const parsed = punchPair.parseRawPunchCsv(rawText);
    const events = (parsed.events || []).slice().sort((a, b) => b.absMin - a.absMin);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: parsed.ok, error: parsed.ok ? null : parsed.error, rawPath, events }));
    return;
  }

  if (url === '/api/pairing-audit') {
    // Our schedule-free pairing (raw punch stream) vs NGTeco's paired timecard.
    // GET /api/pairing-audit?start=YYYY-MM-DD&end=YYYY-MM-DD (optional clamp;
    // default = the complete-day overlap of both sources, dropping each
    // source's final possibly-in-progress day).
    const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
    const rawPath = resolveRawPunchCsv();
    if (!rawPath) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'No raw punch CSV found. Set RAW_PUNCH_CSV, or place the "View Attendance Punch" export (Person ID,Person Name,Punch Date,Attendance record,...) in Downloads.' }));
      return;
    }
    let rawText;
    try { rawText = fs.readFileSync(rawPath, 'utf8'); }
    catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
      return;
    }
    const parsed = punchPair.parseRawPunchCsv(rawText);
    if (!parsed.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: parsed.error, rawPath }));
      return;
    }
    const d = loadData();
    const ngRecords = d.records || [];
    const shiftByPid = {};
    for (const r of ngRecords) if (r.pid && r.shift && !shiftByPid[r.pid]) shiftByPid[r.pid] = r.shift;
    const ours = punchPair.pairEvents(parsed.events, { shiftByPid });

    // default window: complete-day overlap (drop each source's last day)
    let startISO = normalizeToISO(qs.get('start'));
    let endISO = normalizeToISO(qs.get('end'));
    if (!startISO || !endISO) {
      const ourDis = parsed.events.map(e => punchPair.mdyToDayIndex(e.dateMDY)).filter(x => x !== null);
      const ngDis = ngRecords.filter(r => r.clockIn).map(r => punchPair.mdyToDayIndex(r.date)).filter(x => x !== null);
      if (ourDis.length && ngDis.length) {
        const s = Math.max(Math.min(...ourDis), Math.min(...ngDis));
        const e = Math.min(Math.max(...ourDis) - 1, Math.max(...ngDis) - 1);
        if (!startISO) startISO = paysheet.dayIndexToISO(s);
        if (!endISO && e >= s) endISO = paysheet.dayIndexToISO(e);
      }
    }
    const audit = punchPair.pairingAudit(ours, ngRecords, { startISO, endISO });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rawPath, events: parsed.events.length,
      summary: audit.summary, items: audit.items }));
    return;
  }
  if (url === '/api/paysheet.xls') {
    // Bi-weekly employer attendance sheet (Excel), replicating the manual workbook
    // and the Process_Timecard v6.5.5 business rules.
    // GET /api/paysheet.xls?start=YYYY-MM-DD (any date inside the desired period;
    // MM/DD/YYYY also OK). No param => period containing the latest data date.
    // Rules come from paysheet-rules.json (read fresh on every request, so edits
    // apply without a restart); falls back to the built-in v6.5.5 defaults.
    const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
    const startISO = normalizeToISO(qs.get('start'));
    let rules = null;
    try {
      rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'paysheet-rules.json'), 'utf8'));
    } catch (_) { /* missing or malformed -> DEFAULT_RULES */ }
    const d = loadData();
    const enriched = timeEngine.enrichAll(d.records || []);
    const model = paysheet.buildModel(enriched, startISO || null, rules);
    const xml = paysheet.toWorkbookXml(model);
    const fname = paysheet.workbookFilename(model);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.ms-excel',
      'Content-Disposition': 'attachment; filename="' + fname + '"',
      'Cache-Control': 'no-store',
    });
    res.end(xml);
    return;
  }
  // ---- Absence / Leave requests (employee submit -> pending -> admin approve/reject) ----
  if (url === '/api/my-absence-requests' && req.method === 'GET') {
    const emp = empAuth.verifySession(parseCookies(req).esid);
    if (!emp) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not logged in' })); return; }
    const mine = loadAbsences().filter((a) => String(a.pid).toUpperCase() === String(emp.pid).toUpperCase());
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, items: mine })); return;
  }
  if (url === '/api/my-absence-requests' && req.method === 'POST') {
    const emp = empAuth.verifySession(parseCookies(req).esid);
    if (!emp) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not logged in' })); return; }
    readJsonBody(req).then((body) => {
      const type = String((body && body.type) || '').trim();
      const person = String((body && body.person) || '').trim();
      const startDate = String((body && body.startDate) || '').trim();
      const endDate = String((body && body.endDate) || startDate).trim();
      const reason = String((body && body.reason) || '').trim();
      const ALLOWED = ['Vacation', 'Sick', 'Personal', 'Bereavement', 'Unpaid'];
      const dre = /^\d{4}-\d{2}-\d{2}$/;
      if (!ALLOWED.includes(type) || !dre.test(startDate) || !dre.test(endDate) || endDate < startDate) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'A valid type and start/end date are required.' })); return;
      }
      const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1;
      const rec = { id: newMendId(), pid: emp.pid, person: person || String(emp.pid), type, startDate, endDate, days, reason, status: 'pending', createdAt: new Date().toISOString(), decidedAt: null };
      const list = loadAbsences(); list.unshift(rec); saveAbsences(list);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, item: rec }));
    }).catch((err) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: err.message || 'bad request' })); });
    return;
  }
  if (url === '/api/absence-requests' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, items: loadAbsences() })); return;
  }
  if ((url === '/api/absence-requests/approve' || url === '/api/absence-requests/reject') && req.method === 'POST') {
    const approving = url.endsWith('/approve');
    readJsonBody(req).then((body) => {
      const id = String((body && body.id) || ''); const list = loadAbsences(); const rec = list.find((r) => r.id === id);
      if (!rec) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'no request with that id' })); return; }
      if (rec.status !== 'pending') { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'already ' + rec.status })); return; }
      rec.status = approving ? 'approved' : 'rejected'; rec.decidedAt = new Date().toISOString(); saveAbsences(list);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, item: rec }));
    }).catch((err) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: err.message || 'bad request' })); });
    return;
  }
  if (url === '/api/absence-requests' && req.method === 'DELETE') {
    const qs = new URLSearchParams((req.url || '').split('?')[1] || ''); const id = qs.get('id') || '';
    const list = loadAbsences(); const rec = list.find((r) => r.id === id);
    if (!rec) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'no request' })); return; }
    saveAbsences(list.filter((r) => r.id !== id));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return;
  }

  // ---- Group Management: employees CRUD ----
  if (url === '/api/employees' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, items: employeeStore.load() }));
    return;
  }
  if (url === '/api/employees/fp-set' && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      const id = String((body && body.id) || '');
      const list = employeeStore.load();
      const i = list.findIndex((e) => e.id === id);
      if (i < 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not found.' })); return; }
      if (typeof body.finger === 'string') list[i].fpFinger = body.finger;
      if (typeof body.enrolled === 'boolean') list[i].fpEnrolled = body.enrolled;
      if (typeof body.status === 'string') list[i].fpStatus = body.status;
      list[i].fpUpdatedAt = new Date().toISOString();
      employeeStore.save(list);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, item: list[i] }));
    }).catch((e) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (url === '/api/employees/fp' && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      const id = String((body && body.id) || '');
      const list = employeeStore.load();
      const i = list.findIndex((e) => e.id === id);
      if (i < 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not found.' })); return; }
      list[i].fpEnrolled = !list[i].fpEnrolled;
      list[i].fpUpdatedAt = new Date().toISOString();
      employeeStore.save(list);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, item: list[i] }));
    }).catch((e) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (url === '/api/employees' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      const pid = String((body && body.pid) || '').trim().toUpperCase();
      const person = String((body && body.person) || '').trim();
      if (!pid || !person) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Employee ID and name are required.' })); return; }
      const list = employeeStore.load();
      const editingId = body.id ? String(body.id) : null;
      if (!editingId && list.some((e) => e.pid.toLowerCase() === pid.toLowerCase())) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'An employee with that ID already exists.' })); return;
      }
      const fields = { pid, person, department: String((body && body.department) || '').trim(), shift: String((body && body.shift) || '').trim(), email: String((body && body.email) || '').trim(), role: String((body && body.role) || 'Normal user').trim() };
      let rec;
      if (editingId) {
        const i = list.findIndex((e) => e.id === editingId);
        if (i < 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not found.' })); return; }
        rec = Object.assign(list[i], fields, { updatedAt: new Date().toISOString() }); list[i] = rec;
      } else {
        rec = Object.assign({ id: newId('emp'), createdAt: new Date().toISOString() }, fields); list.unshift(rec);
      }
      employeeStore.save(list);
      let ngteco_push = null;
      try {
        const _tok = await ngteco.scopedToken();
        if (!editingId) {
          const _r = await ngteco.pushEmployee(_tok, rec); ngteco_push = _r.ok ? 'pushed' : (_r.exists ? 'exists' : ('failed: ' + _r.message));
        } else {
          const _emps = await ngteco.listEmployees(_tok);
          const _p = _emps.find((e) => String(e.code).toUpperCase() === String(rec.pid).toUpperCase());
          if (!_p) { const _r = await ngteco.pushEmployee(_tok, rec); ngteco_push = _r.ok ? 'created' : ('failed: ' + _r.message); }
          else if (((_p.fp || 0) + (_p.face || 0) + (_p.card || 0)) > 0) { ngteco_push = 'kept-enrolled'; }
          else { await ngteco.deleteEmployee(_tok, _p.id); const _r = await ngteco.pushEmployee(_tok, rec); ngteco_push = _r.ok ? 'renamed' : ('failed: ' + _r.message); }
        }
      } catch (_e) { ngteco_push = "failed: " + _e.message; console.error("[emp-push-error] pid=" + rec.pid + " person=" + rec.person + " -> " + _e.stack); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); let tempPassword = null; let mailed = false; if (!editingId && rec.email) { try { tempPassword = empAuth.genPassword(); empAuth.setCredential(rec.pid, rec.email, tempPassword); } catch (_e) {} try { if (tempPassword && mailer.configured()) { const _link = 'https://saniclock.anubhavflow.com/me?install=1'; await mailer.send(rec.email, 'Your SaniClock timesheet login', mailer.inviteHtml(rec.person, rec.email, tempPassword, _link), mailer.inviteText(rec.person, rec.email, tempPassword, _link)); mailed = true; } } catch (_e) { console.error('[emp-invite-mail] ' + rec.pid + ' -> ' + _e.message); } } res.end(JSON.stringify({ ok: true, item: rec, ngteco: ngteco_push, tempPassword: tempPassword, mailed: mailed }));
    }).catch((e) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (url === '/api/employees' && req.method === 'DELETE') {
    (async () => {
      const id = new URLSearchParams((req.url || '').split('?')[1] || '').get('id');
      const list = employeeStore.load();
      const rec = list.find((e) => e.id === id);
      let ngteco_del = null;
      if (rec && rec.pid) {
        try {
          const _tok = await ngteco.scopedToken();
          const _emps = await ngteco.listEmployees(_tok);
          const _p = _emps.find((e) => String(e.code).toUpperCase() === String(rec.pid).toUpperCase());
          if (_p) { const _r = await ngteco.deleteEmployee(_tok, _p.id); ngteco_del = _r.ok ? 'removed' : ('failed: ' + _r.message); } else { ngteco_del = 'not-in-ngteco'; }
        } catch (_e) { ngteco_del = 'failed: ' + _e.message; }
      }
      if (rec && rec.pid) { try { empAuth.removeCredential(rec.pid); } catch (_x) {} } employeeStore.save(list.filter((e) => e.id !== id));
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, ngteco: ngteco_del }));
    })().catch((_e) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: _e.message })); });
    return;
  }

  // ---- Email invites (SMTP; configure at /connect/mail) ----
  if (url === '/connect/mail' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(MAIL_SETUP_HTML(mailer.meta()));
    return;
  }
  if (url === '/api/mail/save' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      try {
        mailer.saveConfig({ host: body.host, port: body.port, secure: !!body.secure, user: body.user, from: body.from || body.user, fromName: body.fromName || 'SaniClock', pass: body.pass });
        await mailer.verify();
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: (e && e.message) || 'connection failed' })); }
    }).catch((e) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (url === '/api/mail/test' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      try { const to = String((body && body.to) || mailer.meta().from || '').trim(); if (!to) throw new Error('no recipient'); await mailer.send(to, 'SaniClock test email', '<p style="font-family:sans-serif">This is a test from <b>SaniClock</b>. If you can read this, email sending works.</p>', 'This is a test from SaniClock. Email sending works.'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, to })); }
      catch (e) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: (e && e.message) || 'send failed' })); }
    }).catch((e) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (url === '/api/mail/invite' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      try {
        if (!mailer.configured()) throw new Error('Email is not set up yet — open /connect/mail first.');
        const pid = String((body && body.pid) || '').trim().toUpperCase();
        const rec = employeeStore.load().find((e) => String(e.pid).toUpperCase() === pid);
        if (!rec) throw new Error('Employee not found.');
        if (!rec.email) throw new Error('This employee has no email on file — add one first.');
        const pass = empAuth.genPassword();
        empAuth.setCredential(rec.pid, rec.email, pass);
        const link = 'https://saniclock.anubhavflow.com/me?install=1';
        await mailer.send(rec.email, 'Your SaniClock timesheet login', mailer.inviteHtml(rec.person, rec.email, pass, link), mailer.inviteText(rec.person, rec.email, pass, link));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, sentTo: rec.email }));
      } catch (e) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: (e && e.message) || 'invite failed' })); }
    }).catch((e) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (url === '/api/report/email' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      try {
        if (!mailer.configured()) throw new Error('Email is not set up yet — open /connect/mail first.');
        const to = String((body && body.to) || '').trim();
        if (!to) throw new Error('Recipient email is required.');
        const startISO = normalizeToISO(body && body.start);
        const endISO = normalizeToISO(body && body.end);
        const d = loadData();
        const enriched = timeEngine.enrichAll(d.records || []);
        const opts = {};
        if (startISO) opts.periodStart = startISO;
        if (endISO) opts.periodEnd = endISO;
        const summary = payroll.periodSummary(enriched, opts);
        const employees = employeeStore.load();
        const deptByPid = new Map(employees.map((e) => [String(e.pid).toUpperCase(), e.department || 'Unassigned']));
        const rosterCountByDept = new Map();
        for (const e of employees) { const dep = e.department || 'Unassigned'; rosterCountByDept.set(dep, (rosterCountByDept.get(dep) || 0) + 1); }

        const rowsByDept = new Map();
        for (const pid in summary.byEmployee) {
          const e = summary.byEmployee[pid];
          const dep = deptByPid.get(String(pid).toUpperCase()) || 'Unassigned';
          if (!rowsByDept.has(dep)) rowsByDept.set(dep, []);
          rowsByDept.get(dep).push({ pid: e.pid, person: e.person, regularMin: e.regularMin, overtimeMin: e.overtimeMin, totalNetMin: e.totalNetMin });
        }

        const periodDates = enriched.filter((r) => r.workDate && (!startISO || r.workDate >= startISO) && (!endISO || r.workDate <= endISO));
        const spanStart = startISO || (periodDates.length ? periodDates.reduce((a, r) => (r.workDate < a ? r.workDate : a), periodDates[0].workDate) : new Date().toISOString().slice(0, 10));
        const spanEnd = endISO || (periodDates.length ? periodDates.reduce((a, r) => (r.workDate > a ? r.workDate : a), periodDates[0].workDate) : spanStart);

        const deptRows = [];
        const attachments = [];
        let totEmployees = 0, totWorked = 0, totMin = 0;
        for (const [dep, rows] of rowsByDept) {
          rows.sort((a, b) => String(a.person).localeCompare(String(b.person)));
          const worked = rows.filter((r) => r.totalNetMin > 0).length;
          const totalMin = rows.reduce((s2, r) => s2 + (r.totalNetMin || 0), 0);
          const rosterCount = rosterCountByDept.get(dep) || rows.length;
          deptRows.push({ name: dep, employees: rosterCount, worked, totalMin });
          totEmployees += rosterCount; totWorked += worked; totMin += totalMin;
          const xml = reportMailer.buildDeptWorkbookXml(dep, spanStart, spanEnd, rows);
          const fname = reportMailer.workbookFilename(dep, spanStart, spanEnd);
          attachments.push({ filename: fname, content: xml, contentType: 'application/vnd.ms-excel' });
        }
        deptRows.sort((a, b) => b.employees - a.employees);

        const facilityName = (settingsStore.load().facilityName) || 'SaniClock';
        const punchViewerHtml = reportMailer.buildPunchCardHtml(spanStart, spanEnd, facilityName, periodDates);
        const viewerFilename = 'SaniClock_Punch_Card_' + spanStart + '_' + spanEnd + '.html';
        attachments.push({ filename: viewerFilename, content: punchViewerHtml, contentType: 'text/html' });

        const emailAttachList = attachments.map((a) => ({ name: a.filename, color: a.contentType === 'text/html' ? '#2f9e5c' : '#2a4568' }));
        const { html, text } = reportMailer.buildReportEmailHtml({
          facilityName, periodStartISO: spanStart, periodEndISO: spanEnd,
          deptRows, totals: { employees: totEmployees, worked: totWorked, totalMin: totMin },
          attachments: emailAttachList,
        });

        await mailer.send(to, facilityName + ' Payroll — Employee Hours (' + spanStart + ' to ' + spanEnd + ')', html, text, attachments);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, sentTo: to, employees: totEmployees, totalHours: Math.round(totMin / 6) / 10 }));
      } catch (e) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: (e && e.message) || 'report email failed' })); }
    }).catch((e) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  // ---- NGTeco cloud bridge: push employees / enroll fingerprint / real enrolled status ----
  if (url === '/api/ngteco/status' && req.method === 'GET') {
    (async () => {
      const tok = await ngteco.scopedToken();
      const dev = await ngteco.getDeviceInternalId(tok);
      const emps = await ngteco.listEmployees(tok);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, device: dev, total: emps.length, enrolled: emps.filter((e) => e.fp > 0).length }));
    })().catch((e) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (url === '/api/ngteco/sync-enrolled' && req.method === 'POST') {
    (async () => {
      const tok = await ngteco.scopedToken();
      const emps = await ngteco.listEmployees(tok);
      const byCode = {}; emps.forEach((e) => { byCode[String(e.code).toUpperCase()] = e; });
      const list = employeeStore.load(); let updated = 0;
      list.forEach((rec) => { const ng = byCode[String(rec.pid).toUpperCase()]; if (ng) { const en = ng.fp > 0; if (rec.fpEnrolled !== en) { rec.fpEnrolled = en; rec.fpUpdatedAt = new Date().toISOString(); updated++; } rec.ngFpCount = ng.fp; } });
      employeeStore.save(list);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, synced: emps.length, updated, enrolled: emps.filter((e) => e.fp > 0).length }));
    })().catch((e) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (url === '/api/ngteco/push-all' && req.method === 'POST') {
    (async () => {
      const tok = await ngteco.scopedToken();
      const existing = await ngteco.listEmployees(tok); const have = {}; existing.forEach((e) => { have[String(e.code).toUpperCase()] = 1; });
      const list = employeeStore.load(); let created = 0, skipped = 0, failed = 0; const errors = [];
      for (const rec of list) {
        if (have[String(rec.pid).toUpperCase()]) { skipped++; continue; }
        try { const r = await ngteco.pushEmployee(tok, rec); if (r.ok) created++; else if (r.exists) skipped++; else { failed++; errors.push(rec.pid + ':' + r.message); } }
        catch (e) { failed++; errors.push(rec.pid + ':' + e.message); }
        await new Promise((rr) => setTimeout(rr, 120));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, created, skipped, failed, errors: errors.slice(0, 10) }));
    })().catch((e) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (url === '/api/ngteco/enroll' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      const pid = String((body && body.pid) || '').trim();
      const fid = body && body.fid != null ? body.fid : 4;
      if (!pid) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'pid required' })); return; }
      const tok = await ngteco.scopedToken();
      const dev = await ngteco.getDeviceInternalId(tok);
      if (!dev) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'No device online' })); return; }
      const emps = await ngteco.listEmployees(tok);
      const person = emps.find((e) => String(e.code).toUpperCase() === String(pid).toUpperCase());
      if (!person) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Employee ' + pid + ' not synced to the device yet' })); return; }
      const r = await ngteco.enrollFingerprint(tok, dev.internalId, person.code, person.id, fid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: r.ok, message: r.ok ? ('Device ' + dev.sn + ' is waiting for a finger press for ' + person.name) : r.message }));
    }).catch((e) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }

  // ---- Device Management: devices CRUD ----
  if (url === '/api/devices' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, items: deviceStore.load() }));
    return;
  }
  if (url === '/api/devices' && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      const sn = String((body && body.sn) || '').trim();
      const alias = String((body && body.alias) || '').trim();
      if (!sn) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Serial number is required.' })); return; }
      const list = deviceStore.load();
      const editingId = body.id ? String(body.id) : null;
      if (!editingId && list.some((d) => d.sn.toLowerCase() === sn.toLowerCase())) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'A device with that serial already exists.' })); return;
      }
      const fields = { sn, alias: alias || sn, model: String((body && body.model) || '').trim(), ip: String((body && body.ip) || '').trim(), site: String((body && body.site) || '').trim(), status: String((body && body.status) || 'Not connected').trim() };
      let rec;
      if (editingId) {
        const i = list.findIndex((d) => d.id === editingId);
        if (i < 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not found.' })); return; }
        rec = Object.assign(list[i], fields, { updatedAt: new Date().toISOString() }); list[i] = rec;
      } else {
        rec = Object.assign({ id: newId('dev'), createdAt: new Date().toISOString() }, fields); list.unshift(rec);
      }
      deviceStore.save(list);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, item: rec }));
    }).catch((e) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (url === '/api/devices' && req.method === 'DELETE') {
    const id = new URLSearchParams((req.url || '').split('?')[1] || '').get('id');
    const list = deviceStore.load().filter((d) => d.id !== id);
    deviceStore.save(list);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---- Settings ----
  if (url === '/api/settings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, settings: settingsStore.load() }));
    return;
  }
  if (url === '/api/settings' && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      const cur = settingsStore.load();
      const next = Object.assign({}, cur, {
        facilityName: String((body && body.facilityName) || cur.facilityName || '').trim(),
        timezone: String((body && body.timezone) || cur.timezone || '').trim(),
        payPeriod: String((body && body.payPeriod) || cur.payPeriod || '').trim(),
        weekStart: String((body && body.weekStart) || cur.weekStart || '').trim(),
        otThresholdWeekly: Number((body && body.otThresholdWeekly) || cur.otThresholdWeekly || 44),
        breakMinutes: Number((body && body.breakMinutes) || cur.breakMinutes || 30),
        updatedAt: new Date().toISOString(),
      });
      settingsStore.save(next);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, settings: next }));
    }).catch((e) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }

  if (url === '/health') {
    const d = loadData();
    res.writeHead(d.ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: d.ok ? 'ok' : 'degraded', records: d.count || 0, dates: (d.dates || []).length, csv: d.csvPath || null, port: PORT }));
    return;
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page());
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  const d = loadData();
  console.log(`Punch · Command Center (FINAL) on http://localhost:${PORT}`);
  console.log(d.ok
    ? `Loaded ${d.count} records across ${d.dates.length} days from ${d.csvPath}`
    : `WARNING: ${d.error} (looked in: ${(d.candidates || CSV_CANDIDATES).join(' | ')})`);
});
