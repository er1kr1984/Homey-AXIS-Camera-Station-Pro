'use strict';

// The tuned werift functions must behave exactly like the originals.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { applyWeriftTuning, weriftRoot } = require('../lib/werift-tuning');

applyWeriftTuning();
const root = weriftRoot();
const binary = require(path.join(root, 'lib', 'common', 'src', 'binary.js'));
const { RtpHeader, RtpPacket } = require(path.join(root, 'lib', 'rtp', 'src', 'rtp', 'rtp.js'));
const common = require(path.join(root, 'lib', 'common', 'src'));

const plain = (h) => JSON.parse(JSON.stringify({ ...h, extensions: h.extensions.map((e) => ({ id: e.id, p: e.payload.toString('hex') })) }));

test('getBit matches the original for every byte, start and length', () => {
  for (let b = 0; b < 256; b++) {
    for (let s = 0; s < 8; s++) {
      for (let l = 1; s + l <= 8; l++) assert.strictEqual(binary.getBit(b, s, l), binary.getBit.original(b, s, l));
    }
  }
  assert.strictEqual(common.getBit, binary.getBit, 'callers through the common index see the fast version');
});

function randomPacket({ ext = false, csrc = 0, padding = false } = {}) {
  const payload = crypto.randomBytes(1 + crypto.randomInt(1200));
  const h = new RtpHeader({
    padding,
    marker: Math.random() < 0.5,
    payloadType: crypto.randomInt(128),
    sequenceNumber: crypto.randomInt(65536),
    timestamp: crypto.randomInt(2 ** 32),
    ssrc: crypto.randomInt(2 ** 32),
    csrc: Array.from({ length: csrc }, () => crypto.randomInt(2 ** 32)),
    extensions: ext ? [{ id: 1, payload: crypto.randomBytes(2) }, { id: 3, payload: crypto.randomBytes(3) }] : [],
  });
  const pkt = new RtpPacket(h, payload);
  return pkt;
}

test('RTP header parse and write match the original', () => {
  for (let i = 0; i < 3000; i++) {
    const opts = { ext: i % 7 === 0, csrc: i % 5 === 0 ? crypto.randomInt(4) : 0 };
    const pkt = randomPacket(opts);
    const fast = pkt.serialize();
    const slow = (() => {
      const h = pkt.header;
      const buf = RtpHeader.prototype.originalSerialize.call(h, h.serializeSize + pkt.payload.length);
      pkt.payload.copy(buf, h.payloadOffset);
      return buf;
    })();
    assert.deepStrictEqual(fast, slow, 'serialized bytes');
    assert.deepStrictEqual(plain(RtpHeader.deSerialize(fast)), plain(RtpHeader.originalDeSerialize(fast)), 'parsed header');
  }
});

test('padding is parsed like the original', () => {
  const buf = Buffer.from('a060000100000002000000030102030400000004', 'hex');
  assert.deepStrictEqual(plain(RtpHeader.deSerialize(buf)), plain(RtpHeader.originalDeSerialize(buf)));
});
