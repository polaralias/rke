# AGENTS

RKE is the deterministic repository runtime. `engineering-workflow` owns independent engineering methodology; the `rke` skill owns optional runtime support for those methods.

## Project rules

- Keep CLI and MCP as thin adapters over `src/operations.ts`; domain behaviour may not be implemented in only one transport.
- Treat every repository path as an explicit data boundary. Dynamic MCP targets must be validated as Git repositories and may be constrained by configured allowed roots.
- Treat `package.json` as the release version source and keep `src/version.ts`, MCP identity, package smoke tests, and release tags equal to it.
- Keep `skills/engineering-workflow` and `.agents/skills/rke` as independently versioned canonical skill packages in this repository. Methodology must remain complete without the runtime; runtime command guidance belongs in `.agents/skills/rke`.
- Publish both skills into the Polaralias skills catalogue as synchronized mirrors; do not maintain independent copies there.
- Verify each catalogue mirror with `npm run skill:check -- --skill <engineering-workflow|rke> --target <skills-repo>/skills/engineering/<name>` before coordinated release.
- Preserve Query-to-Knowledge and Repository Change Comprehension as named workflow concepts, and preserve OKF Tasks as an independent primitive.
- Run the complete deterministic test suite, no-Python audit, and npm package build before release.

<!-- repo-setup:shared-governance:start -->
## Shared Git Workflow

- work from a short-lived branch created from `main`
- do not commit directly to `main`
- use branch names prefixed with `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, or `test/`
- keep one logical change per branch and pull request
- open a pull request before merging to `main`, including for solo work
- prefer squash merge unless multiple commits carry durable review value
- delete the merged or closed feature branch after the work is finished; never delete `main`
- use tags in `vX.Y.Z` format for releases and do not move published tags
<!-- repo-setup:shared-governance:end -->
