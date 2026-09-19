from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from .documentation import documentation_closure_evidence
from .okf_adapter import OkfAdapterError, check_bundle, normalise_relative, plan
from .workflow_state import (
    PHASES,
    TASK_MODES,
    SCHEMA_VERSION,
    invalid_state,
    load_validated_state,
    require_active,
    state_path,
    unique,
    utc_now,
    write_json,
)


JOURNEYS: dict[str, dict[str, Any]] = {
    "understand": {
        "name": "understand",
        "reference": "references/journeys/understand.md",
        "capabilities": ["context-retrieval"],
        "gates": [],
        "operations": [
            "repository-orientation",
            "machine-readable-dissection",
            "bounded-evidence-retrieval",
            "runtime-verification",
            "declared-versus-observed-trust-classification",
            "ambiguity-resolution",
            "knowledge-impact-classification",
            "minimum-documentation-foundation",
        ],
    },
    "design": {
        "name": "design",
        "reference": "references/journeys/design.md",
        "capabilities": [],
        "gates": ["acceptance-defined"],
        "operations": [
            "truth-and-assumption-separation",
            "bounded-feature-contract",
            "scenario-pressure-test",
            "public-behaviour-acceptance",
            "verification-matrix",
            "dependency-and-risk-modelling",
            "traceable-work-package-readiness",
        ],
    },
    "close": {
        "name": "close",
        "reference": "references/journeys/close.md",
        "capabilities": [],
        "gates": [],
        "operations": [
            "bound-change-explanation",
            "independent-lane-assessment",
            "provisional-task-reconciliation",
            "durable-knowledge-promotion",
            "final-task-reconciliation",
            "task-and-knowledge-reconciliation",
            "final-validation",
            "continuation-disposition",
            "explicit-closure",
        ],
    },
}

CAPABILITIES: dict[str, dict[str, Any]] = {
    "query-to-knowledge": {
        "name": "query-to-knowledge",
        "reference": "references/extensions/query-to-knowledge.md",
        "gates": ["shared-understanding"],
    },
    "parallel-delivery": {
        "name": "parallel-delivery",
        "reference": "references/extensions/parallel-delivery.md",
        "gates": ["integrated-tree-validation", "worktree-cleanup"],
    },
    "publication": {
        "name": "publication",
        "reference": "references/extensions/publication.md",
        "gates": ["publication-safety"],
    },
}

LEGACY_ROUTES: dict[str, dict[str, Any]] = {
    "EWO": {"name": "engineering-workflow-orchestrator", "destination": "lifecycle", "command": ["start"]},
    "RDS": {"name": "repo-dissection", "destination": "understand", "command": ["dissection", "assess"]},
    "QTK": {"name": "query-to-knowledge", "destination": "query-to-knowledge", "command": ["capability", "enable", "query-to-knowledge"]},
    "RKE": {"name": "repo-knowledge-engineering", "destination": "understand", "command": ["journey", "enter", "understand"]},
    "DDD": {"name": "doc-driven-development", "destination": "design", "command": ["journey", "enter", "design"]},
    "RTL": {"name": "repo-task-lifecycle", "destination": "tasks", "command": ["task", "configure"]},
    "WTC": {"name": "worktree-task-coordinator", "destination": "parallel-delivery", "command": ["coordination", "validate"]},
    "RCC": {"name": "repo-change-comprehension", "destination": "close", "command": ["journey", "enter", "close"]},
    "RSA": {"name": "repo-session-alignment", "destination": "close", "command": ["closure", "assess"]},
    "LHO": {"name": "local-handoff", "destination": "handoff-write", "command": ["handoff", "write", "--visibility", "local"]},
    "LPK": {"name": "local-pickup", "destination": "handoff-inspect", "command": ["handoff", "inspect", "--visibility", "local"]},
    "RPF": {"name": "repo-publish-finaliser", "destination": "publication", "command": ["capability", "enable", "publication"]},
    "RST": {"name": "repo-setup", "destination": "repository-setup", "command": ["use-separate-bootstrap-capability"], "separate": True},
}


