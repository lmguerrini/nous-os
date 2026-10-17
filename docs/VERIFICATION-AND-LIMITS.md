# Verification and limits

## CI checks

The Python suite covers canonical records, provenance, ingestion, derived indexes, candidate gates, temporal behavior, projections, and package contracts. Demo-generator tests cover deterministic output, canonical JSON, one index edge per real relation, and validator acceptance. UI unit tests exercise topology laws, density and relation selection, focus, panels, labels, appearance, and render scheduling; renderer suites cover 2D/3D drawing contracts and interactions. Browser evidence suites cover page opening and rendered interactions when the required browser and GPU environment is available. Not every browser or visual evidence suite runs in default CI.

The reproducible public Python and typecheck commands used by CI are:

```bash
python3 -m pip install pytest ".[semantic]"
npm --prefix ui ci
python3 -m pytest tests/ -q --ignore=tests/test_semantic.py --ignore=tests/test_semantic_controls.py
npm --prefix ui run typecheck
```

The two excluded semantic modules need local ONNX checkpoints; resolution is local-only. The semantic extra is installed because other package tests import that module. CI runs on Linux with the declared Python floor and a current Python version. It covers package installation and import, the Python suite, typecheck, repository hygiene checks, and the commit-message contract across repository history. It does not run GPU-backed browser evidence or visual acceptance review.


## Context compilation

The six assembly-strategy families were compared on a private evaluation corpus: five were measured and none beat the plain strategy, which is the default; the sixth could not be measured on that corpus and is recorded as unmeasured rather than as a tie (see `DEFAULT_STRATEGY` in [`src/nous_os/compile.py`](../src/nous_os/compile.py)). Evaluation distinguishes including a source pair from including the cited passages. Retrieval arms are compared separately in [retrieval measurement](RETRIEVAL-MEASUREMENT.md).

## Measured on synthetic data

- In a browser matrix on the demo dataset (five topologies × three morphologies × 2D/3D × Indra on/off, 60 configurations, 5 to 21 sampled nodes each, identical camera), all 60 configurations reached Complete, and 46 kept every sampled node within 1% of its Complete radius across presets. The exceptions include 2D Canopy without Indra (up to about twice the Complete size); 3D Sierpiński, Llull and Canopy, Stellar with Indra (up to 23%); 2D Natural and Canopy with Indra (up to 57% and 11% for one sampled node each); 3D Natural Stellar without Indra (up to 7.7%, because layout depth differs); and 2D Natural Mycelium without Indra (1.4%). Full details are in [gallery measurements](GALLERY-AND-MEASUREMENTS.md).
- In that same matrix, 440 of 561 sampled clicks (78%) selected the intended node; in dense views a click can select a neighbouring node.
- On one machine, 3D Complete was also reached in a browser in all five topologies on larger synthetic datasets of 15,000 and 20,000 nodes (up to 25,111 drawn relations); the published demo profiles do not generate these sizes.
- Gallery render times and density counts are single-machine synthetic demo measurements, documented in [gallery measurements](GALLERY-AND-MEASUREMENTS.md).

## Observed on a private dataset

These observations used a development build of the review page on a larger private dataset, whose content is not published.

- In a run of the same 60-configuration node-size matrix, 54 configurations mounted: five 3D views were not certified within the 90-second probe, and 2D Julia with Indra and Neural was refused by design. No general performance conclusion follows from the timeouts.
- 40 of the 54 kept every sampled node within 1% of its Complete radius across presets. The exceptions are 2D Canopy without Indra (61–92%, with the sparser presets drawing nodes larger); 3D Sierpiński, Llull and Julia, Stellar with Indra (up to 23%); and residuals of 1.4–4.5% in eight other 2D views without Indra.
- After choosing Complete on a large 3D view, the density control and URL can update after the drawing completes.

## Known limits

- Browser suites require Playwright browsers and a real GPU adapter. They generate `ui/dist/`, which is run output and is not committed.
- `npm --prefix ui run test:unit` does not pass from a clean clone, even after `npm --prefix ui run build:review`; four document suites require generated evidence under `ui/dist/` and fail when it is absent.
- Semantic tests need locally cached ONNX checkpoints. With the semantic extra and an empty cache, the recorded run has failures and errors; no download is attempted.
- Six visual acceptance criteria require human inspection of rendered images.
- Only Chromium was verified for the review page. Touch devices, keyboard navigation inside the canvas, and screen readers were not verified.
- In 3D Julia with Indra, a node's glow halo can vary with which nodes the atlas admits; its core size and centre do not.
- Nodes outside the camera can be clipped.
- In 2D Neural at Balanced on the demo dataset, the view from the whole-graph distance is almost black (mean brightness about 2% of white); the branches become visible about twice as close, as in the gallery's Neural 2D view.
- After the page fits the view or restores a camera without a gesture (for example on entering fullscreen), Llull's figure, Sierpiński's outline and Julia's rays can keep an earlier placement until the camera next moves.
- Llull requires exactly nine root domains.
- Julia with Indra is refused when the atlas cannot be certified legible at its mounted scale. With labels hidden, its legibility certificate can fail because the «+N» badges are hidden.
- Some Complete drawing calibrations are keyed to the demo's 11,199 nodes; other dataset sizes use general policies until those constants are parameterized.
- A second page drawing a heavy 3D view in the same browser can stall for several seconds. The first opening of a sparse Natural 3D view computes a full reference layout first.
- The per-node date table used by Canopy is empty in the demo, so dates are unknown unless a dataset supplies them.
- Llull, Indra compositions, and the Julia atlas are covered by their own runtime certificates.
- Code comments, test names, some documentation headings, and page test hooks and storage keys (for example `window.__d067`) carry short development step identifiers; they label development steps and reference no data.

Privacy is local by default: store locations come from configuration and NousOS does not guess a corpus location. The tracked fixtures and README gallery images use invented synthetic material. Indexes are derived and rebuildable, not the source of truth. Optional semantic indexing uses locally available model files. A corpus remains where you place it; this repository contains the software and synthetic examples. The command line and stdio JSON-RPC transports have no network listener; the separate review demo serves only on loopback.
