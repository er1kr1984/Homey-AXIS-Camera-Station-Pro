'use strict';

// Keeps one camera streaming to a fake viewer for N minutes and reports packets per minute,
// to check streams outlive Camera Station's 15-minute access token.
// Usage: ACS_HOST=.. ACS_USER=.. ACS_PASS=.. node test/long-run.js [camera] [minutes]
const { RTCPeerConnection, RTCRtpCodecParameters } = require('werift');
const AcsClient = require('../lib/acs-client');
const LiveRelay = require('../lib/live-relay');

const [filter = '', minutes = '20'] = process.argv.slice(2);
(async () => {
  const acs = new AcsClient({ host: process.env.ACS_HOST, username: process.env.ACS_USER, password: process.env.ACS_PASS, log: (...a) => console.log(new Date().toISOString(), ...a) });
  const cam = (await acs.listCameras()).find((c) => c.name.toLowerCase().includes(filter));
  const relay = new LiveRelay({ getAcs: () => acs, log: (...a) => console.log(new Date().toISOString(), ...a) });
  const pc = new RTCPeerConnection({ codecs: { video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }], parameters: 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1' })] } });
  pc.addTransceiver('video', { direction: 'recvonly' });
  let n = 0;
  pc.onTrack.subscribe((t) => t.onReceiveRtp.subscribe(() => { n++; }));
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 300));
  const { answerSdp } = await relay.openViewer({ camera: cam, mode: 'low', startProfile: 'low', viewerOfferSdp: pc.localDescription.sdp });
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  for (let m = 1; m <= Number(minutes); m++) {
    const before = n;
    await new Promise((r) => setTimeout(r, 60000));
    console.log(`minute ${m}: ${n - before} packets`);
  }
  relay.closeAll();
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
