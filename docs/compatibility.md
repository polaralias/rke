# RKE 1.x stability contract

This document identifies the interfaces RKE intends to stabilize at 1.0. During the 0.x series, release notes may announce necessary changes and migrations; consumers should pin compatible RKE and Engineering Workflow (EWF) versions. From 1.0 onward, the following contract applies throughout the 1.x line.

## Public interfaces

- CLI operation names and their principal arguments are stable. New optional arguments and new operations may be added compatibly.
- MCP tool names, JSON argument schemas, and structured-result discriminators and meanings are stable. CLI and MCP remain adapters over the same operation registry and handlers.
- CLI exit code `0` means the operation completed successfully, `2` means invocation or domain input was invalid, and `3` means a valid operation returned an unresolved or blocking workflow outcome. Other non-zero values indicate process or transport failure rather than a domain result.
- `.rke/repo-context.json` is a public repository format. Its `schemaVersion` controls migrations; RKE must either read the version, provide an explicit migration, or fail with a specific incompatibility error. It must not silently reinterpret incompatible data.
- `.engineering-workflow/state.json` is an RKE-managed implementation detail. Users may inspect and back it up, but integrations must use lifecycle operations rather than depending on its internal fields.

## Repository surfaces

- `.rke/` stores tracked RKE identity, knowledge bindings, and intentionally shared continuation evidence.
- `.engineering-workflow/` stores disposable or local workflow state, caches, indexes, and receipts. It is normally ignored.
- `.githooks/` stores repository-owned hooks installed by RKE when explicitly requested.
- `local-docs/` stores ignored machine-local notes and handoffs. A deliberate shared handoff belongs under `.rke/handoffs/` instead.

These ownership boundaries are stable even when files within an implementation-detail directory evolve.

## Deprecation and compatibility

A public 1.x interface is deprecated for at least one minor release before removal. Removal or incompatible reinterpretation requires the next major release. Security fixes may disable unsafe behaviour immediately, but the release must name the affected surface and provide a safe migration where feasible.

The runtime distribution includes two independently versioned skill packages: `engineering-workflow` for engineering methods and `rke` for runtime support. Neither skill version is the runtime version. EWF remains usable without RKE. The RKE adapter selects commands for a chosen method and owns runtime state, schemas, receipts and host integration guidance. Installing EWF alone does not install the runtime or adapter.

Each synchronized catalogue mirror records the source repository, skill path, skill version, runtime distribution version and content digest. Check the selected package explicitly with `skill:check -- --skill <name> --target <mirror>`. The runtime's qualification report retains `identity.skill` for EWF compatibility and adds `identity.adapter` for the RKE skill; `--skill` can select a repository-local copy of either. A baseline without the adapter identity requires requalification rather than inheriting acceptance. Runtime help describes the commands available in the installed version; unsupported operations must fail explicitly.
