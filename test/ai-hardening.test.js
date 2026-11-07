'use strict';
// Offline route tests: no live MongoDB, listener, account, or provider call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {fixtureMongo} = require('./fake-mongo');
const {FEATURE_GATES, createAIConfig, validModel, aggregatePricePayload} = require('../lib/ai-policy');
const root = path.resolve(__dirname, '..'), filename = path.join(root, 'server.js'), localRequire = createRequire(filename);
const admin = {email:'operator@example.invalid',name:'Synthetic operator',role:'admin'};
const provider = {CLAUDE_API_KEY:'synthetic-key-never-send',ANTHROPIC_MODEL:'claude-synthetic-offline-model'};
const priceGates = {AI_PRICE_EXPLANATION_ENABLED:'true',AI_PRICE_AGGREGATES_TO_ANTHROPIC_APPROVED:'true'};
function enabled(feature) {return Object.fromEntries(FEATURE_GATES[feature].map(name => [name, 'true']));}
function listing(id = 'synthetic-message-private', group = '987654321-123456789@g.us') {
  const timestamp = Math.floor(Date.now()/1000) - 60;
  return {id,sourceKey:id,sourceLine:0,model:'iPhone 18 Pro Max',modelKey:'iphone 18 pro max',type:'WTS',priceKind:'supplier_ask',priceUnit:'unit',condition:'Brand New',storage:'256GB',region:'HK',activation:'non_active',color:'burgundy',currency:'USD',price:1000,qty:50,availability:'active',timestamp,channelId:'private-channel',group,sender:'synthetic-sender-private',source:{provider:'whapi',providerMessageId:id,sourceTimestamp:timestamp,channelId:'private-channel',groupId:group,sender:'synthetic-sender-private',lineIndex:0,isForwarded:false,contentFingerprint:'private-fingerprint-'+id},extraction:{flags:[]}};
}
async function fixture(env = {}) {
  const fake = fixtureMongo(), calls = {requests:[],onAI:null,onJSON:null,ok:true};
  const app = {routes:[],middleware:[],disable(){},use(fn){this.middleware.push(fn);}};
  for (const method of ['get','post','patch','put','delete']) app[method] = (route,...handlers) => app.routes.push({method,route,handlers});
  function express(){return app;} express.json = express.static = () => () => {};
  const context = {module:{exports:{}},Buffer,Date,AbortSignal,__dirname:root,console:{log(){},error(){}},process:{env:{JWT_SECRET:'synthetic-signing-secret-at-least-32-characters',ADMIN_EMAILS:admin.email,WHATSAPP_ENABLED:'false',...env}},
    require(name){if(name==='express')return express;if(name==='cors')return()=>()=>{};if(name==='mongodb')throw Error('Live database forbidden');return localRequire(name);},
    setInterval(){throw Error('No listeners or schedulers');},clearInterval(){},
    async fetch(url, options){calls.requests.push({url,options,body:JSON.parse(options.body)});if(calls.onAI)await calls.onAI();return {ok:calls.ok,async json(){if(calls.onJSON)await calls.onJSON();return {content:[{text:'Synthetic explanation only'}]};}};},
  };
  vm.createContext(context);
  const seam = '\nmodule.exports.__install=async(d,c)=>{db=d;tradeStore=new TradeStore(d,c);policy=new MongoChannelPolicy(d.collection("channel_privacy"));await policy.initialize();};';
  vm.runInContext(fs.readFileSync(filename,'utf8')+seam,context,{filename});
  const server = context.module.exports; await server.__install(fake.db,fake.client);
  await fake.db.collection('users').insertOne(admin);
  await server.policy.create('private-channel','Private channel name');
  await server.policy.mergeGroups('private-channel',[{id:'987654321-123456789@g.us',name:'Private group name'},{id:'876543210-234567891@g.us',name:'OFF group name'}],(await server.policy.get('private-channel')).generation);
  await server.policy.setGroups('private-channel',[{id:'987654321-123456789@g.us',enabled:true}]);
  await server.policy.setActive('private-channel',true);
  await fake.db.collection('group_listings_v1').insertOne(listing());
  async function call(route,body = {},method = 'post') {
    const entry = app.routes.find(r => r.method===method && r.route===route); assert.ok(entry,route);
    const req = {body,query:body,params:{},headers:{authorization:'Bearer '+server.makeToken(admin)}};
    const res = {statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;this.done=true;return this;}};
    for(const fn of entry.handlers){let next=false,error;await fn(req,res,e=>{next=true;error=e;});if(error){await app.middleware.find(f=>f.length===4)(error,req,res,()=>{});break;}if(!next||res.done)break;}
    return res;
  }
  return {...fake,server,calls,call};
}
const bodies = {
  price:{model:'iPhone 18 Pro Max'},briefing:{},profile:{query:'synthetic-sender-private'},
  autoreply:{listing:{id:'synthetic-message-private',sender:'client-forged-phone',raw:'client-forged-secret'},intent:'Synthetic intent'},
  item:{question:'Synthetic question'},
};
async function callAll(f){for(const feature of Object.keys(FEATURE_GATES))assert.equal((await f.call('/api/ai/'+feature,bodies[feature])).statusCode,200,feature);}

