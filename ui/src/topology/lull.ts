/** Llull — combinatorial topology governed by the verified Llullian nine-domain rule;
 * not a fractal and not an IFS. Circular combinatorial layout law (D-082 P8, D-084).
 * Implements steps 2 and 5 of the Llull rule
 * on top of the inquiry model in `lull-inquiry.ts`: the nine letters of Figure A as
 * guides on the outer circle, communities in inner ring/sector bands, real records in
 * deeper bands, one pickable vertex per real ID, positions fixed from the full snapshot,
 * and a «Perché qui» witness for every node with the letter↔root mapping, sort keys,
 * ring/angle, real relation IDs and the historical limit. Chords are derived in
 * `lull-inquiry.ts` from real relations only; generated combinations never become edges.
 *
 * D084-LLULL BEGIN — ring policy `lull-rings-v2`:
 * - The nine real roots and their Figure A guides sit at exact 40° intervals on the
 *   outer circle (radius 940), B at -90° and B–K clockwise in codepoint root order.
 *   Each root owns the same 40° sector, less a narrow 0.018-radian boundary gap.
 *   Sector angles never depend on populations or the active density/reading.
 * - Communities (levels 2–3) occupy [760, 900] with separation 22; records
 *   (levels ≥ 4) occupy [250, 735] with separation 6.5. Both bands retain each
 *   root's equal sector. The centre inside radius 250 has no reference vertices;
 *   real chords may cross it. Distinct rings disclose hierarchy without moving
 *   a real ID between readings or densities.
 * - Each (band, sector) arc is a ladder of concentric arcs from the band's outer edge
 *   inward: radial step = slot separation, one slot every separation unit of arc,
 *   occupied slots centred around the letter's mid-angle on each ring. Community
 *   slots fill in the documented sort order with level
 *   first (communities outermost, their subgroups just inside), then primary-parent
 *   path, semantic kind, status, descending importance, codepoint ID.
 * - If a community ladder exhausts its band, overflow compresses onto a distinct
 *   inner arc inside the same community sector and annulus. Record overflow keeps
 *   its inward fallback (neither is reached on the reference snapshot).
 * Positions depend only on the full snapshot: densities choose subsets and shared IDs
 * never move between Essenziale, Bilanciata and Completa. `layoutFull` caches per
 * (snapshot digest, law version, dimension) as TOPOLOGY-CONTRACT requires.
 * D084-LLULL END
 *
 * D085-S4 (fix 2): the Figure A layer is completed by the Third Figure's 36 pair
 * compartments — one dashed structural chord per two-letter combination between the
 * nine real root vertices. They are guides, never relations: non-semantic, excluded
 * from every count, disclosed in the witness and the legend; the real relations stay
 * the only solid ink between vertices.
 *
 * D085-S4: semantic zoom over the same compartments. Each compartment
 * with real cross-domain evidence also emits one pair bundle — a non-semantic
 * guide whose weight is the exact number of real relations of that compartment
 * in the FULL snapshot — drawn at overview between its two root vertices (in 3D
 * at its offset-class table) and released into the individual real chords as the
 * camera closes in. Empty compartments draw no bundle. A translucent overview
 * veil over the record annulus lightens the record bands at distance; it never
 * removes a mark and fades to nothing on the same zoom curve. Bundles aggregate
 * existing relations, never new edges: `lull.generated-edges` stays 0. */
import type { GuideCurve, TopologyDimension, TopologyLayout, TopologyLaw, TopologyNode, TopologySnapshot, TopologyWitness } from './contract.ts';
import type { LayoutContainer, Point3 } from '../review/layout-v2.ts';
import type { LullIndex } from './lull-inquiry.ts';
import { LULL_LETTERS, LULL_SOURCE_CITATION, indexLullSnapshot } from './lull-inquiry.ts';

export const LULL_RING_POLICY_VERSION = 'lull-rings-v2';
/** Figure A outer circle: the nine letter guides and the nine root vertices. */
export const LULL_OUTER_RADIUS = 940;
export const LULL_BOUNDARY_GAP = 0.018;
/** Equal sectors reserve every root the same Figure A angle. */
export const LULL_BANDS = {
  root: { inner: LULL_OUTER_RADIUS, outer: LULL_OUTER_RADIUS, separation: 22 },
  community: { inner: 760, outer: 900, separation: 22 },
  record: { inner: 250, outer: 735, separation: 6.5 },
} as const;
const TAU = Math.PI * 2;
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const bandOf = (level: number): 'root' | 'community' | 'record' =>
  level <= 1 ? 'root' : level === 2 || level === 3 ? 'community' : 'record';
const pairKey = (a: string, b: string) => [a, b].sort(cmp).join('');

/** D084-LLULL BEGIN — name gate. The short selector name «Llull» supersedes the older naming line. Keep
 * that name only while the verified rule passes: nine roots mapped B–K, 36 pairs with
 * exact evidence, 84 triples with Fourth Figure positions, hypotheses OFF, and
 * «Perché qui» carrying the historical limitation. Otherwise use the fallback. */
export const LULL_NAME_AUTHORISED = true;
export const LULL_LABEL_AUTHORISED = 'Llull';
export const LULL_LABEL_FALLBACK = 'Topologia circolare combinatoria';
// D084-LLULL END
// D085-S4 BEGIN (fix 5): the offset-class lift supersedes the 3D refusal of D-084 (that
// refusal was right about the extrusion it described; it never considered this coordinate).
// Every pair compartment has a wheel offset in ninth-of-a-turn units between its two real
// root letters; the class min(offset, 9 - offset) in {1,2,3,4} partitions the 36 compartments
// into four regular sub-families of 9 (enneagon, star {9/2}, three triangles, star {9/4}).
// That class is the third coordinate: the pair chords lift to four tables and each real
// node rises by the maximal class its real cross-domain relations attest.
export const LULL_3D_LIFT = LULL_OUTER_RADIUS / 4;
export const LULL_3D_LEVELS = 4;
/** Class of the wheel offset between two root-letter indices, in ninth-of-a-turn units. */
export function lullPairClass(letterIndexA: number, letterIndexB: number): 1 | 2 | 3 | 4 {
  const offset = ((letterIndexB - letterIndexA) % 9 + 9) % 9;
  return (offset <= 4 ? offset : 9 - offset) as 1 | 2 | 3 | 4;
}
export const LULL_3D_LAW = 'In 3D la quota \u00e8 la classe d\u2019offset della Terza Figura (d = min(offset, 9 \u2212 offset) \u2208 {1,2,3,4}): le 36 coppie salgono a quattro tavole regolari di 9 e ogni record si solleva della classe massima attestata dalle sue relazioni reali fra domini; le combinazioni senza evidenza non alzano nulla e nessuna diventa spigolo.';
// D085-S4 END

