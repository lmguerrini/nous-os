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
export const LULL_INDRA_3D_REFUSAL = 'Llull con Indra in 3D non è disponibile: la regola verificata assegna ai nove domini lettere e posizioni sul cerchio, ma non una terza coordinata ai nodi reali. Ruotare o estrudere il diagramma non rappresenterebbe una nuova operazione combinatoria. Usa Llull con Indra in 2D.';
const juliaIndraGate = new Map<TopologyDimension, boolean>();
// D085-S5 BEGIN: the selector and graph status share the evaluated gate record.
type JuliaGateMetric = Readonly<{ eligible: number; passing: number; share: number }>;
const juliaGateMetrics = new Map<TopologyDimension, JuliaGateMetric>();
export function juliaIndraGateStatus(dimension: TopologyDimension) {
  const metric = juliaGateMetrics.get(dimension);
  return { evaluated: metric !== undefined, ok: juliaIndraGate.get(dimension) === true,
    eligible: metric?.eligible ?? 0, passing: metric?.passing ?? 0, share: metric?.share ?? 0,
    reason: juliaIndraGate.get(dimension) === true ? null : JULIA_INDRA_REFUSAL };
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
  if (id === 'lull' && dimension === '3d' && indra) return { ok: false, reason: LULL_INDRA_3D_REFUSAL };
  if (id === 'julia' && indra && juliaIndraGate.get(dimension) !== true)
    return { ok: false, reason: JULIA_INDRA_REFUSAL };
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
