'use strict';
const crypto = require('node:crypto');
const { problem } = require('./channel-policy');
const STAGES = ['new', 'contacted', 'qualified', 'quoted', 'won', 'lost'];
const CONTACT_STATUSES = ['unknown', 'permitted', 'suppressed'];
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function str(value, max = 500, optional = false) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw problem('Invalid CRM text field');
  return value.trim();
}
function array(value, max = 100, length = 500) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw problem('Invalid CRM list');
  return [...new Set(value.map(x => str(x, length)).filter(Boolean))];
}
function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function excluded(row) {
  const company = norm(row.company);
  return /^(usmp|usmobilephones|recirq|recirqglobal|araglobal)/.test(company) || /(?:usmp|recirq|araglobal)/.test(norm(row.website));
}
function held(row) {
  return row.sourceRowKey === 'Prospects:LAT-014' || /mobilezoneinternationalimportexport/.test(norm(row.company)) || row.complianceHold === true || row.held === true || /compliance[ _-]*hold/i.test(JSON.stringify(row.rawFields || {}));
}
function normalizeRecord(row) {
  if (!plain(row)) throw problem('Invalid CRM record');
  const result = {};
  for (const key of ['sourceRowKey', 'company', 'country', 'city', 'website', 'category', 'priority']) result[key] = str(row[key], key === 'website' ? 2000 : 500, true);
  if (!result.company || !result.sourceRowKey) throw problem('Company and stable source row key are required');
  if (result.website && !safeUrl(result.website)) result.website = ''; // Preserve the original in rawFields, never make unsafe links.
  for (const key of ['emails', 'phones', 'whatsapp', 'contactNames']) result[key] = array(row[key]);
  result.sourceUrls = array(row.sourceUrls, 250, 2000).filter(safeUrl);
  result.sourceNotes = str(row.sourceNotes, 40000, true);
  if (row.rawFields != null && (!plain(row.rawFields) || Buffer.byteLength(JSON.stringify(row.rawFields)) > 250000)) throw problem('Invalid or oversized original fields');
  result.rawFields = row.rawFields || {};
  return result;
}
function preparePackage(value) {
  if (!plain(value) || value.schemaVersion !== 1 || !plain(value.source) || !Array.isArray(value.records) || value.records.length > 2000) throw problem('Use a schema version 1 CRM import package');
  const source = {
    libraryFileId: str(value.source.libraryFileId, 300), filename: str(value.source.filename, 300),
    version: value.source.version, sha256: str(value.source.sha256, 64),
  };
  if (!Number.isSafeInteger(source.version) || source.version < 1 || !/^[a-f0-9]{64}$/.test(source.sha256)) throw problem('Invalid workbook version or checksum');
  const seen = new Set(), records = [], heldRows = [], excludedRows = [], duplicateRows = [];
  for (const row of value.records) {
    const normalized = normalizeRecord(row);
    if (excluded(normalized)) { excludedRows.push({ company: normalized.company, sourceRowKey: normalized.sourceRowKey }); continue; }
    if (held(row)) { heldRows.push({ company: normalized.company, sourceRowKey: normalized.sourceRowKey, reason: 'Compliance hold' }); continue; }
    const id = 'buyer_' + hash([source.libraryFileId, normalized.sourceRowKey]).slice(0, 32);
    if (seen.has(id)) { duplicateRows.push(normalized.sourceRowKey); continue; }
    seen.add(id);
    records.push({ ...normalized, id, source, sourceDigest: hash(normalized) });
  }
  for (const [key, target] of [['held', heldRows], ['excluded', excludedRows]]) {
    if (value[key] != null && (!Array.isArray(value[key]) || value[key].length > 2000)) throw problem('Invalid withheld rows');
    for (const row of value[key] || []) {
      if (!plain(row)) throw problem('Invalid withheld row');
      target.push({ company: str(row.company, 500, true), sourceRowKey: str(row.sourceRowKey, 500, true), reason: key === 'held' ? 'Compliance hold' : 'Excluded company' });
    }
  }
  // A withheld row wins even if the same key also appears in the eligible list.
  const blockedKeys = new Set([...heldRows, ...excludedRows].map(row => row.sourceRowKey).filter(Boolean));
  const blockedNames = new Set([...heldRows, ...excludedRows].map(row => norm(row.company)).filter(Boolean));
  return { source, records: records.filter(row => !blockedKeys.has(row.sourceRowKey) && !blockedNames.has(norm(row.company))), heldRows, excludedRows, duplicateRows, digest: hash(value) };
}
function publicLead(row, admin) {
  const { _id, rawFields, sourceDigest, ...result } = row;
  if (admin) result.rawFields = rawFields;
  return result;
}
function visible(row, user) { return user.role === 'admin' || (row.assignedTo === user.email && !held(row) && !excluded(row)); }
function requireVisible(row, user) { if (!row || !visible(row, user)) throw problem('Buyer record not found', 404); }
function requiredVersion(value) { if (!Number.isSafeInteger(value) || value < 1) throw problem('Refresh the buyer before saving', 409); return value; }
class BuyerCRM {
  constructor(db, client, { secret, now = () => new Date(), getTeam = async () => [] } = {}) {
    this.db = db; this.client = client; this.secret = secret; this.now = now; this.getTeam = getTeam;
    this.leads = db.collection('buyer_crm_leads_v1'); this.imports = db.collection('buyer_crm_imports_v1'); this.holds = db.collection('buyer_crm_holds_v1'); this.ready = false;
  }
  async initialize() {
    await this.leads.createIndex({ id: 1 }, { unique: true });
    await this.leads.createIndex({ assignedTo: 1, stage: 1 });
    await this.imports.createIndex({ id: 1 }, { unique: true });
    await this.holds.createIndex({ id: 1 }, { unique: true });
    this.ready = true;
  }
  admin(user) { if (user?.role !== 'admin') throw problem('Administrator access required', 403); }
  async list(user, query = {}) {
    const filter = user.role === 'admin' ? {} : { assignedTo: user.email };
    if (query.stage && !STAGES.includes(query.stage)) throw problem('Invalid pipeline stage');
    const search = str(query.search, 200, true).toLowerCase();
    const skip = Number(query.skip || 0), limit = Number(query.limit || 100);
    if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw problem('Invalid page');
    // A bounded owner workspace. No unbounded regex or user-controlled Mongo queries.
    let rows = await this.leads.find(filter).sort({ company: 1 }).limit(10001).toArray();
    if (rows.length > 10000) throw problem('This CRM exceeds its current 10,000-record workspace limit', 503);
    if (user.role !== 'admin') rows = rows.filter(row => visible(row, user));
    if (search) rows = rows.filter(row => [row.company, row.country, row.city, ...row.emails, ...row.phones, ...row.contactNames].join(' ').toLowerCase().includes(search));
    const stageCounts = Object.fromEntries(STAGES.map(stage => [stage, rows.filter(row => row.stage === stage).length]));
    if (query.stage) rows = rows.filter(row => row.stage === query.stage);
    return { items: rows.slice(skip, skip + limit).map(row => { const { rawFields, sourceNotes, notes, offers, history, ...summary } = publicLead(row, false); return summary; }), total: rows.length, stages: STAGES, stageCounts, canImport: user.role === 'admin' };
  }
  async get(user, id) { const row = await this.leads.findOne({ id: str(id, 100) }); requireVisible(row, user); return publicLead(row, user.role === 'admin'); }
  async preview(user, payload) {
    this.admin(user);
    const prepared = preparePackage(payload), existing = await this.leads.find({}).limit(10001).toArray();
    if (existing.length > 10000) throw problem('Workspace limit reached', 503);
    const storedHolds = await this.holds.find({ 'source.libraryFileId': prepared.source.libraryFileId }).toArray();
    const withheld = [...storedHolds, ...prepared.heldRows, ...prepared.excludedRows];
    const blockedKeys = new Set(withheld.map(row => row.sourceRowKey).filter(Boolean));
    const blockedNames = new Set(withheld.map(row => norm(row.company)).filter(Boolean));
    const blocked = row => blockedKeys.has(row.sourceRowKey) || blockedNames.has(norm(row.company));
    const previouslyWithheld = prepared.records.filter(blocked).length;
    prepared.records = prepared.records.filter(row => !blocked(row));
    const quarantine = existing.filter(row => row.source.libraryFileId === prepared.source.libraryFileId && blocked(row) && !row.complianceHold).length;
    const byId = new Map(existing.map(row => [row.id, row]));
    const same = prepared.records.filter(row => byId.has(row.id)), changed = same.filter(row => row.sourceDigest !== byId.get(row.id).sourceDigest);
    const identifiers = new Map(); let possibleDuplicates = 0;
    for (const row of [...existing, ...prepared.records]) {
      const keys = [row.website && 'website:' + row.website.toLowerCase().replace(/\/$/, ''), ...row.emails.map(x => 'email:' + x.toLowerCase()), ...row.phones.map(x => 'phone:' + x.replace(/\D/g, ''))].filter(Boolean);
      if (keys.some(key => identifiers.has(key) && identifiers.get(key) !== row.id)) possibleDuplicates++;
      for (const key of keys) identifiers.set(key, row.id);
    }
    const counts = { eligible: prepared.records.length, held: prepared.heldRows.length, excluded: prepared.excludedRows.length, existing: same.length, changed: changed.length, insert: prepared.records.length - same.length, duplicateSourceRows: prepared.duplicateRows.length, possibleDuplicates, previouslyWithheld, quarantine };
    const claim = Buffer.from(JSON.stringify({ digest: prepared.digest, email: user.email, expires: this.now().getTime() + 10 * 60 * 1000 })).toString('base64url');
    const signature = crypto.createHmac('sha256', this.secret).update(claim).digest('base64url');
    return { previewToken: claim + '.' + signature, counts, warnings: [
      'New buyers stay owner-only. Public contact details do not establish marketing permission.',
      ...(quarantine ? [`${quarantine} existing buyers will be restricted to owner-only and removed from sales assignments because the source now withholds them.`] : []),
      ...(previouslyWithheld ? ['Previously withheld buyers stay blocked even when a later file omits the hold.'] : []),
      ...(changed.length ? ['Changed source rows will be skipped, preserving CRM history. Review before a separate update.'] : []),
      ...(possibleDuplicates ? ['Some companies share a contact or website. These are flagged for review, not automatically merged.'] : []),
      ...(prepared.duplicateRows.length ? ['Duplicate source IDs in this file are skipped after the first occurrence.'] : []),
    ] };
  }
  verifyPreview(user, prepared, token) {
    if (typeof token !== 'string' || token.length > 1000) throw problem('Preview this import first', 409);
    const [claim, sig, extra] = token.split('.');
    const expected = crypto.createHmac('sha256', this.secret).update(claim || '').digest('base64url');
    if (extra || !sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw problem('Import preview is invalid', 409);
    let data; try { data = JSON.parse(Buffer.from(claim, 'base64url').toString()); } catch { throw problem('Import preview is invalid', 409); }
    if (data.digest !== prepared.digest || data.email !== user.email || data.expires < this.now().getTime()) throw problem('Import preview expired or changed; preview again', 409);
  }
  async commit(user, payload, previewToken) {
    this.admin(user); const p = preparePackage(payload); this.verifyPreview(user, p, previewToken);
    const importId = 'import_' + p.digest, previous = await this.imports.findOne({ id: importId });
    if (previous) return { ...previous.result, replay: true };
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        const prior = await this.imports.findOne({ id: importId }, { session }); if (prior) return { ...prior.result, replay: true };
        // Serialize workspace imports, including disjoint source IDs. This prevents
        // a hold and an eligible copy from committing in competing snapshots and
        // makes the workspace capacity check safe across concurrent imports.
        await this.imports.updateOne({ id: 'workspace_import_lock' }, { $inc: { version: 1 } }, { session, upsert: true });
        const existing = await this.leads.find({}, { session }).limit(10001).toArray();
        let inserted = 0, skipped = 0;
        const at = this.now().toISOString();
        // Withholding is durable and revokes previously assigned copies in this source.
        // Run these writes in the import transaction so rep edits race through Mongo's
        // write-conflict handling rather than overwriting the quarantine.
        const storedHolds = await this.holds.find({ 'source.libraryFileId': p.source.libraryFileId }, { session }).toArray();
        const withheld = [...storedHolds, ...p.heldRows, ...p.excludedRows];
        const blockedKeys = new Set(withheld.map(row => row.sourceRowKey).filter(Boolean));
        const blockedNames = new Set(withheld.map(row => norm(row.company)).filter(Boolean));
        const blocked = row => blockedKeys.has(row.sourceRowKey) || blockedNames.has(norm(row.company));
        const sourceLeads = existing.filter(row => row.source.libraryFileId === p.source.libraryFileId);
        for (const row of sourceLeads.filter(blocked)) {
          if (row.complianceHold === true && row.assignedTo === null && row.contactStatus === 'suppressed') continue;
          row.complianceHold = true; row.assignedTo = null; row.access = 'owner_only'; row.contactStatus = 'suppressed';
          row.version++; row.updatedAt = at;
          row.history.push({ action: 'source_withheld', actor: user.email, at, importId });
          const changed = await this.leads.replaceOne({ id: row.id, version: row.version - 1 }, row, { session });
          if (changed.matchedCount !== 1) throw problem('Buyer changed during import; preview again', 409);
        }
        const existingIds = new Set(existing.map(row => row.id));
        const documents = [];
        for (const row of p.records) {
          if (blocked(row) || existingIds.has(row.id)) { skipped++; continue; }
          if (existing.length + documents.length >= 10000) throw problem('Workspace capacity is 10,000 buyers; import was not applied', 409);
          documents.push({ ...row, version: 1, stage: 'new', assignedTo: null, access: 'owner_only', contactStatus: 'unknown', consentEvidence: '', followUpAt: null, notes: [], offers: [], history: [{ action: 'imported', actor: user.email, at, importId }], createdAt: at, updatedAt: at });
          existingIds.add(row.id);
        }
        // One bounded bulk write avoids per-row network round trips exceeding the
        // replica-set transaction lifetime for a normal 875-company workbook.
        if (documents.length) {
          const result = await this.leads.insertMany(documents, { session, ordered: true });
          if (!result.acknowledged) throw problem('Import write was not confirmed', 503);
          inserted = documents.length;
        }
        for (const row of [...p.heldRows, ...p.excludedRows]) {
          const id = 'hold_' + hash([p.source.libraryFileId, row.sourceRowKey || row.company]);
          if (!await this.holds.findOne({ id }, { session })) await this.holds.insertOne({ id, ...row, source: p.source, access: 'owner_only', at }, { session });
        }
        const result = { inserted, skipped, held: p.heldRows.length, excluded: p.excludedRows.length, duplicateSourceRows: p.duplicateRows.length };
        await this.imports.insertOne({ id: importId, source: p.source, actor: user.email, at, result }, { session });
        return result;
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', wtimeoutMS: 5000 }, maxCommitTimeMS: 10000 });
    } catch (error) { if (error.code === 11000) throw problem('Import changed concurrently; preview again', 409); throw error; }
    finally { await session.endSession(); }
  }
  async change(user, id, version, action, mutate) {
    const row = await this.leads.findOne({ id: str(id, 100) }); requireVisible(row, user); requiredVersion(version);
    if (row.version !== version) throw problem('Buyer changed; refresh before saving', 409);
    if ((row.history || []).length >= 5000) throw problem('Buyer history limit reached; contact the owner', 409);
    const next = structuredClone(row), at = this.now().toISOString();
    // BSON ObjectId loses its prototype through structuredClone. Preserve Mongo's
    // immutable _id rather than replacing it with a plain cloned object.
    if (row._id !== undefined) next._id = row._id;
    await mutate(next, at);
    next.version++; next.updatedAt = at; next.history.push({ action, actor: user.email, at });
    const changed = await this.leads.replaceOne({ id, version }, next, { writeConcern: { w: 'majority', wtimeoutMS: 5000 } });
    if (!changed.acknowledged || changed.matchedCount !== 1) throw problem('Buyer changed; refresh before saving', 409);
    return publicLead(next, user.role === 'admin');
  }
  async update(user, id, input) {
    if (!plain(input) || Object.keys(input).some(key => !['version', 'stage', 'followUpAt', 'assignedTo', 'contactStatus', 'consentEvidence'].includes(key))) throw problem('Unsupported buyer change');
    return this.change(user, id, input.version, 'updated', async row => {
      if ('stage' in input) { if (!STAGES.includes(input.stage)) throw problem('Invalid pipeline stage'); row.stage = input.stage; }
      if ('followUpAt' in input) {
        if (input.followUpAt !== null && (typeof input.followUpAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(input.followUpAt) || !Number.isFinite(Date.parse(input.followUpAt)))) throw problem('Invalid follow-up date');
        row.followUpAt = input.followUpAt === null ? null : new Date(input.followUpAt).toISOString();
      }
      if ('assignedTo' in input) {
        this.admin(user);
        if (input.assignedTo !== null && (held(row) || excluded(row))) throw problem('Withheld buyers cannot be assigned', 409);
        const team = await this.getTeam();
        if (input.assignedTo !== null && !team.some(member => member.email === input.assignedTo && member.disabled !== true)) throw problem('Choose an existing enabled, allowed team account');
        row.assignedTo = input.assignedTo; row.access = input.assignedTo ? 'assigned_rep' : 'owner_only';
      }
      if ('contactStatus' in input) {
        if (!CONTACT_STATUSES.includes(input.contactStatus)) throw problem('Invalid contact permission');
        if ((held(row) || excluded(row)) && input.contactStatus !== 'suppressed') throw problem('Withheld buyers must remain suppressed', 409);
        if (input.contactStatus !== 'suppressed') this.admin(user);
        const evidence = str(input.consentEvidence, 3000, true);
        if (input.contactStatus === 'permitted' && !evidence) throw problem('Record evidence, channel and scope of permission first');
        row.contactStatus = input.contactStatus; row.consentEvidence = input.contactStatus === 'permitted' ? evidence : '';
      } else if ('consentEvidence' in input) throw problem('Save permission status with its evidence');
    });
  }
  async note(user, id, input) {
    const text = str(input?.text, 5000); if (!text) throw problem('A note is required');
    return this.change(user, id, input.version, 'note_added', (row, at) => { if (row.notes.length >= 1000) throw problem('Note limit reached'); row.notes.push({ id: crypto.randomUUID(), text, author: user.email, at }); });
  }
  async offer(user, id, input) {
    const title = str(input?.title, 200), description = str(input?.description, 5000, true), currency = str(input?.currency, 3).toUpperCase();
    const unitPrice = str(input?.unitPrice, 20), quantity = Number(input?.quantity);
    if (!title || !/^[A-Z]{3}$/.test(currency) || !/^\d{1,12}(\.\d{1,4})?$/.test(unitPrice) || Number(unitPrice) <= 0 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) throw problem('Enter a title, currency, positive unit price and whole quantity');
    return this.change(user, id, input.version, 'offer_drafted', (row, at) => { if (held(row) || excluded(row)) throw problem('Withheld buyers cannot receive offer drafts', 409); if (row.offers.length >= 500) throw problem('Offer limit reached'); row.offers.push({ id: crypto.randomUUID(), title, description, currency, unitPrice, quantity, status: 'draft', author: user.email, at }); });
  }
  async review(user, id, offerId, input) {
    this.admin(user); if (!['approved', 'rejected'].includes(input?.status)) throw problem('Choose approved or rejected');
    return this.change(user, id, input.version, 'offer_reviewed', (row, at) => {
      const offer = row.offers.find(item => item.id === offerId); if (!offer || offer.status !== 'draft') throw problem('Draft offer not found or already reviewed', 409);
      if ((row.contactStatus === 'suppressed' || held(row) || excluded(row)) && input.status === 'approved') throw problem('Suppressed contacts cannot have approved offers', 409);
      Object.assign(offer, { status: input.status, reviewNote: str(input.note, 3000, true), reviewedBy: user.email, reviewedAt: at });
    });
  }
  async export(user) {
    this.admin(user); const rows = await this.leads.find({}).limit(10001).toArray();
    if (rows.length > 10000) throw problem('Workspace export limit reached', 503);
    return { schemaVersion: 1, exportedAt: this.now().toISOString(), purpose: 'Owner worklist only, not a marketing send list', records: rows.filter(row => row.contactStatus !== 'suppressed' && !excluded(row) && !held(row)).map(row => publicLead(row, false)) };
  }
}
function registerBuyerCRM(app, { authMiddleware, adminMiddleware, asyncRoute, getStore, getTeam }) {
  const store = () => { const value = getStore(); if (!value?.ready) throw problem('Buyer CRM storage unavailable', 503); return value; };
  app.get('/api/crm/leads', authMiddleware, asyncRoute(async (req, res) => res.json(await store().list(req.user, req.query))));
  app.get('/api/crm/leads/:id', authMiddleware, asyncRoute(async (req, res) => res.json(await store().get(req.user, req.params.id))));
  app.patch('/api/crm/leads/:id', authMiddleware, asyncRoute(async (req, res) => res.json(await store().update(req.user, req.params.id, req.body))));
  app.post('/api/crm/leads/:id/notes', authMiddleware, asyncRoute(async (req, res) => res.json(await store().note(req.user, req.params.id, req.body))));
  app.post('/api/crm/leads/:id/offers', authMiddleware, asyncRoute(async (req, res) => res.json(await store().offer(req.user, req.params.id, req.body))));
  app.post('/api/crm/leads/:id/offers/:offerId/review', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => res.json(await store().review(req.user, req.params.id, req.params.offerId, req.body))));
  app.get('/api/crm/team', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => res.json({ items: (await getTeam()).map(user => ({ email: user.email, name: user.name })) })));
  app.get('/api/crm/export', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => res.json(await store().export(req.user))));
  app.post('/api/crm/import/preview', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => res.json(await store().preview(req.user, req.body?.package))));
  app.post('/api/crm/import/commit', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => res.json(await store().commit(req.user, req.body?.package, req.body?.previewToken))));
}
module.exports = { BuyerCRM, registerBuyerCRM, preparePackage, excluded, held, STAGES };
