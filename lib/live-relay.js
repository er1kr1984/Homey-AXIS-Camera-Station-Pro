'use strict';

// Relays ACS live streams to WebRTC viewers (the Homey frontend).
//
// ACS always sends the SDP offer, and so does Homey, so they can't be connected
// directly. Per camera we hold ONE upstream peer connection to ACS (CameraStream)
// and answer each viewer with its own peer connection (ViewerSession). H.264 RTP
// packets are forwarded untouched (no transcoding) to every viewer.
//
//   viewers --offer--> [ViewerSession]* <==RTP== [CameraStream] <--offer-- ACS

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
const VIEWER_SILENCE_MS = 15000; // viewers send RTCP about every second
const UPSTREAM_LINGER_MS = 10000; // keep ACS open briefly for quick re-opens

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

// One live session from ACS for one camera, shared by any number of viewers.
class CameraStream {
  constructor({
    acs, camera, streamProfile, log, onClose,
  }) {
    this.acs = acs;
    this.camera = camera;
    this.streamProfile = streamProfile;
    this.log = log;
    this.onClose = onClose;
    this.viewers = new Set();
    this.closed = false;
    this.packets = 0;
    this.ready = this._startWithRetry();
    this.ready.catch((err) => {
      this.log(`ACS stream failed: ${err.message}`);
      this.close();
    });
  }

  // ACS occasionally doesn't complete ICE on the first try; retry once, keeping viewers attached.
  async _startWithRetry() {
    try {
      await this._start();
    } catch (err) {
      if (this.closed) throw err;
      this.log(`ACS attempt 1 failed (${err.message}), retrying`);
      this._teardownUpstream();
      await this._start();
    }
  }

  _teardownUpstream() {
    clearInterval(this.statsTimer);
    const { session, pc } = this;
    this.session = null;
    this.pc = null;
    this.track = null;
    this._retrying = true;
    if (session) session.close();
    if (pc) pc.close().catch(() => {});
    this._retrying = false;
  }

