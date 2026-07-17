#!/usr/bin/env node
/**
 * ngteco-connect.js — a tiny, self-contained "Connect your NGTeco account" page.
 *
 * The user types their NGTeco email + password HERE (on their own SaniClock
 * server, over HTTPS). Credentials are written to /opt/saniclock/.ngteco.env
 * and a test login runs immediately. The assistant never sees the password.
 *
 * Served locally on 127.0.0.1:8300, exposed by nginx at /connect/ngteco.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const { execFile } = require('child_process');
const ENVF = '/opt/saniclock/.ngteco.env';
const PULL = '/opt/saniclock/ngteco-pull-auto.js';
const PORT = 8300;

function readEnv() { const o = {}; try { fs.readFileSync(ENVF, 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) o[m[1]] = m[2]; }); } catch {} return o; }
function writeEnv(o) { fs.writeFileSync(ENVF, Object.entries(o).map(([k, v]) => k + '=' + v).join('\n') + '\n', { mode: 0o600 }); }

const PAGE = (msg, ok) => `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Connect NGTeco — SaniClock</title><style>
body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#1e293b;padding:32px;border-radius:16px;width:min(420px,92vw);box-shadow:0 20px 60px rgba(0,0,0,.4)}
h1{font-size:20px;margin:0 0 4px}p.sub{color:#94a3b8;font-size:13px;margin:0 0 20px}
label{display:block;font-size:13px;margin:14px 0 6px;color:#cbd5e1}
input{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:9px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:15px}
button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:9px;background:#3b82f6;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#2563eb}.msg{margin-top:16px;padding:11px 13px;border-radius:9px;font-size:14px}
.ok{background:#064e3b;color:#6ee7b7}.err{background:#7f1d1d;color:#fca5a5}.note{color:#64748b;font-size:12px;margin-top:18px;line-height:1.5}
</style></head><body><div class=card>
<h1>Connect your NGTeco account</h1><p class=sub>SaniClock will use this to pull your punches automatically. Your password is stored only on your own server.</p>
<form method=POST>
<label>NGTeco login email</label><input name=user type=email required autocomplete=off placeholder="you@company.com">
<label>NGTeco password</label><input name=pass type=password required autocomplete=off placeholder="••••••••">
<button type=submit>Connect &amp; test login</button></form>
${msg ? `<div class="msg ${ok ? 'ok' : 'err'}">${msg}</div>` : ''}
<div class=note>This runs on your SaniClock server over HTTPS. The password is written to a private server file (.ngteco.env, permissions 600) and used only to log in to NGTeco. It is never shown to anyone.</div>
</div></body></html>`;

function testLogin(cb) {
  execFile('node', [PULL], { timeout: 60000, env: Object.assign({}, process.env) }, (err, stdout, stderr) => {
    const out = (stdout || '') + (stderr || '');
    const m = out.match(/Pulled (\d+) punches/);
    if (m) return cb(null, 'Connected! Test pull succeeded — ' + m[1] + ' punches fetched. Auto-login is working.');
    const fail = (out.match(/PULL FAILED: (.*)/) || [])[1] || (err && err.message) || 'unknown error';
    cb(new Error(fail));
  });
}

http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE('', false)); }
  if (req.method === 'POST') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      const p = new URLSearchParams(b);
      const user = (p.get('user') || '').trim(), pass = p.get('pass') || '';
      if (!user || !pass) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE('Please enter both email and password.', false)); }
      const env = readEnv(); env.NGTECO_USER = user; env.NGTECO_PASS = pass;
      env.NGTECO_TOKEN = env.NGTECO_TOKEN || ''; env.NGTECO_REFRESH = env.NGTECO_REFRESH || '';
      writeEnv(env);
      testLogin((err, okMsg) => {
        if (err) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE('Saved, but login test failed: ' + err.message, false)); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE(okMsg, true));
      });
    });
    return;
  }
  res.writeHead(405); res.end('method not allowed');
}).listen(PORT, '127.0.0.1', () => console.log('[ngteco-connect] listening on 127.0.0.1:' + PORT));
