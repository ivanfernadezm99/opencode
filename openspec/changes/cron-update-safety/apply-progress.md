# Apply Progress — Cron Update Safety (Work Unit 1: PR1 cron fix)

**Mode**: Strict TDD (hybrid persistence)
**Work Unit**: 1 — Cron not-firing root-cause fix + at-most-once (PR 1 of 3-chain)
**Files touched**: `packages/opencode/src/cron/jobs.ts`, `packages/opencode/src/server/server.ts`, `packages/opencode/test/cron/jobs.test.ts`
**Status**: Work Unit 1 complete (tasks 1.1–1.10). Ready for next batch / verify on PR1.
## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1 | `test/cron/jobs.test.ts` | Integration (`it.live`) | ✅ 29/29 (after notify-column fix) | ✅ Written (failed) | ✅ Passed | ➖ Single | ✅ Clean |
| 1.2 | `test/cron/jobs.test.ts` | Integration (`it.live`) | ✅ baseline | ✅ Written (past-NULL/invalid/disabled already held) | ✅ Passed | ✅ 4 cases | ➖ None needed |
| 1.3 | `test/cron/jobs.ts` impl | — (GREEN) | ✅ | — | ✅ 34/34 | ✅ via 1.1+1.2 cases | ✅ Clean |
| 1.4 | `test/cron/jobs.test.ts` | Integration (`it.live`) | ✅ 34/34 | ✅ Written (failed: method absent) | ✅ Passed | ✅ 3 cases | ✅ Clean |
| 1.5 | `test/cron/jobs.ts` impl | — (GREEN) | ✅ | — | ✅ 37/37 | ✅ via 1.4 cases | ✅ Clean |
| 1.6 | `test/cron/jobs.test.ts` | Integration (`it.live`) | ✅ 37/37 | ✅ Written (failed) | ✅ Passed | ✅ 2 cases | ✅ Clean |
| 1.7 | `test/cron/jobs.test.ts` | Integration (`it.live`) | ✅ 37/37 | ✅ Written (catchCause contract) | ✅ Passed | ➖ Single | ✅ Clean |
| 1.8 | `test/cron/jobs.ts` impl | — (GREEN) | ✅ | — | ✅ 40/40 | ✅ via 1.6 cases | ✅ Clean |
| 1.9 | `src/server/server.ts` loop | Production loop (no direct unit) | ✅ | — | ✅ via integration path | ➖ Single | ✅ Clean |
| 1.10 | `test/cron/jobs.test.ts` | Verify | — | — | ✅ 40/40 | — | — |

## Test Summary

- **Total tests written (added)**: 11 (5 create + 3 backfill + 2 advance + 1 isolation)
- **Total tests passing**: 40 / 40 (`bun test test/cron/jobs.test.ts`, from `packages/opencode`)
- **Layers used**: Integration (`it.live` / `testEffect`), Unit (existing schema/computeNextRun)
- **Approval tests**: None needed — new behaviors, not refactoring of tested behavior
- **Pure functions created**: none new (computeNextRun already pure; service effects used)

## Deviations from Design

- **Test layer construction** (minor, test-only): design/spec suggested
  `CronJobs.defaultLayer.pipe(Layer.provide(CoreDatabase.layerFromPath(":memory:")))`.
  To seed raw rows via `CoreDatabase.Service` (spec: "Seed via `db.insert(CronJobTable)`"),
  the test layer uses `Layer.provideMerge(CronJobs.layer, CoreDatabase.layerFromPath(":memory:"))`
  instead. This exposes the shared `:memory:` Database to the test scope so backfill/advance
  tests can seed directly. No production-code deviation.
- **Pre-existing test bug fixed** (in-scope file): `createTestDb()` in `jobs.test.ts` was
  missing the `notify` column that the real `CronJobTable` schema added; 5 schema tests were
  failing before any work. Added `notify integer NOT NULL DEFAULT 0` to the helper. Reported
  in this artifact; not silently hidden.

## Issues Found

- None blocking. Documented (design) at-most-once tradeoff: if `advanceNextRun` fails, the loop
  logs via `catchCause` and proceeds to `executor.execute`, accepting a rare at-least-once window
  to keep the ticker alive (D12).

## Remaining Tasks

- Work Unit 2 (tasks 2.1–2.3): `cron dedupe` subcommand — PR 2
- Work Unit 3 (tasks 3.1–3.7): installer update safety — PR 3
- Phase 4 (4.1): manual Windows checklist

## Commit

- Commit: `fix(core): cron jobs born dead with NULL next_run_at` (Work Unit 1, PR1)

---

## Corrective Re-Run (Gate Feedback — 1 of 1)

Reviewer flagged 4 gaps against real code (suite was 40/40 but the following were genuine). All resolved in follow-up commit `b8292b5e91` on top of `983a8e4de0`.

