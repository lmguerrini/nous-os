"""Dense semantic retrieval: vectors as an index, never as canon.

**Derived, never authority.** Every vector this module produces is cached
inference over a chunk's text — nothing here says anything canon does not
already say, and nothing downstream may cite a vector as a fact. Deleting an
index and rebuilding it from the same chunks and the same weights must
reproduce it exactly, or the "derived" claim is false.

**No default weights.** Following ``aliases.py``: two backends are named here
— DENSE-ML, multilingual, and DENSE-EN, English-only — and neither is chosen
for a caller who forgot to. A module-level "the encoder" would be exactly the
unproven promotion the alias layer already refused to make for term expansion,
made again for embeddings.

**A model that cannot be loaded is not an error to smooth over, and it is not
a zero score either.** It is a third outcome, `IndexStatus.NOT_RUN`, with a
reason — the same shape as `measure.RunStatus.NOT_RUN`, for the same reason: a
caller citing "nothing matched" needs to be able to tell that apart from
"nothing ran".

**The configuration below is preregistered, not tuned here.** Truncation at
256 tokens, mean pooling over the attention mask, L2 normalisation, cosine
similarity, float32 throughout, one thread. Changing any of it changes what a
rebuild reproduces, so it is pinned rather than treated as a knob.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Protocol, runtime_checkable

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

from nous_os.chunking import Chunk
from nous_os.identity import digest_bytes

#: Truncation length, pinned. Not a default; every backend uses exactly this.
MAX_TOKENS = 256


class SemanticError(Exception):
    """Raised when an index cannot be built or queried as specified."""


class IndexStatus(Enum):
    """Whether an index actually holds vectors."""

    COMPLETE = "complete"
    #: The weights this index needed could not be loaded. **Never an empty
    #: index that reads as "searched and found nothing".**
    NOT_RUN = "not_run"


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """Which weights a backend loads. A name, not a default.

    Identifies a checkpoint by repository and filename rather than by a bare
    string a caller could mistype into "whichever one happens to be on disk".
    """

    name: str
    repo_id: str
    onnx_filename: str = "onnx/model.onnx"
    tokenizer_filename: str = "tokenizer.json"

    def __post_init__(self) -> None:
        for field_name in ("name", "repo_id", "onnx_filename", "tokenizer_filename"):
            value = getattr(self, field_name)
            if type(value) is not str or not value.strip():
                raise SemanticError(f"a model spec needs a {field_name}")


#: The two backends this capability was preregistered against. Naming them is
#: not choosing one: a caller still has to pass one to `build` or `OnnxBackend`.
DENSE_ML = ModelSpec("DENSE-ML", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
DENSE_EN = ModelSpec("DENSE-EN", "sentence-transformers/all-MiniLM-L6-v2")


@runtime_checkable
class Backend(Protocol):
    """Anything that turns text into fixed-size, L2-normalised vectors."""

    @property
    def name(self) -> str:
        """A stable identifier, so a result can say which weights produced it."""

    def encode(self, texts: tuple[str, ...]) -> np.ndarray:
        """Encode ``texts`` to a ``(len(texts), dim)`` float32, L2-normalised matrix."""


#: The three input names every sentence-transformers ONNX export this project
#: has seen declares. Not assumed: `OnnxBackend` only ever feeds the names a
#: given model's `get_inputs()` actually asks for, and refuses if it asks for
#: one that is not in this table.
_KNOWN_INPUTS = ("input_ids", "attention_mask", "token_type_ids")


class OnnxBackend:
    """A dense encoder loaded from one ONNX checkpoint and its tokenizer.

    Resolution happens once, in the constructor: a caller holding an instance
    has a working encoder, and a caller that could not get one has the reason
    why, to record as `NOT_RUN` rather than let an import-time crash propagate
    out of whatever was trying to build an index.
    """

    __slots__ = (
        "_spec",
        "_session",
        "_tokenizer",
        "_input_names",
        "_checkpoint_digest",
        "_tokenizer_digest",
    )

    def __init__(self, spec: ModelSpec) -> None:
        if not isinstance(spec, ModelSpec):
            raise SemanticError("a backend is built from a ModelSpec naming its weights")
        try:
            # `local_files_only` is the whole of this module's network posture,
            # and it is a refusal rather than a preference. Without it the
            # resolver contacts the hub on every construction -- it falls back
            # to the cache when that fails, so the index still builds offline,
            # but a system whose corpus boundary is enforced physically should
            # not be reaching for a network it does not need. It would also
            # DOWNLOAD a checkpoint that is merely absent, which is how a
            # 470 MB fetch happens without anyone deciding to.
            #
            # A checkpoint that is not already cached is therefore NOT_RUN with
            # a reason, not a silent acquisition. Obtaining weights is a human
            # act, performed once, deliberately -- not something a retrieval
            # index does on its own behalf mid-experiment.
            onnx_path = hf_hub_download(
                repo_id=spec.repo_id, filename=spec.onnx_filename, local_files_only=True
            )
            tokenizer_path = hf_hub_download(
                repo_id=spec.repo_id, filename=spec.tokenizer_filename, local_files_only=True
            )
        except Exception as error:
            # huggingface_hub raises a different exception for "repo absent",
            # "file absent" and "nothing cached", with no common base narrower
            # than Exception. Whichever it is, it is this module's NOT_RUN
            # reason to carry, never a crash the caller must anticipate.
            raise SemanticError(
                f"{spec.name}: could not resolve {spec.repo_id!r} ({spec.onnx_filename}): {error}"
            ) from error

        checkpoint_bytes = Path(onnx_path).read_bytes()
        tokenizer_bytes = Path(tokenizer_path).read_bytes()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        try:
            session = ort.InferenceSession(
                onnx_path, sess_options=options, providers=["CPUExecutionProvider"]
            )
        except Exception as error:
            raise SemanticError(f"{spec.name}: the checkpoint could not be loaded: {error}") from error

        input_names = {declared.name for declared in session.get_inputs()}
        unknown = input_names - set(_KNOWN_INPUTS)
        if unknown:
            raise SemanticError(
                f"{spec.name}: declares input(s) this backend cannot feed: {sorted(unknown)}"
            )

        tokenizer = Tokenizer.from_file(tokenizer_path)
        # The tokenizer's own padding config, if any, names the right pad id
        # and token for this vocabulary -- a default like `pad_id=0` is only
        # right by accident and is actively wrong for a sentencepiece
        # tokenizer whose pad id is not 0. Only the *length* is overridden, to
        # pad dynamically to the longest sequence in each call rather than to
        # whatever fixed length one particular checkpoint happened to ship
        # with; padding to a fixed length would still be correct once masked,
        # but a caller comparing two backends should not see one silently
        # padding further than the other for no reason tied to the query.
        padding = tokenizer.padding
        pad_id = padding["pad_id"] if padding else 0
        pad_token = padding["pad_token"] if padding else "[PAD]"
        tokenizer.enable_truncation(max_length=MAX_TOKENS)
        tokenizer.enable_padding(pad_id=pad_id, pad_token=pad_token, length=None)

        self._spec = spec
        self._session = session
        self._tokenizer = tokenizer
        self._input_names = input_names
        self._checkpoint_digest = digest_bytes(checkpoint_bytes)
        self._tokenizer_digest = digest_bytes(tokenizer_bytes)

    @property
    def name(self) -> str:
        return self._spec.name

    @property
    def checkpoint_digest(self) -> str:
        """sha256 of the ONNX file's bytes, so a result can say which weights produced it."""
        return self._checkpoint_digest

    @property
    def tokenizer_digest(self) -> str:
        """sha256 of the tokenizer JSON bytes paired with this checkpoint."""
        return self._tokenizer_digest

    def encode(self, texts: tuple[str, ...]) -> np.ndarray:
        """Mean-pool over the attention mask, then L2-normalise. Float32 throughout.

        Padding is applied per call, to the longest sequence in ``texts``. A
        text encoded alone and the same text encoded inside a longer batch
        must produce the same vector -- if they do not, the mask is being
        ignored somewhere and padding is silently entering the average.
        """
        if type(texts) is not tuple or not texts:
            raise SemanticError("encode needs a non-empty tuple of texts")
        encodings = self._tokenizer.encode_batch(list(texts))
        ids = np.array([encoding.ids for encoding in encodings], dtype=np.int64)
        mask = np.array([encoding.attention_mask for encoding in encodings], dtype=np.int64)
        type_ids = np.array([encoding.type_ids for encoding in encodings], dtype=np.int64)
        available = {"input_ids": ids, "attention_mask": mask, "token_type_ids": type_ids}
        feed = {input_name: available[input_name] for input_name in self._input_names}

        hidden = self._session.run(None, feed)[0]
        weights = mask.astype(np.float32)[..., np.newaxis]
        summed = (hidden.astype(np.float32) * weights).sum(axis=1)
        # Every row has at least one unmasked token -- the tokenizer always
        # emits at least a [CLS]/<s>-equivalent -- so this clamp exists for
        # arithmetic safety, not because a zero denominator is expected.
        counts = np.clip(weights.sum(axis=1), 1e-9, None)
        pooled = summed / counts
        norms = np.clip(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12, None)
        return (pooled / norms).astype(np.float32)


