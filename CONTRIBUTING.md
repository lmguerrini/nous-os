# Contributing

Thank you for looking. This document is short and specific: it covers how to
run what is here, and the one contract this project is strict about.

## Running the checks

```bash
python3 -m pip install pytest ".[semantic]"
npm --prefix ui ci
python3 -m pytest tests/ -q --ignore=tests/test_semantic.py --ignore=tests/test_semantic_controls.py
npm --prefix ui run typecheck
```

That is the same command continuous integration runs, and every part of it is
load-bearing:

- **The `semantic` extra**, even though the two modules that need checkpoints are
  excluded. `nous_os.semantic` imports NumPy at module level, and three tests
  elsewhere walk every module in the package. With only `pytest` installed and no
  `--ignore`, pytest aborts during collection and nothing runs at all.
- **The two `--ignore` arguments**, because those modules need two ONNX
  checkpoints already in a local Hugging Face cache. Nothing is ever downloaded.
- **`npm --prefix ui ci`**, because five tests in `tests/test_vocabulary.py` check
  a published document against the renderer's own resolved values by bundling the
  TypeScript that produces them. Without `ui/node_modules` those five **fail with
  a stated reason** — they do not skip and they do not pass.

`README.md` lists what does not run from a public clone, and why each of those is
a stated refusal rather than a silent skip.

## The commit-message contract

**Every commit message in this repository has the same shape**, and it is
checked mechanically:

```
type(scope): concise imperative subject

- what changed, and why it matters
- a second outcome
```

### The rules

| Rule | |
|---|---|
| Type | one of `build chore ci docs feat fix perf refactor revert style test` |
| Scope | optional, lower case, the area actually changed — `temporal`, `ledger`, `render3f`, `engine`, `mcp` |
| Subject length | **72 characters hard maximum**, including the type and scope. 45–65 reads best |
| Mood | imperative — *add*, *refuse*, *bind*, *stop*. Never *adds*, *added*, *adding* |
| Case | the description starts lower case and does not end in a full stop |
| One statement | **no comma-joined clauses**, no ` because `, ` so that `, ` and then `, ` which ` |
| Body | one blank line, then **two to four bullets**, each a single line of at most 300 characters |
| Nothing else | no prose after the bullets, no trailers, no `Co-authored-by`, no tool or model attribution |

### What must never appear

Anything naming *how the work was run* rather than *what changed*: internal
capability identifiers (`CAP-13`), decision or candidate identifiers, the words
`coordinator`, `gauntlet`, `preregistration`, `tranche`, `closure record`,
`closure audit`, `runtime pack`, and the name of any model or vendor. A reader of
this repository cannot resolve any of them.

The ordinary word **capability is fine and is product vocabulary** —
`capability.py`, `system.capabilities`, four authority tiers. Only the opaque
identifiers are refused.

Absolute filesystem paths are refused too.

### Why the rules are this specific

The first two hundred commits here were rigorous and unreadable. Every one
passed a gate that checked shape and forbidden words, and a subject could run to
a hundred and thirty-six characters of narrative — *"let the missing-record
control reach the case it exists to prove, and stop the document claiming a
check nobody runs"* — and still be accepted, because **formal conformance is not
quality** and nothing was asking the second question. The history was rewritten
once, in a single message-only pass that preserved every tree, author, committer
and timestamp exactly. This document and the check below exist so that it does
not have to happen again.

### Checking a message

```bash
python3 tools/commit_msg_contract.py .git/COMMIT_EDITMSG
python3 tools/commit_msg_contract.py --range HEAD~10..HEAD
```

Install it as a hook if you like — it is a plain script with no dependencies:

```bash
printf '#!/bin/sh\nexec python3 tools/commit_msg_contract.py "$1"\n' > .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg
```

Continuous integration runs the same check over the whole history on every push,
so a message that drifts is caught whether or not the hook is installed.

**This check does not ask whether a message is safe to publish.** That question
needs a private vocabulary that must not itself be published, so it lives outside
this repository and runs before a push. A green result here means *well formed
and well written*, and nothing more; the two questions are separate and this
tool answers only the first.

## Everything else

The principles the code is tested against are in `README.md`, and the names this
project uses — and why some concepts earned a word from the vocabulary of
knowledge rather than of software — are in `docs/VOCABULARY.md`, which the test
suite checks against the code.

Two habits matter more than any style rule here:

- **A check that did not run is not a check that passed.** Anything that cannot
  be evaluated reports a third answer and says why. Please keep it that way
  rather than adding a skip.
- **No complexity without evidence.** A new mechanism needs a named failure
  mode, a reproducible test and an observed win before it earns a place.
