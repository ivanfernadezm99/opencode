# Proposal: cron-update-safety

## Intent

Cron "Recordatorio cargar horas Redmine" (Mon-Fri 17:30, notify) never fires. Root cause: `CronJobs.create()` writes `next_run_at: input.next_run_at ?? undefined` → NULL whenever the caller omits it; `getDueJobs()` filters `next_run_at <= now()`, which NULL never satisfies, so the job is permanently dead. Every seeded/added job (`seedDefaultCrons()`, `cron add`) is born dead. User requirement is CRITICAL: **"no quiero perder nada, absolutamente nada del avance del cliente"** — no user skills, Engram DB, sessions, or client progress may be lost on any update, and this must hold on EVERY machine via `install.ps1`.

## Scope

### In Scope
- Fix `create()` to self-compute `next_run_at` when omitted (root-cause fix heals seeder + `cron add`).
- Idempotent backfill of NULL `next_run_at` for enabled jobs (scheduler start / `getDueJobs`) to repair already-broken client DBs.
- Installer: name-dedupe desktop cron block (today creates duplicates).
- Installer: extend pre-update backup to desktop app data dir + global config + skills; add restore-on-error semantics.
- Cleanup of the 2 duplicate jobs already in the client DB (dedupe migration keyed on job name).
- Persist this safety requirement to Engram + local docs.

### Out of Scope
- Executor `job.skills` loading gap (attach skill tools) — deferred, flagged.
- notify-gating UX (auto-run headlessly vs. Yes click) — deferred, flagged.
- Migrate-SessionDatabase across desktop channel — separate concern.

## Capabilities

### New Capabilities
- `installer-update-safety`: pre-update backup of all client data (desktop dir, config, skills), restore-on-error, desktop cron name-dedupe.

### Modified Capabilities
- `cron-job-storage`: `create()` MUST compute `next_run_at` when omitted; backfill MUST heal NULL enabled jobs idempotently.
- `cron-scheduler`: MUST backfill NULL `next_run_at` for enabled jobs at start; leave invalid/`once`-expired jobs untouched.

## Approach

Approach 1 (recommended): compute inside `create()` using existing exported `computeNextRun()` + idempotent backfill in scheduler start. Approach 4 travels with it: dedupe desktop cron by name before add; extend `install.ps1` backup to `%APPDATA%\ai.opencode.desktop.dev`, global config, skills; copy backups before binary swap; restore on any error.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/opencode/src/cron/jobs.ts` | Modified | `create()` next_run_at; backfill; getDueJobs NULL handling |
| `packages/opencode/src/cron/scheduler.ts` | Modified | Backfill on start |
| `packages/opencode/src/cron/executor.ts` | Deferred | skills loading / notify UX (flag only) |
| `install.ps1` | Modified | Backup scope, restore-on-error, desktop cron dedupe |
| `.opencode/default-crons.json` | Reference | Manifest source of truth |

## Decision Requests (open questions answered)

1. **Desktop (channel `dev`) is the target**: fix must heal `opencode-dev.db` specifically.
2. **Backup full `%APPDATA%\ai.opencode.desktop.dev`** (dir) + config + skills, not just DB — nothing may be lost.
3. **Duplicate cleanup**: automated dedupe migration keyed on job name (recommended) vs manual `cron remove` (decision needed).
4. **notify UX**: defer; current 2h-grace + Yes-gate stays.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Future-only fix leaves seeded NULL jobs dead | High | Mandatory idempotent backfill |
| Backfill hits invalid/once-expired schedules | Med | Skip jobs where `computeNextRun` returns null |
| Duplicate jobs recur on clients | Med | Name-dedupe in installer + dedupe migration |
| Restore semantics buggy → data loss (critical) | Low | Backups before any overwrite; copy-only, never delete; restore on error |

## Rollback Plan

Revert cron fix = restore previous `jobs.ts`/`scheduler.ts`; existing NULL jobs already healed stay. Installer rollback = restore `*.backup-<timestamp>` copies (all client data) and skip binary swap. Backups never deleted during update.

## Dependencies

- `computeNextRun()` already exported in `jobs.ts`.
- Installer run on Windows clients to apply dedupe/backup fixes.

## Success Criteria

- [ ] `create()` without `next_run_at` produces a non-NULL, correctly-computed value.
- [ ] Existing NULL enabled jobs healed on scheduler start (verified on client DB).
- [ ] Desktop install creates exactly one job per manifest entry (no duplicates).
- [ ] Update backs up desktop dir + config + skills; simulated failure restores all client data intact.
- [ ] Safety requirement persisted to Engram + docs.
