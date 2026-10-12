import { maxOf } from '#render-common/array-aggregation.ts';
import { CANOPY_RATIO, CANOPY_TURN, CANOPY_SPATIAL_TILT, CANOPY_VERSION,
  CANOPY_SPATIAL_DISPLAY_ROTATION, CANOPY_SPATIAL_DISPLAY_SCALE,
  canopySpatialDisplayPoint, canopySpatialRotation, type CanopyLayout,
  type CanopyInputNode, type CanopyMatrix3 } from './canopy-layout.ts';
import type { GraphEdge } from '../review/graph-v2.ts';

export type CanopyCertificate = Readonly<{
  construction: 'contracting-binary-similarities';
  ratio: number; turnDegrees: number; rootCount: number; addressUnique: boolean;
  bounded: boolean; deterministicDigest: string; structuralEdges: number; attestedEdges: number;
  exploratoryEdges: number; crossDomainStructural: number; crossDomainAttested: number; crossDomainExploratory: number;
  sourceEdgeAccounting: boolean; sourceNodeAccounting: boolean; limitation: string;
  spatial: Readonly<{ maps: 'S±(x)=0.64 R±(x+e)'; e: readonly [0, -1, 0];
    tiltDegrees: number; orthogonalityResidual: number; orthogonal: boolean;
    displayScale: number; displayOrthogonalityResidual: number;
    contraction: number; contractive: boolean; uniqueCompactAttractor: boolean;
    addressBitDepth: boolean; finiteIterates: boolean; maxCoordinateResidual: number;
    maxFiniteNormExcess: number; tailBoundFormula: '0.64^(n+1)/(1-0.64)' }>;
}>;

/** Unit-frame remainder after n consumed address bits, before the 485 display scale. */
export function canopySpatialTailBound(depth: number): number {
  if (!Number.isSafeInteger(depth) || depth < 0) throw new RangeError('Canopy address depth must be nonnegative');
  return CANOPY_RATIO ** (depth + 1) / (1 - CANOPY_RATIO);
}

export type CanopySpatialDisplacement = Readonly<{
  referenceOrbit: 'x=.866x-.5z; y=.9y+.2z'; count: number; pixelsPerUnit: number;
  fitScale: number; fitRotationDegrees: number; rmsPixels: number; maxPixels: number;
  fixedCameraRmsPixels: number; fixedCameraMaxPixels: number;
  rmsByLevelPixels: Readonly<Record<number, number>>;
}>;

/** Deterministic screen-plane diagnostic against the D-081 alternating-torsion view.
 * The orbit follows the D-081 3D test camera; a single weighted 2D similarity is
 * fitted over all real IDs. Browser capture is still needed for visual acceptance. */
