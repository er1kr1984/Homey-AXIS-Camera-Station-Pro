'use strict';

const Homey = require('homey');
const { registerLogin } = require('../../lib/pair-login');

class CameraDriver extends Homey.Driver {

  async onInit() {
    const { flow } = this.homey;
    const acs = () => this.homey.app.getAcs();
    const id = (device) => device.getData().id;

    this.cameraEventTrigger = flow.getDeviceTriggerCard('camera_event');

    flow.getConditionCard('is_recording').registerRunListener(async ({ device }) => acs().isRecording(id(device)));
    flow.getConditionCard('is_online').registerRunListener(async ({ device }) => {
      const statuses = await acs().getCameraStatuses();
      return statuses[id(device)] === 'ok';
    });

    flow.getActionCard('take_snapshot').registerRunListener(async ({ device }) => ({
      snapshot: await this.homey.app.createSnapshotImage(() => device.snapshotJpeg()),
    }));
    flow.getActionCard('start_recording').registerRunListener(async ({ device }) => {
      await acs().startRecording(id(device));
      await device.setCapabilityValue('acs_recording', true).catch(() => {});
    });
    flow.getActionCard('stop_recording').registerRunListener(async ({ device }) => {
      await acs().stopRecording(id(device));
      await device.setCapabilityValue('acs_recording', false).catch(() => {});
    });
    flow.getActionCard('add_bookmark').registerRunListener(async ({ device, name, description }) => {
      await acs().addBookmark(id(device), name || 'Homey', description);
    });

    const preset = flow.getActionCard('goto_preset');
    preset.registerArgumentAutocompleteListener('preset', async (query, { device }) => {
      let presets;
      try {
        presets = await acs().getPtzPresets(id(device));
      } catch (err) {
        throw new Error(this.homey.__('errors.noPtz'));
      }
      const q = (query || '').toLowerCase();
      return presets
        .filter((p) => p.name.toLowerCase().includes(q))
        .map((p) => ({ name: p.name, id: p.id }));
    });
    preset.registerRunListener(async ({ device, preset: chosen }) => {
      await acs().gotoPtzPreset(id(device), chosen.id);
    });
  }

  async onPair(session) {
    registerLogin(this, session);
    session.setHandler('list_devices', async () => {
      this.homey.app.diag('pair: listing cameras');
      let cameras;
      try {
        cameras = await this.homey.app.getAcs().listCameras();
      } catch (err) {
        this.homey.app.diagError('pair: listing cameras failed:', err.stack || err.message);
        throw err;
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

  async onRepair(session) {
    registerLogin(this, session);
  }

}

module.exports = CameraDriver;
