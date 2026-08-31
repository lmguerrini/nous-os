"""Hand-computed checks for the CAP-15 retrieval metric definitions."""

from __future__ import annotations

from copy import deepcopy

import pytest

from benchmarks.metrics import (
    BASELINE,
    CHUNK_BASELINE,
    MetricsError,
    NotRunArmMetrics,
    RunArmMetrics,
    compute_metrics,
)


def _artifact() -> dict[str, object]:
    cells = [
        {"bridge": "b1", "direction": "A->B", "lang_pair": "en->it", "source_doc": "s1", "target_doc": "t1", "target_chunk": "c1", "status": "RUN", "not_run_reason": None},
        {"bridge": "b2", "direction": "A->B", "lang_pair": "en->it", "source_doc": "s2", "target_doc": "t2", "target_chunk": "c2", "status": "RUN", "not_run_reason": None},
        {"bridge": "b3", "direction": "A->B", "lang_pair": "en->it", "source_doc": "s3", "target_doc": "t3", "target_chunk": "c3", "status": "RUN", "not_run_reason": None},
        {"bridge": "b4", "direction": "A->B", "lang_pair": "en->en", "source_doc": "s4", "target_doc": "t4", "target_chunk": "c4", "status": "RUN", "not_run_reason": None},
        {"bridge": "b5", "direction": "A->B", "lang_pair": "en->en", "source_doc": "s5", "target_doc": "t5", "target_chunk": "c5", "status": "RUN", "not_run_reason": None},
        {"bridge": "b6", "direction": "A->B", "lang_pair": "en->it", "source_doc": "s6", "target_doc": "t6", "target_chunk": None, "status": "NOT_RUN", "not_run_reason": "target document unavailable"},
        {"bridge": "b7", "direction": "A->B", "lang_pair": "en->en", "source_doc": "s7", "target_doc": "t7", "target_chunk": None, "status": "NOT_RUN", "not_run_reason": "target document unavailable"},
    ]
    return {
        "corpus": {"documents": 7, "chunks": 14, "max_tokens": 100, "tier": "fixture"},
        "bridges": {"governed": 7, "cells": 7, "runnable": 5},
        "k_values": [1, 5, 10, 20],
        "k_max": 100,
        "determinism_payload_digest": "fixture-digest",
        "cells": cells,
        "arms": {
            "BASELINE": {"status": "RUN", "not_run_reason": None, "description": "document lexical", "seconds": 1.0, "ranks": {"b1|A->B": 1, "b2|A->B": 6, "b3|A->B": 10, "b4|A->B": None, "b5|A->B": 20}},
            "BASELINE-CHUNK-BM25": {"status": "RUN", "not_run_reason": None, "description": "chunk lexical", "seconds": 1.0, "ranks": {"b1|A->B": 2, "b2|A->B": 4, "b3|A->B": None, "b4|A->B": 1, "b5|A->B": 9}},
            "DENSE": {"status": "RUN", "not_run_reason": None, "description": "dense", "seconds": 1.0, "ranks": {"b1|A->B": 2, "b2|A->B": 1, "b3|A->B": None, "b4|A->B": 8, "b5|A->B": 30}},
            "EMPTY": {"status": "RUN", "not_run_reason": None, "description": "completed no-hit arm", "seconds": 1.0, "ranks": {"b1|A->B": None, "b2|A->B": None, "b3|A->B": None, "b4|A->B": None, "b5|A->B": None}},
            "UNAVAILABLE": {"status": "NOT_RUN", "not_run_reason": "model unavailable", "description": "not attempted"},
        },
    }


def test_hand_computed_pooled_metrics() -> None:
    metrics = compute_metrics(_artifact())
    dense = metrics.arms["DENSE"]
    assert isinstance(dense, RunArmMetrics)
    # DENSE: hits@1=1, @5=2, @10=3, @20=3; MRR=(1/2 + 1 + 1/8)/5=13/40.
    # At 10, only b4 is unique to DENSE and only b3 is lost from BASELINE: 1/5 each.
    assert dense.recall_at[1].numerator == 1
    assert dense.recall_at[1].denominator == 5
    assert dense.recall_at[5].value == 2 / 5
    assert dense.recall_at[10].value == 3 / 5
    assert dense.recall_at[20].value == 3 / 5
    assert dense.mrr.value == 13 / 40
    assert dense.unique_recall_at[10].value == 1 / 5
    assert dense.lost_recall_at[10].value == 1 / 5


def test_not_run_cells_do_not_change_any_metric() -> None:
    original = _artifact()
    expanded = deepcopy(original)
    expanded["cells"].append(
        {"bridge": "b8", "direction": "A->B", "lang_pair": "en->it", "source_doc": "s8", "target_doc": "t8", "target_chunk": None, "status": "NOT_RUN", "not_run_reason": "target document unavailable"}
    )
    original_metrics = compute_metrics(original)
    expanded_metrics = compute_metrics(expanded)
    assert original_metrics.denominator == expanded_metrics.denominator == 5
    assert original_metrics.stratum_denominators == expanded_metrics.stratum_denominators
    assert original_metrics.arms == expanded_metrics.arms


def test_not_run_arm_is_not_a_completed_zero_result() -> None:
    metrics = compute_metrics(_artifact())
    unavailable = metrics.arms["UNAVAILABLE"]
    empty = metrics.arms["EMPTY"]
    assert isinstance(unavailable, NotRunArmMetrics)
    assert unavailable.reason == "model unavailable"
    assert isinstance(empty, RunArmMetrics)
    assert empty.recall_at[10].numerator == 0
    assert empty.recall_at[10].denominator == 5


