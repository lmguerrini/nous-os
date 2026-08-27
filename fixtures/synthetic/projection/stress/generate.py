"""Generate deterministic synthetic renderer stress fixtures and do not create canonical data."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import argparse
import json
from pathlib import Path
from random import Random
from typing import Final


SYNTHETIC_DECLARATION: Final = (
    "SYNTHETIC STRESS MATERIAL ONLY: carries no semantic meaning, is never canon, "
    "and exists only to measure renderer performance."
)
SCHEMA_VERSION: Final = "nous-projection-ir/1"
OUTPUT_DIRECTORY: Final = Path(__file__).resolve().parent
RANDOM_SEED: Final = 13_013


@dataclass(frozen=True)
class Scale:
    """Describe one renderer scale and do not describe semantic data."""

    filename: str
    order_of_magnitude: int
    assertion_counts: tuple[int, ...]
    conflicts_per_community: tuple[int, ...]

    def __post_init__(self) -> None:
        """Require complete community parameters and do not accept inferred topology."""
        if len(self.assertion_counts) != len(self.conflicts_per_community):
            raise ValueError("each community needs a conflict count")
        if self.order_of_magnitude < 1:
            raise ValueError("the order of magnitude must be positive")
        if not self.assertion_counts or min(self.assertion_counts) < 3:
            raise ValueError("each community needs at least three assertions")
        if min(self.conflicts_per_community) < 1:
            raise ValueError("each community needs at least one conflict")


SCALES: Final = (
    Scale("stress-100.json", 2, (9, 9), (4, 4)),
    Scale("stress-1000.json", 3, (27, 27, 27, 27, 27, 27, 26, 26), (11, 11, 11, 11, 11, 11, 11, 11)),
    Scale("stress-10000.json", 4, (95,) * 23 + (99,), (40,) * 23 + (41,)),
)


def _canonical_bytes(value: object) -> bytes:
    """Encode stable fixture bytes and do not preserve caller formatting."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _identifier(prefix: str, number: int) -> str:
    """Create a valid deterministic identifier and do not mint a production identity."""
    return f"{prefix}_{number:026X}"


def _provenance(source_id: str, label: str) -> dict[str, object]:
    """Create closed-shape placeholder provenance and do not claim a resolvable source."""
    return {
        "source_id": source_id,
        "snapshot_digest": sha256(f"synthetic-stress:{label}".encode("utf-8")).hexdigest(),
        "start_byte": 0,
        "end_byte": len(SYNTHETIC_DECLARATION.encode("utf-8")),
        "span": SYNTHETIC_DECLARATION,
    }


def _groups(member_count: int, group_count: int) -> tuple[int, ...]:
    """Partition local hub members into valid conflict groups and do not randomize them."""
    if group_count > member_count // 2:
        raise ValueError("conflicts need at least two members")
    base, remainder = divmod(member_count, group_count)
    return tuple(base + (1 if index < remainder else 0) for index in range(group_count))


def _node(identifier: str, kind: str, attributes: dict[str, object]) -> dict[str, object]:
    """Encode one governed node shape and do not add presentation fields."""
    return {"id": identifier, "kind": kind, "attributes": attributes}


def _edge(
    identifier: str,
    kind: str,
    source: str,
    target: str,
    attributes: object,
) -> dict[str, object]:
    """Encode one governed edge shape and do not add display metadata."""
    return {
        "id": identifier,
        "kind": kind,
        "source": source,
        "target": target,
        "attributes": attributes,
    }


