# Tasks: fix-microsoft-login-models

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~234 (4 files: +234 / -8) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Delivery strategy | single-pr |

Decision needed before apply: No
Chained PRs recommended: No
400-line budget risk: Low

> **Lifecycle note**: this change was implemented directly in commit `1620364e1`
> ("fix(opencode): register plugin-only providers without models.dev entry") on
> `dev-fork-snapshot` (2026-07-31), outside the SDD apply flow. Tasks below are
> reconstructed from the implemented commit and marked complete to close the
> cycle; the archived SDD lifecycle records the direct-implementation history.

## Phase 1 — Provider Registration for Plugin-Only Providers

- [x] **1.1** `provider.ts` — `mergeProvider`: register a minimal provider from the patch when `database[providerID]` is undefined (id, name, source, env, key, options, models) instead of silently bailing; preserve the match-against-database deep-merge path for entries that exist in models.dev
- [x] **1.2** `provider.ts` — Plugin models hook loop: create a catalog stub (`{ id, name, source: "custom", env: [], options: {}, models: {} }`) for plugin-only providers and insert it into `database` so the hook's model list survives downstream merges
- [x] **1.3** `provider.ts` — Plugin models hook loop: replace `auth.get(providerID).pipe(Effect.orDie)` with `Effect.catch(() => Effect.succeed(undefined))` so the admin-bypass path (no auth entry) does not crash init
- [x] **1.4** `provider.ts` — Plugin auth loader loop: run the loader with a stub entry (`loaderEntry`) when the provider has no models.dev entry instead of skipping

## Phase 2 — Microsoft Plugin Models Hook

- [x] **2.1** `microsoft.ts` — Add `provider.models` hook declaring GitHub Models inference surface: `https://models.github.ai/inference` base URL, `@ai-sdk/openai-compatible` SDK, with `MICROSOFT_MODELS` and `MICROSOFT_MODELS_BASE_URL` env overrides

## Phase 3 — Tests

- [x] **3.1** `provider.test.ts` — Full-init regression test replicating the MS-SSO scenario (OAuth-only auth entry, no models.dev `microsoft` entry → provider registered, models visible)
- [x] **3.2** `microsoft.test.ts` — Unit tests for the plugin's `models` hook surface (model list shape, env overrides)
