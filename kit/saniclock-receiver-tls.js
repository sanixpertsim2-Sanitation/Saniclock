#!/usr/bin/env node
/*
 * saniclock-receiver-tls.js — the server the NG-TC2 pushes its punches to,
 * once its traffic reaches us (via a travel router we control).
 *
 * Listens on BOTH:
 *   - tcp/80   plain HTTP   (if BEST-W turns out to be unencrypted)
 *   - tcp/443  HTTPS        (self-signed cert impersonating *.ngteco.com;
 *                            works if the clock does NOT pin its cert)
 *
 * Speaks the ZKTeco ADMS / iclock PUSH dialect that "BEST-W" is built on:
 *   GET  /iclock/cdata?SN=..&options=all   -> handshake / config registry
 *   GET  /iclock/getrequest?SN=..          -> pending commands (none)
 *   POST /iclock/cdata?SN=..&table=ATTLOG  -> attendance records
 * Anything else -> 200 OK  (be a server that says yes, so the clock believes
 * the push succeeded even if we can't parse an unexpected body).
 *
 * Every parseable punch is written to  C:\saniclock-punches.csv  in the exact
 * "View Attendance Punch" schema SaniClock already ingests.
 *
 * Zero-dependency. Run as Administrator (binds 80/443):
 *     node saniclock-receiver-tls.js
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');

const OUT = process.env.RECV_CSV || 'C:\\saniclock-punches.csv';
const RAWLOG = 'C:\\saniclock-receiver.log';
const HEADER = 'Person ID,Person Name,Punch Date,Attendance record,Verify Type,TimeZone,Source';

// --- embedded self-signed cert (CN=*.ngteco.com) so no openssl needed ---
const CERT = `-----BEGIN CERTIFICATE-----
MIIDkTCCAnmgAwIBAgIUXW8lnmtc3hPkz+yGxQeimUhpYWIwDQYJKoZIhvcNAQEL
BQAwODELMAkGA1UEBhMCQ0ExEjAQBgNVBAoMCVNhbmlDbG9jazEVMBMGA1UEAwwM
Ki5uZ3RlY28uY29tMB4XDTI2MDcxMjE3NDkxMVoXDTM2MDcwOTE3NDkxMVowODEL
MAkGA1UEBhMCQ0ExEjAQBgNVBAoMCVNhbmlDbG9jazEVMBMGA1UEAwwMKi5uZ3Rl
Y28uY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAo6eEbjQ5qwnR
xIMCC0KQX2Ha24iDF0t6fQREfiV3kbZ2GcDkb//7ZkG284eVpxwbAl5mT2ZG8Emn
x/2QU+0LnTtNBfZSjuHDdnMrqvAxmAiD56XRbY52Dv38Dfx5P6YICcR42cuEVQmV
DB+pKxtSnzAKPJV4dKp6lLp827rJypy9QQphnEnFM0PoX/vmFtkmYlqcakJBhrBU
B7Yps3UhdGjLQRTxWTJ2d+Fb4bJDxH63y09Q1ulEFa54YcnxDtjX7raPzbqv1h45
CXH8TdxERuBdeNKRyoIk4dnpWqnKpvC3vgu83382ueDiAZgp2MS2FyCQSEO75iFe
Ac8wMyaRDQIDAQABo4GSMIGPMB0GA1UdDgQWBBRCQECLbgXp3Nd4L4oRLhnA4VJj
+zAfBgNVHSMEGDAWgBRCQECLbgXp3Nd4L4oRLhnA4VJj+zAPBgNVHRMBAf8EBTAD
AQH/MDwGA1UdEQQ1MDOCDCoubmd0ZWNvLmNvbYIKbmd0ZWNvLmNvbYIRb2ZmaWNl
Lm5ndGVjby5jb22HBMCoAQkwDQYJKoZIhvcNAQELBQADggEBABfbhY9/kak/7Tk8
eRycSNw4bOkDZQkmOM2hXTvJVQnEeL16E69mg/826NbMcF3IrTkQo3ybL6vdX567
I5ZoJvgGVLt9IJUxcBQIndDzIBTBJoBktCFh7iXAWJdBxgA54QjsPwWIoSgbUCYZ
AlhshOHSxi1k1ZVrDgRKyPL5rdcjU5Ga7Wnwan5Zz9oEAjZ6oV+/2H5T10qZoqtL
jHeQQ7prdUvGTP8LwRc3Q9G2SToRbh8U/ZL67FcR7qQ8B9jfXDY1OyGgaQXauIVV
AdP/i8g1sKQXN1x2XsaTW4S929Xie7qdp/cRiv/gIpUtUbf7CBXxecy9Y1gSc12N
B1HFnQo=
-----END CERTIFICATE-----`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCjp4RuNDmrCdHE
gwILQpBfYdrbiIMXS3p9BER+JXeRtnYZwORv//tmQbbzh5WnHBsCXmZPZkbwSafH
/ZBT7QudO00F9lKO4cN2cyuq8DGYCIPnpdFtjnYO/fwN/Hk/pggJxHjZy4RVCZUM
H6krG1KfMAo8lXh0qnqUunzbusnKnL1BCmGcScUzQ+hf++YW2SZiWpxqQkGGsFQH
timzdSF0aMtBFPFZMnZ34VvhskPEfrfLT1DW6UQVrnhhyfEO2Nfuto/Nuq/WHjkJ
cfxN3ERG4F140pHKgiTh2elaqcqm8Le+C7zffza54OIBmCnYxLYXIJBIQ7vmIV4B
zzAzJpENAgMBAAECggEAGE0rD2FOce1Emrl4f3sMLLm/ccuI6dfhsbhFQnUmVvsg
+OyJj28T4gielfWbfaPhB95EM4SkwpAxa7Nlr+y6hYfVhW3hLwnryEZMZPcDakfT
bH3VRj86HTpOaDZGO/MX7Plhl7fOqAEDArid2oKVZ4GO95WbfDmHd9fkbA2F4wHc
ECOChf1uTZTzgMm/sI3mcKg4K7JqwFLgJpTkjCjCUMHQRFvyprAtPmEEskmA5aCj
Pu2oHcAKq7R3JBr/B9aouYVC95mrCQNCKQUQQcSK/3cFsPLCECdAazLv+XtppSQU
KIROHG5r2Sxxtxrslx4NlYP1kCUsbhiMS8aktZizOQKBgQDTHfiPU6r3aAsE1EAc
VTEIrjnum660ZSyRxJdwtbF3WQpLAEqakASDAhMMPYZ1yUgOsOTnjsEd7AR18gKM
Isp6j1FFZVoCtQBB+yEn0KPROrXxuUADjQ9C9rtRiqI/iC7MqFBHy5+/om/8LcOT
tIuMAdLzY6BN4F6Ngnns2Pm5ZQKBgQDGcmRzJIlo4OKDE6RCH4arJciZV+VoxSpV
XVAOM1I1eUvxFH4a3wSI2TbyR/U96jt4o85aEQXKFiRIP/22OVtaZuZTprY+uESm
SJ92p54I6svk3eyIpwSo8RMvWTJYkNvjI1itH0aLCQtLjNPqyRBaOjIaBr54UhZg
ju8URaBSiQKBgHq3jjdKDDQ5/0W0VvvhLVp9Y+FmD3x+3xRwcRMsGldko44LQlJr
6qN4fjf8P3+SG9emTbioC2toOQOSRJbO1mG9kyFCk7rFGbxAzPoG1mKVvRMgeqxV
v4xOPX5dlohVkdaW8+t32okbU/sDYw8lwIQGv2eI/rKl/HBHarYZPbfdAoGAE1cE
qSAPcDQyfxnD8VnHMxjMkv0481v7wzQD4E5qHaIDn6wimhXQCFI7A6O1p+ITB6/X
JXnxOX+s64mo/UBbwdSzb8WYj0ZAEoCTYen2AeJ4GobyTWMRljFgcEXeHTmI5HsG
YmDg7B3mhudjo8cSm+h+B4FOwMUnPyPO8wfSFxkCgYBuleSZdLoHdzUNGP7JJiaY
ulJTfnRbeF91tRkDQ5LTwMk/VRkxCINIVV1zY95NOEQdcrf46bb6riV3q4QDY412
jhr4JIMVBgQQ2WKhPr7lIemoYg69jtF9dwybk32Bl9Qh3oIi0dP8uAf77CiNi/bf
HNPFZrqO/hwPEEw5Zkzb3g==
-----END PRIVATE KEY-----`;

function ts() { return new Date().toISOString(); }
function log(m) {
  const line = '[' + ts() + '] ' + m;
  console.log(line);
  try { fs.appendFileSync(RAWLOG, line + '\n'); } catch (e) {}
}
if (!fs.existsSync(OUT)) { try { fs.writeFileSync(OUT, HEADER + '\n'); } catch (e) {} }

function registry(sn) {
  return ['GET OPTION FROM: ' + sn, 'Stamp=9999', 'OpStamp=9999', 'ErrorDelay=30',
    'Delay=10', 'TransTimes=00:00;12:00', 'TransInterval=1', 'TransFlag=1111000000',
    'TimeZone=-300', 'Realtime=1', 'Encrypt=0', 'ServerVer=2.4.1 SaniClock'].join('\r\n') + '\r\n';
}
function esc(v){return String(v==null?'':v).replace(/["\r\n]/g,'').replace(/,/g,' ').replace(/ {2,}/g,' ').trim();}
function ingestAttlog(body){
  const lines=body.split(/\r?\n/).filter(l=>l.trim());let n=0;
  for(const line of lines){
    const f=line.split('\t');if(f.length<2)continue;
    const pin=f[0].trim();const m=/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec((f[1]||'').trim());
    if(!pin||!m)continue;
    const dateMDY=(+m[2])+'/'+(+m[3])+'/'+m[1];const hms=m[4]+':'+m[5]+':'+m[6];
    const verify=f[3]?'V'+f[3].trim():'Fingerprint';
    try{fs.appendFileSync(OUT,[esc(pin),esc(pin),esc(dateMDY),esc(hms),esc(verify),'',esc('best-w')].join(',')+'\n');}catch(e){}
    log('   >>> PUNCH  pid='+pin+'  '+dateMDY+' '+hms);n++;
  }
  return n;
}

function handler(scheme){
  return (req,res)=>{
    let u;try{u=new URL(req.url,'http://x');}catch(e){u={pathname:req.url,searchParams:new Map()};}
    const sn=(u.searchParams.get&&u.searchParams.get('SN'))||'?';
    let body='';req.on('data',c=>{body+=c;});
    req.on('end',()=>{
      const p=u.pathname;
      log('['+scheme+'] '+req.method+' '+req.url+'  from '+(req.socket.remoteAddress||'?')+'  SN='+sn+(body?'  body['+body.length+']':''));
      if(req.method==='GET'&&p==='/iclock/cdata'){res.writeHead(200,{'Content-Type':'text/plain'});res.end(registry(sn));return;}
      if(req.method==='GET'&&p==='/iclock/getrequest'){res.writeHead(200,{'Content-Type':'text/plain'});res.end('OK');return;}
      if(req.method==='POST'&&p==='/iclock/cdata'){
        const table=(u.searchParams.get&&u.searchParams.get('table'))||'';
        if(/ATTLOG/i.test(table)){const n=ingestAttlog(body);log('   ATTLOG SN='+sn+' -> '+n+' punch(es) saved');res.writeHead(200,{'Content-Type':'text/plain'});res.end('OK: '+n);return;}
        if(body)log('   POST body ('+table+'): '+body.slice(0,300).replace(/\r?\n/g,' | '));
        res.writeHead(200,{'Content-Type':'text/plain'});res.end('OK');return;
      }
      // unknown path/verb — say yes anyway so the device thinks it succeeded
      if(body)log('   (unrecognized) body: '+body.slice(0,300).replace(/\r?\n/g,' | '));
      res.writeHead(200,{'Content-Type':'text/plain'});res.end('OK');
    });
  };
}

// HTTP on 80
http.createServer(handler('HTTP')).listen(80,'0.0.0.0',()=>log('HTTP  receiver on 0.0.0.0:80'));
// HTTPS on 443 (self-signed *.ngteco.com)
try{
  https.createServer({key:KEY,cert:CERT},handler('HTTPS')).listen(443,'0.0.0.0',()=>log('HTTPS receiver on 0.0.0.0:443 (self-signed *.ngteco.com)'));
}catch(e){log('HTTPS start error: '+e.message);}
// surface TLS handshake failures (this is how we learn if the clock PINS its cert)
process.on('uncaughtException',e=>log('EXC: '+e.message));
log('=== SaniClock TLS receiver ready. Punches -> '+OUT+' ===');
log('Watch for: "PUNCH" lines = SUCCESS. TLS errors on :443 = the clock is PINNING (dead end).');
