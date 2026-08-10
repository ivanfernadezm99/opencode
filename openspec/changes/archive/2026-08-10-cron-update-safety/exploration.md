# Exploration: cron-update-safety

**Change**: `cron-update-safety`
**Project**: opencode
**Phase**: explore
**Status**: success

## Summary

The cron "Recordatorio cargar horas Redmine" (Mon-Fri 17:30, notify) is not firing on Windows clients. Root cause: jobs are created with `next_run_at = NULL` and the scheduler only ever advances jobs that are already due — so a NULL-next_run job is permanently dead. Secondary issues: installer creates duplicate desktop-app cron jobs (no name dedupe against the desktop DB), the `skills` field of a job is never used at execution time, and the installer does not back up the desktop app data directory before updates.

## Findings

### Cron subsystem

- `CronJobTable.next_run_at` is a nullable `integer()` with no index (`cron-job.sql.ts:12`). `getDueJobs()` scans unfiltered (fine at cron scale).
- `CronJobs.create()` (`jobs.ts:197-226`) writes `next_run_at: input.next_run_at ?? undefined` (line 213) → **NULL whenever the caller omits it**.
- `getDueJobs()` (`jobs.ts:280-289`) filters `enabled=1 AND next_run_at <= now()` (line 285). NULL never satisfies `<= now()` → job never becomes due.
- Tick loop (`scheduler.ts:203-207`) runs `tick()` every 60s; grace filter (`scheduler.ts:99-103`) drops `next_run_at === null` jobs; `advanceNextRun()` (`scheduler.ts:109`) only runs for jobs already due. A NULL job is permanently dead.
- `seedDefaultCrons()` (`defaults.ts:58-66`) and `cron add` (`cli/cron.ts:148-158`) both call `create()` without `next_run_at` → every seeded/added job is born dead.
- Only correct path today: `cron resume` (`cli/cron.ts:246-253`) calls `computeNextRun(...)`. `advanceNextRun()` (`jobs.ts:291-313`) also computes it correctly but only after a job is already due.
- `computeNextRun()` (`jobs.ts:63-95`) exists, exported, same module as `create()` — natural home for the fix.

### Executor

- `job.skills` stored but **never used**: no reference in `executor.ts`; only `job.prompt` sent to model (`executor.ts:173-178`).
- notify flow (`executor.ts:134-141`): `notify=1` → `showNotification()`; dismiss/headless → `markJobRun("skipped")`. A daily 17:30 cron has `graceMs = 2h` (`computeGraceMs`) and requires a click on Yes to run.

### Installer (install.ps1)

- Binary install `Install-Binary` (312-414); pre-update data backup (810-844); `Migrate-SessionDatabase` (527-681); post-update engram backup (962-975); skills sparse-checkout `.opencode/skills/*` (1042-1111); CLI cron seeding with name-dedupe via `cron list` (1286-1340); **desktop** cron seeding with **no name-dedupe** (1414-1458); desktop config linking (1018-1030); MCP config merge (1113-1269).
- `redmine-time-entries` skill IS in the repo (`.opencode/skills/redmine-time-entries`) and ships to clients via `dev`-branch sparse checkout → copied to `~/.config/opencode/skills`. Distribution works; only execution-time loading is broken.
- Desktop cron block (`install.ps1:1431-1449`) adds every manifest job when the stamp differs, with no existing-name check — only guard is `desktopCronStamp` (1426) written after all adds (1450-1454). Crash between add and stamp → duplicate on next `-Desktop` install. This is the concrete source of the 2 identical jobs in the client DB.
- CLI block dedupe (1292-1303) runs `cron list` against fork-channel CLI DB `dev-fork-snapshot`, which the desktop app (channel `dev` → `opencode-dev.db`) does not read.

### Client data locations (Windows)

