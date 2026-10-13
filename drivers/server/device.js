'use strict';

const Homey = require('homey');

const POLL_MS = 60 * 1000;
const FIRST_LOOK_BACK_MS = 30 * 60 * 1000; // on start, look at the last 30 minutes (no flows)
const RECORDING_PROBLEMS = ['RecordingFailure', 'RecordingFailCameraAccess'];
const DISK_PROBLEMS = ['DiskError', 'DiskWarning'];

// Health of the Camera Station server, from its event log and camera list.
class ServerDevice extends Homey.Device {

  async onInit() {
    this.seen = new Set(); // event keys already handled (the log's time filter is inclusive)
    this.lastDiskProblem = 0;
    this.lastRecordingProblem = 0;
    this.lastTriggered = new Map(); // "type|camera" -> ms, to hold back repeats
    this.cursor = null;
    this._refreshInfo().catch((err) => this.homey.app.diagError('[server] info:', err.message));
    this.homey.setTimeout(() => this.poll(), 5000);
    this.timer = this.homey.setInterval(() => this.poll(), POLL_MS);
  }

  async _refreshInfo() {
    const system = await this.homey.app.getAcs(this.getData().id).getSystem();
    await this.setSettings({
      server_name: system.Name || '',
      server_version: system.ServerDisplayVersion || '',
      server_hardware: [system.Hardware && system.Hardware.Vendor, system.Hardware && system.Hardware.ModelName].filter(Boolean).join(' '),
    });
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const acs = this.homey.app.getAcs(this.getData().id);
      const statuses = await acs.getCameraStatuses();
      await this.setCapabilityValue('acs_cameras_offline', Object.values(statuses).filter((s) => s !== 'ok').length);

      const firstRun = this.cursor === null;
      const since = firstRun ? new Date(Date.now() - FIRST_LOOK_BACK_MS) : this.cursor;
      const events = await acs.getEventLog(since);
      for (const ev of events) {
        if (this.seen.has(ev.key)) continue;
        this.seen.add(ev.key);
        await this._handle(ev, !firstRun);
      }
      if (events.length) this.cursor = events[events.length - 1].time;
      else if (firstRun) this.cursor = since;
      if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-1000));

      await this._updateAlarms();
      await this.setAvailable();
      this.pollErrorLogged = false;
    } catch (err) {
      if (!this.pollErrorLogged) this.homey.app.diagError('[server] poll failed:', err.message);
      this.pollErrorLogged = true;
      await this.setUnavailable(this.homey.app.friendly(err)).catch(() => {});
    } finally {
      this.polling = false;
    }
  }

  _label(type) {
    const text = this.homey.__(`server.${type}`);
    return text && !text.startsWith('server.') ? text : type;
  }

  // Runs flows for a problem at most once per "repeat_minutes" per type and camera/disk.
  _shouldTrigger(type, subject) {
    const key = `${type}|${subject}`;
    const now = Date.now();
    const repeatMs = (Number(this.getSetting('repeat_minutes')) || 60) * 60 * 1000;
    if (now - (this.lastTriggered.get(key) || 0) < repeatMs) return false;
    this.lastTriggered.set(key, now);
    return true;
  }

  async _handle(ev, triggerFlows) {
    const time = ev.time.toISOString().replace('T', ' ').slice(0, 16);
    const label = this._label(ev.type);
    const driver = this.driver;
    const run = (card, tokens) => card.trigger(this, tokens).catch((err) => this.homey.app.diagError('[server] trigger:', err.message));

    if (RECORDING_PROBLEMS.includes(ev.type)) {
      this.lastRecordingProblem = Math.max(this.lastRecordingProblem, ev.time.getTime());
      const description = `${label}: ${ev.name}`;
      await this.setCapabilityValue('acs_last_problem', `${time} ${description}`).catch(() => {});
      if (triggerFlows && this._shouldTrigger(ev.type, ev.cameraId)) {
        this.homey.app.diag(`[server] ${description}`);
        await run(driver.problemTrigger, { problem: label, description, camera: ev.name, time });
        await run(driver.recordingFailedTrigger, { camera: ev.name, reason: label, time });
      }
    } else if (DISK_PROBLEMS.includes(ev.type)) {
      this.lastDiskProblem = Math.max(this.lastDiskProblem, ev.time.getTime());
      const where = ev.diskPath || ev.path;
      const description = `${label}${where ? `: ${where}` : ''}`;
      await this.setCapabilityValue('acs_last_problem', `${time} ${description}`).catch(() => {});
      if (triggerFlows && this._shouldTrigger(ev.type, where)) {
        this.homey.app.diag(`[server] ${description}`);
        await run(driver.problemTrigger, { problem: label, description, camera: '', time });
        await run(driver.diskProblemTrigger, { problem: label, path: where, time });
      }
    } else if (ev.type === 'CameraStatusDown' || ev.type === 'CameraStatusUp') {
      if (triggerFlows) {
        this.homey.app.diag(`[server] ${label}: ${ev.name}`);
        await run(driver.cameraStatusTrigger, { camera: ev.name, online: ev.type === 'CameraStatusUp', time });
      }
    }
  }

  async _updateAlarms() {
    const windowMs = (Number(this.getSetting('alarm_minutes')) || 30) * 60 * 1000;
    const now = Date.now();
    const disk = now - this.lastDiskProblem < windowMs;
    const recording = now - this.lastRecordingProblem < windowMs;
    if (this.getCapabilityValue('alarm_generic.disk') !== disk) await this.setCapabilityValue('alarm_generic.disk', disk);
    if (this.getCapabilityValue('alarm_generic.recording') !== recording) await this.setCapabilityValue('alarm_generic.recording', recording);
    if (!disk && !recording && this.getCapabilityValue('acs_last_problem') === null) {
      await this.setCapabilityValue('acs_last_problem', this.homey.__('server.none')).catch(() => {});
    }
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('alarm_minutes')) this.homey.setTimeout(() => this._updateAlarms().catch(() => {}), 100);
  }

  // Which Camera Station a Repair updates the login of.
  serverIdForRepair() {
    return this.getData().id;
  }

  async onDeleted() {
    this.homey.clearInterval(this.timer);
  }

  async onUninit() {
    this.homey.clearInterval(this.timer);
  }

}

module.exports = ServerDevice;
