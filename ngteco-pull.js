#!/usr/bin/env node
// ngteco-pull.js - pulls punches from NGTeco cloud into the dashboard's raw CSV.
// Zero-dependency. Reads NGTECO_TOKEN from /opt/saniclock/.ngteco.env.
'use strict';
const https=require('https'), fs=require('fs'), path=require('path');
const ENVF='/opt/saniclock/.ngteco.env';
const OUT='/opt/saniclock/data/punch.csv';
const HEADER='Person ID,Person Name,Punch Date,Attendance record,Verify Type,TimeZone,Source';
function env(k){try{const t=fs.readFileSync(ENVF,'utf8');const m=t.match(new RegExp('^'+k+'=(.*)$','m'));return m?m[1].trim():'';}catch{return '';}}
const TOKEN=process.env.NGTECO_TOKEN||env('NGTECO_TOKEN');
function log(m){console.log('['+new Date().toISOString()+'] '+m);}
if(!TOKEN){log('No NGTECO_TOKEN in env file - cannot pull. Paste a fresh token into '+ENVF);process.exit(2);}
function daysAgo(n){const d=new Date(Date.now()-n*864e5);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
const START=process.argv[2]||daysAgo(14), END=process.argv[3]||daysAgo(0);
function get(page){return new Promise((res,rej)=>{
  const q='current='+page+'&pageSize=100&keyword=&date_range='+START+'&date_range='+END;
  const req=https.request({host:'office-api.ngteco.com',path:'/att/api/v1.0/transactions/transaction/?'+q,method:'GET',
    headers:{'Authorization':'Bearer '+TOKEN,'accessor':'Web','accept':'application/json','origin':'https://office.ngteco.com','referer':'https://office.ngteco.com/'}},
    r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{if(r.statusCode===401)return rej(new Error('AUTH 401 - token expired, refresh it'));try{res(JSON.parse(d));}catch(e){rej(new Error('bad JSON http '+r.statusCode));}});});
  req.on('error',rej);req.end();
});}
function esc(v){return String(v==null?'':v).replace(/["\r\n]/g,'').replace(/,/g,' ').replace(/ {2,}/g,' ').trim();}
(async()=>{
  let page=1,rows=[],total=null;
  while(true){
    const j=await get(page);const data=(j.data&&j.data.data)||[];
    if(total===null)total=(j.data&&j.data.total)||0;
    for(const r of data){rows.push([esc(r.employee_code),esc(r.employee_name||r.employee_code),esc(r.att_date),esc(r.attendance_status),esc(r.verify_type),'',esc(r.punch_from)].join(','));}
    if(page*100>=total||data.length===0)break;page++;
  }
  fs.writeFileSync(OUT,HEADER+'\n'+rows.join('\n')+'\n');
  log('Pulled '+rows.length+' punches ('+START+'..'+END+') -> '+OUT);
})().catch(e=>{log('PULL FAILED: '+e.message);process.exit(1);});
