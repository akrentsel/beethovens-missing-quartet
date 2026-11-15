const {launch}=require('./browser.cjs');
const assert=require('node:assert/strict');
const BASE=process.env.TEST_BASE_URL||'http://127.0.0.1:8890/';
const wait=async(p,expr,ms=10000)=>{const t=Date.now();while(Date.now()-t<ms){if(await p.eval(expr))return;await p.sleep(100);}throw Error('Timed out: '+expr)};
(async()=>{
 const p=await launch({width:1280,height:1050});
 try{
  await p.open(BASE);await wait(p,"document.querySelectorAll('.composer-row').length===36");
  assert.equal(await p.eval("document.querySelectorAll('.era-section').length"),5);
  await p.eval("document.getElementById('composer-search').value='dvorak';document.getElementById('composer-search').dispatchEvent(new Event('input'))");
  assert.equal(await p.eval("document.querySelectorAll('.composer-row').length"),1);
  assert.ok(await p.eval("document.querySelector('.composer-name').textContent.includes('Dvořák')"));
  await p.eval("document.getElementById('composer-search').value='';document.getElementById('composer-search').dispatchEvent(new Event('input'));document.querySelector('[data-era=american]').click()");
  assert.equal(await p.eval("document.querySelectorAll('.composer-row').length"),8);
  await p.eval("location.hash='composer/shostakovich'");await p.sleep(150);
  assert.equal(await p.eval("document.querySelector('h1').textContent"),'Shostakovich');
  assert.equal(await p.eval("document.querySelectorAll('[data-form]').length"),4);
  assert.ok(await p.eval("document.querySelector('.empty-state').textContent.includes('Nothing on this shelf')"));
  await p.eval("document.querySelector('[data-form=piano-sonata]').click()");
  assert.equal(await p.eval("document.querySelector('[data-form=piano-sonata]').getAttribute('aria-pressed')"),'true');
  await p.eval("location.hash='composer/beethoven'");await p.sleep(150);
  assert.equal(await p.eval("document.querySelectorAll('.work-record').length"),1);
  assert.ok(await p.eval("document.querySelector('.work-record a.button-link').href.includes('work.html?id=beethoven-quartet-d-minor')"));
  await p.shot('/tmp/mw-composer-tested.png');
  await p.eval("location.hash='works'");await p.sleep(150);assert.equal(await p.eval("document.querySelectorAll('.work-record').length"),1);
  await p.eval("location.hash='queue'");await p.sleep(150);assert.equal(await p.eval("document.querySelector('h1').textContent"),'The next work');
  await p.eval("location.hash='composer/not-real'");await p.sleep(150);assert.ok(await p.eval("document.querySelector('h1').textContent.includes('not here')"));
  await p.eval("location.hash='browse'");await p.sleep(150);
  await p.send('Emulation.setDeviceMetricsOverride',{width:375,height:950,deviceScaleFactor:1,mobile:false});
  await p.shot('/tmp/mw-mobile-tested.png');assert.ok(await p.eval('document.documentElement.scrollWidth<=375'));
  await p.eval("location.hash='composer/beethoven'");await p.sleep(150);assert.ok(await p.eval('document.documentElement.scrollWidth<=375'));
  assert.equal(p.logs.filter(s=>s.startsWith('EXCEPTION:')).length,0,p.logs.join('\n'));
  console.log('PASS library: 36 composers, five groups, search, era filter, empty shelves, forms, work links, queue, invalid route, mobile overflow.');
 }finally{await p.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
