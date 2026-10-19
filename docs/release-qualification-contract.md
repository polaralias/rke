# Exact-artifact release qualification

RKE 0.1.0 is the initial development version. EWF and the runtime adapter are independently versioned packages. The [candidate declaration](release-completion-status.json) uses schema 3 and deliberately contains no prior release or hosted-pass projection. `node dist/scripts/validate-candidate.js` checks actual package/skill versions, the Tasks workflow pin and ledger agreement. It reports `initial-candidate-unqualified`; `--require-qualified-source` refuses this declaration. Optional `--tarball` captures the actual SHA-256; `--mirror` validates source provenance. None of these operations grants release approval.

`npm run validate:release` checks the inner-loop package contract. Publication separately requires Node >=24.15, clean identified source, byte-identical committed methodology/package inputs, the exact `v<version>` tag, ancestry in `origin/main`, complete runtime and both skill identities, and a reviewed exact-artifact receipt. `node dist/scripts/validate-publication.js --qualification RECEIPT.json --tarball PACKAGE.tgz` validates that receipt before publication. Do not rebuild after qualification.

Receipt schema 1 contains `scope` (`public-beta` or `complete`), `sourceCommit`, `version`, `runtimeDigest`, `skillDigest`, `adapterDigest`, `tarballIntegrity`, `reviewedAt` and exactly seven distinct `gates` (G0–G6). Each gate has a substantive `evidence` reference and matching artifact digests. All gates must pass; only G5 may remain pending for `public-beta`, with the study limitation explicit. Schema, hashes and green fixtures cannot judge independent engineering outcomes.

The protected npm environment supplies reviewed JSON via `vars.RKE_RELEASE_QUALIFICATION`. Missing, stale or incomplete evidence blocks publication. The publisher refuses conflicting registry integrity. Versioning, tagging, history cleanup and local tests never authorize publication.

The [repository intelligence acceptance contract](repository-intelligence-acceptance.md) and [original-skill matrix](legacy-skill-parity-matrix.md) are independent obligations. [Study preregistration](agent-study-contract.md) retains its protected cohort and thresholds. Lack of approved trials or human participants leaves qualification open.

CI targets Node 24.15 and maintained Node 24 on Linux, Windows and macOS. The independent OKF Tasks workflow pins `99a2907181c029446ffaf9c6bff664a7b0ff487c`, with strict contracts and no skips. Its Python environment belongs to the external producer; RKE runtime and distribution remain TypeScript. No hosted result is claimed before this exact committed artifact executes there.

## Verification and publishing authority

The tag workflow follows the same verify-then-publish split as OKF Tasks. Its source checkout, complete deterministic verification, installed-package smoke and exact-artifact qualification run with a read-only GitHub token. Only after qualification does it upload the tested tarball and expose its version/integrity as job outputs.

The npm publisher has no source checkout and runs no repository code. It downloads the verified artifact, checks its SHA-512 against verification output, refuses registry conflicts, and invokes trusted npm with lifecycle scripts disabled. OIDC and attestation permissions exist only in that publishing job. Configure npm trusted publishing for `polaralias/rke`, workflow `publish-release.yml`, environment `npm` before an actual publication; this setup does not publish a version or create a tag.

The GitHub-release job runs only after successful npm publication or exact-integrity readback. It consumes the same artifact without source checkout, and promotes the existing draft or creates one release for the tag. Release Drafter is restricted to trusted `main` and derives its draft version from `package.json`.

The default-branch ruleset requires one approval, code-owner review, resolved conversations and successful `release-gate` plus both supported real-Tasks integration checks. Force pushes and branch deletion are blocked for ordinary updates. Repository administrators may bypass the rules, matching the explicitly selected OKF Tasks policy. `repo-admin.json` records the maintained policy; GitHub readback establishes the actual installed rule.
