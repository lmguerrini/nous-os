// D084-W3-LABELS BEGIN: short English selector names and a rigorous
// mathematical classification. The selector shows exactly the short names; the extended
// technical names and the classification stay in the tooltips/legend explanations; nothing
// groups Canopy, Julia, Sierpiński and Llull under «IFS» or «Fractal».
// The contract is asserted on the real surfaces — the Canopy route's overlay, notices,
// pending/refusal status, static controls, both legend surfaces and the repository document.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { TopologyDimension, TopologyId } from '../src/topology/contract.ts';
import { LAB_CONTAINER_DESCRIPTION, TOPOLOGY_DESCRIPTIONS, TOPOLOGY_IDS, topologyLabel,
  topologyTooltip } from '../src/topology/registry.ts';
import { renderFlowLegend } from '../src/review/legend.ts';
import { resolveExperimentalOrganization } from '../src/review/view-contract.ts';
import type { PaletteValues } from '../src/review/palette.ts';

const dimensions: readonly TopologyDimension[] = ['2d', '3d'];
/** Strings forbidden in the selector and in any label playing the selector's role. */
const FORBIDDEN_IN_SELECTOR = [
  'Albero frattale',
  'Canopy IFS',
  'Julia coordinate esterne', 'Julia · coordinate esterne',
  'Sierpiński gasket triangolare', 'Sierpiński · gasket triangolare',
  'Combinatoria lulliana',
] as const;
/** The classification sentence every tooltip/legend entry must carry. */
const CLASSIFICATION: Readonly<Record<TopologyId, RegExp>> = {
  natural: /^Natural — /,
  'canopy-ifs': /fractal tree generated through an Iterated Function System/,
  julia: /complex dynamical system/,
  sierpinski: /affine Iterated Function System/,
  lull: /combinatorial topology governed by the verified Llullian nine-domain rule; not a fractal and not an IFS/,
};

test('the topology selector shows exactly the short English names in both dimensions', () => {
  assert.deepEqual([...TOPOLOGY_IDS], ['natural', 'canopy-ifs', 'julia', 'sierpinski', 'lull']);
  const expected: readonly string[] = ['Natural', 'Canopy', 'Julia', 'Sierpiński', 'Llull'];
  for (const dimension of dimensions) {
    assert.deepEqual(TOPOLOGY_IDS.map(id => topologyLabel(id, dimension)), expected);
  }
});

test('no forbidden string reaches a selector label or a selector tooltip', () => {
  for (const dimension of dimensions) {
    for (const id of TOPOLOGY_IDS) {
      const label = topologyLabel(id, dimension);
      const tooltip = topologyTooltip(id, dimension);
      for (const forbidden of FORBIDDEN_IN_SELECTOR) {
        assert.ok(!label.includes(forbidden), `${id} label carries «${forbidden}»: ${label}`);
        assert.ok(!tooltip.includes(forbidden), `${id} tooltip carries «${forbidden}»: ${tooltip}`);
      }
      assert.ok(!tooltip.startsWith('Vista Fractal'), `${id} tooltip groups the lab under «Fractal»`);
    }
  }
});

test('every tooltip/legend entry keeps the full name and its classification sentence', () => {
  for (const id of TOPOLOGY_IDS) {
    for (const dimension of dimensions) {
      const tooltip = topologyTooltip(id, dimension);
      assert.match(tooltip, CLASSIFICATION[id], `${id} tooltip misses its classification: ${tooltip}`);
      // The full name leads the entry; the short selector name is its first word.
      assert.ok(tooltip.startsWith(topologyLabel(id, dimension)), tooltip);
    }
  }
});

test('Julia is a complex dynamical system and is never classified primarily as an IFS', () => {
  for (const dimension of dimensions) {
    const tooltip = topologyTooltip('julia', dimension);
    assert.match(tooltip, /complex dynamical system/);
    assert.doesNotMatch(tooltip, /Iterated Function System/);
    assert.match(tooltip, /not classified primarily as an IFS/);
  }
  // The 3D lift stays explained as a scalar potential, never as a 3D Julia set.
  assert.match(topologyTooltip('julia', '3d'), /potenziale esterno G/);
  assert.match(topologyTooltip('julia', '3d'), /non un insieme di Julia 3D/);
});

test('Llull is a combinatorial topology — not a fractal and not an IFS', () => {
  assert.match(TOPOLOGY_DESCRIPTIONS.lull, /not a fractal and not an IFS/);
  assert.doesNotMatch(TOPOLOGY_DESCRIPTIONS.lull, /fractal tree|Iterated Function System \(IFS\)\./);
});

