# Memory walkthrough: synthetic corpus

## Try the memory on the synthetic corpus

From the repository root, this example ingests the shipped Markdown files through the public Python API, builds the derived index, searches it, reads context for a result, and resolves a citation to the exact bytes of a hash-checked snapshot. The CLI defaults to read access; ingestion here uses the library's public `nous_os.ledger.ingest` function.

```bash
WORKSPACE="$(mktemp -d)"
export WORKSPACE
mkdir -p "$WORKSPACE/snapshots"
export PYTHONPATH=src
export NOUS_OS_DATA_ROOT=fixtures/synthetic/corpus
export NOUS_OS_SNAPSHOT_ROOT="$WORKSPACE/snapshots"
export NOUS_OS_LEDGER_PATH="$WORKSPACE/ledger.jsonl"
export NOUS_OS_DERIVED_PATH="$WORKSPACE/derived.sqlite3"
export NOUS_OS_CANDIDATE_STORE_PATH="$WORKSPACE/candidates.jsonl"
export NOUS_OS_BRIDGE_REGISTRY_PATH="$WORKSPACE/bridges.jsonl"
export NOUS_OS_REJECTION_MEMORY_PATH="$WORKSPACE/rejections.jsonl"
export NOUS_OS_RELATION_STORE_PATH="$WORKSPACE/relations.jsonl"

python3 - <<'PY'
from datetime import datetime, timezone
import os
from pathlib import Path
from nous_os.identity import new_source_id
from nous_os.ledger import Ledger, ingest
from nous_os.snapshots import SnapshotStore
from nous_os.untrusted import UntrustedText

root = Path(os.environ["NOUS_OS_DATA_ROOT"])
snapshots = SnapshotStore(Path(os.environ["NOUS_OS_SNAPSHOT_ROOT"]))
ledger = Ledger(Path(os.environ["NOUS_OS_LEDGER_PATH"]))
files = sorted(root.rglob("*.md"))
for path in files:
    ingest(snapshots, ledger, new_source_id(),
           UntrustedText(path.read_text(encoding="utf-8")),
           datetime.now(timezone.utc))
print(f"Ingested {len(files)} synthetic Markdown files.")
PY

python3 -m nous_os.derived rebuild --snapshot-root "$NOUS_OS_SNAPSHOT_ROOT" --ledger-path "$NOUS_OS_LEDGER_PATH" --derived-path "$NOUS_OS_DERIVED_PATH"

python3 -m nous_os knowledge.search --query "How many metres do spring tides at Kestrel Bay reach?" --limit 3 | tee "$WORKSPACE/search.json"

python3 - <<'PY'
import json
import os
from pathlib import Path
from nous_os.snapshots import SnapshotStore

workspace = Path(os.environ["WORKSPACE"])
hits = json.loads((workspace / "search.json").read_text(encoding="utf-8"))
phrase = b"spring tides reaching five"
for hit in hits:
    snapshot = SnapshotStore(Path(os.environ["NOUS_OS_SNAPSHOT_ROOT"])).get(
        hit["source_id"], hit["snapshot_digest"])
    start = snapshot.data.find(phrase)
    if start >= 0:
        citation = {
            "source_id": hit["source_id"],
            "snapshot_digest": hit["snapshot_digest"],
            "start_byte": start,
            "end_byte": start + len(phrase),
            "span": phrase.decode("utf-8"),
        }
        (workspace / "citation.json").write_text(
            json.dumps(citation), encoding="utf-8")
        (workspace / "hit-source-id").write_text(
            hit["source_id"], encoding="utf-8")
        print("Built a citation from the search hit and its stored snapshot.")
        break
else:
    raise SystemExit("No search hit contained the example citation span.")
PY

python3 -m nous_os knowledge.context --source-id "$(cat "$WORKSPACE/hit-source-id")"

python3 -m nous_os provenance.span --citation "$(cat "$WORKSPACE/citation.json")"

python3 -m nous_os system.capabilities
python3 -m nous_os system.health

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"system.health","arguments":{}}}' \
  | python3 -m nous_os.mcp
```

The ingest step prints `Ingested 4 synthetic Markdown files.`, and `provenance.span` prints the bytes at the cited range, `"spring tides reaching five"`, which match the citation's quoted text.

The search question includes punctuation to exercise the full-text fallback. The citation names the exact byte range for `spring tides reaching five` in one hit's snapshot; `provenance.span` loads that snapshot, checks its content hash and the byte range, and prints the bytes at that range; comparing them with the quoted text confirms the citation. The snippet demonstrates source retrieval; it is not an assertion promoted to canon.

## Memory and review model

NousOS is a Python library with local command-line and stdio JSON-RPC interfaces plus a browser graph review page. It is not a hosted service or chat product; callers choose when to invoke operations. The review page serves on loopback. The public repository contains invented synthetic fixtures and gallery data; a user's corpus remains where they place it, and store locations come from configuration rather than being guessed. The command line and stdio JSON-RPC transports have no network listener.

The rebuildable full-text index searches canonical records. When query syntax is invalid, search retries once with the query's words, allowing natural-language questions with punctuation to return results. An optional semantic index can be built from locally available model files; it is derived, rebuildable, and reported as not run when required material is absent. Neither index replaces source records or citations. A hit retains source and snapshot identifiers and returns readable text with metadata such as kind, role, creation time, and title when present. The context compiler takes ranked material and emits a reproducible context pack with a record of its inputs. The public retrieval method is described in [the retrieval measurement](RETRIEVAL-MEASUREMENT.md).

Source files are stored as immutable, content-addressed snapshots with an append-only ingest ledger. Re-ingesting unchanged bytes does not create a new content version. Citations identify a snapshot and byte range, which can be checked against the exact source bytes. Assertions retain valid time (when a claim applied) and recording time (when the system learned it); superseded claims stay in history, and disagreements are exposed as conflicts instead of being silently resolved.

Proposals, discovery results, adjudications, and rejections are stored separately from canonical assertions. Their presence does not change canon. No operation promotes a proposal into canon; a person makes that decision through a separate review path. The graph projection carries typed node and relation classes, evidence links, and review details to the renderer. Visual containers, bundles, and geometric guides help read the drawing but do not add source relations.
