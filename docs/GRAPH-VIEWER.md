# Real-data graph viewer

The Python exporter selects conversations from the inventory and reads source records, live candidate proposals, verified canon, and recorded source relations. It writes the product's `graph.project` IR and a companion `details.json` with provenance, standing, and bounded previews. The output contains your own source material; keep it outside the repository.

```sh
source /path/to/WORKSPACE.env
PYTHONPATH=src python3 -m nous_os.graph_view sample --inventory /path/to/INVENTORY-v1.jsonl --replaced /path/to/REPLACED-IN-REVIEW.jsonl --out /path/to/sample.json --per-scope 2
PYTHONPATH=src python3 -m nous_os.graph_view export --sample /path/to/sample.json --replaced /path/to/REPLACED-IN-REVIEW.jsonl --out-dir /path/to/graph --max-candidates 12
PYTHONPATH=src python3 -m nous_os.graph_view serve --sample /path/to/sample.json --replaced /path/to/REPLACED-IN-REVIEW.jsonl --static ui/dist/viewer --port 8765 --max-candidates 12
```

`serve` listens on `127.0.0.1` and exposes the cached `/api/graph.json`, `/api/details.json`, and `/api/health` reads. Sampling defaults to two conversations per scope and allows at most eight. `export` and `serve` default to 12 live candidates per conversation; `--max-candidates` accepts 1–40. The exporter caps the IR at 800 nodes plus edges. `details.json` reports the configured candidate cap, actual counts, and truncation.

The shared layout's cost grows quickly with node count and can fail its minimum-separation floor on dense graphs. The default `--max-candidates 12` keeps a sample small. If the viewer reports a layout failure, rerun `export` or `serve` with a smaller `--max-candidates`.

The current projection input type admits only canonical assertions. The exporter adapts candidate proposals into that projection input so they can appear in the IR, while `details.json` carries their actual `candidate` status. An IR assertion's lifecycle field therefore does **not** establish that its candidate was promoted. Recorded source relations appear as `explicit_relation` details with their source endpoints and evidence; they have no IR edge kind and are listed in node details rather than drawn. Projection citation edges and source to conversation membership details are `structural`. The exporter adds no inferred edges. The graph is a sampled view, not a complete corpus or a truth ranking.