test('all AI is default OFF and legacy AI_ENABLED never enables any route', async () => {
  for (const env of [{}, {...provider}, {...provider,AI_ENABLED:'true'}]) {
    const config = createAIConfig(env);
    for (const feature of Object.keys(FEATURE_GATES)) assert.equal(config.ready(feature),false);
    const f = await fixture(env); await callAll(f); assert.equal(f.calls.requests.length,0);
    const prices = await f.call('/api/ai/price',bodies.price);
    assert.match(prices.body.result,/Historical asking prices/); assert.equal(prices.body.analysis.counts.included,1);
    const trends = await f.call('/api/price-trends',bodies.price,'get');assert.equal(trends.body.analysis.counts.included,1);assert.equal(f.calls.requests.length,0);
  }
});

test('each feature requires its own enable flag AND explicit sharing approval', async () => {
  for (const feature of Object.keys(FEATURE_GATES)) {
    const [flag, approval] = FEATURE_GATES[feature];
    for (const env of [{[flag]:'true'},{[approval]:'true'},{[flag]:'true',[approval]:'TRUE'},{[flag]:true,[approval]:'true'}]) {
      const f = await fixture({...provider,AI_ENABLED:'true',...env});await callAll(f);assert.equal(f.calls.requests.length,0,JSON.stringify(env));
    }
    const f = await fixture({...provider,...enabled(feature)});await callAll(f);
    assert.equal(f.calls.requests.length,1,feature+' must not enable other routes');
    assert.equal(f.calls.requests[0].body.model,provider.ANTHROPIC_MODEL);
  }
});

test('explicit valid model and provider key are required, with no retired default or fallback', async () => {
  for (const model of [undefined,'',' ','claude-sonnet-4-20250514','claude-unsafe\ntext','https://untrusted.invalid','claude-'+'x'.repeat(100),'claude-x/../y','gpt-test']) {
    assert.equal(validModel(model),false);
    const f=await fixture({...provider,...Object.assign({},...Object.keys(FEATURE_GATES).map(enabled)),ANTHROPIC_MODEL:model});await callAll(f);assert.equal(f.calls.requests.length,0);
  }
  for(const key of [undefined,'','  ']) {
    const f=await fixture({...provider,...priceGates,CLAUDE_API_KEY:key});assert.equal((await f.call('/api/ai/price',bodies.price)).statusCode,200);assert.equal(f.calls.requests.length,0);
  }
  assert.equal(createAIConfig({...provider,...priceGates}).ready('__proto__'),false);
});

