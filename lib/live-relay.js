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
  RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack,
} = require('werift');

const h264 = () => new RTCRtpCodecParameters({
  mimeType: 'video/H264',
  clockRate: 90000,
  rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }],
  parameters: 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1',
});

const ICE_GATHER_TIMEOUT_MS = 3000;
const UPSTREAM_TIMEOUT_MS = 15000;

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
    const viewerPc = new RTCPeerConnection({ codecs: { video: [h264()] } });
    this.viewerPc = viewerPc;

    viewerPc.connectionStateChange.subscribe((state) => {
      this.log(`[${this.camera.name}] viewer ${state}`);
      if (state === 'failed' || state === 'closed') this.close();
    });

    await viewerPc.setRemoteDescription({ type: 'offer', sdp: viewerOfferSdp });
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
    this.log(`viewer offer: ${summary(viewerOfferSdp)}`);
    this.log(`our answer: ${summary(viewerPc.localDescription.sdp)}`);
    return viewerPc.localDescription.sdp;
  }

  async _startUpstream() {
    let upstreamPc;
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
          track.onReceiveRtp.subscribe((rtp) => {
            if (this.packets++ === 0) this._upstreamConnected();
            this.viewerTrack.writeRtp(rtp);
          });
        });
        await upstreamPc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        await upstreamPc.setLocalDescription(await upstreamPc.createAnswer());
        return upstreamPc.localDescription.sdp;
      },
      onRemoteCandidate: async (c) => {
        if (!c.candidate || !upstreamPc) return;
        await upstreamPc.addIceCandidate({ candidate: c.candidate, sdpMLineIndex: c.sdpMLineIndex ?? 0, sdpMid: c.sdpMid ?? 'application0' })
          .catch((err) => this.log('addIceCandidate:', err.message));
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
    this.log(`[${this.camera.name}] relay closed after ${this.packets} packets`);
    if (this.session) this.session.close();
    for (const pc of [this.upstreamPc, this.viewerPc]) {
      if (pc) pc.close().catch(() => {});
    }
    if (this.onClose) this.onClose(this);
  }
}

module.exports = LiveRelay;
