# Gallery and measurements

The gallery uses the synthetic demo dataset, whose content is invented. Seed 1 of the `reference` profile produces the dataset digest recorded in the manifest; the profile's counts are illustrative except for its fixed node total and root-domain count. Captures use the page's fullscreen view, where only the NousOS title stays visible at the top left; node labels, panels, tooltips, selections and controls are hidden. Each capture waits for the renderer to stabilise before the image is saved. Each pair is captured in the same page session and orientation; each density is framed on its own nodes. Balanced has its own layout, 7–10× more compact than Complete in these captures, measured from the manifest's layout bounds, so an identical camera would show it as a small cluster. Both camera states are recorded in the manifest.

Every capture in the README except Julia 3D is framed by measurement. The capture tool reads each drawn node's position from the page, takes the bounds of the subject's nodes (the whole graph for an overview, one cluster for a close-up; the background stars are not nodes), and moves the camera through the page's own camera state until those bounds are centred and fill the target share of the frame's limiting dimension: 85% for the overviews and 70% for the 2D close-ups. In 3D the bounds use node centres, because a node near the camera can report a footprint larger than what is drawn. Sierpiński 3D, whose outline reaches well beyond its nodes, is framed on its visible structure instead: nodes, relations and outline in a screenshot of the page, with the stars, the background glow and the title left out. After each fit and each camera change the capture tool makes one wheel step in and one out at the centre of the frame, which returns the camera to the same place and makes the page redraw the topology guides. This is a workaround in the capture tool only: the page itself still has the guide-placement limit listed in [Verification and limits](VERIFICATION-AND-LIMITS.md#known-limits). A cluster is the set of nodes that descend from one root domain in the hierarchy, which is how the page groups them. At Balanced a cluster's nodes are spread across the compact Balanced layout, so the 2D close-ups use Custom with 2,000 nodes (2,000 nodes and 2,947 drawn edges in the view): the d1 cluster with all 144 of its nodes, and the d8 cluster with all 187. Julia 3D is tilted by a short downward drag and brought three wheel steps closer than the fitted view (×1.16): its relation bundles become visible only that close, and the tilt keeps the whole figure within about 87% of the frame's height. A separate check on the saved images measures what is drawn, meaning nodes, relations and visible guides without the stars, the background glow or the title: in all twelve overviews it fills 80–88% of the frame's limiting dimension, with its centre within 2% of the frame's centre. The records of the captures shown in the README hold their density, counts and camera, and the framed ones also their framing measurement; the captures that the README does not show keep their earlier records. The renders stabilised before each capture; nothing is cropped or enlarged.

## Density counts

In Natural 2D, the gallery manifest records 80 / 11,199 nodes for Essential, 400 / 11,199 for Balanced, and 11,199 / 11,199 for Complete. Complete draws every node.

## Recorded render times

`completeMs` measures time from a fresh page until the renderer's readiness status reports Complete, meaning every requested node and edge is drawn at full quality. Captures were measured on one machine and browser: headless Chromium 151 (ANGLE Metal backend) on an Apple-silicon Mac (darwin arm64). These measurements do not characterize other machines or browsers.

| Gallery view | Time to Complete |
|---|---:|
| Natural · 2D | 4.5 s |
| Natural · 3D | 3.1 s |
| Canopy · 2D | 2.5 s |
| Canopy · 3D | 2.6 s |
| Sierpiński · 2D | 3.6 s |
| Sierpiński · 3D | 2.8 s |
| Llull · 2D | 3.1 s |
| Llull · 3D | 2.7 s |
| Julia · 2D | 5.2 s |
| Julia · 3D | 4.8 s |
| Neural · 3D · Brain | 7.2 s |
| Mycelium · 2D | 5.6 s |
| Exploratory · 3D | 2.7 s |
| Natural · 2D · Essential | 1.5 s |
| Natural · 2D · Balanced | 1.6 s |
| Whole page | 3.2 s |

In the paired captures, switching the same page from Complete to Balanced reached Complete readiness (every requested node and edge drawn at full quality) in 1.5 s (2D) and 0.8 s (3D). Canopy, Sierpiński, Llull and Julia are experimental Geometry Lab topologies.

## Node-size coherence matrix

The matrix samples node sizes in a browser on the synthetic demo dataset across five topologies × three morphologies × 2D/3D × Indra on/off: 60 configurations, with 5 to 21 sampled nodes each. Every configuration reached Complete. Node size is taken from the complete layout at every density preset (Essential, Balanced, Complete, Custom), with an identical camera. In 46 of 60 configurations, every sampled node stayed within 1% of its Complete radius across presets. Exceptions:

- 2D Canopy without Indra: sparse presets draw nodes up to about twice their Complete size.
- 3D Sierpiński, Llull and Canopy, Stellar with Indra: up to 23%.
- 2D Natural and 2D Canopy with Indra: one sampled node each, up to 57% and 11%.
- 3D Natural Stellar without Indra: up to 7.7% in drawn size; the node keeps its size, but each density's layout places it at a different depth.
- 2D Natural Mycelium without Indra: 1.4%.

In the same matrix, 440 of 561 sampled clicks (78%) selected the intended node; in dense views a click can select a neighbouring node. These are measurements of this synthetic demo matrix, not general guarantees.

See [`assets/gallery/MANIFEST.json`](assets/gallery/MANIFEST.json) for capture metadata and layout bounds.

## Topology, morphology, and density behavior

Topology determines where nodes are placed; morphology determines how nodes and edges are drawn. All five topologies support both dimensions. **Natural** deterministically arranges the primary hierarchy around root domains. **Canopy** uses an iterated function system (IFS) tree with curved rails. **Sierpiński** uses an affine IFS: a triangular gasket in 2D and tetrahedral dust in 3D. **Llull** implements the circular-combinatorial Figure A and requires exactly nine root domains; its 3D height is the Third Figure's offset class. **Julia** places nodes in external coordinates of certified quadratic or cubic dynamics; its 3D height is a scalar lift of the external potential G, not a 3D Julia set. Each topology checks its preconditions and refuses input it cannot place faithfully.

The four Geometry Lab topologies—Canopy, Sierpiński, Llull, and Julia—are experimental. **Indra** is an optional organization that groups a supported topology into nested containers called pearls. A pearl counts hidden nodes, and opening it reveals its real children; Indra changes the organization of the view, not the dataset's relations. Julia with Indra is refused when its atlas cannot be certified legible at its mounted scale.

The three morphologies are **Stellar** (luminous points and filaments), **Neural** (somata and neural-style connections), and **Mycelium** (branching network-like forms). Neural's optional brain control adds a decorative brain outline in 3D. In Natural, morphology also selects the default arrangement: Stellar uses constellation, Neural uses network, and Mycelium uses mycelium. In other topologies, placement follows the selected topology law; morphology does not change meaning.

Density controls select how much of the graph is drawn. Complete draws every node. Custom requests a chosen number of real nodes. Status distinguishes visible from represented nodes and reports drawn and eligible relations; a requested budget does not guarantee the actual visible count. At Complete, dense 3D views draw every node and every relation selected by the relation-detail control. The relation-detail control («Essenziali» / «Tutte» in the interface: essential / all) can select essential or all eligible relations under the active reading. Attested and exploratory readings stay distinct, **Combined** shows both classes, and an inference does not become cited evidence because it is drawn.