test('aggregate provider body contains only numeric aggregates, anonymous series and closed enums', async () => {
  const f = await fixture({...provider,...priceGates});
  const row = listing('do-not-send-provider-id');
  row.model = row.modelKey = 'private model text call +441234567890';
  row.storage='private-storage-message';row.region='private-region-message';row.color='private-color-message';
  row.sim='private-sim-message';row.ram='private-ram-message';row.location='private-market-message';row.shippingTerms='private-shipping-message';
  row.sender='+441234567890';row.source.sender=row.sender;row.source.originalOfferId='private-original-offer';
  row.raw='RAW MESSAGE SECRET';row.source.raw='nested private text';row.sellerCountry='private-country';
  await f.db.collection('group_listings_v1').insertOne(row);
  const result = await f.call('/api/ai/price',{model:row.model,question:'USER TEXT SECRET',intent:'user private intent'});
  assert.equal(result.statusCode,200);assert.equal(result.body.analysis.counts.included,1);assert.equal(f.calls.requests.length,1);
  const request=f.calls.requests[0],encoded=JSON.stringify(request.body),payload=JSON.parse(request.body.messages[0].content);
  assert.equal(request.url,'https://api.anthropic.com/v1/messages');assert.equal(request.options.headers['x-api-key'],provider.CLAUDE_API_KEY);
  assert.deepEqual(Object.keys(request.body).sort(),['max_tokens','messages','model','system']);
  for(const marker of [row.model,row.storage,row.region,row.color,row.sim,row.ram,row.location,row.shippingTerms,row.sender,row.id,row.source.originalOfferId,row.source.contentFingerprint,row.channelId,row.group,row.raw,row.source.raw,row.sellerCountry,'USER TEXT SECRET','user private intent','sourceRef','evidenceIds','providerMessageId','dimensions'])assert.equal(encoded.includes(marker),false,marker);
  assert.equal(payload.series[0].label,'series_1');assert.equal(payload.series[0].currency,'USD');assert.equal(payload.series[0].kind,'asking_price');
  assert.equal(payload.series[0].summary.median,1000);assert.equal(payload.series[0].summary.uniqueSourceCount,1);assert.equal(payload.series[0].trend.forecast,false);
  assert.match(result.body.result,/AI explanation/);
});

test('serializer discards arbitrary text even in warning/reason/model/currency/numeric fields', () => {
  const secret = 'PRIVATE +971501234567 message';
  const payload = aggregatePricePayload({asOf:secret,windowStart:secret,bucket:secret,policy:{windowDays:56,minQuantity:secret},counts:{input:1,included:1,excluded:0,duplicatesRemoved:0,secret},limitations:[secret],exclusions:[{id:secret,reasons:[secret]}],series:[{key:secret,dimensions:{model:secret,storage:secret,gradingMethod:secret,gradingNamespace:secret,supplierGrade:secret,currency:secret,kind:secret},summary:{median:secret,min:Infinity,max:{toJSON(){return secret;}},sampleCount:1,uniqueSourceCount:1,evidenceIds:[secret]},warnings:['unknown_sim',secret],buckets:[{start:secret,end:secret,complete:true,median:123,sampleCount:1,evidenceIds:[secret]}],trend:{status:secret,reasons:['insufficient_samples',secret],delta:secret,percentChange:NaN,direction:secret,evidenceIds:[secret],forecast:true},evidence:[{sourceRef:secret,id:secret,observedAt:secret}]}]});
  assert.equal(JSON.stringify(payload).includes(secret),false);
  assert.deepEqual(payload.series[0].warnings,['unknown_sim']);assert.deepEqual(payload.series[0].trend.reasons,['insufficient_samples']);
  assert.equal(payload.series[0].currency,'not_disclosed');assert.equal(payload.series[0].summary.median,null);assert.equal(payload.series[0].summary.max,null);assert.equal(payload.series[0].trend.forecast,false);
  const encoded = JSON.stringify(payload);for(const field of ['evidence','sourceRef','gradingNamespace','supplierGrade','observedAt','windowStart'])assert.equal(encoded.includes(field),false,field);
});

