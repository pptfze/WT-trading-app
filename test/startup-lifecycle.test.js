'use strict';
// Exercise actual server.start with controlled Express/Mongo adapters. No ports,
// external network, credentials or production DB writes; not a socket test.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {EventEmitter}=require('node:events');
const {fixtureMongo}=require('./fake-mongo');
const root=path.resolve(__dirname,'..'),localRequire=createRequire(path.join(root,'server.js'));
async function harness(){
  const fake=fixtureMongo(),logs=[];let deadline,listenCallback,resolveListening,closes=0,mongoCloses=0,open=false;
  const listening=new Promise(resolve=>{resolveListening=resolve;});
  const listener=new EventEmitter();
  listener.close=callback=>{closes++;open=false;callback?.();return listener;};
  listener.closeAllConnections=()=>{open=false;};
  const app={use(){},disable(){},set(){},listen(port,callback){listenCallback=callback;resolveListening();return listener;}};
  for(const method of ['get','post','patch','put','delete'])app[method]=()=>{};
  function express(){return app;}express.json=express.static=()=>()=>{};
  const guardModule={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'lib/startup-guard.js'),'utf8'),{
    module:guardModule,console:{log:x=>logs.push(x)},setTimeout:fn=>{deadline=fn;return {};},clearTimeout:()=>{},
  });
  // Use the real bounded-cleanup timer; only the total startup deadline is manual.
  guardModule.exports.boundedCleanup=(work)=>localRequire('./lib/startup-guard').boundedCleanup(work,20);
  fake.db.admin=()=>({command:async()=>({setName:'synthetic-rs',logicalSessionTimeoutMinutes:30})});
  class MongoClient{async connect(){return this;}db(){return fake.db;}async close(){mongoCloses++;}startSession(){return fake.client.startSession();}}
  const moduleObject={exports:{}};
  const context={module:moduleObject,exports:moduleObject.exports,__dirname:root,Buffer,AbortSignal,URL,
    setTimeout,clearTimeout,setInterval,clearInterval,console:{log:x=>logs.push(x),error:x=>logs.push(x)},
    process:{env:{JWT_SECRET:'synthetic-startup-test-secret-only-0000',ADMIN_EMAILS:'synthetic@example.invalid',WHATSAPP_ENABLED:'false',MONGO_URI:'mongodb://synthetic.invalid',MONGODB_DB_NAME:'synthetic_startup'},exit(){throw new Error('Imported start must not exit');}},
    require(name){if(name==='express')return express;if(name==='cors')return ()=>()=>{};if(name==='mongodb')return {MongoClient};if(name==='mongodb/package.json')return {version:'6.21.0'};if(name==='./lib/startup-guard')return guardModule.exports;return localRequire(name);},
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'server.js'),'utf8'),context,{filename:path.join(root,'server.js')});
  return {server:moduleObject.exports,listening,expire:()=>deadline(),lateListen:()=>{open=true;listenCallback();},get closes(){return closes;},get mongoCloses(){return mongoCloses;},get open(){return open;},logs};
}
test('actual startup closes pending listener and closes it again on late listening callback',async()=>{
 const h=await harness();const started=h.server.start();const rejected=assert.rejects(started,/deadline exceeded/);
 await h.listening;h.expire();await rejected;
 assert.ok(h.closes>=1,'failed startup must close pending listener');assert.ok(h.mongoCloses>=1);
 const before=h.closes;h.lateListen();await new Promise(resolve=>setImmediate(resolve));
 assert.ok(h.closes>before,'late listening callback must close again');assert.equal(h.open,false);
 assert.equal(h.server.policy,null,'failed policy must be detached');
 assert.equal(h.logs.some(line=>line.includes('Platform on port')),false);
 assert.equal(h.logs.some(line=>line.includes('synthetic.invalid')),false);
});
