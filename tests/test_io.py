from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rke.io import atomic_write_text


class DurableIoTests(unittest.TestCase):
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
