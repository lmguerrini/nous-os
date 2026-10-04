import type Sigma from 'sigma';

export type RelationMaterialBinding = {
  readonly relationId: string;
  readonly materialTypes: readonly string[];
};

export type RenderRelationGeometryWitness = {
  readonly relationId: string;
  readonly controlPoint: { readonly x: number; readonly y: number };
};

export type LiveRelationMaterialBindings = {
  observe(sigma: Sigma): void;
  record(fingerprint: number, materialType: string): void;
  materialTypesFor(sigma: Sigma, relationId: string): readonly string[];
};

export type LiveRelationGeometryBindings = {
  observe(sigma: Sigma): void;
  record(fingerprint: number, controlPoint: { readonly x: number; readonly y: number }): void;
  controlPointFor(sigma: Sigma, relationId: string): { readonly x: number; readonly y: number } | undefined;
};

const versions = new WeakMap<Sigma, number>();
const cache = new WeakMap<Sigma, {
  graph: ReturnType<Sigma['getGraph']>;
  version: number;
  fingerprints: ReadonlyMap<string, number>;
}>();

function advanceVersion(sigma: Sigma): void {
  versions.set(sigma, (versions.get(sigma) ?? 0) + 1);
  cache.delete(sigma);
}

/** Sigma's processing index is node count + 1 + stable zIndex order. */
export function relationFingerprints(sigma: Sigma): ReadonlyMap<string, number> {
  const version = versions.get(sigma) ?? 0;
  const graph = sigma.getGraph();
  const cached = cache.get(sigma);
  if (cached?.graph === graph && cached.version === version) return cached.fingerprints;
  const ids = [...graph.edges()];
  if (sigma.getSetting('zIndex')) {
    const zIndexes = new Map(ids.map(id => {
      const data = sigma.getEdgeDisplayData(id);
      if (data === undefined) throw new TypeError('live relation fingerprint requires display data');
      return [id, data.zIndex] as const;
    }));
    ids.sort((left, right) => zIndexes.get(left)! - zIndexes.get(right)!);
  }
  const first = graph.nodes().length + 1;
  const fingerprints = new Map(ids.map((id, offset) => [id, first + offset]));
  cache.set(sigma, { graph, version, fingerprints });
  return fingerprints;
}

export function createLiveRelationMaterialBindings(): LiveRelationMaterialBindings {
  let recorded = new Map<number, string[]>();
  return {
    observe(sigma) {
      sigma.on('beforeProcess', () => { recorded = new Map(); advanceVersion(sigma); });
    },
    record(fingerprint, materialType) {
      const types = recorded.get(fingerprint) ?? [];
      types.push(materialType);
      recorded.set(fingerprint, types);
    },
    materialTypesFor(sigma, relationId) {
      const fingerprint = relationFingerprints(sigma).get(relationId);
      if (fingerprint === undefined) throw new TypeError(`live relation ${relationId} has no Sigma fingerprint`);
      return [...(recorded.get(fingerprint) ?? [])];
    },
  };
}

export function createLiveRelationGeometryBindings(): LiveRelationGeometryBindings {
  let recorded = new Map<number, { readonly x: number; readonly y: number }>();
  return {
    observe(sigma) { sigma.on('beforeProcess', () => { recorded = new Map(); }); },
    record(fingerprint, controlPoint) { recorded.set(fingerprint, controlPoint); },
    controlPointFor(sigma, relationId) {
      const fingerprint = relationFingerprints(sigma).get(relationId);
      if (fingerprint === undefined) throw new TypeError(`live relation ${relationId} has no Sigma fingerprint`);
      return recorded.get(fingerprint);
    },
  };
}

export function liveRelationMaterialBindings(sigma: Sigma, bindings: LiveRelationMaterialBindings): readonly RelationMaterialBinding[] {
  return [...sigma.getGraph().edges()].sort().map(relationId => {
    const materialTypes = bindings.materialTypesFor(sigma, relationId);
    if (materialTypes.length === 0) throw new TypeError(`live relation ${relationId} has no processed material program`);
    return { relationId, materialTypes };
  });
}

export function liveRelationGeometryWitnesses(sigma: Sigma, bindings: LiveRelationGeometryBindings): readonly RenderRelationGeometryWitness[] {
  return [...sigma.getGraph().edges()].sort().map(relationId => {
    const controlPoint = bindings.controlPointFor(sigma, relationId);
    if (controlPoint === undefined) throw new TypeError(`live relation ${relationId} has no processed control-point attributes`);
    const viewportControlPoint = sigma.framedGraphToViewport(controlPoint);
    return { relationId, controlPoint: { x: viewportControlPoint.x, y: viewportControlPoint.y } };
  });
}
