# Proposal: Dynamic OAuth callback port for Microsoft login

## Intent

The Microsoft OAuth server (CLI plugin + Desktop login gate) hardcodes `OAUTH_PORT = 53800`. On Windows, Hyper-V/WSL/WinNAT reserves large excluded port ranges; when 53800 falls inside one, `server.listen(53800, "127.0.0.1")` throws `EACCES: permission denied`, breaking Microsoft login entirely. Bind an OS-assigned dynamic port (0) and construct the redirect_uri from the real bound port.

## Scope

### In Scope
- Bind loopback server on **port 0**, read real port from `server.address()` after `listen()`.
- Make `buildAuthorizeUrl()` accept a `redirectUri` param (stop reading module const).
- Return `{ port, redirectUri }` from `startOAuthServer()`; store bound `redirectUri` in module state for reuse as `refreshAccessUrl`/token exchange.
- Update CLI caller (`authorize` hook) and Desktop `runMicrosoftOAuth`/`resolveMicrosoftConfig` to thread the dynamic `redirectUri`.
- Update `openspec/specs/microsoft-auth` requirements/scenarios + interface contracts.

### Out of Scope
- Device Code flow (no redirect URIs involved).
- Other OAuth providers (xai, digitalocean, openai/codex) — separate, already variable or out of scope.
- Azure AD app registration changes (ops concern — see Risks).

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `microsoft-auth`: loopback redirect URI no longer pinned to fixed port 53800; must use OS-assigned dynamic port resolved at listen time. Update "Auth Code + PKCE Flow" requirement, "Port 53800 conflict" error scenario, and `**Redirect**` interface contract.

## Approach

Follow existing in-repo precedent in `snowflake-cortex.ts` (218-226): `server.listen(0, OAUTH_HOST)` then `const addr = server.address(); oauthServerPort = addr.port`. Derive `redirectUri = \`http://${OAUTH_HOST}:${port}${OAUTH_REDIRECT_PATH}\``. Thread this value through `buildAuthorizeUrl`, `MicrosoftConfig.redirectUri`, and the token exchange (which already uses `config.redirectUri`). Reuse single shared server; keep `EADDRINUSE` rejection.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/opencode/src/plugin/microsoft.ts` | Modified | Dynamic port; `buildAuthorizeUrl(redirectUri,…)`; returns real port/uri |
| `packages/desktop/src/main/login-gate.ts` | Modified | Same dynamic-port refactor; return port from `startOAuthServer` |
| `openspec/specs/microsoft-auth/spec.md` | Modified | Redirect contract + scenarios |
| `packages/opencode/test/plugin/microsoft.test.ts` | Modified | Add dynamic-port / redirect-uri tests |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Azure AD app registration does not permit `127.0.0.1` dynamic-port redirect | Med | Verify registration accepts loopback any-port (`http://localhost` or `127.0.0.1`+port). If rejected, register `http://localhost` (per RFC 8252 §7.3) |
| `redirect_uri` mismatch → token exchange 400 | Med | Ensure exact same literal used in authorize, server parse, and exchange |
| Desktop returns `Promise<void>` → thread port through refactor | Med | Change signature to return `{ port, redirectUri }`; LogicChange local call sites |

## Rollback Plan

Revert the two source files to restore `OAUTH_PORT = 53800` consts and fixed `REDIRECT_URI`; possibly revert spec delta. No persistent data or DB changes.

## Dependencies

- Azure AD app registration for `cb06d541-ed31-4195-b7ff-d2b50084da6f` allows dynamic loopback port.

## Success Criteria

- [ ] OAuth callback binds a dynamic port on Windows (no `EACCES`) and on Linux/macOS
- [ ] `startOAuthServer()` returns and uses the real bound port
- [ ] Full PKCE browser login succeeds for CLI and Desktop
- [ ] `bun test` in `packages/opencode` passes (new dynamic-port/redirect tests)