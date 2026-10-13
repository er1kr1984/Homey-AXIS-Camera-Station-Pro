'use strict';

const Homey = require('homey');
const { applyWeriftTuning } = require('./lib/werift-tuning');

const tuningFailures = applyWeriftTuning();
const LiveRelay = require('./lib/live-relay');
const ServerRegistry = require('./lib/servers');
const events = require('./lib/events');
const { classify } = require('./lib/errors');
const { Mp4LiveSource } = require('./lib/mp4-live');

const STATUS_POLL_MS = 60 * 1000;
const MAX_SNAPSHOT_IMAGES = 30;
const LOG_LINES = 300;
const LOG_PERSIST_MS = 60 * 1000;
const MAX_HTTP_SOURCES = 6; // live MP4 streams for the widget away from home

class CameraStationLiveApp extends Homey.App {

  async onInit() {
    this.recentLogs = [];
    this.logsDirty = false;
    // With diagnostics on, keep the log of a run that crashed so it can be read after the restart.
    const crashed = this.homey.settings.get('diag_running_logs');
    if (crashed && crashed.length) this.homey.settings.set('diag_previous_logs', crashed);
    this.homey.settings.unset('diag_running_logs');
    process.on('uncaughtException', (err) => {
      this.diagError('UNCAUGHT', err && err.stack);
      this._persistLogs(true);
    });
    process.on('unhandledRejection', (err) => {
      this.diagError('UNHANDLED REJECTION', (err && err.stack) || err);
      this._persistLogs(true);
    });
    this.homey.setInterval(() => this._persistLogs(false), LOG_PERSIST_MS);

    if (!this.homey.settings.get('diagnostics')) this.homey.settings.unset('diag_previous_logs');
    this.relay = null;
    this.profiles = new Map(); // server id -> { at, profiles }
    this.servers = new ServerRegistry({
      homey: this.homey,
      log: (...args) => this.diag(...args),
      onServerChanged: (id) => this._serverChanged(id),
    });
    await this.servers.migrateLegacy();
    this.snapshotImages = [];
    this.mp4Sources = new Map(); // "sourceId|quality" -> Mp4LiveSource
    this.lastRejectedLog = 0;
    this._registerFlowCards();
    this._registerWidget();
    this.statusTimer = this.homey.setInterval(() => this.pollStatus(), STATUS_POLL_MS);
    this.homey.setTimeout(() => this.pollStatus(), 10000);
    this.diag(`Camera Station Live started (${this.servers.ids().length} server(s))`);
    if (tuningFailures.length) this.diagError('Running without some speed-ups:', tuningFailures.join('; '));
  }

  // ---- Servers ----

  // ACS client for a server id (or the only server when there is one).
  getAcs(serverId) {
    return this.servers.client(serverId);
  }

  // Server id for a camera/source id ("73016_<server id>").
  serverIdFor(sourceId) {
    return this.servers.idForSource(sourceId) || String(sourceId || '').split('_')[1];
  }

  _serverChanged(serverId) {
    if (this.relay) this.relay.closeServer(serverId);
    if (this.profiles) this.profiles.delete(serverId);
  }

  // A clear, translated message for an error from Camera Station.
  friendly(err) {
    const code = classify(err);
    const key = `errors.${code}`;
    const text = this.homey.__(key);
    return text && text !== key ? text : (err && err.message) || String(err);
  }

  // ---- Live video ----

  // One relay for all cameras of all servers: shares a single ACS stream per camera.
  getRelay() {
    if (!this.relay) {
      this.relay = new LiveRelay({
        getAcs: (camera) => this.getAcs(this.serverIdFor(camera.sourceId)),
        log: (...args) => this.diag(...args),
        onProfileLearned: (sourceId, profile) => this._rememberProfile(sourceId, profile),
        knownBFrames: this.homey.settings.get('bframe_cameras') || [],
        onBFrames: (sourceId) => {
          const known = new Set(this.homey.settings.get('bframe_cameras') || []);
          known.add(sourceId);
          this.homey.settings.set('bframe_cameras', [...known]);
        },
      });
    }
    return this.relay;
  }

  // True while any live stream is running (used to postpone CPU-heavy work).
  isStreaming() {
    return !!(this.relay && [...this.relay.streams.values()].some((s) => !s.closed));
  }

