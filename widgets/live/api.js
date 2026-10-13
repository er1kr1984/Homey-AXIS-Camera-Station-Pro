'use strict';

module.exports = {
  // body: { source } (the widget's "View or camera" setting) -> { columns, rows, tiles }
  async getLayout({ homey, body }) {
    return homey.app.widgetLayout(body && body.source);
  },
  // body: { source, sourceId } -> { jpeg: base64 } (fallback when live video can't connect)
  async snapshot({ homey, body }) {
    return homey.app.widgetSnapshot(body || {});
  },
  // body: { source, sourceId, after, quality } -> { codec, init?, seq, data, restart }
  // (live video over HTTP when WebRTC can't connect)
  async mp4({ homey, body }) {
    return homey.app.widgetMp4(body || {});
  },
  // body: { source, sourceId, sdp, quality } -> { answerSdp }
  async offer({ homey, body }) {
    return homey.app.widgetOffer(body || {});
  },
};
