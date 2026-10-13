'use strict';

// CPU cost of relaying one camera to one fake viewer.
// Usage: ACS_USER=.. ACS_PASS=.. node test/cpu.js [camera] [profile] [seconds]
if (process.env.TUNE) require('../lib/werift-tuning').applyWeriftTuning();
const { RTCPeerConnection, RTCRtpCodecParameters } = require('werift');
const AcsClient = require('../lib/acs-client');
const LiveRelay = require('../lib/live-relay');

const [filter = '', profile = 'medium', secs = '15'] = process.argv.slice(2);
(async () => {
  const acs = new AcsClient({ host: '192.168.1.250', username: process.env.ACS_USER, password: process.env.ACS_PASS });
  const cam = (await acs.listCameras()).find((c) => c.name.toLowerCase().includes(filter));
  const relay = new LiveRelay({ acs });
  const pc = new RTCPeerConnection({ codecs: { video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }], parameters: 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1' })] } });
  pc.addTransceiver('video', { direction: 'recvonly' });
  let rtp = 0;
  pc.onTrack.subscribe((t) => t.onReceiveRtp.subscribe(() => { rtp++; }));
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 300));
  const { answerSdp } = await relay.openViewer({ camera: cam, streamProfile: profile, viewerOfferSdp: pc.localDescription.sdp });
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  await new Promise((r) => setTimeout(r, 4000));
  const c0 = process.cpuUsage(); const t0 = Date.now(); const r0 = rtp;
  await new Promise((r) => setTimeout(r, Number(secs) * 1000));
  const c = process.cpuUsage(c0); const wall = (Date.now() - t0) / 1000;
  // Note: this process runs BOTH the relay and the fake viewer, so the relay alone is roughly half.
  console.log(JSON.stringify({ camera: cam.name, profile, pktPerSec: Math.round((rtp - r0) / wall), cpuPercentTotal: Math.round(((c.user + c.system) / 1e6 / wall) * 100), usPerPacket: Math.round((c.user + c.system) / Math.max(1, rtp - r0)) }));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
