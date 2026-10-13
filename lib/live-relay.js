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
const quality = require('./quality');

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
const GOP_CACHE_MAX_PACKETS = 5000; // ~6 s of a 2 Mbit/s stream

// True when this RTP payload starts a keyframe: SPS (alone or in a STAP-A),
// or the first fragment of an IDR slice.
function startsKeyframe(payload) {
  const type = payload[0] & 0x1f;
  if (type === 7) return true;
  if (type === 5) return true;
  if (type === 24) {
    for (let o = 1; o + 2 < payload.length;) {
      const len = payload.readUInt16BE(o);
      if ((payload[o + 2] & 0x1f) === 7) return true;
      o += 2 + len;
    }
    return false;
  }
  if (type === 28) return (payload[1] & 0x80) !== 0 && (payload[1] & 0x1f) === 5;
  return false;
}

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

// One live WebRTC session from ACS at one quality level.
class Upstream {
  constructor({
    acs, camera, profile, log, onPacket, onDead,
  }) {
    this.acs = acs;
    this.camera = camera;
    this.profile = profile;
    this.log = (...args) => log(`[${profile}]`, ...args);
    this.onPacket = onPacket;
    this.onDead = onDead;
    this.closed = false;
    this.packets = 0;
    this.bytes = 0;
  }

  // Resolves on the first video packet.
  async start() {
    let pc;
    // ACS can trickle candidates before our remote description is applied; hold them until then.
    let remoteReady = false;
    const pendingCandidates = [];
    const addCandidate = (c) => pc.addIceCandidate({ candidate: c.candidate, sdpMLineIndex: c.sdpMLineIndex ?? 0, sdpMid: c.sdpMid ?? 'application0' })
      .catch((err) => this.log('addIceCandidate:', err.message));
    let gotFirstPacket;
    const connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for ACS video')), UPSTREAM_TIMEOUT_MS);
      gotFirstPacket = () => { clearTimeout(timer); resolve(); };
    });

    this.session = await this.acs.startLiveSession({
      camera: this.camera,
      streamProfile: this.profile,
      onOffer: async (offerSdp, iceServers) => {
        pc = new RTCPeerConnection({ iceServers, codecs: { video: [h264()] } });
        this.pc = pc;
        pc.onIceCandidate.subscribe((c) => {
          if (!c || !this.session) return;
          const j = c.toJSON();
          this.session.sendCandidate({ candidate: j.candidate, sdpMLineIndex: j.sdpMLineIndex ?? 0, sdpMid: j.sdpMid ?? 'application0' });
        });
        pc.iceConnectionStateChange.subscribe((state) => this.log(`ACS ICE ${state}`));
        pc.connectionStateChange.subscribe((state) => {
          if (state === 'failed' || state === 'closed') this._dead(`ACS ${state}`);
        });
        pc.onTrack.subscribe((track) => {
          if (track.kind !== 'video') return;
          this.track = track;
          track.onReceiveRtp.subscribe((rtp) => {
            if (this.closed) return;
            if (this.packets++ === 0) gotFirstPacket();
            this.bytes += rtp.payload.length;
            this.onPacket(this, rtp);
          });
        });
        await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        remoteReady = true;
        for (const c of pendingCandidates.splice(0)) addCandidate(c);
        await pc.setLocalDescription(await pc.createAnswer());
        return pc.localDescription.sdp;
      },
      onRemoteCandidate: async (c) => {
        if (!c.candidate) return;
        if (!remoteReady) pendingCandidates.push(c);
        else await addCandidate(c);
      },
      onClose: () => this._dead('signaling closed'),
    });
    await connected;
  }

  requestKeyframe() {
    const transceiver = this.pc && this.pc.getTransceivers().find((t) => t.kind === 'video');
    if (transceiver && this.track && this.track.ssrc) transceiver.receiver.sendRtcpPLI(this.track.ssrc);
  }

  _dead(reason) {
    if (this.closed) return;
    this.log(`ACS stream ended: ${reason}`);
    this.close();
    if (this.onDead) this.onDead(this);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.session) this.session.close();
    if (this.pc) this.pc.close().catch(() => {});
  }
}

