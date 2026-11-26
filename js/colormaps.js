// Colormaps as evenly spaced sRGB control points (sampled from matplotlib / cmocean).
//
// Classic script (not an ES module) so the viewer also runs from file://; see
// "How it works" in README.md. The body is not indented to keep it identical to
// the module it was converted from.

function mvColormaps(MV) {
'use strict';

const MAPS = {
  RdBu_r: ['#053061', '#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7', '#fddbc7', '#f4a582', '#d6604d', '#b2182b', '#67001f'],
  seismic: ['#00004c', '#0000e6', '#8080ff', '#ffffff', '#ff8080', '#e60000', '#800000'],
  coolwarm: ['#3b4cc0', '#6788ee', '#9abbff', '#c9d7f0', '#edd1c2', '#f7a889', '#e26952', '#b40426'],
  RdYlBu_r: ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027', '#a50026'],
  // matplotlib PRGn reversed: green (negative) -> white -> purple (positive)
  PRGn_r: ['#00441b', '#1b7837', '#5aae61', '#a6dba0', '#d9f0d3', '#f7f7f7', '#e7d4e8', '#c2a5cf', '#9970ab', '#762a83', '#40004b'],
  PuOr_r: ['#2d004b', '#542788', '#8073ac', '#b2abd2', '#d8daeb', '#f7f7f7', '#fee0b6', '#fdb863', '#e08214', '#b35806', '#7f3b08'],
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  magma: ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  cividis: ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8779', '#a69d75', '#c4b56c', '#e4cf5b', '#fee838'],
  gray: ['#000000', '#ffffff'],
};

const DIVERGING = ['RdBu_r', 'PRGn_r', 'seismic', 'coolwarm', 'RdYlBu_r', 'PuOr_r'];
const SEQUENTIAL = ['viridis', 'magma', 'inferno', 'cividis', 'gray'];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

/** 256-entry Float32Array RGB lookup table. */
function lut(name, reverse = false) {
  const pts = (MAPS[name] ?? MAPS.RdBu_r).map(hex);
  const n = 256, out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const t = (reverse ? n - 1 - i : i) / (n - 1);
    const x = t * (pts.length - 1), k = Math.min(pts.length - 2, Math.floor(x)), f = x - k;
    for (let c = 0; c < 3; c++) out[3 * i + c] = pts[k][c] * (1 - f) + pts[k + 1][c] * f;
  }
  return out;
}

Object.assign(MV, { DIVERGING, SEQUENTIAL, lut });
}
(self.MV_PARTS ||= []).push(mvColormaps);
