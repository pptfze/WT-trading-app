'use strict';
// Bounded text extraction, no provider/AI I/O. Unknown fields stay unknown.
const CURRENCIES = ['USD','AED','EUR','GBP','SAR','KWD','QAR','BHD','OMR'];
const MODELS = /\b(?:(?:1[0-9]\s*pm)|iphone\s*(?:1[0-9]|[6-9])(?:\s*(?:pro\s*max|pro|max|plus|mini))?|(?:samsung\s+)?galaxy\s*(?:s\d{2}(?:\s*(?:ultra|plus|fe))?|z\s*(?:fold|flip)\s*\d)|(?:google\s+)?pixel\s*\d{1,2}(?:\s*(?:pro\s*xl|pro|xl|a))?)\b/gi;
const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g,' ') : null;
function intent(text) {
  const sell = /\b(wts|selling|for sale|want to sell)\b/i.test(text);
  const buy = /\b(wtb|buying|looking for|want to buy)\b/i.test(text);
  return sell === buy ? null : sell ? 'WTS' : 'WTB';
}
function condition(text) {
  if (/\b(refurbished|refurb)\b/i.test(text)) return 'Refurbished';
  const used = /\b(used|tested|as[ -]?is|pre[- ]?owned|grade\s*[ABC][+]?)\b/i.test(text);
  const fresh = /\b(brand new|bnib|sealed|new)\b/i.test(text);
  return used && fresh ? null : used ? 'Used' : fresh ? 'Brand New' : null;
}
function normalizeModel(value) {
  return clean(value).toLowerCase().replace(/^(1[0-9])\s*pm$/, 'iphone $1 pro max').replace(/^samsung\s+/, '').replace(/^google\s+/, '')
    .replace(/iphone\s*/, 'iPhone ').replace(/galaxy\s*/, 'Galaxy ').replace(/pixel\s*/, 'Pixel ')
    .replace(/\b(pro|max|plus|mini|ultra|fold|flip|xl|fe)\b/g,w=>w[0].toUpperCase()+w.slice(1))
    .replace(/\bs(\d+)/g,'S$1').replace(/\bz\b/g,'Z');
}
function one(text, expression, map = value => value.toUpperCase()) {
  const values = [...text.matchAll(expression)].map(m => map(m[1]));
  return [...new Set(values)].length === 1 ? values[0] : null;
}
function fields(text) {
  const currencies = [...new Set((text.match(/\b(?:USD|AED|EUR|GBP|SAR|KWD|QAR|BHD|OMR)\b/gi)||[]).map(x=>x.toUpperCase()))];
  const hits = [...text.matchAll(/\b(USD|AED|EUR|GBP|SAR|KWD|QAR|BHD|OMR)\s*[:@]?\s*(\d+(?:,\d{3})*(?:\.\d{1,3})?)(?![\d.,])\b|(?<![\d.,])\b(\d+(?:,\d{3})*(?:\.\d{1,3})?)\s*(USD|AED|EUR|GBP|SAR|KWD|QAR|BHD|OMR)\b/gi)];
  const pairs = [...new Map(hits.map(m=>{const c=(m[1]||m[4]).toUpperCase(),p=Number((m[2]||m[3]).replace(/,/g,'')); return [c+':'+p,{currency:c,price:p}];})).values()];
  let price = pairs.length===1 && pairs[0].price>0 && pairs[0].price<10000000 ? pairs[0].price : null;
  const storageHits = [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(GB|TB)\b/gi)].filter(m=>!/ram\s*[:=]?\s*$/i.test(text.slice(Math.max(0,m.index-8),m.index)) && !(m[2].toUpperCase()==='GB' && /^\s*(?:RAM|memory)(?!\s*[:=]?\s*\d)/i.test(text.slice(m.index+m[0].length))));
  const storages = [...new Set(storageHits.map(m=>Number(m[1])*(m[2].toUpperCase()==='TB'?1024:1)))];
  const quantities = [...new Set([...text.matchAll(/\b(?:qty|quantity)\s*[:=]?\s*(\d+)\b|\b(\d+)\s*(?:pcs|pieces|units)\b/gi)].map(m=>Number(m[1]||m[2])))];
  const qty = quantities.length===1 && quantities[0]>0 && quantities[0]<=1000000 ? quantities[0] : null;
  const grade = one(text,/\bgrade\s*[:=]?\s*([ABC]\+?)(?![A-Za-z+])/gi) || (/\b(?:tested|used)\b/i.test(text) ? one(text, /(?:^|\s)([ABC]\+?)(?=\s|$|[,;])/gi) : null);
  const regionText=text.replace(/\bcontact us\b/gi,'contact');
  const region = one(regionText,/\b(UAE|US|USA|EU|EURO|EUROPE|UK|JP|JAP|JAPAN|HK|HONG KONG|CN|CH|CHINA|SG|SINGAPORE|INDIA|INTERNATIONAL)\b/gi,x=>({USA:'US',EURO:'EU',EUROPE:'EU',JAP:'JP',JAPAN:'JP','HONG KONG':'HK',CH:'CN',CHINA:'CN',SINGAPORE:'SG',INDIA:'IN'}[x.toUpperCase()]||x.toUpperCase()));
  const sim = one(text,/\b(dual\s*(?:physical\s*)?sim|single\s*sim|e[- ]?sim(?:\s*only)?)\b/gi,x=>x.toLowerCase().replace(/\s+/g,' ').replace(/e[- ]?sim/,'esim'));
  const ram = one(text,/\bRAM\s*[:=]?\s*(\d+)\s*GB\b/gi,x=>Number(x)+'GB') || one(text,/\b(\d+)\s*GB\s*RAM\b/gi,x=>Number(x)+'GB');
  const color = one(text,/\b(burgundy|natural titanium|black titanium|white titanium|blue titanium|desert titanium|black|white|blue|green|red|pink|purple|silver|gold)\b/gi,x=>x.toLowerCase());
  const batteries=[...new Set([...text.matchAll(/\b(?:battery(?:\s*health)?|bh)\s*[:=]?\s*(\d{1,3})\s*%/gi)].map(m=>Number(m[1])))];
  const location = text.match(/\b(?:location|located|stock in|available in)\s*[:=]?\s*([^|;]+?)(?=\s+(?:qty|price|USD|AED|EUR|GBP|SAR)\b|$)/i)?.[1];
  const activation = /\b(?:non[ -]?active|not\s+active)\b/i.test(text)?'non_active':/\bactive\b/i.test(text)?'active':null;
  const tradeClass = /\bas[ -]?is\b/i.test(text)?'as_is':/\btested\b/i.test(text)?'tested':null;
  const supplierGrade = one(text,/\b(DNA|DNB|DNC|DND)\b/gi);
  const gradingNamespace = supplierGrade && /\bverizon\b/i.test(text) ? 'verizon' : null;
  const lot = /\b(?:per lot|total|bundle|carton|dozen)\b/i.test(text);
  const unit = /\b(?:each|per\s*(?:unit|piece|pc|phone))\b/i.test(text);
  const flags=[];
  if(/\b(?:not|no|without)\s+(?:brand\s+new|new|used|tested|sealed|refurbished|grade|battery|dual|single|black|white|blue|burgundy|hk|usa|japan)\b/i.test(text))flags.push('negated_specification');
  if(currencies.length&&pairs.length===0&&/\b(?:USD|AED|EUR|GBP|SAR|KWD|QAR|BHD|OMR)\s*[:@]?\s*[-−]?\d/i.test(text))flags.push('ambiguous_price_or_currency');
  if(/\b(?:USD|AED|EUR|GBP|SAR|KWD|QAR|BHD|OMR)\s*[:@]?\s*\d[\d,.]*\s*(?:\/|[-–]|to)\s*\d/i.test(text) || /\b\d[\d,.]*\s*(?:\/|[-–]|to)\s*\d[\d,.]*\s*(?:USD|AED|EUR|GBP|SAR|KWD|QAR|BHD|OMR)\b/i.test(text)) {price=null;flags.push('ambiguous_price_or_currency');}
  if(/\b(?:non[ -]?active|not\s+active)\b/i.test(text) && /\bactive\b/i.test(text.replace(/\b(?:non[ -]?active|not\s+active)\b/gi,''))) flags.push('ambiguous_activation');
  if(batteries.length>1 || batteries.some(v=>v>100)) flags.push('ambiguous_battery_health');
  if(/\b(?:grade\s*)?C\+/i.test(text)) flags.push('unsupported_grade');
  if(lot&&unit) flags.push('ambiguous_price_unit');
  if(region===null && /\b(?:UAE|US|USA|EU|EURO|EUROPE|UK|JP|JAP|JAPAN|HK|HONG KONG|CN|CH|CHINA|SG|SINGAPORE|INDIA|INTERNATIONAL)\b/i.test(regionText))flags.push('ambiguous_region');
  if(color===null && /\b(?:burgundy|titanium|black|white|blue|green|red|pink|purple|silver|gold)\b/i.test(text))flags.push('ambiguous_color');
  if(sim===null && /\b(?:dual\s*(?:physical\s*)?sim|single\s*sim|e[- ]?sim)\b/i.test(text))flags.push('ambiguous_sim');
  if(grade===null && /\bgrade\s*[ABC]/i.test(text))flags.push('ambiguous_grade');
  if(supplierGrade===null && /\b(?:DNA|DNB|DNC|DND)\b/i.test(text))flags.push('ambiguous_supplier_grade');
  if(/\bas[ -]?is\b/i.test(text)&&/\btested\b/i.test(text))flags.push('ambiguous_trade_class');
  if(/\bdr[ .-]?fone\b/i.test(text)&&/\bcosmetic\b/i.test(text))flags.push('ambiguous_grading_method');

  if(pairs.length>1||currencies.length>1) flags.push('ambiguous_price_or_currency');
  if(storages.length>1) flags.push('multiple_storage_variants');
  if(quantities.length>1) flags.push('ambiguous_quantity');
  if(lot) flags.push('price_unit_uncertain');
  if(/\b(?:from|starting at|approx|around)\b/i.test(text)&&price!==null) flags.push('indicative_price');
  if(/\b(?:new|sealed|bnib)\b/i.test(text)&&/\b(?:used|grade|refurb)\b/i.test(text)) flags.push('ambiguous_condition');
  return {activation,tradeClass,supplierGrade,gradingNamespace,condition:condition(text),storage:storages.length===1?storages[0]+'GB':null,ram,color,qty,grade,region,sim,
    batteryHealth:batteries.length===1&&batteries[0]<=100?batteries[0]:null,
    gradingMethod:/\bdr[ .-]?fone\b/i.test(text)?'drfone':/\bcosmetic\b/i.test(text)?'cosmetic':/\bas[ -]?is\b/i.test(text)?'as_is':null,
    price,currency:currencies.length===1?currencies[0]:null,priceUnit:lot?'lot':unit?'unit':null,
    location:location?clean(location).slice(0,120):null,flags};
}
function extractTradeItems(text) {
  if(typeof text!=='string'||text.length<8||text.length>50000) return [];
  const lines=[];
  for(const raw of text.split(/\r?\n/).map(clean).filter(Boolean)) {
    const hasModel=[...raw.matchAll(MODELS)].length>0;
    const prior=lines[lines.length-1];
    const continuation=!hasModel&&!intent(raw)&&/^(?:(?:USD|AED|EUR|GBP|SAR|KWD|QAR|BHD|OMR)\s*\d|(?:qty|quantity|price|battery|bh|RAM|grade)\b|\d+\s*(?:pcs|pieces|units)\b)/i.test(raw);
    if(continuation&&prior&&[...prior.matchAll(MODELS)].length) lines[lines.length-1]=prior+' | '+raw;
    else lines.push(raw);
  }
  let context={type:null,condition:null,currency:null,location:null,tradeClass:null,gradingMethod:null};
  let contextFlags=[];
  const output=[];
  for(let lineIndex=0;lineIndex<lines.length&&output.length<100;lineIndex++) {
    const line=lines[lineIndex],type=intent(line),models=[...line.matchAll(MODELS)].map(m=>normalizeModel(m[0])),values=fields(line);
    if(!models.length) {
      if(line.length<=100&&!/\d/.test(line)) {
        if(type) {context={type,condition:values.condition,currency:values.currency,location:values.location,tradeClass:values.tradeClass,gradingMethod:values.gradingMethod};contextFlags=[...values.flags];}
        else if(/\bWTS\b/i.test(line)&&/\bWTB\b/i.test(line)) {context.type=null;contextFlags.push('ambiguous_intent');}
        else if(values.flags.length) {contextFlags.push(...values.flags);context.condition=null;context.tradeClass=null;context.gradingMethod=null;context.currency=null;}
        else if(!/\b(?:wts|wtb)\b/i.test(line)) for(const key of ['condition','currency','location','tradeClass','gradingMethod']) if(values[key]) context[key]=values[key];
      }
      continue;
    }
    const flags=[...(type?[]:contextFlags),...values.flags];
    if(models.length!==1) flags.push('multiple_models_on_line');
    const selectedType=type||context.type;
    if(type)context={type,condition:null,currency:null,location:null,tradeClass:null,gradingMethod:null};
    if(!selectedType||(/\bWTS\b/i.test(line)&&/\bWTB\b/i.test(line))) continue;
    const item={type:selectedType,model:models.length===1?models[0]:null,...values,
      tradeClass:values.tradeClass||context.tradeClass,gradingMethod:values.gradingMethod||context.gradingMethod,condition:values.condition||context.condition,currency:values.currency||context.currency,location:values.location||context.location,
      lineIndex,raw:line,availability:/\b(not available|out of stock|sold out|unavailable|fulfilled|sold|cancelled|canceled)\b/i.test(line)?'unavailable':'active',
      priceKind:selectedType==='WTS'?'supplier_ask':'buyer_budget'};
    delete item.flags;
    item.modelKey=item.model?.toLowerCase()||null;
    for(const key of ['condition','storage','currency','price','qty','location']) if(!item[key]) flags.push((key==='qty'?'quantity':key)+'_unknown');
    if(!item.priceUnit) flags.push('price_unit_unknown');
    if(item.supplierGrade&&!item.gradingNamespace) flags.push('supplier_grading_namespace_unknown');
    if(item.condition==='Used'&&!item.grade&&!item.supplierGrade) flags.push('grade_unknown');
    item.extraction={method:'deterministic-v1',flags:[...new Set(flags)]};
    item.summary=line.slice(0,160); output.push(item);
  }
  return output;
}
module.exports={extractTradeItems,normalizeModel,fields,CURRENCIES};