const LULL_LIMIT_COMPACT = 'Limite storico: le lettere indicano corpora documentali, non i principi predicabili di Llull; i conteggi non provano verità; le 84 triple sono classi deduplicate delle 252 camere della Quarta Figura (Ars brevis, 1308).';

// D085-S4 BEGIN (fix 2): the structural-guide disclosure every «Perché qui» carries, so
// the 36 dashed pair chords of the figure are never mistaken for relations.
export const LULL_GUIDE_DISCLOSURE = 'Guide strutturali: le 36 corde tratteggiate fra le lettere del cerchio esterno sono i compartimenti binari della Terza Figura, non relazioni; non entrano nei conteggi e nessuna combinazione generata diventa spigolo.';
// D085-S4 END

// D085-S4 BEGIN: semantic zoom over the 36 pair compartments. The pair
// bundles are non-semantic guides like the dashed chords, but each one stands for
// a counted set of REAL relations of the full snapshot (its `weight`), so the
// overview reads as Llull's chord rosette drawn from real data while the
// individual chords — density- and reading-filtered by the view, never by the
// law — take over as the camera closes in. The overview veil lightens the record
// band at distance; it is a drawing layer over the marks, never a removal.
export type LullBundleGuide = GuideCurve & Readonly<{ weight: number }>;
/** Guide kind of an aggregated pair bundle (one per evidenced compartment). */
export const LULL_BUNDLE_KIND = 'lull-pair-bundle';
/** Guide kind of the overview veil over the record annulus (2D only). */
export const LULL_VEIL_KIND = 'lull-overview-veil';
/** The veil covers the record annulus with a small margin, inside the communities. */
export const LULL_VEIL_RADIUS = LULL_BANDS.record.outer + 13;
/** The disclosure sentence of the bundles, with the two audit numbers interpolated. */
export const LULL_BUNDLE_DISCLOSURE = (count: number, total: number): string =>
  `Fasci d’insieme: a distanza i ${count} compartimenti con evidenza sono disegnati come fasci che aggregano ${total} relazioni reali fra domini del snapshot completo (larghezza e opacità proporzionali al conteggio; un fascio rappresenta relazioni reali già esistenti, mai una nuova); i compartimenti senza evidenza non disegnano nulla e avvicinando la vista i fasci lasciano il posto alle relazioni singole, che la densità e la lettura attive filtrano.`;
/** The 2D-only veil sentence of the same disclosure block. */
export const LULL_VEIL_DISCLOSURE = 'Velo d’insieme: a distanza un velo attenua le fasce dei record per lasciar leggere la figura; non rimuove mai un segno e svanisce avvicinando la vista.';
// D085-S4 END

type SectorGeometry = Readonly<{ spans: readonly number[]; starts: readonly number[] }>;
/** D084-LLULL BEGIN: Figure A's equal ninefold partition. Counts are accepted
 * for the existing caller contract and checked, but cannot change an angle. */
export function lullSectorGeometry(counts: readonly number[]): SectorGeometry {
  if (counts.length !== 9) throw new Error(`lull: nine sector counts required; found ${counts.length}`);
  const pitch = TAU / 9;
  const spans = counts.map(() => pitch - LULL_BOUNDARY_GAP);
  const starts = counts.map((_, index) => -Math.PI / 2 - pitch / 2 + index * pitch + LULL_BOUNDARY_GAP / 2);
  return { spans, starts };
}
// D084-LLULL END

type Slot = Readonly<{ ring: number; slot: number; radius: number; angle: number }>;
/** Fill one band's arc ladder for a sector: outermost ring first, one slot per
 * separation unit of arc, centred about the Figure A letter on each ring. */
function ladder(count: number, span: number, startAngle: number, band: Readonly<{ inner: number; outer: number; separation: number }>, overflowPolicy: 'within-band' | 'inward' = 'inward'): Slot[] {
  const slots: Slot[] = [];
  const step = band.separation;
  let radius = band.outer - step / 2;
  let remaining = count;
  let ring = 0;
  while (remaining > 0 && radius >= band.inner + step / 2) {
    const capacity = Math.floor(span * radius / step);
    const taken = Math.min(capacity, remaining);
    // D084-LLULL BEGIN: sparse rings stay centred beneath their real root.
    for (let s = 0; s < taken; s++) {
      const slotAngle = step / radius;
      slots.push({ ring, slot: s, radius, angle: startAngle + span / 2 + slotAngle * (s - (taken - 1) / 2) });
    }
    // D084-LLULL END
    remaining -= taken;
    ring++;
    radius -= step;
  }
  // D084-LLULL BEGIN: community overflow stays on a distinct inner arc of its
  // annulus. Compression is unavoidable once the 22-unit ladder is full, but
  // sector bounds and the gap to the record band remain intact. Record overflow
  // retains the documented inward fallback. Neither occurs on the reference data.
  if (overflowPolicy === 'within-band') {
    const overflow = remaining;
    const overflowRadius = band.inner + step / 4;
    for (let i = 0; i < overflow; i++) {
      slots.push({ ring, slot: i, radius: overflowRadius,
        angle: startAngle + span * (i + 1) / (overflow + 1) });
    }
    return slots;
  }
  // D084-LLULL END
  let fallback = 0;
  while (remaining > 0) {
    const rawRadius = band.inner - step / 2 - fallback * step;
    slots.push({ ring, slot: fallback, radius: Math.max(0.5, rawRadius),
      angle: startAngle + span / 2 + (rawRadius < 0.5 ? fallback * 0.02 : 0) });
    remaining--;
    ring++;
    fallback++;
  }
  return slots;
}

const polar = (radius: number, angle: number): Point3 => ({ x: radius * Math.cos(angle), y: radius * Math.sin(angle), z: 0 });

/** The documented comparator inside a sector: primary-parent path, semantic kind,
 * status, descending importance, codepoint ID. The primary domain is constant
 * within a sector and therefore not repeated here. */
