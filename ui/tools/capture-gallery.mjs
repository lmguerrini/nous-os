// Capture the README gallery of the review page from the synthetic demo dataset.
//
//   node ui/tools/capture-gallery.mjs [--port 8776] [--dataset demo/out/reference/dataset] [--only id,id]
//
// Prerequisites, from the repository root: `npm --prefix ui ci`, `npm --prefix ui run build:review`, Playwright's Chromium
// (`npx --prefix ui playwright install chromium`) and the synthetic dataset
// (`node --experimental-strip-types demo/src/cli.ts synth --profile reference --seed 1 --out demo/out/reference`).
//
// Every image is a fresh page opened directly in its state, captured once the renderer reports «completa» and nothing it
// reports has changed for 1.5 s. Overlays that are not the graph are hidden and the animated exploratory beam is paused
// with the page's own «Movimento» switch, so a capture is repeatable. The graph-area crops exclude the toolbar and the side
// panel; `interface.jpg` keeps the whole page. The manifest records the conditions and the time each state took to complete.
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
const OUT = path.join(ROOT, 'docs', 'assets', 'gallery');
const VIEWPORT = { width: 1440, height: 1000 };
const DEVICE_SCALE_FACTOR = 2;
const GRAPH_AREA = { x: 0, y: 210, width: 1060, height: 780 };
const OVERLAYS = '#focus-chip,#lab-notice,#notice,#toast,#fractal-canopy-explanation,#gizmo,[role=tooltip],.tooltip{visibility:hidden!important}';

