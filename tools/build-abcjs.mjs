#!/usr/bin/env node
// Reproducible, deliberately narrow patch of the pinned upstream 6.5.2 bundle.
// No minifier/build toolchain is needed: reject any upstream change, then replace
// exactly three known spans. server/vendor/abcjs.cjs remains unmodified.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(root,'server/vendor/abcjs.cjs'),'utf8');
const expected='9a6ac915174d0cb06c5278247072cc2ab8f1f90e193a1988b3b0e6c9fcfb47b9';
if(createHash('sha256').update(source).digest('hex')!==expected)throw Error('Upstream abcjs bundle changed; review the patch against the new source.');
let output=source;
function once(before,after){if(output.split(before).length!==2)throw Error('Patch context must occur exactly once: '+before.slice(0,70));output=output.replace(before,after);}
// In upstream src/synth/abc_midi_flattener.js:
// F is doModifiedNotes; V is adjustPitch; G is adjustForMicroTone.
// y is the written note, and T is its resolved MIDI event.
once('function F(e,t){var r=t.start,n=t.duration,a=H(1/32);','function F(e,t,writtenNote){var r=t.start,n=t.duration,a=H(1/32);');
once('F(m.noteModification,T);','F(m.noteModification,T,y);');
const oldTrill='case"trill":for(var i=2;n>0;)u.push({cmd:"note",pitch:t.pitch+i,volume:t.volume,start:r,duration:a,gap:0,instrument:h,style:"decoration"}),i=2===i?0:2,n-=a,r+=a;break;';
const newTrill=`case "trill": {
  // Resolve the next WRITTEN diatonic pitch through the same key signature,
  // bar-accidental and transposition state as an ordinary note. No accidental
  // is supplied, so this lookup does not alter that state.
  var upper = writtenNote && typeof writtenNote.pitch === "number" &&
    writtenNote.midipitch === undefined && writtenNote.actualPitch === undefined
    ? G({ pitch: V({ pitch: writtenNote.pitch + 1 }) })
    : { pitch: t.pitch + 2, cents: t.cents };
  for (var i = 1; n > 0;) {
    var trillEvent = { cmd: "note", pitch: i ? upper.pitch : t.pitch,
      volume: t.volume, start: r, duration: a, gap: 0,
      instrument: h, style: "decoration" };
    var trillCents = i ? upper.cents : t.cents;
    if (trillCents !== undefined) trillEvent.cents = trillCents;
    u.push(trillEvent);
    i = 1 - i; n -= a; r += a;
  }
  break;
}`;
once(oldTrill,newTrill);
output='/*! Missing Works: key-aware trill playback patch v1. See docs/trill-playback.md. Upstream MIT license retained. */\n'+output+`\n;(function(root){var api=typeof module==="object"&&module.exports?module.exports:root.ABCJS;if(api)api.missingWorksTrillPatch="key-aware-v1";})(typeof window!=="undefined"?window:this);\n`;
const dir=path.join(root,'assets/vendor');
const license=fs.readFileSync(path.join(root,'server/vendor/abcjs.LICENSE.md'),'utf8')+'\n\nBundled third-party notices:\n'+fs.readFileSync(path.join(root,'server/vendor/abcjs-basic-min.js.LICENSE'),'utf8');
const args=process.argv.slice(2);if(args.some(a=>a!=='--check'))throw Error('Usage: node tools/build-abcjs.mjs [--check]');
if(args.includes('--check')){
 if(fs.readFileSync(path.join(dir,'abcjs-basic-min.js'),'utf8')!==output||fs.readFileSync(path.join(dir,'abcjs_basic.LICENSE'),'utf8')!==license)throw Error('Generated browser bundle or license is out of date.');
 console.log('Browser patch is reproducible; upstream hash and all patch contexts verified.');
}else{
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'abcjs-basic-min.js'),output);fs.writeFileSync(path.join(dir,'abcjs_basic.LICENSE'),license);
 console.log('Built assets/vendor/abcjs-basic-min.js; source SHA-256 verified; 3 exact patches applied.');
}
