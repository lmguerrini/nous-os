"""Structural and executable checks for the registered operation boundary.

The important failure is a new route to a governed implementation that never
asks the registry whether its caller has authority. These tests inspect
bindings, rather than spelling-sensitive names, and execute real operations
against temporary files so a declared tier cannot become an untested label.
"""

from __future__ import annotations

import ast
import hashlib
import importlib
import inspect
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import get_type_hints

import pytest

import nous_os.capability as authority
import nous_os.operations
from nous_os.adjudication import HumanDecision, PromotionRecord, Rejection, RejectionMemory, Verdict
from nous_os.attribution import AttributedKey, KeyOrigin
from nous_os.capability import Grant, NotAuthorized, Tier, execute
from nous_os.canonical import Assertion, LifecycleState, SupportClass
from nous_os.candidates import CandidateStore, Proposal
from nous_os.chunking import chunk_document
from nous_os.compile import FlatTopK
from nous_os.config import DataRoot
from nous_os.derived import build
from nous_os.extraction import ExtractionStore, Extractor
from nous_os.discovery import (
    BridgeCard,
    BridgeRegistry,
    Depth,
    Endpoint,
    EpistemicClass,
    Gate,
    GateOutcome,
    GateVector,
    RoundResult,
)
from nous_os.ledger import IngestResult, IngestStatus, Ledger, ingest
from nous_os.provenance import CharLocator, Citation, DerivedCitation, Locator
from nous_os.projection import KnowledgeState, RELIABILITY
from nous_os.reconciliation import (
    EvidenceBasis,
    Origin,
    RelationClass,
    RelationEnd,
    RelationProposal,
    RelationStore,
)
from nous_os.snapshots import SnapshotStore
from nous_os.temporal import ClaimKey, TemporalIndex
from nous_os.untrusted import UntrustedText


REPOSITORY = Path(__file__).resolve().parent.parent
PACKAGE = REPOSITORY / "src" / "nous_os"
SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
RECORDED_AT = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)
TEMPORAL_KEY = ClaimKey("seeded-claim")
_ACCOUNTED_TEST_REGISTRATION_MODULES = frozenset(
    {"test_capability", "tests.test_capability"}
)


@dataclass(frozen=True, slots=True)
class _Operation:
    """One project operation, derived from the live registry entry."""

    name: str
    tier: Tier
    module: str
    qualname: str


@dataclass(frozen=True, slots=True)
class _FunctionBinding:
    """The defining module and qualified name of one governed function."""

    module: str
    qualname: str


@dataclass(frozen=True, slots=True)
class _ModuleBinding:
    """A local name bound to an imported module, not to one function."""

    module: str


@dataclass(frozen=True, slots=True)
class _CanonDigest:
    """A digest together with the byte counts that produced it."""

    value: str
    snapshot_bytes: int
    ledger_bytes: int


def _resolve_import_from(
    module: str,
    is_package: bool,
    node: ast.ImportFrom,
) -> str | None:
    """Resolve one import-from module against the scanned module's package."""
    if node.level == 0:
        return node.module
    package_parts = module.split(".") if is_package else module.split(".")[:-1]
    ascents = node.level - 1
    if ascents >= len(package_parts):
        return None
    resolved = package_parts[: len(package_parts) - ascents]
    if node.module is not None:
        resolved.extend(node.module.split("."))
    return ".".join(resolved)


class _Scope:
    """A lexical scope whose bindings can be resolved at each use site."""

    def __init__(
        self,
        parent: _Scope | None,
        bindings: dict[str, _FunctionBinding | _ModuleBinding | None] | None = None,
        qualname_prefix: str = "",
    ) -> None:
        self.parent = parent
        self.bindings = {} if bindings is None else dict(bindings)
        self.qualname_prefix = qualname_prefix

    def bind(self, name: str, value: _FunctionBinding | _ModuleBinding | None) -> None:
        self.bindings[name] = value

    def resolve(self, name: str) -> _FunctionBinding | _ModuleBinding | None:
        if name in self.bindings:
            return self.bindings[name]
        if self.parent is None:
            return None
        return self.parent.resolve(name)

    def binds(self, name: str) -> bool:
        if name in self.bindings:
            return True
        return self.parent is not None and self.parent.binds(name)


class _FunctionLocalNames(ast.NodeVisitor):
    """Collect direct function locals without letting nested scopes leak out."""

    def __init__(self) -> None:
        self.names: set[str] = set()
        self.global_names: set[str] = set()
        self.nonlocal_names: set[str] = set()

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.names.add(node.id)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.names.add(alias.asname or alias.name.split(".", 1)[0])

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for alias in node.names:
            if alias.name != "*":
                self.names.add(alias.asname or alias.name)

    def visit_Global(self, node: ast.Global) -> None:
        self.global_names.update(node.names)

    def visit_Nonlocal(self, node: ast.Nonlocal) -> None:
        self.nonlocal_names.update(node.names)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.names.add(node.name)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.names.add(node.name)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        return

    def _visit_comprehension(self, node: ast.expr) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.comprehension):
                self.visit(child.iter)
                for condition in child.ifs:
                    self.visit(condition)
            else:
                self.visit(child)

    visit_ListComp = _visit_comprehension
    visit_SetComp = _visit_comprehension
    visit_GeneratorExp = _visit_comprehension
    visit_DictComp = _visit_comprehension


