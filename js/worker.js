// Web worker: reads the file, detects its format and evaluates slices on demand,
// so that heavy spectral transforms never block the UI.
//
// Classic script (not an ES module) so the viewer also runs from file://; see
// "How it works" in README.md. The body is not indented to keep it identical to
// the module it was converted from.

function mvWorker(MV) {
'use strict';
const { openBuffer, makeExterior, sampleLevels, makeVolume, Tracer } = MV;

let provider = null;
let exterior = null; // { factor, ext }
let volInterior = null; // sampled interior levels for tracing
const volExterior = new Map(); // factor -> sampled exterior levels

const EXT_LEVELS = 32;

function getExterior(factor) {
  if (!exterior || exterior.factor !== factor) {
    const ro = Math.max(...provider.radius);
    exterior = { factor, ext: makeExterior(provider, provider.magnetic, ro * factor, EXT_LEVELS) };
  }
  return exterior.ext;
}

function fieldLines(n, factor, inLen) {
  const ids = provider.magnetic.ids;
  if (!volInterior) {
    // at most ~48 interior levels, always including both boundaries
    const nr = provider.radius.length, k = Math.min(nr, 48);
    const irs = [...new Set(Array.from({ length: k }, (_, i) => Math.round((i * (nr - 1)) / (k - 1))))];
    volInterior = sampleLevels(provider, ids, irs);
  }
  const sets = [volInterior];
  if (factor > 1) {
    if (!volExterior.has(factor)) {
      const ext = getExterior(factor);
      volExterior.clear();
      volExterior.set(factor, sampleLevels(ext, ids, Array.from(ext.radius, (_, i) => i),
        { colat: volInterior.colat, nPhi: volInterior.nPhi }));
    }
    sets.push(volExterior.get(factor));
  }
  const tracer = new Tracer(makeVolume(...sets));
  const rs = Math.max(...provider.radius), ri = Math.min(...provider.radius);
  const h = 0.006 * rs;
  // length travelled inside r_o is capped (in units of r_o, per direction)
  if (factor > 1) {
    // seeds on the outer boundary; lines run through the potential field and,
    // up to the cap, into the interior
    const cap = Math.ceil((inLen * rs) / h);
    if (cap === 0) tracer.rmin = rs * (1 - 1e-9);
    return tracer.lines(rs, n, h, Math.ceil((4 * rs * factor) / h) + cap, rs, Math.max(1, cap));
  }
  // interior only: seeds just inside r_o
  const cap = Math.ceil((Math.max(inLen, 0.5) * rs) / h);
  return tracer.lines(rs - 0.03 * (rs - ri), n, h, cap);
}

async function readUrl(url, id) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} while fetching ${url}`);
  const len = Number(res.headers.get('content-length'));
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    chunks.push(value);
    if (len) postMessage({ type: 'progress', id, frac: got / len, text: 'Downloading' });
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out.buffer;
}

const mb = (b) => (b / 2 ** 20).toFixed(0) + ' MB';
const outOfMemory = (size) =>
  `Could not hold the ${size ? mb(size) + ' ' : ''}file in memory: the browser refused the allocation. ` +
  'Close other tabs or use a machine with more RAM.';

// ------------------------------------------------------------------ memory
// Bytes held by the worker: the file buffer (while anything still uses it) and
// every typed array reachable from the provider, exterior and tracing volumes.
// Buffers captured only inside closures are not seen, except the file buffer,
// which is tracked through a WeakRef so that holding it here does not keep it alive.
let fileRef = null;
function heldBytes() {
  const seen = new Set();
  const visited = new Set();
  const walk = (v, depth) => {
    if (v === null || typeof v !== 'object' || depth > 8 || visited.has(v)) return;
    visited.add(v);
    if (v instanceof ArrayBuffer) { seen.add(v); return; }
    if (ArrayBuffer.isView(v)) { seen.add(v.buffer); return; }
    if (v instanceof Map) { for (const x of v.values()) walk(x, depth + 1); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk([provider, exterior, volInterior, volExterior], 0);
  const buf = fileRef?.deref();
  if (buf) seen.add(buf);
  let total = 0;
  for (const b of seen) total += b.byteLength;
  return total;
}
const reportMemory = () => postMessage({ type: 'memory', bytes: heldBytes() });

function metaOf(p, name, size) {
  return {
    fileName: name,
    fileSize: size,
    formatName: p.formatName,
    kind: p instanceof Object && p.lay ? 'spectral' : 'grid',
    info: p.info,
    notes: p.notes ?? null,
    fields: p.fields.map(({ id, label, signed, cmap }) => ({ id, label, signed, cmap })),
    magnetic: p.magnetic ?? null,
    radius: Array.from(p.radius),
    colat: Array.from(p.grid.colat),
    nPhi: p.grid.nPhi,
  };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.cmd === 'open') {
      provider = null;
      exterior = null;
      volInterior = null;
      volExterior.clear();
      fileRef = null;
      reportMemory();
      let buf, name;
      if (msg.file) {
        name = msg.file.name;
        postMessage({ type: 'progress', id: msg.id, text: 'Reading file' });
        try {
          buf = await msg.file.arrayBuffer();
        } catch (err) {
          throw new Error(outOfMemory(msg.file.size));
        }
      } else {
        name = decodeURIComponent(new URL(msg.url).pathname.split('/').pop());
        try {
          buf = await readUrl(msg.url, msg.id);
        } catch (err) {
          if (err instanceof RangeError) throw new Error(outOfMemory(0));
          throw err;
        }
      }
      fileRef = new WeakRef(buf);
      postMessage({ type: 'progress', id: msg.id, text: 'Parsing' });
      provider = openBuffer(buf, name, { experimental: !!msg.experimental });
      provider.onProgress = null;
      postMessage({ type: 'meta', id: msg.id, meta: metaOf(provider, name, buf.byteLength) });
      reportMemory();
      return;
    }
    if (!provider) throw new Error('No file loaded');
    provider.onProgress = (frac) => postMessage({ type: 'progress', id: msg.id, frac, text: 'Computing' });
    const t0 = performance.now();
    let data;
    if (msg.cmd === 'exterior') {
      const ext = getExterior(msg.factor);
      postMessage({ type: 'data', id: msg.id, radius: Array.from(ext.radius) });
      reportMemory();
      return;
    }
    if (msg.cmd === 'fieldlines') {
      const res = fieldLines(msg.n, msg.factor, msg.inLen);
      provider.onProgress = null;
      postMessage({ type: 'data', id: msg.id, ...res, ms: performance.now() - t0 },
        [res.points.buffer, res.offsets.buffer, res.polarity.buffer]);
      reportMemory();
      return;
    }
    if (msg.cmd === 'shell' && msg.ext) data = getExterior(msg.factor).shell(msg.field, msg.ir);
    else if (msg.cmd === 'shell') data = provider.shell(msg.field, msg.ir);
    else if (msg.cmd === 'equator') data = provider.equator(msg.field);
    else if (msg.cmd === 'meridian') data = provider.meridian(msg.field, msg.phi).slice();
    else throw new Error('unknown command ' + msg.cmd);
    provider.onProgress = null;
    postMessage({ type: 'data', id: msg.id, data, ms: performance.now() - t0 }, [data.buffer]);
    reportMemory();
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: err?.message ?? String(err) });
  }
};
}
(self.MV_PARTS ||= []).push(mvWorker);
