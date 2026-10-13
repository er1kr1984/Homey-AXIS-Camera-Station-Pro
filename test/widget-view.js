'use strict';

// Loads the widget page in headless Chrome with a Camera Station view (all tiles live
// through the relay, like on the home network) and reports what every tile shows.
// Usage: ACS_HOST=.. ACS_USER=.. ACS_PASS=.. CHROME_PUPPETEER=<dir> node test/widget-view.js [view name] [seconds]
const path = require('node:path');
const fs = require('node:fs');
require('../lib/werift-tuning').applyWeriftTuning();
const AcsClient = require('../lib/acs-client');
const LiveRelay = require('../lib/live-relay');
const { Mp4LiveSource } = require('../lib/mp4-live');

const puppeteer = require(path.join(process.env.CHROME_PUPPETEER, 'node_modules', 'puppeteer'));
const locales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'en.json'), 'utf8'));
const [viewName = '', secs = '20'] = process.argv.slice(2);

(async () => {
  const acs = new AcsClient({ host: process.env.ACS_HOST, username: process.env.ACS_USER, password: process.env.ACS_PASS });
  const views = await acs.listViews();
  const view = views.find((v) => v.name.toLowerCase().includes(viewName.toLowerCase()) && v.tiles.length > 1);
  console.log('view', view.name, view.tiles.map((t) => t.camera.name));
  const mp4s = {};
  const calls = [];
  const relay = new LiveRelay({ getAcs: () => acs, log: (...a) => (process.env.VERBOSE ? console.log(...a) : null) });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('PAGE', m.text()));
  await page.setViewport({ width: 800, height: 450 });
  await page.exposeFunction('mockApi', async (method, p, body) => {
    calls.push(`${p} ${(body && body.sourceId) || ''}`.trim());
    if (p === '/layout') {
      let rows = 1; let columns = 1;
      for (const t of view.tiles) { rows = Math.max(rows, t.row + t.rowSpan); columns = Math.max(columns, t.column + t.columnSpan); }
      return { rows, columns, tiles: view.tiles.map((t) => ({ row: t.row, column: t.column, rowSpan: t.rowSpan, columnSpan: t.columnSpan, sourceId: t.camera.sourceId, name: t.camera.name })) };
    }
    if (p === '/offer') {
      const tile = view.tiles.find((t) => t.camera.sourceId === body.sourceId);
      return { answerSdp: (await relay.openViewer({ camera: tile.camera, mode: 'low', startProfile: 'low', viewerOfferSdp: body.sdp })).answerSdp };
    }
    if (p === '/snapshot') return { jpeg: (await acs.getSnapshot(body.sourceId, 640, 360)).toString('base64') };
    if (p === '/report') { console.log('REPORT', JSON.stringify(body)); return { ok: true }; }
    if (p === '/mp4') {
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
  for (let s = 0; s < Number(secs); s += 5) {
    await new Promise((r) => setTimeout(r, 5000));
    const state = await page.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => {
      const v = t.querySelector('video');
      return `${t.querySelector('.label').textContent}: live=${t.classList.contains('live')} badge=${t.querySelector('.badge').hidden ? '-' : t.querySelector('.badge').textContent} status=${t.querySelector('.status').textContent} rtc=${!!v.srcObject} ready=${v.readyState} paused=${v.paused} t=${v.currentTime.toFixed(1)} ${v.videoWidth}x${v.videoHeight} img=${!t.querySelector('img').hidden}`;
    }));
    console.log(`--- ${s + 5} s`); state.forEach((l) => console.log('  ', l));
  }
  // What is actually on screen: average brightness of each tile in a screenshot.
  const shot = await page.screenshot({ encoding: 'base64' });
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => { const r = t.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
  const png = await page.evaluate(async (b64, bx) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return bx.map(([x, y, w, h]) => { const d = g.getImageData(x + 2, y + 2, w - 4, h - 4).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3; return Math.round(s / (d.length / 4)); });
  }, shot, boxes);
  console.log('ON SCREEN brightness per tile', JSON.stringify(png));
  if (process.env.SHOT) require('node:fs').writeFileSync(process.env.SHOT, Buffer.from(shot, 'base64'));
  console.log('calls', calls.filter((c) => !c.startsWith('/mp4')).join(' | '));
  await browser.close();
  relay.closeAll();
  for (const m of Object.values(mp4s)) m.close('test done');
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
