'use strict';
// Loopback-only, uniquely named disposable databases and synthetic records.
// Never consult MONGO_URI, Atlas credentials, or private workbook contents.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MongoClient } = require('mongodb');
const { BuyerCRM } = require('../lib/buyer-crm');
const owner = { email: 'owner@example.invalid', role: 'admin' };
const rep = { email: 'rep@example.invalid', role: 'member' };
const other = { email: 'other@example.invalid', role: 'member' };
const options = { secret: 'synthetic-crm-preview-secret-not-production', getTeam: async () => [owner, rep] };
function sourcePackage(records = [{ sourceRowKey: 'synthetic:1', company: 'Synthetic Buyer', emails: ['buyer@example.invalid'], rawFields: { evidence: 'Synthetic original source' } }]) {
  return { schemaVersion: 1, source: { libraryFileId: 'synthetic-file', filename: 'synthetic.xlsx', version: 1, sha256: 'a'.repeat(64) }, records, held: [], excluded: [] };
}
async function fixture(work) {
  const client = new MongoClient('mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true', { serverSelectionTimeoutMS: 5000 });
  const db = client.db('wt_ci_' + randomUUID().replaceAll('-', ''));
  try {
    await client.connect();
    assert.equal((await db.admin().command({ hello: 1 })).setName, 'rs0');
    const crm = new BuyerCRM(db, client, options);
    await crm.initialize();
    await work({ crm, db, client });
  } finally {
    await db.dropDatabase().catch(() => {});
    await client.close();
  }
}
async function importPackage(crm, payload) {
  const preview = await crm.preview(owner, payload);
  return crm.commit(owner, payload, preview.previewToken);
}

test('real Mongo CRM import, assignment, ObjectId-safe edits and durable replay', { timeout: 60000 }, async () => fixture(async ({ crm, db, client }) => {
  const payload = sourcePackage();
  assert.equal((await importPackage(crm, payload)).inserted, 1);
  const lead = (await crm.list(owner)).items[0];
  assert.equal((await crm.list(rep)).total, 0);
  const original = await db.collection('buyer_crm_leads_v1').findOne({ id: lead.id });
  assert.equal(original._id._bsontype, 'ObjectId');
  await crm.update(owner, lead.id, { version: 1, assignedTo: rep.email });
  await crm.note(rep, lead.id, { version: 2, text: 'Synthetic conversation note' });
  assert.equal((await crm.list(rep)).total, 1);
  assert.equal((await crm.list(other)).total, 0);
  await assert.rejects(crm.get(other, lead.id), { status: 404 });
  assert.equal((await crm.get(rep, lead.id)).rawFields, undefined);
  const restarted = new BuyerCRM(db, client, options);
  await restarted.initialize();
  const replay = await importPackage(restarted, payload);
  assert.equal(replay.replay, true);
  assert.equal(await db.collection('buyer_crm_leads_v1').countDocuments(), 1);
  const updated = await db.collection('buyer_crm_leads_v1').findOne({ id: lead.id });
  assert.ok(updated._id.equals(original._id));
  assert.equal(updated.notes[0].text, 'Synthetic conversation note');
  assert.deepEqual(updated.rawFields, payload.records[0].rawFields);
  assert.equal(updated.version, 3);
}));

test('real Mongo held reimport revokes rep access without losing original history', { timeout: 60000 }, async () => fixture(async ({ crm, db }) => {
  const payload = sourcePackage();
  await importPackage(crm, payload);
  const lead = (await crm.list(owner)).items[0];
  await crm.update(owner, lead.id, { version: 1, assignedTo: rep.email });
  await crm.note(rep, lead.id, { version: 2, text: 'Keep synthetic history' });
  const hold = sourcePackage([]);
  hold.source.version = 2;
  hold.held = [{ sourceRowKey: 'synthetic:1', company: 'Synthetic Buyer' }];
  assert.equal((await crm.preview(owner, hold)).counts.quarantine, 1);
  await importPackage(crm, hold);
  assert.equal((await crm.list(rep)).total, 0);
  await assert.rejects(crm.get(rep, lead.id), { status: 404 });
  await assert.rejects(crm.note(rep, lead.id, { version: 4, text: 'Cannot append' }), { status: 404 });
  await assert.rejects(crm.update(owner, lead.id, { version: 4, assignedTo: rep.email }), { status: 409 });
  assert.equal((await crm.export(owner)).records.length, 0);
  const row = await crm.get(owner, lead.id);
  assert.equal(row.complianceHold, true);
  assert.equal(row.assignedTo, null);
  assert.equal(row.contactStatus, 'suppressed');
  assert.equal(row.notes[0].text, 'Keep synthetic history');
  assert.equal(row.history.at(-1).action, 'source_withheld');
  assert.equal(row.history.length, 4);
  assert.deepEqual(row.rawFields, payload.records[0].rawFields);
  assert.equal((await importPackage(crm, payload)).replay, true);
  assert.equal((await crm.get(owner, lead.id)).complianceHold, true);
  assert.equal(await db.collection('buyer_crm_holds_v1').countDocuments(), 1);
}));

for (const outerKind of ['eligible', 'held']) {
  test(`real Mongo concurrent ${outerKind} snapshot retries after competing import`, { timeout: 60000 }, async () => fixture(async ({ crm, db, client }) => {
    // Ensure an existing lock document so the race exercises snapshot write
    // conflict retries rather than the separate first-upsert unique-key path.
    await importPackage(crm, sourcePackage([]));
    const competing = new BuyerCRM(db, client, options);
    await competing.initialize();
    const eligible = sourcePackage();
    const held = sourcePackage([]);
    held.source.version = 2;
    held.held = [{ sourceRowKey: 'synthetic:1', company: 'Synthetic Buyer' }];
    const outerPayload = outerKind === 'eligible' ? eligible : held;
    const competingPayload = outerKind === 'eligible' ? held : eligible;
    const outerPreview = await crm.preview(owner, outerPayload);
    const competingPreview = await competing.preview(owner, competingPayload);
    const imports = crm.imports;
    let interleaved = false, snapshotReads = 0;
    crm.imports = {
      findOne: async (query, args) => {
        const document = await imports.findOne(query, args);
        if (args?.session) {
          snapshotReads++;
          if (!interleaved) {
            interleaved = true;
            // Commit another transaction after this transaction established its
            // snapshot, but before it writes the shared workspace lock.
            await competing.commit(owner, competingPayload, competingPreview.previewToken);
          }
        }
        return document;
      },
      updateOne: (...args) => imports.updateOne(...args),
      insertOne: (...args) => imports.insertOne(...args),
    };
    const result = await crm.commit(owner, outerPayload, outerPreview.previewToken);
    assert.equal(interleaved, true);
    assert.ok(snapshotReads >= 2, 'the Mongo driver must retry the stale snapshot');
    assert.equal((await crm.list(rep)).total, 0);
    assert.equal((await crm.export(owner)).records.length, 0);
    assert.equal(await db.collection('buyer_crm_holds_v1').countDocuments(), 1);
    const rows = await db.collection('buyer_crm_leads_v1').find({}).toArray();
    if (outerKind === 'eligible') {
      assert.equal(result.inserted, 0);
      assert.equal(result.skipped, 1);
      assert.equal(rows.length, 0);
    } else {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].complianceHold, true);
      assert.equal(rows[0].assignedTo, null);
      assert.equal(rows[0].contactStatus, 'suppressed');
      assert.equal(rows[0].history.at(-1).action, 'source_withheld');
    }
  }));
}
