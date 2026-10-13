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
      const system = await this.homey.app.getAcs().getSystem();
      if (this.getDevices().some((d) => d.getData().id === system.Id)) return [];
      return [{ name: system.Name || 'Camera Station', data: { id: system.Id } }];
    });
  }

  async onRepair(session) {
    registerLogin(this, session);
  }

}

module.exports = ServerDriver;
