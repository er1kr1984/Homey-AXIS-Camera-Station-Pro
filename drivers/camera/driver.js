'use strict';

const Homey = require('homey');
const { registerLogin } = require('../../lib/pair-login');

class CameraDriver extends Homey.Driver {

  async onInit() {
    const { flow } = this.homey;
    const id = (device) => device.getData().id;
    const acsOf = (device) => device.acs();
    // Run a Camera Station call; failures become a clear message in the flow's error.
    const call = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        throw new Error(this.homey.app.friendly(err));
      }
    };

    this.cameraEventTrigger = flow.getDeviceTriggerCard('camera_event');

    flow.getConditionCard('is_recording').registerRunListener(async ({ device }) => call(() => acsOf(device).isRecording(id(device))));
    flow.getConditionCard('is_online').registerRunListener(async ({ device }) => call(async () => {
      const statuses = await acsOf(device).getCameraStatuses();
      return statuses[id(device)] === 'ok';
    }));

    flow.getActionCard('take_snapshot').registerRunListener(async ({ device }) => call(async () => ({
      snapshot: await this.homey.app.createSnapshotImage(() => device.snapshotJpeg()),
    })));
    flow.getActionCard('start_recording').registerRunListener(async ({ device }) => call(async () => {
      await acsOf(device).startRecording(id(device));
      await device.setCapabilityValue('acs_recording', true).catch(() => {});
    }));
    flow.getActionCard('stop_recording').registerRunListener(async ({ device }) => call(async () => {
      await acsOf(device).stopRecording(id(device));
      await device.setCapabilityValue('acs_recording', false).catch(() => {});
    }));
    flow.getActionCard('add_bookmark').registerRunListener(async ({ device, name, description }) => call(async () => {
      await acsOf(device).addBookmark(id(device), name || 'Homey', description);
    }));

    const preset = flow.getActionCard('goto_preset');
    preset.registerArgumentAutocompleteListener('preset', async (query, { device }) => {
      let presets;
      try {
        presets = await acsOf(device).getPtzPresets(id(device));
      } catch (err) {
        throw new Error(this.homey.__('errors.noPtz'));
      }
      const q = (query || '').toLowerCase();
      return presets
        .filter((p) => p.name.toLowerCase().includes(q))
        .map((p) => ({ name: p.name, id: p.id }));
    });
    preset.registerRunListener(async ({ device, preset: chosen }) => call(async () => {
      await acsOf(device).gotoPtzPreset(id(device), chosen.id);
    }));
  }

  async onPair(session) {
    registerLogin(this, session);
    session.setHandler('list_devices', async () => {
      this.homey.app.diag('pair: listing cameras');
      const cameras = [];
      for (const serverId of this.homey.app.servers.ids()) {
        try {
          cameras.push(...await this.homey.app.getAcs(serverId).listCameras());
        } catch (err) {
          this.homey.app.diagError('pair: listing cameras failed:', err.message);
          throw new Error(this.homey.app.friendly(err));
        }
      }
      this.homey.app.diag(`pair: found ${cameras.length} cameras`);
      const added = new Set(this.getDevices().map((d) => d.getData().id));
      return cameras
        .filter((c) => !added.has(c.sourceId))
        .map((c) => ({
          name: c.name,
          data: { id: c.sourceId },
          store: { orgId: c.orgId, targetId: c.targetId },
        }));
    });
  }

  async onRepair(session, device) {
    registerLogin(this, session, device);
  }

}

module.exports = CameraDriver;
