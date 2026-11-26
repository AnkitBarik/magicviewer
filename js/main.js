// Classic script (not an ES module) so the viewer runs both when hosted and when
// index.html is opened straight from disk (file://), where browsers block local
// module files and worker scripts. three.js comes from the CDN through dynamic
// import(), resolved by the import map in index.html; the other parts are loaded
// by <script> tags and registered in self.MV_PARTS (see README, "How it works").
(async () => {
const THREE = await import('three');
const [{ OrbitControls }, { LineSegments2 }, { LineSegmentsGeometry }, { LineMaterial }] = await Promise.all([
  import('three/addons/controls/OrbitControls.js'),
  import('three/addons/lines/LineSegments2.js'),
  import('three/addons/lines/LineSegmentsGeometry.js'),
  import('three/addons/lines/LineMaterial.js'),
]);
const MV = {};
for (const part of self.MV_PARTS) if (part.name !== 'mvWorker') part(MV);
const { lut, DIVERGING, SEQUENTIAL } = MV;

// ------------------------------------------------------------------ settings
const params = new URLSearchParams(location.search);
const TWO_PI = 2 * Math.PI;
const EXPERIMENTAL = params.get('experimental') === '1'; // enable readers still being validated

const $ = (id) => document.getElementById(id);
const ui = {
  panel: $('panel'), panelToggle: $('panelToggle'), panelOpen: $('panelOpen'),
  fileInput: $('fileInput'), urlForm: $('urlForm'), urlInput: $('urlInput'),
  memText: $('memText'), memBar: $('memBar'), memNote: $('memNote'), infoSection: $('infoSection'), fileName: $('fileName'),
  info: $('info'), notesBox: $('notesBox'), notes: $('notes'), controls: $('controls'),
  field: $('fieldSelect'), showShell: $('showShell'), radius: $('radius'), radiusOut: $('radiusOut'),
  showEq: $('showEq'), showMer: $('showMer'), cutaway: $('cutaway'), phi: $('phi'), phiOut: $('phiOut'),
  phiRow: $('phiRow'), cutStart: $('cutStart'), cutStartOut: $('cutStartOut'), cutStartRow: $('cutStartRow'),
  cutEnd: $('cutEnd'), cutEndOut: $('cutEndOut'), cutEndRow: $('cutEndRow'),
  cmap: $('cmap'), cmapRev: $('cmapRev'), sat: $('sat'), satOut: $('satOut'), lockRange: $('lockRange'),
  shading: $('shading'), shadingOut: $('shadingOut'),
  cbBox: $('cbBox'), cbLabel: $('cbLabel'), colorbar: $('colorbar'), cbMin: $('cbMin'), cbMid: $('cbMid'), cbMax: $('cbMax'),
  resetView: $('resetView'), snapshot: $('snapshot'),
  status: $('status'), statusText: $('statusText'), progressBar: $('progressBar'),
  busy: $('busy'), busyBar: $('busyBar'), busyText: $('busyText'),
  canvas: $('canvas'), view: $('view'), empty: $('empty'), tooltip: $('tooltip'),
  dropOverlay: $('dropOverlay'), viewBar: $('viewBar'),
  magSection: $('magSection'), showLines: $('showLines'), nLines: $('nLines'), nLinesOut: $('nLinesOut'),
  lineOpts: $('lineOpts'), rExt: $('rExt'), rExtOut: $('rExtOut'), inLen: $('inLen'), inLenOut: $('inLenOut'),
};

// ------------------------------------------------------------------ three.js
THREE.ColorManagement.enabled = false; // colormap values are used as-is
const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, ui.canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 1.2;
controls.maxDistance = 20;
function resetView() {
  camera.position.set(3.2, -3.4, 2.1);
  controls.target.set(0, 0, 0);
  controls.update();
}
resetView();

// Lighting: ambient + a head-light that follows the camera (from the viewer's upper left).
// With shading s, surface brightness ranges from (1 - s) to 1 times the colormap color.
// (three.js Lambert divides by pi, hence the factor pi in the intensities.)
const ambient = new THREE.AmbientLight(0xffffff, 1);
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.position.set(-1.2, 1.5, 2);
camera.add(sun);
scene.add(ambient, camera);
function setShading(s) {
  ambient.intensity = Math.PI * (1 - s);
  sun.intensity = Math.PI * s;
  requestRender();
}

const dataGroup = new THREE.Group();
const decoGroup = new THREE.Group();
const lineGroup = new THREE.Group();
scene.add(dataGroup, decoGroup, lineGroup);
const lineMaterial = new LineMaterial({ color: 0xffffff, linewidth: 1.6, vertexColors: true });

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  return { bg: cs.getPropertyValue('--view-bg').trim(), line: cs.getPropertyValue('--muted').trim() };
}
function applyTheme() {
  const t = themeColors();
  scene.background = new THREE.Color(t.bg);
  decoGroup.traverse((o) => { if (o.material?.color && o.userData.themed) o.material.color.set(t.line); });
  requestRender();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// Width taken by the colorbar on the right; the view is shifted left by half of
// it, so the model is centred in the free area instead of under the bar.
const colorbarSpace = () => (ui.cbBox.hidden ? 0 : ui.cbBox.offsetWidth + 24);
function resize() {
  const w = ui.view.clientWidth, h = ui.view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.setViewOffset(w, Math.max(h, 1), colorbarSpace() / 2, 0, w, Math.max(h, 1));
  lineMaterial.resolution.set(w, h);
  camera.updateProjectionMatrix();
  requestRender();
}
const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(ui.view);
resizeObserver.observe(ui.cbBox);

let renderPending = false;
function requestRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    if (controls.update()) requestRender();
    renderer.render(scene, camera);
  });
}
controls.addEventListener('change', requestRender);

