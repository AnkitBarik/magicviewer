// Spherical-harmonic helpers.
//
// Reference convention ("MagIC convention"): fully normalised associated
// Legendre functions WITHOUT Condon-Shortley phase,
//   P_lm(theta) = sqrt((2l+1)/(4 pi) (l-m)!/(l+m)!) P_l^m(cos theta),
// and a real field is reconstructed as
//   f(theta, phi) = sum_{m>=0} w_m Re[ F_m(theta) e^{i m phi} ],  w_0 = 1, w_m = 2.
// Format adapters convert their coefficients to this convention.
//
// Classic script (not an ES module) so the viewer also runs from file://; see
// "How it works" in README.md. The body is not indented to keep it identical to
// the module it was converted from.

function mvSht(MV) {
'use strict';

/** Number of modes in an SHTns/MagIC-style truncation (m = 0, mres, ..., mmax*mres). */
function nlmCalc(lmax, mmax, mres) {
  return (mmax + 1) * (lmax + 1) - (mres * mmax * (mmax + 1)) / 2;
}

/**
 * (l,m) ordering used by both MagIC and SHTns: blocks of constant m,
 * l = m..lMax inside each block. `mList` is the list of orders kept.
 */
function lmLayout(lMax, mList) {
  const ms = [], mStart = [];
  let n = 0;
  for (const m of mList) {
    if (m > lMax) continue;
    ms.push(m);
    mStart.push(n);
    n += lMax - m + 1;
  }
  const ell = new Int32Array(n);
  const em = new Int32Array(n);
  for (let b = 0; b < ms.length; b++) {
    for (let l = ms[b], p = mStart[b]; l <= lMax; l++, p++) {
      ell[p] = l;
      em[p] = ms[b];
    }
  }
  return { lMax, ms, mStart, ell, m: em, lmMax: n };
}

/** Smallest n' >= n whose prime factors are all 2, 3 or 5 (fast FFT sizes). */
function fftSize(n) {
  for (let k = Math.max(1, Math.ceil(n)); ; k++) {
    let r = k;
    for (const p of [2, 3, 5]) while (r % p === 0) r /= p;
    if (r === 1) return k;
  }
}

/**
 * Complex inverse DFT  x_k = sum_m Z_m exp(+2 pi i m k / N)  (no normalisation)
 * for any N: recursive mixed-radix Cooley-Tukey (decimation in time), with
 * direct butterflies for each factor, so radices 2, 3, 4, 5 are fast and any
 * remaining prime factor p costs O(N p).
 */
class InverseDFT {
  constructor(N) {
    this.N = N;
    const f = [];
    let n = N;
    for (const p of [4, 2, 3, 5]) while (n % p === 0) { f.push(p); n /= p; }
    for (let p = 7; p * p <= n; p += 2) while (n % p === 0) { f.push(p); n /= p; }
    if (n > 1) f.push(n);
    this.factors = f;
    this.cos = new Float64Array(N);
    this.sin = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / N);
      this.sin[k] = Math.sin((2 * Math.PI * k) / N);
    }
    const pmax = Math.max(1, ...f);
    this._tr = new Float64Array(pmax);
    this._ti = new Float64Array(pmax);
  }

  /** x = IDFT(z); zr/zi and xr/xi are distinct Float64Arrays of length N. */
  run(zr, zi, xr, xi) {
    this._rec(zr, zi, 0, 1, this.N, xr, xi, 0, 0);
  }

  _rec(zr, zi, inOff, stride, n, xr, xi, outOff, fi) {
    if (n === 1) { xr[outOff] = zr[inOff]; xi[outOff] = zi[inOff]; return; }
    const p = this.factors[fi], m = n / p;
    for (let q = 0; q < p; q++) this._rec(zr, zi, inOff + q * stride, stride * p, m, xr, xi, outOff + q * m, fi + 1);
    // combine p sub-transforms of length m: X[k + u m] = sum_q w^{q (k + u m)} Y_q[k], w = e^{2 pi i / n}
    const N = this.N, C = this.cos, S = this.sin, step = N / n, tr = this._tr, ti = this._ti;
    for (let k = 0; k < m; k++) {
      for (let q = 0; q < p; q++) { tr[q] = xr[outOff + q * m + k]; ti[q] = xi[outOff + q * m + k]; }
      for (let u = 0; u < p; u++) {
        const kk = k + u * m;
        let sr = tr[0], si = ti[0];
        for (let q = 1; q < p; q++) {
          const t = ((q * kk) % n) * step, c = C[t], s = S[t];
          sr += tr[q] * c - ti[q] * s;
          si += tr[q] * s + ti[q] * c;
        }
        xr[outOff + kk] = sr; xi[outOff + kk] = si;
      }
    }
  }
}

