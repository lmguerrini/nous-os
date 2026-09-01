# Interoperability: the Core contract and its two transports

This describes what an outside process — a script, a local coding agent, a client speaking the
Model Context Protocol — can actually reach in NousOS, through which door, and under which
authority. It does not describe an aspiration; every operation named below is generated at
runtime from `src/nous_os/core.py`'s published catalogue, and the two transports are checked
against that catalogue by the test suite rather than trusted to have kept pace with it by hand.

## One contract, two transports

```
                CORE SERVICE CONTRACT           src/nous_os/core.py
               /                     \
            CLI                     stdio JSON-RPC
      src/nous_os/cli.py      src/nous_os/mcp.py
```

`nous_os.core` is the one application service boundary. It publishes a fixed catalogue of
external operations — nineteen of them — each with a stable external name, a required
authorization tier, and a declared parameter specification. Every governed decision this package
makes is made inside `core.invoke`: resolving which operation a name refers to, validating the
supplied JSON-shaped arguments against that operation's declared parameters, and checking the
caller's grant against the tier the operation actually requires — read from
`nous_os.capability`'s live registry at catalogue-construction time, never retyped.

Two transports are built on top of that one contract, and both are **generated** from it rather
than hand-written:

- **`nous_os.cli`**, a command-line interface. One subcommand per catalogue entry, named with the
  entry's external name exactly, with one option per declared parameter.
- **`nous_os.mcp`**, a stdio JSON-RPC 2.0 server, standard library only. One tool per catalogue
  entry, published through `tools/list`, with a JSON Schema built from the same parameter
  specification the command line uses.

Neither transport imports the other, in either direction — enforced structurally and checked by
the test suite, not merely a convention. Neither imports a domain module in order to call an
operation, and neither calls `nous_os.capability.execute` directly: both call `core.invoke`, and
`core.invoke` is the only thing that calls `execute`. Every semantic decision — which operation a
name resolves to, whether a grant holds the required tier, how an argument is validated — is made
once, inside Core, and is therefore identical on both transports by construction rather than by
having been kept in step by hand. It also means every one of those decisions is reachable and
correct with the stdio server's module, `nous_os.mcp`, never imported at all: nothing about it is
the internal authority for anything.

## Authority: declared once, at process startup, and never widened by a request

Neither transport asks Core, or anything else, who may issue a grant — `nous_os.capability` is
explicit that this is a question it does not answer. Each transport answers it the same, narrow
way:

- A transport declares the tier set it runs with **once, at process startup**, from an explicit
  command-line argument or an environment variable, and **defaults to `read` alone**. Proposing
  requires an explicit opt-in at startup; it is never implied by a request.
- **Nothing about a request can widen that declared set.** Not the tool or subcommand name being
  invoked, not the content of any argument, not a session identity, not the identity a client
  reports about itself during `initialize`. The grant built at startup is passed unchanged to
  every call the process serves.
- **A transport that mistakenly declares `promote` still reaches no promoting operation**, because
  the catalogue does not publish one — see below. This is the strongest single statement this
  design can make, and it is checked directly, per transport, against every published operation.

## Every published operation, and its tier

| Operation | Tier | Summary | Parameters (`?` = optional) |
| --- | --- | --- | --- |
| `system.capabilities` | read | List every operation this contract offers, with its tier and parameters. | (none) |
| `system.health` | read | Report whether each configured store location is readable, absent, or unknown. | (none) |
| `knowledge.search` | read | Full-text search over the derived index. | query, limit? |
| `canon.documents` | read | List every canonical document under the configured data root. | (none) |
| `canon.describe` | read | List every canonical document under the data root with the digest of its bytes. | (none) |
| `canon.sources` | read | List every source the derived index holds. | (none) |
| `canon.versions` | read | List one source's snapshot digests, oldest first. | source_id |
| `provenance.span` | read | Read the exact text a citation names, from the snapshot it cites. | citation |
| `graph.project` | read | Project a renderer-independent knowledge graph from caller-supplied state. | state, policy, question? |
| `time.as_of` | read | Partition a caller-supplied temporal index by validity and recording time. | index, valid_at?, recorded_as_of? |
| `time.conflicts` | read | Report connected disagreements in a caller-supplied temporal index. | index, key? |
| `time.supersession` | read | Return one subject's recorded assertion history, oldest first. | index, key |
| `context.compile` | read | Fill a token budget from a caller-supplied ranking. Performs no retrieval. | chunks, ranking, strategy, budget_tokens |
| `candidate.proposals` | read | List every recorded proposal, in file order. | (none) |
| `candidate.rejections` | read | List every recorded rejection, in file order. | (none) |
| `candidate.bridges` | read | List every recorded bridge card, in file order. | (none) |
| `candidate.propose` | propose | Record one untrusted proposal, apart from canon. | source_id, content, proposed_at, holder |
| `candidate.discover` | propose | Classify a deterministic round of candidate bridge cards. | round_number, candidates, at, consult_memory? |
| `candidate.adjudicate` | propose | Record one durable failed-gate rejection trace. | cluster_id, failed_gate, reason, round_number, rejected_at |

