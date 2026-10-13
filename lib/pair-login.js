'use strict';

// Login step shared by the camera and view drivers (Homey's login_credentials template).
// The Camera Station server is found automatically: the saved one if it still answers,
// otherwise a search of the local network.

const { discoverAcs, probe } = require('./discover');

async function findServer(homey) {
  const saved = homey.settings.get('acs_host');
  if (saved && await probe(saved, 3000)) return saved;
  const local = await homey.cloud.getLocalAddress();
  homey.app.diag(`pair: searching for Camera Station near ${local}`);
  const found = await discoverAcs(local.split(':')[0]);
  homey.app.diag(`pair: found servers: ${found.join(', ') || 'none'}`);
  if (!found.length) throw new Error(homey.__('pair.noServer'));
  return found[0];
}

function registerLogin(driver, session) {
  const { homey } = driver;
  session.setHandler('showView', async (viewId) => homey.app.diag(`pair: showing view ${viewId}`));
  session.setHandler('login', async ({ username, password }) => {
    const host = await findServer(homey);
    try {
      await homey.app.saveLogin({ host, username, password });
    } catch (err) {
      homey.app.diagError('pair: login failed:', err.message);
      throw new Error(homey.__('pair.loginFailed'));
    }
    homey.app.diag(`pair: logged in to ${host}`);
    return true;
  });
}

module.exports = { registerLogin };
