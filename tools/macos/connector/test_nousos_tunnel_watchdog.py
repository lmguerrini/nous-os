#!/usr/bin/env python3
"""Tests for the on-demand NousOS tunnel watchdog and gate session metadata."""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

import nousos_tunnel_gate
import nousos_tunnel_watchdog as watchdog


def response(
    when: float,
    *,
    session: str = "s-test",
    method: str = "tools/call",
    decision: str = "forward",
    event: str = "response",
) -> dict:
    return {
        "ts": watchdog.utc_text(when),
        "session": session,
        "event": event,
        "method": method,
        "decision": decision,
    }


class DecisionTests(unittest.TestCase):
    def test_presence_away_stops_only_when_hid_and_tool_idle_exceed_window(self) -> None:
        result = watchdog.decide_presence([], "s-test", 100, 161, 60, 600,
                                         hid_idle_reader=lambda: 61)
        self.assertEqual(result[:2], ("stop", "away"))

    def test_presence_present_user_keeps_running(self) -> None:
        result = watchdog.decide_presence([], "s-test", 100, 161, 60, 600,
                                         hid_idle_reader=lambda: 60)
        self.assertEqual(result[0], "run")

    def test_presence_unknown_hid_falls_back_to_idle_window(self) -> None:
        result = watchdog.decide_presence([], "s-test", 100, 161, 60, 600,
                                         hid_idle_reader=lambda: None)
        self.assertEqual(result[:2], ("stop", "idle"))

    def test_presence_max_wins(self) -> None:
        result = watchdog.decide_presence([], "s-test", 100, 700, 60, 600,
                                         hid_idle_reader=lambda: 1)
        self.assertEqual(result[:2], ("stop", "max"))

    def test_presence_recent_real_response_keeps_tunnel(self) -> None:
        result = watchdog.decide_presence([response(150)], "s-test", 100,
                                         161, 60, 600,
                                         hid_idle_reader=lambda: 90)
        self.assertEqual(result[0], "run")

    def test_presence_boundary_hid_equal_to_window_is_present(self) -> None:
        result = watchdog.decide_presence([], "s-test", 100, 160, 60, 600,
                                         hid_idle_reader=lambda: 60)
        self.assertEqual(result[0], "run")

    def test_presence_boundary_tool_idle_equal_to_window_stops_if_away(self) -> None:
        result = watchdog.decide_presence([], "s-test", 100, 160, 60, 600,
                                         hid_idle_reader=lambda: 61)
        self.assertEqual(result[:2], ("stop", "away"))

    def test_presence_clock_jump_back_does_not_stop(self) -> None:
        result = watchdog.decide_presence([], "s-test", 100, 90, 60, 600,
                                         hid_idle_reader=lambda: 100)
        self.assertEqual(result[0], "run")

    def test_presence_clock_jump_past_max_stops(self) -> None:
        result = watchdog.decide_presence([], "s-test", 100, 1000, 60, 600,
                                         hid_idle_reader=lambda: 0)
        self.assertEqual(result[:2], ("stop", "max"))


