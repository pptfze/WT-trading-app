'use strict';
const { canonicalEmail, parsePasswordHash, securityError } = require('./auth-security');

function accountPlan(input, env) {
  const email = canonicalEmail(input.email);
  const admins = new Set((env.ADMIN_EMAILS || '').split(',').map(canonicalEmail).filter(Boolean));
  const members = new Set([...admins, ...(env.APP_ALLOWED_EMAILS || '').split(',').map(canonicalEmail).filter(Boolean)]);
  if (!email || !members.has(email)) throw securityError('The exact account must be in ADMIN_EMAILS or APP_ALLOWED_EMAILS before maintenance.', 400);
  if (!['create', 'reset-password', 'disable', 'enable', 'revoke-sessions'].includes(input.action)) throw securityError('Unsupported account maintenance action.', 400);
  const plan = { action: input.action, email };
  if (input.action === 'create') {
    if (!['admin', 'member'].includes(input.role)) throw securityError('Choose the explicit admin or member role.', 400);
    if (input.role === 'admin' && !admins.has(email)) throw securityError('Administrator accounts must be in ADMIN_EMAILS.', 400);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || /[\x00-\x1f]/.test(input.name)) throw securityError('Enter a name of 1–100 characters.', 400);
    plan.role = input.role; plan.name = input.name.trim();
  } else if (input.role !== undefined || input.name !== undefined) {
    throw securityError('Role and name are only accepted when creating an account.', 400);
  }
  return plan;
}
async function applyAccountChange(collection, plan, passwordHash, { now = () => new Date() } = {}) {
  // This is only imported by the operator CLI. No HTTP route imports this module.
  if (['create', 'reset-password'].includes(plan.action) && !parsePasswordHash(passwordHash)) throw securityError('A current-version password hash is required.', 400);
  const writeConcern = { w: 'majority', wtimeoutMS: 5000 };
  if (plan.action === 'create') {
    await collection.createIndex({ email: 1 }, { unique: true });
    const result = await collection.insertOne({ email: plan.email, name: plan.name, role: plan.role, passwordHash, disabled: false, authVersion: 0, createdAt: now(), passwordChangedAt: now() }, { writeConcern });
    if (!result.acknowledged) throw securityError('Account creation was not confirmed. Inspect before retrying.');
    return;
  }
  const user = await collection.findOne({ email: plan.email }, { readPreference: 'primary', readConcern: { level: 'linearizable' }, maxTimeMS: 5000 });
  if (!user) throw securityError('Account not found; maintenance does not create it implicitly.', 404);
  const update = { $inc: { authVersion: 1 } };
  if (plan.action === 'reset-password') update.$set = { passwordHash, passwordChangedAt: now() };
  else if (plan.action === 'disable' || plan.action === 'enable') update.$set = { disabled: plan.action === 'disable' };
  else if (plan.action !== 'revoke-sessions') throw securityError('Unsupported account maintenance action.', 400);
  const result = await collection.updateOne({ email: plan.email, ...(user.passwordHash !== undefined ? { passwordHash: user.passwordHash } : {}) }, update, { writeConcern });
  if (!result.acknowledged || result.matchedCount !== 1) throw securityError('Account changed or maintenance was not confirmed. Inspect before retrying.');
}
module.exports = { accountPlan, applyAccountChange };
