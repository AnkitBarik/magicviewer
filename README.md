# MagIC Viewer

[![License: GPL v3](https://img.shields.io/github/license/AnkitBarik/magicviewer)](LICENSE)
[![GitHub Pages](https://github.com/AnkitBarik/magicviewer/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/AnkitBarik/magicviewer/actions/workflows/pages/pages-build-deployment)

Interactive 3D viewer for [MagIC](https://magic-sph.github.io) simulation
output that runs entirely in your browser. Files are read locally and never
uploaded.

**Open the viewer: <https://ankitbarik.github.io/magicviewer/>**

## Supported files

- Graphic files `G_#.TAG` (e.g. `G_1.run1`): all fields on the simulation grid.
- Potential files `V_lmr_#.TAG`, `B_lmr_#.TAG`, `T_lmr_#.TAG`, `Xi_lmr_#.TAG`:
  velocity, magnetic field, temperature/entropy and composition, from their
  spherical-harmonic coefficients.

## Usage

Open the viewer, then drop a file onto the page or click "Open a file". It also
works offline from a local copy: double-click `index.html` (three.js is still
loaded from the internet).

- **Views:** a spherical surface at any radius, the equatorial plane, a
  meridional plane and a cut-away. Hover over the model to read values.
- **Magnetic field:** "Field lines" traces lines through the shell and through
  the potential field outside it, out to the radius set by "Extrapolate to".
  The radius slider then continues outside the shell too.
- **Colours:** colormap, reverse, saturation, shading, and a lock to keep the
  colour range fixed. Field lines follow the colormap chosen for the magnetic
  field.
- **Sliders:** click a value to type one, and use ↺ to reset it.
- **Save PNG** exports the current view.

### Loading a file from a URL

Add `?url=` to share a view of a file on a web server:

```
https://ankitbarik.github.io/magicviewer/?url=https://example.org/G_1.run1
```

The server must allow cross-origin requests (CORS).

### Memory

The whole file is loaded into memory, so very large files need a machine with
enough RAM. The memory meter in the Data panel shows how much the viewer uses.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for how the viewer works, adding other
codes, tests and deployment.

## License

GPL-3.0, see [LICENSE](LICENSE).
