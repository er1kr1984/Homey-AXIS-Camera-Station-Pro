'use strict';

const Homey = require('homey');
const AcsClient = require('./lib/acs-client');
const { applyWeriftTuning } = require('./lib/werift-tuning');

const tuningFailures = applyWeriftTuning();
const LiveRelay = require('./lib/live-relay');
const events = require('./lib/events');

const STATUS_POLL_MS = 60 * 1000;
const MAX_SNAPSHOT_IMAGES = 30;

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
    this.snapshotImages = [];
    this._registerFlowCards();
    this._registerWidget();
    this.statusTimer = this.homey.setInterval(() => this.pollStatus(), STATUS_POLL_MS);
    this.homey.setTimeout(() => this.pollStatus(), 10000);
    this.diag('Camera Station Live started');
    if (tuningFailures.length) this.diagError('Running without some speed-ups:', tuningFailures.join('; '));
  }

  _registerWidget() {
    const widget = this.homey.dashboards.getWidget('live');
    widget.registerSettingAutocompleteListener('source', async (query) => {
      const q = (query || '').toLowerCase();
      const items = [];
      for (const d of this.homey.drivers.getDriver('view').getDevices()) {
        items.push({ name: d.getName(), description: this.homey.__('widget.view'), kind: 'view', id: d.getData().id });
      }
      for (const d of this.homey.drivers.getDriver('camera').getDevices()) {
        items.push({ name: d.getName(), description: this.homey.__('widget.camera'), kind: 'camera', id: d.getData().id });
      }
      return items.filter((i) => i.name.toLowerCase().includes(q));
    });
  }

  // Grid for the live widget: the view's layout (only the used part), or one tile for a camera.
  async widgetLayout(source) {
    if (!source || !source.id) throw new Error(this.homey.__('widget.pickSource'));
    if (source.kind === 'camera') {
      const device = this.homey.drivers.getDriver('camera').getDevices().find((d) => d.getData().id === source.id);
      if (!device) throw new Error(this.homey.__('widget.missing'));
      return { rows: 1, columns: 1, tiles: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 1, sourceId: source.id, name: device.getName() }] };
    }
    const device = this.homey.drivers.getDriver('view').getDevices().find((d) => d.getData().id === source.id);
    const layout = device && device.getStoreValue('layout');
    if (!layout) throw new Error(this.homey.__('widget.missing'));
    let rows = 1;
    let columns = 1;
    for (const t of layout.tiles) {
      rows = Math.max(rows, t.row + t.rowSpan);
      columns = Math.max(columns, t.column + t.columnSpan);
    }
    return {
      rows,
      columns,
      tiles: layout.tiles.map((t) => ({
        row: t.row, column: t.column, rowSpan: t.rowSpan, columnSpan: t.columnSpan, sourceId: t.camera.sourceId, name: t.camera.name,
      })),
    };
  }

  // One tile's WebRTC offer from the widget -> answer, through the shared relay.
  async widgetOffer({ source, sourceId, sdp, quality }) {
    const camera = this._findCamera(source, sourceId);
    if (!camera) throw new Error(this.homey.__('widget.missing'));
    const mode = ['low', 'medium', 'auto'].includes(quality) ? quality : 'low';
    this.diag(`[${camera.name}] widget viewer offer (${mode})`);
    const { answerSdp } = await this.getRelay().openViewer({
      camera,
      mode,
      startProfile: 'low',
      viewerOfferSdp: sdp,
    });
    return { answerSdp };
  }

  // Camera details for a source id, from a camera device or a view's layout.
  _findCamera(source, sourceId) {
    const cam = this.homey.drivers.getDriver('camera').getDevices().find((d) => d.getData().id === sourceId);
    if (cam) {
      return {
        name: cam.getName(), sourceId, orgId: cam.getStore().orgId, targetId: cam.getStore().targetId,
      };
    }
    for (const view of this.homey.drivers.getDriver('view').getDevices()) {
      const tile = ((view.getStoreValue('layout') || {}).tiles || []).find((t) => t.camera.sourceId === sourceId);
      if (tile) return tile.camera;
    }
    return null;
  }

  _registerFlowCards() {
    this.eventTrigger = this.homey.flow.getTriggerCard('acs_event');
    const triggerAction = (id, action) => this.homey.flow.getActionCard(id).registerRunListener(async (args) => {
      await this.getAcs().trigger(action, args.trigger, args.seconds);
    });
    triggerAction('acs_trigger_activate', 'activate');
    triggerAction('acs_trigger_deactivate', 'deactivate');
    triggerAction('acs_trigger_pulse', 'pulse');
    triggerAction('acs_trigger_for', 'activateFor');
  }

  // Called by the public /event endpoint (api.js).
  async receiveEvent(query, body) {
    const ev = events.parseEvent(query, body);
    if (!events.sameSecret(ev.key, events.getSecret(this.homey))) {
      this.diagError('event: rejected request with a wrong or missing key');
      throw new Error('Unauthorized');
    }
    this.diag(`event: ${ev.type} from ${ev.source || ev.cameraId || 'unknown source'}`);
    const device = ev.cameraId && this.homey.drivers.getDriver('camera').getDevices()
      .find((d) => d.getData().id === ev.cameraId);
    const source = ev.source || (device && device.getName()) || ev.cameraId;
    await this.eventTrigger.trigger({
      type: ev.type, source, source_id: ev.cameraId, time: ev.time,
    }).catch((err) => this.diagError('event trigger failed:', err.message));
    if (device) await device.onCameraStationEvent(ev);
    return { ok: true };
  }

  // A picture frozen at this moment (unlike the device image, which is fetched when viewed).
  // Old ones are released so they don't pile up.
  async createSnapshotImage(getJpeg) {
    const jpeg = await getJpeg();
    const image = await this.homey.images.createImage();
    image.setStream(async (stream) => {
      stream.end(jpeg);
    });
    this.snapshotImages.push(image);
    while (this.snapshotImages.length > MAX_SNAPSHOT_IMAGES) {
      this.snapshotImages.shift().unregister().catch(() => {});
    }
    return image;
  }

  // Camera online/offline and manual recording status for all camera devices.
  async pollStatus() {
    const devices = this.homey.drivers.getDriver('camera').getDevices();
    if (!devices.length || !this.homey.settings.get('acs_host')) return;
    try {
      const acs = this.getAcs();
      const statuses = await acs.getCameraStatuses();
      for (const device of devices) {
        await device.updateStatus(statuses[device.getData().id]).catch(() => {});
      }
      this._statusErrorLogged = false;
    } catch (err) {
      if (!this._statusErrorLogged) this.diagError('status check failed:', err.message);
      this._statusErrorLogged = true;
    }
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
    if (!this.relay) {
      this.relay = new LiveRelay({
        acs: this.getAcs(),
        log: (...args) => this.diag(...args),
        onProfileLearned: (sourceId, profile) => this._rememberProfile(sourceId, profile),
      });
    }
    return this.relay;
  }

  // Camera Station's quality profiles per camera, refreshed hourly.
  async getCameraProfiles() {
    if (!this.profiles || Date.now() - this.profilesAt > 60 * 60 * 1000) {
      this.profiles = await this.getAcs().getCameraProfiles();
      this.profilesAt = Date.now();
    }
    return this.profiles;
  }

  // Auto quality stepped down for a camera: start there next time (shared by camera
  // and view devices).
  _rememberProfile(sourceId, profile) {
    const learned = this.homey.settings.get('auto_profiles') || {};
    learned[sourceId] = { profile, at: Date.now() };
    this.homey.settings.set('auto_profiles', learned);
    this.diag(`[${sourceId}] Auto quality will start at ${profile} from now on`);
  }

  getLearnedProfile(sourceId) {
    return (this.homey.settings.get('auto_profiles') || {})[sourceId] || null;
  }

  forgetLearnedProfile(sourceId) {
    const learned = this.homey.settings.get('auto_profiles') || {};
    delete learned[sourceId];
    this.homey.settings.set('auto_profiles', learned);
  }

  resetConnection() {
    if (this.relay) this.relay.closeAll();
    this.relay = null;
    this.acs = null;
    this.profiles = null;
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
