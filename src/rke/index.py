from __future__ import annotations

import re
from collections import Counter
from typing import Any


SEARCH_FIELDS = ("path", "filename", "symbol", "heading", "body")
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9]+")
IDENTIFIER_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
TOKEN_ALIASES = {
    "configuration": "config",
    "configurations": "config",
    "credentials": "credential",
    "providers": "provider",
}


def tokenize(value: str) -> list[str]:
    expanded = IDENTIFIER_BOUNDARY.sub(" ", value.replace("_", " ").replace("-", " "))
    tokens = [match.group(0).lower() for match in TOKEN_PATTERN.finditer(expanded)]
    return [TOKEN_ALIASES.get(token, token) for token in tokens]


def build_search_index(documents: list[dict[str, Any]]) -> dict[str, Any]:
    postings: dict[str, list[list[Any]]] = {}
    totals = {field: 0 for field in SEARCH_FIELDS}
    document_frequencies: Counter[str] = Counter()
    for document_id, document in enumerate(documents):
        document["documentId"] = document_id
        fields = document.get("fields", {})
        seen_terms: set[str] = set()
        per_term: dict[str, list[int]] = {}
        for field_index, field in enumerate(SEARCH_FIELDS):
            tokens = fields.get(field, [])
            totals[field] += len(tokens)
            for term, count in Counter(tokens).items():
                per_term.setdefault(term, [0] * len(SEARCH_FIELDS))[field_index] = count
                seen_terms.add(term)
        for term in seen_terms:
            document_frequencies[term] += 1
        for term, counts in per_term.items():
            postings.setdefault(term, []).append([document_id, *counts])
    count = max(1, len(documents))
    return {
        "documentCount": len(documents),
        "averageFieldLengths": {
            field: totals[field] / count for field in SEARCH_FIELDS
        },
        "documentFrequencies": dict(document_frequencies),
        "postings": postings,
    }
