'use strict';
const {createHash}=require('node:crypto');
const {extractTradeItems}=require('./trade-extraction');
const digest=value=>createHash('sha256').update(value).digest('hex');
function sourceKey(channelId,groupId,messageId) {return digest(JSON.stringify(['whapi',channelId,groupId,messageId]));}
function createTradeProcessor({store,policy,now=()=>Date.now(),extract=extractTradeItems}) {
  const visible=listing=>policy.allows(listing.channelId,listing.group);
  return async function process(msg,{channelId,allowed,lease,sourceType='group',sourceId=msg.chat_id,contactPhone=null}) {
    // Called only after the shared selected-source privacy gate and storage check.
    // ID and source timestamp are required; never turn receipt time into market time.
    if(typeof msg.id!=='string'||!msg.id.trim()||msg.id.length>512||!Number.isFinite(msg.timestamp)||msg.timestamp<=0||msg.timestamp>now()/1000+300) return 0;
    const key=sourceKey(channelId,msg.chat_id,msg.id), repository=store();
    if(!repository||!await allowed()) return 0;
    if(await repository.hasMessage(key)) {
      // A previous commit may have succeeded before matching failed. Delivery
      // retries repair that bounded work without extracting/inserting again.
      if(await allowed()) await repository.buildMatches(await repository.messageListings(key),async listing=>await allowed()&&await visible(listing));
      return 0;
    }
    const text=typeof msg.text?.body==='string'?msg.text.body:typeof msg.caption==='string'?msg.caption:'';
    if(text.length<8||text.length>50000||!await allowed())return 0;
    const sender=typeof msg.from==='string'?msg.from.replace(/@s\.whatsapp\.net$/,''):null;
    const channel=await policy.get(channelId);
    const groupName=(sourceType==='contact'?channel?.contacts?.[msg.chat_id]?.name:channel?.groups?.[msg.chat_id]?.name)||msg.chat_id;
    const receivedAt=new Date(now()).toISOString();
    const fingerprint=digest(text.trim().replace(/\s+/g,' ').toLowerCase());
    const source={provider:'whapi',providerMessageId:msg.id,channelId,sourceType,chatId:sourceId,contactPhone,groupId:sourceType==='group'?msg.chat_id:null,sender,sourceTimestamp:msg.timestamp,receivedAt,
      isForwarded:msg.forwarded===true?true:msg.forwarded===false?false:null,contentFingerprint:fingerprint};
    const extracted=await extract(text);
    if(!await allowed())return 0;
    const listings=extracted.map((item,index)=>({...item,id:key+':'+index,sourceKey:key,sourceLine:index,
      source:{...source,lineIndex:item.lineIndex},channelId,sourceType,group:msg.chat_id,groupName,sender,timestamp:msg.timestamp,
      listingCountry:null,sellerCountry:null,dealScore:null,isFlagged:false,assignedTo:null,status:'new',notes:[],version:0,createdAt:new Date(now())}));
    const outcome=await repository.persistMessage({_id:key,source,raw:text,listingCount:listings.length,receivedAt},listings,allowed,session=>{
      if(typeof policy.fence!=='function')throw new Error('Transactional privacy fence unavailable');
      return policy.fence(session,channelId,sourceId,lease);
    });
    if(!await allowed())return 0;
    await repository.buildMatches(outcome.duplicate?await repository.messageListings(key):listings,async listing=>await allowed()&&await visible(listing));
    return outcome.duplicate?0:listings.length;
  };
}
module.exports={createTradeProcessor,sourceKey};
