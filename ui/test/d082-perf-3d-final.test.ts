import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMorphologyGeometry, somaLobeAreaScale } from '../src/engine/morphology-geometry.ts';
import { DEFAULT_APPEARANCE } from '../src/engine/presentation-options.ts';
import { MORPHOLOGY_CONTRACT } from '../src/engine/morphology-contract.ts';
import { drawFlowLayer, neuralSomaFrames, readNeuralShapeCacheStats,
  somaOutlineRadiusAtAngle } from '../src/render-common/morphology-canvas.ts';
import { setFlowMotionAllowed, setFlowNow } from '../src/render-common/flow.ts';

test('3D Neural lobe normalization is one node-local constant across perspective poses', t => {
  const nodes = [{ id: 'hub', position: { x: 0, y: 0, z: 0 }, radius: 10 },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, radius: 4,
      position: { x: Math.cos(i * 0.7) * 20, y: Math.sin(i * 0.7) * 20,
        z: Math.sin(i * 1.7) * 16 } }))];
  const edges = nodes.slice(1).map((node, i) => ({ id: `e${i}`, source: 'hub', target: node.id, width: 1 }));
  const geometry = buildMorphologyGeometry('neural', nodes, edges);
  const style = { fieldColor: '#000', nodes: new Map(), edges: new Map() };
  const before = readNeuralShapeCacheStats();
  const scales = new Map<string, number>();
  let maximumErrorPx = 0;
  for (let pose = 0; pose < 80; pose++) {
    const yaw = pose * 0.075, pitch = Math.sin(pose * 0.18) * 0.6;
    const frames = neuralSomaFrames(geometry, point => {
      const x = point.x * Math.cos(yaw) - point.z * Math.sin(yaw);
      const z = point.x * Math.sin(yaw) + point.z * Math.cos(yaw);
      return { x: x * 2, y: (point.y * Math.cos(pitch) - z * Math.sin(pitch)) * 2, scale: 2 };
    }, style, MORPHOLOGY_CONTRACT.neural, DEFAULT_APPEARANCE, '3d');
    for (const [id, frame] of frames) {
      const first = scales.get(id);
      if (first === undefined) scales.set(id, frame.lobeAreaScale!);
      else assert.ok(Math.abs(frame.lobeAreaScale! - first) < 1e-12,
        'the planar parity path may differ at floating-point roundoff');
      const exact = somaLobeAreaScale(frame.lobes ?? [], angle =>
        somaOutlineRadiusAtAngle({ ...frame, lobes: [] }, angle));
      for (let sample = 0; sample < 64; sample++) {
        const angle = sample * Math.PI / 32;
        maximumErrorPx = Math.max(maximumErrorPx, Math.abs(
          somaOutlineRadiusAtAngle(frame, angle)
          - somaOutlineRadiusAtAngle({ ...frame, lobeAreaScale: exact }, angle)));
      }
    }
  }
  const after = readNeuralShapeCacheStats();
  assert.ok(after.lobeMisses - before.lobeMisses <= geometry.nodes.length * 2);
  assert.ok(after.lobeHits - before.lobeHits >= geometry.nodes.length * 78);
  t.diagnostic(`sampled 80-pose, 10-node approximation: maximum outline error ${maximumErrorPx.toFixed(4)} CSS px`);
  assert.ok(maximumErrorPx < 0.55);
});

test('the 3D flow overlay prepares only its selected visible edge paints', () => {
  const nodes = Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, radius: 3,
    position: { x: (i % 2) * 30 + (i % 20), y: Math.floor(i / 20) * 8, z: 0 } }));
  const edges = Array.from({ length: 200 }, (_, i) => ({ id: `e${String(i).padStart(3, '0')}`,
    source: `n${i * 2}`, target: `n${i * 2 + 1}`, width: 1 }));
  const geometry = buildMorphologyGeometry('stellar', nodes, edges);
  const style = { fieldColor: '#000', nodes: new Map(), edges: new Map(edges.map(edge =>
    [edge.id, { color: 'rgb(220, 220, 220)', presentation: {
      category: 'exploratory' as const, opacityPermille: 1000, widthPermille: 1000 } }] as const)) };
  let projections = 0, fills = 0;
  const project = (point: typeof nodes[number]['position']) => {
    projections++;
    return { x: point.x + 50, y: point.y + 50, scale: 1 };
  };
  const context = { canvas: { width: 600, height: 400,
    getBoundingClientRect: () => ({ width: 600, height: 400 }) },
    globalCompositeOperation: 'source-over', lineCap: 'butt', lineJoin: 'miter',
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() { fills++; },
    createLinearGradient() { return { addColorStop() {} }; },
  } as unknown as CanvasRenderingContext2D;
  try {
    setFlowMotionAllowed(true);
    // D086-F5 BEGIN: sample the D-079 long beam while its centre crosses these short edges.
    setFlowNow(500);
    // D086-F5 END
    drawFlowLayer(context, geometry, project, style,
      { ...DEFAULT_APPEARANCE, flowIntensity: 1, flowSpeed: 1 }, '3d');
    assert.equal(fills, 60);
    assert.ok(projections < 1200, `projected ${projections} points for a 60-edge flow budget`);
  } finally { setFlowMotionAllowed(false); }
});

test('flow priority prefix expands past clipped edges to keep 60 visible pulses', () => {
  const nodes = Array.from({ length: 340 }, (_, i) => ({ id: `n${i}`, radius: 3,
    position: { x: i < 200 ? -1000 + (i % 2) * 20 : 20 + (i % 2) * 20,
      y: (i % 20) * 10, z: 0 } }));
  const edges = Array.from({ length: 170 }, (_, i) => ({ id: `e${String(i).padStart(3, '0')}`,
    source: `n${i * 2}`, target: `n${i * 2 + 1}`, width: 1 }));
  const geometry = buildMorphologyGeometry('stellar', nodes, edges);
  const style = { fieldColor: '#000', nodes: new Map(), edges: new Map(edges.map(edge =>
    [edge.id, { color: 'rgb(220, 220, 220)', presentation: {
      category: 'exploratory' as const, opacityPermille: 1000, widthPermille: 1000 } }] as const)) };
  let fills = 0;
  const context = { canvas: { width: 600, height: 400,
    getBoundingClientRect: () => ({ width: 600, height: 400 }) },
    globalCompositeOperation: 'source-over', lineCap: 'butt', lineJoin: 'miter',
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() { fills++; },
    createLinearGradient() { return { addColorStop() {} }; },
  } as unknown as CanvasRenderingContext2D;
  try {
    setFlowMotionAllowed(true);
    // D086-F5 BEGIN: sample the D-079 long beam while its centre crosses these short edges.
    setFlowNow(500);
    // D086-F5 END
    drawFlowLayer(context, geometry, point => ({ x: point.x, y: point.y, scale: 1 }), style,
      { ...DEFAULT_APPEARANCE, flowIntensity: 1, flowSpeed: 1 }, '3d');
    assert.equal(fills, 60);
  } finally { setFlowMotionAllowed(false); }
});
