'use strict';
// Optional offline browser check. Requires an already installed Playwright and
// Chromium. Every request is intercepted; provider/network access is forbidden.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const unexpected = [], errors = [], requests = [];
    let failSelection = true;
    let channels = [{ id: 'synthetic-channel', label: 'Synthetic channel', active: false, groups: { '120000000001@g.us': { id: '120000000001@g.us', name: '<img src=x onerror="window.injected=true">', enabled: false, participants: 3 } } }];
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      const endpoint = url.pathname, method = req.method();
      requests.push({ endpoint, method });
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.hostname !== 'app.invalid') { unexpected.push(req.url()); return route.abort(); }
      if (endpoint === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8') });
      if (endpoint === '/vendor/xlsx.full.min.js') return route.fulfill({ contentType: 'text/javascript', body: '// Optional export library not installed in synthetic preview.' });
      if (endpoint === '/api/auth/login') return json({ token: 'synthetic-session-only', user: { name: 'Synthetic operator', email: 'operator@example.invalid', role: 'admin' } });
      if (endpoint === '/health') return json({ status: 'ok', db: 'mongodb', privacyPolicy: 'ready', whatsapp: { enabled: false, configured: false } });
      if (endpoint === '/api/channels' && method === 'GET') return json(channels);
      if (endpoint === '/api/channels/synthetic-channel/groups/120000000001%40g.us' && method === 'PATCH') {
        if (failSelection) return json({ error: 'Synthetic save failure' }, 503);
        channels[0].groups['120000000001@g.us'].enabled = req.postDataJSON().enabled;
        return json({ ok: true });
      }
      if (endpoint === '/api/channels/synthetic-channel/toggle' && method === 'PATCH') { channels[0].active = req.postDataJSON().active; return json({ ok: true, active: channels[0].active }); }
      if (endpoint === '/api/channels/synthetic-channel/groups' && method === 'GET') {
        channels[0].groups['120000000002@g.us'] = { id: '120000000002@g.us', name: 'New synthetic group', enabled: false };
        return json(Object.values(channels[0].groups));
      }
      if (endpoint === '/api/channels/synthetic-channel' && method === 'DELETE') { channels = []; return json({ ok: true }); }
      if (['/api/messages', '/api/team', '/api/alerts', '/api/snapshots'].includes(endpoint)) return json([]);
      unexpected.push(method + ' ' + endpoint); return route.abort();
    });
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => { localStorage.setItem('wa_channels', '[{"id":"old"}]'); localStorage.setItem('wa_whapi', 'synthetic-legacy-token'); localStorage.setItem('wa_token', 'synthetic-old-session'); });
    await page.goto('https://app.invalid/');
    assert.deepEqual(await page.evaluate(() => ['wa_channels', 'wa_whapi', 'wa_token'].map(k => localStorage.getItem(k))), [null, null, null]);
    assert.equal(requests.filter(r => r.endpoint.startsWith('/api/')).length, 0);
    await page.locator('#loginEmail').fill('operator@example.invalid');
    await page.locator('#loginPw').fill('synthetic-password');
    await page.evaluate(() => doLogin());
    await page.locator('[data-tab="channels"]').click();
    const group = page.locator('#channelsList input[type=checkbox]').first();
    await group.waitFor();
    assert.equal(await group.isChecked(), false);
    assert.equal(await page.locator('#channelsList img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await group.check();
    await page.waitForFunction(() => document.getElementById('channelsStatus').textContent.includes('Synthetic save failure'));
    assert.equal(await group.isChecked(), false);
    failSelection = false;
    await group.check();
    await page.waitForFunction(() => document.getElementById('channelsStatus').textContent.includes('is ON'));
    assert.equal(await group.isChecked(), true);
    await page.getByRole('button', { name: 'Activate selection', exact: true }).click();
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Activate selection', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh Groups', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#channelsList input[type=checkbox]').length === 2);
    assert.deepEqual(await page.locator('#channelsList input[type=checkbox]').evaluateAll(nodes => nodes.map(n => n.checked)), [true, false]);
    assert.equal(channels[0].active, false);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('channelsStatus').textContent.includes('Channel removed'));
    await page.locator('#reloadChannelsButton').click();
    assert.equal(channels.length, 0);
    assert.equal(requests.some(r => r.endpoint === '/api/channels' && r.method === 'POST'), false);
    await page.reload();
    assert.equal(await page.locator('#authScreen').isVisible(), true);
    assert.deepEqual(await page.evaluate(() => ['wa_channels', 'wa_whapi', 'wa_token'].map(k => localStorage.getItem(k))), [null, null, null]);
    const before = requests.filter(r => r.endpoint.startsWith('/api/')).length;
    await page.evaluate(() => demoMode());
    assert.equal(requests.filter(r => r.endpoint.startsWith('/api/')).length, before);
    assert.equal(await page.locator('#channelsList input:checked').count(), 0);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    console.log('PASS offline Chromium UI: startup read-only, legacy-secret cleanup, default OFF, safe metadata, failed save rollback, explicit selection, pause, resync/new group OFF, deletion/no recreation, reload login, offline demo. No external requests.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
