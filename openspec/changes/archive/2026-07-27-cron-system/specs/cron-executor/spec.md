# Cron Executor Specification

## Purpose

Construct a fresh AIAgent per job invocation, execute the prompt, persist output to the filesystem, and record results in the database.

## Requirements

### Requirement: Fresh Agent Per Run

Each job execution MUST create a new AIAgent instance with no session memory from previous runs. The agent MUST NOT reuse or carry over conversation history between invocations.

#### Scenario: Isolated execution

- GIVEN a job that runs twice
- WHEN the second run starts
- THEN the AIAgent has no context from the first run — it starts with a clean conversation

### Requirement: Agent Construction

The executor MUST construct the AIAgent using the job's `model` (or default model when null), `skills` (array of skill names to load), and `workdir` (filesystem context). The agent runs the job's `prompt` as the initial user message.

#### Scenario: Agent uses job configuration

- GIVEN a job with `model: "gpt-4o"`, `skills: ["effect"]`, `workdir: "/project"]`
- WHEN the executor constructs the agent
- THEN the agent uses the specified model, loads the "effect" skill, and has workdir context

#### Scenario: Default model fallback

- GIVEN a job with `model: null` and `skills: null`
- WHEN the executor constructs the agent
- THEN the agent uses the system default model and no extra skills

### Requirement: Output Persistence

The executor MUST save the AIAgent's conversation output to `~/.opencode/cron/output/{job_id}/{timestamp}.md`. The file contains the full conversation including the prompt and the agent's response. The directory MUST be created if it does not exist.

#### Scenario: Output written to correct path

- GIVEN a job with id `abc-123` runs at time `1719000000000`
- WHEN execution completes successfully
- THEN a file exists at `~/.opencode/cron/output/abc-123/1719000000000.md` containing the conversation

#### Scenario: Directory created on first run

- GIVEN a job with id `abc-123` that has never run
- WHEN execution starts
- THEN the directory `~/.opencode/cron/output/abc-123/` is created

### Requirement: Error Handling

The executor MUST handle agent timeouts (via inactivity tracker) and agent errors gracefully. On timeout or error, it SHALL call `markJobRun(job, "error", description)` and NOT leave the job in `running` state. Timeout threshold SHOULD be configurable per-job or default to 5 minutes.

#### Scenario: Timeout recorded as error

- GIVEN a job whose prompt does not complete within the timeout
- WHEN the inactivity tracker fires
- THEN `markJobRun(job, "error", "timeout")` is called and state transitions to `error`

#### Scenario: Agent error recorded

- GIVEN a job whose AIAgent throws an unrecoverable error
- WHEN the executor catches the error
- THEN `markJobRun(job, "error", errorMessage)` is called

### Requirement: State Transitions

The executor SHALL call `markJobRun(job, "completed")` on successful completion. The job `state` transitions through: `scheduled` → `running` (set at dispatch) → `completed` or `error`. The executor MUST NOT advance `next_run_at` — that is the scheduler's responsibility.

#### Scenario: Job state tracking

- GIVEN a job is dispatched by the scheduler
- WHEN the executor completes successfully
- THEN the job's final DB state shows `last_status="completed"` and `state="scheduled"` (ready for next run)
