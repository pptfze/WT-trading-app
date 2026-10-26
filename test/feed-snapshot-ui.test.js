'use strict';
// Synthetic VM regression tests, not a browser or live-service QA pass.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).join('\n');
const response=(body,status=200)=>({ok:status<400,status,json:async()=>body});
const listing=(id)=>({id,type:'WTS',model:'Synthetic',sender:'synthetic-seller',price:10,currency:'USD',timestamp:1700000000,source:{groupId:'synthetic-group'}});
function client(fetcher){
  const nodes=new Map(),calls=[],notifications=[];
  function node(id){if(!nodes.has(id)){const classes=new Set();nodes.set(id,{value:id==='matchFilter'?'all':'',innerHTML:'',textContent:'',disabled:false,style:{},setAttribute(){},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)}});}return nodes.get(id);}
  const context=vm.createContext({window:{addEventListener(){}},document:{hidden:false,getElementById:node,querySelectorAll:()=>[],querySelector:()=>node('selector')},localStorage:{getItem:()=>null},AbortController,URLSearchParams,setTimeout,clearTimeout,setInterval,clearInterval,fetch:async(url,options)=>{calls.push({url,options});return fetcher(url,options);},notifications});
  vm.runInContext(script,context);const run=s=>vm.runInContext(s,context);
  run("S.token='synthetic';S.user={email:'sales@example.invalid',role:'member'};updateAll=()=>{};setPill=()=>{};toast=()=>{};checkHealth=()=>{};checkWatchlistMatch=l=>notifications.push(l.id);checkLocalAlert=()=>{};");
  return {run,node,calls,notifications,context};
}

test('feed is an authorized bounded full snapshot including equal timestamps, not an incremental append',async()=>{
  let rows=Array.from({length:350},(_,i)=>listing('row-'+i));const c=client(()=>response(rows));
  await c.run('poll()');
  assert.equal(c.calls[0].url,'/api/messages?limit=2000');assert.doesNotMatch(c.calls[0].url,/since=/);
  assert.equal(c.run('S.listings.length'),350);assert.equal(c.run("S.traders['synthetic-seller'].wts"),350);
  assert.equal(c.notifications.length,0);
  rows=[listing('row-2'),listing('row-2')];await c.run('poll()');
  assert.equal(c.run('S.listings.length'),1);assert.equal(c.run("S.traders['synthetic-seller'].wts"),1);
});

test('repeated snapshots do not repeat watch notifications, including IDs that disappear then return',async()=>{
  let rows=[listing('one')];const c=client(()=>response(rows));await c.run('poll()');await c.run('poll()');
  rows=[listing('one'),listing('two')];await c.run('poll()');await c.run('poll()');
  assert.deepEqual(c.notifications,['two']);
  rows=[listing('one')];await c.run('poll()');rows=[listing('one'),listing('two')];await c.run('poll()');
  assert.deepEqual(c.notifications,['two']);
});

test('snapshots cap new-item notifications and requests at one in flight',async()=>{
  let release;const c=client(()=>new Promise(resolve=>{release=resolve;}));
  const one=c.run('poll()');await c.run('poll()');assert.equal(c.calls.length,1);assert.equal(c.run('F.busy'),true);
  release(response([listing('first')]));await one;
  const next=c.run('poll()');release(response(Array.from({length:30},(_,i)=>listing('new-'+i))));await next;
  assert.equal(c.notifications.length,5);assert.equal(c.run('F.busy'),false);
});

test('missing sources clear match/trend caches and do not background-refresh Matches',async()=>{
  let rows=[listing('one')];const c=client(()=>response(rows));await c.run('poll()');
  c.run("M.items=[{id:'sensitive-old-match'}];M.verified=true;document.getElementById('trendResults').innerHTML='old history'");
  rows=[];await c.run('poll()');assert.equal(c.run('M.items.length'),0);assert.equal(c.node('trendResults').innerHTML,'');
  assert.equal(c.calls.filter(call=>call.url.startsWith('/api/matches')).length,0);
});

test('failed authorized snapshot clears cached source data and dependent outputs',async()=>{
  let fail=false;const c=client(()=>fail?response({error:'Policy unavailable'},503):response([listing('one')]));
  await c.run('poll()');c.run("M.items=[{id:'old'}];M.verified=true;document.getElementById('trendResults').innerHTML='old'");
  fail=true;await c.run('poll()');assert.equal(c.run('S.listings.length'),0);assert.equal(c.run('Object.keys(S.traders).length'),0);assert.equal(c.run('M.items.length'),0);assert.equal(c.node('trendResults').innerHTML,'');
});

for(const type of ['session','policy'])test('late feed result cannot restore data after '+type+' invalidation',async()=>{
  let release;const c=client(()=>new Promise(resolve=>{release=resolve;}));const pending=c.run('poll()');
  if(type==='session')c.run("sessionVersion++;S.token='';resetFeedSync()");else c.run('invalidateSourceViews(false)');
  release(response([listing('stale')]));await pending;assert.equal(c.run('S.listings.length'),0);assert.equal(c.run('F.busy'),false);
});

