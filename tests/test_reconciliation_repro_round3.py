"""Regression oracle for the reconciliation boundary: an equal-text group is bounded by source versions as well as by source ids."""
from __future__ import annotations

import json
from pathlib import Path

from nous_os import reconciliation
from nous_os.reconciliation import TextView, text_equality_relations
from tests.test_reconciliation import AT, LEFT_SOURCE, RIGHT_SOURCE, _World


def test_c3_equal_text_fan_out_is_bounded_by_source_versions(tmp_path: Path) -> None:
    """Two sources with thirty equal-text versions each must not expand into 900 proposals: the group is oversized, counted, not expanded."""
    world = _World(tmp_path)
    text = "equal text carried unchanged through thirty metadata-only versions of two sources"
    views = []
    for source in (LEFT_SOURCE, RIGHT_SOURCE):
        for version in range(30):
            snapshot = world.snapshots.put(source, json.dumps({"text": text, "version": version, "source": source}).encode("utf-8"))
            views.append(TextView(source, snapshot.digest, "fixture", text))
    result = text_equality_relations(tuple(views), store=world.snapshots, proposed_at=AT)
    bound = getattr(reconciliation, "MAX_GROUP_VIEWS", None)
    assert bound is not None, "a per-group bound on views (versions) must exist beside MAX_GROUP_SOURCES"
    assert len(result.proposals) <= bound * (bound - 1) // 2
    assert result.oversized_groups == 1
    assert len(result.proposals) == 0
