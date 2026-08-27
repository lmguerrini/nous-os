"""Pin synthetic renderer stress fixtures and do not establish semantic content."""

from __future__ import annotations

import ast
import copy
import hashlib
import inspect
import json
from pathlib import Path
import subprocess
import sys

import pytest

from nous_os.identity import canonical_bytes
from nous_os.projection import EdgeKind, NodeKind, ProjectionError, ProjectionIR, from_payload


ROOT = Path(__file__).resolve().parent.parent
STRESS_DIRECTORY = ROOT / "fixtures" / "synthetic" / "projection" / "stress"
GENERATOR = STRESS_DIRECTORY / "generate.py"
FIXTURE_NAMES = ("stress-100.json", "stress-1000.json", "stress-10000.json")


def _payload(filename: str) -> dict[str, object]:
    """Read one declared stress payload and do not normalize its source bytes."""
    value = json.loads((STRESS_DIRECTORY / filename).read_bytes())
    assert type(value) is dict
    return value


def _manifest() -> dict[str, object]:
    """Read the stress pin manifest and do not derive expected fixture facts."""
    value = json.loads((STRESS_DIRECTORY / "MANIFEST.json").read_bytes())
    assert type(value) is dict
    return value


def _fresh_generated_bytes(output_directory: Path) -> dict[str, bytes]:
    """Run the generator in isolation and do not rewrite checked-in fixtures."""
    completed = subprocess.run(
        [sys.executable, str(GENERATOR), "--output-dir", str(output_directory)],
        check=False,
        capture_output=True,
    )
    assert completed.returncode == 0, completed.stderr.decode("utf-8")
    assert completed.stdout == b""
    return {path.name: path.read_bytes() for path in sorted(output_directory.iterdir()) if path.is_file()}


def _governed_signatures() -> dict[str, tuple[str, str]]:
    """Extract ProjectionIR's endpoint rules from its source and do not restate them."""
    source_path = inspect.getsourcefile(ProjectionIR)
    assert source_path is not None
    tree = ast.parse(Path(source_path).read_text(encoding="utf-8"))
    for statement in ast.walk(tree):
        if not isinstance(statement, ast.Assign):
            continue
        if not any(isinstance(target, ast.Name) and target.id == "signatures" for target in statement.targets):
            continue
        if not isinstance(statement.value, ast.Dict):
            continue
        rules: dict[str, tuple[str, str]] = {}
        for key, value in zip(statement.value.keys, statement.value.values):
            assert isinstance(key, ast.Attribute) and isinstance(key.value, ast.Name)
            assert key.value.id == "EdgeKind"
            assert isinstance(value, ast.Tuple) and len(value.elts) == 2
            source, target = value.elts
            assert isinstance(source, ast.Attribute) and isinstance(source.value, ast.Name)
            assert isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name)
            assert source.value.id == "NodeKind" and target.value.id == "NodeKind"
            rules[getattr(EdgeKind, key.attr).value] = (
                getattr(NodeKind, source.attr).value,
                getattr(NodeKind, target.attr).value,
            )
        if rules:
            return rules
    raise AssertionError("ProjectionIR endpoint signatures were not found in their source")


def _assert_edge_signatures(payload: dict[str, object]) -> None:
    """Require every edge to use the governed directed signature and do not infer a new rule."""
    nodes = payload["nodes"]
    edges = payload["edges"]
    assert type(nodes) is list and type(edges) is list
    kinds = {node["id"]: node["kind"] for node in nodes if type(node) is dict}
    signatures = _governed_signatures()
    assert set(signatures) == {kind.value for kind in EdgeKind}
    for edge in edges:
        assert type(edge) is dict
        actual = (kinds[edge["source"]], kinds[edge["target"]])
        expected = signatures[edge["kind"]]
        assert actual == expected, f"illegal edge signature for {edge['id']}: {actual} != {expected}"


