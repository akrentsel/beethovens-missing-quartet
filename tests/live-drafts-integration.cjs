// Real draft store/API/player integration, using a temporary local DB and TEST-ONLY music.
const {launch}=require('./browser.cjs');const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');const {join}=require('node:path');const {tmpdir}=require('node:os');
(async()=>{
 const {createApp}=await import('../server/app.mjs');const {publishDraft}=await import('../server/drafts.mjs');const {validatePayload}=await import('../server/draft-validation.mjs');
 const dir=mkdtempSync(join(tmpdir(),'mw-real-drafts-')),base='http://127.0.0.1:8898';let p;
 const app=createApp({dbPath:join(dir,'votes.sqlite'),draftRoot:join(dir,'drafts'),allowedOrigins:[base],serveStatic:true});
 const abc=n=>`X:1\nT:TEST ONLY — not a composition\nM:4/4\nL:1/8\nQ:1/4=120\n%%score 1 {2 3}\nV:1 clef=treble name="Violin"\nV:2 clef=treble name="Keyboard RH"\nV:3 clef=bass name="Keyboard LH"\nK:C\nV:1\n%%MIDI program 40\nV:2\n%%MIDI program 0\nV:3\n%%MIDI program 0\n[V:1] ${'c8 | '.repeat(n).trim()}]\n[V:2] ${'G8 | '.repeat(n).trim()}]\n[V:3] ${'C,8 | '.repeat(n).trim()}]\n`;
 const publish=(n,expected)=>publishDraft({root:join(dir,'drafts'),store:app.store,payload:validatePayload({id:'test-integration-draft',requestId:'bach:violin-sonata:1',title:'TEST ONLY — live API integration',changeNote:`Test snapshot of ${n} bars`,expectedRevision:expected,movements:[{id:'i',label:'Test movement',abc:abc(n)}]})});
 try{
 app.store.startRequest('bach:violin-sonata:1');publish(8,0);
 await new Promise(r=>app.server.listen(8898,'127.0.0.1',r));p=await launch({width:1100,height:950});
 const wait=async(e,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await p.eval(e))return;await p.sleep(100);}throw Error('Timed out '+e)};
 await p.open(base+'/work.html?draft=test-integration-draft');await wait('window.mwPlayer&&mwPlayer.revision()===1');
 assert.equal(await p.eval("document.querySelectorAll('#pl-parts button').length"),3);
 await p.eval("document.getElementById('pl-play').click()");await wait("mwPlayer.state()==='playing'");
 const before=await p.eval("document.getElementById('pl-abc').value");publish(10,1);await p.eval('mwPlayer.checkDraft()');await p.sleep(300);
 assert.equal(await p.eval('mwPlayer.revision()'),1);assert.equal(await p.eval("document.getElementById('pl-abc').value"),before);
 assert.equal(await p.eval("document.getElementById('pl-update').hidden"),false);
 await p.eval("document.getElementById('pl-stop').click()");await wait('mwPlayer.revision()===2');
 assert.equal(await p.eval('mwPlayer.state()'),'idle');
 assert.notEqual(await p.eval("document.getElementById('pl-abc').value"),before);
 const old=await(await fetch(base+'/api/drafts/test-integration-draft/revisions/1/i.abc')).text();assert.equal(old,abc(8));
 assert.equal(p.logs.filter(x=>x.startsWith('EXCEPTION:')).length,0,p.logs.join('\n'));
 console.log('PASS real draft API/player: validated three-part snapshot, actual audio, pinned playing score, Stop-and-follow revision2 without autoplay, immutable revision1.');
 }finally{if(p)await p.close();await app.close();rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
