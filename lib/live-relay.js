'use strict';

// Relays one ACS live stream to one WebRTC viewer (the Homey frontend).
//
// ACS always sends the SDP offer, and so does Homey, so they can't be connected
// directly. We answer both sides with two peer connections and forward the
// H.264 RTP packets between them untouched (no transcoding).
//
//   Homey viewer --offer--> [viewerPc]  <==RTP==  [upstreamPc] <--offer-- ACS

const crypto = require('node:crypto');
const {
  RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack, useOPUS, usePCMU,
} = require('werift');

const h264 = () => new RTCRtpCodecParameters({
  mimeType: 'video/H264',
  clockRate: 90000,
  rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }],
  parameters: 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1',
});

const ICE_GATHER_TIMEOUT_MS = 3000;
const UPSTREAM_TIMEOUT_MS = 15000;

// Keeps a single H.264 payload type in the viewer's video section (plus its RTX), so the
// packets we forward are always labelled with a format the viewer will decode.
// Prefers packetization-mode=1 and the High profile ACS actually sends.
function pickViewerH264(offerSdp) {
  const lines = offerSdp.split(/\r?\n/);
  const mIdx = lines.findIndex((l) => l.startsWith('m=video'));
  if (mIdx < 0) return { sdp: offerSdp, chosen: null };
  let end = lines.findIndex((l, i) => i > mIdx && l.startsWith('m='));
  if (end < 0) end = lines.length;
  const section = lines.slice(mIdx, end);
  const rtpmap = {};
  const fmtp = {};
  for (const l of section) {
    let m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(l);
    if (m) rtpmap[m[1]] = m[2].toUpperCase();
    m = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (m) fmtp[m[1]] = m[2];
  }
  const h264 = Object.keys(rtpmap).filter((pt) => rtpmap[pt] === 'H264');
  const score = (pt) => {
    const f = (fmtp[pt] || '').toLowerCase();
    let sc = 0;
    if (f.includes('packetization-mode=1')) sc += 10;
    if (/profile-level-id=64/.test(f)) sc += 3;
    else if (/profile-level-id=42e0/.test(f)) sc += 2;
    if (f.includes('level-asymmetry-allowed=1')) sc += 1;
    return sc;
  };
  const chosen = h264.sort((a, b) => score(b) - score(a))[0];
  if (!chosen) return { sdp: offerSdp, chosen: null, h264: [] };
  const rtx = Object.keys(fmtp).filter((pt) => rtpmap[pt] === 'RTX' && fmtp[pt].includes(`apt=${chosen}`));
  const keep = new Set([chosen, ...rtx]);
  const mParts = section[0].split(' ');
  section[0] = [...mParts.slice(0, 3), ...mParts.slice(3).filter((pt) => keep.has(pt))].join(' ');
  const filtered = section.filter((l) => {
    const m = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/.exec(l);
    return !m || keep.has(m[1]);
  });
  const out = [...lines.slice(0, mIdx), ...filtered, ...lines.slice(end)].join('\r\n');
  return { sdp: out, chosen: `${chosen} ${fmtp[chosen] || ''}`, h264: h264.map((pt) => `${pt}:${fmtp[pt] || ''}`) };
}

function waitForIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

class LiveRelay {
  constructor({ acs, camera, streamProfile = 'high', log = () => {}, onClose }) {
    this.id = crypto.randomUUID();
    this.acs = acs;
    this.camera = camera;
    this.streamProfile = streamProfile;
    this.log = log;
    this.onClose = onClose;
    this.closed = false;
    this.lastKeepAlive = Date.now();
    this.packets = 0;
  }

