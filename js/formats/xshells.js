// XSHELLS (https://nschaeff.bitbucket.io/xshells/) field files: fieldU_*, fieldB_*,
// fieldT_*, fieldC_* ...  Spherical-harmonic (SHTns) coefficients on a radial grid.
// Layout follows xshells_io.cpp (Spectral::save_generic) and pyxshells.load_field:
//
//   1024-byte header (FieldInfo), r[nr] (double), [ltr[nr] (uint16) if VAR_LTR],
//   then for each shell ir = irs-1 .. ire+1 (ghost shells included) and each
//   component (1 = scalar, 2 = poloidal/toroidal): nlm complex values
//   (complex64, complex128 or fp48-packed).
//
// Poloidal/toroidal convention: v = curl(T r) + curl curl(P r), so
//   Q = l(l+1) P / r,  S = dP/dr + P/r,  T = T.
//
// Classic script (not an ES module) so the viewer also runs from file://; see
// "How it works" in README.md. The body is not indented to keep it identical to
// the module it was converted from.

function mvXshells(MV) {
'use strict';
const { SpectralProvider, lmLayout, mRange, nlmCalc, RadialDerivative } = MV;

const FILE_SINGLE_PREC = 4096, FILE_VAR_LTR = 8192, FILE_FP48 = 16384;
const SHT_NO_CS_PHASE = 1024, SHT_REAL_NORM = 2048;

const fmt = (x, d = 4) => (Number.isInteger(x) ? String(x) : Number(x).toPrecision(d));

function readHeader(buf, le) {
  if (buf.byteLength < 1024) return null;
  const dv = new DataView(buf);
  const I = (k) => dv.getInt32(4 * k, le);
  const D = (k) => dv.getFloat64(64 + 8 * k, le);
  const h = {
    le,
    rawVersion: I(0), lmax: I(1), mmax: I(2), mres: I(3), nlm: I(4), nr: I(5),
    irs: I(6), ire: I(7), bci: I(8), bco: I(9), shtnorm: I(12), ncomp: I(13),
    iter: I(14), step: I(15), rbci: D(0), rbco: D(1), time: D(3),
  };
  if (!(h.nr > 0 && h.nr < 1e6 && h.lmax >= 0 && h.lmax < 1e5 && h.mmax >= 0 && h.mres > 0)) return null;
  if (nlmCalc(h.lmax, h.mmax, h.mres) !== h.nlm) return null;
  if (!(h.irs >= 0 && h.ire < h.nr && h.irs <= h.ire)) return null;
  h.version = h.rawVersion & (FILE_SINGLE_PREC - 1);
  if (h.version > 20) return null;
  if (h.version < 10) h.ncomp = 2;
  if (h.ncomp !== 1 && h.ncomp !== 2) return null;
  h.prec = h.rawVersion & FILE_SINGLE_PREC ? 'single' : h.rawVersion & FILE_FP48 ? 'fp48' : 'double';
  h.varLtr = (h.rawVersion & FILE_VAR_LTR) !== 0;
  const td = new TextDecoder('latin1');
  const cstr = (o, n) => {
    const b = new Uint8Array(buf, o, n);
    const z = b.indexOf(0);
    return td.decode(z < 0 ? b : b.subarray(0, z));
  };
  h.hgid = cstr(128, 64);
  h.text = cstr(192, 832);
  return h;
}

// fp48: 48-bit floats (sign, 11-bit exponent relative to a per-block shift, 36-bit mantissa).
const tmp = new DataView(new ArrayBuffer(8));
function fp48Decode(dv, off, le, n, out, outOff) {
  const expShift = (dv.getInt16(off, le) + 959) * 2 ** 40;
  const EXMA = 2 ** 47 - 1;
  for (let i = 0; i < n; i++) {
    const b = off + 2 + 6 * i;
    const w0 = dv.getUint16(b, le), w1 = dv.getUint16(b + 2, le), w2 = dv.getUint16(b + 4, le);
    const neg = (w2 & 0x8000) !== 0;
    const z = w0 + w1 * 65536 + (w2 & 0x7fff) * 2 ** 32;
    let v;
    if (z === 0) v = 0;
    else if (z === EXMA) v = NaN;
    else {
      const bits = z + expShift; // value << 12 gives the IEEE-754 bits
      tmp.setUint32(0, Math.floor(bits / 2 ** 20) | (neg ? 0x80000000 : 0));
      tmp.setUint32(4, (bits % 2 ** 20) * 4096);
      v = tmp.getFloat64(0);
    }
    out[outOff + i] = v;
  }
}

function fieldSymbol(name) {
  const m = /field([A-Za-z]+?)(?:[._]|$)/.exec(name.split('/').pop());
  return m ? m[1] : null;
}

const xshells = {
  name: 'XSHELLS field file',
  detect(buf) {
    for (const le of [true, false]) {
      let h;
      try { h = readHeader(buf, le); } catch { h = null; }
      if (h) return h;
    }
    return null;
  },

  open(buf, name, h) {
    const dv = new DataView(buf);
    const le = h.le;
    const { nr, irs, ire, lmax, mmax, mres, nlm, ncomp } = h;
    let off = 1024;
    const rAll = new Float64Array(nr);
    for (let i = 0; i < nr; i++) rAll[i] = dv.getFloat64(off + 8 * i, le);
    off += 8 * nr;
    let ltr = null;
    if (h.varLtr) {
      ltr = new Uint16Array(nr);
      for (let i = 0; i < nr; i++) ltr[i] = dv.getUint16(off + 2 * i, le);
      off += 2 * nr;
    }
    const lay = lmLayout(lmax, mRange(mmax * mres, mres));
    if (lay.lmMax !== nlm) throw new Error('XSHELLS: inconsistent spherical-harmonic layout');

    // physical shells irs..ire, dropping r = 0 (centre of a full sphere)
    const shells = [];
    for (let ir = irs; ir <= ire; ir++) if (rAll[ir] > 0) shells.push(ir);
    const nPhys = shells.length;
    if (nPhys < 3) throw new Error('XSHELLS: fewer than 3 radial shells');
    const radius = Float64Array.from(shells, (ir) => rAll[ir]);
    const shellPos = new Map(shells.map((ir, k) => [ir, k]));

    // Decode everything into Float32 [shell][comp][2*nlm] in the reference convention.
    const stride = 2 * nlm;
    const data = new Float32Array(nPhys * ncomp * stride);
    const esz = h.prec === 'single' ? 8 : h.prec === 'double' ? 16 : 0;
    const scratch = new Float64Array(stride);
    let need = off;
    for (let ir = irs - 1; ir <= ire + 1; ir++) {
      const lt = h.varLtr ? Math.min(lmax, ltr[Math.max(0, Math.min(nr - 1, ir))]) : lmax;
      // modes stored for this shell
      let nlmr = 0;
      for (let im = 0; im <= mmax; im++) nlmr += Math.max(0, lt - im * mres + 1);
      const compBytes = h.prec === 'fp48' ? 2 * (6 * nlmr + 1) : esz * nlmr;
      need += compBytes * ncomp; // both ghost shells are always stored
      if (need > buf.byteLength) throw new Error('XSHELLS: file is truncated');
      const k = shellPos.get(ir);
      for (let ic = 0; ic < ncomp; ic++, off += compBytes) {
        if (k === undefined) continue; // ghost shell or r = 0
        if (h.prec === 'fp48') fp48Decode(dv, off, le, 2 * nlmr, scratch, 0);
        else if (h.prec === 'single') for (let i = 0; i < 2 * nlmr; i++) scratch[i] = dv.getFloat32(off + 4 * i, le);
        else for (let i = 0; i < 2 * nlmr; i++) scratch[i] = dv.getFloat64(off + 8 * i, le);
        const dst = (k * ncomp + ic) * stride;
        if (nlmr === nlm) {
          for (let i = 0; i < stride; i++) data[dst + i] = scratch[i];
        } else {
          // scatter truncated blocks into the full layout
          let src = 0;
          for (let b = 0; b < lay.ms.length; b++) {
            const nl = Math.max(0, lt - lay.ms[b] + 1);
            const d0 = dst + 2 * lay.mStart[b];
            for (let i = 0; i < 2 * nl; i++) data[d0 + i] = scratch[src + i];
            src += 2 * nl;
          }
        }
      }
    }

    // Normalisation -> reference convention (orthonormal, no Condon-Shortley phase).
    const norm = h.shtnorm & 0xff;
    const cs = (h.shtnorm & SHT_NO_CS_PHASE) === 0;
    const realNorm = (h.shtnorm & SHT_REAL_NORM) !== 0;
    const fac = new Float64Array(nlm);
    for (let q = 0; q < nlm; q++) {
      const l = lay.ell[q], m = lay.m[q];
      let f = norm === 1 ? Math.sqrt(4 * Math.PI) : norm === 2 ? Math.sqrt((4 * Math.PI) / (2 * l + 1)) : 1;
      if (cs && m & 1) f = -f;
      if (realNorm && m > 0) f /= Math.SQRT2;
      fac[q] = f;
    }
    for (let k = 0; k < nPhys * ncomp; k++) {
      const o = k * stride;
      for (let q = 0; q < nlm; q++) { data[o + 2 * q] *= fac[q]; data[o + 2 * q + 1] *= fac[q]; }
    }

    const sym0 = fieldSymbol(name) ?? (ncomp === 1 ? 'T' : 'U');
    const sym = sym0 === 'U' ? 'u' : sym0;
    const A = new Float64Array(stride), Q = new Float64Array(stride);
    const S = new Float64Array(stride), T = new Float64Array(stride);
    let pol = null, dpol = null;
    const coef = (k) => {
      if (ncomp === 1) {
        const o = k * stride;
        for (let i = 0; i < stride; i++) A[i] = data[o + i];
        return { a: A };
      }
      if (!pol) {
        pol = new Float32Array(nPhys * stride);
        for (let s = 0; s < nPhys; s++) pol.set(data.subarray(2 * s * stride, (2 * s + 1) * stride), s * stride);
        // 3-point finite differences, as in XSHELLS' own post-processing (xspp, pyxshells)
        dpol = new RadialDerivative(radius, pol, stride, 'fd3');
      }
      const d = dpol.row(k);
      const r = radius[k], o = k * stride, ot = (2 * k + 1) * stride;
      for (let q = 0; q < nlm; q++) {
        const l2 = lay.ell[q] * (lay.ell[q] + 1);
        const pr = pol[o + 2 * q], pi = pol[o + 2 * q + 1];
        Q[2 * q] = (l2 * pr) / r; Q[2 * q + 1] = (l2 * pi) / r;
        S[2 * q] = d[2 * q] + pr / r; S[2 * q + 1] = d[2 * q + 1] + pi / r;
        T[2 * q] = data[ot + 2 * q]; T[2 * q + 1] = data[ot + 2 * q + 1];
      }
      return { q: Q, s: S, t: T };
    };

    const fields = ncomp === 1
      ? [{
        id: sym, label: sym === 'C' ? 'C (composition)' : sym, signed: sym !== 'T' && sym !== 'C', comp: 'a',
        ...(sym === 'C' ? { cmap: 'cividis' } : {}),
      }]
      : [
        { id: sym + '_r', label: sym + '_r', signed: true, comp: 'r' },
        { id: sym + '_t', label: sym + '_θ', signed: true, comp: 't' },
        { id: sym + '_p', label: sym + '_φ', signed: true, comp: 'p' },
      ];
    const normName = ['orthonormal', '4π', 'Schmidt'][norm] ?? `#${norm}`;
    const info = [
      ['Format', `XSHELLS field v${h.version} (${h.prec}${h.varLtr ? ', var. ℓ-trunc.' : ''})`],
      ['Field', `field${sym0} (${ncomp === 1 ? 'scalar' : 'poloidal/toroidal'})`],
      ['Time', fmt(h.time, 6)],
      ['Iteration', h.iter],
      ['ℓ_max, m_max, m_res', `${lmax}, ${mmax}, ${mres}`],
      ['n_r (shells)', `${nr} (${irs}..${ire})`],
      ['r range', `${fmt(radius[0])} – ${fmt(radius[nPhys - 1])}`],
      ['SH norm', normName + (cs ? '' : ', no CS phase') + (realNorm ? ', real' : '')],
      ...(h.hgid ? [['Code id', h.hgid]] : []),
    ];
    return new SpectralProvider({
      format: 'xshells', lay, radius, kind: ncomp === 1 ? 'scalar' : 'vector',
      coef, fields, info, notes: h.text || null,
      magnetic: ncomp === 2 && sym === 'B' ? { ids: ['B_r', 'B_t', 'B_p'] } : null,
    });
  },
};

Object.assign(MV, { xshells });
}
(self.MV_PARTS ||= []).push(mvXshells);