const base = { indra: 'off', morphology: 'stellar', density: 'balanced', reading: 'attested', colour: 'bw', labels: true, brain: false };
export const GALLERY = [
  { id: 'natural-2d', title: 'Natural · 2D', view: { ...base, rendering: '2d', topology: 'natural' } },
  { id: 'natural-3d-complete', title: 'Natural · 3D · Completa', view: { ...base, density: 'complete', rendering: '3d', topology: 'natural' } },
  { id: 'natural-indra-3d', title: 'Natural + Indra · 3D', view: { ...base, indra: 'on', rendering: '3d', topology: 'natural' } },
  { id: 'canopy-2d', title: 'Canopy · 2D', view: { ...base, rendering: '2d', topology: 'canopy-ifs' } },
  { id: 'canopy-indra-3d', title: 'Canopy + Indra · 3D', view: { ...base, indra: 'on', rendering: '3d', topology: 'canopy-ifs' } },
  { id: 'julia-2d', title: 'Julia · 2D', view: { ...base, rendering: '2d', topology: 'julia' } },
  { id: 'julia-indra-2d-complete', title: 'Julia + Indra atlas · 2D · Completa', view: { ...base, indra: 'on', density: 'complete', rendering: '2d', topology: 'julia' } },
  { id: 'sierpinski-2d', title: 'Sierpiński · 2D', view: { ...base, rendering: '2d', topology: 'sierpinski' } },
  { id: 'sierpinski-3d', title: 'Sierpiński · 3D', view: { ...base, rendering: '3d', topology: 'sierpinski' } },
  { id: 'llull-2d', title: 'Llull · 2D', view: { ...base, rendering: '2d', topology: 'circular-combinatorial' } },
  { id: 'llull-indra-3d-complete', title: 'Llull + Indra · 3D · Completa', view: { ...base, indra: 'on', density: 'complete', rendering: '3d', topology: 'circular-combinatorial' } },
  { id: 'neural-3d-brain', title: 'Neural · 3D · brain · Completa', view: { ...base, morphology: 'neural', density: 'complete', brain: true, rendering: '3d', topology: 'natural' } },
  { id: 'mycelium-2d-complete', title: 'Mycelium · 2D · Completa', view: { ...base, morphology: 'mycelium', density: 'complete', rendering: '2d', topology: 'natural' } },
  { id: 'exploratory-3d', title: 'Esplorativa connections · 3D · Completa', view: { ...base, density: 'complete', reading: 'exploratory', rendering: '3d', topology: 'natural' } },
  { id: 'palette-gems-2d', title: 'Palette Gemme · 2D', view: { ...base, colour: 'gems', rendering: '2d', topology: 'natural' } },
  { id: 'interface', title: 'The whole page: Natural · 3D', view: { ...base, rendering: '3d', topology: 'natural' }, fullPage: true },
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

// The renderer is done when its readiness says «completa» and nothing it reports has changed for 1.5 s.
async function settle(page, timeoutMs = 120000) {
  const t0 = Date.now(); let last = '', since = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(250);
    const key = await page.evaluate(() => {
      const r = window.__d082?.render?.(); const s = window.__d081?.status?.(); const c = window.__d067?.cameraState?.();
      const pose = window.__d067?.camera?.(); const w = window.__d067?.witness?.();
      return JSON.stringify([r?.view, r?.quality, r?.nodes?.drawn, r?.allEdges?.drawn, s?.edges?.drawn, s?.hint,
        c ? [c.x, c.y, c.ratio, c.angle].map(v => +Number(v ?? 0).toFixed(4)) : null,
        pose?.position && pose?.target ? [...pose.position, ...pose.target].map(v => +Number(v).toFixed(3)) : null,
        w?.taxonomy?.phase ?? null]);
    }).catch(() => '');
    let quality = null, phase = null; try { const a = JSON.parse(key); quality = a[1]; phase = a[8]; } catch {}
    if (key !== last) { last = key; since = Date.now(); }
    else if (Date.now() - since > 1500 && quality === 'completa' && (phase == null || phase === 'complete')) return Date.now() - t0 - 1500;
  }
  return -1;
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(DATASET, 'manifest.json'), 'utf8'));
  const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
  await mkdir(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu'] : [] });
  const browserVersion = browser.version();
  const records = [];
  try {
    for (const item of GALLERY.filter(g => !only || only.has(g.id))) {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, colorScheme: 'dark' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e.message ?? e)));
      const t0 = Date.now();
      await page.goto(stateUrl(server.origin, item.view), { waitUntil: 'load' });
      const settled = await settle(page);
      const completeMs = settled < 0 ? null : Date.now() - t0 - 1500;
      await page.evaluate(css => {
        const style = document.createElement('style'); style.textContent = css; document.head.append(style);
        const motion = document.getElementById('flow-motion');
        if (motion && motion.checked) { motion.checked = false; motion.dispatchEvent(new Event('change')); }
      }, OVERLAYS);
      await page.waitForTimeout(500);
      const file = path.join(OUT, `${item.id}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 82, scale: 'css', ...(item.fullPage ? {} : { clip: GRAPH_AREA }) });
      const state = await page.evaluate(() => {
        const r = window.__d082?.render?.(); const s = window.__d081?.status?.();
        return { view: r?.view ?? null, quality: r?.quality ?? null, nodesVisible: s?.nodes?.visible ?? null,
          nodesTotal: s?.nodes?.total ?? null, edgesDrawn: s?.edges?.drawn ?? null, edgesTotal: s?.edges?.total ?? null };
      });
      records.push({ id: item.id, title: item.title, file: `${item.id}.jpg`, view: item.view, state, completeMs, pageErrors: errors.length });
      console.log(`${item.id}: ${state.quality} in ${completeMs ?? 'timeout'} ms, ${state.nodesVisible}/${state.nodesTotal} nodes, ${errors.length} page errors`);
      await context.close();
    }
  } finally {
    await browser.close();
    server.stop();
  }
  await writeFile(path.join(OUT, 'MANIFEST.json'), JSON.stringify({
    schema: 'nousos-gallery/1', dataset: { generator: 'demo/src/cli.ts synth --profile reference --seed 1', digest: manifest.digest },
    viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, graphArea: GRAPH_AREA, browser: `Chromium ${browserVersion}`,
    platform: `${os.platform()} ${os.arch()}`, images: records }, null, 2) + '\n');
}

await main();
