'use strict';

const Homey = require('homey');
const { registerLogin } = require('../../lib/pair-login');

class ServerDriver extends Homey.Driver {

  async onInit() {
    const { flow } = this.homey;
    this.problemTrigger = flow.getDeviceTriggerCard('server_problem');
    this.recordingFailedTrigger = flow.getDeviceTriggerCard('recording_failed');
    this.diskProblemTrigger = flow.getDeviceTriggerCard('disk_problem');
    this.cameraStatusTrigger = flow.getDeviceTriggerCard('camera_status_changed');
    flow.getConditionCard('has_problem').registerRunListener(async ({ device }) => (
      !!device.getCapabilityValue('alarm_generic.disk') || !!device.getCapabilityValue('alarm_generic.recording')
    ));
  }

  async onPair(session) {
    registerLogin(this, session);
    session.setHandler('list_devices', async () => {
      const added = new Set(this.getDevices().map((d) => d.getData().id));
      return this.homey.app.servers.list()
        .filter((s) => !added.has(s.id))
        .map((s) => ({ name: s.name || s.host, data: { id: s.id } }));
    });
  }

  async onRepair(session, device) {
    registerLogin(this, session, device);
  }

}

module.exports = ServerDriver;
