'use strict';

const Homey = require('homey');
const AcsClient = require('./lib/acs-client');

class CameraStationLiveApp extends Homey.App {

  async onInit() {
    this.acs = null;
    this.homey.settings.on('set', (key) => {
      if (key.startsWith('acs_')) this.acs = null;
    });
    this.log('Camera Station Live started');
  }

  // Shared ACS connection for all cameras; rebuilt when the login changes.
  getAcs() {
    if (!this.acs) {
      const host = this.homey.settings.get('acs_host');
      if (!host) throw new Error(this.homey.__('errors.notConfigured'));
      this.acs = new AcsClient({
        host,
        username: this.homey.settings.get('acs_username'),
        password: this.homey.settings.get('acs_password'),
        log: (...args) => this.log(...args),
      });
    }
    return this.acs;
  }

  // Checks a login before saving it. Throws with a readable message on failure.
  async saveLogin({ host, username, password }) {
    const acs = new AcsClient({ host: host.trim(), username: username.trim(), password, log: (...a) => this.log(...a) });
    await acs.login();
    this.homey.settings.set('acs_host', host.trim());
    this.homey.settings.set('acs_username', username.trim());
    this.homey.settings.set('acs_password', password);
    this.acs = acs;
    return acs;
  }

}

module.exports = CameraStationLiveApp;
