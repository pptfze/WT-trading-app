'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compare,fresh}=require('../lib/matching');
const NOW=Date.parse('2026-10-12T12:00:00Z');
function pair(){const base={model:'iPhone 18 Pro Max',modelKey:'iphone 18 pro max',storage:'256GB',condition:'Brand New',currency:'USD',region:'HK',activation:'non_active',color:'burgundy',grade:null,tradeClass:null,gradingMethod:null,gradingNamespace:null,supplierGrade:null,sim:null,ram:null,batteryHealth:null,availability:'active',timestamp:NOW/1000,qty:5,priceUnit:'unit',location:'Dubai',extraction:{flags:[]}};return [{...base,id:'offer',type:'WTS',group:'1@g.us',sender:'supplier',price:1000},{...base,id:'demand',type:'WTB',group:'2@g.us',sender:'buyer',price:1100}];}
function result(edit={}){const [a,b]=pair();Object.assign(b,edit);return compare(a,b,{now:NOW});}
test('same-currency exact known specs produce a review lead and arithmetic spread only',()=>{const m=result();assert.equal(m.comparison.unitSpread,100);assert.equal(m.comparison.possibleQty,5);assert.ok(m.flags.includes('inventory_not_reserved'));assert.ok(m.flags.includes('availability_not_verified'));});
for(const [field,value]of Object.entries({modelKey:'iphone 17 pro max',storage:'512GB',condition:'Used',currency:'AED',region:'US',activation:'active',color:'black',sim:'esim',ram:'12GB',batteryHealth:95,group:'1@g.us',sender:'supplier',availability:'fulfilled'}))test('incompatible '+field+' is excluded',()=>assert.equal(result({[field]:value}),null));
test('same WTS side cannot match',()=>assert.equal(result({type:'WTS'}),null));
test('missing currency is never defaulted',()=>assert.equal(result({currency:null}),null));
test('missing required specs cannot silently equal unknown',()=>{for(const field of ['modelKey','storage','condition']){const [a,b]=pair();a[field]=b[field]=null;assert.equal(compare(a,b,{now:NOW}),null);}});
test('stale and future timestamp sources are excluded',()=>{assert.equal(result({timestamp:NOW/1000-49*3600}),null);assert.equal(result({timestamp:NOW/1000+3600}),null);assert.equal(result({timestamp:null}),null);});
test('buyer budget below supplier unit ask is excluded',()=>assert.equal(result({price:900}),null));
test('unknown prices, quantities and unit basis stay null, not profit estimates',()=>{const m=result({price:null,qty:null,priceUnit:null});assert.equal(m.comparison.unitSpread,null);assert.equal(m.comparison.possibleQty,null);assert.ok(m.flags.includes('price_comparison_unavailable'));});
test('any extraction ambiguity blocks matching',()=>assert.equal(result({extraction:{flags:['ambiguous_condition']}}),null));
test('tested grades A and A+ are not equivalent',()=>{const [a,b]=pair();for(const x of [a,b])Object.assign(x,{condition:'Used',tradeClass:'tested',grade:'A'});b.grade='A+';assert.equal(compare(a,b,{now:NOW}),null);b.grade='A';assert.ok(compare(a,b,{now:NOW}));});
test('tested-used and supplier as-is grades are never mapped',()=>{const [a,b]=pair();Object.assign(a,{condition:'Used',tradeClass:'tested',grade:'A'});Object.assign(b,{condition:'Used',tradeClass:'as_is',supplierGrade:'DNA',gradingNamespace:'verizon'});assert.equal(compare(a,b,{now:NOW}),null);});
test('as-is requires exact known supplier namespace and code',()=>{const [a,b]=pair();for(const x of [a,b])Object.assign(x,{condition:'Used',tradeClass:'as_is',supplierGrade:'DNA',gradingNamespace:'verizon'});assert.ok(compare(a,b,{now:NOW}));b.gradingNamespace='other';assert.equal(compare(a,b,{now:NOW}),null);b.gradingNamespace=null;assert.equal(compare(a,b,{now:NOW}),null);});
module.exports={pair,NOW};
test('contact source identity is stable across channels for duplicate claims',()=>{const[a,b]=pair();a.source={provider:'whapi',chatId:'441234567890@s.whatsapp.net',groupId:null,providerMessageId:'same-message',lineIndex:0,channelId:'one'};const first=compare(a,b,{now:NOW});const copy={...a,id:'different-copy',source:{...a.source,channelId:'two'}};assert.equal(compare(copy,b,{now:NOW}).id,first.id);});
test('missing buyer identity cannot create a match',()=>assert.equal(result({sender:null}),null));