// ------------------------------------------------------------------ worker
// The worker is built from a Blob holding the source of every registered part,
// which also works on file:// pages, where loading a worker file is blocked.
const workerSrc = 'const MV = {};\n' + self.MV_PARTS.map((f) => `(${f})(MV);`).join('\n');
const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
let reqId = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const m = e.data;
  const p = pending.get(m.id);
  if (m.type === 'memory') { workerBytes = m.bytes; showMemory(); return; }
  if (m.type === 'progress') {
    if (p) setStatus(`${m.text ?? 'Working'}${m.frac != null ? ` ${Math.round(100 * m.frac)}%` : '…'}`, m.frac);
    const job = busyJobs.get(m.id);
    if (job) { job.frac = m.frac ?? null; if (m.text && job.cmd === 'open') job.what = m.text; refreshBusy(); }
    return;
  }
  if (!p) return;
  pending.delete(m.id);
  busyJobs.delete(m.id);
  refreshBusy();
  if (m.type === 'error') p.reject(new Error(m.message));
  else p.resolve(m);
};
function call(msg) {
  const id = ++reqId;
  busyJobs.set(id, busyJob(msg));
  refreshBusy();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id });
  });
}

// ------------------------------------------------------------------ busy overlay
// While any worker request is pending, a progress bar and label sit on top of
// the view, so it is clear that the picture is still the previous one. They
// appear only after a short delay, so fast updates (most shells) do not flicker.
const busyJobs = new Map(); // request id -> { cmd, field, what, frac }
let busyTimer = null;
function busyJob(msg) {
  const what = {
    open: 'Opening file', shell: msg.ext ? 'potential-field shell' : 'shell', equator: 'equatorial plane',
    meridian: 'meridional planes', fieldlines: 'Tracing field lines', exterior: 'Computing the potential field outside r_o',
  }[msg.cmd] ?? 'Working';
  const field = msg.field && meta ? meta.fields.find((f) => f.id === msg.field)?.label : null;
  return { cmd: msg.cmd, field, what, frac: null };
}
function refreshBusy() {
  if (!busyJobs.size) {
    clearTimeout(busyTimer); busyTimer = null;
    ui.busy.hidden = true;
    return;
  }
  const job = [...busyJobs.values()].at(-1); // most recent request
  const pct = job.frac != null ? ` · ${Math.round(100 * job.frac)}%` : '…';
  ui.busyText.replaceChildren(job.field ? `Computing ${job.field} ${job.what}${pct}` : `${job.what}${pct}`);
  if (meta && job.cmd !== 'open') {
    const note = document.createElement('span');
    note.className = 'muted';
    note.textContent = ' — showing the previous view';
    ui.busyText.append(note);
  }
  ui.busyBar.classList.toggle('indeterminate', job.frac == null);
  ui.busyBar.style.width = job.frac == null ? '' : `${(100 * job.frac).toFixed(1)}%`;
  if (ui.busy.hidden && !busyTimer) {
    busyTimer = setTimeout(() => { busyTimer = null; if (busyJobs.size) ui.busy.hidden = false; }, 150);
  }
}

