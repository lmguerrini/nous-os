// Capture the README gallery of the review page from the synthetic demo dataset.
//
//   node ui/tools/capture-gallery.mjs [--port 8776] [--dataset demo/out/reference/dataset] [--only id,id] [--out dir] [--variants file.json --out dir]
//
// Prerequisites, from the repository root: `npm --prefix ui ci`, `npm --prefix ui run build:review`, Playwright's Chromium
// (`npx --prefix ui playwright install chromium`) and the synthetic dataset
// (`node --experimental-strip-types demo/src/cli.ts synth --profile reference --seed 1 --out demo/out/reference`).
//
// Every item except `interface` enters the page's real fullscreen mode, keeps the fullscreen brand visible, and captures after stable full readiness. Density pairs
// share a page session. A `frame` setting centres the subject's drawn nodes (the whole graph, a root domain's descendants, or one node and its
// descendants) and sizes them to a share of the frame's limiting dimension through the page's own camera state; set CAPTURE_FRAME_DEBUG=1 to
// log each framing iteration.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'ui', 'package.json'));
const { chromium } = require('@playwright/test');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]]] : acc, []));
const PORT = Number(args.port ?? 8776);
const DATASET = path.resolve(ROOT, args.dataset ?? 'demo/out/reference/dataset');
const GALLERY_DIR = path.resolve(ROOT, 'docs', 'assets', 'gallery');
const OUT = path.resolve(ROOT, args.out ?? GALLERY_DIR);
const VIEWPORT = { width: 1600, height: 1000 };
const DEVICE_SCALE_FACTOR = 2;
const GRAPH_OVERLAYS = '#focus-chip,#lab-notice,#notice,#toast,#fractal-canopy-explanation,#gizmo,[role=tooltip],.tooltip,[data-fractal-bundle-count]{visibility:hidden!important}';
const OVERLAYS = '#focus-chip,#lab-notice,#notice,#toast,#fractal-canopy-explanation,#gizmo,[role=tooltip],.tooltip,[data-fractal-bundle-count],#review-toolbar,#details,#panel-edge-toggle,#fullscreen-bar,#fullscreen-legend,#selection-focus-controls,#graph-status-panel,#performance-overlay,#appearance-panel,#error{display:none!important;visibility:hidden!important}';
const FULL_WINDOW = OVERLAYS;

// Copied from tests/test_public_safety.py::test_no_personal_identifier_in_tracked_bytes (ALL_PATTERNS).
const ABSOLUTE_PATH_PATTERNS = [
  /\/[U]sers\/[A-Za-z0-9._-]+/,
  /\/[h]ome\/[A-Za-z0-9._-]+/,
  /[C]:\\\\?[U]sers\\\\?/,
  /\/[V]olumes\/[A-Za-z0-9._-]+/,
  /\/[p]rivate\/(?:tmp|var)\/[A-Za-z0-9._-]+/,
  /~\/(?:[D]esktop|[D]ocuments|[D]ownloads|[L]ibrary|[P]ictures|[M]usic|[M]ovies)(?:\/[A-Za-z0-9._-]+)*/,
  /\/[o]pt\/[A-Za-z0-9._-]+/,
  /\/[s]rv\/[A-Za-z0-9._-]+/,
  /\/[A]pplications\/[A-Za-z0-9._-]+/,
  /\/[n]et\/[A-Za-z0-9._-]+/,
  /%[U]SERPROFILE%\\[A-Za-z0-9._-]+/,
  /\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._-]+/,
];
const IDENTIFIER_PATTERNS = [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/];
const CREDENTIAL_PATTERNS = [
  /\bs[k]-[A-Za-z0-9_-]{16,}/,
  /\bgh[p]_[A-Za-z0-9]{16,}/,
  /\b[A]KIA[0-9A-Z]{12,}/,
  /-----BEGIN [A-Z ]*PRI[V]ATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|password)\s*[=:]\s*['"][^'"]{8,}/,
  /\bx[o]xb-[A-Za-z0-9-]{10,}/,
  /\b[A]IzaSy[A-Za-z0-9_-]{16,}/,
];
const ALL_PATTERNS = [...ABSOLUTE_PATH_PATTERNS, ...IDENTIFIER_PATTERNS, ...CREDENTIAL_PATTERNS];

