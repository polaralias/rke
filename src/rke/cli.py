from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .documentation import DocumentationError
from .errors import ContextError
from .host_integration import HOSTS, HostIntegrationError
from .knowledge import KnowledgeError
from .lifecycle import CAPABILITIES, JOURNEYS
from .okf_adapter import OkfAdapterError
from .operations import OperationError, invoke_operation
from .paths import repository_relative_path
from .workflow_state import PHASES, TASK_MODES, state_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rke",
        description="Run Repository Knowledge Engineering operations and workflow lifecycle.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    activate_parser = subparsers.add_parser(
        "activate", help="Idempotently create, validate, or reopen workflow state."
    )
    activate_parser.add_argument("--root", type=Path, default=Path.cwd())
    activate_parser.add_argument("--phase", choices=PHASES, default="deliver")
    activate_parser.add_argument("--task-mode", choices=TASK_MODES, default="none")
    start_parser = subparsers.add_parser("start", help="Start a workflow session.")
    start_parser.add_argument("--root", type=Path, default=Path.cwd())
    start_parser.add_argument("--phase", choices=PHASES, default="understand")
    start_parser.add_argument("--task-mode", choices=TASK_MODES, default="none")
    start_parser.add_argument("--capability", action="append", default=[])
    start_parser.add_argument("--gate", action="append", default=[])
    start_parser.add_argument(
        "--new-cycle",
        action="store_true",
        help="Start a fresh cycle only when the saved workflow is closed.",
    )
    checkpoint_parser = subparsers.add_parser(
        "checkpoint", help="Persist compact restart context."
    )
    checkpoint_parser.add_argument("--root", type=Path, default=Path.cwd())
    checkpoint_parser.add_argument("--summary", required=True)
    checkpoint_parser.add_argument("--next-action", required=True)
    resume_parser = subparsers.add_parser(
        "resume", help="Validate and return saved workflow state."
    )
    resume_parser.add_argument("--root", type=Path, default=Path.cwd())
    close_parser = subparsers.add_parser(
        "close", help="Close only when required gates are resolved."
    )
    close_parser.add_argument("--root", type=Path, default=Path.cwd())
    close_parser.add_argument("--base")
    gate_parser = subparsers.add_parser(
        "gate", help="Resolve workflow obligations from explicit evidence."
    )
    gate_subparsers = gate_parser.add_subparsers(dest="gate_command", required=True)
    add_parser = gate_subparsers.add_parser(
        "add", help="Register one or more obligations on an active workflow."
    )
    add_parser.add_argument("--root", type=Path, default=Path.cwd())
    add_parser.add_argument("--gate", action="append", required=True)
    resolve_parser = gate_subparsers.add_parser(
        "resolve", help="Resolve one outstanding gate with an evidence receipt."
    )
    resolve_parser.add_argument("--root", type=Path, default=Path.cwd())
    resolve_parser.add_argument("--gate", required=True)
    resolve_parser.add_argument("--evidence", required=True)
    journey_parser = subparsers.add_parser(
        "journey", help="Enter a selectively loaded workflow journey."
    )
    journey_subparsers = journey_parser.add_subparsers(
        dest="journey_command", required=True
    )
    enter_parser = journey_subparsers.add_parser(
        "enter", help="Enter the understand or design journey."
    )
    enter_parser.add_argument("journey", choices=tuple(JOURNEYS))
    enter_parser.add_argument("--root", type=Path, default=Path.cwd())
    task_parser = subparsers.add_parser(
        "task", help="Configure and validate proportional OKF Tasks tracking."
    )
    task_subparsers = task_parser.add_subparsers(dest="task_command", required=True)
    configure_parser = task_subparsers.add_parser(
        "configure", help="Select none, lightweight, or full durable task tracking."
    )
    configure_parser.add_argument("--root", type=Path, default=Path.cwd())
    configure_parser.add_argument("--mode", choices=TASK_MODES, required=True)
    configure_parser.add_argument("--task-ref")
    configure_parser.add_argument("--bundle", default="tasks")
    configure_parser.add_argument(
        "--force",
        action="store_true",
        help="Explicitly reduce task mode without resolving existing reconciliation gates.",
    )
    task_check_parser = task_subparsers.add_parser(
        "check", help="Run strict validation through the authoritative OKF Tasks CLI."
    )
    task_check_parser.add_argument("--root", type=Path, default=Path.cwd())
    task_check_parser.add_argument("--cli")
    capability_parser = subparsers.add_parser(
        "capability", help="Activate a bounded optional workflow capability."
    )
    capability_subparsers = capability_parser.add_subparsers(
        dest="capability_command", required=True
    )
    enable_parser = capability_subparsers.add_parser(
        "enable", help="Enable one capability and register its evidence gates."
    )
    enable_parser.add_argument("capability", choices=tuple(CAPABILITIES))
    enable_parser.add_argument("--root", type=Path, default=Path.cwd())
    closure_parser = subparsers.add_parser(
        "closure", help="Assess independent material-work closure lanes."
    )
    closure_subparsers = closure_parser.add_subparsers(
        dest="closure_command", required=True
    )
    assess_parser = closure_subparsers.add_parser(
        "assess", help="Report whether every registered closure obligation is clear."
    )
    assess_parser.add_argument("--root", type=Path, default=Path.cwd())
    assess_parser.add_argument("--base")
    legacy_parser = subparsers.add_parser(
        "legacy", help="Resolve a legacy engineering name to the replacement surface."
    )
    legacy_subparsers = legacy_parser.add_subparsers(
        dest="legacy_command", required=True
    )
    route_parser = legacy_subparsers.add_parser(
        "route", help="Return one deterministic compatibility destination."
    )
    route_parser.add_argument("legacy_name")
    route_parser.add_argument("--root", type=Path, default=Path.cwd())
    dissection_parser = subparsers.add_parser(
        "dissection", help="Inventory an unfamiliar repository and its trust gaps."
    )
    dissection_subparsers = dissection_parser.add_subparsers(
        dest="dissection_command", required=True
    )
    dissection_assess_parser = dissection_subparsers.add_parser(
        "assess", help="Return a machine-readable repository dissection."
    )
    dissection_assess_parser.add_argument("--root", type=Path, default=Path.cwd())
    handoff_parser = subparsers.add_parser(
        "handoff", help="Write or inspect local or shared continuation artefacts."
    )
    handoff_subparsers = handoff_parser.add_subparsers(
        dest="handoff_command", required=True
    )
    handoff_write_parser = handoff_subparsers.add_parser(
        "write", help="Write one deterministic continuation handoff."
    )
    handoff_write_parser.add_argument("--root", type=Path, default=Path.cwd())
    handoff_write_parser.add_argument("--topic", required=True)
    handoff_write_parser.add_argument("--summary", required=True)
    handoff_write_parser.add_argument("--next-action", required=True)
    handoff_write_parser.add_argument("--mode", choices=("standard", "max"), default="standard")
    handoff_write_parser.add_argument("--visibility", choices=("local", "shared"), default="local")
    handoff_write_parser.add_argument("--directory")
    handoff_write_parser.add_argument("--reference", action="append", default=[])
    handoff_inspect_parser = handoff_subparsers.add_parser(
        "inspect", help="Select and verify one active continuation handoff."
    )
    handoff_inspect_parser.add_argument("--root", type=Path, default=Path.cwd())
    handoff_inspect_parser.add_argument("--path")
    handoff_inspect_parser.add_argument("--visibility", choices=("auto", "local", "shared"), default="auto")
    handoff_inspect_parser.add_argument("--directory")
    coordination_parser = subparsers.add_parser(
        "coordination", help="Validate and plan parallel or stacked worktree delivery."
    )
    coordination_subparsers = coordination_parser.add_subparsers(
        dest="coordination_command", required=True
    )
    coordination_validate_parser = coordination_subparsers.add_parser(
        "validate", help="Validate a coordination manifest without changing Git."
    )
    coordination_validate_parser.add_argument("--root", type=Path, default=Path.cwd())
    coordination_validate_parser.add_argument("--manifest", required=True)
    coordination_plan_parser = coordination_subparsers.add_parser(
        "plan", help="Return non-executing worktree allocation commands."
    )
    coordination_plan_parser.add_argument("--root", type=Path, default=Path.cwd())
    coordination_plan_parser.add_argument("--manifest", required=True)
    publication_parser = subparsers.add_parser(
        "publication", help="Assess bounded repository publication safety."
    )
    publication_subparsers = publication_parser.add_subparsers(
        dest="publication_command", required=True
    )
    publication_scan_parser = publication_subparsers.add_parser(
        "scan", help="Scan tracked files and use gitleaks when available."
    )
    publication_scan_parser.add_argument("--root", type=Path, default=Path.cwd())
    context_parser = subparsers.add_parser(
        "context", help="Build and query disposable repository context."
    )
    context_subparsers = context_parser.add_subparsers(
        dest="context_command", required=True
    )
    find_parser = context_subparsers.add_parser(
        "find", help="Retrieve ranked repository evidence for a question."
    )
    find_parser.add_argument("query")
    find_parser.add_argument("--root", type=Path, default=Path.cwd())
    find_parser.add_argument("--limit", type=int, default=8)
    find_parser.add_argument("--scope")
    check_parser = context_subparsers.add_parser(
        "check", help="Refresh and report generated context trust signals."
    )
    check_parser.add_argument("--root", type=Path, default=Path.cwd())
    check_parser.add_argument(
        "--manifest", default=".rke/repo-context.json"
    )
    benchmark_parser = context_subparsers.add_parser(
        "benchmark", help="Measure retrieval against a versioned query corpus."
    )
    benchmark_parser.add_argument("--root", type=Path, default=Path.cwd())
    benchmark_parser.add_argument("--corpus", required=True)
    impact_parser = context_subparsers.add_parser(
        "impact", help="Classify canonical-knowledge impact for changed paths."
    )
    impact_parser.add_argument("--root", type=Path, default=Path.cwd())
    impact_parser.add_argument("--changed", action="append", required=True)
    impact_parser.add_argument(
        "--manifest", default=".rke/repo-context.json"
    )
    verify_parser = context_subparsers.add_parser(
        "verify", help="Record a review receipt for one bound knowledge document."
    )
    verify_parser.add_argument("--root", type=Path, default=Path.cwd())
    verify_parser.add_argument("--knowledge", required=True)
    verify_parser.add_argument("--evidence", required=True)
    verify_parser.add_argument(
        "--manifest", default=".rke/repo-context.json"
    )
    structure_parser = subparsers.add_parser(
        "structure", help="Inspect live source APIs, dependencies, and blast radius."
    )
    structure_subparsers = structure_parser.add_subparsers(
        dest="structure_command", required=True
    )
    structure_api_parser = structure_subparsers.add_parser(
        "file-api", help="Return signatures from one source file without function bodies."
    )
    structure_api_parser.add_argument("path")
    structure_api_parser.add_argument("--root", type=Path, default=Path.cwd())
    structure_review_parser = structure_subparsers.add_parser(
        "review", help="Prepare bounded source slices for agent review when parsing is unavailable."
    )
    structure_review_parser.add_argument("path")
    structure_review_parser.add_argument("--root", type=Path, default=Path.cwd())
    structure_review_apply_parser = structure_subparsers.add_parser(
        "review-apply", help="Validate and record source-bound agent structural evidence."
    )
    structure_review_apply_parser.add_argument("path")
    structure_review_apply_parser.add_argument("--review-file", required=True)
    structure_review_apply_parser.add_argument("--root", type=Path, default=Path.cwd())
    structure_trace_parser = structure_subparsers.add_parser(
        "trace", help="Trace incoming callers, outgoing calls, or both."
    )
    structure_trace_parser.add_argument("symbol")
    structure_trace_parser.add_argument(
        "--direction", choices=("in", "out", "both"), default="in"
    )
    structure_trace_parser.add_argument("--depth", type=int, default=2)
    structure_trace_parser.add_argument("--scope", action="append", default=[])
    structure_trace_parser.add_argument("--root", type=Path, default=Path.cwd())
    structure_map_parser = structure_subparsers.add_parser(
        "map", help="Return source clusters and dependency hubs without rendering."
    )
    structure_map_parser.add_argument("--limit", type=int, default=20)
    structure_map_parser.add_argument("--scope", action="append", default=[])
    structure_map_parser.add_argument("--root", type=Path, default=Path.cwd())
    structure_impact_parser = structure_subparsers.add_parser(
        "impact", help="Trace callers affected by changed source files."
    )
    structure_impact_parser.add_argument("--changed", action="append", required=True)
    structure_impact_parser.add_argument("--depth", type=int, default=2)
    structure_impact_parser.add_argument("--scope", action="append", default=[])
    structure_impact_parser.add_argument("--root", type=Path, default=Path.cwd())
    structure_benchmark_parser = structure_subparsers.add_parser(
        "benchmark", help="Measure structural recall and output size on a corpus."
    )
    structure_benchmark_parser.add_argument("--corpus", required=True)
    structure_benchmark_parser.add_argument("--root", type=Path, default=Path.cwd())
    structure_search_parser = structure_subparsers.add_parser(
        "search", help="Find regex hits grouped by enclosing symbol and coupling."
    )
    structure_search_parser.add_argument("pattern")
    structure_search_parser.add_argument("--limit", type=int, default=50)
    structure_search_parser.add_argument("--scope", action="append", default=[])
    structure_search_parser.add_argument("--root", type=Path, default=Path.cwd())
    knowledge_parser = subparsers.add_parser(
        "knowledge", help="Validate and maintain canonical OKF knowledge."
    )
    knowledge_subparsers = knowledge_parser.add_subparsers(
        dest="knowledge_command", required=True
    )
    knowledge_check_parser = knowledge_subparsers.add_parser(
        "check", help="Validate typed concepts and their durable relationship graph."
    )
    knowledge_check_parser.add_argument("--root", type=Path, default=Path.cwd())
    knowledge_check_parser.add_argument("--bundle", required=True)
    knowledge_build_parser = knowledge_subparsers.add_parser(
        "build-indexes", help="Build deterministic progressive-disclosure indexes."
    )
    knowledge_build_parser.add_argument("--root", type=Path, default=Path.cwd())
    knowledge_build_parser.add_argument("--bundle", required=True)
    knowledge_build_parser.add_argument("--force", action="store_true")
    knowledge_register_parser = knowledge_subparsers.add_parser(
        "register", help="Bind one typed canonical concept to explicit source patterns."
    )
    knowledge_register_parser.add_argument("--root", type=Path, default=Path.cwd())
    knowledge_register_parser.add_argument("--knowledge", required=True)
    knowledge_register_parser.add_argument("--source", action="append", required=True)
    knowledge_register_parser.add_argument(
        "--manifest", default=".rke/repo-context.json"
    )
    documentation_parser = subparsers.add_parser(
        "documentation", help="Assess and complete event-driven documentation work."
    )
    documentation_subparsers = documentation_parser.add_subparsers(
        dest="documentation_command", required=True
    )
    documentation_bootstrap_parser = documentation_subparsers.add_parser(
        "bootstrap", help="Assess the repository's documentation foundation without writing it."
    )
    documentation_bootstrap_parser.add_argument("--root", type=Path, default=Path.cwd())
    documentation_bootstrap_parser.add_argument("--bundle", default="docs/knowledge")
    documentation_bootstrap_parser.add_argument(
        "--manifest", default=".rke/repo-context.json"
    )
    documentation_assess_parser = documentation_subparsers.add_parser(
        "assess", help="Classify documentation impact from a Git base."
    )
    documentation_assess_parser.add_argument("--root", type=Path, default=Path.cwd())
    documentation_assess_parser.add_argument("--base", required=True)
    documentation_assess_parser.add_argument(
        "--manifest", default=".rke/repo-context.json"
    )
    documentation_apply_parser = documentation_subparsers.add_parser(
        "apply", help="Validate authored documentation, reader retrieval, and freshness."
    )
    documentation_apply_parser.add_argument("--root", type=Path, default=Path.cwd())
    documentation_apply_parser.add_argument("--base", required=True)
    documentation_apply_parser.add_argument("--bundle", required=True)
    documentation_apply_parser.add_argument("--knowledge", action="append", required=True)
    documentation_apply_parser.add_argument("--evidence", required=True)
    documentation_apply_parser.add_argument("--reader-query", action="append", required=True)
    documentation_apply_parser.add_argument(
        "--manifest", default=".rke/repo-context.json"
    )
    change_parser = subparsers.add_parser(
        "change", help="Record bounded causal change comprehension."
    )
    change_subparsers = change_parser.add_subparsers(
        dest="change_command", required=True
    )
    change_explain_parser = change_subparsers.add_parser(
        "explain", help="Record an RCC-compatible explanation receipt for a Git delta."
    )
    change_explain_parser.add_argument("--root", type=Path, default=Path.cwd())
    change_explain_parser.add_argument("--base", required=True)
    change_explain_parser.add_argument("--summary", required=True)
    host_parser = subparsers.add_parser(
        "host", help="Describe or install bounded host integration."
    )
    host_subparsers = host_parser.add_subparsers(dest="host_command", required=True)
    host_recipe_parser = host_subparsers.add_parser(
        "recipe", help="Return MCP and Git-gate setup without changing host configuration."
    )
    host_recipe_parser.add_argument("--root", type=Path, default=Path.cwd())
    host_recipe_parser.add_argument("--host", choices=HOSTS, required=True)
    host_recipe_parser.add_argument("--base", required=True)
    host_install_parser = host_subparsers.add_parser(
        "install", help="Install a local pre-push gate and supported project MCP config."
    )
    host_install_parser.add_argument("--root", type=Path, default=Path.cwd())
    host_install_parser.add_argument("--host", choices=HOSTS, required=True)
    host_install_parser.add_argument("--base", required=True)
    host_install_parser.add_argument("--force", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    root = args.root.resolve()
    try:
        if args.command == "activate":
            payload, exit_code = invoke_operation(
                root,
                "workflow_activate",
                {"phase": args.phase, "taskMode": args.task_mode},
            )
        elif args.command == "start":
            payload, exit_code = invoke_operation(
                root,
                "workflow_start",
                {
                    "phase": args.phase,
                    "capabilities": args.capability,
                    "gates": args.gate,
                    "taskMode": args.task_mode,
                    "newCycle": args.new_cycle,
                },
            )
        elif args.command == "checkpoint":
            payload, exit_code = invoke_operation(
                root,
                "workflow_checkpoint",
                {"summary": args.summary, "nextAction": args.next_action},
            )
        elif args.command == "resume":
            payload, exit_code = invoke_operation(root, "workflow_resume", {})
        elif args.command == "close":
            values = {"base": args.base} if args.base is not None else {}
            payload, exit_code = invoke_operation(root, "workflow_close", values)
        elif args.command == "gate" and args.gate_command == "resolve":
            payload, exit_code = invoke_operation(
                root,
                "workflow_gate_resolve",
                {"gate": args.gate, "evidence": args.evidence},
            )
        elif args.command == "gate" and args.gate_command == "add":
            payload, exit_code = invoke_operation(
                root, "workflow_gate_add", {"gates": args.gate}
            )
        elif args.command == "journey" and args.journey_command == "enter":
            payload, exit_code = invoke_operation(
                root, "workflow_journey_enter", {"journey": args.journey}
            )
        elif args.command == "task" and args.task_command == "configure":
            values = {
                "mode": args.mode,
                "bundle": args.bundle,
                "force": args.force,
            }
            if args.task_ref is not None:
                values["taskRef"] = args.task_ref
            payload, exit_code = invoke_operation(root, "workflow_task_configure", values)
        elif args.command == "task" and args.task_command == "check":
            values = {"cli": args.cli} if args.cli is not None else {}
            payload, exit_code = invoke_operation(root, "workflow_task_check", values)
        elif args.command == "capability" and args.capability_command == "enable":
            payload, exit_code = invoke_operation(
                root,
                "workflow_capability_enable",
                {"capability": args.capability},
            )
        elif args.command == "closure" and args.closure_command == "assess":
            values = {"base": args.base} if args.base is not None else {}
            payload, exit_code = invoke_operation(
                root, "workflow_closure_assess", values
            )
        elif args.command == "legacy" and args.legacy_command == "route":
            payload, exit_code = invoke_operation(
                root, "workflow_legacy_route", {"name": args.legacy_name}
            )
        elif args.command == "dissection" and args.dissection_command == "assess":
            payload, exit_code = invoke_operation(root, "repo_dissection_assess", {})
        elif args.command == "handoff" and args.handoff_command == "write":
            values = {
                "topic": args.topic,
                "summary": args.summary,
                "nextAction": args.next_action,
                "mode": args.mode,
                "visibility": args.visibility,
                "references": args.reference,
            }
            if args.directory is not None:
                values["directory"] = args.directory
            payload, exit_code = invoke_operation(
                root,
                "repo_handoff_write",
                values,
            )
        elif args.command == "handoff" and args.handoff_command == "inspect":
            values = {"visibility": args.visibility}
            if args.path is not None:
                values["path"] = args.path
            if args.directory is not None:
                values["directory"] = args.directory
            payload, exit_code = invoke_operation(
                root,
                "repo_handoff_inspect",
                values,
            )
        elif args.command == "coordination" and args.coordination_command == "validate":
            payload, exit_code = invoke_operation(
                root, "repo_coordination_validate", {"manifest": args.manifest}
            )
        elif args.command == "coordination" and args.coordination_command == "plan":
            payload, exit_code = invoke_operation(
                root, "repo_coordination_plan", {"manifest": args.manifest}
            )
        elif args.command == "publication" and args.publication_command == "scan":
            payload, exit_code = invoke_operation(root, "repo_publication_scan", {})
        elif args.command == "context" and args.context_command == "find":
            values = {"query": args.query, "limit": args.limit}
            if args.scope is not None:
                values["scope"] = args.scope
            payload, exit_code = invoke_operation(
                root,
                "repo_find_context",
                values,
            )
        elif args.command == "context" and args.context_command == "check":
            payload, exit_code = invoke_operation(
                root, "repo_context_check", {"manifest": args.manifest}
            )
        elif args.command == "context" and args.context_command == "benchmark":
            payload, exit_code = invoke_operation(
                root, "repo_context_benchmark", {"corpus": args.corpus}
            )
        elif args.command == "context" and args.context_command == "impact":
            payload, exit_code = invoke_operation(
                root,
                "repo_knowledge_impact",
                {"changedPaths": args.changed, "manifest": args.manifest},
            )
        elif args.command == "context" and args.context_command == "verify":
            payload, exit_code = invoke_operation(
                root,
                "repo_knowledge_verify",
                {
                    "knowledge": args.knowledge,
                    "evidence": args.evidence,
                    "manifest": args.manifest,
                },
            )
        elif args.command == "structure" and args.structure_command == "file-api":
            payload, exit_code = invoke_operation(
                root, "repo_file_api", {"path": args.path}
            )
        elif args.command == "structure" and args.structure_command == "review":
            payload, exit_code = invoke_operation(
                root, "repo_prepare_code_review", {"path": args.path}
            )
        elif args.command == "structure" and args.structure_command == "review-apply":
            review_path, _ = repository_relative_path(
                root,
                args.review_file,
                escape_code="structure_review_file_escape",
                missing_code="structure_review_file_missing",
            )
            try:
                review = json.loads(review_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise ContextError("structure_review_invalid", f"Review evidence is invalid JSON at line {exc.lineno}.") from exc
            payload, exit_code = invoke_operation(
                root, "repo_record_code_review", {"path": args.path, "review": review}
            )
        elif args.command == "structure" and args.structure_command == "trace":
            payload, exit_code = invoke_operation(
                root,
                "repo_trace_symbol",
                {
                    "symbol": args.symbol,
                    "direction": args.direction,
                    "depth": args.depth,
                    "scopes": args.scope,
                },
            )
        elif args.command == "structure" and args.structure_command == "map":
            payload, exit_code = invoke_operation(
                root, "repo_structure_map", {"limit": args.limit, "scopes": args.scope}
            )
        elif args.command == "structure" and args.structure_command == "impact":
            payload, exit_code = invoke_operation(
                root,
                "repo_change_impact",
                {"changedPaths": args.changed, "depth": args.depth, "scopes": args.scope},
            )
        elif args.command == "structure" and args.structure_command == "benchmark":
            payload, exit_code = invoke_operation(
                root, "repo_structure_benchmark", {"corpus": args.corpus}
            )
        elif args.command == "structure" and args.structure_command == "search":
            payload, exit_code = invoke_operation(
                root,
                "repo_find_all",
                {"pattern": args.pattern, "limit": args.limit, "scopes": args.scope},
            )
        elif args.command == "knowledge" and args.knowledge_command == "check":
            payload, exit_code = invoke_operation(
                root, "repo_knowledge_bundle_check", {"bundle": args.bundle}
            )
        elif args.command == "knowledge" and args.knowledge_command == "build-indexes":
            payload, exit_code = invoke_operation(
                root,
                "repo_knowledge_build_indexes",
                {"bundle": args.bundle, "force": args.force},
            )
        elif args.command == "knowledge" and args.knowledge_command == "register":
            payload, exit_code = invoke_operation(
                root,
                "repo_knowledge_register",
                {
                    "knowledge": args.knowledge,
                    "sources": args.source,
                    "manifest": args.manifest,
                },
            )
        elif args.command == "documentation" and args.documentation_command == "bootstrap":
            payload, exit_code = invoke_operation(
                root,
                "repo_documentation_bootstrap",
                {"bundle": args.bundle, "manifest": args.manifest},
            )
        elif args.command == "documentation" and args.documentation_command == "assess":
            payload, exit_code = invoke_operation(
                root,
                "repo_documentation_assess",
                {"base": args.base, "manifest": args.manifest},
            )
        elif args.command == "documentation" and args.documentation_command == "apply":
            payload, exit_code = invoke_operation(
                root,
                "repo_documentation_apply",
                {
                    "base": args.base,
                    "bundle": args.bundle,
                    "knowledgePaths": args.knowledge,
                    "evidence": args.evidence,
                    "readerQueries": args.reader_query,
                    "manifest": args.manifest,
                },
            )
        elif args.command == "change" and args.change_command == "explain":
            payload, exit_code = invoke_operation(
                root,
                "repo_change_explain",
                {"base": args.base, "summary": args.summary},
            )
        elif args.command == "host" and args.host_command == "recipe":
            payload, exit_code = invoke_operation(
                root,
                "repo_host_recipe",
                {"host": args.host, "base": args.base},
            )
        elif args.command == "host" and args.host_command == "install":
            payload, exit_code = invoke_operation(
                root,
                "repo_host_install",
                {"host": args.host, "base": args.base, "force": args.force},
            )
        else:  # pragma: no cover - argparse owns command validation.
            raise AssertionError(f"unsupported command: {args.command}")
    except FileNotFoundError:
        payload = {
            "result": "missing-state",
            "state_path": str(state_path(root)),
            "error": {
                "code": "workflow_state_missing",
                "message": "Run engineering start before this lifecycle operation.",
            },
        }
        exit_code = 2
    except json.JSONDecodeError as exc:
        payload = {
            "result": "invalid-state",
            "state_path": str(state_path(root)),
            "error": {
                "code": "workflow_state_invalid_json",
                "message": f"Workflow state is not valid JSON at line {exc.lineno}.",
            },
        }
        exit_code = 2
    except ContextError as exc:
        payload = {
            "result": "context-error",
            "error": {"code": exc.code, "message": exc.message},
        }
        exit_code = 2
    except OkfAdapterError as exc:
        payload = {
            "result": "task-adapter-error",
            "error": {"code": exc.code, "message": exc.message},
        }
        exit_code = 2
    except KnowledgeError as exc:
        payload = {
            "result": "knowledge-error",
            "error": {"code": exc.code, "message": exc.message},
        }
        exit_code = 2
    except DocumentationError as exc:
        payload = {
            "result": "documentation-error",
            "error": {"code": exc.code, "message": exc.message},
        }
        exit_code = 2
    except HostIntegrationError as exc:
        payload = {
            "result": "host-integration-error",
            "error": {"code": exc.code, "message": exc.message},
        }
        exit_code = 2
    except OperationError as exc:
        payload = {
            "result": "operation-error",
            "error": {"code": exc.code, "message": exc.message},
        }
        exit_code = 2
    except ValueError as exc:
        payload = {
            "result": "operation-error",
            "error": {"code": "invalid_operation_input", "message": str(exc)},
        }
        exit_code = 2
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
