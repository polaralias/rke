# Supported composition

RKE 0.1.0 is the initial TypeScript runtime, supported on Node >=24.15.0. CLI and MCP share the same validated operations.

- EWF 6.2.1 supplies independent engineering methodology from `skills/engineering-workflow`.
- RKE adapter 1.2.2 supplies optional runtime guidance from `.agents/skills/rke`.
- OKF Tasks is an independent producer. The integration workflow pins source `99a2907181c029446ffaf9c6bff664a7b0ff487c`; the runtime invokes a separately installed compatible CLI.
- Catalogue copies are synchronized mirrors with exact source provenance. They do not become independent implementations.

See the [initial candidate declaration](release-completion-status.json) and [qualification contract](release-qualification-contract.md). No published release, hosted result, automatic host selection or agent effectiveness is established by this declaration. Qualify the committed source and actual installed composition before making those claims.