test('Sierpiński keeps the affine-IFS classification and its extended technical names as explanation', () => {
  assert.match(TOPOLOGY_DESCRIPTIONS.sierpinski, /affine Iterated Function System/);
  assert.match(TOPOLOGY_DESCRIPTIONS.sierpinski, /gasket triangolare/);
  assert.match(TOPOLOGY_DESCRIPTIONS.sierpinski, /polvere di tetraedro/);
});

test('Canopy keeps the IFS-generated fractal-tree classification as explanation', () => {
  assert.match(TOPOLOGY_DESCRIPTIONS['canopy-ifs'], /fractal tree generated through an Iterated Function System/);
});

test('the lab container states that it holds topologies of different families', () => {
  assert.match(LAB_CONTAINER_DESCRIPTION, /famiglie differenti/);
  assert.match(LAB_CONTAINER_DESCRIPTION, /sistema dinamico complesso/);
  assert.match(LAB_CONTAINER_DESCRIPTION, /topologia combinatoria/);
});

test('the selector wiring uses the tooltip classification, not the law label', async () => {
  const main = await readFile(new URL('../src/review/main.ts', import.meta.url), 'utf8');
  // The selector button's resting tooltip is the full classification, the visible text the
  // short name; a refusal reason still wins (it explains the disabled state).
  assert.match(main, /button\.title = reason \?\? topologyTooltip\(topology, axes\.projection\);/);
  assert.match(main, /label\.title = LAB_CONTAINER_DESCRIPTION;/);
  // The lab notice for Canopy carries the short name and never the «Fractal» grouping.
  assert.doesNotMatch(main, /Vista Fractal/);
  assert.doesNotMatch(main, /Canopy IFS/);
  assert.match(main, /'Canopy · sistema di funzioni iterate \(IFS\) sperimentale · geometria derivata, non semantica'/);
  // Non-canopy topologies describe themselves with the classification tooltip.
  assert.match(main, /: topologyTooltip\(topology, axes\.projection\)\);/);
});

test('the canopy witness names the topology with the short name and explains the IFS', async () => {
  for (const file of ['../src/topology/canopy-law.ts', '../src/review/v2-page.ts']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /law: 'Canopy IFS'/);
    assert.match(source, /law: 'Canopy'/);
    assert.match(source, /sistema di funzioni iterate \(IFS\)/);
  }
});

test('the static container tooltips declare the different families and carry no forbidden name', async () => {
  const html = await readFile(new URL('../review/index.html', import.meta.url), 'utf8');
  const containerTitles = [...html.matchAll(/<div class="axis" data-axis="organization" title="([^"]+)"><strong>Topologia<\/strong>/g)];
  assert.equal(containerTitles.length, 1);
  assert.match(containerTitles[0]![1]!, /famiglie differenti/);
  const fullscreenTitles = [...html.matchAll(/class="fullscreen-group-label" title="([^"]+)">Topologia</g)];
  assert.equal(fullscreenTitles.length, 1);
  assert.match(fullscreenTitles[0]![1]!, /famiglie differenti/);
  for (const forbidden of FORBIDDEN_IN_SELECTOR) {
    assert.ok(!html.includes(forbidden), `index.html carries «${forbidden}»`);
  }
});

// D084-W3-LABELS R2 BEGIN: the audit's F1/F2/F3 — the contract holds on the surfaces the user
// actually sees (overlay ARIA name, notices, pending/refusal status, static controls, both
// legend surfaces, documentation), not only in the registry strings.

