'use strict';
const { groupIdValid, contactIdValid } = require('./channel-policy');

function sourceMetadata(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  // A present own-message flag must be the actual boolean false. A DM requires
  // this explicit inbound assertion; missing flags never authorize a contact.
  if ((Object.hasOwn(msg, 'from_me') && msg.from_me !== false)
    || (Object.hasOwn(msg, 'fromMe') && msg.fromMe !== false)) return null;
  if (groupIdValid(msg.chat_id)) {
    if ((Object.hasOwn(msg, 'is_group') && msg.is_group !== true)
      || (Object.hasOwn(msg, 'chat_type') && msg.chat_type !== 'group')) return null;
    return { sourceType: 'group', sourceId: msg.chat_id };
  }
  if (contactIdValid(msg.chat_id)) {
    if (msg.from_me !== false || (Object.hasOwn(msg, 'is_group') && msg.is_group !== false)
      || (Object.hasOwn(msg, 'chat_type') && !['contact', 'private', 'personal'].includes(msg.chat_type))) return null;
    return { sourceType: 'contact', sourceId: msg.chat_id, contactPhone: '+' + msg.chat_id.split('@')[0] };
  }
  return null;
}
function contactSenderMatches(msg, source) {
  const digits = source.contactPhone.slice(1);
  const matches = value => typeof value === 'string' && (value === digits || value === source.sourceId);
  if (!matches(msg.from)) return false;
  // Contradictory alternative identity fields are not used as aliases.
  for (const field of ['sender_id', 'sender', 'author', 'participant']) {
    if (Object.hasOwn(msg, field) && !matches(msg[field])) return false;
  }
  if (Object.hasOwn(msg, 'chat') && (!msg.chat || typeof msg.chat !== 'object' || Array.isArray(msg.chat)
    || (Object.hasOwn(msg.chat, 'id') && msg.chat.id !== source.sourceId)
    || (Object.hasOwn(msg.chat, 'type') && !['contact', 'private', 'personal'].includes(msg.chat.type)))) return false;
  return true;
}

// Dependency injection lets privacy tests exercise the actual ingestion pipeline
// without an HTTP listener, provider SDK, database, credentials or network.
function createIngestor({ policy, ready = () => true, storageReady = async () => true, classify, score, insert, recordRaw, recordTrader, checkAlerts, phoneToCountry, processSelected }) {
  return async function ingest(channelId, messages) {
    const result = { accepted: 0, ignored: 0 };
    if (!Array.isArray(messages)) return result;
    for (const msg of messages) {
      // Inspect routing flags first. No text retention/AI or implicit discovery.
      const source = sourceMetadata(msg);
      if (!source || !ready() || !await policy.allows(channelId, source.sourceId)) {
        result.ignored++; continue;
      }
      // Read/validate DM sender identity only after explicit contact selection.
      if (source.sourceType === 'contact' && !contactSenderMatches(msg, source)) {
        result.ignored++; continue;
      }
      const lease = await policy.lease(channelId, source.sourceId);
      const allowed = async () => ready() && lease !== null && msg.chat_id === source.sourceId
        && sourceMetadata(msg)?.sourceType === source.sourceType
        && (source.sourceType !== 'contact' || contactSenderMatches(msg, source))
        && await policy.lease(channelId, source.sourceId) === lease;
      // Storage outages block processing before raw retention or AI transmission.
      if (!await storageReady() || !await allowed()) { result.ignored++; continue; }
      if (processSelected) {
        const accepted = await processSelected(msg, {channelId, allowed, lease, ...source});
        result.accepted += accepted;
        if (!accepted) result.ignored++;
        continue;
      }
      const text = typeof msg.text?.body === 'string' ? msg.text.body : typeof msg.caption === 'string' ? msg.caption : '';
      if (text.length < 8 || text.length > 50000) { result.ignored++; continue; }
      const sender = source.sourceType === 'contact' ? source.contactPhone.slice(1) : typeof msg.from === 'string' ? msg.from.replace('@s.whatsapp.net', '') : 'Unknown';
      const group = source.sourceId;
      const selectedChannel = await policy.get(channelId);
      const groupName = (source.sourceType === 'group' ? selectedChannel?.groups[group]?.name : selectedChannel?.contacts?.[group]?.name) || group;
      const ts = Number.isFinite(msg.timestamp) ? msg.timestamp : Math.floor(Date.now() / 1000);
      if (!await allowed()) { result.ignored++; continue; }
      recordRaw({ text, sender, group, groupName, channelId, ts, ...source });
      if (!['wts', 'wtb', 'selling', 'buying', 'for sale', 'looking for', 'aed', 'usd', 'offer', 'grade', 'brand new', 'used'].some(k => text.toLowerCase().includes(k))) { result.ignored++; continue; }
      if (!await allowed()) { result.ignored++; continue; }
      const classified = await classify(text, sender);
      // Revocation while classification is outstanding prevents later writes/AI.
      if (!await allowed() || !classified || classified.type === 'UNKNOWN') { result.ignored++; continue; }
      const sellerCountry = phoneToCountry(sender);
      const listing = {
        id: `${ts}-${require('node:crypto').randomUUID()}`,
        type: classified.type, condition: classified.condition,
        model: classified.model || null, storage: classified.storage || null,
        ram: classified.ram || null, color: classified.color || null,
        qty: classified.qty || null, grade: classified.condition === 'Used' ? (classified.grade || null) : null,
        price: classified.price || null, currency: classified.currency || 'USD',
        summary: classified.summary || text.slice(0, 80), dealScore: null,
        isFlagged: false, flagReason: null, sender, channelId, sellerCountry,
        listingCountry: classified.country || null, group, timestamp: ts, raw: text, ...source,
        assignedTo: null, status: 'new', notes: [], createdAt: new Date(),
      };
      if (!await allowed()) { result.ignored++; continue; }
      Object.assign(listing, await score(listing, allowed));
      if (!await allowed()) { result.ignored++; continue; }
      await insert(listing);
      if (!await allowed()) continue;
      recordTrader(listing);
      await checkAlerts(listing);
      result.accepted++;
    }
    return result;
  };
}
module.exports = { createIngestor };
