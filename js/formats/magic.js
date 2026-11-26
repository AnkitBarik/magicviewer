// MagIC (https://magic-sph.github.io) output files.
//
//  * G_#.TAG       graphic files: fields on the (phi, theta, r) grid
//                  (stream format, as written by out_graph_file.f90).
//  * X_lmr_#.TAG   potential files (X = V, B, T, Xi): spherical-harmonic
//                  coefficients on the radial grid (stream format, version 1 & 2).
// Readers follow python/magic/graph.py and python/magic/potential.py.
//
// Classic script (not an ES module) so the viewer also runs from file://; see
// "How it works" in README.md. The body is not indented to keep it identical to
// the module it was converted from.

function mvMagic(MV) {
'use strict';
const { GridProvider, SpectralProvider, lmLayout, mRange, RadialDerivative } = MV;

const fmt = (x, d = 4) => (Number.isInteger(x) ? String(x) : Number(x).toPrecision(d));

/** Float32Array of n values at byte offset off (view when possible, else decoded copy). */
function floats(buf, dv, off, n, le, w) {
  if (w === 4 && le && off % 4 === 0) return new Float32Array(buf, off, n);
  const out = new Float32Array(n);
  if (w === 4) for (let i = 0; i < n; i++) out[i] = dv.getFloat32(off + 4 * i, le);
  else for (let i = 0; i < n; i++) out[i] = dv.getFloat64(off + 8 * i, le);
  return out;
}

// ---------------------------------------------------------------- G files

function graphHeader(buf, le, w) {
  const dv = new DataView(buf);
  const size = buf.byteLength;
  let off = 0;
  const int = () => {
    const v = w === 4 ? dv.getInt32(off, le) : Number(dv.getBigInt64(off, le));
    off += w;
    return v;
  };
  const flt = () => {
    const v = w === 4 ? dv.getFloat32(off, le) : dv.getFloat64(off, le);
    off += w;
    return v;
  };
  if (size < 200) return null;
  const version = int();
  if (version < 1 || version > 100) return null;
  const runId = new TextDecoder('latin1').decode(new Uint8Array(buf, off, 64)).trim();
  off += 64;
  const h = { version, runId, le, w };
  h.time = flt();
  if (version > 13) {
    [h.ra, h.pr, h.raxi, h.sc, h.ek, h.stef, h.prmag, h.radratio, h.sigma] =
      Array.from({ length: 9 }, flt);
  } else {
    [h.ra, h.pr, h.raxi, h.sc, h.ek, h.prmag, h.radratio, h.sigma] =
      Array.from({ length: 8 }, flt);
  }
  h.nr = int(); h.ntheta = int(); h.npI = int(); h.minc = int(); h.nric = int();
  if (!(h.nr > 1 && h.nr < 1e5 && h.ntheta > 1 && h.ntheta < 1e5 &&
        h.npI > 0 && h.npI < 2e5 && h.minc > 0 && h.minc < 1000)) return null;
  if (h.npI === h.ntheta * 2) h.npI = h.npI / h.minc;
  if (!Number.isInteger(h.npI)) return null;
  const flags = version > 13 ? 6 : 5;
  const f = Array.from({ length: flags }, int).map((x) => x !== 0);
  if (version > 13) [h.lHeat, h.lChem, h.lPhase, h.lMag, h.lPress, h.lCondIc] = f;
  else { [h.lHeat, h.lChem, h.lMag, h.lPress, h.lCondIc] = f; h.lPhase = false; }

  if (off + w * (h.ntheta + h.nr) > size) return null;
  h.colat = Float64Array.from(floats(buf, dv, off, h.ntheta, le, w)); off += w * h.ntheta;
  h.radius = Float64Array.from(floats(buf, dv, off, h.nr, le, w)); off += w * h.nr;
  if (h.lMag && h.nric > 1) off += w * h.nric;
  h.dataOffset = off;

  h.fieldOrder = ['vr', 'vtheta', 'vphi'];
  if (h.lHeat) h.fieldOrder.push('entropy');
  if (h.lChem) h.fieldOrder.push('xi');
  if (h.lPhase) h.fieldOrder.push('phase');
  if (h.lPress) h.fieldOrder.push('pressure');
  if (h.lMag) h.fieldOrder.push('Br', 'Btheta', 'Bphi');

  const plane = h.ntheta * h.npI;
  h.expected = off + w * plane * h.nr * h.fieldOrder.length +
    (h.lMag && h.nric > 1 ? w * plane * h.nric * 3 : 0);
  // sanity: colatitudes in (0, pi), increasing
  for (let i = 0; i < h.ntheta; i++) {
    if (!(h.colat[i] > 0 && h.colat[i] < Math.PI)) return null;
    if (i && h.colat[i] <= h.colat[i - 1]) return null;
  }
  return h;
}

const GRAPH_FIELDS = {
  vr: { label: 'u_r', signed: true },
  vtheta: { label: 'u_θ', signed: true },
  vphi: { label: 'u_φ', signed: true },
  entropy: { label: 'T / entropy', signed: false },
  xi: { label: 'ξ (composition)', signed: false, cmap: 'cividis' },
  phase: { label: 'phase field', signed: false },
  pressure: { label: 'pressure', signed: true },
  Br: { label: 'B_r', signed: true },
  Btheta: { label: 'B_θ', signed: true },
  Bphi: { label: 'B_φ', signed: true },
};

const magicGraph = {
  name: 'MagIC graphic file (G_#)',
  detect(buf) {
    const size = buf.byteLength;
    if (size < 100) return null;
    // Old record-marker files start with a record of 20 bytes holding "Graphout_Version_XX".
    const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 4, 8));
    if (head === 'Graphout') {
      return { unsupported: 'old MagIC G file with Fortran record markers; re-run with a recent MagIC or convert it' };
    }
    let fallback = null;
    for (const le of [true, false]) {
      for (const w of [4, 8]) {
        let h;
        try { h = graphHeader(buf, le, w); } catch { h = null; }
        if (!h) continue;
        if (h.expected === size) return h;
        if (h.expected < size && !fallback) fallback = h;
      }
    }
    return fallback;
  },

  open(buf, name, h) {
    const dv = new DataView(buf);
    const plane = h.ntheta * h.npI;
    const nf = h.fieldOrder.length;
    const cache = new Map();
    const raw = (id, ir) => {
      const k = h.fieldOrder.indexOf(id);
      const key = id + '|' + ir;
      if (cache.has(key)) return cache.get(key);
      const off = h.dataOffset + h.w * plane * (ir * nf + k);
      const arr = floats(buf, dv, off, plane, h.le, h.w);
      if (arr.buffer !== buf) {
        cache.set(key, arr);
        if (cache.size > 64) cache.delete(cache.keys().next().value);
      }
      return arr;
    };
    const fields = h.fieldOrder.map((id) => ({ id, ...GRAPH_FIELDS[id] }));
    const info = [
      ['Format', 'MagIC G file v' + h.version + (h.w === 8 ? ' (double)' : '')],
      ['Run', h.runId],
      ['Time', fmt(h.time, 6)],
      ['Ra', fmt(h.ra)], ['Ek', fmt(h.ek)], ['Pr', fmt(h.pr)],
      ...(h.lMag ? [['Pm', fmt(h.prmag)]] : []),
      ...(h.lChem ? [['Ra_ξ', fmt(h.raxi)], ['Sc', fmt(h.sc)]] : []),
      ['r_i/r_o', fmt(h.radratio)],
      ['Grid (r, θ, φ)', `${h.nr} × ${h.ntheta} × ${h.npI * h.minc}`],
      ...(h.minc > 1 ? [['Symmetry m', h.minc]] : []),
    ];
    if (h.expected !== buf.byteLength) {
      info.push(['Warning', `file size ${buf.byteLength} B differs from expected ${h.expected} B`]);
    }
    return new GridProvider({
      format: 'magic-graph',
      radius: h.radius,
      colat: h.colat,
      nPhiStored: h.npI,
      symmetry: h.minc,
      strideT: 1,
      strideP: h.ntheta,
      raw,
      fields,
      info,
      magnetic: h.lMag ? { ids: ['Br', 'Btheta', 'Bphi'] } : null,
    });
  },
};

