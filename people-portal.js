'use strict';
/**
 * ferrero-enroll.js — standalone Ferrero (TC7) enrollment portal.
 * Isolated from scale.js. Serves at /ferrero (nginx -> 127.0.0.1:8400).
 * Simple shared-password login (FERRERO_PASS env). Talks to NGTeco live via
 * lib/ngteco-api.js (shared .ngteco.env credentials). Scopes strictly to the
 * Ferrero department + the TC7 device.
 */
const http = require('http');
const crypto = require('crypto');
const https = require('https');
const ngteco = require('/opt/saniclock/lib/ngteco-api.js');
let empAuth = null, mailer = null;
try { empAuth = require('/opt/saniclock/lib/emp-auth.js'); } catch (e) {}
try { mailer = require('/opt/saniclock/lib/mailer.js'); } catch (e) {}
const APP_LINK = 'https://saniclock.anubhavflow.com/me?install=1';

// One portal script, one facility per process (FACILITY env): its clock, its NGTeco department, its SaniClock session.
const FAC = process.env.FACILITY || 'Ferrero';
const CFG = {
  Ferrero: { dev: 'ee8959801e404554af7b2e8ba5623518', sn: 'CCH5252300480', dept: '8a8294229fcaca2d01a01058c1db030e', base: '/people',       app: '',       cookie: 'sc_session', auth: '/opt/saniclock/data/.auth.json' },
  IM2:     { dev: '9cbd72e140f94388a747d6d7cf73ffc1', sn: 'UWH5252100004', dept: '8a828a869c2ca2c4019c46b784ff0662', base: '/IM2/people',   app: '/IM2',   cookie: 'sc_im2',     auth: '/opt/im2/data/.auth.json' },
  CLARK:   { dev: '82ed1432138644d2972a478fd5e0b63f', sn: 'CDQ4252201233', dept: '8a8294789e066fba019e2993b68e662d', base: '/CLARK/people', app: '/CLARK', cookie: 'sc_clark',   auth: '/opt/clark/data/.auth.json' },
}[FAC];
if (!CFG) throw new Error('unknown FACILITY ' + FAC);
const PORT = process.env.PORTAL_PORT || 8410;
const PASS = process.env.PORTAL_PASS || 'Ferrero2026';
const SECRET = process.env.FERRERO_SECRET || crypto.randomBytes(16).toString('hex');
const API = 'office-api.ngteco.com';
const TC7_ID = CFG.dev;           // this facility's clock (NGTeco device id)
const FERRERO_DEPT = CFG.dept;   // this facility's NGTeco department
const DESIG = '8a828a869c2ca2c4019c46b9cda0066a';        // DEFAULT designation (shared by all departments)
const ENROLL_TYPE = { fingerprint: 1, face: 2, card: 3 };// fingerprint verified; face/card confirmed on first live test