test('different exact specs remain independent anonymous series even when currency is withheld', async () => {
  const f=await fixture({...provider,...priceGates});
  await f.db.collection('group_listings_v1').insertMany([{...listing('second-private'),currency:'ZZZ',storage:'private-spec-1'},{...listing('third-private'),currency:'ZZZ',storage:'private-spec-2',price:1200}]);
  const result=await f.call('/api/ai/price',bodies.price);assert.equal(result.statusCode,200);
  const payload=JSON.parse(f.calls.requests[0].body.messages[0].content);assert.equal(payload.series.length,3);
  assert.deepEqual(payload.series.map(s=>s.label),['series_1','series_2','series_3']);assert.equal(payload.series.filter(s=>s.currency==='not_disclosed').length,2);
  assert.equal(JSON.stringify(payload).includes('ZZZ'),false);assert.equal(JSON.stringify(payload).includes('private-spec'),false);
});

test('selected contact-derived data is stripped of contact metadata before aggregate sharing',async()=>{
  const f=await fixture({...provider,...priceGates}),contactId='441234567890@s.whatsapp.net';
  await f.server.policy.addContact('private-channel',{phone:'+441234567890',name:'Private person'});
  await f.server.policy.setContacts('private-channel',[{id:contactId,enabled:true}]);
  const row=listing('private-contact-message',contactId);row.source.sourceType='contact';row.source.chatId=contactId;row.source.groupId=null;row.source.contactPhone='+441234567890';row.source.sender=contactId;
  await f.db.collection('group_listings_v1').insertOne(row);
  const result=await f.call('/api/ai/price',bodies.price);assert.equal(result.statusCode,200);assert.equal(result.body.analysis.counts.included,2);
  const body=JSON.stringify(f.calls.requests[0].body);for(const privateText of [contactId,'+441234567890','Private person','private-contact-message','sourceType','contactPhone','chatId'])assert.equal(body.includes(privateText),false);
});

test('permission revoked between analysis and external dispatch prevents the provider request',async()=>{
  const f=await fixture({...provider,...priceGates});
  const original=f.server.policy.list.bind(f.server.policy);let checks=0;
  f.server.policy.list=async()=>{if(++checks===4)await f.server.policy.setActive('private-channel',false);return original();};
  const result=await f.call('/api/ai/price',bodies.price);assert.equal(result.statusCode,409);assert.equal(f.calls.requests.length,0);assert.equal(result.body.analysis,undefined);
});

test('permission revoked while reading provider response discards the complete result',async()=>{
  const f=await fixture({...provider,...priceGates});f.calls.onJSON=()=>f.server.policy.setActive('private-channel',false);
  const result=await f.call('/api/ai/price',bodies.price);assert.equal(result.statusCode,409);assert.equal(f.calls.requests.length,1);assert.equal(result.body.analysis,undefined);assert.equal(result.body.result,undefined);
});

test('unselected or revoked source records never contribute to outbound aggregates',async()=>{
  const f=await fixture({...provider,...priceGates});await f.db.collection('group_listings_v1').insertOne({...listing('unselected-private','876543210-234567891@g.us'),price:999999});
  let result=await f.call('/api/ai/price',bodies.price);assert.equal(result.statusCode,200);
  const payload=JSON.parse(f.calls.requests[0].body.messages[0].content);assert.equal(payload.counts.input,1);assert.equal(payload.series[0].summary.max,1000);
  await f.server.policy.setActive('private-channel',false);result=await f.call('/api/ai/price',bodies.price);assert.equal(result.body.analysis.counts.input,0);assert.equal(f.calls.requests.length,1);
});

test('all source-reading non-aggregate AI routes discard responses after source revocation',async()=>{
  for(const feature of ['briefing','profile','autoreply']){
    const f=await fixture({...provider,...enabled(feature)});f.calls.onAI=()=>f.server.policy.setActive('private-channel',false);
    const result=await f.call('/api/ai/'+feature,bodies[feature]);assert.equal(result.statusCode,409,feature);assert.equal(result.body.result,undefined);assert.equal(f.calls.requests.length,1);
  }
});

