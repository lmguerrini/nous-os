"""The application service boundary used by the CLI and stdio transports.

A CLI and an MCP-shaped server are built *on top of* this module. Neither
derives an operation name, tier, or parameter specification from a domain
module; it reads the published catalogue instead. That avoids separate
transport mappings from a request shape to :func:`nous_os.capability.execute`,
which could drift apart.

**Core never imports a domain implementation in order to call it.** Every Core
call that names a registered operation goes through
:func:`nous_os.capability.execute`, which is this module's one registered-call
door. Core imports domain *types* — dataclasses, enums, stores —
to build arguments and to render results, because turning a JSON object into a
:class:`~nous_os.provenance.Citation` or a :class:`~nous_os.discovery.BridgeCard`
is binding, not bypassing. It never imports a registered operation's
*implementation* function and never calls a domain method that ``execute``
exists to guard.

**The catalogue holds no promotion.** ``ingest_source`` and
``promote_candidate`` are registered at ``Tier.PROMOTE`` and are deliberately
absent from :data:`CATALOGUE`. That is not an oversight to be filled in later;
it is the property this module exists to hold. Through this module's
catalogue, :func:`invoke` cannot name a promotion-tier operation because no
descriptor names one. Other package APIs are outside this contract.

**Argument content cannot move authority.** :func:`invoke` resolves a
descriptor from the external name alone and only then looks at the supplied
JSON arguments. A registered operation's descriptor tier is read from the
governed registry at catalogue construction; the two Core-level reads share a
fixed READ tier. Nothing in the JSON a caller supplies is capable of choosing
a different operation or a different tier: there is no field named
``operation`` or ``tier`` anywhere in the parameter specifications below, and
the lookup that resolves both happens before a single argument value is read.
"""

from __future__ import annotations

import os
import stat
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Final, Mapping

from nous_os.adjudication import AdjudicationError, Rejection, RejectionMemory
from nous_os.candidates import CandidateStore
from nous_os.canonical import Assertion, CanonicalError, LifecycleState, SupportClass
from nous_os.capability import Grant, NotAuthorized, Tier, execute, required_tier
from nous_os.chunking import Chunk, ChunkingError
from nous_os.compile import PREREGISTERED_ARMS, CohesionStrategy, Pack
from nous_os.config import DataRoot, resolve_data_root
from nous_os.discovery import (
    BridgeCard,
    BridgeRegistry,
    Depth,
    DiscoveryError,
    Endpoint,
    EpistemicClass,
    Gate,
    GateOutcome,
    GateVector,
    TrivialityArchetype,
)
from nous_os.extraction import ExtractionStore
from nous_os.identity import ASSERTION_PREFIX, InvalidIdentifier, require_id
from nous_os.ledger import Ledger
from nous_os.projection import (
    DISCOVERY,
    RELIABILITY,
    KnowledgeState,
    ProjectionError,
    ProjectionPolicy,
    TemporalQuestion,
)
from nous_os.provenance import Citation, Locator, ProvenanceError, derived_citation_from_payload
from nous_os.reconciliation import RelationClass, RelationError, RelationProposal, RelationStore
from nous_os.snapshots import SnapshotStore
from nous_os.temporal import ClaimKey, ClaimKeyError, TemporalError, TemporalIndex
from nous_os.untrusted import UntrustedText

# Importing this module is what populates the governed registry that
# ``required_tier`` below reads from. Core never calls anything defined in it;
# the import exists solely for that registration side effect, exactly as any
# other caller of ``execute`` depends on it having run first.
import nous_os.operations as _operations  # noqa: F401


__all__ = (
    "CoreError",
    "UnknownExternalOperation",
    "ArgumentError",
    "UnknownArgument",
    "MissingArgument",
    "ArgumentTypeError",
    "PromotionNotOffered",
    "WorkspaceNotConfigured",
    "AliasedWorkspaceLocation",
    "Workspace",
    "ParameterSpec",
    "OperationDescriptor",
    "CATALOGUE",
    "resolve_workspace",
    "validate_arguments",
    "invoke",
)


class CoreError(Exception):
    """Base error for a request this service boundary refuses to satisfy."""


class UnknownExternalOperation(CoreError):
    """Raised when no catalogue entry is published under the supplied name."""


class ArgumentError(CoreError):
    """Base error for JSON-shaped arguments that do not match a descriptor."""


class UnknownArgument(ArgumentError):
    """Raised when a supplied argument name is not declared by the descriptor."""


class MissingArgument(ArgumentError):
    """Raised when a required argument is absent."""


class ArgumentTypeError(ArgumentError):
    """Raised when a supplied argument's JSON shape does not validate."""


class PromotionNotOffered(CoreError):
    """Raised when a catalogue entry would be built at PROMOTE or ECA tier.

    This contract's refusal is enforced at construction rather than left as an
    absence someone could stop noticing: it offers neither a promotion nor an
    outside action, and building a descriptor for one raises before the
    catalogue can hold it.
    """


# --- the workspace: every on-disk location this service resolves -----------


class WorkspaceNotConfigured(Exception):
    """Raised when a workspace location was not supplied by any configured source.

    Deliberately not a subclass of anything a caller is likely to catch by
    accident, matching :class:`~nous_os.config.DataRootNotConfigured`'s stance:
    not knowing where a store lives is a third answer, distinct from the store
    being empty.
    """


class AliasedWorkspaceLocation(Exception):
    """Raised when workspace locations name one on-disk object or overlap unsafely.

    Deliberately not a subclass of anything a caller is likely to catch by
    accident, matching :class:`WorkspaceNotConfigured`'s stance: two names for
    one place is a third answer, distinct from either location being merely
    unconfigured. Without this, ``--ledger-path X --candidate-store-path X``
    resolves cleanly and a PROPOSE call appends a proposal record straight
    into the file configured as the ledger; a store resolving inside the
    canonical data root is refused for the identical reason, because a write
    there is a write to canon by another name. The same refusal compares every
    canonical location -- data root, snapshot root, and ledger -- against
    every noncanonical store in both directions, whether or not that location
    has been created on disk yet. It additionally catches a store hard-linked
    to a traversable document beneath the data root or snapshot root, not
    merely one of the other six configured names.

    Every location is resolved fully -- symlinks followed, ``..`` collapsed --
    before any of these are compared, and every comparison below prefers
    filesystem truth (device and inode) to string truth wherever that truth
    is available. That catches direct location aliases, a hard link to a
    traversable canonical file, a not-yet-created ledger directory, a
    case-only variant on this platform's own case-insensitive volume, and a
    Unicode NFC/NFD variant of an existing directory name. Enumerating
    canon's own file identities is fail-closed rather than best-effort too: a
    directory this process cannot list, or a file it names but cannot then
    stat, refuses the whole workspace instead of silently reporting fewer
    identities than canon actually holds -- see
    :func:`_canonical_file_identities`. A dangling canonical symlink has no
    target identity to contribute, so it does not make the workspace
    unavailable. What this cannot cover, honestly: a
    canonical file reachable only beneath a *symlinked* subdirectory is not
    enumerated as canon at all, because neither ``rglob`` nor ``os.walk``
    descends a symlinked directory on this runtime, so a store hard-linked to
    a file found only that way is invisible to this check; a not-yet-existing
    path, or one whose ancestor is not a directory at all -- both
    ``FileNotFoundError`` and ``NotADirectoryError`` mean there is nothing
    there yet for ``os.stat`` to settle -- is compared by a normalised
    spelling rather than filesystem truth, which is inherently unable to
    observe a filesystem-specific aliasing rule this project has not been
    shown a reproduction of; and any other ``OSError`` while comparing two
    paths refuses the whole workspace rather than guessing whether they are
    the same location. It also cannot make a later pathname write race-safe:
    an adversary who can already write the workspace directory can replace a
    not-yet-existing store path, or one of its ancestors, with a symlink into
    canon after this check and before the store opens that pathname. A
    race-safe candidate-store write requires the candidate store to use
    descriptor-relative, no-follow filesystem calls; that belongs in the
    candidate store and is outside this Core check.
    """


#: Resolution order for every non-data-root location, highest first: an
#: explicit argument, then the named environment variable, then refusal.
#: The data root itself keeps using ``config.resolve_data_root`` unchanged.
SNAPSHOT_ROOT_ENV_VAR: Final = "NOUS_OS_SNAPSHOT_ROOT"
LEDGER_PATH_ENV_VAR: Final = "NOUS_OS_LEDGER_PATH"
DERIVED_PATH_ENV_VAR: Final = "NOUS_OS_DERIVED_PATH"
CANDIDATE_STORE_PATH_ENV_VAR: Final = "NOUS_OS_CANDIDATE_STORE_PATH"
CANDIDATE_REPLACEMENTS_PATH_ENV_VAR: Final = "NOUS_OS_CANDIDATE_REPLACEMENTS_PATH"
BRIDGE_REGISTRY_PATH_ENV_VAR: Final = "NOUS_OS_BRIDGE_REGISTRY_PATH"
REJECTION_MEMORY_PATH_ENV_VAR: Final = "NOUS_OS_REJECTION_MEMORY_PATH"
RELATION_STORE_PATH_ENV_VAR: Final = "NOUS_OS_RELATION_STORE_PATH"
EXTRACTION_STORE_PATH_ENV_VAR: Final = "NOUS_OS_EXTRACTION_STORE_PATH"
SEMANTIC_INDEX_PATH_ENV_VAR: Final = "NOUS_OS_SEMANTIC_INDEX_PATH"
ASSET_ROOT_PATH_ENV_VAR: Final = "NOUS_OS_ASSET_ROOT_PATH"
SIGHTING_LOG_PATH_ENV_VAR: Final = "NOUS_OS_SIGHTING_LOG_PATH"
CANON_ROOT_PATH_ENV_VAR: Final = "NOUS_OS_CANON_ROOT_PATH"


