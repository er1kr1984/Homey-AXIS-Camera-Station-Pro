'use strict';

// Server registry against a real Camera Station, with a stand-in for Homey's settings.
// Usage: ACS_HOST=.. ACS_USER=.. ACS_PASS=.. node test/servers.live.js
const assert = require('node:assert');
const ServerRegistry = require('../lib/servers');

const store = {};
const homey = { settings: { get: (k) => store[k], set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); }, unset: (k) => { delete store[k]; } } };

(async () => {
  const changed = [];
  const reg = new ServerRegistry({ homey, log: () => {}, onServerChanged: (id) => changed.push(id) });

  // 1. A 0.1 install's single login moves over.
  Object.assign(store, { acs_host: process.env.ACS_HOST, acs_username: process.env.ACS_USER, acs_password: process.env.ACS_PASS });
  await reg.migrateLegacy();
  const [id] = reg.ids();
  assert.ok(id, 'server added');
  assert.strictEqual(store.acs_host, undefined, 'legacy settings removed');
  assert.ok(store.servers[id].pins[443], 'certificate pinned');
  assert.strictEqual(reg.list()[0].password, undefined, 'list hides the password');
  console.log('migrated:', reg.list()[0].name, reg.list()[0].version);

  // 2. The client works and is shared.
  const cams = await reg.client(id).listCameras();
  assert.ok(cams.length > 0);
  assert.strictEqual(reg.client(id), reg.client(), 'single server is the default');
  console.log('cameras via registry:', cams.length);

  // 3. Same login again changes nothing (no stream reset).
  changed.length = 0;
  await reg.addOrUpdate({ host: process.env.ACS_HOST, username: process.env.ACS_USER, password: process.env.ACS_PASS });
  assert.deepStrictEqual(changed, [], 'unchanged login does not reset streams');

  // 4. Wrong password: clear error, stored login untouched.
  await assert.rejects(reg.addOrUpdate({ host: process.env.ACS_HOST, username: process.env.ACS_USER, password: 'wrong' }), (e) => e.code === 'login_failed');
  assert.strictEqual(store.servers[id].password, process.env.ACS_PASS);

  // 5. A different certificate is refused.
  store.servers[id].pins = { 443: 'AA:BB', 29204: 'AA:BB' };
  reg.clients.clear();
  await assert.rejects(reg.client(id).getSystem(), (e) => e.code === 'cert_changed');
  // ...until the user trusts it again.
  await reg.retrust(id);
  reg.clients.clear();
  assert.ok((await reg.client(id).getSystem()).Id === id);
  console.log('PASS');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
