---
type: Architecture Concept
title: RKE architecture
description: Defines the independently installed Repository Knowledge Engineering runtime, its shared CLI and MCP operation layer, repository boundaries, and relationship with EWF and OKF Tasks.
timestamp: 2026-09-18T22:45:00+01:00
authority: canonical
verification: verified-working
verified_at: 2026-09-18T22:45:00+01:00
verified_against:
  - src/rke/operations.py
  - src/rke/engineering.py
  - src/rke/repo_context_mcp.py
  - src/rke/host_integration.py
  - skills/engineering-workflow/SKILL.md
  - "106 deterministic tests passed"
  - "polaralias-rke 0.1.0 wheel built"
owner: polaralias
tags:
  - rke
  - engineering-workflow
  - repository-context
  - mcp
navigation:
  role: foundational
  order: 10
---

# RKE architecture

## Purpose

RKE turns repository evidence into bounded, retrievable engineering context without confusing generated indexes, authored knowledge, execution records or workflow state.

## Distribution

The `polaralias-rke` package is the sole executable implementation. It exposes two adapters over one operation registry:

- `rke` maps shell arguments to registered handlers and is authoritative for hooks, CI and automation.
- `rke-mcp` maps MCP tool calls to the same handlers and schemas. It adds no domain implementation.

The initial extracted runtime is covered by 106 deterministic tests and a successful wheel build.

The EWF skill is co-versioned in `skill/engineering-workflow`. The Polaralias skills repository carries a synchronized catalogue mirror for agent discovery. A mirror may not contain a divergent runtime copy.

## Repository selection

CLI calls supply `--root`. Machine-wide MCP calls supply `repository` for each tool invocation. The server canonicalises the OS path, verifies that dynamic targets are Git repositories, optionally constrains them beneath configured `--allow-root` boundaries, and passes one resolved root to the handler.

Each repository owns its own `.engineering-workflow/` state, disposable indexes and receipts. Cross-repository work must retain source provenance and must never merge canonical knowledge or freshness claims implicitly.

## Methodology

Documentation-driven development is the principle: make intended behaviour and durable decisions legible, implement against them, and validate them against source and runtime evidence.

RKE is the operational methodology:

1. Retrieve bounded repository evidence.
2. Resolve source-backed facts separately from user intent.
3. Use Query-to-Knowledge when consequential intent remains uncertain.
4. Design and implement against explicit acceptance.
5. Assess knowledge and documentation impact from the real Git delta.
6. Use Repository Change Comprehension to explain the causal final state.
7. Close only when validation, task truth, knowledge and documentation evidence reconcile.

## Independent primitives

RKE does not absorb OKF Tasks. OKF Tasks owns execution records, validation and lifecycle truth. RKE may invoke its authoritative CLI through a bounded adapter.

EWF does not absorb RKE. EWF is the agent-facing workflow skill; RKE is the installed tool and methodology it directs.
