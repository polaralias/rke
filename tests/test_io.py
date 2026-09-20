from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
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

    def test_old_live_owner_is_never_reclaimed_by_age(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "resource.lock"
            path.write_text(
                json.dumps(
                    {"pid": os.getpid(), "createdAt": time.time() - 10, "token": "expired"}
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ConcurrentWriteError, "Timed out"):
                with FileLock(path, timeout=0.03, malformed_grace=0):
                    pass
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["token"], "expired")

    def test_malformed_lock_is_reclaimed_after_a_short_grace(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "resource.lock"
            path.write_text("{", encoding="utf-8")
            old = time.time() - 10
            os.utime(path, (old, old))

            with FileLock(path, timeout=0.1, malformed_grace=0.01):
                record = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(record["pid"], os.getpid())

    def test_fresh_malformed_lock_is_not_reclaimed_during_its_grace(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "resource.lock"
            path.write_text("", encoding="utf-8")

            with self.assertRaisesRegex(ConcurrentWriteError, "Timed out"):
                with FileLock(path, timeout=0.03, malformed_grace=60):
                    pass
            self.assertTrue(path.exists())

    def test_paused_creator_cannot_publish_over_an_existing_owner(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "resource.lock"
            original_link = os.link
            creator_ready = threading.Event()
            release_publish = threading.Event()
            creator_entered = threading.Event()
            release_creator = threading.Event()
            delayed = False
            errors: list[BaseException] = []

            def controlled_link(source: str, target: str) -> None:
                nonlocal delayed
                if threading.current_thread().name == "paused-lock-creator" and not delayed:
                    delayed = True
                    creator_ready.set()
                    if not release_publish.wait(2):
                        raise TimeoutError("test did not release the paused lock publication")
                original_link(source, target)

            def acquire_as_creator() -> None:
                try:
                    with FileLock(path, timeout=2):
                        creator_entered.set()
                        release_creator.wait(2)
                except BaseException as exc:  # Preserve background failures for the assertion.
                    errors.append(exc)

            with patch("rke.io.os.link", side_effect=controlled_link):
                creator = threading.Thread(
                    target=acquire_as_creator,
                    name="paused-lock-creator",
                )
                creator.start()
                self.assertTrue(creator_ready.wait(1))
                self.assertFalse(path.exists())

                with FileLock(path, timeout=1):
                    release_publish.set()
                    time.sleep(0.05)
                    self.assertFalse(creator_entered.is_set())

                self.assertTrue(creator_entered.wait(1))
                release_creator.set()
                creator.join(1)

            self.assertFalse(creator.is_alive())
            self.assertEqual(errors, [])
            self.assertFalse(path.exists())
            self.assertEqual(list(path.parent.glob(".resource.lock.candidate-*")), [])

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
                with FileLock(path, timeout=0.03, malformed_grace=0):
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
