'use strict';
/**
 * lib/emp-auth.js — per-employee self-service credentials + sessions.
 * Separate from the admin auth (data/.auth.json). Each employee account is keyed
 * by Person ID (pid). username = their email. Password is scrypt-hashed; the
 * plaintext is generated once on employee creation and shown to the admin to
 * hand over (never emailed from here). Sessions are stateless signed cookies
 * (esid) scoped to {pid, role:'emp'} — an employee can only ever see their own data.
 */
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const FILE = path.join(__dirname, '..', 'data', 'employee-auth.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { secret: '', accounts: {} }; } }
function save(o) { fs.writeFileSync(FILE, JSON.stringify(o, null, 2), { mode: 0o600 }); }
let STORE = load();
if (!STORE.secret) { STORE.secret = crypto.randomBytes(32).toString('hex'); if (!STORE.accounts) STORE.accounts = {}; save(STORE); }

// readable password: no ambiguous chars (0/O, 1/l/I), 10 chars, mixed
function genPassword() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(10); let p = '';
  for (let i = 0; i < 10; i++) p += cs[b[i] % cs.length];
  return p;
}
function hashPw(pw, salt) { return crypto.scryptSync(String(pw || ''), salt, 64).toString('hex'); }

/** Create/replace an employee login. Returns the account (without hash). */
function setCredential(pid, email, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const acc = { pid: String(pid), email: String(email || '').toLowerCase().trim(), salt, hash: hashPw(password, salt), mustChange: true, updatedAt: new Date().toISOString() };
  STORE.accounts[String(pid)] = acc; save(STORE);
  return { pid: acc.pid, email: acc.email, mustChange: true };
}
function removeCredential(pid) { if (STORE.accounts[String(pid)]) { delete STORE.accounts[String(pid)]; save(STORE); return true; } return false; }
function byEmail(email) { const e = String(email || '').toLowerCase().trim(); return Object.values(STORE.accounts).find((a) => a.email === e) || null; }
function byPid(pid) { return STORE.accounts[String(pid)] || null; }

function verify(email, password) {
  const a = byEmail(email); if (!a) return null;
  try { const h = Buffer.from(hashPw(password, a.salt), 'hex'); const s = Buffer.from(a.hash, 'hex'); if (h.length === s.length && crypto.timingSafeEqual(h, s)) return { pid: a.pid, email: a.email, mustChange: !!a.mustChange }; } catch {}
  return null;
}
function changePassword(pid, newPw) {
  const a = STORE.accounts[String(pid)]; if (!a) return false;
  a.salt = crypto.randomBytes(16).toString('hex'); a.hash = hashPw(newPw, a.salt); a.mustChange = false; a.updatedAt = new Date().toISOString();
  save(STORE); return true;
}
function signSession(pid) {
  const payload = Buffer.from(JSON.stringify({ pid: String(pid), role: 'emp', exp: Date.now() + 12 * 3600e3 })).toString('base64url');
  const sig = crypto.createHmac('sha256', STORE.secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifySession(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const dot = token.lastIndexOf('.'); const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', STORE.secret).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(payload, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
function listAccounts() { return Object.values(STORE.accounts).map((a) => ({ pid: a.pid, email: a.email, mustChange: !!a.mustChange, updatedAt: a.updatedAt })); }

module.exports = { genPassword, setCredential, removeCredential, byEmail, byPid, verify, changePassword, signSession, verifySession, listAccounts };
