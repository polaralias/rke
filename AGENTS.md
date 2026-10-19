# AGENTS

RKE is the deterministic repository runtime. `engineering-workflow` owns independent engineering methodology; the `rke` skill owns optional runtime support for those methods.

## Engineering skills

For material repository engineering, read and apply the repository's [Engineering Workflow skill](skills/engineering-workflow/SKILL.md), selecting the method that fits the task. Read the separate [RKE skill](.agents/skills/rke/SKILL.md) when runtime operations are requested, useful, or required by repository policy. Installation alone does not require runtime use. Read the selected skill's complete entry point and only the relevant references.

Both canonical skills are already present in this checkout; use these local sources when contributing. For installation into another project or a supported agent host, use the same Skills CLI convention as the [Polaralias catalogue](https://github.com/polaralias/skills):

```sh
npx skills add polaralias/rke --skill engineering-workflow
npx skills add polaralias/rke --skill rke
```

Add `--global` for a user-wide installation. The catalogue provides synchronized mirrors using the same commands with `polaralias/skills` as the repository. Install from either source, rather than keeping duplicate installations. Skill installation supplies agent instructions; install the optional runtime separately with `npm install --global @polaralias/rke`. See [README.md](README.md#install) for installation and host setup.

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