def _scale_payload(scale_index: int, scale: Scale, random: Random) -> dict[str, object]:
    """Build a locally dense, sparsely bridged stress graph and do not model knowledge."""
    nodes: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    source_ids: list[tuple[str, str]] = []
    subject_ids: list[tuple[str, str]] = []
    base_number = (scale_index + 1) * 100_000

    for community, assertion_count in enumerate(scale.assertion_counts):
        local_sources = (
            _identifier("src", base_number + community * 100 + 1),
            _identifier("src", base_number + community * 100 + 2),
        )
        local_subjects = (
            f"stress-{scale.filename.removesuffix('.json')}-community-{community}-hub",
            f"stress-{scale.filename.removesuffix('.json')}-community-{community}-leaf",
        )
        source_ids.append(local_sources)
        subject_ids.append(local_subjects)
        for source_id in local_sources:
            nodes.append(_node(f"source:{source_id}", "source", {"source_id": source_id}))
        for subject_id in local_subjects:
            nodes.append(_node(f"subject:{subject_id}", "subject", {"key": subject_id}))

        primary_count = assertion_count - assertion_count // 6
        primary_positions = tuple(sorted(random.sample(range(assertion_count), primary_count)))
        local_assertions: list[str] = []
        primary_assertions: list[str] = []
        for local_index in range(assertion_count):
            assertion_id = _identifier("asr", base_number + community * 100 + 10 + local_index)
            assertion_node = f"assertion:{assertion_id}"
            source_index = 0 if local_index in primary_positions else 1
            subject_index = 0 if local_index in primary_positions else 1
            provenance = _provenance(source_ids[community][source_index], assertion_id)
            nodes.append(
                _node(
                    assertion_node,
                    "assertion",
                    {
                        "assertion_id": assertion_id,
                        "text": SYNTHETIC_DECLARATION,
                        "support": "unknown",
                        "lifecycle": "canonical",
                        "recorded_at": "2026-01-01T00:00:00+00:00",
                        "valid_from": "2026-01-01T00:00:00+00:00",
                        "valid_to": "2026-01-02T00:00:00+00:00",
                        "provenance": provenance,
                        "temporal": "established",
                    },
                )
            )
            edges.append(
                _edge(
                    f"about:{assertion_id}",
                    "about",
                    assertion_node,
                    f"subject:{subject_ids[community][subject_index]}",
                    None,
                )
            )
            edges.append(
                _edge(
                    f"cites:{assertion_id}",
                    "cites",
                    assertion_node,
                    f"source:{source_ids[community][source_index]}",
                    provenance,
                )
            )
            local_assertions.append(assertion_id)
            if local_index in primary_positions:
                primary_assertions.append(assertion_id)
        cursor = 0
        for conflict, group_size in enumerate(_groups(primary_count, scale.conflicts_per_community[community])):
            members = tuple(primary_assertions[cursor : cursor + group_size])
            cursor += group_size
            conflict_id = f"conflict:stress-{scale_index}-{community}-{conflict}"
            nodes.append(
                _node(
                    conflict_id,
                    "conflict",
                    {
                        "subject_key": subject_ids[community][0],
                        "overlap": "overlaps",
                        "members": list(members),
                    },
                )
            )
            for member in members:
                edges.append(
                    _edge(
                        f"member:{conflict_id}:{member}",
                        "conflict_member",
                        conflict_id,
                        f"assertion:{member}",
                        None,
                    )
                )
        if cursor != primary_count:
            raise ValueError("conflict groups did not consume the local hub")

    community_count = len(scale.assertion_counts)
    for community in range(community_count):
        cluster_id = f"stress-{scale_index}-community-{community}"
        cluster_node = f"cluster:{cluster_id}"
        card_id = _identifier("asr", base_number + 90_000 + community)
        bridge_node = f"bridge:{card_id}"
        rejection_node = f"rejection:stress-{scale_index}-{community}"
        nodes.append(_node(cluster_node, "cluster", {"cluster_id": cluster_id}))
        nodes.append(
            _node(
                bridge_node,
                "bridge",
                {
                    "card_id": card_id,
                    "cluster_id": cluster_id,
                    "epistemic_class": "explicit",
                    "depth": "deep",
                    "non_triviality": SYNTHETIC_DECLARATION,
                    "consequence": SYNTHETIC_DECLARATION,
                    "noise_objection": SYNTHETIC_DECLARATION,
                    "origin_round": 1,
                    "gate_outcomes": [
                        ["cross_project", "pass"],
                        ["grounded", "pass"],
                        ["not_already_stated", "pass"],
                        ["non_trivial", "pass"],
                        ["consequential", "pass"],
                        ["survives_noise_objection", "pass"],
                    ],
                    "gate_reasons": [],
                    "triviality": None,
                    "disposition": "accepted",
                },
            )
        )
        nodes.append(
            _node(
                rejection_node,
                "rejection",
                {
                    "cluster_id": cluster_id,
                    "failed_gate": "grounded",
                    "reason": SYNTHETIC_DECLARATION,
                    "round_number": 1,
                    "rejected_at": "2026-01-01T00:00:00+00:00",
                },
            )
        )
        edges.append(_edge(f"in-cluster:{card_id}", "in_cluster", bridge_node, cluster_node, None))
        for side, endpoint_community in (("left", community), ("right", (community + 1) % community_count)):
            source_id = source_ids[endpoint_community][0]
            provenance = _provenance(source_id, f"{card_id}-{side}")
            edges.append(
                _edge(
                    f"side:{card_id}:{side}",
                    "bridge_side",
                    bridge_node,
                    f"source:{source_id}",
                    {
                        "side": side,
                        "project": "synthetic-renderer-stress",
                        "quote": SYNTHETIC_DECLARATION,
                        "provenance": provenance,
                    },
                )
            )
        edges.append(_edge(f"rejects:{rejection_node}", "rejects", rejection_node, cluster_node, None))

    return {
        "schema_version": SCHEMA_VERSION,
        "policy_id": "discovery",
        "question": {"valid_at": None, "recorded_as_of": None},
        "nodes": sorted(nodes, key=lambda item: str(item["id"])),
        "edges": sorted(edges, key=lambda item: str(item["id"])),
    }


