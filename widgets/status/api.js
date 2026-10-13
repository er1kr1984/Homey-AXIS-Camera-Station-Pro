'use strict';

module.exports = {
  // -> { servers: [{ name, health, online, total, cameras, events }], updated }
  async status({ homey }) {
    return homey.app.widgetStatus();
  },
  // body: { sourceId, on } -> { recording }
  async record({ homey, body }) {
    return homey.app.widgetRecord(body || {});
  },
};