def _function_local_names(node: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    """Return names Python treats as local before the function body runs."""
    collector = _FunctionLocalNames()
    for statement in node.body:
        collector.visit(statement)
    arguments = (
        *node.args.posonlyargs,
        *node.args.args,
        *node.args.kwonlyargs,
    )
    collector.names.update(argument.arg for argument in arguments)
    if node.args.vararg is not None:
        collector.names.add(node.args.vararg.arg)
    if node.args.kwarg is not None:
        collector.names.add(node.args.kwarg.arg)
    return collector.names - collector.global_names - collector.nonlocal_names


class _BindingUseScanner:
    """Find actual uses of governed function bindings in one parsed module."""

    def __init__(
        self,
        module: str,
        governed: frozenset[_FunctionBinding],
        *,
        is_package: bool = False,
    ) -> None:
        self._module = module
        self._is_package = is_package
        self._governed = governed
        self._governed_by_name = {(item.module, item.qualname): item for item in governed}
        self._operations_reexports = {
            name: binding
            for name, value in vars(nous_os.operations).items()
            for binding in governed
            if getattr(value, "__module__", None) == binding.module
            and getattr(value, "__qualname__", None) == binding.qualname
        }
        module_names = {item.module for item in governed}
        self._module_names = {
            ".".join(parts[:length])
            for module_name in module_names
            for parts in [module_name.split(".")]
            for length in range(1, len(parts) + 1)
        }
        self.used = False

    def scans(self, tree: ast.Module) -> bool:
        """Whether this source holds and uses at least one governed function."""
        self._visit_block(tree.body, _Scope(None))
        return self.used

    def _binding_for_expression(
        self, node: ast.expr, scope: _Scope
    ) -> _FunctionBinding | _ModuleBinding | None:
        if isinstance(node, ast.Name):
            return scope.resolve(node.id)
        if isinstance(node, ast.Call):
            if (
                not isinstance(node.func, ast.Name)
                or node.func.id != "getattr"
                or scope.binds("getattr")
                or len(node.args) < 2
            ):
                return None
            attribute = node.args[1]
            if not isinstance(attribute, ast.Constant) or type(attribute.value) is not str:
                # A computed attribute name is not statically resolvable, so do not guess.
                return None
            base = self._binding_for_expression(node.args[0], scope)
            if not isinstance(base, _ModuleBinding):
                return None
            return self._import_binding(base.module, attribute.value)
        if not isinstance(node, ast.Attribute):
            return None
        base = self._binding_for_expression(node.value, scope)
        if not isinstance(base, _ModuleBinding):
            return None
        direct = self._governed_by_name.get((base.module, node.attr))
        if direct is not None:
            return direct
        reexport = (
            self._operations_reexports.get(node.attr)
            if base.module == "nous_os.operations"
            else None
        )
        if reexport is not None:
            return reexport
        module_name = f"{base.module}.{node.attr}"
        if module_name in self._module_names:
            return _ModuleBinding(module_name)
        return None

    def _import_binding(self, module: str, name: str) -> _FunctionBinding | _ModuleBinding | None:
        direct = self._governed_by_name.get((module, name))
        if direct is not None:
            return direct
        reexport = (
            self._operations_reexports.get(name)
            if module == "nous_os.operations"
            else None
        )
        if reexport is not None:
            return reexport
        module_name = f"{module}.{name}" if module else name
        if module_name in self._module_names:
            return _ModuleBinding(module_name)
        return None

    def _defined_binding(self, scope: _Scope, name: str) -> _FunctionBinding | None:
        return self._governed_by_name.get((self._module, scope.qualname_prefix + name))

    def _bind_target(
        self,
        target: ast.expr,
        value: _FunctionBinding | _ModuleBinding | None,
        scope: _Scope,
    ) -> None:
        if isinstance(target, ast.Name):
            scope.bind(target.id, value)
            return
        if isinstance(target, (ast.Tuple, ast.List)):
            for item in target.elts:
                self._bind_target(item, None, scope)
            return
        if isinstance(target, ast.Starred):
            self._bind_target(target.value, None, scope)

    def _visit_block(self, statements: list[ast.stmt], scope: _Scope) -> None:
        for statement in statements:
            self._visit(statement, scope)

    def _visit_function(
        self,
        node: ast.FunctionDef | ast.AsyncFunctionDef,
        scope: _Scope,
    ) -> None:
        scope.bind(node.name, self._defined_binding(scope, node.name))
        for decorator in node.decorator_list:
            self._visit(decorator, scope)
        for default in (*node.args.defaults, *node.args.kw_defaults):
            if default is not None:
                self._visit(default, scope)
        local_bindings = {name: None for name in _function_local_names(node)}
        prefix = f"{scope.qualname_prefix}{node.name}.<locals>."
        self._visit_block(node.body, _Scope(scope, local_bindings, prefix))

    def _visit_comprehension(self, node: ast.expr, scope: _Scope) -> None:
        generators = node.generators  # type: ignore[attr-defined]
        local = _Scope(scope)
        for generator in generators:
            self._visit(generator.iter, local)
            self._visit(generator.target, local)
            self._bind_target(generator.target, None, local)
            for condition in generator.ifs:
                self._visit(condition, local)
        if isinstance(node, ast.DictComp):
            self._visit(node.key, local)
            self._visit(node.value, local)
        else:
            self._visit(node.elt, local)  # type: ignore[attr-defined]

    def _visit(self, node: ast.AST, scope: _Scope) -> None:
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load) and isinstance(
                scope.resolve(node.id), _FunctionBinding
            ):
                self.used = True
            return
        if isinstance(node, ast.Attribute):
            self._visit(node.value, scope)
            if isinstance(node.ctx, ast.Load) and isinstance(
                self._binding_for_expression(node, scope), _FunctionBinding
            ):
                self.used = True
            return
        if isinstance(node, ast.Import):
            for alias in node.names:
                local_name = alias.asname or alias.name.split(".", 1)[0]
                module_name = alias.name if alias.asname else alias.name.split(".", 1)[0]
                scope.bind(
                    local_name,
                    _ModuleBinding(module_name) if module_name in self._module_names else None,
                )
            return
        if isinstance(node, ast.ImportFrom):
            module = _resolve_import_from(self._module, self._is_package, node)
            for alias in node.names:
                if alias.name != "*":
                    binding = (
                        self._import_binding(module, alias.name)
                        if module is not None
                        else None
                    )
                    scope.bind(alias.asname or alias.name, binding)
            return
        if isinstance(node, ast.Call):
            if isinstance(
                self._binding_for_expression(node.func, scope), _FunctionBinding
            ):
                self.used = True
            for child in ast.iter_child_nodes(node):
                self._visit(child, scope)
            return
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self._visit_function(node, scope)
            return
        if isinstance(node, ast.ClassDef):
            scope.bind(node.name, None)
            for decorator in node.decorator_list:
                self._visit(decorator, scope)
            class_scope = _Scope(scope, qualname_prefix=f"{scope.qualname_prefix}{node.name}.")
            self._visit_block(node.body, class_scope)
            return
        if isinstance(node, ast.Assign):
            self._visit(node.value, scope)
            binding = self._binding_for_expression(node.value, scope)
            for target in node.targets:
                self._visit(target, scope)
                self._bind_target(target, binding, scope)
            return
        if isinstance(node, ast.AnnAssign):
            if node.value is not None:
                self._visit(node.value, scope)
            self._visit(node.target, scope)
            self._bind_target(
                node.target,
                self._binding_for_expression(node.value, scope) if node.value is not None else None,
                scope,
            )
            return
        if isinstance(node, ast.NamedExpr):
            self._visit(node.value, scope)
            self._bind_target(node.target, self._binding_for_expression(node.value, scope), scope)
            return
        if isinstance(node, (ast.For, ast.AsyncFor)):
            self._visit(node.iter, scope)
            self._visit(node.target, scope)
            self._bind_target(node.target, None, scope)
            self._visit_block(node.body, scope)
            self._visit_block(node.orelse, scope)
            return
        if isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                self._visit(item.context_expr, scope)
                if item.optional_vars is not None:
                    self._visit(item.optional_vars, scope)
                    self._bind_target(item.optional_vars, None, scope)
            self._visit_block(node.body, scope)
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            self._visit_comprehension(node, scope)
            return
        for child in ast.iter_child_nodes(node):
            self._visit(child, scope)


