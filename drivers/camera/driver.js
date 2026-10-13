'use strict';

const Homey = require('homey');

class CameraDriver extends Homey.Driver {

  async onPair(session) {
    this._loginHandlers(session);
    session.setHandler('list_devices', async () => {
      const cameras = await this.homey.app.getAcs().listCameras();
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
    this._loginHandlers(session);
  }

  _loginHandlers(session) {
    session.setHandler('get_login', async () => ({
      host: this.homey.settings.get('acs_host') || '',
      username: this.homey.settings.get('acs_username') || '',
    }));
    session.setHandler('login', async ({ host, username, password }) => {
      if (!host || !username || !password) throw new Error(this.homey.__('pair.missingFields'));
      await this.homey.app.saveLogin({ host, username, password });
      return true;
    });
  }

}

module.exports = CameraDriver;