// ------------------------------------------------------------------ memory meter
// Browsers do not expose total or free system RAM. navigator.deviceMemory
// (Chromium only) gives the device RAM in GB, rounded and capped at 8, so the
// meter compares what the viewer holds with that estimate.
const DEVICE_GB = navigator.deviceMemory ?? null;
const DEVICE_BYTES = DEVICE_GB ? DEVICE_GB * 2 ** 30 : null;
let workerBytes = 0;
const fmtBytes = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GB` : `${Math.round(b / 2 ** 20)} MB`);
const deviceLabel = () => (DEVICE_GB >= 8 ? '≥ 8 GB' : `~${DEVICE_GB} GB`);
function viewerBytes() {
  let b = workerBytes;
  for (const v of cache.values()) b += v.byteLength ?? 0;
  return b;
}
function showMemory() {
  const used = viewerBytes();
  if (DEVICE_BYTES) {
    const frac = used / DEVICE_BYTES;
    ui.memText.textContent = `${fmtBytes(used)} of ${deviceLabel()}`;
    ui.memBar.style.width = `${Math.min(100, 100 * frac).toFixed(1)}%`;
    ui.memBar.className = frac > 0.8 ? 'high' : frac > 0.5 ? 'mid' : '';
    ui.memNote.textContent = DEVICE_GB >= 8
      ? 'Held by the viewer, against device RAM as reported by the browser (capped at 8 GB). Free RAM is not available to web pages.'
      : 'Held by the viewer, against device RAM as reported by the browser. Free RAM is not available to web pages.';
  } else {
    ui.memText.textContent = fmtBytes(used);
    ui.memBar.parentElement.hidden = true;
    ui.memNote.textContent = 'Held by the viewer. This browser does not report device RAM.';
  }
}

function setStatus(text, frac = null, error = false, done = false) {
  ui.statusText.textContent = text;
  // machine-readable state, used by tests/shoot.py
  document.documentElement.dataset.state = error ? 'error' : done ? 'ready' : 'busy';
  ui.status.classList.toggle('error', error);
  ui.progressBar.style.width = frac == null ? '0' : `${Math.round(100 * frac)}%`;
}

// ------------------------------------------------------------------ state
let meta = null;
// sel: selected shell, either an interior radial index or an exterior
// (potential-field) level when ext is true
const deg = (d) => (d * Math.PI) / 180;
const MAG_CMAP = 'PRGn_r'; // default for magnetic field maps and field lines: purple outward, green inward
const state = {
  field: null, sel: { ir: 0, ext: false }, phi: deg(300), sat: 1, extRadii: null,
  cutStart: deg(300), cutEnd: deg(30), // cut-away wedge, counter-clockwise from start to end
  // Colormap choices, kept separately for the magnetic components (which also
  // colour the field lines) and for the other fields; null = field default.
  magCmap: { name: MAG_CMAP, rev: false },
  otherCmap: null,
};
const cache = new Map(); // key -> Float32Array
showMemory();
let autoRange = null, lockedRange = null;
let generation = 0;

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v);
  return v;
}
function cachePut(key, v) {
  cache.set(key, v);
  while (cache.size > 48) cache.delete(cache.keys().next().value);
  showMemory();
}
async function fetchSlice(kind, extra) {
  const key = [kind, state.field, JSON.stringify(extra ?? {})].join('|');
  const hit = cacheGet(key);
  if (hit) return hit;
  const m = await call({ cmd: kind, field: state.field, ...extra });
  cachePut(key, m.data);
  return m.data;
}

const normPhi = (p) => ((p % TWO_PI) + TWO_PI) % TWO_PI;

// ------------------------------------------------------------------ loading
async function openSource(src) {
  setStatus('Opening…', 0);
  generation++;
  try {
    if (src.file && DEVICE_BYTES && DEVICE_GB < 8 && src.file.size > 0.5 * DEVICE_BYTES) {
      setStatus(`Opening a ${fmtBytes(src.file.size)} file on a device with ${deviceLabel()} RAM; this may fail…`, 0);
    }
    // the worker's own location is a blob: URL, so resolve relative URLs here
    if (src.url) src = { url: new URL(src.url, location.href).href };
    const m = await call({ cmd: 'open', experimental: EXPERIMENTAL, ...src });
    meta = m.meta;
  } catch (err) {
    setStatus(err.message, null, true);
    return;
  }
  cache.clear();
  showMemory();
  lockedRange = null;
  ui.lockRange.checked = false;
  setupForFile();
  await update();
}

function setupForFile() {
  ui.empty.hidden = true;
  ui.infoSection.hidden = false;
  ui.controls.hidden = false;
  ui.viewBar.hidden = false;
  ui.cbBox.hidden = false;
  document.getElementById('viewActions').hidden = false;
  ui.fileName.textContent = meta.fileName;
  ui.info.replaceChildren();
  for (const [k, v] of [...meta.info, ['Size', (meta.fileSize / 2 ** 20).toFixed(1) + ' MB']]) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    ui.info.append(dt, dd);
  }
  ui.notesBox.hidden = !meta.notes;
  ui.notes.textContent = meta.notes ?? '';

  ui.field.replaceChildren(...meta.fields.map((f) => new Option(f.label, f.id)));
  state.field = meta.fields[0].id;
  ui.field.value = state.field;

  meta.rmax = Math.max(...meta.radius);
  meta.rmin = Math.min(...meta.radius);
  ui.radius.max = String(meta.radius.length - 1);
  // default shell: closest to 85 % of the gap, measured outward
  const target = meta.rmin + 0.85 * (meta.rmax - meta.rmin);
  let best = 0;
  meta.radius.forEach((r, i) => { if (Math.abs(r - target) < Math.abs(meta.radius[best] - target)) best = i; });
  state.sel = { ir: best, ext: false };
  meta.defaultIr = best; // used by the radius reset button
  state.extRadii = null;
  ui.magSection.hidden = !meta.magnetic;
  ui.showLines.checked = false;
  clearLines();
  rebuildRadiusSlider();
  pickDefaultCmap();
  buildDecorations();
  syncLabels();
}

function currentField() {
  return meta.fields.find((f) => f.id === state.field);
}

// Colormap for the selected field: the magnetic components share one choice
// (state.magCmap, also used by the field lines); other fields share another
// (state.otherCmap) when it suits them, else their own default.
function pickDefaultCmap() {
  const f = currentField();
  if (isMagneticField()) {
    ui.cmap.value = state.magCmap.name;
    ui.cmapRev.checked = state.magCmap.rev;
    return;
  }
  const o = state.otherCmap;
  const list = f.signed ? DIVERGING : SEQUENTIAL;
  if (f.cmap) ui.cmap.value = f.cmap;
  else ui.cmap.value = o && list.includes(o.name) ? o.name : f.signed ? 'RdBu_r' : 'magma';
  ui.cmapRev.checked = o ? o.rev : false;
}
// A colormap picked while a magnetic component is selected becomes the
// magnetic choice (and recolours the field lines); otherwise the other one.
function onCmapChange() {
  const sel = { name: ui.cmap.value, rev: ui.cmapRev.checked };
  if (isMagneticField()) {
    state.magCmap = sel;
    colorLines();
  } else {
    state.otherCmap = sel;
  }
  recolor();
}

const isMagneticField = () => !!meta?.magnetic?.ids.includes(state.field);
const extFactor = () => Number(ui.rExt.value) / 100;
// The potential field outside r_o is computed whenever field lines are shown and
// the extrapolation radius exceeds r_o.
const extWanted = () => ui.showLines.checked && extFactor() > 1;
const extActive = () => extWanted() && !!state.extRadii;
const selRadius = () => (state.sel.ext ? state.extRadii[state.sel.ir] : meta.radius[state.sel.ir]);

// Radius slider entries, inner -> outer, plus exterior levels for magnetic components.
function radiusEntries() {
  const list = meta.radius.map((r, ir) => ({ r, ir, ext: false })).sort((a, b) => a.r - b.r);
  if (extActive() && isMagneticField()) list.push(...state.extRadii.map((r, ir) => ({ r, ir, ext: true })));
  return list;
}
function rebuildRadiusSlider() {
  meta.sliderEntries = radiusEntries();
  let k = meta.sliderEntries.findIndex((e) => e.ir === state.sel.ir && e.ext === state.sel.ext);
  if (k < 0) { // e.g. exterior level no longer available: fall back to the outer boundary
    k = meta.radius.length - 1;
    state.sel = { ir: meta.sliderEntries[k].ir, ext: false };
  }
  ui.radius.max = String(meta.sliderEntries.length - 1);
  ui.radius.value = String(k);
}

// ------------------------------------------------------------------ geometry
const trimNum = (x, d) => String(Number(x.toFixed(d)));
const fmtNum = (x) => {
  if (x === 0 || !isFinite(x)) return String(x);
  const a = Math.abs(x);
  return a >= 1e4 || a < 1e-2 ? x.toExponential(2) : x.toPrecision(3);
};

function phiSamples(start, end, nPhi) {
  const n = Math.max(2, Math.ceil(((end - start) / TWO_PI) * nPhi));
  return Array.from({ length: n + 1 }, (_, i) => start + ((end - start) * i) / n);
}

// periodic linear interpolation along a row of nPhi samples starting at phi=0
function rowAt(arr, off, nPhi, phi) {
  const x = (normPhi(phi) / TWO_PI) * nPhi;
  const i = Math.floor(x) % nPhi, f = x - Math.floor(x);
  return arr[off + i] * (1 - f) + arr[off + ((i + 1) % nPhi)] * f;
}

function gridMesh(nu, nv, fill, kind) {
  const pos = new Float32Array(nu * nv * 3);
  const val = new Float32Array(nu * nv);
  const v3 = [0, 0, 0];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const k = i * nv + j;
      val[k] = fill(i, j, v3);
      pos.set(v3, 3 * k);
    }
  }
  const idx = new Uint32Array((nu - 1) * (nv - 1) * 6);
  let o = 0;
  for (let i = 0; i < nu - 1; i++) {
    for (let j = 0; j < nv - 1; j++) {
      const a = i * nv + j, b = a + 1, c = a + nv, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nu * nv * 3), 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.userData.values = val;
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.userData.kind = kind;
  return mesh;
}

// shell: rows theta (with poles), columns phi
function shellMesh(data, r, phis) {
  const colat = meta.colat, nt = colat.length, np = meta.nPhi;
  const thetas = [0, ...colat, Math.PI];
  let north = 0, south = 0;
  for (let k = 0; k < np; k++) { north += data[k]; south += data[(nt - 1) * np + k]; }
  north /= np; south /= np;
  const rr = r / meta.rmax;
  return gridMesh(thetas.length, phis.length, (i, j, p) => {
    const th = thetas[i], ph = phis[j], s = Math.sin(th);
    p[0] = rr * s * Math.cos(ph); p[1] = rr * s * Math.sin(ph); p[2] = rr * Math.cos(th);
    if (i === 0) return north;
    if (i === thetas.length - 1) return south;
    return rowAt(data, (i - 1) * np, np, ph);
  }, 'shell');
}

// equatorial plane: rows radius, columns phi
function equatorMesh(data, irs, phis) {
  const np = meta.nPhi;
  return gridMesh(irs.length, phis.length, (i, j, p) => {
    const ir = irs[i], rr = meta.radius[ir] / meta.rmax, ph = phis[j];
    p[0] = rr * Math.cos(ph); p[1] = rr * Math.sin(ph); p[2] = 0;
    return rowAt(data, ir * np, np, ph);
  }, 'equator');
}

// meridional half-plane at phi: rows radius, columns theta (with poles)
function meridianMesh(data, irs, phi) {
  const colat = meta.colat, nt = colat.length;
  const thetas = [0, ...colat, Math.PI];
  const c = Math.cos(phi), s = Math.sin(phi);
  return gridMesh(irs.length, thetas.length, (i, j, p) => {
    const ir = irs[i], rr = meta.radius[ir] / meta.rmax, th = thetas[j];
    p[0] = rr * Math.sin(th) * c; p[1] = rr * Math.sin(th) * s; p[2] = rr * Math.cos(th);
    const jj = Math.min(nt - 1, Math.max(0, j - 1));
    return data[ir * nt + jj];
  }, 'meridian');
}

function buildDecorations() {
  for (const o of [...decoGroup.children]) { decoGroup.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
  const line = themeColors().line;
  const lineMat = () => new THREE.LineBasicMaterial({ color: line, transparent: true, opacity: 0.45 });
  const circle = (r, plane) => {
    const pts = Array.from({ length: 181 }, (_, i) => {
      const a = (TWO_PI * i) / 180;
      return plane === 'eq' ? new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), 0)
        : new THREE.Vector3(r * Math.cos(a), 0, r * Math.sin(a));
    });
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat());
    l.userData.themed = true;
    return l;
  };
  decoGroup.add(circle(1, 'eq'));
  const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints(
    [new THREE.Vector3(0, 0, -1.25), new THREE.Vector3(0, 0, 1.25)]), lineMat());
  axis.userData.themed = true;
  decoGroup.add(axis);
  const ri = meta.rmin / meta.rmax;
  if (ri > 0.02) {
    const core = new THREE.Mesh(new THREE.SphereGeometry(ri * 0.998, 64, 32),
      new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.85, metalness: 0.05 }));
    core.userData.kind = 'core';
    decoGroup.add(core);
  }
  applyTheme();
}

function clearData() {
  for (const o of [...dataGroup.children]) { dataGroup.remove(o); o.geometry.dispose(); o.material.dispose(); }
}

// ------------------------------------------------------------------ update
async function update() {
  if (!meta) return;
  const gen = ++generation;
  const showShell = ui.showShell.checked, showEq = ui.showEq.checked;
  const cut = ui.cutaway.checked, showMer = ui.showMer.checked;
  const phi = normPhi(state.phi);
  // wedge removed from the shell: from cutStart counter-clockwise to cutEnd
  const c0 = normPhi(state.cutStart);
  const span = normPhi(state.cutEnd - state.cutStart) || TWO_PI / 360;
  const rs = selRadius();
  const t0 = performance.now();
  try {
    const shellReq = state.sel.ext ? { ir: state.sel.ir, ext: true, factor: extFactor() } : { ir: state.sel.ir };
    const shell = showShell ? await fetchSlice('shell', shellReq) : null;
    if (gen !== generation) return;
    const eq = showEq ? await fetchSlice('equator') : null;
    if (gen !== generation) return;
    // meridional half-planes
    const merPhis = cut ? [c0, normPhi(c0 + span)] : showMer ? [phi, normPhi(phi + Math.PI)] : [];
    const mers = [];
    for (const p of merPhis) {
      mers.push(await fetchSlice('meridian', { phi: p }));
      if (gen !== generation) return;
    }

    clearData();
    const meshes = [];
    const allIr = meta.radius.map((_, i) => i);
    // in cut-away mode planes stop at the shell radius
    const inner = cut && showShell ? allIr.filter((i) => meta.radius[i] <= rs * (1 + 1e-9)) : allIr;
    if (shell) {
      const phis = cut ? phiSamples(c0 + span, c0 + TWO_PI, meta.nPhi)
        : phiSamples(0, TWO_PI, meta.nPhi);
      meshes.push(shellMesh(shell, rs, phis));
    }
    if (eq) {
      const phis = cut ? phiSamples(c0, c0 + span, meta.nPhi) : phiSamples(0, TWO_PI, meta.nPhi);
      meshes.push(equatorMesh(eq, inner, phis));
    }
    merPhis.forEach((p, k) => meshes.push(meridianMesh(mers[k], inner, p)));
    for (const m of meshes) dataGroup.add(m);
    state.drawnField = state.field;

    autoRange = computeRange(meshes.map((m) => m.geometry.userData.values));
    recolor();
    const ms = performance.now() - t0;
    setStatus(`${meta.formatName} · ${currentField().label}` + (ms > 300 ? ` · ${(ms / 1000).toFixed(1)} s` : ''), null, false, true);
  } catch (err) {
    if (gen === generation) setStatus(err.message, null, true);
  }
}

function computeRange(arrays) {
  const signed = currentField().signed;
  const sample = [];
  let total = 0;
  for (const a of arrays) total += a.length;
  const step = Math.max(1, Math.floor(total / 200000));
  for (const a of arrays) for (let i = 0; i < a.length; i += step) if (isFinite(a[i])) sample.push(a[i]);
  if (!sample.length) return { min: -1, max: 1, signed };
  if (signed) {
    const abs = Float32Array.from(sample, Math.abs).sort();
    const m = abs[Math.floor(0.998 * (abs.length - 1))] || abs[abs.length - 1] || 1;
    return { min: -m, max: m, signed };
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of sample) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo === hi) { lo -= 1; hi += 1; }
  return { min: lo, max: hi, signed };
}

function activeRange() {
  const base = lockedRange ?? autoRange;
  if (!base) return { min: -1, max: 1 };
  const s = state.sat;
  if (base.signed) return { min: base.min * s, max: base.max * s };
  const mid = 0.5 * (base.min + base.max), half = 0.5 * (base.max - base.min) * s;
  return { min: mid - half, max: mid + half };
}

function recolor() {
  const table = lut(ui.cmap.value, ui.cmapRev.checked);
  const { min, max } = activeRange();
  const inv = 1 / (max - min || 1);
  for (const m of dataGroup.children) {
    const vals = m.geometry.userData.values, col = m.geometry.attributes.color.array;
    for (let i = 0; i < vals.length; i++) {
      let t = (vals[i] - min) * inv;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const k = 3 * Math.round(t * 255);
      col[3 * i] = table[k]; col[3 * i + 1] = table[k + 1]; col[3 * i + 2] = table[k + 2];
    }
    m.geometry.attributes.color.needsUpdate = true;
  }
  drawColorbar(table, min, max);
  requestRender();
}

function drawColorbar(table, min, max) {
  const ctx = ui.colorbar.getContext('2d');
  const w = ui.colorbar.width, h = ui.colorbar.height;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const k = 3 * Math.round((1 - y / (h - 1)) * 255); // maximum at the top
    for (let x = 0; x < w; x++) {
      const o = 4 * (y * w + x);
      img.data[o] = 255 * table[k]; img.data[o + 1] = 255 * table[k + 1];
      img.data[o + 2] = 255 * table[k + 2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // label of the field currently drawn (the selection may be ahead of it while computing)
  ui.cbLabel.textContent = meta?.fields.find((f) => f.id === state.drawnField)?.label ?? '';
  const tick = (x) => fmtNum(x).replace(/^-/, '\u2212'); // typographic minus
  ui.cbMin.textContent = tick(min);
  ui.cbMid.textContent = tick(0.5 * (min + max));
  ui.cbMax.textContent = tick(max);
}

function syncLabels() {
  for (const refresh of resetRefreshers) refresh();
  const r = selRadius();
  show(ui.radiusOut, `${fmtNum(r)} (${(r / meta.rmax).toFixed(3)} r_o)` + (state.sel.ext ? ' · potential' : ''));
  show(ui.nLinesOut, ui.nLines.value);
  show(ui.inLenOut, `${trimNum(Number(ui.inLen.value) / 100, 2)} r_o`);
  show(ui.rExtOut, extFactor() > 1 ? `${trimNum(extFactor(), 2)} r_o` : 'off (interior only)');
  ui.lineOpts.hidden = !ui.showLines.checked;
  const degs = (p) => `${Math.round((normPhi(p) * 180) / Math.PI)}°`;
  show(ui.phiOut, degs(state.phi));
  show(ui.cutStartOut, degs(state.cutStart));
  show(ui.cutEndOut, degs(state.cutEnd));
  ui.phiRow.hidden = !ui.showMer.checked;
  ui.cutStartRow.hidden = ui.cutEndRow.hidden = !ui.cutaway.checked;
  show(ui.satOut, `${Math.round(state.sat * 100)}%`);
  ui.radius.disabled = !ui.showShell.checked;
}

// ------------------------------------------------------------------ typed slider values
// Every slider's read-out can be clicked (or tabbed to) and a value typed in its
// display units: Enter or leaving the field applies it, Escape cancels. The value
// is clamped and snapped to the slider's range and step, written to the slider,
// and the slider's own input/change handlers do the rest. A reset button next to
// the read-out returns the slider to its default (the value in index.html, or
// def() when given) the same way; it is disabled while the slider is at the default.
const resetRefreshers = [];
function setSlider(slider, v) {
  slider.value = String(v);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
}
function show(el, text) {
  if (document.activeElement !== el) el.textContent = text;
}
function editable(out, slider, { get, toSlider, fmt, def = () => slider.defaultValue }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'reset';
  btn.textContent = '↺';
  btn.setAttribute('aria-label', 'Reset to default');
  out.after(btn);
  const refresh = () => {
    const d = def();
    btn.disabled = d == null || String(d) === slider.value;
    btn.title = d == null ? 'Reset to default' : `Reset to default (${fmt(Number(d))})`;
  };
  btn.addEventListener('click', () => {
    const d = def();
    if (d == null) return;
    setSlider(slider, d);
    refresh();
  });
  slider.addEventListener('input', refresh);
  resetRefreshers.push(refresh);
  refresh();

  out.contentEditable = 'plaintext-only';
  if (out.contentEditable !== 'plaintext-only') out.contentEditable = 'true';
  out.spellcheck = false;
  out.classList.add('editable');
  out.title = 'Click to type a value';
  let before = '';
  // a click inside the <label> would otherwise move focus to the slider
  out.addEventListener('click', (e) => e.preventDefault());
  out.addEventListener('focus', () => {
    before = out.textContent;
    out.textContent = get();
    requestAnimationFrame(() => { if (document.activeElement === out) getSelection().selectAllChildren(out); });
  });
  out.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); out.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); out.dataset.cancel = '1'; out.blur(); }
  });
  out.addEventListener('blur', () => {
    const text = out.textContent.trim();
    const cancel = out.dataset.cancel; delete out.dataset.cancel;
    const x = parseFloat(text.replace(',', '.'));
    out.textContent = before;
    if (cancel || !Number.isFinite(x)) return;
    let v = toSlider(x, text);
    if (v == null || !Number.isFinite(v)) return;
    const min = Number(slider.min), max = Number(slider.max), step = Number(slider.step) || 1;
    v = Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step));
    setSlider(slider, v);
  });
}
editable(ui.radiusOut, ui.radius, {
  get: () => (meta ? trimNum(selRadius(), 6) : ''),
  // a plain number is a radius in the file's units; "0.9 r_o" (or "0.9 ro") a fraction of r_o
  toSlider: (x, text) => {
    if (!meta) return null;
    const r = /r_?o\s*$/i.test(text) ? x * meta.rmax : x;
    const dist = (e) => Math.abs((e.ext ? state.extRadii[e.ir] : meta.radius[e.ir]) - r);
    let best = 0;
    meta.sliderEntries.forEach((e, k) => { if (dist(e) < dist(meta.sliderEntries[best])) best = k; });
    return best;
  },
  def: () => (meta?.sliderEntries ? meta.sliderEntries.findIndex((e) => e.ir === meta.defaultIr && !e.ext) : null),
  fmt: (k) => `r = ${fmtNum(meta.radius[meta.sliderEntries[k].ir])}`,
});
editable(ui.nLinesOut, ui.nLines, { get: () => ui.nLines.value, toSlider: (x) => x, fmt: (v) => `${v}` });
editable(ui.rExtOut, ui.rExt, { get: () => trimNum(extFactor(), 2), toSlider: (x) => x * 100,
  fmt: (v) => `${trimNum(v / 100, 2)} r_o` });
editable(ui.inLenOut, ui.inLen, { get: () => trimNum(Number(ui.inLen.value) / 100, 2), toSlider: (x) => x * 100,
  fmt: (v) => `${trimNum(v / 100, 2)} r_o` });
for (const [out, slider] of [[ui.phiOut, ui.phi], [ui.cutStartOut, ui.cutStart], [ui.cutEndOut, ui.cutEnd]]) {
  editable(out, slider, { get: () => slider.value, toSlider: (x) => Math.round(((x % 360) + 360) % 360) % 360,
    fmt: (v) => `${v}°` });
}
editable(ui.satOut, ui.sat, { get: () => ui.sat.value, toSlider: (x) => x, fmt: (v) => `${v}%` });
editable(ui.shadingOut, ui.shading, { get: () => ui.shading.value, toSlider: (x) => x, fmt: (v) => `${v}%` });

// ------------------------------------------------------------------ field lines
let linesGen = 0;
function clearLines() {
  for (const o of [...lineGroup.children]) { lineGroup.remove(o); o.geometry.dispose(); }
  requestRender();
}

async function updateLines() {
  const gen = ++linesGen;
  if (!meta?.magnetic || !ui.showLines.checked) { clearLines(); return; }
  setStatus('Tracing field lines…');
  try {
    const m = await call({
      cmd: 'fieldlines', n: Number(ui.nLines.value), factor: extActive() ? extFactor() : 1,
      inLen: Number(ui.inLen.value) / 100,
    });
    if (gen !== linesGen) return;
    clearLines();
    const { points, offsets, polarity } = m;
    let nseg = 0;
    for (let i = 0; i < polarity.length; i++) nseg += offsets[i + 1] - offsets[i] - 1;
    const pos = new Float32Array(nseg * 6);
    const s = 1 / meta.rmax;
    let o = 0;
    for (let i = 0; i < polarity.length; i++) {
      for (let k = offsets[i]; k < offsets[i + 1] - 1; k++) {
        for (let d = 0; d < 6; d++) pos[o + d] = points[3 * k + d] * s;
        o += 6;
      }
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(pos);
    g.userData.lines = { offsets, polarity, nseg };
    lineGroup.add(new LineSegments2(g, lineMaterial));
    colorLines();
    setStatus(`${polarity.length} field lines` + (m.ms > 300 ? ` · ${(m.ms / 1000).toFixed(1)} s` : ''), null, false, true);
  } catch (err) {
    if (gen === linesGen) setStatus(err.message, null, true);
  }
}

// Colour the field lines with the magnetic colormap (state.magCmap): its
// strong ends for B_r > 0 / < 0 at the seed, like the magnetic field maps.
function colorLines() {
  const line = lineGroup.children[0];
  if (!line) return;
  const { offsets, polarity, nseg } = line.geometry.userData.lines;
  const table = lut(state.magCmap.name, state.magCmap.rev);
  const at = (t) => { const k = 3 * Math.round(255 * t); return [table[k], table[k + 1], table[k + 2]]; };
  const out = at(0.92), inw = at(0.08);
  const col = new Float32Array(nseg * 6);
  let o = 0;
  for (let i = 0; i < polarity.length; i++) {
    const c = polarity[i] > 0 ? out : inw;
    for (let k = offsets[i]; k < offsets[i + 1] - 1; k++) { col.set(c, o); col.set(c, o + 3); o += 6; }
  }
  line.geometry.setColors(col);
  requestRender();
}

// Move the camera back (never closer) so that a sphere of radius R (in r_o) fits.
function fitRadius(R) {
  const v = Math.min(camera.fov, camera.fov * camera.aspect) / 2;
  const d = (1.1 * R) / Math.sin(THREE.MathUtils.degToRad(v));
  const off = camera.position.clone().sub(controls.target);
  if (off.length() < d) {
    camera.position.copy(controls.target).add(off.setLength(d));
    controls.update();
    requestRender();
  }
}

// Called when field lines are toggled or the extrapolation radius changes:
// computes (or drops) the potential field outside r_o, then redraws.
async function setExtrapolation() {
  if (extWanted()) {
    try {
      const m = await call({ cmd: 'exterior', factor: extFactor() });
      state.extRadii = m.radius;
      fitRadius(extFactor());
    } catch (err) {
      setStatus(err.message, null, true);
      state.extRadii = null;
    }
  } else {
    state.extRadii = null;
  }
  rebuildRadiusSlider();
  syncLabels();
  update();
  updateLines();
}

// ------------------------------------------------------------------ hover
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hoverQueued = false, lastEvent = null;
ui.canvas.addEventListener('pointermove', (e) => {
  lastEvent = e;
  if (hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(() => { hoverQueued = false; hover(lastEvent); });
});
ui.canvas.addEventListener('pointerleave', () => { ui.tooltip.hidden = true; });
function hover(e) {
  if (!meta || e.buttons) { ui.tooltip.hidden = true; return; }
  const rect = ui.canvas.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects([...dataGroup.children, ...decoGroup.children.filter((o) => o.isMesh)], false)[0];
  if (!hit || !hit.face || hit.object.userData.kind === 'core') { ui.tooltip.hidden = true; return; }
  const vals = hit.object.geometry.userData.values, f = hit.face;
  let v;
  if (hit.barycoord) v = vals[f.a] * hit.barycoord.x + vals[f.b] * hit.barycoord.y + vals[f.c] * hit.barycoord.z;
  else v = vals[f.a];
  const p = hit.point, r = p.length();
  const lat = 90 - (Math.acos(Math.max(-1, Math.min(1, p.z / (r || 1)))) * 180) / Math.PI;
  const lon = (((Math.atan2(p.y, p.x) * 180) / Math.PI) + 360) % 360;
  ui.tooltip.textContent = `${currentField().label} = ${fmtNum(v)}\nr = ${fmtNum(r * meta.rmax)}  lat ${lat.toFixed(1)}°  lon ${lon.toFixed(1)}°`;
  ui.tooltip.style.whiteSpace = 'pre';
  ui.tooltip.style.left = `${e.clientX - ui.view.getBoundingClientRect().left}px`;
  ui.tooltip.style.top = `${e.clientY - ui.view.getBoundingClientRect().top}px`;
  ui.tooltip.hidden = false;
}

// ------------------------------------------------------------------ controls
for (const n of [...DIVERGING, ...SEQUENTIAL]) ui.cmap.append(new Option(n, n));
ui.cmap.value = 'RdBu_r';

ui.fileInput.addEventListener('change', () => {
  const f = ui.fileInput.files[0];
  if (f) openSource({ file: f });
  ui.fileInput.value = '';
});
ui.urlForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const u = ui.urlInput.value.trim();
  if (u) openSource({ url: u });
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; ui.dropOverlay.hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; ui.dropOverlay.hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  ui.dropOverlay.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) openSource({ file: f });
});

ui.field.addEventListener('change', () => {
  state.field = ui.field.value;
  lockedRange = null;
  ui.lockRange.checked = false;
  pickDefaultCmap();
  rebuildRadiusSlider();
  syncLabels();
  update();
});

let radiusTimer = null;
ui.radius.addEventListener('input', () => {
  const e = meta.sliderEntries[Number(ui.radius.value)];
  state.sel = { ir: e.ir, ext: e.ext };
  syncLabels();
  // shells are cheap: follow the slider, lightly debounced
  clearTimeout(radiusTimer);
  radiusTimer = setTimeout(update, 40);
});
// Longitude sliders: planes are cheap for grid files (follow the slider), but
// can take seconds for high-resolution spectral files (recompute on release).
for (const [el, key] of [[ui.phi, 'phi'], [ui.cutStart, 'cutStart'], [ui.cutEnd, 'cutEnd']]) {
  let timer = null;
  el.addEventListener('input', () => {
    state[key] = deg(Number(el.value));
    syncLabels();
    if (meta?.kind === 'grid') { clearTimeout(timer); timer = setTimeout(update, 40); }
  });
  el.addEventListener('change', () => { if (meta?.kind !== 'grid') update(); });
}
for (const el of [ui.showShell, ui.showEq, ui.showMer, ui.cutaway]) {
  el.addEventListener('change', () => {
    if (el === ui.cutaway && el.checked) ui.showMer.checked = false;
    if (el === ui.showMer && el.checked) ui.cutaway.checked = false;
    syncLabels();
    update();
  });
}
ui.showLines.addEventListener('change', setExtrapolation);
ui.nLines.addEventListener('input', syncLabels);
ui.nLines.addEventListener('change', updateLines);
ui.inLen.addEventListener('input', syncLabels);
ui.inLen.addEventListener('change', updateLines);
ui.rExt.addEventListener('input', syncLabels);
ui.rExt.addEventListener('change', () => { if (ui.showLines.checked) setExtrapolation(); });
ui.cmap.addEventListener('change', onCmapChange);
ui.cmapRev.addEventListener('change', onCmapChange);
ui.sat.addEventListener('input', () => {
  state.sat = Number(ui.sat.value) / 100;
  syncLabels();
  recolor();
});
ui.shading.addEventListener('input', () => {
  setShading(Number(ui.shading.value) / 100);
  show(ui.shadingOut, `${ui.shading.value}%`);
});
ui.lockRange.addEventListener('change', () => {
  lockedRange = ui.lockRange.checked && autoRange ? { ...autoRange } : null;
  recolor();
});
ui.resetView.addEventListener('click', () => { resetView(); requestRender(); });
ui.snapshot.addEventListener('click', () => {
  renderer.render(scene, camera);
  const a = document.createElement('a');
  a.href = renderer.domElement.toDataURL('image/png');
  a.download = (meta?.fileName ?? 'sphere') + '_' + (state.field ?? '') + '.png';
  a.click();
});
ui.panelToggle.addEventListener('click', () => {
  ui.panel.classList.add('collapsed');
  ui.panelOpen.hidden = false;
});
ui.panelOpen.addEventListener('click', () => {
  ui.panel.classList.remove('collapsed');
  ui.panelOpen.hidden = true;
});

setShading(Number(ui.shading.value) / 100);
show(ui.shadingOut, `${ui.shading.value}%`);
applyTheme();
resize();
const initialUrl = params.get('url');
if (initialUrl) {
  ui.urlInput.value = initialUrl;
  openSource({ url: initialUrl });
}
})().catch((err) => {
  console.error(err);
  const offline = /import|fetch|module/i.test(String(err?.message));
  const text = document.getElementById('statusText');
  text.textContent = offline
    ? 'three.js could not be loaded from the CDN (cdn.jsdelivr.net). Check your internet connection and reload.'
    : `The viewer could not start: ${err?.message ?? err}`;
  document.getElementById('status').classList.add('error');
  document.documentElement.dataset.state = 'error';
});