def _package_sources() -> tuple[Path, ...]:
    """Every package source file, guarded against a vacuous filesystem scan."""
    sources = tuple(sorted(PACKAGE.rglob("*.py")))
    assert sources, "no package source files were found for the structural scan"
    return sources


def _module_name(path: Path) -> str:
    """Return the import name corresponding to one source file."""
    relative = path.relative_to(REPOSITORY / "src").with_suffix("")
    if relative.name == "__init__":
        return ".".join(relative.parent.parts)
    return ".".join(relative.parts)


def _source_for_module(module: str) -> Path | None:
    """Resolve a project module name to its source file without importing it."""
    parts = module.split(".")
    if not parts or parts[0] != "nous_os":
        return None
    relative = Path(*parts[1:])
    if not relative.parts:
        return PACKAGE / "__init__.py"
    return (PACKAGE / relative).with_suffix(".py")


def _project_operations() -> tuple[_Operation, ...]:
    """Derive package-owned registry entries and their function identities."""
    registry = authority._REGISTRY
    assert registry, "the operation registry is empty; no boundary can be scanned"
    found = []
    excluded: list[str] = []
    for name, entry in registry.items():
        tier, implementation = entry
        module = getattr(implementation, "__module__", None)
        if type(module) is not str or not (
            module == "nous_os" or module.startswith("nous_os.")
        ):
            if module in _ACCOUNTED_TEST_REGISTRATION_MODULES:
                # These permanent registrations are exercised by their defining tests.
                continue
            excluded.append(name)
            continue
        source = _source_for_module(module)
        assert source is not None and source.is_file(), (
            f"registered implementation {name!r} names a missing package module {module!r}"
        )
        qualname = getattr(implementation, "__qualname__", None)
        assert type(qualname) is str and qualname, (
            f"registered implementation {name!r} has no qualified name"
        )
        found.append(_Operation(name, tier, module, qualname))
    assert not excluded, (
        "registered entries excluded from package operation enumeration: "
        f"{sorted(excluded)!r}"
    )
    assert found, "the registry contains no implementation defined in the package"
    return tuple(sorted(found, key=lambda operation: operation.name))


def _governed_implementations() -> frozenset[_FunctionBinding]:
    """Derive the implementation identities the binding scan must resolve."""
    implementations = frozenset(
        _FunctionBinding(operation.module, operation.qualname)
        for operation in _project_operations()
    )
    assert implementations, "no governed implementation identities were derived"
    return implementations


def _parsed_package_sources() -> dict[Path, ast.Module]:
    """Parse every source file and reject an empty parsed set explicitly."""
    parsed = {
        path: ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for path in _package_sources()
    }
    assert parsed, "no source files were parsed for the structural scan"
    return parsed


