'use strict';

const Homey = require('homey');
const { registerLogin } = require('../../lib/pair-login');

class CameraDriver extends Homey.Driver {

  async onPair(session) {
    registerLogin(this, session);
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
    registerLogin(this, session);
  }

}

module.exports = CameraDriver;
