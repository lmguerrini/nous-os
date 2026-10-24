#!/usr/bin/env python3
"""Small fcntl lock wrapper for serializing tunnel starts."""

from __future__ import annotations

import fcntl
import os
import sys
from pathlib import Path


def acquire(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        return -1
    os.set_inheritable(descriptor, True)
    return descriptor


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) >= 2 and args[0] == "acquire":
        descriptor = acquire(Path(args[1]))
        if descriptor < 0:
            print("Another start is already in progress.", file=sys.stderr)
            return 75
        if len(args) < 3:
            return 0
        os.execv(args[2], args[2:])
    if len(args) == 2 and args[0] == "check":
        descriptor = acquire(Path(args[1]))
        if descriptor < 0:
            return 75
        os.close(descriptor)
        return 0
    print("Invalid lock helper arguments.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