def _canon_digest(root: Path, ledger: Ledger) -> _CanonDigest:
    """Hash all snapshot bytes and the ledger bytes, in deterministic order."""
    digest = hashlib.sha256()
    snapshots = root / "snapshots"
    snapshot_bytes = 0
    for path in sorted(path for path in snapshots.rglob("*") if path.is_file()):
        payload = path.read_bytes()
        snapshot_bytes += len(payload)
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(payload)
        digest.update(b"\0")
    ledger_payload = ledger.path.read_bytes() if ledger.path.is_file() else b""
    digest.update(b"ledger\0")
    digest.update(ledger_payload)
    return _CanonDigest(digest.hexdigest(), snapshot_bytes, len(ledger_payload))


@dataclass(frozen=True, slots=True)
class _TemporaryCanon:
    """The real files needed to execute every current registered operation."""

    root: Path
    snapshots: SnapshotStore
    ledger: Ledger
    derived_path: Path
    data_root: DataRoot
    canon_root_path: Path
    citation: Citation
    relation_citation: Citation
    candidates: CandidateStore
    relations: RelationStore
    temporal: TemporalIndex
    bridges: BridgeRegistry
    rejections: RejectionMemory
    decision: HumanDecision
    candidate: Proposal
    authorizations: Path


def _temporal_index(citation: Citation) -> TemporalIndex:
    """Seed overlapping canonical assertions so temporal reads prove a result."""
    index = TemporalIndex()
    for number in (1, 2):
        index.add(
            TEMPORAL_KEY,
            Assertion(
                id=f"asr_{number:026X}",
                text=f"temporal assertion {number}",
                citation=citation,
                support=SupportClass.DIRECT_QUOTE,
                recorded_at=RECORDED_AT,
                state=LifecycleState.CANONICAL,
                valid_from=RECORDED_AT,
            ),
        )
    return index


def _axis_temporal_index(citation: Citation) -> TemporalIndex:
    """Seed one assertion included at the query instant and one excluded by it."""
    index = TemporalIndex()
    established = Assertion(
        id="asr_0000000000000000000000000A",
        text="established at the operation query instant",
        citation=citation,
        support=SupportClass.DIRECT_QUOTE,
        recorded_at=RECORDED_AT,
        state=LifecycleState.CANONICAL,
        valid_from=RECORDED_AT,
        valid_to=RECORDED_AT.replace(day=3),
    )
    excluded = Assertion(
        id="asr_0000000000000000000000000B",
        text="excluded at the operation query instant",
        citation=citation,
        support=SupportClass.DIRECT_QUOTE,
        recorded_at=RECORDED_AT.replace(day=3),
        state=LifecycleState.CANONICAL,
        valid_from=RECORDED_AT.replace(day=3),
        valid_to=RECORDED_AT.replace(day=4),
    )
    index.add(TEMPORAL_KEY, established)
    index.add(TEMPORAL_KEY, excluded)
    return index


def _temporary_canon(tmp_path: Path) -> _TemporaryCanon:
    """Build one small canonical record and its disposable derived index."""
    root = tmp_path / "canon"
    snapshots = SnapshotStore(root / "snapshots")
    ledger = Ledger(root / "ledger.jsonl")
    result = ingest(
        snapshots,
        ledger,
        SOURCE_ID,
        UntrustedText("alpha signal in a source document"),
        RECORDED_AT,
    )
    assert result.entry is not None, "fixture ingest did not create a ledger entry"
    derived_path = build(snapshots, ledger, tmp_path / "derived.sqlite")
    documents = tmp_path / "documents"
    documents.mkdir()
    (documents / "source.md").write_text("alpha signal in a source document", encoding="utf-8")
    citation = Citation(
        SOURCE_ID,
        result.entry.snapshot_digest,
        Locator(0, 5),
        "alpha",
    )
    relation_snapshot = snapshots.put(
        SOURCE_ID, b"beta signal in a source document"
    )
    relation_citation = Citation(
        SOURCE_ID,
        relation_snapshot.digest,
        Locator(0, 4),
        "beta",
    )
    candidate = Proposal(
        "asr_01ARZ3NDEKTSV4RRFFQ69G5FAB",
        SOURCE_ID,
        UntrustedText("candidate material awaiting authorization"),
        RECORDED_AT,
        "fixture holder",
    )
    return _TemporaryCanon(
        root=root,
        snapshots=snapshots,
        ledger=ledger,
        derived_path=derived_path,
        data_root=DataRoot(documents),
        canon_root_path=tmp_path / "assertion-canon",
        citation=citation,
        relation_citation=relation_citation,
        candidates=CandidateStore(tmp_path / "candidates.jsonl"),
        relations=RelationStore(tmp_path / "relations.jsonl"),
        temporal=_temporal_index(citation),
        bridges=BridgeRegistry(tmp_path / "bridges.jsonl"),
        rejections=RejectionMemory(tmp_path / "rejections.jsonl"),
        decision=HumanDecision(
            "fixture adjudicator",
            Verdict.PROMOTE,
            RECORDED_AT,
            "The fixture authorizes this candidate.",
            AttributedKey(ClaimKey("fixture-promotion"), KeyOrigin.OPERATOR),
        ),
        candidate=candidate,
        authorizations=tmp_path / "authorizations.jsonl",
    )


