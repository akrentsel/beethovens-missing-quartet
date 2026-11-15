const TOKEN_KEY='missing-works-voter-v1';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const normalize=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export const formatDuration=s=>`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
export function rankRequests(rows){return [...rows].sort((a,b)=>b.votes-a.votes||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));}
export function matchingComposers(catalog,query='',era=''){const q=normalize(query.trim());return catalog.composers.filter(c=>(!era||c.eraId===era)&&(!q||normalize(c.name+' '+c.shortName).includes(q)));}
export function validApiBase(value,origin){
 if(!value)return '';
 const u=new URL(value,origin);if(u.username||u.password||u.search||u.hash)throw Error('Invalid API address');
 if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw Error('The voting service must use HTTPS.');
 return u.href.replace(/\/$/,'');
}
if(typeof document!=='undefined')boot();
async function boot(){
 const $=id=>document.getElementById(id),root=$('main');
 const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 const link=(text,url,cls)=>{const a=el('a',text,cls);a.href=url;return a;};
 const button=(text,fn,cls)=>{const b=el('button',text,cls);b.type='button';b.addEventListener('click',fn);return b;};
 let catalog,base='',requests=[],apiState='loading',apiError='',lastUpdated='',token=null,storageError=false,sequence=0;
 let selectedEra='',query='',selectedForm='string-quartet',queueEra='',queueForm='',queueState='active',busy=new Set(),messages=new Map();
 function route(){const raw=location.hash.slice(1);if(!raw||raw==='browse')return {view:'browse'};if(raw==='works'||raw==='queue')return {view:raw};if(raw.startsWith('composer/'))return {view:'composer',id:raw.slice(9)};return {view:'missing'};}
 function composer(id){return catalog.composers.find(c=>c.id===id);}
 function form(id){return catalog.forms.find(f=>f.id===id);}
 function worksFor(id){return catalog.works.filter(w=>w.composerId===id);}
 function currentRequest(cId){return requests.find(r=>r.composerId===cId&&r.formId===selectedForm&&r.status!=='completed');}
 function makeHeader(title,subtitle,crumb){const h=el('section',undefined,'page-heading');if(crumb)h.append(link(crumb.text,crumb.url,'breadcrumb'));h.append(el('h1',title));if(subtitle)h.append(el('p',subtitle,'subtitle'));return h;}
 function playLink(w){const a=link('Listen & follow the score',`work.html?id=${encodeURIComponent(w.id)}`,'button-link');const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 12 14');svg.setAttribute('aria-hidden','true');const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M1 1L11 7L1 13Z');svg.append(path);a.prepend(svg);return a;}
 function featured(w){const f=el('article',undefined,'featured');f.append(el('p','First on the shelf','section-kicker'));f.firstChild.style.color='#d6e5e7';f.append(el('h2',w.title),el('p',`${w.subtitle || form(w.formId).label} · ${formatDuration(w.durationSeconds)} of music`,'meta'));const lines=el('div',undefined,'work-lines');lines.setAttribute('aria-hidden','true');['I','II','III','IV'].forEach(n=>lines.append(el('span',n)));f.append(lines,playLink(w));return f;}
 function workRecord(w){const a=el('article',undefined,'work-record');a.append(el('p',`Inspired by ${composer(w.composerId).shortName}`,'meta'),el('h3',w.title),el('p',w.description),el('p',`${form(w.formId).label} · ${w.movements.length} movements · ${formatDuration(w.durationSeconds)}`,'work-meta'),playLink(w));const links=el('div',undefined,'text-links');if(w.notebook)links.append(link('Composition notebook',w.notebook));if(w.transcript)links.append(link('Conversation logs',w.transcript));a.append(links);return a;}
 function apiNotice(){
  const n=el('div',undefined,'status-note');n.setAttribute('role','status');
  if(apiState==='loading')n.textContent='Connecting to the shared voting queue…';
  else if(apiState==='unconfigured')n.textContent='The library is open. Shared voting will open when the vote server is connected; no votes are being saved yet.';
  else if(apiState==='error'){n.classList.add('error');n.append(el('span','The voting service is unavailable. No new votes can be saved right now.'),button('Try again',()=>loadVotes(),'text-button'));}
  else if(storageError)n.textContent='Your browser is blocking storage. You can read the totals, but enable local storage to save a vote.';
  else return null;
  return n;
 }
 function availability(parent){const notice=apiNotice();if(notice)parent.append(notice);}
 function catalogueRows(container,count){container.replaceChildren();const filtered=matchingComposers(catalog,query,selectedEra);count.textContent=`${filtered.length} of ${catalog.composers.length} composers · categories overlap in history`;
  if(!filtered.length){container.append(el('p','No composer matches that search. Try a surname or another era.','catalogue-empty'));return;}
  for(const era of catalog.eras){const cs=filtered.filter(c=>c.eraId===era.id);if(!cs.length)continue;const section=el('section',undefined,'era-section');const heading=el('div',undefined,'era-heading');heading.append(el('h3',era.label),el('span',`${cs.length} composers`));const list=el('div',undefined,'composer-list');for(const c of cs){const row=link('',`#composer/${c.id}`,'composer-row');const w=worksFor(c.id);row.append(el('span',c.shortName,'composer-name'),el('span',c.years,'years'),el('span',w.length?`${w.length} work to hear`:'Request a work','availability'),el('span','›','row-arrow'));list.append(row);}section.append(heading,list);container.append(section);}
 }
 function renderBrowse(){
  const hero=el('section',undefined,'hero'),intro=el('div');intro.append(el('p','A listening library, chosen by you','section-kicker'),el('h1','What would you like to hear next?'),el('p','Choose a composer. Choose a form. Vote for a new work, then follow its score as you listen.','intro'),el('p','Original AI-composed homages. Not lost works, and not a claim to reproduce a composer’s genius.','disclaimer'));hero.append(intro,featured(catalog.works[0]));root.append(hero);
  const top=el('div',undefined,'catalogue-top');top.append(el('h2','Browse the composers'));const label=el('label','Find a composer','search-label'),input=el('input');input.type='search';input.value=query;input.placeholder='Brahms, Shostakovich, Price…';input.id='composer-search';label.append(input);top.append(label);root.append(top);
  const count=el('p',undefined,'composer-count');count.setAttribute('aria-live','polite');root.append(count);
  const layout=el('div',undefined,'browse-layout'),aside=el('aside'),nav=el('nav',undefined,'era-nav');nav.setAttribute('aria-label','Filter composers by era');const rows=el('div');
  const options=[{id:'',label:'All composers'},...catalog.eras];for(const era of options){const b=button(era.label,()=>{selectedEra=era.id;for(const child of nav.children)child.setAttribute('aria-pressed',String(child.dataset.era===selectedEra));catalogueRows(rows,count);});b.dataset.era=era.id;b.setAttribute('aria-pressed',String(selectedEra===era.id));nav.append(b);}aside.append(nav);layout.append(aside,rows);root.append(layout);catalogueRows(rows,count);
  input.addEventListener('input',()=>{query=input.value;catalogueRows(rows,count);});
  const queue=el('section',undefined,'queue-preview'),head=el('div',undefined,'section-header');head.append(el('h2','The next work'),link('See the full queue','#queue'));queue.append(head,el('p','Votes guide the next composition. A person starts each project; winning a vote does not launch it automatically.','small-copy'));availability(queue);
  const active=rankRequests(requests.filter(r=>r.status!=='completed'&&(r.votes>0||r.status==='composing'))).slice(0,5);
  if(active.length)queue.append(queueTable(active));else if(apiState==='ready')queue.append(el('p','No votes yet. Open a composer and be the first to choose a work.','empty-state'));root.append(queue);
 }
 function renderWorks(){root.append(makeHeader('On the shelf','Every finished work, ready to hear. More will arrive as the queue is composed.'));const grid=el('div',undefined,'work-grid');catalog.works.forEach(w=>grid.append(workRecord(w)));root.append(grid);}
 function renderComposer(id){
  const c=composer(id);if(!c){renderMissing();return;}const era=catalog.eras.find(e=>e.id===c.eraId);root.append(makeHeader(c.shortName,`${c.name} · ${c.years}`,{text:`All composers / ${era.label}`,url:'#browse'}));
  const layout=el('div',undefined,'composer-detail'),works=el('section',undefined,'works-list');works.append(el('h2','Listen'));
  const list=worksFor(id);if(list.length)list.forEach(w=>works.append(workRecord(w)));else{const empty=el('div',undefined,'empty-state');empty.append(el('p','Nothing on this shelf yet.'),el('p',`Choose a form and help decide the first work inspired by ${c.shortName}.`,'small-copy'));works.append(empty);}
  const panel=el('section',undefined,'request-panel');panel.append(el('h2',list.length?'Choose the next work':'Choose the first work'),el('p',`What would you like to hear in conversation with ${c.shortName}’s musical world?`,'explanation'));
  const options=el('div',undefined,'form-options');options.setAttribute('role','group');options.setAttribute('aria-label','Type of piece');
  for(const f of catalog.forms){const b=button(f.label,()=>{selectedForm=f.id;messages.clear();render();document.querySelector(`[data-form="${f.id}"]`)?.focus();});b.dataset.form=f.id;b.setAttribute('aria-pressed',String(selectedForm===f.id));options.append(b);}panel.append(options,el('p',form(selectedForm).description,'small-copy'));const target=el('div');target.id='vote-region';panel.append(target);layout.append(works,panel);root.append(layout);renderVoteRegion(id);
 }
 function renderVoteRegion(id){
  const box=$('vote-region');if(!box)return;box.replaceChildren();availability(box);const r=currentRequest(id);const block=el('div',undefined,'vote-block');
  const rounds=catalog.works.filter(w=>w.composerId===id&&w.formId===selectedForm).length;
  if(rounds)block.append(el('p',`A new request for another ${form(selectedForm).label.toLowerCase()}. The completed work stays in the library.`,'small-copy'));
  if(apiState==='ready'&&r){
   const total=el('p',undefined,'vote-total');total.append(el('span',String(r.votes),'vote-count'),el('span',r.votes===1?'vote':'votes','vote-count-label'));block.append(total);
   if(r.status==='composing')block.append(el('p','Being composed. Voting is closed for this round.','status-note'));
   else{const b=button(busy.has(r.id)?'Saving…':r.voted?'✓ Voted — undo':'Vote for this work',()=>castVote(r.id,!r.voted),'primary-button');b.disabled=busy.has(r.id)||storageError;b.setAttribute('aria-pressed',String(r.voted));b.dataset.voteId=r.id;block.append(b);}
  }else{const b=button(apiState==='loading'?'Loading votes…':'Voting unavailable',()=>{},'primary-button');b.disabled=true;block.append(b);if(apiState==='ready')block.append(el('p','There is no open request for this combination yet.','small-copy'));}
  const msg=el('p',r?messages.get(r.id)||'':'','inline-status');msg.setAttribute('role','status');block.append(msg,el('p','No account needed. One vote per request in this browser; support as many different requests as you like. You can undo a vote while its round is open.','vote-note'));
  if(apiState==='ready')block.append(button('Refresh totals',()=>loadVotes(),'text-button'));box.append(block);
 }
 function queueTable(rows){
  const wrap=el('div',undefined,'queue-wrap'),table=el('table',undefined,'queue-table');table.setAttribute('aria-label','Composition requests ranked by votes');const head=el('thead'),tr=el('tr');['Composer & form','Status','Votes'].forEach(t=>tr.append(el('th',t)));head.append(tr);table.append(head);const body=el('tbody');
  for(const r of rows){const c=composer(r.composerId),f=form(r.formId);if(!c||!f)continue;const row=el('tr'),title=el('td');title.append(link(c.shortName,`#composer/${c.id}`,'queue-composer'),el('div',`${f.label}${r.round>1?' · request '+r.round:''}`,'meta'));title.firstChild.addEventListener('click',()=>{selectedForm=f.id;});const state=el('td',r.status==='composing'?'Being composed':r.status==='completed'?'Completed':'Open','state-label');if(r.status==='completed'&&r.workId){const w=catalog.works.find(w=>w.id===r.workId);if(w){state.append(el('br'),link('Listen',`work.html?id=${encodeURIComponent(w.id)}`));}}row.append(title,state,el('td',String(r.votes),'queue-count'));body.append(row);}table.append(body);wrap.append(table);return wrap;
 }
 function renderQueue(){
  root.append(makeHeader('The next work','A shared queue of quartets, sonatas, and symphonies. Your votes set the direction.'));
  const controls=el('div',undefined,'queue-controls');const select=(text,items,value,onchange)=>{const l=el('label',text),s=el('select');for(const o of items){const option=el('option',o.label);option.value=o.id;s.append(option);}s.value=value;s.addEventListener('change',()=>{onchange(s.value);render();});l.append(s);return l;};
  controls.append(select('Era or tradition',[{id:'',label:'All eras'},...catalog.eras],queueEra,v=>queueEra=v),select('Form',[{id:'',label:'All forms'},...catalog.forms],queueForm,v=>queueForm=v),select('Show',[{id:'active',label:'Open & in progress'},{id:'completed',label:'Completed requests'}],queueState,v=>queueState=v),button('Refresh totals',()=>loadVotes(),'secondary-button'));root.append(controls);availability(root);
  const rows=rankRequests(requests.filter(r=>(queueState==='completed'?r.status==='completed':r.status!=='completed')&&(!queueEra||composer(r.composerId)?.eraId===queueEra)&&(!queueForm||r.formId===queueForm)&&(queueState==='completed'||r.votes>0||r.status==='composing')));
  if(rows.length)root.append(queueTable(rows));else if(apiState==='ready')root.append(el('p',queueState==='completed'?'No completed requests match these filters.':'No votes in this selection yet. Choose a composer to put a work on the queue.','empty-state'));
  root.append(el('p','Only supported requests appear here. Ties are ordered by request creation time, then ID. Counts are frozen when a round moves into composition; a new round opens after its work is completed.','small-copy'));
  if(lastUpdated)root.append(el('p','Last checked '+new Date(lastUpdated).toLocaleTimeString()+'. Refresh to see the latest votes.','meta'));
  root.append(link('Browse composers','#browse','return-link'));
 }
 function renderMissing(){root.append(makeHeader('That shelf is not here.','The composer or page could not be found.'),link('Back to the catalogue','#browse','button-link'));}
 function render(){if(!catalog)return;root.replaceChildren();const r=route();document.querySelectorAll('[data-nav]').forEach(a=>a.setAttribute('aria-current',a.dataset.nav===(r.view==='composer'?'browse':r.view)?'page':'false'));document.title=(r.view==='composer'&&composer(r.id)?composer(r.id).shortName+' — ':'')+'Missing Works';if(r.view==='browse')renderBrowse();else if(r.view==='works')renderWorks();else if(r.view==='composer')renderComposer(r.id);else if(r.view==='queue')renderQueue();else renderMissing();}
 async function request(path,options={}){const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),15000);try{const headers={...(token?{'X-Voter-Token':token}:{}),...options.headers};const r=await fetch(base+path,{...options,headers,signal:ac.signal,cache:'no-store'});const data=await r.json().catch(()=>({}));if(!r.ok){const e=Error(typeof data.error==='string'?data.error:'The request could not be saved.');e.status=r.status;throw e;}return data;}finally{clearTimeout(timer);}}
 async function loadVotes(){if(!base){apiState='unconfigured';render();return;}if(busy.size)return;const n=++sequence;apiState='loading';render();try{const d=await request('/api/requests');if(n!==sequence)return;if(!Array.isArray(d.requests)||d.requests.some(r=>typeof r.id!=='string'||!Number.isInteger(r.votes)||r.votes<0||!['open','composing','completed'].includes(r.status)||!composer(r.composerId)||!form(r.formId)))throw Error('Invalid voting response');requests=d.requests;apiState='ready';apiError='';lastUpdated=new Date().toISOString();}catch(e){if(n!==sequence)return;apiState='error';apiError=e.message;}render();}
 async function castVote(id,voted){if(!token||busy.has(id)||apiState!=='ready')return;busy.add(id);sequence++;messages.delete(id);const active=route();renderVoteRegion(active.id);try{const d=await request('/api/votes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:id,voted})});if(!d.request||d.request.id!==id||!Number.isInteger(d.request.votes))throw Error('Invalid save response');requests=requests.map(r=>r.id===id?d.request:r);messages.set(id,voted?'Your vote is saved. Thank you.':'Your vote was removed.');lastUpdated=new Date().toISOString();}catch(e){messages.set(id,e.status===429?'Too many changes. Please wait a minute and try again.':e.status===409?'This round has closed. Refresh the totals to see its status.':'Your vote was not confirmed. Please try again.');}finally{busy.delete(id);if(route().view==='composer')renderVoteRegion(route().id);}}
 document.querySelector('.skip').addEventListener('click',e=>{e.preventDefault();root.focus();root.scrollIntoView({block:'start'});});
 $('privacy-toggle').addEventListener('click',()=>{const p=$('privacy-note');p.hidden=!p.hidden;$('privacy-toggle').setAttribute('aria-expanded',String(!p.hidden));});
 window.addEventListener('hashchange',()=>{render();window.scrollTo({top:0,behavior:'instant'});});
 try{
  const r=await fetch('data/catalog.json');if(!r.ok)throw Error('Catalogue unavailable');catalog=await r.json();
  try{const stored=localStorage.getItem(TOKEN_KEY);token=stored&&UUID.test(stored)?stored:crypto.randomUUID();localStorage.setItem(TOKEN_KEY,token);}catch(e){token=null;storageError=true;}
  try{const c=await fetch('config.json');if(!c.ok)throw Error('Configuration unavailable');base=validApiBase((await c.json()).apiBaseUrl,location.origin);}catch(e){apiState='error';apiError=e.message;render();return;}
  render();await loadVotes();
 }catch(e){root.replaceChildren(makeHeader('The catalogue could not load.','Please refresh the page or try again in a moment.'),link('Open the original quartet player','beethoven.html','button-link'));}
}
