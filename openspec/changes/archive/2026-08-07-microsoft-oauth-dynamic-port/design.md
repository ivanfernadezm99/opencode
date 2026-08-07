# Design: Microsoft OAuth Dynamic Port

## Technical Approach

The Microsoft OAuth loopback server is shared across the CLI plugin (`packages/opencode/src/plugin/microsoft.ts`) and the Desktop login gate (`packages/desktop/src/main/login-gate.ts`). Both hardcode `OAUTH_PORT = 53800` and a derived module const `REDIRECT_URI`; on Windows a WinNAT/Hyper-V excluded range makes `listen(53800)` throw `EACCES`, breaking login.

Strategy: bind both servers on `0`, resolve the real port from `server.address().port` after `listen()`, build `redirectUri = http://127.0.0.1:<realPort>/callback`, cache it in module state, and thread it through `buildAuthorizeUrl` and token exchange. This follows the existing `snowflake-cortex.ts` precedent (`listen(0)` + `oauthServerPort = address.port`, lines 216–226) and matches `codex.ts`, which already passes `redirectUri` explicitly into `buildAuthorizeUrl`.

## Architecture Decisions

| # | Decision | Options | Tradeoff | Decision |
|---|----------|---------|----------|----------|
| D1 | Fixed-port consts | Keep `OAUTH_PORT`/`REDIRECT_URI` vs. remove | Keeping them re-introduces the exact spec-removed smell and permits accidental reuse | **Fully dynamic.** Remove `OAUTH_PORT` and `REDIRECT_URI`; keep `OAUTH_HOST` + `OAUTH_REDIRECT_PATH` and a `buildRedirectUri(port)` helper. `requireClientId` now tells users to register loopback `http://127.0.0.1`/`http://localhost` (RFC 8252 §7.3), not a specific port |
| D2 | `buildAuthorizeUrl` redirect source | Keep module const vs. param | Param matches spec (MUST accept `redirectUri`); const is wrong after dynamic bind | **Add `redirectUri` positional param** as last argument in both files |
| D3 | CLI exchange gets dynamic URI | Explicit param vs. overwrite `config.redirectUri` | `exchangeCodeForTokens` already reads `config.redirectUri`; handler consumes config captured by `waitForOAuthCallback` | **In authorizer: `config.redirectUri = (await startOAuthServer()).redirectUri`** before `waitForOAuthCallback`. Threads value with zero signature churn; refresh path is unaffected |
| D4 | Desktop exchange gets the URI | Cache in module vs. re-resolve config | Desktop handler re-calls `resolveMicrosoftConfig()` per request (line 176), which rebuilds the default | **Cache `boundRedirectUri` module var** set in `startOAuthServer`, read by the handler, cleared in `stopOAuthServer`; keep `resolveMicrosoftConfig` untouched |
| D5 | Cache real port | Observe `server.address()` per bind vs. module var | Server started once, reused for whole flow | **Add `oauthServerPort` module var** (mirrors `snowflake-cortex.ts`); `startOAuthServer` short-circuit returns `buildRedirectUri(oauthServerPort)`; clear both on `stop`. The request handler builds its base URL from `oauthServerPort`, not `OAUTH_PORT` |
| D6 | Auth loader / `OAUTH_DUMMY_KEY` | — | Refresh token and loader use `refreshAccessToken`, which sends no `redirect_uri` | **Unchanged.** No code or contract change in the loader. Keep out of scope |

## Data Flow

```
authorize() ──► startOAuthServer() ──► listen(0, 127.0.0.1)
                    │                    ▲ address().port
                    ▼                    │
            {port, redirectUri} ◄────────┘
                    │
      set config.redirectUri (CLI) / boundRedirectUri (Desktop)
                    │
 buildAuthorizeUrl(cfg.tenant, pkce, state, clientId, scopes, redirectUri)  ──► browser
                    │
 waitForOAuthCallback(pkce, state, config) -- handler receives /callback
                    │  reads config.redirectUri (CLI) / boundRedirectUri (Desktop)
                    ▼
 exchangeCodeForTokens(code, pkce, config)  POST /token redirect_uri=<bound>
                    │
                    ▼
              Tokens persisted as Oauth
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/opencode/src/plugin/microsoft.ts` | Modify | Remove `OAUTH_PORT`/`REDIRECT_URI`; add `buildRedirectUri`; add `oauthServerPort` var (D5); return real port from `startOAuthServer`; `buildAuthorizeUrl(..., redirectUri)`; set `config.redirectUri` in authorizer (D3); update `requireClientId` message |
| `packages/desktop/src/main/login-gate.ts` | Modify | Same const removal; return `{port, redirectUri}` from `startOAuthServer` (was `Promise<void>`); `buildAuthorizeUrl(..., redirectUri)`; `boundRedirectUri` module var (D4); handler merges it into exchange config; base URL from `oauthServerPort` |
| `packages/opencode/test/plugin/microsoft.test.ts` | Modify | Add `buildAuthorizeUrl` redirectUri param test + dynamic-port bind test |
| `openspec/changes/microsoft-oauth-dynamic-port/specs/microsoft-auth/spec.md` | Modify | (already authored) |
| `openspec/specs/microsoft-auth/spec.md` | Modify | Merge delta at archive time (not this phase) |

## Interfaces / Contracts

```ts
function buildRedirectUri(port: number): string // `http://127.0.0.1:${port}/callback`

// CLI
let oauthServerPort: number | undefined                              // cached (D5)
export async function startOAuthServer(): Promise<{ port: number; redirectUri: string }>
export function buildAuthorizeUrl(tenant, pkce, state, clientId, scopes, redirectUri): string

// Desktop
let oauthServerPort: number | undefined
let boundRedirectUri: string | undefined                             // D4
function startOAuthServer(): Promise<{ port: number; redirectUri: string }>  // was Promise<void>
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `buildAuthorizeUrl(..., redirectUri)` — `redirect_uri` query param equals the passed value | Parse `new URL(...).searchParams.get("redirect_uri")`; assert literal |
| Unit | `buildRedirectUri(port)` exact format | Small table |
| Integration | `startOAuthServer()` binds port 0, returns `port > 0` and `redirectUri === http://127.0.0.1:${port}/callback`; second call reuses the same port; `stopOAuthServer` resets `oauthServerPort` | Real bind on localhost (`bun test` in `packages/opencode`); no external network |

> Note: cannot run `bun typecheck` from `packages/opencode` (breaks running instance) — use it from a package dir or ask the user before applying.

## Migration / Rollout

No data migration, feature flags, or DB changes. Rollback = revert the two source files to restore the fixed-const version; no persisted state.

Software requirement: Azure AD app `cb06d541-...` must accept loopback any-port redirect. Verify; if rejected, register `http://localhost` per RFC 8252 §7.3. This is the only ops dependency and is outside code.

## Open Questions

- [ ] Azure AD app registration loopback any-port acceptance (ops check; blocks E2E sign-in verification)
- [ ] Whether `buildAuthorizeUrl` param should be named `redirectUri` vs `redirect` for prior art (`codex.ts` uses `redirectUri`) — reservations: none, use `redirectUri`
- [ ] None blocking design; D1–D6 fully specify the change