// ---------------------------------------------------------- potential files

function potHeader(buf, le) {
  const dv = new DataView(buf);
  const size = buf.byteLength;
  if (size < 128) return null;
  let off = 0;
  const i4 = () => { const v = dv.getInt32(off, le); off += 4; return v; };
  const f4 = () => { const v = dv.getFloat32(off, le); off += 4; return v; };
  const h = { le };
  h.version = i4();
  if (h.version !== 1 && h.version !== 2) return null;
  [h.time, h.ra, h.pr, h.raxi, h.sc, h.prmag, h.ek, h.radratio, h.sigma] =
    Array.from({ length: 9 }, f4);
  [h.nr, h.nric, h.lmax, h.minc, h.lmMax] = Array.from({ length: 5 }, i4);
  if (!(h.nr > 2 && h.nr < 1e5 && h.lmax > 0 && h.lmax < 1e5 && h.minc > 0 &&
        h.lmMax > 0 && h.nric >= 0 && h.nric < 1e5)) return null;
  if (h.version === 2) { h.mMin = i4(); h.mMax = i4(); }
  else { h.mMin = 0; h.mMax = Math.floor(h.lmax / h.minc) * h.minc; }
  [h.omegaIc, h.omegaMa] = [f4(), f4()];
  if (off + 8 * h.nr > size) return null;
  h.radius = Float64Array.from(floats(buf, dv, off, h.nr, le, 4)); off += 4 * h.nr;
  h.rho0 = Float64Array.from(floats(buf, dv, off, h.nr, le, 4)); off += 4 * h.nr;
  h.dataOffset = off;
  const block = 8 * h.nr * h.lmMax;
  const icBlock = 8 * h.nric * h.lmMax;
  const rest = size - off;
  if (rest === block) h.ncomp = 1;
  else if (rest === 2 * block || rest === 2 * block + 2 * icBlock) h.ncomp = 2;
  else return null;
  h.lay = lmLayout(h.lmax, mRange(h.mMax, h.minc, h.mMin));
  if (h.lay.lmMax !== h.lmMax) return null;
  return h;
}