// ---------- NGTeco raw helpers ----------
function apiGet(tok, path) {
  return new Promise((res, rej) => {
    https.get({ host: API, path, headers: { Authorization: 'Bearer ' + tok, accessor: 'Web', accept: 'application/json', origin: 'https://office.ngteco.com', referer: 'https://office.ngteco.com/' } },
      (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res({}); } }); }).on('error', rej);
  });
}
function apiSend(tok, method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({ host: API, path, method, headers: Object.assign({ Authorization: 'Bearer ' + tok, accessor: 'Web', accept: 'application/json', origin: 'https://office.ngteco.com', referer: 'https://office.ngteco.com/' }, data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
      (rr) => { let b = ''; rr.on('data', (c) => b += c); rr.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch (e) {} res({ status: rr.statusCode, json: j }); }); });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

async function ferreroRoster(tok) {
  const out = []; let page = 1, total = null;
  // ponytail: NGTeco cloud reports 0 fingerprints for everyone, so "enrolled" = has punched by fingerprint on this clock (31-day punch store)
  const fpSeen = new Set();
  try { const seen = JSON.parse(require('fs').readFileSync('/opt/saniclock/data/ngteco-seen.json', 'utf8'));
    for (const k in seen) { const p = seen[k]; if (p && p.punch_from === CFG.sn && /finger/i.test(p.verify_type || '')) fpSeen.add(String(p.employee_code)); } } catch (e) {}
  while (true) {
    const r = await apiGet(tok, '/hr/api/v2.0/employees/?current=' + page + '&pageSize=100&keyword=&departments=' + FERRERO_DEPT);
    const d = r.data || {}; const rows = d.data || []; if (total === null) total = d.total || 0;
    for (const e of rows) {
      const c = e.credentialCount || {};
      const code = e.employeeCode || e.name;
      const appAccess = !!e.userId, appEmail = '';   // NGTeco app login exists for this person
      out.push({ id: e.id, code: code, name: e.fullName || ((e.firstName || '') + ' ' + (e.lastName || '')).trim(),
        email: e.email || appEmail || '', appAccess: appAccess,
        fp: fpSeen.has(String(code)) ? 1 : (c.fingerPrint || 0), face: (c.visibleLightFace || c.face || 0), card: c.card || 0 });
    }
    if (page * 100 >= total || rows.length === 0) break; page++;
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

async function enrollCredential(tok, type, code, personId, fid) {
  const enrollType = ENROLL_TYPE[type] || 1;
  const body = { enrollType, pin: String(code), personId };
  if (type === 'fingerprint') body.fid = String(fid == null ? 4 : fid); // 4 = left thumb default
  const r = await apiSend(tok, 'POST', '/dms/api/v2.0/devices/' + TC7_ID + '/registration/', body);
  return { ok: r.status >= 200 && r.status < 300 && !(r.json && /fail|error|not exist|offline/i.test(r.json.message || '')), status: r.status, message: (r.json && r.json.message) || (r.status === 200 ? 'Success' : 'HTTP ' + r.status) };
}

async function addEmployee(tok, f) {
  const body = { firstName: f.firstName, lastName: f.lastName || '.', code: String(f.code), email: f.email || '', departmentIdOrCode: FERRERO_DEPT, designationIdOrCode: DESIG, createUser: !!f.appAccess };
  const r = await apiSend(tok, 'POST', '/hr/api/v2.0/employees/', body);
  const msg = (r.json && r.json.message) || '';
  return { ok: r.status === 200, exists: /exist|duplicate|already/i.test(msg), status: r.status, message: msg || (r.status === 200 ? 'Created' : 'HTTP ' + r.status), id: r.json && r.json.data && r.json.data.id };
}

// verify a recent punch by code (today), for the post-enroll "punch once" check
async function verifyPunch(tok, code) {
  const now = new Date();
  const iso = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const r = await apiGet(tok, '/att/api/v1.0/transactions/transaction/?current=1&pageSize=200&keyword=' + encodeURIComponent(code) + '&date_range=' + iso + '&date_range=' + iso);
  const rows = (r.data && r.data.data) || [];
  const mine = rows.filter((x) => String(x.employee_code).toUpperCase() === String(code).toUpperCase());
  if (!mine.length) return { punched: false };
  mine.sort((a, b) => (b.att_date + ' ' + b.attendance_status).localeCompare(a.att_date + ' ' + a.attendance_status));
  return { punched: true, at: mine[0].attendance_status, date: mine[0].att_date, count: mine.length };
}

// ---------- session ----------
function sign(v) { return v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function verify(t) { if (!t || t.indexOf('.') < 0) return false; const i = t.lastIndexOf('.'); const p = t.slice(0, i), s = t.slice(i + 1); const e = crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); if (s !== e) return false; try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now(); } catch (x) { return false; } }
function mkToken() { return sign(Buffer.from(JSON.stringify({ r: 'ferrero', exp: Date.now() + 12 * 3600e3 })).toString('base64url')); }
function cookies(req) { const o = {}; (req.headers.cookie || '').split(/;\s*/).forEach((c) => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i)] = c.slice(i + 1); }); return o; }
// A SaniClock admin session (sc_session, Path=/) is accepted here too, so the "Add person" button needs no second login.
const SC_AUTH = CFG.auth;
function scSessionOk(tok) {
  try {
    if (!tok || tok.indexOf('.') < 0) return false;
    const a = JSON.parse(require('fs').readFileSync(SC_AUTH, 'utf8'));
    const i = tok.lastIndexOf('.'); const p = tok.slice(0, i), sig = tok.slice(i + 1);
    const e = crypto.createHmac('sha256', a.secret).update(p).digest('base64url');
    if (e.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(e), Buffer.from(sig))) return false;
    const j = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return !!j && j.exp > Date.now();
  } catch (e) { return false; }
}
function authed(req) { const c = cookies(req); return verify(c.fsid) || scSessionOk(c[CFG.cookie]); }
function body(req) { return new Promise((res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch (e) { res({}); } }); }); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  try {
    if (url === '/api/login' && req.method === 'POST') {
      const b = await body(req);
      if (String(b.pass || '') !== PASS) return json(res, 401, { ok: false, error: 'Wrong password.' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'fsid=' + mkToken() + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + 12 * 3600 }); return res.end(JSON.stringify({ ok: true }));
    }
    if (url === '/api/logout' && req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'fsid=; HttpOnly; Path=/; Max-Age=0' }); return res.end('{"ok":true}'); }

    // everything below needs auth
    if (url.startsWith('/api/')) {
      if (!authed(req)) return json(res, 401, { ok: false, error: 'auth' });
      const tok = await ngteco.scopedToken();

      if (url === '/api/roster' && req.method === 'GET') {
        const list = await ferreroRoster(tok);
        const dev = await apiGet(tok, '/dms/api/v2.0/devices/' + TC7_ID + '/');
        const p = (dev.data && dev.data.parameters) || {};
        const rd = (dev.data && dev.data.registrationDeviceDetail) || {};
        return json(res, 200, { ok: true, list,
          device: { status: dev.data && dev.data.status_format, users: p.userCount + '/' + p.maxUserCount, fpEnabled: rd.bioData === '1', faceEnabled: rd.bioPhoto === '1', cardEnabled: rd.card === '1' } });
      }
      if (url === '/api/enroll' && req.method === 'POST') {
        const b = await body(req);
        if (b.type !== 'fingerprint') return json(res, 400, { ok: false, message: 'Only fingerprint enrolment is enabled' });
        const r = await enrollCredential(tok, b.type, b.code, b.personId, b.fid);
        return json(res, 200, r);
      }
      if (url === '/api/verify-punch' && req.method === 'GET') {
        const code = new URLSearchParams((req.url || '').split('?')[1] || '').get('code');
        return json(res, 200, await verifyPunch(tok, code));
      }
      if (url === '/api/adduser' && req.method === 'POST') {
        const b = await body(req);
        if (!b.firstName || !b.code) return json(res, 200, { ok: false, message: 'First name and Person ID are required.' });
        if (b.appAccess && !b.email) return json(res, 200, { ok: false, message: 'Email is required for app access.' });
        const made = await addEmployee(tok, b);
        // One submission does both: the person in NGTeco, then the fingerprint request on this facility's clock, Left thumb.
        if (made.ok && made.id) made.enroll = await enrollCredential(tok, 'fingerprint', b.code, made.id, 4);
        return json(res, 200, made);
      }
      // register email + grant SaniClock app access (the /me portal), before biometric enroll
      if (url === '/api/setup' && req.method === 'POST') {
        const b = await body(req);
        const code = String(b.code || '').trim();
        const email = String(b.email || '').trim();
        if (!code) return json(res, 200, { ok: false, message: 'Missing employee.' });
        if (b.appAccess && !email) return json(res, 200, { ok: false, message: 'Email is required to grant app access.' });
        if (!empAuth) return json(res, 200, { ok: false, message: 'App-access module unavailable.' });
        try {
          let mailed = false, pass = null;
          if (b.appAccess) {
            pass = empAuth.genPassword();
            empAuth.setCredential(code, email, pass);
            if (mailer && email && mailer.configured()) {
              try { await mailer.send(email, 'Your SaniClock timesheet login', mailer.inviteHtml(b.name || code, email, pass, APP_LINK), mailer.inviteText(b.name || code, email, pass, APP_LINK)); mailed = true; } catch (me) {}
            }
          }
          return json(res, 200, { ok: true, appAccess: !!b.appAccess, email: email, mailed: mailed });
        } catch (e) { return json(res, 200, { ok: false, message: (e && e.message) || 'setup failed' }); }
      }
      return json(res, 404, { ok: false, error: 'not found' });
    }

    // page
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  } catch (e) {
    json(res, 200, { ok: false, error: (e && e.message) || 'server error' });
  }
});
server.listen(PORT, () => console.log('ferrero-enroll on :' + PORT));

