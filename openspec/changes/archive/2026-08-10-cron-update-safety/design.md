# Design: Cron Update Safety (CORRECTED — round 2)

**Status**: `design`
**Change**: `cron-update-safety`
**Mode**: hybrid (filesystem + Engram)

## Corrections Applied

### Round 1

| ID | Severity | Fix applied in this design |
|----|----------|----------------------------|
| C1 | critical | Backfill + advance-before-exec live in the **production loop in `server.ts`** (`getDueJobs()` → `advanceNextRun()` → `executor.execute()`), NOT `scheduler.ts` (`CronScheduler.layer` is dead code). `server.ts` added to File Changes. |
| C2 / W5 | critical | `Stop-WithError` no longer `exit 1`s; it invokes `Restore-ClientData` (when a backup stamp exists) then throws a terminating error. `Main @mainParams` wrapped in `try/catch → Restore-ClientData`. |
| C3 | critical | `cron dedupe` groups only jobs with `name != null`; NULL-named jobs are skipped entirely. |
| W1 | warning | `scheduler.ts start()` is a no-op; backfill fix placed in `server.ts`, not the dead layer. `scheduler.ts` untouched. |
| W2 | warning | `computeNextRun` returns a **past `Date`** for `once`-expired (null only for invalid). Persist only when `computed > now`. |
| W3 | warning | Tests **MODIFIED** at `test/cron/jobs.test.ts` + `test/cli/cron.test.ts`; use `testEffect(CronJobs.defaultLayer.pipe(Layer.provide(CoreDatabase.layerFromPath(":memory:"))))`. |
| W4 | warning | `cron dedupe` runs **unconditionally** before the stamp check (already-stamped clients hold the 2 duplicates). |
| B1 | blocker | Skills install **copy-only**; never `Remove-Item` user skills dir; overwrite individual files only after backup; errors terminating. |
| B2 | blocker | Backups **verified** (existence + non-empty) before any destructive step; missing mandatory backup → abort. |
| B3 | critical | Dedupe uses exact full-name, case-insensitive matching against desktop DB; no partial regex. |
| B4 | critical | Restore covers DB-lock holders, overlay-vs-replace, ordering, restore-failure handling. |
| W6 | warning | `cron dedupe` under desktop `XDG_DATA_HOME` redirect (targets `opencode-dev.db` = channel `dev`). |
| W7 | warning | `XDG_DATA_HOME` / `ENGRAM_DATA_DIR` restored in `finally`. |
| W8 | warning | Backup retention: keep newest N stamps, never delete originals. |

### Round 2 (residual gate)

| ID | Severity | Fix applied in this design |
|----|----------|----------------------------|
| R1 | critical | `advanceNextRun` persists **future-only**; `once`-expired → **mark done** (`enabled=0`, `state="completed"`) instead of persisting a past `next_run_at`. Recurring-invalid → disable + log (breaks due-loop). At-most-once now holds for `once` jobs. See D11. |
| R2 | critical | `advanceNextRun(job.id)` in the loop is wrapped in **`Effect.catchCause((cause) => Effect.logError("Cron advanceNextRun failed", cause))`** so a per-job failure (e.g. `Job not found`) never reaches "Cron ticker crashed" and kills the fiber. `catchCause` is required (not `Effect.catch`) because jobs.ts throws `CronJobServiceError` synchronously inside `Effect.map` after `orDie`, which Effect 4.0.0-beta.83 converts to a **defect** (`die`), and `Effect.catch` handles only typed failures. See D12. |
| R3 | warning | Spec wording corrected: `once`-expired returns a **past timestamp**, not null; guard is `computed > now`. `cron-job-storage/spec.md` and `cron-scheduler/spec.md` updated. |
| R4 | critical | **Swallow-catches removed/replaced** per block so errors reach the outer restore path: skills (1105-1108) → FATAL; desktop app installer (1409-1411) → FATAL; desktop cron adds (1446-1448) → FATAL; MCP parse (1254-1256) → non-fatal (parse-only, no mutation). See D13. |
| R5 | critical | Backup block **catch-and-continue (842-844) deleted** so backup-verification failures abort with restore (B2 no longer regresses). `Backup-Path` tightened: **missing source → `$false`**; non-empty verified for dirs AND files. See D14. |