test('fully authorized reply drafts use canonical listing and bounded plain-text intent',async()=>{
  const f=await fixture({...provider,...enabled('autoreply')});
  assert.equal((await f.call('/api/ai/autoreply',bodies.autoreply)).statusCode,200);
  const body=JSON.stringify(f.calls.requests[0].body);assert.equal(body.includes('client-forged-phone'),false);assert.equal(body.includes('client-forged-secret'),false);assert.equal(body.includes('synthetic-sender-private'),true);
  for(const intent of [undefined,{},'', 'x'.repeat(4001)])assert.equal((await f.call('/api/ai/autoreply',{...bodies.autoreply,intent})).statusCode,400);
  assert.equal(f.calls.requests.length,1);
});

test('provider rejection triggers no model fallback or second request',async()=>{
  const f=await fixture({...provider,...priceGates});f.calls.ok=false;
  const result=await f.call('/api/ai/price',bodies.price);assert.equal(result.statusCode,502);assert.equal(f.calls.requests.length,1);assert.equal(f.calls.requests[0].body.model,provider.ANTHROPIC_MODEL);
});


test('OFF then ON during any source-reading AI request invalidates its original authorization',async()=>{
  for(const feature of ['price','briefing','profile','autoreply']){
    const f=await fixture({...provider,...enabled(feature)});
    f.calls.onAI=async()=>{await f.server.policy.setActive('private-channel',false);await f.server.policy.setActive('private-channel',true);};
    const result=await f.call('/api/ai/'+feature,bodies[feature]);assert.equal(result.statusCode,409,feature);assert.equal(result.body.result,undefined);assert.equal(f.calls.requests.length,1);
  }
});

test('direct-contact revocation during aggregate AI invalidates the response',async()=>{
  const f=await fixture({...provider,...priceGates}),contactId='441234567890@s.whatsapp.net';
  await f.server.policy.addContact('private-channel',{phone:'+441234567890',name:'Private person'});
  await f.server.policy.setContacts('private-channel',[{id:contactId,enabled:true}]);
  const row=listing('private-contact-message',contactId);row.source.sourceType='contact';row.source.chatId=contactId;row.source.groupId=null;row.source.contactPhone='+441234567890';row.source.sender=contactId;
  await f.db.collection('group_listings_v1').insertOne(row);
  f.calls.onAI=()=>f.server.policy.setContacts('private-channel',[{id:contactId,enabled:false}]);
  const result=await f.call('/api/ai/price',bodies.price);assert.equal(result.statusCode,409);assert.equal(result.body.result,undefined);assert.equal(f.calls.requests.length,1);
});


test('original selected-read grants reject OFF then ON before later AI lease checks',async()=>{
  for(const feature of ['price','briefing','profile','autoreply']){
    const f=await fixture({...provider,...enabled(feature)});
    const original=f.server.policy.list.bind(f.server.policy);let checks=0;
    f.server.policy.list=async()=>{if(++checks===3){await f.server.policy.setActive('private-channel',false);await f.server.policy.setActive('private-channel',true);}return original();};
    const result=await f.call('/api/ai/'+feature,bodies[feature]);
    assert.equal(result.statusCode,409,feature);assert.equal(f.calls.requests.length,0,feature);assert.equal(result.body.result,undefined);assert.equal(result.body.analysis,undefined);
  }
});

test('original selected-read grants survive harmless source metadata refresh without being replaced',async()=>{
  const f=await fixture({...provider,...priceGates});
  const original=f.server.policy.list.bind(f.server.policy);let checks=0;
  f.server.policy.list=async()=>{if(++checks===3)await f.server.policy.mergeGroups('private-channel',[{id:'987654321-123456789@g.us',name:'Refreshed label'}],(await f.server.policy.get('private-channel')).generation);return original();};
  const result=await f.call('/api/ai/price',bodies.price);assert.equal(result.statusCode,200);assert.equal(f.calls.requests.length,1);
  assert.equal(JSON.stringify(f.calls.requests[0].body).includes('Refreshed label'),false);assert.equal(result.body.grants,undefined);
});


