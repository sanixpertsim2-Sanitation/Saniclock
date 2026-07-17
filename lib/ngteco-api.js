'use strict';
/**
 * lib/ngteco-api.js — shared NGTeco cloud client for scale.js (the dashboard).
 * Wraps the reverse-engineered auth chain + data/command endpoints so the
 * Group-Management UI can Push employees, Enroll fingerprints, and read
 * enrolled status — all from SaniClock. Zero deps (Node built-ins only).
 *
 * Reads credentials/tokens from /opt/saniclock/.ngteco.env (managed by the pull).
 */
const https = require('https'), fs = require('fs');
const ENVF = process.env.NGTECO_ENV || '/opt/saniclock/.ngteco.env';
const API = 'office-api.ngteco.com';
const DEPT_DEFAULT = '8a8294659f3fbee2019f6727223c05a6';   // Ferrero Main plant
const DESIG_DEFAULT = '8a8294659f3fbee2019f6727c86305a9';  // DEFAULT

function readEnv() { const o = {}; try { fs.readFileSync(ENVF, 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) o[m[1]] = m[2].trim(); }); } catch {} return o; }
function writeEnv(o) { fs.writeFileSync(ENVF, Object.entries(o).map(([k, v]) => k + '=' + v).join('\n') + '\n', { mode: 0o600 }); }

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const d = body ? JSON.stringify(body) : null;
    const r = https.request(opts, (x) => { let b = ''; x.on('data', (c) => b += c); x.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: x.statusCode, json: j, raw: b }); }); });
    r.on('error', reject); if (d) r.write(d); r.end();
  });
}
function authH(t, extra) { return Object.assign({ 'Authorization': 'Bearer ' + t, 'accessor': 'Web', 'accept': 'application/json', 'origin': 'https://office.ngteco.com', 'referer': 'https://office.ngteco.com/' }, extra || {}); }
function pick(j) { const a = j && (j.AuthenticationResult || j.data || j); return a ? { access: a.AccessToken || a.access_token || a.access, refresh: a.RefreshToken || a.refresh_token } : {}; }

async function loginBase(ENV) {
  if (!ENV.NGTECO_USER || !ENV.NGTECO_PASS) throw new Error('NGTECO_USER/PASS not set');
  const r = await req({ host: API, path: '/oauth2/api/v1.0/token', method: 'POST', headers: { 'Content-Type': 'application/json', accessor: 'Web', accept: 'application/json', origin: 'https://office.ngteco.com', referer: 'https://office.ngteco.com/' } }, { username: ENV.NGTECO_USER, password: ENV.NGTECO_PASS });
  const t = pick(r.json); if (!t.access) throw new Error('login failed: ' + ((r.json && r.json.message) || r.status));
  ENV.NGTECO_TOKEN = t.access; if (t.refresh) ENV.NGTECO_REFRESH = t.refresh; writeEnv(ENV); return t.access;
}
async function companyId(ENV, base) {
  if (ENV.NGTECO_COMPANY) return ENV.NGTECO_COMPANY;
  const r = await req({ host: API, path: '/auth/api/v1.0/companies/get_default_company/', method: 'GET', headers: authH(base) });
  const cid = r.json && (r.json.company_id || (r.json.data && r.json.data.company_id));
  if (cid) { ENV.NGTECO_COMPANY = cid; writeEnv(ENV); } return cid;
}
async function switchCompany(base, cid) { const r = await req({ host: API, path: '/auth/api/v1.0/companies/switch_company_v2/', method: 'PUT', headers: authH(base, { 'content-type': 'application/json' }) }, { company_id: cid }); return r.json && r.json.data && r.json.data.access; }

/** Full chain -> company-scoped token (re-logs in if the stored base is stale). */
async function scopedToken() {
  const ENV = readEnv();
  let base = ENV.NGTECO_TOKEN;
  if (base) { const cid = await companyId(ENV, base); if (cid) { const s = await switchCompany(base, cid); if (s) return s; } }
  base = await loginBase(ENV);
  const cid = await companyId(ENV, base);
  const s = await switchCompany(base, cid);
  if (!s) throw new Error('company switch failed');
  return s;
}

