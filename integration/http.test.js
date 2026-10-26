'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {MongoClient}=require('mongodb');
const {hashPassword}=require('../lib/auth-security');
test('real HTTP login/logout and disconnected webhook against disposable MongoDB', {timeout:60000}, async()=>{
  const name='wt_ci_'+randomUUID().replaceAll('-','');
  // Discard provider/production settings; only loopback synthetic data is used.
  for(const k of Object.keys(process.env)) if(k.startsWith('AI_')||['CLAUDE_API_KEY','WHAPI_TOKENS_JSON','WEBHOOK_SECRET','TRUST_PROXY_CIDRS'].includes(k)) delete process.env[k];
  Object.assign(process.env,{MONGO_URI:'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true',MONGODB_DB_NAME:name,JWT_SECRET:'synthetic-http-session-secret-not-production-000000',ADMIN_EMAILS:'synthetic@example.invalid',APP_ALLOWED_EMAILS:'',WHATSAPP_ENABLED:'false',PORT:'0'});
  const client=new MongoClient(process.env.MONGO_URI,{serverSelectionTimeoutMS:5000});
  let server;
  try {
    await client.connect();
    await client.db(name).collection('users').insertOne({email:'synthetic@example.invalid',name:'Synthetic owner',role:'admin',authVersion:0,passwordHash:await hashPassword('synthetic-password-not-for-production-1234')});
    server=await require('../server').start();
    const base='http://127.0.0.1:'+server.address().port;
    const health=await fetch(base+'/health'); assert.equal(health.status,200);
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'synthetic@example.invalid',password:'synthetic-password-not-for-production-1234'})});
    assert.equal(login.status,200); const {token}=await login.json(); assert.ok(token);
    const headers={Authorization:'Bearer '+token};
    assert.equal((await fetch(base+'/api/auth/me',{headers})).status,200);
    assert.equal((await fetch(base+'/api/auth/logout',{method:'POST',headers})).status,200);
    assert.equal((await fetch(base+'/api/auth/me',{headers})).status,401);
    const ingress=await fetch(base+'/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{id:'synthetic',text:{body:'synthetic ignored'}}]})});
    assert.equal(ingress.status,503);
    assert.equal(await client.db(name).collection('group_messages_v1').countDocuments(),0);
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    await client.db(name).dropDatabase().catch(()=>{}); await client.close();
  }
});