@dataclass(frozen=True, slots=True)
class Workspace:
    """Every on-disk location Core resolves, validated when it is constructed.

    ``resolve_workspace`` refuses a caller that leaves any location
    unconfigured rather than selecting a machine-specific default. Direct
    construction requires every required store value, resolves their
    spellings, and applies the same overlap refusal. Asset-root, sighting-log, and
    canon-root locations are independently configurable; full derived verification
    needs both the asset root and the sighting log.
    """

    data_root: DataRoot
    snapshot_root: Path
    ledger_path: Path
    derived_path: Path
    candidate_store_path: Path
    bridge_registry_path: Path
    rejection_memory_path: Path
    relation_store_path: Path
    extraction_store_path: Path | None = None
    semantic_index_path: Path | None = None
    asset_root_path: Path | None = None
    sighting_log_path: Path | None = None
    canon_root_path: Path | None = None
    candidate_replacements_path: Path | None = None

    def __post_init__(self) -> None:
        """Resolve direct inputs before applying the shared overlap refusal."""
        if type(self.data_root) is not DataRoot:
            raise CoreError("workspace data_root must be a DataRoot")
        object.__setattr__(
            self, "data_root", DataRoot(self.data_root.path.expanduser().resolve())
        )
        for field in (
            "snapshot_root",
            "ledger_path",
            "derived_path",
            "candidate_store_path",
            "bridge_registry_path",
            "rejection_memory_path",
            "relation_store_path",
        ):
            value = getattr(self, field)
            try:
                resolved = Path(value).expanduser().resolve()
            except (TypeError, ValueError) as error:
                raise CoreError(f"workspace {field} must be path-like") from error
            object.__setattr__(self, field, resolved)
        if self.extraction_store_path is not None:
            try:
                extraction_store_path = Path(self.extraction_store_path).expanduser().resolve()
            except (TypeError, ValueError) as error:
                raise CoreError("workspace extraction_store_path must be path-like or None") from error
            object.__setattr__(self, "extraction_store_path", extraction_store_path)
        if self.semantic_index_path is not None:
            try:
                semantic_index_path = Path(self.semantic_index_path).expanduser().resolve()
            except (TypeError, ValueError) as error:
                raise CoreError("workspace semantic_index_path must be path-like or None") from error
            object.__setattr__(self, "semantic_index_path", semantic_index_path)
        if self.asset_root_path is not None:
            try:
                asset_root_path = Path(self.asset_root_path).expanduser().resolve()
            except (TypeError, ValueError) as error:
                raise CoreError("workspace asset_root_path must be path-like or None") from error
            object.__setattr__(self, "asset_root_path", asset_root_path)
        if self.sighting_log_path is not None:
            try:
                sighting_log_path = Path(self.sighting_log_path).expanduser().resolve()
            except (TypeError, ValueError) as error:
                raise CoreError("workspace sighting_log_path must be path-like or None") from error
            object.__setattr__(self, "sighting_log_path", sighting_log_path)
        if self.canon_root_path is not None:
            try:
                canon_root_path = Path(self.canon_root_path).expanduser().resolve()
            except (TypeError, ValueError) as error:
                raise CoreError("workspace canon_root_path must be path-like or None") from error
            object.__setattr__(self, "canon_root_path", canon_root_path)
        if self.candidate_replacements_path is not None:
            try:
                replacements_path = Path(self.candidate_replacements_path).expanduser().resolve()
            except (TypeError, ValueError) as error:
                raise CoreError("workspace candidate_replacements_path must be path-like or None") from error
            object.__setattr__(self, "candidate_replacements_path", replacements_path)
        _refuse_aliased_locations(self)


def _resolve_path(
    explicit: str | os.PathLike[str] | None,
    env_var: str,
    field: str,
    environ: dict[str, str],
) -> Path:
    """Resolve one workspace location, or refuse. Mirrors ``resolve_data_root``."""
    candidate: str | os.PathLike[str] | None = explicit
    if candidate is None:
        from_env = environ.get(env_var)
        if from_env is not None and from_env.strip():
            candidate = from_env
    if candidate is None:
        raise WorkspaceNotConfigured(
            f"no {field} was configured; pass one explicitly or set {env_var}. "
            "NousOS does not guess a location."
        )
    return Path(candidate).expanduser().resolve()


@dataclass(frozen=True, slots=True)
class _WorkspaceLocation:
    """One resolved workspace path and its relation to the canonical layer.

    Canonical membership is recorded here once: data root, snapshot root, ledger,
    and configured canon root are canon on disk. The containing subset is derived
    from that membership and ``is_directory`` below, so the alias refusal does not
    quietly protect one canonical root while forgetting another.
    """

    field: str
    path: Path
    is_canonical: bool
    is_directory: bool


def _workspace_locations(workspace: Workspace) -> tuple[_WorkspaceLocation, ...]:
    """Every resolved location with its canonical-layer role, in dataclass order."""
    return (
        _WorkspaceLocation("data_root", workspace.data_root.path, True, True),
        _WorkspaceLocation("snapshot_root", workspace.snapshot_root, True, True),
        _WorkspaceLocation("ledger_path", workspace.ledger_path, True, False),
        _WorkspaceLocation("derived_path", workspace.derived_path, False, False),
        _WorkspaceLocation("candidate_store_path", workspace.candidate_store_path, False, False),
        *(() if workspace.candidate_replacements_path is None else (
            _WorkspaceLocation("candidate_replacements_path", workspace.candidate_replacements_path, False, False),
        )),
        _WorkspaceLocation("bridge_registry_path", workspace.bridge_registry_path, False, False),
        _WorkspaceLocation("rejection_memory_path", workspace.rejection_memory_path, False, False),
        _WorkspaceLocation("relation_store_path", workspace.relation_store_path, False, False),
        *(() if workspace.extraction_store_path is None else (
            _WorkspaceLocation(
                "extraction_store_path", workspace.extraction_store_path, False, True
            ),
        )),
        *(() if workspace.semantic_index_path is None else (
            _WorkspaceLocation(
                "semantic_index_path", workspace.semantic_index_path, False, True
            ),
        )),
        *(() if workspace.asset_root_path is None else (
            _WorkspaceLocation("asset_root_path", workspace.asset_root_path, False, True),
        )),
        *(() if workspace.canon_root_path is None else (
            _WorkspaceLocation(
                "canon_root_path", workspace.canon_root_path, True, True
            ),
        )),
        *(() if workspace.sighting_log_path is None else (
            _WorkspaceLocation("sighting_log_path", workspace.sighting_log_path, False, False),
        )),
    )


def _normalized_spelling(path: Path) -> str:
    """A comparison key for a path this process cannot yet prove exists.

    ``Path.resolve()`` neither case-folds nor Unicode-normalises a spelling,
    so two arguments that look different can still name what a filesystem
    would treat as one location once something is actually written there,
    and ``os.stat`` cannot settle that for a path that is not there yet to
    stat. ``unicodedata.normalize("NFC", ...)`` merges decomposed and
    precomposed spellings; a filesystem can distinguish those names, so that
    merge is conservative rather than a proof of aliasing. Case is
    conservative in the same way: ``os.path.normcase`` case-folds only on
    Windows, and this project also has to run correctly on this platform's own
    case-insensitive-by-default volume, where it does not. ``casefold()`` is
    therefore applied unconditionally in addition to it. On a genuinely
    case-sensitive or Unicode-sensitive filesystem this can refuse two
    not-yet-created locations that would not actually have collided, and that
    direction of error -- an over-cautious refusal, never an unproven claim
    that two spellings are safe -- is the one this project accepts.
    """
    return unicodedata.normalize("NFC", os.path.normcase(str(path))).casefold()


def _same_location(first: Path, second: Path) -> bool:
    """Tell whether two resolved paths denote one filesystem location.

    Both paths have already passed through ``Path.expanduser().resolve()``,
    so a symlink or a ``..`` segment cannot make two differently-spelled
    arguments compare equal here. When both sides can be statted, identity is
    settled by device and inode -- filesystem truth, not string truth -- which
    is what actually catches a hard link, and what a case-insensitive or a
    Unicode-normalising filesystem does on its own for a name that already
    exists, since ``os.stat`` performs that folding itself rather than this
    function guessing at it. When either side cannot be statted because it
    does not exist yet, there is no filesystem truth available to consult, so
    this falls back to :func:`_normalized_spelling`.
    """
    if first == second:
        return True
    try:
        first_info = os.stat(first)
        second_info = os.stat(second)
    except (FileNotFoundError, NotADirectoryError):
        # Either genuinely does not exist yet, or an ancestor component is a
        # regular file rather than a directory -- ``os.stat`` raises
        # ``NotADirectoryError`` for the latter, and a path sitting beneath a
        # file cannot exist either, for exactly the same reason a path with
        # no such ancestor problem at all does not exist before it is
        # created. Both are the identical "nothing there yet to stat" case,
        # so both fall back to the same normalised-spelling comparison.
        return _normalized_spelling(first) == _normalized_spelling(second)
    except OSError as error:
        raise AliasedWorkspaceLocation(
            f"cannot compare filesystem identity for {first} and {second}: {error}; "
            "NousOS refuses the workspace rather than guessing whether they are "
            "the same location"
        ) from error
    if first_info.st_ino == 0 or second_info.st_ino == 0:
        raise AliasedWorkspaceLocation(
            f"cannot compare filesystem identity for {first} and {second}; "
            "the platform did not expose stable inode values"
        )
    return (first_info.st_dev, first_info.st_ino) == (second_info.st_dev, second_info.st_ino)