@dataclass(frozen=True, slots=True)
class SemanticHit:
    """One result. Rank 1 is the best match."""

    chunk_id: str
    source_id: str
    score: float
    rank: int


@dataclass(frozen=True, slots=True, eq=False)
class SemanticIndex:
    """Chunk ids and the vectors that encode them -- nothing else.

    Reconstructible from ``chunks`` and a `Backend` alone: the same chunks and
    the same weights must produce byte-identical vectors and byte-identical
    ranking, in any process. `state_digest` is how that claim is checked --
    never `==`, which this class disables. A frozen dataclass holding a numpy
    array gets a generated `__eq__` that compares fields with ``==``, and
    comparing an array of more than one element that way raises rather than
    answering; disabling it is cheaper than teaching every caller to avoid it.
    """

    status: IndexStatus
    backend_name: str
    chunk_ids: tuple[str, ...]
    source_ids: tuple[str, ...]
    vectors: np.ndarray | None = field(repr=False)
    checkpoint_digest: str | None = None
    reason: str | None = None
    #: The backend that produced this index, kept so `search` can encode a
    #: query without a caller having to hand it back in every time. `None`
    #: for a `NOT_RUN` index, which has nothing to encode a query with.
    backend: Backend | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self.status is IndexStatus.COMPLETE:
            if self.vectors is None or self.backend is None:
                raise SemanticError("a complete index must hold vectors and its backend")
            if self.vectors.dtype != np.float32:
                raise SemanticError("vectors must be float32")
            if self.vectors.shape[0] != len(self.chunk_ids):
                raise SemanticError("one vector per chunk id, no more and no fewer")
            if len(self.chunk_ids) != len(self.source_ids):
                raise SemanticError("chunk ids and source ids must pair up")
        else:
            if self.vectors is not None or self.backend is not None:
                raise SemanticError("a not-run index holds no vectors and no backend")
            if type(self.reason) is not str or not self.reason.strip():
                raise SemanticError("a not-run index must say why it did not run")

    def search(
        self,
        query: str,
        limit: int,
        exclude_sources: frozenset[str] = frozenset(),
    ) -> tuple[SemanticHit, ...]:
        """The ``limit`` nearest chunks to ``query`` by cosine similarity.

        ``exclude_sources`` is applied before the top-``limit`` cut, not
        after: filtering afterwards would return fewer than ``limit`` results
        whenever an excluded source occupied one of the top spots, silently
        shrinking ``k`` instead of finding the next real candidate.

        Ties are broken by chunk id, ascending. Never by whatever order the
        vector matrix happens to hold rows in -- that order is an accident of
        how `build` sorted its input, not a fact about relevance.
        """
        if self.status is not IndexStatus.COMPLETE:
            raise SemanticError(f"the index did not run: {self.reason}")
        if type(query) is not str or not query.strip():
            raise SemanticError("a search needs a query")
        if type(limit) is not int or isinstance(limit, bool) or limit < 1:
            raise SemanticError(f"limit must be a positive integer, not {limit!r}")
        if type(exclude_sources) is not frozenset:
            raise SemanticError(f"exclude_sources must be a frozenset, not {type(exclude_sources).__name__}")

        query_vector = self.backend.encode((query,))[0]
        scores = self.vectors @ query_vector
        candidates = [
            (chunk_id, source_id, float(score))
            for chunk_id, source_id, score in zip(self.chunk_ids, self.source_ids, scores)
            if source_id not in exclude_sources
        ]
        candidates.sort(key=lambda candidate: (-candidate[2], candidate[0]))
        return tuple(
            SemanticHit(chunk_id=chunk_id, source_id=source_id, score=score, rank=rank)
            for rank, (chunk_id, source_id, score) in enumerate(candidates[:limit], start=1)
        )

    def state_digest(self) -> str:
        """The digest of the ids and the vectors' raw bytes.

        Raw bytes, not a decimal or JSON rendering of the floats: comparing
        two builds by their text representation is a weaker claim than
        comparing them as bytes, and byte-identical is the claim this module
        makes.
        """
        if self.status is not IndexStatus.COMPLETE:
            raise SemanticError(f"the index did not run: {self.reason}")
        payload = b"\0".join(chunk_id.encode("utf-8") for chunk_id in self.chunk_ids)
        payload += b"\0\0" + self.vectors.tobytes()
        return digest_bytes(payload)