### Round 3 (final corrective gate)

| ID | Severity | Fix applied in this design |
|----|----------|----------------------------|
| R2r | critical | `advanceNextRun(job.id)` isolation switched from `Effect.catch` to **`Effect.catchCause`**. jobs.ts:297 throws `CronJobServiceError` synchronously inside `Effect.map` on the `orDie` DB path → Effect 4 beta.83 converts sync throws in continuations to **defects** (`die`), which `Effect.catch` (typed-failure only) cannot handle; `catchCause` catches both typed failures and defects. Ticker survives the removed-job DEFECT path. See D12. |
| R3r | warning | `create()` future-guard made explicit in spec: persist **only when computed value is strictly in the future**, else store NULL. Aligned requirement/scenario text in `cron-job-storage/spec.md` and design body. See D4. |
| R5r | critical | **Fresh-install semantics restored** (matches install.ps1:839-841). `Backup-Path` aborts only when the source **exists but its backup is missing/empty**; a legitimately absent source (`-not (Test-Path $Src)`) is **skipped with a note**, not a fatal error — so a fresh install with no `~/.engram`/session/desktop/config dirs no longer aborts on the primary `irm\|iex` path. Non-empty verification kept for dirs AND files. See D14. |
| R4r | critical | Desktop cron adds (install.ps1:1441-1445) made **FATAL on non-zero exit** — native exit codes never throw under `$ErrorActionPreference="Stop"`, so the warn-and-continue path was the primary failure mode, not the exception catch (1446-1448). Added `if ($LASTEXITCODE -ne 0) { Stop-WithError ... }` (mirrors desktop-app-installer block 6) and the **stamp write (1450-1453) runs only after ALL adds succeed** — a failed `cron add` no longer stamps a version with cron silently absent. See D13. |

## Technical Approach

**Cron** (Approach 1): `CronJobs.create()` computes `next_run_at` when omitted/explicit-null and the job is enabled, persisting only when `computeNextRun(job)` yields a **future** timestamp. `backfillNextRuns()` heals `next_run_at IS NULL AND enabled=1` rows idempotently. Both feed the **production loop in `server.ts`**: `backfillNextRuns()` once before the loop, then per due job `advanceNextRun(id)` **before** `executor.execute(job)` (at-most-once). `advanceNextRun` is future-only and, for a not-future `once` job, marks it done — so a `once` job fires at most once even across a >60s execution (600s executor timeout). **Installer** (Approach 4): backup scope extended to desktop dir/config/skills with non-empty verification; `Restore-ClientData`; swallow-catches removed so failures restore; `cron dedupe` under the desktop XDG redirect.

## Architecture Decisions

