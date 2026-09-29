import test from "node:test";
import assert from "node:assert/strict";
import {
  adjacencyOf,
  communityResolver,
  DENSITIES,
  DENSITY_BUDGETS,
  EXPLORATORY_RESERVE_SHARE,
  formatCount,
  forcedArcIds,
  lodLevelFromZoom,
  manualExpansionTiers,
  LOD_ENTER_INTERMEDIATE,
  LOD_ENTER_NEAR,
  LOD_EXIT_INTERMEDIATE,
  LOD_EXIT_NEAR,
  normalizeDensity,
  refreshCameraAction,
  selectArcs,
  selectNodes,
} from "../../src/review/lod.ts";
import type { LodArcInfo, LodNodeInfo } from "../../src/review/lod.ts";
import { DENSITY_LABEL_BUDGETS, LABEL_BUDGET, labelBudgetOf } from "../../src/review/labels.ts";
import { computeLayout } from "../../src/review/layout-v2.ts";
import type { LayoutEdge, LayoutNode } from "../../src/review/layout-v2.ts";
import { DisclosureHistory, V2_PAGE } from "../../src/review/v2-core.ts";

/** A synthetic two-domain review graph, deterministic and small enough to read:
 *  d0, d1 (domains) → p* (projects) → c* (conversations) → k* (concepts), ids hierarchical. */
type Fixture = {
  nodes: LodNodeInfo[];
  arcs: LodArcInfo[];
  adjacency: Map<string, readonly string[]>;
  communityOf: (id: string) => string;
};

function buildFixture(domains = 2, projectsPerDomain = 3, conversationsPerProject = 8, conceptsPerConversation = 6): Fixture {
  const nodes: LodNodeInfo[] = [];
  const contains: LodArcInfo[] = [];
  const relations: LodArcInfo[] = [];
  let relation = 0;
  const conversations: { id: string; domain: string }[] = [];
  for (let d = 0; d < domains; d++) {
    const domain = { id: `d${d}`, level: 1, parent: null, importance: 1 };
    nodes.push(domain);
    for (let p = 0; p < projectsPerDomain; p++) {
      const project = { id: `d${d}-p${p}`, level: 2, parent: domain.id, importance: 0.7 - p * 0.05 };
      nodes.push(project);
      contains.push({ id: `contains:${project.id}`, source: domain.id, target: project.id, class: "attested", count: 1 });
      for (let c = 0; c < conversationsPerProject; c++) {
        const conversation = { id: `d${d}-p${p}-c${c}`, level: 3, parent: project.id, importance: 0.5 - c * 0.02 };
        nodes.push(conversation);
        contains.push({ id: `contains:${conversation.id}`, source: project.id, target: conversation.id, class: "attested", count: 1 });
        conversations.push({ id: conversation.id, domain: domain.id });
        for (let k = 0; k < conceptsPerConversation; k++) {
          const idea = { id: `${conversation.id}-k${k}`, level: 4, parent: conversation.id, importance: k / 10 };
          nodes.push(idea);
          contains.push({ id: `contains:${idea.id}`, source: conversation.id, target: idea.id, class: "attested", count: 1 });
          if (k === 0)
            relations.push({ id: `r${relation++}`, source: idea.id, target: `d${(d + 1) % domains}-p0-c0`, class: "attested", count: 1 + k });
          if (k === 1)
            relations.push({ id: `x${relation++}`, source: idea.id, target: `d${(d + 1) % domains}-p1-c1`, class: "exploratory", count: 1 });
        }
      }
    }
  }
  const arcs = [...contains, ...relations];
  void conversations;
  return { nodes, arcs, adjacency: adjacencyOf(nodes, arcs), communityOf: communityResolver(nodes) };
}

const baseInput = (fixture: Fixture, level: Parameters<typeof selectNodes>[0]["level"], budget: number, extra: Partial<Parameters<typeof selectNodes>[0]> = {}) => ({
  nodes: fixture.nodes,
  level,
  budget,
  pinned: new Set<string>(),
  focus: null,
  adjacency: fixture.adjacency,
  communityOf: fixture.communityOf,
  ...extra,
});

