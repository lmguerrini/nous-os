// Capture the README gallery of the review page from the synthetic demo dataset.
//
//   node ui/tools/capture-gallery.mjs [--port 8776] [--dataset demo/out/reference/dataset] [--only id,id] [--out dir]
//
// Prerequisites, from the repository root: `npm --prefix ui ci`, `npm --prefix ui run build:review`, Playwright's Chromium
// (`npx --prefix ui playwright install chromium`) and the synthetic dataset
// (`node --experimental-strip-types demo/src/cli.ts synth --profile reference --seed 1 --out demo/out/reference`).
//
// Every item except `interface` hides page chrome and captures the full viewport after stable full readiness. Density pairs
// share a page session; detail items use real camera zoom in one session per morphology and projection.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
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
const OUT = path.resolve(ROOT, args.out ?? path.join('docs', 'assets', 'gallery'));
const VIEWPORT = { width: 1600, height: 1000 };
const DEVICE_SCALE_FACTOR = 2;
const GRAPH_OVERLAYS = '#focus-chip,#lab-notice,#notice,#toast,#fractal-canopy-explanation,#gizmo,[role=tooltip],.tooltip{visibility:hidden!important}';
const OVERLAYS = '#focus-chip,#lab-notice,#notice,#toast,#fractal-canopy-explanation,#gizmo,[role=tooltip],.tooltip,#review-toolbar,#details,#panel-edge-toggle,#fullscreen-bar,#fullscreen-legend,#selection-focus-controls,#graph-status-panel,#performance-overlay,#appearance-panel,#error{display:none!important;visibility:hidden!important}';
const FULL_WINDOW = `${OVERLAYS}\nhtml,body,#shell,#viewport,#render-root,.view-host{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important;background:#050505!important}`;

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
  { id: 'julia-3d-complete', title: 'Julia · 3D · Completa', view: { ...base, rendering: '3d', topology: 'julia' } },
  { id: 'neural-3d-brain', title: 'Neural · 3D · Completa · Cervello', view: { ...base, morphology: 'neural', brain: true, rendering: '3d', topology: 'natural' } },
  { id: 'mycelium-2d-complete', title: 'Mycelium · 2D · Completa', view: { ...base, morphology: 'mycelium', rendering: '2d', topology: 'natural' } },
  { id: 'exploratory-3d-complete', title: 'Esplorativa connections · 3D · Completa', view: { ...base, reading: 'exploratory', rendering: '3d', topology: 'natural' } },
  { id: 'natural-2d-essential', title: 'Natural · 2D · Essenziale', view: { ...base, density: 'essential', rendering: '2d', topology: 'natural' } },
  { id: 'natural-2d-balanced', title: 'Natural · 2D · Bilanciata', view: { ...base, density: 'balanced', rendering: '2d', topology: 'natural' } },
  { id: 'natural-stellar-2d-complete', title: 'Natural · Stellar · 2D · Completa', view: { ...base, rendering: '2d', topology: 'natural' }, paired: true },
  { id: 'natural-stellar-2d-balanced', title: 'Natural · Stellar · 2D · Bilanciata', view: { ...base, density: 'balanced', rendering: '2d', topology: 'natural' }, paired: true },
  { id: 'natural-stellar-3d-complete', title: 'Natural · Stellar · 3D · Completa', view: { ...base, rendering: '3d', topology: 'natural' }, paired: true },
  { id: 'natural-stellar-3d-balanced', title: 'Natural · Stellar · 3D · Bilanciata', view: { ...base, density: 'balanced', rendering: '3d', topology: 'natural' }, paired: true },
  { id: 'natural-stellar-2d-complete-zoom-mid', title: 'Natural · Stellar · 2D · Completa · intermediate zoom', view: { ...base, rendering: '2d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '2d', zoom: 'mid', wheelSteps: 3 },
  { id: 'natural-stellar-2d-complete-zoom-deep', title: 'Natural · Stellar · 2D · Completa · deep zoom', view: { ...base, rendering: '2d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '2d', zoom: 'deep', wheelSteps: 8 },
  { id: 'natural-stellar-3d-complete-zoom-mid', title: 'Natural · Stellar · 3D · Completa · intermediate zoom', view: { ...base, rendering: '3d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '3d', zoom: 'mid', wheelSteps: 22 },
  { id: 'natural-stellar-3d-complete-zoom-deep', title: 'Natural · Stellar · 3D · Completa · deep zoom', view: { ...base, rendering: '3d', topology: 'natural' }, detail: true, morphology: 'stellar', dimension: '3d', zoom: 'deep', wheelSteps: 26 },
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

async function fitAfterResize(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = window.__d067.fit();
    if (result && typeof result.then === 'function') await result;
  });
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
  const raw = await page.screenshot({ type: 'jpeg', quality: paired ? 90 : 85,
    scale: paired ? 'device' : 'css', ...(fullPage ? { fullPage: true } : {}) });
  await writeFile(file, raw);
  return inspectJpeg(await readFile(file), path.basename(file));
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(DATASET, 'manifest.json'), 'utf8'));
  let previousGallery = null;
  try { previousGallery = JSON.parse(await readFile(path.join(OUT, 'MANIFEST.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
  const unknown = only && [...only].filter(id => !GALLERY.some(item => item.id === id));
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
    const saveRecord = async (page, item, camera, dimensions, timings, pageErrors, state = null, pairRule = null, detail = null) => {
      const record = {
        id: item.id, title: item.title, file: `${item.id}.jpg`, view: item.view, state: state ?? await readState(page),
        completeMs: timings.completeMs, densitySwitchMs: timings.densitySwitchMs,
        stableMs: timings.stableMs, pageErrors: pageErrors.length, camera,
        width: dimensions.width, height: dimensions.height,
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
        await installCaptureStyle(page, true);
        const completeMs = await waitForComplete(page, navigationStartedAt);
        await fitAfterResize(page);
        const complete = await stableFullReadiness(page);
        const recordedCamera = await cameraSnapshot(page);
        if (!recordedCamera.state) throw new Error(`${full.id}: page did not expose cameraState()`);
        const pairRule = "same page session and orientation; each density framed by the page's fit()";
        const completeCapture = requested.includes(full) ? {
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
          { completeMs, densitySwitchMs: null, stableMs: complete.stableMs }, pageErrors, completeCapture.state, pairRule));
        if (requested.includes(balanced)) {
          const dimensions = await captureJpeg(page, path.join(OUT, `${balanced.id}.jpg`), true);
          pageRecords.push(await saveRecord(page, balanced, pairCamera, dimensions,
            { completeMs: null, densitySwitchMs, stableMs: balancedReady.stableMs }, pageErrors, null, pairRule));
        }
      } finally {
        await context.close();
        for (const record of pageRecords) record.pageErrors = pageErrors.length;
      }
    };

    const captureDetailSession = async (morphology, dimension) => {
      const items = GALLERY.filter(item => item.detail && item.morphology === morphology && item.dimension === dimension);
      const requested = items.filter(item => !only || only.has(item.id));
      if (!requested.length) return;
      const lastRequestedIndex = Math.max(...items.map((item, index) => requested.includes(item) ? index : -1));
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, colorScheme: 'dark' });
      const page = await context.newPage();
      const pageErrors = [], pageRecords = [];
      page.on('pageerror', error => pageErrors.push(String(error.message ?? error)));
      page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
      try {
        const navigationStartedAt = Date.now();
        await page.goto(stateUrl(server.origin, items[0].view), { waitUntil: 'load' });
        await installCaptureStyle(page, true);
        const completeMs = await waitForComplete(page, navigationStartedAt);
        await fitAfterResize(page);
        await stableFullReadiness(page);
        const cameraAtFit = await cameraSnapshot(page);
        const anchor = await page.evaluate(() => {
          const positions = window.__d067.witness()?.nodeViewport ?? {};
          const center = { x: innerWidth / 2, y: innerHeight / 2 };
          const candidates = Object.entries(positions).filter(([id, point]) => id.startsWith('domain:')
            && Number.isFinite(point?.x) && Number.isFinite(point?.y));
          candidates.sort(([idA, a], [idB, b]) => {
            const da = (a.x - center.x) ** 2 + (a.y - center.y) ** 2;
            const db = (b.x - center.x) ** 2 + (b.y - center.y) ** 2;
            return da - db || idA.localeCompare(idB);
          });
          return candidates[0] ? { id: candidates[0][0], position: { x: candidates[0][1].x, y: candidates[0][1].y } } : null;
        });
        if (!anchor) throw new Error(`${morphology} ${dimension}: no drawn domain: node is available as a zoom anchor`);

        for (let itemIndex = 0; itemIndex <= lastRequestedIndex; itemIndex++) {
          const item = items[itemIndex];
          for (let step = 0; step < item.wheelSteps; step++) {
            const point = await page.evaluate(id => window.__d067.witness()?.nodeViewport?.[id] ?? null, anchor.id);
            if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
              throw new Error(`${item.id}: zoom anchor ${anchor.id} is no longer drawn`);
            await page.mouse.move(point.x, point.y);
            await page.mouse.wheel(0, -100);
            await page.waitForTimeout(350);
          }
          if (!requested.includes(item)) continue;
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

          const cameraAtCapture = await cameraSnapshot(page);
          const reveal = await page.evaluate(() => window.__d074?.revealWitness?.() ?? null);
          let zoom, zoomSource;
          if (dimension === '2d') {
            const fitRatio = cameraAtFit.state?.ratio, currentRatio = cameraAtCapture.state?.ratio;
            if (!(fitRatio > 0) || !(currentRatio > 0)) throw new Error(`${item.id}: cannot compute zoom from 2D camera ratios`);
            zoom = fitRatio / currentRatio; zoomSource = 'cameraState ratio';
          } else {
            const distance = camera => {
              const p = camera?.pose?.position, t = camera?.pose?.target;
              return p?.length === 3 && t?.length === 3 ? Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]) : NaN;
            };
            const fitDistance = distance(cameraAtFit), currentDistance = distance(cameraAtCapture);
            if (!(fitDistance > 0) || !(currentDistance > 0)) throw new Error(`${item.id}: cannot compute zoom from 3D camera distance`);
            zoom = fitDistance / currentDistance; zoomSource = 'camera position-target distance';
          }
          const dimensions = await captureJpeg(page, path.join(OUT, `${item.id}.jpg`), true);
          const detail = { anchorId: anchor.id, anchorAtFit: anchor.position, wheelSteps: item.wheelSteps,
            zoom, zoomSource, revealZoom: Number.isFinite(reveal?.zoom) ? reveal.zoom : null,
            cameraAtFit, cameraAtCapture, tooltipFallbackUsed };
          pageRecords.push(await saveRecord(page, item, { recorded: cameraAtFit, restored: cameraAtCapture }, dimensions,
            { completeMs, densitySwitchMs: null, stableMs: ready.stableMs }, pageErrors, null, null, detail));
        }
      } finally {
        await context.close();
        for (const record of pageRecords) record.pageErrors = pageErrors.length;
      }
    };

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
        await installCaptureStyle(page, fullWindow);
        const completeMs = await waitForComplete(page, navigationStartedAt);
        if (fullWindow) await fitAfterResize(page);
        const settled = await stableFullReadiness(page);
        const camera = await cameraSnapshot(page);
        const dimensions = await captureJpeg(page, path.join(OUT, `${item.id}.jpg`), false, item.fullPage === true);
        pageRecords.push(await saveRecord(page, item, { recorded: camera, restored: camera }, dimensions,
          { completeMs, densitySwitchMs: null, stableMs: settled.stableMs }, pageErrors));
      } finally {
        await context.close();
        for (const record of pageRecords) record.pageErrors = pageErrors.length;
      }
    }
    const detailMorphologies = [...new Set(GALLERY.filter(item => item.detail).map(item => item.morphology))];
    for (const morphology of detailMorphologies) for (const dimension of ['2d', '3d'])
      await captureDetailSession(morphology, dimension);
  } finally {
    await browser.close();
    server.stop();
  }
  const capturedIds = new Set(records.map(record => record.id));
  const byId = new Map((previousGallery?.images ?? []).filter(record => !capturedIds.has(record.id)).map(record => [record.id, record]));
  for (const record of records) byId.set(record.id, record);
  const images = GALLERY.flatMap(item => byId.has(item.id) ? [byId.get(item.id)] : []);
  const knownIds = new Set(GALLERY.map(item => item.id));
  for (const [id, record] of byId) if (!knownIds.has(id)) images.push(record);
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