| # | Decision | Options | Choice & rationale |
|---|----------|---------|--------------------|
| D1 | Where scheduler fix lands | wire `CronScheduler.layer`; fix inline loop in `server.ts` | **Fix `server.ts` inline loop.** It is the only production scheduler; `CronScheduler.layer` is dead. |
| D2 | Backfill trigger | scheduler `start()`; per tick; **once before loop** | **Once before the tick loop** in `server.ts`. Idempotent (`WHERE next_run_at IS NULL`). |
| D3 | At-most-once | rely on exec side-effects; **advance-before-exec** | **`advanceNextRun(id)` before `executor.execute(job)`**; a re-tick 60s later sees the advanced future value. |
| D4 | `create()` next_run_at | compute on omitted only; **omitted+explicit-null, future-only** | Compute when `input.next_run_at == null` AND `enabled !== 0`; persist **only if computed > now**. Explicit non-null never overwritten. |
| D5 | `once`-expired in backfill | backfill past dates; **skip** | `computeNextRun` returns a past `Date` for expired `once` (null only for invalid). Guard `computed > now` → expired stays NULL. |
| D6 | Dedupe key | partial regex; **exact full-name** | **Exact, case-insensitive** full-name via `cron dedupe`; NULL-named jobs excluded from grouping. |
| D7 | Restore hook | `exit`; **throw + try/catch around Main** | **Throw** so explicit failures and `$ErrorActionPreference="Stop"` propagations reach `try/catch → Restore-ClientData`. |
| D8 | Skills install | delete+copy; **copy-only** | **Never delete the user skills dir.** Overwrite individual files only after backup; errors terminating. |
| D9 | Backup verification | best-effort; **verify before mutate** | **Verify** each `*.backup-<stamp>` exists and is non-empty before any destructive step; abort on missing mandatory backup. |
| D10 | Dedupe placement | stamp-guarded; **unconditional before stamp check** | **Unconditional**, because already-stamped clients hold the 2 duplicates. |
| D11 | `advanceNextRun` on not-future | persist past; **future-only + mark done** | Persist only when `computed > now`. `once` + not-future → `enabled=0`,`state="completed"` (no past `next_run_at` persisted, no re-fire). Recurring-invalid → disable + log (breaks hot due-loop). |
| D12 | advance failure isolation | unguarded (kills ticker); **catch → logError** | **`Effect.catchCause((cause) => Effect.logError("Cron advanceNextRun failed", cause))`** (not `Effect.catch`): jobs.ts throws `CronJobServiceError` synchronously inside `Effect.map` after `orDie`, which Effect 4 beta.83 turns into a DEFECT (`die`); `catchCause` is required to also catch defects, mirroring executor.execute. Loop continues. Rare at-least-once window on advance failure is accepted (documented). |
| D13 | Swallow-catches | keep (silent); **remove / Stop-WithError per block** | **Skills, desktop app installer, desktop cron adds → FATAL** (mutate backed-up data; propagate to restore). **MCP parse (1254-1256) → non-fatal** (parse-only, no mutation; write-back at 1261 already uncaught/FATAL). Backup block catch deleted (R5). |
| D14 | `Backup-Path` verification | missing source → `$true`; missing source → `$false` (abort); **missing source → skip + note** | Mandatory backup = source exists AND backup non-empty (dirs AND files). A **legitimately absent source is skipped with a note** (fresh-install semantics, install.ps1:839-841); abort with restore ONLY when the source exists but its backup is missing/empty. |

## Data Flow

```
server.ts listenEffect ──▶ CronJobs.backfillNextRuns()  [once, WHERE next_run_at IS NULL AND enabled=1]
   │   └─▶ per row computeNextRun ── future? ──▶ UPDATE next_run_at     (2nd run selects 0 rows)
   └─▶ tick loop every 60s:
        getDueJobs() ──▶ for each job:
             advanceNextRun(id) ──Effect.catchCause(logError)──▶ executor.execute(job) ──forkIn(state.scope)
             # advance: future? persist : once→enabled=0/completed | recurring→disable+log

create() ── enabled? AND next_run_at==null ──▶ computeNextRun ── future? ──▶ persist
                                          past/invalid ─▶ stays NULL

install.ps1 Main ──▶ [verified backup] ──▶ binary swap ──▶ skills/desktop/MCP (FATAL, no swallow)
   ──▶ any terminating error ──▶ try/catch ──▶ Restore-ClientData ──▶ kill DB holders ──▶ overlay *.backup-<stamp>
   desktop cron block ──▶ XDG_DATA_HOME=desktopDataDir ──▶ cron dedupe (unconditional) ──▶ stamp
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/opencode/src/server/server.ts` | **Modify** | Add `backfillNextRuns()` before loop; `advanceNextRun(job.id).pipe(Effect.catchCause(logError))` before `executor.execute(job)` (R2r, R1). |
| `packages/opencode/src/cron/jobs.ts` | Modify | `create()` future-only compute; `advanceNextRun` future-only + once-done (D11); add `backfillNextRuns` to `Interface`+impl+layer. |
| `packages/opencode/src/cli/cron.ts` | Modify | Add `dedupe` subcommand (exact full-name, case-insensitive; skip NULL names; keep earliest `time_created`). |
| `packages/opencode/test/cron/jobs.test.ts` | **Modify** | Add computeNextRun/create/backfill/advance cases (incl. once double-fire, advance-failure isolation) using `testEffect(...)`. |
| `packages/opencode/test/cli/cron.test.ts` | **Modify** | Add `dedupe` cases (incl. NULL-name skip) using `testEffect` + real DB. |
| `install.ps1` | Modify | Verified non-empty backup; delete backup catch (842-844, R5); fresh-install skip restored (R5r); `Restore-ClientData`; `Stop-WithError` throw+restore; `try/catch` around Main; copy-only skills + remove outer skills catch (1105-1108, FATAL); desktop app installer FATAL (1409-1411); desktop cron adds FATAL on non-zero exit (1441-1445) + stamp only after all adds (R4r); MCP parse stays non-fatal (1254-1256); unconditional `cron dedupe` under XDG redirect; env restore in `finally`. |
| `.opencode/scripts/test-installer.ps1` | **Modify** | Assertions for new backup scope, non-empty verification, removed swallow-catches, `try { Main }`, copy-only skills, unconditional dedupe. |
| `openspec/changes/cron-update-safety/specs/cron-job-storage/spec.md` | **Modify** | Correct once-expired wording (R3). |
| `openspec/changes/cron-update-safety/specs/cron-scheduler/spec.md` | **Modify** | Correct once-job scenario wording (R3). |

