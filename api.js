'use strict';

// Endpoints of the app's settings page (Homey login required) and the public event
// address Camera Station's action rules call (secret key required, see lib/events.js).
module.exports = {
  async getSettingsState({ homey }) {
    return homey.app.settingsState();
  },
  async saveServer({ homey, body }) {
    return homey.app.settingsSaveServer(body);
  },
  async testServer({ homey, params }) {
    return homey.app.settingsTestServer(params.id);
  },
  async trustServer({ homey, params }) {
    return homey.app.settingsTrustServer(params.id);
  },
  async removeServer({ homey, params }) {
    return homey.app.settingsRemoveServer(params.id);
  },
  async setDiagnostics({ homey, body }) {
    return homey.app.settingsSetDiagnostics(body && body.on);
  },
  async newEventKey({ homey }) {
    await homey.app.newEventKey();
    return { ok: true };
  },
  // Only with diagnostics switched on in the app settings.
  async getLogs({ homey }) {
    return homey.app.diagnosticsLogs(false);
  },
  async getPreviousLogs({ homey }) {
    return homey.app.diagnosticsLogs(true);
  },
  // Public: Camera Station action rules call this. Requires the app's secret key.
  async receiveEventGet({ homey, query }) {
    return homey.app.receiveEvent(query, {});
  },
  async receiveEventPost({ homey, query, body }) {
    return homey.app.receiveEvent(query, body);
  },
};
