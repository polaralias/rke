from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from .documentation import DocumentationError
from .host_integration import HostIntegrationError
from .knowledge import KnowledgeError
from .okf_adapter import OkfAdapterError
from .operations import (
    OperationError,
    UnknownOperationError,
    invoke_operation,
    mcp_tools,
)
from .errors import ContextError


LEGACY_PROTOCOL_VERSION = "2025-11-25"
MODERN_PROTOCOL_VERSION = "2026-07-28"
SUPPORTED_PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION]
SERVER_INFO = {"name": "rke", "version": "0.3.0"}
SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo"
PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion"
CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities"
MAX_MESSAGE_BYTES = 4 * 1024 * 1024


def protocol_error(
    identifier: Any,
    code: int,
    message: str,
    *,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "jsonrpc": "2.0",
        "id": identifier,
        "error": {"code": code, "message": message},
    }
    if data is not None:
        payload["error"]["data"] = data
    return payload


def modern_result(payload: dict[str, Any], *, cacheable: bool = False) -> dict[str, Any]:
    result = dict(payload)
    result["resultType"] = "complete"
    result["_meta"] = {SERVER_INFO_KEY: SERVER_INFO}
    if cacheable:
        result["ttlMs"] = 0
        result["cacheScope"] = "private"
    return result


def tool_result(
    payload: dict[str, Any], *, is_error: bool = False, modern: bool = False
) -> dict[str, Any]:
    result = {
        "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
        "structuredContent": payload,
        "isError": is_error,
    }
    return modern_result(result) if modern else result


def modern_request_error(request: dict[str, Any]) -> dict[str, Any] | None:
    params = request.get("params")
    meta = params.get("_meta") if isinstance(params, dict) else None
    version = meta.get(PROTOCOL_VERSION_KEY) if isinstance(meta, dict) else None
    if request.get("method") == "server/discover" or version is not None:
        if version != MODERN_PROTOCOL_VERSION:
            return protocol_error(
                request.get("id"),
                -32022,
                "Unsupported protocol version",
                data={"supported": SUPPORTED_PROTOCOL_VERSIONS, "requested": version},
            )
        if not isinstance(meta.get(CLIENT_CAPABILITIES_KEY), dict):
            return protocol_error(
                request.get("id"),
                -32602,
                "Modern requests require client capabilities in params._meta.",
            )
    return None


def domain_error(
    identifier: Any,
    exc: (
        ContextError
        | KnowledgeError
        | DocumentationError
        | HostIntegrationError
        | OkfAdapterError
        | OperationError
    ),
    *,
    modern: bool,
) -> dict[str, Any]:
    payload = {"code": exc.code, "message": exc.message}
    return {
        "jsonrpc": "2.0",
        "id": identifier,
        "result": tool_result(payload, is_error=True, modern=modern),
    }


