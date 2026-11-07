'use strict';

// Shared policy validation/mutation rules plus a filesystem test reference.
// Production uses MongoChannelPolicy; do not instantiate this file adapter there.
// This file stores only channel/group selections. Provider credentials belong in
// the server environment, never in this file or in browser/API responses.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const channelIdValid = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
const groupIdValid = id => typeof id === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(id) && id.length <= 128;
// Supported contact identity is an explicitly entered international phone number.
// Do not guess a country code or map provider LID/c.us aliases to phone identities.
const phoneValid = value => typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value);
const contactIdValid = id => typeof id === 'string' && /^[1-9]\d{7,14}@s\.whatsapp\.net$/.test(id);
function contactIdFromPhone(phone) {
  if (!phoneValid(phone)) throw problem('Enter a full international phone number: + and 8 to 15 digits');
  return phone.slice(1) + '@s.whatsapp.net';
}
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fieldsOnly = (value, names) => Object.keys(value).every(key => names.includes(key));
const copy = value => JSON.parse(JSON.stringify(value));
function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }

class ChannelPolicy {
  constructor(filename, io = fs) {
    this.filename = path.resolve(filename);
    this.io = io;
    this.ready = false;
    this.state = { version: 1, channels: {}, deleted: {} };
    try {
      if (io.existsSync(this.filename)) {
        const source = io.readFileSync(this.filename, 'utf8');
        const stored = JSON.parse(source);
        this.validate(stored);
        this.state = stored;
        this.diskSnapshot = source;
      } else {
        this.persist(this.state);
      }
      this.ready = true;
    } catch {
      // Never recreate a corrupt/inaccessible file or silently use default-allow.
      this.ready = false;
    }
  }

  validate(state) {
    if (!plainObject(state) || !fieldsOnly(state, ['version', 'channels', 'deleted']) || state.version !== 1 || !plainObject(state.channels) || !plainObject(state.deleted)) throw problem('Invalid policy');
    for (const [id, ch] of Object.entries(state.channels)) {
      if (!channelIdValid(id) || !plainObject(ch) || !fieldsOnly(ch, ['id', 'label', 'active', 'generation', 'authorizationVersion', 'groups', 'contacts', 'deletedContacts']) || ch.id !== id || typeof ch.active !== 'boolean' || typeof ch.label !== 'string' || typeof ch.generation !== 'string' || !plainObject(ch.groups) || !Number.isSafeInteger(ch.authorizationVersion) || ch.authorizationVersion < 0) throw problem('Invalid channel policy');
      for (const [gid, group] of Object.entries(ch.groups)) {
        if (!groupIdValid(gid) || !plainObject(group) || !fieldsOnly(group, ['id', 'name', 'participants', 'enabled']) || group.id !== gid || typeof group.enabled !== 'boolean' || typeof group.name !== 'string') throw problem('Invalid group policy');
      }
      if (Object.hasOwn(ch, 'contacts') && !plainObject(ch.contacts)) throw problem('Invalid contact policy');
      if (Object.hasOwn(ch, 'deletedContacts') && !plainObject(ch.deletedContacts)) throw problem('Invalid contact deletion policy');
      for (const [cid, contact] of Object.entries(ch.contacts || {})) {
        if (!contactIdValid(cid) || !plainObject(contact) || !fieldsOnly(contact, ['id', 'phone', 'name', 'enabled'])
          || contact.id !== cid || !phoneValid(contact.phone) || contactIdFromPhone(contact.phone) !== cid
          || typeof contact.name !== 'string' || contact.name.length > 160 || typeof contact.enabled !== 'boolean') throw problem('Invalid contact policy');
      }
      for (const [cid, deleted] of Object.entries(ch.deletedContacts || {})) {
        if (!contactIdValid(cid) || deleted !== true || Object.hasOwn(ch.contacts || {}, cid)) throw problem('Invalid contact deletion policy');
      }
    }
    for (const [id, deleted] of Object.entries(state.deleted)) {
      if (!channelIdValid(id) || deleted !== true || Object.hasOwn(state.channels, id)) throw problem('Invalid deletion policy');
    }
  }