// ---------- the page (login + app; client JS uses NO template literals / ${} ) ----------
const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>People &middot; ${FAC} &middot; SaniClock</title>
<style>
:root{--bg:#0a0f1c;--panel:#111a2c;--card:#131d31;--line:rgba(120,160,255,.14);--line2:rgba(143,208,255,.24);--text:#eaf0fb;--text2:#93a1bd;--text3:#6b7a95;--brand:#2f7bff;--brand2:#59a6ff;--gold:#cba967;--emerald:#34d399;--rose:#fb7185}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.wrap{max-width:960px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 16px) 14px calc(30px + env(safe-area-inset-bottom))}
.hidden{display:none!important}
/* login */
.login{max-width:400px;margin:12vh auto 0;background:var(--panel);border:1px solid var(--line2);border-radius:18px;padding:30px 26px}
.login h1{font-size:21px;font-weight:800;letter-spacing:-.3px}.login p{color:var(--text2);font-size:13.5px;margin:6px 0 20px;line-height:1.5}
label{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text2);margin:0 0 7px}
input{width:100%;height:48px;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:12px;color:var(--text);font-size:15px;padding:0 14px;outline:none}
input:focus{border-color:var(--brand)}
.btn{width:100%;height:48px;margin-top:14px;border:0;border-radius:12px;font-size:15px;font-weight:700;color:#fff;background:linear-gradient(135deg,var(--brand2),var(--brand));cursor:pointer}
.btn:disabled{opacity:.6}
.err{background:rgba(251,113,133,.12);border:1px solid rgba(251,113,133,.3);color:#ffb1b1;font-size:13px;padding:10px 12px;border-radius:11px;margin-top:14px;display:none}
/* header */
.hdr{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.hdr .t{flex:1;min-width:0}
.hdr b{font-size:20px;font-weight:800;letter-spacing:-.3px;display:block}
.hdr span{font-size:12px;color:var(--text2)}
@media (max-width:600px){.hdr{flex-wrap:wrap;gap:8px}.hdr .t{flex:1 1 100%}.hdr .ghost{flex:1;text-align:center;justify-content:center}}
.dev{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px}
.pill{font-size:10.5px;font-weight:700;letter-spacing:.03em;padding:3px 9px;border-radius:999px;border:1px solid var(--line2)}
.pill.on{color:var(--emerald);border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.1)}
.pill.off{color:var(--rose);border-color:rgba(251,113,133,.3);background:rgba(251,113,133,.08)}
.ghost{background:rgba(255,255,255,.06);color:var(--text2);border:1px solid var(--line);border-radius:10px;height:38px;padding:0 14px;font-size:13px;font-weight:600;cursor:pointer}
/* tabs */
.tabs{display:flex;gap:8px;margin-bottom:12px}
.tab{flex:1;height:44px;border:1px solid var(--line);background:var(--card);border-radius:12px;color:var(--text2);font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}
.tab.on{color:var(--text);border-color:var(--line2);background:rgba(47,123,255,.1)}
.tab .n{font-size:11px;background:var(--brand);color:#fff;border-radius:999px;padding:1px 8px;min-width:20px}
.tab.on .n{background:var(--brand)}
.toolbar{display:flex;gap:8px;margin-bottom:12px}
.search{flex:1;position:relative}
.search input{height:44px;padding-left:14px}
.addbtn{height:44px;padding:0 16px;border:0;border-radius:12px;background:linear-gradient(135deg,var(--brand2),var(--brand));color:#fff;font-weight:700;font-size:14px;cursor:pointer;white-space:nowrap}
/* rows */
.row{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:9px}
.av{width:40px;height:40px;border-radius:50%;flex:none;display:grid;place-items:center;font-weight:800;font-size:14px;color:#fff}
.info{min-width:0;flex:1}
.info b{font-size:15px;font-weight:700;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.info span{font-size:12px;color:var(--text3);font-family:ui-monospace,Menlo,monospace}
.acts{display:flex;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end;align-items:center}
.acts button{border-radius:10px;padding:8px 11px;font-size:12px;font-weight:700;cursor:pointer;min-height:36px;border:1px solid var(--line2);background:rgba(47,123,255,.1);color:var(--brand2)}
.acts button:disabled{opacity:.55}
@media (max-width:480px){.row{flex-wrap:wrap}.acts,.badges{width:100%;justify-content:flex-end}.tab{font-size:13px;gap:5px;padding:0 4px}}
.badges{display:flex;gap:6px;flex:none}
.badge{font-size:10.5px;font-weight:700;padding:4px 9px;border-radius:999px;background:rgba(52,211,153,.12);color:var(--emerald);border:1px solid rgba(52,211,153,.3)}
.empty{text-align:center;color:var(--text3);font-size:14px;padding:36px 12px}
/* overlay + toast */
.ov{position:fixed;inset:0;background:rgba(4,7,15,.7);display:none;align-items:center;justify-content:center;padding:18px;z-index:50}
.ov.on{display:flex}
.sheet{width:min(440px,100%);background:var(--panel);border:1px solid var(--line2);border-radius:18px;padding:24px}
.sheet h3{font-size:18px;font-weight:800;margin-bottom:6px}
.sheet p{color:var(--text2);font-size:13.5px;line-height:1.55;margin-bottom:16px}
.sheet label{margin-top:12px}
.fingergrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}
.fingergrid button{height:44px;border:1px solid var(--line);background:var(--card);color:var(--text2);border-radius:10px;font-size:12.5px;font-weight:600;cursor:pointer}
.fingergrid button.sel{border-color:var(--brand);color:var(--text);background:rgba(47,123,255,.14)}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(120%);background:#0d1424;border:1px solid var(--line2);color:var(--text);padding:13px 18px;border-radius:13px;font-size:13.5px;max-width:90vw;box-shadow:0 18px 50px -18px #000;transition:transform .3s;z-index:60}
.toast.show{transform:translateX(-50%) translateY(0)}
.toast.ok{border-color:rgba(52,211,153,.4)}.toast.bad{border-color:rgba(251,113,133,.4)}
</style></head><body>

<!-- LOGIN -->
<div id="loginView"><div class="login">
  <h1>People &middot; ${FAC}</h1>
  <p>Add a person and enroll their fingerprint on the ${FAC} clock. Sign in to SaniClock first (<a href="${CFG.app}/login?next=${encodeURIComponent(CFG.base + '/')}" style="color:inherit">open sign-in</a>) or enter the access password.</p>
  <label for="pw">Access password</label>
  <input id="pw" type="password" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;" autofocus/>
  <div class="err" id="loginErr"></div>
  <button class="btn" id="loginBtn">Enter</button>
</div></div>

<!-- APP -->
<div id="appView" class="hidden"><div class="wrap">
  <div class="hdr">
    <div class="t"><b>${FAC} &middot; ${CFG.sn}</b><span id="devSub">Loading device&hellip;</span>
      <div class="dev" id="devPills"></div></div>
    <a class="ghost" id="backBtn" href="${CFG.app}/" style="display:inline-flex;align-items:center;text-decoration:none">&larr; SaniClock</a>
    <button class="ghost" id="refreshBtn">Refresh</button>
    <button class="ghost" id="logoutBtn">Sign out</button>
  </div>
  <div class="tabs">
    <button class="tab on" data-tab="all">All <span class="n" id="nAll">0</span></button>
    <button class="tab" data-tab="pending">Pending <span class="n" id="nPending">0</span></button>
    <button class="tab" data-tab="enrolled">Enrolled <span class="n" id="nEnrolled">0</span></button>
  </div>
  <div class="toolbar">
    <div class="search"><input id="q" type="search" placeholder="Search name or ID&hellip;" autocomplete="off"/></div>
    <button class="addbtn" id="addBtn">+ Add user</button>
  </div>
  <div id="list"></div>
</div></div>

<!-- FINGER PICKER -->
<div class="ov" id="fingerOv"><div class="sheet">
  <h3>Enroll fingerprint</h3>
  <p id="fingerWho">Pick a finger, then the employee presses it on the clock <b>3 times</b>.</p>
  <div class="fingergrid" id="fingerGrid"></div>
  <button class="btn" id="fingerStart">Start on device</button>
  <button class="ghost" id="fingerCancel" style="width:100%;margin-top:8px;height:44px">Cancel</button>
</div></div>

<!-- PUNCH VERIFY -->
<div class="ov" id="punchOv"><div class="sheet">
  <h3>Confirm the enrollment</h3>
  <p id="punchWho">Ask the employee to <b>punch once</b> on the clock now to confirm their fingerprint works. Click below once they&#39;ve punched.</p>
  <button class="btn" id="punchCheck">They punched &mdash; verify</button>
  <button class="ghost" id="punchSkip" style="width:100%;margin-top:8px;height:44px">Skip for now</button>
</div></div>

<!-- ADD USER -->
<div class="ov" id="addOv"><div class="sheet">
  <h3>Add new ${FAC} employee</h3>
  <p>Creates the person in NGTeco (${FAC} department) and immediately sends the fingerprint request to the ${FAC} clock (${CFG.sn}). Finger: <b>Left thumb</b>. Have them at the clock.</p>
  <label>First name</label><input id="afn" autocomplete="off"/>
  <label>Last name</label><input id="aln" autocomplete="off"/>
  <label>Person ID</label><input id="acode" autocomplete="off" placeholder="e.g. 120"/>
  <label>Email (optional)</label><input id="aemail" type="email" autocomplete="off"/>
  <label style="display:flex;align-items:center;gap:9px;margin-top:10px;cursor:pointer"><input id="aapp" type="checkbox" style="width:auto;margin:0"/> App access (NGTeco app login for this person, needs the email)</label>
  <div class="err" id="addErr"></div>
  <button class="btn" id="addSubmit">Create person + send fingerprint request</button>
  <button class="ghost" id="addCancel" style="width:100%;margin-top:8px;height:44px">Cancel</button>
</div></div>

<!-- EMAIL + APP ACCESS GATE -->
<div class="ov" id="setupOv"><div class="sheet">
  <h3>Email &amp; app access</h3>
  <p id="suWho">Set the employee&#39;s email and app access.</p>
  <label>Email</label><input id="suEmail" type="email" autocomplete="off" placeholder="name@company.com"/>
  <label style="display:flex;align-items:center;gap:10px;text-transform:none;letter-spacing:0;font-size:14px;color:var(--text);margin-top:14px;cursor:pointer">
    <input id="suAccess" type="checkbox" style="width:20px;height:20px;flex:none" checked/> Give this employee app access (SaniClock mobile timesheet) &mdash; emails them a login</label>
  <div class="err" id="suErr"></div>
  <button class="btn" id="suSubmit">Save &amp; continue to enroll</button>
  <button class="ghost" id="suCancel" style="width:100%;margin-top:8px;height:44px">Cancel</button>
</div></div>

<div class="toast" id="toast"></div>

<script>
var BASE='${CFG.base}';
var $=function(s){return document.querySelector(s);};
var STATE={tab:'all',list:[],q:'',pending:{code:null,personId:null,name:null,fid:6}};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function ini(n){return String(n||'').trim().split(/\\s+/).slice(0,2).map(function(w){return w[0]||'';}).join('').toUpperCase();}
function hue(n){var h=0;for(var i=0;i<(n||'').length;i++)h=(h*31+n.charCodeAt(i))%360;return h;}
function avatar(n){return 'background:linear-gradient(135deg,hsl('+hue(n)+' 55% 42%),hsl('+((hue(n)+40)%360)+' 55% 36%))';}
function toast(msg,kind){var t=$('#toast');t.textContent=msg;t.className='toast show '+(kind||'');setTimeout(function(){t.className='toast '+(kind||'');},4200);}
function jget(u){return fetch(BASE+u,{cache:'no-store'}).then(function(r){return r.json();});}
function jpost(u,b){return fetch(BASE+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json();});}

/* login */
$('#loginBtn').addEventListener('click',doLogin);
$('#pw').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});
function doLogin(){
  var b=$('#loginBtn');b.disabled=true;$('#loginErr').style.display='none';
  jpost('/api/login',{pass:$('#pw').value}).then(function(j){
    b.disabled=false;
    if(j.ok){$('#loginView').classList.add('hidden');$('#appView').classList.remove('hidden');load();}
    else{$('#loginErr').textContent=j.error||'Login failed.';$('#loginErr').style.display='block';}
  }).catch(function(){b.disabled=false;$('#loginErr').textContent='Network error.';$('#loginErr').style.display='block';});
}
/* auto-enter if already signed in */
jget('/api/roster').then(function(j){if(j&&j.ok){$('#loginView').classList.add('hidden');$('#appView').classList.remove('hidden');render(j);}}).catch(function(){});

$('#logoutBtn').addEventListener('click',function(){jpost('/api/logout',{}).then(function(){location.reload();});});
$('#refreshBtn').addEventListener('click',load);

function load(){
  jget('/api/roster').then(function(j){
    if(!j.ok){toast('Could not load roster: '+(j.error||''),'bad');return;}
    render(j);
  }).catch(function(){toast('Network error loading roster.','bad');});
}
function render(j){
  STATE.list=j.list||[];
  var d=j.device||{};
  $('#devSub').textContent=(d.status==='online'?'Online':'Offline')+' \\u00b7 '+(d.users||'')+' users';
  var pills='<span class="pill '+(d.status==='online'?'on':'off')+'">'+(d.status==='online'?'Clock online':'Clock offline')+'</span>'+
    '<span class="pill" style="color:var(--text2);border-color:var(--line)">'+(d.users||'')+' users</span>';
  $('#devPills').innerHTML=pills;
  STATE.dev=d;
  paint();
}
function isEnrolled(e){return e.fp>0;}
function paint(){
  var q=STATE.q.toLowerCase();
  var pend=STATE.list.filter(function(e){return !isEnrolled(e);});
  var enr=STATE.list.filter(isEnrolled);
  $('#nAll').textContent=STATE.list.length;$('#nPending').textContent=pend.length;$('#nEnrolled').textContent=enr.length;
  var rows=(STATE.tab==='all'?STATE.list:STATE.tab==='pending'?pend:enr).filter(function(e){
    return !q||String(e.name).toLowerCase().indexOf(q)>=0||String(e.code).toLowerCase().indexOf(q)>=0;
  });
  var list=$('#list');
  if(!rows.length){list.innerHTML='<div class="empty">'+(STATE.tab==='pending'?(q?'No matching pending employees.':'Everyone is enrolled. \\ud83c\\udf89'):(q?'No matching enrolled employees.':'Nobody enrolled yet.'))+'</div>';return;}
  list.innerHTML=rows.map(function(e){
    var on=isEnrolled(e);
    var acts='<div class="acts">'+(on?'<span class="badge">Fingerprint</span>':'')+
        '<button data-a="fingerprint" data-code="'+esc(e.code)+'" data-id="'+esc(e.id)+'" data-name="'+esc(e.name)+'">'+(on?'Re-enrol':'Enrol fingerprint')+'</button></div>';
    return '<div class="row"><span class="av" style="'+avatar(e.name)+'">'+esc(ini(e.name))+'</span>'+
      '<div class="info"><b>'+esc(e.name)+'</b><span>ID '+esc(e.code)+(e.email?' \\u00b7 '+esc(e.email):'')+(e.appAccess?' \\u00b7 App access':'')+'</span></div>'+acts+'</div>';
  }).join('');
}
/* tabs + search */
Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(t){t.addEventListener('click',function(){
  Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(x){x.classList.remove('on');});
  t.classList.add('on');STATE.tab=t.getAttribute('data-tab');paint();});});