def _is_inside(path: Path, container: Path) -> bool:
    """Tell whether resolved ``path`` denotes a location inside ``container``.

    Walks every ancestor of ``path`` and asks whether it is the same location
    as ``container`` by :func:`_same_location`, rather than comparing ancestor
    strings to ``container`` directly: a container that already exists is
    reached by ``os.stat`` regardless of the case or Unicode-normalisation
    form an ancestor of ``path`` happens to have been spelled in, exactly as
    two configured locations are. ``path.parents`` never contains ``path``
    itself, so equal paths are not "inside" each other here.
    """
    return any(_same_location(ancestor, container) for ancestor in path.parents)


def _reraise_walk_error(error: OSError) -> None:
    """``os.walk``'s ``onerror`` hook: make a listing failure propagate.

    ``os.walk`` otherwise swallows a directory it cannot list -- the exact
    silent shrinkage :func:`_canonical_file_identities` below refuses to
    tolerate -- and simply omits that subtree from what it yields, with no
    exception and no other signal that anything was skipped.
    """
    raise error


def _canonical_file_identities(root: Path) -> frozenset[tuple[int, int]]:
    """Every regular file's identity beneath ``root``, or a refusal.

    A missing root, including a path below a non-directory ancestor, has no
    files to contribute. Any other failure to stat the root, or a root that
    exists but is not a directory, refuses: those cases do not establish an
    empty directory. Used to catch a store hard-linked to a canonical document
    or snapshot blob that is not itself one of the seven configured locations,
    and so is otherwise invisible to the pairwise comparison above.

    Everything past that point is fail-closed rather than best-effort: an
    incomplete identity set looks identical to a complete one to every caller
    of this function, which is exactly the defect. A directory ``os.walk``
    cannot list, or a file it names but this process cannot then stat --
    unlike ``rglob``'s default behaviour, which silently reports fewer
    identities than canon actually holds -- refuses the whole workspace
    instead. A named entry that is absent, including a dangling symlink,
    contributes no identity and is skipped.
    """
    try:
        root_info = os.stat(root)
    except (FileNotFoundError, NotADirectoryError):
        return frozenset()
    except OSError as error:
        raise AliasedWorkspaceLocation(
            f"cannot enumerate canonical file identities beneath {root}: {error}; "
            "NousOS refuses the workspace rather than checking a possibly "
            "incomplete set"
        ) from error
    if not stat.S_ISDIR(root_info.st_mode):
        raise AliasedWorkspaceLocation(
            f"cannot enumerate canonical file identities beneath {root}: root is not a directory"
        )
    identities: set[tuple[int, int]] = set()
    try:
        for dirpath, _dirnames, filenames in os.walk(root, onerror=_reraise_walk_error):
            for filename in filenames:
                try:
                    info = os.stat(os.path.join(dirpath, filename))
                except (FileNotFoundError, NotADirectoryError):
                    continue
                if stat.S_ISREG(info.st_mode) and info.st_ino != 0:
                    identities.add((info.st_dev, info.st_ino))
    except OSError as error:
        raise AliasedWorkspaceLocation(
            f"cannot enumerate canonical file identities beneath {root}: {error}; "
            "NousOS refuses the workspace rather than checking a possibly "
            "incomplete set"
        ) from error
    return frozenset(identities)


def _refuse_aliased_locations(workspace: Workspace) -> None:
    """Refuse aliases, either-direction containment, and hard links into canon.

    Every comparison below goes through :func:`_same_location` or
    :func:`_is_inside`, both of which prefer filesystem truth over string
    truth wherever a comparison can be settled that way. Containment is
    checked against every canonical location -- the data root, the snapshot
    root, and the ledger -- not only the two canonical directories, because a
    store nested beneath a ledger path that has not been created yet is just
    as real a collision as one nested beneath an existing directory. A
    store's own filesystem identity is additionally checked against every
    traversable regular file beneath the data root or the snapshot root, not
    only against the other six configured names, because a hard link makes a
    store and a canonical document one file without either configured path
    ever equalling or containing the other. A file this scan cannot list or
    stat refuses the whole workspace rather than being silently excluded, as
    described by :func:`_canonical_file_identities`.

    The sole exemption permits ``canon_root_path`` and ``data_root`` to name
    the identical filesystem directory; every other equality or overlap refuses.
    """
    locations = _workspace_locations(workspace)
    for index, first in enumerate(locations):
        for second in locations[index + 1 :]:
            if _same_location(first.path, second.path):
                if {first.field, second.field} == {"data_root", "canon_root_path"}:
                    # A canon root may intentionally share the data root; only this
                    # exact pair is exempt from the general no-alias rule.
                    continue
                raise AliasedWorkspaceLocation(
                    f"{first.field} and {second.field} both denote {first.path}; NousOS "
                    "refuses two names for one workspace location"
                )

    canonical_directories = tuple(
        location for location in locations if location.is_canonical and location.is_directory
    )
    canonical_locations = tuple(location for location in locations if location.is_canonical)
    stores = tuple(location for location in locations if not location.is_canonical)

    for index, first in enumerate(canonical_directories):
        for second in canonical_directories[index + 1 :]:
            if _is_inside(first.path, second.path) or _is_inside(second.path, first.path):
                raise AliasedWorkspaceLocation(
                    f"canonical directories {first.field}={first.path} and "
                    f"{second.field}={second.path} overlap; NousOS refuses nested canon"
                )

    for canonical in canonical_locations:
        for store in stores:
            if _is_inside(store.path, canonical.path):
                raise AliasedWorkspaceLocation(
                    f"{store.field} resolves to {store.path}, inside canonical location "
                    f"{canonical.field}={canonical.path}; a store may not sit inside canon, "
                    "including a canonical location that does not exist yet"
                )
            if _is_inside(canonical.path, store.path):
                raise AliasedWorkspaceLocation(
                    f"canonical location {canonical.field}={canonical.path} sits inside "
                    f"store {store.field}={store.path}; a canonical location may not sit in a store"
                )

    canonical_file_identities = frozenset().union(
        *(
            _canonical_file_identities(location.path) for location in canonical_directories
        )
    )
    for store in stores:
        try:
            store_info = os.stat(store.path)
        except OSError:
            continue
        if store_info.st_ino == 0:
            continue
        if (store_info.st_dev, store_info.st_ino) in canonical_file_identities:
            raise AliasedWorkspaceLocation(
                f"{store.field} resolves to {store.path}, which shares a filesystem identity "
                "with a file beneath the data root or the snapshot root; a store may not be "
                "hard-linked to canon"
            )


def resolve_workspace(
    *,
    data_root: str | os.PathLike[str] | None = None,
    snapshot_root: str | os.PathLike[str] | None = None,
    ledger_path: str | os.PathLike[str] | None = None,
    derived_path: str | os.PathLike[str] | None = None,
    candidate_store_path: str | os.PathLike[str] | None = None,
    bridge_registry_path: str | os.PathLike[str] | None = None,
    rejection_memory_path: str | os.PathLike[str] | None = None,
    relation_store_path: str | os.PathLike[str] | None = None,
    extraction_store_path: str | os.PathLike[str] | None = None,
    semantic_index_path: str | os.PathLike[str] | None = None,
    asset_root_path: str | os.PathLike[str] | None = None,
    sighting_log_path: str | os.PathLike[str] | None = None,
    canon_root_path: str | os.PathLike[str] | None = None,
    candidate_replacements_path: str | os.PathLike[str] | None = None,
    environ: dict[str, str] | None = None,
) -> Workspace:
    """Resolve every location Core needs, or refuse. Never guesses one.

    ``environ`` is injectable so resolution order is testable without mutating
    the real process environment, exactly as :func:`~nous_os.config.resolve_data_root`
    already allows.

    The returned ``Workspace`` applies :class:`AliasedWorkspaceLocation` to
    every configured location: noncanonical stores may not overlap any
    canonical location, and no pair may name one filesystem object. Without
    that check,
    two options naming the same file resolve cleanly and a write meant for one
    store lands in another.
    """
    env = os.environ if environ is None else environ
    return Workspace(
        data_root=resolve_data_root(data_root, environ=env),
        snapshot_root=_resolve_path(
            snapshot_root, SNAPSHOT_ROOT_ENV_VAR, "snapshot store root", env
        ),
        ledger_path=_resolve_path(ledger_path, LEDGER_PATH_ENV_VAR, "ledger path", env),
        derived_path=_resolve_path(
            derived_path, DERIVED_PATH_ENV_VAR, "derived index path", env
        ),
        candidate_store_path=_resolve_path(
            candidate_store_path, CANDIDATE_STORE_PATH_ENV_VAR, "candidate store path", env
        ),
        bridge_registry_path=_resolve_path(
            bridge_registry_path, BRIDGE_REGISTRY_PATH_ENV_VAR, "bridge registry path", env
        ),
        rejection_memory_path=_resolve_path(
            rejection_memory_path,
            REJECTION_MEMORY_PATH_ENV_VAR,
            "rejection memory path",
            env,
        ),
        relation_store_path=_resolve_path(
            relation_store_path,
            RELATION_STORE_PATH_ENV_VAR,
            "relation store path",
            env,
        ),
        extraction_store_path=(
            _resolve_path(
                extraction_store_path,
                EXTRACTION_STORE_PATH_ENV_VAR,
                "extraction store path",
                env,
            )
            if extraction_store_path is not None
            or bool(env.get(EXTRACTION_STORE_PATH_ENV_VAR, "").strip())
            else None
        ),
        semantic_index_path=(
            _resolve_path(
                semantic_index_path,
                SEMANTIC_INDEX_PATH_ENV_VAR,
                "semantic index path",
                env,
            )
            if semantic_index_path is not None
            or bool(env.get(SEMANTIC_INDEX_PATH_ENV_VAR, "").strip())
            else None
        ),
        asset_root_path=(
            _resolve_path(asset_root_path, ASSET_ROOT_PATH_ENV_VAR, "asset root", env)
            if asset_root_path is not None or bool(env.get(ASSET_ROOT_PATH_ENV_VAR, "").strip())
            else None
        ),
        sighting_log_path=(
            _resolve_path(sighting_log_path, SIGHTING_LOG_PATH_ENV_VAR, "sighting log", env)
            if sighting_log_path is not None or bool(env.get(SIGHTING_LOG_PATH_ENV_VAR, "").strip())
            else None
        ),
        canon_root_path=(
            _resolve_path(canon_root_path, CANON_ROOT_PATH_ENV_VAR, "canon root", env)
            if canon_root_path is not None or bool(env.get(CANON_ROOT_PATH_ENV_VAR, "").strip())
            else None
        ),
        candidate_replacements_path=(
            _resolve_path(candidate_replacements_path, CANDIDATE_REPLACEMENTS_PATH_ENV_VAR,
                          "candidate replacements path", env)
            if candidate_replacements_path is not None or bool(env.get(CANDIDATE_REPLACEMENTS_PATH_ENV_VAR, "").strip())
            else None
        ),
    )


