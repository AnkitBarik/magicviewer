// Field-line tracing through a vector field sampled on a coarse (r, theta, phi)
// volume, with trilinear interpolation and fixed-step RK4 along B/|B|.
//
// Classic script (not an ES module) so the viewer also runs from file://; see
// "How it works" in README.md. The body is not indented to keep it identical to
// the module it was converted from.

function mvFieldlines(MV) {
'use strict';

/** Colatitudes of a uniform, equator-symmetric grid. */
function uniformColat(n) {
  return Float64Array.from({ length: n }, (_, j) => ((j + 0.5) * Math.PI) / n);
}

/**
 * Sample the three spherical components (ids = [r, theta, phi]) of a provider
 * at radial indices `irs` on a coarse grid. Returns per-level arrays [nt][np].
 */
function sampleLevels(provider, ids, irs, grid = { nt: 64, np: 128 }) {
  let colat, nPhi, get;
  if (provider.lay) {
    // spectral: a light-weight view with its own coarse, truncated grid
    const c = grid.colat ?? uniformColat(grid.nt);
    const view = Object.create(provider);
    view.lTrunc = Math.min(provider.lay.lMax, Math.floor((2 * c.length) / 3));
    view.setGrid(c, grid.nPhi ?? grid.np);
    colat = view.colat;
    nPhi = view.nPhi;
    get = (id, ir) => view.shell(id, ir);
  } else {
    // grid: subsample the native grid, symmetrically about the equator
    const ntF = provider.nTheta, npF = provider.nPhi;
    const half = Math.min(grid.nt, ntF) >> 1;
    const north = Array.from({ length: half }, (_, j) =>
      Math.min((ntF >> 1) - 1, Math.round(((j + 0.5) * ntF) / (2 * half) - 0.5)));
    const tIdx = [...north, ...north.map((t) => ntF - 1 - t).reverse()];
    let step = Math.max(1, Math.round(npF / grid.np));
    while (npF % step) step--; // keep phi_k = 2 pi k / nPhi
    nPhi = npF / step;
    colat = Float64Array.from(tIdx, (t) => provider.colat[t]);
    get = (id, ir) => {
      const full = provider.shell(id, ir);
      const out = new Float32Array(tIdx.length * nPhi);
      tIdx.forEach((t, j) => {
        for (let p = 0; p < nPhi; p++) out[j * nPhi + p] = full[t * npF + p * step];
      });
      return out;
    };
  }
  const levels = Array.from(irs, (ir, k) => {
    provider.onProgress?.(k / irs.length);
    return { r: provider.radius[ir], comps: ids.map((id) => get(id, ir)) };
  });
  return { colat, nPhi, levels };
}

/** Merge sampled level sets (same grid) into a volume sorted by radius. */
function makeVolume(...sets) {
  const { colat, nPhi } = sets[0];
  const levels = sets.flatMap((s) => s.levels).sort((a, b) => a.r - b.r);
  const nt = colat.length, n2 = nt * nPhi;
  const B = new Float32Array(levels.length * 3 * n2);
  levels.forEach((lv, i) => lv.comps.forEach((c, k) => B.set(c, (3 * i + k) * n2)));
  return { r: Float64Array.from(levels, (l) => l.r), colat: Float64Array.from(colat), nPhi, B };
}

class Tracer {
  constructor(vol) {
    this.v = vol;
    this.nt = vol.colat.length;
    this.n2 = this.nt * vol.nPhi;
    this.rmin = vol.r[0];
    this.rmax = vol.r[vol.r.length - 1];
    this._s = new Float64Array(3);
  }

  _bracket(arr, x) {
    const n = arr.length;
    if (x <= arr[0]) return [0, 0, 0];
    if (x >= arr[n - 1]) return [n - 1, n - 1, 0];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= x) lo = mid; else hi = mid;
    }
    return [lo, hi, (x - arr[lo]) / (arr[hi] - arr[lo])];
  }

  /** Spherical components (Br, Btheta, Bphi) at (r, theta, phi), into this._s. */
  spherical(r, th, ph) {
    const v = this.v, np = v.nPhi, n2 = this.n2, B = v.B;
    const [i0, i1, fr] = this._bracket(v.r, r);
    const [t0, t1, ft] = this._bracket(v.colat, th);
    const x = ((((ph / (2 * Math.PI)) % 1) + 1) % 1) * np;
    const p0 = Math.floor(x) % np, p1 = (p0 + 1) % np, fp = x - Math.floor(x);
    const s = this._s;
    for (let k = 0; k < 3; k++) {
      const a = (3 * i0 + k) * n2, b = (3 * i1 + k) * n2;
      const c = (o, t) => (1 - fp) * B[o + t * np + p0] + fp * B[o + t * np + p1];
      const va = (1 - ft) * c(a, t0) + ft * c(a, t1);
      const vb = (1 - ft) * c(b, t0) + ft * c(b, t1);
      s[k] = (1 - fr) * va + fr * vb;
    }
    return s;
  }

  /** Unit field direction at Cartesian point p into out; false outside / null field. */
  direction(p, out) {
    const r = Math.hypot(p[0], p[1], p[2]);
    if (r < this.rmin || r > this.rmax) return false;
    const th = Math.acos(Math.max(-1, Math.min(1, p[2] / r)));
    const ph = Math.atan2(p[1], p[0]);
    const [br, bt, bp] = this.spherical(r, th, ph);
    const st = Math.sin(th), ct = Math.cos(th), sp = Math.sin(ph), cp = Math.cos(ph);
    const bx = br * st * cp + bt * ct * cp - bp * sp;
    const by = br * st * sp + bt * ct * sp + bp * cp;
    const bz = br * ct - bt * st;
    const n = Math.hypot(bx, by, bz);
    if (!(n > 0)) return false;
    out[0] = bx / n; out[1] = by / n; out[2] = bz / n;
    return true;
  }

  /**
   * RK4 integration from p along +/- B; returns flat [x,y,z,...] (excluding p).
   * Optional cap: stop after capSteps steps spent at r < rCap.
   */
  integrate(p, sign, h, maxSteps, rCap = 0, capSteps = Infinity) {
    let inside = 0;
    const pts = [];
    const x = Float64Array.from(p);
    const k1 = new Float64Array(3), k2 = new Float64Array(3), k3 = new Float64Array(3), k4 = new Float64Array(3);
    const y = new Float64Array(3);
    const hs = sign * h;
    for (let i = 0; i < maxSteps; i++) {
      if (!this.direction(x, k1)) break;
      for (let c = 0; c < 3; c++) y[c] = x[c] + 0.5 * hs * k1[c];
      if (!this.direction(y, k2)) break;
      for (let c = 0; c < 3; c++) y[c] = x[c] + 0.5 * hs * k2[c];
      if (!this.direction(y, k3)) break;
      for (let c = 0; c < 3; c++) y[c] = x[c] + hs * k3[c];
      if (!this.direction(y, k4)) break;
      for (let c = 0; c < 3; c++) x[c] += (hs / 6) * (k1[c] + 2 * k2[c] + 2 * k3[c] + k4[c]);
      pts.push(x[0], x[1], x[2]);
      if (Math.hypot(x[0], x[1], x[2]) < rCap && ++inside >= capSteps) break;
    }
    return pts;
  }

  /**
   * Seeds on the sphere r = rSeed, picked among a Fibonacci lattice with
   * probability proportional to |B_r| (systematic resampling: deterministic).
   */
  seeds(rSeed, n) {
    const m = Math.max(30 * n, 2000);
    const cand = [], w = [];
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < m; i++) {
      const z = 1 - (2 * (i + 0.5)) / m, s = Math.sqrt(1 - z * z), ph = ga * i;
      const th = Math.acos(z);
      const br = this.spherical(rSeed, th, ph)[0];
      cand.push([rSeed * s * Math.cos(ph), rSeed * s * Math.sin(ph), rSeed * z, Math.sign(br)]);
      w.push(Math.abs(br));
    }
    const total = w.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return [];
    const out = [];
    let acc = 0, k = 0;
    for (let i = 0; i < m && k < n; i++) {
      acc += w[i];
      while (k < n && acc >= ((k + 0.5) * total) / n) { out.push(cand[i]); k++; }
    }
    return out;
  }

  /** Trace n field lines seeded at rSeed (cap: see integrate). */
  lines(rSeed, n, h, maxSteps, rCap = 0, capSteps = Infinity) {
    const polylines = [];
    for (const [x, y, z, pol] of this.seeds(rSeed, n)) {
      const back = this.integrate([x, y, z], -1, h, maxSteps, rCap, capSteps);
      const fwd = this.integrate([x, y, z], 1, h, maxSteps, rCap, capSteps);
      const pts = [];
      for (let i = back.length - 3; i >= 0; i -= 3) pts.push(back[i], back[i + 1], back[i + 2]);
      pts.push(x, y, z, ...fwd);
      if (pts.length >= 6) polylines.push({ pts, pol });
    }
    let total = 0;
    for (const l of polylines) total += l.pts.length;
    const points = new Float32Array(total);
    const offsets = new Int32Array(polylines.length + 1);
    const polarity = new Int8Array(polylines.length);
    let o = 0;
    polylines.forEach((l, i) => {
      points.set(l.pts, o);
      offsets[i] = o / 3;
      polarity[i] = l.pol;
      o += l.pts.length;
    });
    offsets[polylines.length] = o / 3;
    return { points, offsets, polarity };
  }
}

Object.assign(MV, { uniformColat, sampleLevels, makeVolume, Tracer });
}
(self.MV_PARTS ||= []).push(mvFieldlines);
