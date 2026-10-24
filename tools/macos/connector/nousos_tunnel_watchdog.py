#!/usr/bin/env python3
"""Stop an on-demand NousOS tunnel after real-request idle or absolute limits."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterable

SESSION_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
ACTIVITY_DECISIONS = {
    "forward",
    "capped",
    "child_error",
    "UNEXPECTED_WRITE_SUCCESS",
}
JOB_LABEL = "com.nousos.tunnel"


def utc_text(epoch: float) -> str:
    return (
        dt.datetime.fromtimestamp(epoch, dt.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def record_epoch(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        result = float(value)
        return result if math.isfinite(result) else None
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.timestamp()


def latest_real_request(
    records: Iterable[Any], session: str, start_epoch: float
) -> float | None:
    latest: float | None = None
    for record in records:
        if not isinstance(record, dict):
            continue
        if (
            record.get("session") != session
            or record.get("event") != "response"
            or record.get("method") != "tools/call"
            or record.get("decision") not in ACTIVITY_DECISIONS
        ):
            continue
        epoch = record_epoch(record.get("ts"))
        if epoch is not None and epoch >= start_epoch:
            latest = epoch if latest is None else max(latest, epoch)
    return latest


def decide(
    records: Iterable[Any],
    session: str,
    start_epoch: float,
    now_epoch: float,
    idle_s: float,
    max_s: float,
) -> tuple[Any, ...]:
    """Return run/remaining times/activity, or stop/reason/remaining/activity.

    An idle_s value of zero disables the idle limit for the --for alias.
    """
    latest = latest_real_request(records, session, start_epoch)
    last_activity = max(start_epoch, latest) if latest is not None else start_epoch
    idle_left = (
        math.inf if idle_s == 0 else max(0.0, idle_s - (now_epoch - last_activity))
    )
    max_left = max(0.0, max_s - (now_epoch - start_epoch))
    if now_epoch - start_epoch >= max_s:
        return ("stop", "max", idle_left, max_left, last_activity)
    if idle_s > 0 and now_epoch - last_activity >= idle_s:
        return ("stop", "idle", idle_left, max_left, last_activity)
    return ("run", idle_left, max_left, last_activity)


def read_hid_idle_seconds() -> float | None:
    """Read macOS HID idle time; return None for any missing or invalid input."""
    try:
        result = subprocess.run(
            ["/usr/sbin/ioreg", "-c", "IOHIDSystem", "-d", "4"],
            capture_output=True, text=True, check=False, timeout=5,
        )
        if result.returncode != 0:
            return None
        match = re.search(r'^[ |]*"HIDIdleTime"\s*=\s*(\d+)\s*$',
                          result.stdout, re.MULTILINE)
        if match is None:
            return None
        return int(match.group(1)) / 1_000_000_000
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def decide_presence(
    records: Iterable[Any], session: str, start_epoch: float,
    now_epoch: float, away_seconds: float, max_s: float,
    hid_idle_reader: Callable[[], float | None] = read_hid_idle_seconds,
) -> tuple[Any, ...]:
    """Presence stop requires away > S and no qualifying response within S.

    Unknown HID input fails safe by applying the existing real-response idle
    rule with S as its window.
    """
    hid_idle = hid_idle_reader()
    latest = latest_real_request(records, session, start_epoch)
    last_activity = max(start_epoch, latest) if latest is not None else start_epoch
    idle_age = max(0.0, now_epoch - last_activity)
    idle_left = max(0.0, away_seconds - idle_age)
    max_left = max(0.0, max_s - (now_epoch - start_epoch))
    if now_epoch - start_epoch >= max_s:
        return ("stop", "max", idle_left, max_left, last_activity, hid_idle)
    if hid_idle is None:
        if idle_age >= away_seconds:
            return ("stop", "idle", idle_left, max_left, last_activity, None)
    elif hid_idle > away_seconds and idle_age >= away_seconds:
        return ("stop", "away", idle_left, max_left, last_activity, hid_idle)
    return ("run", idle_left, max_left, last_activity, hid_idle)


def read_records(log_dir: Path, now_epoch: float) -> list[dict[str, Any]]:
    """Read both UTC days; an unreadable file discards all activity fail-safe."""
    today = dt.datetime.fromtimestamp(now_epoch, dt.timezone.utc).date()
    records: list[dict[str, Any]] = []
    for day in (today - dt.timedelta(days=1), today):
        path = log_dir / f"gate-{day:%Y%m%d}.ndjson"
        try:
            with path.open("rb") as stream:
                for line in stream:
                    # A writer may still be appending the final line.
                    if not line.endswith(b"\n"):
                        continue
                    try:
                        value = json.loads(line)
                    except (UnicodeDecodeError, ValueError):
                        continue
                    if isinstance(value, dict):
                        records.append(value)
        except FileNotFoundError:
            continue
        except OSError:
            return []
    return records


def job_loaded() -> bool:
    try:
        return subprocess.run(
            ["/bin/launchctl", "print", f"gui/{os.getuid()}/{JOB_LABEL}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode == 0
    except OSError:
        return False


def append_stop_log(
    log_dir: Path,
    session: str,
    reason: str,
    started: float,
    last_activity: float,
    idle_s: float,
    max_s: float,
) -> None:
    record = {
        "ts": utc_text(time.time()),
        "session": session,
        "reason": reason,
        "started": utc_text(started),
        "last_activity": utc_text(last_activity),
        "idle_s": idle_s,
        "max_s": max_s,
    }
    line = (json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n").encode(
        "utf-8"
    )
    descriptor = os.open(
        log_dir / "watchdog.log",
        os.O_WRONLY | os.O_APPEND | os.O_CREAT,
        0o600,
    )
    try:
        os.write(descriptor, line)
    finally:
        os.close(descriptor)


def print_status(args: argparse.Namespace) -> int:
    now = time.time()
    records = read_records(args.log_dir, now)
    latest = latest_real_request(records, args.session, args.start_epoch)
    presence_away_seconds = getattr(args, "presence_away_seconds", None)
    presence = presence_away_seconds is not None
    if presence:
        result = decide_presence(records, args.session, args.start_epoch, now,
                                 presence_away_seconds, args.max_seconds)
    else:
        result = decide(records, args.session, args.start_epoch, now,
                        args.idle_seconds, args.max_seconds)
    if result[0] == "run":
        _, idle_left, max_left, *_ = result
    else:
        _, _, idle_left, max_left, *_ = result
    print(f"session: {args.session}")
    print(f"started: {utc_text(args.start_epoch)}")
    if presence:
        print("mode: presence")
        hid_idle = result[-1]
        print("user idle seconds: " + ("unknown" if hid_idle is None else f"{hid_idle:.1f}"))
    print(f"last real request: {utc_text(latest) if latest is not None else 'none yet'}")
    idle_window = args.presence_away_seconds if presence else args.idle_seconds
    print("idle minutes left: " + ("disabled" if idle_window == 0 else f"{idle_left / 60:.1f}"))
    print(f"max minutes left: {max_left / 60:.1f}")
    return 0


def run_loop(
    args: argparse.Namespace,
    *,
    is_loaded: Callable[[], bool] = job_loaded,
) -> int:
    saw_tunnel_loaded = False
    while True:
        loaded = is_loaded()
        if loaded:
            saw_tunnel_loaded = True
        elif saw_tunnel_loaded:
            # A manual stop has already unloaded the tunnel job.
            return 0

        now = time.time()
        records = read_records(args.log_dir, now)
        if getattr(args, "presence_away_seconds", None) is not None:
            result = decide_presence(records, args.session, args.start_epoch,
                                     now, args.presence_away_seconds,
                                     args.max_seconds)
        else:
            result = decide(records, args.session, args.start_epoch, now,
                            args.idle_seconds, args.max_seconds)
        if result[0] == "stop":
            _, reason, _, _, last_activity, *_ = result
            if not loaded:
                # The tunnel never loaded, or was manually stopped before this
                # process observed it. There is nothing to stop.
                return 0
            if not is_loaded():
                return 0
            completed = subprocess.run(
                ["/bin/zsh", str(args.stop_command), "stop", "--from-watchdog", "--reason", reason],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if completed.returncode == 0:
                try:
                    append_stop_log(
                        args.log_dir, args.session, reason, args.start_epoch,
                        last_activity, args.idle_seconds, args.max_seconds,
                    )
                except OSError as exc:
                    print(f"Cannot append watchdog stop log: {exc}", file=sys.stderr)
                    return 1
                return 0
            # Retry a failed stop while the launchd watchdog remains alive.
        if args.once:
            return 0
        time.sleep(args.interval)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--start-epoch", required=True, type=float)
    parser.add_argument("--idle-seconds", required=True, type=float)
    parser.add_argument("--max-seconds", required=True, type=float)
    parser.add_argument("--presence-away-seconds", type=float)
    parser.add_argument("--log-dir", required=True, type=Path)
    parser.add_argument("--stop-command", type=Path)
    parser.add_argument("--interval", type=float, default=30)
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--self-label", default="")
    args = parser.parse_args(argv)

    if not SESSION_PATTERN.fullmatch(args.session):
        parser.error("invalid session")
    if args.self_label and not SESSION_PATTERN.fullmatch(args.self_label):
        parser.error("invalid self label")
    if not math.isfinite(args.start_epoch):
        parser.error("start epoch must be finite")
    if not math.isfinite(args.idle_seconds) or args.idle_seconds < 0:
        parser.error("idle seconds must be nonnegative and finite")
    if not math.isfinite(args.max_seconds) or args.max_seconds <= 0:
        parser.error("max seconds must be positive and finite")
    if args.presence_away_seconds is not None and (
        not math.isfinite(args.presence_away_seconds) or args.presence_away_seconds <= 0
    ):
        parser.error("presence away seconds must be positive and finite")
    if not math.isfinite(args.interval) or args.interval <= 0:
        parser.error("interval must be positive and finite")
    if args.status:
        return print_status(args)
    if args.stop_command is None or not args.stop_command.is_absolute():
        parser.error("--stop-command must be an absolute path")
    code = run_loop(args)
    if args.self_label:
        # Unload this one-shot launchd job so no finished watchdog stays loaded.
        # launchd ends this process as part of the bootout; nothing follows it.
        os.execv(
            "/bin/launchctl",
            ["launchctl", "bootout", f"gui/{os.getuid()}/{args.self_label}"],
        )
    return code


if __name__ == "__main__":
    raise SystemExit(main())