def build_payloads() -> dict[str, dict[str, object]]:
    """Build every declared scale deterministically and do not write files."""
    random = Random(RANDOM_SEED)
    return {scale.filename: _scale_payload(index, scale, random) for index, scale in enumerate(SCALES)}


def _degrees(payload: dict[str, object]) -> list[int]:
    """Measure undirected visual incidence and do not infer semantic centrality."""
    nodes = payload["nodes"]
    edges = payload["edges"]
    if type(nodes) is not list or type(edges) is not list:
        raise ValueError("payload has no graph arrays")
    degrees = {str(node["id"]): 0 for node in nodes if type(node) is dict}
    for edge in edges:
        if type(edge) is not dict:
            raise ValueError("edge is not an object")
        degrees[str(edge["source"])] += 1
        degrees[str(edge["target"])] += 1
    return sorted(degrees.values())


def _manifest(payloads: dict[str, dict[str, object]]) -> dict[str, object]:
    """Pin generated bytes and graph witnesses and do not attest semantic content."""
    fixtures: dict[str, object] = {}
    scales = {scale.filename: scale for scale in SCALES}
    for filename in sorted(payloads):
        payload = payloads[filename]
        raw = _canonical_bytes(payload)
        degrees = _degrees(payload)
        fixtures[filename] = {
            "sha256": sha256(raw).hexdigest(),
            "node_count": len(payload["nodes"]),
            "edge_count": len(payload["edges"]),
            "element_count": len(payload["nodes"]) + len(payload["edges"]),
            "order_of_magnitude": scales[filename].order_of_magnitude,
            "median_degree": degrees[(len(degrees) - 1) // 2],
            "maximum_degree": degrees[-1],
            "minimum_maximum_to_median_factor": 3,
        }
    return {"synthetic_declaration": SYNTHETIC_DECLARATION, "fixtures": fixtures}


def write_fixtures(output_directory: Path) -> None:
    """Write the declared fixture set and do not write canonical or personal data."""
    output_directory.mkdir(parents=True, exist_ok=True)
    payloads = build_payloads()
    for filename in sorted(payloads):
        payload = payloads[filename]
        (output_directory / filename).write_bytes(_canonical_bytes(payload))
    (output_directory / "MANIFEST.json").write_bytes(_canonical_bytes(_manifest(payloads)))
    (output_directory / "README.md").write_text(
        f"# Synthetic renderer stress fixtures\n\n{SYNTHETIC_DECLARATION}\n",
        encoding="utf-8",
    )


def main() -> None:
    """Write default stress fixtures or an explicit destination and do not use runtime entropy."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_DIRECTORY)
    arguments = parser.parse_args()
    write_fixtures(arguments.output_dir)


if __name__ == "__main__":
    main()
