'use strict';

const Homey = require('homey');
const { registerLogin } = require('../../lib/pair-login');

class ViewDriver extends Homey.Driver {

  async onPair(session) {
    registerLogin(this, session);
    session.setHandler('list_devices', async () => {
      this.homey.app.diag('pair: listing views');
      const views = await this.homey.app.getAcs().listViews();
      this.homey.app.diag(`pair: found ${views.length} views`);
      const added = new Set(this.getDevices().map((d) => d.getData().id));
      return views
        .filter((v) => !added.has(v.id))
        .map((v) => ({
          name: v.name,
          data: { id: v.id },
          store: { layout: v },
        }));
    });
  }

  async onRepair(session) {
    registerLogin(this, session);
  }

}

module.exports = ViewDriver;
