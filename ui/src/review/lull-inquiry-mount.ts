/** Llull — page mount of the inquiry table (D-082 P8, Build B).
 * The side panel offers the «Tabella delle combinazioni» section only while the
 * topology is «Llull». The section is collapsed by default and
 * the inquiry is built lazily on its first opening, over the density's visible
 * set and the active reading. The hypothesis layer stays a separate, labelled,
 * OFF-by-default layer and never enters the graph-edge counts. Choosing a pair
 * or triple reports the exact real relation IDs the row lists, so the page can
 * highlight them through its existing emphasis APIs; the mount owns no renderer
 * of its own — it renders the existing panel model (`renderLullPanel`). */
import type { TopologyEdge, TopologySnapshot } from '../topology/contract.ts';
import type { LullInquiry } from '../topology/lull-inquiry.ts';
import { buildLullInquiry } from '../topology/lull-inquiry.ts';
import { computeLullInquiryAsync } from '../topology/page-bridge.ts';
import type { LullPanelModel } from './lull-panel.ts';
import { createLullPanel, renderLullPanel } from './lull-panel.ts';

export const LULL_INQUIRY_SECTION_TITLE = 'Tabella delle combinazioni';
export const LULL_INQUIRY_CLOSED_HINT = 'Sezione chiusa di default: apri per costruire la tavola d\u2019inchiesta sui nodi visibili e sulla lettura attiva.';
export const LULL_INQUIRY_HYPOTHESIS_LABEL = 'Mostra ipotesi — combinazioni senza evidenza; livello separato, mai conteggiate come spigoli del grafo';
export const LULL_INQUIRY_HIGHLIGHT_TITLE = 'Evidenzia nel grafo esattamente le relazioni reali elencate dalla riga; restano visibili solo quelle che la lettura e la densit\u00e0 correnti gi\u00e0 disegnano.';

/** The inquiry-table selection the page highlights: a pair compartment or a
 * Fourth-Figure triple with the exact real relation IDs its row lists. */
export type LullInquirySelection = Readonly<{ kind: 'pair' | 'triple'; id: string; letters: string; relationIds: readonly string[] }>;
export type LullInquiryMountInput = Readonly<{
    snapshot: TopologySnapshot;
    visibleIds: ReadonlySet<string>;
    eligible: (edge: TopologyEdge) => boolean;
    reading: string;
}>;

/** The reading the inquiry discloses: structural relations stay eligible in
 * every reading, exactly like the classic relation filter the page applies. */
export function lullReadingLabel(reading: 'attested' | 'exploratory' | 'combined'): string {
    return reading === 'attested' ? 'attestata (attestate + strutturali)'
        : reading === 'exploratory' ? 'esplorativa (esplorative + strutturali)'
            : 'combinata (attestate + esplorative + strutturali)';
}

type BuildInquiry = typeof buildLullInquiry;
type BuildInquiryAsync = (snapshot: TopologySnapshot, selectedIds: ReadonlySet<string>, reading: string,
    eligible: (edge: TopologyEdge) => boolean) => Promise<LullInquiry>;
type MountRow = { kind: 'pair' | 'triple'; id: string; letters: string; relationIds: readonly string[] };

