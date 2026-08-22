"""Decision constructors whose module has no decision-class global."""

from __future__ import annotations


def module_qualified_constructor(**kw: object) -> object:
    """Resolve the class through a locally imported module qualifier."""
    import nous_os.adjudication as m

    return m.HumanDecision(**kw)


def function_local_import_constructor(**kw: object) -> object:
    """Resolve the class through a function-local import."""
    from nous_os.adjudication import HumanDecision

    return HumanDecision(**kw)
