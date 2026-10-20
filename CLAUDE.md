# Claude Code Instructions

@AGENTS.md

Apply the engineering skill routing and installation guidance in [AGENTS.md](AGENTS.md#engineering-skills). Use the canonical skills already in this checkout: [Engineering Workflow](skills/engineering-workflow/SKILL.md) for engineering methodology and the separate [RKE adapter](.agents/skills/rke/SKILL.md) for relevant runtime support. Read the selected skill before acting; runtime installation alone does not require adapter use.

For multi-repository work, follow [named workspace ownership](docs/managed-workspaces.md). Keep ordinary repository operations local; a registered workspace never authorizes additional roots or member writes.
