from __future__ import annotations


MAX_CHUNK_CHARACTERS = 6_000
MAX_CHUNK_LINES = 120
CHUNK_OVERLAP_LINES = 8
Chunk = tuple[int, int, int, int, str | None, str]


def _utf8_segments(line: str, maximum: int) -> list[tuple[int, int, str]]:
    segments: list[tuple[int, int, str]] = []
    start = 0
    while start < len(line):
        end = start
        size = 0
        while end < len(line):
            width = len(line[end].encode("utf-8"))
            if size and size + width > maximum:
                break
            size += width
            end += 1
        segments.append((start + 1, end + 1, line[start:end]))
        start = end
    return segments or [(1, 1, "")]


def bounded_line_chunks(
    lines: list[str], start: int, end: int, label: str | None
) -> list[Chunk]:
    chunks: list[Chunk] = []
    cursor = max(1, start)
    final = min(len(lines), max(cursor, end))
    while cursor <= final:
        current_line = lines[cursor - 1]
        if len(current_line.encode("utf-8")) > MAX_CHUNK_CHARACTERS:
            for start_column, end_column, content in _utf8_segments(
                current_line, MAX_CHUNK_CHARACTERS
            ):
                chunks.append(
                    (cursor, cursor, start_column, end_column, label, content)
                )
            cursor += 1
            continue
        chunk_end = cursor - 1
        encoded_bytes = 0
        while chunk_end < final and chunk_end - cursor + 1 < MAX_CHUNK_LINES:
            next_line = lines[chunk_end]
            next_size = len(next_line.encode("utf-8")) + 1
            if next_size > MAX_CHUNK_CHARACTERS:
                break
            if (
                chunk_end >= cursor
                and encoded_bytes + next_size > MAX_CHUNK_CHARACTERS
            ):
                break
            encoded_bytes += next_size
            chunk_end += 1
        if chunk_end < cursor:
            continue
        content = "\n".join(lines[cursor - 1 : chunk_end])
        end_column = len(lines[chunk_end - 1]) + 1
        chunks.append((cursor, chunk_end, 1, end_column, label, content))
        if chunk_end >= final:
            break
        cursor = max(cursor + 1, chunk_end - CHUNK_OVERLAP_LINES + 1)
    return chunks