def resolve_repository(
    fixed_root: Path | None,
    raw_arguments: Any,
    allowed_roots: tuple[Path, ...],
) -> tuple[Path, dict[str, Any]]:
    if not isinstance(raw_arguments, dict):
        raise OperationError("Operation arguments must be an object.")
    arguments = dict(raw_arguments)
    requested = arguments.pop("repository", None)
    if fixed_root is not None:
        repository = fixed_root
        if requested is not None and Path(str(requested)).resolve() != repository:
            raise OperationError(
                "This compatibility server is fixed to a different repository.",
                code="repository_boundary_violation",
            )
    else:
        if not isinstance(requested, str) or not requested.strip():
            raise OperationError(
                "Argument 'repository' must identify a Git repository.",
                code="repository_required",
            )
        repository = Path(requested).expanduser().resolve()
    if not repository.is_dir():
        raise OperationError(
            f"Repository directory does not exist: {repository}",
            code="repository_missing",
        )
    if fixed_root is None:
        result = subprocess.run(
            ["git", "-C", str(repository), "rev-parse", "--show-toplevel"],
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            raise OperationError(
                f"Path is not inside a Git repository: {repository}",
                code="git_repository_required",
            )
        # Keep the OS-native resolved path supplied by the client. Git for Windows
        # may report an MSYS-mapped top-level path that is not directly addressable
        # by the Python process even though validation succeeded.
    if allowed_roots and not any(
        repository == boundary or repository.is_relative_to(boundary)
        for boundary in allowed_roots
    ):
        raise OperationError(
            f"Repository is outside the configured allowed roots: {repository}",
            code="repository_not_allowed",
        )
    return repository, arguments


def dispatch(
    root: Path | None,
    request: dict[str, Any],
    *,
    allowed_roots: tuple[Path, ...] = (),
) -> dict[str, Any] | None:
    identifier = request.get("id")
    if request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
        return protocol_error(identifier, -32600, "Invalid Request")
    if "id" not in request:
        return None
    method = request["method"]
    modern_error = modern_request_error(request)
    if modern_error is not None:
        return modern_error
    params = request.get("params")
    meta = params.get("_meta") if isinstance(params, dict) else None
    modern = isinstance(meta, dict) and meta.get(PROTOCOL_VERSION_KEY) == MODERN_PROTOCOL_VERSION
    if method == "server/discover":
        return {
            "jsonrpc": "2.0",
            "id": identifier,
            "result": modern_result(
                {
                    "supportedVersions": SUPPORTED_PROTOCOL_VERSIONS,
                    "capabilities": {"tools": {}},
                    "instructions": "Use shared engineering operations for bounded repository evidence and governed maintenance.",
                },
                cacheable=True,
            ),
        }
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": identifier,
            "result": {
                "protocolVersion": LEGACY_PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        }
    if method == "ping":
        return {
            "jsonrpc": "2.0",
            "id": identifier,
            "result": modern_result({}) if modern else {},
        }
    if method == "tools/list":
        listed = {"tools": mcp_tools(repository_required=root is None)}
        return {
            "jsonrpc": "2.0",
            "id": identifier,
            "result": modern_result(listed, cacheable=True) if modern else listed,
        }
    if method != "tools/call":
        return protocol_error(identifier, -32601, "Method not found")
    if not isinstance(params, dict) or not isinstance(params.get("name"), str):
        return protocol_error(identifier, -32602, "Invalid tools/call parameters")
    try:
        repository, arguments = resolve_repository(
            root, params.get("arguments", {}), allowed_roots
        )
        outcome = invoke_operation(repository, params["name"], arguments)
    except UnknownOperationError:
        return protocol_error(identifier, -32602, f"Unknown tool: {params['name']}")
    except (
        ContextError,
        KnowledgeError,
        DocumentationError,
        HostIntegrationError,
        OkfAdapterError,
        OperationError,
    ) as exc:
        return domain_error(identifier, exc, modern=modern)
    except Exception as exc:  # Keep one malformed request from terminating stdio.
        print(
            f"rke-mcp internal tool failure: {type(exc).__name__}",
            file=sys.stderr,
            flush=True,
        )
        payload = {
            "code": "internal_operation_error",
            "message": "The operation failed unexpectedly; the MCP server remains available.",
        }
        return {
            "jsonrpc": "2.0",
            "id": identifier,
            "result": tool_result(payload, is_error=True, modern=modern),
        }
    return {
        "jsonrpc": "2.0",
        "id": identifier,
        "result": tool_result(
            outcome.payload,
            is_error=outcome.exit_code != 0,
            modern=modern,
        ),
    }


def run(root: Path | None = None, *, allowed_roots: tuple[Path, ...] = ()) -> int:
    for raw_line in sys.stdin.buffer:
        if len(raw_line) > MAX_MESSAGE_BYTES:
            response = protocol_error(None, -32600, "Message exceeds maximum size")
        else:
            try:
                request = json.loads(raw_line.decode("utf-8"))
                response = (
                    dispatch(root, request, allowed_roots=allowed_roots)
                    if isinstance(request, dict)
                    else protocol_error(None, -32600, "Invalid Request")
                )
            except (UnicodeDecodeError, json.JSONDecodeError):
                response = protocol_error(None, -32700, "Parse error")
        if response is not None:
            sys.stdout.write(
                json.dumps(response, separators=(",", ":"), ensure_ascii=False) + "\n"
            )
            sys.stdout.flush()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Expose RKE operations over one multi-repository MCP stdio server."
    )
    parser.add_argument(
        "--root",
        type=Path,
        help="Compatibility mode: fix this server process to one repository.",
    )
    parser.add_argument(
        "--allow-root",
        type=Path,
        action="append",
        default=[],
        help="Optional directory boundary for repositories accepted by tool calls.",
    )
    args = parser.parse_args()
    root = args.root.resolve() if args.root else None
    allowed_roots = tuple(path.resolve() for path in args.allow_root)
    return run(root, allowed_roots=allowed_roots)


if __name__ == "__main__":
    raise SystemExit(main())
