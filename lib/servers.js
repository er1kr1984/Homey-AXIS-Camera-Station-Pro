'use strict';

// The Camera Station servers this Homey knows, stored in the app setting "servers":
//   { <server id>: { id, name, host, port, apiPort, username, password, pins, version, hardware } }
// The server id is Camera Station's own system id; camera and view ids end in it.

const AcsClient = require('./acs-client');
const { fetchFingerprint } = require('./tls-pin');
const { AcsError } = require('./errors');

const KEY = 'servers';

class ServerRegistry {
  constructor({ homey, log = () => {}, onServerChanged = () => {} }) {
    this.homey = homey;
    this.log = log;
    this.onServerChanged = onServerChanged;
    this.clients = new Map();
  }

  _all() {
    return this.homey.settings.get(KEY) || {};
  }

  _save(all) {
    this.homey.settings.set(KEY, all);
  }

  // Without passwords, for lists and the settings page.
  list() {
    return Object.values(this._all()).map(({ password, ...rest }) => rest);
  }

  ids() {
    return Object.keys(this._all());
  }

  get(id) {
    return this._all()[id] || null;
  }

  // The server whose id a camera/source id ends in ("73016_<server id>").
  idForSource(sourceId) {
    const id = String(sourceId || '').split('_')[1];
    return id && this.get(id) ? id : null;
  }

  // One shared client per server; certificates seen for the first time are remembered.
  client(id) {
    if (!id) {
      const ids = this.ids();
      if (ids.length === 1) [id] = ids;
      else if (!ids.length) throw new AcsError('not_configured');
      else throw new AcsError('not_configured', 'Several Camera Station servers; none chosen');
    }
    let client = this.clients.get(id);
    if (client) return client;
    const entry = this.get(id);
    if (!entry) throw new AcsError('not_configured', `Unknown Camera Station ${id}`);
    client = new AcsClient({
      host: entry.host,
      port: entry.port,
      apiPort: entry.apiPort,
      username: entry.username,
      password: entry.password,
      pins: entry.pins || {},
      log: (...args) => this.log(`[${entry.name || entry.host}]`, ...args),
      onNewPin: (port, fp) => {
        const all = this._all();
        if (!all[id]) return;
        all[id].pins = { ...(all[id].pins || {}), [port]: fp };
        this._save(all);
      },
    });
    this.clients.set(id, client);
    return client;
  }

  // Logs in with fresh certificate pins and saves (or updates) the server.
  // Returns the saved entry without its password.
  async addOrUpdate({
    host, port = 443, apiPort = 29204, username, password,
  }) {
    host = String(host || '').trim();
    username = String(username || '').trim();
    port = Number(port) || 443;
    apiPort = Number(apiPort) || 29204;
    if (!host || !username || !password) throw new AcsError('missing_fields');
    // The user is logging in now: trust the certificates this server presents now.
    const pins = { [port]: await fetchFingerprint(host, port) };
    if (apiPort !== port) pins[apiPort] = await fetchFingerprint(host, apiPort);
    else pins[apiPort] = pins[port];
    const client = new AcsClient({
      host, port, apiPort, username, password, pins, log: this.log,
    });
    await client.login();
    const info = await client.checkCompatibility();
    const all = this._all();
    const before = all[info.id];
    all[info.id] = {
      id: info.id,
      name: info.name,
      host,
      port,
      apiPort,
      username,
      password,
      pins,
      version: info.version,
      webClientVersion: info.webClientVersion,
      hardware: info.hardware,
    };
    this._save(all);
    const changed = !before || ['host', 'port', 'apiPort', 'username', 'password'].some((k) => before[k] !== all[info.id][k])
      || JSON.stringify(before.pins) !== JSON.stringify(pins);
    if (changed) {
      this.clients.delete(info.id);
      this.onServerChanged(info.id);
    }
    this.log(`Camera Station ${info.name} (${host}) ${before ? 'updated' : 'added'}, version ${info.version}`);
    const { password: _omit, ...shown } = all[info.id];
    return shown;
  }

  // Trust the certificate the server presents now (e.g. after Camera Station renewed it),
  // after checking the stored login still works with it.
  async retrust(id) {
    const entry = this.get(id);
    if (!entry) throw new AcsError('not_configured');
    return this.addOrUpdate(entry);
  }

  remove(id) {
    const all = this._all();
    if (!all[id]) return;
    delete all[id];
    this._save(all);
    this.clients.delete(id);
    this.onServerChanged(id);
  }

  // Version 0.1 kept one login in acs_host/acs_username/acs_password. Move it over.
  async migrateLegacy() {
    const legacy = ['acs_host', 'acs_username', 'acs_password'];
    const host = this.homey.settings.get('acs_host');
    if (host && !this.ids().length) {
      try {
        await this.addOrUpdate({
          host,
          username: this.homey.settings.get('acs_username'),
          password: this.homey.settings.get('acs_password'),
        });
      } catch (err) {
        this.log('Could not move the saved Camera Station login over:', err.message);
        return; // keep the old login so a later start can try again
      }
    }
    // Once the server list exists, the old copy (with its password) must not stay behind.
    if (this.ids().length) for (const key of legacy) this.homey.settings.unset(key);
  }
}

module.exports = ServerRegistry;
