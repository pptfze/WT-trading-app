'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {fixtureMongo}=require('./fake-mongo');
const root=path.resolve(__dirname,'..'),file=path.join(root,'server.js'),localRequire=createRequire(file);
const admin={email:'operator@example.invalid',name:'Operator',role:'admin'},sales={email:'sales@example.invalid',name:'Sales',role:'member'};
async function fixture({ai=false,whatsapp=false}={}) {
  const fake=fixtureMongo(),app={routes:[],middleware:[],disable(){},use(fn){this.middleware.push(fn);}};
  for(const method of ['get','post','patch','put','delete'])app[method]=(route,...handlers)=>app.routes.push({method,route,handlers});
  function express(){return app;}express.json=express.static=()=>()=>{};
  const context={module:{exports:{}},Buffer,Date,AbortSignal,__dirname:root,console:{log(){},error(){}},process:{env:{JWT_SECRET:'synthetic-strong-test-secret-0000000000000000',ADMIN_EMAILS:admin.email,APP_ALLOWED_EMAILS:sales.email,WHATSAPP_ENABLED:whatsapp?'true':'false',WEBHOOK_SECRET:'synthetic-webhook-secret-00000000000000',CLAUDE_API_KEY:'synthetic-do-not-send',AI_ENABLED:ai?'true':'false',AI_PRICE_EXPLANATION_ENABLED:ai?'true':'false',AI_PRICE_AGGREGATES_TO_ANTHROPIC_APPROVED:ai?'true':'false',ANTHROPIC_MODEL:'claude-synthetic-offline-model'}},require(name){if(name==='express')return express;if(name==='cors')return()=>()=>{};if(name==='mongodb')throw Error('Live database forbidden');return localRequire(name);},setInterval(){throw Error('No listeners/schedulers');},clearInterval(){},async fetch(){calls.ai++;if(calls.onAI)await calls.onAI();return {ok:true,async json(){return {content:[{text:'Synthetic evidence-only explanation'}]};}};}};
  const calls={ai:0,onAI:null};vm.createContext(context);
  const seam='\nmodule.exports.__install=async(d,c)=>{db=d;tradeStore=new TradeStore(d,c);policy=new MongoChannelPolicy(d.collection("channel_privacy"));await policy.initialize();};';
  vm.runInContext(fs.readFileSync(file,'utf8')+seam,context,{filename:file});const server=context.module.exports;await server.__install(fake.db,fake.client);
  await fake.db.collection('users').insertMany([admin,sales]);await server.policy.create('channel','Synthetic');await server.policy.mergeGroups('channel',[{id:'1@g.us',name:'Selected suppliers'},{id:'2@g.us',name:'OFF buyers'}],(await server.policy.get('channel')).generation);await server.policy.setGroups('channel',[{id:'1@g.us',enabled:true}]);await server.policy.setActive('channel',true);
  async function call(method,route,{actor=admin,body={},query={},params={},headers={}}={}){
    const entry=app.routes.find(r=>r.method===method&&r.route===route);assert.ok(entry,route);
    const req={body,query,params,headers:{...(actor?{authorization:'Bearer '+server.makeToken(actor)}:{}),...headers}},res={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.body=value;this.done=true;return this;}};
    for(const fn of entry.handlers){let next=false,error;await fn(req,res,e=>{next=true;error=e;});if(error){await app.middleware.find(f=>f.length===4)(error,req,res,()=>{});break;}if(!next||res.done)break;}return res;
  }
  return {...fake,server,call,calls};
}
function listing(id,group='1@g.us') {const ts=Math.floor(Date.now()/1000)-60;return {id,sourceKey:id,sourceLine:0,model:'iPhone 18 Pro Max',modelKey:'iphone 18 pro max',type:'WTS',priceKind:'supplier_ask',priceUnit:'unit',condition:'Brand New',storage:'256GB',region:'HK',activation:'non_active',color:'burgundy',currency:'USD',price:1000,qty:50,availability:'active',timestamp:ts,channelId:'channel',group,sender:'supplier',source:{provider:'whapi',providerMessageId:id,sourceTimestamp:ts,channelId:'channel',groupId:group,sender:'supplier',lineIndex:0,isForwarded:false,contentFingerprint:id},extraction:{flags:[]}};}
test('matching and analytics endpoints require a current authenticated allowed account',async()=>{const f=await fixture();for(const [method,route]of [['get','/api/matches'],['post','/api/matches/:id/claim'],['patch','/api/matches/:id'],['get','/api/price-trends']])assert.equal((await f.call(method,route,{actor:null})).statusCode,401);});
test('reports and trends exclude unselected group records, retaining explicit dimensions/currency',async()=>{const f=await fixture();await f.db.collection('group_listings_v1').insertMany([listing('selected'),listing('off','2@g.us')]);const report=await f.call('get','/api/report');assert.equal(report.body.listings.length,1);const trend=await f.call('get','/api/price-trends',{query:{model:'iPhone 18 Pro Max'}});assert.equal(trend.statusCode,200);assert.equal(trend.body.analysis.counts.input,1);assert.equal(trend.body.analysis.series[0].dimensions.currency,'USD');assert.equal(trend.body.analysis.series[0].dimensions.activationStatus,'non_active');});
test('deterministic price analysis works with external AI disabled, and optional MOQ is explicit',async()=>{const f=await fixture();await f.db.collection('group_listings_v1').insertOne({...listing('one'),qty:20});let result=await f.call('post','/api/ai/price',{body:{model:'iPhone 18 Pro Max'}});assert.equal(result.statusCode,200);assert.match(result.body.result,/Historical asking prices/);assert.equal(result.body.analysis.counts.included,1);assert.equal(f.calls.ai,0);result=await f.call('get','/api/price-trends',{query:{model:'iPhone 18 Pro Max',minQuantity:'50'}});assert.equal(result.body.analysis.counts.included,0);assert.equal(result.body.analysis.policy.minQuantity,50);});
test('analytics rejects malformed model/filter requests without broadening Mongo predicates',async()=>{const f=await fixture();for(const query of [{},{model:{$ne:null}},{model:'iPhone',currency:{$ne:null}},{model:'iPhone',minQuantity:'bad'}])assert.equal((await f.call('get','/api/price-trends',{query})).statusCode,400);});
test('AI draft uses canonical selected listing, never client-forged or unselected payload',async()=>{const f=await fixture({ai:true});await f.db.collection('group_listings_v1').insertOne(listing('off','2@g.us'));for(const id of ['missing','off']){assert.equal((await f.call('post','/api/ai/autoreply',{body:{listing:{id,raw:'forged secret'},intent:'reply'}})).statusCode,404);}assert.equal(f.calls.ai,0);});
test('revocation during optional AI explanation discards the response',async()=>{const f=await fixture({ai:true});await f.db.collection('group_listings_v1').insertOne(listing('one'));f.calls.onAI=()=>f.server.policy.setActive('channel',false);const r=await f.call('post','/api/ai/price',{body:{model:'iPhone 18 Pro Max'}});assert.equal(r.statusCode,409);assert.equal(f.calls.ai,1);assert.equal(r.body.analysis,undefined);});
test('listing availability is versioned and rejects obsolete arbitrary workflow fields',async()=>{const f=await fixture();await f.db.collection('group_listings_v1').insertOne({...listing('one'),version:0});const params={id:'one'};assert.equal((await f.call('patch','/api/listings/:id',{actor:sales,params,body:{status:'closed',assignedTo:'x'}})).statusCode,400);assert.equal((await f.call('patch','/api/listings/:id',{actor:sales,params,body:{availability:'fulfilled',version:0}})).statusCode,200);assert.equal((await f.call('patch','/api/listings/:id',{actor:sales,params,body:{availability:'active',version:0}})).statusCode,409);});
test('contact management is admin-only, full-number-only, starts OFF and has a separate selection boundary',async()=>{
  const f=await fixture(),params={channelId:'channel'};
  assert.equal((await f.call('post','/api/channels/:channelId/contacts',{actor:sales,params,body:{phone:'+441234567890'}})).statusCode,403);
  for(const phone of ['441234567890','0123456789','+44 1234567890','441234567890@lid'])assert.equal((await f.call('post','/api/channels/:channelId/contacts',{params,body:{phone}})).statusCode,400);
  const add=await f.call('post','/api/channels/:channelId/contacts',{params,body:{phone:'+441234567890'}});assert.equal(add.statusCode,200);assert.equal(add.body.contact.enabled,false);
  assert.equal(await f.server.policy.allows('channel','441234567890@s.whatsapp.net'),false);assert.equal(await f.server.policy.allows('channel','1@g.us'),true);
  const target={...params,contactId:add.body.contact.id};await f.call('patch','/api/channels/:channelId/contacts/:contactId',{params:target,body:{enabled:true}});assert.equal(await f.server.policy.allows('channel',add.body.contact.id),true);
  await f.call('delete','/api/channels/:channelId/contacts/:contactId',{params:target});assert.equal(await f.server.policy.allows('channel',add.body.contact.id),false);assert.equal((await f.call('post','/api/channels/:channelId/contacts',{params,body:{phone:'+441234567890'}})).statusCode,409);
});
test('selected individual webhook creates contact-provenanced match; OFF contacts never read content and revocation hides all derived views',async()=>{
  const f=await fixture({whatsapp:true}),contactId='441234567890@s.whatsapp.net',params={channelId:'channel'};
  await f.call('post','/api/channels/:channelId/contacts',{params,body:{phone:'+441234567890',name:'Selected synthetic supplier'}});
  const poison={id:'off-personal',chat_id:contactId,is_group:false,from_me:false,timestamp:Math.floor(Date.now()/1000)};
  for(const key of ['text','caption','from'])Object.defineProperty(poison,key,{get(){throw Error('Unselected private content read');}});
  const webhook=messages=>f.call('post','/webhook',{actor:null,headers:{'x-webhook-secret':'synthetic-webhook-secret-00000000000000'},query:{channel:'channel'},body:{messages}});
  assert.equal((await webhook([poison])).body.accepted,0);
  await f.call('patch','/api/channels/:channelId/contacts/:contactId',{params:{...params,contactId},body:{enabled:true}});
  const ts=Math.floor(Date.now()/1000),text='brand new 18 pm 256GB non active HK burgundy USD ';
  const offer={id:'dm-offer',chat_id:contactId,is_group:false,from_me:false,from:'441234567890',timestamp:ts,text:{body:'WTS '+text+'1000 each qty 50'}};
  const demand={id:'group-demand',chat_id:'1@g.us',is_group:true,from_me:false,from:'971501234567',timestamp:ts,text:{body:'WTB '+text+'1100 each qty 50'}};
  assert.equal((await webhook([offer,demand])).body.accepted,2);
  const matches=await f.call('get','/api/matches');assert.equal(matches.body.matches.length,1);assert.equal(matches.body.matches[0].offer.source.sourceType,'contact');assert.equal(matches.body.matches[0].offer.source.chatId,contactId);assert.equal(matches.body.matches[0].offer.source.groupId,null);assert.equal(matches.body.matches[0].offer.source.contactPhone,'+441234567890');
  await f.call('patch','/api/channels/:channelId/contacts/:contactId',{params:{...params,contactId},body:{enabled:false}});
  assert.equal((await f.call('get','/api/matches')).body.matches.length,0);assert.equal((await f.call('get','/api/messages')).body.length,1);assert.equal((await f.call('get','/api/report')).body.listings.length,1);
  const trend=await f.call('get','/api/price-trends',{query:{model:'iPhone 18 Pro Max'}});assert.equal(trend.body.analysis.counts.input,1);assert.equal(trend.body.analysis.series[0].dimensions.kind,'buyer_budget');
});
test('aggregate snapshot reads require current source permissions and hide legacy snapshots without source evidence',async()=>{
  const f=await fixture();await f.db.collection('group_listings_v1').insertOne(listing('one'));await f.call('post','/api/snapshots');await f.db.collection('group_snapshots_v1').insertOne({date:new Date(),totalListings:999});assert.equal((await f.call('get','/api/snapshots')).body.length,1);await f.server.policy.setActive('channel',false);assert.equal((await f.call('get','/api/snapshots')).body.length,0);
});
