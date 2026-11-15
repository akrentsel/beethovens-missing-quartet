import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolvePublicPath} from '../server/static.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const original=createRequire(import.meta.url)('../server/vendor/abcjs.cjs');
const module={exports:{}};vm.runInNewContext(fs.readFileSync(new URL('../assets/vendor/abcjs-basic-min.js',import.meta.url),'utf8'),{module,exports:module.exports,console});
const fixed=module.exports;
const abc=(key,body,extra='')=>`X:1\nT:TEST ONLY\nM:4/4\nL:1/4\nQ:1/4=120\nK:${key}\n${extra}${body}\n`;
const sequence=(source,lib=fixed)=>lib.parseOnly(source)[0].setUpAudio();
const notes=(source,lib=fixed)=>sequence(source,lib).tracks[0].filter(e=>e.cmd==='note');
const pitches=ns=>[...new Set(ns.map(n=>n.pitch))].sort((a,b)=>a-b);
const between=(ns,a,b)=>ns.filter(n=>n.start>=a-1e-7&&n.start<b-1e-7);
const CASES=[
 ['C','E',[64,65]],['C','B',[71,72]],['C','D',[62,64]],
 ['G','F',[66,67]],['G','E',[64,66]],['D','C',[61,62]],
 ['F','A',[69,70]],['Bb','D',[62,63]],['Eb','G',[67,68]],
 ['Ab','C',[60,61]],['Db','F',[65,66]],['Gb','B',[70,71]],
 ['Em','F',[66,67]],['Dm','E',[64,65]],['Am','B',[71,72]],
 ['Bm','F',[66,67]],['Cmix','B',[70,72]],['Edor','F',[66,67]],
 ['C','B,',[59,60]],['C','b',[83,84]],['C','e\'',[88,89]],
];
test('upstream bug reproduced: E-F# and F#-G# instead of diatonic neighbours',()=>{
 assert.deepEqual(pitches(notes(abc('C','!trill!E4 |]'),original)),[64,66]);
 assert.deepEqual(pitches(notes(abc('Em','!trill!F4 |]'),original)),[66,68]);
 assert.equal(fixed.missingWorksTrillPatch,'key-aware-v1');
});
for(const [key,note,expected] of CASES)test(`trill on ${note} in ${key}: ${expected.join('/')}`,()=>{
 const ns=notes(abc(key,`!trill!${note}4 |]`));assert.deepEqual(pitches(ns),expected);
 // Keep the original upper-note-first rhythm, velocity and instrument.
 const before=notes(abc(key,`!trill!${note}4 |]`),original);assert.equal(ns.length,before.length);
 for(let i=0;i<ns.length;i++)for(const k of ['start','duration','volume','instrument','gap'])assert.equal(ns[i][k],before[i][k]);
});
test('principal accidentals are respected, including enharmonic and augmented neighbours',()=>{
 for(const [key,note,expected] of [['C','^F',[66,67]],['D','=F',[65,67]],['C','_F',[64,67]],['C','^^F',[67]],['C','__B',[69,72]]])assert.deepEqual(pitches(notes(abc(key,`!trill!${note}4 |]`))),expected);
});
test('upper-note bar accidental applies, then resets at the barline',()=>{
 const ns=notes(abc('C','^F !trill!E F E | !trill!E4 |]'));
 assert.deepEqual(pitches(between(ns,.25,.5)),[64,66]);
 assert.equal(between(ns,.5,.75)[0].pitch,66,'looking up auxiliary does not alter later F');
 assert.deepEqual(pitches(between(ns,1,2)),[64,65]);
});
test('natural cancels key accidental within the bar, not in the next bar',()=>{
 const ns=notes(abc('G','=F !trill!E F E | !trill!E4 |]'));
 assert.deepEqual(pitches(between(ns,.25,.5)),[64,65]);assert.deepEqual(pitches(between(ns,1,2)),[64,66]);
});
test('auxiliary accidentals can create augmented seconds and are octave-specific',()=>{
 assert.deepEqual(pitches(between(notes(abc('C','^G !trill!F3 |]')),.25,1)),[65,68]);
 assert.deepEqual(pitches(between(notes(abc('C','^f !trill!E3 |]')),.25,1)),[64,65]);
 assert.deepEqual(pitches(between(notes(abc('C','^^F !trill!E3 |]')),.25,1)),[64,67]);
});
test('inline key changes select the new upper note',()=>{
 const ns=notes(abc('C','!trill!E4 | [K:G] !trill!E4 | [K:F] !trill!A4 |]'));
 assert.deepEqual(pitches(between(ns,0,1)),[64,65]);assert.deepEqual(pitches(between(ns,1,2)),[64,66]);assert.deepEqual(pitches(between(ns,2,3)),[69,70]);
});
test('bar accidentals stay in their own voice',()=>{
 const source='X:1\nM:4/4\nL:1/4\nQ:1/4=120\n%%score 1 2\nV:1 clef=treble\nV:2 clef=treble\nK:C\n[V:1] ^F !trill!E3 |]\n[V:2] G !trill!E3 |]\n';
 const tracks=sequence(source).tracks;
 assert.deepEqual(pitches(between(tracks[0].filter(e=>e.cmd==='note'),.25,1)),[64,66]);
 assert.deepEqual(pitches(between(tracks[1].filter(e=>e.cmd==='note'),.25,1)),[64,65]);
});
test('repeats retain diatonic trills and total duration',()=>{
 const source=abc('C','|: !trill!E4 | !trill!B4 :|');
 const a=sequence(source),b=sequence(source,original);assert.equal(a.totalDuration,b.totalDuration);
 assert.deepEqual(pitches(a.tracks[0].filter(e=>e.cmd==='note')),[64,65,71,72]);
});
test('transposition shifts principal and auxiliary together',()=>{
 assert.deepEqual(pitches(notes(abc('C','!trill!E4 |]','%%MIDI transpose 12\n'))),[76,77]);
 assert.deepEqual(pitches(notes(abc('C clef=treble-8','!trill!E4 |]'))),[52,53]);
});
test('explicit trillh half-step override remains unchanged',()=>{
 const source=abc('C','!trillh!D4 |]');assert.deepEqual(pitches(notes(source)),[62,63]);
 assert.equal(JSON.stringify(sequence(source)),JSON.stringify(sequence(source,original)));
});
test('plain notes and other ornaments retain upstream behaviour',()=>{
 for(const body of ['C D E F |]','^F F =F F |]','!mordent!E4 |]','!turn!E4 |]','!uppermordent!E4 |]'])assert.equal(JSON.stringify(sequence(abc('G',body))),JSON.stringify(sequence(abc('G',body),original)));
});
test('microtonal trills still use valid sample pitches and retain cent offsets',()=>{
 const ns=notes(abc('C','!trill!^/F4 |]'));assert.ok(ns.every(n=>Number.isInteger(n.pitch)));
 assert.ok(ns.some(n=>n.pitch===65&&n.cents===50));assert.ok(ns.some(n=>n.pitch===67&&n.cents===undefined));
});
function midiPitches(bytes){
 const b=Buffer.from(bytes),out=[];assert.equal(b.toString('ascii',0,4),'MThd');let p=8+b.readUInt32BE(4);
 while(p<b.length){assert.equal(b.toString('ascii',p,p+4),'MTrk');const end=p+8+b.readUInt32BE(p+4);p+=8;let status=0;
  const vl=()=>{let n=0,v;do{v=b[p++];n=(n<<7)|(v&127)}while(v&128);return n};
  while(p<end){vl();if(b[p]&128)status=b[p++];if(status===255){p++;const n=vl();p+=n;}else if(status===240||status===247){const n=vl();p+=n;}else{const kind=status&240,a=b[p++];const c=kind===192||kind===208?null:b[p++];if(kind===144&&c>0)out.push(a);}}
 }
 return [...new Set(out)].sort((a,b)=>a-b);
}
test('MIDI export receives the same corrected trill pitches as audio',()=>{
 const tune=fixed.parseOnly(abc('Em','!trill!F4 |]'))[0];
 assert.deepEqual(midiPitches(fixed.synth.getMidiFile(tune,{midiOutputType:'binary'})),[66,67]);
});
test('local static server allows only the two public vendor files',()=>{
 assert.equal(resolvePublicPath('/assets/vendor/abcjs-basic-min.js'),'assets/vendor/abcjs-basic-min.js');
 assert.equal(resolvePublicPath('/assets/vendor/abcjs_basic.LICENSE'),'assets/vendor/abcjs_basic.LICENSE');
 assert.equal(resolvePublicPath('/assets/vendor/abcjs.cjs'),null);
 assert.equal(resolvePublicPath('/assets/vendor/../../server/db.mjs'),null);
});
test('generated patch is reproducible and both player pages use it',()=>{
 execFileSync(process.execPath,['tools/build-abcjs.mjs','--check'],{cwd:root});
 for(const file of ['work.html','beethoven.html']){const s=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');assert.ok(s.includes('src="assets/vendor/abcjs-basic-min.js"'));assert.ok(!s.includes('src="https://cdn.jsdelivr.net/npm/abcjs@'));}
});