| ID | Severity | Fix | Test evidence |
|----|----------|-----|---------------|
| F1 | blocker | CI forbid-only guard in `.github/workflows/test.yml` before the test step: `grep -rEn --include="*.test.ts" --include="*.test.tsx" -E "(^|[^._A-Za-z0-9])(describe\|test\|it)\.only\(" packages` → exit 1 on match. Verified: matches a `.only` fixture (grep exit 0), no match on clean tree (grep exit 1). No unit test (CI config). | guard CLI check: fixture match + clean-tree no-match |
| F2 | warning | `server.ts` backfill wrapper `Effect.catch` → `Effect.catchCause` — every backfill failure is a DEFECT (select/update are `orDie`), so `Effect.catch` was dead code that would let the defect escape and kill the fiber before the tick loop ("Cron ticker started" never logs). Mirrors D12/R2r. | production-loop change (no direct unit; mirrors already-tested catchCause advance path) |
| F3 | warning | `jobs.ts` backfill: `healed += 1` now only on `Exit.isSuccess(exit)` after `.pipe(Effect.orDie, Effect.exit)`, so a failed per-row UPDATE no longer reports as healed. **RED first**: added test forcing a real per-row failure via a SQLite `BEFORE UPDATE OF next_run_at ... RAISE(FAIL)` trigger on one row; asserted `healed === 1` (was 2) and survivor still heals. | RED: 1 fail → GREEN: 42/42 |
| F4 | warning | recurring-invalid branch (disable + `state="error"` + log) had zero coverage. Added test: due recurring `cron` job with invalid expression → `advanceNextRun` → `enabled=0`, `state="error"`, `getDueJobs()` excludes it. Implementation already present; test is a coverage add (passed immediately). | 42/42 |

**Suite**: `bun test test/cron/jobs.test.ts` from `packages/opencode` → **42 pass / 0 fail** (was 40; +2 tests).

### TDD Cycle Evidence (corrective re-run)

| Fix | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|-----|-----------|-------|------------|-----|-------|-------------|----------|
| F3 | `test/cron/jobs.test.ts` | Integration (`it.live` / `testEffect`) | ✅ 40/40 | ✅ Written (1 fail: healed=2 vs 1) | ✅ Passed (42/42) | ✅ failed-row + survivor in one case | ✅ Clean |
| F4 | `test/cron/jobs.test.ts` | Integration (`it.live`) | ✅ 40/40 | ➖ Coverage add (impl pre-existed) | ✅ Passed | ➖ Single | ✅ Clean |
| F2 | `src/server/server.ts` | Production loop (no direct unit) | ✅ | — | ✅ via integration path | ➖ Single | ✅ Clean |
| F1 | `.github/workflows/test.yml` | CI config (no unit) | N/A | — | ✅ guard CLI verified | ➖ Single | ✅ Clean |

### Test Summary (corrective re-run)

- **Tests written (added)**: 2 (F3 isolation, F4 recurring-invalid)
- **Total passing**: 42 / 42
- **Commit**: `b8292b5e91 fix(core): guard cron safety net against test.only and backfill defects` (follow-up, not history rewrite)

---

## Work Unit 2 — `cron dedupe` subcommand (PR 2)

**Mode**: Strict TDD (hybrid persistence)
**Work Unit**: 2 — `cron dedupe` subcommand (PR 2 of 3-chain, base = dev with PR1 commits)
**Files touched**: `packages/opencode/src/cli/cron.ts`, `packages/opencode/test/cli/cron.test.ts`
**Status**: Work Unit 2 complete (tasks 2.1–2.3). Ready for PR3.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2.1 | `test/cli/cron.test.ts` | Integration (`it.live` / `testEffect`) | ✅ 10/10 (cron.test.ts) | ✅ Written (export `dedupe` missing → RED) | ✅ Passed (14/14) | ✅ 4 scenarios | ✅ Clean |
| 2.2 | `src/cli/cron.ts` impl | — (GREEN) | ✅ | — | ✅ 14/14 | ✅ via 2.1 cases | ✅ Clean |
| 2.3 | `test/cli/cron.test.ts` + `test/cron/jobs.test.ts` | Verify | — | — | ✅ 14/14 + 42/42 | — | — |

### Test Summary

- **Total tests written (added)**: 4 (earliest-kept, case-insensitive collapse, NULL skip, fresh-DB no-op)
- **Total tests passing**: 14 / 14 (`bun test test/cli/cron.test.ts`); regression 42 / 42 (`bun test test/cron/jobs.test.ts`), from `packages/opencode`
- **Layers used**: Integration (`it.live` / `testEffect` + real `:memory:` DB via `CoreDatabase.layerFromPath`)
- **Approval tests**: None — new behavior, not refactoring
- **Pure functions created**: 1 (`dedupe` `Effect.fn`, deterministic list→plan→remove)

