# Tasks: Microsoft OAuth Dynamic Port

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~220–280 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | single-pr |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

## Phase 1: CLI Plugin — `packages/opencode/src/plugin/microsoft.ts`

- [x] 1.1 Remove `OAUTH_PORT` and `REDIRECT_URI` consts (lines 26, 28); keep `OAUTH_HOST` + `OAUTH_REDIRECT_PATH`
- [x] 1.2 Add `buildRedirectUri(port)` helper returning `http://${OAUTH_HOST}:${port}${OAUTH_REDIRECT_PATH}`
- [x] 1.3 Add `let oauthServerPort: number | undefined` module var (mirror `snowflake-cortex.ts`)
- [x] 1.4 `startOAuthServer()`: on short-circuit return `{ port: oauthServerPort, redirectUri: buildRedirectUri(oauthServerPort) }`
- [x] 1.5 `startOAuthServer()`: `server.listen(0, OAUTH_HOST)`; in listen callback read `server.address().port` into `oauthServerPort`; return `{ port, redirectUri: buildRedirectUri(port) }`
- [x] 1.6 `startOAuthServer()`: request handler base URL uses `oauthServerPort` not `OAUTH_PORT` (line 548)
- [x] 1.7 `stopOAuthServer()`: clear `oauthServerPort` alongside `oauthServer`
- [x] 1.8 `buildAuthorizeUrl(...)`: add last positional `redirectUri: string` param; use it for `redirect_uri` (line 296)
- [x] 1.9 `getConfig()`: drop `options.redirectUri ?? REDIRECT_URI` fallback (line 64) — keep field but dynamic
- [x] 1.10 `authorize` hook: capture `const { redirectUri } = await startOAuthServer()` and pass it to `buildAuthorizeUrl` (line 810-819)
- [x] 1.11 `authorize` hook: set `config.redirectUri = redirectUri` before `waitForOAuthCallback` (D3)
- [x] 1.12 `requireClientId` error: replace fixed `REDIRECT_URI` (line 701) with loopback any-port guidance (`http://127.0.0.1` / RFC 8252)
- [x] 1.13 `getConfig` `MicrosoftAuthPluginOptions.redirectUri`: remove or document as internal (unused after dynamic bind)

## Phase 2: Desktop Parity — `packages/desktop/src/main/login-gate.ts`

- [x] 2.1 Remove `OAUTH_PORT`, `REDIRECT_URI` consts (lines 25-27); keep host/path
- [x] 2.2 Add `buildRedirectUri(port)` + `let oauthServerPort`/`let boundRedirectUri` module vars (D4/D5)
- [x] 2.3 `startOAuthServer()`: return `Promise<{ port: number; redirectUri: string }>` (was `void`); bound short-circuit returns cached values
- [x] 2.4 `startOAuthServer()`: `server.listen(0, OAUTH_HOST)`; read `address().port`; set `boundRedirectUri`; return `{ port, redirectUri }`
- [x] 2.5 Handler base URL from `oauthServerPort` (line 140); `exchangeCodeForTokens` uses `boundRedirectUri` via merged config (line 176)
- [x] 2.6 `stopOAuthServer()`: clear `oauthServerPort` and `boundRedirectUri`
- [x] 2.7 `runMicrosoftOAuth`: pass returned `redirectUri` into `buildAuthorizeUrl` (line 228)

## Phase 3: Tests — `packages/opencode/test/plugin/microsoft.test.ts`

- [x] 3.1 Unit: `buildAuthorizeUrl(..., redirectUri)` sets `redirect_uri` query param to the passed literal (parse `new URL(...).searchParams`)
- [x] 3.2 Unit: `buildRedirectUri(port)` table — exact `${OAUTH_HOST}:${port}/callback` format
- [x] 3.3 Integration: `startOAuthServer()` binds port 0, returns `port > 0` + `redirectUri === buildRedirectUri(port)`; second call reuses same port; `stopOAuthServer` resets `oauthServerPort`
- [x] 3.4 Run `bun test` from `packages/opencode` (do NOT run `bun typecheck` there — breaks running instance)

## Phase 4: Spec Cleanup — `openspec`

- [x] 4.1 Confirm `openspec/changes/microsoft-oauth-dynamic-port/specs/microsoft-auth/spec.md` matches implemented decisions (already authored)
- [ ] 4.2 `openspec/specs/microsoft-auth/spec.md` delta merge is deferred to archive phase — DO NOT edit now

## External / Non-Code

- [ ] 5.1 Verify Azure AD app `cb06d541-` accepts loopback any-port redirect (ops; blocks E2E sign-in, not apply)