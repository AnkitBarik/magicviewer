# MagIC Viewer

Interactive 3D viewer for spherical-shell simulation output, running entirely in
the browser with [three.js](https://threejs.org). Files are read locally and are
never uploaded.

**Supported codes and files**

| Code | Files | Content |
|---|---|---|
| [MagIC](https://magic-sph.github.io) | `G_#.TAG` | fields on the (r, θ, φ) grid (stream format, single/double precision) |
| MagIC | `V_lmr_#`, `B_lmr_#`, `T_lmr_#`, `Xi_lmr_#` | spherical-harmonic potentials (versions 1 and 2) |

Formats are detected from the file contents. The file name is only used to tell
which physical field a file holds (e.g. `V_lmr` vs `B_lmr`, `fieldU` vs `fieldB`).

**Views:** a spherical surface at any radius, the equatorial plane, a meridional
plane, and a cut-away quarter. It also has hover read-out, several colormaps,
saturation and range locking, shading, and PNG export.

A reader for [XSHELLS](https://nschaeff.bitbucket.io/xshells/) field files
(`fieldU_*`, `fieldB_*`, …) is included in `js/formats/xshells.js` but not
enabled yet, as it still needs testing. Add `?experimental=1` to the page URL to
try it.

**Magnetic fields** (MagIC G files with B, `B_lmr`):

- *Potential-field extrapolation* outside the outer boundary r_o, assuming a
  current-free insulating exterior: Q_lm(r) = Q_lm(r_o)(r_o/r)^(l+2) and
  S_lm = −Q_lm/(l+1). It is switched on together with the field lines, out to
  the radius set by "Extrapolate to" (up to 4 r_o; 1.00 turns it off). While
  it is on, the radius slider continues past r_o. For G files, B_r at r_o is first analysed into
  spherical harmonics using Gauss–Legendre quadrature on MagIC's grid.
- *Field lines* are traced with fixed-step RK4 through a coarse 3D sample of
  **B** and coloured by the sign of B_r at the seed (red: outward). Seeds are
  drawn in proportion to |B_r| near r_o. With extrapolation on, lines are traced
  in the potential-field region only.

## Usage

Open `index.html`, either hosted or by double-clicking it locally (no server
needed), then drop a file onto it or pick one. You can also load a file
from a URL, which is handy for sharing:

```
https://<user>.github.io/magic-viewer/?url=https://example.org/G_1.test
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

```sh
python tests/make_reference.py xshells path/to/fieldU_0001.job magic_pot path/to/V_lmr_1.run
python -m http.server            # from a directory that contains this repo and the data
# open  http://localhost:8000/<repo>/tests/test.html?refs=reference/fieldU_0001.job.json&data=/<data-dir>/
```

`tests/shoot.py` drives headless Chrome to take screenshots.

## Deployment

The site is static, with no build step. Enable GitHub Pages on the `main` branch,
root folder.