def not_run(backend_name: str, reason: str) -> SemanticIndex:
    """An index that did not happen, said out loud.

    Construction requires a reason, exactly like `measure.not_run`: a NOT_RUN
    index with no explanation reads as an oversight, not as a recorded fact,
    and this is the value most likely to be cited months later.
    """
    if type(reason) is not str or not reason.strip():
        raise SemanticError("a not-run index must say why it did not run")
    return SemanticIndex(IndexStatus.NOT_RUN, backend_name, (), (), None, None, reason, None)


def build(chunks: tuple[Chunk, ...], spec: ModelSpec) -> SemanticIndex:
    """Build an index over ``chunks`` with the weights ``spec`` names.

    Refuses an empty chunk set outright -- an empty index would score every
    query zero and a caller checking only ``status`` would read that as a
    completed search that simply found nothing, which is not what happened.
    A model that cannot be resolved is the other refusal this module makes
    explicit: `NOT_RUN`, not a crash and not an index that silently has
    nothing in it.
    """
    if type(chunks) is not tuple or not chunks:
        raise SemanticError("an index needs at least one chunk; an empty index scores everything zero")
    if not all(isinstance(chunk, Chunk) for chunk in chunks):
        raise SemanticError("an index is built from Chunk instances")
    if len({chunk.id for chunk in chunks}) != len(chunks):
        raise SemanticError("two chunks share an id")
    if not isinstance(spec, ModelSpec):
        raise SemanticError("build needs a ModelSpec naming which weights to use")

    try:
        backend = OnnxBackend(spec)
    except SemanticError as error:
        return not_run(spec.name, str(error))

    # Sorted by id, not left in the caller's order: two callers handing the
    # same chunks in a different order must still get byte-identical vectors,
    # or "derived, reconstructible" is a claim this module does not keep.
    ordered = tuple(sorted(chunks, key=lambda chunk: chunk.id))
    vectors = backend.encode(tuple(chunk.text for chunk in ordered))
    vectors = np.ascontiguousarray(vectors, dtype=np.float32)
    vectors.setflags(write=False)
    return SemanticIndex(
        IndexStatus.COMPLETE,
        backend.name,
        tuple(chunk.id for chunk in ordered),
        tuple(chunk.source_id for chunk in ordered),
        vectors,
        backend.checkpoint_digest,
        None,
        backend,
    )