  // Takes the viewer's SDP offer and returns a complete (non-trickle) SDP answer.
  async answer(viewerOfferSdp) {
    const track = new MediaStreamTrack({ kind: 'video' });
    this.viewerTrack = track;
    this.log(`viewer offer media: ${viewerOfferSdp.split(/\r?\n/).filter((l) => /^m=|^a=rtpmap|^a=fmtp|^a=(sendrecv|recvonly|sendonly|inactive)/.test(l)).join(' | ').slice(0, 1500)}`);
    // The viewer may also offer audio; accept the codecs so negotiation succeeds,
    // then mark audio inactive (ACS live WebRTC is video only here).
    const viewerPc = new RTCPeerConnection({ codecs: { video: [h264()], audio: [useOPUS(), usePCMU()] } });
    this.viewerPc = viewerPc;

    viewerPc.connectionStateChange.subscribe((state) => {
      this.log(`[${this.camera.name}] viewer ${state}`);
      if (state === 'failed' || state === 'closed') this.close();
    });

    const picked = pickViewerH264(viewerOfferSdp);
    this.log(`viewer H.264 options: ${(picked.h264 || []).join(' ; ')}`);
    this.log(`using viewer H.264: ${picked.chosen}`);
    await viewerPc.setRemoteDescription({ type: 'offer', sdp: picked.sdp });
    for (const t of viewerPc.getTransceivers()) {
      if (t.kind === 'audio') t.setDirection('inactive');
    }
    const transceiver = viewerPc.getTransceivers().find((t) => t.kind === 'video');
    if (!transceiver) throw new Error('Viewer offer has no video');
    transceiver.setDirection('sendonly');
    transceiver.sender.replaceTrack(track);
    // Viewer asks for a keyframe -> ask ACS for one.
    transceiver.sender.onRtcp.subscribe((rtcp) => {
      const isPli = rtcp.type === 206 && rtcp.feedback && rtcp.feedback.count === 1;
      if (isPli) this.requestKeyframe();
    });

    // Start the upstream session in parallel with the viewer handshake.
    this.upstreamReady = this._startUpstream();
    this.upstreamReady.catch((err) => {
      this.log(`[${this.camera.name}] upstream failed: ${err.message}`);
      this.close();
    });

    await viewerPc.setLocalDescription(await viewerPc.createAnswer());
    await waitForIceGathering(viewerPc, ICE_GATHER_TIMEOUT_MS);
    const summary = (sdp) => [
      ...sdp.split(/\r?\n/).filter((l) => l.startsWith('m=') || l.startsWith('a=candidate')).map((l) => l.slice(0, 90)),
    ].join(' | ');
    this.log(`our answer: ${summary(viewerPc.localDescription.sdp)}`);
    return viewerPc.localDescription.sdp;
  }

  async _startUpstream() {
    let upstreamPc;
    // ACS can trickle candidates before our remote description is applied; hold them until then.
    let remoteReady = false;
    const pendingCandidates = [];
    const addCandidate = (c) => upstreamPc.addIceCandidate({ candidate: c.candidate, sdpMLineIndex: c.sdpMLineIndex ?? 0, sdpMid: c.sdpMid ?? 'application0' })
      .catch((err) => this.log('addIceCandidate:', err.message));
    const connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for ACS video')), UPSTREAM_TIMEOUT_MS);
      this._upstreamConnected = () => { clearTimeout(timer); resolve(); };
    });

    this.session = await this.acs.startLiveSession({
      camera: this.camera,
      streamProfile: this.streamProfile,
      onOffer: async (offerSdp, iceServers) => {
        upstreamPc = new RTCPeerConnection({ iceServers, codecs: { video: [h264()] } });
        this.upstreamPc = upstreamPc;
        upstreamPc.onIceCandidate.subscribe((c) => {
          if (!c || !this.session) return;
          const j = c.toJSON();
          this.session.sendCandidate({ candidate: j.candidate, sdpMLineIndex: j.sdpMLineIndex ?? 0, sdpMid: j.sdpMid ?? 'application0' });
        });
        upstreamPc.connectionStateChange.subscribe((state) => {
          this.log(`[${this.camera.name}] ACS ${state}`);
          if (state === 'failed' || state === 'closed') this.close();
        });
        upstreamPc.onTrack.subscribe((track) => {
          if (track.kind !== 'video') return;
          this.upstreamTrack = track;
          this.statsTimer = setInterval(() => {
            this.log(`forwarded ${this.packets} packets so far`);
          }, 30000);
          track.onReceiveRtp.subscribe((rtp) => {
            if (this.packets++ === 0) {
              this._upstreamConnected();
              this.log('first video packet from ACS');
            }
            this.viewerTrack.writeRtp(rtp);
          });
        });
        await upstreamPc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        remoteReady = true;
        for (const c of pendingCandidates.splice(0)) addCandidate(c);
        await upstreamPc.setLocalDescription(await upstreamPc.createAnswer());
        return upstreamPc.localDescription.sdp;
      },
      onRemoteCandidate: async (c) => {
        if (!c.candidate) return;
        if (!remoteReady) pendingCandidates.push(c);
        else await addCandidate(c);
      },
      onClose: () => this.close(),
    });
    await connected;
  }

  requestKeyframe() {
    const transceiver = this.upstreamPc && this.upstreamPc.getTransceivers().find((t) => t.kind === 'video');
    if (transceiver && this.upstreamTrack && this.upstreamTrack.ssrc) {
      transceiver.receiver.sendRtcpPLI(this.upstreamTrack.ssrc);
    }
  }

  keepAlive() {
    this.lastKeepAlive = Date.now();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.statsTimer);
    this.log(`[${this.camera.name}] relay closed after ${this.packets} packets`);
    if (this.session) this.session.close();
    for (const pc of [this.upstreamPc, this.viewerPc]) {
      if (pc) pc.close().catch(() => {});
    }
    if (this.onClose) this.onClose(this);
  }
}

module.exports = LiveRelay;
module.exports.pickViewerH264 = pickViewerH264;
