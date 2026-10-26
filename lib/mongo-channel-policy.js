'use strict';

const { ChannelPolicy, channelIdValid, groupIdValid, contactIdValid, problem } = require('./channel-policy');

const DOCUMENT_ID = 'channel-policy-v1';
const COLLECTION_NAME = 'channel_privacy';
const MAX_CAS_ATTEMPTS = 16;
const copy = value => JSON.parse(JSON.stringify(value));
const record = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const storageError = () => problem('Privacy policy storage unavailable; all ingestion is blocked until restart', 503);

// There is deliberately no local policy snapshot or fallback file. Each read,
// including each ingestion lease check, goes to the primary. Majority writes
// plus single-document linearizable reads prevent an acknowledged revocation
// from being hidden by a stale secondary or a previous process's memory.
class MongoChannelPolicy {
  constructor(databaseOrCollection) {
    this.collection = databaseOrCollection && typeof databaseOrCollection.collection === 'function'
      ? databaseOrCollection.collection(COLLECTION_NAME) : databaseOrCollection;
    this.ready = false;
    this.poisoned = false;
    this.initialization = null;
  }

  failClosed() {
    this.ready = false;
    this.poisoned = true;
    return storageError();
  }

  checkReady() {
    if (!this.ready || this.poisoned) throw storageError();
  }

  validate(state) {
    ChannelPolicy.prototype.validate.call(this, state);
    if (!record(state) || !record(state.channels) || !record(state.deleted)) throw problem('Invalid policy');
    for (const channel of Object.values(state.channels)) {
      if (!record(channel) || !record(channel.groups) || (Object.hasOwn(channel, 'contacts') && !record(channel.contacts)) || (Object.hasOwn(channel, 'deletedContacts') && !record(channel.deletedContacts)) || channel.label.length > 160 || !channel.generation || channel.generation.length > 128) throw problem('Invalid channel policy');
      for (const contact of Object.values(channel.contacts || {})) { if (!record(contact)) throw problem('Invalid contact policy'); }
      for (const group of Object.values(channel.groups)) {
        if (!record(group) || group.name.length > 200 || !Number.isSafeInteger(group.participants) || group.participants < 0) throw problem('Invalid group policy');
      }
    }
  }

  validateDocument(document) {
    if (!record(document) || Object.keys(document).some(key => !['_id', 'revision', 'version', 'channels', 'deleted'].includes(key))
      || document._id !== DOCUMENT_ID || !Number.isSafeInteger(document.revision) || document.revision < 0) throw problem('Invalid policy document');
    this.validate({ version: document.version, channels: document.channels, deleted: document.deleted });
  }

  async initialize() {
    if (this.poisoned) return false;
    if (!this.initialization) this.initialization = this.initializeOnce();
    return this.initialization;
  }

  async initializeOnce() {
    try {
      const result = await this.collection.updateOne(
        { _id: DOCUMENT_ID },
        { $setOnInsert: { revision: 0, version: 1, channels: {}, deleted: {} } },
        { upsert: true, writeConcern: { w: 'majority', wtimeoutMS: 5000 }, maxTimeMS: 5000 }
      );
      if (!result || result.acknowledged !== true || !((result.matchedCount === 1 && result.upsertedCount === 0)
        || (result.matchedCount === 0 && result.upsertedCount === 1))) throw storageError();
      await this.readDocument(true);
      if (this.poisoned) return false;
      this.ready = true;
      return true;
    } catch {
      this.failClosed();
      return false;
    }
  }

  async readDocument(initializing = false) {
    if (!initializing) this.checkReady();
    try {
      const document = await this.collection.findOne({ _id: DOCUMENT_ID }, {
        readPreference: 'primary', readConcern: { level: 'linearizable' }, maxTimeMS: 5000
      });
      this.validateDocument(document);
      // Another concurrent operation may have failed while this read waited.
      if (this.poisoned) throw storageError();
      if (!initializing) this.checkReady();
      return document;
    } catch {
      throw this.failClosed();
    }
  }