$('#q').addEventListener('input',function(){STATE.q=$('#q').value;paint();});

/* enroll button clicks -> email/app-access gate -> biometric */
$('#list').addEventListener('click',function(e){
  var b=e.target.closest('button[data-a]');if(!b)return;
  var type=b.getAttribute('data-a'),code=b.getAttribute('data-code');
  var emp=STATE.list.filter(function(x){return String(x.code)===String(code);})[0];
  if(!emp)return;
  STATE.pending={code:emp.code,personId:emp.id,name:emp.name,fid:6,type:type,email:emp.email};
  proceedEnroll(type,emp);
});
function proceedEnroll(type,emp){
  if(type==='fingerprint'){openFingerPicker(emp.name);}
  else{fireEnroll(type,emp.code,emp.id,null,emp.name);}
}
/* email + app-access gate */
function openSetup(emp,type){
  STATE.setupFor={emp:emp,type:type};
  $('#suWho').innerHTML='Before enrolling <b>'+esc(emp.name)+'</b>, set their email and app access.';
  $('#suEmail').value=emp.email||'';
  $('#suAccess').checked=true;
  $('#suErr').style.display='none';
  $('#setupOv').classList.add('on');
}
$('#suCancel').addEventListener('click',function(){$('#setupOv').classList.remove('on');});
$('#suSubmit').addEventListener('click',function(){
  var s=STATE.setupFor;if(!s)return;
  var email=$('#suEmail').value.trim(),access=$('#suAccess').checked;
  if(access&&!email){$('#suErr').textContent='Email is required to grant app access.';$('#suErr').style.display='block';return;}
  var b=this;b.disabled=true;$('#suErr').style.display='none';
  jpost('/api/setup',{code:s.emp.code,name:s.emp.name,email:email,appAccess:access}).then(function(r){
    b.disabled=false;
    if(!r.ok){$('#suErr').textContent='NGTeco/app: '+(r.message||'failed');$('#suErr').style.display='block';return;}
    s.emp.email=email;s.emp.appAccess=access||s.emp.appAccess;
    $('#setupOv').classList.remove('on');
    toast('\\u2713 '+(access?(r.mailed?'App access granted \\u2014 invite emailed to '+email:'App access granted for '+email):'Email saved'),'ok');
    proceedEnroll(s.type,s.emp);
  }).catch(function(){b.disabled=false;$('#suErr').textContent='Network error.';$('#suErr').style.display='block';});
});
/* finger picker */
var FINGERS=[['Right thumb',5],['Right index',6],['Right middle',7],['Left thumb',4],['Left index',3],['Left middle',2]];
function openFingerPicker(name){
  $('#fingerWho').innerHTML='For <b>'+esc(name)+'</b>: pick a finger, tap Start, then they press it on the clock <b>3 times</b>.';
  $('#fingerGrid').innerHTML=FINGERS.map(function(f,i){return '<button data-fid="'+f[1]+'"'+(f[1]===4?' class="sel"':'')+'>'+f[0]+'</button>';}).join('');
  STATE.pending.fid=4;
  $('#fingerOv').classList.add('on');
}
$('#fingerGrid').addEventListener('click',function(e){var b=e.target.closest('button[data-fid]');if(!b)return;
  Array.prototype.forEach.call(document.querySelectorAll('#fingerGrid button'),function(x){x.classList.remove('sel');});
  b.classList.add('sel');STATE.pending.fid=+b.getAttribute('data-fid');});
