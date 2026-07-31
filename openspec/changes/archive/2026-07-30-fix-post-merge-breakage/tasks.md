# Tasks: Fix Post-Merge Breakage

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

## Phase 1: Fix LayerNode.make() signatures

- [x] 1.1 `packages/opencode/src/identity/index.ts:441` — rewrite `LayerNode.make(layer, [Auth.node, Database.node])` to `LayerNode.make({ service: Service, layer, deps: [Auth.node, Database.node] })`
- [x] 1.2 `packages/opencode/src/provider/budget.ts:302` — rewrite `LayerNode.make(layer, [Database.node, Provider.node])` to `LayerNode.make({ service: Service, layer, deps: [Database.node, Provider.node] })`

## Phase 2: Re-add defaultLayer exports (leaf modules)

- [x] 2.1 `packages/core/src/database/database.ts` — add `export const defaultLayer = layer`
- [x] 2.2 `packages/core/src/fs-util.ts` — add `export const defaultLayer = layer.pipe(Layer.provide(NodeFileSystem.layer))` inside `namespace FSUtil`
- [x] 2.3 `packages/opencode/src/effect/runtime-flags.ts` — add `export const defaultLayer = Service.layer.pipe(Layer.orDie)`
- [x] 2.4 `packages/llm/src/route/executor.ts` — add `export const defaultLayer = fetchLayer`

## Phase 3: Re-add defaultLayer exports (dependent modules)

- [x] 3.1 `packages/opencode/src/auth/index.ts` — add `export const defaultLayer = layer`
- [x] 3.2 `packages/opencode/src/config/config.ts` — add `export const defaultLayer = layer`
- [x] 3.3 `packages/opencode/src/plugin/index.ts` — add `export const defaultLayer = layer`
- [x] 3.4 `packages/opencode/src/permission/index.ts` — add `export const defaultLayer = layer`
- [x] 3.5 `packages/opencode/src/event-v2-bridge.ts` — add `export const defaultLayer = layer`
- [x] 3.6 `packages/opencode/src/image/image.ts` — add `export const defaultLayer = layer`
- [x] 3.7 `packages/opencode/src/session/session.ts` — add `export const defaultLayer = layer`
- [x] 3.8 `packages/opencode/src/session/summary.ts` — add `export const defaultLayer = layer`
- [x] 3.9 `packages/opencode/src/session/status.ts` — add `export const defaultLayer = layer`
- [x] 3.10 `packages/opencode/src/snapshot/index.ts` — add `export const defaultLayer = layer`
- [x] 3.11 `packages/opencode/src/agent/agent.ts` — add `export const defaultLayer = layer`
- [x] 3.12 `packages/opencode/src/provider/provider.ts` — add `export const defaultLayer = layer`

## Phase 4: Test fixes

- [x] 4.1 `packages/core/test/account/sql.test.ts:45` — add `"lastAllowanceMonth"` to expected TokenBalanceTable column sort
- [x] 4.2 `packages/opencode/test/event-manifest.test.ts:12` — verified `EventManifest.Latest.size` is still 88 (no update needed)

## Phase 5: Verification

- [x] 5.1 Run `bun typecheck` from `packages/opencode` — 29 errors (down from 69 pre-existing, no new errors introduced)
- [x] 5.2 Run `bun typecheck` from `packages/core` — clean (0 errors)
- [x] 5.3 Run `bun typecheck` from `packages/llm` — clean (0 errors)
- [x] 5.4 Run `bun test` from `packages/core` — all tests pass
- [x] 5.5 Run `bun test` from `packages/opencode` (event-manifest, identity, llm, layer-node) — all pass
