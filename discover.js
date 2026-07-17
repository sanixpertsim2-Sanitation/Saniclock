#!/usr/bin/env node
/**
 * saniclock-discover.js — learn where the NG-TC4 phones home.
 *
 * Legitimate interoperability diagnostic on hardware we own: we point the
 * device's DNS at this machine, log the exact hostname it tries to resolve
 * for its cloud push, answer with our own IP, and catch the connection on
 * :80 and :443 to see whether BEST-W is plain HTTP (redirectable) or HTTPS
 * (and its SNI). No third-party system is touched — only our own device's
 * outbound call, redirected to our own server.
 *
 * Run as admin (binds 53/80/443).  Our IP: set OURIP env (default 10.0.0.213).
 */
'use strict';
const dgram = require('dgram');
const net = require('net');
const http = require('http');

const OURIP = process.env.OURIP || '10.0.0.213';
function log(m) { console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m); }

// ---- DNS server (UDP 53): log the query name, answer with OURIP ----
function parseName(buf, off) {
  const parts = []; let jumped = false, o = off, safety = 0;
  while (safety++ < 40) {
    const len = buf[o];
    if (len === 0) { o++; break; }
    if ((len & 0xc0) === 0xc0) { const ptr = ((len & 0x3f) << 8) | buf[o + 1]; if (!jumped) off = o + 2; o = ptr; jumped = true; continue; }
    parts.push(buf.toString('ascii', o + 1, o + 1 + len)); o += 1 + len;
  }
  return { name: parts.join('.'), end: jumped ? off : o };
}
const dns = dgram.createSocket('udp4');
dns.on('message', (msg, rinfo) => {
  try {
    const q = parseName(msg, 12);
    log('DNS QUERY  from ' + rinfo.address + '  ->  ' + q.name);
    // Build answer: copy header+question, set QR/AA, 1 answer -> OURIP
    const id = msg.subarray(0, 2);
    const qsection = msg.subarray(12, q.end + 4); // name + qtype + qclass
    const header = Buffer.alloc(12);
    id.copy(header, 0);
    header.writeUInt16BE(0x8180, 2); // response, recursion available
    header.writeUInt16BE(1, 4); // QDCOUNT
    header.writeUInt16BE(1, 6); // ANCOUNT
    const ans = Buffer.alloc(16);
    ans.writeUInt16BE(0xc00c, 0); // pointer to name at offset 12
    ans.writeUInt16BE(1, 2); // type A
    ans.writeUInt16BE(1, 4); // class IN
    ans.writeUInt32BE(30, 6); // TTL 30s
    ans.writeUInt16BE(4, 10); // rdlength
    OURIP.split('.').forEach((n, i) => { ans[12 + i] = +n; });
    dns.send(Buffer.concat([header, qsection, ans]), rinfo.port, rinfo.address);
  } catch (e) { log('DNS parse error: ' + e.message); }
});
dns.on('error', (e) => log('DNS bind error: ' + e.message));
dns.bind(53, OURIP, () => log('DNS logger on ' + OURIP + ':53  (answers everything -> ' + OURIP + ')'));

// ---- HTTP catcher (80): log the full request the device makes ----
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    log('*** HTTP :80  ' + req.method + ' ' + req.url + '  Host=' + (req.headers.host || '?'));
    log('    headers: ' + JSON.stringify(req.headers));
    if (body) log('    body[' + body.length + ']: ' + body.slice(0, 400));
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK');
  });
}).listen(80, '0.0.0.0', () => log('HTTP catcher on tcp/80'));

// ---- Raw TCP catcher (443): a TLS connection here => it's HTTPS. Read the
// ClientHello to extract the SNI (the real hostname), then we know it's HTTPS
// and whether we could MITM it. ----
net.createServer((sock) => {
  log('*** TCP :443 connection from ' + sock.remoteAddress + '  => device is using HTTPS');
  sock.once('data', (d) => {
    // TLS ClientHello: try to pull the SNI extension for the hostname.
    try {
      const hex = d.subarray(0, 6).toString('hex');
      log('    first bytes: ' + hex + (d[0] === 0x16 ? '  (TLS handshake)' : ''));
      const s = d.toString('latin1');
      const m = s.match(/[a-z0-9.-]+\.(com|net|io|cn|cc|org)/i);
      if (m) log('    SNI/host hint: ' + m[0]);
    } catch (e) {}
    sock.destroy();
  });
  sock.on('error', () => {});
}).listen(443, '0.0.0.0', () => log('TLS/443 catcher up'));

log('DISCOVERY READY — set device DNS to ' + OURIP + ' and reboot it.');
