'use strict';
// Hardcoded loopback-only disposable database: never reads Atlas credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {MongoClient} = require('mongodb');
const {MongoChannelPolicy} = require('../lib/mongo-channel-policy');
const {MongoLoginLimiter} = require('../lib/login-limiter');
const {TradeStore} = require('../lib/trade-store');
test('isolated replica-set indexes, durable defaults, commit/dedup/rollback and shared login limits', {timeout:60000}, async () => {
  const client = new MongoClient('mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true', {serverSelectionTimeoutMS:5000});
  const db = client.db('wt_ci_' + randomUUID().replaceAll('-', ''));
  try {
    await client.connect();
    const hello = await db.admin().command({hello:1});
    assert.equal(hello.setName, 'rs0');
    const policy = new MongoChannelPolicy(db);
    assert.equal(await policy.initialize(), true);
    assert.deepEqual(await policy.list(), []);
    const restarted = new MongoChannelPolicy(db);
    assert.equal(await restarted.initialize(), true);
    assert.deepEqual(await restarted.list(), []);
    const store = new TradeStore(db, client);
    await store.initialize();
    const channel = await policy.create('synthetic');
    await policy.mergeGroups('synthetic', [{id:'1@g.us',name:'Synthetic'}], channel.generation);
    await policy.setGroups('synthetic', [{id:'1@g.us',enabled:true}]);
    await policy.setActive('synthetic', true);
    const lease = await policy.lease('synthetic','1@g.us');
    const fence = session => policy.fence(session,'synthetic','1@g.us',lease);
    assert.deepEqual(await store.persistMessage({_id:'synthetic-ok'}, [{id:'synthetic-ok:0'}], async()=>true, fence), {duplicate:false});
    assert.deepEqual(await store.persistMessage({_id:'synthetic-ok'}, [{id:'synthetic-ok:0'}], async()=>true, fence), {duplicate:true});
    await assert.rejects(store.persistMessage({_id:'synthetic-rollback'}, [{id:'synthetic-rollback:0'}], async()=>true, async session=>{await fence(session);throw new Error('Synthetic rollback');}), /Synthetic rollback/);
    assert.equal(await store.hasMessage('synthetic-rollback'), false);
    assert.equal(await db.collection('group_listings_v1').countDocuments({id:'synthetic-rollback:0'}), 0);
    // Once the transaction has the fence write lock, revocation cannot be
    // acknowledged until this message commit finishes. Do not await it inside.
    let revocation, revoked = false;
    await store.persistMessage({_id:'synthetic-before-revoke'}, [], async()=>true, async session=>{
      await fence(session);
      revocation = restarted.setActive('synthetic',false).then(()=>{revoked=true;});
      await new Promise(resolve=>setTimeout(resolve,50));
      assert.equal(revoked,false);
    });
    await revocation;
    assert.equal(await store.hasMessage('synthetic-before-revoke'),true);
    await assert.rejects(store.persistMessage({_id:'synthetic-after-revoke'}, [], async()=>true,fence), /selection changed/);
    assert.equal(await store.hasMessage('synthetic-after-revoke'),false);
    // OFF/ON cannot revive a captured grant, even though currently selected.
    await policy.setActive('synthetic',true);
    await assert.rejects(store.persistMessage({_id:'synthetic-stale-grant'}, [], async()=>true,fence), /selection changed/);
    assert.equal(await store.hasMessage('synthetic-stale-grant'),false);
    // Force an actual stale-snapshot write conflict: revocation commits after
    // the transaction snapshot read but before its fence write. Driver retry
    // must revalidate the original grant, not capture a newly enabled lease.
    const liveCollection=db.collection('channel_privacy');
    let interleaved=false;
    const racingPolicy=new MongoChannelPolicy({
      findOne:async(filter,options)=>{
        const document=await liveCollection.findOne(filter,options);
        if(options?.session&&!interleaved){interleaved=true;await restarted.setActive('synthetic',false);}
        return document;
      },
      updateOne:(...args)=>liveCollection.updateOne(...args),
    });
    assert.equal(await racingPolicy.initialize(),true);
    const latestLease=await policy.lease('synthetic','1@g.us');
    await assert.rejects(store.persistMessage({_id:'synthetic-write-conflict'},[],async()=>true,
      session=>racingPolicy.fence(session,'synthetic','1@g.us',latestLease)),/selection changed/);
    assert.equal(interleaved,true);
    assert.equal(await store.hasMessage('synthetic-write-conflict'),false);
    const collection = db.collection('auth_login_limits_v1');
    const options = {client, now:()=>1800000000000};
    const first = new MongoLoginLimiter(collection, 'synthetic-only-not-a-production-secret-0000', options);
    const second = new MongoLoginLimiter(collection, 'synthetic-only-not-a-production-secret-0000', options);
    await first.initialize(); await second.initialize();
    for(let i=0;i<10;i++) assert.equal((await (i%2?first:second).consume({email:'synthetic@example.invalid',ip:'192.0.2.1'})).allowed, true);
    assert.equal((await second.consume({email:'synthetic@example.invalid',ip:'192.0.2.1'})).allowed, false);
    assert.equal(await collection.countDocuments({attempts:10}), 3);
  } finally {
    await db.dropDatabase().catch(()=>{});
    await client.close();
  }
});
