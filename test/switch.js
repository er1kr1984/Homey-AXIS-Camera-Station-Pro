'use strict';

// Mid-stream quality switch with one fake viewer.
// Usage: ACS_USER=.. ACS_PASS=.. node test/switch.js [camera] [from] [to]
const { RTCPeerConnection, RTCRtpCodecParameters, useOPUS } = require('werift');
const AcsClient = require('../lib/acs-client');
const LiveRelay = require('../lib/live-relay');
const parseSps = require('./sps');

const [filter = 'p3267', from = 'medium', to = 'low'] = process.argv.slice(2);

function spsFrom(payload) {
  const t = payload[0] & 0x1f;
  if (t === 7) return payload;
  if (t === 24) {
    for (let o = 1; o + 2 < payload.length;) {
      const len = payload.readUInt16BE(o);
      if ((payload[o + 2] & 0x1f) === 7) return payload.subarray(o + 2, o + 2 + len);
      o += 2 + len;
    }
  }
  return null;
}

(async () => {
  const acs = new AcsClient({ host: '192.168.1.250', username: process.env.ACS_USER, password: process.env.ACS_PASS });
  const cam = (await acs.listCameras()).find((c) => c.name.toLowerCase().includes(filter));
  const relay = new LiveRelay({ acs, log: (...a) => console.log(...a) });
  const pc = new RTCPeerConnection({ codecs: { video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }], parameters: 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1' })], audio: [useOPUS()] } });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });
  const t0 = Date.now();
  let lastSeq = null; let bigGaps = 0; let rtp = 0; const resolutions = [];
  pc.onTrack.subscribe((t) => t.onReceiveRtp.subscribe((p) => {
    rtp++;
    if (lastSeq !== null) {
      const d = (p.header.sequenceNumber - lastSeq + 65536) % 65536;
      if (d > 5 && d < 65000) bigGaps++;
    }
    lastSeq = p.header.sequenceNumber;
    const sps = spsFrom(p.payload);
    if (sps) {
      const r = parseSps(sps);
      const label = `${r.width}x${r.height}`;
      if (resolutions[resolutions.length - 1]?.res !== label) resolutions.push({ at: ((Date.now() - t0) / 1000).toFixed(1), res: label });
    }
  }));
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 300));
  const { answerSdp } = await relay.openViewer({ camera: cam, mode: 'auto', startProfile: from, viewerOfferSdp: pc.localDescription.sdp });
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  await new Promise((r) => setTimeout(r, 6000));
  const before = rtp;
  console.log('--- forcing switch at', ((Date.now() - t0) / 1000).toFixed(1));
  relay.streams.get(cam.sourceId).switchProfile(to, 'test');
  await new Promise((r) => setTimeout(r, 12000));
  console.log('RESULT', JSON.stringify({ before, after: rtp - before, bigSeqGaps: bigGaps, resolutions, profileNow: relay.streams.get(cam.sourceId).profile }));
  relay.closeAll();
  await pc.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
