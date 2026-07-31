# Proposal: Fix Post-Merge Breakage

## Intent

Fix the compiler errors, test failures, and runtime crash introduced when upstream rewrote `LayerNode.make()` to a single-arg API and removed `defaultLayer` exports. Upstream merged before our fork caught up — this is a compatibility restoration pass, not a feature change.

## Scope

### In Scope
- Fix `LayerNode.make()` calls in `identity/index.ts` and `provider/budget.ts` (single-arg `MakeInput` object)
- Re-export `defaultLayer` from the 16 modules that lost it (auth, database, provider, config, plugin, permission, event-v2-bridge, session, snapshot, agent, session/summary, session/status, image, runtime-flags, FSUtil, RequestExecutor)
- Fix cascading type errors from removed exports
- Update `TokenBalanceTable` test to include `lastAllowanceMonth` column
- Regenerate event manifest snapshot

### Out of Scope
- Diff package types (already resolved — diff@8.0.2 has built-in types)
- Refactoring `LayerNode` usage patterns
- Upstream divergence on any non-breaking API surface

## Capabilities

### New Capabilities
None — pure fix, no new spec-level behavior.

### Modified Capabilities
None — no spec-level requirements change. Only API compatibility and test data restored.

## Approach

1. Fix 2 `LayerNode.make()` calls to use `{ service, name, layer, deps }` shape — unblocks all tests
2. Add back `defaultLayer` named exports to 16 modules (one-line each: `export const defaultLayer = ...`)
3. Run `bun typecheck` from `packages/opencode` to resolve ~69 cascading errors
4. Add `lastAllowanceMonth` column to `packages/core/test/account/sql.test.ts`
5. Regenerate `packages/core/src/public-event-manifest.ts` snapshot

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/opencode/src/identity/index.ts` | Modified | LayerNode.make() params |
| `packages/opencode/src/provider/budget.ts` | Modified | LayerNode.make() params |
| `packages/opencode/src/auth/index.ts` | Modified | Re-add defaultLayer export |
| `packages/opencode/src/database/` | Modified | Re-add defaultLayer export |
| `packages/opencode/src/provider/` | Modified | Re-add defaultLayer export |
| `packages/opencode/src/config/` | Modified | Re-add defaultLayer export |
| `packages/opencode/src/plugin/` | Modified | Re-add defaultLayer export |
| `packages/opencode/src/permission/` | Modified | Re-add defaultLayer export |
| `packages/opencode/src/event-v2-bridge/` | Modified | Re-add defaultLayer export |
| `packages/opencode/src/session/` | Modified | Re-add defaultLayer export |
| `packages/opencode/src/snapshot/` | Modified | Re-add defaultLayer export |
| `packages/opencode/src/agent/` | Modified | Re-add defaultLayer export |
| `packages/opencode/src/image/` | Modified | Re-add defaultLayer export |
| `packages/opencode/src/runtime-flags/` | Modified | Re-add defaultLayer export |
| `packages/core/test/account/sql.test.ts` | Modified | Add lastAllowanceMonth |
| `packages/core/src/public-event-manifest.ts` | Modified | Regenerate snapshot |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Missing a re-export from 16 modules | Low | Run `bun typecheck` after each batch |
| LayerNode.make() fix has wrong shape | Low | Existing test suite covers layer wiring |
| Regenerated snapshot differs | Low | `bun test` validates snapshot |

## Rollback Plan

`git checkout dev -- packages/openspec/src/identity/index.ts packages/openspec/src/provider/budget.ts packages/core/test/account/sql.test.ts packages/core/src/public-event-manifest.ts` and for each re-export module, `git checkout dev -- <path>`. Restores pre-fix state exactly.

## Dependencies

- Upstream must NOT re-introduce the single-arg `LayerNode.make()` before this fix lands
- None external

## Success Criteria

- [ ] `bun typecheck` passes in `packages/opencode`
- [ ] `bun test` passes in `packages/opencode`
- [ ] `bun test` passes in `packages/core`
- [ ] No runtime crash on `LayerNode.make()` — `hasUnbound()` no longer sees `dependencies: undefined`
