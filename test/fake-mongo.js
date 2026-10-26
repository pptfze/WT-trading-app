'use strict';
// Purpose-built offline adapter. This tests our filters/transactions/CAS logic,
// not the MongoDB driver, replica-set behavior or real database guarantees.
const copy=v=>v==null?v:structuredClone(v);
const at=(o,key)=>key.split('.').reduce((v,k)=>v?.[k],o);
function matches(row,query) {return Object.entries(query).every(([key,value])=>{
  const actual=at(row,key);
  if(value&&typeof value==='object'&&!Array.isArray(value))return Object.entries(value).every(([op,v])=>op==='$gte'?actual>=v:op==='$gt'?actual>v:op==='$lt'?actual<v:op==='$in'?v.includes(actual):op==='$type'?typeof actual===v:false);
  return actual===value;
});}
function fixtureMongo() {
  const state=new Map(),calls=[];let queue=Promise.resolve();
  const db={state,calls,collection(name) {
    if(!state.has(name))state.set(name,[]);
    const rows=()=>state.get(name);
    const api={
      async createIndex(fields,options) {calls.push({action:'index',name,fields,options});},
      async findOne(query,options) {calls.push({action:'findOne',name,query,options});return copy(rows().find(x=>matches(x,query))||null);},
      find(query={}) {let order={},offset=0,limit=Infinity;return {sort(o){order=o;return this;},skip(n){offset=n;return this;},limit(n){limit=n;return this;},async toArray(){return copy(rows().filter(x=>matches(x,query)).sort((a,b)=>{for(const [k,d] of Object.entries(order)){if(a[k]!==b[k])return (a[k]>b[k]?1:-1)*d;}return 0;}).slice(offset,offset+limit));}};},
      async insertOne(document,options) {calls.push({action:'insertOne',name,options});if(rows().some(r=>document._id!==undefined&&r._id===document._id||document.id!==undefined&&r.id===document.id)){const e=new Error('Synthetic duplicate');e.code=11000;throw e;}rows().push(copy(document));return {acknowledged:true,insertedId:document._id};},
      async insertMany(documents,options) {for(const doc of documents)await api.insertOne(doc,options);return {acknowledged:true};},
      async updateOne(query,update,options={}) {calls.push({action:'updateOne',name,query,update,options});let row=rows().find(x=>matches(x,query));if(!row&&options.upsert){row={...query,...copy(update.$setOnInsert)};rows().push(row);return {acknowledged:true,matchedCount:0,modifiedCount:0,upsertedCount:1};}if(!row)return {acknowledged:true,matchedCount:0,modifiedCount:0,upsertedCount:0};apply(row,update);return {acknowledged:true,matchedCount:1,modifiedCount:1,upsertedCount:0};},
      async findOneAndUpdate(query,update,options) {calls.push({action:'findOneAndUpdate',name,query,update,options});const row=rows().find(x=>matches(x,query));if(!row)return null;apply(row,update);return copy(row);},
      async replaceOne(query,replacement) {const idx=rows().findIndex(x=>matches(x,query));if(idx<0)return {acknowledged:true,matchedCount:0,modifiedCount:0};rows()[idx]=copy(replacement);return {acknowledged:true,matchedCount:1,modifiedCount:1};},
    };return api;
  },async command(){return {ok:1};}};
  const client={startSession(){return {inTransaction(){return true;},async withTransaction(work,options){calls.push({action:'transaction',options});const previous=queue;let release;queue=new Promise(r=>release=r);await previous;const snapshot=copy(state);try{return await work();}catch(e){state.clear();for(const [k,v]of snapshot)state.set(k,v);throw e;}finally{release();}},async endSession(){calls.push({action:'endSession'});}};}};
  return {db,client,state,calls};
}
function apply(row,update){Object.assign(row,copy(update.$set||{}));for(const[k,v]of Object.entries(update.$inc||{}))row[k]=(row[k]||0)+v;for(const[k,v]of Object.entries(update.$push||{})){row[k]||=[];row[k].push(copy(v));}}
module.exports={fixtureMongo,matches};