async function listEmployees(tok) {
  const out = []; let page = 1, total = null;
  while (true) {
    const r = await req({ host: API, path: '/hr/api/v2.0/employees/?current=' + page + '&pageSize=100&keyword=&departments=', method: 'GET', headers: authH(tok) });
    const d = (r.json && r.json.data) || {}; const rows = d.data || [];
    if (total === null) total = d.total || 0;
    for (const e of rows) out.push({ id: e.id, code: e.employeeCode || e.name, name: e.fullName, fp: (e.credentialCount && e.credentialCount.fingerPrint) || 0, face: (e.credentialCount && (e.credentialCount.visibleLightFace || e.credentialCount.face)) || 0, card: (e.credentialCount && e.credentialCount.card) || 0 });
    if (page * 100 >= total || rows.length === 0) break; page++;
  }
  return out;
}
async function pushEmployee(tok, emp) {
  const parts = (emp.person || '').trim().split(/\s+/); const firstName = parts.shift() || ('emp' + emp.pid); const lastName = parts.join(' ') || '.';
  const r = await req({ host: API, path: '/hr/api/v2.0/employees/', method: 'POST', headers: authH(tok, { 'content-type': 'application/json' }) }, { firstName, lastName, code: String(emp.pid), email: emp.email || '', departmentIdOrCode: emp.dept || DEPT_DEFAULT, designationIdOrCode: DESIG_DEFAULT, createUser: false });
  const msg = (r.json && r.json.message) || '';
  return { ok: r.status === 200, exists: /exist|duplicate|already/i.test(msg), status: r.status, message: msg, id: r.json && r.json.data && r.json.data.id };
}
async function getDeviceInternalId(tok) {
  const r = await req({ host: API, path: '/dms/api/v2.0/devices/?current=1&pageSize=16', method: 'GET', headers: authH(tok) });
  const rows = (r.json && r.json.data && r.json.data.data) || [];
  return rows[0] ? { internalId: rows[0].id, sn: rows[0].sn, online: rows[0].online_status || rows[0].status } : null;
}
/** fid: 0-9 finger index (4 = left thumb). enrollType 1 = fingerprint. */
async function enrollFingerprint(tok, deviceInternalId, pin, personId, fid) {
  const r = await req({ host: API, path: '/dms/api/v2.0/devices/' + deviceInternalId + '/registration/', method: 'POST', headers: authH(tok, { 'content-type': 'application/json' }) }, { enrollType: 1, pin: String(pin), fid: String(fid == null ? 4 : fid), personId });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, message: (r.json && r.json.message) || '' };
}

async function deleteEmployee(tok, personId) {
  const r = await req({ host: API, path: '/hr/api/v2.0/employees/' + personId + '/', method: 'DELETE', headers: authH(tok) });
  return { ok: r.status >= 200 && r.status < 400, status: r.status, message: (r.json && r.json.message) || '' };
}

module.exports = { scopedToken, listEmployees, pushEmployee, getDeviceInternalId, enrollFingerprint, deleteEmployee, DEPT_DEFAULT, DESIG_DEFAULT };

// CLI self-test: node ngteco-api.js
if (require.main === module) {
  (async () => {
    const tok = await scopedToken(); console.log('scoped token OK (' + tok.length + ' chars)');
    const dev = await getDeviceInternalId(tok); console.log('device:', dev);
    const emps = await listEmployees(tok);
    console.log('employees:', emps.length, '| fingerprint-enrolled:', emps.filter((e) => e.fp > 0).length);
    console.log('sample:', emps.slice(0, 3).map((e) => e.code + ':' + e.name + ' fp=' + e.fp).join(' | '));
  })().catch((e) => { console.error('SELFTEST FAIL:', e.message); process.exit(1); });
}