test("the budgets are respected at each density", () => {
  const fixture = buildFixture(4, 4, 10, 8); // 4 domains, 16 projects, 160 conversations, 1280 concepts
  for (const density of DENSITIES) {
    const budget = DENSITY_BUDGETS[density];
    const nodes = selectNodes(baseInput(fixture, "intermediate", budget.nodes));
    assert.ok(nodes.rendered.length <= budget.nodes, `${density}: ${nodes.rendered.length} <= ${budget.nodes}`);
    const arcs = selectArcs({
      arcs: fixture.arcs.filter(arc => nodes.rendered.includes(arc.source) && nodes.rendered.includes(arc.target)),
      budget: budget.arcs,
      pinned: new Set(),
      focus: null,
      communityOf: fixture.communityOf,
      keepExploratory: true,
    });
    assert.ok(arcs.length <= budget.arcs, `${density}: ${arcs.length} <= ${budget.arcs}`);
    assert.ok(labelBudgetOf(density) <= LABEL_BUDGET);
    assert.equal(labelBudgetOf(density), DENSITY_LABEL_BUDGETS[density]);
  }
  assert.deepEqual(DENSITY_LABEL_BUDGETS, { essential: 20, balanced: 40, complete: 60 });
  assert.deepEqual(
    { ...DENSITY_BUDGETS.balanced },
    { nodes: 400, arcs: 450, labels: 40 },
  );
});

test("hysteresis: small zoom changes inside a band change nothing, crossing the band does", () => {
  // Deep inside far, jitter around the overview: nothing happens.
  let level = lodLevelFromZoom(1.0, "far");
  for (const zoom of [1.08, 0.93, 1.05, 0.97]) level = lodLevelFromZoom(zoom, level);
  assert.equal(level, "far");
  // Inside the intermediate band [1.2, 1.9): the level holds in both directions.
  level = "intermediate";
  for (const zoom of [1.35, 1.55, 1.8, 1.25, 1.5]) level = lodLevelFromZoom(zoom, level);
  assert.equal(level, "intermediate");
  // A notch is about 1.1×: around the middle of the band it can never flip the level.
  for (const start of [1.4, 1.45, 1.5]) {
    let current = lodLevelFromZoom(start, "intermediate");
    current = lodLevelFromZoom(start * 1.12, current);
    current = lodLevelFromZoom(start / 1.12, current);
    assert.equal(current, "intermediate", `zoom ${start}`);
  }
  // Crossing the enter threshold steps up; falling only to the exit threshold steps back down.
  assert.equal(lodLevelFromZoom(LOD_ENTER_INTERMEDIATE, "far"), "intermediate");
  assert.equal(lodLevelFromZoom(LOD_ENTER_INTERMEDIATE - 0.01, "far"), "far");
  assert.equal(lodLevelFromZoom(LOD_EXIT_INTERMEDIATE + 0.01, "intermediate"), "intermediate");
  assert.equal(lodLevelFromZoom(LOD_EXIT_INTERMEDIATE - 0.01, "intermediate"), "far");
  assert.equal(lodLevelFromZoom(LOD_ENTER_NEAR, "intermediate"), "near");
  assert.equal(lodLevelFromZoom(LOD_ENTER_NEAR - 0.01, "intermediate"), "intermediate");
  assert.equal(lodLevelFromZoom(LOD_EXIT_NEAR + 0.01, "near"), "near");
  assert.equal(lodLevelFromZoom(LOD_EXIT_NEAR - 0.01, "near"), "intermediate");
  // A zoom sequence that wanders inside the near band and comes back never leaves it.
  let near = lodLevelFromZoom(5, "intermediate");
  for (const zoom of [4.2, 3.6, 4.9, 3.3, 4.4]) near = lodLevelFromZoom(zoom, near);
  assert.equal(near, "near");
});

test("coordinates are stable for nodes that stay visible across density and level changes", () => {
  const fixture = buildFixture(2, 3, 6, 5);
  // The page lays the whole disclosed set out once and the LOD is a pure filter over those
  // positions, so a node visible at two densities keeps the same coordinates by construction.
  const layoutNodes: LayoutNode[] = fixture.nodes.map(node => ({
    id: node.id, level: node.level as 1 | 2 | 3 | 4 | 5, parent: node.parent, size: 0.3, domains: [],
  }));
  const edges: LayoutEdge[] = fixture.arcs.map(arc => ({ id: arc.id, source: arc.source, target: arc.target, class: arc.class }));
  const positions = new Map(computeLayout({ nodes: layoutNodes, edges, organization: "natural", morphology: "stellar" }).positions);
  const atEssential = new Set(selectNodes(baseInput(fixture, "far", DENSITY_BUDGETS.essential.nodes)).rendered);
  const atComplete = new Set(selectNodes(baseInput(fixture, "intermediate", DENSITY_BUDGETS.complete.nodes)).rendered);
  const staying = [...atEssential].filter(id => atComplete.has(id));
  assert.ok(staying.length > 0);
  // The layout's incremental stability: re-running with the previous positions as seeds returns
  // every existing coordinate unchanged, whatever subset a later pass renders.
  for (const morphology of ["stellar", "mycelium"] as const) {
    const second = computeLayout({ nodes: layoutNodes, edges, organization: "natural", morphology, previous: positions });
    for (const id of staying) {
      assert.deepEqual(second.positions.get(id), positions.get(id), `${morphology}: ${id} must not move`);
    }
  }
});

