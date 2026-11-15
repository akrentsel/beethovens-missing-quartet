// Verify patched pitches reach both rendered audio and MIDI in the actual browser player.
// Uses tab-local source edits only; never publishes scores or changes votes.
const {launch}=require('./browser.cjs');const assert=require('node:assert/strict');
const BASE=process.env.TEST_BASE_URL||'http://127.0.0.1:8894/';
(async()=>{const p=await launch({width:1100,height:950});
const wait=async(e,ms=30000)=>{const t=Date.now();while(Date.now()-t<ms){if(await p.eval(e))return;await p.sleep(100);}throw Error('Timed out: '+e)};
try{
 await p.open(BASE+'work.html?id=beethoven-quartet-d-minor');
 assert.equal(await p.eval('ABCJS.missingWorksTrillPatch'),'key-aware-v1');
 const source='X:1\nT:TEST ONLY — trill playback\nM:4/4\nL:1/8\nQ:1/4=120\nV:1 clef=treble name="Flute"\nK:C\nV:1\n%%MIDI program 73\n!trill!E8 |]';
 await p.eval(`document.getElementById('pl-abc').value=${JSON.stringify(source)};document.getElementById('pl-abc').dispatchEvent(new Event('input'))`);
 await p.sleep(600);await p.eval("document.getElementById('pl-play').click()");await wait("mwPlayer.state()==='playing'");
 const sound=await p.eval(`(()=>{const mb=mwPlayer.synth().midiBuffer;const pitches=[...new Set(mb.flattened.tracks[0].filter(e=>e.cmd==='note').map(e=>e.pitch))].sort((a,b)=>a-b);const b=mb.audioBuffers[0];let peak=0;for(let c=0;c<b.numberOfChannels;c++){const d=b.getChannelData(c);for(let i=0;i<d.length;i++)peak=Math.max(peak,Math.abs(d[i]));}return {pitches,peak,seconds:b.duration}})()`);
 assert.deepEqual(sound.pitches,[64,65]);assert.ok(sound.peak>0&&sound.peak<=1);
 const midi=await p.eval(`(()=>{const t=ABCJS.parseOnly(document.getElementById('pl-abc').value)[0];const bytes=ABCJS.synth.getMidiFile(t,{midiOutputType:'binary'});return {header:Array.from(bytes.slice(0,4)),notes:[...new Set(t.setUpAudio().tracks[0].filter(e=>e.cmd==='note').map(e=>e.pitch))].sort((a,b)=>a-b)}})()`);
 assert.deepEqual(midi.header,[77,84,104,100]);assert.deepEqual(midi.notes,[64,65]);
 await p.open(BASE+'beethoven.html');assert.equal(await p.eval('ABCJS.missingWorksTrillPatch'),'key-aware-v1');
 const legacySource='X:1\nM:4/4\nL:1/4\nK:Em\n!trill!F4 |]';
 const legacy=await p.eval(`(()=>{const t=ABCJS.parseOnly(${JSON.stringify(legacySource)})[0];return [...new Set(t.setUpAudio().tracks[0].filter(e=>e.cmd==='note').map(e=>e.pitch))].sort((a,b)=>a-b)})()`);
 assert.deepEqual(legacy,[66,67]);
 assert.equal(p.logs.filter(x=>x.startsWith('EXCEPTION:')).length,0,p.logs.join('\n'));
 console.log('PASS browser: key-aware audio pitches, non-silent buffer, MIDI header/pitches, and legacy player patch.',sound);
}finally{await p.close()}})().catch(e=>{console.error(e);process.exitCode=1});
