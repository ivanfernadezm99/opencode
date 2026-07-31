# Proposal: fix-microsoft-login-models

## Intent

Users authenticated only via the Microsoft Entra ID SSO gate saw an empty model list in the prompt input. The `models.dev` catalog has no top-level `microsoft` provider, and provider initialization silently dropped plugin-defined providers missing from that catalog. This change makes plugin-only providers register correctly so MS-SSO users see a usable model list.

## Scope

### In Scope
- `mergeProvider`: register a minimal provider from the plugin patch instead of bailing when `database[providerID]` is undefined (match-against-database path preserved for a future models.dev entry)
- Plugin models hook loop: create a catalog stub for plugin-only providers and tolerate missing auth entries (admin-bypass path) instead of `orDie`
- Plugin auth loader loop: run the loader with a stub entry when the provider has no models.dev entry
- Microsoft plugin `models` hook: declare a GitHub Models inference model list (`@ai-sdk/openai-compatible`, `https://models.github.ai/inference`) with `MICROSOFT_MODELS` and `MICROSOFT_MODELS_BASE_URL` overrides
- Regression test replicating the SSO scenario (full provider init) + unit tests for the hook surface

### Out of Scope
- Real model API calls through the Microsoft OAuth token (Phase 2 of the exploration — model surface selection and serving prompts)
- Changes to the UI layer (`use-providers.ts`, `models.tsx` — no change needed once `connected` is non-empty)

## Capabilities

### Modified Capabilities
- `microsoft-auth`: Provider now registers a `models` hook and is visible with a model list after SSO login

## Approach

Phase 1 only of the exploration recommendation: relax the three guards in `provider.ts` init that drop plugin-defined providers missing from `models.dev`, and have `MicrosoftAuthPlugin` expose a `models` hook declaring the GitHub Models inference surface. Implemented in commit `1620364e1`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/opencode/src/provider/provider.ts` | Modified | `mergeProvider` plugin-only fallback; models hook loop stub + tolerant auth; auth loader loop stub entry |
| `packages/opencode/src/plugin/microsoft.ts` | Modified | Add `provider.models` hook (GitHub Models inference) with env overrides |
| `packages/opencode/test/plugin/microsoft.test.ts` | Modified | Unit tests for the models hook surface |
| `packages/opencode/test/provider/provider.test.ts` | Modified | Full-init regression test replicating the SSO scenario |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| MS OAuth token alone cannot call model APIs | High | Documented in exploration; Phase 2 (model surface + serving) is separate follow-up |
| Future models.dev `microsoft` entry | Low | `mergeProvider` keeps the match-against-database path; plugin-only fallback is a no-op then |
| Knock-on effects on `getLanguage` | Low | `toPublicInfo` already tolerates `undefined` database entries (verified in exploration) |

## Rollback Plan

Revert commit `1620364e1`. No data migration needed — provider registration is derived state, not persisted.

## Success Criteria

- [x] MS-SSO user (OAuth-only auth entry) gets a non-empty `connected` provider list with the `microsoft` provider visible
- [x] Admin-bypass login path does not crash provider initialization
- [x] Regression test replicates the SSO scenario and passes
