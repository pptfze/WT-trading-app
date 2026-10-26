'use strict';
const {problem}=require('./channel-policy');
const {compare}=require('./matching');
const MAX_PAGE=200;
const DURABLE={writeConcern:{w:'majority',wtimeoutMS:5000},maxTimeMS:5000};
const TRANSITIONS={claimed:['contacted','negotiating','closed','dismissed'],contacted:['negotiating','closed','dismissed'],negotiating:['contacted','closed','dismissed']};
// Uses actual MongoDB transactions and CAS operations. There is no production
// memory fallback and no claim that salesperson assignment reserves inventory.
class TradeStore {
  constructor(db,client,{freshnessHours=48,now=()=>Date.now()}={}) {this.db=db;this.client=client;this.freshnessHours=freshnessHours;this.now=now;}
  async initialize() {
    await this.db.collection('group_messages_v1').createIndex({receivedAt:1});
    await this.db.collection('group_listings_v1').createIndex({id:1},{unique:true});
    await this.db.collection('group_listings_v1').createIndex({sourceKey:1,sourceLine:1},{unique:true,partialFilterExpression:{sourceKey:{$type:'string'}}});
    await this.db.collection('group_listings_v1').createIndex({type:1,modelKey:1,timestamp:-1});
    await this.db.collection('group_matches_v1').createIndex({id:1},{unique:true});
    await this.db.collection('group_matches_v1').createIndex({offerId:1,demandId:1},{unique:true});
    await this.db.collection('group_matches_v1').createIndex({updatedAt:-1});
  }
  async messageListings(key) {return this.db.collection('group_listings_v1').find({sourceKey:key}).limit(100).toArray();}
  async hasMessage(key) {return !!await this.db.collection('group_messages_v1').findOne({_id:key},{projection:{_id:1},readPreference:'primary'});}
  async persistMessage(message,listings,allowed,fence) {
    if(typeof fence!=='function')throw problem('Transactional privacy fence unavailable',503);
    if(!await allowed())throw problem('Group selection changed during processing',409);
    const session=this.client.startSession({defaultTimeoutMS:5000}); let duplicate=false;
    try {
      await session.withTransaction(async()=>{
        duplicate=false;
        await fence(session);
        if(await this.db.collection('group_messages_v1').findOne({_id:message._id},{session})) {duplicate=true;return;}
        await this.db.collection('group_messages_v1').insertOne(message,{session});
        if(listings.length) await this.db.collection('group_listings_v1').insertMany(listings,{session,ordered:true});
        // No external policy reads here: the fence holds the revocation lock
        // until this transaction commits or aborts.
      },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary',maxCommitTimeMS:5000,timeoutMS:5000});
      return {duplicate};
    } catch(error) {
      if(error.code===11000&&await this.hasMessage(message._id)) return {duplicate:true};
      throw error;
    } finally {await session.endSession({timeoutMS:5000});}
  }
  async buildMatches(listings,allowed) {
    // Bounded, indexed exact-model lookup. A cap is disclosed to callers; it is
    // not an exhaustive market search or a stock allocation engine.
    for(const listing of listings) {
      if(!listing.modelKey||!await allowed(listing)) continue;
      const opposite=listing.type==='WTS'?'WTB':'WTS';
      const others=await this.db.collection('group_listings_v1').find({type:opposite,modelKey:listing.modelKey,timestamp:{$gte:this.now()/1000-this.freshnessHours*3600}}).sort({timestamp:-1}).limit(500).toArray();
      for(const other of others) {
        if(!await allowed(listing)||!await allowed(other)) continue;
        const candidate=compare(listing.type==='WTS'?listing:other,listing.type==='WTB'?listing:other,{now:this.now(),freshnessHours:this.freshnessHours});
        if(!candidate) continue;
        await this.db.collection('group_matches_v1').updateOne({id:candidate.id},{$setOnInsert:{...candidate,status:'new',assignedTo:null,version:0,notes:[],createdAt:new Date(this.now()),updatedAt:new Date(this.now())}},{...DURABLE,upsert:true});
      }
    }
  }
  async list({limit=100}={},allowed) {
    const records=await this.db.collection('group_matches_v1').find({}).sort({updatedAt:-1}).limit(Math.min(MAX_PAGE,limit)).toArray();
    const output=[];
    for(const record of records) {const hydrated=await this.visible(record,allowed);if(hydrated)output.push(hydrated);}
    return output;
  }
  async visible(record,allowed) {
    if(!record) return null;
    const c=this.db.collection('group_listings_v1');
    const offer=await c.findOne({id:record.offerId}),demand=await c.findOne({id:record.demandId});
    if(!offer||!demand||!await allowed(offer)||!await allowed(demand)) return null;
    const candidate=compare(offer,demand,{now:this.now(),freshnessHours:this.freshnessHours});
    if(candidate) {
      for(const listing of [offer,demand]) {
        if(!listing.source?.contentFingerprint)continue;
        const copies=await c.find({'source.contentFingerprint':listing.source.contentFingerprint,sourceLine:listing.sourceLine}).limit(50).toArray();
        let count=0;for(const copy of copies)if(await allowed(copy))count++;
        if(count>1&&!candidate.flags.includes('reposted_content_possible'))candidate.flags.push('reposted_content_possible');
      }
    }
    if(!await allowed(offer)||!await allowed(demand))return null;
    if(!candidate&&record.status==='new') return null;
    if(!candidate)record={...record,flags:[...(record.flags||[]),'source_no_longer_eligible_reverify'],comparison:{...record.comparison,unitSpread:null,possibleQty:null}};
    return {...record,...(candidate?{flags:candidate.flags,comparison:candidate.comparison}:{}),offer,demand};
  }
  async claim(id,version,actor,allowed) {
    this.validateVersion(version);
    const record=await this.db.collection('group_matches_v1').findOne({id});
    if(!await this.visible(record,allowed)) throw problem('Match is no longer available',404);
    const match=await this.db.collection('group_matches_v1').findOneAndUpdate({id,version,status:'new',assignedTo:null},{$set:{status:'claimed',assignedTo:actor.email,updatedAt:new Date(this.now())},$inc:{version:1}},{...DURABLE,returnDocument:'after',includeResultMetadata:false});
    if(!match) throw problem('Another teammate changed this match; refresh and review',409);
    return match;
  }
  validateVersion(value) {if(!Number.isSafeInteger(value)||value<0)throw problem('A current match version is required');}
  async update(id,body,actor,isAdmin,allowed) {
    this.validateVersion(body.version);
    if(Object.keys(body).some(k=>!['version','status','note'].includes(k))) throw problem('Unsupported match field');
    const record=await this.db.collection('group_matches_v1').findOne({id});
    if(!await this.visible(record,allowed)) throw problem('Match is no longer available',404);
    if(record.assignedTo!==actor.email&&!isAdmin) throw problem('Only the assigned salesperson or an administrator can change this match',403);
    const update={$set:{updatedAt:new Date(this.now())},$inc:{version:1}};
    if(body.status!==undefined) {
      if(!TRANSITIONS[record.status]?.includes(body.status)) throw problem('Invalid match status transition',409);
      update.$set.status=body.status;
    }
    if(body.note!==undefined) {
      if(typeof body.note!=='string'||!body.note.trim()||body.note.length>2000)throw problem('Notes must contain 1–2000 characters');
      if((record.notes||[]).length>=200)throw problem('Note limit reached',409);
      update.$push={notes:{text:body.note.trim(),by:actor.email,at:new Date(this.now())}};
    }
    if(body.status===undefined&&body.note===undefined)throw problem('No change requested');
    const match=await this.db.collection('group_matches_v1').findOneAndUpdate({id,version:body.version,status:record.status,assignedTo:record.assignedTo},update,{...DURABLE,returnDocument:'after',includeResultMetadata:false});
    if(!match)throw problem('Another teammate changed this match; refresh and review',409);
    return match;
  }
}
module.exports={TradeStore,TRANSITIONS};
