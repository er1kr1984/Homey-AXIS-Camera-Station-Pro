'use strict';

// Two viewers of one camera asking for different qualities must share one stream and
// neither may lose video when the other joins.
// Usage: ACS_HOST=.. ACS_USER=.. ACS_PASS=.. node test/relay-mixed.js [camera]
const { RTCPeerConnection, RTCRtpCodecParameters } = require('werift');
const AcsClient = require('../lib/acs-client');
const LiveRelay = require('../lib/live-relay');

const filter = process.argv[2] || '';
const codec = () => new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }], parameters: 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1' });

async function viewer(relay, camera, mode) {
  const pc = new RTCPeerConnection({ codecs: { video: [codec()] } });
  pc.addTransceiver('video', { direction: 'recvonly' });
  const stats = { rtp: 0 };
  pc.onTrack.subscribe((t) => t.onReceiveRtp.subscribe(() => { stats.rtp++; }));
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 300));
  const { answerSdp } = await relay.openViewer({ camera, mode, startProfile: 'medium', viewerOfferSdp: pc.localDescription.sdp });
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  return { pc, stats };
}

(async () => {
  const acs = new AcsClient({ host: process.env.ACS_HOST, username: process.env.ACS_USER, password: process.env.ACS_PASS });
  const cam = (await acs.listCameras()).find((c) => c.name.toLowerCase().includes(filter));
  const relay = new LiveRelay({ acs, log: (...a) => console.log(...a) });
  const a = await viewer(relay, cam, 'auto');
  await new Promise((r) => setTimeout(r, 5000));
  const aBefore = a.stats.rtp;
  const b = await viewer(relay, cam, 'low');
  await new Promise((r) => setTimeout(r, 6000));
  const result = { streams: relay.streams.size, aBefore, aAfter: a.stats.rtp - aBefore, b: b.stats.rtp };
  console.log('RESULT', JSON.stringify(result));
  relay.closeAll();
  process.exit(result.streams === 1 && result.aAfter > 0 && result.b > 0 ? 0 : 2);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