test("arc priority order: selected and focus, bridges, attested by weight, exploratory last", () => {
  const communityOf = communityResolver([
    { id: "a", level: 1, parent: null },
    { id: "b", level: 1, parent: null },
    { id: "a1", level: 3, parent: "a" },
    { id: "a2", level: 3, parent: "a" },
    { id: "a3", level: 3, parent: "a" },
    { id: "b1", level: 3, parent: "b" },
    { id: "b2", level: 3, parent: "b" },
  ]);
  // Only bridge-min touches the focus a1; the inner arcs stay among a2/a3 and b1/b2.
  const arcs: LodArcInfo[] = [
    { id: "pinned", source: "a2", target: "a3", class: "attested", count: 1 },
    { id: "bridge-min", source: "a1", target: "b1", class: "attested", count: 1 },
    { id: "bridge-heavy", source: "a2", target: "b2", class: "attested", count: 9 },
    { id: "bridge-light", source: "a3", target: "b2", class: "attested", count: 2 },
    { id: "inner-heavy", source: "a2", target: "a3", class: "attested", count: 8 },
    { id: "inner-light", source: "b1", target: "b2", class: "attested", count: 3 },
    { id: "exp-1", source: "b1", target: "b2", class: "exploratory", count: 4 },
    { id: "exp-2", source: "a2", target: "a3", class: "exploratory", count: 1 },
  ];
  // Pinned first, then the focus relation, then bridges by weight.
  const chosen = selectArcs({ arcs, budget: 4, pinned: new Set(["pinned"]), focus: "a1", communityOf, keepExploratory: false });
  assert.deepEqual(chosen, ["pinned", "bridge-min", "bridge-heavy", "bridge-light"]);
  // Without pinning or focus, bridges precede weightier inner attested arcs.
  const ranked = selectArcs({ arcs, budget: 3, pinned: new Set(), focus: null, communityOf, keepExploratory: false });
  assert.deepEqual(ranked, ["bridge-heavy", "bridge-light", "bridge-min"]);
  // The exploratory reserve: in the exploratory reading the weightier exploratory arc survives
  // while the lowest-priority non-bridge attested arc gives way; bridges never do.
  const exploratory = selectArcs({ arcs, budget: 5, pinned: new Set(), focus: null, communityOf, keepExploratory: true });
  assert.equal(exploratory.filter(id => id.startsWith("exp")).length, Math.min(2, Math.floor(5 * EXPLORATORY_RESERVE_SHARE)));
  assert.ok(exploratory.includes("exp-1"), "the weightier exploratory arc survives");
  assert.ok(exploratory.includes("bridge-heavy"), "bridges are never the ones giving way");
  assert.ok(!exploratory.includes("inner-light"), "the lightest non-bridge attested arc gave way");
});

test("an explicit pinned set and selection path survive a tight budget", () => {
  const fixture = buildFixture(2, 3, 6, 5);
  // The selector keeps the caller's explicit pins; the page bounds that caller set separately.
  const expandedChildren = new Set(fixture.nodes.filter(n => n.parent === "d0-p0").map(n => n.id));
  const selected = "d0-p0-c1-k2";
  const ancestors = ["d0", "d0-p0", "d0-p0-c1"];
  const pinned = new Set<string>([...expandedChildren, selected, ...ancestors]);
  const chosen = selectNodes(baseInput(fixture, "far", 6, { pinned }));
  const rendered = new Set(chosen.rendered);
  for (const id of pinned) assert.ok(rendered.has(id), `${id} must stay visible`);
  assert.equal(chosen.rendered.length, pinned.size, "beyond the budget only the explicit set remains");
  assert.ok(!rendered.has("d1-p0-c0"), "nothing beyond the explicit set is admitted");
  // Arcs: the selected relation and the contains path of the selection survive a zero-filling budget.
  const arcPinned = new Set([`contains:${selected}`, "contains:d0-p0-c1", "contains:d0-p0"]);
  const arcs = selectArcs({
    arcs: fixture.arcs,
    budget: arcPinned.size,
    pinned: arcPinned,
    focus: selected,
    communityOf: fixture.communityOf,
    keepExploratory: false,
  });
  for (const id of arcPinned) assert.ok(arcs.includes(id), `${id} must stay drawn`);
});

