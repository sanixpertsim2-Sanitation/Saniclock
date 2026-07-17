'use strict';
/**
 * lib/mailer.js — outbound email for employee invites.
 * SMTP settings + app-password live in /opt/saniclock/.mail.env (mode 600, root-only).
 * The admin enters them once via /connect/mail; the password is never logged or returned.
 */
const fs = require('fs');
const nodemailer = require('nodemailer');
const ENVF = process.env.MAIL_ENV || '/opt/saniclock/.mail.env';

function readEnv() { const o = {}; try { fs.readFileSync(ENVF, 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) o[m[1]] = m[2]; }); } catch {} return o; }
function writeEnv(o) { fs.writeFileSync(ENVF, Object.entries(o).map(([k, v]) => k + '=' + v).join('\n') + '\n', { mode: 0o600 }); }

function configured() { const e = readEnv(); return !!(e.MAIL_HOST && e.MAIL_USER && e.MAIL_PASS); }
function meta() { const e = readEnv(); return { host: e.MAIL_HOST || '', port: e.MAIL_PORT || '', user: e.MAIL_USER || '', from: e.MAIL_FROM || '', fromName: e.MAIL_FROM_NAME || 'SaniClock', hasPass: !!e.MAIL_PASS }; }

function transport() {
  const e = readEnv();
  const port = +(e.MAIL_PORT || 587);
  return nodemailer.createTransport({
    host: e.MAIL_HOST, port,
    secure: e.MAIL_SECURE === '1' || port === 465,
    requireTLS: port === 587,
    auth: { user: e.MAIL_USER, pass: e.MAIL_PASS },
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 15000, greetingTimeout: 12000, socketTimeout: 25000,
  });
}
function fromLine() { const e = readEnv(); return '"' + (e.MAIL_FROM_NAME || 'SaniClock') + '" <' + (e.MAIL_FROM || e.MAIL_USER) + '>'; }

function saveConfig(c) {
  const e = readEnv();
  if (c.host != null) e.MAIL_HOST = c.host;
  if (c.port != null) e.MAIL_PORT = String(c.port);
  e.MAIL_SECURE = c.secure ? '1' : '0';
  if (c.user != null) e.MAIL_USER = c.user;
  if (c.from != null) e.MAIL_FROM = c.from;
  if (c.fromName != null) e.MAIL_FROM_NAME = c.fromName;
  if (c.pass) e.MAIL_PASS = c.pass; // only overwrite when a new one is supplied
  writeEnv(e);
}

async function verify() { await transport().verify(); return true; }
async function send(to, subject, html, text, attachments) {
  const info = await transport().sendMail({ from: fromLine(), to, subject, html, text: text || '', attachments: attachments || undefined });
  return { ok: true, id: info.messageId, accepted: info.accepted || [], rejected: info.rejected || [] };
}

/** Friendly, on-brand invite email. link = the /me URL; pass = one-time password. */
function inviteHtml(name, email, pass, link) {
  const first = String(name || '').split(/\s+/)[0] || 'there';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#eef3fb;padding:28px 14px">
  <div style="max-width:480px;margin:0 auto;background:#0b1220;border-radius:18px;overflow:hidden;color:#eaf0fb">
    <div style="background:linear-gradient(135deg,#1f5bff,#59a6ff);padding:24px 26px">
      <div style="font-size:20px;font-weight:800;letter-spacing:-.3px;color:#fff">SaniClock</div>
      <div style="font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#dbe8ff;margin-top:2px">My Timesheet</div>
    </div>
    <div style="padding:26px">
      <p style="font-size:16px;margin:0 0 6px">Hi ${first},</p>
      <p style="color:#aebbd4;font-size:14px;line-height:1.55;margin:0 0 20px">Your SaniClock timesheet is ready. Sign in to see your hours, breaks, and request punch corrections — anytime, from your phone.</p>
      <div style="background:#111a2c;border:1px solid #253251;border-radius:12px;padding:16px 18px;margin-bottom:20px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#7b89a6">Username</div>
        <div style="font-size:15px;font-weight:600;margin:2px 0 12px">${email}</div>
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#7b89a6">Temporary password</div>
        <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;font-weight:700;letter-spacing:1px;color:#59a6ff;margin-top:2px">${pass}</div>
      </div>
      <a href="${link}" style="display:block;text-align:center;background:linear-gradient(135deg,#59a6ff,#1f5bff);color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px;border-radius:12px">Open my timesheet</a>
      <p style="color:#7b89a6;font-size:12.5px;line-height:1.5;margin:18px 0 0">You'll be asked to set your own password on first sign-in. Tip: after signing in, tap <b style="color:#aebbd4">Add to Home Screen</b> so it opens like an app.</p>
    </div>
  </div>
  <div style="text-align:center;color:#8a96ad;font-size:11px;margin-top:14px">SaniClock by SaniXperts · Time &amp; Attendance</div>
</div>`;
}
function inviteText(name, email, pass, link) {
  return 'Hi ' + (String(name || '').split(/\s+/)[0] || 'there') + ',\n\nYour SaniClock timesheet is ready.\n\nUsername: ' + email + '\nTemporary password: ' + pass + '\n\nOpen it: ' + link + '\n\nYou will set your own password on first sign-in.\n\nSaniClock by SaniXperts';
}

module.exports = { configured, meta, saveConfig, verify, send, inviteHtml, inviteText };
