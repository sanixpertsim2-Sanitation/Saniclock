#!/usr/bin/env node
/* probe-tc2.js — read the NG-TC2's identity + network + push config over 4370.
   READ-ONLY. Changes nothing on the device. Target defaults to 192.168.1.77. */
'use strict';
const net = require('net');
const TARGET = process.argv[2] || '192.168.1.77';
const PORT = 4370;
const USHRT = 65535;
const CMD = { CONNECT: 1000, EXIT: 1001, AUTH: 1102, ACKOK: 2000, UNAUTH: 2005, OPTIONS_RRQ: 11 };
function chk(b){let s=0;for(let i=0;i<b.length;i+=2){s+=(i===b.length-1)?b[i]:b.readUInt16LE(i);s%=USHRT;}return USHRT-s-1;}
function hdr(cmd,sid,rid,data){const d=Buffer.from(data||[]);const b=Buffer.alloc(8+d.length);b.writeUInt16LE(cmd,0);b.writeUInt16LE(sid,4);b.writeUInt16LE(rid,6);d.copy(b,8);b.writeUInt16LE(chk(b),2);b.writeUInt16LE((rid+1)%USHRT,6);const p=Buffer.from([0x50,0x50,0x82,0x7d,0,0,0,0]);p.writeUInt16LE(b.length,4);return Buffer.concat([p,b]);}
function dec(p){const i=p.subarray(8);return{cmd:i.readUInt16LE(0),sid:i.readUInt16LE(4),data:p.subarray(16)};}
function ck(key,sid,t=50){key>>>=0;sid>>>=0;let k=0;for(let i=0;i<32;i++)k=(key&(1<<i))?(((k<<1)|1)>>>0):((k<<1)>>>0);k=(k+sid)>>>0;const b=Buffer.alloc(4);b.writeUInt32LE(k,0);b[0]^=0x5A;b[1]^=0x4B;b[2]^=0x53;b[3]^=0x4F;const h0=b.readUInt16LE(0),h1=b.readUInt16LE(2);const b2=Buffer.alloc(4);b2.writeUInt16LE(h1,0);b2.writeUInt16LE(h0,2);const B=t&0xff;b2[0]^=B;b2[1]^=B;b2[2]=B;b2[3]^=B;return b2;}
const sock=new net.Socket();let buf=Buffer.alloc(0),onP=null,sid=0,rid=0;
sock.on('data',c=>{buf=Buffer.concat([buf,c]);while(buf.length>=8){const sz=buf.readUInt16LE(4);if(buf.length<8+sz)break;const pk=buf.subarray(0,8+sz);buf=buf.subarray(8+sz);if(onP)onP(pk);}});
function once(){return new Promise(r=>{onP=p=>{onP=null;r(p);};});}
function sr(cmd,data){const p=once();rid++;sock.write(hdr(cmd,sid,rid,data));return p;}
async function g(n){const p=await sr(CMD.OPTIONS_RRQ,Buffer.from(n+'\0','ascii'));return dec(p).data.toString('latin1').replace(/\0+$/,'');}
(async()=>{
  console.log('=== NG-TC2 PROBE (read-only) target '+TARGET+':4370 ===');
  await new Promise((res,rej)=>{sock.setTimeout(9000);sock.once('timeout',()=>rej(new Error('timeout - not reachable')));sock.connect(PORT,TARGET,res);});
  let p=await sr(CMD.CONNECT,Buffer.from([]));let h=dec(p);sid=h.sid;
  if(h.cmd===CMD.UNAUTH){rid=1;p=await sr(CMD.AUTH,ck(0,sid));h=dec(p);if(h.cmd!==CMD.ACKOK){console.log('AUTH FAILED (commkey not 0)');process.exit(1);}}
  console.log('AUTH OK (commkey 0)\n--- IDENTITY ---');
  for(const k of ['~SerialNumber','~DeviceName','~OEMVendor','~ProductTime','FirmVer','~ZKFPVersion','~PlatformKind']){
    try{const v=await g(k);console.log('  '+(v||k+': (empty)'));}catch(e){}
  }
  console.log('--- NETWORK (is it DHCP or static? can we redirect?) ---');
  for(const k of ['IPAddress','NetMask','GATEIPAddress','DNS','DHCP','EnableDHCP','IPMode','NetIPMode','DNSServer','SecondaryDNS','MAC']){
    try{const v=await g(k);console.log('  '+(v||k+': (empty)'));}catch(e){}
  }
  console.log('--- PUSH / CLOUD (how it phones home) ---');
  for(const k of ['WebServerIP','WebServerPort','ServerIP','ServerPort','WebServerURL','WebServerDomain','~ServerName','TransFlag','TransTimes','TransInterval','Realtime','PushProtVer','PushVersion','EnableADMS','SupportServerMode','ComProtocol','Encrypt','HttpsEnable','SSLEnable','CloudServerHost','CloudServerPort','BestServer','~PushOption','PushSDKVer']){
    try{const v=await g(k);console.log('  '+(v||k+': (empty)'));}catch(e){}
  }
  await sr(CMD.EXIT,Buffer.from([])).catch(()=>{});
  sock.destroy();
  console.log('\n=== DONE — copy everything above and send it back ===');
  process.exit(0);
})().catch(e=>{console.log('ERROR:',e.message);process.exit(1);});