`packages/opencode/src/cron/scheduler.ts`, `defaults.ts` — **unchanged** (dead / healed via `create()`).

## Interfaces / Contracts

```ts
// jobs.ts — advanceNextRun: future-only + once-done (D11)
const advanceNextRun = Effect.fn("CronJobs.advanceNextRun")((id: string) =>
  mapError(Effect.gen(function* () {
    const row = yield* select where id ... orDie(throw Job not found)
    const computed = computeNextRun(row, new Date())
    if (computed && computed.getTime() > now()) {
      yield* update({ next_run_at: computed.getTime(), time_updated })     // future
    } else if (row.schedule_kind === "once") {
      yield* update({ enabled: 0, state: "completed", time_updated })      // mark done
    } else {
      Effect.logError("Cron advanceNextRun: cannot advance", row)          // recurring invalid → disable, no hot loop
      yield* update({ enabled: 0, state: "error", time_updated })
    }
    return rowToJob(select row)
  })),
)

// jobs.ts — backfillNextRuns (Interface + impl + layer)
readonly backfillNextRuns: () => Effect.Effect<number, CronJobServiceError>
// select where(and(eq(enabled,1), isNull(next_run_at))).all()
//   → per row: const d = computeNextRun(row); if (d && d.getTime() > now()) update(next_run_at)
//   → returns healed count; per-row failure ignored (Effect.ignore), not aborting

// jobs.ts — create() rule (persist future only — strictly in the future, else NULL) — R3r
const enabled = input.enabled ?? 1
if (input.next_run_at == null && enabled !== 0) {
  const d = computeNextRun({ schedule_kind: input.schedule_kind, schedule_expr: input.schedule_expr })
  if (d && d.getTime() > Date.now()) nextRunAt = d.getTime()   // persist ONLY if strictly future; past/invalid → stays NULL
}

// server.ts — production loop, per due job (D12, R2r): catchCause so the sync-throw
// DEFECT from jobs.ts:297 (removed job) is caught too, not just typed failures.
for (const job of due) {
  yield* cronJobs.advanceNextRun(job.id).pipe(
    Effect.catchCause((cause) => Effect.logError("Cron advanceNextRun failed", cause)),
  )
  yield* executor.execute(job).pipe(
    Effect.catchCause((e) => Effect.logError("Cron job failed", e)),
    Effect.forkIn(state.scope),
  )
}

// cli/cron.ts — dedupe command (group by normalized full name, non-null)
interface DedupeResult { removed: number; kept: number; skippedNull: number }
// list() → Map<string, CronJob> keyed by name.trim().toLowerCase() for name != null
//   keep min(time_created) per key; remove() every other id
```