// Every topology the page offers, in 2D and in 3D, at «Completa» unless an image is about density. Labels are off and the Indra
// meta-topology is not shown.
const base = { indra: 'off', morphology: 'stellar', density: 'complete', reading: 'attested', colour: 'bw', labels: false, brain: false };
export const GALLERY = [
  { id: 'natural-2d-complete', title: 'Natural · 2D · Completa', view: { ...base, rendering: '2d', topology: 'natural' } },
  { id: 'natural-3d-complete', title: 'Natural · 3D · Completa', view: { ...base, rendering: '3d', topology: 'natural' } },
  { id: 'canopy-2d-complete', title: 'Canopy · 2D · Completa', view: { ...base, rendering: '2d', topology: 'canopy-ifs' }, frame: { subject: 'all', occupancy: 0.85 } },
  { id: 'canopy-3d-complete', title: 'Canopy · 3D · Completa', view: { ...base, rendering: '3d', topology: 'canopy-ifs' }, frame: { subject: 'all', occupancy: 0.85 } },
  { id: 'sierpinski-2d-complete', title: 'Sierpiński · 2D · Completa', view: { ...base, rendering: '2d', topology: 'sierpinski' }, frame: { subject: 'all', occupancy: 0.85 } },
  { id: 'sierpinski-3d-complete', title: 'Sierpiński · 3D · Completa', view: { ...base, rendering: '3d', topology: 'sierpinski' }, frame: { subject: 'all', bounds: 'visible', occupancy: 0.85 } },
  { id: 'llull-2d-complete', title: 'Llull · 2D · Completa', view: { ...base, rendering: '2d', topology: 'circular-combinatorial' }, frame: { subject: 'all', occupancy: 0.85 } },
  { id: 'llull-3d-complete', title: 'Llull · 3D · Completa', view: { ...base, rendering: '3d', topology: 'circular-combinatorial' }, frame: { subject: 'all', occupancy: 0.85 } },
  { id: 'julia-2d-complete', title: 'Julia · 2D · Completa', view: { ...base, rendering: '2d', topology: 'julia' }, frame: { subject: 'all', occupancy: 0.85 } },
  { id: 'julia-3d-complete', title: 'Julia · 3D · Completa', view: { ...base, rendering: '3d', topology: 'julia' }, camera: [{ op: 'orbit', dx: 0, dy: 110, steps: 10 }, { op: 'zoomAt', x: 0.5, y: 0.5, steps: 3 }] },
  { id: 'neural-3d-brain', title: 'Neural · 3D · Completa · Cervello', view: { ...base, morphology: 'neural', brain: true, rendering: '3d', topology: 'natural' } },
  { id: 'mycelium-2d-complete', title: 'Mycelium · 2D · Completa', view: { ...base, morphology: 'mycelium', rendering: '2d', topology: 'natural' } },
  { id: 'exploratory-3d-complete', title: 'Esplorativa connections · 3D · Completa', view: { ...base, reading: 'exploratory', rendering: '3d', topology: 'natural' } },
  { id: 'natural-2d-essential', title: 'Natural · 2D · Essenziale', view: { ...base, density: 'essential', rendering: '2d', topology: 'natural' } },
  { id: 'natural-2d-balanced', title: 'Natural · 2D · Bilanciata', view: { ...base, density: 'balanced', rendering: '2d', topology: 'natural' } },
  { id: 'natural-stellar-2d-complete', title: 'Natural · Stellar · 2D · Completa', view: { ...base, rendering: '2d', topology: 'natural' }, paired: true, frame: { subject: 'all', occupancy: 0.85 } },
  { id: 'natural-stellar-2d-balanced', title: 'Natural · Stellar · 2D · Bilanciata', view: { ...base, density: 'balanced', rendering: '2d', topology: 'natural' }, paired: true, frame: { subject: 'all', occupancy: 0.85 } },
  { id: 'natural-stellar-3d-complete', title: 'Natural · Stellar · 3D · Completa', view: { ...base, rendering: '3d', topology: 'natural' }, paired: true, frame: { subject: 'all', occupancy: 0.85 } },
  { id: 'natural-stellar-3d-balanced', title: 'Natural · Stellar · 3D · Bilanciata', view: { ...base, density: 'balanced', rendering: '3d', topology: 'natural' }, paired: true, frame: { subject: 'all', occupancy: 0.85 } },
  // Close-ups: centred on one cluster. At Balanced a cluster's nodes are spread across the compact Balanced layout, so 2D uses
  // Custom with 2,000 nodes, where each root domain keeps its own disc; in 3D, Custom draws those nodes faint among long relations,
  // so 3D stays at Complete on one source and its proposals.
  { id: 'natural-stellar-2d-custom-detail-links', title: 'Natural · Stellar · 2D · Custom 2000 · small cluster and its links', view: { ...base, density: 'custom', customNodes: 2000, rendering: '2d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '2d', camera: [], frame: { subject: { domains: ['d1'] }, occupancy: 0.7 } },
  { id: 'natural-stellar-2d-custom-detail-cluster', title: 'Natural · Stellar · 2D · Custom 2000 · nodes of one cluster', view: { ...base, density: 'custom', customNodes: 2000, rendering: '2d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '2d', camera: [], frame: { subject: { domains: ['d8'] }, occupancy: 0.7 } },
  { id: 'natural-stellar-3d-complete-detail-source', title: 'Natural · Stellar · 3D · Completa · one source and its proposals', view: { ...base, rendering: '3d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '3d', camera: [{ op: 'orbit', dx: 120, dy: -50, steps: 10 }], frame: { subject: { under: ['source:n061'] }, occupancy: 0.65 } },
  // A change of scale on one cluster: the d1 cluster centred with the relations that leave it, then the same camera brought six
  // wheel steps closer at the same centre. Density, morphology, palette and orientation stay the same; only the distance changes.
  { id: 'natural-stellar-2d-custom-scale-cluster', title: 'Natural · Stellar · 2D · Custom 2000 · one cluster in context', view: { ...base, density: 'custom', customNodes: 2000, rendering: '2d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '2d', camera: [], frame: { subject: { domains: ['d1'] }, occupancy: 0.3 } },
  { id: 'natural-stellar-2d-custom-scale-closer', title: 'Natural · Stellar · 2D · Custom 2000 · the same cluster, closer', view: { ...base, density: 'custom', customNodes: 2000, rendering: '2d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '2d', camera: [{ op: 'frame', subject: { domains: ['d1'] }, occupancy: 0.3 }, { op: 'zoomAt', x: 0.5, y: 0.5, steps: 6 }] },
  // The three morphologies at Bilanciata (Stellar reuses the paired overviews above). The camera follows each morphology: in 2D
  // the neural branches and the mycelium threads only stand out closer than the whole-graph fit, so those two zoom in from it;
  // Neural 3D shows the whole brain envelope («Cervello») a little closer than the page's fit; Mycelium 3D is the whole graph,
  // framed on what is drawn because its threads reach well beyond the nodes.
  { id: 'natural-neural-2d-balanced', title: 'Natural · Neural · 2D · Bilanciata', view: { ...base, morphology: 'neural', density: 'balanced', rendering: '2d', topology: 'natural' }, camera: [{ op: 'frame', subject: 'all', occupancy: 0.85 }, { op: 'zoomAt', x: 0.5, y: 0.5, steps: 4 }] },
  { id: 'natural-neural-3d-balanced-brain', title: 'Natural · Neural · 3D · Bilanciata · Cervello', view: { ...base, morphology: 'neural', brain: true, density: 'balanced', rendering: '3d', topology: 'natural' }, camera: [{ op: 'zoomAt', x: 0.5, y: 0.5, steps: 6 }] },
  { id: 'natural-mycelium-2d-balanced', title: 'Natural · Mycelium · 2D · Bilanciata', view: { ...base, morphology: 'mycelium', density: 'balanced', rendering: '2d', topology: 'natural' }, camera: [{ op: 'frame', subject: 'all', occupancy: 0.85 }, { op: 'zoomAt', x: 0.5, y: 0.5, steps: 3 }] },
  { id: 'natural-mycelium-3d-balanced', title: 'Natural · Mycelium · 3D · Bilanciata', view: { ...base, morphology: 'mycelium', density: 'balanced', rendering: '3d', topology: 'natural' }, frame: { subject: 'all', bounds: 'visible', occupancy: 0.85 } },
  { id: 'interface', title: 'The whole page: Natural · 3D · Completa', view: { ...base, rendering: '3d', topology: 'natural' }, fullPage: true },
];


const stateUrl = (origin, view) => `${origin}/#experimental=fractal&view2=` + encodeURIComponent(JSON.stringify({ schema: 2, ...view }));

async function startServer() {
  const child = spawn(process.env.PYTHON ?? 'python3', ['-m', 'nous_os.graph_review', 'serve', '--graph', DATASET,
    '--static', path.join(ROOT, 'ui', 'dist', 'review'), '--port', String(PORT)],
  { cwd: ROOT, env: { ...process.env, PYTHONPATH: path.join(ROOT, 'src') }, stdio: ['ignore', 'ignore', 'inherit'] });
  const origin = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`${origin}/api/health`); if (r.ok) return { origin, health: await r.json(), stop: () => child.kill('SIGTERM') }; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  child.kill('SIGTERM');
  throw new Error('the review server did not start');
}

async function waitForComplete(page, startedAt, viewFragment = null) {
  await page.waitForFunction(fragment => {
    const render = window.__d082?.render?.(), status = window.__d081?.status?.();
    return render?.quality === 'completa' && status?.quality === 'completa'
      && (!fragment || render?.view?.includes(fragment));
  }, viewFragment, { timeout: 120000 });
  return Date.now() - startedAt;
}

function inspectJpeg(buffer, file) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error(`${file}: Chromium did not write a JPEG`);
  let offset = 2, width = null, height = null, iccProfiles = 0;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) throw new Error(`${file}: malformed JPEG marker stream`);
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > buffer.length) throw new Error(`${file}: truncated JPEG marker`);
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw new Error(`${file}: invalid JPEG segment length`);
    const payload = offset + 2;
    if (marker === 0xe1) throw new Error(`${file}: APP1 metadata is forbidden`);
    if (marker === 0xe2 && buffer.subarray(payload, payload + 12).toString('ascii') === 'ICC_PROFILE\0') iccProfiles++;
    if (sof.has(marker)) { height = buffer.readUInt16BE(payload + 1); width = buffer.readUInt16BE(payload + 3); }
    offset += length;
  }
  if (iccProfiles > 1) throw new Error(`${file}: found ${iccProfiles} ICC_PROFILE APP2 segments`);
  if (!width || !height) throw new Error(`${file}: JPEG has no readable SOF dimensions`);
  return { width, height };
}

async function installCaptureStyle(page, fullWindow) {
  await page.evaluate(({ css }) => {
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    const motion = document.getElementById('flow-motion');
    if (motion?.checked) { motion.checked = false; motion.dispatchEvent(new Event('change')); }
    window.dispatchEvent(new Event('resize'));
  }, { css: fullWindow ? FULL_WINDOW : GRAPH_OVERLAYS });
}

async function stableFullReadiness(page, timeoutMs = 120000) {
  const started = Date.now(); let previous = '', unchangedSince = Date.now(), latest = null;
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(250);
    latest = await page.evaluate(() => {
      const render = window.__d082?.render?.(); const status = window.__d081?.status?.();
      const camera = { state: window.__d067?.cameraState?.() ?? null, pose: window.__d067?.camera?.() ?? null };
      return { render, status, camera };
    }).catch(() => null);
    if (!latest) continue;
    const r = latest.render, s = latest.status;
    const full = r?.quality === 'completa' && s?.quality === 'completa' && r?.ladder === 4
      && r?.nodes?.drawn === r?.nodes?.required && r?.allEdges?.drawn === r?.allEdges?.required;
    const signature = JSON.stringify({ render: r && { view: r.view, quality: r.quality, ladder: r.ladder,
      nodes: r.nodes, mainEdges: r.mainEdges, allEdges: r.allEdges, decor: r.decor },
      status: s && { quality: s.quality, nodes: s.nodes, edges: s.edges }, camera: latest.camera });
    if (signature !== previous) { previous = signature; unchangedSince = Date.now(); }
    else if (full && Date.now() - unchangedSince >= 2000) return { ...latest, stableMs: Date.now() - unchangedSince };
  }
  throw new Error(`full render did not reach stable readiness: ${JSON.stringify(latest)}`);
}

async function cameraSnapshot(page) {
  return page.evaluate(() => ({ state: window.__d067?.cameraState?.() ?? null, pose: window.__d067?.camera?.() ?? null }));
}

// The recorded camera is the one at the end of the program; refuse to capture if the view has drifted since (3D controls damp).
async function assertCameraUnchanged(page, recorded, itemId) {
  const current = await cameraSnapshot(page);
  const differs = (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
    if (a && b && typeof a === 'object' && typeof b === 'object')
      return Object.keys({ ...a, ...b }).some(key => differs(a[key], b[key]));
    return a !== b;
  };
  if (differs(recorded, current)) throw new Error(`${itemId}: the camera moved after its program; recorded ${JSON.stringify(recorded)}, now ${JSON.stringify(current)}`);
}

function zoomFromCameras(before, after, dimension, itemId) {
  if (dimension === '2d') {
    const beforeRatio = before.state?.ratio, afterRatio = after.state?.ratio;
    if (!(beforeRatio > 0) || !(afterRatio > 0)) throw new Error(`${itemId}: cannot measure zoom from 2D camera ratios`);
    return { factor: beforeRatio / afterRatio, source: 'cameraState ratio' };
  }
  const distance = camera => {
    const position = camera?.pose?.position, target = camera?.pose?.target;
    return position?.length === 3 && target?.length === 3
      ? Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]) : NaN;
  };
  const beforeDistance = distance(before), afterDistance = distance(after);
  if (!(beforeDistance > 0) || !(afterDistance > 0)) throw new Error(`${itemId}: cannot measure zoom from 3D camera distance`);
  return { factor: beforeDistance / afterDistance, source: 'camera position-target distance' };
}

async function resolveCameraAnchor(page, rule, itemId) {
  const anchor = await page.evaluate(request => {
    const positions = window.__d067.witness()?.nodeViewport ?? {};
    const candidates = Object.entries(positions).filter(([id, point]) => Number.isFinite(point?.x) && Number.isFinite(point?.y)
      && (request.kind !== 'domain' || id.startsWith('domain:'))
      && (request.kind !== 'id' || id === request.id));
    if (request.kind === 'id') return candidates[0] ? { id: candidates[0][0], position: candidates[0][1] } : null;
    const target = request.kind === 'centre-domain' ? { x: innerWidth / 2, y: innerHeight / 2 }
      : { x: request.x * innerWidth, y: request.y * innerHeight };
    candidates.sort(([aId, a], [bId, b]) => {
      const da = (a.x - target.x) ** 2 + (a.y - target.y) ** 2;
      const db = (b.x - target.x) ** 2 + (b.y - target.y) ** 2;
      return da - db || aId.localeCompare(bId);
    });
    return candidates[0] ? { id: candidates[0][0], position: { x: candidates[0][1].x, y: candidates[0][1].y } } : null;
  }, rule);
  if (!anchor) throw new Error(`${itemId}: camera zoom anchor '${rule.kind === 'id' ? rule.id : rule.kind}' is not drawn`);
  return anchor;
}

// A subject is 'all', { domains: [...] } (the nodes descending from those root domains) or { under: [...] } (those nodes and their
// descendants, for example one source and its proposals).
function subjectNodeIds(subject, hierarchy) {
  if (subject === 'all') return null;
  if (subject && Array.isArray(subject.under) && subject.under.length) {
    const roots = new Set(subject.under);
    return [...hierarchy.ancestors].filter(([, chain]) => chain.some(id => roots.has(id))).map(([id]) => id);
  }
  if (!subject || !Array.isArray(subject.domains) || !subject.domains.length)
    throw new Error('frame subject must be all, a non-empty domains list or a non-empty under list');
  const domains = new Set(subject.domains);
  return [...hierarchy.domains].filter(([, memberships]) => memberships.some(domain => domains.has(domain))).map(([id]) => id);
}

// Decodes the 8-bit RGB or RGBA PNG that Chromium's screenshot returns into per-pixel luminance.
function decodePngLuminance(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('screenshot is not a PNG');
  let offset = 8, width = 0, height = 0, colourType = -1;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colourType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG bit depth or interlace');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported PNG colour type ${colourType}`);
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels;
  const pixels = Buffer.alloc(stride * height), luminance = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride), above = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0, b = above ? above[i] : 0, c = above && i >= channels ? above[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const estimate = a + b - c, pa = Math.abs(estimate - a), pb = Math.abs(estimate - b), pc = Math.abs(estimate - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = value & 255;
    }
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * channels;
      luminance[y * width + x] = (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000;
    }
  }
  return { width, height, luminance };
}

// The drawn structure as a reader sees it, for a topology whose guides reach beyond its nodes (Sierpinski's 3D outline): nodes,
// relations and guides from a screenshot of the page, without the background stars, its smooth glow, or the title.
async function measureVisibleFraming(page) {
  const { rect, title } = await page.evaluate(() => {
    const r = document.getElementById('viewport').getBoundingClientRect(), b = document.getElementById('fullscreen-brand')?.getBoundingClientRect();
    return { rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      title: b ? { left: b.left - r.left, top: b.top - r.top, right: b.right - r.left, bottom: b.bottom - r.top } : null };
  });
  const png = await page.screenshot({ type: 'png', scale: 'css', clip: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } });
  const { width, height, luminance } = decodePngLuminance(png);
  // A half-resolution grid (the brightest pixel of each 2x2 block, so thin lines survive). A cell counts when it is bright and clearly
  // brighter than its surroundings, which leaves out the background's smooth glow; only connected regions of at least 24 cells are kept,
  // which leaves out the stars.
  const gw = Math.floor(width / 2), gh = Math.floor(height / 2), grid = new Uint8Array(gw * gh), bright = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = 2 * y * width + 2 * x;
    grid[y * gw + x] = Math.max(luminance[i], luminance[i + 1], luminance[i + width], luminance[i + width + 1]);
  }
  const sums = new Float64Array((gw + 1) * (gh + 1));
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++)
    sums[(y + 1) * (gw + 1) + x + 1] = grid[y * gw + x] + sums[y * (gw + 1) + x + 1] + sums[(y + 1) * (gw + 1) + x] - sums[y * (gw + 1) + x];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const x0 = Math.max(0, x - 15), x1 = Math.min(gw, x + 16), y0 = Math.max(0, y - 15), y1 = Math.min(gh, y + 16);
    const mean = (sums[y1 * (gw + 1) + x1] - sums[y0 * (gw + 1) + x1] - sums[y1 * (gw + 1) + x0] + sums[y0 * (gw + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    const value = grid[y * gw + x];
    const inTitle = title && 2 * x >= title.left - 8 && 2 * x <= title.right + 8 && 2 * y >= title.top - 8 && 2 * y <= title.bottom + 8;
    bright[y * gw + x] = value > 28 && value - mean > 16 && !inTitle ? 1 : 0;
  }
  const label = new Int32Array(gw * gh).fill(-1), queue = new Int32Array(gw * gh), columns = new Uint32Array(gw), rows = new Uint32Array(gh);
  let kept = 0;
  for (let start = 0; start < bright.length; start++) {
    if (!bright[start] || label[start] !== -1) continue;
    let head = 0, tail = 0;
    queue[tail++] = start; label[start] = start;
    while (head < tail) {
      const cell = queue[head++], cx = cell % gw, cy = (cell - cx) / gw;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const next = ny * gw + nx;
        if (bright[next] && label[next] === -1) { label[next] = start; queue[tail++] = next; }
      }
    }
    if (tail < 24) continue;
    for (let k = 0; k < tail; k++) { const cell = queue[k], cx = cell % gw; columns[cx]++; rows[(cell - cx) / gw]++; }
    kept += tail;
  }
  if (!kept) throw new Error('no visible structure to frame');
  const quantile = (counts, fraction) => {
    let seen = 0;
    for (let i = 0; i < counts.length; i++) { seen += counts[i]; if (seen > fraction * kept) return i; }
    return counts.length - 1;
  };
  const left = 2 * quantile(columns, 0.001), right = 2 * (quantile(columns, 0.999) + 1);
  const top = 2 * quantile(rows, 0.001), bottom = 2 * (quantile(rows, 0.999) + 1);
  const w = rect.width, h = rect.height, occupancy = { x: (right - left) / w, y: (bottom - top) / h };
  return { subject: 'visible', count: kept, bounds: 'visible structure (stars, background glow and title excluded)',
    bbox: { left, top, right, bottom, width: right - left, height: bottom - top }, viewport: { width: w, height: h }, occupancy,
    limiting: occupancy.x >= occupancy.y ? 'x' : 'y', centreOffset: { x: (left + right) / 2 - w / 2, y: (top + bottom) / 2 - h / 2 },
    clipped: left <= 2 || top <= 2 || right >= w - 2 || bottom >= h - 2 ? 1 : 0 };
}