### Implementation

- `DedupeResult` interface `{ removed, kept, skippedNull }` exported from `src/cli/cron.ts`.
- `dedupe = Effect.fn("Cli.cron.dedupe")()`: `list()` all jobs → group by `name.trim().toLowerCase()` for `name != null` only → keep earliest `time_created` per group → `remove()` every other id → `Effect.logInfo("DedupeResult", result)` and return the result. NULL-named jobs counted in `skippedNull`, never grouped (C3 fix, D6).
- `DedupeCommand` (`dedupe` subcommand) registered in `CronCommand` chain; `demandCommand` message updated to include `dedupe`.
- Resolves the DB path via the standard `CronJobs.layer` over `Database.defaultLayer` — no hardcoded paths — so PR3 can invoke it under `XDG_DATA_HOME` redirect (W6).

### Deviations from Design

- None — implementation matches design (D6) and spec `Desktop Cron Seeding Dedupe`.

### Issues Found

- Test-only expectation corrected during cycle: `kept` counts distinct kept name-groups (NULL-named jobs are neither kept nor removed; they increment `skippedNull` only). First GREEN run caught the mismatched assertion and the test was corrected to match the contract. No production-code deviation.

### Remaining Tasks

- Work Unit 3 (tasks 3.1–3.7): installer update safety — PR 3 (depends on `cron dedupe`)
- Phase 4 (4.1): manual Windows checklist

### Commit

- Commit: `8612f2933b feat(core): add cron dedupe command` (Work Unit 2, PR2). Staged only the two in-scope files. Not pushed (orchestrator handles chain).

---

## Work Unit 3 — Installer update safety (PR 3)

**Mode**: Strict TDD (hybrid persistence) — PowerShell static-assertion harness (`pwsh .opencode/scripts/test-installer.ps1`, no Pester) + runtime behavioral smoke test of extracted functions.
**Work Unit**: 3 — Installer backup/restore/dedupe safety (PR 3 of 3-chain; base = dev with PR1+PR2; depends on `cron dedupe` from PR2).
**Files touched**: `install.ps1`, `.opencode/scripts/test-installer.ps1`.
**Status**: Work Unit 3 complete (tasks 3.1–3.7). All 3 requirements of `installer-update-safety/spec.md` implemented.

### TDD Cycle Evidence

| Task | Test layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|------------|-----|-------|-------------|----------|
| 3.1 | Static assertion + runtime | ✅ 32 pass / 0 fail baseline | ✅ 22 new asserts failed (RED) | ✅ 55 pass / 0 fail | ✅ 3 Backup-Path runtime cases (dir/file/empty) | ✅ Clean |
| 3.2 | Static assertion + runtime | ✅ | ✅ scope assert failed | ✅ | ✅ runtime: non-empty dir/file, empty dir/file, missing-source | ✅ Clean |
| 3.3 | Static assertion + runtime | ✅ | ✅ try{Main}/Restore/Stop-WithError asserts failed | ✅ | ✅ runtime: Restore-Path overlay + keeps backup | ✅ Clean |
| 3.4 | Static assertion | ✅ | ✅ `Remove-Item on skills dest` RED (B1 found) | ✅ | ✅ | ✅ Clean |
| 3.5 | Static assertion | ✅ | ✅ dedupe/non-zero-exit asserts failed | ✅ | ✅ | ✅ Clean |
| 3.6 | Static assertion + runtime | ✅ | ✅ retention assert failed | ✅ | ✅ runtime: 10→8, original intact | ✅ Clean |
| 3.7 | Static + AST + runtime | ✅ | ✅ new [9] block written first, 22 fail | ✅ | ✅ | ✅ Clean |

### Test Summary

- **Runner**: `pwsh .opencode/scripts/test-installer.ps1 -Path install.ps1` → **55 pass / 0 fail / 4 warnings (pre-existing), exit 0**.
- **Runtime behavioral harness** (functions extracted from install.ps1 via AST, executed with stub writers): **11 pass / 0 fail** — Backup-Path skip/verify (dir+file, empty-dir/empty-file), Retention 10→8 + originals intact, Restore-Path overlay + backup retained.
- **AST hardening**: test [2] previously only checked `ParseInput` didn't throw; it now asserts **0 parse errors** — this caught a real `$Backup:` scope-qualifier parse error I introduced (line 726), fixed with `${Backup}:` delimiter.
- **Layers**: PowerShell static assertions (regex/AST against install.ps1) + runtime behavioral.

### Implementation (matches design round-3)