def _discovery_card(citation: Citation) -> BridgeCard:
    """Build one accepted bridge card for a real deterministic round."""
    endpoint = Endpoint("fixture project", citation, "alpha")
    return BridgeCard(
        card_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAC",
        cluster_id="fixture-discovery-cluster",
        left=endpoint,
        right=Endpoint("second fixture project", citation, "alpha"),
        epistemic_class=EpistemicClass.DERIVED,
        depth=Depth.DEEP,
        non_triviality="The fixture relates two distinct projects.",
        consequence="The fixture produces a reviewable bridge.",
        noise_objection="The shared fixture word could be coincidental.",
        gates=GateVector({gate: GateOutcome.PASS for gate in Gate}, {}),
        origin_round=1,
    )


def _read_arguments(name: str, canon: _TemporaryCanon) -> dict[str, object]:
    """Supply real arguments for each known read operation, or fail loudly."""
    context_chunks = chunk_document(
        SOURCE_ID,
        "# Fixture context\n\nalpha preserves the fixture boundary.",
    )
    arguments = {
        "search": {"path": canon.derived_path, "query": "alpha"},
        "context": {"path": canon.derived_path, "source_id": SOURCE_ID},
        "semantic": {"index_path": None, "query": "semantic fixture"},
        "sources": {"path": canon.derived_path},
        "versions": {"path": canon.derived_path, "source_id": SOURCE_ID},
        "read_span": {"store": canon.snapshots, "citation": canon.citation},
        "verify_derived": {
            "extraction_store": ExtractionStore(canon.root / "extraction-store"),
            "snapshot_store": canon.snapshots,
            "ledger": canon.ledger,
            "citation": DerivedCitation(
                asset_source_id=SOURCE_ID,
                asset_digest="0" * 64,
                extractor=Extractor.PLAIN_TEXT,
                extractor_version="1",
                record_digest="0" * 64,
                locator=CharLocator(0, 1),
                span="a",
            ),
        },
        "list_documents": {"root": canon.data_root},
        "list_assertions": {"root": canon.canon_root_path},
        "describe_corpus": {"root": canon.data_root},
        "proposals": {"store": canon.candidates},
        "relations": {"store": canon.relations},
        "verify_relations": {"store": canon.relations, "snapshots": canon.snapshots},
        "rejections": {"memory": canon.rejections},
        "bridges": {"registry": canon.bridges},
        "as_of": {
            "index": canon.temporal,
            "valid_at": RECORDED_AT,
            "recorded_as_of": RECORDED_AT,
        },
        "conflicts": {"index": canon.temporal, "key": TEMPORAL_KEY},
        "supersession": {"index": canon.temporal, "key": TEMPORAL_KEY},
        "project": {"state": KnowledgeState(canon.temporal), "policy": RELIABILITY},
        "compile_context": {
            "chunks": context_chunks,
            "ranking": tuple(chunk.id for chunk in context_chunks),
            "strategy": FlatTopK(),
            "budget_tokens": sum(chunk.tokens for chunk in context_chunks),
        },
    }
    if name not in arguments:
        pytest.fail(f"read operation {name!r} has no executable test arguments")
    return arguments[name]


def _propose_arguments(name: str, canon: _TemporaryCanon) -> dict[str, object]:
    """Supply real arguments for every current proposal-tier operation."""
    arguments = {
        "record_proposal": {
            "store": canon.candidates,
            "source_id": SOURCE_ID,
            "content": UntrustedText("this is a proposal, not a fact"),
            "proposed_at": RECORDED_AT,
            "holder": "proposer",
        },
        "discover": {
            "round_number": 1,
            "candidates": (_discovery_card(canon.citation),),
            "registry": canon.bridges,
            "memory": canon.rejections,
            "at": RECORDED_AT,
            "consult_memory": False,
        },
        "adjudicate": {
            "memory": canon.rejections,
            "cluster_id": "fixture-adjudication-cluster",
            "failed_gate": Gate.G1.value,
            "reason": "the fixture records a durable failed gate",
            "round_number": 1,
            "rejected_at": RECORDED_AT,
        },
        "propose_relation": {
            "store": canon.relations,
            "snapshots": canon.snapshots,
            "proposal": RelationProposal(
                relation_class=RelationClass.RELATED,
                left=RelationEnd(SOURCE_ID, canon.citation.snapshot_digest),
                right=RelationEnd(SOURCE_ID, canon.relation_citation.snapshot_digest),
                bases=(EvidenceBasis.MODEL_JUDGEMENT,),
                citations=(canon.citation, canon.relation_citation),
                origin=Origin.OPERATOR,
                producer="operation-fixture/1",
                proposed_at=RECORDED_AT,
                notes="The fixture only establishes a relation between two versions.",
            ),
        },
    }
    if name not in arguments:
        pytest.fail(f"propose operation {name!r} has no executable test arguments")
    return arguments[name]


def _promote_arguments(name: str, canon: _TemporaryCanon) -> dict[str, object]:
    """Supply an effectful argument set for every known promotion operation."""
    arguments = {
        "ingest_source": {
            "store": canon.snapshots,
            "ledger": canon.ledger,
            "source_id": SOURCE_ID,
            "content": UntrustedText("a later version that must be stored"),
            "recorded_at": RECORDED_AT,
        },
        "promote_candidate": {
            "decision": canon.decision,
            "candidate": canon.candidate,
            "authorizations": canon.authorizations,
        },
    }
    if name not in arguments:
        pytest.fail(f"promote operation {name!r} has no executable test arguments")
    return arguments[name]


