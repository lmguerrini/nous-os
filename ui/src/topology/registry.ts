/** Geometry Lab's layout-law register. Classic Natural and Canopy keep their verified routes. */
import type { TopologyDimension, TopologyId, TopologyLaw, TopologySupport } from './contract.ts';
import { juliaLaw } from './julia.ts';
import { sierpinskiLaw } from './sierpinski.ts';
import { lullLaw } from './lull.ts';
import { INDRA_COMPOSE_VERSION } from './indra-compose.ts';
import { canopyLaw } from './canopy-law.ts';

export const TOPOLOGY_LAWS: Readonly<Record<TopologyId, TopologyLaw | null>> = {
  natural: null, 'canopy-ifs': canopyLaw, julia: juliaLaw, sierpinski: sierpinskiLaw, lull: lullLaw,
};
export const TOPOLOGY_IDS: readonly TopologyId[] = ['natural', 'canopy-ifs', 'julia', 'sierpinski', 'lull'];
// D084-W3-LABELS BEGIN: short selector names plus the full mathematical classification.
/** The selector shows exactly these short names. The extended
 * technical names stay in TOPOLOGY_DESCRIPTIONS as explanation only. Natural is named
 * here; every lab law names itself, and Llull's name stays behind the law's verified name
 * gate (`lull.ts`: «Llull» while the verified nine-domain rule holds, else the fallback). */
const SELECTOR_LABELS: Readonly<Record<TopologyId, string>> = {
  natural: 'Natural', 'canopy-ifs': 'Canopy', julia: 'Julia', sierpinski: 'Sierpiński', lull: 'Llull',
};
/** Full names and classification, kept for tooltips, the legend and documentation.
 * Canopy is an IFS-generated fractal tree; Julia is a complex dynamical system and is
 * deliberately not classified primarily as an IFS (inverse iteration is a technique it
 * may use, not its family); Sierpiński is an affine IFS; Llull is a combinatorial
 * topology — not a fractal and not an IFS. The lab therefore states that it holds
 * topologies of different families instead of grouping them under «IFS» or «Fractal». */
export const TOPOLOGY_DESCRIPTIONS: Readonly<Record<TopologyId, string>> = {
  natural: 'Natural — disposizione classica della gerarchia primaria.',
  'canopy-ifs': 'Canopy — fractal tree generated through an Iterated Function System (IFS).',
  julia: 'Julia — complex dynamical system (not classified primarily as an IFS, even if it may use inverse iteration).',
  sierpinski: 'Sierpiński — affine Iterated Function System (2D: gasket triangolare; 3D: polvere di tetraedro).',
  lull: 'Llull — combinatorial topology governed by the verified Llullian nine-domain rule; not a fractal and not an IFS.',
};
/** The one container line: the lab holds mathematical topologies of different families. */
export const LAB_CONTAINER_DESCRIPTION =
  'Geometry Lab: topologie matematiche di famiglie differenti — sistemi di funzioni iterate (IFS), '
  + 'sistema dinamico complesso, topologia combinatoria; nessuna etichetta unica le raggruppa.';
// D085-S5 BEGIN: snapshot-derived Julia legibility refusals are shared by toolbar controls.
export const JULIA_INDRA_REFUSAL = 'Julia con Indra non è disponibile: alla scala adattata le perle non mostrano abbastanza figli reali separati e curve guida leggibili. Usa Julia senza Indra.';
// D086-F4 BEGIN: Llull 3D + Indra uses the verified full-snapshot class
// and primary-pearl composition; Julia has an independent legibility gate.
// D086-F4 END
const juliaIndraGate = new Map<TopologyDimension, boolean>();
// D085-S5 BEGIN: the selector and graph status share the evaluated gate record.
// D087-JULIA BEGIN
type JuliaGateMetric = Readonly<{ eligible: number; passing: number; share: number;
  snapshotDigest?: string; phase?: string; eligibleParents?: number;
  closedPearlsDrawn?: number; closedPearlsProjected?: number;
  openPassing?: number; openPassingProjected?: number; openEligible?: number;
  childSeparationMinPx?: number; insideGuideMaxPx?: number;
  shellOverlapCount?: number; focusedParent?: string | null }>;
