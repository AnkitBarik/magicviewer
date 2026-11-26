// Spectral (spherical-harmonic) data provider.
//
// A format adapter supplies, for every radial index ir, complex coefficients in
// the reference convention of sht.js (interleaved re/im, Float64Array 2*lmMax):
//   scalar fields : { a }           f = sum a_lm Y_lm
//   vector fields : { q, s, t }     v = Q Y r + S r grad Y - r x grad(T Y)
// i.e. v_r = sum Q Y,
//      v_theta = sum S dY/dtheta + T (1/sin) dY/dphi,
//      v_phi   = sum S (1/sin) dY/dphi - T dY/dtheta.
// The provider evaluates shells, the equatorial plane and meridional planes.
//
// Classic script (not an ES module) so the viewer also runs from file://; see
// "How it works" in README.md. The body is not indented to keep it identical to
// the module it was converted from.

function mvSpectral(MV) {
'use strict';
const { plmTheta, fftSize, InverseDFT } = MV;

const MAX_TABLE_ENTRIES = 24e6; // per table (P and dP), Float32

class SpectralProvider {
  /**
   * @param {object} o
   * @param {object} o.lay      lmLayout()
   * @param {Float64Array} o.radius  physical radii (any order)
   * @param {'scalar'|'vector'} o.kind
   * @param {(ir:number)=>object} o.coef  coefficient getter
   * @param {Array} o.fields   [{id,label,signed,comp}] comp in 'a','r','t','p'
   * @param {Array} o.info     [[key, value], ...] for display
   */
  constructor(o) {
    Object.assign(this, o);
    const lay = this.lay;
    // Display grid that resolves the data: at least lMax + 1 colatitudes (even,
    // for the parity split) and an FFT-friendly number of longitudes >= 2 mMax + 2,
    // about twice the colatitudes so that cells are roughly square. The
    // Legendre tables (nTheta/2 x lmMax each for P and dP) cap nTheta.
    let nt = o.nTheta ?? Math.max(96, lay.lMax + 1);
    const cap = Math.floor((2 * MAX_TABLE_ENTRIES) / lay.lmMax);
    if (nt > cap) nt = Math.max(32, cap);
    nt += nt % 2;
    const mMax = lay.ms[lay.ms.length - 1];
    const np = o.nPhi ?? fftSize(Math.max(2 * nt, 2 * mMax + 2));
    this.setGrid(Float64Array.from({ length: nt }, (_, j) => ((j + 0.5) * Math.PI) / nt), np);
    this.onProgress = null;
  }

  get grid() {
    return { colat: this.colat, nPhi: this.nPhi, phi0: 0 };
  }

  /** Use another (equator-symmetric) colatitude grid, e.g. for validation. */
  setGrid(colat, nPhi = 2 * colat.length) {
    this.colat = Float64Array.from(colat);
    this.nTheta = colat.length;
    this.nPhi = nPhi;
    this._P = null;
    this._merCache = [];
    // longitude synthesis by FFT (any nPhi; orders m >= nPhi wrap around, as
    // sampling e^{i m phi} at nPhi points requires)
    this._dft = new InverseDFT(nPhi);
    this._zr = new Float64Array(nPhi); this._zi = new Float64Array(nPhi);
    this._xr = new Float64Array(nPhi); this._xi = new Float64Array(nPhi);
  }

  _tables() {
    if (this._P) return;
    const lm = this.lay.lmMax, nh = this.nTheta / 2;
    this._P = new Float32Array(nh * lm);
    this._dP = new Float32Array(nh * lm);
    this._sin = new Float64Array(nh);
    const P = new Float64Array(lm), dP = new Float64Array(lm);
    for (let j = 0; j < nh; j++) {
      plmTheta(this.colat[j], this.lay, P, dP);
      this._P.set(P, j * lm);
      this._dP.set(dP, j * lm);
      this._sin[j] = Math.sin(this.colat[j]);
    }
  }

  // Which coefficient arrays feed the P-sum (X) and dP-sum (Y), with factors.
  _operands(comp, c) {
    switch (comp) {
      case 'a': return { X: c.a, Y: null, imX: false, cy: 0 };
      case 'r': return { X: c.q, Y: null, imX: false, cy: 0 };
      case 't': return { X: c.t, Y: c.s, imX: true, cy: 1 };
      case 'p': return { X: c.s, Y: c.t, imX: true, cy: -1 };
      default: throw new Error('unknown component ' + comp);
    }
  }

  _field(id) {
    const f = this.fields.find((f) => f.id === id);
    if (!f) throw new Error('unknown field ' + id);
    return f;
  }

  /**
   * Complex F_m for the northern row (colatitude theta) and its mirror
   * (pi - theta), using Plm parity. Results in FN, FS (interleaved, per block).
   */
  _rowPair(P, dP, off, invSin, op, FN, FS) {
    const lay = this.lay, X = op.X, Y = op.Y, cy = op.cy;
    const L = this.lTrunc ?? lay.lMax; // optional truncation (coarse views)
    for (let b = 0; b < lay.ms.length; b++) {
      const m = lay.ms[b], st = lay.mStart[b], n = L - m + 1;
      if (n <= 0) {
        FN[2 * b] = FN[2 * b + 1] = FS[2 * b] = FS[2 * b + 1] = 0;
        continue;
      }
      let xer = 0, xei = 0, xor = 0, xoi = 0, yer = 0, yei = 0, yor = 0, yoi = 0;
      for (let k = 0; k < n; k += 2) {
        const lm = st + k, p = P[off + lm];
        xer += X[2 * lm] * p; xei += X[2 * lm + 1] * p;
      }
      for (let k = 1; k < n; k += 2) {
        const lm = st + k, p = P[off + lm];
        xor += X[2 * lm] * p; xoi += X[2 * lm + 1] * p;
      }
      if (Y) {
        for (let k = 0; k < n; k += 2) {
          const lm = st + k, d = dP[off + lm];
          yer += Y[2 * lm] * d; yei += Y[2 * lm + 1] * d;
        }
        for (let k = 1; k < n; k += 2) {
          const lm = st + k, d = dP[off + lm];
          yor += Y[2 * lm] * d; yoi += Y[2 * lm + 1] * d;
        }
      }
      // X part: N = Xe + Xo, S = Xe - Xo ; optionally multiplied by i m / sin
      let nxr = xer + xor, nxi = xei + xoi, sxr = xer - xor, sxi = xei - xoi;
      if (op.imX) {
        const f = m * invSin;
        [nxr, nxi] = [-nxi * f, nxr * f];
        [sxr, sxi] = [-sxi * f, sxr * f];
      }
      // Y part: N = Ye + Yo, S = -(Ye - Yo)  (dP is antisymmetric w.r.t. P)
      FN[2 * b] = nxr + cy * (yer + yor);
      FN[2 * b + 1] = nxi + cy * (yei + yoi);
      FS[2 * b] = sxr - cy * (yer - yor);
      FS[2 * b + 1] = sxi - cy * (yei - yoi);
    }
  }

  // out[o + k] = sum_b w_m Re[F_m e^{i m phi_k}], phi_k = 2 pi k / nPhi, w_0 = 1, w_m = 2
  _phiSynth(F, out, o) {
    const ms = this.lay.ms, np = this.nPhi, zr = this._zr, zi = this._zi;
    zr.fill(0); zi.fill(0);
    for (let b = 0; b < ms.length; b++) {
      const m = ms[b], w = m === 0 ? 1 : 2, k = m % np;
      zr[k] += w * F[2 * b]; zi[k] += w * F[2 * b + 1];
    }
    this._dft.run(zr, zi, this._xr, this._xi);
    const xr = this._xr;
    for (let k = 0; k < np; k++) out[o + k] = xr[k];
  }

  /** Shell at radial index ir: Float32Array [nTheta][nPhi]. */
  shell(fieldId, ir) {
    this._tables();
    const f = this._field(fieldId);
    const op = this._operands(f.comp, this.coef(ir));
    const nt = this.nTheta, nh = nt / 2, np = this.nPhi, lm = this.lay.lmMax;
    const nb = this.lay.ms.length;
    const FN = new Float64Array(2 * nb), FS = new Float64Array(2 * nb);
    const row = new Float64Array(np);
    const out = new Float32Array(nt * np);
    for (let j = 0; j < nh; j++) {
      this._rowPair(this._P, this._dP, j * lm, 1 / this._sin[j], op, FN, FS);
      this._phiSynth(FN, row, 0);
      out.set(row, j * np);
      this._phiSynth(FS, row, 0);
      out.set(row, (nt - 1 - j) * np);
    }
    return out;
  }

  /** Equatorial plane: Float32Array [nr][nPhi]. */
  equator(fieldId) {
    const f = this._field(fieldId);
    const lm = this.lay.lmMax, nb = this.lay.ms.length, np = this.nPhi, nr = this.radius.length;
    if (!this._eqP) {
      this._eqP = new Float64Array(lm);
      this._eqdP = new Float64Array(lm);
      plmTheta(Math.PI / 2, this.lay, this._eqP, this._eqdP);
    }
    const FN = new Float64Array(2 * nb), FS = new Float64Array(2 * nb);
    const row = new Float64Array(np);
    const out = new Float32Array(nr * np);
    for (let ir = 0; ir < nr; ir++) {
      const op = this._operands(f.comp, this.coef(ir));
      this._rowPair(this._eqP, this._eqdP, 0, 1, op, FN, FS);
      this._phiSynth(FN, row, 0);
      out.set(row, ir * np);
      if (this.onProgress && ir % 8 === 7) this.onProgress((ir + 1) / nr);
    }
    return out;
  }

  /** Meridional half-plane at longitude phi: Float32Array [nr][nTheta]. */
  meridian(fieldId, phi) {
    const TWO_PI = 2 * Math.PI;
    const norm = (x) => ((x % TWO_PI) + TWO_PI) % TWO_PI;
    const same = (a, b) => Math.abs(norm(a - b + Math.PI) - Math.PI) < 1e-9;
    const p = norm(phi);
    for (const c of this._merCache) {
      if (c.field !== fieldId) continue;
      if (same(c.phi, p)) return c.plane0;
      if (same(c.phi + Math.PI, p)) return c.planePi;
    }
    const [plane0, planePi] = this._meridianPair(fieldId, p);
    this._merCache.unshift({ field: fieldId, phi: p, plane0, planePi });
    this._merCache.length = Math.min(this._merCache.length, 4);
    return plane0;
  }

  // Both half-planes phi0 and phi0+pi in one pass (e^{i m pi} = (-1)^m).
  _meridianPair(fieldId, phi0) {
    this._tables();
    const f = this._field(fieldId);
    const lay = this.lay, lm = lay.lmMax, nb = lay.ms.length;
    const nt = this.nTheta, nh = nt / 2, nr = this.radius.length;
    const out0 = new Float32Array(nr * nt), outPi = new Float32Array(nr * nt);
    const RX = new Float64Array(lm), RY = new Float64Array(lm);
    const cm = new Float64Array(nb), sm = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      const m = lay.ms[b], w = m === 0 ? 1 : 2;
      cm[b] = w * Math.cos(m * phi0);
      sm[b] = w * Math.sin(m * phi0);
    }
    const P = this._P, dP = this._dP;
    let lastReport = 0;
    for (let ir = 0; ir < nr; ir++) {
      const op = this._operands(f.comp, this.coef(ir));
      const X = op.X, Y = op.Y;
      // project coefficients on e^{i m phi0}
      for (let b = 0; b < nb; b++) {
        const m = lay.ms[b], st = lay.mStart[b], n = lay.lMax - m + 1;
        const c = cm[b], s = sm[b];
        for (let k = 0; k < n; k++) {
          const q = st + k, xr = X[2 * q], xi = X[2 * q + 1];
          RX[q] = op.imX ? -m * (xr * s + xi * c) : xr * c - xi * s;
          if (Y) RY[q] = op.cy * (Y[2 * q] * c - Y[2 * q + 1] * s);
        }
      }
      for (let j = 0; j < nh; j++) {
        const off = j * lm, sx = op.imX ? 1 / this._sin[j] : 1;
        let Ne = 0, Se = 0, No = 0, So = 0; // even-m / odd-m contributions
        for (let b = 0; b < nb; b++) {
          const st = lay.mStart[b], n = lay.lMax - lay.ms[b] + 1;
          let xe = 0, xo = 0, ye = 0, yo = 0;
          for (let k = 0; k < n; k += 2) xe += RX[st + k] * P[off + st + k];
          for (let k = 1; k < n; k += 2) xo += RX[st + k] * P[off + st + k];
          if (Y) {
            for (let k = 0; k < n; k += 2) ye += RY[st + k] * dP[off + st + k];
            for (let k = 1; k < n; k += 2) yo += RY[st + k] * dP[off + st + k];
          }
          const nv = sx * (xe + xo) + (ye + yo);
          const sv = sx * (xe - xo) - (ye - yo);
          if (lay.ms[b] & 1) { No += nv; So += sv; } else { Ne += nv; Se += sv; }
        }
        out0[ir * nt + j] = Ne + No;
        out0[ir * nt + nt - 1 - j] = Se + So;
        outPi[ir * nt + j] = Ne - No;
        outPi[ir * nt + nt - 1 - j] = Se - So;
      }
      if (this.onProgress && ir - lastReport >= 8) {
        lastReport = ir;
        this.onProgress(ir / nr);
      }
    }
    return [out0, outPi];
  }
}

Object.assign(MV, { SpectralProvider });
}
(self.MV_PARTS ||= []).push(mvSpectral);