function sortKey(node: TopologyNode, pathOf: ReadonlyMap<string, string>): string {
  return [pathOf.get(node.id) ?? '', node.kind, node.status ?? '', `${node.importance.toFixed(6)} DESC`, node.id].join('\0');
}
// D084-LLULL BEGIN: compare importance numerically; its printed sort key is a
// disclosure, never a lexical surrogate for descending numeric order.
function compareInSector(a: TopologyNode, b: TopologyNode, pathOf: ReadonlyMap<string, string>): number {
  return cmp(pathOf.get(a.id) ?? '', pathOf.get(b.id) ?? '')
    || cmp(a.kind, b.kind)
    || cmp(a.status ?? '', b.status ?? '')
    || b.importance - a.importance
    || cmp(a.id, b.id);
}
// D084-LLULL END

/** Community path of each node: primary-parent chain from the root, root excluded,
 * as a deterministic codepoint key. */
function communityPaths(snapshot: TopologySnapshot, rootSet: ReadonlySet<string>, byId: ReadonlyMap<string, TopologyNode>): ReadonlyMap<string, string> {
  const pathOf = new Map<string, string>();
  for (const node of snapshot.nodes) {
    const path: string[] = [];
    let cursor = node.parent;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      if (!rootSet.has(cursor)) path.unshift(cursor);
      cursor = byId.get(cursor)?.parent ?? null;
    }
    pathOf.set(node.id, path.join('\u0000'));
  }
  return pathOf;
}

type Placement = Readonly<{ point: Point3; ring: number; slot: number; radius: number; angle: number; band: 'community' | 'record' }>;
/** Place every real node of the snapshot on the Figure A wheel. Pure and
 * deterministic: identical snapshots produce identical positions. */
function lullPlacements(snapshot: TopologySnapshot, index: LullIndex, pathOf: ReadonlyMap<string, string>): ReadonlyMap<string, Placement> {
  const sectors = index.roots.map(root => snapshot.nodes.filter(n => index.rootOf.get(n.id) === root.id && n.parent !== null));
  const totals = sectors.map(list => list.length);
  const communityCounts = sectors.map(list => list.filter(n => n.level === 2 || n.level === 3).length);
  const recordCounts = sectors.map(list => list.filter(n => n.level >= 4).length);
  const totalGeometry = lullSectorGeometry(totals);
  const communityGeometry = lullSectorGeometry(communityCounts);
  const recordGeometry = lullSectorGeometry(recordCounts);
  const placements = new Map<string, Placement>();
  for (const [rootIndex, root] of index.roots.entries()) {
    const span = totalGeometry.spans[rootIndex]!;
    const start = totalGeometry.starts[rootIndex]!;
    const mid = start + span / 2;
    placements.set(root.id, { point: polar(LULL_OUTER_RADIUS, mid), ring: 0, slot: rootIndex, radius: LULL_OUTER_RADIUS, angle: mid, band: 'community' });
    const members = sectors[rootIndex]!;
    const communityOfBand = members.filter(n => n.level === 2 || n.level === 3)
      .sort((a, b) => a.level - b.level || compareInSector(a, b, pathOf));
    const communitySlots = ladder(communityOfBand.length, communityGeometry.spans[rootIndex]!, communityGeometry.starts[rootIndex]!, LULL_BANDS.community, 'within-band');
    for (const [i, node] of communityOfBand.entries()) {
      const slot = communitySlots[i]!;
      placements.set(node.id, { point: polar(slot.radius, slot.angle), ring: slot.ring, slot: slot.slot, radius: slot.radius, angle: slot.angle, band: 'community' });
    }
    const recordsOfBand = members.filter(n => n.level >= 4)
      .sort((a, b) => compareInSector(a, b, pathOf));
    const recordSlots = ladder(recordsOfBand.length, recordGeometry.spans[rootIndex]!, recordGeometry.starts[rootIndex]!, LULL_BANDS.record);
    for (const [i, node] of recordsOfBand.entries()) {
      const slot = recordSlots[i]!;
      placements.set(node.id, { point: polar(slot.radius, slot.angle), ring: slot.ring, slot: slot.slot, radius: slot.radius, angle: slot.angle, band: 'record' });
    }
  }
  return placements;
}

function circleGuide(id: string, kind: string, radius: number, segments = 128): GuideCurve {
  const points: Point3[] = [];
  for (let i = 0; i <= segments; i++) points.push(polar(radius, i * TAU / segments));
  return { id, points, kind, semantic: false };
}
function arcGuide(id: string, kind: string, radius: number, from: number, to: number, segments = 24): GuideCurve {
  const points: Point3[] = [];
  for (let i = 0; i <= segments; i++) points.push(polar(radius, from + (to - from) * i / segments));
  return { id, points, kind, semantic: false };
}
function rayGuide(id: string, kind: string, angle: number, inner: number, outer: number): GuideCurve {
  return { id, points: [polar(inner, angle), polar(outer, angle)], kind, semantic: false };
}

/** Real relation degree per node over the snapshot's full edge list, split into
 * same-root and cross-root counts with the exact IDs, for «Perché qui». The
 * breakdown carries the evidence type (class, direction) so step 5's disclosure
 * names the kind of evidence behind every count. */
type RelationDegree = Readonly<{ ids: string[]; cross: number; attested: number; exploratory: number; structural: number; directedCount: number; undirected: number }>;
function relationIndex(snapshot: TopologySnapshot, index: LullIndex): ReadonlyMap<string, RelationDegree> {
  const perNode = new Map<string, { ids: string[]; cross: number; attested: number; exploratory: number; structural: number; directedCount: number; undirected: number }>();
  for (const edge of snapshot.edges) {
    const cross = index.rootOf.get(edge.source) !== index.rootOf.get(edge.target);
    for (const id of [edge.source, edge.target]) {
      const entry = perNode.get(id) ?? { ids: [], cross: 0, attested: 0, exploratory: 0, structural: 0, directedCount: 0, undirected: 0 };
      entry.ids.push(edge.id);
      if (cross) entry.cross++;
      if (edge.class === 'attested') entry.attested++;
      else if (edge.class === 'exploratory') entry.exploratory++;
      else entry.structural++;
      if (edge.directed === true) entry.directedCount++;
      else entry.undirected++;
      perNode.set(id, entry);
    }
  }
  for (const entry of perNode.values()) entry.ids.sort(cmp);
  return perNode;
}

