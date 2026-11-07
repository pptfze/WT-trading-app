'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
// Filesystem test reference only; production Mongo policy does not use this.
// JSON storage supports exactly one server process per durable volume. A stale
// lock after SIGKILL requires operator inspection; never guess that it is safe.
function acquirePolicyLock(policyFile) {
  const filename = policyFile + '.lock';
  const owner = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
  let fd;
  try {
    fd = fs.openSync(filename, 'wx', 0o600);
    fs.writeFileSync(fd, owner);
    fs.fsyncSync(fd);
  } catch {
    throw new Error('Policy storage is already locked or unavailable. Only one server instance is supported.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  return () => {
    try { if (fs.readFileSync(filename, 'utf8') === owner) fs.unlinkSync(filename); } catch { /* Leave uncertain lock in place. */ }
  };
}
module.exports = { acquirePolicyLock };