test('policy invalidation aborts match and trend epochs so late responses cannot restore history',async()=>{
  let releaseMatch,releaseTrend;
  const c=client(url=>new Promise(resolve=>{if(url.startsWith('/api/matches'))releaseMatch=resolve;else releaseTrend=resolve;}));
  c.context.localStorage.setItem=()=>{};c.node('trendModel').value='Synthetic';
  const match=c.run('refreshMatches()'),trend=c.run('loadPriceTrends()');
  c.run('invalidateSourceViews(false)');
  releaseMatch(response({matches:[],limits:{freshnessHours:48}}));releaseTrend(response({analysis:{series:[],counts:{included:1}},limits:{maxRows:2000}}));
  await Promise.all([match,trend]);assert.equal(c.run('M.verified'),false);assert.equal(c.node('trendResults').innerHTML,'');assert.equal(c.run('P.busy'),false);
});

test('source changes refresh Matches only when its pane is visible',async()=>{
  const c=client(url=>response(url.startsWith('/api/messages')?[]:{matches:[],limits:{freshnessHours:48}}));
  c.run('invalidateSourceViews()');await new Promise(resolve=>setImmediate(resolve));assert.equal(c.calls.filter(x=>x.url.startsWith('/api/matches')).length,0);
  c.node('pane-matches').classList.add('active');c.run('invalidateSourceViews()');await new Promise(resolve=>setImmediate(resolve));assert.equal(c.calls.filter(x=>x.url.startsWith('/api/matches')).length,1);
  c.run('document.hidden=true;invalidateSourceViews()');await new Promise(resolve=>setImmediate(resolve));assert.equal(c.calls.filter(x=>x.url.startsWith('/api/matches')).length,1);
});

test('terminal matches have notes-only status controls',()=>{
  const c=client(()=>response([]));
  for(const status of ['closed','dismissed']){
    c.context.item={id:'lead',version:1,status,assignedTo:'sales@example.invalid',offer:listing('offer'),demand:listing('demand'),notes:[]};
    c.run('M.items=[item];M.verified=true;renderMatches()');
    assert.doesNotMatch(c.node('matchesList').innerHTML,/data-match-status/);assert.match(c.node('matchesList').innerHTML,/data-match-note/);
    assert.match(c.node('matchesList').innerHTML,/closed to further status changes/);
  }
});

test('late source-list response cannot restore channels after logout',async()=>{
  let release;const c=client(()=>new Promise(resolve=>{release=resolve;}));
  const pending=c.run('reloadChannels()');
  c.run("sessionVersion++;S.token='';S.user=null;localChannels=[];channelsBusy=false");
  release(response([{id:'old-channel',label:'Old account',active:true,groups:{},contacts:{}}]));
  await assert.rejects(pending,/Session changed/);assert.equal(c.run('localChannels.length'),0);
});

test('source-list continuation independently checks session even when API helper has already returned',async()=>{
  const c=client(()=>response([]));
  c.run("api=async()=>{Promise.resolve().then(()=>{sessionVersion++;localChannels=[]});return [{id:'old-channel',groups:{}}]}");
  await assert.rejects(c.run('reloadChannels()'),/Session changed/);assert.equal(c.run('localChannels.length'),0);
});

test('late source mutation cannot rewrite or clear the next signed-in user’s source views',async()=>{
  let release;const c=client(()=>new Promise(resolve=>{release=resolve;}));
  c.run("S.user.role='admin';renderChannels=()=>{};invalidateSourceViews=()=>{};localChannels=[{id:'channel',active:true,groups:{g:{id:'g',enabled:true}},contacts:{}}]");
  const pending=c.run("toggleGroup('channel','g',false)");
  c.run("sessionVersion++;S.token='new-session';localChannels=[{id:'channel',active:true,groups:{g:{id:'g',enabled:true}},contacts:{}}];channelsBusy=false;document.getElementById('channelsStatus').textContent='New session'");
  release(response({ok:true}));await pending;
  assert.equal(c.run('localChannels[0].groups.g.enabled'),true);assert.equal(c.node('channelsStatus').textContent,'New session');assert.equal(c.run('channelsBusy'),false);
});

test('source-mutation continuation checks current session before applying a successful response',async()=>{
  const c=client(()=>response([]));
  c.run("S.user.role='admin';renderChannels=()=>{};invalidateSourceViews=()=>{};localChannels=[{id:'channel',groups:{g:{id:'g',enabled:true}},contacts:{}}];api=async()=>{Promise.resolve().then(()=>{sessionVersion++;localChannels=[];channelsBusy=false;document.getElementById('channelsStatus').textContent='New session'});return {ok:true}}");
  await c.run("toggleGroup('channel','g',false)");
  assert.equal(c.run('localChannels.length'),0);assert.equal(c.node('channelsStatus').textContent,'New session');
});
