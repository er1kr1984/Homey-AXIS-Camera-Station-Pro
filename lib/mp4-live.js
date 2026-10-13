'use strict';

// Live video over plain HTTP for the dashboard widget when WebRTC can't connect (e.g. a
// phone on mobile data, where Homey can't be reached directly).
//
// Camera Station serves each camera as fragmented MP4 (/Acs/Streaming/Video/Live/Mp4):
// an init segment (ftyp + moov), then one moof + mdat pair per video frame. This source
// reads that stream, keeps the frames since the latest keyframe, and hands out what is
// new since a viewer's last request. The widget plays it with the browser's own video
// player (Media Source Extensions), which also handles B-frames. Homey only buffers bytes:
// no decryption or re-encryption per packet, so this costs less CPU than the WebRTC relay.

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const IDLE_CLOSE_MS = 15000; // close when no viewer asked for 15 s
const START_TIMEOUT_MS = 8000;

// avc1.<profile><constraints><level> from the moov's avcC box, for MediaSource.isTypeSupported.
function codecFromInit(init) {
  const i = init.indexOf('avcC');
  if (i < 0) return null;
  return `avc1.${init.subarray(i + 5, i + 8).toString('hex')}`;
}

// True when a moof box's first sample is a sync sample (keyframe).
function moofIsKeyframe(moof) {
  const trun = moof.indexOf('trun');
  if (trun < 0) return false;
  const flags = moof.readUInt32BE(trun + 4) & 0xffffff;
  let offset = trun + 12; // after size, type, version/flags, sample_count
  if (flags & 0x1) offset += 4; // data_offset
  let sampleFlags = null;
  if (flags & 0x4) sampleFlags = moof.readUInt32BE(offset); // first_sample_flags
  if (sampleFlags === null) {
    const tfhd = moof.indexOf('tfhd');
    if (tfhd < 0) return false;
    const tf = moof.readUInt32BE(tfhd + 4) & 0xffffff;
    let o = tfhd + 12; // after track_ID
    if (tf & 0x1) o += 8;
    if (tf & 0x2) o += 4;
    if (tf & 0x8) o += 4;
    if (tf & 0x10) o += 4;
    if (!(tf & 0x20)) return false;
    sampleFlags = moof.readUInt32BE(o); // default_sample_flags
  }
  return (sampleFlags & 0x10000) === 0; // sample_is_non_sync_sample not set
}

class Mp4LiveSource {
  constructor({ acs, cameraId, quality = 'low', log = () => {}, onClose }) {
    this.acs = acs;
    this.cameraId = cameraId;
    this.quality = quality;
    this.log = log;
    this.onClose = onClose;
    this.init = null;
    this.codec = null;
    this.fragments = []; // { seq, key, data } from the latest keyframe on
    this.bytes = 0;
    this.seq = 0;
    this.closed = false;
    this.pending = Buffer.alloc(0);
    this.moof = null;
    this.lastRead = Date.now();
    this.waiters = [];
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastRead > IDLE_CLOSE_MS) this.close('no viewer');
    }, 5000);
    this._open();
  }

  async _open() {
    try {
      this.res = await this.acs.openLiveMp4(this.cameraId, this.quality);
      this.res.on('data', (chunk) => this._onData(chunk));
      this.res.on('end', () => this.close('stream ended'));
      this.res.on('error', (err) => this.close(err.message));
    } catch (err) {
      this.close(err.message);
    }
  }

  _onData(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 8) {
      const size = this.pending.readUInt32BE(0);
      if (size < 8) return this.close('bad MP4 box');
      if (this.pending.length < size) break;
      const type = this.pending.toString('latin1', 4, 8);
      const box = Buffer.from(this.pending.subarray(0, size));
      this.pending = this.pending.subarray(size);
      this._onBox(type, box);
    }
    return undefined;
  }

  _onBox(type, box) {
    if (type === 'ftyp') {
      this.ftyp = box;
    } else if (type === 'moov') {
      this.init = this.ftyp ? Buffer.concat([this.ftyp, box]) : box;
      this.codec = codecFromInit(box);
    } else if (type === 'moof') {
      this.moof = box;
    } else if (type === 'mdat' && this.moof) {
      const key = moofIsKeyframe(this.moof);
      const data = Buffer.concat([this.moof, box]);
      this.moof = null;
      if (key) {
        this.fragments = [];
        this.bytes = 0;
      }
      if (!this.fragments.length && !key) return; // wait for a keyframe to start from
      this.seq += 1;
      this.fragments.push({ seq: this.seq, key, data });
      this.bytes += data.length;
      // A very long gap between keyframes: keep the newest data, the viewer re-syncs.
      while (this.bytes > MAX_BUFFER_BYTES && this.fragments.length > 1) {
        this.bytes -= this.fragments.shift().data.length;
      }
      for (const wake of this.waiters.splice(0)) wake();
    }
  }

  _ready() {
    return this.init && this.fragments.length && this.fragments[0].key;
  }

  // What a viewer needs after `after` (the last seq it has; null = starting). Waits for
  // the stream to start when it hasn't yet. Returns { codec, init?, seq, data, restart }.
  async read(after) {
    this.lastRead = Date.now();
    if (!this._ready()) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for video')), START_TIMEOUT_MS);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
      if (this.closed) throw new Error('Video stream closed');
    }
    const oldest = this.fragments[0].seq;
    // New viewer, or one that fell behind the buffer: start again from the keyframe.
    const restart = after === null || after === undefined || after < oldest - 1 || after > this.seq;
    const from = restart ? oldest : after + 1;
    const parts = this.fragments.filter((f) => f.seq >= from).map((f) => f.data);
    return {
      codec: this.codec,
      init: restart ? this.init.toString('base64') : undefined,
      seq: this.seq,
      restart,
      data: Buffer.concat(parts).toString('base64'),
    };
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.idleTimer);
    if (this.res) this.res.destroy();
    this.fragments = [];
    for (const wake of this.waiters.splice(0)) wake();
    this.log(`HTTP video closed (${reason})`);
    if (this.onClose) this.onClose(this);
  }
}

module.exports = { Mp4LiveSource, codecFromInit, moofIsKeyframe };
