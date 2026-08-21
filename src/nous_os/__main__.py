"""Entry point. Reports the version and nothing else.

The command surface is deliberately this small. Operations arrive with the
capabilities that define them, so that nothing here claims a behaviour the
test suite does not yet cover.
"""

from __future__ import annotations

import argparse

from nous_os import __version__


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nous-os", description="NousOS")
    parser.add_argument("--version", action="version", version=__version__)
    parser.parse_args(argv)
    parser.print_help()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
