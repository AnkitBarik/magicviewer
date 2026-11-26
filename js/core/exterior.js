// Potential-field extrapolation of a magnetic field outside the outer boundary
// r_o (current-free, insulating exterior): B = -grad V with
//   Q_lm(r) = Q_lm(r_o) (r_o/r)^(l+2),  S_lm(r) = -Q_lm(r) / (l+1),  T_lm = 0
// in the radial/spheroidal/toroidal convention of spectral.js.
//
// Spectral providers supply Q at r_o directly. For grid providers, B_r at r_o
// is first analysed into spherical harmonics (Gauss-Legendre quadrature when
// the colatitudes form a Gauss grid, as in MagIC).
//
// Classic script (not an ES module) so the viewer also runs from file://; see
// "How it works" in README.md. The body is not indented to keep it identical to
// the module it was converted from.

function mvExterior(MV) {
'use strict';
const { SpectralProvider, lmLayout, mRange, plmTheta } = MV;

/** Quadrature weights in cos(theta) for the given colatitudes (sum = 2). */
function latitudeWeights(colat) {
  const n = colat.length;
  const x = Array.from(colat, Math.cos);
  // Gauss-Legendre: w = 2 / ((1 - x^2) P_n'(x)^2), valid if P_n(x_j) = 0
  const w = new Float64Array(n);
  let gauss = true;
  for (let j = 0; j < n; j++) {
    // Newton-refine the node (colatitudes are often stored in single precision)
    let xj = x[j], dp = 1, shift = 0;
    for (let it = 0; it < 3; it++) {
      let p0 = 1, p1 = xj;
      for (let k = 2; k <= n; k++) [p0, p1] = [p1, ((2 * k - 1) * xj * p1 - (k - 1) * p0) / k];
      dp = (n * (xj * p1 - p0)) / (xj * xj - 1);
      const d = p1 / dp;
      if (it === 0) shift = Math.abs(d);
      xj -= d;
    }
    if (shift > 1e-5) gauss = false;
    w[j] = 2 / ((1 - xj * xj) * dp * dp);
  }
  if (gauss) return { w, gauss };
  // fallback: midpoint rule in theta
  for (let j = 0; j < n; j++) {
    const a = j === 0 ? 0 : 0.5 * (colat[j - 1] + colat[j]);
    const b = j === n - 1 ? Math.PI : 0.5 * (colat[j] + colat[j + 1]);
    w[j] = Math.cos(a) - Math.cos(b);
  }
  return { w, gauss: false };
}

/** Spherical-harmonic analysis of a shell f[t][p] (uniform phi from 0). */
function analyseShell(f, colat, nPhi, lay) {
  const { w } = latitudeWeights(colat);
  const nb = lay.ms.length, lm = lay.lmMax;
  const out = new Float64Array(2 * lm);
  const P = new Float64Array(lm), dP = new Float64Array(lm);
  const Fr = new Float64Array(nb), Fi = new Float64Array(nb);
  const dphi = (2 * Math.PI) / nPhi;
  for (let t = 0; t < colat.length; t++) {
    for (let b = 0; b < nb; b++) {
      const m = lay.ms[b];
      let sr = 0, si = 0;
      for (let p = 0; p < nPhi; p++) {
        const v = f[t * nPhi + p], a = m * p * dphi;
        sr += v * Math.cos(a);
        si -= v * Math.sin(a);
      }
      Fr[b] = sr * dphi * w[t];
      Fi[b] = si * dphi * w[t];
    }
    plmTheta(colat[t], lay, P, dP);
    for (let b = 0; b < nb; b++) {
      const st = lay.mStart[b], n = lay.lMax - lay.ms[b] + 1;
      for (let k = 0; k < n; k++) {
        out[2 * (st + k)] += Fr[b] * P[st + k];
        out[2 * (st + k) + 1] += Fi[b] * P[st + k];
      }
    }
  }
  return out;
}

/** Radii of the exterior levels: geometric from r_o (excluded) to rExt. */
function exteriorRadii(ro, rExt, levels = 32) {
  return Float64Array.from({ length: levels }, (_, k) => ro * Math.pow(rExt / ro, (k + 1) / levels));
}

/**
 * Build a SpectralProvider for the potential field on exterior levels.
 * @param base     the file's provider
 * @param vec      { ids: [rId, tId, pId] } magnetic component field ids
 * @param rExt     outermost radius (same units as base.radius)
 */
function makeExterior(base, vec, rExt, levels = 32) {
  let io = 0;
  for (let i = 1; i < base.radius.length; i++) if (base.radius[i] > base.radius[io]) io = i;
  const ro = base.radius[io];
  let lay, Q0;
  if (base.lay) {
    lay = base.lay;
    Q0 = Float64Array.from(base.coef(io).q); // coef() reuses its buffers: copy
  } else {
    const nt = base.colat.length, np = base.nPhi;
    const L = Math.max(1, Math.min(Math.floor((2 * nt) / 3), Math.floor(np / 2) - 1));
    lay = lmLayout(L, mRange(L, base.symmetry ?? 1));
    Q0 = analyseShell(base.shell(vec.ids[0], io), base.colat, np, lay);
  }
  const radius = exteriorRadii(ro, rExt, levels);
  const lm = lay.lmMax;
  const Q = new Float64Array(2 * lm), S = new Float64Array(2 * lm), T = new Float64Array(2 * lm);
  const coef = (k) => {
    const x = ro / radius[k];
    for (let q = 0; q < lm; q++) {
      const l = lay.ell[q], f = Math.pow(x, l + 2);
      Q[2 * q] = f * Q0[2 * q]; Q[2 * q + 1] = f * Q0[2 * q + 1];
      S[2 * q] = -Q[2 * q] / (l + 1); S[2 * q + 1] = -Q[2 * q + 1] / (l + 1);
    }
    return { q: Q, s: S, t: T };
  };
  const ext = new SpectralProvider({
    format: 'exterior', lay, radius, kind: 'vector', coef, info: [],
    fields: vec.ids.map((id, k) => ({ id, comp: 'rtp'[k], signed: true })),
    nTheta: 32,
  });
  ext.setGrid(base.grid.colat, base.grid.nPhi);
  if (base.lay) { // same modes and grid: share the Legendre tables
    base._tables();
    ext._P = base._P; ext._dP = base._dP; ext._sin = base._sin;
  }
  ext.ro = ro;
  return ext;
}

Object.assign(MV, { latitudeWeights, analyseShell, exteriorRadii, makeExterior });
}
(self.MV_PARTS ||= []).push(mvExterior);
