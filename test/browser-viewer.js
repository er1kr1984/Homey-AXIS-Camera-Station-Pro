'use strict';

// A real browser (headless Chrome) as the viewer, like the dashboard widget: its offer has
// many codecs, and it must decode the forwarded H.264.
// Usage: ACS_USER=.. ACS_PASS=.. CHROME_PUPPETEER=<dir with puppeteer> node test/browser-viewer.js [camera] [seconds]
const path = require('node:path');
require('../lib/werift-tuning').applyWeriftTuning();
const AcsClient = require('../lib/acs-client');
const LiveRelay = require('../lib/live-relay');

const puppeteer = require(path.join(process.env.CHROME_PUPPETEER, 'node_modules', 'puppeteer'));
const [filter = 'p3267', secs = '8'] = process.argv.slice(2);

(async () => {
  const acs = new AcsClient({ host: '192.168.1.250', username: process.env.ACS_USER, password: process.env.ACS_PASS });
  const cam = (await acs.listCameras()).find((c) => c.name.toLowerCase().includes(filter));
  const relay = new LiveRelay({ acs, log: (...a) => console.log(...a) });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.exposeFunction('relayOffer', async (sdp) => (await relay.openViewer({ camera: cam, mode: 'low', startProfile: 'low', viewerOfferSdp: sdp })).answerSdp);
  await page.setContent('<video id=v muted autoplay playsinline></video>');
  const result = await page.evaluate(async (seconds) => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('video', { direction: 'recvonly' });
    const v = document.getElementById('v');
    pc.ontrack = (e) => { v.srcObject = e.streams[0] || new MediaStream([e.track]); };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => { if (pc.iceGatheringState === 'complete') r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 2500); });
    const offerCodecs = (pc.localDescription.sdp.match(/a=rtpmap:\d+ [A-Za-z0-9]+/g) || []).length;
    const answer = await window.relayOffer(pc.localDescription.sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    await new Promise((r) => setTimeout(r, seconds * 1000));
    let inbound = null;
    (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s; });
    return {
      offerCodecs, state: pc.connectionState,
      framesDecoded: inbound && inbound.framesDecoded, frameWidth: inbound && inbound.frameWidth, frameHeight: inbound && inbound.frameHeight,
      packetsLost: inbound && inbound.packetsLost, packetsReceived: inbound && inbound.packetsReceived, framesReceived: inbound && inbound.framesReceived, framesDropped: inbound && inbound.framesDropped, keyFramesDecoded: inbound && inbound.keyFramesDecoded, pliCount: inbound && inbound.pliCount, nackCount: inbound && inbound.nackCount, freezeCount: inbound && inbound.freezeCount, jitterBufferEmitted: inbound && inbound.jitterBufferEmittedCount, decoder: inbound && inbound.decoderImplementation,
    };
  }, Number(secs));
  console.log('BROWSER', JSON.stringify(result));
  await browser.close();
  relay.closeAll();
  process.exit(result.framesDecoded > 0 ? 0 : 2);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
