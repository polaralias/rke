from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any, Callable, Iterator

from .documentation import apply_documentation, assess_documentation, explain_change
from .continuity import inspect_handoff, write_handoff
from .coordination import plan_coordination, validate_coordination
from .dissection import assess_dissection
from .host_integration import host_recipe, install_host
from .knowledge import build_indexes, inspect_bundle, register_knowledge
from .manifest import DEFAULT_MANIFEST_PATH
from .publication import scan_publication
from .repo_context import (
    benchmark_context,
    check_context,
    find_context,
    impact_context,
    verify_knowledge,
)
from .structure import (
    benchmark_structure,
    change_impact,
    file_api,
    prepare_agent_review,
    record_agent_review,
    repository_map,
    search_structure,
    trace_symbol,
)


DEFAULT_MANIFEST = DEFAULT_MANIFEST_PATH
OperationHandler = Callable[[Path, dict[str, Any]], tuple[dict[str, Any], int]]


class OperationError(Exception):
    def __init__(self, message: str, *, code: str = "invalid_operation_arguments") -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class UnknownOperationError(OperationError):
    def __init__(self, name: str) -> None:
        super().__init__(f"Unknown operation: {name}", code="unknown_operation")
        self.name = name


@dataclass(frozen=True)
class OperationOutcome:
    payload: dict[str, Any]
    exit_code: int = 0

    def __iter__(self) -> Iterator[Any]:
        yield self.payload
        yield self.exit_code


@dataclass(frozen=True)
class Operation:
    name: str
    title: str
    description: str
    input_schema: dict[str, Any]
    read_only: bool
    idempotent: bool
    handler: OperationHandler

    def mcp_tool(self, *, repository_required: bool = False) -> dict[str, Any]:
        schema = deepcopy(self.input_schema)
        if repository_required:
            schema.setdefault("properties", {})["repository"] = {
                "type": "string",
                "description": "Absolute path to the Git repository for this operation.",
            }
            required = list(schema.get("required", []))
            if "repository" not in required:
                required.append("repository")
            schema["required"] = required
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": schema,
            "annotations": {
                "readOnlyHint": self.read_only,
                "idempotentHint": self.idempotent,
            },
        }


def string(arguments: dict[str, Any], name: str, *, default: str | None = None) -> str:
    value = arguments.get(name, default)
    if not isinstance(value, str) or not value.strip():
        raise OperationError(f"Argument '{name}' must be a non-empty string.")
    return value


def optional_string(arguments: dict[str, Any], name: str) -> str | None:
    value = arguments.get(name)
    if value is not None and not isinstance(value, str):
        raise OperationError(f"Argument '{name}' must be a string.")
    return value


def integer(arguments: dict[str, Any], name: str, *, default: int) -> int:
    value = arguments.get(name, default)
    if not isinstance(value, int) or isinstance(value, bool):
        raise OperationError(f"Argument '{name}' must be an integer.")
    return value


def boolean(arguments: dict[str, Any], name: str, *, default: bool = False) -> bool:
    value = arguments.get(name, default)
    if not isinstance(value, bool):
        raise OperationError(f"Argument '{name}' must be a boolean.")
    return value


def strings(arguments: dict[str, Any], name: str) -> list[str]:
    value = arguments.get(name)
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(item, str) and item.strip() for item in value)
    ):
        raise OperationError(f"Argument '{name}' must be a non-empty string array.")
    return value


def optional_strings(arguments: dict[str, Any], name: str) -> list[str]:
    value = arguments.get(name, [])
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item.strip() for item in value
    ):
        raise OperationError(f"Argument '{name}' must be a string array.")
    return value


def mapping(arguments: dict[str, Any], name: str) -> dict[str, Any]:
    value = arguments.get(name)
    if not isinstance(value, dict):
        raise OperationError(f"Argument '{name}' must be an object.")
    return value


