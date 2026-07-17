#!/usr/bin/env node
/* saniclock-receiver.js — all-in-one "say yes" server for the NG-TC2.
   Listens HTTP:80 and HTTPS:443 (self-signed, tests the no-pinning case).
   Accepts ANY path, logs everything, writes punches to CSV, always answers
   200 OK so the clock believes delivery succeeded. Run as admin (ports 80/443).
   Usage:  node saniclock-receiver.js   (optional PORT_HTTP / PORT_HTTPS env) */
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');

const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDMRbKPF8v3X8Sl
XQPsdjwjqD2AT/gGaeNNURHhQ/FZklcvkdyLkzv3a7u3gwVTsrXtwmih7QUWqPF4
qnp+BpBq2qTqZ5bE6uSpAvvqbPzmGjBwgYhl/IJXSdhsktvIlgqfec4ZnBO2ZksV
ACQG61RN/00HI0LSe4CifT1+WrxuK1DMXB8yRDKNCn3zoQbX7xCLkvNA+jRLcqSW
w/87/lRRzTWnBRl3ajgalUyu8pDJGWcos8PzbZh4yzvGRKkVI8z7C1UfLOns+Dz3
S4EvJgZIukJh2ofO7fnrxPTw7kZ/H9hjvSjWhXOyAeDi36UMMJvcq8nEHpLicoz9
B3GtGLnVAgMBAAECggEAAZmDdh+hQA3mt40+XhEhMIwSoBy5GJ9RNu10YIBzmNhO
pV6cDMGLaldio7jtRzJoE+AFUKH5+6tVd99wkJL6JBpMrIqWduSIdagl/f8zY1wj
JMAu7u5qSuOXCxG7yxrkXGeTAmM4n2i2xutveTws/dYKwyjE+b/iETkFMF8fiKMY
KFEILVQP4hDEmIgKqii3ZKJYVJKJwq/TpcTAq4RhHG+jQCQ9xXpgB2hnkhV5fYsd
ZoUZGVrVWSg4OnZqLUxWP+xO+8o/ysk1RMBDU10rgiUOln8YyueYYEaW7HC1Jyov
QaCDB8rOtrSaJRGobCE0a7CIJbA44WVFjm8w+X9f5QKBgQD8Wot9Az191JpoSsze
1YxDEF7ciR23QMc46t3H/ytb3RveQz7JUlMP/ZyiqO/u5VcPTRNgIUN94DCr0Aps
0uWbnzgE0L0vTXKKul4Xq12QNAZa+XdwkaF7Io3bj+ymggDih1qdHG3D7OBeCUHn
CIUlT1rmQ+CLkLh6TuwGC1mFwwKBgQDPOUyzoOmdNnplYARjNksxrYwsimylAB+W
U9qUb5Ezy5xhpG4RNpYn1V61h5E6IN3AEc2xzBoDUrV417N1p3dy59LAKCI76HWK
dul+ij33gOJQ0ubMatRdJyy/FF+ozyxGCpzbDV0Z7UQdT/zhbMWgHeIt0xUCPqQJ
2SFsge0QhwKBgQDoSNwezW27togOudOMxhqe3KHE9D2zIeB/xskwv/OEUqnFVDam
D64/iN22aDS6vMX/Yp4UHWpHoqaKcCw4cYRCVDO3UwDhWrO1eMkFlorAIvM6qGjF
6HcwpeTYFsnplr8DxT2mYrWy5Aa+6FyOMiyE5F+ylwZI0YTNqHnfMnFMCwKBgAuU
OhL3dNZSCvjLKrOYfw8hkWmTuoplvV4bBWWx7j0krXJPS88ua6mCJK6kCpti5sEq
vYGn0/RHlNhRxTdXyjbjeUU/eNo8HQVFq7pkYx4HV54Iitj1RzSFUdzDeKzoFqM7
SJR85KzkMyAoLgsylsBhqxfAabYcZfIe7d0wTVzVAoGAZ/bLG6IO64BHDSvz54Nn
ByOZqPTGXZBRbYteP/8Ls2jHKL2aUvmLOSJKlYM4PztoPyiHeUYBM10H8oEFOJa+
UyzRTn20UcKLsSqk/FddRFz1dUpwjve1LHtKPZc6UAN2+5yasxYEo5aZ+2WgSPgY
vkqnR92cLSF7IKe9wLAhFsw=
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIDNzCCAh+gAwIBAgIUYHymQl3QAq3go4D5GKPtEuMP6hIwDQYJKoZIhvcNAQEL
BQAwKzEVMBMGA1UEAwwMbmd0ZWNvLWxvY2FsMRIwEAYDVQQKDAlTYW5pQ2xvY2sw
HhcNMjYwNzEyMTczMDAzWhcNMzYwNzA5MTczMDAzWjArMRUwEwYDVQQDDAxuZ3Rl
Y28tbG9jYWwxEjAQBgNVBAoMCVNhbmlDbG9jazCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAMxFso8Xy/dfxKVdA+x2PCOoPYBP+AZp401REeFD8VmSVy+R
3IuTO/dru7eDBVOyte3CaKHtBRao8Xiqen4GkGrapOpnlsTq5KkC++ps/OYaMHCB
iGX8gldJ2GyS28iWCp95zhmcE7ZmSxUAJAbrVE3/TQcjQtJ7gKJ9PX5avG4rUMxc
HzJEMo0KffOhBtfvEIuS80D6NEtypJbD/zv+VFHNNacFGXdqOBqVTK7ykMkZZyiz
w/NtmHjLO8ZEqRUjzPsLVR8s6ez4PPdLgS8mBki6QmHah87t+evE9PDuRn8f2GO9
KNaFc7IB4OLfpQwwm9yrycQekuJyjP0Hca0YudUCAwEAAaNTMFEwHQYDVR0OBBYE
FFChJ6V+MponL+fyOfCi/EJYEe0nMB8GA1UdIwQYMBaAFFChJ6V+MponL+fyOfCi
/EJYEe0nMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAJLvrvnP
epDlCtsq3AKobWOlHHciIjUHP0yUwMp5kfTImrWOSYpDuL5eZTvNhaG1+AmQvQv8
kdniJmpvzZT1WAT88qXXn+qrBsIxHt1XyyM6Wk0IcKk6YpALqseNeYwhnyc2Kbwa
qZWOB7kcv+lDaHeGS/yfgJfGkkbQrwyGewN41Ws5wYHda8eD3MmcqaPweTsPHr3E
Ot8QPuDyOl8YiV2zXV7sUXCMd7yRPjNsRjA8jw+27+vuWKqQmXC7OvZ+QkTtoT+e
85XcVK2K+fXa96C8cgVtcUWQcTPja2QgdLP15e/aTJ8h/BB1e+vfxzpcpFUVSqq6
FkShA0YOW/V7lk4=
-----END CERTIFICATE-----`;

const OUT = process.env.RECV_CSV || path.join(__dirname, 'live-punches.csv');
const HEADER = 'Person ID,Person Name,Punch Date,Attendance record,Verify Type,TimeZone,Source';
function log(m) { console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m); }
try { if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, HEADER + '\n'); } catch (e) {}
function esc(v) { return String(v == null ? '' : v).replace(/[",\r\n]/g, ' ').replace(/ {2,}/g, ' ').trim(); }

function ingest(body) {
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  let n = 0;
  for (const line of lines) {
    const f = line.split('\t');
    if (f.length < 2) continue;
    const pin = f[0].trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec((f[1] || '').trim());
    if (!pin || !m) continue;
    const dateMDY = (+m[2]) + '/' + (+m[3]) + '/' + m[1];
    const hms = m[4] + ':' + m[5] + ':' + m[6];
    fs.appendFileSync(OUT, [esc(pin), esc(pin), esc(dateMDY), esc(hms), esc(f[3] ? 'V' + f[3].trim() : 'Fingerprint'), '', esc('receiver')].join(',') + '\n');
    log('  >>> PUNCH  pid=' + pin + '  ' + dateMDY + ' ' + hms);
    n++;
  }
  return n;
}

function handler(scheme) {
  return (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      log(scheme + '  ' + req.method + ' ' + req.url + '  host=' + (req.headers.host || '?') + (body ? ('  body[' + body.length + ']') : ''));
      if (body) log('     BODY: ' + body.slice(0, 300).replace(/\r?\n/g, ' | '));
      const u = req.url || '';
      if (/ATTLOG/i.test(u) && body) {
        const n = ingest(body);
        log('     ATTLOG parsed ' + n + ' punch(es)');
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK: ' + n); return;
      }
      if (/\/iclock\/cdata/i.test(u) && req.method === 'GET') {
        const sn = (u.match(/SN=([^&]+)/) || [])[1] || '?';
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('GET OPTION FROM: ' + sn + '\r\nStamp=9999\r\nOpStamp=9999\r\nErrorDelay=30\r\nDelay=10\r\nTransTimes=00:00;12:00\r\nTransInterval=1\r\nTransFlag=1111000000\r\nTimeZone=-300\r\nRealtime=1\r\nEncrypt=0\r\n'); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK'); // say yes to everything
    });
  };
}

http.createServer(handler('HTTP :80 ')).listen(Number(process.env.PORT_HTTP) || 80, '0.0.0.0', () => log('HTTP  receiver on 0.0.0.0:' + (process.env.PORT_HTTP || 80)));
try {
  https.createServer({ key: KEY, cert: CERT }, handler('HTTPS:443')).listen(Number(process.env.PORT_HTTPS) || 443, '0.0.0.0', () => log('HTTPS receiver on 0.0.0.0:' + (process.env.PORT_HTTPS || 443) + ' (self-signed)'));
} catch (e) { log('HTTPS bind failed: ' + e.message); }
log('SaniClock receiver ready -> ' + OUT + '  (answers 200 OK to everything)');
