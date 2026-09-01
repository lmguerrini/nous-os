"""Entry point. Delegates the whole command line to :mod:`nous_os.cli`.

This module keeps no argument-parsing logic of its own -- :mod:`nous_os.cli`
is the one place that walks :data:`nous_os.core.CATALOGUE` to build the real
command surface, including ``--version``, so there is exactly one parser to
keep in step with the catalogue rather than two.
"""

from __future__ import annotations

from nous_os.cli import main

if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