def _validate_schema(value: Any, schema: dict[str, Any], path: str = "arguments") -> None:
    expected = schema.get("type")
    if expected == "object":
        if not isinstance(value, dict):
            raise OperationError(f"{path} must be an object.")
        properties = schema.get("properties", {})
        for required in schema.get("required", []):
            if required not in value:
                raise OperationError(f"{path}.{required} is required.")
        if schema.get("additionalProperties") is False:
            extras = sorted(set(value) - set(properties))
            if extras:
                raise OperationError(
                    f"{path} contains unsupported properties: {', '.join(extras)}."
                )
        for name, item in value.items():
            item_schema = properties.get(name)
            if item_schema is not None:
                _validate_schema(item, item_schema, f"{path}.{name}")
        return
    if expected == "string":
        if not isinstance(value, str) or not value.strip():
            raise OperationError(f"{path} must be a non-empty string.")
    elif expected == "integer":
        if not isinstance(value, int) or isinstance(value, bool):
            raise OperationError(f"{path} must be an integer.")
        if "minimum" in schema and value < schema["minimum"]:
            raise OperationError(f"{path} must be at least {schema['minimum']}.")
        if "maximum" in schema and value > schema["maximum"]:
            raise OperationError(f"{path} must be at most {schema['maximum']}.")
    elif expected == "boolean":
        if not isinstance(value, bool):
            raise OperationError(f"{path} must be a boolean.")
    elif expected == "array":
        if not isinstance(value, list):
            raise OperationError(f"{path} must be an array.")
        if len(value) < schema.get("minItems", 0):
            raise OperationError(
                f"{path} must contain at least {schema['minItems']} item(s)."
            )
        item_schema = schema.get("items")
        if item_schema:
            for index, item in enumerate(value):
                _validate_schema(item, item_schema, f"{path}[{index}]")
    if "enum" in schema and value not in schema["enum"]:
        choices = ", ".join(str(choice) for choice in schema["enum"])
        raise OperationError(f"{path} must be one of: {choices}.")


def _lifecycle(name: str, root: Path, **arguments: Any) -> tuple[dict[str, Any], int]:
    from . import lifecycle
    from .workflow_state import state_path

    function = getattr(lifecycle, name)
    try:
        result = function(root, **arguments)
    except FileNotFoundError:
        return (
            {
                "result": "missing-state",
                "state_path": str(state_path(root)),
                "error": {
                    "code": "workflow_state_missing",
                    "message": "Run engineering start before this lifecycle operation.",
                },
            },
            2,
        )
    except json.JSONDecodeError as exc:
        return (
            {
                "result": "invalid-state",
                "state_path": str(state_path(root)),
                "error": {
                    "code": "workflow_state_invalid_json",
                    "message": f"Workflow state is not valid JSON at line {exc.lineno}.",
                },
            },
            2,
        )
    return result if isinstance(result, tuple) else (result, 0)


