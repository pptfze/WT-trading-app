'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {extractTradeItems,fields}=require('../lib/trade-extraction');
const parse=text=>extractTradeItems(text)[0];
test('user shorthand is a trade label with exact activation/region/color, no invented price or condition',()=>{
  for(const [raw,state]of [['active','active'],['non active','non_active'],['non-active','non_active']]){
    const x=parse('Wts 18 pm 256 GB '+raw+' HK burgundy');
    assert.equal(x.model,'iPhone 18 Pro Max');assert.equal(x.storage,'256GB');assert.equal(x.activation,state);assert.equal(x.region,'HK');assert.equal(x.color,'burgundy');assert.equal(x.price,null);assert.equal(x.currency,null);assert.equal(x.condition,null);
  }
});
test('multiline headings carry only explicit shared values, each item has separate identity and price',()=>{
  const rows=extractTradeItems('WTS brand new\nLocation Dubai\n18 pm 256 GB active HK burgundy USD 1100 each qty 5\n18 pm 512 GB non active HK burgundy USD 1250 each qty 8\nWTB used tested\niPhone 15 128GB grade A USD 500 per unit qty 2');
  assert.equal(rows.length,3);assert.deepEqual(rows.map(x=>[x.type,x.price,x.qty]),[['WTS',1100,5],['WTS',1250,8],['WTB',500,2]]);assert.equal(rows[2].tradeClass,'tested');assert.equal(rows[2].location,null);assert.equal(rows[0].priceUnit,'unit');
});
for(const code of ['A','A+','b','B+','C'])test('tested generic grade stays distinct: '+code,()=>{const x=parse('WTS used tested iPhone 15 128GB grade '+code);assert.equal(x.grade,code.toUpperCase());assert.equal(x.supplierGrade,null);});
for(const code of ['DNA','Dnb','DNC','DnD'])test('Verizon as-is code keeps its own namespace: '+code,()=>{const x=parse('WTS as is Verizon iPhone 15 128GB '+code);assert.equal(x.supplierGrade,code.toUpperCase());assert.equal(x.grade,null);assert.equal(x.gradingNamespace,'verizon');assert.equal(x.tradeClass,'as_is');});
for(const [alias,canonical]of [['Hk','HK'],['Jap','JP'],['Ch','CN'],['USA','US'],['Euro','EU'],['Uk','UK'],['Sg','SG'],['India','IN']])test('region alias '+alias,()=>assert.equal(parse('WTS new 18 pm 256GB '+alias).region,canonical));
test('unknown carrier namespace is explicit uncertainty, never generic grading',()=>{const x=parse('WTS as is iPhone 15 128GB DNB');assert.equal(x.gradingNamespace,null);assert.ok(x.extraction.flags.includes('supplier_grading_namespace_unknown'));});
test('model/storage/quantity/telephone numbers never fabricate a price',()=>{
  const x=parse('WTS iPhone 15 256GB qty 100 contact 971501234567');assert.equal(x.price,null);assert.equal(x.currency,null);assert.equal(x.qty,100);
  assert.equal(parse('WTS iPhone 15 256GB $500').currency,null);
});
test('explicit currency amounts normalize separators without inferring exchange rates',()=>{const x=parse('WTS iPhone 15 256GB AED 1,250.50 each');assert.equal(x.price,1250.5);assert.equal(x.currency,'AED');});
test('mixed variants/prices are review flags, never one inferred exact item',()=>{
  const x=parse('WTS iPhone 15 128GB 256GB USD 500 AED 1900');assert.equal(x.price,null);assert.equal(x.storage,null);assert.equal(x.currency,null);assert.ok(x.extraction.flags.includes('multiple_storage_variants'));
  assert.equal(parse('WTS iPhone 15 and iPhone 16 256GB USD 500').model,null);
});
test('unavailable item text never becomes active inventory',()=>assert.equal(parse('WTS iPhone 15 128GB sold out').availability,'unavailable'));
test('RAM cannot be misread as device storage and TB normalizes to GB',()=>{const x=parse('WTS Galaxy S24 Ultra 1TB RAM 12GB');assert.equal(x.ram,'12GB');assert.equal(x.storage,'1024GB');});
test('price basis requires explicit unit wording; lot is distinct',()=>{assert.equal(fields('USD 100').priceUnit,null);assert.equal(fields('USD 100 total bundle').priceUnit,'lot');assert.equal(fields('USD 100 per unit').priceUnit,'unit');});
test('location preposition does not become India region',()=>assert.equal(parse('WTS iPhone 15 128GB stock in Dubai').region,null));
test('malformed, very large and unsupported text is bounded without speculation',()=>{for(const s of [null,{},'a','x'.repeat(50001),'WTS unsupported widget USD 1'])assert.deepEqual(extractTradeItems(s),[]);});
test('numeric ranges cannot become definitive unit prices',()=>{for(const suffix of ['900/950','900-950','900 to 950']){const x=parse('WTS brand new iPhone 18 Pro Max 256GB AED '+suffix+' each qty 2');assert.equal(x.price,null);assert.ok(x.extraction.flags.includes('ambiguous_price_or_currency'));}});
test('conflicting activation or battery data is blocked by uncertainty flags',()=>{assert.ok(parse('WTS new 18 pm 256GB non active active').extraction.flags.includes('ambiguous_activation'));const x=parse('WTS tested used iPhone 15 128GB battery 90% battery 75%');assert.equal(x.batteryHealth,null);assert.ok(x.extraction.flags.includes('ambiguous_battery_health'));});
test('C+ is unsupported, not silently equivalent to C',()=>assert.ok(parse('WTS used tested iPhone 15 128GB grade C+').extraction.flags.includes('unsupported_grade')));
test('numeric continuation lines attach only to the preceding explicit model',()=>{const x=parse('WTS brand new iPhone 18 Pro Max 256GB\nUSD 900 each\nqty 2');assert.equal(x.price,900);assert.equal(x.qty,2);assert.equal(x.priceUnit,'unit');});
test('malformed prices cannot be partly parsed into plausible smaller prices',()=>{for(const raw of ['USD 900.1234','USD 1,25','USD 12,34.56']){const x=parse('WTS new iPhone 15 128GB '+raw+' each');assert.equal(x.price,null);assert.ok(x.extraction.flags.includes('ambiguous_price_or_currency'));}});
test('negated properties become explicit blocked uncertainty',()=>{for(const raw of ['not brand new','not grade A'])assert.ok(parse('WTS iPhone 15 128GB '+raw).extraction.flags.includes('negated_specification'));});
test('new explicit intent on model line does not inherit a different item condition',()=>{const rows=extractTradeItems('WTS brand new\niPhone 15 128GB USD 100 each\nWTB iPhone 16 128GB USD 200 each');assert.equal(rows[0].condition,'Brand New');assert.equal(rows[1].condition,null);});
test('contradictory headers never silently affirm earlier intent or condition',()=>{const x=parse('WTS\nBrand new\nUsed sealed\niPhone 16 256GB USD 900 each');assert.equal(x.condition,null);assert.ok(x.extraction.flags.includes('ambiguous_condition'));assert.deepEqual(extractTradeItems('WTS brand new\nWTB WTS\niPhone 16 256GB USD 900 each'),[]);});
test('not active normalizes separately from active',()=>assert.equal(parse('WTS new 18 pm 256GB not active HK burgundy').activation,'non_active'));
test('conflicting region, color, SIM and grade values cannot become merely unknown compatible fields',()=>{for(const [raw,flag]of [['HK USA','ambiguous_region'],['black white','ambiguous_color'],['single sim dual sim','ambiguous_sim'],['grade A grade B','ambiguous_grade'],['as is tested','ambiguous_trade_class']]){assert.ok(parse('WTS used iPhone 15 128GB '+raw).extraction.flags.includes(flag),raw);}});
test('contact us does not establish a US regional variant',()=>assert.equal(parse('WTS new iPhone 15 128GB contact us').region,null));
test('the user’s Asis spelling retains supplier grading as an independent class',()=>{const x=parse('WTS Asis Verizon iPhone 15 128GB Dnb USD 200 each');assert.equal(x.condition,'Used');assert.equal(x.tradeClass,'as_is');assert.equal(x.supplierGrade,'DNB');assert.equal(x.gradingMethod,'as_is');});
test('negated standalone headers cannot restore affirmative condition or tested-class assumptions',()=>{for(const text of ['WTS\nnot brand new\n18 pm 256GB non active HK burgundy USD 1000 each qty 5','WTS\nno tested\niPhone 16 128GB grade A USD 500 each qty 2']){const x=parse(text);assert.ok(x.extraction.flags.includes('negated_specification'));assert.equal(x.tradeClass,null);}assert.equal(parse('WTS\nnot brand new\n18 pm 256GB non active HK burgundy USD 1000 each qty 5').condition,null);});
