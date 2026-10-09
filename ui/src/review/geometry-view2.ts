/** Deterministic schema-2 Geometry Lab URL migration. The old view parser remains authoritative for v1. */
import { DEFAULT_AXES, parseSavedAxes } from './view-contract.ts';
import type { PageAxes } from './view-contract.ts';
import { normalizeDensity } from './lod.ts';
import type { Density } from './lod.ts';
import type { TopologyId, TopologySupport } from '../topology/contract.ts';
import { defaultNaturalArrangement } from '../projection/natural-bridge.ts';
// D086-CUSTOM BEGIN
import type { CustomAvailability, CustomCommitFact, CustomDensityIntent } from './custom-density-types.ts';
/** Validate the draft before a page task is enqueued. */
export function parseCustomDraft(raw: string, availability: CustomAvailability): number | null {
  if (!raw.trim() || availability.available <= 0 || availability.minimum > availability.available) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? Math.max(availability.minimum, Math.min(availability.available, value)) : null;
}
/** The pending object, not its amount, owns publication after an asynchronous mount. */
export function currentCustomCommit(intent: CustomDensityIntent, pending: CustomDensityIntent | null,
  result: CustomCommitFact | 'superseded'): result is CustomCommitFact {
  return pending === intent && result !== 'superseded' && result.committed;
}
// D086-CUSTOM END

// D085-S1 BEGIN: commit each requested geometry transition before the next reads its axes.
// A failed transition releases the lane while its own caller still receives the error.
export function createGeometryTransitionQueue(): { enqueue<T>(work: () => Promise<T>): Promise<T> } {
  let tail: Promise<void> = Promise.resolve();
  return { enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = tail.then(work);
    tail = task.then(() => {}, () => {});
    return task;
  } };
}
// D085-S1 END

export type Compatibility = 'd081-natural' | 'typed-natural-v1' | 'd081-indra-recursive' | 'indras-pearls-v1' | 'd081-canopy';
export type WireTopology = Exclude<TopologyId, 'lull'> | 'circular-combinatorial';
export const lawTopology = (id: WireTopology): TopologyId => id === 'circular-combinatorial' ? 'lull' : id;
export const wireTopology = (id: TopologyId): WireTopology => id === 'lull' ? 'circular-combinatorial' : id;
// D086-CUSTOM BEGIN: Custom is a portable view choice; the legacy LOD table stays three-state.
export type ViewDensity = Density | 'custom';
export type GeometryView2 = Readonly<{ schema: 2; rendering: '2d' | '3d'; topology: WireTopology; indra: 'off' | 'on';
  morphology: PageAxes['morphology']; density: ViewDensity; customNodes?: number; reading: PageAxes['reading']; colour: PageAxes['colour'];
  labels: boolean; brain?: boolean; naturalArrangement?: NonNullable<PageAxes['arrangement']>;
  compatibility?: Compatibility; suspendedIntent?: 'fractal' | 'holographic' }>;
export type LegacyHolographicView2 = Readonly<{ schema: 2; mode: 'legacy-holographic'; rendering: '2d' | '3d';
  morphology: PageAxes['morphology']; density: Density; customNodes?: number; reading: PageAxes['reading']; colour: PageAxes['colour'];
  labels: boolean; brain?: boolean; experimental: true }>;
export type SavedGeometryView2 = GeometryView2 | LegacyHolographicView2;
export type ResolvedGeometryView2 = Readonly<{ value: SavedGeometryView2; source: 'query-view2' | 'hash-view2' | 'query-view' | 'hash-view' | 'storage' | 'default'; error?: string }>;
// D086-CUSTOM END
// D082-LAB-FIX4 BEGIN
export type SupportedGeometryView2 = Readonly<{ value: SavedGeometryView2; notice?: string }>;