// The framing measurement a capture records: the bounds of its frame subject's drawn nodes, or the visible structure when the frame
// setting asks for it.
async function measureForSetting(page, setting, idDomains) {
  if (setting?.bounds === 'visible') return measureVisibleFraming(page);
  const subject = setting?.subject ?? 'all';
  return measureFraming(page, subject, subjectNodeIds(subject, idDomains));
}

async function measureFraming(page, subject = 'all', selectedIds = null) {
  return page.evaluate(({ subject, selectedIds }) => {
    const witness = window.__d067?.witness?.();
    const viewportElement = document.getElementById('viewport');
    const rect = viewportElement?.getBoundingClientRect();
    if (!witness || !rect) throw new Error('framing witness or fullscreen viewport is unavailable');
    const selected = selectedIds === null ? null : new Set(selectedIds);
    // `__d067.witness()` lists every drawn node with its core radius; a painted-id list is used only when the witness carries one.
    const painted = Array.isArray(witness.paintedNodeIds) && witness.paintedNodeIds.length ? new Set(witness.paintedNodeIds) : null;
    const candidates = Object.entries(witness.nodeViewport ?? {}).filter(([id, point]) => (!painted || painted.has(id))
      && (!selected || selected.has(id)) && Number.isFinite(point?.x) && Number.isFinite(point?.y));
    // A subject turned out of the 3D frustum reports a zero radius; its projected centres still say where it is.
    const drawn = candidates.filter(([, point]) => (point?.radius ?? 0) > 0);
    const nodes = drawn.length ? drawn : candidates;
    if (!nodes.length) throw new Error(`framing subject ${JSON.stringify(subject)} has no projected nodes`);
    // In 3D a node near the camera can report a perspective footprint far larger than what is drawn (956 px was seen), so the
    // 3D bounds use node centres; the 2D radius is the drawn ink radius and is kept.
    const perspective = String(window.__d082?.render?.()?.view ?? '').includes('/3d/');
    const cores = nodes.map(([id, point]) => ({ id, x: point.x - rect.left, y: point.y - rect.top, r: perspective ? 0 : point.radius ?? 0 }));
    const left = Math.min(...cores.map(node => node.x - node.r)), top = Math.min(...cores.map(node => node.y - node.r));
    const right = Math.max(...cores.map(node => node.x + node.r)), bottom = Math.max(...cores.map(node => node.y + node.r));
    const width = rect.width, height = rect.height, bboxWidth = right - left, bboxHeight = bottom - top;
    const occupancy = { x: bboxWidth / width, y: bboxHeight / height };
    return { subject, count: cores.length, drawnOnly: drawn.length > 0, bounds: perspective ? 'node centres' : 'node centres ± drawn radius',
      bbox: { left, top, right, bottom, width: bboxWidth, height: bboxHeight },
      viewport: { width, height }, occupancy, limiting: occupancy.x >= occupancy.y ? 'x' : 'y',
      centreOffset: { x: (left + right) / 2 - width / 2, y: (top + bottom) / 2 - height / 2 },
      clipped: cores.filter(node => node.x - node.r < 0 || node.y - node.r < 0
        || node.x + node.r > width || node.y + node.r > height).length };
  }, { subject, selectedIds });
}

