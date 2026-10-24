#!/usr/bin/env python3
"""Pure policy for the opt-in presence keeper."""

from __future__ import annotations

import argparse


def should_start(*, session_running: bool, setup_complete: bool,
                 user_idle_seconds: float | None, manual_stop: bool) -> bool:
    """Start only for a configured, stopped, non-manually-stopped present user."""
    return (
        not session_running
        and setup_complete
        and user_idle_seconds is not None
        and user_idle_seconds < 120
        and not manual_stop
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-running", action="store_true")
    parser.add_argument("--setup-complete", action="store_true")
    parser.add_argument("--idle-seconds", type=float)
    parser.add_argument("--manual-stop", action="store_true")
    args = parser.parse_args()
    print("start" if should_start(
        session_running=args.session_running,
        setup_complete=args.setup_complete,
        user_idle_seconds=args.idle_seconds,
        manual_stop=args.manual_stop,
    ) else "skip")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
