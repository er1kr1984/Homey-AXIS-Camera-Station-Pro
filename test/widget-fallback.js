'use strict';

// Loads the widget page in headless Chrome with a stand-in Homey API: tile 1's live
// video never connects (like mobile data) and must fall back to pictures; tile 2 gets a
// real live stream through the relay.
// Usage: ACS_USER=.. ACS_PASS=.. CHROME_PUPPETEER=<dir> node test/widget-fallback.js
const path = require('node:path');
const fs = require('node:fs');
require('../lib/werift-tuning').applyWeriftTuning();
const AcsClient = require('../lib/acs-client');
const LiveRelay = require('../lib/live-relay');
const { Mp4LiveSource } = require('../lib/mp4-live');

const puppeteer = require(path.join(process.env.CHROME_PUPPETEER, 'node_modules', 'puppeteer'));
const locales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'en.json'), 'utf8'));

(async () => {
  const acs = new AcsClient({ host: process.env.ACS_HOST, username: process.env.ACS_USER, password: process.env.ACS_PASS });
  const cams = await acs.listCameras();
  const m1045 = cams.find((c) => /M1045/.test(c.name));
  const p3267 = cams.find((c) => /P3267/.test(c.name));
  const mp4s = {};
  const relay = new LiveRelay({ getAcs: () => acs, log: () => {} });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 360 });
  await page.exposeFunction('mockApi', async (method, p, body) => {
    if (p === '/layout') {
      return { rows: 1, columns: 2, tiles: [
        { row: 0, column: 0, rowSpan: 1, columnSpan: 1, sourceId: p3267.sourceId, name: 'P3267 (no live)' },
        { row: 0, column: 1, rowSpan: 1, columnSpan: 1, sourceId: m1045.sourceId, name: 'M1045 (live)' }] };
    }
    if (p === '/offer') {
      if (body.sourceId === p3267.sourceId) return new Promise(() => {}); // never answers
      return { answerSdp: (await relay.openViewer({ camera: m1045, mode: 'low', startProfile: 'low', viewerOfferSdp: body.sdp })).answerSdp };
    }
    if (p === '/snapshot') return { jpeg: (await acs.getSnapshot(body.sourceId, 640, 360)).toString('base64') };
    if (p === '/mp4') {
      if (process.env.NO_HTTP_VIDEO) throw new Error('no HTTP video');
      if (!mp4s[body.sourceId]) mp4s[body.sourceId] = new Mp4LiveSource({ acs, cameraId: body.sourceId });
      return mp4s[body.sourceId].read(body.after);
    }
    throw new Error(`unexpected ${p}`);
  });
  const html = fs.readFileSync(path.join(__dirname, '..', 'widgets', 'live', 'public', 'index.html'), 'utf8');
  await page.setContent(html);
  await page.evaluate((loc) => {
    const get = (k) => k.split('.').reduce((o, x) => (o || {})[x], loc);
    window.onHomeyReady({
      getSettings: () => ({ source: { kind: 'view', id: 'x' }, quality: 'low' }),
      api: (m, p, b) => window.mockApi(m, p, b),
      __: (k) => get(k) || k,
      ready: () => {},
      hapticFeedback: () => {},
    });
  }, locales);
  await new Promise((r) => setTimeout(r, 26000));
  const state = await page.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => ({
    label: t.querySelector('.label').textContent,
    live: t.classList.contains('live'),
    pictureShown: !t.querySelector('img').hidden && t.querySelector('img').src.startsWith('data:image/jpeg'),
    badge: t.querySelector('.badge').hidden ? null : t.querySelector('.badge').textContent,
    videoPlaying: t.querySelector('video').readyState >= 2 && !t.querySelector('video').paused,
    currentTime: t.querySelector('video').currentTime,
    viaHttp: !!t.querySelector('video').getAttribute('src'),
  })));
  console.log(JSON.stringify(state, null, 1));
  await browser.close();
  relay.closeAll();
  for (const m of Object.values(mp4s)) m.close('test done');
  // The tile that can't go live must end in a working state: HTTP video playing, or
  // (when this browser can't play it, e.g. headless Chrome here) pictures.
  const httpPlaying = state[0].viaHttp && state[0].videoPlaying && state[0].badge === 'VIA HOMEY';
  const pictures = state[0].pictureShown && state[0].badge === 'PICTURE';
  console.log(`fallback tile: ${httpPlaying ? 'HTTP video playing' : pictures ? 'pictures' : 'NOT WORKING'}`);
  const fallbackOk = process.env.NO_HTTP_VIDEO ? pictures : (httpPlaying || pictures);
  const ok = fallbackOk && state[1].videoPlaying && !state[1].badge;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
