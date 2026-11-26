// Format registry. Each format exposes:
//   name                       human-readable name
//   detect(buf, name) -> hdr   parsed header if the content matches, else null
//                              ({unsupported: reason} for known-but-unsupported variants)
//   open(buf, name, hdr) -> provider (GridProvider or SpectralProvider)
// Detection is content-based (headers + size consistency), so file names do not
// matter, except as hints for the physical field (e.g. V_lmr vs B_lmr, fieldU vs fieldB).
//
// To add a code, write an adapter in this folder and append it below.
// Adapters still being validated go in EXPERIMENTAL: they are used only when
// openBuffer is called with { experimental: true } (the page's ?experimental=1).
//
// Classic script (not an ES module) so the viewer also runs from file://; see
// "How it works" in README.md. The body is not indented to keep it identical to
// the module it was converted from.

function mvFormats(MV) {
'use strict';
const { xshells, magicPot, magicGraph } = MV;

const FORMATS = [magicPot, magicGraph];
const EXPERIMENTAL = [xshells];

function openBuffer(buf, name, { experimental = false } = {}) {
  const active = experimental ? [...EXPERIMENTAL, ...FORMATS] : FORMATS;
  for (const f of active) {
    const h = f.detect(buf, name);
    if (!h) continue;
    if (h.unsupported) throw new Error(`${f.name}: ${h.unsupported}`);
    const p = f.open(buf, name, h);
    p.formatName = f.name;
    return p;
  }
  const hidden = experimental ? null : EXPERIMENTAL.find((f) => f.detect(buf, name));
  if (hidden) {
    throw new Error(`This looks like a ${hidden.name}, which is not supported yet ` +
      '(add ?experimental=1 to the page URL to try the untested reader).');
  }
  throw new Error(
    'Unrecognised file. Supported: ' + active.map((f) => f.name).join(', ') + '.');
}

Object.assign(MV, { FORMATS, EXPERIMENTAL, openBuffer });
}
(self.MV_PARTS ||= []).push(mvFormats);