  persist(next) {
    const directory = path.dirname(this.filename);
    this.io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = this.filename + '.' + crypto.randomUUID() + '.tmp';
    let fd;
    try {
      fd = this.io.openSync(temporary, 'wx', 0o600);
      const serialized = JSON.stringify(next, null, 2) + '\n';
      this.io.writeFileSync(fd, serialized);
      this.io.fsyncSync(fd);
      this.io.closeSync(fd); fd = undefined;
      this.io.renameSync(temporary, this.filename);
      const dirFd = this.io.openSync(directory, 'r');
      try { this.io.fsyncSync(dirFd); } finally { this.io.closeSync(dirFd); }
      this.diskSnapshot = serialized;
    } finally {
      if (fd !== undefined) this.io.closeSync(fd);
      try { this.io.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }

  checkReady() {
    if (this.ready) {
      try {
        // Detect lost mounts, corruption, external edits and stale second readers.
        if (this.io.readFileSync(this.filename, 'utf8') !== this.diskSnapshot) this.ready = false;
      } catch { this.ready = false; }
    }
    if (!this.ready) throw problem('Privacy policy storage unavailable or changed; all ingestion is blocked', 503);
  }
  change(fn) {
    this.checkReady();
    const next = copy(this.state);
    const result = fn(next);
    this.validate(next);
    try { this.persist(next); } catch {
      this.ready = false;
      throw problem('Could not save privacy settings; all ingestion is blocked', 503);
    }
    this.state = next;
    return copy(result === undefined ? { ok: true } : result);
  }
  list() { this.checkReady(); return Object.values(copy(this.state.channels)); }
  get(id) { this.checkReady(); return channelIdValid(id) && Object.hasOwn(this.state.channels, id) ? copy(this.state.channels[id]) : null; }
  required(state, id) {
    if (!channelIdValid(id) || !Object.hasOwn(state.channels, id)) throw problem('Channel not found', 404);
    return state.channels[id];
  }
  create(id, label = '') {
    if (!channelIdValid(id) || typeof label !== 'string' || label.length > 160) throw problem('Invalid channel id or label');
    return this.change(state => {
      if (Object.hasOwn(state.deleted, id)) throw problem('Deleted channel cannot be recreated automatically; use a new channel id', 409);
      if (Object.hasOwn(state.channels, id)) throw problem('Channel already exists; existing selections have not changed', 409);
      return state.channels[id] = { id, label: label || id, active: false, generation: crypto.randomUUID(), authorizationVersion: 0, groups: {}, contacts: {}, deletedContacts: {} };
    });
  }
  setActive(id, active) {
    if (typeof active !== 'boolean') throw problem('active must be a boolean');
    return this.change(state => { const ch = this.required(state, id); if (ch.active !== active) ch.authorizationVersion++; ch.active = active; return ch; });
  }
  remove(id) {
    return this.change(state => { this.required(state, id); delete state.channels[id]; state.deleted[id] = true; });
  }
  mergeGroups(id, groups, generation) {
    if (!Array.isArray(groups)) throw problem('Invalid group response');
    return this.change(state => {
      const ch = this.required(state, id);
      if (generation !== ch.generation) throw problem('Channel changed during sync', 409);
      for (const item of groups) {
        // Ignore personal chats, broadcast/status/newsletter IDs and malformed IDs.
        if (!plainObject(item) || !groupIdValid(item.id)) continue;
        const name = typeof item.name === 'string' ? item.name.slice(0, 200) : item.id;
        const participants = Number.isSafeInteger(item.participants) && item.participants >= 0 ? item.participants : 0;
        if (!ch.groups[item.id]) ch.groups[item.id] = { id: item.id, name, participants, enabled: false };
        else Object.assign(ch.groups[item.id], { name, participants });
      }
      return Object.values(ch.groups);
    });
  }
  setGroups(id, groups) {
    if (!Array.isArray(groups) || groups.length > 5000) throw problem('groups must be an array');
    return this.change(state => {
      const ch = this.required(state, id);
      for (const group of groups) {
        if (!plainObject(group) || !groupIdValid(group.id) || typeof group.enabled !== 'boolean') throw problem('Each group needs a valid id and boolean enabled');
        if (!ch.groups[group.id]) throw problem('Group not found', 404);
      }
      if (groups.some(group => ch.groups[group.id].enabled !== group.enabled)) ch.authorizationVersion++;
      for (const group of groups) ch.groups[group.id].enabled = group.enabled;
      return ch;
    });
  }
  addContact(id, contact) {
    if (!plainObject(contact) || !fieldsOnly(contact, ['phone', 'name']) || (Object.hasOwn(contact, 'name') && (typeof contact.name !== 'string' || contact.name.length > 160))) throw problem('Contact needs an international phone number and optional name; new contacts start OFF');
    const contactId = contactIdFromPhone(contact.phone);
    return this.change(state => {
      const ch = this.required(state, id);
      ch.contacts ||= {};
      ch.deletedContacts ||= {};
      if (Object.hasOwn(ch.deletedContacts, contactId)) throw problem('Deleted contact cannot be recreated by a stale request', 409);
      if (Object.hasOwn(ch.contacts, contactId)) throw problem('Contact already exists; its selection has not changed', 409);
      return ch.contacts[contactId] = { id: contactId, phone: contact.phone, name: contact.name || contact.phone, enabled: false };
    });
  }
  setContacts(id, contacts) {
    if (!Array.isArray(contacts) || contacts.length > 5000) throw problem('contacts must be an array');
    return this.change(state => {
      const ch = this.required(state, id);
      for (const contact of contacts) {
        if (!plainObject(contact) || !fieldsOnly(contact, ['id', 'enabled']) || !contactIdValid(contact.id) || typeof contact.enabled !== 'boolean') throw problem('Each contact needs an exact chat id and boolean enabled');
        if (!Object.hasOwn(ch.contacts || {}, contact.id)) throw problem('Contact not found', 404);
      }
      if (contacts.some(contact => ch.contacts[contact.id].enabled !== contact.enabled)) ch.authorizationVersion++;
      for (const contact of contacts) ch.contacts[contact.id].enabled = contact.enabled;
      return ch;
    });
  }
  removeContact(id, contactId) {
    if (!contactIdValid(contactId)) throw problem('Invalid contact chat id');
    return this.change(state => {
      const ch = this.required(state, id);
      if (!Object.hasOwn(ch.contacts || {}, contactId)) throw problem('Contact not found', 404);
      delete ch.contacts[contactId];
      ch.deletedContacts ||= {};
      ch.deletedContacts[contactId] = true;
      ch.authorizationVersion++;
    });
  }
  lease(channelId, groupId) {
    if (!this.allows(channelId, groupId)) return null;
    const ch = this.state.channels[channelId];
    return ch.generation + ':' + ch.authorizationVersion;
  }
  allows(channelId, groupId) {
    try { this.checkReady(); } catch { return false; }
    if (!channelIdValid(channelId) || (!groupIdValid(groupId) && !contactIdValid(groupId))) return false;
    const ch = Object.hasOwn(this.state.channels, channelId) ? this.state.channels[channelId] : null;
    if (!ch || ch.active !== true) return false;
    const selections = groupIdValid(groupId) ? ch.groups : ch.contacts || {};
    return Object.hasOwn(selections, groupId) && selections[groupId].enabled === true;
  }
}
module.exports = { ChannelPolicy, channelIdValid, groupIdValid, contactIdValid, contactIdFromPhone, problem };