# --- the catalogue -----------------------------------------------------------

#: The closed JSON shapes a declared parameter may take. Not an ``Enum``: this
#: project's own vocabulary check requires every module-level Python ``Enum``
#: under ``src/nous_os`` to be documented in ``docs/VOCABULARY.md``, and a
#: closed set of JSON Schema-style type names carries no epistemic content for
#: that document to map — it is a wire-format detail, not a product concept.
JSON_TYPES: Final = ("string", "integer", "number", "boolean", "array", "object")


@dataclass(frozen=True, slots=True)
class ParameterSpec:
    """One declared JSON-shaped parameter: its name, type, and whether it is required."""

    name: str
    json_type: str
    required: bool
    description: str

    def __post_init__(self) -> None:
        if type(self.name) is not str or not self.name:
            raise CoreError("a parameter name must be a non-blank string")
        if self.json_type not in JSON_TYPES:
            raise CoreError(f"unknown JSON parameter type: {self.json_type!r}")
        if type(self.required) is not bool:
            raise CoreError("a parameter's required flag must be a bool")
        if type(self.description) is not str or not self.description:
            raise CoreError("a parameter description must be a non-blank string")


#: Tiers no external operation may ever be published at. ``ingest_source`` and
#: ``promote_candidate`` are registered at ``Tier.PROMOTE``; nothing is yet
#: registered at ``Tier.EXTERNAL_CONSEQUENTIAL_ACTION``, and the refusal below
#: covers it anyway so a future registration at that tier is unreachable here
#: too, by construction, on day one. Declared before :class:`OperationDescriptor`
#: because its own constructor reads this name directly: the refusal is not
#: solely :func:`_descriptor`'s to make, so a caller building a descriptor by
#: hand, bypassing that helper entirely, is refused identically.
_UNOFFERED_TIERS: Final = (Tier.PROMOTE, Tier.EXTERNAL_CONSEQUENTIAL_ACTION)


@dataclass(frozen=True, slots=True)
class OperationDescriptor:
    """One external operation: its name, tier, registered operation, and parameters.

    ``operation`` is the name registered in :mod:`nous_os.operations`, or
    ``None`` for a Core-level read that calls nothing through the registry.
    ``tier`` is checked against :func:`~nous_os.capability.required_tier` in
    this class's own ``__post_init__``, for every entry that names a
    registered operation, not merely by :func:`_descriptor`: a caller
    building a descriptor by hand with a ``tier`` that disagrees with what
    ``operation`` is actually registered at is refused here directly, so a
    declared tier cannot silently drift from what the registry enforces
    regardless of which constructor was used to reach this class.

    A tier in :data:`_UNOFFERED_TIERS` is refused here directly, not merely by
    :func:`_descriptor`: this class is exported in :data:`__all__` and nothing
    about its own constructor otherwise stops a caller from building a
    PROMOTE or EXTERNAL_CONSEQUENTIAL_ACTION descriptor by hand.
    """

    external_name: str
    operation: str | None
    tier: Tier
    summary: str
    parameters: tuple[ParameterSpec, ...]

    def __post_init__(self) -> None:
        if type(self.external_name) is not str or not self.external_name:
            raise CoreError("an external operation name must be a non-blank string")
        if self.operation is not None and type(self.operation) is not str:
            raise CoreError("operation must be a registered name or None")
        if not any(self.tier is member for member in Tier):
            raise CoreError("tier must be a declared Tier member")
        if self.operation is not None and self.tier is not required_tier(self.operation):
            raise CoreError(
                f"{self.external_name!r} declares tier {self.tier}, but "
                f"{self.operation!r} is registered at {required_tier(self.operation)}"
            )
        if any(self.tier is forbidden for forbidden in _UNOFFERED_TIERS):
            raise PromotionNotOffered(
                f"{self.external_name!r} declares tier {self.tier}; this contract "
                "offers no PROMOTE or EXTERNAL_CONSEQUENTIAL_ACTION operation, "
                "through this constructor or any other"
            )
        if type(self.summary) is not str or not self.summary:
            raise CoreError("a descriptor summary must be a non-blank string")
        if type(self.parameters) is not tuple or any(
            type(parameter) is not ParameterSpec for parameter in self.parameters
        ):
            raise CoreError("parameters must be a tuple of exact ParameterSpec records")


#: The tier Core itself declares for the two reads that call no registered
#: operation. Named once so both descriptors read the same value rather than
#: two literals that could drift apart.
_CORE_LEVEL_TIER: Final = Tier.READ


def _descriptor(
    external_name: str,
    operation: str | None,
    summary: str,
    parameters: tuple[ParameterSpec, ...],
) -> OperationDescriptor:
    tier = _CORE_LEVEL_TIER if operation is None else required_tier(operation)
    if tier in _UNOFFERED_TIERS:
        raise PromotionNotOffered(
            f"{external_name!r} names {operation!r}, registered at {tier}; "
            "this contract offers no PROMOTE or EXTERNAL_CONSEQUENTIAL_ACTION operation"
        )
    return OperationDescriptor(external_name, operation, tier, summary, parameters)


