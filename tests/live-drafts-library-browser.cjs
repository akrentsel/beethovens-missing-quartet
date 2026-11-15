// Test-only draft metadata server. No votes or drafts are written to production.
const {createServer}=require('node:http');const fs=require('node:fs');const path=require('node:path');
const assert=require('node:assert/strict');const {launch}=require('./browser.cjs');
const root=path.resolve(__dirname,'..'),cat=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/backend-catalog.json')));
let drafts=[],fail=false,calls=0;
const record={id:'bach-violin-sonata-1',requestId:'bach:violin-sonata:1',composerId:'bach',formId:'violin-sonata',title:'Test snapshot — not a new composition',revision:1,publishedAt:'2026-11-15T20:00:00Z',changeNote:'Opening phrase <script>not executable</script>',status:'composing',completedWorkId:null,movements:[{id:'i',label:'I. Adagio',bars:8}]};
const server=createServer((req,res)=>{
 const p=new URL(req.url,'http://localhost').pathname;
 const json=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(v))};
 if(p==='/config.json')return json({apiBaseUrl:'http://127.0.0.1:8896'});
 if(p==='/data/catalog.json')return json(cat);
 if(p==='/api/requests')return json({requests:[{id:'bach:violin-sonata:1',composerId:'bach',formId:'violin-sonata',round:1,status:'composing',votes:1,voted:false,createdAt:'2026-11-15T19:00:00Z',workId:null}],updatedAt:new Date().toISOString()});
 if(p==='/api/drafts'){calls++;return fail?json({error:'test offline'},503):json({drafts});}
 let file=path.join(root,p==='/'?'index.html':p);
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
 res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html');res.end(fs.readFileSync(file));
});
(async()=>{await new Promise(r=>server.listen(8896,'127.0.0.1',r));const p=await launch({width:1200,height:950});
const wait=async(expr,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await p.eval(expr))return;await p.sleep(100);}throw Error('Timed out: '+expr)};
try{
 await p.open('http://127.0.0.1:8896/#composer/bach');
 await wait("document.querySelector('.draft-waiting')?.textContent.includes('first playable snapshot')");assert.equal(await p.eval("document.querySelectorAll('.draft-record').length"),0);
 drafts=[record];await wait("document.querySelectorAll('.draft-record').length===1");assert.ok(calls>=2,'published snapshot discovered by scheduled polling');
 assert.equal(await p.eval("document.querySelector('.draft-record .button-link').getAttribute('href')"),'work.html?draft=bach-violin-sonata-1');
 assert.ok(await p.eval("document.querySelector('.draft-record').textContent.includes('8 written bars')"));assert.equal(await p.eval("document.querySelectorAll('.draft-record script').length"),0);
 await p.eval("location.hash='queue'");await p.sleep(100);assert.equal(await p.eval("document.querySelector('.draft-queue-link').textContent"),'Listen to draft');
 await p.eval("location.hash='composer/bach'");await p.sleep(100);fail=true;await p.eval("document.dispatchEvent(new Event('visibilitychange'))");await wait("document.querySelector('.live-drafts').textContent.includes('temporarily unavailable')");assert.equal(await p.eval("document.querySelectorAll('.draft-record').length"),1,'cached draft stays accessible offline');
 fail=false;drafts=[{...record,revision:2,movements:[{id:'i',label:'I. Adagio',bars:16}],status:'completed',completedWorkId:'bach-violin-sonata-1'}];
 await p.eval("[...document.querySelectorAll('.live-drafts button')].find(b=>b.textContent==='Try again').click()");await wait("document.querySelector('.draft-record .button-link').textContent.includes('finished')");
 assert.equal(await p.eval("document.querySelector('.draft-record .button-link').getAttribute('href')"),'work.html?id=bach-violin-sonata-1');
 await p.send('Emulation.setDeviceMetricsOverride',{width:375,height:900,deviceScaleFactor:1,mobile:false});await p.shot('/tmp/mw-live-draft-library-mobile.png');assert.ok(await p.eval('document.documentElement.scrollWidth<=375'));
 assert.equal(p.logs.filter(x=>x.startsWith('EXCEPTION:')).length,0,p.logs.join('\n'));
 console.log('PASS live draft discovery: empty state, scheduled first snapshot, bar count, safe text, queue link, offline retention, completion link, mobile layout.');
}finally{await p.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1});
