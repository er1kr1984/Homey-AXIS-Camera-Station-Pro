'use strict';

const Homey = require('homey');
const AcsClient = require('./lib/acs-client');

class CameraStationLiveApp extends Homey.App {

  async onInit() {
    this.recentLogs = [];
    this.acs = null;
    this.homey.settings.on('set', (key) => {
      if (key.startsWith('acs_')) this.acs = null;
    });
    this.diag('Camera Station Live started');
  }

  // Logs and keeps recent lines so they can be read through the app's API (GET /logs).
  diag(...args) {
    this._remember('', args);
    this.log(...args);
  }

  diagError(...args) {
    this._remember('ERROR ', args);
    this.error(...args);
  }

  _remember(prefix, args) {
    this.recentLogs.push(`${new Date().toISOString()} ${prefix}${args.map(String).join(' ')}`);
    if (this.recentLogs.length > 300) this.recentLogs.shift();
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
        log: (...args) => this.diag(...args),
      });
    }
    return this.acs;
  }

  // Checks a login before saving it. Throws with a readable message on failure.
  async saveLogin({ host, username, password }) {
    const acs = new AcsClient({ host: host.trim(), username: username.trim(), password, log: (...a) => this.diag(...a) });
    await acs.login();
    this.homey.settings.set('acs_host', host.trim());
    this.homey.settings.set('acs_username', username.trim());
    this.homey.settings.set('acs_password', password);
    this.acs = acs;
    return acs;
  }

}

module.exports = CameraStationLiveApp;
