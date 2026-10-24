#!/usr/bin/env python3
"""Read and write the watchdog state file, including its stable mode token."""

from __future__ import annotations

import sys
from pathlib import Path


def encode_state(session: str, started: str, idle: str, maximum: str,
                 presence: bool, away: str) -> str:
    mode = "presence" if presence else "idle"
    return "\n".join((session, started, idle, maximum, mode, away, ""))


def read_state(path: Path) -> tuple[str, str, str, str, str, str] | None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    if len(lines) < 4:
        return None
    session, started, idle, maximum = lines[:4]
    mode = lines[4] if len(lines) > 4 else "idle"
    away = lines[5] if len(lines) > 5 else "0"
    mode = {"yes": "presence", "no": "idle"}.get(mode, mode)
    if mode not in {"idle", "presence"}:
        return None
    return session, started, idle, maximum, mode, away


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) == 8 and args[0] == "write":
        _, filename, session, started, idle, maximum, presence, away = args
        Path(filename).write_text(
            encode_state(session, started, idle, maximum, presence == "yes", away),
            encoding="utf-8",
        )
        return 0
    if len(args) == 2 and args[0] == "read":
        state = read_state(Path(args[1]))
        if state is None:
            return 1
        print("\n".join(state))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
