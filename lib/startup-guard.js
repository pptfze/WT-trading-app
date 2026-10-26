'use strict';
// Only fixed stage names are logged. Never pass driver errors, URIs or secrets.
const STAGES = new Set(['mongo-connect', 'mongo-topology', 'mongo-indexes', 'privacy-policy', 'http-listen']);
function createStartupGuard({ timeoutMS = 60000, log = console.log } = {}) {
  let expired = false, finished = false, current = 'mongo-connect', rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  // Attach a handler even between stages, when no race is awaiting the deadline.
  deadline.catch(() => {});
  const timer = setTimeout(() => { expired = true; rejectDeadline(new Error('Startup deadline exceeded')); }, timeoutMS);
  function active() { if (expired || finished) throw new Error('Startup is no longer active'); }
  return {
    async stage(name, work) {
      active();
      if (!STAGES.has(name)) throw new Error('Invalid startup stage');
      current = name; log('Startup stage: ' + name);
      const result = await Promise.race([Promise.resolve().then(work), deadline]);
      active(); return result;
    },
    get stageName() { return current; },
    get active() { return !expired && !finished; },
    finish() { finished = true; clearTimeout(timer); },
  };
}
async function boundedCleanup(work, timeoutMS = 2000) {
  let timer;
  try {
    await Promise.race([Promise.resolve().then(work).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, timeoutMS); })]);
  } finally { clearTimeout(timer); }
}
module.exports = { createStartupGuard, boundedCleanup };