// D085-S4 BEGIN (fix 5): the offset classes a node's real cross-domain relations attest.
type LiftClass = Readonly<{ max: number; classes: readonly number[] }>;
/** The 3D table sentence every witness of the lifted view carries. */
export const LULL_3D_TABLES = 'In 3D le 36 corde salgono alle quattro tavole d’offset d=1–4 della Terza Figura (enneagono, stella {9/2}, tre triangoli, stella {9/4}).';

function lullWitnesses(snapshot: TopologySnapshot, index: LullIndex, placements: ReadonlyMap<string, Placement>, pathOf: ReadonlyMap<string, string>, relations: ReadonlyMap<string, RelationDegree>,
  // D085-S4: the bundle audit of this layout, disclosed by every witness.
  bundleAudit: Readonly<{ count: number; total: number }>,
  // D085-S4 (fix 5): non-null only for the 3D lift; null keeps the 2D quota text away.
  liftClasses: ReadonlyMap<string, LiftClass> | null = null): ReadonlyMap<string, TopologyWitness> {
  const witnesses = new Map<string, TopologyWitness>();
  const rootTitles = new Map(index.roots.map(r => [r.id, r.title]));
  // D084-LLULL BEGIN: expose the exact sector, sort and evidence mapping.
  const geometry = lullSectorGeometry(index.roots.map(() => 1));
  const sectorOf = new Map(index.roots.map((root, i) => [root.id, i]));
  for (const node of snapshot.nodes) {
    const placement = placements.get(node.id)!;
    const root = index.rootOf.get(node.id)!;
    const letter = index.letterOf.get(root)!;
    const sectorIndex = sectorOf.get(root)!;
    const sectorStart = geometry.starts[sectorIndex]!;
    const sectorEnd = sectorStart + geometry.spans[sectorIndex]!;
    const rootTitle = rootTitles.get(root)!;
    const degree = relations.get(node.id);
    const shownIds = degree ? degree.ids.slice(0, 12).join(', ') : '';
    const moreIds = degree ? degree.ids.length - Math.min(12, degree.ids.length) : 0;
    const pathText = (pathOf.get(node.id) ?? '').split('\u0000').filter(Boolean).join(' \u203a ');
    const isRoot = node.parent === null;
    // D085-S4 BEGIN (fix 5): the quota sentence of the lifted view. Roots anchor the
    // instrument at z=0 by rule; every other node rises by its maximal attested class.
    const lift = liftClasses?.get(node.id);
    const quotaText = liftClasses === null ? '' : isRoot
      ? `Quota 3D: 0 — le nove lettere ancorano il cerchio di Figura A, lo strumento della regola. `
      : `Quota 3D: classe d=${lift?.max ?? 0} da ${degree ? degree.cross : 0} relazioni reali fra domini (classi attestate: ${lift ? lift.classes.join(', ') : 'nessuna'}); la quota deriva solo dalle relazioni reali del snapshot completo e le combinazioni senza evidenza non alzano nulla. `;
    // D085-S4 END
    const address = isRoot ? `${letter}:figura-a` : `${letter}:${placement.band === 'community' ? 'c' : 'r'}${placement.ring}:p${placement.slot}`;
    const text = `Perch\u00e9 qui: vertice reale ${node.id} del dominio ${rootTitle} (lettera ${letter}; alfabeto B\u2013K dall'ordinamento codepoint dei nove domini radice). `
      + `Comunit\u00e0: ${pathText || '(sotto la radice)'}. Chiavi d'ordine: percorso primario, kind ${node.kind}, status ${node.status ?? 'assente'}, importanza ${node.importance.toFixed(3)} decrescente, id. `
      + `Posizione: ${isRoot ? 'cerchio esterno di Figura A' : `anello ${placement.ring} della fascia ${placement.band === 'community' ? 'comunit\u00e0' : 'record'} del settore ${letter}`}, angolo ${(placement.angle * 180 / Math.PI).toFixed(2)}\u00b0, raggio ${placement.radius.toFixed(1)}. `
      + `Settore ${letter}: ${(sectorStart * 180 / Math.PI).toFixed(2)}\u00b0\u2013${(sectorEnd * 180 / Math.PI).toFixed(2)}\u00b0. `
      + `Relazioni reali: ${degree ? degree.ids.length : 0} (${degree ? degree.cross : 0} fra domini${shownIds ? `; id: ${shownIds}${moreIds > 0 ? ` \u2026 +${moreIds} nella tavola d'inchiesta` : ''}` : ''}). `
      + `Tipo di evidenza: ${degree ? degree.attested : 0} attestate, ${degree ? degree.exploratory : 0} esplorative, ${degree ? degree.structural : 0} strutturali (${degree ? degree.directedCount : 0} direzionali, ${degree ? degree.undirected : 0} senza direzione). `
      // D085-S6 BEGIN: the control's user name is Connessione; the epistemic reading of the counts
      // keeps its own verb, so the reserved control word disappears from the witness text.
      + `Come leggere i conteggi: tutte le relazioni del snapshot completo; la connessione attiva della vista filtra la tavola d'inchiesta, mai i vertici. `
      // D085-S6 END
      // D085-S4 BEGIN (fix 2): every witness discloses the structural pair guides.
      + `${LULL_GUIDE_DISCLOSURE} `
      // D085-S4 END
      // D085-S4 BEGIN: every witness also discloses the overview bundles
      // and — in the flat view only — the veil that lightens the record band.
      + `${LULL_BUNDLE_DISCLOSURE(bundleAudit.count, bundleAudit.total)} `
      + (liftClasses === null ? `${LULL_VEIL_DISCLOSURE} ` : '')
      // D085-S4 END
      // D085-S4 BEGIN (fix 5): the lifted view adds the tables and the node's quota.
      + (liftClasses === null ? '' : `${LULL_3D_TABLES} ${quotaText}`)
      // D085-S4 END
      + `${LULL_LIMIT_COMPACT} ${LULL_SOURCE_CITATION}`;
    witnesses.set(node.id, {
      law: `combinatoria-lulliana/${LULL_RING_POLICY_VERSION}`,
      address,
      values: {
        letter, root, ring: isRoot ? 'figura-a' : String(placement.ring), slot: String(placement.slot),
        band: isRoot ? 'figura-a' : placement.band,
        angle: Number((placement.angle * 180 / Math.PI).toFixed(2)), radius: Number(placement.radius.toFixed(1)),
        sector: letter, sectorStart: Number((sectorStart * 180 / Math.PI).toFixed(2)), sectorEnd: Number((sectorEnd * 180 / Math.PI).toFixed(2)),
        sortPath: pathOf.get(node.id) ?? '', sortKey: sortKey(node, pathOf), relationIds: degree?.ids.join(', ') ?? '',
        relations: degree ? degree.ids.length : 0, crossDomainRelations: degree ? degree.cross : 0,
        evidenceAttested: degree ? degree.attested : 0, evidenceExploratory: degree ? degree.exploratory : 0,
        evidenceStructural: degree ? degree.structural : 0, evidenceDirected: degree ? degree.directedCount : 0,
        evidenceUndirected: degree ? degree.undirected : 0, reading: 'snapshot-completo',
        // D085-S4 BEGIN: the bundle audit values behind the disclosure.
        pairBundles: bundleAudit.count, pairBundleRelations: bundleAudit.total,
        // D085-S4 END
        kind: node.kind, status: node.status ?? '', importance: Number(node.importance.toFixed(6)),
        // D085-S4 BEGIN (fix 5): the quota values exist only in the lifted view.
        ...(liftClasses !== null ? { quota3d: isRoot ? 0 : lift?.max ?? 0, quota3dClasses: isRoot ? '' : lift?.classes.join(',') ?? '' } : {}),
        // D085-S4 END
      },
      text,
    });
  }
  // D084-LLULL END
  return witnesses;
}

