'use strict';

// Events from Camera Station's "Send HTTP notification" action rule.
//
// The app exposes a public endpoint (/api/app/<id>/event). Public means Homey does not
// ask for a login, so every request must carry the app's secret key; requests without
// it are ignored. Camera Station can fill in its trigger data, either in the address
// (GET) or in a JSON/form body (POST):
//   $(TriggerData.Type)  $(TriggerData.SourceId)  $(TriggerData.SourceName)  $(TriggerData.TimeUtc)

const crypto = require('node:crypto');

const APP_ID = 'com.erikrichardson.acswebrtc';

function getSecret(homey) {
  let secret = homey.settings.get('event_secret');
  if (!secret) {
    secret = crypto.randomBytes(18).toString('base64url');
    homey.settings.set('event_secret', secret);
  }
  return secret;
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Address shown in a camera's settings. `event=motion` marks the rule as a motion rule, so
// the motion alarm works even if Camera Station does not fill in the event type.
async function eventAddress(homey, cameraId) {
  const local = await homey.cloud.getLocalAddress();
  const q = new URLSearchParams({ key: getSecret(homey), camera: cameraId, event: 'motion' });
  return `http://${local.split(':')[0]}/api/app/${APP_ID}/event?${q}&type=$(TriggerData.Type)&time=$(TriggerData.TimeUtc)`;
}

// A placeholder Camera Station did not fill in arrives literally; treat it as missing.
function clean(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return /^\$\(TriggerData\.[A-Za-z]+\)$/.test(s) ? '' : s;
}

// Normalises query + body (any capitalisation) into { key, cameraId, source, type, time, motion }.
function parseEvent(query = {}, body = {}) {
  const all = {};
  let b = body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (e) { b = Object.fromEntries(new URLSearchParams(b)); }
  }
  for (const src of [b || {}, query || {}]) {
    for (const [k, v] of Object.entries(src)) all[k.toLowerCase().replace(/^triggerdata\./, '')] = v;
  }
  const type = clean(all.type);
  const event = clean(all.event);
  return {
    key: clean(all.key),
    cameraId: clean(all.camera || all.sourceid),
    source: clean(all.name || all.sourcename),
    type: type || (event.toLowerCase() === 'motion' ? 'Motion' : event) || 'Event',
    time: clean(all.time || all.timeutc || all.timelocal) || new Date().toISOString(),
    motion: event.toLowerCase() === 'motion' || /motion/i.test(type),
  };
}

module.exports = {
  getSecret, sameSecret, eventAddress, parseEvent,
};