def _invalid_or_closed(root: Path) -> tuple[Any, tuple[dict[str, Any], int] | None]:
    snapshot = load_validated_state(root)
    return snapshot, require_active(snapshot)


def start(
    root: Path,
    *,
    phase: str,
    capabilities: list[str],
    gates: list[str],
    task_mode: str,
    new_cycle: bool = False,
) -> tuple[dict[str, Any], int]:
    target = state_path(root)
    if target.exists():
        snapshot = load_validated_state(root)
        if snapshot.errors:
            return invalid_state(snapshot)
        state = snapshot.value
        if new_cycle and state["status"] == "closed":
            now = utc_now()
            previous_cycle = {
                "created_at": state.get("created_at"),
                "closed_at": state.get("closed_at"),
                "primary_phase": state.get("primary_phase"),
                "gate_receipt_count": len(state.get("gate_receipts", [])),
            }
            state = {
                "schema_version": SCHEMA_VERSION,
                "status": "active",
                "primary_phase": phase,
                "active_capabilities": unique(capabilities),
                "outstanding_gates": unique(gates),
                "task_tracking": {"mode": task_mode, "task_ref": None},
                "continuity": {"checkpoint": None, "previous_cycle": previous_cycle},
                "created_at": now,
                "updated_at": now,
            }
            write_json(target, state)
            return {"result": "new-cycle-started", "state_path": str(target), "state": state}, 0
        return {"result": "resumed-existing", "state_path": str(target), "state": state}, 0
    now = utc_now()
    state: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "status": "active",
        "primary_phase": phase,
        "active_capabilities": unique(capabilities),
        "outstanding_gates": unique(gates),
        "task_tracking": {"mode": task_mode, "task_ref": None},
        "continuity": {"checkpoint": None},
        "created_at": now,
        "updated_at": now,
    }
    write_json(target, state)
    return {"result": "started", "state_path": str(target), "state": state}, 0


def checkpoint(root: Path, *, summary: str, next_action: str) -> tuple[dict[str, Any], int]:
    snapshot, blocked = _invalid_or_closed(root)
    if blocked:
        return blocked
    now = utc_now()
    snapshot.value["continuity"]["checkpoint"] = {
        "at": now,
        "summary": summary,
        "next_action": next_action,
    }
    snapshot.value["updated_at"] = now
    write_json(snapshot.path, snapshot.value)
    return {"result": "checkpointed", "state_path": str(snapshot.path), "state": snapshot.value}, 0


def resume(root: Path) -> tuple[dict[str, Any], int]:
    snapshot = load_validated_state(root)
    if snapshot.errors:
        return invalid_state(snapshot)
    return {
        "result": "resumed",
        "state_path": str(snapshot.path),
        "verification": {"valid": True, "errors": []},
        "state": snapshot.value,
    }, 0


def activation_git_baseline(root: Path) -> dict[str, Any]:
    def git(*arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(root), *arguments],
            text=True,
            capture_output=True,
            check=False,
        )

    head = git("rev-parse", "HEAD")
    changed = git("diff", "--name-only", "HEAD")
    untracked = git("ls-files", "--others", "--exclude-standard")
    if head.returncode or changed.returncode or untracked.returncode:
        return {"gitRepository": False, "head": None, "dirtyPaths": []}
    dirty_paths = sorted(set(changed.stdout.splitlines()) | set(untracked.stdout.splitlines()))
    return {
        "gitRepository": True,
        "head": head.stdout.strip(),
        "dirtyPaths": dirty_paths[:500],
        "dirtyPathCount": len(dirty_paths),
        "dirtyPathsTruncated": len(dirty_paths) > 500,
    }


