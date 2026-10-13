'use strict';

// Finds AXIS Camera Station Pro servers on the local /24 by asking each address
// for the web client configuration (https://<ip>/web-client/config).

const https = require('node:https');

function probe(host, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get({
      host, port: 443, path: '/web-client/config', rejectUnauthorized: false, timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 20000) req.destroy(); });
      res.on('end', () => {
        try {
          const cfg = JSON.parse(data);
          resolve(cfg && cfg.signalServerUrl ? host : null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function discoverAcs(localAddress, { concurrency = 48, timeoutMs = 1500 } = {}) {
  const base = localAddress.split('.').slice(0, 3).join('.');
  const hosts = [];
  for (let i = 1; i < 255; i++) hosts.push(`${base}.${i}`);
  const found = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++];
      if (await probe(host, timeoutMs)) found.push(host);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found;
}

module.exports = { discoverAcs, probe };
