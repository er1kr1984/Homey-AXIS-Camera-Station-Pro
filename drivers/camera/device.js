'use strict';

const Homey = require('homey');
const LiveVideo = require('../../lib/live-video');
const { eventAddress } = require('../../lib/events');

const CAPABILITIES = ['alarm_motion', 'alarm_generic', 'acs_recording'];

class CameraDevice extends Homey.Device {

  async onInit() {
    // Devices added by older versions get the newer capabilities.
    for (const cap of CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch((err) => this.homey.app.diagError(`addCapability ${cap}:`, err.message));
    }
    this.registerCapabilityListener('acs_recording', async (on) => {
      try {
        if (on) await this.acs().startRecording(this.getData().id);
        else await this.acs().stopRecording(this.getData().id);
      } catch (err) {
        throw new Error(this.homey.app.friendly(err));
      }
    });
    this.refreshEventAddress().catch((err) => this.homey.app.diagError(`[${this.getName()}] event address:`, err.message));

    this.image = await this.homey.images.createImage();
    this.image.setStream(async (stream) => {
      const jpeg = await this.snapshotJpeg();
      stream.end(jpeg);
    });
    await this.setCameraImage('live', this.homey.__('device.liveTitle'), this.image);

    const device = this;
    this.live = new LiveVideo({
      device: this,
      camera: {
        get name() { return device.getName(); }, // follows renames in Homey
        sourceId: this.getData().id,
        orgId: this.getStore().orgId,
        targetId: this.getStore().targetId,
      },
      getMode: () => this.getSetting('stream_profile') || 'low',
    });
    await this.live.attach('live', this.homey.__('device.liveTitle'));

    this._scheduleSnapshots();
  }

  // The Camera Station server this camera belongs to.
  acs() {
    return this.homey.app.getAcs(this.homey.app.serverIdFor(this.getData().id));
  }

  snapshotJpeg() {
    return this.acs().getSnapshot(this.getData().id);
  }

  // The address Camera Station's action rules call; changes with Homey's IP or a new key.
  async refreshEventAddress() {
    await this.setSettings({ event_address: await eventAddress(this.homey, this.getData().id) });
  }

  // From the public /event endpoint (see app.receiveEvent).
  async onCameraStationEvent(ev) {
    if (ev.motion) {
      await this.setCapabilityValue('alarm_motion', true).catch(() => {});
      if (this.motionTimer) this.homey.clearTimeout(this.motionTimer);
      const seconds = Number(this.getSetting('motion_reset')) || 30;
      this.motionTimer = this.homey.setTimeout(() => {
        this.setCapabilityValue('alarm_motion', false).catch(() => {});
      }, seconds * 1000);
    }
    let snapshot = this.image;
    try {
      snapshot = await this.homey.app.createSnapshotImage(() => this.snapshotJpeg());
    } catch (err) {
      this.homey.app.diagError(`[${this.getName()}] event snapshot:`, err.message);
    }
    await this.driver.cameraEventTrigger.trigger(this, { type: ev.type, time: ev.time, snapshot })
      .catch((err) => this.homey.app.diagError(`[${this.getName()}] event trigger:`, err.message));
  }

  // From the app's status poller: 'ok' | 'unauthenticated' | 'unreachable' | undefined.
  async updateStatus(status) {
    const offline = status !== undefined && status !== 'ok';
    if (this.getCapabilityValue('alarm_generic') !== offline) {
      await this.setCapabilityValue('alarm_generic', offline);
      this.homey.app.diag(`[${this.getName()}] camera ${offline ? `offline (${status})` : 'back online'}`);
    }
    if (!offline) {
      const recording = await this.acs().isRecording(this.getData().id).catch(() => null);
      if (recording !== null && this.getCapabilityValue('acs_recording') !== recording) {
        await this.setCapabilityValue('acs_recording', recording);
      }
    }
  }

  _scheduleSnapshots() {
    if (this.snapshotTimer) this.homey.clearInterval(this.snapshotTimer);
    const minutes = Number(this.getSetting('snapshot_interval'));
    if (!minutes) return;
    this.snapshotTimer = this.homey.setInterval(() => {
      this.image.update().catch((err) => this.homey.app.diagError(`[${this.getName()}] Snapshot update failed:`, err.message));
    }, minutes * 60 * 1000);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('snapshot_interval')) this._scheduleSnapshots();
    // New quality applies to the next viewer; close current streams so it takes effect.
    if (changedKeys.includes('stream_profile')) {
      this.homey.app.forgetLearnedProfile(this.getData().id);
      this._closeStreams();
    }
  }

  // Which Camera Station a Repair updates the login of.
  serverIdForRepair() {
    return this.homey.app.serverIdFor(this.getData().id);
  }

  async onDeleted() {
    this._closeAll();
  }

  async onUninit() {
    this._closeAll();
  }

  _closeStreams() {
    this.live.close();
    if (this.homey.app.relay) this.homey.app.relay.closeCamera(this.getData().id);
  }

  _closeAll() {
    if (this.motionTimer) this.homey.clearTimeout(this.motionTimer);
    if (this.snapshotTimer) this.homey.clearInterval(this.snapshotTimer);
    this._closeStreams();
  }

}

module.exports = CameraDevice;
