'use strict';

module.exports = {
  async getLogs({ homey }) {
    return homey.app.recentLogs;
  },
  async getPreviousLogs({ homey }) {
    return homey.app.previousLogs;
  },
  // Public: Camera Station action rules call this. Requires the app's secret key.
  async receiveEventGet({ homey, query }) {
    return homey.app.receiveEvent(query, {});
  },
  async receiveEventPost({ homey, query, body }) {
    return homey.app.receiveEvent(query, body);
  },
};