- **3.1 Backup-Path** (install.ps1 ~692): missing source → `Write-Info` skip + `return $true` (R5r, fresh install); else `Copy-Item -Recurse -Force -ErrorAction Stop`; non-empty verified via `PSIsContainer` (dir child-count) / `Length -eq 0` (file); `return -not $isEmpty`; returns `$false` only when source EXISTS but backup missing/empty. Enclosing try/catch (old 842-844) deleted (R5) so failures propagate → outer restore.
- **3.2 Backup scope**: `$script:backupStamp` (script scope). Backup map `$backupMap` covers `sessionDataDir`, `engramDbDir`, `desktopDataDir`, `globalConfigDir` → each `*.backup-<stamp>`. Any non-empty-verify failure → `Stop-WithError` (abort+restore, D9/D14).
- **3.3 Restore + error semantics**: `Stop-CronHolders` (kills opencode/opencode-desktop/engram for DB locks) → `Restore-Path` overlay-from-backup in order session→desktop→config→engram. `Stop-WithError` now `throw $Message` (terminating, not exit 1) and calls `Restore-ClientData` inline. Main wrapped: `try { Main @mainParams } catch { Restore-ClientData; Write-Err; throw } finally { env restore }`. Env vars (`XDG_DATA_HOME`, `ENGRAM_DATA_DIR`, `GENTLE_AI_CHANNEL`) restored in `finally` (W7). Restore never deletes backups; on failure logs loudly + keeps them.
- **3.4 Copy-only skills + FATAL**: skills block no longer `Remove-Item` the skill dir; backs up `$dest` → `$dest.backup-<stamp>` then copies children via `"$($_.FullName)\*"` with `-Exclude "node_modules"` (children-wildcard verified to avoid nesting). Outer skills catch → `Stop-WithError` (FATAL). Desktop app installer catch → `Stop-WithError` (FATAL).
- **3.5 Desktop cron block**: `cron dedupe` runs UNCONDITIONALLY under XDG redirect BEFORE stamp check (W4); `if ($LASTEXITCODE -ne 0) Stop-WithError` on dedupe and on each add (R4r); stamp (`Set-Content $desktopCronStamp`) written only after all adds succeed. MCP parse catch unchanged (non-fatal).
- **3.6 Retention (W8)**: `Enforce-BackupRetention` keeps newest 8 `*.backup-*` per target family; never deletes originals.
- **3.7 test-installer.ps1**: added section [9] with 23 assertions (backup scope vars, non-empty verify, missing-source skip, `try{Main}`, catch-restore, finally-env, copy-only skills, unconditional dedupe, non-zero-exit Stop-WithError, stamp-after-all, `$script:backupStamp`, Restore-ClientData + callsites). Hardened test [2] to assert 0 parse errors.

### Deviations from Design

- **Retention placement**: `Enforce-BackupRetention` scans each family's *sibling* `*.backup-*` pattern (`$leaf.backup-*` in the parent dir), matching the actual backup naming (`$target.backup-<stamp>`). Design specified intent (newest 8 per family); naming pattern matches implementation.
- **Restore-Path target pre-creation**: creates the target dir if absent before overlay (harmless on restore; target normally exists).
- **Stale-file tradeoff (documented)**: copy-only skills overwrite individual files but do not delete stale files from a prior version (per hard B1 constraint "never Remove-Item skills"). A previous full-replace behavior could leave orphaned skill files; originals/user data are preserved in `$dest.backup-<stamp>`. Acceptable and safer than deletion.

### Issues Found