// A programmatic fit or camera restore moves the camera but does not redraw every overlay: Llull's figure, Sierpinski's outline and
// Julia's rays kept an earlier placement while the nodes moved. Each fit and restore is therefore followed by one wheel step in and one
// out at the viewport centre. Scaling about the same point by s and then 1/s returns the same camera, now redrawn through the page's own
// wheel path.
async function redrawThroughWheel(page) {
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.mouse.move(size.width / 2, size.height / 2);
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(450);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(450);
  // Leave no hover behind (a Canopy bundle badge stayed after the pointer left the window): end the pointer's path over an empty
  // corner, tell the canvas the pointer has left, then move it out of the page.
  await page.mouse.move(4, size.height - 4, { steps: 8 });
  await page.evaluate(() => {
    const root = document.querySelector('#render-root'), host = root?.querySelector('.view-host');
    for (const element of [host, root]) element?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
  });
  await page.mouse.move(-40, -40);
  await page.waitForTimeout(300);
}

async function restoreCameraThroughPage(page, state) {
  await page.evaluate(state => window.__d067.restoreCameraState(state), state);
  await redrawThroughWheel(page);
  await stableFullReadiness(page);
}

// Pans through the page's own camera state. A drag carries inertia in 2D (a 60 px drag moved the content about 105 px), so the
// subject's centre is moved by solving the measured response of its on-screen centre to the camera's x and y.
async function measurePanResponse(page, measure, base) {
  const state = await page.evaluate(() => window.__d067.cameraState());
  const step = 0.01 * (state.ratio ?? 1);
  const probe = async key => {
    await restoreCameraThroughPage(page, { ...state, [key]: state[key] + step });
    const moved = await measure();
    return { x: (moved.centreOffset.x - base.centreOffset.x) / step, y: (moved.centreOffset.y - base.centreOffset.y) / step };
  };
  const alongX = await probe('x'), alongY = await probe('y');
  await restoreCameraThroughPage(page, state);
  const determinant = alongX.x * alongY.y - alongY.x * alongX.y;
  if (!(Math.abs(determinant) > 1e-9)) throw new Error('camera state x/y has no measurable effect on the subject');
  return { alongX, alongY, determinant, step };
}

