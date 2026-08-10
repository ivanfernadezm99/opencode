# Tasks: Cron Update Safety

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~770 (315 cron fix + 145 dedupe + 310 installer) |
| 400-line budget risk | Medium (per-slice); High (whole) |
| Chained PRs recommended | Yes |
| Suggested split | PR1 (cron fix) → PR2 (dedupe CLI) → PR3 (installer safety) |
| Delivery strategy | auto-forecast (orchestrator decides chaining) |
| Chain strategy | pending (team decision; stacked-to-main vs feature-branch-chain) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Cron not-firing root-cause fix + at-most-once (TDD) | PR 1 | jobs.ts + server.ts + jobs.test.ts; independent |
| 2 | `cron dedupe` subcommand (TDD) | PR 2 | cli/cron.ts + cli/cron.test.ts; needed by PR3 |
| 3 | Installer backup/restore/dedupe safety | PR 3 | install.ps1 + test-installer.ps1 static asserts; uses `cron dedupe` (PR2) |

Chain: PR1 → PR2 → PR3 stacked to `dev`. PR3 depends on PR2 (`cron dedupe` referenced by installer). PR1 and PR3 independent.

## Work Unit 1 — Cron fix (TDD: RED → GREEN)

- [x] 1.1 RED: In `packages/opencode/test/cron/jobs.test.ts` add `it.live` case: `create()` without `next_run_at` on an enabled job stores non-NULL future value (spec CRUD "Create and retrieve a job"). Run `bun test test/cron/jobs.test.ts` from `packages/opencode`; expect fail.
- [x] 1.2 RED: cases: create past-computed → NULL; explicit `next_run_at` respected; `enabled=0` → NULL (spec scenarios). Expect fail.
- [x] 1.3 GREEN: In `packages/opencode/src/cron/jobs.ts` `create()` compute `next_run_at` when `input.next_run_at == null && enabled !== 0`, persist only if `computeNextRun(...).getTime() > Date.now()`, else leave undefined (D4/R3r, line 213).
- [x] 1.4 RED: `backfillNextRuns` tests in `jobs.test.ts` using `testEffect(CronJobs.defaultLayer.pipe(Layer.provide(CoreDatabase.layerFromPath(":memory:"))))`: heals enabled NULL, idempotent, skips disabled/invalid/once-expired, per-row error doesn't abort (spec). Seed via `db.insert(CronJobTable)`. Expect fail.
- [x] 1.5 GREEN: Add `backfillNextRuns(): Effect<number, CronJobServiceError>` to `Interface` (jobs.ts:134) + impl (`select where(and(eq(enabled,1), isNull(next_run_at)))`, per-row `computeNextRun`, update only if future, `Effect.ignore` per-row error) + layer return (jobs.ts:362). Return healed count.
- [x] 1.6 RED: `advanceNextRun` once double-fire test: due `once` job → `enabled=0`/`state="completed"`; second `getDueJobs()` excludes it (spec cron-scheduler). Expect fail.
- [x] 1.7 RED: advance-failure isolation test: `advanceNextRun` on removed job → DEFECT caught by `catchCause`, loop continues, ticker fiber survives.
- [x] 1.8 GREEN: Rewrite `advanceNextRun` (jobs.ts:291-313): persist only if `computed > now`; else `once` → `{enabled:0,state:"completed"}`; recurring-invalid → `{enabled:0,state:"error"}` + logError (D11).
- [x] 1.9 GREEN: In `packages/opencode/src/server/server.ts` loop (94-128): call `backfillNextRuns()` once before tick loop; wrap `advanceNextRun(job.id)` in `Effect.catchCause((cause)=>Effect.logError(...))` before `executor.execute(job)` (D2/D3/D12/R2r).
- [x] 1.10 GREEN: Verify: `bun test test/cron/jobs.test.ts` from `packages/opencode`; all green.

## Work Unit 2 — `cron dedupe` subcommand (TDD)

- [x] 2.1 RED: In `packages/opencode/test/cli/cron.test.ts` add `it.live` dedupe cases with real DB: keeps earliest `time_created`; removes later same-name (case-insensitive); skips NULL-named jobs (spec installer "Existing duplicates collapsed"). Expect fail.
- [x] 2.2 GREEN: In `packages/opencode/src/cli/cron.ts` add `DedupeCommand` (`dedupe`): `list()`, group by `name.trim().toLowerCase()` for `name != null`, keep min `time_created`, `remove()` each other id; log `DedupeResult {removed,kept,skippedNull}` (D6). Register in `CronCommand` chain (cron.ts:313).
- [x] 2.3 Verify: `bun test test/cli/cron.test.ts` from `packages/opencode`; green.

## Work Unit 3 — Installer update safety (PowerShell, static asserts)

- [x] 3.1 GREEN: In `install.ps1` rewrite `Backup-Path` (810-844): missing source → skip+note (fresh install, R5r); else `Copy-Item -Recurse -Force -ErrorAction Stop`; non-empty verify for dirs AND files; `$false` on missing/empty; delete enclosing try/catch (842-844, R5).
- [x] 3.2 GREEN: Backup scope: add desktop dir, config (incl. skills), engram, session DBs to `$b` map; abort+restore when source exists but backup missing/empty (D9/D14).
- [x] 3.3 GREEN: `Restore-ClientData` (stop DB holders → overlay restores in order session→desktop→config→engram); `Stop-WithError` → throw + inline restore (D7/C2/W5); wrap `try { Main @mainParams } catch { Restore-ClientData; throw }`; env vars restored in `finally` (W7).
- [x] 3.4 GREEN: Skills copy-only (never Remove-Item; overwrite individual files after backup) + outer skills catch (1105-1108) → FATAL (D8/R4). Desktop app installer catch (1409-1411) → FATAL.
- [x] 3.5 GREEN: Desktop cron block (1414-1458): run `cron dedupe` unconditionally under `XDG_DATA_HOME` redirect; `if ($LASTEXITCODE -ne 0) Stop-WithError` on adds (1441-1445); stamp written only after ALL adds succeed (R4r); MCP parse stays non-fatal (1254-1256).
- [x] 3.6 GREEN: Retention (W8): keep newest 8 `*.backup-*` per family; never delete originals.
- [x] 3.7 Verify: extend `.opencode/scripts/test-installer.ps1` static assertions (backup scope, non-empty verify, missing-source skip, `try{Main}`, copy-only skills, unconditional dedupe, non-zero-exit Stop-WithError, stamp-after-all). Run via `pwsh .opencode/scripts/test-installer.ps1`.

## Phase 4 — Manual verification (no harness)

- [x] 4.1 Windows checklist (installer-update-safety spec): `install.ps1 -Desktop` → each `*.backup-<stamp>` exists & non-empty; `opencode-dev.db` has exactly one `Recordatorio cargar horas Redmine` with non-NULL `next_run_at`; simulated skills failure → `Restore-ClientData` fires; custom user skill under `~/.config/opencode/skills` survives.