function lullContainers(snapshot: TopologySnapshot, index: LullIndex, placements: ReadonlyMap<string, Placement>, byId: ReadonlyMap<string, TopologyNode>): LayoutContainer[] {
  const containers: LayoutContainer[] = [];
  const sectors = index.roots.map(root => snapshot.nodes.filter(n => index.rootOf.get(n.id) === root.id));
  const geometry = lullSectorGeometry(sectors.map(list => Math.max(0, list.length - 1)));
  for (const [rootIndex, root] of index.roots.entries()) {
    const span = geometry.spans[rootIndex]!;
    const start = geometry.starts[rootIndex]!;
    const letter = index.letterOf.get(root.id)!;
    const sine = Math.sin(span / 2);
    const centerRadius = 960 * sine / (1 + sine);
    const radius = 960 - centerRadius;
    const center = polar(centerRadius, start + span / 2);
    containers.push({ id: `lull:sector:${letter}`, level: 1, center, radius, radius2d: radius, open: true,
      title: `${letter} \u00b7 ${root.title}` });
  }
  // Community containers (levels 2–3): tight circles around each community's placed
  // descendants, for the drawer and the semantic zoom into subgroups.
  const members = new Map<string, string[]>();
  for (const node of snapshot.nodes) {
    let cursor = node.parent;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const level = byId.get(cursor)?.level;
      if (level === 2 || level === 3) {
        const list = members.get(cursor) ?? [];
        list.push(node.id);
        members.set(cursor, list);
      }
      cursor = byId.get(cursor)?.parent ?? null;
    }
  }
  for (const [communityId, list] of [...members].sort((a, b) => cmp(a[0], b[0]))) {
    if (!placements.has(communityId)) continue;
    const ids = [communityId, ...list];
    let cx = 0, cy = 0;
    for (const id of ids) {
      const point = placements.get(id)!;
      cx += point.point.x / ids.length;
      cy += point.point.y / ids.length;
    }
    let radius = 0;
    for (const id of ids) {
      const point = placements.get(id)!;
      radius = Math.max(radius, Math.hypot(point.point.x - cx, point.point.y - cy));
    }
    const community = byId.get(communityId)!;
    containers.push({ id: `lull:community:${communityId}`, level: community.level, center: { x: cx, y: cy, z: 0 },
      radius: radius + 14, radius2d: radius + 14, open: true, title: community.title });
  }
  return containers;
}

/** The D-084 Figure A ground marks (rim, hub, spokes, sector rays, letter arcs, band
 * circles): 32 non-semantic guides at z = 0. D085-S4 (fix 5): shared verbatim by both
 * dimensions — the whole 2D figure is the ground of the 3D view. */
function lullFigureMarks(snapshot: TopologySnapshot, index: LullIndex): GuideCurve[] {
  // D084-LLULL BEGIN: radial guide marks are nonsemantic, not relation edges.
  const guides: GuideCurve[] = [
    circleGuide('lull:guide:figure-a', 'lull-figure-a', LULL_OUTER_RADIUS),
    circleGuide('lull:guide:hub', 'lull-hub', 205, 96),
  ];
  const sectors = index.roots.map(root => snapshot.nodes.filter(n => index.rootOf.get(n.id) === root.id));
  const geometry = lullSectorGeometry(sectors.map(list => Math.max(0, list.length - 1)));
  for (const [rootIndex, root] of index.roots.entries()) {
    const letter = index.letterOf.get(root.id)!;
    const span = geometry.spans[rootIndex]!;
    const start = geometry.starts[rootIndex]!;
    guides.push(rayGuide(`lull:guide:ray:${letter}:start`, 'lull-sector-ray', start - LULL_BOUNDARY_GAP / 2, 24, LULL_OUTER_RADIUS));
    guides.push(arcGuide(`lull:guide:letter:${letter}`, 'lull-letter', LULL_OUTER_RADIUS, start + span / 2 - 0.035, start + span / 2 + 0.035));
    guides.push(rayGuide(`lull:guide:spoke:${letter}`, 'lull-hub-spoke', start + span / 2, 0, 205));
  }
  for (const radius of [LULL_BANDS.community.outer, LULL_BANDS.community.inner, LULL_BANDS.record.outer])
    guides.push(circleGuide(`lull:guide:band:${radius}`, 'lull-band', radius, 96));
  // D084-LLULL END
  return guides;
}