class HidReaderTests(unittest.TestCase):
    @mock.patch.object(watchdog.subprocess, "run")
    def test_parses_normal_value(self, run) -> None:
        run.return_value = mock.Mock(returncode=0, stdout='"HIDIdleTime" = 1234567890')
        self.assertEqual(watchdog.read_hid_idle_seconds(), 1.23456789)

    @mock.patch.object(watchdog.subprocess, "run")
    def test_missing_or_malformed_value_returns_none(self, run) -> None:
        for output in ("no property", '"HIDIdleTime" = nope', '"HIDIdleTime" = 12junk'):
            run.return_value = mock.Mock(returncode=0, stdout=output)
            with self.subTest(output=output):
                self.assertIsNone(watchdog.read_hid_idle_seconds())

    @mock.patch.object(watchdog.subprocess, "run")
    def test_nonzero_exit_returns_none(self, run) -> None:
        run.return_value = mock.Mock(returncode=1, stdout='"HIDIdleTime" = 10')
        self.assertIsNone(watchdog.read_hid_idle_seconds())

    @mock.patch.object(watchdog.subprocess, "run", side_effect=subprocess.TimeoutExpired("ioreg", 5))
    def test_timeout_returns_none(self, run) -> None:
        self.assertIsNone(watchdog.read_hid_idle_seconds())

    @mock.patch.object(watchdog.subprocess, "run")
    def test_multiple_matches_use_first_value(self, run) -> None:
        run.return_value = mock.Mock(
            returncode=0,
            stdout='"HIDIdleTime" = 2000000000\n"HIDIdleTime" = 9000000000',
        )
        self.assertEqual(watchdog.read_hid_idle_seconds(), 2.0)

    @mock.patch.object(watchdog.subprocess, "run")
    def test_real_tree_prefixed_line(self, run) -> None:
        run.return_value = mock.Mock(
            returncode=0, stdout='| |     "HIDIdleTime" = 377032500\n'
        )
        self.assertEqual(watchdog.read_hid_idle_seconds(), 0.3770325)

    @mock.patch.object(watchdog.subprocess, "run")
    def test_real_multiline_ioreg_excerpt(self, run) -> None:
        run.return_value = mock.Mock(
            returncode=0,
            stdout=(
                '+-o IOHIDSystem  <class IOHIDSystem, id 0x1, registered, matched, active, busy 0 (1 ms), retain 7>\n'
                '  | {\n'
                '  |   "IOHIDParameters" = {\n'
                '  |     "HIDIdleTime" = 377032500\n'
                '  |     "HIDKeyboardModifierMappingPairs" = (\n'
                '  |       {"HIDKeyboardModifierMappingSrc"=0, "HIDKeyboardModifierMappingDst"=0}\n'
                '  |     )\n'
                '  |   }\n'
                '  | }\n'
            ),
        )
        self.assertEqual(watchdog.read_hid_idle_seconds(), 0.3770325)

    def test_no_activity_stops_at_exact_idle_limit(self) -> None:
        self.assertEqual(watchdog.decide([], "s-test", 100, 119, 20, 120)[0], "run")
        self.assertEqual(
            watchdog.decide([], "s-test", 100, 120, 20, 120)[:2],
            ("stop", "idle"),
        )

    def test_qualifying_responses_reset_idle(self) -> None:
        for decision in (
            "forward", "capped", "child_error", "UNEXPECTED_WRITE_SUCCESS"
        ):
            with self.subTest(decision=decision):
                result = watchdog.decide(
                    [response(115, decision=decision)], "s-test",
                    100, 120, 20, 120,
                )
                self.assertEqual(result[0], "run")
                self.assertEqual(result[-1], 115)
                self.assertEqual(result[1], 15)

    def test_non_activity_does_not_reset(self) -> None:
        cases = [
            response(115, method="initialize"),
            response(115, method="tools/list"),
            response(115, method="ping"),
            response(115, decision="refuse_not_exposed"),
            response(115, event="request"),
            response(115, session="another-session"),
            response(99),
        ]
        for record in cases:
            with self.subTest(record=record):
                result = watchdog.decide(
                    [record], "s-test", 100, 120, 20, 120
                )
                self.assertEqual(result[:2], ("stop", "idle"))
                self.assertEqual(result[-1], 100)

    def test_max_wins_with_fresh_activity(self) -> None:
        result = watchdog.decide(
            [response(219)], "s-test", 100, 220, 20, 120
        )
        self.assertEqual(result[:2], ("stop", "max"))

    def test_max_only_disables_idle(self) -> None:
        self.assertEqual(
            watchdog.decide([], "s-test", 100, 150, 0, 120)[0], "run"
        )

    def test_invalid_and_partial_lines_and_both_utc_days(self) -> None:
        boundary = dt.datetime(
            2026, 9, 26, 0, 0, 1, tzinfo=dt.timezone.utc
        ).timestamp()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            yesterday = root / "gate-20260925.ndjson"
            today = root / "gate-20260926.ndjson"
            yesterday.write_bytes(
                json.dumps(response(boundary - 2)).encode() + b"\n"
                + b"{invalid}\n"
                + b'{"session":"s-test"'
            )
            today.write_bytes(
                json.dumps(response(boundary)).encode() + b"\n"
            )
            records = watchdog.read_records(root, boundary + 1)
            self.assertEqual(len(records), 2)
            self.assertEqual(
                watchdog.latest_real_request(
                    records, "s-test", boundary - 10
                ),
                boundary,
            )

    def test_unreadable_log_discards_activity(self) -> None:
        now = time.time()
        day = dt.datetime.fromtimestamp(now, dt.timezone.utc)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            # Yesterday's file is readable and holds a qualifying response; today's
            # file cannot be read (a directory). Fail safe: ALL activity is
            # discarded, so the idle timer runs from the session start.
            yesterday = day - dt.timedelta(days=1)
            record = {"ts": yesterday.isoformat().replace("+00:00", "Z"), "session": "s-test",
                      "event": "response", "method": "tools/call", "decision": "forward"}
            (root / f"gate-{yesterday:%Y%m%d}.ndjson").write_text(json.dumps(record) + "\n", encoding="utf-8")
            (root / f"gate-{day:%Y%m%d}.ndjson").mkdir()
            self.assertEqual(watchdog.read_records(root, now), [])

    def test_once_evaluates_only_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            args = Namespace(
                session="s-test",
                start_epoch=time.time(),
                idle_seconds=2,
                max_seconds=6,
                log_dir=Path(temporary),
                stop_command=Path("/unused"),
                interval=30,
                once=True,
            )
            started = time.monotonic()
            self.assertEqual(
                watchdog.run_loop(args, is_loaded=lambda: True), 0
            )
            self.assertLess(time.monotonic() - started, 1)


