#!/usr/bin/env python3
"""Generate reference values with the codes' own Python tools.

Usage:
    python tests/make_reference.py CASE FILE [CASE FILE ...]

CASE is one of: xshells, magic_pot, magic_graph.
Writes tests/reference/<basename>.json, consumed by tests/test.html.

Requirements: numpy; for xshells: pyxshells + shtns (XSHELLS_PY env var may point
to the xshells python/ directory); for magic: the MagIC python package on PYTHONPATH.
"""
import json
import os
import sys

import numpy as np

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'reference')
rng = np.random.default_rng(1)


def pick(shape, n=300):
    return [tuple(int(rng.integers(0, s)) for s in shape) for _ in range(n)]


def xshells_case(fname):
    sys.path.insert(0, os.environ.get('XSHELLS_PY', os.path.expanduser('~/xshells-2.12/python')))
    import pyxshells as px
    S = px.load_field(fname, lazy=False)
    lmax = S.lmax
    nlat = max(32, 2 * ((3 * lmax) // 4 + 1))
    nlat += nlat % 2
    nphi = 2 * nlat
    S.sht.set_grid(nlat, nphi)
    colat = np.arccos(S.sht.cos_theta)
    irs, ire = S.irs, S.ire
    r = S.grid.r
    phys = [ir for ir in range(irs, ire + 1) if r[ir] > 0]
    cases = []
    vector = S.ncomp() == 2
    # interior shells only (boundaries depend on ghost-point conventions)
    for ir in phys[2:-2:max(1, len(phys) // 6)]:
        k = phys.index(ir)
        if vector:
            comps = S.spat_shell(ir)
        else:
            comps = (S.spat_shell(ir),)
        for name, arr in zip(('r', 't', 'p') if vector else ('a',), comps):
            arr = np.asarray(arr)
            assert arr.shape == (nlat, nphi), arr.shape
            pts = pick(arr.shape)
            cases.append({'ir': k, 'comp': name,
                          'points': [[j, p, float(arr[j, p])] for j, p in pts],
                          'scale': float(np.abs(arr).max())})
    return {'format': 'xshells', 'colat': colat.tolist(), 'nPhi': nphi, 'shells': cases}


def cheb_mapped_derivative(data, r):
    """d/dr of data[..., nr] on a (possibly mapped) Gauss-Lobatto grid: D_x f / (dr/dx).

    Independent numpy implementation (Trefethen differentiation matrix +
    Chebyshev least-squares fit of the grid mapping r(x))."""
    from numpy.polynomial import chebyshev as C
    n = len(r) - 1
    x = np.cos(np.pi * np.arange(n + 1) / n)
    c = np.ones(n + 1); c[0] = c[-1] = 2; c *= (-1.0) ** np.arange(n + 1)
    X = np.tile(x, (n + 1, 1)).T
    D = np.outer(c, 1 / c) / (X - X.T + np.eye(n + 1))
    D -= np.diag(D.sum(axis=1))
    drdx = C.chebval(x, C.chebder(C.chebfit(x, r, 30)))
    return np.tensordot(data, D, axes=[-1, 1]) / drdx


def magic_pot_case(fname):
    from magic import MagicPotential
    d, base = os.path.split(os.path.abspath(fname))
    field, rest = base.split('_lmr_')
    ipot, tag = rest.split('.', 1)
    cwd = os.getcwd()
    os.chdir(d)
    try:
        p = MagicPotential(field=field, datadir='.', tag=tag, ipot=int(ipot),
                           setup_SHT=True, verbose=False)
    finally:
        os.chdir(cwd)
    ell = p.ell
    nr = p.n_r_max
    vector = field in ('V', 'B')
    rho = p.rho0 if field == 'V' else np.ones(nr)
    if vector:
        # MagIC's rderavg is spectral only on unmapped grids (first-order FD otherwise)
        dw = cheb_mapped_derivative(p.pol, p.radius.astype(float))
    cases = []
    for ir in range(4, nr - 4, max(1, nr // 6)):
        r = p.radius[ir]
        comps = {}
        if vector:
            comps['r'] = p.sh.spec_spat(p.pol[:, ir] * ell * (ell + 1) / r**2 / rho[ir])
            vt, vp = p.sh.spec_spat(dw[:, ir], p.tor[:, ir])
            comps['t'] = vt / r / rho[ir]
            comps['p'] = vp / r / rho[ir]
        else:
            comps['a'] = p.sh.spec_spat(p.pol[:, ir])
        for name, arr in comps.items():
            arr = np.asarray(arr)  # (nphi, ntheta)
            pts = pick(arr.shape)
            cases.append({'ir': ir, 'comp': name,
                          'points': [[t, ph, float(arr[ph, t])] for ph, t in pts],
                          'scale': float(np.abs(arr).max())})
    return {'format': 'magic-pot', 'colat': np.asarray(p.colat).tolist(),
            'nPhi': int(p.n_phi_max), 'shells': cases}


def magic_graph_case(fname):
    from magic import MagicGraph
    d, base = os.path.split(os.path.abspath(fname))
    ivar, tag = base[2:].split('.', 1)
    cwd = os.getcwd()
    os.chdir(d)
    try:
        g = MagicGraph(ivar=int(ivar), tag=tag, datadir='.')
    finally:
        os.chdir(cwd)
    cases = []
    for name in ('vr', 'vtheta', 'vphi', 'entropy', 'Br'):
        if not hasattr(g, name):
            continue
        arr = getattr(g, name)  # (npI, ntheta, nr)
        pts = pick(arr.shape, 100)
        cases.append({'field': name,
                      'points': [[ir, t, p, float(arr[p, t, ir])] for p, t, ir in pts],
                      'scale': float(np.abs(arr).max())})
    return {'format': 'magic-graph', 'fields': cases}


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    args = sys.argv[1:]
    for case, fname in zip(args[::2], args[1::2]):
        ref = {'xshells': xshells_case, 'magic_pot': magic_pot_case,
               'magic_graph': magic_graph_case}[case](fname)
        ref['file'] = os.path.basename(fname)
        out = os.path.join(OUT, os.path.basename(fname) + '.json')
        with open(out, 'w') as f:
            json.dump(ref, f)
        print('wrote', out)
