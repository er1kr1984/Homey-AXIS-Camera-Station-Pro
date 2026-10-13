'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isNonReferenceSlice } = require('../lib/live-relay');

test('non-reference slices are droppable, everything else is kept', () => {
  assert.strictEqual(isNonReferenceSlice(Buffer.from([0x01, 0x9a])), true); // slice, nri 0
  assert.strictEqual(isNonReferenceSlice(Buffer.from([0x41, 0x9a])), false); // slice, nri 2 (P-frame)
  assert.strictEqual(isNonReferenceSlice(Buffer.from([0x1c, 0x81])), true); // FU-A, nri 0, inner slice
  assert.strictEqual(isNonReferenceSlice(Buffer.from([0x5c, 0x81])), false); // FU-A, nri 2
  assert.strictEqual(isNonReferenceSlice(Buffer.from([0x1c, 0x85])), false); // FU-A inner IDR
  assert.strictEqual(isNonReferenceSlice(Buffer.from([0x65, 0x88])), false); // IDR
  assert.strictEqual(isNonReferenceSlice(Buffer.from([0x78, 0x00])), false); // STAP-A
  assert.strictEqual(isNonReferenceSlice(Buffer.from([0x06, 0x05])), false); // SEI
});
