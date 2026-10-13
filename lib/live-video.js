'use strict';

// Attaches a live WebRTC video for one ACS camera to a Homey device.
// Used by camera devices (one video) and view devices (one video per camera in the view).

const { chooseStartProfile } = require('./quality');

const MAX_VIEWERS = 4;
const LEARNED_PROFILE_DAYS = 7;

class LiveVideo {
  // camera: { name, sourceId, orgId, targetId }; getMode(): 'auto' | 'high' | 'medium' | 'low'
  constructor({ device, camera, getMode }) {
    this.device = device;
    this.app = device.homey.app;
    this.camera = camera;
    this.getMode = getMode;
    this.viewers = new Map();
  }

  async attach(videoId, title) {
    const video = await this.device.homey.videos.createVideoWebRTC({ dataChannel: false });
    video.registerOfferListener(async (offerSdp) => this._onOffer(offerSdp));
    video.registerKeepAliveListener(async (streamId) => {
      const viewer = this.viewers.get(streamId);
      if (viewer) viewer.keepAlive();
    });
    await this.device.setCameraVideo(videoId, title, video);
  }

  async _onOffer(offerSdp) {
    const tag = `[${this.camera.name}]`;
    this.app.diag(`${tag} Viewer offer received (${this.viewers.size} already watching)`);
    // Drop the oldest viewer rather than piling up sessions.
    if (this.viewers.size >= MAX_VIEWERS) this.viewers.values().next().value.close();
    try {
      const { viewer, answerSdp } = await this.app.getRelay().openViewer({
        camera: this.camera,
        mode: this.getMode() || 'auto',
        startProfile: await this._autoStartProfile(),
        viewerOfferSdp: offerSdp,
        onClose: (v) => {
          this.viewers.delete(v.id);
          this.app.diag(`${tag} viewer closed (${this.viewers.size} left)`);
        },
      });
      this.viewers.set(viewer.id, viewer);
      return { answerSdp, streamId: viewer.id };
    } catch (err) {
      this.app.diagError(`${tag} Could not start live video:`, err.message);
      const reason = err.code === 'too_many_streams' ? this.device.homey.__('errors.too_many_streams') : this.app.friendly(err);
      throw new Error(reason);
    }
  }

  // Where Auto quality starts: what worked last time, else the camera's largest profile
  // up to 720p at 15 fps.
  async _autoStartProfile() {
    const learned = this.app.getLearnedProfile(this.camera.sourceId);
    if (learned && Date.now() - learned.at < LEARNED_PROFILE_DAYS * 24 * 60 * 60 * 1000) return learned.profile;
    try {
      const profiles = await this.app.getCameraProfiles(this.app.serverIdFor(this.camera.sourceId));
      return chooseStartProfile(profiles[this.camera.sourceId]);
    } catch (err) {
      this.app.diagError(`[${this.camera.name}] Could not read quality profiles:`, err.message);
      return 'medium';
    }
  }

  close() {
    for (const viewer of [...this.viewers.values()]) viewer.close();
  }
}

module.exports = LiveVideo;