This table matches `core.CATALOGUE` and is checked against it by
`tests/test_interoperability_doc.py`.

## No `promote` or externally-consequential operation is published, and why

`ingest_source` and `promote_candidate` are registered in `nous_os.operations` at
`Tier.PROMOTE`, and nothing is yet registered at
`Tier.EXTERNAL_CONSEQUENTIAL_ACTION`. Neither tier has a single entry in the table above, and that
absence is not an oversight waiting to be filled in: `core.py`'s catalogue-construction helper
refuses outright to build a descriptor at either tier, so attempting to add one raises before it
could ever be held. A promotion, or any action with an effect outside this package, can only be
reached by a human working a step this contract does not offer to either transport — which is the
entire reason a portable artifact and a remote client can be trusted with authority no stronger
than `read` or `propose` at all: there is nothing stronger for either of them to reach, by
construction, regardless of what tier a misconfigured process declares for itself at startup.

## The portable proposal artifact

A client that cannot itself open a connection to the stdio transport — see below — still needs a
way to hand this package proposed material. The portable proposal artifact is a plain JSON file
the command line reads (the one permitted local file input either transport offers, and only the
command line offers it) and turns into one or more calls to the existing `candidate.propose`
operation — **an argument-sourcing mode, not a new operation.** The published operation set is
identical on both transports; importing from an artifact adds no name to either one.

Schema, defined in `nous_os.artifact`:

```json
{
  "schema": "nous-os.candidate-proposal-artifact",
  "version": 1,
  "provider": "a local client, recorded for provenance only",
  "session": "a session identifier, recorded for provenance only",
  "proposals": [
    {
      "source_id": "src_...",
      "content": "the proposed text",
      "proposed_at": "2026-01-02T12:00:00+00:00",
      "holder": "who or what put the proposal forward"
    }
  ]
}
```

Three properties hold the whole design:

1. **The artifact cannot carry authority.** No grant, tier, or capability field exists in this
   schema, at any depth. A document naming one anyway is refused outright — `ArtifactCarriesAuthority`
   — never silently dropped. Authority for what an imported proposal may do comes from the tier
   the command line was started with, exactly as it would for a proposal typed directly.
2. **Its content arrives untrusted.** Every proposal's `content` becomes
   `nous_os.untrusted.UntrustedText` the moment the artifact is parsed, and is unwrapped only at
   the one point that must produce the plain string `core.invoke` requires.
3. **Provider and session identity are provenance, never authority.** Both are carried through
   unexamined, recorded alongside each imported result for whatever audit trail the caller keeps,
   and are proven incapable of changing the authorization decision: the tier the command line
   checks against is fixed at process startup, before the artifact is ever read.

An unknown schema identifier, an unsupported version, a malformed document, and a document whose
payload is not text are each refused with their own distinct, typed error.

## Wiring a local client to the stdio transport

`nous_os.mcp` speaks newline-delimited JSON-RPC 2.0 on stdin and stdout: one message in, one
message out, handling `initialize`, `tools/list`, and `tools/call` at minimum, with a tool
published per catalogue entry above. Nothing but a JSON-RPC message is ever written to stdout.

A local client that launches a server over stdio — a local coding agent is the common example —
generally needs three things from its own configuration, described here rather than performed:
a command to launch (`python -m nous_os.mcp`, or the equivalent for however this package is
installed), any workspace-location arguments or environment variables the deployment needs
(`--data-root`, `NOUS_OS_DATA_ROOT`, and the sibling options `nous_os.core.resolve_workspace`
reads), and, if authority beyond `read` is genuinely wanted for that specific launch, an explicit
`--tier` argument or the `NOUS_OS_STDIO_TIERS` environment variable. This document does not modify
any client's configuration file and does not read this machine's existing one; wiring a specific
client is the operator's own step, taken with the operator's own credentials for that client.

**`ChatGPT`'s own client speaks SSE and streaming HTTP, not stdio**, so it cannot itself open a
connection to a local process the way a stdio-based client can. A first-party `OpenAI` tunnel can
relay such a connection to a local server, at the cost of a Platform organization and a runtime
API key — and that path is **not taken here**. The portable artifact plus the command line's
import mode is the path that needs neither: a document produced anywhere reaches
`candidate.propose` through nothing but a local file read and a locally declared grant. That is
*a* real production path for getting proposed material from a client that cannot reach stdio into
this package, not a claim that it is the only one a future client integration might use.
