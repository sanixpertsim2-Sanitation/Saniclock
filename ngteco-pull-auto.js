#!/usr/bin/env node
/**
 * ngteco-pull-auto.js — pull punches from NGTeco cloud into SaniClock, fully
 * automatic login. Reverse-engineered from office.ngteco.com (2026-07-15).
 *
 * AUTH CHAIN (all three steps required — the company switch was the missing piece):
 *   1. LOGIN   POST office-api.ngteco.com/oauth2/api/v1.0/token {username,password}
 *              -> AuthenticationResult { AccessToken (base), RefreshToken }
 *   2. COMPANY GET  /auth/api/v1.0/companies/get_default_company/  -> company_id
 *   3. SWITCH  PUT  /auth/api/v1.0/companies/switch_company_v2/ {company_id}
 *              -> data.access  (COMPANY-SCOPED token — required for /att /hr /dms)
 * Without step 3 every data call returns "Company not found in access token".
 *
 * PUNCHES  GET /att/api/v1.0/transactions/transaction/  (scoped token)
 *   fields: employee_code, employee_name, att_date, attendance_status(=punch time),
 *           verify_type, punch_from(=device SN), timezone, punch_format_time
 *
 * .ngteco.env keys: NGTECO_USER, NGTECO_PASS, NGTECO_TOKEN(base, managed),
 *   NGTECO_REFRESH(managed), NGTECO_COMPANY(managed).
 */
'use strict';
const https = require('https'), fs = require('fs');
const ENVF = process.env.NGTECO_ENV || '/opt/saniclock/.ngteco.env';
const OUT = process.env.NGTECO_OUT || '/opt/saniclock/data/punch.csv';
const API = 'office-api.ngteco.com';
const HEADER = 'Person ID,Person Name,Punch Date,Attendance record,Verify Type,TimeZone,Source';
const log = (m) => console.log('[' + new Date().toISOString() + '] ' + m);

function readEnv() {
  const o = {};
  try { fs.readFileSync(ENVF, 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) o[m[1]] = m[2].trim(); }); } catch {}
  return o;
}
function writeEnv(o) { fs.writeFileSync(ENVF, Object.entries(o).map(([k, v]) => k + '=' + v).join('\n') + '\n', { mode: 0o600 }); }
let ENV = readEnv();

function req(opts, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const r = https.request(opts, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function authH(token, extra) {
  return Object.assign({ 'Authorization': 'Bearer ' + token, 'accessor': 'Web', 'accept': 'application/json',
    'origin': 'https://office.ngteco.com', 'referer': 'https://office.ngteco.com/' }, extra || {});
}
function pickTokens(j) {
  const a = j && (j.AuthenticationResult || j.authenticationResult || j.data || j);
  if (!a) return {};
  return { access: a.AccessToken || a.accessToken || a.access_token || a.access, refresh: a.RefreshToken || a.refreshToken || a.refresh_token };
}

async function login() {
  if (!ENV.NGTECO_USER || !ENV.NGTECO_PASS) throw new Error('NGTECO_USER / NGTECO_PASS not set in ' + ENVF);
  log('Logging in as ' + ENV.NGTECO_USER + ' ...');
  const res = await req({ host: API, path: '/oauth2/api/v1.0/token', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'accessor': 'Web', 'accept': 'application/json', 'origin': 'https://office.ngteco.com', 'referer': 'https://office.ngteco.com/' } },
    { username: ENV.NGTECO_USER, password: ENV.NGTECO_PASS });
  const t = pickTokens(res.json);
  if (res.status >= 400 || !t.access) {
    const msg = (res.json && (res.json.message || res.json.msg || res.json.error)) || ('http ' + res.status);
    throw new Error('LOGIN failed: ' + msg);
  }
  ENV.NGTECO_TOKEN = t.access; if (t.refresh) ENV.NGTECO_REFRESH = t.refresh; writeEnv(ENV);
  log('Login OK (base token stored).');
  return t.access;
}
async function refresh() {
  if (!ENV.NGTECO_REFRESH) return null;
  log('Refreshing base token ...');
  const res = await req({ host: 'ai.minervaiot.com', path: '/ngteco/refresh-token', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    { platform_id: 'ngtecowebsite', AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: ENV.NGTECO_REFRESH } });
  const t = pickTokens(res.json);
  if (res.status >= 400 || !t.access) { log('Refresh failed (http ' + res.status + ').'); return null; }
  ENV.NGTECO_TOKEN = t.access; if (t.refresh) ENV.NGTECO_REFRESH = t.refresh; writeEnv(ENV);
  log('Refresh OK.');
  return t.access;
}
async function getCompanyId(baseTok) {
  if (ENV.NGTECO_COMPANY) return ENV.NGTECO_COMPANY;
  const res = await req({ host: API, path: '/auth/api/v1.0/companies/get_default_company/', method: 'GET', headers: authH(baseTok) });
  const cid = res.json && (res.json.company_id || (res.json.data && res.json.data.company_id));
  if (cid) { ENV.NGTECO_COMPANY = cid; writeEnv(ENV); }
  return cid || null;
}
async function switchCompany(baseTok, cid) {
  const res = await req({ host: API, path: '/auth/api/v1.0/companies/switch_company_v2/', method: 'PUT', headers: authH(baseTok, { 'content-type': 'application/json' }) }, { company_id: cid });
  return (res.json && res.json.data && res.json.data.access) || null;
}
/** Full chain -> company-scoped token. */
async function ensureScoped() {
  let base = ENV.NGTECO_TOKEN;
  if (base) {
    const cid = await getCompanyId(base);
    if (cid) { const sc = await switchCompany(base, cid); if (sc) return sc; }
  }
  base = (await refresh()) || (await login());          // fresh base
  const cid = await getCompanyId(base);
  if (!cid) throw new Error('no default company for account');
  const sc = await switchCompany(base, cid);
  if (!sc) throw new Error('company switch failed (check credentials)');
  return sc;
}

function daysAgo(n) { const d = new Date(Date.now() - n * 864e5); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
const START = process.argv[2] || daysAgo(3), END = process.argv[3] || daysAgo(0);

function getPage(token, page) {
  const q = 'current=' + page + '&pageSize=100&keyword=&date_range=' + START + '&date_range=' + END;
  return req({ host: API, path: '/att/api/v1.0/transactions/transaction/?' + q, method: 'GET', headers: authH(token) });
}
const esc = (v) => String(v == null ? '' : v).replace(/["\r\n]/g, '').replace(/,/g, ' ').replace(/ {2,}/g, ' ').trim();

(async () => {
  const token = await ensureScoped();
  let page = 1, rows = [], total = null;
  while (true) {
    const r = await getPage(token, page);
    if (r.status === 401) throw new Error('Unexpected 401 after company switch');
    const j = r.json || {}; const data = (j.data && j.data.data) || [];
    if (total === null) total = (j.data && j.data.total) || 0;
    for (const rec of data) rows.push([esc(rec.employee_code), esc(rec.employee_name || rec.employee_code), esc(rec.att_date), esc(rec.attendance_status), esc(rec.verify_type), '', esc(rec.punch_from)].join(','));
    if (page * 100 >= total || data.length === 0) break; page++;
  }
  fs.writeFileSync(OUT, HEADER + '\n' + rows.join('\n') + '\n');
  log('Pulled ' + rows.length + ' punches (' + START + '..' + END + ') -> ' + OUT);
})().catch((e) => { log('PULL FAILED: ' + e.message); process.exit(1); });