const magicPot = {
  name: 'MagIC potential file (X_lmr_#)',
  detect(buf) {
    for (const le of [true, false]) {
      let h;
      try { h = potHeader(buf, le); } catch { h = null; }
      if (h) return h;
    }
    return null;
  },

  open(buf, name, h) {
    const dv = new DataView(buf);
    const base = name.split('/').pop();
    const mt = /^(V|B|T|Xi)_lmr/.exec(base);
    let kind = mt ? mt[1] : h.ncomp === 1 ? 'T' : 'V';
    if ((kind === 'T' || kind === 'Xi') !== (h.ncomp === 1)) kind = h.ncomp === 1 ? 'T' : 'V';
    const lm = h.lmMax, nr = h.nr, n = 2 * lm * nr;
    const pol = floats(buf, dv, h.dataOffset, n, h.le, 4);
    const tor = h.ncomp === 2 ? floats(buf, dv, h.dataOffset + 4 * n, n, h.le, 4) : null;
    const ell = h.lay.ell;
    let dpol = null;

    const lay = h.lay;
    const A = new Float64Array(2 * lm), Q = new Float64Array(2 * lm);
    const S = new Float64Array(2 * lm), T = new Float64Array(2 * lm);
    const useRho = kind === 'V';

    const coef = (ir) => {
      const o = 2 * lm * ir;
      if (h.ncomp === 1) {
        for (let k = 0; k < 2 * lm; k++) A[k] = pol[o + k];
        return { a: A };
      }
      const r = h.radius[ir], rho = useRho ? h.rho0[ir] : 1;
      const fr = 1 / (r * rho), fq = 1 / (r * r * rho);
      for (let q = 0; q < lm; q++) {
        const l2 = ell[q] * (ell[q] + 1);
        Q[2 * q] = l2 * fq * pol[o + 2 * q]; Q[2 * q + 1] = l2 * fq * pol[o + 2 * q + 1];
        T[2 * q] = fr * tor[o + 2 * q]; T[2 * q + 1] = fr * tor[o + 2 * q + 1];
      }
      // S needs the radial derivative of the poloidal potential, which only the
      // theta and phi components use: compute it on first access, so radial
      // components (and the potential-field exterior) never pay for it.
      let sReady = false;
      return {
        q: Q, t: T,
        get s() {
          if (!sReady) {
            if (!dpol) dpol = new RadialDerivative(h.radius, pol, 2 * lm, 'auto');
            const d = dpol.row(ir);
            for (let k = 0; k < 2 * lm; k++) S[k] = fr * d[k];
            sReady = true;
          }
          return S;
        },
      };
    };

    const sym = kind === 'V' ? 'u' : kind;
    const fields = h.ncomp === 1
      ? [{
        id: kind, label: kind === 'Xi' ? 'ξ (composition)' : 'T / entropy', signed: false, comp: 'a',
        ...(kind === 'Xi' ? { cmap: 'cividis' } : {}),
      }]
      : [
        { id: sym + '_r', label: sym + '_r', signed: true, comp: 'r' },
        { id: sym + '_t', label: sym + '_θ', signed: true, comp: 't' },
        { id: sym + '_p', label: sym + '_φ', signed: true, comp: 'p' },
      ];
    const info = [
      ['Format', `MagIC ${kind}_lmr file v${h.version}`],
      ['Time', fmt(h.time, 6)],
      ['Ra', fmt(h.ra)], ['Ek', fmt(h.ek)], ['Pr', fmt(h.pr)],
      ...(h.prmag ? [['Pm', fmt(h.prmag)]] : []),
      ['r_i/r_o', fmt(h.radratio)],
      ['ℓ_max, m_max, minc', `${h.lmax}, ${h.mMax}, ${h.minc}` + (h.mMin ? ` (m_min ${h.mMin})` : '')],
      ['n_r', nr],
    ];
    return new SpectralProvider({
      format: 'magic-pot', lay, radius: h.radius, kind: h.ncomp === 1 ? 'scalar' : 'vector',
      coef, fields, info,
      magnetic: kind === 'B' ? { ids: ['B_r', 'B_t', 'B_p'] } : null,
    });
  },
};

Object.assign(MV, { magicGraph, magicPot });
}
(self.MV_PARTS ||= []).push(mvMagic);