Installer (`install.ps1`) — verified backup + no swallow (R5, R4):

```powershell
# (1) Backup — VERIFIED, non-empty, copy-only (D9/D14, R5r)
$script:backupStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
function Backup-Path($Src, $Dst) {
  if (-not (Test-Path $Src)) { Write-Info "Skipping backup: source absent (fresh install) $Src"; return $true }  # skip, NOT fatal (R5r)
  Copy-Item -Path $Src -Destination $Dst -Recurse -Force -ErrorAction Stop
  if (-not (Test-Path $Dst)) { return $false }
  $item = Get-Item $Dst
  $isEmpty = if ($item.PSIsContainer) { (Get-ChildItem $Dst -Force -EA SilentlyContinue).Count -eq 0 }
             else { $item.Length -eq 0 }
  return -not $isEmpty                                               # non-empty required (dirs AND files)
}
$b = @(
  @{ Src=$sessionDataDir;  Dst="$sessionDataDir.backup-$script:backupStamp" },   # opencode*.db (+wal/shm)
  @{ Src=$engramDbDir;     Dst="$engramDbDir.backup-$script:backupStamp" },      # engram.db (+wal/shm)
  @{ Src=$desktopDataDir;  Dst="$desktopDataDir.backup-$script:backupStamp" },   # %APPDATA%\ai.opencode.desktop.dev
  @{ Src=$globalConfigDir; Dst="$globalConfigDir.backup-$script:backupStamp" },  # ~/.config\opencode (incl. skills)
)
$b | ForEach-Object { if (-not (Backup-Path $_.Src $_.Dst)) { Stop-WithError "Backup missing/empty for existing source $($_.Src)" } }
# NOTE: the enclosing `try{...}catch{Write-Warn continue}` at 842-844 is DELETED (R5)
#   so backup-verification failures / Stop-WithError abort reach the outer try/catch → Restore-ClientData.
#   Fresh-install skip restored (R5r): a source that never existed is skipped, never aborted.

# (2) Restore — precise semantics (B4) — unchanged
function Restore-ClientData {
  if (-not $script:backupStamp) { return }
  Stop-CronHolders
  Restore-Path "$sessionDataDir.backup-$script:backupStamp" $sessionDataDir   # 1. session DBs
  Restore-Path "$desktopDataDir.backup-$script:backupStamp"  $desktopDataDir  # 2. desktop dir (+ opencode-dev.db)
  Restore-Path "$globalConfigDir.backup-$script:backupStamp" $globalConfigDir # 3. config (incl. skills)
  Restore-Path "$engramDbDir.backup-$script:backupStamp"     $engramDbDir     # 4. engram DB
  # copy-only overlay; originals never deleted; if restore fails: log loudly, keep backups, exit non-zero.
}

# (3) Stop-WithError — throw + inline restore (C2/W5) — unchanged
function Stop-WithError { param([string]$Message)
  Write-Err $Message; Restore-ClientData; Stop-Transcript | Out-Null
  throw $Message }

# (4) Wrap Main (single restore hook)
try { Main @mainParams }
catch { Restore-ClientData; Write-Err "Install failed — client data restored. Backups: *.backup-$script:backupStamp"; throw }

# (5) Skills — copy-only AND FATAL (R4): the outer `catch{Write-Warn continue}` (1105-1108) is DELETED,
#     so a skills failure propagates → Restore-ClientData. Keep the `finally` for tempDir cleanup.
Get-ChildItem $downloadedSkills -Directory | ForEach-Object {
  $dest = Join-Path $skillsDir $_.Name
  if (Test-Path $dest) { Copy-Item $dest "$dest.backup-$script:backupStamp" -Recurse -Force -ErrorAction Stop }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force -Exclude "node_modules" -ErrorAction Stop
}

# (6) Desktop app installer — FATAL (R4): replace catch{Write-Warn} (1409-1411) so a thrown error
#     propagates → Restore-ClientData. Non-zero exit → Stop-WithError (not Write-Warn).
# (7) Desktop cron adds — FATAL (R4r): primary failure path is the non-zero-exit branch
#     (install.ps1:1441-1445) — native exit codes never throw under $ErrorActionPreference="Stop",
#     so the old catch(Write-Warn) at 1446-1448 was never the real failure path. On non-zero exit,
#     Stop-WithError (mirrors desktop-app-installer block 6). Run `cron dedupe` (unconditional) before
#     adds under XDG redirect. The stamp write (install.ps1:1450-1453) runs ONLY after ALL adds succeed —
#     a failed `cron add` must not leave a stamp with cron silently absent.
# (8) MCP parse (1254-1256) — NON-FATAL: parse-only, no state mutation; keep Write-Warn + continue.
#     The write-back at 1261 has no catch and already propagates (FATAL) → Restore-ClientData.
# (9) Retention (W8): keep newest 8 *.backup-* per target family, never delete originals.
```