test("only explicit arc pins are forced beyond the budget", () => {
  const arcs: LodArcInfo[] = [
    { id: "pinned-path", source: "root", target: "expanded", class: "attested", count: 1 },
    { id: "expanded-child", source: "expanded", target: "child", class: "attested", count: 1 },
    { id: "focus-in", source: "focus", target: "other-a", class: "attested", count: 1 },
    { id: "focus-out", source: "other-b", target: "focus", class: "attested", count: 1 },
    { id: "ordinary", source: "other-a", target: "other-b", class: "attested", count: 20 },
  ];
  const input = {
    arcs,
    budget: 1,
    pinned: new Set(["pinned-path", "expanded-child", "missing"]),
    focus: "focus",
    communityOf: (_id: string) => "one",
    keepExploratory: false,
  };
  const forced = forcedArcIds(input);
  assert.deepEqual(forced, ["expanded-child", "pinned-path"]);
  const selected = selectArcs(input);
  assert.deepEqual(selected, forced, "only explicit pins survive beyond the budget");
  assert.equal(selected.length, 2);
});

test("twenty manual expansions pin one page and prioritize earlier children", () => {
  const fixture = buildFixture(4, 4, 10, 8);
  const history = new DisclosureHistory();
  const parents = fixture.nodes.filter(node => node.level === 3).slice(0, 20).map(node => node.id);
  for (const id of parents) history.expand(id);
  const tiers = manualExpansionTiers(fixture.nodes, history.state.manualOrder, V2_PAGE);
  const selected = `${parents[0]}-k0`;
  const path = [selected, parents[0]!, parents[0]!.slice(0, parents[0]!.lastIndexOf("-")), parents[0]!.slice(0, 2)];
  const pins = new Set([...tiers.pinnedContainers, ...tiers.pinnedChildren, ...path]);
  assert.ok(pins.size <= V2_PAGE + parents.length + path.length);
  assert.deepEqual(tiers.pinnedChildren, fixture.nodes.filter(node => node.parent === parents.at(-1))
    .sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id)).map(node => node.id));
  const sizes: number[] = [];
  for (const density of DENSITIES) {
    const budget = DENSITY_BUDGETS[density].nodes;
    const chosen = selectNodes(baseInput(fixture, "intermediate", budget, { pinned: pins, priority: tiers.priorityChildren }));
    const rendered = new Set(chosen.rendered);
    sizes.push(rendered.size);
    assert.ok(rendered.size <= budget + pins.size);
    for (const id of tiers.pinnedChildren) assert.ok(rendered.has(id), `recent child ${id}`);
    for (const id of tiers.priorityChildren.slice(0, Math.max(0, budget - pins.size)))
      assert.ok(rendered.has(id), `earlier child ${id} leads the fill`);
    const pool = fixture.arcs.filter(arc => rendered.has(arc.source) && rendered.has(arc.target));
    const arcPins = new Set(tiers.pinnedChildren.map(id => `contains:${id}`));
    const arcs = selectArcs({ arcs: pool, budget: DENSITY_BUDGETS[density].arcs, pinned: arcPins,
      focus: null, priority: tiers.priorityChildren.map(id => `contains:${id}`),
      communityOf: fixture.communityOf, keepExploratory: false });
    assert.ok(arcs.length <= DENSITY_BUDGETS[density].arcs + arcPins.size);
    for (const id of arcPins) assert.ok(arcs.includes(id), `recent arc ${id}`);
    const earlierAvailable = tiers.priorityChildren.map(id => `contains:${id}`)
      .filter(id => pool.some(arc => arc.id === id));
    for (const id of earlierAvailable.slice(0, Math.max(0, DENSITY_BUDGETS[density].arcs - arcPins.size)))
      assert.ok(arcs.includes(id), `earlier arc ${id} leads the fill`);
  }
  assert.ok(sizes[0]! < sizes[1]! && sizes[1]! < sizes[2]!, `strict density sizes: ${sizes}`);
  assert.deepEqual(sizes, [150, 400, 850]);
  history.undo();
  assert.equal(history.state.manualOrder.at(-1), parents.at(-2));
  history.redo();
  assert.equal(history.state.manualOrder.at(-1), parents.at(-1));
});

