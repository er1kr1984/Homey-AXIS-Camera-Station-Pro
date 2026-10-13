'use strict';

module.exports = {
  // body: { source } (the widget's "View or camera" setting) -> { columns, rows, tiles }
  async getLayout({ homey, body }) {
    return homey.app.widgetLayout(body && body.source);
  },
  // body: { source, sourceId, sdp, quality } -> { answerSdp }
  async offer({ homey, body }) {
    return homey.app.widgetOffer(body || {});
  },
};