## Testing Strategy

Strict TDD (`bun test` from `packages/opencode`). Tests exercise the production path the way `server.ts` calls it.

| Layer | What to test | Approach |
|-------|-------------|----------|
| Unit | `computeNextRun`: cron/interval/once; invalid→null; **once-expired→PAST Date (not null)** | plain `test` in `jobs.test.ts` (existing pattern) |
| Integration | `create()` rule: omitted→computed future; explicit non-null→respected; explicit-null→computed; `enabled=0`→NULL; once-past→NULL | `testEffect(CronJobs.defaultLayer.pipe(Layer.provide(CoreDatabase.layerFromPath(":memory:"))))` |
| Integration | `backfillNextRuns`: heals NULL enabled; idempotent; skips disabled/invalid/once-expired; per-row error doesn't abort | same `testEffect`, seed via `db.insert(CronJobTable)` |
| Integration | **`advanceNextRun` once double-fire**: a due `once` job is marked `enabled=0`/`completed`, so a second `getDueJobs()` tick excludes it | `testEffect`; assert no re-fire |
| Integration | **advance failure isolation**: `advanceNextRun` on a removed job (service-level `Job not found` becomes a DEFECT via sync throw inside `Effect.map`) is caught by `catchCause` and does not abort the loop / kill the ticker fiber | `testEffect`; seed+remove a due job, tick, assert loop continues AND the ticker fiber survives |
| Integration | Production loop contract: `getDueJobs()` → `advanceNextRun(id)` → healed future value; next tick excludes job | `testEffect` |
| Unit | `cron dedupe`: keeps earliest `time_created`; removes later same-name (case-insensitive); **skips NULL-named jobs** | `testEffect` + real DB in `cli/cron.test.ts` |
| PowerShell | backup non-empty verification; missing-source → **skip** (fresh install) vs existing-but-empty → abort; removed swallow-catches; `try { Main }`; copy-only skills; unconditional dedupe; desktop cron non-zero exit → Stop-WithError; stamp only after all adds succeed | extend `.opencode/scripts/test-installer.ps1` static assertions |

**Windows client manual checklist** (no Pester harness): (1) run `install.ps1 -Desktop`; confirm each `*.backup-<stamp>` exists AND is non-empty for desktop dir, config, skills, `engram.db`, `opencode*.db`. (2) `opencode-dev.db` has exactly one `Recordatorio cargar horas Redmine` (after unconditional dedupe) with non-NULL `next_run_at`. (3) Simulate a failure in the skills block → confirm `Restore-ClientData` fires and data intact, backups retained. (4) User-created custom skill under `~/.config/opencode/skills` survives intact.

## Migration / Rollout

`backfillNextRuns()` heals existing client DBs on next app/server start — no manual step. Desktop duplicates collapse on next `-Desktop` update via unconditional `cron dedupe`. Once-expired jobs are cleaned (marked done) on their next due scan, not backfilled. Backups retained per retention policy (newest 8 per family; originals never deleted).

## Open Questions

- None blocking. Out of scope (flagged): executor `job.skills` loading; notify UX. Documented tradeoff (D12): an `advanceNextRun` failure logs and continues to execute, accepting a rare at-least-once window to keep the ticker alive.

## Next Recommended

`tasks` (sdd-tasks).