test('two-channel final authorization uses one fresh snapshot and no sequential source-lease window',async()=>{
  for(const toggleBackOn of [false,true]){
    const f=await fixture({...provider,...priceGates});
    await f.server.policy.create('second-channel','Second private channel');
    await f.server.policy.mergeGroups('second-channel',[{id:'765432109-345678912@g.us',name:'Second private group'}],(await f.server.policy.get('second-channel')).generation);
    await f.server.policy.setGroups('second-channel',[{id:'765432109-345678912@g.us',enabled:true}]);
    await f.server.policy.setActive('second-channel',true);
    const row=listing('second-channel-private-message','765432109-345678912@g.us');row.channelId='second-channel';row.source.channelId='second-channel';row.source.sender='second-private-sender';row.price=1100;
    await f.db.collection('group_listings_v1').insertOne(row);
    const originalList=f.server.policy.list.bind(f.server.policy);let snapshots=0,leaseCalls=0;
    f.server.policy.lease=async()=>{leaseCalls++;throw Error('No per-source awaited authorization checks allowed');};
    f.server.policy.list=async()=>{
      // The fourth read is the final fresh snapshot before dispatch, after the
      // original two-source read and completed analysis. Revoke the first source.
      if(++snapshots===4){await f.server.policy.setActive('private-channel',false);if(toggleBackOn)await f.server.policy.setActive('private-channel',true);}
      return originalList();
    };
    const result=await f.call('/api/ai/price',bodies.price);
    assert.equal(result.statusCode,409);assert.equal(f.calls.requests.length,0);assert.equal(leaseCalls,0);assert.equal(snapshots,4);assert.equal(result.body.analysis,undefined);
  }
});


test('safe AI configuration status explains disabled, unapproved, missing-model and missing-key states',async()=>{
  const cases=[
    {env:{},expected:'disabled'},
    {env:{...provider,AI_PRICE_EXPLANATION_ENABLED:'true'},expected:'sharing_not_approved'},
    {env:{...priceGates,CLAUDE_API_KEY:provider.CLAUDE_API_KEY},expected:'model_missing_or_invalid'},
    {env:{...provider,...priceGates,ANTHROPIC_MODEL:'claude-sonnet-4-20250514'},expected:'model_missing_or_invalid'},
    {env:{...priceGates,ANTHROPIC_MODEL:provider.ANTHROPIC_MODEL},expected:'credentials_missing'},
    {env:{...provider,...priceGates},expected:'ready'},
  ];
  for(const {env,expected} of cases){
    const f=await fixture(env),result=await f.call('/api/ai/price',bodies.price);
    assert.equal(result.statusCode,200);assert.equal(result.body.ai.status,expected);assert.deepEqual(Object.keys(result.body.ai),['status']);
    assert.match(result.body.result,/Historical asking prices/);assert.equal(result.body.analysis.counts.included,1);
    assert.equal(JSON.stringify(result.body).includes(provider.CLAUDE_API_KEY),false);assert.equal(JSON.stringify(result.body).includes(provider.ANTHROPIC_MODEL),false);
    assert.equal(f.calls.requests.length,expected==='ready'?1:0);
  }
  for(const feature of ['briefing','profile','autoreply','item']){
    const f=await fixture({...enabled(feature),CLAUDE_API_KEY:provider.CLAUDE_API_KEY});
    const result=await f.call('/api/ai/'+feature,bodies[feature]);assert.equal(result.body.ai.status,'model_missing_or_invalid');
    assert.match(result.body.result,/ANTHROPIC_MODEL/);assert.equal(f.calls.requests.length,0);
  }
});