async function applyFrame(page, setting, dimension, itemId, idDomains) {
  const subject = setting.subject ?? 'all', target = setting.occupancy ?? 0.85;
  const tolerance = setting.tolerance ?? 0.03, maxIterations = setting.maxIterations ?? 12;
  if (!(target > 0 && target < 1) || !(tolerance >= 0) || !Number.isInteger(maxIterations) || maxIterations < 1)
    throw new Error(`${itemId}: invalid frame occupancy, tolerance, or maxIterations`);
  const ids = subjectNodeIds(subject, idDomains), iterations = [];
  const effectiveTarget = target;
  let response = null, nearRatio = null, farRatio = null;
  const measure = () => setting.bounds === 'visible' ? measureVisibleFraming(page) : measureFraming(page, subject, ids);
  let measurement = await measure();
  const zoomMetric = async () => {
    const snapshot = await cameraSnapshot(page);
    if (dimension === '3d') {
      const p = snapshot.pose?.position, t = snapshot.pose?.target;
      return { ratio: snapshot.state?.ratio ?? null, distance: p?.length === 3 && t?.length === 3
        ? Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]) : null };
    }
    return { ratio: snapshot.state?.ratio ?? null };
  };
  for (let index = 0; index < maxIterations; index++) {
    const entry = { iteration: index + 1, measurementBefore: measurement, cameraBefore: await zoomMetric(),
      pan: { dx: 0, dy: 0 }, zoom: null };
    const offset = measurement.centreOffset;
    if (Math.abs(offset.x) > measurement.viewport.width * 0.005 || Math.abs(offset.y) > measurement.viewport.height * 0.005) {
      response ??= await measurePanResponse(page, measure, measurement);
      const { alongX, alongY, determinant } = response;
      const dx = (-offset.x * alongY.y + offset.y * alongY.x) / determinant;
      const dy = (-offset.y * alongX.x + offset.x * alongX.y) / determinant;
      const state = await page.evaluate(() => window.__d067.cameraState());
      await restoreCameraThroughPage(page, { ...state, x: state.x + dx, y: state.y + dy });
      entry.pan = { method: 'page camera state', offsetBefore: offset, cameraDelta: { x: dx, y: dy } };
      measurement = await measure();
      // A large pan changes what the zoom bracket was measured on; a subject still off centre cannot be judged for size.
      if (Math.abs(offset.x) > measurement.viewport.width * 0.05 || Math.abs(offset.y) > measurement.viewport.height * 0.05) nearRatio = farRatio = null;
      if (Math.abs(measurement.centreOffset.x) > measurement.viewport.width * 0.005
        || Math.abs(measurement.centreOffset.y) > measurement.viewport.height * 0.005) {
        entry.cameraAfter = await zoomMetric();
        entry.measurementAfter = measurement;
        iterations.push(entry);
        continue;
      }
    }
    const occupancy = Math.max(measurement.occupancy.x, measurement.occupancy.y);
    const tooNear = occupancy > target + tolerance || measurement.clipped > 0, tooFar = occupancy < target - tolerance;
    if (tooNear || tooFar) {
      // A larger ratio is farther away. Step in proportion, at most x2 either way, and bisect once the band is bracketed: in
      // perspective a cluster's on-screen size grows faster than the dolly as the camera nears it, so one proportional jump overshoots.
      const state = await page.evaluate(() => window.__d067.cameraState());
      if (tooNear) nearRatio = nearRatio === null ? state.ratio : Math.max(nearRatio, state.ratio);
      else farRatio = farRatio === null ? state.ratio : Math.min(farRatio, state.ratio);
      let next = state.ratio * Math.min(2, Math.max(0.5, occupancy / target));
      if (nearRatio !== null && farRatio !== null && !(next > nearRatio && next < farRatio)) next = Math.sqrt(nearRatio * farRatio);
      const before = await zoomMetric();
      await restoreCameraThroughPage(page, { ...state, ratio: next });
      measurement = await measure();
      entry.zoom = { ratioFrom: state.ratio, ratioTo: next, bracket: { near: nearRatio, far: farRatio }, before, after: await zoomMetric() };
      response = null;
    }
    entry.cameraAfter = await zoomMetric();
    entry.measurementAfter = measurement;
    iterations.push(entry);
    if (process.env.CAPTURE_FRAME_DEBUG) console.error(`${itemId} frame ${index + 1}: n=${measurement.count} occ=${measurement.occupancy.x.toFixed(3)}x${measurement.occupancy.y.toFixed(3)} off=${measurement.centreOffset.x.toFixed(1)},${measurement.centreOffset.y.toFixed(1)} clipped=${measurement.clipped} ratio=${entry.cameraAfter.ratio} distance=${entry.cameraAfter.distance ?? ''}`);
    const finalOccupancy = Math.max(measurement.occupancy.x, measurement.occupancy.y);
    if (Math.abs(finalOccupancy - effectiveTarget) <= tolerance && measurement.clipped === 0
      && Math.abs(measurement.centreOffset.x) <= measurement.viewport.width * 0.005
      && Math.abs(measurement.centreOffset.y) <= measurement.viewport.height * 0.005)
      return { program: { op: 'frame', subject, ...(setting.bounds ? { bounds: setting.bounds } : {}), occupancy: target, tolerance, maxIterations }, effectiveTarget, iterations, final: measurement };
  }
  throw new Error(`${itemId}: frame did not reach target after ${maxIterations} iterations; last measurement ${JSON.stringify(measurement)}`);
}

async function applyCameraProgram(page, program, dimension, itemId, idDomains) {
  if (!Array.isArray(program)) throw new Error(`${itemId}: camera program must be an array`);
  const before = await cameraSnapshot(page), zooms = [], orbits = [], frames = [];
  for (let index = 0; index < program.length; index++) {
    const operation = program[index], operationBefore = await cameraSnapshot(page);
    const validateSteps = () => {
      if (!Number.isInteger(operation.steps) || operation.steps < 1) throw new Error(`${itemId}: camera operation ${index} needs positive integer steps`);
    };
    if (operation?.op === 'orbit' || operation?.op === 'pan') {
      validateSteps();
      if (!Number.isFinite(operation.dx) || !Number.isFinite(operation.dy))
        throw new Error(`${itemId}: camera operation ${index} needs finite dx and dy`);
      const center = await page.evaluate(() => ({ x: innerWidth / 2, y: innerHeight / 2 }));
      await page.mouse.move(center.x, center.y);
      const shiftPan = operation.op === 'pan' && dimension === '3d';
      if (shiftPan) await page.keyboard.down('Shift');
      try {
        await page.mouse.down({ button: 'left' });
        for (let step = 1; step <= operation.steps; step++)
          await page.mouse.move(center.x + operation.dx * step / operation.steps,
            center.y + operation.dy * step / operation.steps);
        await page.mouse.up({ button: 'left' });
      } finally {
        if (shiftPan) await page.keyboard.up('Shift');
      }
      if (operation.op === 'orbit' && dimension === '3d') {
        const operationAfter = await cameraSnapshot(page);
        orbits.push({ operation: index, before: operationBefore.state?.orbit ?? null, after: operationAfter.state?.orbit ?? null });
      }
    } else if (operation?.op === 'zoomAt') {
      validateSteps();
      if (![operation.x, operation.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1))
        throw new Error(`${itemId}: camera operation ${index} zoomAt coordinates must be within 0..1`);
      const point = await page.evaluate(({ x, y }) => ({ x: x * innerWidth, y: y * innerHeight }), operation);
      await page.mouse.move(point.x, point.y);
      for (let step = 0; step < operation.steps; step++) {
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(350);
      }
      const operationAfter = await cameraSnapshot(page);
      zooms.push({ operation: index, ...zoomFromCameras(operationBefore, operationAfter, dimension, itemId), point });
    } else if (operation?.op === 'zoomAnchor') {
      validateSteps();
      let rule;
      if (operation.anchor === 'centre-domain') rule = { kind: 'centre-domain' };
      else if (typeof operation.anchor === 'string' && operation.anchor.startsWith('domain:'))
        rule = { kind: 'id', id: operation.anchor };
      else if (operation.anchor && typeof operation.anchor === 'object' && operation.anchor['node-near']) {
        const point = operation.anchor['node-near'];
        if (!point || typeof point !== 'object'
          || ![point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1))
          throw new Error(`${itemId}: camera operation ${index} node-near coordinates must be within 0..1`);
        rule = { kind: 'node-near', x: point.x, y: point.y };
      } else throw new Error(`${itemId}: camera operation ${index} has an unsupported zoomAnchor rule`);
      const anchor = await resolveCameraAnchor(page, rule, itemId);
      for (let step = 0; step < operation.steps; step++) {
        const current = await page.evaluate(id => window.__d067.witness()?.nodeViewport?.[id] ?? null, anchor.id);
        if (!current || !Number.isFinite(current.x) || !Number.isFinite(current.y))
          throw new Error(`${itemId}: zoom anchor ${anchor.id} is no longer drawn`);
        await page.mouse.move(current.x, current.y);
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(350);
      }
      const operationAfter = await cameraSnapshot(page);
      zooms.push({ operation: index, ...zoomFromCameras(operationBefore, operationAfter, dimension, itemId), anchor: operation.anchor,
        anchorId: anchor.id, anchorAtStart: anchor.position });
    } else if (operation?.op === 'frame') {
      frames.push({ operation: index, ...(await applyFrame(page, operation, dimension, itemId, idDomains)) });
    } else throw new Error(`${itemId}: camera operation ${index} has unsupported op '${operation?.op}'`);
  }
  const after = await cameraSnapshot(page);
  return { program: JSON.parse(JSON.stringify(program)), before, after, zooms, ...(frames.length ? { frames } : {}),
    ...(orbits.length ? { orbits, orbit: { before: before.state?.orbit ?? null, after: after.state?.orbit ?? null } } : {}) };
}

async function fitAfterResize(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = window.__d067.fit();
    if (result && typeof result.then === 'function') await result;
  });
  await redrawThroughWheel(page);
}

async function enterFullscreenAndFit(page, itemId) {
  const deadline = Date.now() + 10000;
  const toolbarActivationStyle = await page.addStyleTag({ content: '#review-toolbar{display:block!important;visibility:visible!important}' });
  try {
    await page.click('#fullscreen', { timeout: 10000 });
    await page.waitForFunction(() => document.fullscreenElement === document.getElementById('viewport'), null,
      { timeout: Math.max(1, deadline - Date.now()) });
  } catch (error) {
    throw new Error(`${itemId}: viewport fullscreen was not entered within 10 seconds: ${error.message}`);
  }
  await toolbarActivationStyle.evaluate(style => style.remove());
  await fitAfterResize(page);
}

