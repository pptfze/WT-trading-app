'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixtureMongo}=require('./fake-mongo');
const {MongoChannelPolicy,validateTransactionTopology}=require('../lib/mongo-channel-policy');
const {TradeStore}=require('../lib/trade-store');
async function fixture(){
  const f=fixtureMongo(),policy=new MongoChannelPolicy(f.db),store=new TradeStore(f.db,f.client);
  assert.equal(await policy.initialize(),true);
  const channel=await policy.create('synthetic');
  await policy.mergeGroups('synthetic',[{id:'1@g.us',name:'Synthetic'}],channel.generation);
  await policy.setGroups('synthetic',[{id:'1@g.us',enabled:true}]);
  await policy.setActive('synthetic',true);
  const lease=await policy.lease('synthetic','1@g.us');
  return {...f,policy,store,lease,fence:session=>policy.fence(session,'synthetic','1@g.us',lease)};
}
test('message commit requires a real policy revision write in the same transaction session',async()=>{
  const f=await fixture();let allowedCalls=0;
  await f.store.persistMessage({_id:'synthetic'},[{id:'synthetic:0'}],async()=>{allowedCalls++;return true;},f.fence);
  const lock=f.calls.find(c=>c.name==='channel_privacy'&&c.update?.$inc);
  const insert=f.calls.find(c=>c.name==='group_messages_v1'&&c.action==='insertOne');
  assert.ok(lock);assert.equal(lock.options.session,insert.options.session);assert.equal(allowedCalls,1);
  assert.equal(lock.update.$inc.revision,1);assert.equal(lock.options.upsert,false);
  assert.ok(f.calls.indexOf(lock)<f.calls.indexOf(insert));
});
test('revoked or OFF then ON lease cannot authorize transaction writes',async()=>{
  for(const resume of [false,true]){
    const f=await fixture();await f.policy.setActive('synthetic',false);if(resume)await f.policy.setActive('synthetic',true);
    await assert.rejects(f.store.persistMessage({_id:'synthetic'},[],async()=>true,f.fence),/selection changed/);
    assert.equal(await f.store.hasMessage('synthetic'),false);
  }
});
test('policy fence refuses missing/outside transaction sessions and absent fence',async()=>{
  const f=await fixture();await assert.rejects(f.policy.fence(null,'synthetic','1@g.us',f.lease));
  await assert.rejects(f.policy.fence({inTransaction:()=>false},'synthetic','1@g.us',f.lease));
  await assert.rejects(f.store.persistMessage({_id:'synthetic'},[],async()=>true),/fence unavailable/);
});
test('failed transaction rolls back its fence revision and message writes',async()=>{
  const f=await fixture(),before=f.state.get('channel_privacy')[0].revision;
  await assert.rejects(f.store.persistMessage({_id:'synthetic'},[],async()=>true,async session=>{await f.fence(session);throw new Error('Synthetic failure');}));
  assert.equal(f.state.get('channel_privacy')[0].revision,before);assert.equal(await f.store.hasMessage('synthetic'),false);
});
test('unacknowledged or no-op policy fence cannot authorize retained content',async()=>{
  for(const result of [{acknowledged:false},{acknowledged:true,matchedCount:1,modifiedCount:0}]){
    const f=await fixture();f.policy.collection.updateOne=async()=>result;
    await assert.rejects(f.store.persistMessage({_id:'synthetic'},[],async()=>true,f.fence));
    assert.equal(await f.store.hasMessage('synthetic'),false);
  }
});

test('startup topology guard rejects standalone or sessionless databases',()=>{
  for(const topology of [null,{}, {logicalSessionTimeoutMinutes:30},{setName:'rs0'},{setName:'rs0',logicalSessionTimeoutMinutes:0}])assert.throws(()=>validateTransactionTopology(topology));
  assert.equal(validateTransactionTopology({setName:'rs0',logicalSessionTimeoutMinutes:30}),true);
  assert.equal(validateTransactionTopology({msg:'isdbgrid',logicalSessionTimeoutMinutes:30}),true);
});
