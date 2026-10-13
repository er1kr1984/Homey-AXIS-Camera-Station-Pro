'use strict';

// Several fake viewers on one camera share one ACS stream.
// Usage: ACS_USER=.. ACS_PASS=.. node test/relay-multi.js [camera] [profile] [viewers] [seconds]
const { RTCPeerConnection, RTCRtpCodecParameters, useOPUS } = require('werift');
const AcsClient = require('../lib/acs-client');
const LiveRelay = require('../lib/live-relay');

const [filter = '', profile = 'medium', count = '3', secs = '8'] = process.argv.slice(2);

async function fakeViewer(relay, cam, i) {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }], parameters: 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1' })],
      audio: [useOPUS()],
    },
  });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });
  const stats = { i, rtp: 0, idr: 0 };
  pc.onTrack.subscribe((t) => t.onReceiveRtp.subscribe((rtp) => {
    stats.rtp++;
    let n = rtp.payload[0] & 0x1f;
    if (n === 28) n = rtp.payload[1] & 0x1f;
    if (n === 5) stats.idr++;
  }));
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 300));
  const { viewer, answerSdp } = await relay.openViewer({ camera: cam, streamProfile: profile, viewerOfferSdp: pc.localDescription.sdp });
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  return { pc, viewer, stats };
}

(async () => {
  const acs = new AcsClient({ host: process.env.ACS_HOST, username: process.env.ACS_USER, password: process.env.ACS_PASS });
  const cam = (await acs.listCameras()).find((c) => c.name.toLowerCase().includes(filter));
  const relay = new LiveRelay({ acs, log: (...a) => console.log(...a) });
  const viewers = [];
  for (let i = 0; i < Number(count); i++) {
    viewers.push(await fakeViewer(relay, cam, i));
    await new Promise((r) => setTimeout(r, 1500));
  }
  await new Promise((r) => setTimeout(r, Number(secs) * 1000));
  console.log('ACS streams open:', relay.streams.size);
  for (const v of viewers) console.log('VIEWER', JSON.stringify(v.stats));
  // Close viewers like a phone going away; the ACS stream should close after the linger time.
  for (const v of viewers) await v.pc.close();
  await new Promise((r) => setTimeout(r, 30000));
  console.log('ACS streams open after viewers left:', relay.streams.size);
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