def _authority_offences(path: Path, tree: ast.Module) -> list[str]:
    """Find authority use by binding, not unrelated methods named execute."""
    module_name = _module_name(path)
    is_package = path.name == "__init__.py"
    imported_modules: dict[str, str] = {}
    authority_functions: dict[str, str] = {}
    offences: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "nous_os.capability":
                    imported_modules[alias.asname or "nous_os"] = (
                        alias.name if alias.asname else "nous_os"
                    )
                    offences.append(f"{path.name} imports the authority module")
        if isinstance(node, ast.ImportFrom):
            imported_from = _resolve_import_from(module_name, is_package, node)
            if imported_from == "nous_os.capability":
                offences.append(f"{path.name} imports the authority module")
                for alias in node.names:
                    if alias.name in {"Grant", "execute"}:
                        authority_functions[alias.asname or alias.name] = alias.name
            if imported_from == "nous_os":
                for alias in node.names:
                    if alias.name == "capability":
                        imported_modules[alias.asname or alias.name] = "nous_os.capability"
                        offences.append(f"{path.name} imports the authority module")

    def imported_module(node: ast.expr) -> str | None:
        if isinstance(node, ast.Name):
            return imported_modules.get(node.id)
        if isinstance(node, ast.Attribute):
            base = imported_module(node.value)
            return f"{base}.{node.attr}" if base is not None else None
        return None

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name):
            imported = authority_functions.get(node.func.id)
            if imported is not None:
                offences.append(f"{path.name} calls {imported}")
        if (
            isinstance(node.func, ast.Attribute)
            and imported_module(node.func.value) == "nous_os.capability"
            and node.func.attr in {"Grant", "execute"}
        ):
            offences.append(f"{path.name} calls {node.func.attr}")
    return offences


def test_registered_project_operations_have_the_required_names_and_tiers() -> None:
    """A missing entry or changed tier would leave a real function ungoverned."""
    operations = _project_operations()
    assert operations, "the registered entry-point enumeration is empty"
    expected = {
        "search": Tier.READ,
        "context": Tier.READ,
        "semantic": Tier.READ,
        "sources": Tier.READ,
        "versions": Tier.READ,
        "list_assertions": Tier.READ,
        "read_span": Tier.READ,
        "verify_derived": Tier.READ,
        "list_documents": Tier.READ,
        "describe_corpus": Tier.READ,
        "proposals": Tier.READ,
        "rejections": Tier.READ,
        "bridges": Tier.READ,
        "as_of": Tier.READ,
        "conflicts": Tier.READ,
        "supersession": Tier.READ,
        "project": Tier.READ,
        "compile_context": Tier.READ,
        "record_proposal": Tier.PROPOSE,
        "relations": Tier.READ,
        "propose_relation": Tier.PROPOSE,
        "verify_relations": Tier.READ,
        "discover": Tier.PROPOSE,
        "adjudicate": Tier.PROPOSE,
        "ingest_source": Tier.PROMOTE,
        "promote_candidate": Tier.PROMOTE,
    }
    assert len(expected) == 26
    assert len(operations) == 26
    assert {operation.name: operation.tier for operation in operations} == expected
    assert all(
        operation.tier is not Tier.EXTERNAL_CONSEQUENTIAL_ACTION
        for operation in operations
    )


def test_governed_implementation_bindings_are_limited_to_the_pinned_modules() -> None:
    """A new direct route or a stale exemption changes this exact binding set."""
    governed = _governed_implementations()
    parsed = _parsed_package_sources()
    holding = {
        path.relative_to(PACKAGE).as_posix()
        for path, tree in parsed.items()
        if _BindingUseScanner(
            _module_name(path),
            governed,
            is_package=path.name == "__init__.py",
        ).scans(tree)
    }
    expected = {
        "operations.py",  # Registration site: it alone imports implementations to register them.
        "semantic_index.py",  # semantic search owns its governed implementation.
        "measure.py",  # Existing measurement code imports and calls search; a forward obligation.
        "config.py",  # describe_corpus calls the governed list_documents function.
        "provenance.py",  # quote_lint calls governed read_span while remaining unguided itself.
        "discovery.py",  # Mechanical gates call governed read_span and search while remaining unguided.
    }
    assert holding == expected, (
        "governed implementation bindings changed: "
        f"unexpected={sorted(holding - expected)}, missing={sorted(expected - holding)}"
    )


def test_registered_wrapper_annotations_resolve_without_importing_discovery_at_runtime() -> None:
    """The module's own TYPE_CHECKING names resolve every circular wrapper hint."""
    hint_globals = dict(vars(nous_os.operations))
    tree = ast.parse(inspect.getsource(nous_os.operations))
    type_checking_blocks = [
        node
        for node in tree.body
        if isinstance(node, ast.If)
        and isinstance(node.test, ast.Name)
        and node.test.id == "TYPE_CHECKING"
    ]
    assert len(type_checking_blocks) == 1
    for statement in type_checking_blocks[0].body:
        if isinstance(statement, ast.ImportFrom) and statement.module is not None:
            module = importlib.import_module(statement.module)
            hint_globals.update(
                {
                    alias.asname or alias.name: getattr(module, alias.name)
                    for alias in statement.names
                }
            )
    wrappers = tuple(
        authority._REGISTRY[operation.name][1] for operation in _project_operations()
    )
    assert len(wrappers) == 26
    resolved = {
        wrapper.__name__: get_type_hints(
            wrapper,
            globalns=hint_globals if wrapper.__module__ == nous_os.operations.__name__ else None,
        )
        for wrapper in wrappers
    }
    assert set(resolved) >= {
        "rejections",
        "bridges",
        "discover",
        "adjudicate",
        "promote_candidate",
    }
    assert resolved["rejections"]["return"] == tuple[Rejection, ...]
    assert resolved["bridges"]["return"] == tuple[BridgeCard, ...]
    assert resolved["discover"]["return"] is RoundResult
    assert resolved["adjudicate"]["return"] is Rejection
    assert resolved["promote_candidate"]["return"] is PromotionRecord


