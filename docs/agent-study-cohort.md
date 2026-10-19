# Owned-source cohort selection

This records source selection for the controlled study, not a completed preregistration or executed model evaluation. Controlled Codex trials remain deferred until implementation is built. Model reasoning settings, spending limits, dependency environments, arm preparation and independently reviewed task graders still need to be pinned before execution.

## Minimum-cost pilot decision — 15 October 2026

The owner requested the lowest practical test/trial usage. The initial budget is at most two short runs of the same bounded task: ordinary tools and EWF with RKE, using an explicitly selected low-cost configured Codex model at low reasoning. Stop on setup failure; do not retry paid runs or silently expand into the controlled-study crossing. Record actual token usage when supplied, otherwise unknown; no monetary claim follows without pinned actual pricing/accounting.

An authentication-only preflight used the existing Codex executable's `login status` with an owned empty `CODEX_HOME`. It returned `Not logged in` (exit 1). No model was invoked and no credentials were copied. Thus the isolated pilot has not run and there are zero model trials from this attempt. The normal desktop account is not evidence that an isolated study home is authenticated. Reusing a globally configured home would also require proving foreign skills, MCP tools and PATH are absent from each arm; the routing evaluator explicitly does not establish that isolation. Authentication and the reviewed host profile remain prerequisites, not successful study observations.

The owner has volunteered for human feedback. Use the [workflow trial](workflow-usability-protocol.md) and record this as project-owner feedback. It does not replace the independent five-reader or unfamiliar-developer requirements.

## Android prototype

The owner authorized selecting a local Android app while explicitly warning that the apps are not close to production code. AudioFocus was selected because its Kotlin implementation includes independent service, monitoring, playback decision, settings and UI paths, with existing unit tests. Its source complexity supplies useful navigation and change scenarios; it does not establish production representativeness, mobile reliability or correctness.

On 2026-10-14 the source freezer captured 41 explicitly selected Git-tracked files from the current worktree: Kotlin under `app/src/main` and `app/src/test`, plus available root/module Gradle configuration, version catalogue, wrapper properties, manifest, ProGuard rules and README. Source HEAD was `44158448dcd5d64fe29a1476feb8a48bd989289b`; the frozen source-map digest is `75721ec10fec357f3eaac5109e14d0bf27965f7e6e510d9b52ae13d59b3f9575`. HEAD identifies the checkout baseline; the digest identifies the captured worktree bytes.

The frozen bytes and explicit selected-path provenance remain local under `.engineering-workflow/cache/audio-focus-frozen-source.json` and `audio-focus-cohort-provenance.json`. Selection used lossless UTF-8 reads, exclusions, secret-pattern checks, physical root identity and repeated content checks. No app source or configuration was changed. No Gradle build, dependency download, emulator or model execution was performed by this selection.

Android/JVM tooling and dependency state are not frozen. Existing repository tests are candidate regression checks, not independently reviewed held-out graders. Any Android result must retain the prototype label and distinguish JVM-only tests from device-dependent behavior. This is one selected snapshot, not the required six-snapshot/four-language/30-task cohort.
