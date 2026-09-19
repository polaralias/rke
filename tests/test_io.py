from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from rke.io import ConcurrentWriteError, FileLock, atomic_write_text


class DurableIoTests(unittest.TestCase):
    def test_lock_records_owner_and_creation_time(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "resource.lock"
            with FileLock(path):
                record = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(record["pid"], os.getpid())
                self.assertLessEqual(record["createdAt"], time.time())
                self.assertRegex(record["token"], r"^[a-f0-9]{32}$")
            self.assertFalse(path.exists())

    def test_lock_reclaims_a_demonstrably_dead_owner(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "resource.lock"
            path.write_text(
                json.dumps({"pid": 123456789, "createdAt": time.time(), "token": "abandoned"}),
                encoding="utf-8",
            )
            with patch.object(FileLock, "_process_alive", return_value=False):
                with FileLock(path, timeout=0.1):
                    record = json.loads(path.read_text(encoding="utf-8"))
                    self.assertNotEqual(record["token"], "abandoned")

    def test_lock_recovers_after_a_hard_process_exit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "resource.lock"
            child = (
                "import os, sys; "
                "from pathlib import Path; "
                "from rke.io import FileLock; "
                "lock = FileLock(Path(sys.argv[1])); "
                "lock.__enter__(); "
                "os._exit(0)"
            )
            subprocess.run([sys.executable, "-c", child, str(path)], check=True)
            self.assertTrue(path.exists())

            with FileLock(path, timeout=1):
                record = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(record["pid"], os.getpid())

    def test_lock_reclaims_an_expired_live_owner(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "resource.lock"
            path.write_text(
                json.dumps(
                    {"pid": os.getpid(), "createdAt": time.time() - 10, "token": "expired"}
                ),
                encoding="utf-8",
            )
            with FileLock(path, timeout=0.1, stale_after=1):
                record = json.loads(path.read_text(encoding="utf-8"))
                self.assertNotEqual(record["token"], "expired")

    def test_fresh_live_lock_is_not_reclaimed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "resource.lock"
            path.write_text(
                json.dumps(
                    {"pid": os.getpid(), "createdAt": time.time(), "token": "active"}
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ConcurrentWriteError, "Timed out"):
                with FileLock(path, timeout=0.03, stale_after=60):
                    pass
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["token"], "active")

    def test_previous_owner_does_not_remove_a_replacement_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "resource.lock"
            owner = FileLock(path)
            owner.__enter__()
            path.write_text(
                json.dumps(
                    {"pid": os.getpid(), "createdAt": time.time(), "token": "replacement"}
                ),
                encoding="utf-8",
            )
            owner.__exit__(None, None, None)
            self.assertTrue(path.exists())
            self.assertEqual(
                json.loads(path.read_text(encoding="utf-8"))["token"], "replacement"
            )

    def test_failed_replace_preserves_complete_previous_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "state.json"
            target.write_text("old-complete\n", encoding="utf-8")

            with patch("rke.io.os.replace", side_effect=OSError("interrupted")):
                with self.assertRaisesRegex(OSError, "interrupted"):
                    atomic_write_text(target, "new-complete\n")

            self.assertEqual(target.read_text(encoding="utf-8"), "old-complete\n")
            self.assertEqual(list(target.parent.glob(".state.json.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
