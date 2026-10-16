// Capture the README gallery of the review page from the synthetic demo dataset.
//
//   node ui/tools/capture-gallery.mjs [--port 8776] [--dataset demo/out/reference/dataset] [--only id,id] [--out dir] [--variants file.json --out dir]
//
// Prerequisites, from the repository root: `npm --prefix ui ci`, `npm --prefix ui run build:review`, Playwright's Chromium
// (`npx --prefix ui playwright install chromium`) and the synthetic dataset
// (`node --experimental-strip-types demo/src/cli.ts synth --profile reference --seed 1 --out demo/out/reference`).
//
// Every item except `interface` enters the page's real fullscreen mode, keeps the fullscreen brand visible, and captures after stable full readiness. Density pairs
// share a page session; detail items use real camera zoom in one session per morphology and projection.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
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
const GRAPH_OVERLAYS = '#focus-chip,#lab-notice,#notice,#toast,#fractal-canopy-explanation,#gizmo,[role=tooltip],.tooltip{visibility:hidden!important}';
const OVERLAYS = '#focus-chip,#lab-notice,#notice,#toast,#fractal-canopy-explanation,#gizmo,[role=tooltip],.tooltip,#review-toolbar,#details,#panel-edge-toggle,#fullscreen-bar,#fullscreen-legend,#selection-focus-controls,#graph-status-panel,#performance-overlay,#appearance-panel,#error{display:none!important;visibility:hidden!important}';
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
  { id: 'canopy-2d-complete', title: 'Canopy · 2D · Completa', view: { ...base, rendering: '2d', topology: 'canopy-ifs' } },
  { id: 'canopy-3d-complete', title: 'Canopy · 3D · Completa', view: { ...base, rendering: '3d', topology: 'canopy-ifs' } },
  { id: 'sierpinski-2d-complete', title: 'Sierpiński · 2D · Completa', view: { ...base, rendering: '2d', topology: 'sierpinski' } },
  { id: 'sierpinski-3d-complete', title: 'Sierpiński · 3D · Completa', view: { ...base, rendering: '3d', topology: 'sierpinski' } },
  { id: 'llull-2d-complete', title: 'Llull · 2D · Completa', view: { ...base, rendering: '2d', topology: 'circular-combinatorial' } },
  { id: 'llull-3d-complete', title: 'Llull · 3D · Completa', view: { ...base, rendering: '3d', topology: 'circular-combinatorial' } },
  { id: 'julia-2d-complete', title: 'Julia · 2D · Completa', view: { ...base, rendering: '2d', topology: 'julia' } },
  { id: 'julia-3d-complete', title: 'Julia · 3D · Completa', view: { ...base, rendering: '3d', topology: 'julia' }, camera: [{ op: 'zoomAt', x: 0.5, y: 0.5, steps: 3 }] },
  { id: 'neural-3d-brain', title: 'Neural · 3D · Completa · Cervello', view: { ...base, morphology: 'neural', brain: true, rendering: '3d', topology: 'natural' } },
  { id: 'mycelium-2d-complete', title: 'Mycelium · 2D · Completa', view: { ...base, morphology: 'mycelium', rendering: '2d', topology: 'natural' } },
  { id: 'exploratory-3d-complete', title: 'Esplorativa connections · 3D · Completa', view: { ...base, reading: 'exploratory', rendering: '3d', topology: 'natural' } },
  { id: 'natural-2d-essential', title: 'Natural · 2D · Essenziale', view: { ...base, density: 'essential', rendering: '2d', topology: 'natural' } },
  { id: 'natural-2d-balanced', title: 'Natural · 2D · Bilanciata', view: { ...base, density: 'balanced', rendering: '2d', topology: 'natural' } },
  { id: 'natural-stellar-2d-complete', title: 'Natural · Stellar · 2D · Completa', view: { ...base, rendering: '2d', topology: 'natural' }, paired: true },
  { id: 'natural-stellar-2d-balanced', title: 'Natural · Stellar · 2D · Bilanciata', view: { ...base, density: 'balanced', rendering: '2d', topology: 'natural' }, paired: true },
  { id: 'natural-stellar-3d-complete', title: 'Natural · Stellar · 3D · Completa', view: { ...base, rendering: '3d', topology: 'natural' }, paired: true },
  { id: 'natural-stellar-3d-balanced', title: 'Natural · Stellar · 3D · Bilanciata', view: { ...base, density: 'balanced', rendering: '3d', topology: 'natural' }, paired: true },
  { id: 'natural-stellar-2d-complete-detail-links', title: 'Natural · Stellar · 2D · Completa · small cluster and its links', view: { ...base, rendering: '2d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '2d', camera: [{ op: 'zoomAnchor', anchor: 'domain:d1', steps: 7 }] },
  { id: 'natural-stellar-2d-complete-detail-cluster', title: 'Natural · Stellar · 2D · Completa · nodes of one cluster', view: { ...base, rendering: '2d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '2d', camera: [{ op: 'zoomAnchor', anchor: 'domain:d6', steps: 8 }] },
  { id: 'natural-stellar-3d-complete-detail-oblique', title: 'Natural · Stellar · 3D · Completa · oblique view of one cluster', view: { ...base, rendering: '3d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '3d', camera: [{ op: 'orbit', dx: 120, dy: -50, steps: 10 }, { op: 'zoomAnchor', anchor: 'domain:d6', steps: 30 }] },
  { id: 'natural-stellar-3d-complete-detail-cluster', title: 'Natural · Stellar · 3D · Completa · nodes of one cluster', view: { ...base, rendering: '3d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '3d', camera: [{ op: 'zoomAnchor', anchor: 'domain:d8', steps: 34 }] },
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

async function applyCameraProgram(page, program, dimension, itemId) {
  if (!Array.isArray(program)) throw new Error(`${itemId}: camera program must be an array`);
  const before = await cameraSnapshot(page), zooms = [], orbits = [];
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
    } else throw new Error(`${itemId}: camera operation ${index} has unsupported op '${operation?.op}'`);
  }
  const after = await cameraSnapshot(page);
  return { program: JSON.parse(JSON.stringify(program)), before, after, zooms,
    ...(orbits.length ? { orbits, orbit: { before: before.state?.orbit ?? null, after: after.state?.orbit ?? null } } : {}) };
}

async function fitAfterResize(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = window.__d067.fit();
    if (result && typeof result.then === 'function') await result;
  });
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
    const tooltipSelectors = '[role="tooltip"],.tooltip,#v2-edge-tooltip,#control-tooltip';
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
  const manifest = JSON.parse(await readFile(path.join(DATASET, 'manifest.json'), 'utf8'));
  if (args.variants === true) throw new Error('--variants needs a JSON file path');
  if (args.variants !== undefined && sameDirectory(OUT, GALLERY_DIR))
    throw new Error('--variants needs --out outside docs/assets/gallery, so variant captures never overwrite the gallery');
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
    const saveRecord = async (page, item, camera, dimensions, timings, pageErrors, state = null, pairRule = null, detail = null, fullscreenInfo = null) => {
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
        const complete = await stableFullReadiness(page);
        const recordedCamera = await cameraSnapshot(page);
        if (!recordedCamera.state) throw new Error(`${full.id}: page did not expose cameraState()`);
        const pairRule = "same page session and orientation; each density framed by the page's fit()";
        const completeCapture = requested.includes(full) ? {
          fullscreenInfo: await assertFullscreenCapture(page, full.id),
          dimensions: await captureJpeg(page, path.join(OUT, `${full.id}.jpg`), true), state: await readState(page),
        } : null;
        const densitySwitchStartedAt = Date.now();
        await page.evaluate(() => window.__d067.setDensity('balanced'));
        const densitySwitchMs = await waitForComplete(page, densitySwitchStartedAt, '/balanced/');
        await fitAfterResize(page);
        const balancedReady = await stableFullReadiness(page);
        const balancedCamera = await cameraSnapshot(page);
        assertSameOrientation(dimension, recordedCamera, balancedCamera);
        const pairCamera = { completa: recordedCamera, bilanciata: balancedCamera };
        if (completeCapture) pageRecords.push(await saveRecord(page, full, pairCamera, completeCapture.dimensions,
          { completeMs, densitySwitchMs: null, stableMs: complete.stableMs }, pageErrors, completeCapture.state, pairRule, null, completeCapture.fullscreenInfo));
        if (requested.includes(balanced)) {
          const fullscreenInfo = await assertFullscreenCapture(page, balanced.id);
          const dimensions = await captureJpeg(page, path.join(OUT, `${balanced.id}.jpg`), true);
          pageRecords.push(await saveRecord(page, balanced, pairCamera, dimensions,
            { completeMs: null, densitySwitchMs, stableMs: balancedReady.stableMs }, pageErrors, null, pairRule, null, fullscreenInfo));
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
        const cameraAtFit = await cameraSnapshot(page);
        const program = item.camera ?? (item.wheelSteps
          ? [{ op: 'zoomAnchor', anchor: 'centre-domain', steps: item.wheelSteps }] : []);
        const execution = await applyCameraProgram(page, program, dimension, item.id);
        await page.mouse.move(-40, -40);
        await page.waitForTimeout(300);
        let ready = await stableFullReadiness(page);
        const readPreCapture = () => page.evaluate(() => {
          const selected = window.__d067.state().selected;
          const tooltipSelectors = '[role="tooltip"],.tooltip,#v2-edge-tooltip,#control-tooltip';
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
        const dimensions = await captureJpeg(page, path.join(OUT, `${item.id}.jpg`), true);
        const firstAnchor = execution.zooms.find(zoom => zoom.anchorId);
        const detail = { anchorId: firstAnchor?.anchorId ?? null, anchorAtFit: firstAnchor?.anchorAtStart ?? null,
          wheelSteps: item.wheelSteps ?? null, zoom: measuredZoom.factor, zoomSource: measuredZoom.source,
          revealZoom: Number.isFinite(reveal?.zoom) ? reveal.zoom : null,
          cameraAtFit, cameraAtCapture, tooltipFallbackUsed };
        pageRecords.push(await saveRecord(page, item, execution, dimensions,
          { completeMs, densitySwitchMs: null, stableMs: ready.stableMs }, pageErrors, null, null, detail, fullscreenInfo));
      } finally {
        await context.close();
        for (const record of pageRecords) record.pageErrors = pageErrors.length;
      }
    };

    if (variants) {
      for (const variant of variants) {
        if (only && !only.has(variant.name)) continue;
        const baseItem = GALLERY.find(item => item.id === variant.base);
        const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, colorScheme: 'dark' });
        const page = await context.newPage();
        const pageErrors = [], pageRecords = [];
        page.on('pageerror', error => pageErrors.push(String(error.message ?? error)));
        page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
        try {
          const navigationStartedAt = Date.now();
          await page.goto(stateUrl(server.origin, baseItem.view), { waitUntil: 'load' });
          const completeMs = await waitForComplete(page, navigationStartedAt);
          await installCaptureStyle(page, true);
          await enterFullscreenAndFit(page, variant.name);
          await stableFullReadiness(page);
          const dimension = baseItem.view.rendering ?? '2d';
          const camera = await applyCameraProgram(page, variant.camera, dimension, variant.name);
          await page.mouse.move(-40, -40);
          await page.waitForTimeout(300);
          const ready = await stableFullReadiness(page);
          const fullscreenInfo = await assertFullscreenCapture(page, variant.name);
          const item = { ...baseItem, id: variant.name, title: variant.title };
          await assertCameraUnchanged(page, camera.after, variant.name);
          const dimensions = await captureJpeg(page, path.join(OUT, `${variant.name}.jpg`), true);
          pageRecords.push(await saveRecord(page, item, camera, dimensions,
            { completeMs, densitySwitchMs: null, stableMs: ready.stableMs }, pageErrors, null, null, null, fullscreenInfo));
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
          let camera = { recorded: await cameraSnapshot(page), restored: null };
          if (item.camera) {
            camera = await applyCameraProgram(page, item.camera, item.view.rendering ?? '2d', item.id);
            await page.mouse.move(-40, -40);
            await page.waitForTimeout(300);
            settled = await stableFullReadiness(page);
          }
          const fullscreenInfo = fullWindow ? await assertFullscreenCapture(page, item.id) : null;
          if (camera.restored === null) camera.restored = camera.recorded;
          if (item.camera) await assertCameraUnchanged(page, camera.after, item.id);
          const dimensions = await captureJpeg(page, path.join(OUT, `${item.id}.jpg`), false, item.fullPage === true);
          pageRecords.push(await saveRecord(page, item, camera, dimensions,
            { completeMs, densitySwitchMs: null, stableMs: settled.stableMs }, pageErrors, null, null, null, fullscreenInfo));
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
