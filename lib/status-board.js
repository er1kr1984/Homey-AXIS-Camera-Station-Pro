'use strict';

// Data for the "Camera Station status" dashboard widget: per server, every camera with its
// online state, whether it is recording (motion or schedule), manual recording and its last
// activity, plus the server's health and latest events. Shared by all open widgets and
// refreshed at most every 15 s, so several dashboards don't multiply the calls to Camera Station.

const CACHE_MS = 15000;
const CAMERA_LIST_MS = 5 * 60 * 1000; // camera names rarely change
const EVENT_HOURS = 24;
const MAX_EVENTS = 8;

// Event log types shown in the widget, in the words of locales/*.json "status.events".
const SHOWN_EVENTS = [
  'RecordingStarted', 'RecordingFailure', 'RecordingFailCameraAccess',
  'DiskError', 'DiskWarning', 'CameraStatusDown', 'CameraStatusUp',
];
const PROBLEM_EVENTS = ['RecordingFailure', 'RecordingFailCameraAccess', 'DiskError', 'DiskWarning', 'CameraStatusDown'];

class StatusBoard {
  constructor({ app }) {
    this.app = app;
    this.cache = null;
    this.pending = null;
    this.cameraLists = new Map(); // server id -> { at, cameras }
  }

  async get() {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.data;
    if (!this.pending) {
      this.pending = this._load()
        .then((data) => { this.cache = { at: Date.now(), data }; return data; })
        .finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  // Start or stop manual recording on any camera, also one that isn't a Homey device.
  async setRecording(sourceId, on) {
    const acs = this.app.getAcs(this.app.serverIdFor(sourceId));
    if (on) await acs.startRecording(sourceId);
    else await acs.stopRecording(sourceId);
    const device = this.app.homey.drivers.getDriver('camera').getDevices().find((d) => d.getData().id === sourceId);
    if (device) await device.setCapabilityValue('acs_recording', !!on).catch(() => {});
    this.cache = null;
    return { recording: !!on };
  }

  async _cameras(serverId, acs) {
    const cached = this.cameraLists.get(serverId);
    if (cached && Date.now() - cached.at < CAMERA_LIST_MS) return cached.cameras;
    const cameras = await acs.listCameras();
    this.cameraLists.set(serverId, { at: Date.now(), cameras });
    return cameras;
  }

  async _load() {
    const servers = [];
    for (const entry of this.app.servers.list()) {
      servers.push(await this._loadServer(entry).catch((err) => ({
        id: entry.id, name: entry.name || entry.host, error: this.app.friendly(err), cameras: [], events: [],
      })));
    }
    return { servers, updated: new Date().toISOString() };
  }

  async _loadServer(entry) {
    const acs = this.app.getAcs(entry.id);
    const [cameras, statuses, events] = await Promise.all([
      this._cameras(entry.id, acs),
      acs.getCameraStatuses(),
      acs.getEventLog(new Date(Date.now() - EVENT_HOURS * 3600 * 1000), 400).catch(() => []),
    ]);
    // Oldest first: the last start/stop per camera tells whether it is recording now.
    const recordingNow = {};
    const lastActivity = {};
    for (const ev of events) {
      if (ev.type === 'RecordingStarted') {
        recordingNow[ev.cameraId] = true;
        lastActivity[ev.cameraId] = ev.time.toISOString();
      } else if (ev.type === 'RecordingStopped') {
        recordingNow[ev.cameraId] = false;
      }
    }
    const manual = {};
    await Promise.all(cameras.map(async (c) => {
      if (statuses[c.sourceId] !== 'ok') return;
      manual[c.sourceId] = await acs.isRecording(c.sourceId).catch(() => null);
    }));
    const homeyCameras = new Set(this.app.homey.drivers.getDriver('camera').getDevices().map((d) => d.getData().id));
    const list = cameras.map((c) => ({
      id: c.sourceId,
      name: this.app._cameraName(c.sourceId) || c.name,
      online: statuses[c.sourceId] === 'ok',
      status: statuses[c.sourceId] || 'unknown',
      recording: !!recordingNow[c.sourceId],
      manual: manual[c.sourceId] === true,
      lastActivity: lastActivity[c.sourceId] || null,
      inHomey: homeyCameras.has(c.sourceId),
    }));
    // Offline cameras first, then by name.
    list.sort((a, b) => (a.online - b.online) || a.name.localeCompare(b.name));
    const names = Object.fromEntries(list.map((c) => [c.id, c.name]));
    // Back-to-back repeats (a camera that records every minute) become one line with a count.
    const grouped = [];
    for (const e of events) {
      if (!SHOWN_EVENTS.includes(e.type)) continue;
      const last = grouped[grouped.length - 1];
      if (last && last.type === e.type && last.cameraId === e.cameraId && last.diskPath === e.diskPath) {
        last.count += 1;
        last.time = e.time;
      } else grouped.push({ ...e, count: 1 });
    }
    const shown = grouped.slice(-MAX_EVENTS).reverse();
    const hourAgo = Date.now() - 3600 * 1000;
    const recentProblems = events.filter((e) => PROBLEM_EVENTS.includes(e.type) && e.time.getTime() > hourAgo);
    // The server device (when added) holds the alarms with the user's own hold times.
    const device = this.app.homey.drivers.getDriver('server').getDevices().find((d) => d.getData().id === entry.id);
    const health = device ? {
      disk: !!device.getCapabilityValue('alarm_generic.disk'),
      recording: !!device.getCapabilityValue('alarm_generic.recording'),
    } : {
      disk: recentProblems.some((e) => e.type.startsWith('Disk')),
      recording: recentProblems.some((e) => e.type.startsWith('Recording')),
    };
    return {
      id: entry.id,
      name: entry.name || entry.host,
      version: entry.version,
      health,
      online: list.filter((c) => c.online).length,
      total: list.length,
      recordingCount: list.filter((c) => c.recording || c.manual).length,
      cameras: list,
      events: shown.map((e) => ({
        time: e.time.toISOString(), type: e.type, camera: names[e.cameraId] || e.name || '', disk: e.diskPath || '', count: e.count,
      })),
    };
  }
}

module.exports = StatusBoard;
