// Grid-space data provider: fields already sampled on (r, theta, phi).
//
// The adapter supplies raw(fieldId, ir) -> Float32Array for one radius, with
// value(theta index t, phi index p) = arr[t*strideT + (p % nPhiStored)*strideP].
// Azimuthal symmetry (minc) is handled by storing one sector and replicating.
//
// Classic script (not an ES module) so the viewer also runs from file://; see
// "How it works" in README.md. The body is not indented to keep it identical to
// the module it was converted from.

function mvGrid(MV) {
'use strict';

class GridProvider {
  /**
   * @param {object} o
   * @param {Float64Array} o.radius
   * @param {Float64Array} o.colat     colatitudes (radians, increasing)
   * @param {number} o.nPhiStored     phi points stored per sector
   * @param {number} o.symmetry       number of sectors (minc)
   * @param {number} o.strideT
   * @param {number} o.strideP
   * @param {(id:string, ir:number)=>Float32Array} o.raw
   * @param {Array} o.fields
   * @param {Array} o.info
   */
  constructor(o) {
    Object.assign(this, o);
    this.nTheta = this.colat.length;
    this.nPhi = this.nPhiStored * this.symmetry;
  }

  get grid() {
    return { colat: this.colat, nPhi: this.nPhi, phi0: 0 };
  }

  shell(fieldId, ir) {
    const a = this.raw(fieldId, ir);
    const nt = this.nTheta, np = this.nPhi, ns = this.nPhiStored;
    const out = new Float32Array(nt * np);
    for (let t = 0; t < nt; t++) {
      for (let p = 0; p < np; p++) {
        out[t * np + p] = a[t * this.strideT + (p % ns) * this.strideP];
      }
    }
    return out;
  }

  equator(fieldId) {
    const nt = this.nTheta, np = this.nPhi, ns = this.nPhiStored, nr = this.radius.length;
    // colatitudes bracketing pi/2 (Gauss grids are symmetric about the equator)
    let t1 = 0;
    while (t1 < nt - 1 && this.colat[t1 + 1] < Math.PI / 2) t1++;
    const t2 = Math.min(t1 + 1, nt - 1);
    const c1 = this.colat[t1], c2 = this.colat[t2];
    const w2 = t2 === t1 ? 0 : (Math.PI / 2 - c1) / (c2 - c1), w1 = 1 - w2;
    const out = new Float32Array(nr * np);
    for (let ir = 0; ir < nr; ir++) {
      const a = this.raw(fieldId, ir);
      for (let p = 0; p < np; p++) {
        const q = (p % ns) * this.strideP;
        out[ir * np + p] = w1 * a[t1 * this.strideT + q] + w2 * a[t2 * this.strideT + q];
      }
    }
    return out;
  }

  meridian(fieldId, phi) {
    const nt = this.nTheta, np = this.nPhi, ns = this.nPhiStored, nr = this.radius.length;
    const x = ((((phi / (2 * Math.PI)) % 1) + 1) % 1) * np;
    const p1 = Math.floor(x) % np, p2 = (p1 + 1) % np, w2 = x - Math.floor(x), w1 = 1 - w2;
    const q1 = (p1 % ns) * this.strideP, q2 = (p2 % ns) * this.strideP;
    const out = new Float32Array(nr * nt);
    for (let ir = 0; ir < nr; ir++) {
      const a = this.raw(fieldId, ir);
      for (let t = 0; t < nt; t++) {
        const o = t * this.strideT;
        out[ir * nt + t] = w1 * a[o + q1] + w2 * a[o + q2];
      }
    }
    return out;
  }
}

Object.assign(MV, { GridProvider });
}
(self.MV_PARTS ||= []).push(mvGrid);