  async _start() {
    let upstreamPc;
    // ACS can trickle candidates before our remote description is applied; hold them until then.
    let remoteReady = false;
    const pendingCandidates = [];
    const addCandidate = (c) => upstreamPc.addIceCandidate({ candidate: c.candidate, sdpMLineIndex: c.sdpMLineIndex ?? 0, sdpMid: c.sdpMid ?? 'application0' })
      .catch((err) => this.log('addIceCandidate:', err.message));
    const connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for ACS video')), UPSTREAM_TIMEOUT_MS);
      this._gotFirstPacket = () => { clearTimeout(timer); resolve(); };
    });

    this.session = await this.acs.startLiveSession({
      camera: this.camera,
      streamProfile: this.streamProfile,
      onOffer: async (offerSdp, iceServers) => {
        upstreamPc = new RTCPeerConnection({ iceServers, codecs: { video: [h264()] } });
        this.pc = upstreamPc;
        upstreamPc.onIceCandidate.subscribe((c) => {
          if (!c || !this.session) return;
          const j = c.toJSON();
          this.session.sendCandidate({ candidate: j.candidate, sdpMLineIndex: j.sdpMLineIndex ?? 0, sdpMid: j.sdpMid ?? 'application0' });
        });
        upstreamPc.iceConnectionStateChange.subscribe((state) => this.log(`ACS ICE ${state}`));
        upstreamPc.connectionStateChange.subscribe((state) => {
          this.log(`ACS ${state}`);
          if ((state === 'failed' || state === 'closed') && this.pc === upstreamPc && !this._retrying) this.close();
        });
        upstreamPc.onTrack.subscribe((track) => {
          if (track.kind !== 'video') return;
          this.track = track;
          this.statsTimer = setInterval(() => {
            this.log(`forwarded ${this.packets} packets to ${this.viewers.size} viewer(s)`);
          }, 60000);
          track.onReceiveRtp.subscribe((rtp) => {
            if (this.packets++ === 0) {
              this._gotFirstPacket();
              this.log('first video packet from ACS');
            }
            for (const viewer of this.viewers) viewer.track.writeRtp(rtp);
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
      onClose: () => { if (!this._retrying && this.pc === upstreamPc) this.close(); },
    });
    await connected;
  }

  addViewer(viewer) {
    clearTimeout(this.lingerTimer);
    this.viewers.add(viewer);
    this.requestKeyframe();
  }

  removeViewer(viewer) {
    this.viewers.delete(viewer);
    if (this.viewers.size === 0 && !this.closed) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = setTimeout(() => {
        if (this.viewers.size === 0) this.close();
      }, UPSTREAM_LINGER_MS);
    }
  }

  requestKeyframe() {
    const transceiver = this.pc && this.pc.getTransceivers().find((t) => t.kind === 'video');
    if (transceiver && this.track && this.track.ssrc) {
      transceiver.receiver.sendRtcpPLI(this.track.ssrc);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.statsTimer);
    clearTimeout(this.lingerTimer);
    this.log(`ACS stream closed after ${this.packets} packets`);
    if (this.session) this.session.close();
    if (this.pc) this.pc.close().catch(() => {});
    for (const viewer of [...this.viewers]) viewer.close();
    if (this.onClose) this.onClose(this);
  }
}

// One viewer (e.g. a phone) watching a CameraStream.
class ViewerSession {
  constructor({ stream, log, onClose }) {
    this.id = crypto.randomUUID();
    this.stream = stream;
    this.log = log;
    this.onClose = onClose;
    this.closed = false;
    this.lastHeard = Date.now();
    this.track = new MediaStreamTrack({ kind: 'video' });
  }

  // Takes the viewer's SDP offer and returns a complete (non-trickle) SDP answer.
  async answer(viewerOfferSdp) {
    // The viewer may also offer audio; accept the codecs so negotiation succeeds,
    // then mark audio inactive (ACS live WebRTC is video only here).
    const pc = new RTCPeerConnection({ codecs: { video: [h264()], audio: [useOPUS(), usePCMU()] } });
    this.pc = pc;
    pc.connectionStateChange.subscribe((state) => {
      this.log(`viewer ${state}`);
      if (state === 'failed' || state === 'closed') this.close();
    });

    const picked = pickViewerH264(viewerOfferSdp);
    this.log(`viewer H.264: ${picked.chosen}`);
    await pc.setRemoteDescription({ type: 'offer', sdp: picked.sdp });
    for (const t of pc.getTransceivers()) {
      if (t.kind === 'audio') t.setDirection('inactive');
    }
    const transceiver = pc.getTransceivers().find((t) => t.kind === 'video');
    if (!transceiver) throw new Error('Viewer offer has no video');
    transceiver.setDirection('sendonly');
    transceiver.sender.replaceTrack(this.track);
    transceiver.sender.onRtcp.subscribe((rtcp) => {
      this.lastHeard = Date.now();
      // Viewer asks for a keyframe (PLI) -> ask ACS for one.
      if (rtcp.type === 206 && rtcp.feedback && rtcp.feedback.count === 1) this.stream.requestKeyframe();
    });

    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS);

    // Close viewers that silently went away (app closed, phone locked, network lost).
    this.lastHeard = Date.now();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastHeard > VIEWER_SILENCE_MS) {
        this.log('viewer silent, closing');
        this.close();
      }
    }, 5000);

    this.stream.addViewer(this);
    return pc.localDescription.sdp;
  }

  keepAlive() {
    this.lastHeard = Date.now();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    this.stream.removeViewer(this);
    if (this.pc) this.pc.close().catch(() => {});
    if (this.onClose) this.onClose(this);
  }
}

// Keeps one CameraStream per camera and hands out viewer sessions.
class LiveRelay {
  constructor({ acs, log = () => {} }) {
    this.acs = acs;
    this.log = log;
    this.streams = new Map(); // key: sourceId|profile
  }

  async openViewer({ camera, streamProfile = 'medium', viewerOfferSdp, onClose }) {
    const key = `${camera.sourceId}|${streamProfile}`;
    let stream = this.streams.get(key);
    if (!stream || stream.closed) {
      stream = new CameraStream({
        acs: this.acs,
        camera,
        streamProfile,
        log: (...args) => this.log(`[${camera.name}]`, ...args),
        onClose: (s) => { if (this.streams.get(key) === s) this.streams.delete(key); },
      });
      this.streams.set(key, stream);
    }
    const viewer = new ViewerSession({
      stream,
      log: (...args) => this.log(`[${camera.name}]`, ...args),
      onClose,
    });
    try {
      return { viewer, answerSdp: await viewer.answer(viewerOfferSdp) };
    } catch (err) {
      viewer.close();
      throw err;
    }
  }

  closeCamera(sourceId) {
    for (const [key, stream] of this.streams) {
      if (key.startsWith(`${sourceId}|`)) stream.close();
    }
  }

  closeAll() {
    for (const stream of [...this.streams.values()]) stream.close();
  }
}

module.exports = LiveRelay;
module.exports.pickViewerH264 = pickViewerH264;
