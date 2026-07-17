#!/usr/bin/env node
/**
 * saniclock-iclock.js — a ZKTeco ADMS / "iclock" push receiver.
 *
 * This is the server a ZKTeco-family clock POSTs its punches to when its
 * WebServerIP/ServerIP is pointed here. It lets SaniClock receive punches
 * DIRECTLY from a device you own — no vendor cloud, biometric/attendance data
 * never leaves your network. Zero-dependency.
 *
 * Implements the minimal iclock protocol a device needs:
 *   GET  /iclock/cdata?SN=..&options=all   -> handshake / config registry
 *   GET  /iclock/getrequest?SN=..          -> pending commands (we send none)
 *   POST /iclock/cdata?SN=..&table=ATTLOG  -> attendance records (tab-separated)
 *
 * Every received punch is appended to data/live-punches.csv in the exact
 * "View Attendance Punch" schema, so it flows through SaniClock's existing
 * pairing/paysheet pipeline unchanged.
 *
 * Run:  node saniclock-iclock.js            (listens 0.0.0.0:8090)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.ICLOCK_PORT) || 8090;
const OUT = process.env.ICLOCK_CSV || path.join(__dirname, 'data', 'live-punches.csv');
const HEADER = 'Person ID,Person Name,Punch Date,Attendance record,Verify Type,TimeZone,Source';

function log(m) { console.log('[' + new Date().toISOString() + '] ' + m); }
function ensureCsv() { fs.mkdirSync(path.dirname(OUT), { recursive: true }); if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, HEADER + '\n'); }
ensureCsv();

// The config block we hand the device on handshake. Realtime=1 => push immediately.
function registry(sn) {
  return [
    'GET OPTION FROM: ' + sn,
    'Stamp=9999', 'OpStamp=9999', 'ErrorDelay=30', 'Delay=10',
    'TransTimes=00:00;12:00', 'TransInterval=1', 'TransFlag=1111000000',
    'TimeZone=-300', 'Realtime=1', 'Encrypt=0', 'ServerVer=2.4.1',
  ].join('\r\n') + '\r\n';
}

function esc(v) { return String(v == null ? '' : v).replace(/["\r\n]/g, '').replace(/,/g, ' ').replace(/ {2,}/g, ' ').trim(); }

// Parse an ATTLOG body: each line "PIN \t YYYY-MM-DD HH:MM:SS \t status \t verify ..."
function ingestAttlog(body) {
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  let n = 0;
  for (const line of lines) {
    const f = line.split('\t');
    if (f.length < 2) continue;
    const pin = f[0].trim();
    const ts = (f[1] || '').trim();               // "2026-07-12 08:05:30"
    const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(ts);
    if (!pin || !m) continue;
    const dateMDY = (+m[2]) + '/' + (+m[3]) + '/' + m[1];
    const hms = m[4] + ':' + m[5] + ':' + m[6];
    const verify = f[3] ? 'V' + f[3].trim() : 'Fingerprint';
    fs.appendFileSync(OUT, [esc(pin), esc(pin), esc(dateMDY), esc(hms), esc(verify), '', esc('iclock')].join(',') + '\n');
    log('  PUNCH  pid=' + pin + '  ' + dateMDY + ' ' + hms);
    n++;
  }
  return n;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const sn = u.searchParams.get('SN') || '?';
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const p = u.pathname;
    if (req.method === 'GET' && p === '/iclock/cdata') {
      log('HANDSHAKE  SN=' + sn + '  ' + req.url);
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(registry(sn)); return;
    }
    if (req.method === 'GET' && p === '/iclock/getrequest') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK'); return;   // no pending commands
    }
    if (req.method === 'POST' && p === '/iclock/cdata') {
      const table = u.searchParams.get('table') || '';
      if (/ATTLOG/i.test(table)) {
        const n = ingestAttlog(body);
        log('ATTLOG  SN=' + sn + '  received ' + n + ' punch(es)');
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK: ' + n); return;
      }
      log('POST ' + table + '  SN=' + sn + '  (' + body.length + ' bytes) — ack');
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK'); return;
    }
    // Anything else the device probes for — log it so we learn its dialect.
    log('OTHER  ' + req.method + ' ' + req.url + (body ? '  body[' + body.length + ']' : ''));
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK');
  });
});
server.listen(PORT, '0.0.0.0', () => log('SaniClock iclock receiver listening on 0.0.0.0:' + PORT + '  ->  ' + OUT));
