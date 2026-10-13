'use strict';

// Renders the status widget in headless Chrome with live data from Camera Station.
// Usage: ACS_HOST=.. ACS_USER=.. ACS_PASS=.. CHROME_PUPPETEER=<dir> SHOT=out.png node test/widget-status.js
const path = require('node:path');
const fs = require('node:fs');
const AcsClient = require('../lib/acs-client');
const StatusBoard = require('../lib/status-board');

const puppeteer = require(path.join(process.env.CHROME_PUPPETEER, 'node_modules', 'puppeteer'));
const locales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', process.env.LANG_FILE || 'en.json'), 'utf8'));

(async () => {
  const acs = new AcsClient({ host: process.env.ACS_HOST, username: process.env.ACS_USER, password: process.env.ACS_PASS });
  const sys = await acs.getSystem();
  const app = {
    servers: { list: () => [{ id: sys.Id, name: sys.Name, version: sys.ServerDisplayVersion }] },
    getAcs: () => acs,
    serverIdFor: () => sys.Id,
    _cameraName: () => null,
    friendly: (e) => e.message,
    homey: { drivers: { getDriver: () => ({ getDevices: () => [] }) } },
  };
  const board = new StatusBoard({ app });
  const t0 = Date.now();
  const data = await board.get();
  console.log(`status in ${Date.now() - t0} ms:`, data.servers.map((s) => `${s.name} ${s.online}/${s.total}, ${s.events.length} events, health ${JSON.stringify(s.health)}`));
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('PAGE', m.text()));
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.setViewport({ width: 380, height: 800, deviceScaleFactor: 2 });
  await page.exposeFunction('mockApi', async (method, p) => {
    if (p === '/status') return board.get();
    throw new Error(`unexpected ${p}`);
  });
  await page.setContent(fs.readFileSync(path.join(__dirname, '..', 'widgets', 'status', 'public', 'index.html'), 'utf8'));
  await page.evaluate((loc) => {
    const get = (k) => k.split('.').reduce((o, x) => (o || {})[x], loc);
    window.onHomeyReady({
      api: (m, p, b) => window.mockApi(m, p, b),
      __: (k, vars) => String(get(k) || k).replace(/__(\w+)__/g, (_, v) => (vars && vars[v] !== undefined ? vars[v] : '')),
      ready: () => {}, setHeight: (h) => { window.widgetHeight = h; }, hapticFeedback: () => {},
    });
  }, locales);
  await new Promise((r) => setTimeout(r, 1500));
  console.log('height', await page.evaluate(() => window.widgetHeight));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