function lullLayout2d(snapshot: TopologySnapshot): TopologyLayout {
  const index = indexLullSnapshot(snapshot);
  const byId = new Map(snapshot.nodes.map(n => [n.id, n]));
  const rootSet = new Set(index.roots.map(r => r.id));
  const pathOf = communityPaths(snapshot, rootSet, byId);
  const placements = lullPlacements(snapshot, index, pathOf);
  const positions = new Map<string, Point3>();
  for (const [id, placement] of placements) positions.set(id, placement.point);
  // D085-S4 BEGIN (fix 5): the D-084 mark set now lives in the shared lullFigureMarks,
  // so both dimensions draw the identical Figure A ground. D085-S4: the
  // overview veil comes first in the list, so the guide layer fills it beneath
  // every other mark of the figure.
  const guides: GuideCurve[] = [lullOverviewVeilGuide(), ...lullFigureMarks(snapshot, index)];
  // D085-S4 END
  // D085-S4 BEGIN (fix 2): the Third Figure's 36 pair compartments as dashed structural
  // chords between the nine real root vertices — the recognisable Figure A signature
  // (the complete graph over the circle letters). Each chord's endpoints are exactly
  // the two root vertices already placed by `lullPlacements`, so nothing is invented:
  // a chord exposes a combinatorial compartment, never a relation, it is non-semantic,
  // stays out of every count, and no generated combination becomes an edge
  // (lull.generated-edges stays 0). Angles come from the same count-independent
  // geometry, so the chords are identical across densities and readings.
  const lullPairChords: GuideCurve[] = [];
  for (let a = 0; a < index.roots.length; a++) {
    for (let b = a + 1; b < index.roots.length; b++) {
      const letters = `${index.letterOf.get(index.roots[a]!.id)!}${index.letterOf.get(index.roots[b]!.id)!}`;
      lullPairChords.push({
        id: `lull:guide:pair:${letters}`,
        points: [placements.get(index.roots[a]!.id)!.point, placements.get(index.roots[b]!.id)!.point],
        kind: 'lull-pair-chord',
        semantic: false,
      });
    }
  }
  guides.push(...lullPairChords);
  // D085-S4 END
  // D085-S4 BEGIN: the evidenced compartments' bundles, last in the list so
  // the guide layer strokes them above the dashes and the veil. Weights come from
  // the full snapshot: the overview aggregate never follows the active density or
  // reading, which filter only the individual drawn chords.
  const pairWeights2d = lullPairWeights(snapshot, index);
  const pairBundles = lullPairBundles(index, placements, pairWeights2d, () => 0);
  guides.push(...pairBundles);
  const bundleAudit = {
    count: pairBundles.length,
    total: pairBundles.reduce((sum, bundle) => sum + bundle.weight, 0),
  };
  // D085-S4 END
  // D084-LLULL END
  const witnesses = lullWitnesses(snapshot, index, placements, pathOf, relationIndex(snapshot, index), bundleAudit);
  // Snapshot diagnostics (fixtures of this digest, not UI constants).
  // D085-S4 BEGIN (fix 5): the cross-domain pair evidence and the base audit rows are
  // extracted so the lifted layout certifies the same facts.
  const pairEvidence = lullPairEvidence(snapshot, index);
  const diagnostics = [
    ...lullBaseDiagnostics(index, positions.size, positions.size === snapshot.nodes.length, pairEvidence),
    // D085-S4 END
    // D085-S4 BEGIN (fix 2): the Figure A pair guides are counted from the built list,
    // never hardcoded, and are acceptable exactly when all C(9,2) compartments exist.
    { code: 'lull.figure-a-pair-guides', value: lullPairChords.length, acceptable: lullPairChords.length === 36 },
    // D085-S4 END
    // D085-S4 BEGIN: the bundles are honest counts of real relations —
    // acceptable exactly when they equal the cross-domain audit over the same edges.
    { code: 'lull.pair-bundles', value: bundleAudit.count, acceptable: bundleAudit.count === pairEvidence.evidenced },
    { code: 'lull.pair-bundle-relations', value: bundleAudit.total, acceptable: bundleAudit.total === pairEvidence.crossDomain },
    // D085-S4 END
  ];
  return { positions, guides, containers: lullContainers(snapshot, index, placements, byId), witnesses, diagnostics };
}

