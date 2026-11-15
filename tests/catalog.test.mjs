import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {matchingComposers,rankRequests,validApiBase,formatDuration} from '../assets/library.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const catalog=JSON.parse(fs.readFileSync(path.join(root,'data/catalog.json'),'utf8'));
test('catalogue has the approved 36 composers in five populated groups and four forms',()=>{
 assert.equal(catalog.composers.length,36);assert.equal(catalog.eras.length,5);assert.equal(catalog.forms.length,4);
 for(const group of catalog.eras){const n=catalog.composers.filter(c=>c.eraId===group.id).length;assert.ok(n>=5&&n<=10,group.id);}
 for(const key of ['composers','eras','forms','works'])assert.equal(new Set(catalog[key].map(x=>x.id)).size,catalog[key].length);
 for(const c of catalog.composers)assert.ok(catalog.eras.some(e=>e.id===c.eraId));
 for(const id of ['beethoven','sibelius','brahms','shostakovich','stravinsky','price','adams'])assert.ok(catalog.composers.some(c=>c.id===id));
});
test('work manifests point only to existing relative public files and correct composer/form',()=>{
 assert.equal(catalog.works.length,1,'no fictional completed pieces');
 for(const w of catalog.works){assert.ok(catalog.composers.some(c=>c.id===w.composerId));assert.ok(catalog.forms.some(f=>f.id===w.formId));assert.equal(w.status,'completed');assert.ok(w.movements.length>0);
  for(const p of [w.notebook,w.transcript,w.legacyUrl,...w.movements.map(m=>m.source)]){assert.ok(!p.includes('..')&&!p.includes('://')&&!p.startsWith('/'));assert.ok(fs.existsSync(path.join(root,p)),p);}
  assert.equal(w.durationSeconds,w.movements.reduce((s,m)=>s+m.durationSeconds,0));
 }
 assert.equal(catalog.works[0].movements.length,4);
});
test('search ignores diacritics and combines with era filter',()=>{
 assert.equal(matchingComposers(catalog,'dvorak')[0].id,'dvorak');
 assert.equal(matchingComposers(catalog,'Bach').length,2);
 assert.equal(matchingComposers(catalog,'Bach','baroque').length,1);
 assert.equal(matchingComposers(catalog,'missing-composer').length,0);
});
test('rank is deterministic and never mutates input',()=>{
 const rows=[{id:'b',votes:2,createdAt:'2026-01-01'},{id:'a',votes:2,createdAt:'2026-01-01'},{id:'z',votes:3,createdAt:'2026-02-01'}];
 assert.deepEqual(rankRequests(rows).map(r=>r.id),['z','a','b']);assert.equal(rows[0].id,'b');
});
test('API URL validation prevents credentials and insecure public endpoints',()=>{
 assert.equal(validApiBase('', 'https://example.com'),'');
 assert.equal(validApiBase('https://lost-compositions.exe.xyz/','https://example.com'),'https://lost-compositions.exe.xyz');
 assert.equal(validApiBase('/','http://localhost:3000'),'http://localhost:3000');
 for(const u of ['http://example.com','https://user:pass@example.com','https://example.com?token=bad','javascript:alert(1)'])assert.throws(()=>validApiBase(u,'https://example.com'));
 assert.equal(formatDuration(1085),'18:05');
});
