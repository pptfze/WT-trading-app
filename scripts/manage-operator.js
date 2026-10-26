#!/usr/bin/env node
'use strict';

// Deliberate, operator-run maintenance only. Never invoked by app startup or HTTP.
// Do not run against a real database without authorization for this exact action.
const { createInterface } = require('node:readline/promises');
const { Writable } = require('node:stream');
const { hashPassword, validateDatabaseName } = require('../lib/auth-security');
const { accountPlan, applyAccountChange } = require('../lib/operator-accounts');

const HELP = `Operator account maintenance (no public signup)

Actions: create, reset-password, disable, enable, revoke-sessions
Required: --email ADDRESS --database EXACT_DB_NAME --apply
Create only: --name NAME --role admin|member

The terminal must be private and interactive. Configure MONGO_URI and explicit
MONGODB_DB_NAME privately, plus operator-approved ADMIN_EMAILS/APP_ALLOWED_EMAILS.
Set OPERATOR_ACCOUNT_MAINTENANCE=true only for this invocation. Never put a password
in arguments, environment variables, files or chat. Passwords are entered twice
at a hidden terminal prompt; they are never printed or randomly generated.

This utility changes persistent access. The owner must authorize each action and
personally enter/confirm a new password. This build has not run it against any DB.
`;

function parseArgs(args) {
  const [action, ...rest] = args;
  const result = { action };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (key === '--apply') { if (result.apply) throw new Error('Duplicate --apply.'); result.apply = true; continue; }
    if (!['--email', '--database', '--name', '--role'].includes(key) || !rest[i + 1] || rest[i + 1].startsWith('--') || Object.hasOwn(result, key.slice(2))) throw new Error('Invalid or duplicate arguments. Use --help.');
    result[key.slice(2)] = rest[++i];
  }
  return result;
}
async function promptTerminal(question, hidden = false) {
  let mute = hidden;
  const output = new Writable({ write(chunk, encoding, callback) { if (!mute) process.stdout.write(chunk, encoding); callback(); } });
  process.stdout.write(question);
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  try { return await rl.question(''); }
  finally { mute = false; rl.close(); if (hidden) process.stdout.write('\n'); }
}
async function main(args = process.argv.slice(2)) {
  if (!args.length || (args.length === 1 && args[0] === '--help')) { process.stdout.write(HELP); return; }
  const input = parseArgs(args);
  if (!input.apply || process.env.OPERATOR_ACCOUNT_MAINTENANCE !== 'true') throw new Error('Maintenance blocked: explicit --apply and OPERATOR_ACCOUNT_MAINTENANCE=true are required.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Maintenance requires a private interactive terminal; piped credentials are not accepted.');
  const database = validateDatabaseName(process.env.MONGODB_DB_NAME);
  if (input.database !== database) throw new Error('The --database value must exactly match MONGODB_DB_NAME.');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI must be configured privately.');
  const plan = accountPlan(input, process.env);
  const confirmation = `APPLY ${plan.action} ${plan.email} ${database}`;
  if (await promptTerminal(`Target: ${database}; account: ${plan.email}; action: ${plan.action}.\nType '${confirmation}' to proceed: `) !== confirmation) throw new Error('Maintenance cancelled.');
  let passwordHash;
  if (['create', 'reset-password'].includes(plan.action)) {
    let password = await promptTerminal('New password (hidden): ', true);
    let repeated = await promptTerminal('Confirm new password (hidden): ', true);
    if (password !== repeated) throw new Error('Passwords did not match. No database write attempted.');
    passwordHash = await hashPassword(password);
    password = ''; repeated = '';
  }
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000, writeConcern: { w: 'majority', wtimeoutMS: 5000 } });
  try {
    await client.connect();
    await applyAccountChange(client.db(database).collection('users'), plan, passwordHash);
    process.stdout.write('Account maintenance acknowledged by the database. Existing sessions are invalidated for changes. Verify sign-in separately.\n');
  } finally { passwordHash = ''; await client.close(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('Account maintenance did not complete or was not confirmed. No password or connection detail was logged. Check inputs and database state before retrying.\n'); process.exitCode = 1; });
module.exports = { parseArgs, main };
