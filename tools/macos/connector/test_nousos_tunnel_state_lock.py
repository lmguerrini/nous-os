#!/usr/bin/env python3
"""State token and start-lock contract tests."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import nousos_tunnel_lock
import nousos_tunnel_state


ROOT = Path(__file__).resolve().parent


class WatchdogStateTests(unittest.TestCase):
    def test_writer_and_reader_round_trip_both_mode_tokens(self) -> None:
        for presence, mode in (("yes", "presence"), ("no", "idle")):
            with self.subTest(presence=presence), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / "watchdog.state"
                self.assertEqual(nousos_tunnel_state.main([
                    "write", str(path), "s-test", "100", "60", "600",
                    presence, "60",
                ]), 0)
                self.assertEqual(path.read_text(encoding="utf-8").splitlines()[4], mode)
                self.assertEqual(
                    nousos_tunnel_state.read_state(path),
                    ("s-test", "100", "60", "600", mode, "60"),
                )


class StartLockTests(unittest.TestCase):
    def test_second_start_lock_attempt_fails_without_touching_session_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            lock_path = root / "start.lock"
            state_path = root / "watchdog.state"
            state_path.write_text("winner-state", encoding="utf-8")
            descriptor = nousos_tunnel_lock.acquire(lock_path)
            self.assertGreaterEqual(descriptor, 0)
            try:
                result = subprocess.run(
                    [sys.executable, str(ROOT / "nousos_tunnel_lock.py"),
                     "acquire", str(lock_path), sys.executable, "-c",
                     f"from pathlib import Path; Path({str(state_path)!r}).write_text('loser')"],
                    capture_output=True, text=True, check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("already in progress", result.stderr)
                self.assertEqual(state_path.read_text(encoding="utf-8"), "winner-state")
            finally:
                os.close(descriptor)


if __name__ == "__main__":
    unittest.main()
