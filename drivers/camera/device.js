'use strict';

const Homey = require('homey');
const LiveRelay = require('../../lib/live-relay');

const MAX_VIEWERS = 4;

class CameraDevice extends Homey.Device {

  async onInit() {
    this.relays = new Map();

    this.image = await this.homey.images.createImage();
    this.image.setStream(async (stream) => {
      const jpeg = await this.homey.app.getAcs().getSnapshot(this.getData().id);
      stream.end(jpeg);
    });
    await this.setCameraImage('live', this.homey.__('device.liveTitle'), this.image);

    const video = await this.homey.videos.createVideoWebRTC({ dataChannel: false });
    video.registerOfferListener(async (offerSdp) => this._onOffer(offerSdp));
    video.registerKeepAliveListener(async (streamId) => {
      const relay = this.relays.get(streamId);
      if (relay) relay.keepAlive();
    });
    await this.setCameraVideo('live', this.homey.__('device.liveTitle'), video);

    this._scheduleSnapshots();
  }

  async _onOffer(offerSdp) {
    // Drop the oldest viewer rather than piling up streams on the server.
    if (this.relays.size >= MAX_VIEWERS) this.relays.values().next().value.close();

    this.homey.app.diag(`[${this.getName()}] Viewer offer received (${offerSdp.length} bytes)`);
    const relay = new LiveRelay({
      acs: this.homey.app.getAcs(),
      camera: {
        name: this.getName(),
        sourceId: this.getData().id,
        orgId: this.getStore().orgId,
        targetId: this.getStore().targetId,
      },
      streamProfile: this.getSetting('stream_profile') || 'high',
      log: (...args) => this.homey.app.diag(`[${this.getName()}]`, ...args),
      onClose: (r) => this.relays.delete(r.id),
    });
    this.relays.set(relay.id, relay);
    try {
      const answerSdp = await relay.answer(offerSdp);
      this.setAvailable().catch(() => {});
      return { answerSdp, streamId: relay.id };
    } catch (err) {
      relay.close();
      this.homey.app.diagError(`[${this.getName()}] Could not start live video:`, err.message);
      throw new Error(this.homey.__('errors.liveFailed'));
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
  }

  async onDeleted() {
    this._closeAll();
  }

  async onUninit() {
    this._closeAll();
  }

  _closeAll() {
    if (this.snapshotTimer) this.homey.clearInterval(this.snapshotTimer);
    for (const relay of [...this.relays.values()]) relay.close();
  }

}

module.exports = CameraDevice;
