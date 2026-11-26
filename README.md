# MagIC Viewer

[![License: GPL v3](https://img.shields.io/github/license/AnkitBarik/magicviewer)](LICENSE)
[![GitHub Pages](https://github.com/AnkitBarik/magicviewer/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/AnkitBarik/magicviewer/actions/workflows/pages/pages-build-deployment)

Interactive 3D viewer for [MagIC](https://magic-sph.github.io) spherical-shell
simulation output, running entirely in the browser with
[three.js](https://threejs.org). Files are read locally and are never uploaded.

**Open the viewer: <https://ankitbarik.github.io/magicviewer/>**

**Supported codes and files**

| Code | Files | Content |
|---|---|---|
| [MagIC](https://magic-sph.github.io) | graphic files `G_#.TAG`, e.g. `G_1.run1` | fields on the (r, θ, φ) grid (stream format, single/double precision) |
| MagIC | potentials `V_lmr_#.TAG`, `B_lmr_#.TAG`, `T_lmr_#.TAG`, `Xi_lmr_#.TAG` | spherical-harmonic coefficients on the radial grid (versions 1 and 2) |

Formats are detected from the file contents. The file name is only used to tell
which physical field a file holds (e.g. `V_lmr` vs `B_lmr`).

**Views:** a spherical surface at any radius, the equatorial plane, a meridional
plane, and a cut-away quarter. It also has hover read-out, several colormaps,
saturation and range locking, shading, and PNG export. Every slider value can
also be typed in, and reset to its default.

A reader for [XSHELLS](https://nschaeff.bitbucket.io/xshells/) field files
(`fieldU_*`, `fieldB_*`, …) is included in `js/formats/xshells.js` but not
enabled yet, as it still needs testing. Add `?experimental=1` to the page URL to
try it.

**Magnetic fields** (MagIC G files with B, `B_lmr`):

- *Potential-field extrapolation* outside the outer boundary r_o, assuming a
  current-free insulating exterior: Q_lm(r) = Q_lm(r_o)(r_o/r)^(l+2) and
  S_lm = −Q_lm/(l+1). It is switched on together with the field lines, out to
  the radius set by "Extrapolate to" (up to 4 r_o; 1.00 turns it off). While
  it is on, the radius slider continues past r_o. For G files, B_r at r_o is
  first analysed into spherical harmonics using Gauss–Legendre quadrature on
  MagIC's grid.
- *Field lines* are traced with fixed-step RK4 through a coarse 3D sample of
  **B** and coloured by the sign of B_r at the seed (red: outward). Seeds are
  drawn in proportion to |B_r| near r_o. With extrapolation on, lines start at
  r_o, run through the potential field, and continue into the shell for at most
  the length set by "Length inside r_o".

## Usage

Open <https://ankitbarik.github.io/magicviewer/>, or double-click `index.html`
in a local copy (no server needed), then drop a file onto it or pick one.

A file on a web server can be loaded with `?url=`, which is handy for sharing.
For a file hosted at `https://example.org/G_1.run1`:

```
https://ankitbarik.github.io/magicviewer/?url=https://example.org/G_1.run1
```

The server hosting the file must allow cross-origin requests (CORS).

Query parameters:

- `url=`: file to load at start-up.
- `experimental=1`: also use readers that are still being validated (XSHELLS).

There is no file-size limit, but the whole file is held in memory. For spectral
files the Legendre tables are also kept, about 80 MB at ℓ_max ≈ 340. The memory
meter in the Data panel shows what the viewer holds against the device RAM
reported by the browser. Only Chromium-based browsers report it, rounded and
capped at 8 GB, and no browser reports free RAM.

## How it works

- `js/formats/`: one adapter per code. Each detects its format from the header
  and size, and returns a *provider*.
  - `GridProvider` (`js/core/grid.js`): data that is already on a grid (MagIC G files).
  - `SpectralProvider` (`js/core/spectral.js`): spherical-harmonic data. Adapters
    convert their coefficients to one convention (orthonormal, no
    Condon–Shortley phase) and supply radial/spheroidal/toroidal coefficients
    (Q, S, T) at each radius. The provider synthesizes shells, the equator and
    meridional planes. It uses Legendre parity, and computes the half-planes at
    φ and φ+π in a single pass. The display grid resolves the data: at least
    ℓ_max + 1 colatitudes and an FFT-friendly number of longitudes (at least
    2 m_max + 2, about twice the colatitudes), e.g. 342 × 720 at ℓ_max = 341.
    Longitudes are synthesized with a mixed-radix FFT (`InverseDFT` in
    `js/core/sht.js`).
- Radial derivatives of poloidal potentials (needed only for the θ and φ
  components, so they are computed on first use):
  - MagIC Chebyshev grids, including mapped grids: exact (Chebyshev, through the
    grid mapping).
  - XSHELLS: second-order finite differences, as in `xspp` and `pyxshells`.
  - Other grids: fourth-order finite differences.
- Everything heavy runs in a Web Worker (`js/worker.js`).
- No build step, and `index.html` also works when opened straight from disk
  (`file://`), where browsers block ES modules and worker files. So the code uses
  classic scripts: each file defines one function, e.g. `function mvSht(MV)`.
  That function reads what it needs from the shared namespace `MV`, adds its
  exports to it, and registers itself in `self.MV_PARTS`. `index.html` loads the
  files in dependency order. `js/main.js` runs every part except `mvWorker`, and
  starts the worker from a Blob built from the source of all the parts, so no
  worker file has to be fetched. three.js is loaded from the CDN with dynamic
  `import()` through the import map, which needs an internet connection.

### Adding another code

Write `js/formats/<code>.js` in the same pattern as `js/formats/magic.js`: a
function `mv<Code>(MV)` that adds an adapter `{ name, detect(buf, name), open(buf, name, header) }`
to `MV` and registers itself in `self.MV_PARTS`. Have `open` return either a
`GridProvider` or a `SpectralProvider`. Then add the adapter to `FORMATS` (or
`EXPERIMENTAL`) in `js/formats/index.js`, and add a `<script>` tag for the file
before `js/formats/index.js` in `index.html` and `tests/test.html`.

## Tests

`tests/make_reference.py` evaluates fields with each code's own Python tools
(`pyxshells` + `shtns`, and the `magic` package). `tests/test.html` compares the
viewer's readers and transforms against those values:

For example, for a run in `~/runs/dynamo` with files `G_1.run1` and
`V_lmr_1.run1`, and this repository cloned to `~/magicviewer`:

```sh
# reference values (needs the MagIC python package on PYTHONPATH);
# writes tests/reference/G_1.run1.json and tests/reference/V_lmr_1.run1.json
cd ~/magicviewer
python tests/make_reference.py magic_graph ~/runs/dynamo/G_1.run1 magic_pot ~/runs/dynamo/V_lmr_1.run1

# serve a folder that holds both the repository and the data files
cd ~/runs/dynamo && ln -s ~/magicviewer . && python -m http.server
```

Then open
`http://localhost:8000/magicviewer/tests/test.html?refs=reference/G_1.run1.json,reference/V_lmr_1.run1.json&data=/`.
`refs` lists the reference files and `data` is the URL prefix of the data files
on that server. The page ends with `ALL PASSED` or the number of failures. The
XSHELLS case works the same way: `python tests/make_reference.py xshells fieldU_0001.job`
(needs `pyxshells` and `shtns`).

`tests/shoot.py` drives headless Chrome to take screenshots. With `--file` it
opens a local file in the page, which also works for `file://` pages:

```sh
python tests/shoot.py file://$HOME/magicviewer/index.html out.png --file ~/runs/dynamo/G_1.run1 \
    --wait "document.documentElement.dataset.state === 'ready'"
```

## Deployment

The site is static, with no build step. It is served by GitHub Pages from the
`main` branch (root folder) of
[AnkitBarik/magicviewer](https://github.com/AnkitBarik/magicviewer) at
<https://ankitbarik.github.io/magicviewer/>, and every push to `main` updates it.