/** Orders m = 0, step, 2 step, ... <= mMax that are >= mMin. */
function mRange(mMax, step, mMin = 0) {
  const out = [];
  for (let m = 0; m <= mMax; m += step) if (m >= mMin) out.push(m);
  return out;
}

/**
 * P_lm(theta) and dP_lm/dtheta for all modes of `lay`, written into P and dP
 * starting at offset `off`.
 */
function plmTheta(theta, lay, P, dP, off = 0) {
  const c = Math.cos(theta), s = Math.sin(theta);
  const dnorm = 1 / Math.sqrt(4 * Math.PI);
  for (let b = 0; b < lay.ms.length; b++) {
    const m = lay.ms[b];
    let pos = off + lay.mStart[b];
    // P_mm = sqrt((2m+1)!!/(2m)!!) sin^m, accumulated in log space to avoid
    // underflow / overflow for large m.
    let logp = 0;
    for (let j = 3; j <= 2 * m + 1; j += 2) logp += Math.log(j / (j - 1));
    logp = 0.5 * logp + (m > 0 ? m * Math.log(s) : 0);
    let p0 = Math.exp(logp);
    let p1 = 0, p2 = 0;
    for (let l = m; l <= lay.lMax; l++) {
      if (l > m) {
        p2 = p1;
        p1 = p0;
        const a = Math.sqrt((2 * l - 1) * (2 * l + 1) / ((l - m) * (l + m)));
        const bb = l - m - 1 > 0
          ? Math.sqrt((2 * l + 1) * (l + m - 1) * (l - m - 1) /
                      ((2 * l - 3) * (l - m) * (l + m)))
          : 0;
        p0 = c * a * p1 - bb * p2;
      }
      P[pos] = dnorm * p0;
      // sin(theta) dP_l/dtheta = l cos(theta) P_l - sqrt((2l+1)(l^2-m^2)/(2l-1)) P_{l-1}
      const prev = l > m ? Math.sqrt((2 * l + 1) * (l * l - m * m) / (2 * l - 1)) * p1 : 0;
      dP[pos] = dnorm * (l * c * p0 - prev) / s;
      pos++;
    }
  }
}

/** Fornberg (1988) weights for the first derivative at x0 from nodes xs. */
function fdWeights(x0, xs) {
  const n = xs.length;
  // c[j][k]: weight of node j for derivative order k (k = 0, 1)
  const c = Array.from({ length: n }, () => [0, 0]);
  let c1 = 1, c4 = xs[0] - x0;
  c[0][0] = 1;
  for (let i = 1; i < n; i++) {
    const mn = Math.min(i, 1);
    let c2 = 1;
    const c5 = c4;
    c4 = xs[i] - x0;
    for (let j = 0; j < i; j++) {
      const c3 = xs[i] - xs[j];
      c2 *= c3;
      if (j === i - 1) {
        for (let k = mn; k >= 1; k--) c[i][k] = (c1 * (k * c[i - 1][k - 1] - c5 * c[i - 1][k])) / c2;
        c[i][0] = (-c1 * c5 * c[i - 1][0]) / c2;
      }
      for (let k = mn; k >= 1; k--) c[j][k] = (c4 * c[j][k] - k * c[j][k - 1]) / c3;
      c[j][0] = (c4 * c[j][0]) / c3;
    }
    c1 = c2;
  }
  return c.map((w) => w[1]);
}

/** Chebyshev coefficients of values sampled at x_k = cos(pi k / N), k = 0..N. */
function chebCoeffs(f) {
  const n = f.length - 1;
  const a = new Float64Array(n + 1);
  for (let m = 0; m <= n; m++) {
    let s = 0;
    for (let k = 0; k <= n; k++) {
      const w = k === 0 || k === n ? 0.5 : 1;
      s += w * f[k] * Math.cos((Math.PI * m * k) / n);
    }
    a[m] = ((m === 0 || m === n ? 1 : 2) / n) * s;
  }
  return a;
}

