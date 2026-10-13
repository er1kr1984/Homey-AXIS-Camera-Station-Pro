'use strict';

// Login step shared by the camera, view and server drivers (Homey's login_credentials
// template asks only for a username and password).
//
// Pairing: the login is tried on the Camera Station servers this Homey already knows; if
// none accepts it, the local network is searched for Camera Station servers and the login
// is tried on each new one. Servers can also be added by address in the app's settings.
// Repair: the login of the device's own server is updated, and its current certificate
// is trusted again.

const { discoverAcs } = require('./discover');
const { classify } = require('./errors');

async function tryLogin(app, host, port, apiPort, username, password, failures) {
  try {
    await app.servers.addOrUpdate({
      host, port, apiPort, username, password,
    });
    return true;
  } catch (err) {
    failures.push(err);
    app.diag(`pair: login on ${host} failed: ${err.message}`);
    return false;
  }
}

// Explains why nothing worked, most useful reason first.
function failureMessage(homey, failures) {
  const codes = failures.map(classify);
  for (const code of ['login_failed', 'no_rights', 'unsupported', 'cert_changed']) {
    if (codes.includes(code)) return homey.app.friendly(failures[codes.indexOf(code)]);
  }
  return homey.__('pair.noServer');
}

async function loginForPairing(homey, { username, password }) {
  const { app } = homey;
  const failures = [];
  let ok = false;
  const known = app.servers.list();
  for (const s of known) {
    if (await tryLogin(app, s.host, s.port, s.apiPort, username, password, failures)) ok = true;
  }
  if (ok) return true;
  const local = await homey.cloud.getLocalAddress();
  app.diag(`pair: searching for Camera Station near ${local}`);
  const knownHosts = new Set(known.map((s) => s.host));
  const found = (await discoverAcs(local.split(':')[0])).filter((h) => !knownHosts.has(h));
  app.diag(`pair: found servers: ${found.join(', ') || 'none'}`);
  for (const host of found) {
    if (await tryLogin(app, host, 443, 29204, username, password, failures)) ok = true;
  }
  if (!ok) throw new Error(failureMessage(homey, failures));
  return true;
}

async function loginForRepair(homey, device, { username, password }) {
  const { app } = homey;
  const serverId = device.serverIdForRepair();
  const entry = app.servers.get(serverId);
  if (!entry) return loginForPairing(homey, { username, password });
  const failures = [];
  if (!await tryLogin(app, entry.host, entry.port, entry.apiPort, username, password, failures)) {
    throw new Error(failureMessage(homey, failures));
  }
  if (device.getAvailable && !device.getAvailable()) await device.setAvailable().catch(() => {});
  return true;
}

function registerLogin(driver, session, device) {
  const { homey } = driver;
  session.setHandler('showView', async (viewId) => homey.app.diag(`pair: showing view ${viewId}`));
  session.setHandler('login', async (credentials) => {
    if (!credentials || !credentials.username || !credentials.password) throw new Error(homey.__('pair.missingFields'));
    return device ? loginForRepair(homey, device, credentials) : loginForPairing(homey, credentials);
  });
}

module.exports = { registerLogin };