  async change(mutate, grantTargets = []) {
    this.checkReady();
    let grantVersions = null;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const previous = await this.readDocument();
      if (grantVersions) {
        for (const [id, version] of grantVersions) {
          const channel = Object.hasOwn(previous.channels, id) ? previous.channels[id] : null;
          if (!channel || channel.generation !== version.generation || channel.authorizationVersion !== version.authorizationVersion) {
            throw problem('Channel permissions changed during update; review the latest settings and retry', 409);
          }
        }
      }
      const next = copy({ version: previous.version, channels: previous.channels, deleted: previous.deleted });
      // Input/rule errors do not poison a healthy database. Nothing is written
      // until every requested change and the entire resulting policy validate.
      const result = mutate(next);
      try { this.validate(next); } catch { throw this.failClosed(); }
      if (!grantVersions) {
        grantVersions = Object.entries(next.channels).filter(([id, channel]) => {
          const old = Object.hasOwn(previous.channels, id) ? previous.channels[id] : null;
          return old && (grantTargets.includes(id) || (!old.active && channel.active)
            || Object.values(channel.groups).some(group => group.enabled && old.groups[group.id]?.enabled !== true)
            || Object.values(channel.contacts || {}).some(contact => contact.enabled && old.contacts?.[contact.id]?.enabled !== true));
        }).map(([id]) => [id, { generation: previous.channels[id].generation, authorizationVersion: previous.channels[id].authorizationVersion }]);
      }
      if (!Number.isSafeInteger(previous.revision + 1)) throw this.failClosed();
      const replacement = { _id: DOCUMENT_ID, revision: previous.revision + 1, ...next };
      this.validateDocument(replacement);
      this.checkReady();
      let written;
      try {
        written = await this.collection.replaceOne({ _id: DOCUMENT_ID, revision: previous.revision }, replacement,
          { upsert: false, writeConcern: { w: 'majority', wtimeoutMS: 5000 }, maxTimeMS: 5000 });
      } catch {
        throw this.failClosed();
      }
      this.checkReady();
      if (!written || written.acknowledged !== true) throw this.failClosed();
      if (written.matchedCount === 1 && written.modifiedCount === 1) return copy(result === undefined ? { ok: true } : result);
      if (written.matchedCount !== 0 || written.modifiedCount !== 0) throw this.failClosed();
      // A revision conflict is safe to retry only by re-reading and reapplying
      // this specific operation. Never replay a stale, whole-policy snapshot.
    }
    throw this.failClosed();
  }

  async list() {
    const document = await this.readDocument();
    this.checkReady();
    return Object.values(copy(document.channels));
  }

  async get(id) {
    const document = await this.readDocument();
    this.checkReady();
    return channelIdValid(id) && Object.hasOwn(document.channels, id) ? copy(document.channels[id]) : null;
  }

  required(state, id) { return ChannelPolicy.prototype.required.call(this, state, id); }
  async create(id, label = '') { return ChannelPolicy.prototype.create.call(this, id, label); }
  async setActive(id, active) {
    const context = { required: this.required, change: mutate => this.change(mutate, active === true ? [id] : []) };
    return ChannelPolicy.prototype.setActive.call(context, id, active);
  }
  async remove(id) { return ChannelPolicy.prototype.remove.call(this, id); }
  async mergeGroups(id, groups, generation) { return ChannelPolicy.prototype.mergeGroups.call(this, id, groups, generation); }
  async setGroups(id, groups) {
    const grants = Array.isArray(groups) && groups.some(group => group && group.enabled === true);
    const context = { required: this.required, change: mutate => this.change(mutate, grants ? [id] : []) };
    return ChannelPolicy.prototype.setGroups.call(context, id, groups);
  }

  async addContact(id, contact) { return ChannelPolicy.prototype.addContact.call(this, id, contact); }
  async setContacts(id, contacts) {
    const grants = Array.isArray(contacts) && contacts.some(contact => contact && contact.enabled === true);
    const context = { required: this.required, change: mutate => this.change(mutate, grants ? [id] : []) };
    return ChannelPolicy.prototype.setContacts.call(context, id, contacts);
  }
  async removeContact(id, contactId) { return ChannelPolicy.prototype.removeContact.call(this, id, contactId); }

  async lease(channelId, groupId) {
    try {
      const document = await this.readDocument();
      this.checkReady();
      if (!channelIdValid(channelId) || (!groupIdValid(groupId) && !contactIdValid(groupId)) || !Object.hasOwn(document.channels, channelId)) return null;
      const channel = document.channels[channelId];
      const selections = groupIdValid(groupId) ? channel.groups : channel.contacts || {};
      if (channel.active !== true || !Object.hasOwn(selections, groupId) || selections[groupId].enabled !== true) return null;
      return channel.generation + ':' + channel.authorizationVersion;
    } catch {
      return null;
    }
  }

  // Serialize message commits against source revocation using a real write to
  // the SAME policy document. Snapshot reads alone do not create a conflict.
  // The caller must use this database's session and must not perform external
  // linearizable policy reads while this transaction holds the document lock.
  async fence(session, channelId, sourceId, expectedLease) {
    this.checkReady();
    if (!session || typeof session.inTransaction !== 'function' || !session.inTransaction()) throw storageError();
    if (!channelIdValid(channelId) || (!groupIdValid(sourceId) && !contactIdValid(sourceId)) || typeof expectedLease !== 'string') throw problem('Group selection changed during processing', 409);
    const document = await this.collection.findOne({ _id: DOCUMENT_ID }, { session });
    try { this.validateDocument(document); } catch { throw this.failClosed(); }
    this.checkReady();
    const channel = Object.hasOwn(document.channels, channelId) ? document.channels[channelId] : null;
    const selections = groupIdValid(sourceId) ? channel?.groups : channel?.contacts;
    if (!channel || channel.active !== true || !selections || !Object.hasOwn(selections, sourceId) || selections[sourceId].enabled !== true
      || channel.generation + ':' + channel.authorizationVersion !== expectedLease) throw problem('Group selection changed during processing', 409);
    if (!Number.isSafeInteger(document.revision + 1)) throw this.failClosed();
    // A competing revocation changes this document: Mongo aborts/retries a stale
    // transaction, whose fresh snapshot must validate the ORIGINAL lease again.
    // Do not swallow transient driver errors or poison otherwise healthy retry.
    const result = await this.collection.updateOne({ _id: DOCUMENT_ID, revision: document.revision }, { $inc: { revision: 1 } }, { session, upsert: false });
    if (!result || result.acknowledged !== true || result.matchedCount !== 1 || result.modifiedCount !== 1) throw storageError();
    this.checkReady();
  }

  async allows(channelId, groupId) {
    const lease = await this.lease(channelId, groupId);
    return this.ready && !this.poisoned && lease !== null;
  }
}

function validateTransactionTopology(topology) {
  // Necessary topology/session prerequisites, not a successful transaction probe.
  if (!topology || (!(typeof topology.setName === 'string' && topology.setName) && topology.msg !== 'isdbgrid')
    || !Number.isFinite(topology.logicalSessionTimeoutMinutes) || topology.logicalSessionTimeoutMinutes <= 0) throw storageError();
  return true;
}
module.exports = { MongoChannelPolicy, DOCUMENT_ID, COLLECTION_NAME, validateTransactionTopology };
