/** Llull — the optional inquiry table UI (D-082 P8, Build B).
 * A pure, testable model of the 36 pair compartments and 84 triple rows with
 * their exact real-relation evidence, plus a thin DOM render. The hypothesis
 * layer (combinations without evidence) is a separate labelled layer, OFF by
 * default, with derived IDs; it never enters the graph-edge counts. The table
 * is optional: the host page keeps it closed until the user opens it. */
import type { LullInquiry, LullPair, LullTriple, LullWheelPosition } from '../topology/lull-inquiry.ts';
import { LULL_HISTORICAL_LIMIT, LULL_SOURCE_CITATION } from '../topology/lull-inquiry.ts';

export const LULL_PANEL_HYPOTHESIS_NOTE = 'Le combinazioni senza evidenza sono ipotesi: un livello derivato, separato e disattivato per default. Non sono spigoli del grafo, non entrano nei conteggi e non aggiungono vertici.';

// D085-S4 BEGIN: the note ties the dashed pair chords to the inquiry table and
// names the overview
// bundles truthfully: at distance the cross-sector relations are not drawn one by
// one — each evidenced row below is exactly one bundle in the figure, its relation
// count is the bundle's weight, and its relation ids are the bundle's ids; on
// approach the routing redraws the exact individual relations as the bundle fades.
// full inquiry audit separately from the active routed fold.
export const LULL_PANEL_GUIDE_NOTE = 'Nella figura: le 36 corde tratteggiate fra le lettere del cerchio esterno sono i compartimenti binari elencati qui sotto (guide strutturali della Terza Figura, non relazioni); le relazioni reali restano le linee continue. A distanza d’insieme le relazioni attive fra due settori non vengono disegnate una per una: possono essere sostituite da un fascio spesso fra le lettere. I numeri e gli id qui sotto descrivono lo snapshot completo; il peso del fascio visibile segue solo le relazioni effettivamente aggregate nella densità e lettura attive, registrate nel witness. Avvicinando la vista ogni relazione singola torna al suo posto.';
// D085-S4 END

/** Ninth-of-a-turn wheel offsets rendered as human-readable alignments. */
export function formatLullWheelPosition(position: LullWheelPosition): string {
  return `fisso ${position.outer}, ruote ${position.innerOne}(+${position.innerOneOffset}/9) e ${position.innerTwo}(+${position.innerTwoOffset}/9)`;
}

export type LullPanelEvidenceRow = Readonly<{ id: string; from: string; to: string; arrow: string; klass: string; type: string; provenance: string; directed: boolean }>;
export type LullPanelPair = Readonly<{ id: string; letters: string; rootTitles: readonly [string, string]; weight: number; hypothesis: boolean; evidence: readonly LullPanelEvidenceRow[] }>;
/** One of a triple's three pair evidence sets, kept exact. */
export type LullPanelPairEvidence = Readonly<{ pairId: string; letters: string; relationIds: readonly string[] }>;
export type LullPanelTriple = Readonly<{ id: string; letters: string; sharedRecordIds: readonly string[]; wheelPositions: readonly LullWheelPosition[]; pairIds: readonly [string, string, string]; pairEvidence: readonly [LullPanelPairEvidence, LullPanelPairEvidence, LullPanelPairEvidence]; pairWeights: readonly [number, number, number]; pathWitnessTotal: number; witnesses: readonly { recordIds: readonly string[]; relationIds: readonly string[] }[]; hypothesis: boolean }>;
export type LullPanelModel = Readonly<{
  title: string;
  limit: string;
  citation: string;
  note: string;
  reading: string;
  summary: Readonly<{ pairs: number; pairsWithEvidence: number; pairHypotheses: number; triples: number; triplesSupported: number; generatedGraphEdges: number }>;
  hypothesesShown: boolean;
  pairs: readonly LullPanelPair[];
  triples: readonly LullPanelTriple[];
}>;

const evidenceRow = (e: LullPair['evidence'][number]): LullPanelEvidenceRow => ({
  id: e.id, from: e.source, to: e.target, arrow: e.directed === true ? '\u2192' : '\u2013', directed: e.directed === true,
  klass: e.class, type: e.type,
  provenance: Array.isArray(e.provenance) ? e.provenance.join(', ') : e.provenance == null ? '' : String(e.provenance),
});

/** Letter-index pairs of a triple's three compartments, in `pairIds` order. */
const PAIR_INDICES = [[0, 1], [0, 2], [1, 2]] as const;

/** Build the panel model from an inquiry. Pure: the same inquiry always yields
 * the same model; hypothesis rows are excluded unless `showHypotheses` is set. */