- CLI binaries: `%LOCALAPPDATA%\opencode\bin\`, `%LOCALAPPDATA%\gentle-ai\bin\`
- CLI session DBs: `%USERPROFILE%\.local\share\opencode\opencode*.db` (channel-named; fork = `dev-fork-snapshot`)
- Desktop app data: `%APPDATA%\ai.opencode.desktop.dev\` (XDG_DATA_HOME → `opencode-dev.db`; config at `...\config\opencode\`)
- Engram DB: `%USERPROFILE%\.engram\engram.db`
- Global config & skills: `%USERPROFILE%\.config\opencode\` + `...\skills\`
- Stamps: `~/.config/opencode/.default-crons-version`, `~/.config/opencode/.mcp-manifest-version`, `%APPDATA%\ai.opencode.desktop.dev\.default-crons-version`
- Install log: `%LOCALAPPDATA%\opencode\logs\install-*.log`

### Backup scope today

Backed up: CLI session DBs (all channels, incl. `-wal`/`-shm`) and `engram.db` (incl. sidecars).
**NOT backed up**: desktop app data dir (`%APPDATA%\ai.opencode.desktop.dev`), global config, skills. `Migrate-SessionDatabase` only touches `%USERPROFILE%\.local\share\opencode`, never the desktop DB.

## Affected areas

- `packages/opencode/src/cron/jobs.ts` — `create()` omits `next_run_at` (213); `getDueJobs()` NULL-filter (285); natural fix + backfill here.
- `packages/opencode/src/cron/defaults.ts:58-66` — seeder creates dead jobs; healed by `create()`-level fix.
- `packages/opencode/src/cli/cron.ts:148-158` — `cron add` creates dead jobs; healed by `create()`-level fix.
- `packages/opencode/src/cron/executor.ts:134-141, 173-178` — notify-gating skips job; `job.skills` unused.
- `packages/opencode/src/cron/scheduler.ts:90-110, 203-207` — tick cadence, grace window, advance-before-exec.
- `install.ps1:810-844` (backup scope gap), `1414-1458` (desktop cron dedupe gap), `1018-1030` (desktop config overwrite).
- `.opencode/default-crons.json` — source-of-truth job manifest.
- Docs: `docs/fork/installer.md` (stale), `docs/installer/README.md`, `docs/fork/README.md`.

## Approaches

1. **Compute `next_run_at` inside `create()` + backfill on scheduler start** — root-cause fix. Heals seeder + CLI + existing client DBs. Idempotent backfill required. Low-Medium effort.
2. **Compute at call sites** (`defaults.ts`, `cli/cron.ts add`) + backfill — more touch points, higher regression surface. Medium.
3. **Make `job.skills` drive execution** (attach skill tools in `executor.ts`) — larger/invasive; orthogonal to "not firing". Medium-High.
4. **Installer: dedupe desktop cron block + back up desktop data dir** — parallel data-safety work. Medium.

## Recommendation

Primary: **Approach 1** — `create()` self-computes `next_run_at` + idempotent backfill (scheduler start and/or `getDueJobs`) for enabled jobs with NULL next_run_at. Repairs already-broken client DBs.
Secondary (travels with same change): **Approach 4** — desktop cron dedupe + desktop data-dir backup. Approach 3 (executor skills/notify UX) is a separate decision.

## Risks

- Fix that only changes future `create()` leaves already-seeded NULL jobs dead — backfill is mandatory.
- `computeNextRun` returns `null` for invalid/`once`-expired schedules — backfill must leave those alone.
- Even with correct next_run_at, a 17:30 daily cron fires only if the app is running within 2h and (notify=1) user accepts.
- Duplicate creation is live on clients — need cleanup/dedupe migration for the 2 existing jobs.
- Desktop data not backed up before updates today.

## Open questions

1. Desktop app (channel `dev`) or CLI? Root cause points to desktop; fix must heal that DB specifically.
2. Should `notify=1` reminders auto-run the skill headlessly and only inform (instead of gating on Yes)?
3. Back up full `%APPDATA%\ai.opencode.desktop.dev` dir or only the DB?
4. Cleanup of duplicate jobs: manual `cron remove` or dedupe migration keyed on job name?

## Next recommended

`propose`
