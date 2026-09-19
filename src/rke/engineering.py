"""Compatibility import for the historical CLI module path."""

from .cli import build_parser, main

__all__ = ["build_parser", "main"]


if __name__ == "__main__":
    raise SystemExit(main())