#: The catalogue this contract offers. Fixed order, fixed membership: every
#: entry is built through :func:`_descriptor`, which refuses to return one
#: whose tier is ``Tier.PROMOTE`` or ``Tier.EXTERNAL_CONSEQUENTIAL_ACTION`` —
#: so ``ingest_source`` and ``promote_candidate`` are unreachable here by
#: construction, not merely absent from the list below.
CATALOGUE: Final[tuple[OperationDescriptor, ...]] = (
    _descriptor(
        "system.capabilities",
        None,
        "List every operation this contract offers, with its tier and parameters.",
        (),
    ),
    _descriptor(
        "system.health",
        None,
        "Report whether each configured store location is readable, absent, or unknown.",
        (),
    ),
    _descriptor(
        "knowledge.search",
        "search",
        "Full-text search over the derived index.",
        (
            ParameterSpec("query", "string", True, "the full-text search query"),
            ParameterSpec(
                "limit", "integer", False, "maximum number of hits to return; defaults to 10"
            ),
        ),
    ),
    _descriptor(
        "knowledge.context",
        "context",
        "Read a source's conversation neighbourhood, or a conversation's ordered records, from the derived index.",
        (
            ParameterSpec("source_id", "string", False, "a source whose conversation neighbourhood is read"),
            ParameterSpec("container", "string", False, "a conversation identifier whose records are read"),
            ParameterSpec("before", "integer", False, "records before a source target; defaults to 2"),
            ParameterSpec("after", "integer", False, "records after a source target; defaults to 2"),
            ParameterSpec("limit", "integer", False, "maximum container records to return; defaults to 200"),
        ),
    ),
    _descriptor(
        "knowledge.semantic",
        "semantic",
        "Dense semantic search over the local semantic index; not_run with a reason when the index or the weights are absent.",
        (
            ParameterSpec("query", "string", True, "the dense semantic search query"),
            ParameterSpec("limit", "integer", False, "maximum number of hits to return; defaults to 10"),
            ParameterSpec(
                "distinct",
                "boolean",
                False,
                "one hit per source, the best chunk; defaults to true",
            ),
        ),
    ),
    _descriptor(
        "canon.documents",
        "list_documents",
        "List every canonical document under the configured data root.",
        (),
    ),
    _descriptor(
        "canon.describe",
        "describe_corpus",
        "List every canonical document under the data root with the digest of its bytes.",
        (),
    ),
    _descriptor(
        "canon.sources",
        "sources",
        "List every source the derived index holds.",
        (),
    ),
    _descriptor(
        "canon.versions",
        "versions",
        "List one source's snapshot digests, oldest first.",
        (ParameterSpec("source_id", "string", True, "the source whose versions are listed"),),
    ),
    _descriptor(
        "canon.assertions",
        "list_assertions",
        "List verified promoted canonical decisions from the configured canon root.",
        (
            ParameterSpec(
                "assertion_id",
                "string",
                False,
                "an exact assertion identifier to restrict the listing",
            ),
        ),
    ),
    _descriptor(
        "provenance.span",
        "read_span",
        "Read the exact text a citation names, from the snapshot it cites.",
        (
            ParameterSpec(
                "citation",
                "object",
                True,
                "the citation naming a source, snapshot digest, byte range, and quoted span",
            ),
        ),
    ),
    _descriptor(
        "provenance.verify_derived",
        "verify_derived",
        "Lint a quote from preserved extraction evidence; `full` also reproduces it from governed original bytes only when both the configured asset root and sighting log bind that source to a current locator.",
        (
            ParameterSpec(
                "citation",
                "object",
                True,
                "the derived citation naming an asset, extraction record, character range, and span",
            ),
            ParameterSpec(
                "full",
                "boolean",
                False,
                "whether to include a fresh-derivation verdict when bytes are available",
            ),
        ),
    ),
    _descriptor(
        "graph.project",
        "project",
        "Project a renderer-independent knowledge graph from caller-supplied state.",
        (
            ParameterSpec(
                "state", "object", True, "the temporal index, bridges, and rejections to project"
            ),
            ParameterSpec("policy", "string", True, "one of 'reliability' or 'discovery'"),
            ParameterSpec(
                "question",
                "object",
                False,
                "the temporal axes to project at; defaults to all time",
            ),
        ),
    ),
    _descriptor(
        "time.as_of",
        "as_of",
        "Partition a caller-supplied temporal index by validity and recording time.",
        (
            ParameterSpec("index", "object", True, "the temporal index to read"),
            ParameterSpec("valid_at", "string", False, "an instant to filter validity against"),
            ParameterSpec(
                "recorded_as_of", "string", False, "an instant to filter recording time against"
            ),
        ),
    ),
    _descriptor(
        "time.conflicts",
        "conflicts",
        "Report connected disagreements in a caller-supplied temporal index.",
        (
            ParameterSpec("index", "object", True, "the temporal index to read"),
            ParameterSpec(
                "key", "string", False, "restrict to one explicit claim key; defaults to every key"
            ),
        ),
    ),
    _descriptor(
        "time.supersession",
        "supersession",
        "Return one subject's recorded assertion history, oldest first.",
        (
            ParameterSpec("index", "object", True, "the temporal index to read"),
            ParameterSpec("key", "string", True, "the explicit claim key to read"),
        ),
    ),
    _descriptor(
        "context.compile",
        "compile_context",
        "Fill a token budget from a caller-supplied ranking. Performs no retrieval.",
        (
            ParameterSpec("chunks", "array", True, "every candidate chunk the ranking may name"),
            ParameterSpec(
                "ranking",
                "array",
                True,
                "chunk ids in relevance order; this operation does not produce the order",
            ),
            ParameterSpec(
                "strategy", "string", True, "the name of a preregistered cohesion strategy"
            ),
            ParameterSpec("budget_tokens", "integer", True, "the token budget to fill"),
        ),
    ),
    _descriptor(
        "candidate.proposals",
        "proposals",
        "List every recorded proposal, in file order.",
        (),
    ),
    _descriptor(
        "candidate.search",
        "candidate_search",
        "Search recorded proposals; canonical standing requires an exact promoted id and version.",
        (
            ParameterSpec("query", "string", True, "plain words and quoted phrases to search"),
            ParameterSpec("limit", "integer", False, "page size, 1 to 20; defaults to 10"),
            ParameterSpec("cursor", "string", False, "opaque next-page cursor"),
            ParameterSpec("include_replaced", "boolean", False, "include superseded proposals; defaults to false"),
            ParameterSpec("ranking", "string", False,
                          "text (default: standing first among best text matches), "
                          "text_relevance (plain BM25), or source_semantic (cited-source rank)"),
        ),
    ),
    _descriptor(
        "candidate.rejections",
        "rejections",
        "List every recorded rejection, in file order.",
        (),
    ),
    _descriptor(
        "candidate.bridges",
        "bridges",
        "List every recorded bridge card, in file order.",
        (),
    ),
    _descriptor(
        "candidate.propose",
        "record_proposal",
        "Record one untrusted proposal, apart from canon.",
        (
            ParameterSpec("source_id", "string", True, "the source the proposal came from"),
            ParameterSpec("content", "string", True, "the proposed content, as untrusted text"),
            ParameterSpec("proposed_at", "string", True, "the instant the proposal was made"),
            ParameterSpec("holder", "string", True, "who or what put the proposal forward"),
        ),
    ),
    _descriptor(
        "candidate.discover",
        "discover",
        "Classify a deterministic round of candidate bridge cards.",
        (
            ParameterSpec("round_number", "integer", True, "the round being run"),
            ParameterSpec("candidates", "array", True, "the bridge cards proposed this round"),
            ParameterSpec("at", "string", True, "the instant this round is recorded at"),
            ParameterSpec(
                "consult_memory",
                "boolean",
                False,
                "whether to skip clusters already rejected; defaults to true",
            ),
        ),
    ),
    _descriptor(
        "candidate.adjudicate",
        "adjudicate",
        "Record one durable failed-gate rejection trace.",
        (
            ParameterSpec("cluster_id", "string", True, "the cluster that failed a gate"),
            ParameterSpec("failed_gate", "string", True, "which gate failed"),
            ParameterSpec("reason", "string", True, "why the gate failed"),
            ParameterSpec("round_number", "integer", True, "the round the failure was found in"),
            ParameterSpec("rejected_at", "string", True, "the instant the rejection is recorded at"),
        ),
    ),
    _descriptor(
        "reconcile.relations",
        "relations",
        "List recorded relations, optionally restricted to one source or class.",
        (
            ParameterSpec("source_id", "string", False, "an end source id to restrict results to"),
            ParameterSpec("relation_class", "string", False, "one declared relation class to restrict results to"),
        ),
    ),
    _descriptor(
        "reconcile.propose",
        "propose_relation",
        "Record one evidence-linked relation proposal, apart from source memory.",
        (ParameterSpec("relation", "object", True, "the complete explicit relation proposal"),),
    ),
    _descriptor(
        "reconcile.verify",
        "verify_relations",
        "Re-resolve every stored relation end and citation without changing the record.",
        (),
    ),
)

assert len({descriptor.external_name for descriptor in CATALOGUE}) == len(CATALOGUE), (
    "two catalogue entries share an external name"
)


# --- JSON argument validation -------------------------------------------------


def _matches_json_type(value: object, json_type: str) -> bool:
    if json_type == "string":
        return type(value) is str
    if json_type == "integer":
        return type(value) is int and not isinstance(value, bool)
    if json_type == "number":
        return type(value) in (int, float) and not isinstance(value, bool)
    if json_type == "boolean":
        return type(value) is bool
    if json_type == "array":
        return type(value) is list
    if json_type == "object":
        return type(value) is dict
    raise CoreError(f"unknown JSON parameter type: {json_type!r}")  # pragma: no cover


def _bind_json_arguments(
    descriptor: OperationDescriptor, arguments: Mapping[str, object]
) -> dict[str, object]:
    """Validate supplied JSON-shaped arguments against one descriptor's spec.

    An unknown argument name is refused, not ignored. A missing required
    argument is refused. A present argument whose JSON type disagrees with its
    declared type is refused. This is purely structural: it reads names and
    types from ``descriptor.parameters``, never from the supplied values.
    """
    if type(arguments) is not dict:
        raise ArgumentTypeError("arguments must be a JSON object")
    declared = {parameter.name: parameter for parameter in descriptor.parameters}
    unknown = sorted(set(arguments) - set(declared))
    if unknown:
        raise UnknownArgument(
            f"{descriptor.external_name} does not declare argument(s): {unknown}"
        )
    missing = sorted(
        parameter.name
        for parameter in descriptor.parameters
        if parameter.required and parameter.name not in arguments
    )
    if missing:
        raise MissingArgument(
            f"{descriptor.external_name} is missing required argument(s): {missing}"
        )
    for name, value in arguments.items():
        spec = declared[name]
        if not _matches_json_type(value, spec.json_type):
            raise ArgumentTypeError(
                f"{descriptor.external_name} argument {name!r} must be a JSON {spec.json_type}"
            )
    return dict(arguments)


# --- JSON to domain-type conversion ------------------------------------------


def _instant(value: object, field: str) -> datetime:
    if type(value) is not str:
        raise ArgumentTypeError(f"{field} must be a string instant")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise ArgumentTypeError(f"{field} is not an ISO 8601 instant: {value!r}") from error
    if parsed.tzinfo is None or parsed.tzinfo.utcoffset(parsed) is None:
        raise ArgumentTypeError(f"{field} must carry a timezone")
    return parsed


def _optional_instant(value: object, field: str) -> datetime | None:
    return None if value is None else _instant(value, field)


def _object(payload: object, keys: frozenset[str], name: str) -> dict[str, object]:
    if type(payload) is not dict or set(payload) != keys:
        raise ArgumentTypeError(f"{name} must be an object with exactly {sorted(keys)}")
    return payload


def _string_array(value: object, field: str) -> tuple[str, ...]:
    if type(value) is not list or any(type(item) is not str for item in value):
        raise ArgumentTypeError(f"{field} must be an array of strings")
    return tuple(value)


def _claim_key(value: object) -> ClaimKey:
    if type(value) is not str:
        raise ArgumentTypeError("a claim key must be a string")
    try:
        return ClaimKey(value)
    except ClaimKeyError as error:
        raise ArgumentTypeError(str(error)) from error


def _citation(payload: object, field: str = "citation") -> Citation:
    value = _object(
        payload, frozenset({"source_id", "snapshot_digest", "start_byte", "end_byte", "span"}), field
    )
    try:
        return Citation(
            value["source_id"],
            value["snapshot_digest"],
            Locator(value["start_byte"], value["end_byte"]),
            value["span"],
        )
    except (ProvenanceError, InvalidIdentifier, TypeError) as error:
        raise ArgumentTypeError(f"{field} is not a valid citation: {error}") from error