def test_relative_imports_and_literal_getattr_reveal_governed_uses() -> None:
    """Relative or literal-indirect binding syntax cannot hide a governed use."""
    governed = _governed_implementations()
    sources = (
        (
            "nous_os.synthetic",
            "from .derived import search\nsearch(path=None, query='alpha')\n",
        ),
        (
            "nous_os.synthetic",
            "from . import derived\nderived.search(path=None, query='alpha')\n",
        ),
        (
            "nous_os.nested.synthetic",
            "from ..derived import search\nsearch(path=None, query='alpha')\n",
        ),
        (
            "nous_os.synthetic",
            "import nous_os.derived as derived\n"
            "getattr(derived, 'search')(path=None, query='alpha')\n",
        ),
        (
            "nous_os.synthetic",
            "from nous_os.provenance import read_span\nread_span(store, citation)\n",
        ),
        (
            "nous_os.synthetic",
            "from nous_os.operations import read_span\nread_span(store, citation)\n",
        ),
        (
            "nous_os.synthetic",
            "import nous_os.operations as ops\nops.read_span(store, citation)\n",
        ),
        (
            "nous_os.synthetic",
            "from nous_os import operations\noperations.read_span(store, citation)\n",
        ),
        (
            "nous_os.synthetic",
            "import nous_os.operations\nnous_os.operations.read_span(store, citation)\n",
        ),
    )
    assert all(
        _BindingUseScanner(module, governed).scans(ast.parse(source))
        for module, source in sources
    )


def test_colliding_names_and_unrelated_attributes_are_not_governed_uses() -> None:
    """Local collisions, regular-expression methods, and dynamic names stay clear."""
    governed = _governed_implementations()
    sources = (
        "def use(search):\n    return search('alpha')\n",
        "import re\ncompiled = re.compile('alpha')\ncompiled.search('alpha')\n",
        "import nous_os.derived as derived\n"
        "name = 'search'\ngetattr(derived, name)(path=None, query='alpha')\n",
        "import nous_os.derived as derived\n"
        "def getattr(module, name):\n    return lambda **kwargs: None\n"
        "getattr(derived, 'search')(path=None, query='alpha')\n",
    )
    assert not any(
        _BindingUseScanner("nous_os.synthetic", governed).scans(ast.parse(source))
        for source in sources
    )


def test_relative_authority_imports_reveal_imports_and_calls() -> None:
    """Relative direct and package imports cannot hide self-authorization."""
    sources = (
        "from .capability import Grant, execute\n"
        "execute(Grant('reader', frozenset()), 'search')\n",
        "from . import capability as authority\n"
        "authority.execute(authority.Grant('reader', frozenset()), 'search')\n",
    )
    for source in sources:
        offences = _authority_offences(PACKAGE / "synthetic.py", ast.parse(source))
        assert any("imports the authority module" in offence for offence in offences)
        assert any("calls execute" in offence for offence in offences)
        assert any("calls Grant" in offence for offence in offences)


def test_local_authority_names_and_unrelated_calls_are_not_offences() -> None:
    """Unimported local collisions and unrelated methods do not create offences."""
    source = (
        "class Grant:\n    pass\n"
        "def execute(value):\n    return value\n"
        "class Worker:\n"
        "    def execute(self, value):\n        return value\n"
        "execute(Grant())\nWorker().execute(Grant())\n"
    )
    assert _authority_offences(PACKAGE / "synthetic.py", ast.parse(source)) == []


