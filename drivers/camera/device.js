'use strict';

const Homey = require('homey');
const { chooseStartProfile } = require('../../lib/quality');

const MAX_VIEWERS = 4;
const LEARNED_PROFILE_DAYS = 7;

class CameraDevice extends Homey.Device {

  async onInit() {
    this.viewers = new Map();

    this.image = await this.homey.images.createImage();
    this.image.setStream(async (stream) => {
      const jpeg = await this.homey.app.getAcs().getSnapshot(this.getData().id);
      stream.end(jpeg);
    });
    await this.setCameraImage('live', this.homey.__('device.liveTitle'), this.image);

    const video = await this.homey.videos.createVideoWebRTC({ dataChannel: false });
    video.registerOfferListener(async (offerSdp) => this._onOffer(offerSdp));
    video.registerKeepAliveListener(async (streamId) => {
      const viewer = this.viewers.get(streamId);
      if (viewer) viewer.keepAlive();
    });
    await this.setCameraVideo('live', this.homey.__('device.liveTitle'), video);

    this._scheduleSnapshots();
  }

  async _onOffer(offerSdp) {
    const tag = `[${this.getName()}]`;
    this.homey.app.diag(`${tag} Viewer offer received (${this.viewers.size} already watching)`);
    // Drop the oldest viewer rather than piling up sessions.
    if (this.viewers.size >= MAX_VIEWERS) this.viewers.values().next().value.close();
    try {
      const { viewer, answerSdp } = await this.homey.app.getRelay().openViewer({
        camera: {
          name: this.getName(),
          sourceId: this.getData().id,
          orgId: this.getStore().orgId,
          targetId: this.getStore().targetId,
        },
        mode: this.getSetting('stream_profile') || 'auto',
        startProfile: await this._autoStartProfile(),
        viewerOfferSdp: offerSdp,
        onClose: (v) => {
          this.viewers.delete(v.id);
          this.homey.app.diag(`${tag} viewer closed (${this.viewers.size} left)`);
        },
      });
      this.viewers.set(viewer.id, viewer);
      return { answerSdp, streamId: viewer.id };
    } catch (err) {
      this.homey.app.diagError(`${tag} Could not start live video:`, err.message);
      throw new Error(this.homey.__('errors.liveFailed'));
    }
  }

  // Where Auto quality starts: what worked last time, else the camera's largest profile
  // up to 720p at 15 fps.
  async _autoStartProfile() {
    const learned = this.getStoreValue('autoProfile');
    if (learned && Date.now() - learned.at < LEARNED_PROFILE_DAYS * 24 * 60 * 60 * 1000) return learned.profile;
    try {
      const profiles = await this.homey.app.getCameraProfiles();
      return chooseStartProfile(profiles[this.getData().id]);
    } catch (err) {
      this.homey.app.diagError(`[${this.getName()}] Could not read quality profiles:`, err.message);
      return 'medium';
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
      this.unsetStoreValue('autoProfile').catch(() => {});
      this._closeAll();
    }
  }

  async onDeleted() {
    this._closeAll();
  }

  async onUninit() {
    this._closeAll();
  }

  _closeAll() {
    if (this.snapshotTimer) this.homey.clearInterval(this.snapshotTimer);
    for (const viewer of [...this.viewers.values()]) viewer.close();
    if (this.homey.app.relay) this.homey.app.relay.closeCamera(this.getData().id);
  }

}

module.exports = CameraDevice;
