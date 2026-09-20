from __future__ import annotations

import argparse
import json

from rke.freshness_benchmark import DEFAULT_FILE_COUNTS, run_freshness_performance_benchmark


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Measure correctness-first retrieval freshness at increasing repository sizes."
    )
    parser.add_argument(
        "--sizes",
        nargs="+",
        type=int,
        default=list(DEFAULT_FILE_COUNTS),
        metavar="COUNT",
        help="Tracked file counts to benchmark (default: 1000 10000 50000).",
    )
    args = parser.parse_args()
    payload = run_freshness_performance_benchmark(tuple(args.sizes))
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