def test_project_operation_enumeration_rejects_an_external_implementation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A foreign registry entry cannot disappear before the pinned map is checked."""
    monkeypatch.setattr(authority, "_REGISTRY", dict(authority._REGISTRY))
    authority.register("review_unchecked_unlink", Tier.READ, Path.unlink)
    with pytest.raises(AssertionError, match="review_unchecked_unlink"):
        _project_operations()


def test_governed_defining_modules_cannot_issue_or_use_their_own_authority() -> None:
    """A defining module that could self-authorize would be a confused deputy."""
    governed = _governed_implementations()
    parsed = _parsed_package_sources()
    defining_sources = {
        _source_for_module(binding.module) for binding in governed
    }
    assert defining_sources and None not in defining_sources, (
        "no defining source files were derived from the implementation registry"
    )
    offences: list[str] = []
    for path in sorted(defining_sources):
        assert path is not None
        if path.name == "operations.py":
            continue
        tree = parsed[path]
        offences.extend(_authority_offences(path, tree))
    assert not offences, "defining modules may not self-authorize:\n" + "\n".join(offences)


def test_the_canon_digest_is_stable_and_sensitive_to_every_input(
    tmp_path: Path,
) -> None:
    """An empty, constant, or random digest instrument cannot support canon checks."""
    canon = _temporary_canon(tmp_path)
    first = _canon_digest(canon.root, canon.ledger)
    unchanged = _canon_digest(canon.root, canon.ledger)
    assert first.snapshot_bytes > 0
    assert first.ledger_bytes > 0
    assert unchanged == first

    snapshot_files = tuple(
        sorted(
            path
            for path in (canon.root / "snapshots").rglob("*")
            if path.is_file()
        )
    )
    assert snapshot_files
    snapshot_payload = snapshot_files[0].read_bytes()
    assert snapshot_payload
    snapshot_files[0].write_bytes(
        bytes((snapshot_payload[0] ^ 1,)) + snapshot_payload[1:]
    )
    snapshot_changed = _canon_digest(canon.root, canon.ledger)
    assert snapshot_changed != first

    ledger_payload = canon.ledger.path.read_bytes()
    canon.ledger.path.write_bytes(ledger_payload + b" ")
    ledger_changed = _canon_digest(canon.root, canon.ledger)
    assert ledger_changed != snapshot_changed


def test_every_read_operation_executes_without_changing_canon(tmp_path: Path) -> None:
    """A read tier that writes canon would violate its authority even when allowed."""
    canon = _temporary_canon(tmp_path)
    reads = tuple(
        operation for operation in _project_operations() if operation.tier is Tier.READ
    )
    assert reads, "the read-operation derivation is empty"
    before = _canon_digest(canon.root, canon.ledger)
    grant = Grant("reader", frozenset({Tier.READ}))
    for operation in reads:
        returned = execute(grant, operation.name, **_read_arguments(operation.name, canon))
        if operation.name == "semantic":
            assert returned == {
                "status": "not_run",
                "reason": "no semantic index location is configured (NOUS_OS_SEMANTIC_INDEX_PATH or --semantic-index-path)",
                "hits": [],
            }
    after = _canon_digest(canon.root, canon.ledger)
    assert after == before


def test_registered_as_of_forwards_each_temporal_axis(tmp_path: Path) -> None:
    """The registry operation must preserve both temporal filters, not omit them."""
    canon = _temporary_canon(tmp_path)
    index = _axis_temporal_index(canon.citation)
    grant = Grant("reader", frozenset({Tier.READ}))
    expected_established = ("asr_0000000000000000000000000A",)
    expected_excluded = ("asr_0000000000000000000000000B",)

    valid_answer = execute(
        grant,
        "as_of",
        index=index,
        valid_at=RECORDED_AT,
    )
    assert tuple(assertion.id for assertion in valid_answer.established) == expected_established
    assert tuple(assertion.id for assertion in valid_answer.excluded) == expected_excluded
    assert tuple(assertion.id for assertion in valid_answer.undetermined) == ()

    recorded_answer = execute(
        grant,
        "as_of",
        index=index,
        recorded_as_of=RECORDED_AT,
    )
    assert tuple(assertion.id for assertion in recorded_answer.established) == expected_established
    assert tuple(assertion.id for assertion in recorded_answer.excluded) == expected_excluded
    assert tuple(assertion.id for assertion in recorded_answer.undetermined) == ()


def test_a_propose_grant_is_refused_by_every_promote_operation(tmp_path: Path) -> None:
    """A proposal-only grant must not be able to mutate canon through promotion."""
    canon = _temporary_canon(tmp_path)
    promotions = tuple(
        operation for operation in _project_operations() if operation.tier is Tier.PROMOTE
    )
    assert promotions, "the promote-operation derivation is empty"
    grant = Grant("proposer", frozenset({Tier.PROPOSE}))
    for operation in promotions:
        before = _canon_digest(canon.root, canon.ledger)
        with pytest.raises(NotAuthorized):
            execute(grant, operation.name, **_promote_arguments(operation.name, canon))
        after = _canon_digest(canon.root, canon.ledger)
        assert after == before


def _mutates_canonical_snapshot_and_ledger(operation: _Operation) -> bool:
    """Select promotions whose inputs are both canonical write stores.

    Authorization-only promotion writes an ``authorizations`` ledger, not the
    canonical snapshot store and canonical ledger measured by this test.
    """
    implementation = authority._REGISTRY[operation.name][1]
    parameters = inspect.signature(implementation).parameters
    return operation.tier is Tier.PROMOTE and {"store", "ledger"} <= parameters.keys()


def test_every_permitted_promote_operation_grows_both_parts_of_canon(
    tmp_path: Path,
) -> None:
    """A no-op or snapshot-only boundary call cannot count as promotion."""
    promotions = tuple(
        operation
        for operation in _project_operations()
        if _mutates_canonical_snapshot_and_ledger(operation)
    )
    assert promotions, "the promote-operation derivation is empty"
    grant = Grant("promoter", frozenset({Tier.PROMOTE}))

    for operation in promotions:
        canon = _temporary_canon(tmp_path / operation.name)
        before = _canon_digest(canon.root, canon.ledger)
        returned = execute(
            grant,
            operation.name,
            **_promote_arguments(operation.name, canon),
        )
        after = _canon_digest(canon.root, canon.ledger)

        assert after.value != before.value
        assert after.snapshot_bytes > before.snapshot_bytes
        assert after.ledger_bytes > before.ledger_bytes
        assert type(returned) is IngestResult
        assert returned.status is IngestStatus.SUPERSEDED
        assert returned.entry is not None
        assert canon.ledger.entries()[-1] == returned.entry


def test_every_permitted_propose_operation_writes_outside_canon(tmp_path: Path) -> None:
    """Proposal authority must work while its records remain outside canon."""
    proposals = tuple(
        operation for operation in _project_operations() if operation.tier is Tier.PROPOSE
    )
    assert proposals, "the propose-operation derivation is empty"
    grant = Grant("proposer", frozenset({Tier.PROPOSE}))
    for operation in proposals:
        canon = _temporary_canon(tmp_path / operation.name)
        before = _canon_digest(canon.root, canon.ledger)
        returned = execute(
            grant,
            operation.name,
            **_propose_arguments(operation.name, canon),
        )
        after = _canon_digest(canon.root, canon.ledger)
        assert returned is not None
        assert after == before