export function compareCanopySpatialProjection(layout: CanopyLayout,
  pixelsPerUnit = 0.17): CanopySpatialDisplacement {
  if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0)
    throw new RangeError('Canopy pixel scale must be positive');
  const project = (x: number, y: number, z: number): readonly [number, number] =>
    [x * 0.866 - z * 0.5, y * 0.9 + z * 0.2];
  const rows = [...layout.positions.values()].map(row => {
    let step = 485, z = 0;
    for (let depth = 0; depth < row.address.length; depth++) {
      step *= CANOPY_RATIO;
      z -= (row.address[depth] === '0' ? -1 : 1) * step * 1.15
        * (depth % 2 === 0 ? 1 : -0.72);
    }
    return { level: row.level,
      source: project(row.point3d.x, row.point3d.y, row.point3d.z),
      target: project(row.point.x, row.point.y * 1.5, z) };
  });
  let weightSum = 0, sx = 0, sy = 0, tx = 0, ty = 0;
  const weight = (level: number) => level <= 1 ? 4 : level === 2 ? 3 : level === 3 ? 2 : 1;
  for (const row of rows) {
    const w = weight(row.level);
    weightSum += w; sx += w * row.source[0]; sy += w * row.source[1];
    tx += w * row.target[0]; ty += w * row.target[1];
  }
  sx /= weightSum || 1; sy /= weightSum || 1;
  tx /= weightSum || 1; ty /= weightSum || 1;
  let real = 0, imaginary = 0, denominator = 0;
  for (const row of rows) {
    const w = weight(row.level), x = row.source[0] - sx, y = row.source[1] - sy;
    const u = row.target[0] - tx, v = row.target[1] - ty;
    real += w * (x * u + y * v);
    imaginary += w * (x * v - y * u);
    denominator += w * (x * x + y * y);
  }
  real /= denominator || 1; imaginary /= denominator || 1;
  let squared = 0, maximum = 0, fixedSquared = 0, fixedMaximum = 0;
  const byLevel = new Map<number, { squared: number; count: number }>();
  for (const row of rows) {
    const x = row.source[0] - sx, y = row.source[1] - sy;
    const u = row.target[0] - tx, v = row.target[1] - ty;
    const distance = Math.hypot(real * x - imaginary * y - u,
      imaginary * x + real * y - v) * pixelsPerUnit;
    const fixedDistance = Math.hypot(x - u, y - v) * pixelsPerUnit;
    squared += distance * distance; maximum = Math.max(maximum, distance);
    fixedSquared += fixedDistance * fixedDistance;
    fixedMaximum = Math.max(fixedMaximum, fixedDistance);
    const level = byLevel.get(row.level) ?? { squared: 0, count: 0 };
    level.squared += distance * distance; level.count++;
    byLevel.set(row.level, level);
  }
  return { referenceOrbit: 'x=.866x-.5z; y=.9y+.2z', count: rows.length,
    pixelsPerUnit, fitScale: Math.hypot(real, imaginary),
    fitRotationDegrees: Math.atan2(imaginary, real) * 180 / Math.PI,
    rmsPixels: Math.sqrt(squared / (rows.length || 1)), maxPixels: maximum,
    fixedCameraRmsPixels: Math.sqrt(fixedSquared / (rows.length || 1)),
    fixedCameraMaxPixels: fixedMaximum,
    rmsByLevelPixels: Object.fromEntries([...byLevel].map(([level, value]) =>
      [level, Math.sqrt(value.squared / value.count)])) };
}

function orthogonalityResidual(matrix: CanopyMatrix3): number {
  let maximum = 0;
  for (let colA = 0; colA < 3; colA++) for (let colB = 0; colB < 3; colB++) {
    let dot = 0;
    for (let row = 0; row < 3; row++) dot += matrix[row * 3 + colA]! * matrix[row * 3 + colB]!;
    maximum = Math.max(maximum, Math.abs(dot - Number(colA === colB)));
  }
  return maximum;
}

function spatialPoint(address: string): readonly [number, number, number] {
  // Evaluate S_{b1}∘...∘S_{bn}(0) as a growing sum of rotated unit stems.
  let basis: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let x = 0, y = 0, z = 0, step = 1;
  for (const bit of address) {
    const rotation = canopySpatialRotation(bit as '0' | '1');
    const next = Array<number>(9);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++)
      next[row * 3 + col] = basis[row * 3]! * rotation[col]!
        + basis[row * 3 + 1]! * rotation[3 + col]!
        + basis[row * 3 + 2]! * rotation[6 + col]!;
    basis = next;
    step *= CANOPY_RATIO;
    x -= step * basis[1]!; y -= step * basis[4]!; z -= step * basis[7]!;
  }
  return [x, y, z];
}