def record_activation(root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    target = state_path(root)
    state = payload["state"]
    state["activation"] = {"activatedAt": utc_now(), **activation_git_baseline(root)}
    state["updated_at"] = state["activation"]["activatedAt"]
    write_json(target, state)
    payload["state"] = state
    payload["activation"] = state["activation"]
    return payload


def activate(root: Path, *, phase: str, task_mode: str) -> tuple[dict[str, Any], int]:
    target = state_path(root)
    if not target.exists():
        payload, exit_code = start(
            root,
            phase=phase,
            capabilities=[],
            gates=[],
            task_mode=task_mode,
        )
        return record_activation(root, payload), exit_code
    payload, exit_code = resume(root)
    if exit_code:
        return payload, exit_code
    if payload["state"]["status"] == "closed":
        payload, exit_code = start(
            root,
            phase=phase,
            capabilities=[],
            gates=[],
            task_mode=task_mode,
            new_cycle=True,
        )
        return record_activation(root, payload), exit_code
    payload["result"] = "activated-existing"
    return record_activation(root, payload), 0


def close(root: Path, *, base: str | None = None) -> tuple[dict[str, Any], int]:
    snapshot = load_validated_state(root)
    if snapshot.errors:
        return invalid_state(snapshot)
    state = snapshot.value
    if state["status"] == "closed":
        return {
            "result": "already-closed",
            "state_path": str(snapshot.path),
            "outstanding_gates": state["outstanding_gates"],
            "documentation": None,
            "state": state,
        }, 0
    if state["outstanding_gates"]:
        return {
            "result": "closure-blocked",
            "state_path": str(snapshot.path),
            "outstanding_gates": state["outstanding_gates"],
            "state": state,
        }, 3
    documentation = documentation_closure_evidence(root, base=base) if base is not None else None
    if documentation is not None and not documentation["ready"]:
        return {
            "result": "closure-blocked",
            "state_path": str(snapshot.path),
            "outstanding_gates": [],
            "documentation": documentation,
            "state": state,
        }, 3
    now = utc_now()
    state.update({"status": "closed", "primary_phase": "close", "closed_at": now, "updated_at": now})
    write_json(snapshot.path, state)
    return {
        "result": "closed",
        "state_path": str(snapshot.path),
        "outstanding_gates": [],
        "documentation": documentation,
        "state": state,
    }, 0


def resolve_gate(root: Path, *, gate: str, evidence: str) -> tuple[dict[str, Any], int]:
    snapshot, blocked = _invalid_or_closed(root)
    if blocked:
        return blocked
    state = snapshot.value
    if gate not in state["outstanding_gates"]:
        return {"result": "gate-not-outstanding", "state_path": str(snapshot.path), "gate": gate, "state": state}, 3
    now = utc_now()
    state["outstanding_gates"] = [value for value in state["outstanding_gates"] if value != gate]
    state.setdefault("gate_receipts", []).append({"gate": gate, "evidence": evidence, "resolved_at": now})
    state["updated_at"] = now
    write_json(snapshot.path, state)
    return {"result": "gate-resolved", "state_path": str(snapshot.path), "gate": gate, "state": state}, 0


def add_gates(root: Path, *, gates: list[str]) -> tuple[dict[str, Any], int]:
    snapshot, blocked = _invalid_or_closed(root)
    if blocked:
        return blocked
    state = snapshot.value
    added = [gate for gate in unique(gates) if gate not in state["outstanding_gates"]]
    state["outstanding_gates"] += added
    state["updated_at"] = utc_now()
    write_json(snapshot.path, state)
    return {"result": "gates-added", "state_path": str(snapshot.path), "added": added, "state": state}, 0


def enter_journey(root: Path, *, journey: str) -> tuple[dict[str, Any], int]:
    snapshot, blocked = _invalid_or_closed(root)
    if blocked:
        return blocked
    state = snapshot.value
    specification = JOURNEYS[journey]
    previous_phase = state["primary_phase"]
    now = utc_now()
    state["primary_phase"] = journey
    state["active_capabilities"] = unique(state["active_capabilities"] + specification["capabilities"])
    state["outstanding_gates"] = unique(state["outstanding_gates"] + specification["gates"])
    state.setdefault("phase_history", []).append({"from": previous_phase, "to": journey, "entered_at": now})
    state["updated_at"] = now
    write_json(snapshot.path, state)
    return {"result": "journey-entered", "state_path": str(snapshot.path), "journey": specification, "state": state}, 0


def configure_tasks(
    root: Path,
    *,
    mode: str,
    task_ref: str | None,
    bundle: str,
    force: bool,
) -> tuple[dict[str, Any], int]:
    snapshot, blocked = _invalid_or_closed(root)
    if blocked:
        return blocked
    state = snapshot.value
    existing = state["task_tracking"]
    rank = {"none": 0, "lightweight": 1, "full": 2}
    if rank[mode] < rank[existing["mode"]] and not force:
        raise OkfAdapterError(
            "task_mode_reduction_requires_force",
            "Reducing durable task tracking requires explicit --force and does not resolve existing task gates.",
        )
    if mode == "none" and task_ref is not None:
        raise OkfAdapterError("task_mode_invalid", "Task mode none cannot retain a task reference.")
    normalized_bundle = normalise_relative(root, bundle)
    if task_ref is not None:
        normalized_ref = normalise_relative(root, task_ref, must_exist=True)
    elif mode != "none":
        normalized_ref = existing.get("task_ref")
    else:
        normalized_ref = None
    state["task_tracking"] = {"mode": mode, "task_ref": normalized_ref, "bundle": normalized_bundle}
    if mode != "none":
        state["active_capabilities"] = unique(state["active_capabilities"] + ["task-lifecycle"])
        state["outstanding_gates"] = unique(state["outstanding_gates"] + ["task-reconciliation"])
    elif force:
        state["active_capabilities"] = [value for value in state["active_capabilities"] if value != "task-lifecycle"]
    state["updated_at"] = utc_now()
    write_json(snapshot.path, state)
    return {"result": "task-tracking-configured", "state_path": str(snapshot.path), "plan": plan(mode), "state": state}, 0


def check_tasks(root: Path, *, cli: str | None) -> tuple[dict[str, Any], int]:
    snapshot = load_validated_state(root)
    if snapshot.errors:
        return invalid_state(snapshot)
    tracking = snapshot.value["task_tracking"]
    mode = tracking["mode"]
    if mode == "none":
        return {"result": "task-tracking-disabled", "executed": False, "plan": plan("none"), "state": snapshot.value}, 0
    payload, exit_code = check_bundle(root, bundle=tracking.get("bundle", "tasks"), cli=cli)
    payload["plan"] = plan(mode)
    payload["taskRef"] = tracking.get("task_ref")
    return payload, exit_code


def enable_capability(root: Path, *, capability: str) -> tuple[dict[str, Any], int]:
    snapshot, blocked = _invalid_or_closed(root)
    if blocked:
        return blocked
    state = snapshot.value
    specification = CAPABILITIES[capability]
    state["active_capabilities"] = unique(state["active_capabilities"] + [capability])
    state["outstanding_gates"] = unique(state["outstanding_gates"] + specification["gates"])
    state["updated_at"] = utc_now()
    write_json(snapshot.path, state)
    return {"result": "capability-enabled", "state_path": str(snapshot.path), "capability": specification, "state": state}, 0


def closure_assessment(root: Path, *, base: str | None = None) -> tuple[dict[str, Any], int]:
    snapshot = load_validated_state(root)
    if snapshot.errors:
        return invalid_state(snapshot)
    state = snapshot.value
    outstanding = state["outstanding_gates"]

    def lane(gates: set[str], clear_status: str = "state-clear") -> dict[str, Any]:
        pending = [gate for gate in outstanding if gate in gates]
        gate_status = "pending" if pending else clear_status
        return {
            "status": gate_status,
            "gateStatus": gate_status,
            "receiptStatus": "not-assessed",
            "pendingGates": pending,
        }

    capabilities = set(state["active_capabilities"])
    task_mode = state["task_tracking"]["mode"]
    lanes = {
        "change": lane({"change-explanation"}),
        "validation": lane({"implementation-validation", "integrated-tree-validation"}),
        "tasks": lane({"task-reconciliation"}, "not-applicable" if task_mode == "none" else "state-clear"),
        "knowledge": lane({"knowledge-impact-review", "knowledge-promotion"}),
        "coordination": lane({"integrated-tree-validation", "worktree-cleanup"}, "not-enabled" if "parallel-delivery" not in capabilities else "state-clear"),
        "publication": lane({"publication-safety"}, "not-enabled" if "publication" not in capabilities else "state-clear"),
    }
    recognised = {gate for details in lanes.values() for gate in details["pendingGates"]}
    residual = [gate for gate in outstanding if gate not in recognised]
    lanes["other"] = {
        "status": "pending" if residual else "state-clear",
        "gateStatus": "pending" if residual else "state-clear",
        "receiptStatus": "not-assessed",
        "pendingGates": residual,
    }
    documentation = None
    if base is not None:
        documentation = documentation_closure_evidence(root, base=base)
        for name in ("change", "knowledge"):
            receipt = documentation[name]
            lanes[name]["receiptStatus"] = receipt["status"]
            lanes[name]["issues"] = receipt["issues"]
            if lanes[name]["pendingGates"]:
                lanes[name]["status"] = "pending"
            else:
                lanes[name]["status"] = receipt["status"]
    ready = not outstanding and state["status"] in {"active", "closed"} and (documentation is None or documentation["ready"])
    task_status = lanes["tasks"]["status"]
    knowledge_status = lanes["knowledge"]["status"]
    session_alignment = {
        "explanation": lanes["change"]["status"],
        "tasks": "not present" if task_status == "not-applicable" else ("blocked" if task_status == "pending" else "no-op"),
        "knowledge": "blocked" if knowledge_status == "pending" else "no-op",
        "validation": lanes["validation"]["status"],
        "handoff": "required" if state["primary_phase"] == "pause" else "not-required",
        "closure": "complete" if ready else "blocked",
        "requiredOrdering": [
            "establish-final-delta",
            "prepare-causal-explanation",
            "discover-task-and-knowledge-lanes",
            "reconcile-tasks-provisionally",
            "promote-durable-knowledge",
            "reconcile-tasks-finally",
            "validate-affected-surfaces",
            "write-handoff-only-if-continuation-is-needed",
        ],
    }
    return {
        "result": "closure-ready" if ready else "closure-blocked",
        "ready": ready,
        "state_path": str(snapshot.path),
        "lanes": lanes,
        "sessionAlignment": session_alignment,
        "outstandingGates": outstanding,
        "documentation": documentation,
        "state": state,
    }, 0 if ready else 3


def route_legacy(value: str) -> tuple[dict[str, Any], int]:
    normalized = value.strip().lower()
    alias = next(
        (
            candidate
            for candidate, route in LEGACY_ROUTES.items()
            if normalized in {candidate.lower(), route["name"].lower()}
        ),
        None,
    )
    if alias is None:
        return {"result": "legacy-route-unknown", "requested": value, "knownAliases": sorted(LEGACY_ROUTES)}, 2
    route = LEGACY_ROUTES[alias]
    return {
        "result": "legacy-route",
        "alias": alias,
        "legacyName": route["name"],
        "destination": route["destination"],
        "command": route["command"],
        "deprecatedPeer": not route.get("separate", False),
        "separateCapability": route.get("separate", False),
    }, 0
