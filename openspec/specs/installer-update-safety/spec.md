# Installer Update Safety Specification

## Purpose

`install.ps1` must guarantee that no client data is lost on any update: every update backs up all client data (desktop app data, global config, skills, Engram DB, session DBs), never deletes the originals, restores everything if any update step fails, and seeds desktop cron jobs without creating duplicates.

## Requirements

### Requirement: Pre-Update Backup Scope

Before replacing any binary or mutating any client data, the installer MUST copy (not move) the following client data to `*.backup-<timestamp>` destinations: the desktop app data dir `%APPDATA%\ai.opencode.desktop.dev`, the global config dir `~/.config/opencode` (including skills), the Engram DB (`%USERPROFILE%\.engram\engram.db` with `-wal`/`-shm` sidecars), and every session DB (`opencode-*.db` / `opencode.db` with sidecars) across all channels. Backups MUST be copy-only: the original files are never deleted or modified by the backup step.

#### Scenario: Desktop data, config, skills and DBs are backed up

- GIVEN a client with desktop data, config, skills, an Engram DB, and session DBs
- WHEN the installer starts an update
- THEN a `*.backup-<timestamp>` copy exists for each of: desktop dir, config dir, skills, Engram DB (with sidecars), and every session DB (with sidecars)
- AND all originals remain in place

#### Scenario: User-created skills survive update

- GIVEN the user created a custom skill under `~/.config/opencode/skills`
- WHEN the update completes
- THEN the skill still exists at its original path and is unchanged

#### Scenario: Engram DB survives update

- GIVEN an Engram DB with prior session memories
- WHEN the update completes
- THEN the DB content is intact at the original location and a backup copy also exists

### Requirement: Restore on Error

If any step of the update fails after backups are taken, the installer MUST restore all client data (desktop dir, config, skills, Engram DB, and session DBs) from the backups and MUST NOT leave a partially-mutated client state. A failure before any overwrite requires no restore because nothing was changed.

#### Scenario: Failed update restores everything

- GIVEN the binary swap fails after backups were taken
- WHEN the installer catches the error
- THEN desktop data, config, skills, Engram DB, and session DBs are restored from `*.backup-<timestamp>`
- AND the client state matches the pre-update state

#### Scenario: Copy-only backup never deletes originals

- GIVEN the backup step runs
- WHEN it completes
- THEN no original file was deleted, moved, or truncated by the backup

### Requirement: Desktop Cron Seeding Dedupe

Before adding a manifest cron job to the desktop DB, the installer MUST check for an existing job with the same name in that DB and MUST NOT add a duplicate when one already exists. If multiple jobs with the same name already exist (from a prior buggy install), the installer MUST dedupe them by name, keeping the earliest/first job and removing the later duplicates. The result MUST be exactly one job per manifest entry per DB.

#### Scenario: Name-dedupe prevents duplicates

- GIVEN a manifest entry `Recordatorio cargar horas Redmine` already exists once in the desktop DB
- WHEN the installer seeds desktop crons
- THEN no second job with that name is added — the DB still has exactly one

#### Scenario: Existing duplicates are collapsed

- GIVEN the desktop DB already contains 2 identical jobs named `Recordatorio cargar horas Redmine`
- WHEN the installer seeds desktop crons
- THEN the earliest job is kept and the later duplicate is removed, leaving exactly one

#### Scenario: Crash between add and stamp creates no duplicate

- GIVEN the desktop cron stamp was not yet written when the installer terminated
- WHEN a later install run seeds desktop crons again
- THEN the name-dedupe sees the job already present and adds nothing new — no duplicate is created

#### Scenario: Fresh manifest job is added

- GIVEN a manifest entry not present in the desktop DB
- WHEN the installer seeds desktop crons
- THEN exactly one job with that name is added