  // Camera Station's quality profiles per camera, refreshed hourly per server.
  async getCameraProfiles(serverId) {
    const cached = this.profiles.get(serverId);
    if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.profiles;
    const profiles = await this.getAcs(serverId).getCameraProfiles();
    this.profiles.set(serverId, { at: Date.now(), profiles });
    return profiles;
  }

  // Auto quality stepped down for a camera: start there next time.
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

  // ---- Dashboard widget ----

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
        row: t.row, column: t.column, rowSpan: t.rowSpan, columnSpan: t.columnSpan, sourceId: t.camera.sourceId, name: this._cameraName(t.camera.sourceId) || t.camera.name,
      })),
    };
  }

  // One tile's WebRTC offer from the widget -> answer, through the shared relay.
  async widgetOffer({ source, sourceId, sdp, quality }) {
    const camera = this._findCamera(source, sourceId);
    if (!camera) throw new Error(this.homey.__('widget.missing'));
    const mode = ['low', 'medium', 'auto'].includes(quality) ? quality : 'low';
    this.diag(`[${camera.name}] widget viewer offer (${mode})`);
    try {
      const { answerSdp } = await this.getRelay().openViewer({
        camera,
        mode,
        startProfile: 'low',
        viewerOfferSdp: sdp,
      });
      return { answerSdp };
    } catch (err) {
      // The widget recognises "too many live streams" and shows pictures instead.
      if (err.code === 'too_many_streams') throw new Error('Too many live streams');
      throw new Error(this.friendly(err));
    }
  }

  // A small picture for a widget tile that can't play live video (e.g. on mobile data,
  // where the phone can't reach Homey directly). Camera Station makes the JPEG; Homey only
  // passes it on, so this is cheap.
  async widgetSnapshot({ source, sourceId }) {
    const camera = this._findCamera(source, sourceId);
    if (!camera) throw new Error(this.homey.__('widget.missing'));
    const jpeg = await this.getAcs(this.serverIdFor(camera.sourceId)).getSnapshot(camera.sourceId, 640, 360);
    return { jpeg: jpeg.toString('base64') };
  }

  // Live video over HTTP for a widget tile that can't connect with WebRTC. The widget asks
  // every half second for what is new since `after`; one Camera Station MP4 stream per
  // camera is shared by all such tiles.
  async widgetMp4({ source, sourceId, after, quality }) {
    const camera = this._findCamera(source, sourceId);
    if (!camera) throw new Error(this.homey.__('widget.missing'));
    const q = quality === 'medium' ? 'medium' : 'low';
    const key = `${camera.sourceId}|${q}`;
    let mp4 = this.mp4Sources.get(key);
    if (!mp4 || mp4.closed) {
      if ([...this.mp4Sources.values()].filter((m) => !m.closed).length >= MAX_HTTP_SOURCES) throw new Error('Too many live streams');
      this.diag(`[${camera.name}] widget video over HTTP (${q})`);
      mp4 = new Mp4LiveSource({
        acs: this.getAcs(this.serverIdFor(camera.sourceId)),
        cameraId: camera.sourceId,
        quality: q,
        log: (...args) => this.diag(`[${camera.name}]`, ...args),
        onClose: (m) => { if (this.mp4Sources.get(key) === m) this.mp4Sources.delete(key); },
      });
      this.mp4Sources.set(key, mp4);
    }
    try {
      return await mp4.read(after === undefined ? null : after);
    } catch (err) {
      throw new Error(this.friendly(err));
    }
  }

  _cameraName(sourceId) {
    const cam = this.homey.drivers.getDriver('camera').getDevices().find((d) => d.getData().id === sourceId);
    return cam ? cam.getName() : null;
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

  // ---- Flow cards ----

  _registerFlowCards() {
    this.eventTrigger = this.homey.flow.getTriggerCard('acs_event');
    const serverAutocomplete = async (query) => {
      const q = (query || '').toLowerCase();
      return this.servers.list()
        .map((s) => ({ name: s.name || s.host, description: s.host, id: s.id }))
        .filter((s) => s.name.toLowerCase().includes(q));
    };
    const triggerAction = (id, action) => {
      const card = this.homey.flow.getActionCard(id);
      card.registerArgumentAutocompleteListener('server', serverAutocomplete);
      card.registerRunListener(async (args) => {
        try {
          await this.getAcs(args.server && args.server.id).trigger(action, args.trigger, args.seconds);
        } catch (err) {
          throw new Error(this.friendly(err));
        }
      });
    };
    triggerAction('acs_trigger_activate', 'activate');
    triggerAction('acs_trigger_deactivate', 'deactivate');
    triggerAction('acs_trigger_pulse', 'pulse');
    triggerAction('acs_trigger_for', 'activateFor');
  }

  // ---- Events from Camera Station (public /event endpoint) ----

  async receiveEvent(query, body) {
    const ev = events.parseEvent(query, body);
    if (!events.sameSecret(ev.key, events.getSecret(this.homey))) {
      // Answer plainly and log at most once a minute: anyone on the network can call this.
      if (Date.now() - this.lastRejectedLog > 60000) {
        this.lastRejectedLog = Date.now();
        this.diagError('event: rejected a request with a wrong or missing key');
      }
      return { ok: false, error: 'unauthorized' };
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

  // A new event key: the old addresses stop working, so Camera Station's action rules need
  // the new addresses (shown in each camera's settings).
  async newEventKey() {
    events.regenerateSecret(this.homey);
    for (const device of this.homey.drivers.getDriver('camera').getDevices()) {
      await device.refreshEventAddress().catch(() => {});
    }
    this.diag('event: made a new event key');
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

  // Camera online/offline and manual recording status for all camera devices, per server.
  async pollStatus() {
    const devices = this.homey.drivers.getDriver('camera').getDevices();
    if (!devices.length) return;
    const byServer = new Map();
    for (const device of devices) {
      const id = this.serverIdFor(device.getData().id);
      if (!byServer.has(id)) byServer.set(id, []);
      byServer.get(id).push(device);
    }
    for (const [serverId, list] of byServer) {
      try {
        const statuses = await this.getAcs(serverId).getCameraStatuses();
        for (const device of list) {
          await device.updateStatus(statuses[device.getData().id]).catch(() => {});
        }
        this.statusErrorLogged = false;
      } catch (err) {
        if (!this.statusErrorLogged) this.diagError('status check failed:', err.message);
        this.statusErrorLogged = true;
      }
    }
  }

  // ---- Settings page API (see api.js) ----

  async settingsState() {
    return {
      servers: this.servers.list(),
      diagnostics: !!this.homey.settings.get('diagnostics'),
      streaming: this.relay ? [...this.relay.streams.values()].filter((s) => !s.closed).length : 0,
    };
  }

  async settingsSaveServer(body) {
    try {
      return await this.servers.addOrUpdate(body || {});
    } catch (err) {
      throw new Error(this.friendly(err));
    }
  }

  async settingsTestServer(id) {
    try {
      const info = await this.getAcs(id).checkCompatibility();
      await this.getAcs(id).getAccessToken();
      return { ok: true, version: info.version };
    } catch (err) {
      throw new Error(this.friendly(err));
    }
  }

  async settingsTrustServer(id) {
    try {
      return await this.servers.retrust(id);
    } catch (err) {
      throw new Error(this.friendly(err));
    }
  }

  async settingsRemoveServer(id) {
    this.servers.remove(id);
    return { ok: true };
  }

  async settingsSetDiagnostics(on) {
    this.homey.settings.set('diagnostics', !!on);
    if (!on) {
      this.homey.settings.unset('diag_previous_logs');
      this.homey.settings.unset('diag_running_logs');
    }
    return { diagnostics: !!on };
  }

  diagnosticsLogs(previous) {
    if (!this.homey.settings.get('diagnostics')) throw new Error(this.homey.__('errors.diagnosticsOff'));
    return previous ? (this.homey.settings.get('diag_previous_logs') || []) : this.recentLogs;
  }

  // ---- Logging ----

  // Keeps recent lines in memory; written to storage only with diagnostics on.
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
    if (this.recentLogs.length > LOG_LINES) this.recentLogs.shift();
    this.logsDirty = true;
  }

  _persistLogs(force) {
    if (!this.homey.settings.get('diagnostics')) return;
    if (!this.logsDirty && !force) return;
    try {
      this.homey.settings.set('diag_running_logs', this.recentLogs.slice(-150));
      this.logsDirty = false;
    } catch (e) { /* ignore */ }
  }

  async onUninit() {
    // A clean stop is not a crash.
    this.homey.settings.unset('diag_running_logs');
    if (this.relay) this.relay.closeAll();
    for (const mp4 of this.mp4Sources.values()) mp4.close('app stopping');
  }

}

module.exports = CameraStationLiveApp;
