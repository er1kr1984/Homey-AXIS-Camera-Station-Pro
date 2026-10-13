'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { chooseStartProfile, lower } = require('../lib/quality');

const p = (r, f) => ({ Resolution: r, Framerate: f });

test('picks the largest profile up to 720p15', () => {
  assert.strictEqual(chooseStartProfile({ High: p('2592x1944', 30), Medium: p('1024x768', 15), Low: p('480x360', 8) }), 'medium');
  assert.strictEqual(chooseStartProfile({ High: p('1280x720', 15), Medium: p('640x360', 15), Low: p('480x360', 8) }), 'high');
  assert.strictEqual(chooseStartProfile({ High: p('3840x2160', 25), Medium: p('1920x1080', 15), Low: p('640x360', 8) }), 'low');
});

test('falls back to the lowest available profile', () => {
  assert.strictEqual(chooseStartProfile({ High: p('800x600', 30) }), 'high');
  assert.strictEqual(chooseStartProfile(null), 'medium');
});

test('steps down one level', () => {
  assert.strictEqual(lower('high'), 'medium');
  assert.strictEqual(lower('medium'), 'low');
  assert.strictEqual(lower('low'), null);
});