async function assertFullscreenCapture(page, itemId) {
  const result = await page.evaluate(() => {
    const viewport = document.getElementById('viewport');
    const brand = document.getElementById('fullscreen-brand');
    const rect = brand?.getBoundingClientRect();
    const brandStyle = brand ? getComputedStyle(brand) : null;
    const brandRect = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    const visible = element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) > 0 && box.width > 0 && box.height > 0;
    };
    const brandVisible = !!brand && !brand.hidden && brandStyle.display !== 'none' && brandStyle.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
    const brandInsideQuarter = !!rect && rect.left >= 0 && rect.top >= 0
      && rect.right <= viewport.clientWidth / 2 && rect.bottom <= viewport.clientHeight / 2;
    const visibleLegendControls = [...document.querySelectorAll('#fullscreen-bar, #fullscreen-bar *, #fullscreen-legend, #fullscreen-legend *')]
      .filter(visible).map(element => element.id || element.tagName.toLowerCase());
    const visibleViewportControls = [...viewport.querySelectorAll('button, input')].filter(visible)
      .map(element => element.id || element.tagName.toLowerCase());
    const selected = window.__d067.state().selected;
    const tooltipSelectors = '[role="tooltip"],.tooltip,#v2-edge-tooltip,#control-tooltip,[data-fractal-bundle-count]';
    const visibleTooltips = [...document.querySelectorAll(tooltipSelectors)].filter(visible)
      .map(element => element.id || element.getAttribute('role') || element.className);
    return { brandRect, brandVisible, brandInsideQuarter, visibleLegendControls, visibleViewportControls, selected, visibleTooltips };
  });
  if (!result.brandVisible || !result.brandInsideQuarter)
    throw new Error(`${itemId}: fullscreen brand is missing, hidden, or outside the top-left viewport quarter`);
  if (result.visibleLegendControls.length || result.visibleViewportControls.length)
    throw new Error(`${itemId}: visible viewport controls remain: ${[...result.visibleLegendControls, ...result.visibleViewportControls].join(', ')}`);
  if (result.selected !== null) throw new Error(`${itemId}: selection is active before capture`);
  if (result.visibleTooltips.length) throw new Error(`${itemId}: tooltip visible before capture: ${result.visibleTooltips.join(', ')}`);
  return { brandRect: result.brandRect };
}

function sameWithinTolerance(left, right, label) {
  if (typeof left === 'number' && typeof right === 'number') return Math.abs(left - right) <= 1e-9;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => sameWithinTolerance(value, right[index], label));
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]
      && sameWithinTolerance(left[key], right[key], label));
  }
  return left === right;
}

function assertSameOrientation(dimension, completeCamera, balancedCamera) {
  const a = completeCamera.state, b = balancedCamera.state;
  if (dimension === '2d') {
    if (typeof a?.angle !== 'number' || typeof b?.angle !== 'number'
      || !sameWithinTolerance(a.angle, b.angle, 'angle')) throw new Error('2D camera angle changed between density fits');
    return;
  }
  if (a?.orbit == null || b?.orbit == null || !sameWithinTolerance(a.orbit, b.orbit, 'orbit'))
    throw new Error('3D camera orbit changed between density fits');
}

async function captureJpeg(page, file, paired, fullPage = false) {
  const initialQuality = paired ? 90 : 85;
  for (let retry = 0; retry <= 5; retry++) {
    const jpegQuality = initialQuality - retry;
    const raw = await page.screenshot({ type: 'jpeg', quality: jpegQuality,
      scale: paired ? 'device' : 'css', ...(fullPage ? { fullPage: true } : {}) });
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(raw);
    if (ALL_PATTERNS.some(pattern => pattern.test(decoded))) {
      if (retry === 5) throw new Error(`${path.basename(file)}: byte-level safety pattern persisted after five JPEG quality retries`);
      continue;
    }
    await writeFile(file, raw);
    return { ...inspectJpeg(await readFile(file), path.basename(file)), jpegQuality,
      ...(retry ? { jpegQualityReason: 'byte-level safety pattern in the encoded bytes' } : {}) };
  }
  throw new Error(`${path.basename(file)}: unable to produce a JPEG that passes the byte-level safety scan`);
}

// Variant captures must never land in the gallery, however its folder is spelled (symlinks, case-insensitive file systems).
function sameDirectory(a, b) {
  const real = p => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
  const fold = p => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p);
  return fold(real(a)) === fold(real(b));
}

