'use strict';

const Homey = require('homey');
const { composeGrid, tileSize } = require('../../lib/grid');

const LAYOUT_REFRESH_MS = 60 * 60 * 1000;

// A Camera Station view, shown as one picture laid out like the view's grid in Camera
// Station. Homey can't play a combined live video of several cameras (that would need
// re-encoding on Homey), so the picture is refreshed regularly instead.
class ViewDevice extends Homey.Device {

  async onInit() {
    this.layout = this.getStoreValue('layout');
    await this._refreshLayout().catch((err) => this.homey.app.diagError(`[${this.getName()}] Could not read view:`, err.message));
    if (!this.layout) {
      await this.setUnavailable(this.homey.__('errors.viewMissing'));
      return;
    }

    this.image = await this.homey.images.createImage();
    this.image.setStream(async (stream) => stream.end(await this.gridJpeg()));
    await this.setCameraImage('grid', this.getName(), this.image);

    this._scheduleSnapshots();
    this.layoutTimer = this.homey.setInterval(() => {
      this._refreshLayout().catch((err) => this.homey.app.diagError(`[${this.getName()}] Could not refresh view:`, err.message));
    }, LAYOUT_REFRESH_MS);
  }

  async _refreshLayout() {
    const views = await this.homey.app.getAcs().listViews();
    const view = views.find((v) => v.id === this.getData().id);
    if (!view) return;
    const changed = this.image && JSON.stringify(view.tiles) !== JSON.stringify(this.layout && this.layout.tiles);
    this.layout = view;
    await this.setStoreValue('layout', view);
    if (changed) {
      this.homey.app.diag(`[${this.getName()}] view changed in Camera Station; updating picture`);
      await this.image.update();
    }
  }

  async gridJpeg() {
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
  }

}

module.exports = ViewDevice;
