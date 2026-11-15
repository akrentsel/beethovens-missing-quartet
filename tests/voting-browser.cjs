// Real HTTP + SQLite integration. Uses a disposable DB and controlled voter IDs, never production votes.
const {launch}=require('./browser.cjs');
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const dir=mkdtempSync(join(tmpdir(),'mw-vote-e2e-')),base='http://127.0.0.1:8891';
let server,p;
async function start(){server=spawn(process.execPath,['server/index.mjs'],{cwd:resolve(__dirname,'..'),env:{...process.env,PORT:'8891',DB_PATH:join(dir,'votes.sqlite'),SERVE_STATIC:'true',ALLOWED_ORIGINS:base},stdio:['ignore','pipe','pipe']});let err='';server.stderr.on('data',x=>err+=x);for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Server startup failed: '+err);}
async function stop(){if(server&&server.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await done;}}
async function wait(expr,ms=15000){const t=Date.now();while(Date.now()-t<ms){if(await p.eval(expr))return;await p.sleep(100);}throw Error('Timed out '+expr);}
const A=randomUUID(),B=randomUUID(),id='brahms:symphony:1';
async function list(token){return (await (await fetch(base+'/api/requests',{headers:{'X-Voter-Token':token}})).json()).requests.find(r=>r.id===id);}
async function set(token,voted){const r=await fetch(base+'/api/votes',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Voter-Token':token},body:JSON.stringify({requestId:id,voted})});assert.equal(r.status,200);return (await r.json()).request;}
(async()=>{try{
 await start();p=await launch({width:1050,height:1050});await p.open(base+'/');
 await p.eval(`localStorage.setItem('missing-works-voter-v1',${JSON.stringify(A)})`);
 await p.open(base+'/?client=A#composer/brahms');await p.eval("document.querySelector('[data-form=symphony]').click()");
 await wait("!!document.querySelector('[data-vote-id]')&&!document.querySelector('[data-vote-id]').disabled");
 assert.equal((await list(A)).votes,0);
 await p.eval("document.querySelector('[data-vote-id]').click()");
 await wait("document.querySelector('.inline-status').textContent.includes('saved')");
 assert.equal((await list(A)).votes,1);assert.equal((await list(B)).voted,false);
 assert.equal((await set(A,true)).votes,1,'duplicate request is idempotent');
 assert.equal((await set(B,true)).votes,2,'independent voter shares the same DB');
 await p.eval("[...document.querySelectorAll('button')].find(b=>b.textContent==='Refresh totals').click()");await wait("document.querySelector('.vote-count')?.textContent==='2'");
 await p.eval("document.querySelector('[data-vote-id]').click()");await wait("document.querySelector('.inline-status').textContent.includes('removed')");assert.equal((await list(A)).votes,1);
 await set(B,false);await set(A,true);await stop();await start();assert.equal((await list(A)).votes,1,'vote survives full server restart');
 // Re-open as a second browser identity: own vote=false, shared total=1.
 await p.eval(`localStorage.setItem('missing-works-voter-v1',${JSON.stringify(B)})`);await p.open(base+'/?client=B#composer/brahms');await p.eval("document.querySelector('[data-form=symphony]').click()");await wait("document.querySelector('.vote-count')?.textContent==='1'");
 assert.equal(await p.eval("document.querySelector('[data-vote-id]').getAttribute('aria-pressed')"),'false');
 await stop();await p.eval("document.querySelector('[data-vote-id]').click()");await wait("document.querySelector('.inline-status').textContent.includes('not confirmed')");assert.equal(await p.eval("document.querySelector('.vote-count').textContent"),'1','offline click never invents a new count');
 await p.shot('/tmp/mw-vote-error.png');
 await start();assert.equal((await list(B)).votes,1);assert.equal((await list(B)).voted,false);await set(A,false);
 assert.equal(p.logs.filter(s=>s.startsWith('EXCEPTION:')).length,0,p.logs.join('\n'));
 console.log('PASS real SQLite/browser voting: save, duplicate suppression, two identities, shared refresh, undo, server restart persistence, and offline failure without fake success.');
}finally{if(p)await p.close();await stop();rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