async function main() {
  if (args.variants === true) throw new Error('--variants needs a JSON file path');
  if (args.variants !== undefined && sameDirectory(OUT, GALLERY_DIR))
    throw new Error('--variants needs --out outside docs/assets/gallery, so variant captures never overwrite the gallery');
  const manifest = JSON.parse(await readFile(path.join(DATASET, 'manifest.json'), 'utf8'));
  const datasetIndex = JSON.parse(await readFile(path.join(DATASET, 'index.json'), 'utf8'));
  // A framing subject's domain is the root its hierarchy descends from: the page places each root domain's descendants in one
  // cluster, while a node's `domains` field can also name other domains (nine of d1's 153 nodes descend from other roots).
  const datasetNodes = new Map(datasetIndex.nodes.map(node => [node.id, node]));
  const ancestorsOf = node => {
    const chain = [];
    for (let current = node, hops = 0; current && hops < 64; current = datasetNodes.get(current.parent), hops++) chain.push(current);
    return chain;
  };
  const rootDomain = chain => chain.find(node => node.kind === 'domain')?.id.replace(/^domain:/, '') ?? null;
  const idDomains = { ancestors: new Map(), domains: new Map() };
  for (const node of datasetIndex.nodes) {
    const chain = ancestorsOf(node);
    idDomains.ancestors.set(node.id, chain.map(item => item.id));
    idDomains.domains.set(node.id, rootDomain(chain) ? [rootDomain(chain)] : node.domains ?? []);
  }
  const variants = typeof args.variants === 'string'
    ? JSON.parse(await readFile(path.resolve(ROOT, args.variants), 'utf8')) : null;
  if (variants !== null) {
    if (!Array.isArray(variants)) throw new Error('--variants must contain a JSON list');
    const names = new Set();
    for (const [index, variant] of variants.entries()) {
      if (!variant || typeof variant.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(variant.name))
        throw new Error(`--variants item ${index} needs a safe output-file stem in name`);
      if (names.has(variant.name)) throw new Error(`--variants has duplicate name '${variant.name}'`);
      if (GALLERY.some(item => item.id === variant.name)) throw new Error(`--variants name '${variant.name}' is a gallery id`);
      names.add(variant.name);
      if (!GALLERY.some(item => item.id === variant.base)) throw new Error(`--variants item ${variant.name}: unknown base '${variant.base}'`);
      if (typeof variant.title !== 'string' || !Array.isArray(variant.camera))
        throw new Error(`--variants item ${variant.name} needs title and camera array`);
      if (variant.view !== undefined && (!variant.view || typeof variant.view !== 'object' || Array.isArray(variant.view)
        || Object.keys(variant.view).some(key => !['density', 'customNodes'].includes(key))))
        throw new Error(`--variants item ${variant.name} view override may contain only density and customNodes`);
      if (variant.view?.density !== undefined && !['balanced', 'custom', 'complete'].includes(variant.view.density))
        throw new Error(`--variants item ${variant.name} has unsupported density`);
      if (variant.view?.customNodes !== undefined && (!Number.isSafeInteger(variant.view.customNodes) || variant.view.customNodes < 1))
        throw new Error(`--variants item ${variant.name} customNodes must be a positive safe integer`);
    }
  }
  let previousGallery = null;
  try { previousGallery = JSON.parse(await readFile(path.join(OUT, 'MANIFEST.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
  const availableIds = variants ? new Set(variants.map(variant => variant.name)) : new Set(GALLERY.map(item => item.id));
  const unknown = only && [...only].filter(id => !availableIds.has(id));
  if (unknown?.length) throw new Error(`unknown gallery id(s): ${unknown.join(', ')}`);
  await mkdir(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu'] : [] });
  const browserVersion = browser.version();
  const records = [];
  try {
    const readState = async page => page.evaluate(() => {
        const r = window.__d082?.render?.(), s = window.__d081?.status?.();
        return { view: r?.view ?? null, quality: r?.quality ?? null, nodesVisible: s?.nodes?.visible ?? null,
          nodesTotal: s?.nodes?.total ?? null, edgesDrawn: s?.edges?.drawn ?? null, edgesTotal: s?.edges?.total ?? null };
      });
    const assertRequestedDensity = async (page, view, itemId) => {
      const requested = view.density ?? 'complete', requestedCustomNodes = requested === 'custom' ? view.customNodes ?? null : null;
      const committed = await page.evaluate(() => ({ density: window.__d067?.density?.() ?? null,
        view: window.__d082?.render?.()?.view ?? null, custom: window.__d081?.status?.()?.custom ?? null }));
      if (committed.density !== requested || !committed.view?.includes(`/${requested}/`))
        throw new Error(`${itemId}: requested density ${requested}, committed ${committed.density} in ${committed.view}`);
      const committedCustomNodes = committed.custom?.requested ?? null;
      if (requested === 'custom' && requestedCustomNodes !== null && committedCustomNodes !== null
        && committedCustomNodes !== requestedCustomNodes)
        throw new Error(`${itemId}: requested ${requestedCustomNodes} custom nodes, committed ${committedCustomNodes}`);
      return { requested, committed: committed.density, committedView: committed.view, requestedCustomNodes, committedCustomNodes };
    };
    const saveRecord = async (page, item, camera, dimensions, timings, pageErrors, state = null, pairRule = null, detail = null, fullscreenInfo = null, framing = null, density = null) => {
      const record = {
        id: item.id, title: item.title, file: `${item.id}.jpg`, view: item.view, state: state ?? await readState(page),
        completeMs: timings.completeMs, densitySwitchMs: timings.densitySwitchMs,
        stableMs: timings.stableMs, pageErrors: pageErrors.length, camera,
        width: dimensions.width, height: dimensions.height,
        jpegQuality: dimensions.jpegQuality,
        ...(dimensions.jpegQualityReason ? { jpegQualityReason: dimensions.jpegQualityReason } : {}),
        ...(fullscreenInfo ? { fullscreen: true, brandRect: fullscreenInfo.brandRect } : {}),
        ...(pairRule ? { pairRule } : {}),
        ...(detail ? { detail } : {}),
        ...(framing ? { framing } : {}),
        density: density ?? await assertRequestedDensity(page, item.view, item.id),
      };
      records.push(record);
      return record;
    };

    const capturePair = async (dimension) => {
      const full = GALLERY.find(item => item.id === `natural-stellar-${dimension}-complete`);
      const balanced = GALLERY.find(item => item.id === `natural-stellar-${dimension}-balanced`);
      const requested = [full, balanced].filter(item => !only || only.has(item.id));
      if (!requested.length) return;
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, colorScheme: 'dark' });
      const page = await context.newPage();
      const pageErrors = [], pageRecords = [];
      page.on('pageerror', error => pageErrors.push(String(error.message ?? error)));
      page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
      try {
        const navigationStartedAt = Date.now();
        await page.goto(stateUrl(server.origin, full.view), { waitUntil: 'load' });
        const completeMs = await waitForComplete(page, navigationStartedAt);
        await installCaptureStyle(page, true);
        await enterFullscreenAndFit(page, full.id);
        let complete = await stableFullReadiness(page);
        const completeDensity = await assertRequestedDensity(page, full.view, full.id);
        const pairRule = "same page session and orientation; each density fitted by the page, then framed on its own nodes";
        let completeCapture = null, completeFrame = null, completeCamera = await cameraSnapshot(page);
        if (full.frame) {
          completeFrame = await applyFrame(page, full.frame, dimension, full.id, idDomains);
          await page.mouse.move(-40, -40);
          await page.waitForTimeout(300);
          complete = await stableFullReadiness(page);
          completeCamera = await cameraSnapshot(page);
        }
        if (!completeCamera.state) throw new Error(`${full.id}: page did not expose cameraState()`);
        if (requested.includes(full)) {
          const fullscreenInfo = await assertFullscreenCapture(page, full.id);
          await assertCameraUnchanged(page, completeCamera, full.id);
          const framingMeasurement = await measureForSetting(page, full.frame, idDomains);
          const dimensions = await captureJpeg(page, path.join(OUT, `${full.id}.jpg`), true);
          completeCapture = { fullscreenInfo, dimensions, state: await readState(page),
            framing: { program: full.frame ? { op: 'frame', ...full.frame } : null, result: completeFrame, measurement: framingMeasurement } };
        }
        const densitySwitchStartedAt = Date.now();
        await page.evaluate(() => window.__d067.setDensity('balanced'));
        const densitySwitchMs = await waitForComplete(page, densitySwitchStartedAt, '/balanced/');
        await fitAfterResize(page);
        let balancedReady = await stableFullReadiness(page);
        const balancedDensity = await assertRequestedDensity(page, balanced.view, balanced.id);
        let balancedFrame = null;
        if (balanced.frame) {
          balancedFrame = await applyFrame(page, balanced.frame, dimension, balanced.id, idDomains);
          await page.mouse.move(-40, -40);
          await page.waitForTimeout(300);
          balancedReady = await stableFullReadiness(page);
        }
        const balancedCamera = await cameraSnapshot(page);
        assertSameOrientation(dimension, completeCamera, balancedCamera);
        const pairCamera = { completa: completeCamera, bilanciata: balancedCamera };
        if (completeCapture) pageRecords.push(await saveRecord(page, full, pairCamera, completeCapture.dimensions,
          { completeMs, densitySwitchMs: null, stableMs: complete.stableMs }, pageErrors, completeCapture.state, pairRule, null, completeCapture.fullscreenInfo, completeCapture.framing, completeDensity));
        if (requested.includes(balanced)) {
          const fullscreenInfo = await assertFullscreenCapture(page, balanced.id);
          await assertCameraUnchanged(page, balancedCamera, balanced.id);
          const framingMeasurement = await measureForSetting(page, balanced.frame, idDomains);
          const dimensions = await captureJpeg(page, path.join(OUT, `${balanced.id}.jpg`), true);
          pageRecords.push(await saveRecord(page, balanced, pairCamera, dimensions,
            { completeMs: null, densitySwitchMs, stableMs: balancedReady.stableMs }, pageErrors, null, pairRule, null, fullscreenInfo,
            { program: balanced.frame ? { op: 'frame', ...balanced.frame } : null, result: balancedFrame, measurement: framingMeasurement }, balancedDensity));
        }
      } finally {
        await context.close();
        for (const record of pageRecords) record.pageErrors = pageErrors.length;
      }
    };

    const captureDetailItem = async item => {
      if (only && !only.has(item.id)) return;
      const dimension = item.dimension;
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, colorScheme: 'dark' });
      const page = await context.newPage();
      const pageErrors = [], pageRecords = [];
      page.on('pageerror', error => pageErrors.push(String(error.message ?? error)));
      page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
      try {
        const navigationStartedAt = Date.now();
        await page.goto(stateUrl(server.origin, item.view), { waitUntil: 'load' });
        const completeMs = await waitForComplete(page, navigationStartedAt);
        await installCaptureStyle(page, true);
        await enterFullscreenAndFit(page, item.id);
        await stableFullReadiness(page);
        const density = await assertRequestedDensity(page, item.view, item.id);
        const cameraAtFit = await cameraSnapshot(page);
        const baseProgram = item.camera ?? (item.wheelSteps
          ? [{ op: 'zoomAnchor', anchor: 'centre-domain', steps: item.wheelSteps }] : []);
        const program = [...baseProgram, ...(item.frame ? [{ op: 'frame', ...item.frame }] : [])];
        const execution = await applyCameraProgram(page, program, dimension, item.id, idDomains);
        await page.mouse.move(-40, -40);
        await page.waitForTimeout(300);
        let ready = await stableFullReadiness(page);
        const readPreCapture = () => page.evaluate(() => {
          const selected = window.__d067.state().selected;
          const tooltipSelectors = '[role="tooltip"],.tooltip,#v2-edge-tooltip,#control-tooltip,[data-fractal-bundle-count]';
          const visibleTooltips = [...document.querySelectorAll(tooltipSelectors)].filter(element => {
            const style = getComputedStyle(element), rect = element.getBoundingClientRect();
            return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          }).map(element => element.id || element.getAttribute('role') || element.className);
          return { selected, visibleTooltips };
        });
        let preCapture = await readPreCapture();
        let tooltipFallbackUsed = false;
        if (preCapture.visibleTooltips.length) {
          tooltipFallbackUsed = true;
          await page.evaluate(() => {
            const root = document.querySelector('#render-root');
            const canvasContainer = root?.querySelector('.view-host');
            root?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
            if (canvasContainer && canvasContainer !== root)
              canvasContainer.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
          });
          ready = await stableFullReadiness(page);
          preCapture = await readPreCapture();
        }
        if (preCapture.selected !== null) throw new Error(`${item.id}: selection is active before detail capture`);
        if (preCapture.visibleTooltips.length) throw new Error(`${item.id}: tooltip visible before detail capture: ${preCapture.visibleTooltips.join(', ')}`);
        const fullscreenInfo = await assertFullscreenCapture(page, item.id);

        const cameraAtCapture = execution.after;
        await assertCameraUnchanged(page, cameraAtCapture, item.id);
        const reveal = await page.evaluate(() => window.__d074?.revealWitness?.() ?? null);
        const measuredZoom = zoomFromCameras(cameraAtFit, cameraAtCapture, dimension, item.id);
        const framingMeasurement = await measureForSetting(page, item.frame, idDomains);
        const dimensions = await captureJpeg(page, path.join(OUT, `${item.id}.jpg`), true);
        const firstAnchor = execution.zooms.find(zoom => zoom.anchorId);
        const detail = { anchorId: firstAnchor?.anchorId ?? null, anchorAtFit: firstAnchor?.anchorAtStart ?? null,
          wheelSteps: item.wheelSteps ?? null, zoom: measuredZoom.factor, zoomSource: measuredZoom.source,
          revealZoom: Number.isFinite(reveal?.zoom) ? reveal.zoom : null,
          cameraAtFit, cameraAtCapture, tooltipFallbackUsed };
        pageRecords.push(await saveRecord(page, item, execution, dimensions,
          { completeMs, densitySwitchMs: null, stableMs: ready.stableMs }, pageErrors, null, null, detail, fullscreenInfo,
          { program: item.frame ? { op: 'frame', ...item.frame } : null, result: execution.frames?.at(-1) ?? null, measurement: framingMeasurement }, density));
      } finally {
        await context.close();
        for (const record of pageRecords) record.pageErrors = pageErrors.length;
      }
    };

    if (variants) {
      for (const variant of variants) {
        if (only && !only.has(variant.name)) continue;
        const baseItem = GALLERY.find(item => item.id === variant.base);
        const variantView = { ...baseItem.view, ...(variant.view ?? {}) };
        const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, colorScheme: 'dark' });
        const page = await context.newPage();
        const pageErrors = [], pageRecords = [];
        page.on('pageerror', error => pageErrors.push(String(error.message ?? error)));
        page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
        try {
          const navigationStartedAt = Date.now();
          await page.goto(stateUrl(server.origin, variantView), { waitUntil: 'load' });
          const completeMs = await waitForComplete(page, navigationStartedAt);
          await installCaptureStyle(page, true);
          await enterFullscreenAndFit(page, variant.name);
          await stableFullReadiness(page);
          const density = await assertRequestedDensity(page, variantView, variant.name);
          const dimension = variantView.rendering ?? '2d';
          const camera = await applyCameraProgram(page, variant.camera, dimension, variant.name, idDomains);
          await page.mouse.move(-40, -40);
          await page.waitForTimeout(300);
          const ready = await stableFullReadiness(page);
          const fullscreenInfo = await assertFullscreenCapture(page, variant.name);
          const item = { ...baseItem, id: variant.name, title: variant.title, view: variantView };
          await assertCameraUnchanged(page, camera.after, variant.name);
          const framingMeasurement = await measureForSetting(page, variant.camera.filter(operation => operation.op === 'frame').at(-1) ?? null, idDomains);
          const dimensions = await captureJpeg(page, path.join(OUT, `${variant.name}.jpg`), true);
          pageRecords.push(await saveRecord(page, item, camera, dimensions,
            { completeMs, densitySwitchMs: null, stableMs: ready.stableMs }, pageErrors, null, null, null, fullscreenInfo,
            { program: variant.camera.filter(operation => operation.op === 'frame'), result: camera.frames ?? null, measurement: framingMeasurement }, density));
        } finally {
          await context.close();
          for (const record of pageRecords) record.pageErrors = pageErrors.length;
        }
      }
    } else {
      for (const item of GALLERY) {
        if (item.detail) continue;
        if (item.paired) {
          if (item.id.endsWith('-2d-complete')) await capturePair('2d');
          if (item.id.endsWith('-3d-complete')) await capturePair('3d');
          continue;
        }
        if (only && !only.has(item.id)) continue;
        const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, colorScheme: 'dark' });
        const page = await context.newPage();
        const pageErrors = [], pageRecords = [];
        page.on('pageerror', error => pageErrors.push(String(error.message ?? error)));
        page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
        try {
          const navigationStartedAt = Date.now();
          await page.goto(stateUrl(server.origin, item.view), { waitUntil: 'load' });
          const fullWindow = item.id !== 'interface';
          const completeMs = await waitForComplete(page, navigationStartedAt);
          await installCaptureStyle(page, fullWindow);
          if (fullWindow) await enterFullscreenAndFit(page, item.id);
          let settled = await stableFullReadiness(page);
          const density = await assertRequestedDensity(page, item.view, item.id);
          let camera = { recorded: await cameraSnapshot(page), restored: null };
          const program = [...(item.camera ?? []), ...(item.frame ? [{ op: 'frame', ...item.frame }] : [])];
          if (program.length) {
            camera = await applyCameraProgram(page, program, item.view.rendering ?? '2d', item.id, idDomains);
            await page.mouse.move(-40, -40);
            await page.waitForTimeout(300);
            settled = await stableFullReadiness(page);
          }
          const fullscreenInfo = fullWindow ? await assertFullscreenCapture(page, item.id) : null;
          if (camera.restored === null) camera.restored = camera.recorded;
          await assertCameraUnchanged(page, program.length ? camera.after : camera.recorded, item.id);
          const framingMeasurement = await measureForSetting(page, item.frame, idDomains);
          const dimensions = await captureJpeg(page, path.join(OUT, `${item.id}.jpg`), false, item.fullPage === true);
          pageRecords.push(await saveRecord(page, item, camera, dimensions,
            { completeMs, densitySwitchMs: null, stableMs: settled.stableMs }, pageErrors, null, null, null, fullscreenInfo,
            { program: item.frame ? { op: 'frame', ...item.frame } : null,
              result: camera.frames?.at(-1) ?? null, measurement: framingMeasurement }, density));
        } finally {
          await context.close();
          for (const record of pageRecords) record.pageErrors = pageErrors.length;
        }
      }
      for (const item of GALLERY.filter(item => item.detail)) await captureDetailItem(item);
    }
  } finally {
    await browser.close();
    server.stop();
  }
  const capturedIds = new Set(records.map(record => record.id));
  const galleryIds = new Set(GALLERY.map(item => item.id));
  const byId = new Map((previousGallery?.images ?? [])
    .filter(record => galleryIds.has(record.id) && !capturedIds.has(record.id)).map(record => [record.id, record]));
  for (const record of records) byId.set(record.id, record);
  const images = variants ? records : GALLERY.flatMap(item => byId.has(item.id) ? [byId.get(item.id)] : []);
  const pageErrorRecords = records.filter(record => record.pageErrors > 0);
  await writeFile(path.join(OUT, 'MANIFEST.json'), JSON.stringify({
    schema: 'nousos-gallery/2', dataset: { generator: previousGallery?.dataset?.generator ?? 'demo/src/cli.ts synth --profile reference --seed 1', digest: manifest.digest },
    viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, browser: `Chromium ${browserVersion}`,
    platform: `${os.platform()} ${os.arch()}`, capturedOn: new Date().toISOString().slice(0, 10), images }, null, 2) + '\n');
  if (pageErrorRecords.length) {
    console.error(`Gallery page errors: ${pageErrorRecords.map(record => `${record.id} (${record.pageErrors})`).join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