// One camera's live video, shared by any number of viewers. Can move to another
// quality level while viewers keep watching.
class CameraStream {
  constructor({
    acs, camera, profile, auto, log, onClose, onProfileChanged,
  }) {
    this.acs = acs;
    this.camera = camera;
    this.profile = profile;
    this.auto = auto; // true when the quality may be changed automatically
    this.log = log;
    this.onClose = onClose;
    this.onProfileChanged = onProfileChanged;
    this.viewers = new Set();
    this.closed = false;
    this.packets = 0;
    this.sampleBytes = 0;
    // Packets since the latest keyframe, replayed to new viewers so their picture starts at once
    // (ACS sends a keyframe only every few seconds and ignores keyframe requests).
    this.gop = [];
    this.gopTimestamp = null;
    this.gopOverflow = true;
    this.ready = this._startActive();
    this.ready.catch((err) => {
      this.log(`ACS stream failed: ${err.message}`);
      this.close();
    });
    this.statsTimer = setInterval(() => {
      this.log(`${this.profile}: forwarded ${this.packets} packets to ${this.viewers.size} viewer(s)`);
    }, 60000);
  }

  _newUpstream(profile) {
    return new Upstream({
      acs: this.acs,
      camera: this.camera,
      profile,
      log: this.log,
      onPacket: (up, rtp) => this._onPacket(up, rtp),
      onDead: (up) => {
        if (up === this.active) this.close();
        if (up === this.pending) this.pending = null;
      },
    });
  }

  // ACS occasionally doesn't complete ICE on the first try; retry once, keeping viewers attached.
  async _startActive() {
    for (let attempt = 1; ; attempt++) {
      const up = this._newUpstream(this.profile);
      this.active = up;
      try {
        await up.start();
        this.log(`${this.profile}: first video packet from ACS`);
        return;
      } catch (err) {
        up.close();
        if (this.closed || attempt >= 2) throw err;
        this.log(`ACS attempt ${attempt} failed (${err.message}), retrying`);
      }
    }
  }

  // Moves to another quality level. The new stream takes over at its first keyframe.
  switchProfile(profile, reason) {
    if (this.closed || this.pending || profile === this.profile) return false;
    this.log(`switching ${this.profile} -> ${profile} (${reason})`);
    const up = this._newUpstream(profile);
    this.pending = up;
    up.start().catch((err) => {
      this.log(`switch to ${profile} failed: ${err.message}`);
      up.close();
      if (this.pending === up) this.pending = null;
    });
    // Give up if the new stream never reaches a keyframe.
    setTimeout(() => {
      if (this.pending === up) {
        this.log(`switch to ${profile} timed out`);
        up.close();
        this.pending = null;
      }
    }, UPSTREAM_TIMEOUT_MS + 10000);
    return true;
  }

  _onPacket(up, rtp) {
    if (up === this.pending) {
      if (!startsKeyframe(rtp.payload)) return;
      // Hand over at the keyframe: viewers continue numbering from where they were.
      const old = this.active;
      this.active = up;
      this.pending = null;
      this.profile = up.profile;
      this.gop = [];
      this.gopTimestamp = null;
      for (const viewer of this.viewers) viewer.sourceChanged(rtp.header);
      if (old) old.close();
      this.log(`now streaming ${this.profile}`);
      if (this.onProfileChanged) this.onProfileChanged(this, this.profile);
    }
    if (up !== this.active) return;
    this.packets++;
    this.sampleBytes += rtp.payload.length;
    this._forward(rtp);
  }

  _forward(rtp) {
    // Each viewer's sender rewrites the header in place, so hand out serialized copies.
    const buf = rtp.serialize();
    if (startsKeyframe(rtp.payload) && rtp.header.timestamp !== this.gopTimestamp) {
      this.gop = [];
      this.gopTimestamp = rtp.header.timestamp;
      this.gopOverflow = false;
    }
    if (!this.gopOverflow) {
      if (this.gop.length < GOP_CACHE_MAX_PACKETS) this.gop.push(buf);
      else { this.gop = []; this.gopOverflow = true; }
    }
    for (const viewer of this.viewers) {
      try {
        viewer.track.writeRtp(buf);
      } catch (err) {
        this.log(`dropping viewer after write error: ${err.message}`);
        viewer.close();
      }
    }
  }

  // kbit/s received from ACS since the last call.
  takeKbps(elapsedMs) {
    const kbps = (this.sampleBytes * 8) / elapsedMs;
    this.sampleBytes = 0;
    return kbps;
  }

  // Called once the viewer's connection is up: replay the current GOP, then go live.
  addViewer(viewer) {
    clearTimeout(this.lingerTimer);
    if (!this.gopOverflow) {
      for (const buf of this.gop) viewer.track.writeRtp(buf);
    }
    this.viewers.add(viewer);
    this.log(`viewer joined (${this.viewers.size} watching, replayed ${this.gopOverflow ? 0 : this.gop.length} cached packets)`);
    this.requestKeyframe();
  }

