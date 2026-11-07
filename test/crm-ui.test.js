'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../public/crm.js'),'utf8');
const html=fs.readFileSync(require('node:path').join(__dirname,'../public/index.html'),'utf8');
function client(apiImpl){
 const root={innerHTML:'',listeners:{},replaceChildren(){this.innerHTML='';},querySelectorAll(){return [];},addEventListener(k,v){this.listeners[k]=v;}};
 const S={token:'synthetic',user:{role:'member',email:'sales@example.invalid'},isDemo:false};
 const calls=[];
 const context=vm.createContext({S,document:{getElementById:()=>root},window:{},FormData:class {constructor(form){return Object.entries(form.values);}},URL,URLSearchParams,setTimeout,clearTimeout,toast(){},esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));},api:async(...args)=>{calls.push(args);return apiImpl(...args);}});
 vm.runInContext(source,context);
 return {root,S,calls,crm:context.window.WACRM,submit(values){return root.listeners.submit({preventDefault(){},target:{id:'crmLeadForm',values}});},click(dataset){return root.listeners.click({target:{closest(){return {dataset,disabled:false};}}});}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const lead={id:'buyer1',version:1,company:'Synthetic buyer',country:'Example',stage:'new',contactStatus:'unknown',emails:['buyer@example.invalid'],notes:[],offers:[]};
test('CRM is integrated and clears data in auth hooks',()=>{
 assert.match(html,/data-tab="crm"/);assert.match(html,/id="pane-crm"/);assert.match(html,/src="\/crm.js"/);
 assert.match(html,/function setupUI\(\)\{\s+if\(window.WACRM\) window.WACRM.reset/);
 assert.match(html,/function logout\(\)\{\s+if\(window.WACRM\) window.WACRM.reset/);
 assert.doesNotMatch(source,/localStorage|sessionStorage|mailto:|wa\.me|\/send|setInterval/);
});
test('demo and signed-out states make no requests',async()=>{
 const c=client(()=>{throw new Error('unexpected');});c.S.isDemo=true;await c.crm.open();assert.equal(c.calls.length,0);assert.match(c.root.innerHTML,/not available in demo/);c.S.isDemo=false;c.S.token='';await c.crm.open();assert.equal(c.calls.length,0);
});
test('member view has search, stages and no owner actions',async()=>{
 const c=client(async()=>({items:[lead],total:1,stages:['new'],canImport:false}));await c.crm.open();assert.match(c.root.innerHTML,/Synthetic buyer/);assert.match(c.root.innerHTML,/crmSearchForm/);assert.doesNotMatch(c.root.innerHTML,/Export CRM|Confirm import|crmImportFile/);assert.equal(c.calls.length,1);
});
test('late results cannot restore private data after reset',async()=>{
 let release;const c=client(()=>new Promise(resolve=>release=resolve));const p=c.crm.open();c.crm.reset();c.S.token='';release({items:[lead],total:1});await p;assert.equal(c.root.innerHTML,'');
});
test('overlapping loads are bounded and detail HTML is escaped',async()=>{
 let release;const c=client(url=>url.includes('?')?new Promise(resolve=>release=resolve):{...lead,company:'<img src=x>',website:'javascript:alert(1)',sourceUrls:['https://example.invalid','data:text/html,bad'],notes:[{text:'<script>bad</script>',author:'Synthetic',at:'2026-11-07'}]});
 const p=c.crm.open();await c.crm.open();assert.equal(c.calls.length,1);release({items:[lead],total:1});await p;c.click({lead:lead.id});await settle();assert.match(c.root.innerHTML,/&lt;img/);assert.match(c.root.innerHTML,/&lt;script/);assert.doesNotMatch(c.root.innerHTML,/<img|<script|href="javascript:|href="data:/);assert.match(c.root.innerHTML,/rel="noopener noreferrer"/);assert.match(c.root.innerHTML,/does not send messages/);
});
test('admin import and export are visible only for real admin session',async()=>{
 const c=client(async url=>url==='/api/crm/team'?{items:[]}:{items:[],total:0,canImport:true});c.S.user.role='admin';await c.crm.open();assert.match(c.root.innerHTML,/crmImportFile/);assert.match(c.root.innerHTML,/Export CRM/);assert.match(c.root.innerHTML,/owner-only/);
});
function editableClient(status,role='member'){
 let record={...lead,contactStatus:status,consentEvidence:status==='permitted'?'Synthetic explicit email consent, 7 November 2026':'',assignedTo:'sales@example.invalid'};
 const c=client(async(url,method,body)=>{
  if(method==='PATCH'){
   if('contactStatus' in body && body.contactStatus!=='suppressed' && c.S.user.role!=='admin')throw new Error('Administrator access required');
   if('consentEvidence' in body && !('contactStatus' in body))throw new Error('Save permission status with its evidence');
   if(body.contactStatus==='permitted'&&!body.consentEvidence)throw new Error('Permission evidence required');
   record={...record,...body,version:record.version+1};return record;
  }
  if(url==='/api/crm/team')return {items:[{email:'sales@example.invalid',name:'Synthetic sales'}]};
  return url.includes('?')?{items:[record],total:1,stages:['new'],canImport:role==='admin'}:record;
 });c.S.user.role=role;return c;
}
for(const status of ['unknown','permitted','suppressed'])test('member can save stage and follow-up with unchanged '+status+' permission',async()=>{
 const c=editableClient(status);await c.crm.open();c.click({lead:lead.id});await settle();
 const select=c.root.innerHTML.match(/<select name="contactStatus">([\s\S]*?)<\/select>/)[1];
 assert.doesNotMatch(select,new RegExp('value="'+(status==='unknown'?'permitted':'unknown')+'"'));
 assert.match(c.root.innerHTML,/name="consentEvidence" readonly/);
 c.submit({stage:'qualified',followUpAt:'2026-11-09T10:00',contactStatus:status,consentEvidence:status==='permitted'?'Synthetic explicit email consent, 7 November 2026':''});await settle();
 const patch=c.calls.find(call=>call[1]==='PATCH');assert.ok(patch);assert.equal(patch[2].stage,'qualified');assert.ok(patch[2].followUpAt.endsWith('Z'));assert.equal('contactStatus' in patch[2],false);assert.equal('consentEvidence' in patch[2],false);assert.match(c.root.innerHTML,/<span class="crm-tag">qualified<\/span>/);assert.doesNotMatch(c.root.innerHTML,/Administrator access required/);
});
test('member can suppress but cannot forge permission upgrade',async()=>{
 const c=editableClient('unknown');await c.crm.open();c.click({lead:lead.id});await settle();
 c.submit({stage:'new',followUpAt:'',contactStatus:'permitted',consentEvidence:'forged'});await settle();assert.equal(c.calls.filter(call=>call[1]==='PATCH').length,0);
 c.submit({stage:'new',followUpAt:'',contactStatus:'suppressed',consentEvidence:''});await settle();const patch=c.calls.find(call=>call[1]==='PATCH');assert.equal(patch[2].contactStatus,'suppressed');assert.equal('consentEvidence' in patch[2],false);
});
test('owner permission evidence edit includes status; unchanged evidence is omitted',async()=>{
 const c=editableClient('permitted','admin');await c.crm.open();c.click({lead:lead.id});await settle();
 c.submit({stage:'new',followUpAt:'',contactStatus:'permitted',consentEvidence:'Updated explicit consent scope',assignedTo:'sales@example.invalid'});await settle();let patches=c.calls.filter(call=>call[1]==='PATCH');assert.equal(patches[0][2].contactStatus,'permitted');assert.equal(patches[0][2].consentEvidence,'Updated explicit consent scope');
 c.submit({stage:'qualified',followUpAt:'',contactStatus:'permitted',consentEvidence:'Updated explicit consent scope',assignedTo:'sales@example.invalid'});await settle();patches=c.calls.filter(call=>call[1]==='PATCH');assert.equal('contactStatus' in patches[1][2],false);assert.equal('consentEvidence' in patches[1][2],false);
});
test('offer currency requires an explicit user choice',()=>{
 assert.match(source,/name="currency" placeholder="e.g. USD or AED" pattern="\[A-Za-z\]\{3\}" maxlength="3" required/);assert.doesNotMatch(source,/name="currency" value=/);
});
for(const hold of [true,false])test('owner compliance hold notice and controls match explicit flag '+hold,async()=>{
 const record={...lead,complianceHold:hold,restrictionReason:'Synthetic compliance review',notes:[{text:'Retained evidence',author:'owner@example.invalid',at:'2026-11-07'}],history:[{action:'restricted',actor:'owner@example.invalid',at:'2026-11-07'}],offers:[{id:'draft1',title:'Existing draft',status:'draft',currency:'AED',unitPrice:'100',quantity:2}]};
 const c=client(async url=>url==='/api/crm/team'?{items:[]}:url.includes('?')?{items:[record],total:1,canImport:true}:record);c.S.user.role='admin';await c.crm.open();
 if(hold)assert.match(c.root.innerHTML,/Restricted · owner only/);else assert.doesNotMatch(c.root.innerHTML,/Restricted · owner only/);
 c.click({lead:lead.id});await settle();assert.match(c.root.innerHTML,/Retained evidence/);assert.match(c.root.innerHTML,/Source and history/);
 if(hold){assert.match(c.root.innerHTML,/Restricted contact · compliance hold/);assert.match(c.root.innerHTML,/Synthetic compliance review/);assert.doesNotMatch(c.root.innerHTML,/name="assignedTo"|crmOfferForm|crmReviewForm/);}else{assert.doesNotMatch(c.root.innerHTML,/Restricted contact · compliance hold/);assert.match(c.root.innerHTML,/name="assignedTo"/);assert.match(c.root.innerHTML,/crmOfferForm/);assert.match(c.root.innerHTML,/crmReviewForm/);}
});