// D085-S4 BEGIN (fix 5): the cross-domain pair evidence shared by both dimensions'
// diagnostics and the base audit rows built from it. D085-S4: the exact
// per-pair counts it walks are now the bundle weights, so the overview aggregates
// and the audit count the identical edges by construction.
function lullPairWeights(snapshot: TopologySnapshot, index: LullIndex): ReadonlyMap<string, number> {
  const pairCounts = new Map<string, number>();
  for (const edge of snapshot.edges) {
    const sourceRoot = index.rootOf.get(edge.source);
    const targetRoot = index.rootOf.get(edge.target);
    if (sourceRoot !== undefined && targetRoot !== undefined && sourceRoot !== targetRoot) {
      const key = pairKey(index.letterOf.get(sourceRoot)!, index.letterOf.get(targetRoot)!);
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
  }
  return pairCounts;
}

function lullPairEvidence(snapshot: TopologySnapshot, index: LullIndex):
Readonly<{ crossDomain: number; evidenced: number }> {
  const pairCounts = lullPairWeights(snapshot, index);
  let crossDomain = 0;
  for (const count of pairCounts.values()) crossDomain += count;
  const evidenced = [...pairCounts.values()].filter(count => count > 0).length;
  return { crossDomain, evidenced };
}

// D085-S4 BEGIN: one bundle per pair compartment with real cross-domain
// evidence in the FULL snapshot, straight between its two root vertices at the
// height `heightOf` gives (z = 0 flat; the pair's offset-class table lifted).
// The weight is the compartment's exact real-relation count; a compartment
// without evidence draws nothing. Deterministic and reading-independent: the law
// always consumes the full snapshot.
function lullPairBundles(index: LullIndex, placements: ReadonlyMap<string, Placement>,
  pairWeights: ReadonlyMap<string, number>, heightOf: (a: number, b: number) => number): LullBundleGuide[] {
  const bundles: LullBundleGuide[] = [];
  for (let a = 0; a < index.roots.length; a++) {
    for (let b = a + 1; b < index.roots.length; b++) {
      const letters = `${index.letterOf.get(index.roots[a]!.id)!}${index.letterOf.get(index.roots[b]!.id)!}`;
      const weight = pairWeights.get(letters) ?? 0;
      if (weight <= 0) continue;
      const height = heightOf(a, b);
      bundles.push({
        id: `lull:bundle:${letters}`,
        points: [{ ...placements.get(index.roots[a]!.id)!.point, z: height },
          { ...placements.get(index.roots[b]!.id)!.point, z: height }],
        kind: LULL_BUNDLE_KIND,
        semantic: false,
        weight,
      });
    }
  }
  return bundles;
}

/** The overview veil: a closed circle over the record annulus, filled — never
 * stroked — by the guide layer at overview and fading to nothing on approach.
 * Flat view only; the lifted view keeps its tables unobstructed. */
function lullOverviewVeilGuide(): GuideCurve {
  return circleGuide('lull:guide:overview-veil', LULL_VEIL_KIND, LULL_VEIL_RADIUS, 128);
}
// D085-S4 END

function lullBaseDiagnostics(index: LullIndex, vertexCount: number, verticesComplete: boolean,
  pairEvidence: Readonly<{ crossDomain: number; evidenced: number }>): readonly Readonly<{ code: string; value: number | string; acceptable: boolean }>[] {
  return [
    { code: 'lull.roots', value: index.roots.length, acceptable: true },
    { code: 'lull.letters', value: LULL_LETTERS.join(''), acceptable: true },
    { code: 'lull.vertices', value: vertexCount, acceptable: verticesComplete },
    { code: 'lull.policy', value: LULL_RING_POLICY_VERSION, acceptable: true },
    { code: 'lull.pairs', value: 36, acceptable: true },
    { code: 'lull.pairs.evidenced', value: pairEvidence.evidenced, acceptable: true },
    { code: 'lull.pairs.empty', value: 36 - pairEvidence.evidenced, acceptable: true },
    { code: 'lull.cross-domain-relations', value: pairEvidence.crossDomain, acceptable: true },
    { code: 'lull.triples', value: 84, acceptable: true },
    { code: 'lull.generated-edges', value: 0, acceptable: true },
  ];
}

/** The offset classes each real node's cross-domain relations attest (full snapshot,
 * exactly the edges the cross-domain diagnostic counts). Pure and deterministic. */
function lullLiftClasses(snapshot: TopologySnapshot, index: LullIndex): ReadonlyMap<string, LiftClass> {
  const letterIndex = new Map(index.roots.map((root, i) => [root.id, i] as const));
  const perNode = new Map<string, { max: number; classes: number[] }>();
  const raise = (id: string, klass: number): void => {
    const entry = perNode.get(id) ?? { max: 0, classes: [] };
    if (!entry.classes.includes(klass)) entry.classes.push(klass);
    if (klass > entry.max) entry.max = klass;
    perNode.set(id, entry);
  };
  for (const edge of snapshot.edges) {
    const sourceRoot = index.rootOf.get(edge.source);
    const targetRoot = index.rootOf.get(edge.target);
    if (sourceRoot === undefined || targetRoot === undefined || sourceRoot === targetRoot) continue;
    const klass = lullPairClass(letterIndex.get(sourceRoot)!, letterIndex.get(targetRoot)!);
    raise(edge.source, klass);
    raise(edge.target, klass);
  }
  for (const entry of perNode.values()) entry.classes.sort((a, b) => a - b);
  return perNode;
}

/** The lifted Third Figure (fix 5): x and y are byte-identical to `lullLayout2d`;
 * z is the offset class — the pair chords rise to four regular tables (d = 1..4,
 * 9 compartments each) and every real non-root node rises by the maximal class its
 * real cross-domain relations attest. Roots anchor the Figure A circle at z = 0.
 * No generated combination becomes an edge or lifts anything. */
function lullLayout3d(snapshot: TopologySnapshot): TopologyLayout {
  const index = indexLullSnapshot(snapshot);
  const byId = new Map(snapshot.nodes.map(n => [n.id, n]));
  const rootSet = new Set(index.roots.map(r => r.id));
  const pathOf = communityPaths(snapshot, rootSet, byId);
  const placements = lullPlacements(snapshot, index, pathOf);
  const liftClasses = lullLiftClasses(snapshot, index);
  const positions = new Map<string, Point3>();
  let lifted = 0;
  const classVertices = [0, 0, 0, 0];
  for (const [id, placement] of placements) {
    const maxClass = rootSet.has(id) ? 0 : liftClasses.get(id)?.max ?? 0;
    if (maxClass > 0) { lifted++; classVertices[maxClass - 1]!++; }
    positions.set(id, { ...placement.point, z: maxClass * LULL_3D_LIFT });
  }
  const guides = [...lullFigureMarks(snapshot, index)];
  // The 36 pair chords at their class height: the four tables of the Third Figure.
  const letterIndexOf = new Map(index.roots.map((root, i) => [root.id, i] as const));
  let liftedChords = 0;
  for (let a = 0; a < index.roots.length; a++) {
    for (let b = a + 1; b < index.roots.length; b++) {
      const letters = `${index.letterOf.get(index.roots[a]!.id)!}${index.letterOf.get(index.roots[b]!.id)!}`;
      const height = lullPairClass(letterIndexOf.get(index.roots[a]!.id)!, letterIndexOf.get(index.roots[b]!.id)!) * LULL_3D_LIFT;
      const from = placements.get(index.roots[a]!.id)!.point;
      const to = placements.get(index.roots[b]!.id)!.point;
      guides.push({
        id: `lull:guide:pair:${letters}`,
        points: [{ ...from, z: height }, { ...to, z: height }],
        kind: 'lull-pair-chord',
        semantic: false,
      });
      liftedChords++;
    }
  }
  // One faint riser per letter, so the four tables stay anchored to Figure A.
  for (const root of index.roots) {
    const base = placements.get(root.id)!.point;
    guides.push({
      id: `lull:guide:riser:${index.letterOf.get(root.id)!}`,
      points: [{ ...base, z: 0 }, { ...base, z: LULL_3D_LEVELS * LULL_3D_LIFT }],
      kind: 'lull-riser',
      semantic: false,
    });
  }
  // D085-S4 BEGIN: the same overview bundles, lifted to each compartment's
  // offset-class table — the aggregate sits at the table it belongs to, above the
  // lifted relation ink. No veil in the lifted view: the tables stay unobstructed.
  const pairBundles = lullPairBundles(index, placements, lullPairWeights(snapshot, index),
    (a, b) => lullPairClass(letterIndexOf.get(index.roots[a]!.id)!, letterIndexOf.get(index.roots[b]!.id)!) * LULL_3D_LIFT);
  guides.push(...pairBundles);
  const bundleAudit = {
    count: pairBundles.length,
    total: pairBundles.reduce((sum, bundle) => sum + bundle.weight, 0),
  };
  // D085-S4 END
  const witnesses = lullWitnesses(snapshot, index, placements, pathOf, relationIndex(snapshot, index), bundleAudit, liftClasses);
  const pairEvidence = lullPairEvidence(snapshot, index);
  const diagnostics = [
    ...lullBaseDiagnostics(index, positions.size, positions.size === snapshot.nodes.length, pairEvidence),
    { code: 'lull.figure-a-pair-guides', value: liftedChords, acceptable: liftedChords === 36 },
    // D085-S4 BEGIN: the same honest counts as the flat view.
    { code: 'lull.pair-bundles', value: bundleAudit.count, acceptable: bundleAudit.count === pairEvidence.evidenced },
    { code: 'lull.pair-bundle-relations', value: bundleAudit.total, acceptable: bundleAudit.total === pairEvidence.crossDomain },
    // D085-S4 END
    { code: 'lull.3d.lift-unit', value: LULL_3D_LIFT, acceptable: true },
    { code: 'lull.3d.levels', value: LULL_3D_LEVELS, acceptable: true },
    { code: 'lull.3d.lifted-vertices', value: lifted, acceptable: true },
    { code: 'lull.3d.class-d1', value: classVertices[0]!, acceptable: true },
    { code: 'lull.3d.class-d2', value: classVertices[1]!, acceptable: true },
    { code: 'lull.3d.class-d3', value: classVertices[2]!, acceptable: true },
    { code: 'lull.3d.class-d4', value: classVertices[3]!, acceptable: true },
  ];
  // Containers are the 2D drawer's circles; the lifted view draws none (as Julia).
  return { positions, guides, containers: [], witnesses, diagnostics };
}
// D085-S4 END

/** Layout cache (TOPOLOGY-CONTRACT): positions are computed once per
 * (snapshot digest, law version, dimension) and reused; densities only choose
 * subsets, so shared IDs never move between Essenziale, Bilanciata and Completa.
 * Bounded and oldest-first evicted to keep memory predictable across digests. */
export const LULL_LAYOUT_CACHE_MAX = 8;
const layoutCache = new Map<string, TopologyLayout>();

export function lullLayoutCacheKey(snapshot: TopologySnapshot, version: string, dimension: TopologyDimension): string {
  return `${snapshot.digest}\0${version}\0${dimension}`;
}

/** Number of cached layouts (diagnostics/tests only). */
export function lullLayoutCacheSize(): number {
  return layoutCache.size;
}

/** Test/diagnostic hook: drop the cached layouts. */
export function clearLullLayoutCache(): void {
  layoutCache.clear();
}

/** `layoutFull` with the required cache: the first call computes, later calls
 * with the same (digest, version, dimension) key return the identical layout. */
export function cachedLullLayout(snapshot: TopologySnapshot, dimension: TopologyDimension): TopologyLayout {
  const key = lullLayoutCacheKey(snapshot, lullLaw.version, dimension);
  const cached = layoutCache.get(key);
  if (cached) return cached;
  // D085-S4 BEGIN (fix 5): each dimension computes its own cached layout — the 2D wheel
  // and the lifted Third Figure share placements, never cache entries.
  const layout = dimension === '2d' ? lullLayout2d(snapshot) : lullLayout3d(snapshot);
  // D085-S4 END
  layoutCache.set(key, layout);
  while (layoutCache.size > LULL_LAYOUT_CACHE_MAX)
    layoutCache.delete(layoutCache.keys().next().value!);
  return layout;
}

/** Unit-frame rerun of the same circular law for Indra ON: the container's real
 * children fill the same band ladders scaled into the unit disc, without minting
 * source vertices or edges. Deterministic. */
function lullLayoutLocal(children: readonly TopologyNode[], snapshot: TopologySnapshot): ReadonlyMap<string, Point3> {
  const allowed = new Set(children.map(n => n.id));
  const byId = new Map(snapshot.nodes.map(n => [n.id, n]));
  const pathOf = new Map<string, string>();
  for (const node of children) {
    const path: string[] = [];
    let cursor = node.parent;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor) && !allowed.has(cursor)) {
      seen.add(cursor);
      path.unshift(cursor);
      cursor = byId.get(cursor)?.parent ?? null;
    }
    pathOf.set(node.id, path.join('\u0000'));
  }
  const scale = 1 / LULL_OUTER_RADIUS;
  const unitBands = {
    // D084-LLULL BEGIN: local ladders use the same versioned separation policy.
    community: { inner: LULL_BANDS.community.inner * scale, outer: LULL_BANDS.community.outer * scale, separation: LULL_BANDS.community.separation * scale },
    record: { inner: LULL_BANDS.record.inner * scale, outer: LULL_BANDS.record.outer * scale, separation: LULL_BANDS.record.separation * scale },
    // D084-LLULL END
  } as const;
  const ordered = [...children].sort((a, b) => cmp(bandOf(a.level), bandOf(b.level))
    || (bandOf(a.level) === 'community' ? a.level - b.level : 0)
    || compareInSector(a, b, pathOf));
  const positions = new Map<string, Point3>();
  // Level-1 children (a sector container may include its root) anchor on the unit
  // outer circle, mirroring Figure A of layoutFull; they never enter the bands.
  const anchors = ordered.filter(n => bandOf(n.level) === 'root');
  for (const [i, node] of anchors.entries())
    positions.set(node.id, polar(1, -Math.PI / 2 + i * TAU / Math.max(1, anchors.length)));
  for (const bandName of ['community', 'record'] as const) {
    const band = unitBands[bandName];
    const membersOfBand = ordered.filter(n => bandOf(n.level) === bandName);
    const slots = ladder(membersOfBand.length, TAU, 0, band, bandName === 'community' ? 'within-band' : 'inward');
    for (const [i, node] of membersOfBand.entries())
      positions.set(node.id, polar(slots[i]!.radius, slots[i]!.angle));
  }
  return positions;
}

export const lullLaw: TopologyLaw = {
  id: 'lull',
  version: LULL_RING_POLICY_VERSION,
  label: (_dimension: TopologyDimension) => LULL_NAME_AUTHORISED ? LULL_LABEL_AUTHORISED : LULL_LABEL_FALLBACK,
  supports: (_dimension: TopologyDimension) =>
    // D085-S4 BEGIN (fix 5): both dimensions are certified — the 3D quota is the Third
    // Figure's offset class, not an extrusion.
    ({ ok: true } as const),
  // D085-S4 END
  layoutFull: (snapshot: TopologySnapshot, dimension: TopologyDimension) =>
    cachedLullLayout(snapshot, dimension),
  layoutLocal: (children: readonly TopologyNode[], snapshot: TopologySnapshot, _dimension: TopologyDimension) =>
    lullLayoutLocal(children, snapshot),
};