def _derived_citation(payload: object, field: str = "citation"):
    try:
        return derived_citation_from_payload(payload)
    except (ProvenanceError, InvalidIdentifier, TypeError) as error:
        raise ArgumentTypeError(f"{field} is not a valid derived citation: {error}") from error


def _assertion_from_payload(payload: object) -> tuple[ClaimKey, Assertion]:
    value = _object(
        payload,
        frozenset(
            {"key", "id", "text", "citation", "support", "recorded_at", "valid_from", "valid_to"}
        ),
        "an assertion entry",
    )
    try:
        support = SupportClass(value["support"])
    except ValueError as error:
        raise ArgumentTypeError(f"unknown support class: {value['support']!r}") from error
    try:
        assertion = Assertion(
            id=value["id"],
            text=value["text"],
            citation=_citation(value["citation"], "assertion citation"),
            support=support,
            recorded_at=_instant(value["recorded_at"], "recorded_at"),
            state=LifecycleState.CANONICAL,
            valid_from=_optional_instant(value["valid_from"], "valid_from"),
            valid_to=_optional_instant(value["valid_to"], "valid_to"),
        )
    except CanonicalError as error:
        raise ArgumentTypeError(f"assertion entry is not valid: {error}") from error
    return _claim_key(value["key"]), assertion


def _temporal_index_from_payload(payload: object) -> TemporalIndex:
    value = _object(payload, frozenset({"assertions"}), "index")
    assertions = value["assertions"]
    if type(assertions) is not list:
        raise ArgumentTypeError("index.assertions must be an array")
    index = TemporalIndex()
    for entry in assertions:
        key, assertion = _assertion_from_payload(entry)
        try:
            index.add(key, assertion)
        except TemporalError as error:
            raise ArgumentTypeError(f"index could not hold an assertion: {error}") from error
    return index


def _temporal_question_from_payload(payload: object) -> TemporalQuestion:
    value = _object(payload, frozenset({"valid_at", "recorded_as_of"}), "question")
    try:
        return TemporalQuestion(
            valid_at=_optional_instant(value["valid_at"], "valid_at"),
            recorded_as_of=_optional_instant(value["recorded_as_of"], "recorded_as_of"),
        )
    except ProjectionError as error:
        raise ArgumentTypeError(f"question is not valid: {error}") from error


_PROJECTION_POLICIES_BY_NAME: Final = {"reliability": RELIABILITY, "discovery": DISCOVERY}


def _projection_policy(value: object) -> ProjectionPolicy:
    if type(value) is not str:
        raise ArgumentTypeError("policy must be a string")
    policy = _PROJECTION_POLICIES_BY_NAME.get(value)
    if policy is None:
        raise ArgumentTypeError(
            f"unknown policy {value!r}; expected one of "
            f"{sorted(_PROJECTION_POLICIES_BY_NAME)}"
        )
    return policy


def _endpoint_from_payload(payload: object) -> Endpoint:
    value = _object(payload, frozenset({"project", "citation", "quote"}), "an endpoint")
    try:
        return Endpoint(
            project=value["project"],
            citation=_citation(value["citation"], "endpoint citation"),
            quote=value["quote"],
        )
    except DiscoveryError as error:
        raise ArgumentTypeError(f"endpoint is not valid: {error}") from error


def _gate_vector_from_payload(payload: object) -> GateVector:
    value = _object(payload, frozenset({"outcomes", "reasons", "triviality"}), "gates")
    outcomes_payload = value["outcomes"]
    reasons_payload = value["reasons"]
    if type(outcomes_payload) is not dict or type(reasons_payload) is not dict:
        raise ArgumentTypeError("gates.outcomes and gates.reasons must be objects")
    try:
        outcomes = {Gate(gate): GateOutcome(outcome) for gate, outcome in outcomes_payload.items()}
        reasons = {Gate(gate): reason for gate, reason in reasons_payload.items()}
        triviality = value["triviality"]
        return GateVector(
            outcomes=outcomes,
            reasons=reasons,
            triviality=None if triviality is None else TrivialityArchetype(triviality),
        )
    except (ValueError, DiscoveryError) as error:
        raise ArgumentTypeError(f"gates are not valid: {error}") from error


def _bridge_card_from_payload(payload: object) -> BridgeCard:
    value = _object(
        payload,
        frozenset(
            {
                "card_id",
                "cluster_id",
                "left",
                "right",
                "epistemic_class",
                "depth",
                "non_triviality",
                "consequence",
                "noise_objection",
                "gates",
                "origin_round",
            }
        ),
        "a bridge card",
    )
    try:
        return BridgeCard(
            card_id=value["card_id"],
            cluster_id=value["cluster_id"],
            left=_endpoint_from_payload(value["left"]),
            right=_endpoint_from_payload(value["right"]),
            epistemic_class=EpistemicClass(value["epistemic_class"]),
            depth=Depth(value["depth"]),
            non_triviality=value["non_triviality"],
            consequence=value["consequence"],
            noise_objection=value["noise_objection"],
            gates=_gate_vector_from_payload(value["gates"]),
            origin_round=value["origin_round"],
        )
    except (ValueError, DiscoveryError) as error:
        raise ArgumentTypeError(f"bridge card is not valid: {error}") from error


def _rejection_from_payload(payload: object) -> Rejection:
    value = _object(
        payload,
        frozenset({"cluster_id", "failed_gate", "reason", "round_number", "rejected_at"}),
        "a rejection entry",
    )
    try:
        return Rejection(
            cluster_id=value["cluster_id"],
            failed_gate=value["failed_gate"],
            reason=value["reason"],
            round_number=value["round_number"],
            rejected_at=_instant(value["rejected_at"], "rejected_at"),
        )
    except AdjudicationError as error:
        raise ArgumentTypeError(f"rejection entry is not valid: {error}") from error


def _knowledge_state_from_payload(payload: object) -> KnowledgeState:
    value = _object(payload, frozenset({"index", "bridges", "rejections"}), "state")
    bridges_payload = value["bridges"]
    rejections_payload = value["rejections"]
    if type(bridges_payload) is not list or type(rejections_payload) is not list:
        raise ArgumentTypeError("state.bridges and state.rejections must be arrays")
    try:
        return KnowledgeState(
            index=_temporal_index_from_payload(value["index"]),
            bridges=tuple(_bridge_card_from_payload(item) for item in bridges_payload),
            rejections=tuple(_rejection_from_payload(item) for item in rejections_payload),
        )
    except ProjectionError as error:
        raise ArgumentTypeError(f"state is not valid: {error}") from error


def _chunk_from_payload(payload: object) -> Chunk:
    value = _object(
        payload,
        frozenset({"id", "source_id", "ordinal", "heading_path", "text", "tokens", "references"}),
        "a chunk",
    )
    heading_path = value["heading_path"]
    references = value["references"]
    if type(heading_path) is not list or any(type(item) is not str for item in heading_path):
        raise ArgumentTypeError("chunk.heading_path must be an array of strings")
    if type(references) is not list or any(type(item) is not str for item in references):
        raise ArgumentTypeError("chunk.references must be an array of strings")
    try:
        return Chunk(
            id=value["id"],
            source_id=value["source_id"],
            ordinal=value["ordinal"],
            heading_path=tuple(heading_path),
            text=value["text"],
            tokens=value["tokens"],
            references=tuple(references),
        )
    except ChunkingError as error:
        raise ArgumentTypeError(f"chunk is not valid: {error}") from error


def _relation_proposal_from_payload(payload: object) -> RelationProposal:
    try:
        return RelationProposal.from_payload(payload)
    except RelationError as error:
        raise ArgumentTypeError(f"relation proposal is not valid: {error}") from error


#: Every preregistered cohesion strategy, keyed by its own stable label. A
#: caller names a strategy; this operation does not invent one, and it never
#: runs retrieval to produce the ranking it is handed.
_COMPILE_STRATEGIES_BY_NAME: Final[dict[str, CohesionStrategy]] = {
    strategy.name: strategy for strategy in PREREGISTERED_ARMS
}


def _compile_strategy(value: object) -> CohesionStrategy:
    if type(value) is not str:
        raise ArgumentTypeError("strategy must be a string")
    strategy = _COMPILE_STRATEGIES_BY_NAME.get(value)
    if strategy is None:
        raise ArgumentTypeError(
            f"unknown compilation strategy {value!r}; expected one of "
            f"{sorted(_COMPILE_STRATEGIES_BY_NAME)}"
        )
    return strategy


# --- binding: JSON-shaped arguments to domain keyword arguments --------------


