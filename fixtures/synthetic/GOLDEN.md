# Golden cases

**Expectations here are derived from the fixture text, not from a run.** Each row says which
documents a correct system must return, and that was decided by reading the documents — not by
running the search and recording what came back. A golden file regenerated from the implementation
it constrains cannot fail.

The fixture set is deliberately bilingual, because vocabulary that differs across languages is one
cause of retrieval misses, and a monolingual fixture set cannot
exercise an alias layer at all.

## G-RETR — exact lexical retrieval, no aliases

Each query appears verbatim in exactly one document, so a correct exact-match system returns that
one and no other.

| Query | Must return | Why, from the text |
|---|---|---|
| `tide` | `en-tides` | the English document says "The tide rises"; the Italian one contains no such word |
| `marea` | `it-maree` | the Italian document says "La marea sale"; the English one contains no such word |
| `lighthouse` | `en-lighthouse` | present in the English document only |
| `faro` | `it-faro` | present in the Italian document only |

## G-ITEN — the cross-language gap

Each query must return **both** language versions of the same subject. With no alias layer these
are misses, by construction: the Italian document does not contain the English term. That is the
gap the alias layer exists to close, and the baseline exists so the closing can be measured rather
than asserted.

| Query | Must return | Baseline outcome, expected |
|---|---|---|
| `tide` | `en-tides`, `it-maree` | MISS — Italian text has no "tide" |
| `lighthouse` | `en-lighthouse`, `it-faro` | MISS — Italian text has no "lighthouse" |
