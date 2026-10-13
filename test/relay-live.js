'use strict';

// End-to-end relay test: a fake "Homey viewer" peer makes the offer, the relay answers
// and forwards ACS video. Usage: ACS_USER=.. ACS_PASS=.. node test-relay.js [camera] [seconds]
const { RTCPeerConnection, RTCRtpCodecParameters } = require('werift');
const AcsClient = require('../lib/acs-client');
const LiveRelay = require('../lib/live-relay');

const filter = (process.argv[2] || '').toLowerCase();
const seconds = Number(process.argv[3] || 10);

(async () => {
  const acs = new AcsClient({ host: process.env.ACS_HOST || '192.168.1.250', username: process.env.ACS_USER, password: process.env.ACS_PASS, log: console.log });
  const cams = await acs.listCameras();
  const cam = cams.find((c) => c.name.toLowerCase().includes(filter)) || cams[0];
  const jpeg = await acs.getSnapshot(cam.sourceId);
  console.log('snapshot bytes', jpeg.length, jpeg.subarray(0, 2).toString('hex'));

  // Fake viewer, like the Homey app: recvonly video, non-trickle offer.
  const viewer = new RTCPeerConnection({
    codecs: { video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }], parameters: 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1' })] },
  });
  viewer.addTransceiver('video', { direction: 'recvonly' });
  const t0 = Date.now();
  const stats = { rtp: 0, idr: 0, firstMs: null };
  viewer.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((rtp) => {
    if (stats.firstMs === null) stats.firstMs = Date.now() - t0;
    stats.rtp++;
    let t = rtp.payload[0] & 0x1f;
    if (t === 28) t = rtp.payload[1] & 0x1f;
    if (t === 5) stats.idr++;
  }));
  await viewer.setLocalDescription(await viewer.createOffer());
  await new Promise((r) => setTimeout(r, 500)); // let host candidates gather

  const relay = new LiveRelay({ acs, camera: cam, streamProfile: process.env.PROFILE || 'high', log: console.log });
  const answer = await relay.answer(viewer.localDescription.sdp);
  console.log(`answer ready after ${Date.now() - t0}ms, candidates in answer: ${(answer.match(/a=candidate/g) || []).length}`);
  await viewer.setRemoteDescription({ type: 'answer', sdp: answer });

  await new Promise((r) => setTimeout(r, seconds * 1000));
  console.log('VIEWER RESULT', JSON.stringify({ camera: cam.name, ...stats }));
  relay.close();
  await viewer.close();
  process.exit(stats.rtp > 0 ? 0 : 2);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