def test_stratum_denominators_sum_to_the_run_population() -> None:
    metrics = compute_metrics(_artifact())
    assert sum(metrics.stratum_denominators.values()) == metrics.denominator == 5


def test_shared_denominator_and_frozen_materiality_threshold() -> None:
    artifact = _artifact()
    cells = artifact["cells"][:5]
    for number in range(6, 21):
        cells.append({"bridge": f"b{number}", "direction": "A->B", "lang_pair": "en->it", "source_doc": f"s{number}", "target_doc": f"t{number}", "target_chunk": f"c{number}", "status": "RUN", "not_run_reason": None})
    artifact["cells"] = cells
    keys = [f"b{number}|A->B" for number in range(1, 21)]
    for arm_name in ("BASELINE", "BASELINE-CHUNK-BM25", "DENSE"):
        artifact["arms"][arm_name]["ranks"] = {key: None for key in keys}
    artifact["arms"]["BASELINE"]["ranks"].update({key: 1 for key in keys[:12]})
    artifact["arms"]["BASELINE-CHUNK-BM25"]["ranks"].update({key: 1 for key in keys[:10]})
    artifact["arms"]["DENSE"]["ranks"].update({key: 1 for key in keys[:13]})
    artifact["arms"]["EMPTY"]["ranks"] = {key: None for key in keys}
    metrics = compute_metrics(artifact)
    dense = metrics.arms["DENSE"]
    assert isinstance(dense, RunArmMetrics)
    assert dense.recall_at[10].numerator == 13
    assert dense.recall_at[10].denominator == 20
    decision = metrics.decisions["DENSE"]
    assert decision.condition_a is False


def test_frozen_stratum_regression_threshold_rejects_a_five_point_loss() -> None:
    """Condition B must retain its -2.0 point floor, not a looser one.

    This fixture gives DENSE a -5.0 point loss against the best lexical arm,
    which must remain outside the permitted stratum regression.
    """
    artifact = _artifact()
    cells = [
        {"bridge": f"b{number}", "direction": "A->B", "lang_pair": "en->it",
         "source_doc": f"s{number}", "target_doc": f"t{number}",
         "target_chunk": f"c{number}", "status": "RUN", "not_run_reason": None}
        for number in range(1, 21)
    ]
    artifact["cells"] = cells
    keys = [f"b{number}|A->B" for number in range(1, 21)]
    for arm_name in (BASELINE, CHUNK_BASELINE, "DENSE"):
        artifact["arms"][arm_name]["ranks"] = {key: None for key in keys}
    artifact["arms"][BASELINE]["ranks"].update({key: 1 for key in keys[:12]})
    artifact["arms"][CHUNK_BASELINE]["ranks"].update({key: 1 for key in keys[:14]})
    artifact["arms"]["DENSE"]["ranks"].update({key: 1 for key in keys[:13]})
    artifact["arms"]["EMPTY"]["ranks"] = {key: None for key in keys}

    decision = compute_metrics(artifact).decisions["DENSE"]
    assert decision.worst_stratum_regression_percentage_points == pytest.approx(-5.0)
    assert decision.condition_b is False


def test_best_lexical_arm_is_selected_from_the_measured_scores() -> None:
    """The reference arm is the higher measured lexical score, not a default.

    Every non-lexical qualification decision is relative to this selection.
    """
    metrics = compute_metrics(_artifact())
    baseline = metrics.arms[BASELINE]
    chunk_baseline = metrics.arms[CHUNK_BASELINE]
    assert isinstance(baseline, RunArmMetrics)
    assert isinstance(chunk_baseline, RunArmMetrics)
    assert baseline.recall_at[10].value == 3 / 5
    assert chunk_baseline.recall_at[10].value == 4 / 5
    assert metrics.best_lexical_arm == CHUNK_BASELINE


def test_two_cell_populations_are_refused_rather_than_pooled() -> None:
    """A governed set and a control set must not share one denominator.

    The instrument scores a negative-control population with the same arms as
    the governed one. Pooling them keeps every individual rank true while
    changing every headline rate, which is the hardest kind of wrong number to
    notice: nothing is false, and the denominator answers a question nobody
    asked. Refusing is the only safe reading.
    """
    artifact = {
        "cells": [
            {"set": "governed", "bridge": "B1", "direction": "A->B",
             "lang_pair": "en->en", "status": "RUN"},
            {"set": "gate_failing", "bridge": "B2", "direction": "A->B",
             "lang_pair": "en->en", "status": "RUN"},
        ],
        "arms": {"BASELINE": {"status": "RUN", "description": "d",
                              "ranks": {"B1|A->B": 1, "B2|A->B": 1}}},
        "k_values": [1, 5, 10, 20],
    }
    with pytest.raises(MetricsError, match="more than one 'set'"):
        compute_metrics(artifact)


def test_one_population_is_not_refused() -> None:
    """The guard must not fire on the ordinary single-population artifact.

    A refusal that also rejects the normal case would be discovered by making
    the tool unusable rather than by this test, and would then be removed
    rather than corrected.
    """
    artifact = {
        "cells": [
            {"set": "governed", "bridge": "B1", "direction": "A->B",
             "lang_pair": "en->en", "status": "RUN"},
            {"set": "governed", "bridge": "B2", "direction": "A->B",
             "lang_pair": "en->en", "status": "RUN"},
        ],
        "arms": {
            "BASELINE": {"status": "RUN", "description": "d",
                         "ranks": {"B1|A->B": 1, "B2|A->B": None}},
            "BASELINE-CHUNK-BM25": {"status": "RUN", "description": "d",
                                    "ranks": {"B1|A->B": 1, "B2|A->B": 2}},
        },
        "k_values": [1, 5, 10, 20],
    }
    assert compute_metrics(artifact).denominator == 2