export function createLullPanel(inquiry: LullInquiry, options: Readonly<{ showHypotheses?: boolean; label?: string }> = {}): LullPanelModel {
  const showHypotheses = options.showHypotheses ?? false;
  const rootTitles = new Map(inquiry.index.roots.map(r => [r.id, r.title]));
  const pairs = inquiry.pairs
    .filter(pair => showHypotheses || !pair.hypothesis)
    .map((pair: LullPair): LullPanelPair => ({
      id: pair.id, letters: pair.letters.join(''),
      rootTitles: [rootTitles.get(pair.roots[0]!) ?? pair.roots[0]!, rootTitles.get(pair.roots[1]!) ?? pair.roots[1]!],
      weight: pair.weight, hypothesis: pair.hypothesis, evidence: pair.evidence.map(evidenceRow),
    }));
  const triples = inquiry.triples
    .filter(triple => showHypotheses || !triple.hypothesis)
    .map((triple: LullTriple): LullPanelTriple => ({
      id: triple.id, letters: triple.letters.join(''),
      sharedRecordIds: triple.sharedRecordIds,
      // B5-01: the three generating wheel alignments and the three exact pair
      // evidence sets survive the panel projection (weights stay derived).
      wheelPositions: triple.wheelPositions,
      pairIds: triple.pairIds,
      pairEvidence: triple.pairRelationIds.map((relationIds, i) => ({
        pairId: triple.pairIds[i]!,
        letters: [triple.letters[PAIR_INDICES[i]![0]!]!, triple.letters[PAIR_INDICES[i]![1]!]!].sort().join(''),
        relationIds,
      })) as [LullPanelPairEvidence, LullPanelPairEvidence, LullPanelPairEvidence],
      pairWeights: triple.pairRelationIds.map(set => set.length) as [number, number, number],
      pathWitnessTotal: triple.pathWitnessTotal,
      witnesses: triple.pathWitnesses.map(w => ({ recordIds: w.recordIds, relationIds: w.relationIds })),
      hypothesis: triple.hypothesis,
    }));
  const pairsWithEvidence = inquiry.pairs.filter(pair => !pair.hypothesis).length;
  const triplesSupported = inquiry.triples.filter(triple => !triple.hypothesis).length;
  return {
    // D084-LLULL BEGIN: short authorised name, with the exact classification disclosed.
    title: options.label ?? 'Llull \u00b7 tavola d\u2019inchiesta',
    limit: 'Llull — combinatorial topology governed by the verified Llullian nine-domain rule; not a fractal and not an IFS. ' + LULL_HISTORICAL_LIMIT,
    // D084-LLULL END
    citation: LULL_SOURCE_CITATION,
    note: LULL_PANEL_HYPOTHESIS_NOTE,
    reading: inquiry.reading,
    summary: {
      pairs: inquiry.pairs.length,
      pairsWithEvidence,
      pairHypotheses: inquiry.pairs.length - pairsWithEvidence,
      triples: inquiry.triples.length,
      triplesSupported,
      generatedGraphEdges: inquiry.generatedGraphEdges,
    },
    hypothesesShown: showHypotheses,
    pairs,
    triples,
  };
}

/** Flip the hypothesis layer: returns a new model, the original is untouched. */
export function toggleLullPanelHypotheses(model: LullPanelModel, inquiry: LullInquiry, options: Readonly<{ label?: string }> = {}): LullPanelModel {
  return createLullPanel(inquiry, { ...options, showHypotheses: !model.hypothesesShown });
}

/** Render the model into a host element. Native `<details>` elements provide the
 * expansion of pair evidence to the exact relation IDs without script state. */