$('#fingerCancel').addEventListener('click',function(){$('#fingerOv').classList.remove('on');});
$('#fingerStart').addEventListener('click',function(){
  $('#fingerOv').classList.remove('on');
  fireEnroll('fingerprint',STATE.pending.code,STATE.pending.personId,STATE.pending.fid,STATE.pending.name);
});
function fireEnroll(type,code,id,fid,name){
  toast('Sending to the clock\\u2026');
  jpost('/api/enroll',{type:type,code:code,personId:id,fid:fid}).then(function(r){
    if(r.ok){
      toast('\\u2713 '+type.charAt(0).toUpperCase()+type.slice(1)+' armed on the clock for '+name+'. NGTeco: '+(r.message||'Success'),'ok');
      if(type==='fingerprint'){openPunchVerify(name,code);}
    }else{
      toast('\\u2717 NGTeco: '+(r.message||('HTTP '+r.status)),'bad');
    }
  }).catch(function(){toast('Network error firing enrollment.','bad');});
}
/* punch verify */
function openPunchVerify(name,code){
  $('#punchWho').innerHTML='Ask <b>'+esc(name)+'</b> to press their finger to <b>punch once</b> on the clock now. Then click below to confirm it registered.';
  STATE.pending.code=code;STATE.pending.name=name;
  $('#punchOv').classList.add('on');
}
$('#punchSkip').addEventListener('click',function(){$('#punchOv').classList.remove('on');load();});
$('#punchCheck').addEventListener('click',function(){
  var b=this;b.disabled=true;b.textContent='Checking punch log\\u2026';
  jget('/api/verify-punch?code='+encodeURIComponent(STATE.pending.code)).then(function(r){
    b.disabled=false;b.textContent='They punched \\u2014 verify';
    if(r.punched){$('#punchOv').classList.remove('on');toast('\\u2713 Confirmed \\u2014 '+STATE.pending.name+' punched at '+r.at+'. Enrollment works.','ok');load();}
    else{toast('No punch found yet for '+STATE.pending.name+'. Have them press again, then retry.','bad');}
  }).catch(function(){b.disabled=false;b.textContent='They punched \\u2014 verify';toast('Network error checking punch.','bad');});
});
/* add user */
$('#addBtn').addEventListener('click',function(){$('#afn').value='';$('#aln').value='';$('#acode').value='';$('#aemail').value='';$('#addErr').style.display='none';$('#addOv').classList.add('on');});
$('#addCancel').addEventListener('click',function(){$('#addOv').classList.remove('on');});
$('#addSubmit').addEventListener('click',function(){
  var b=this;b.disabled=true;$('#addErr').style.display='none';
  var payload={firstName:$('#afn').value.trim(),lastName:$('#aln').value.trim(),code:$('#acode').value.trim(),email:$('#aemail').value.trim(),appAccess:$('#aapp').checked};
  jpost('/api/adduser',payload).then(function(r){
    b.disabled=false;
    if(r.ok){$('#addOv').classList.remove('on');var en=r.enroll||{};toast('\\u2713 '+payload.firstName+' created'+(en.ok?' \\u2014 fingerprint request sent to the clock. Left thumb, 3 times.':' \\u2014 fingerprint request failed: '+(en.message||'')),en.ok?'ok':'bad');if(en.ok)openPunchVerify((payload.firstName+' '+payload.lastName).trim(),payload.code);STATE.tab='pending';Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(x){x.classList.toggle('on',x.getAttribute('data-tab')==='pending');});load();}
    else{$('#addErr').textContent='NGTeco: '+(r.message||'failed')+(r.exists?' (that Person ID already exists)':'');$('#addErr').style.display='block';}
  }).catch(function(){b.disabled=false;$('#addErr').textContent='Network error.';$('#addErr').style.display='block';});
});
</script>
</body></html>`;