/** This proves properties of the separate IFS canopy, not a conjugacy to F_c or a ray certificate. */
export function certifyCanopy(layout: CanopyLayout, nodes: readonly CanopyInputNode[],
  edges: readonly GraphEdge[]): CanopyCertificate {
  const addresses = [...layout.positions.values()].map(node => node.address);
  const sourceIds = new Set(layout.relationBundles.flatMap(bundle => bundle.sourceEdgeIds));
  const inputIds = new Set(edges.map(edge => edge.id));
  const rotations = [canopySpatialRotation('0'), canopySpatialRotation('1')];
  const orthogonality = maxOf(rotations.map(orthogonalityResidual));
  const displayOrthogonality = orthogonalityResidual(CANOPY_SPATIAL_DISPLAY_ROTATION);
  const origin = layout.rails.find(rail => rail.address === 'root')?.to3d;
  let coordinateResidual = 0, finiteNormExcess = 0;
  let addressBitDepth = true;
  for (const row of layout.positions.values()) {
    const address = row.address;
    const parentAddress = row.parentId === null ? '' : layout.positions.get(row.parentId)?.address;
    if (!/^[01]+$/.test(address) || parentAddress === undefined ||
      !address.startsWith(parentAddress) || address.length <= parentAddress.length) addressBitDepth = false;
    const expected = spatialPoint(address);
    const display = canopySpatialDisplayPoint({ x: expected[0], y: expected[1], z: expected[2] });
    const actual = origin ? [(row.point3d.x - origin.x) / 485,
      (row.point3d.y - origin.y) / 485, (row.point3d.z - origin.z) / 485] : [Infinity, Infinity, Infinity];
    coordinateResidual = Math.max(coordinateResidual,
      Math.hypot(display.x - actual[0]!, display.y - actual[1]!, display.z - actual[2]!));
    const finiteNormLimit = CANOPY_RATIO * (1 - CANOPY_RATIO ** address.length) / (1 - CANOPY_RATIO);
    finiteNormExcess = Math.max(finiteNormExcess, Math.hypot(...expected) - finiteNormLimit);
  }
  const finiteIterates = Number.isFinite(coordinateResidual) && coordinateResidual < 1e-10
    && finiteNormExcess < 1e-10;
  const finite = [...layout.positions.values()].every(node =>
    [node.point.x, node.point.y, node.point.z, node.point3d.x, node.point3d.y, node.point3d.z].every(Number.isFinite) &&
    Math.max(Math.abs(node.point.x), Math.abs(node.point.y), Math.abs(node.point.z),
      Math.abs(node.point3d.x), Math.abs(node.point3d.y), Math.abs(node.point3d.z)) < 2000);
  const sourceNodeAccounting = layout.positions.size === nodes.length &&
    new Set(nodes.map(node => node.id)).size === nodes.length &&
    nodes.every(node => layout.positions.has(node.id));
  const spatialValid = orthogonality < 1e-12 && displayOrthogonality < 1e-12
    && CANOPY_SPATIAL_DISPLAY_SCALE > 0 && CANOPY_RATIO > 0 && CANOPY_RATIO < 1
    && addressBitDepth && finiteIterates;
  return { construction: 'contracting-binary-similarities', ratio: CANOPY_RATIO,
    turnDegrees: CANOPY_TURN * 180 / Math.PI, rootCount: nodes.filter(node => node.parent === null).length,
    addressUnique: sourceNodeAccounting && addressBitDepth && new Set(addresses).size === nodes.length,
    bounded: finite && spatialValid, deterministicDigest: `${CANOPY_VERSION}:${layout.digest}`,
    structuralEdges: edges.filter(edge => edge.type === 'classified_in').length,
    attestedEdges: edges.filter(edge => edge.type !== 'classified_in' && edge.class === 'attested').length,
    exploratoryEdges: edges.filter(edge => edge.class === 'exploratory').length,
    crossDomainStructural: layout.structuralCrossDomain,
    crossDomainAttested: layout.crossDomain.attested,
    crossDomainExploratory: layout.crossDomain.exploratory,
    sourceEdgeAccounting: inputIds.size === edges.length && sourceIds.size === inputIds.size &&
      [...inputIds].every(id => sourceIds.has(id)),
    sourceNodeAccounting,
    spatial: { maps: 'S±(x)=0.64 R±(x+e)', e: [0, -1, 0],
      tiltDegrees: CANOPY_SPATIAL_TILT * 180 / Math.PI,
      orthogonalityResidual: orthogonality, orthogonal: orthogonality < 1e-12,
      displayScale: CANOPY_SPATIAL_DISPLAY_SCALE,
      displayOrthogonalityResidual: displayOrthogonality,
      contraction: CANOPY_RATIO, contractive: CANOPY_RATIO > 0 && CANOPY_RATIO < 1,
      uniqueCompactAttractor: orthogonality < 1e-12 && CANOPY_RATIO > 0 && CANOPY_RATIO < 1,
      addressBitDepth, finiteIterates, maxCoordinateResidual: coordinateResidual,
      maxFiniteNormExcess: finiteNormExcess, tailBoundFormula: '0.64^(n+1)/(1-0.64)' },
    limitation: 'Le similitudini euclidee 2D e 3D del canopy sono separate da F_c. Gli endpoint degli indirizzi finiti approssimano il compatto attrattore, senza attestare appartenenza esatta. Nessun certificato dei raggi inversi di F_c è rivendicato.',
  };
}
