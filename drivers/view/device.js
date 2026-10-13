'use strict';

const Homey = require('homey');
const LiveVideo = require('../../lib/live-video');
const { composeGrid, tileSize } = require('../../lib/grid');

const LAYOUT_REFRESH_MS = 60 * 60 * 1000;

// A Camera Station view: a still picture laid out like the view's grid, and one live
// video per camera in the view (Homey shows one at a time).
class ViewDevice extends Homey.Device {

  async onInit() {
    this.lives = [];
    this.layout = this.getStoreValue('layout');
    await this._refreshLayout().catch((err) => this.homey.app.diagError(`[${this.getName()}] Could not read view:`, err.message));
    if (!this.layout) {
      await this.setUnavailable(this.homey.__('errors.viewMissing'));
      return;
    }

    this.image = await this.homey.images.createImage();
    this.image.setStream(async (stream) => stream.end(await this._gridJpeg()));
    await this.setCameraImage('grid', this.getName(), this.image);

    await this._attachVideos();
    this._scheduleSnapshots();
    this.layoutTimer = this.homey.setInterval(() => {
      this._refreshLayout().catch((err) => this.homey.app.diagError(`[${this.getName()}] Could not refresh view:`, err.message));
    }, LAYOUT_REFRESH_MS);
  }

  async _refreshLayout() {
    const views = await this.homey.app.getAcs().listViews();
    const view = views.find((v) => v.id === this.getData().id);
    if (!view) return;
    const changed = JSON.stringify(view.tiles) !== JSON.stringify(this.layout && this.layout.tiles);
    this.layout = view;
    await this.setStoreValue('layout', view);
    if (changed && this.lives.length) {
      this.homey.app.diag(`[${this.getName()}] view changed in Camera Station; updating cameras`);
      await this._attachVideos();
    }
  }

  // The view's cameras, each once, in reading order (top-left first).
  _cameras() {
    const seen = new Set();
    return [...this.layout.tiles]
      .sort((a, b) => a.row - b.row || a.column - b.column)
      .map((t) => t.camera)
      .filter((c) => !seen.has(c.sourceId) && seen.add(c.sourceId));
  }

  async _attachVideos() {
    for (const live of this.lives) live.close();
    this.lives = [];
    const cameras = this._cameras();
    for (let i = 0; i < cameras.length; i++) {
      const live = new LiveVideo({ device: this, camera: cameras[i], getMode: () => this.getSetting('stream_profile') });
      await live.attach(`camera_${i}`, cameras[i].name);
      this.lives.push(live);
    }
    this.homey.app.diag(`[${this.getName()}] ${cameras.length} live cameras: ${cameras.map((c) => c.name).join(', ')}`);
  }

  async _gridJpeg() {
    const acs = this.homey.app.getAcs();
    const snapshots = new Map();
    await Promise.all(this.layout.tiles.map(async (tile) => {
      const size = tileSize(this.layout, tile);
      const jpeg = await acs.getSnapshot(tile.camera.sourceId, size.width, size.height).catch(() => null);
      if (jpeg) snapshots.set(tile.camera.sourceId, jpeg);
    }));
    return composeGrid(this.layout, snapshots);
  }

  _scheduleSnapshots() {
    if (this.snapshotTimer) this.homey.clearInterval(this.snapshotTimer);
    const minutes = Number(this.getSetting('snapshot_interval'));
    if (!minutes) return;
    this.snapshotTimer = this.homey.setInterval(() => {
      this.image.update().catch((err) => this.homey.app.diagError(`[${this.getName()}] Picture update failed:`, err.message));
    }, minutes * 60 * 1000);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('snapshot_interval')) this._scheduleSnapshots();
    if (changedKeys.includes('stream_profile')) {
      for (const live of this.lives) {
        this.homey.app.forgetLearnedProfile(live.camera.sourceId);
        live.close();
        if (this.homey.app.relay) this.homey.app.relay.closeCamera(live.camera.sourceId);
      }
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
    if (this.layoutTimer) this.homey.clearInterval(this.layoutTimer);
    for (const live of this.lives) live.close();
  }

}

module.exports = ViewDevice;