def _bind_search(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    kwargs: dict[str, object] = {"path": workspace.derived_path, "query": arguments["query"]}
    if "limit" in arguments:
        kwargs["limit"] = arguments["limit"]
    return kwargs


def _bind_context(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    kwargs: dict[str, object] = {"path": workspace.derived_path}
    for name in ("source_id", "container", "before", "after", "limit"):
        if name in arguments:
            kwargs[name] = arguments[name]
    return kwargs


def _bind_semantic(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    kwargs: dict[str, object] = {
        "index_path": workspace.semantic_index_path,
        "derived_path": workspace.derived_path,
        "query": arguments["query"],
        "distinct": arguments.get("distinct", True),
    }
    for name in ("limit",):
        if name in arguments:
            kwargs[name] = arguments[name]
    return kwargs


def _bind_root_only(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {"root": workspace.data_root}


def _bind_path_only(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {"path": workspace.derived_path}


def _bind_versions(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {"path": workspace.derived_path, "source_id": arguments["source_id"]}


def _bind_assertions(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    assertion_id = arguments.get("assertion_id")
    if assertion_id is not None:
        require_id(assertion_id, ASSERTION_PREFIX)
    return {"root": workspace.canon_root_path, "assertion_id": assertion_id}


def _bind_read_span(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {
        "store": SnapshotStore(workspace.snapshot_root),
        "citation": _citation(arguments["citation"]),
    }


def _bind_verify_derived(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    kwargs: dict[str, object] = {
        "extraction_store": ExtractionStore(workspace.extraction_store_path),
        "snapshot_store": SnapshotStore(workspace.snapshot_root),
        "ledger": Ledger(workspace.ledger_path),
        "citation": _derived_citation(arguments["citation"]),
    }
    if "full" in arguments:
        kwargs["full"] = arguments["full"]
    if workspace.asset_root_path is not None:
        kwargs["asset_root_path"] = workspace.asset_root_path
    if workspace.sighting_log_path is not None:
        kwargs["sighting_log_path"] = workspace.sighting_log_path
    return kwargs


def _bind_project(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    kwargs: dict[str, object] = {
        "state": _knowledge_state_from_payload(arguments["state"]),
        "policy": _projection_policy(arguments["policy"]),
    }
    if "question" in arguments:
        kwargs["question"] = _temporal_question_from_payload(arguments["question"])
    return kwargs


def _bind_as_of(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    kwargs: dict[str, object] = {"index": _temporal_index_from_payload(arguments["index"])}
    if "valid_at" in arguments:
        kwargs["valid_at"] = _instant(arguments["valid_at"], "valid_at")
    if "recorded_as_of" in arguments:
        kwargs["recorded_as_of"] = _instant(arguments["recorded_as_of"], "recorded_as_of")
    return kwargs


def _bind_conflicts(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    kwargs: dict[str, object] = {"index": _temporal_index_from_payload(arguments["index"])}
    if "key" in arguments:
        kwargs["key"] = _claim_key(arguments["key"])
    return kwargs


def _bind_supersession(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {
        "index": _temporal_index_from_payload(arguments["index"]),
        "key": _claim_key(arguments["key"]),
    }


def _bind_compile_context(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    chunks = arguments["chunks"]
    if type(chunks) is not list:
        raise ArgumentTypeError("chunks must be an array")
    return {
        "chunks": tuple(_chunk_from_payload(item) for item in chunks),
        "ranking": _string_array(arguments["ranking"], "ranking"),
        "strategy": _compile_strategy(arguments["strategy"]),
        "budget_tokens": arguments["budget_tokens"],
    }


def _bind_proposals(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {"store": CandidateStore(workspace.candidate_store_path)}


def _bind_candidate_search(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {
        "store_path": workspace.candidate_store_path,
        "replacement_path": workspace.candidate_replacements_path,
        "canon_root": workspace.canon_root_path,
        "semantic_index_path": workspace.semantic_index_path,
        "derived_path": workspace.derived_path,
        **arguments,
    }


def _bind_rejections(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {"memory": RejectionMemory(workspace.rejection_memory_path)}


def _bind_bridges(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {"registry": BridgeRegistry(workspace.bridge_registry_path)}


def _bind_record_proposal(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {
        "store": CandidateStore(workspace.candidate_store_path),
        "source_id": arguments["source_id"],
        "content": UntrustedText(arguments["content"]),
        "proposed_at": _instant(arguments["proposed_at"], "proposed_at"),
        "holder": arguments["holder"],
    }


def _bind_discover(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    candidates = arguments["candidates"]
    if type(candidates) is not list:
        raise ArgumentTypeError("candidates must be an array")
    kwargs: dict[str, object] = {
        "round_number": arguments["round_number"],
        "candidates": tuple(_bridge_card_from_payload(item) for item in candidates),
        "registry": BridgeRegistry(workspace.bridge_registry_path),
        "memory": RejectionMemory(workspace.rejection_memory_path),
        "at": _instant(arguments["at"], "at"),
    }
    if "consult_memory" in arguments:
        kwargs["consult_memory"] = arguments["consult_memory"]
    return kwargs


def _bind_adjudicate(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {
        "memory": RejectionMemory(workspace.rejection_memory_path),
        "cluster_id": arguments["cluster_id"],
        "failed_gate": arguments["failed_gate"],
        "reason": arguments["reason"],
        "round_number": arguments["round_number"],
        "rejected_at": _instant(arguments["rejected_at"], "rejected_at"),
    }


def _bind_relations(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    kwargs: dict[str, object] = {"store": RelationStore(workspace.relation_store_path)}
    if "source_id" in arguments:
        kwargs["source_id"] = arguments["source_id"]
    if "relation_class" in arguments:
        try:
            kwargs["relation_class"] = RelationClass(arguments["relation_class"])
        except ValueError as error:
            raise ArgumentTypeError(
                f"relation_class is not a declared relation class: {arguments['relation_class']!r}"
            ) from error
    return kwargs


def _bind_propose_relation(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {
        "store": RelationStore(workspace.relation_store_path),
        "snapshots": SnapshotStore(workspace.snapshot_root),
        "proposal": _relation_proposal_from_payload(arguments["relation"]),
    }


def _bind_verify_relations(workspace: Workspace, arguments: dict[str, object]) -> dict[str, object]:
    return {
        "store": RelationStore(workspace.relation_store_path),
        "snapshots": SnapshotStore(workspace.snapshot_root),
    }


_BINDERS: Final = {
    "knowledge.search": _bind_search,
    "knowledge.context": _bind_context,
    "knowledge.semantic": _bind_semantic,
    "canon.documents": _bind_root_only,
    "canon.describe": _bind_root_only,
    "canon.sources": _bind_path_only,
    "canon.versions": _bind_versions,
    "canon.assertions": _bind_assertions,
    "provenance.span": _bind_read_span,
    "provenance.verify_derived": _bind_verify_derived,
    "graph.project": _bind_project,
    "time.as_of": _bind_as_of,
    "time.conflicts": _bind_conflicts,
    "time.supersession": _bind_supersession,
    "context.compile": _bind_compile_context,
    "candidate.proposals": _bind_proposals,
    "candidate.search": _bind_candidate_search,
    "candidate.rejections": _bind_rejections,
    "candidate.bridges": _bind_bridges,
    "candidate.propose": _bind_record_proposal,
    "candidate.discover": _bind_discover,
    "candidate.adjudicate": _bind_adjudicate,
    "reconcile.relations": _bind_relations,
    "reconcile.propose": _bind_propose_relation,
    "reconcile.verify": _bind_verify_relations,
}


# --- rendering: domain results to JSON-shaped data ---------------------------


def _render_citation(citation: Citation) -> dict[str, object]:
    return {
        "source_id": citation.source_id,
        "snapshot_digest": citation.snapshot_digest,
        "start_byte": citation.locator.start_byte,
        "end_byte": citation.locator.end_byte,
        "span": citation.span,
    }


def _render_instant(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _render_optional_instant(value: datetime | None) -> str | None:
    return None if value is None else _render_instant(value)


def _render_assertion(assertion: Assertion) -> dict[str, object]:
    return {
        "id": assertion.id,
        "text": assertion.text,
        "citation": _render_citation(assertion.citation),
        "support": assertion.support.value,
        "recorded_at": _render_instant(assertion.recorded_at),
        "state": assertion.state.value,
        "valid_from": _render_optional_instant(assertion.valid_from),
        "valid_to": _render_optional_instant(assertion.valid_to),
    }


def _render_search(hits) -> list[dict[str, object]]:
    rendered = []
    for hit in hits:
        item = {
            "snapshot_digest": hit.snapshot_digest,
            "source_id": hit.source_id,
            "text": hit.text,
            "kind": hit.kind,
            "role": hit.role,
            "created_at": hit.created_at,
        }
        if hit.title is not None:
            item["title"] = hit.title
        rendered.append(item)
    return rendered


def _render_describe_corpus(described) -> list[dict[str, object]]:
    return [{"path": path, "digest": digest} for path, digest in described]


def _render_as_of(answer) -> dict[str, object]:
    return {
        "established": [_render_assertion(a) for a in answer.established],
        "excluded": [_render_assertion(a) for a in answer.excluded],
        "undetermined": [_render_assertion(a) for a in answer.undetermined],
    }


def _render_conflicts(conflicts) -> list[dict[str, object]]:
    return [
        {
            "key": conflict.key.value,
            "members": [_render_assertion(a) for a in conflict.members],
            "overlap": conflict.overlap.value,
        }
        for conflict in conflicts
    ]


def _render_chunk(chunk: Chunk) -> dict[str, object]:
    return {
        "id": chunk.id,
        "source_id": chunk.source_id,
        "ordinal": chunk.ordinal,
        "heading_path": list(chunk.heading_path),
        "text": chunk.text,
        "tokens": chunk.tokens,
        "references": list(chunk.references),
    }


def _render_pack(pack: Pack) -> dict[str, object]:
    return {
        "chunks": [_render_chunk(chunk) for chunk in pack.chunks],
        "manifest": pack.manifest.as_payload(),
    }


def _render_round_result(result) -> dict[str, object]:
    return {
        "round_number": result.round_number,
        "status": result.status.value,
        "proposed": [card.as_payload() for card in result.proposed],
        "accepted": [card.as_payload() for card in result.accepted],
        "rejected": [card.as_payload() for card in result.rejected],
        "undetermined": [card.as_payload() for card in result.undetermined],
        "skipped": list(result.skipped),
    }


_RENDERERS: Final = {
    "knowledge.search": _render_search,
    "knowledge.context": lambda result: result,
    "knowledge.semantic": lambda result: result,
    "canon.documents": lambda documents: list(documents),
    "canon.describe": _render_describe_corpus,
    "canon.sources": lambda sources: list(sources),
    "canon.versions": lambda versions: list(versions),
    "canon.assertions": lambda assertions: assertions,
    "provenance.span": lambda text: text,
    "provenance.verify_derived": lambda result: result,
    "graph.project": lambda ir: ir.as_payload(),
    "time.as_of": _render_as_of,
    "time.conflicts": _render_conflicts,
    "time.supersession": lambda assertions: [_render_assertion(a) for a in assertions],
    "context.compile": _render_pack,
    "candidate.proposals": lambda proposals: [p.as_payload() for p in proposals],
    "candidate.search": lambda result: result,
    "candidate.rejections": lambda rejections: [r.as_payload() for r in rejections],
    "candidate.bridges": lambda cards: [c.as_payload() for c in cards],
    "candidate.propose": lambda proposal: proposal.as_payload(),
    "candidate.discover": _render_round_result,
    "candidate.adjudicate": lambda rejection: rejection.as_payload(),
    "reconcile.relations": lambda relations: [relation.as_payload() for relation in relations],
    "reconcile.propose": lambda relation: relation.as_payload(),
    "reconcile.verify": lambda verification: verification.as_payload(),
}


# --- the two Core-level reads --------------------------------------------------


def _authorize_core_level(grant: Grant, tier: Tier) -> None:
    """Refuse exactly as ``execute`` would, for a read that calls no registered operation.

    ``system.capabilities`` and ``system.health`` read no canonical content and
    call nothing through the governed registry, so there is no ``execute``
    invocation to perform the tier check inside. This is a hand-maintained
    copy of ``execute``'s grant type, tier-set type, and membership checks;
    ``test_core_level_authorization_matches_execute_for_valid_and_malformed_grants``
    compares their accepted/refused outcomes for valid, missing, and malformed
    grants. It is not mechanically bound to ``execute``.
    """
    refusal = "the grant does not hold the operation's required tier"
    if type(grant) is not Grant:
        raise NotAuthorized(refusal)
    if type(getattr(grant, "tiers", None)) is not frozenset:
        raise NotAuthorized(refusal)
    try:
        authorized = grant.holds(tier)
    except Exception:
        authorized = False
    if not authorized:
        raise NotAuthorized(refusal)


def _render_descriptor(descriptor: OperationDescriptor) -> dict[str, object]:
    return {
        "name": descriptor.external_name,
        "tier": descriptor.tier.value,
        "summary": descriptor.summary,
        "parameters": [
            {
                "name": parameter.name,
                "type": parameter.json_type,
                "required": parameter.required,
                "description": parameter.description,
            }
            for parameter in descriptor.parameters
        ],
    }


def _system_capabilities() -> dict[str, object]:
    return {"operations": [_render_descriptor(descriptor) for descriptor in CATALOGUE]}


def _location_health(path: Path, *, is_directory: bool) -> str:
    """healthy / absent / unknown for one location, never conflating them.

    Calls :func:`os.stat` directly rather than ``Path.is_dir``/``Path.is_file``:
    those methods report *every* ``OSError`` — a permission failure exactly
    like a missing file — as a plain ``False``, which is precisely the
    conflation this function exists to refuse. ``FileNotFoundError`` is the
    one outcome this treats as genuinely absent; any other failure to stat the
    location, most often a permission failure, is unknown rather than assumed
    healthy or assumed absent. A location that exists but is the wrong kind of
    node — a file sitting where a directory belongs, or the reverse — is
    unknown as well: it is not healthy, and reporting it as merely absent
    would hide that something real, just not the expected thing, is there.

    ``os.stat`` succeeding is not the same fact as the location being
    readable: a directory's permission bits can admit ``stat`` while refusing
    ``readdir``, and a file's can admit ``stat`` while refusing ``read`` --
    the exact access a real caller would make. So once the node exists and is
    the right kind, this attempts that access directly: listing the directory
    or opening the file for reading. A ``PermissionError`` there, exactly
    like one from ``os.stat`` itself, is unknown rather than healthy.
    """
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return "absent"
    except OSError:
        return "unknown"
    kind_matches = stat.S_ISDIR(info.st_mode) if is_directory else stat.S_ISREG(info.st_mode)
    if not kind_matches:
        return "unknown"
    try:
        if is_directory:
            with os.scandir(path):
                pass
        else:
            with open(path, "rb"):
                pass
    except OSError:
        return "unknown"
    return "healthy"


def _system_health(workspace: Workspace) -> dict[str, object]:
    return {
        "data_root": _location_health(workspace.data_root.path, is_directory=True),
        "snapshot_root": _location_health(workspace.snapshot_root, is_directory=True),
        "ledger_path": _location_health(workspace.ledger_path, is_directory=False),
        "derived_path": _location_health(workspace.derived_path, is_directory=False),
        "candidate_store_path": _location_health(
            workspace.candidate_store_path, is_directory=False
        ),
        "bridge_registry_path": _location_health(
            workspace.bridge_registry_path, is_directory=False
        ),
        "rejection_memory_path": _location_health(
            workspace.rejection_memory_path, is_directory=False
        ),
        "relation_store_path": _location_health(workspace.relation_store_path, is_directory=False),
        "extraction_store_path": (
            "unconfigured"
            if workspace.extraction_store_path is None
            else _location_health(workspace.extraction_store_path, is_directory=True)
        ),
        "semantic_index_path": (
            "unconfigured"
            if workspace.semantic_index_path is None
            else _location_health(workspace.semantic_index_path, is_directory=True)
        ),
        "asset_root_path": (
            "unconfigured"
            if workspace.asset_root_path is None
            else _location_health(workspace.asset_root_path, is_directory=True)
        ),
        "canon_root_path": (
            "unconfigured"
            if workspace.canon_root_path is None
            else _location_health(workspace.canon_root_path, is_directory=True)
        ),
        "sighting_log_path": (
            "unconfigured"
            if workspace.sighting_log_path is None
            else _location_health(workspace.sighting_log_path, is_directory=False)
        ),
    }


# --- the one entry point -------------------------------------------------------


def _resolve_descriptor(external_name: str) -> OperationDescriptor:
    """Resolve one descriptor from its external name alone.

    The signature is the property: it takes no ``arguments`` parameter at all,
    so nothing supplied by a caller can be consulted while choosing which
    operation, and therefore which tier, a request will run against.
    """
    descriptor = next(
        (candidate for candidate in CATALOGUE if candidate.external_name == external_name), None
    )
    if descriptor is None:
        raise UnknownExternalOperation(f"no operation is published under {external_name!r}")
    return descriptor


def validate_arguments(
    external_name: str, workspace: Workspace, arguments: Mapping[str, object]
) -> None:
    """Run every check ``invoke`` runs before it ever reaches ``execute``, without executing.

    Resolves the descriptor, validates ``arguments`` against its declared
    parameter specification, and runs the identical domain-type conversion
    the matching binder performs -- the exact two steps :func:`invoke`
    performs before it calls :func:`nous_os.capability.execute`, reusing that
    same code so those two checks cannot drift apart from having been typed
    twice. Raises the identical typed error :func:`invoke` would raise for a
    structural or binder-detected malformed request; returns ``None`` for a
    request that would proceed through binding.

    This cannot reach a check a registered operation's own implementation
    performs only while actually running -- an identifier's exact format
    inside a domain constructor, for instance -- because that code is never
    called here. A caller needing to validate several requests before
    deciding whether to run any of them, such as an all-or-nothing import,
    can use this instead of writing and then discovering a later one was
    malformed.
    """
    descriptor = _resolve_descriptor(external_name)
    bound = _bind_json_arguments(descriptor, arguments)
    if descriptor.operation is None:
        return
    binder = _BINDERS[external_name]
    binder(workspace, bound)


def invoke(
    grant: Grant,
    external_name: str,
    workspace: Workspace,
    arguments: Mapping[str, object],
) -> object:
    """Resolve, authorize, and run one external operation. The one entry point.

    The steps run in this fixed order, and the order is the property:

    1. Resolve a descriptor from ``external_name`` alone. An unknown name is
       refused before anything about ``arguments`` is examined.
    2. Validate ``arguments`` against the descriptor's declared parameter
       specification: an undeclared name or a wrong JSON type is refused.
    3. Build domain-typed keyword arguments from the validated JSON, through
       each domain type's own validating constructor.
    4. Call :func:`nous_os.capability.execute` — this module's only path to a
       registered operation — or, for the two Core-level reads that name no
       registered operation, perform the copied authorization check directly.
    5. Render the domain result back into JSON-shaped data.

    Because resolution depends only on ``external_name`` and a descriptor's
    tier is fixed at catalogue construction (from the governed registry for a
    registered operation and from the shared READ constant for a Core-level
    read), no content inside ``arguments`` can change which operation is
    resolved or which tier is checked. Validation and binding read and
    transform ``arguments``, but they cannot feed back into the resolution
    above them or into the later tier check, because resolution has already
    completed by the time either runs.
    """
    descriptor = _resolve_descriptor(external_name)

    bound = _bind_json_arguments(descriptor, arguments)

    if descriptor.operation is None:
        _authorize_core_level(grant, descriptor.tier)
        if external_name == "system.capabilities":
            return _system_capabilities()
        return _system_health(workspace)

    binder = _BINDERS[external_name]
    domain_kwargs = binder(workspace, bound)
    result = execute(grant, descriptor.operation, **domain_kwargs)
    renderer = _RENDERERS[external_name]
    return renderer(result)