const unionIds = (sets: readonly (readonly string[])[]): string[] => {
    const seen = new Set<string>();
    for (const set of sets) for (const id of set) seen.add(id);
    return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

const cacheKeyOf = (input: LullInquiryMountInput): string =>
    JSON.stringify([input.snapshot.digest, input.reading, [...input.visibleIds].sort()]);
const signatureOf = (key: string, hypotheses: boolean): string => `${key}\0${hypotheses ? 'H' : 'E'}`;

export class LullInquiryMount {
    private readonly build: BuildInquiry;
    private readonly buildAsync: BuildInquiryAsync | undefined;
    private readonly onChange: ((selection: LullInquirySelection | null) => void) | undefined;
    private section: HTMLDetailsElement | null = null;
    private statusLine: HTMLElement | null = null;
    private hypothesisBox: HTMLInputElement | null = null;
    private body: HTMLElement | null = null;
    private buttons: { button: HTMLButtonElement; row: MountRow }[] = [];
    private input: LullInquiryMountInput | null = null;
    private key: string | null = null;
    private modelSignature: string | null = null;
    private pendingSignature: string | null = null;
    private requestGeneration = 0;
    private inquiry: LullInquiry | null = null;
    private hypothesesEnabled = false;
    private active = false;
    private selection: LullInquirySelection | null = null;

    constructor(deps: Readonly<{ buildInquiry?: BuildInquiry; buildInquiryAsync?: BuildInquiryAsync; onSelectionChange?: (selection: LullInquirySelection | null) => void }> = {}) {
        this.build = deps.buildInquiry ?? buildLullInquiry;
        this.buildAsync = deps.buildInquiryAsync ?? (deps.buildInquiry ? undefined : computeLullInquiryAsync);
        this.onChange = deps.onSelectionChange;
    }

    getSelection(): LullInquirySelection | null { return this.selection; }
    isActive(): boolean { return this.active; }

    /** A node selection supersedes the inquiry-table highlight; also used by reset(). */
    clearSelection(): void {
        if (!this.selection) return;
        this.selection = null;
        this.refreshButtons();
        this.onChange?.(null);
    }

    /** The page seam: renderPanel calls this on every side-panel rebuild. The
     * section element is persistent, so its open state and the hypothesis
     * checkbox survive panel re-renders; a fresh open rebuilds lazily. */
    sync(host: HTMLElement, active: boolean, input: LullInquiryMountInput): void {
        if (!active) {
            if (this.active) this.deactivate();
            return;
        }
        this.active = true;
        const nextKey = cacheKeyOf(input);
        if (this.key !== nextKey) {
            this.requestGeneration++;
            this.pendingSignature = null;
            this.inquiry = null;
            this.modelSignature = null;
            if (this.selection) {
                this.selection = null;
                this.onChange?.(null);
            }
        }
        this.input = input;
        this.key = nextKey;
        this.ensureSection(host.ownerDocument!);
        const section = this.section!;
        if (section.parentNode !== host) host.append(section);
        if (section.open) this.ensureTable();
    }

    private deactivate(): void {
        this.active = false;
        const hadSelection = this.selection !== null;
        this.selection = null;
        if (this.section) {
            this.section.open = false;
            this.section.parentNode?.removeChild(this.section);
            if (this.hypothesisBox) this.hypothesisBox.checked = false;
            this.body?.replaceChildren();
            if (this.statusLine) this.statusLine.textContent = LULL_INQUIRY_CLOSED_HINT;
        }
        this.inquiry = null;
        this.modelSignature = null;
        this.pendingSignature = null;
        this.requestGeneration++;
        this.key = null;
        this.input = null;
        this.hypothesesEnabled = false;
        this.buttons = [];
        if (hadSelection) this.onChange?.(null);
    }

    private ensureSection(doc: Document): void {
        if (this.section) return;
        const section = doc.createElement('details');
        section.className = 'lull-inquiry-section';
        section.id = 'lull-inquiry-section';
        const summary = doc.createElement('summary');
        summary.textContent = LULL_INQUIRY_SECTION_TITLE;
        const status = doc.createElement('p');
        status.className = 'lull-inquiry-status';
        status.textContent = LULL_INQUIRY_CLOSED_HINT;
        const hypothesisLabel = doc.createElement('label');
        hypothesisLabel.className = 'lull-inquiry-hypotheses';
        const box = doc.createElement('input');
        box.type = 'checkbox';
        const boxText = doc.createElement('span');
        boxText.textContent = LULL_INQUIRY_HYPOTHESIS_LABEL;
        hypothesisLabel.append(box, boxText);
        box.addEventListener('change', () => {
            this.hypothesesEnabled = box.checked;
            if (this.inquiry) this.renderModel();
            else this.ensureTable();
        });
        section.addEventListener('toggle', () => {
            if (section.open) this.ensureTable();
            else if (this.pendingSignature) {
                this.requestGeneration++;
                this.pendingSignature = null;
                if (this.statusLine) this.statusLine.textContent = LULL_INQUIRY_CLOSED_HINT;
            }
        });
        const body = doc.createElement('div');
        body.className = 'lull-inquiry-body';
        section.append(summary, status, hypothesisLabel, body);
        this.section = section;
        this.statusLine = status;
        this.hypothesisBox = box;
        this.body = body;
    }

    private ensureTable(): void {
        if (!this.input || !this.key || !this.body || !this.statusLine) return;
        const signature = signatureOf(this.key, this.hypothesesEnabled);
        if (this.inquiry && this.modelSignature === signature) return;
        if (this.pendingSignature === signature) return;
        const input = this.input;
        this.statusLine.textContent = 'Costruzione della tavola d\u2019inchiesta\u2026';
        this.body.replaceChildren();
        this.buttons = [];
        if (this.buildAsync) {
            const generation = ++this.requestGeneration;
            this.pendingSignature = signature;
            void this.buildAsync(input.snapshot, input.visibleIds, input.reading, input.eligible).then(inquiry => {
                if (generation !== this.requestGeneration || !this.active || !this.section?.open
                    || this.key !== cacheKeyOf(input) || this.pendingSignature !== signature) return;
                this.pendingSignature = null;
                this.inquiry = inquiry;
                this.renderModel();
                if (this.statusLine) this.statusLine.textContent = `Tavola costruita sui ${input.visibleIds.size} nodi visibili della densit\u00e0 corrente \u00b7 lettura ${input.reading}.`;
            }).catch(error => {
                if (generation !== this.requestGeneration || !this.active || this.key !== cacheKeyOf(input)) return;
                this.pendingSignature = null;
                this.inquiry = null;
                this.modelSignature = null;
                if (this.statusLine) this.statusLine.textContent = `Tavola non costruita: ${error instanceof Error ? error.message : String(error)}.`;
            });
            return;
        }
        try {
            this.inquiry = this.build(input.snapshot, { selectedIds: input.visibleIds, eligible: input.eligible, reading: input.reading });
        } catch (error) {
            this.inquiry = null;
            this.modelSignature = null;
            this.statusLine.textContent = `Tavola non costruita: ${error instanceof Error ? error.message : String(error)}.`;
            return;
        }
        this.renderModel();
        this.statusLine.textContent = `Tavola costruita sui ${input.visibleIds.size} nodi visibili della densit\u00e0 corrente \u00b7 lettura ${input.reading}.`;
    }

    private renderModel(): void {
        if (!this.inquiry || !this.body || !this.key) return;
        const model = createLullPanel(this.inquiry, { showHypotheses: this.hypothesesEnabled });
        renderLullPanel(this.body, model);
        this.modelSignature = signatureOf(this.key, this.hypothesesEnabled);
        this.wireRowButtons(model);
    }

    /** The highlight affordance joins the rows `renderLullPanel` produced: one
     * button per pair and triple compartment, mapped back through the row id
     * the letters determine. Hypothesis rows list no relation and stay inert. */
    private wireRowButtons(model: LullPanelModel): void {
        const doc = this.body!.ownerDocument!;
        const rows = new Map<string, MountRow>();
        for (const pair of model.pairs)
            rows.set(pair.id, { kind: 'pair', id: pair.id, letters: pair.letters, relationIds: pair.evidence.map(row => row.id) });
        for (const triple of model.triples)
            rows.set(triple.id, {
                kind: 'triple', id: triple.id, letters: triple.letters,
                relationIds: unionIds([...triple.pairEvidence.map(pair => pair.relationIds), ...triple.witnesses.map(witness => witness.relationIds)]),
            });
        this.buttons = [];
        for (const child of [...this.body!.children]) {
            const kind = child.className.includes('lull-panel__triple') ? 'triple'
                : child.className.includes('lull-panel__pair') ? 'pair' : null;
            if (!kind) continue;
            const letters = (child.children[0]?.textContent ?? '').split('\u00b7')[0]!.trim();
            const row = rows.get(`inquiry:${kind}:${letters}`);
            if (!row) continue;
            const button: HTMLButtonElement = doc.createElement('button');
            button.type = 'button';
            button.className = 'lull-inquiry-highlight';
            button.title = LULL_INQUIRY_HIGHLIGHT_TITLE;
            button.addEventListener('click', () => { this.chooseRow(row); });
            child.append(button);
            this.buttons.push({ button, row });
        }
        if (this.selection && !rows.has(this.selection.id)) {
            this.selection = null;
            this.onChange?.(null);
        }
        this.refreshButtons();
    }

    private refreshButtons(): void {
        for (const { button, row } of this.buttons) {
            const count = row.relationIds.length;
            const selected = this.selection?.id === row.id;
            button.disabled = count === 0;
            button.textContent = selected ? 'Rimuovi evidenza'
                : count === 1 ? 'Evidenzia la relazione elencata'
                    : `Evidenzia le ${count} relazioni elencate`;
            button.title = count === 0
                ? 'IPOTESI: la riga non elenca relazioni reali, nessuna evidenza da applicare.'
                : LULL_INQUIRY_HIGHLIGHT_TITLE;
        }
    }

    private chooseRow(row: MountRow): void {
        if (!row.relationIds.length) return;
        this.selection = this.selection?.id === row.id ? null : { kind: row.kind, id: row.id, letters: row.letters, relationIds: row.relationIds };
        this.refreshButtons();
        this.onChange?.(this.selection);
    }
}
