from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
STATE_DIRECTORY = ".engineering-workflow"
STATE_FILENAME = "state.json"
PHASES = ("understand", "design", "deliver", "close", "pause", "resume")
TASK_MODES = ("none", "lightweight", "full")


@dataclass(frozen=True)
class ValidatedState:
    path: Path
    value: dict[str, Any]
    errors: list[str]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def state_path(root: Path) -> Path:
    return root / STATE_DIRECTORY / STATE_FILENAME


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _string_list(value: Any, label: str, errors: list[str]) -> None:
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item.strip() for item in value
    ):
        errors.append(f"{label} must be a list of non-empty strings")
    elif len(value) != len(set(value)):
        errors.append(f"{label} must not contain duplicates")


def validate_state(state: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(state, dict):
        return ["workflow state must be an object"]
    if state.get("schema_version") != SCHEMA_VERSION:
        errors.append("unsupported schema_version")
    status = state.get("status")
    if status not in {"active", "closed"}:
        errors.append("status must be active or closed")
    if state.get("primary_phase") not in PHASES:
        errors.append("primary_phase is not recognised")
    _string_list(state.get("active_capabilities"), "active_capabilities", errors)
    _string_list(state.get("outstanding_gates"), "outstanding_gates", errors)

    task_tracking = state.get("task_tracking")
    if not isinstance(task_tracking, dict):
        errors.append("task_tracking must be an object")
    else:
        if task_tracking.get("mode") not in TASK_MODES:
            errors.append("task_tracking.mode is not recognised")
        task_ref = task_tracking.get("task_ref")
        if task_ref is not None and (
            not isinstance(task_ref, str) or not task_ref.strip()
        ):
            errors.append("task_tracking.task_ref must be null or a non-empty string")
        bundle = task_tracking.get("bundle")
        if bundle is not None and (not isinstance(bundle, str) or not bundle.strip()):
            errors.append("task_tracking.bundle must be a non-empty string when present")

    continuity = state.get("continuity")
    if not isinstance(continuity, dict):
        errors.append("continuity must be an object")
    else:
        checkpoint = continuity.get("checkpoint")
        if checkpoint is not None:
            if not isinstance(checkpoint, dict):
                errors.append("continuity.checkpoint must be null or an object")
            else:
                if not _valid_timestamp(checkpoint.get("at")):
                    errors.append("continuity.checkpoint.at must be an ISO-8601 timestamp")
                for field in ("summary", "next_action"):
                    if not isinstance(checkpoint.get(field), str) or not checkpoint[field].strip():
                        errors.append(
                            f"continuity.checkpoint.{field} must be a non-empty string"
                        )
        previous = continuity.get("previous_cycle")
        if previous is not None and not isinstance(previous, dict):
            errors.append("continuity.previous_cycle must be an object when present")

    for field in ("created_at", "updated_at"):
        if not _valid_timestamp(state.get(field)):
            errors.append(f"{field} must be an ISO-8601 timestamp")
    if status == "closed" and not _valid_timestamp(state.get("closed_at")):
        errors.append("closed_at must be an ISO-8601 timestamp for closed state")

    receipts = state.get("gate_receipts", [])
    if not isinstance(receipts, list):
        errors.append("gate_receipts must be a list")
    else:
        for index, receipt in enumerate(receipts):
            if not isinstance(receipt, dict):
                errors.append(f"gate_receipts[{index}] must be an object")
                continue
            for field in ("gate", "evidence"):
                if not isinstance(receipt.get(field), str) or not receipt[field].strip():
                    errors.append(
                        f"gate_receipts[{index}].{field} must be a non-empty string"
                    )
            if not _valid_timestamp(receipt.get("resolved_at")):
                errors.append(
                    f"gate_receipts[{index}].resolved_at must be an ISO-8601 timestamp"
                )

    history = state.get("phase_history", [])
    if not isinstance(history, list):
        errors.append("phase_history must be a list")
    else:
        for index, transition in enumerate(history):
            if not isinstance(transition, dict):
                errors.append(f"phase_history[{index}] must be an object")
                continue
            if transition.get("from") not in PHASES or transition.get("to") not in PHASES:
                errors.append(f"phase_history[{index}] contains an invalid phase")
            if not _valid_timestamp(transition.get("entered_at")):
                errors.append(
                    f"phase_history[{index}].entered_at must be an ISO-8601 timestamp"
                )
    return errors


def load_validated_state(root: Path) -> ValidatedState:
    target = state_path(root)
    if not target.exists():
        raise FileNotFoundError(f"workflow state not found: {target}")
    value = json.loads(target.read_text(encoding="utf-8"))
    return ValidatedState(target, value, validate_state(value))


def invalid_state(snapshot: ValidatedState) -> tuple[dict[str, Any], int]:
    return (
        {
            "result": "invalid-state",
            "state_path": str(snapshot.path),
            "verification": {"valid": False, "errors": snapshot.errors},
            "state": snapshot.value,
        },
        2,
    )


def require_active(
    snapshot: ValidatedState,
) -> tuple[dict[str, Any], int] | None:
    if snapshot.errors:
        return invalid_state(snapshot)
    if snapshot.value["status"] == "closed":
        return (
            {
                "result": "workflow-closed",
                "state_path": str(snapshot.path),
                "state": snapshot.value,
            },
            3,
        )
    return None
