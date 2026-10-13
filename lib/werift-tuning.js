'use strict';

// Performance patch for werift's SRTP ciphers.
//
// werift passes raw Buffer keys to crypto.createCipheriv/createHmac for every packet,
// which makes Node rebuild a key object each time. Converting the session keys to
// KeyObjects once makes per-packet encryption about 2x cheaper, which matters on
// Homey's small CPU. Behaviour is unchanged.

const path = require('node:path');
const crypto = require('node:crypto');

const KEY_FIELDS = ['srtpSessionKey', 'srtcpSessionKey', 'srtpSessionAuthTag', 'srtcpSessionAuthTag'];

function toKeyObjects(cipher) {
  if (cipher._keyObjectsReady) return;
  for (const field of KEY_FIELDS) {
    if (Buffer.isBuffer(cipher[field])) cipher[field] = crypto.createSecretKey(cipher[field]);
  }
  cipher._keyObjectsReady = true;
}

function patchClass(Cls) {
  if (!Cls || Cls.prototype._tuned) return;
  for (const method of ['encryptRtp', 'decryptRtp', 'encryptRTCP', 'decryptRTCP']) {
    const original = Cls.prototype[method];
    if (typeof original !== 'function') continue;
    Cls.prototype[method] = function tuned(...args) {
      toKeyObjects(this);
      return original.apply(this, args);
    };
  }
  Cls.prototype._tuned = true;
}

function applyWeriftTuning() {
  // Deep paths are not in werift's package exports, so resolve them from its main entry.
  let root = path.dirname(require.resolve('werift'));
  while (path.basename(root) !== 'werift' && root !== path.dirname(root)) root = path.dirname(root);
  const dir = path.join(root, 'lib', 'rtp', 'src', 'srtp', 'cipher');
  patchClass(require(path.join(dir, 'gcm.js')).CipherAesGcm);
  patchClass(require(path.join(dir, 'ctr.js')).CipherAesCtr);
}

module.exports = { applyWeriftTuning };
