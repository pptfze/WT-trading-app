'use strict';
const crypto = require('node:crypto');
const { securityError } = require('./auth-security');

const WRITE = Object.freeze({ w: 'majority' });
const WINDOW_MS = 15 * 60 * 1000;

// Shared Mongo counters survive restarts and combine all replicas using the
// same database and signing secret. Counter reservation happens BEFORE hashing
// or account lookup, including unknown users and successful attempts.
class MongoLoginLimiter {
  constructor(collection, secret, { now = Date.now, client } = {}) {
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw securityError('Login protection is not configured');
    this.collection = collection; this.secret = secret; this.now = now; this.client = client; this.ready = false;
  }
  async initialize() {
    this.ready = false;
    if (!this.client || typeof this.client.startSession !== 'function') throw securityError('Transactional login protection unavailable');
    await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'login_window_expiry' });
    this.ready = true;
  }
  async reserve(scope, identity, bucket, limit, expiresAt, session) {
    const _id = crypto.createHmac('sha256', this.secret).update(JSON.stringify(['login-v1', scope, identity, bucket])).digest('hex');
    const created = await this.collection.updateOne({ _id }, { $setOnInsert: { attempts: 0, expiresAt } }, { upsert: true, session });
    if (!created.acknowledged) throw securityError('Login protection unavailable');
    // A conditional single-document update cannot exceed the cap under races.
    const result = await this.collection.findOneAndUpdate(
      { _id, attempts: { $lt: limit } }, { $inc: { attempts: 1 } },
      { upsert: false, returnDocument: 'after', includeResultMetadata: false, session }
    );
    if (!result) return false;
    if (result._id !== _id || !Number.isSafeInteger(result.attempts) || result.attempts < 1 || result.attempts > limit) throw securityError('Login protection unavailable');
    return true;
  }
  async consume({ email, ip }) {
    if (!this.ready) throw securityError('Login protection unavailable');
    const now = this.now(), bucket = Math.floor(now / WINDOW_MS);
    const retryAfter = Math.max(1, Math.ceil(((bucket + 1) * WINDOW_MS - now) / 1000));
    const expiresAt = new Date((bucket + 2) * WINDOW_MS);
    // No forwarded-header parsing here. Express supplies req.ip only after its
    // explicitly configured, verified proxy trust boundary has been applied.
    const peer = typeof ip === 'string' && ip.length <= 128 ? ip : 'unknown-peer';
    const account = typeof email === 'string' && email.length <= 254 ? email : 'invalid-account';
    const session = this.client.startSession({ defaultTimeoutMS: 5000 });
    const limited = new Error('Login attempt limit exceeded');
    try {
      // All counters commit together. Rejected traffic cannot burn another
      // account's global quota or leave arbitrary new identity records behind.
      await session.withTransaction(async () => {
        for (const [scope, identity, limit] of [['global', 'all', 300], ['peer', peer, 100], ['account', account, 10]]) {
          if (!await this.reserve(scope, identity, bucket, limit, expiresAt, session)) throw limited;
        }
      }, { readConcern: { level: 'snapshot' }, writeConcern: WRITE, readPreference: 'primary', timeoutMS: 5000 });
      return { allowed: true, retryAfter: 0 };
    } catch (error) {
      if (error === limited) return { allowed: false, retryAfter };
      throw error;
    } finally { await session.endSession({ timeoutMS: 5000 }); }

  }
}
module.exports = { MongoLoginLimiter, WINDOW_MS };
