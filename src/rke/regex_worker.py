from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from .paths import repository_relative_path
from .security import redact_secrets


MAX_MATCHES = 10_000


def main() -> int:
    request = json.load(sys.stdin)
    root = Path(request["root"]).resolve()
    expression = re.compile(request["pattern"])
    matches: list[dict[str, object]] = []
    count = 0
    for value in request["paths"]:
        target, relative = repository_relative_path(
            root,
            value,
            escape_code="structure_path_escape",
            missing_code="structure_path_missing",
        )
        try:
            text = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not expression.search(line):
                continue
            count += 1
            if len(matches) < MAX_MATCHES:
                safe_line, redactions = redact_secrets(line.strip())
                matches.append(
                    {
                        "path": relative,
                        "line": line_number,
                        "snippet": safe_line[:300],
                        "redactions": redactions,
                    }
                )
    print(
        json.dumps(
            {
                "matchCount": count,
                "matches": matches,
                "workerTruncated": count > len(matches),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
