'use strict';

// Checks the H.264 picker against a Chrome-style offer with several H.264 variants.
const assert = require('node:assert');
const { pickViewerH264 } = require('../lib/live-relay');

const offer = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103 104 105 127',
  'a=rtpmap:96 VP8/90000', 'a=rtcp-fb:96 nack',
  'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96',
  'a=rtpmap:102 H264/90000', 'a=rtcp-fb:102 nack pli', 'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f',
  'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102',
  'a=rtpmap:104 H264/90000', 'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:105 rtx/90000', 'a=fmtp:105 apt=104',
  'a=rtpmap:127 H264/90000', 'a=fmtp:127 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f',
  'a=mid:1', '',
].join('\r\n');

const r = pickViewerH264(offer);
assert.ok(r.chosen.startsWith('127 '), r.chosen);
assert.match(r.sdp, /m=video 9 UDP\/TLS\/RTP\/SAVPF 127\r\n/);
assert.doesNotMatch(r.sdp, /rtpmap:96 /);
assert.match(r.sdp, /m=audio 9 UDP\/TLS\/RTP\/SAVPF 111/);
console.log('ok', r.chosen);
