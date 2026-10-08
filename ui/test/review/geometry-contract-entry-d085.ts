// D085-S1 BEGIN: production entry points bundled for the transition VM harness.
export { V2Page, GeometrySupersededError, projectionRefusalOf } from '../../src/review/v2-page.ts';
export { topologySupport, topologyRowState, setJuliaIndraLegibility, TOPOLOGY_IDS } from '../../src/topology/registry.ts';
export { createGeometryTransitionQueue, lawTopology, wireTopology, serializeGeometryView2, geometryToLegacyAxes } from '../../src/review/geometry-view2.ts';
export { normalizeAxesInput, resolveArrangementReadout } from '../../src/review/view-contract.ts';
export { normalizeDensity } from '../../src/review/lod.ts';
// D085-S1 END
