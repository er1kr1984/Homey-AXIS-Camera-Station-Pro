'use strict';

const Homey = require('homey');
const AcsClient = require('./lib/acs-client');
const LiveRelay = require('./lib/live-relay');

class CameraStationLiveApp extends Homey.App {

  async onInit() {
    this.recentLogs = [];
    // Keep the log of the run that crashed, so it can be read after the restart.
    const crashed = this.homey.settings.get('diag_running_logs');
    if (crashed && crashed.length) this.homey.settings.set('diag_previous_logs', crashed);
    this.previousLogs = this.homey.settings.get('diag_previous_logs') || [];
    process.on('uncaughtException', (err) => {
      this.diagError('UNCAUGHT', err && err.stack);
      this._persistLogs();
    });
    process.on('unhandledRejection', (err) => {
      this.diagError('UNHANDLED REJECTION', (err && err.stack) || err);
      this._persistLogs();
    });
    this.homey.setInterval(() => this._persistLogs(), 15000);
    this.acs = null;
    this.relay = null;
    this.homey.settings.on('set', (key) => {
      if (key.startsWith('acs_')) this.resetConnection();
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

  _persistLogs() {
    try {
      this.homey.settings.set('diag_running_logs', this.recentLogs.slice(-150));
    } catch (e) { /* ignore */ }
  }

  async onUninit() {
    // A clean stop is not a crash.
    this.homey.settings.unset('diag_running_logs');
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

  // One relay for all cameras: shares a single ACS stream per camera between viewers.
  getRelay() {
    if (!this.relay) this.relay = new LiveRelay({ acs: this.getAcs(), log: (...args) => this.diag(...args) });
    return this.relay;
  }

  resetConnection() {
    if (this.relay) this.relay.closeAll();
    this.relay = null;
    this.acs = null;
  }

  // Checks a login before saving it. Throws with a readable message on failure.
  async saveLogin({ host, username, password }) {
    const acs = new AcsClient({ host: host.trim(), username: username.trim(), password, log: (...a) => this.diag(...a) });
    await acs.login();
    this.homey.settings.set('acs_host', host.trim());
    this.homey.settings.set('acs_username', username.trim());
    this.homey.settings.set('acs_password', password);
    this.resetConnection();
    this.acs = acs;
    return acs;
  }

}

module.exports = CameraStationLiveApp;
