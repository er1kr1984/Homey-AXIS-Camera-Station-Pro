'use strict';

// Measures the relay's own CPU with a fixed synthetic load.
// Usage: TUNE=1 RATE=200 VIEWERS=1 node bench/relay-bench.js
const { fork } = require('node:child_process');
const path = require('node:path');

if (process.env.TUNE) require('../lib/werift-tuning').applyWeriftTuning();
const LiveRelay = require('../lib/live-relay');

const child = fork(path.join(__dirname, 'peers.js'), { env: process.env });
const waiters = [];
child.on('message', (m) => { for (const w of waiters.slice()) w(m); });
const next = (type, pred = () => true) => new Promise((res) => {
  const w = (m) => { if (m.type === type && pred(m)) { waiters.splice(waiters.indexOf(w), 1); res(m); } };
  waiters.push(w);
});

// Fake AcsClient: the "camera" lives in the child process.
const acs = {
  async startLiveSession({ onOffer, onRemoteCandidate }) {
    const offerP = next('acsOffer');
    child.send({ type: 'acsStart' });
    child.on('message', (m) => { if (m.type === 'acsCandidate') onRemoteCandidate(m.candidate); });
    const { sdp } = await offerP;
    const answer = await onOffer(sdp, []);
    child.send({ type: 'acsAnswer', sdp: answer });
    return { sendCandidate: (candidate) => child.send({ type: 'relayCandidate', candidate }), close() {} };
  },
};

(async () => {
  const relay = new LiveRelay({ acs, log: () => {} });
  const camera = { name: 'bench', sourceId: 'bench_1', orgId: 'o', targetId: 't' };
  child.send({ type: 'viewersStart' });
  const viewers = Number(process.env.VIEWERS || 1);
  for (let i = 0; i < viewers; i++) {
    const { sdp } = await next('viewerOffer', (m) => m.i === i);
    const { answerSdp } = await relay.openViewer({ camera, mode: 'auto', startProfile: 'medium', viewerOfferSdp: sdp });
    child.send({ type: 'viewerAnswer', i, sdp: answerSdp });
  }
  await new Promise((r) => setTimeout(r, 4000));
  const statsP0 = next('stats'); child.send({ type: 'stats' }); const s0 = (await statsP0).received;
  const c0 = process.cpuUsage(); const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 15000));
  const c = process.cpuUsage(c0); const wall = (Date.now() - t0) / 1000;
  const statsP1 = next('stats'); child.send({ type: 'stats' }); const s1 = (await statsP1).received;
  const delivered = (s1 - s0) / wall;
  console.log(JSON.stringify({
    tune: !!process.env.TUNE, rate: Number(process.env.RATE || 200), viewers, deliveredPerSec: Math.round(delivered),
    relayCpuPercent: +(((c.user + c.system) / 1e6 / wall) * 100).toFixed(1),
    relayUsPerDeliveredPacket: Math.round((c.user + c.system) / (s1 - s0)),
  }));
  child.kill();
  process.exit(0);
})().catch((e) => { console.error(e); child.kill(); process.exit(1); });
