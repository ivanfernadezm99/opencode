# Archive Report: Fix Post-Merge Breakage

**Archived**: 2026-07-30
**Source Folder**: `openspec/changes/fix-post-merge-breakage/`
**Archive Folder**: `openspec/changes/archive/2026-07-30-fix-post-merge-breakage/`

## Change Summary

Fix compiler errors, test failures, and runtime crash introduced when upstream rewrote `LayerNode.make()` to a single-arg API and removed `defaultLayer` exports. A compatibility restoration pass — no spec-level behavior change.

## Artifacts

### OpenSpec (Filesystem)
- `proposal.md` ✅
- `tasks.md` ✅ (all 18 tasks checked `[x]`)
- No delta specs — pure fix, no spec-level changes
- `archive-report.md` ✅ (this file)

### Engram Observation Lineage
| Artifact | Observation ID |
|----------|---------------|
| `sdd/fix-post-merge-breakage/proposal` | #2941 |
| `sdd/fix-post-merge-breakage/tasks` | #2942 |
| `fix-post-merge-breakage apply-progress` | #2943 |
| `sdd/fix-post-merge-breakage/verify-report` | #2945 |

## Verification

- **Verdict**: PASS
- **Verdict Reason**: All 18 tasks implemented and verified
- **CRITICAL Issues**: None
- **Tests**: packages/core 1090 pass ✅, packages/opencode 54 pass ✅
- **Typecheck**: packages/core 0 errors ✅, packages/llm 0 errors ✅, packages/opencode 29 pre-existing errors (upstream divergence, no regressions)

## Specs Synced

None — this was a pure fix with no spec-level requirements change. No delta specs existed to merge into main specs.

## Key Changes Applied

- `LayerNode.make()` API fix in `identity/index.ts` and `provider/budget.ts` (single-arg `MakeInput` object)
- `defaultLayer` exports restored to 16 modules
- `TokenBalanceTable` test updated with `lastAllowanceMonth` column
- Event manifest snapshot verified (no change needed)
- 40/69 typecheck errors fixed, 0 regressions

## SDD Cycle

This change has been fully planned, implemented, verified, and archived.
