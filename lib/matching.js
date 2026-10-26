'use strict';
const {createHash} = require('node:crypto');
const SPEC_FIELDS=['modelKey','storage','condition','grade','tradeClass','gradingMethod','gradingNamespace','supplierGrade','region','activation','sim','ram','color'];
const BLOCK_FLAGS=new Set(['multiple_models_on_line','multiple_storage_variants','ambiguous_condition','ambiguous_price_or_currency','supplier_grading_namespace_unknown','unsupported_grade','negated_specification']);
function matchId(offerId,demandId) {return createHash('sha256').update(JSON.stringify([offerId,demandId])).digest('hex');}
function origin(listing) {const s=listing.source;return s?.provider&&(s.chatId||s.groupId)&&s.providerMessageId?JSON.stringify([s.provider,s.chatId||s.groupId,s.providerMessageId,s.lineIndex]):listing.id;}
function fresh(listing,now,maxAgeHours=48) {
  return listing.availability==='active' && Number.isFinite(listing.timestamp) && listing.timestamp<=now/1000+300 && listing.timestamp>=now/1000-maxAgeHours*3600;
}
function compare(offer,demand,{now=Date.now(),freshnessHours=48}={}) {
  if(!offer||!demand||offer.type!=='WTS'||demand.type!=='WTB'||!fresh(offer,now,freshnessHours)||!fresh(demand,now,freshnessHours)) return null;
  if(!offer.group||!demand.group||offer.group===demand.group||!offer.sender||!demand.sender||offer.sender===demand.sender) return null;
  if(!offer.currency||offer.currency!==demand.currency) return null;
  if(!offer.modelKey||!offer.storage||!offer.condition||offer.modelKey!==demand.modelKey||offer.storage!==demand.storage||offer.condition!==demand.condition) return null;
  if([...(offer.extraction?.flags||[]),...(demand.extraction?.flags||[])].some(f=>(BLOCK_FLAGS.has(f)||f.startsWith('ambiguous_')))) return null;
  // Used tested grades and as-is supplier grades are distinct namespaces.
  if(offer.condition!=='Brand New') {
    if(!offer.tradeClass||offer.tradeClass!==demand.tradeClass) return null;
    if(offer.tradeClass==='as_is') {
      if(!offer.gradingNamespace||!offer.supplierGrade||offer.gradingNamespace!==demand.gradingNamespace||offer.supplierGrade!==demand.supplierGrade) return null;
    } else if(!offer.grade||offer.grade!==demand.grade) return null;
  }
  const flags=['availability_not_verified','inventory_not_reserved'];
  if(offer.source?.isForwarded===true||demand.source?.isForwarded===true)flags.push('forwarded_source_requires_verification');
  for(const field of SPEC_FIELDS) {
    const a=offer[field]??null,b=demand[field]??null;
    if(a!==null&&b!==null&&a!==b) return null;
    // If either side explicitly specified a feature, require it on both sides.
    // Unknown on both can be a review lead, never a compatibility assertion.
    if((a===null)!==(b===null)) return null;
    if(a===null&&['region','activation','sim','ram','color','gradingMethod'].includes(field)) flags.push(field+'_unknown');
  }
  if(offer.batteryHealth!==null&&offer.batteryHealth!==undefined || demand.batteryHealth!==null&&demand.batteryHealth!==undefined) {
    if(offer.batteryHealth!==demand.batteryHealth) return null;
  } else if(offer.condition==='Used') flags.push('battery_health_unknown');
  for(const item of [offer,demand]) for(const flag of item.extraction?.flags||[]) if(!flags.includes(flag)) flags.push(flag);
  const knownUnit=offer.priceUnit==='unit'&&demand.priceUnit==='unit';
  const hasPrices=Number.isFinite(offer.price)&&offer.price>0&&Number.isFinite(demand.price)&&demand.price>0;
  const definitive=knownUnit&&hasPrices&&!flags.includes('indicative_price');
  if(definitive&&demand.price<offer.price) return null;
  if(!knownUnit) flags.push('unit_price_comparison_unavailable');
  if(!hasPrices) flags.push('price_comparison_unavailable');
  if(offer.location!==demand.location) flags.push('location_differs_or_unknown');
  return {id:matchId(origin(offer),origin(demand)),offerId:offer.id,demandId:demand.id,flags:[...new Set(flags)],
    comparison:{currency:offer.currency,offerUnitPrice:offer.priceUnit==='unit'?offer.price:null,buyerUnitPrice:demand.priceUnit==='unit'?demand.price:null,
      unitSpread:definitive?Number((demand.price-offer.price).toFixed(3)):null,
      possibleQty:Number.isSafeInteger(offer.qty)&&Number.isSafeInteger(demand.qty)?Math.min(offer.qty,demand.qty):null}};
}
module.exports={compare,fresh,matchId,SPEC_FIELDS};
