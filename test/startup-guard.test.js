'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {createStartupGuard,boundedCleanup}=require('../lib/startup-guard');
test('startup reports fixed stages and finishes successfully',async()=>{
 const logs=[];const guard=createStartupGuard({timeoutMS:100,log:x=>logs.push(x)});
 assert.equal(await guard.stage('mongo-connect',async()=>42),42);
 guard.finish();assert.deepEqual(logs,['Startup stage: mongo-connect']);
 await assert.rejects(guard.stage('http-listen',async()=>true),/no longer active/);
});
test('hung startup is rejected by total deadline rather than left waiting',async()=>{
 const guard=createStartupGuard({timeoutMS:20,log:()=>{}});
 await assert.rejects(guard.stage('mongo-topology',()=>new Promise(()=>{})),/deadline exceeded/);
 assert.equal(guard.stageName,'mongo-topology');guard.finish();
});
test('late connection resolution cannot advance to another startup stage',async()=>{
 let resolve;const guard=createStartupGuard({timeoutMS:20,log:()=>{}});
 await assert.rejects(guard.stage('mongo-connect',()=>new Promise(r=>{resolve=r;})),/deadline exceeded/);
 resolve(true);let called=false;
 await assert.rejects(guard.stage('http-listen',()=>{called=true;}),/no longer active/);
 assert.equal(called,false);guard.finish();
});
test('startup rejects arbitrary stage strings without logging private text',async()=>{
 const logs=[];const guard=createStartupGuard({timeoutMS:100,log:x=>logs.push(x)});
 await assert.rejects(guard.stage('mongodb://private-value',async()=>{}),/Invalid startup stage/);
 assert.deepEqual(logs,[]);guard.finish();
});
test('cleanup remains bounded when driver close never settles',async()=>{
 await boundedCleanup(()=>new Promise(()=>{}),20);
 await boundedCleanup(()=>Promise.reject(new Error('private driver details')),20);
});
