'use strict';

module.exports = {
  async getLogs({ homey }) {
    return homey.app.recentLogs;
  },
  async getPreviousLogs({ homey }) {
    return homey.app.previousLogs;
  },
};