def workflow_activate(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return _lifecycle(
        "activate",
        root,
        phase=string(arguments, "phase", default="deliver"),
        task_mode=string(arguments, "taskMode", default="none"),
    )


def workflow_start(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return _lifecycle(
        "start",
        root,
        phase=string(arguments, "phase", default="understand"),
        capabilities=arguments.get("capabilities", []),
        gates=arguments.get("gates", []),
        task_mode=string(arguments, "taskMode", default="none"),
        new_cycle=boolean(arguments, "newCycle"),
    )


def workflow_checkpoint(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return _lifecycle(
        "checkpoint",
        root,
        summary=string(arguments, "summary"),
        next_action=string(arguments, "nextAction"),
    )


def workflow_resume(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return _lifecycle("resume", root)


def workflow_close(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return _lifecycle("close", root, base=optional_string(arguments, "base"))


def workflow_gate_add(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return _lifecycle("add_gates", root, gates=strings(arguments, "gates"))


def workflow_gate_resolve(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return _lifecycle(
        "resolve_gate",
        root,
        gate=string(arguments, "gate"),
        evidence=string(arguments, "evidence"),
    )


def workflow_journey_enter(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return _lifecycle("enter_journey", root, journey=string(arguments, "journey"))


def workflow_task_configure(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return _lifecycle(
        "configure_tasks",
        root,
        mode=string(arguments, "mode"),
        task_ref=optional_string(arguments, "taskRef"),
        bundle=string(arguments, "bundle", default="docs/tasks"),
        force=boolean(arguments, "force"),
    )


def workflow_task_check(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return _lifecycle("check_tasks", root, cli=optional_string(arguments, "cli"))


def workflow_capability_enable(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return _lifecycle(
        "enable_capability", root, capability=string(arguments, "capability")
    )


def workflow_closure_assess(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return _lifecycle(
        "closure_assessment", root, base=optional_string(arguments, "base")
    )


def workflow_legacy_route(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    del root
    from .lifecycle import route_legacy

    return route_legacy(string(arguments, "name"))


def host_recipe_operation(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return (
        host_recipe(
            root,
            host=string(arguments, "host"),
            base=string(arguments, "base", default="main"),
        ),
        0,
    )


def host_install_operation(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return (
        install_host(
            root,
            host=string(arguments, "host"),
            base=string(arguments, "base", default="main"),
            force=boolean(arguments, "force"),
        ),
        0,
    )


def context_benchmark(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return benchmark_context(root, string(arguments, "corpus")), 0


def context_find(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return (
        find_context(
            root,
            string(arguments, "query"),
            limit=integer(arguments, "limit", default=8),
            scope=optional_string(arguments, "scope"),
        ),
        0,
    )


def context_check(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return check_context(root, manifest=string(arguments, "manifest", default=DEFAULT_MANIFEST)), 0


def knowledge_impact(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return (
        impact_context(
            root,
            strings(arguments, "changedPaths"),
            manifest=string(arguments, "manifest", default=DEFAULT_MANIFEST),
        ),
        0,
    )


def knowledge_verify(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return (
        verify_knowledge(
            root,
            string(arguments, "knowledge"),
            string(arguments, "evidence"),
            manifest=string(arguments, "manifest", default=DEFAULT_MANIFEST),
        ),
        0,
    )


def knowledge_check(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return inspect_bundle(root, string(arguments, "bundle"))


def knowledge_build(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return (
        build_indexes(
            root,
            string(arguments, "bundle"),
            force=boolean(arguments, "force"),
        ),
        0,
    )


def knowledge_register(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return (
        register_knowledge(
            root,
            string(arguments, "knowledge"),
            strings(arguments, "sources"),
            manifest=string(arguments, "manifest", default=DEFAULT_MANIFEST),
        ),
        0,
    )


def documentation_assess(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return assess_documentation(
        root,
        base=string(arguments, "base"),
        manifest=string(arguments, "manifest", default=DEFAULT_MANIFEST),
    )


def documentation_apply(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return (
        apply_documentation(
            root,
            base=string(arguments, "base"),
            bundle=string(arguments, "bundle"),
            knowledge_paths=strings(arguments, "knowledgePaths"),
            evidence=string(arguments, "evidence"),
            reader_queries=strings(arguments, "readerQueries"),
            manifest=string(arguments, "manifest", default=DEFAULT_MANIFEST),
        ),
        0,
    )


def change_explain(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return (
        explain_change(
            root,
            base=string(arguments, "base"),
            summary=string(arguments, "summary"),
        ),
        0,
    )


def structure_file_api(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return file_api(root, string(arguments, "path")), 0


def structure_agent_review(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return prepare_agent_review(root, string(arguments, "path")), 0


def structure_record_agent_review(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return record_agent_review(root, string(arguments, "path"), mapping(arguments, "review")), 0


def structure_trace(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return (
        trace_symbol(
            root,
            string(arguments, "symbol"),
            direction=string(arguments, "direction", default="in"),
            depth=integer(arguments, "depth", default=2),
            scopes=optional_strings(arguments, "scopes") or None,
        ),
        0,
    )


def structure_map(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return repository_map(
        root,
        limit=integer(arguments, "limit", default=20),
        scopes=optional_strings(arguments, "scopes") or None,
    ), 0


def structure_change_impact(
    root: Path, arguments: dict[str, Any]
) -> tuple[dict[str, Any], int]:
    return (
        change_impact(
            root,
            strings(arguments, "changedPaths"),
            depth=integer(arguments, "depth", default=2),
            scopes=optional_strings(arguments, "scopes") or None,
        ),
        0,
    )


def structure_benchmark(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return benchmark_structure(root, string(arguments, "corpus")), 0


def structure_search(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return (
        search_structure(
            root,
            string(arguments, "pattern"),
            limit=integer(arguments, "limit", default=50),
            scopes=optional_strings(arguments, "scopes") or None,
        ),
        0,
    )


def dissection_assess(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return assess_dissection(root), 0


def handoff_write(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    references = arguments.get("references", [])
    if not isinstance(references, list) or not all(isinstance(value, str) for value in references):
        raise OperationError("Argument 'references' must be a string array.")
    return (
        write_handoff(
            root,
            topic=string(arguments, "topic"),
            summary=string(arguments, "summary"),
            next_action=string(arguments, "nextAction"),
            mode=string(arguments, "mode", default="standard"),
            visibility=string(arguments, "visibility", default="local"),
            directory=optional_string(arguments, "directory"),
            references=references,
        ),
        0,
    )


def handoff_inspect(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return inspect_handoff(
        root,
        path=optional_string(arguments, "path"),
        visibility=string(arguments, "visibility", default="auto"),
        directory=optional_string(arguments, "directory"),
    )


def coordination_validate(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return validate_coordination(root, string(arguments, "manifest"))


def coordination_plan(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return plan_coordination(root, string(arguments, "manifest"))


def publication_scan(root: Path, arguments: dict[str, Any]) -> tuple[dict[str, Any], int]:
    return scan_publication(root)


def object_schema(
    properties: dict[str, Any], required: list[str] | None = None
) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    return schema


STRING = {"type": "string"}
STRING_ARRAY = {"type": "array", "items": STRING, "minItems": 1}
OPTIONAL_STRING_ARRAY = {"type": "array", "items": STRING}
PHASE = {"type": "string", "enum": ["understand", "design", "deliver", "close", "pause", "resume"]}
TASK_MODE = {"type": "string", "enum": ["none", "lightweight", "full"]}
HOST = {"type": "string", "enum": ["codex", "claude", "git"]}


OPERATIONS = (
    Operation(
        "workflow_activate",
        "Activate an engineering workflow",
        "Create, validate, or reopen repository-local workflow state through the idempotent agent entrypoint.",
        object_schema({"phase": {**PHASE, "default": "deliver"}, "taskMode": {**TASK_MODE, "default": "none"}}),
        False,
        True,
        workflow_activate,
    ),
    Operation(
        "workflow_start",
        "Start an engineering workflow",
        "Create workflow state or return the valid existing workflow without resetting it.",
        object_schema({
            "phase": {**PHASE, "default": "understand"},
            "capabilities": {"type": "array", "items": STRING},
            "gates": {"type": "array", "items": STRING},
            "taskMode": {**TASK_MODE, "default": "none"},
            "newCycle": {"type": "boolean", "default": False},
        }),
        False,
        True,
        workflow_start,
    ),
    Operation(
        "workflow_checkpoint",
        "Checkpoint workflow continuity",
        "Store a compact verified summary and next action without copying stronger records.",
        object_schema({"summary": STRING, "nextAction": STRING}, ["summary", "nextAction"]),
        False,
        False,
        workflow_checkpoint,
    ),
    Operation(
        "workflow_resume",
        "Resume workflow state",
        "Validate and return repository-local workflow state for re-verification.",
        object_schema({}),
        True,
        True,
        workflow_resume,
    ),
    Operation(
        "workflow_close",
        "Close an engineering workflow",
        "Close only when gates and optional exact-delta documentation evidence are clear.",
        object_schema({"base": STRING}),
        False,
        False,
        workflow_close,
    ),
    Operation(
        "workflow_gate_add",
        "Add workflow gates",
        "Register explicit unresolved obligations without resetting existing workflow state.",
        object_schema({"gates": STRING_ARRAY}, ["gates"]),
        False,
        True,
        workflow_gate_add,
    ),
    Operation(
        "workflow_gate_resolve",
        "Resolve a workflow gate",
        "Resolve one outstanding obligation with bounded evidence from its owning surface.",
        object_schema({"gate": STRING, "evidence": STRING}, ["gate", "evidence"]),
        False,
        False,
        workflow_gate_resolve,
    ),
    Operation(
        "workflow_journey_enter",
        "Enter a workflow journey",
        "Transition into understand, design, or close and return the one reference to load.",
        object_schema({"journey": {"type": "string", "enum": ["understand", "design", "close"]}}, ["journey"]),
        False,
        False,
        workflow_journey_enter,
    ),
    Operation(
        "workflow_task_configure",
        "Configure task persistence",
        "Configure proportionate OKF Tasks delegation without copying its execution schema.",
        object_schema({
            "mode": TASK_MODE,
            "taskRef": STRING,
            "bundle": {"type": "string", "default": "docs/tasks"},
            "force": {"type": "boolean", "default": False},
        }, ["mode"]),
        False,
        False,
        workflow_task_configure,
    ),
    Operation(
        "workflow_task_check",
        "Check configured task state",
        "Delegate validation to OKF Tasks when durable task mode is enabled.",
        object_schema({"cli": STRING}),
        True,
        True,
        workflow_task_check,
    ),
    Operation(
        "workflow_capability_enable",
        "Enable a workflow capability",
        "Enable one bounded extension and register only its required evidence gates.",
        object_schema({"capability": {"type": "string", "enum": ["query-to-knowledge", "parallel-delivery", "publication"]}}, ["capability"]),
        False,
        True,
        workflow_capability_enable,
    ),
    Operation(
        "workflow_closure_assess",
        "Assess workflow closure",
        "Report independent closure lanes without closing or waiving any obligation.",
        object_schema({"base": STRING}),
        True,
        True,
        workflow_closure_assess,
    ),
    Operation(
        "workflow_legacy_route",
        "Resolve a legacy engineering route",
        "Map a documented legacy alias or package name to one current workflow surface.",
        object_schema({"name": STRING}, ["name"]),
        True,
        True,
        workflow_legacy_route,
    ),
    Operation(
        "repo_host_recipe",
        "Describe host integration",
        "Return supported MCP, Git hook, and project-routing integration without mutation.",
        object_schema({"host": HOST, "base": {"type": "string", "default": "main"}}, ["host"]),
        True,
        True,
        host_recipe_operation,
    ),
    Operation(
        "repo_host_install",
        "Install host integration",
        "Install repository-local routing and pre-push integration while preserving independent ownership.",
        object_schema({
            "host": HOST,
            "base": {"type": "string", "default": "main"},
            "force": {"type": "boolean", "default": False},
        }, ["host"]),
        False,
        False,
        host_install_operation,
    ),
    Operation(
        "repo_context_benchmark",
        "Benchmark repository retrieval",
        "Run a repository-local query corpus and report deterministic retrieval metrics.",
        object_schema({"corpus": STRING}, ["corpus"]),
        True,
        True,
        context_benchmark,
    ),
    Operation(
        "repo_dissection_assess",
        "Assess repository dissection",
        "Inventory entry points, runtime candidates, tests, docs, knowledge, tasks, and trust gaps without overclaiming runtime verification.",
        object_schema({}),
        True,
        True,
        dissection_assess,
    ),
    Operation(
        "repo_handoff_write",
        "Write a continuation handoff",
        "Write one deterministic, secret-safe project handoff outside task and canonical knowledge surfaces.",
        object_schema(
            {
                "topic": STRING,
                "summary": STRING,
                "nextAction": STRING,
                "mode": {"type": "string", "enum": ["standard", "max"], "default": "standard"},
                "visibility": {"type": "string", "enum": ["local", "shared"], "default": "local"},
                "directory": STRING,
                "references": {"type": "array", "items": STRING},
            },
            ["topic", "summary", "nextAction"],
        ),
        False,
        False,
        handoff_write,
    ),
    Operation(
        "repo_handoff_inspect",
        "Inspect a continuation handoff",
        "Select one active handoff and return the claims that must be re-verified before work resumes.",
        object_schema({
            "path": STRING,
            "visibility": {"type": "string", "enum": ["auto", "local", "shared"], "default": "auto"},
            "directory": STRING,
        }),
        True,
        True,
        handoff_inspect,
    ),
    Operation(
        "repo_coordination_validate",
        "Validate parallel delivery coordination",
        "Validate topology, worktree boundaries, path ownership, dependency order, authority, and validation classes.",
        object_schema({"manifest": STRING}, ["manifest"]),
        True,
        True,
        coordination_validate,
    ),
    Operation(
        "repo_coordination_plan",
        "Plan worktree allocation",
        "Return non-executing Git worktree argv plans from a valid coordination manifest.",
        object_schema({"manifest": STRING}, ["manifest"]),
        True,
        True,
        coordination_plan,
    ),
    Operation(
        "repo_publication_scan",
        "Scan publication safety",
        "Run a redacted tracked-file safety scan and use gitleaks when it is already installed.",
        object_schema({}),
        True,
        True,
        publication_scan,
    ),
    Operation(
        "repo_find_context",
        "Find repository context",
        "Rank repository-local evidence for a query with the disposable BM25 index.",
        object_schema(
            {
                "query": STRING,
                "limit": {"type": "integer", "minimum": 1, "default": 8},
                "scope": STRING,
            },
            ["query"],
        ),
        True,
        True,
        context_find,
    ),
    Operation(
        "repo_context_check",
        "Check repository knowledge freshness",
        "Check indexed evidence and declared knowledge bindings without changing governed knowledge.",
        object_schema({"manifest": STRING}),
        True,
        True,
        context_check,
    ),
    Operation(
        "repo_knowledge_impact",
        "Classify knowledge impact",
        "Classify changed paths against explicit bindings and conservative lexical candidates.",
        object_schema({"changedPaths": STRING_ARRAY, "manifest": STRING}, ["changedPaths"]),
        True,
        True,
        knowledge_impact,
    ),
    Operation(
        "repo_knowledge_verify",
        "Record knowledge verification",
        "Record an evidence-backed verification receipt in the repository knowledge manifest.",
        object_schema(
            {"knowledge": STRING, "evidence": STRING, "manifest": STRING},
            ["knowledge", "evidence"],
        ),
        False,
        False,
        knowledge_verify,
    ),
    Operation(
        "repo_knowledge_bundle_check",
        "Validate an OKF knowledge bundle",
        "Validate typed concepts and the resolved durable relationship graph.",
        object_schema({"bundle": STRING}, ["bundle"]),
        True,
        True,
        knowledge_check,
    ),
    Operation(
        "repo_knowledge_build_indexes",
        "Build OKF knowledge indexes",
        "Build deterministic progressive-disclosure indexes.",
        object_schema(
            {"bundle": STRING, "force": {"type": "boolean", "default": False}},
            ["bundle"],
        ),
        False,
        True,
        knowledge_build,
    ),
    Operation(
        "repo_knowledge_register",
        "Register canonical knowledge bindings",
        "Bind one typed OKF concept to explicit repository source patterns.",
        object_schema(
            {"knowledge": STRING, "sources": STRING_ARRAY, "manifest": STRING},
            ["knowledge", "sources"],
        ),
        False,
        True,
        knowledge_register,
    ),
    Operation(
        "repo_documentation_assess",
        "Assess documentation impact",
        "Classify a material Git delta as no-op, update, or decision-required.",
        object_schema({"base": STRING, "manifest": STRING}, ["base"]),
        True,
        True,
        documentation_assess,
    ),
    Operation(
        "repo_documentation_apply",
        "Complete documentation validation",
        "Validate authored documentation, reader retrieval, graph integrity, and freshness.",
        object_schema(
            {
                "base": STRING,
                "bundle": STRING,
                "knowledgePaths": STRING_ARRAY,
                "evidence": STRING,
                "readerQueries": STRING_ARRAY,
                "manifest": STRING,
            },
            ["base", "bundle", "knowledgePaths", "evidence", "readerQueries"],
        ),
        False,
        False,
        documentation_apply,
    ),
    Operation(
        "repo_change_explain",
        "Record change explanation",
        "Record a causal explanation receipt for the current material Git delta.",
        object_schema({"base": STRING, "summary": STRING}, ["base", "summary"]),
        False,
        False,
        change_explain,
    ),
    Operation(
        "repo_file_api",
        "Read a file API surface",
        "Return signatures and line locations without function bodies.",
        object_schema({"path": STRING}, ["path"]),
        True,
        True,
        structure_file_api,
    ),
    Operation(
        "repo_prepare_code_review",
        "Prepare bounded agent code review",
        "Return bounded source slices and a strict review schema when parser evidence is unavailable.",
        object_schema({"path": STRING}, ["path"]),
        True,
        True,
        structure_agent_review,
    ),
    Operation(
        "repo_record_code_review",
        "Record bounded agent code review",
        "Validate and cache source-digest-bound structural evidence for a file without parser coverage.",
        object_schema({"path": STRING, "review": {"type": "object"}}, ["path", "review"]),
        False,
        True,
        structure_record_agent_review,
    ),
    Operation(
        "repo_trace_symbol",
        "Trace symbol dependencies",
        "Trace bounded incoming callers, outgoing calls, or both from live source.",
        object_schema(
            {
                "symbol": STRING,
                "direction": {"type": "string", "enum": ["in", "out", "both"], "default": "in"},
                "depth": {"type": "integer", "minimum": 1, "maximum": 5, "default": 2},
                "scopes": OPTIONAL_STRING_ARRAY,
            },
            ["symbol"],
        ),
        True,
        True,
        structure_trace,
    ),
    Operation(
        "repo_structure_map",
        "Summarise repository structure",
        "Return source clusters and dependency hubs for orientation without rendering a graph.",
        object_schema({"limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}, "scopes": OPTIONAL_STRING_ARRAY}),
        True,
        True,
        structure_map,
    ),
    Operation(
        "repo_change_impact",
        "Trace structural change impact",
        "Find callers transitively affected by symbols in changed source files.",
        object_schema(
            {
                "changedPaths": STRING_ARRAY,
                "depth": {"type": "integer", "minimum": 1, "maximum": 5, "default": 2},
                "scopes": OPTIONAL_STRING_ARRAY,
            },
            ["changedPaths"],
        ),
        True,
        True,
        structure_change_impact,
    ),
    Operation(
        "repo_structure_benchmark",
        "Benchmark structural context",
        "Measure exact expected-symbol recall and output size on a checked-in corpus.",
        object_schema({"corpus": STRING}, ["corpus"]),
        True,
        True,
        structure_benchmark,
    ),
    Operation(
        "repo_find_all",
        "Find all structural matches",
        "Find regex matches in source, grouped by enclosing symbol and ranked by coupling.",
        object_schema(
            {
                "pattern": STRING,
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
                "scopes": OPTIONAL_STRING_ARRAY,
            },
            ["pattern"],
        ),
        True,
        True,
        structure_search,
    ),
)

OPERATION_BY_NAME = {operation.name: operation for operation in OPERATIONS}


def mcp_tools(*, repository_required: bool = False) -> list[dict[str, Any]]:
    return [
        operation.mcp_tool(repository_required=repository_required)
        for operation in OPERATIONS
    ]


def invoke_operation(
    root: Path, name: str, raw_arguments: Any
) -> OperationOutcome:
    if not isinstance(raw_arguments, dict):
        raise OperationError("Operation arguments must be an object.")
    operation = OPERATION_BY_NAME.get(name)
    if operation is None:
        raise UnknownOperationError(name)
    _validate_schema(raw_arguments, operation.input_schema)
    try:
        payload, exit_code = operation.handler(root, raw_arguments)
    except OperationError:
        raise
    except Exception as exc:
        if isinstance(exc, (ValueError, json.JSONDecodeError)):
            raise OperationError(str(exc), code="invalid_operation_data") from exc
        raise
    return OperationOutcome(payload=payload, exit_code=exit_code)
