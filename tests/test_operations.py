"""Structural and executable checks for the registered operation boundary.

The important failure is a new route to a governed implementation that never
asks the registry whether its caller has authority. These tests inspect
bindings, rather than spelling-sensitive names, and execute real operations
against temporary files so a declared tier cannot become an untested label.
"""

from __future__ import annotations

import ast
import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pytest

import nous_os.capability as authority
import nous_os.operations
from nous_os.capability import Grant, NotAuthorized, Tier, execute
from nous_os.candidates import CandidateStore, Proposal
from nous_os.config import DataRoot
from nous_os.derived import build
from nous_os.ledger import Ledger, ingest
from nous_os.provenance import Citation, Locator
from nous_os.snapshots import SnapshotStore
from nous_os.untrusted import UntrustedText


REPOSITORY = Path(__file__).resolve().parent.parent
PACKAGE = REPOSITORY / "src" / "nous_os"
SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
RECORDED_AT = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)


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

    def __init__(self, module: str, governed: frozenset[_FunctionBinding]) -> None:
        self._module = module
        self._governed = governed
        self._governed_by_name = {(item.module, item.qualname): item for item in governed}
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
        if not isinstance(node, ast.Attribute):
            return None
        base = self._binding_for_expression(node.value, scope)
        if not isinstance(base, _ModuleBinding):
            return None
        direct = self._governed_by_name.get((base.module, node.attr))
        if direct is not None:
            return direct
        module_name = f"{base.module}.{node.attr}"
        if module_name in self._module_names:
            return _ModuleBinding(module_name)
        return None

    def _import_binding(self, module: str, name: str) -> _FunctionBinding | _ModuleBinding | None:
        direct = self._governed_by_name.get((module, name))
        if direct is not None:
            return direct
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
            if node.module is None or node.level:
                return
            for alias in node.names:
                if alias.name != "*":
                    scope.bind(alias.asname or alias.name, self._import_binding(node.module, alias.name))
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
    for name, entry in registry.items():
        tier, implementation = entry
        module = getattr(implementation, "__module__", None)
        if type(module) is not str or not module.startswith("nous_os"):
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


def _canon_digest(root: Path, ledger: Ledger) -> str:
    """Hash all snapshot bytes and the ledger bytes, in deterministic order."""
    digest = hashlib.sha256()
    snapshots = root / "snapshots"
    for path in sorted(path for path in snapshots.rglob("*") if path.is_file()):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    digest.update(b"ledger\0")
    digest.update(ledger.path.read_bytes() if ledger.path.is_file() else b"")
    return digest.hexdigest()


@dataclass(frozen=True, slots=True)
class _TemporaryCanon:
    """The real files needed to execute every current registered operation."""

    root: Path
    snapshots: SnapshotStore
    ledger: Ledger
    derived_path: Path
    data_root: DataRoot
    citation: Citation
    candidates: CandidateStore


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
    return _TemporaryCanon(
        root=root,
        snapshots=snapshots,
        ledger=ledger,
        derived_path=derived_path,
        data_root=DataRoot(documents),
        citation=citation,
        candidates=CandidateStore(tmp_path / "candidates.jsonl"),
    )


def _read_arguments(name: str, canon: _TemporaryCanon) -> dict[str, object]:
    """Supply real arguments for each known read operation, or fail loudly."""
    arguments = {
        "search": {"path": canon.derived_path, "query": "alpha"},
        "sources": {"path": canon.derived_path},
        "versions": {"path": canon.derived_path, "source_id": SOURCE_ID},
        "read_span": {"store": canon.snapshots, "citation": canon.citation},
        "list_documents": {"root": canon.data_root},
        "describe_corpus": {"root": canon.data_root},
        "proposals": {"store": canon.candidates},
    }
    if name not in arguments:
        pytest.fail(f"read operation {name!r} has no executable test arguments")
    return arguments[name]


def _promote_arguments(name: str, canon: _TemporaryCanon) -> dict[str, object]:
    """Supply an effectful argument set for every known promotion operation."""
    arguments = {
        "ingest_source": {
            "store": canon.snapshots,
            "ledger": canon.ledger,
            "source_id": SOURCE_ID,
            "content": UntrustedText("a later version that must not be stored"),
            "recorded_at": RECORDED_AT,
        }
    }
    if name not in arguments:
        pytest.fail(f"promote operation {name!r} has no executable test arguments")
    return arguments[name]


def _authority_offences(path: Path, tree: ast.Module) -> list[str]:
    """Find authority use by binding, not unrelated methods named execute."""
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
            if node.module == "nous_os.capability":
                offences.append(f"{path.name} imports the authority module")
                for alias in node.names:
                    if alias.name in {"Grant", "execute"}:
                        authority_functions[alias.asname or alias.name] = alias.name
            if node.module == "nous_os":
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
    assert {operation.name: operation.tier for operation in operations} == {
        "search": Tier.READ,
        "sources": Tier.READ,
        "versions": Tier.READ,
        "read_span": Tier.READ,
        "list_documents": Tier.READ,
        "describe_corpus": Tier.READ,
        "proposals": Tier.READ,
        "record_proposal": Tier.PROPOSE,
        "ingest_source": Tier.PROMOTE,
    }
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
        if _BindingUseScanner(_module_name(path), governed).scans(tree)
    }
    expected = {
        "operations.py",  # Registration site: it alone imports implementations to register them.
        "measure.py",  # Existing measurement code imports and calls search; a forward obligation.
        "config.py",  # describe_corpus calls the governed list_documents function.
        "provenance.py",  # quote_lint calls governed read_span while remaining unguided itself.
    }
    assert holding == expected, (
        "governed implementation bindings changed: "
        f"unexpected={sorted(holding - expected)}, missing={sorted(expected - holding)}"
    )


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
        execute(grant, operation.name, **_read_arguments(operation.name, canon))
    after = _canon_digest(canon.root, canon.ledger)
    assert after == before


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


def test_a_propose_grant_records_a_proposal_without_changing_canon(tmp_path: Path) -> None:
    """Proposal authority must work, while its recorded result remains outside canon."""
    canon = _temporary_canon(tmp_path)
    before = _canon_digest(canon.root, canon.ledger)
    grant = Grant("proposer", frozenset({Tier.PROPOSE}))
    recorded = execute(
        grant,
        "record_proposal",
        store=canon.candidates,
        source_id=SOURCE_ID,
        content=UntrustedText("this is a proposal, not a fact"),
        proposed_at=RECORDED_AT,
        holder="proposer",
    )
    assert type(recorded) is Proposal
    assert canon.candidates.proposals() == (recorded,)
    after = _canon_digest(canon.root, canon.ledger)
    assert after == before
