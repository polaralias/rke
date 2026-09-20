from __future__ import annotations

import json
import os
import secrets
import tempfile
import time
from pathlib import Path
from typing import Any


class ConcurrentWriteError(ValueError):
    """Raised when a bounded durable-write lock cannot be acquired."""


class FileLock:
    """Cross-platform lock file with ownership-safe stale-lock recovery."""

    def __init__(
        self,
        path: Path,
        *,
        timeout: float = 10.0,
        malformed_grace: float = 1.0,
    ) -> None:
        self.path = path
        self.timeout = timeout
        self.malformed_grace = malformed_grace
        self._descriptor: int | None = None
        self._token: str | None = None

    @staticmethod
    def _process_alive(pid: int) -> bool:
        if pid <= 0:
            return False
        if pid == os.getpid():
            return True
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            handle = kernel32.OpenProcess(0x1000, False, pid)
            if handle:
                kernel32.CloseHandle(handle)
                return True
            return ctypes.get_last_error() != 87
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def _reclaim_stale_lock(self) -> bool:
        try:
            observed = self.path.stat()
            record = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
            try:
                observed = self.path.stat()
            except FileNotFoundError:
                return True
            record = None
        pid = record.get("pid") if isinstance(record, dict) else None
        created_at = record.get("createdAt") if isinstance(record, dict) else None
        token = record.get("token") if isinstance(record, dict) else None
        owner_pid = pid if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0 else None
        valid_owner = (
            owner_pid is not None
            and isinstance(created_at, (int, float))
            and not isinstance(created_at, bool)
            and isinstance(token, str)
            and bool(token)
        )
        if valid_owner:
            if owner_pid is not None and self._process_alive(owner_pid):
                return False
        elif time.time() - observed.st_mtime < self.malformed_grace:
            return False
        try:
            current = self.path.stat()
        except FileNotFoundError:
            return True
        identity = ("st_dev", "st_ino", "st_mtime_ns", "st_size")
        if any(getattr(current, field) != getattr(observed, field) for field in identity):
            return False
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        return True

    def __enter__(self) -> FileLock:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                descriptor = os.open(
                    self.path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
                try:
                    self._token = secrets.token_hex(16)
                    record = {
                        "pid": os.getpid(),
                        "createdAt": time.time(),
                        "token": self._token,
                    }
                    os.write(descriptor, (json.dumps(record) + "\n").encode("utf-8"))
                    os.fsync(descriptor)
                except Exception:
                    os.close(descriptor)
                    self._token = None
                    try:
                        self.path.unlink()
                    except FileNotFoundError:
                        pass
                    raise
                self._descriptor = descriptor
                return self
            except FileExistsError:
                if self._reclaim_stale_lock():
                    continue
                if time.monotonic() >= deadline:
                    raise ConcurrentWriteError(
                        f"Timed out waiting for durable-write lock: {self.path}"
                    ) from None
                time.sleep(0.025)

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if self._descriptor is not None:
            os.close(self._descriptor)
            self._descriptor = None
        try:
            record = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(record, dict) and record.get("token") == self._token:
                self.path.unlink()
        except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
            pass
        self._token = None


def sibling_lock(path: Path) -> Path:
    return path.with_name(f".{path.name}.lock")


def atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory_descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def atomic_write_text(path: Path, content: str) -> None:
    atomic_write_bytes(path, content.encode("utf-8"))


def atomic_write_json(path: Path, payload: Any, *, indent: int = 2) -> None:
    atomic_write_text(path, json.dumps(payload, indent=indent) + "\n")