class LoopTests(unittest.TestCase):
    def test_real_response_resets_two_second_idle_timer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stop_record = root / "stop-called.txt"
            fake_stop = root / "fake-stop.zsh"
            fake_stop.write_text(
                '#!/bin/zsh\nprintf "%s\\n" "$*" >> "$FAKE_STOP_RECORD"\n',
                encoding="utf-8",
            )
            start = time.time()
            args = Namespace(
                session="s-test",
                start_epoch=start,
                idle_seconds=2,
                max_seconds=6,
                log_dir=root,
                stop_command=fake_stop,
                interval=0.05,
                once=False,
            )

            def add_request() -> None:
                time.sleep(1)
                moment = time.time()
                day = dt.datetime.fromtimestamp(
                    moment, dt.timezone.utc
                )
                path = root / f"gate-{day:%Y%m%d}.ndjson"
                with path.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(response(moment)) + "\n")

            writer = threading.Thread(target=add_request)
            writer.start()
            with mock.patch.dict(
                os.environ, {"FAKE_STOP_RECORD": str(stop_record)}
            ):
                begun = time.monotonic()
                self.assertEqual(
                    watchdog.run_loop(args, is_loaded=lambda: True), 0
                )
                elapsed = time.monotonic() - begun
            writer.join(timeout=1)

            self.assertGreaterEqual(elapsed, 2.8)
            self.assertLess(elapsed, 5.8)
            self.assertEqual(
                stop_record.read_text(encoding="utf-8").splitlines(),
                ["stop --from-watchdog --reason idle"],
            )
            entries = [
                json.loads(line)
                for line in (root / "watchdog.log")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["reason"], "idle")
            self.assertEqual(entries[0]["session"], "s-test")


class GateSessionTests(unittest.TestCase):
    def test_valid_session_is_logged_and_invalid_session_is_null(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            environment = {
                "NOUSOS_TUNNEL_LOG_DIR": temporary,
                "NOUSOS_TUNNEL_SESSION": "s20260925-1a2b",
            }
            with mock.patch.dict(os.environ, environment):
                logger = nousos_tunnel_gate.MetadataLog()
                # Read once at start: a later change (here also to an invalid
                # value, with a space and "!") must not affect this logger.
                os.environ["NOUSOS_TUNNEL_SESSION"] = "changed after start!"
                logger.write(event="request", method="ping", decision="ping")
                invalid = nousos_tunnel_gate.MetadataLog()
                invalid.write(event="request", method="ping", decision="ping")

            paths = list(Path(temporary).glob("gate-*.ndjson"))
            self.assertEqual(len(paths), 1)
            records = [
                json.loads(line)
                for line in paths[0].read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(records[0]["session"], "s20260925-1a2b")
            self.assertIsNone(records[1]["session"])


if __name__ == "__main__":
    unittest.main()