export function renderLullPanel(host: HTMLElement, model: LullPanelModel): void {
  host.replaceChildren();
  host.classList.add('lull-panel');
  const doc = host.ownerDocument;
  const heading = doc.createElement('h3');
  heading.textContent = model.title;
  const limit = doc.createElement('p');
  limit.className = 'lull-panel__limit';
  limit.textContent = model.limit;
  const citation = doc.createElement('p');
  citation.className = 'lull-panel__citation';
  citation.textContent = model.citation;
  const summary = doc.createElement('p');
  summary.className = 'lull-panel__summary';
  summary.textContent = `36 compartimenti binari della Terza Figura: ${model.summary.pairsWithEvidence} con evidenza, ${model.summary.pairHypotheses} ipotesi (vuoti) \u00b7 `
    + `${model.summary.triples} triple della Quarta Figura: ${model.summary.triplesSupported} con testimoni \u00b7 spigoli generati: ${model.summary.generatedGraphEdges}.`;
  const reading = doc.createElement('p');
  reading.className = 'lull-panel__reading';
  // D085-S6 BEGIN: the control's user-visible name is Connessione.
  reading.textContent = `Connessione attiva: ${model.reading}.`;
  // D085-S6 END
  // D085-S4 BEGIN (fix 2): the figure's dashed pair chords point at this table.
  const guideNote = doc.createElement('p');
  guideNote.className = 'lull-panel__guides';
  guideNote.textContent = LULL_PANEL_GUIDE_NOTE;
  // D085-S4 END
  const note = doc.createElement('p');
  note.className = 'lull-panel__note';
  note.textContent = `${model.note} Livello ipotesi: ${model.hypothesesShown ? 'visibile' : 'nascosto (default)'}.`;
  host.append(heading, limit, citation, summary, reading, guideNote, note);
  // D082-LAB-FIX3 BEGIN: nested evidence bodies are materialized on first open.
  const onFirstOpen = (item: HTMLDetailsElement, populate: () => void): void => {
    let populated = false;
    item.addEventListener('toggle', () => {
      if (item.open && !populated) { populated = true; populate(); }
    });
  };
  const pairHeader = doc.createElement('h4');
  pairHeader.textContent = 'Coppie (B\u2013K)';
  host.append(pairHeader);
  for (const pair of model.pairs) {
    const item = doc.createElement('details');
    item.className = 'lull-panel__pair';
    const label = doc.createElement('summary');
    label.textContent = `${pair.letters} \u00b7 ${pair.rootTitles[0]} + ${pair.rootTitles[1]} \u00b7 ${pair.weight} relazioni${pair.hypothesis ? ' \u00b7 IPOTESI (nessuna evidenza)' : ''}`;
    item.append(label);
    onFirstOpen(item, () => {
      if (pair.evidence.length) {
        const list = doc.createElement('ul');
        for (const row of pair.evidence) {
          const entry = doc.createElement('li');
          entry.textContent = `${row.id} \u00b7 ${row.from} ${row.arrow} ${row.to} \u00b7 ${row.klass} \u00b7 ${row.type}${row.provenance ? ` \u00b7 provenienza: ${row.provenance}` : ''}`;
          list.append(entry);
        }
        item.append(list);
      }
    });
    host.append(item);
  }
  const tripleHeader = doc.createElement('h4');
  tripleHeader.textContent = 'Triple (Quarta Figura, classi deduplicate)';
  host.append(tripleHeader);
  for (const triple of model.triples) {
    const item = doc.createElement('details');
    item.className = 'lull-panel__triple';
    const label = doc.createElement('summary');
    label.textContent = `${triple.letters} \u00b7 condivisi: ${triple.sharedRecordIds.length} \u00b7 coppie: ${triple.pairWeights.join('/')} \u00b7 testimoni di percorso: ${triple.pathWitnessTotal}${triple.hypothesis ? ' \u00b7 IPOTESI' : ''}`;
    item.append(label);
    onFirstOpen(item, () => {
      // B5-01: relation-ID bodies are created only when the row is expanded.
      const wheels = doc.createElement('p');
      wheels.className = 'lull-panel__wheel-positions';
      wheels.textContent = `Allineamenti generanti (Quarta Figura): ${triple.wheelPositions.map(formatLullWheelPosition).join(' \u00b7 ')}.`;
      item.append(wheels);
      for (const pair of triple.pairEvidence) {
        const pairItem = doc.createElement('details');
        pairItem.className = 'lull-panel__triple-pair';
        const pairLabel = doc.createElement('summary');
        pairLabel.textContent = `Coppia ${pair.letters} \u00b7 ${pair.relationIds.length} relazioni`;
        pairItem.append(pairLabel);
        onFirstOpen(pairItem, () => {
          if (!pair.relationIds.length) return;
          const ids = doc.createElement('p');
          ids.className = 'lull-panel__pair-relation-ids';
          ids.textContent = pair.relationIds.join(', ');
          pairItem.append(ids);
        });
        item.append(pairItem);
      }
      if (triple.sharedRecordIds.length) {
        const shared = doc.createElement('p');
        shared.textContent = `Record condivisi: ${triple.sharedRecordIds.join(', ')}`;
        item.append(shared);
      }
      for (const witness of triple.witnesses) {
        const line = doc.createElement('p');
        line.textContent = `Percorso ${witness.recordIds.join(' \u203a ')} tramite ${witness.relationIds.join(', ')}`;
        item.append(line);
      }
    });
    host.append(item);
  }
  // D082-LAB-FIX3 END
}