// D087-JULIA END
const juliaGateMetrics = new Map<TopologyDimension, JuliaGateMetric>();
export function juliaIndraGateStatus(dimension: TopologyDimension) {
  const metric = juliaGateMetrics.get(dimension);
  return { evaluated: metric !== undefined, ok: juliaIndraGate.get(dimension) === true,
    eligible: metric?.eligible ?? 0, passing: metric?.passing ?? 0, share: metric?.share ?? 0,
    // D087-JULIA BEGIN
    ...(metric ?? {}),
    reason: juliaIndraGate.get(dimension) === true ? null : !metric
      ? 'Julia con Indra: verifica in corso.' : metric.phase
      ? `Julia con Indra rifiutata (${metric.phase}): ${metric.closedPearlsDrawn ?? metric.closedPearlsProjected ?? 0} perle, `
        + `${metric.openPassing ?? metric.openPassingProjected ?? 0}/${metric.openEligible ?? 0} carte aperte, `
        + `${metric.shellOverlapCount ?? 0} sovrapposizioni; separazione ${metric.childSeparationMinPx ?? 0} px, `
        + `guida ${metric.insideGuideMaxPx ?? 0} px.` : JULIA_INDRA_REFUSAL };
    // D087-JULIA END
}
export function setJuliaIndraLegibility(dimension: TopologyDimension, ok: boolean,
  metric?: JuliaGateMetric): void {
  juliaIndraGate.set(dimension, ok);
  if (metric) juliaGateMetrics.set(dimension, metric);
}
// D085-S5 END
// D085-S5 END
/** Dimension-specific technical note, kept as explanation next to the classification. */
function topologyNote(id: TopologyId, dimension: TopologyDimension): string {
  if (id === 'julia' && dimension === '3d')
    return ' In 3D la quota è il potenziale esterno G (sollevamento scalare), non un insieme di Julia 3D.';
  // D085-S4 BEGIN: the Llull 3D quota is the Third Figure's offset class —
  // a reversible combinatorial coordinate, never an extrusion of the 2D wheel.
  if (id === 'lull' && dimension === '3d')
    return ' In 3D la quota è la classe d’offset della Terza Figura (d = 1–4): le 36 coppie salgono a quattro tavole regolari e i record si sollevano della classe massima attestata dalle loro relazioni reali fra domini.';
  // D085-S4 END
  return '';
}
/** Selector-facing label: the short name only. Natural is classic; Canopy, Julia, Sierpiński
 * and Llull carry their short name in their law (Llull through its name gate). */
export function topologyLabel(id: TopologyId, dimension: TopologyDimension): string {
  if (id === 'natural') return SELECTOR_LABELS[id];
  return TOPOLOGY_LAWS[id]!.label(dimension);
}
/** Selector-facing tooltip: the full name with its classification sentence. */
export function topologyTooltip(id: TopologyId, dimension: TopologyDimension): string {
  return `${TOPOLOGY_DESCRIPTIONS[id]}${topologyNote(id, dimension)}`;
}
// D084-W3-LABELS END
export function topologySupport(id: TopologyId, dimension: TopologyDimension, indra: boolean): TopologySupport {
  // D085-S5 BEGIN
  // D086-F4 BEGIN: the verified full-snapshot class now composes with Indra.
  // Julia retains its separate legibility gate.
  // D086-F4 END
  if (id === 'julia' && indra && juliaIndraGate.get(dimension) !== true)
    // D087-JULIA BEGIN
    return { ok: false, reason: juliaIndraGateStatus(dimension).reason ?? JULIA_INDRA_REFUSAL };
    // D087-JULIA END
  // D085-S5 END
  if (id === 'natural') return { ok: true };
  const support = TOPOLOGY_LAWS[id]!.supports(dimension);
  if (!support.ok) return support;
  if (indra && String(INDRA_COMPOSE_VERSION) === 'stub-0')
    return { ok: false, reason: 'Composizione Indra in preparazione.' };
  return { ok: true };
}
export function topologyRowState(id: TopologyId, dimension: TopologyDimension, indra: boolean,
  selected: TopologyId | null): Readonly<{ label: string; disabled: boolean; reason: string | null; pressed: boolean }> {
  const support = topologySupport(id, dimension, indra);
  return { label: topologyLabel(id, dimension), disabled: !support.ok,
    reason: support.ok ? null : support.reason, pressed: id === selected };
}
