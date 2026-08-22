"""Real importable callables used to exercise the decision reference oracle."""

from __future__ import annotations

import functools

from nous_os.adjudication import HumanDecision


def direct_constructor() -> object:
    """Call the decision class by its exported name."""
    return HumanDecision()


def local_alias_constructor() -> object:
    """Resolve a local alias before calling the decision class."""
    decision_type = HumanDecision
    return decision_type()


class DecisionFactory:
    """A public callable object whose dunder manufactures a decision."""

    def __call__(self) -> object:
        return HumanDecision()


def mentions_decision_in_text() -> str:
    """The text HumanDecision is not an executable reference."""
    return "HumanDecision"


def type_checks_decision(value: object) -> bool:
    """Reference the class for a check without constructing a decision."""
    return type(value) is HumanDecision


def module_qualified_constructor() -> object:
    """Import the module locally and call the class through its qualifier."""
    import nous_os.adjudication as adjudication

    return adjudication.HumanDecision()


def function_local_import_constructor() -> object:
    """Import the class locally, with no module-global binding to resolve."""
    from nous_os.adjudication import HumanDecision as LocalDecision

    return LocalDecision()


class PartialDecisionMint:
    """A callable with no bytecode, used to pin fail-closed walk coverage."""

    make = functools.partial(HumanDecision)
