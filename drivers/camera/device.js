'use strict';

const Homey = require('homey');
const LiveVideo = require('../../lib/live-video');

class CameraDevice extends Homey.Device {

  async onInit() {
    this.image = await this.homey.images.createImage();
    this.image.setStream(async (stream) => {
      const jpeg = await this.homey.app.getAcs().getSnapshot(this.getData().id);
      stream.end(jpeg);
    });
    await this.setCameraImage('live', this.homey.__('device.liveTitle'), this.image);

    this.live = new LiveVideo({
      device: this,
      camera: {
        name: this.getName(),
        sourceId: this.getData().id,
        orgId: this.getStore().orgId,
        targetId: this.getStore().targetId,
      },
      getMode: () => this.getSetting('stream_profile') || 'low',
    });
    await this.live.attach('live', this.homey.__('device.liveTitle'));

    this._scheduleSnapshots();
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
    if (this.snapshotTimer) this.homey.clearInterval(this.snapshotTimer);
    this._closeStreams();
  }

}

module.exports = CameraDevice;