/** Resolve an unsupported portable combination to the closest supported saved view. */
export function resolveSupportedGeometryView2(value: SavedGeometryView2,
  supports: (topology: TopologyId, dimension: '2d' | '3d', indra: boolean) => TopologySupport): SupportedGeometryView2 {
  if ('mode' in value) return { value };
  const topology = lawTopology(value.topology);
  const indra = value.indra === 'on';
  if (supports(topology, value.rendering, indra).ok) return { value };

  const otherDimension = value.rendering === '3d' ? '2d' : '3d';
  if (supports(topology, otherDimension, indra).ok) {
    return { value: { ...value, rendering: otherDimension },
      notice: `${topology} non supporta ${value.rendering.toUpperCase()}: caricata la vista ${otherDimension.toUpperCase()} per mantenere la topologia.` };
  }
  if (indra && supports(topology, value.rendering, false).ok) {
    return { value: { ...value, indra: 'off' },
      notice: `${topology} non supporta Indra in ${value.rendering.toUpperCase()}: caricata la topologia senza Indra.` };
  }
  return { value: { ...value, rendering: '2d', topology: 'natural', indra: 'off', compatibility: 'd081-natural' },
    notice: `${topology} non è supportata in questa composizione: caricata Natural 2D.` };
}
// D082-LAB-FIX4 END
const TOPOLOGIES: readonly WireTopology[] = ['natural', 'canopy-ifs', 'julia', 'sierpinski', 'circular-combinatorial'];
const COMPATIBILITIES: readonly Compatibility[] = ['d081-natural', 'typed-natural-v1', 'd081-indra-recursive', 'indras-pearls-v1', 'd081-canopy'];
const COLOURS = ['bw','warm','earth','gems','night','semantic','amber','old-gold','ochre','copper','alchemical-red','warm-twilight','sepia','brace','miele','custom','stellar-cold','stellar-warm'];
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function vocabulary(value: unknown, choices: readonly string[], key: string): void {
  if (typeof value !== 'string' || !choices.includes(value)) throw new TypeError(`view2.${key} fuori vocabolario`);
}
export function parseGeometryView2(raw: string): SavedGeometryView2 {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('view2 deve essere un oggetto');
  const r = value as Record<string, unknown>;
  if (r.schema !== 2) throw new TypeError('view2.schema deve essere 2');
  const analytical = r.mode === 'legacy-holographic';
  const allowed = new Set(analytical
    ? ['schema','mode','rendering','morphology','density','customNodes','reading','colour','labels','brain','experimental']
    : ['schema','rendering','topology','indra','morphology','density','customNodes','reading','colour','labels','brain','naturalArrangement','compatibility','suspendedIntent']);
  for (const key of Object.keys(r)) if (!allowed.has(key)) throw new TypeError(`view2.${key} sconosciuto`);
  vocabulary(r.rendering, ['2d','3d'], 'rendering');
  vocabulary(r.morphology, ['stellar','neural','mycelium'], 'morphology');
  // D086-CUSTOM BEGIN
  vocabulary(r.density, analytical ? ['essential','balanced','complete'] : ['essential','balanced','complete','custom'], 'density');
  if (own(r, 'customNodes') && (!Number.isSafeInteger(r.customNodes) || (r.customNodes as number) <= 0))
    throw new TypeError('view2.customNodes deve essere un intero positivo sicuro');
  // D086-CUSTOM END
  vocabulary(r.reading, ['attested','exploratory','combined'], 'reading');
  vocabulary(r.colour, COLOURS, 'colour');
  if (typeof r.labels !== 'boolean') throw new TypeError('view2.labels deve essere booleano');
  if (own(r,'brain') && typeof r.brain !== 'boolean') throw new TypeError('view2.brain deve essere booleano');
  if (analytical) {
    if (r.experimental !== true) throw new TypeError('Holographic richiede experimental:true');
    return r as LegacyHolographicView2;
  }
  if (own(r,'mode')) throw new TypeError('view2.mode sconosciuto');
  vocabulary(r.topology, TOPOLOGIES, 'topology');
  vocabulary(r.indra, ['off','on'], 'indra');
  if (own(r,'naturalArrangement')) vocabulary(r.naturalArrangement, ['constellation','network','mycelium'], 'naturalArrangement');
  if (r.topology !== 'natural' && own(r,'naturalArrangement')) throw new TypeError('naturalArrangement richiede Natural');
  if (own(r,'compatibility')) vocabulary(r.compatibility, COMPATIBILITIES, 'compatibility');
  if (r.compatibility === 'd081-natural' || r.compatibility === 'typed-natural-v1') {
    if (r.topology !== 'natural' || r.indra !== 'off') throw new TypeError('view2.compatibility incoerente');
  } else if (r.compatibility === 'd081-indra-recursive' || r.compatibility === 'indras-pearls-v1') {
    if (r.topology !== 'natural' || r.indra !== 'on') throw new TypeError('view2.compatibility incoerente');
  } else if (r.compatibility === 'd081-canopy' && (r.topology !== 'canopy-ifs' || r.indra !== 'off'))
    throw new TypeError('view2.compatibility incoerente');
  if (own(r,'suspendedIntent')) vocabulary(r.suspendedIntent, ['fractal','holographic'], 'suspendedIntent');
  if (r.suspendedIntent && (r.topology !== 'natural' || r.indra !== 'off')) throw new TypeError('suspendedIntent richiede Natural/OFF');
  if (r.topology === 'natural' && r.indra === 'off' && !own(r,'naturalArrangement'))
    return { ...r, naturalArrangement: defaultNaturalArrangement(r.morphology as PageAxes['morphology']) } as GeometryView2;
  return r as GeometryView2;
}
export function serializeGeometryView2(value: SavedGeometryView2): string {
  const v = parseGeometryView2(JSON.stringify(value));
  if ('mode' in v) return JSON.stringify({ schema: 2, mode: v.mode, rendering: v.rendering, morphology: v.morphology,
    density: v.density, ...(v.customNodes !== undefined ? { customNodes: v.customNodes } : {}), reading: v.reading, colour: v.colour, labels: v.labels,
    ...(v.brain !== undefined ? { brain: v.brain } : {}), experimental: true });
  return JSON.stringify({ schema: 2, rendering: v.rendering, topology: v.topology, indra: v.indra,
    morphology: v.morphology, density: v.density, ...(v.customNodes !== undefined ? { customNodes: v.customNodes } : {}), reading: v.reading, colour: v.colour, labels: v.labels,
    ...(v.brain !== undefined ? { brain: v.brain } : {}),
    ...(v.naturalArrangement !== undefined ? { naturalArrangement: v.naturalArrangement } : {}),
    ...(v.compatibility !== undefined ? { compatibility: v.compatibility } : {}),
    ...(v.suspendedIntent !== undefined ? { suspendedIntent: v.suspendedIntent } : {}) });
}
export function migrateLegacyView(raw: string, density: Density, search = '', hash = ''): SavedGeometryView2 {
  // D082-B2 BEGIN: old URL bookmarks may omit default axes. Complete only registered
  // fields here, then let the pinned v1 parser reject unknown fields and bad values.
  // The saved-axes parser itself remains strict for stored records and other callers.
  const input: unknown = JSON.parse(raw);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Saved axes must be an object');
  const axes = parseSavedAxes(JSON.stringify({ ...DEFAULT_AXES, ...input }));
  // D082-B2 END
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const flags = new Set([...((query.get('experimental') ?? '').split(',')), ...((fragment.get('experimental') ?? '').split(','))]);
  const typed = query.get('projection') === 'natural' || fragment.get('projection') === 'natural';
  const pearls = fragment.get('indra') === 'pearls' && flags.has('indra-pearls');
  if (axes.organization === 'holographic' && flags.has('holographic')) return {
    schema: 2, mode: 'legacy-holographic', rendering: axes.projection, morphology: axes.morphology,
    density, reading: axes.reading, colour: axes.colour, labels: axes.labels,
    ...(axes.brain !== undefined ? { brain: axes.brain } : {}), experimental: true,
  };
  const suspendedIntent = axes.organization === 'fractal' && !flags.has('fractal') ? 'fractal'
    : axes.organization === 'holographic' ? 'holographic' : undefined;
  const topology: TopologyId = axes.organization === 'fractal' && flags.has('fractal') ? 'canopy-ifs' : 'natural';
  const indra = axes.organization === 'indra' ? 'on' : 'off';
  const compatibility: Compatibility = topology === 'canopy-ifs' ? 'd081-canopy'
    : indra === 'on' ? pearls ? 'indras-pearls-v1' : 'd081-indra-recursive'
    : typed ? 'typed-natural-v1' : 'd081-natural';
  return { schema: 2, rendering: axes.projection, topology, indra, morphology: axes.morphology,
    density, reading: axes.reading, colour: axes.colour, labels: axes.labels,
    ...(axes.brain !== undefined ? { brain: axes.brain } : {}),
    ...(topology === 'natural' && indra === 'off'
      ? { naturalArrangement: axes.arrangement ?? defaultNaturalArrangement(axes.morphology) } : {}),
    compatibility, ...(suspendedIntent ? { suspendedIntent } : {}) };
}
export function defaultGeometryView2(density: ViewDensity = 'balanced'): GeometryView2 {
  return { schema: 2, rendering: '2d', topology: 'natural', indra: 'off', morphology: 'stellar',
    density, reading: 'attested', colour: 'bw', labels: true, naturalArrangement: 'constellation',
    compatibility: 'd081-natural' };
}
export function resolveGeometryView2(search: string, hash: string, storedView: string | null, storedDensity: string | null): ResolvedGeometryView2 {
  const query = new URLSearchParams(search), fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  // D086-CUSTOM BEGIN: the legacy density key is a fallback even when no view record survives.
  const density: ViewDensity = storedDensity === 'custom' ? 'custom' : normalizeDensity(storedDensity);
  // D086-CUSTOM END
  // D086-CUSTOM BEGIN: an explicit URL amount wins; an omitted amount inherits the last saved choice.
  let storedCustomNodes: number | undefined;
  if (storedView) {
    try {
      const saved = parseGeometryView2(storedView);
      storedCustomNodes = saved.customNodes;
    } catch { /* a bad saved view cannot invalidate a valid URL */ }
  }
  const inheritCustomNodes = (value: SavedGeometryView2): SavedGeometryView2 =>
    value.customNodes === undefined && storedCustomNodes !== undefined
      ? { ...value, customNodes: storedCustomNodes } : value;
  for (const [source, raw] of [['query-view2',query.get('view2')],['hash-view2',fragment.get('view2')]] as const) {
    if (raw !== null) {
      try { return { value: inheritCustomNodes(parseGeometryView2(raw)), source }; }
      catch (error) { return { value: defaultGeometryView2(density), source, error: String(error) }; }
    }
  }
  for (const [source, raw] of [['query-view',query.get('view')],['hash-view',fragment.get('view')],['storage',storedView]] as const) {
    if (raw !== null) {
      try { return { value: inheritCustomNodes(source === 'storage' && JSON.parse(raw)?.schema === 2
        ? parseGeometryView2(raw) : migrateLegacyView(raw, density === 'custom' ? 'balanced' : density, search, hash)), source }; }
      catch (error) { return { value: defaultGeometryView2(density), source, error: String(error) }; }
    }
  }
  return { value: defaultGeometryView2(density), source: 'default' };
  // D086-CUSTOM END
}
export function geometryToLegacyAxes(value: SavedGeometryView2): PageAxes {
  // D085-S5 BEGIN: a Lab law keeps Indra's approved shell renderer when Indra is on.
  const organization = 'mode' in value ? 'holographic' : value.topology === 'canopy-ifs' && value.indra === 'off' ? 'fractal' :
    value.indra === 'on' ? 'indra' : 'natural';
  // D085-S5 END
  return { projection: value.rendering, morphology: value.morphology, organization,
    colour: value.colour, labels: value.labels, reading: value.reading,
    ...(value.brain !== undefined ? { brain: value.brain } : {}),
    ...(organization === 'natural' ? { arrangement: 'mode' in value ? DEFAULT_AXES.arrangement : value.naturalArrangement } : {}) };
}
/** Rewrites only view/view2; URLSearchParams retains unrelated repeated key values and order. */
export function rewriteGeometryUrl(search: string, hash: string, value: SavedGeometryView2): { search: string; hash: string } {
  const q = new URLSearchParams(search), h = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  q.delete('view'); h.delete('view'); q.delete('view2'); h.delete('view2');
  h.append('view2', serializeGeometryView2(value));
  return { search: q.toString() ? `?${q}` : '', hash: `#${h}` };
}
