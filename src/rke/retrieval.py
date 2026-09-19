from __future__ import annotations

import math
from typing import Any

from .index import SEARCH_FIELDS, tokenize


FIELD_WEIGHTS = {
    "path": 2.4,
    "filename": 3.2,
    "symbol": 4.0,
    "heading": 2.4,
    "body": 1.0,
}
FIELD_LENGTH_NORMALIZATION = {
    "path": 0.2,
    "filename": 0.1,
    "symbol": 0.2,
    "heading": 0.3,
    "body": 0.75,
}


def bm25f_scores(
    index: dict[str, Any], query: str, allowed_document_ids: set[int]
) -> dict[int, float]:
    search = index["search"]
    document_count = max(1, int(search["documentCount"]))
    averages = search["averageFieldLengths"]
    scores: dict[int, float] = {}
    k1 = 1.2
    for term in dict.fromkeys(tokenize(query)):
        document_frequency = int(search["documentFrequencies"].get(term, 0))
        if not document_frequency:
            continue
        inverse_frequency = math.log(
            1
            + (document_count - document_frequency + 0.5)
            / (document_frequency + 0.5)
        )
        for posting in search["postings"].get(term, []):
            document_id = int(posting[0])
            if document_id not in allowed_document_ids:
                continue
            document = index["documents"][document_id]
            weighted_frequency = 0.0
            for field_index, field in enumerate(SEARCH_FIELDS, start=1):
                frequency = int(posting[field_index])
                if not frequency:
                    continue
                length = len(document["fields"].get(field, []))
                average = float(averages.get(field) or 1.0)
                b = FIELD_LENGTH_NORMALIZATION[field]
                weighted_frequency += FIELD_WEIGHTS[field] * frequency / (
                    1 - b + b * length / average
                )
            if weighted_frequency:
                scores[document_id] = scores.get(document_id, 0.0) + inverse_frequency * (
                    weighted_frequency * (k1 + 1) / (weighted_frequency + k1)
                )
    return scores


def matched_excerpt(
    document: dict[str, Any], query: str, maximum: int = 2_000
) -> str:
    snippet = document["snippet"]
    if len(snippet) <= maximum:
        return snippet
    lowered = snippet.lower()
    offsets = [lowered.find(term) for term in tokenize(query)]
    offsets = [offset for offset in offsets if offset >= 0]
    anchor = min(offsets) if offsets else 0
    start = max(0, anchor - maximum // 3)
    end = min(len(snippet), start + maximum)
    start = max(0, end - maximum)
    prefix = "…" if start else ""
    suffix = "…" if end < len(snippet) else ""
    return prefix + snippet[start:end] + suffix


def ranked_result(
    document: dict[str, Any], query: str, score: float
) -> dict[str, Any]:
    query_terms = set(tokenize(query))
    fields = document.get("fields", {})
    reasons = ["term-match", "bm25f"]
    if query_terms.intersection(fields.get("path", [])):
        reasons.append("path-match")
    normalized_query = "".join(tokenize(query))
    normalized_symbol = "".join(fields.get("symbol", []))
    normalized_heading = "".join(fields.get("heading", []))
    normalized_filename = "".join(fields.get("filename", []))
    if normalized_query and normalized_query in {normalized_symbol, normalized_filename}:
        score *= 1.8
        reasons.append("exact-identifier")
    elif normalized_query and normalized_query == normalized_heading:
        score *= 1.5
        reasons.append("exact-heading")
    if document.get("knowledgeAuthority") == "canonical":
        score *= 1.45
        reasons.append("canonical-knowledge")
    if document.get("navigationRole") in {"entry-point", "foundational"}:
        score *= 1.2
        reasons.append("foundational-knowledge")
    return {
        "documentId": document["documentId"],
        "path": document["path"],
        "startLine": document["startLine"],
        "endLine": document["endLine"],
        "kind": document["kind"],
        "symbol": document["symbol"],
        "score": score,
        "reasons": reasons,
        "snippet": matched_excerpt(document, query),
    }


def diversify_results(
    ranked: list[dict[str, Any]], limit: int
) -> list[dict[str, Any]]:
    ranked.sort(key=lambda item: (-item["score"], item["path"], item["startLine"]))
    selected: list[dict[str, Any]] = []
    deferred: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    for item in ranked:
        if item["path"] in seen_paths:
            deferred.append(item)
        else:
            selected.append(item)
            seen_paths.add(item["path"])
        if len(selected) == limit:
            break
    if len(selected) < limit:
        selected.extend(deferred[: limit - len(selected)])
    for item in selected:
        item["score"] = round(item["score"], 6)
        item.pop("documentId", None)
    return selected