- **Parse error caught by AST hardening**: my first edit to `Restore-Path` used `"$Backup: ..."` (variable immediately followed by `:`), which is a PowerShell parse error (`': ' not followed by a valid variable name`). The old test [2] missed it (ParseInput doesn't throw); hardened test [2] now asserts 0 errors and it was fixed with `${Backup}:`. This is a genuine PR3 bug fixed during the cycle.

### Remaining Tasks

- Phase 4 (4.1): manual Windows checklist (installer-update-safety spec) — no harness.

### Commit

- Commit: `fix(installer): backup/restore safety + cron dedupe on update` (Work Unit 3, PR3). Staged only `install.ps1` + `.opencode/scripts/test-installer.ps1`. Includes the earlier-session uncommitted install.ps1 change (Get-WindowsVersion/Get-DesktopAppExe/x64-alias guard) from the same file. Not pushed (orchestrator handles 3-PR chain).

---

## Work Unit 3 — Corrective Re-Run (Gate Feedback, 1 of 1)

Two independent reviewers verified the real file and the CRITICAL requirement (no client data loss on any update). All blockers/critical/warnings fixed in a follow-up commit on top of `ed6bf73174` (no history rewrite).

**Runner**: `pwsh .opencode/scripts/test-installer.ps1` → **74 pass / 0 fail / 4 warnings (pre-existing), exit 0** (was 55; +18 RED-gate tests +1 updated R4r assertion). Plus runtime behavioral harness: **5 pass / 0 fail** (B1 quarantine, W9 cache exclusion, W8 sidecar purge, W8b sidecar restore, restoreDone guard).

| ID | Sev | Fix in install.ps1 | Static assert | Runtime assert |
|----|-----|--------------------|---------------|----------------|
| B1 | blocker | `Backup-Path` wraps copy in try/catch; on failure quarantines partial `$Dst` → `*.incomplete-<stamp>` then rethrows, so `Restore-Path` (missing → skip) can never overlay truncated data over live data | ✅ [10.1] | ✅ forced copy failure → quarantined |
| B2 | blocker | `cron dedupe 2>&1 \| Out-Null` removed (PS5.1 NativeCommandError under EAP=Stop aborted every -Desktop update); stderr now redirected to a temp file (`2> $dedupeTmp`), exit code checked via `$dedupeExit` | ✅ [10.2] | — |
| C3 | critical | Desktop installer non-zero exit no longer `Write-Warn`-swallowed → `Stop-WithError "Desktop installer failed (exit N)"` → triggers restore | ✅ [10.3] | — |
| W4 | warning | `taskkill 2>$null` under EAP=Stop wrapped in new `Invoke-TaskKill` helper (EAP=Continue save/restore); all 3 callsites (Stop-CronHolders + 2 in Main) routed through it | ✅ [10.4] | — |
| W5 | warning | User-config cron stamp gated on `-not $cronAddFailed` (set on any failed/errored add) — a failed default-cron seed is retried next update, not permanently skipped | ✅ [10.5] | — |
| W6 | warning | `$script:backupStamp` → `yyyyMMdd-HHmmssfff` (millisecond) so same-second runs never reuse a stamp and `-Force`-overwrite a verified backup | ✅ [10.6] | — |
| W7 | warning | After `Get-WindowsVersion` resolves a version, compare vs `Get-InstalledVersion`; refuse (warn + keep current) a resolved version older than installed | ✅ [10.7] | — |
| W8 | warning | `Restore-Path` purges stale live `-wal`/`-shm` (removes target sidecar when backup lacks it; restores it when present) | ✅ [10.8] | ✅ stale purged / present restored |
| W9 | warning | Desktop-dir backup excludes locked cache subdirs `GPUCache`, `Code Cache`, `Crashpad`, `logs` (B1 quarantine contains any residual damage) | ✅ [10.9] | ✅ cache excluded, real data copied |
| S1 | suggestion | `$script:restoreDone` guard so `Restore-ClientData` runs exactly once (Stop-WithError + outer catch) | ✅ [10.10] | ✅ 4 restore calls once, 2nd is no-op |
| S2 | suggestion | **Documented** (not changed): `Clear-OrphanedShortcuts` still runs before backup — documented in Deviations. | — | — |

### TDD Cycle Evidence (corrective re-run)

| Fix | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|-----|-----------|-------|------------|-----|-------|-------------|----------|
| B1 | test-installer.ps1 [10.1] + runtime | Static + runtime | ✅ 55/0 | ✅ 18 fails | ✅ 74/0 | ✅ forced-failure quarantine + W9 exclude | ✅ Clean |
| B2 | test-installer.ps1 [10.2] | Static | ✅ | ✅ `2>&1\|Out-Null` present → RED | ✅ removed + `2> tmp` | ✅ exit-code check | ✅ Clean |
| C3 | test-installer.ps1 [10.3] | Static | ✅ | ✅ swallowed pattern present → RED | ✅ Stop-WithError | — | ✅ Clean |
| W4 | test-installer.ps1 [10.4] | Static | ✅ | ✅ no helper → RED | ✅ Invoke-TaskKill ×3 | — | ✅ Clean |
| W5 | test-installer.ps1 [10.5] | Static | ✅ | ✅ no flag → RED | ✅ gated stamp | — | ✅ Clean |
| W6 | test-installer.ps1 [10.6] | Static | ✅ | ✅ seconds-only → RED | ✅ `fff` | — | ✅ Clean |
| W7 | test-installer.ps1 [10.7] | Static | ✅ | ✅ no guard → RED | ✅ no-downgrade | — | ✅ Clean |
| W8 | test-installer.ps1 [10.8] + runtime | Static + runtime | ✅ | ✅ no purge → RED | ✅ purge | ✅ stale-purged + present-restored | ✅ Clean |
| W9 | test-installer.ps1 [10.9] + runtime | Static + runtime | ✅ | ✅ no GPUCache → RED | ✅ exclude | ✅ cache skipped / data copied | ✅ Clean |
| S1 | test-installer.ps1 [10.10] + runtime | Static + runtime | ✅ | ✅ no guard → RED | ✅ restoreDone | ✅ runs-once | ✅ Clean |

### Test Summary (corrective re-run)

- **Tests written (added)**: 18 static assertions (section [10]) + 5 runtime behavioral cases. 1 pre-existing [9.8] assertion updated to the corrected R4r contract (dedupe now uses `$dedupeExit -ne 0`; cron-add failure asserted via `Stop-WithError "Failed to create cron"`).
- **Total passing**: 74 / 74 static (exit 0) + 5 / 5 runtime.
- **Commit**: `fix(installer): quarantine partial backups, PS5.1 dedupe, restore correctness` (follow-up on top of `ed6bf73174`; PR3 Work Unit 3).

### Deviations from Design

- **`Clear-OrphanedShortcuts` ordering (S2, documented)**: still runs before the backup (install.ps1 `Main`, before version detection), outside the restore scope. A wrongly-classified shortcut deletion is permanent and not covered by `Restore-ClientData`. Not changed in this corrective run to avoid destabilizing the already-verified shortcut cleanup; the gate's primary data-loss requirement (client session/engram/desktop/config data) is fully covered by the verified backup + quarantine + restore.
- **`cron list` (install.ps1, user-cron block) still uses `& $opencodeExe cron list 2>&1`** — retained because success writes to stdout and the call is already wrapped in try/catch (a NativeCommandError degrades to warn-continue). Only `cron dedupe` (which writes success to stderr) required the PS5.1-safe redirect.
- **Test [9.8] regex updated** to the corrected R4r contract (was coupled to the pre-fix `$LASTEXITCODE -ne 0) { Stop-WithError` dedupe shape). Behavior unchanged: non-zero cron exit → Stop-WithError on both dedupe and adds.

### Remaining Tasks

- Phase 4 (4.1): manual Windows checklist (installer-update-safety spec) — no harness. This corrective run is install.ps1-only; the manual Windows smoke test (backup non-empty, single cron row, simulated skills failure → restore, custom skill survival) remains outstanding on a real Windows host.

---

## Work Unit 3 — Round-4 Corrective Re-Run (runtime-harness gate)

A new **runtime behavioral harness** — `.opencode/scripts/install-runtime-harness.ps1` — extracts install.ps1 functions verbatim via AST and executes them (stubbed writers) to catch runtime bugs that the static-assertion suite (`test-installer.ps1`) cannot. The static suite uses only grep/AST shape checks and had PASSED the two bugs below; only execution found them (**truthful RED: 8 pass / 4 fail** on the unpatched file).

**Runner**: runtime harness → **12 pass / 0 fail**. Static suite still → **97 pass / 0 fail / 4 pre-existing warnings** (verified identical on pre-edit HEAD — not introduced by the round-4 commit).

| ID | Sev | Bug in install.ps1 | Runtime probe (was RED) | Fix |
|----|-----|--------------------|-------------------------|-----|
| R1 | blocker | `Invoke-NativeRedirected` `finally` did `(Get-Content $errTmp -Raw -ErrorAction SilentlyContinue).Trim()` on an EMPTY temp file (the common happy path — cron list/add write stdout only). `Get-Content -Raw` returns `$null` on empty; `.Trim()` on null threw a **terminating error inside the finally block**, which the function's own try/catch could NOT catch → crashed the happy-path restore on every update. | P1-empty-stderr THREW: `You cannot call a method on a null-valued expression` | Null-check before `.Trim()`; only TrimEnd when non-whitespace (PS 5.1-safe; never rely on `-Raw` for empty files). |
| C2 | critical | `Test-CronJobNameExists` used `$line.Substring(40)` — starting AT the 1-char separator and running the whole remainder through `.Trim()` — so it could never equal the bare name → it NEVER matched retry/no-readd idempotence (every update re-added the manifest cron rows). | P4 matcher full=False single=False prefix=False; P9 manifestSeen=False retryNoAdd=False | Extract the name cell starting at column **41** as `name.padEnd(18)` (`[Math]::Max($Name.Length,18)` wide), `TrimEnd`; multi-word manifest names match verbatim, prefix collisions do not. |
| W3 | warning | `$opencodeExe --version 2>&1` (**`--version`** verification, exe path) still merged native stderr under EAP=Stop — same PS5.1 `NativeCommandError` class as the round-3 `cron dedupe` bug (B2), for the exe path. | P10-native-hazard flagged line 1728 | Routed through `Invoke-NativeRedirected` (`--version`), like the OPS cron add/list path; no residual `2>&1` native merge of the exe/cron/dedupe/taskkill paths. |

### TDD Cycle Evidence (round-4 corrective)

| Fix | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|-----|-----------|-------|------------|-----|-------|-------------|----------|
| B1 | install-runtime-harness.ps1 P1/P2/P3 + static [CRITICAL4] | Runtime (AST-extract exec) + static | ✅ 74/0 static | ✅ P1 THREW (8/12) | ✅ 12/12 | ✅ empty vs non-empty stderr + exe-missing | ✅ Clean |
| C2 | harness P4/P9 | Runtime | ✅ | ✅ P4+P9 fail (8/12) | ✅ match + idempotent | ✅ full/single/prefix/absent cases | ✅ Clean |
| W3 | harness P10 | Runtime (whole-source hazard scan) | ✅ | ✅ line 1728 flagged | ✅ no residual 2>&1 merge | ✅ comment-cmd/exe/taskkill/cron scan terms | ✅ Clean |

### Test Summary (round-4 corrective)

- **Runtime harness added**: `.opencode/scripts/install-runtime-harness.ps1` — AST-extracts `Invoke-NativeRedirected`, `Test-CronJobNameExists`, `Backup-Path`, `Restore-Path`, `Enforce-BackupRetention`, `Invoke-TaskKill` etc., stubs writers/markers, executes for real. Plain-text child→parent protocol (`id\tok_int\tdetail`) avoids PowerShell `[switch]`/JSON bool round-trip. 12 probes (P1–P10).
- **Total passing**: runtime 12 / 12; static 97 / 0 / 4 (pre-existing warnings unchanged).
- **psh runtime**: PowerShell 7.6.4 bootstrap to `/tmp/pwsh` (host had none on PATH).
- **Commit**: `579ec8b93b fix(installer): null-safe Invoke-NativeRedirected, correct cron name match` (follow-up on top of `f4b152f63e`; PR3 chain). Staged only `install.ps1` + the harness. Untouched: unrelated desktop/opencode `package.json` bumps, two `*_windows_x64.zip` artifacts.

### Deviations from Design

- **`$opencodeExe --version` verification** moved to `Invoke-NativeRedirected` (Design round-3 documented only `cron dedupe` for the exe/stderr path). The `--version` native merge was the same class of hazard; routed through the runner, exit code checked, both streams captured — no behavior outside verification changed. `$BinaryPath --version` (line ~261, install-time version check) is not a cron/dedupe/taskkill/exe-update path and was intentionally left as-is (out of the gate's path scope).
- **Round-4 is harness-only + install.ps1**: two real bugs were verifiably runtime-only (static suite was green). No new spec/design doc edits; contracts unchanged.

### Remaining Tasks

- Phase 4 (4.1): manual Windows checklist (installer-update-safety spec) — no harness. Manual Windows smoke test (backup non-empty, single cron row, simulated skills failure → restore, custom skill survival) remains outstanding on real Windows.

---

## Work Unit 3 — Post-Gate Hardening (fresh-context reviewer findings)

After the PR3 gate PASSED (commits `579ec8b93b` + `9f1b9f7e3b` on top of `f4b152f63e`, runtime 12/12 + static 97/97), two fresh-context reviewers left 3 MATERIAL warnings, approved to fix now before pushing the 3-PR chain. STRICT TDD kept active; no regressions to round-4 fixes.

**Runner (final)**: runtime harness → **12 pass / 0 fail**; static suite → **103 pass / 0 fail / 4 pre-existing warnings** (was 97; +6 new hardening asserts).

| ID | Sev | Finding | Fix | RED → GREEN |
|----|-----|---------|-----|------------|
| SEC-1 | security | A real Nextcloud token literal was hardcoded (`$NEXTCLOUD_TOKEN = "…"` line 41) and used in Basic-auth headers (~196/338/376). A committed repo must carry NO secret. | `$NEXTCLOUD_TOKEN = if ($env:NEXTCLOUD_TOKEN) { $env:NEXTCLOUD_TOKEN } else { "<unset>" }`. Mirror paths already fail gracefully back to GitHub when auth is unusable. Also removed the same literal from `docs/nextcloud.md`, `docs/releases.md`, and `scripts/sync-to-nextcloud.sh` (that script now refuses when `NEXTCLOUD_SHARE_URL` is unset). | RED: static [SEC-1] "NEXTCLOUD_TOKEN source" failed (literal present). GREEN: env-sourced, no 32+ char literal guard added. |
| PS51-a | warning | `Get-InstalledVersion` still did `& $BinaryPath --version 2>&1` (~261) — under EAP=Stop the first stderr line is a terminating NativeCommandError, silently forcing reinstall and bypassing the no-downgrade guard. | Routed through `Invoke-NativeRedirected` (`2>` temp, exit-gated). | RED: static [12.2] failed. GREEN: `--version` via runner; runtime P10 (widened) flags the OLD line 261, clean after. |
| PS51-b | warning | Skill-dep `bun install` / `npm install ... 2>&1` (~1441/1446/1451) merged native stderr → npm warnings made every skill's deps log as failed and skip on PS5.1. | Replaced `2>&1` with `2>$null`; rely on `$LASTEXITCODE` alone (intent preserved via try/catch). | RED: static [12.3] failed. GREEN: no native merge. |
| PS51-c | warning | `gentle-ai version 2>&1` (~1771) same hazard class. | Routed through `Invoke-NativeRedirected`. | RED: static [12.4] failed. GREEN: clean. |
| P5C | warning | Runtime probe P5c was VACUOUS — `Rename-Item` succeeded (partial renamed away) so the quarantine failure path (`.incomplete` sentinel write + Restore refusal) never executed. | Forced a GENUINE rename failure: pre-create the exact quarantine destination (`$partial.incomplete-<stamp>`) as an existing FILE (dir-onto-file rename fails on Win+Unix) AND blocked the delete fallback with an exclusive lock (Windows `FileShare.None` handle) / read-only nested dir (POSIX `chmod 555`) so `Remove-Item` fails → the `.incomplete` sentinel branch must run and `Restore-Path` must refuse. | RED: old probe reported `partialExists=False` (rename succeeded → branch never ran). GREEN: `partialExists=True, sentinel=True, refuse=False` — failure path genuinely exercised. |
| P10 | warning | P10 regex blind spots — missed `$BinaryPath`, `$gentleExe`, `bun install`, `npm install`, `cmd /c`. | Widened pattern list to those + existing `$opencodeExe/@cronArgs/taskkill/cron/dedupe`, and made it EAP-state-aware so EAP=Continue-wrapped blocks (the sole allowed `cmd /c` at ~1567) are exempt. | RED (widened, against original file): caught lines 261/1441/1446/1451/1771, correctly exempted 1567. GREEN after fix: no residual non-EAPContinued native merge. |
| SCRUB | suggestion | Harness leaves `scratch-*` dirs under the probe TEMP dir at exit. | Added cleanup of `$env:PROBE_TEMP` at harness exit. | Verified: no `install-runtime-scratch-*` remains after a fresh run. |

### TDD Cycle Evidence (post-gate hardening)

| Fix | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|-----|-----------|-------|------------|-----|-------|-------------|----------|
| SEC-1 | test-installer.ps1 [12.1] | Static (regex) | ✅ 97/0 | ✅ literal present → source assert FAIL | ✅ env-sourced + 32+ literal guard | ✅ literal/absent + env path | ✅ Clean |
| PS51-a/b/c | test-installer.ps1 [12.2-12.4] + harness P10 | Static + runtime | ✅ 97/0 + 12/12 | ✅ 3 asserts FAIL (2>&1 present) | ✅ routed/`2>$null` | ✅ each path + residual scan | ✅ Clean |
| P5C | install-runtime-harness.ps1 P5c | Runtime (AST-exec) | ✅ 12/12 | ✅ old probe vacuous (rename succeeded) | ✅ genuine rename-fail + sentinel + refusal | ✅ dir-onto-file + locked-delete | ✅ Clean |
| P10 | harness P10 | Runtime (whole-source scan) | ✅ 12/12 | ✅ widened scan flags 5 lines on original | ✅ 0 residual | ✅ pattern set + EAP-exemption | ✅ Clean |

### Test Summary (post-gate hardening)

- **Tests written (added)**: 6 static assertions (section [12]) + 1 runtime probe rewritten (P5c) + P10 pattern set widened.
- **Total passing**: static **103 / 103** (exit 0); runtime **12 / 12** (exit 0).
- **Secret proof**: a worktree-wide grep for the previous token literal (excluding `.git`) returned **0 matches** in tracked files. Only `git` history retains the old token (see Rotation flag). The literal string itself is intentionally not echoed here.
- **Commit**: `ede756d2b0 fix(installer): remove hardcoded Nextcloud token, seal remaining PS5.1 stderr hazards` (post-gate hardening, on top of `9f1b9f7e3b`; no history rewrite). Untouched/untracked: two `*_windows_x64.zip` + unrelated package.json bumps.

### Deviations from Design

- None for the 3 findings. Additional in-scope hardening: removed the same Nextcloud token literal from tracked `docs/` + `scripts/` (SEC-1 explicitly requires "no secret anywhere in the repo, docs").

### Rotation flag (for the user)

The literal token is in **git history** (`ff9f48efa9` / `94e99622b1`). It MUST be **rotated at Nextcloud** (revoke/recreate the share token) — not done here. After rotation, set `NEXTCLOUD_TOKEN` (installer) / `NEXTCLOUD_SHARE_URL` (sync script) in the runtime environment.

### Remaining Tasks

- Phase 4 (4.1): manual Windows checklist — no harness.