def _degrees(payload: dict[str, object]) -> list[int]:
    """Measure visual incidence degrees and do not assign a semantic rank."""
    nodes = payload["nodes"]
    edges = payload["edges"]
    assert type(nodes) is list and type(edges) is list
    degrees = {node["id"]: 0 for node in nodes if type(node) is dict}
    for edge in edges:
        assert type(edge) is dict
        degrees[edge["source"]] += 1
        degrees[edge["target"]] += 1
    return sorted(degrees.values())


def _assert_heavy_tail(payload: dict[str, object], factor: int) -> None:
    """Require a concrete high-degree witness and do not label every uneven graph scale-free."""
    degrees = _degrees(payload)
    median = degrees[(len(degrees) - 1) // 2]
    maximum = degrees[-1]
    assert maximum > median * factor, f"maximum degree {maximum} is not greater than {factor} times median {median}"


def _assert_synthetic_declaration(raw: bytes) -> None:
    """Require an explicit synthetic declaration in fixture bytes and do not infer it from location."""
    declaration = raw.decode("utf-8")
    for phrase in (
        "SYNTHETIC STRESS MATERIAL ONLY",
        "carries no semantic meaning",
        "is never canon",
        "exists only to measure renderer performance",
    ):
        assert phrase in declaration, f"synthetic declaration lacks {phrase!r}"


def _assert_manifest_entry(payload: dict[str, object], entry: dict[str, object], raw: bytes) -> None:
    """Check a manifest pin against one payload and do not regenerate the expected pin."""
    nodes = payload["nodes"]
    edges = payload["edges"]
    assert type(nodes) is list and type(edges) is list
    assert entry["sha256"] == hashlib.sha256(raw).hexdigest(), "manifest sha256 pin mismatch"
    assert entry["node_count"] == len(nodes), "manifest node_count pin mismatch"
    assert entry["edge_count"] == len(edges), "manifest edge_count pin mismatch"
    element_count = len(nodes) + len(edges)
    assert entry["element_count"] == element_count, "manifest element_count pin mismatch"
    order = entry["order_of_magnitude"]
    assert type(order) is int
    assert 10**order <= element_count < 10 ** (order + 1), "element count is outside its declared order"
    degrees = _degrees(payload)
    assert entry["median_degree"] == degrees[(len(degrees) - 1) // 2], "manifest median_degree pin mismatch"
    assert entry["maximum_degree"] == degrees[-1], "manifest maximum_degree pin mismatch"
    assert type(entry["minimum_maximum_to_median_factor"]) is int


def _uniform_degree_payload() -> dict[str, object]:
    """Build a conformant low-variance control graph and do not model a stress topology."""
    nodes: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    for index in range(2):
        source_id = f"src_{index + 1:026X}"
        assertion_id = f"asr_{index + 1:026X}"
        subject = f"uniform-subject-{index}"
        provenance = {
            "source_id": source_id,
            "snapshot_digest": f"{index + 1:064x}",
            "start_byte": 0,
            "end_byte": 1,
            "span": "x",
        }
        nodes.extend(
            (
                {"id": f"source:{source_id}", "kind": "source", "attributes": {"source_id": source_id}},
                {"id": f"subject:{subject}", "kind": "subject", "attributes": {"key": subject}},
                {
                    "id": f"assertion:{assertion_id}",
                    "kind": "assertion",
                    "attributes": {
                        "assertion_id": assertion_id,
                        "text": "uniform control",
                        "support": "unknown",
                        "lifecycle": "canonical",
                        "recorded_at": "2026-01-01T00:00:00+00:00",
                        "valid_from": "2026-01-01T00:00:00+00:00",
                        "valid_to": "2026-01-02T00:00:00+00:00",
                        "provenance": provenance,
                        "temporal": "established",
                    },
                },
            )
        )
        edges.extend(
            (
                {"id": f"about:{assertion_id}", "kind": "about", "source": f"assertion:{assertion_id}", "target": f"subject:{subject}", "attributes": None},
                {"id": f"cites:{assertion_id}", "kind": "cites", "source": f"assertion:{assertion_id}", "target": f"source:{source_id}", "attributes": provenance},
            )
        )
    return {
        "schema_version": "nous-projection-ir/1",
        "policy_id": "discovery",
        "question": {"valid_at": None, "recorded_as_of": None},
        "nodes": nodes,
        "edges": edges,
    }


def test_stress_fixtures_are_byte_identical_to_a_fresh_generator_run(tmp_path: Path) -> None:
    """Pin generated bytes to fresh output and do not rewrite committed fixtures while testing."""
    generated = _fresh_generated_bytes(tmp_path)
    assert set(generated) == {*FIXTURE_NAMES, "MANIFEST.json", "README.md"}
    for filename, expected in generated.items():
        actual = (STRESS_DIRECTORY / filename).read_bytes()
        assert actual == expected, filename

    with pytest.raises(AssertionError, match="stress-100.json"):
        assert (STRESS_DIRECTORY / "stress-100.json").read_bytes() == b"hand-edited fixture", "stress-100.json"


def test_stress_fixtures_round_trip_through_the_real_projection_ir_and_governed_signatures() -> None:
    """Restore every stress payload through ProjectionIR and do not re-describe its schema."""
    for filename in FIXTURE_NAMES:
        raw = (STRESS_DIRECTORY / filename).read_bytes()
        payload = _payload(filename)
        restored = from_payload(payload)
        assert canonical_bytes(restored.as_payload()) == raw
        _assert_edge_signatures(payload)

    forbidden = copy.deepcopy(_payload("stress-100.json"))
    edges = forbidden["edges"]
    assert type(edges) is list
    about = next(edge for edge in edges if type(edge) is dict and edge["kind"] == "about")
    about["target"] = next(node["id"] for node in forbidden["nodes"] if type(node) is dict and node["kind"] == "source")
    with pytest.raises(ProjectionError, match="endpoint kinds inconsistent with about"):
        from_payload(forbidden)
    with pytest.raises(AssertionError, match="illegal edge signature"):
        _assert_edge_signatures(forbidden)


def test_stress_manifest_pins_counts_hashes_and_heavy_tail_witnesses() -> None:
    """Pin stress scale and degree witnesses and do not treat a passing parse as a scale guarantee."""
    manifest = _manifest()
    entries = manifest["fixtures"]
    assert type(entries) is dict
    assert set(entries) == set(FIXTURE_NAMES)
    for filename in FIXTURE_NAMES:
        entry = entries[filename]
        assert type(entry) is dict
        payload = _payload(filename)
        raw = (STRESS_DIRECTORY / filename).read_bytes()
        _assert_manifest_entry(payload, entry, raw)
        _assert_heavy_tail(payload, entry["minimum_maximum_to_median_factor"])

    shrunk = copy.deepcopy(_payload("stress-100.json"))
    nodes = shrunk["nodes"]
    assert type(nodes) is list
    nodes.pop()
    with pytest.raises(AssertionError):
        _assert_manifest_entry(shrunk, entries["stress-100.json"], (STRESS_DIRECTORY / "stress-100.json").read_bytes())

    bad_hash = copy.deepcopy(entries["stress-100.json"])
    assert type(bad_hash) is dict
    bad_hash["sha256"] = "0" * 64
    with pytest.raises(AssertionError):
        _assert_manifest_entry(_payload("stress-100.json"), bad_hash, (STRESS_DIRECTORY / "stress-100.json").read_bytes())

    uniform = _uniform_degree_payload()
    assert len(from_payload(uniform).nodes) == len(uniform["nodes"])
    with pytest.raises(AssertionError, match="maximum degree 2 is not greater than 3 times median 1"):
        _assert_heavy_tail(uniform, 3)


def test_stress_fixtures_declare_their_synthetic_status_in_actual_bytes() -> None:
    """Require explicit synthetic status in every file and do not infer status from directory names."""
    for filename in FIXTURE_NAMES:
        _assert_synthetic_declaration((STRESS_DIRECTORY / filename).read_bytes())
    _assert_synthetic_declaration((STRESS_DIRECTORY / "README.md").read_bytes())
    _assert_synthetic_declaration((STRESS_DIRECTORY / "MANIFEST.json").read_bytes())

    with pytest.raises(AssertionError, match="synthetic declaration lacks"):
        _assert_synthetic_declaration(b'{"fixture":"ordinary"}')
