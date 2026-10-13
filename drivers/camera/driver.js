'use strict';

const Homey = require('homey');
const { discoverAcs, probe } = require('../../lib/discover');

class CameraDriver extends Homey.Driver {

  async onPair(session) {
    this._loginHandler(session);
    session.setHandler('list_devices', async () => {
      this.homey.app.diag('pair: listing cameras');
      let cameras;
      try {
        cameras = await this.homey.app.getAcs().listCameras();
      } catch (err) {
        this.homey.app.diagError('pair: listing cameras failed:', err.stack || err.message);
        throw err;
      }
      this.homey.app.diag(`pair: found ${cameras.length} cameras`);
      const added = new Set(this.getDevices().map((d) => d.getData().id));
      return cameras
        .filter((c) => !added.has(c.sourceId))
        .map((c) => ({
          name: c.name,
          data: { id: c.sourceId },
          store: { orgId: c.orgId, targetId: c.targetId },
        }));
    });
  }

  async onRepair(session) {
    this._loginHandler(session);
  }

  _loginHandler(session) {
    session.setHandler('showView', async (viewId) => this.homey.app.diag(`pair: showing view ${viewId}`));
    session.setHandler('login', async ({ username, password }) => {
      const host = await this._findServer();
      try {
        await this.homey.app.saveLogin({ host, username, password });
      } catch (err) {
        this.homey.app.diagError('pair: login failed:', err.message);
        throw new Error(this.homey.__('pair.loginFailed'));
      }
      this.homey.app.diag(`pair: logged in to ${host}`);
      return true;
    });
  }

  // Uses the saved server if it still answers, otherwise searches the local network.
  async _findServer() {
    const saved = this.homey.settings.get('acs_host');
    if (saved && await probe(saved, 3000)) return saved;
    const local = await this.homey.cloud.getLocalAddress();
    this.homey.app.diag(`pair: searching for Camera Station near ${local}`);
    const found = await discoverAcs(local.split(':')[0]);
    this.homey.app.diag(`pair: found servers: ${found.join(', ') || 'none'}`);
    if (!found.length) throw new Error(this.homey.__('pair.noServer'));
    return found[0];
  }

}

module.exports = CameraDriver;
