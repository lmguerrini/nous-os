#!/usr/bin/env python3
"""Tests for all presence keeper tick decisions."""

from __future__ import annotations

import unittest

import nousos_tunnel_presence as presence


class KeeperTickTests(unittest.TestCase):
    def test_tick_start_and_all_skip_conditions(self) -> None:
        cases = [
            (False, True, 119.9, False, True),
            (True, True, 10, False, False),       # session already running
            (False, False, 10, False, False),    # setup incomplete
            (False, True, 120, False, False),    # away threshold is strict
            (False, True, None, False, False),  # unknown idle is not present
            (False, True, 10, True, False),      # manual stop marker
        ]
        for running, setup, idle, manual, expected in cases:
            with self.subTest(running=running, setup=setup, idle=idle, manual=manual):
                self.assertEqual(
                    presence.should_start(
                        session_running=running,
                        setup_complete=setup,
                        user_idle_seconds=idle,
                        manual_stop=manual,
                    ), expected,
                )


if __name__ == "__main__":
    unittest.main()