test('the canopy overlay publishes its accessible name as Canopy, never Fractal', async () => {
  const source = await readFile(new URL('../src/fractal/renderer-adapter.ts', import.meta.url), 'utf8');
  assert.match(source, /aria-label', 'Spiegazione della vista Canopy'/);
  assert.doesNotMatch(source, /aria-label[^;]*Fractal/);
});

test('the Canopy route publishes no «Fractal» identity in notices, pending or refusal status', async () => {
  const page = await readFile(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');
  // The disclosure the lab notice receives names the selector-facing view.
  assert.match(page, /return `Vista Canopy (?:·|\\u00B7) posizioni derivate dai raggi esterni inversi/);
  assert.doesNotMatch(page, /Vista Fractal/);
  // Pending and refusal status lines name Canopy; no call site passes the legacy name.
  assert.doesNotMatch(page, /showProjectionRefusal\('Fractal'/);
  assert.doesNotMatch(page, /setProjectionPending\((?:[^)]*)'Fractal'/);
  assert.match(page, /private setProjectionPending\(pending: boolean, view = 'Canopy'/);
  assert.match(page, /showProjectionRefusal\('Canopy',/);
  assert.match(page, /setProjectionPending\(true, 'Canopy', epoch\)/);
});

test('the page boot and toolbar carry no residual Fractal display label on the Canopy route', async () => {
  const main = await readFile(new URL('../src/review/main.ts', import.meta.url), 'utf8');
  // The suspended legacy deep link names the view the selector shows.
  assert.match(main, /suspendedIntent === 'fractal' \? 'Canopy' : 'Holographic'/);
  // The toolbar summary's organization row is gone; the topology line comes from the lab register.
  assert.doesNotMatch(main, /organization: \{ natural: "Natural", indra: "Indra", fractal: "Fractal"/);
  assert.doesNotMatch(main, /Vista Fractal/);
});

test('the static experimental controls of both placements carry Canopy and its classification', async () => {
  const html = await readFile(new URL('../review/index.html', import.meta.url), 'utf8');
  // The whole static document is free of the exposed «Fractal» display name; the legacy
  // internal value survives only as the button's data-value.
  assert.ok(!html.includes('Fractal'), 'index.html still exposes the «Fractal» display name');
  const expected = /<button data-value="fractal" hidden title="Canopy · fractal tree generated through an Iterated Function System \(IFS\) · vista sperimentale">Canopy · sperimentale<\/button>/g;
  assert.equal([...html.matchAll(expected)].length, 2, 'toolbar and fullscreen templates must both carry the Canopy control');
});

/** A minimal element double: `renderFlowLegend` only replaces, appends, sets classes,
 * datasets, titles and SVG attributes, so the legend can be rendered and read in Node. */
class LegendElement {
  tagName: string;
  className = '';
  textContent = '';
  title = '';
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: LegendElement[] = [];
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  append(...nodes: (LegendElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') this.textContent += node;
      else this.children.push(node);
    }
  }
  prepend(node: LegendElement): void { this.children.unshift(node); }
  replaceChildren(): void { this.children = []; this.textContent = ''; }
}
const legendDocument = {
  createElement: (tagName: string) => new LegendElement(tagName),
  createElementNS: (_ns: string, tagName: string) => new LegendElement(tagName),
};
const legendPalette = {
  attested: '#cccccc', exploratory: '#cccccc', container: '#cccccc', selection: '#cccccc',
} as PaletteValues;
const CLASSIFICATION_KINDS: readonly string[] = ['container', 'canopy-ifs', 'julia', 'sierpinski', 'lull'];
/** The legend entries of one rendered flow legend: [dataset entry kind, title/text]. */
function renderedLegendEntries(topology: TopologyId | null): { kind: string; text: string }[] {
  const previous = globalThis.document;
  Object.assign(globalThis, { document: legendDocument });
  try {
    const host = new LegendElement('div');
    renderFlowLegend(host as unknown as HTMLElement, legendPalette, 'natural', topology);
    return host.children.map(entry => ({
      kind: entry.dataset.topologyClassification ?? entry.dataset.flowLegendEntry ?? entry.tagName,
      // The classification entries set their own text; the flow rows keep the label in a span.
      text: entry.textContent || entry.children.map(child => child.textContent).join(''),
    }));
  } finally { Object.assign(globalThis, { document: previous }); }
}

test('the legend surfaces render the lab classification while a lab topology governs the view', () => {
  for (const topology of ['canopy-ifs', 'julia', 'sierpinski', 'lull'] as const) {
    const entries = renderedLegendEntries(topology);
    const classification = entries.filter(entry => CLASSIFICATION_KINDS.includes(entry.kind));
    assert.ok(classification.some(entry => entry.kind === 'container' && entry.text === LAB_CONTAINER_DESCRIPTION),
      `${topology}: the legend opens with the different-families line`);
    for (const id of ['canopy-ifs', 'julia', 'sierpinski', 'lull'] as const)
      assert.ok(classification.some(entry => entry.kind === id && entry.text === TOPOLOGY_DESCRIPTIONS[id]),
        `${topology}: the legend carries the ${id} classification sentence`);
    // The four families are never collapsed into one: each sentence keeps its own entry.
    assert.equal(classification.length, 5, `${topology}: one container line plus four sentences`);
  }
  // Outside the Geometry Lab — classic Natural and the legacy analytical view — the plain flow
  // legend is unchanged, so those states keep their pixels.
  for (const topology of [null, 'natural'] as const) {
    const entries = renderedLegendEntries(topology);
    assert.ok(entries.every(entry => entry.kind !== 'container'), `${String(topology)}: no classification block`);
    assert.ok(entries.some(entry => entry.text === 'Relazione attestata'), `${String(topology)}: the flow legend is intact`);
  }
});

test('both legend mounts are wired to the lab taxonomy', async () => {
  const [main, page, legend, css] = await Promise.all([
    readFile(new URL('../src/review/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/review/legend.ts', import.meta.url), 'utf8'),
    readFile(new URL('../review/index.html', import.meta.url), 'utf8'),
  ]);
  // The legend code that renders both surfaces (the panel «Legenda» section and the fullscreen
  // legend card) is src/review/legend.ts; the classification block is part of renderFlowLegend.
  assert.match(legend, /appendTopologyClassification\(host, topology\);/);
  assert.match(legend, /entry\.dataset\.topologyClassification = kind;/);
  // The fullscreen legend and every panel box re-render with the active topology, and a
  // taxonomy switch refreshes them.
  assert.match(main, /renderFlowLegend\(fullscreen, palette, organization, topology\);/);
  assert.match(main, /const topology = 'mode' in geometry \? null : lawTopology\(geometry\.topology\);/);
  assert.match(main, /refreshFlowLegends\(\);\n  \/\/ D084-W3-LABELS END\n  \/\/ D082-B-NOTICE BEGIN/);
  assert.match(main, /appendFlowLegend\(details, activePalette\(\), axes\.organization === "indra" \? "indra" : "natural",\n    'mode' in geometry \? null : lawTopology\(geometry\.topology\)\);/);
  assert.match(page, /appendFlowLegend\(host, this\.palette, this\.axes\.organization === 'indra' \? 'indra' : 'natural', this\.topology\);/);
  // The classification entries wrap, so the fullscreen card stays a compact corner overlay.
  assert.match(css, /\.flow-legend-entry\[data-topology-classification\] \{[^}]*max-width:340px/);
});

test('the repository documents the four names, their classification and the different-families note', async () => {
  const document_ = await readFile(new URL('../../docs/views/GEOMETRY-LAB.md', import.meta.url), 'utf8');
  for (const id of ['canopy-ifs', 'julia', 'sierpinski', 'lull'] as const) {
    assert.ok(document_.includes(TOPOLOGY_DESCRIPTIONS[id]), 'classification sentence present: ' + id);
  }
  assert.match(document_, /topologies of different families/);
  assert.match(document_, /not a fractal and \*?not\*? an IFS|not a fractal and not an IFS/);
  assert.match(document_, /not classified primarily as an IFS/);
  assert.match(document_, /Canopy, Julia, Sierpiński, Llull/);
  // A public document: no local paths, no private handoff vocabulary.
  assert.ok(!document_.includes('/Users/'), 'no local absolute paths');
  assert.ok(!document_.includes('private-workspace'), 'no private handoff vocabulary');
  assert.ok(!/D0\d{2}/.test(document_), 'no internal cycle identifiers');
});
// D084-W3-LABELS R2 END

// D084-W3-LABELS BEGIN: the public `setAxes`
// fallback for an unflagged legacy organization reaches the visible lab notice, so it must name the
// view as the selector does and never the legacy identity.
test('the unflagged legacy organization fallback names Canopy in its visible notice', () => {
  const resolved = resolveExperimentalOrganization('fractal', new Set());
  assert.equal(resolved.organization, 'natural');
  assert.match(resolved.notice ?? '', /^Canopy è una vista sperimentale: caricata Natural\./);
  assert.doesNotMatch(resolved.notice ?? '', /Fractal/);
  assert.equal(resolveExperimentalOrganization('fractal', new Set(['fractal'] as const)).notice, null);
});
// D084-W3-LABELS END

// D084-W3-LABELS BEGIN: the public error and refusal
// texts of the legacy organization key, the Canopy status limit and the Canopy explanation all name
// the view «Canopy»; no user-facing string literal in these modules names «Fractal».
test('public errors, refusals, the status limit and the explanation name Canopy, never Fractal', async () => {
  const main = await readFile(new URL('../src/review/main.ts', import.meta.url), 'utf8');
  assert.match(main, /const viewLabel = \(organization: "fractal" \| "holographic"\) => organization === "fractal" \? "Canopy" : "Holographic";/);
  for (const file of ['../src/review/main.ts', '../src/fractal/explain.ts', '../src/fractal/canopy-status.ts', '../src/review/view-contract.ts']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const code = source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join('\n');
    const literals = [...code.matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g)].map(match => match[0]);
    assert.deepEqual(literals.filter(text => /\bFractal\b/.test(text)), [], file + ': no user-facing «Fractal»');
  }
});
// D084-W3-LABELS END