/**
 * If radius[k] is a smooth function r(x) of the Gauss-Lobatto nodes
 * x_k = cos(pi k / N) (plain or mapped Chebyshev grid, e.g. MagIC's
 * radial_scheme='CHEB' with or without l_newmap), return dr/dx at the nodes;
 * otherwise null.
 */
function chebyshevMapping(radius) {
  const n = radius.length - 1;
  if (n < 4) return null;
  const a = chebCoeffs(radius);
  const scale = Math.abs(a[1]);
  if (!(scale > 0)) return null;
  // smooth map <=> fast coefficient decay (radii are often stored in single precision)
  const tol = 1e-5 * scale;
  for (let m = Math.max(3, Math.floor(n / 2)); m <= n; m++) if (Math.abs(a[m]) > tol) return null;
  let cut = n;
  while (cut > 1 && Math.abs(a[cut]) < 1e-7 * scale) cut--;
  // derivative coefficients b (series in T_m), then evaluate at the nodes
  const b = new Float64Array(cut + 2);
  for (let m = cut; m >= 1; m--) b[m - 1] = b[m + 1] + 2 * m * a[m];
  b[0] *= 0.5;
  const drdx = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) {
    const th = (Math.PI * k) / n;
    let s = 0;
    for (let m = 0; m < cut; m++) s += b[m] * Math.cos(m * th);
    drdx[k] = s;
    if (!(Math.abs(s) > 0)) return null;
  }
  return drdx;
}

/** Row i of the Chebyshev differentiation matrix w.r.t. x on x_k = cos(pi k/N). */
function chebRow(i, n) {
  const x = (k) => Math.cos((Math.PI * k) / n);
  const c = (k) => (k === 0 || k === n ? 2 : 1) * (k % 2 ? -1 : 1);
  const w = new Float64Array(n + 1);
  let diag = 0;
  for (let j = 0; j <= n; j++) {
    if (j === i) continue;
    w[j] = c(i) / c(j) / (x(i) - x(j));
    diag -= w[j];
  }
  w[i] = diag;
  return w;
}

/**
 * Radial derivative of data laid out [ir][k] (`stride` values per radius),
 * evaluated lazily one radius at a time and cached.
 * scheme: 'cheb' (spectral, plain or mapped Gauss-Lobatto grids), 'fd3' or
 * 'fd5' (finite differences on the non-uniform grid, one-sided at the
 * boundaries), or 'auto' (cheb when the grid allows it, else fd5).
 */
class RadialDerivative {
  constructor(radius, data, stride, scheme = 'auto') {
    const nr = radius.length;
    const drdx = scheme === 'auto' || scheme === 'cheb' ? chebyshevMapping(radius) : null;
    if (scheme === 'auto') scheme = drdx ? 'cheb' : 'fd5';
    if (scheme === 'cheb' && !drdx) scheme = 'fd5';
    this.scheme = scheme;
    this.data = data;
    this.stride = stride;
    this.out = new Float32Array(nr * stride);
    this.done = new Uint8Array(nr);
    this.weights = [];
    const w = Math.min(scheme === 'fd3' ? 3 : 5, nr);
    for (let i = 0; i < nr; i++) {
      if (scheme === 'cheb') {
        const row = chebRow(i, nr - 1);
        for (let j = 0; j < nr; j++) row[j] /= drdx[i];
        this.weights.push({ i0: 0, w: row });
      } else {
        const i0 = Math.max(0, Math.min(nr - w, i - (w >> 1)));
        const xs = Array.from({ length: w }, (_, j) => radius[i0 + j]);
        this.weights.push({ i0, w: Float64Array.from(fdWeights(radius[i], xs)) });
      }
    }
  }

  /** Derivative at radial index i (Float32Array view of length stride). */
  row(i) {
    const st = this.stride, o = i * st;
    const out = this.out.subarray(o, o + st);
    if (!this.done[i]) {
      const { i0, w } = this.weights[i];
      const acc = new Float64Array(st);
      for (let j = 0; j < w.length; j++) {
        const c = w[j];
        if (c === 0) continue;
        const d = (i0 + j) * st;
        for (let k = 0; k < st; k++) acc[k] += c * this.data[d + k];
      }
      out.set(acc);
      this.done[i] = 1;
    }
    return out;
  }
}

Object.assign(MV, { nlmCalc, lmLayout, mRange, plmTheta, chebyshevMapping, RadialDerivative, fftSize, InverseDFT });
}
(self.MV_PARTS ||= []).push(mvSht);
