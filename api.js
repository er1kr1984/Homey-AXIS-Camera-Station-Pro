'use strict';

module.exports = {
  async getLogs({ homey }) {
    return homey.app.recentLogs;
  },
};
