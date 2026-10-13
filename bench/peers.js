'use strict';

// Child process: a fake ACS (offers H.264 + data channel, sends synthetic RTP at a fixed rate)
// and a fake viewer (offers recvonly video). Talks to the relay process over IPC.
const {
  RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack, RtpPacket, RtpHeader, useOPUS,
} = require('werift');

const RATE = Number(process.env.RATE || 200);
const SIZE = Number(process.env.SIZE || 1100);
const VIEWERS = Number(process.env.VIEWERS || 1);
const codec = () => new RTCRtpCodecParameters({
  mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }],
  parameters: 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1',
});

let acs;
let received = 0;
let sessions = 0;
const send = (m) => process.send(m);

process.on('message', async (m) => {
  if (m.type === 'acsStart') {
    sessions++;
    const session = sessions;
    acs = new RTCPeerConnection({ codecs: { video: [codec()] } });
    acs.createDataChannel('ctrl');
    const track = new MediaStreamTrack({ kind: 'video' });
    acs.addTransceiver(track, { direction: 'sendonly' });
    acs.onIceCandidate.subscribe((c) => { if (c) send({ type: 'acsCandidate', candidate: c.toJSON() }); });
    await acs.setLocalDescription(await acs.createOffer());
    send({ type: 'acsOffer', sdp: acs.localDescription.sdp });
    // Synthetic stream: a "keyframe" (IDR FU-A start) every 2 s, otherwise P slices.
    let seq = 0; let ts = 0; let n = 0;
    const perTick = Math.max(1, Math.round(RATE / 100));
    const started = Date.now();
    const pauseAfter = Number(process.env.PAUSE_AFTER_MS || 0);
    setInterval(() => {
      // Simulate a stalled camera: the first session goes silent after PAUSE_AFTER_MS.
      if (pauseAfter && session === 1 && Date.now() - started > pauseAfter) return;
      for (let i = 0; i < perTick; i++) {
        const payload = Buffer.alloc(SIZE, 0x41);
        payload[0] = 28; // FU-A
        payload[1] = n % (RATE * 2) === 0 ? 0x85 : 0x01; // start of IDR every 2 s
        track.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 96, sequenceNumber: seq++ & 0xffff, timestamp: ts, ssrc: 1234, marker: true }), payload));
        n++;
        if (n % 10 === 0) ts = (ts + 9000) >>> 0;
      }
    }, 10);
  } else if (m.type === 'acsAnswer') {
    await acs.setRemoteDescription({ type: 'answer', sdp: m.sdp });
  } else if (m.type === 'relayCandidate') {
    await acs.addIceCandidate(m.candidate).catch(() => {});
  } else if (m.type === 'viewersStart') {
    for (let i = 0; i < VIEWERS; i++) {
      const v = new RTCPeerConnection({ codecs: { video: [codec()], audio: [useOPUS()] } });
      v.addTransceiver('audio', { direction: 'recvonly' });
      v.addTransceiver('video', { direction: 'recvonly' });
      v.onTrack.subscribe((t) => t.onReceiveRtp.subscribe(() => { received++; }));
      await v.setLocalDescription(await v.createOffer());
      await new Promise((r) => setTimeout(r, 300));
      send({ type: 'viewerOffer', i, sdp: v.localDescription.sdp });
      process.on('message', async (a) => { if (a.type === 'viewerAnswer' && a.i === i) await v.setRemoteDescription({ type: 'answer', sdp: a.sdp }); });
    }
  } else if (m.type === 'stats') {
    send({ type: 'stats', received });
  }
});
