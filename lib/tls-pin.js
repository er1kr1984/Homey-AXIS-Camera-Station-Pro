'use strict';

// Certificate pinning for Camera Station's self-signed HTTPS certificates.
//
// Camera Station uses self-signed certificates, so normal certificate checks can't be
// used. Instead the app remembers each port's certificate fingerprint when the user logs
// in (trust on first use) and refuses to talk to a server that presents a different one,
// so the login is never sent to another device that took over the address.

const https = require('node:https');
const tls = require('node:tls');
const { AcsError } = require('./errors');

// SHA-256 fingerprint of the certificate a server presents (no credentials are sent).
function fetchFingerprint(host, port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: undefined, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.fingerprint256) reject(new AcsError('unreachable', `No certificate from ${host}:${port}`));
      else resolve(cert.fingerprint256);
    });
    socket.on('timeout', () => socket.destroy(new AcsError('unreachable', `Timeout connecting to ${host}:${port}`)));
    socket.on('error', (err) => reject(err instanceof AcsError ? err : new AcsError('unreachable', err.message)));
  });
}

// An https.Agent that only hands out connections whose certificate matches the pin for
// that port. getPin(port) returns the stored fingerprint or null; with no pin yet, the
// first certificate seen is reported through onNewPin(port, fingerprint) and trusted.
class PinnedAgent extends https.Agent {
  constructor({ getPin, onNewPin, ...options }) {
    super({ keepAlive: true, ...options, rejectUnauthorized: false });
    this.getPin = getPin;
    this.onNewPin = onNewPin;
  }

  createConnection(options, callback) {
    const socket = tls.connect({ ...options, rejectUnauthorized: false });
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      if (err) {
        socket.destroy();
        callback(err);
      } else {
        callback(null, socket);
      }
    };
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const seen = cert && cert.fingerprint256;
      const port = Number(options.port);
      const pinned = this.getPin(port);
      if (!seen) return finish(new AcsError('unreachable', 'No certificate presented'));
      if (!pinned) {
        if (this.onNewPin) this.onNewPin(port, seen);
        return finish(null);
      }
      if (pinned !== seen) return finish(new AcsError('cert_changed', `Certificate on port ${port} changed`));
      return finish(null);
    });
    socket.once('error', (err) => finish(err));
    // Returning nothing: the request waits for the callback, so no data is sent before the check.
    return undefined;
  }
}

module.exports = { fetchFingerprint, PinnedAgent };
