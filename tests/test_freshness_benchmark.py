from __future__ import annotations

import unittest

from rke.freshness_benchmark import run_freshness_performance_benchmark


class FreshnessPerformanceBenchmarkTests(unittest.TestCase):
    def test_small_benchmark_exercises_warm_and_one_changed_paths(self) -> None:
        payload = run_freshness_performance_benchmark((20,))

        self.assertEqual(payload["result"], "freshness-performance-benchmarked")
        trial = payload["trials"][0]
        self.assertEqual(trial["fileCount"], 20)
        self.assertFalse(trial["warmRefreshed"])
        self.assertEqual(trial["warmReusedFiles"], 20)
        self.assertTrue(trial["changedRefreshed"])
        self.assertEqual(trial["changedFilesRefreshed"], 1)
        self.assertEqual(trial["changedHashedFiles"], 1)
        self.assertEqual(trial["changedTopPath"], "src/bucket-000/component-000000.txt")


if __name__ == "__main__":
    unittest.main()
