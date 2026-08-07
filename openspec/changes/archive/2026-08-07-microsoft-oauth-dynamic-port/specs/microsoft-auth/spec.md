# Delta for microsoft-auth

Change: `microsoft-oauth-dynamic-port`. Loopback redirect URI is no longer pinned to a fixed port; it binds an OS-assigned dynamic port and threads the real bound URI through the whole PKCE flow.

## ADDED Requirements

### Requirement: Dynamic Loopback Port Binding

The OAuth loopback server MUST bind to `127.0.0.1` on an OS-assigned port (`0`) rather than a fixed port, and MUST resolve the real bound port from `server.address().port` after `listen()`. The redirect URI MUST be derived from that real port as `http://127.0.0.1:<port>/callback`. `startOAuthServer()` MUST return `{ port, redirectUri }` capturing the actual bound values; it is created once and the same bound redirect URI MUST be reused for the rest of the flow. The Desktop login gate MUST follow the identical dynamic-port behavior.

#### Scenario: OS-assigned port is resolved

- GIVEN the server is requested on port `0`
- WHEN `listen()` completes
- THEN the returned port is a non-zero OS-assigned number
- AND `redirectUri` exactly equals `http://127.0.0.1:<that-port>/callback`

#### Scenario: Same redirect URI threads through the whole flow

- GIVEN a dynamic bound `redirectUri`
- WHEN building the authorize URL, parsing the callback, and exchanging the code
- THEN the identical literal is used in `redirect_uri` of both the authorize request and the token exchange

### Requirement: Desktop Parity

The Desktop login gate `startOAuthServer()` MUST bind the loopback server on an OS-assigned port and return `{ port, redirectUri }` from the bound address, mirroring the CLI plugin.

#### Scenario: Desktop resolves dynamic port

- GIVEN the Desktop login gate starts the Microsoft OAuth server
- WHEN the server binds on port `0`
- THEN the callback and token exchange use the real bound `redirectUri`, identical to CLI behavior

## MODIFIED Requirements

### Requirement: Auth Code + PKCE Flow

The `authorize` method MUST start a loopback server on `127.0.0.1` at an OS-assigned port, generate S256 PKCE verifier/challenge, build the Microsoft authorize URL using the dynamic redirect URI, and wait for the callback. On callback, it MUST exchange the `code` + `code_verifier` for tokens and may persist an access or refresh token as `Oauth`.
`buildAuthorizeUrl` MUST accept a `redirectUri` parameter and use it for `redirect_uri` instead of reading a module constant.

(Previously: bound a fixed `127.0.0.1:53800/callback`; `buildAuthorizeUrl` used a module-level `REDIRECT_URI` const.)

#### Scenario: PKCE flow succeeds

- GIVEN the server is bound to an OS-assigned port on `127.0.0.1`
- WHEN Microsoft redirects to `/callback?code=XYZ&state=ABC`
- THEN the code is exchanged via POST `/oauth2/v2.0/token` with `grant_type=authorization_code`, `code_verifier`, and the bound `redirect_uri`
- AND tokens (refresh, access, expires, accountId) are saved as `Oauth`
- AND the browser shows `HTML_SUCCESS`

#### Scenario: State mismatch

- GIVEN `pendingOAuth.state` is `"ABC"` and callback receives `state=XYZ`
- THEN the server responds 400 with `HTML_ERROR("Invalid state")`
- AND the callback promise rejects

#### Scenario: Error parameter in redirect

- GIVEN Microsoft redirects with `error=access_denied&error_description=User+denied`
- WHEN the callback receives the error
- THEN the server responds with `HTML_ERROR("User denied")`
- AND the callback promise rejects

### Requirement: Error Handling

The plugin MUST handle port binding failures, consent denial, expired tokens, and Microsoft error responses with clear messages.

(Previously: its port scenario was titled "Port 53800 conflict" with a fixed port.)

#### Scenario: Loopback port binding failure

- GIVEN the OS cannot bind the loopback port (e.g. `EADDRINUSE` or `EACCES` from an excluded WinNAT/Hyper-V range)
- WHEN `startOAuthServer()` is called
- THEN the promise rejects
- AND `oauthServer` is cleared so a later attempt can retry

#### Scenario: Consent denial and failed refresh

- GIVEN consent is denied, or the refresh grant returns 400 (90d inactivity)
- THEN the flow surfaces a clear error and rejects
- AND the loader does NOT crash

## REMOVED Requirements

### Requirement: Hardcoded port 53800

(Reason: fixed-port binding is the root cause of `EACCES` on Windows; the port must be OS-assigned.)
(Migration: remove the fixed-port consts in the CLI plugin and Desktop login gate; derive from `server.address().port`. Update the Redirect contract.)