'use strict';

const Homey = require('homey');
const { registerLogin } = require('../../lib/pair-login');

class ViewDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getActionCard('take_view_snapshot').registerRunListener(async ({ device }) => ({
      snapshot: await this.homey.app.createSnapshotImage(() => device.gridJpeg()),
    }));
  }

  async onPair(session) {
    registerLogin(this, session);
    session.setHandler('list_devices', async () => {
      this.homey.app.diag('pair: listing views');
      const found = [];
      for (const serverId of this.homey.app.servers.ids()) {
        try {
          const views = await this.homey.app.getAcs(serverId).listViews();
          found.push(...views.map((v) => ({ view: v, serverId })));
        } catch (err) {
          throw new Error(this.homey.app.friendly(err));
        }
      }
      this.homey.app.diag(`pair: found ${found.length} views`);
      const added = new Set(this.getDevices().map((d) => d.getData().id));
      return found
        .filter(({ view }) => !added.has(view.id))
        .map(({ view, serverId }) => ({
          name: view.name,
          data: { id: view.id },
          store: { layout: view, serverId },
        }));
    });
  }

  async onRepair(session, device) {
    registerLogin(this, session, device);
  }

}

module.exports = ViewDriver;
