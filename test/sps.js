'use strict';
// Minimal H.264 SPS parser: width/height (enough for typical camera streams).
module.exports = function parseSps(nal) {
  const rbsp = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    rbsp.push(nal[i]);
  }
  let pos = 0;
  const bit = () => (rbsp[pos >> 3] >> (7 - (pos++ & 7))) & 1;
  const bits = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bit(); return v; };
  const ue = () => { let z = 0; while (!bit()) z++; return (1 << z) - 1 + bits(z); };
  const se = () => { const v = ue(); return v & 1 ? (v + 1) / 2 : -v / 2; };
  const profile = bits(8); bits(16); ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128].includes(profile)) {
    const chroma = ue(); if (chroma === 3) bit(); ue(); ue(); bit();
    if (bit()) for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) if (bit()) { let last = 8, next = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; } }
  }
  ue(); const poc = ue();
  if (poc === 0) ue(); else if (poc === 1) { bit(); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
  ue(); bit();
  const wMbs = ue() + 1; const hMapUnits = ue() + 1; const frameMbsOnly = bit();
  if (!frameMbsOnly) bit(); bit();
  let [cl, cr, ct, cb] = [0, 0, 0, 0];
  if (bit()) { cl = ue(); cr = ue(); ct = ue(); cb = ue(); }
  const w = wMbs * 16 - (cl + cr) * 2; const h = (2 - frameMbsOnly) * hMapUnits * 16 - (ct + cb) * 2;
  return { profile, width: w, height: h };
};