test("the newest expansion pins at most sixty children by importance then id", () => {
  const parent: LodNodeInfo = { id: "container", level: 3, parent: null, importance: 1 };
  const children: LodNodeInfo[] = Array.from({ length: 80 }, (_, i) => ({
    id: `child-${String(i).padStart(2, "0")}`, level: 4, parent: parent.id,
    importance: i % 2,
  }));
  const tiers = manualExpansionTiers([parent, ...children.toReversed()], [parent.id], V2_PAGE);
  const expected = [...children].sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id)).slice(0, V2_PAGE);
  assert.deepEqual(tiers.pinnedChildren, expected.map(node => node.id));
  assert.deepEqual(tiers.priorityChildren, []);
});

test("the near level shows the focus neighbourhood before global principals", () => {
  const fixture = buildFixture(2, 3, 6, 5);
  const focus = "d1-p1-c2-k3";
  const near = selectNodes(baseInput(fixture, "near", 60, { focus }));
  const intermediate = selectNodes(baseInput(fixture, "intermediate", 60, { focus }));
  const rendered = new Set(near.rendered);
  // Two hops out of the focus: the family around it is in, ahead of unrelated communities.
  assert.ok(rendered.has(focus));
  assert.ok(rendered.has("d1-p1-c2"), "the parent conversation is in the neighbourhood");
  assert.ok(rendered.has("d1-p1-c2-k2"), "a sibling concept is one hop out");
  const nearSet = new Set(near.rendered);
  const interSet = new Set(intermediate.rendered);
  assert.ok(nearSet.size <= 60 && interSet.size <= 60);
  assert.ok(near.dropped.every(id => !nearSet.has(id)));
});

test("deterministic: the same inputs in a different order give the same rendered sets", () => {
  const fixture = buildFixture(3, 3, 6, 4);
  const shuffledNodes = [...fixture.nodes].reverse();
  const shuffledArcs = [...fixture.arcs].reverse();
  const first = selectNodes(baseInput(fixture, "intermediate", 80));
  const second = selectNodes(baseInput({ ...fixture, nodes: shuffledNodes }, "intermediate", 80));
  assert.deepEqual(second.rendered, first.rendered);
  const arcsFirst = selectArcs({ arcs: fixture.arcs, budget: 30, pinned: new Set(), focus: null, communityOf: fixture.communityOf, keepExploratory: true });
  const arcsSecond = selectArcs({ arcs: shuffledArcs, budget: 30, pinned: new Set(), focus: null, communityOf: fixture.communityOf, keepExploratory: true });
  assert.deepEqual(arcsSecond, arcsFirst);
  // Communities resolve along the parent chain only.
  assert.equal(fixture.communityOf("d1-p2-c3-k3"), "d1");
  assert.equal(fixture.communityOf("d1"), "d1");
});

test("normalizeDensity and formatCount", () => {
  assert.equal(normalizeDensity("essential"), "essential");
  assert.equal(normalizeDensity("bogus"), "balanced");
  assert.equal(normalizeDensity(undefined, "complete"), "complete");
  assert.equal(formatCount(1200), "1.200");
  assert.equal(formatCount(3900), "3.900");
  assert.equal(formatCount(12345), "12.345");
  assert.equal(formatCount(42), "42");
});

test("refreshCameraAction: a density or level refresh never refits", () => {
  const base = { hasCamera: true, keep: true, boundsChanged: true, userMoved: false };
  // The same scene — same disclosed ids, arrangement, morphology — restores even when the
  // rendered subset's extents jitter enough to look like a bounds change.
  assert.equal(refreshCameraAction({ ...base, sceneUnchanged: true }), "restore");
  assert.equal(refreshCameraAction({ ...base, userMoved: true, sceneUnchanged: true }), "restore");
  // Genuinely new bounds the user did not move past still refit; a user gesture restores.
  assert.equal(refreshCameraAction({ ...base, sceneUnchanged: false }), "refit");
  assert.equal(refreshCameraAction({ ...base, userMoved: true, sceneUnchanged: false }), "restore");
  // Unchanged bounds restore; another arrangement keeps the mount-solved camera; no camera at
  // all means there is nothing to do.
  assert.equal(refreshCameraAction({ ...base, boundsChanged: false, sceneUnchanged: false }), "restore");
  assert.equal(refreshCameraAction({ ...base, keep: false, boundsChanged: false, sceneUnchanged: false }), "none");
  assert.equal(refreshCameraAction({ hasCamera: false, keep: true, boundsChanged: true, userMoved: false, sceneUnchanged: false }), "none");
});
