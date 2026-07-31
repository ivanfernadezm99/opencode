# Archive Report: fix-microsoft-login-models

**Archived**: 2026-07-31
**Source Folder**: `openspec/changes/fix-microsoft-login-models/`
**Archive Folder**: `openspec/changes/archive/2026-07-31-fix-microsoft-login-models/`

## Status

ARCHIVED — success (partial lifecycle: explore-only folder, artifacts reconstructed from implemented code)

## Executive Summary

MS-SSO users (authenticated only via the Microsoft Entra ID gate) saw an empty model list because the `models.dev` catalog has no `microsoft` provider and three guards in provider init silently dropped plugin-defined providers missing from that catalog. The fix: `mergeProvider` registers a minimal provider from the plugin patch, the plugin models-hook loop creates a catalog stub and tolerates missing auth entries, the plugin auth loader loop runs with a stub entry, and `MicrosoftAuthPlugin` exposes a `models` hook (GitHub Models inference, `@ai-sdk/openai-compatible`, `MICROSOFT_MODELS`/`MICROSOFT_MODELS_BASE_URL` overrides). Implemented directly in commit `1620364e1` ("fix(opencode): register plugin-only providers without models.dev entry") on `dev-fork-snapshot` (2026-07-31) — outside the SDD apply flow.

## Task Completion Gate

The change's SDD lifecycle never produced proposal/spec/tasks artifacts — only `explore.md`. Per orchestrator instruction, minimal artifacts were reconstructed from the existing exploration AND the implemented commit (no re-implementation). All 7 reconstructed tasks are marked `[x]`; the tasks file carries a lifecycle note recording the direct-implementation history. Gate passed with explicit orchestrator approval for the partial lifecycle.

## Artifacts

### OpenSpec (Filesystem)
- `explore.md` ✅ (original artifact — root-cause analysis and approach recommendation)
- `proposal.md` ✅ (reconstructed at archive from explore.md + commit 1620364e1)
- `specs/microsoft-auth/spec.md` ✅ (delta spec — created at archive, merged into main spec)
- `tasks.md` ✅ (reconstructed at archive, 7/7 complete)
- `archive-report.md` ✅ (this file)

### Engram Observation Lineage
| Artifact | Observation ID |
|----------|---------------|
| Prior state note (bug still open, 13:34) | #2970 |
| Original exploration | #2259 |
| `sdd/fix-microsoft-login-models/archive-report` | (this run) |

Note: #2970 (2026-07-31 13:34) recorded the bug as still open; commit `1620364e1` (15:48) landed after that note and resolved it.

## Specs Synced

| Domain | Action | Details |
|--------|--------|---------|
| microsoft-auth | Updated | 1 requirement ADDED (Plugin-Only Provider Model Registration) with 3 scenarios; merged into existing `openspec/specs/microsoft-auth/spec.md`. |

## Delta Spec Sync Details

The delta spec was created from the implemented behavior (commit `1620364e1` diff: `provider.ts` three-guard relaxation + `microsoft.ts` models hook) and the exploration's recommended Phase 1. Merged into the existing main spec `openspec/specs/microsoft-auth/spec.md` after the Error Handling requirement, preserving all pre-existing requirements and scenarios.

## Source Control Status

- Implementation commit: `1620364e1` (dev-fork-snapshot, 2026-07-31)
- Archive moved via `git mv` — pending orchestrator commit (archive-only work; no commits made by the archive executor)

## Risks

- Proposal/tasks were reconstructed at archive time from the commit + exploration, not authored during the original cycle. The commit message and diff served as the source of truth for scope.
- Phase 2 of the exploration (serving actual model requests through the Microsoft OAuth token) remains unimplemented — recorded as future work in proposal Out of Scope.

## Next Recommended

none — SDD cycle closed. Optional follow-up: Phase 2 model serving (out of scope, documented in proposal).

## Skill Resolution

paths-injected — `sdd-archive/SKILL.md` (config), `_shared/sdd-phase-common.md`, `_shared/openspec-convention.md`, `_shared/persistence-contract.md`, `_shared/engram-convention.md`, `_shared/sdd-status-contract.md`
