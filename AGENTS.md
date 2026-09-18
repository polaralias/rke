# AGENTS

RKE is the canonical executable implementation and methodology used by the `engineering-workflow` skill.

## Project rules

- Keep CLI and MCP as thin adapters over `src/rke/operations.py`; domain behaviour may not be implemented in only one transport.
- Treat every repository path as an explicit data boundary. Dynamic MCP targets must be validated as Git repositories and may be constrained by configured allowed roots.
- Keep `pyproject.toml`, `VERSION`, `src/rke/__init__.py`, and MCP server identity versions aligned.
- Keep `skills/engineering-workflow` as the canonical skill package paired with this runtime.
- Publish the skill into the Polaralias skills catalogue as a synchronized mirror; do not maintain an independent runtime copy there.
- Verify a local catalogue checkout with `python scripts/sync_skill.py --target <skills-repo>/skills/engineering/engineering-workflow --check` before coordinated release.
- Preserve Query-to-Knowledge and Repository Change Comprehension as named workflow concepts, and preserve OKF Tasks as an independent primitive.
- Run the complete deterministic test suite and build a wheel before release.

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
