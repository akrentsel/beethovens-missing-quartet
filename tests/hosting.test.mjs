import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const redirect=fs.readFileSync(new URL('../assets/legacy-host.js',import.meta.url),'utf8');
function target(hostname,pathname,search='',hash=''){let result=null;vm.runInNewContext(redirect,{location:{hostname,pathname,search,hash,replace:s=>result=s}});return result;}
test('old Pages links redirect to matching VM paths, including composer and transcript anchors',()=>{
 assert.equal(target('akrentsel.github.io','/beethovens-missing-quartet/','','#composer/brahms'),'https://lost-compositions.exe.xyz/#composer/brahms');
 assert.equal(target('akrentsel.github.io','/beethovens-missing-quartet/work.html','?id=beethoven-quartet-d-minor'),'https://lost-compositions.exe.xyz/work.html?id=beethoven-quartet-d-minor');
 assert.equal(target('akrentsel.github.io','/beethovens-missing-quartet/transcript.html','','#entry-0040'),'https://lost-compositions.exe.xyz/transcript.html#entry-0040');
 assert.equal(target('lost-compositions.exe.xyz','/'),null);
 assert.equal(target('akrentsel.github.io','/another-project/'),null);
});
test('VM public bundle excludes backend, raw histories, tests and database files',()=>{
 const paths=fs.readFileSync(new URL('../deploy/public-files.txt',import.meta.url),'utf8').trim().split('\n');
 assert.equal(new Set(paths).size,paths.length);
 for(const path of paths){assert.ok(!path.includes('..'));assert.ok(!/^(server|tests|deploy|docs|private-history|var)\//.test(path));assert.ok(!/\.(sqlite|db|env)$/.test(path));const file=new URL('../'+path,import.meta.url);assert.ok(fs.statSync(file).isFile(),path);assert.ok(!fs.lstatSync(file).isSymbolicLink(),path);}
 for(const required of ['index.html','work.html','transcript.json','config.json','data/catalog.json','assets/legacy-host.js'])assert.ok(paths.includes(required));
});