  reserve() {
    clearTimeout(this.lingerTimer);
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
    if (this.active) this.active.requestKeyframe();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.statsTimer);
    clearTimeout(this.lingerTimer);
    this.log(`ACS stream closed after ${this.packets} packets`);
    if (this.active) this.active.close();
    if (this.pending) this.pending.close();
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
      if (state === 'connected' && !this.closed && !this.joined) {
        this.joined = true;
        this.stream.addViewer(this);
      }
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
    this.sender = transceiver.sender;
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

    // Keep the ACS stream from lingering-closing while this viewer connects.
    this.stream.reserve();
    return pc.localDescription.sdp;
  }

  keepAlive() {
    this.lastHeard = Date.now();
  }

  // The camera stream moved to another ACS stream: continue sequence numbers and
  // timestamps from where this viewer was, with a small gap to mark the change.
  sourceChanged(header) {
    if (this.sender && this.sender.sequenceNumber !== undefined) this.sender.replaceRTP(header, true);
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

// Keeps one CameraStream per camera, hands out viewer sessions and steps quality
// down when the app uses too much CPU.
class LiveRelay {
  constructor({ acs, log = () => {}, onProfileLearned }) {
    this.acs = acs;
    this.log = log;
    this.onProfileLearned = onProfileLearned;
    this.streams = new Map(); // key: sourceId
    this.cpuSamples = [];
    this.lastSwitch = 0;
    this.lastStatus = 0;
    this.lastSampleAt = Date.now();
    this.cpu = new quality.CpuMonitor({ onSample: (pct) => this._onCpuSample(pct) });
  }

  // mode: 'auto' or a fixed profile. startProfile: where an auto stream begins.
  async openViewer({
    camera, mode = 'auto', startProfile = 'medium', viewerOfferSdp, onClose,
  }) {
    const auto = mode === 'auto';
    const profile = auto ? startProfile : mode;
    let stream = this.streams.get(camera.sourceId);
    if (stream && !stream.closed && stream.auto !== auto) stream.close();
    if (stream && !stream.closed && !auto && stream.profile !== profile) stream.close();
    stream = this.streams.get(camera.sourceId);
    if (!stream || stream.closed) {
      const key = camera.sourceId;
      stream = new CameraStream({
        acs: this.acs,
        camera,
        profile,
        auto,
        log: (...args) => this.log(`[${camera.name}]`, ...args),
        onClose: (s) => { if (this.streams.get(key) === s) this.streams.delete(key); },
        onProfileChanged: (s, p) => { if (s.auto && this.onProfileLearned) this.onProfileLearned(camera.sourceId, p); },
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

  _onCpuSample(percent) {
    const now = Date.now();
    const elapsed = now - this.lastSampleAt;
    this.lastSampleAt = now;
    const streams = [...this.streams.values()].filter((s) => !s.closed);
    const rates = new Map(streams.map((s) => [s, s.takeKbps(elapsed)]));
    this.cpuSamples.push(percent);
    if (this.cpuSamples.length > 2) this.cpuSamples.shift();
    const avg = this.cpuSamples.reduce((a, b) => a + b, 0) / this.cpuSamples.length;
    if (!streams.length) return;

    if (now - this.lastStatus > 60000) {
      this.lastStatus = now;
      this.log(`CPU ${Math.round(avg)}%; ${streams.map((s) => `${s.camera.name}: ${s.profile}${s.auto ? ' (auto)' : ''} ${Math.round(rates.get(s))} kbit/s`).join(', ')}`);
    }
    if (now - this.lastSwitch < quality.SWITCH_COOLDOWN_MS || this.cpuSamples.length < 2) return;

    const critical = avg > quality.CPU_CRITICAL;
    if (!critical && avg <= quality.CPU_HIGH) return;
    const candidates = streams
      .filter((s) => !s.pending && quality.lower(s.profile) && (s.auto || critical))
      .sort((a, b) => rates.get(b) - rates.get(a));
    const target = candidates[0];
    if (!target) return;
    if (target.switchProfile(quality.lower(target.profile), `CPU ${Math.round(avg)}%${critical ? ', critical' : ''}`)) {
      this.lastSwitch = now;
      this.cpuSamples = [];
    }
  }

  closeCamera(sourceId) {
    const stream = this.streams.get(sourceId);
    if (stream) stream.close();
  }

  closeAll() {
    for (const stream of [...this.streams.values()]) stream.close();
    this.cpu.stop();
  }
}

module.exports = LiveRelay;
module.exports.pickViewerH264 = pickViewerH264;
