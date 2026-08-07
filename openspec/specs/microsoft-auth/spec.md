# microsoft-auth Specification

## Purpose

Microsoft Entra ID / Microsoft Account OAuth2/OIDC provider for OpenCode CLI. Dual-flow auth: Authorization Code + PKCE (desktop) and Device Code (headless), with token refresh and tenant configuration.

## Requirements

### Requirement: Plugin Registration

The plugin MUST register as `provider: "microsoft"` with an AuthHook containing two OAuth flow methods and one API key fallback.

| Method | Type | Label |
|--------|------|-------|
| PKCE Loopback | oauth | Microsoft Account (Browser) |
| Device Code | oauth | Microsoft Account (Headless/VPS) |
| API Key | api | Manually enter API Key |

#### Scenario: Plugin loaded

- GIVEN `MicrosoftAuthPlugin` is exported
- WHEN `internalPlugins()` is called
- THEN `auth.provider` is `"microsoft"`, `loader` returns `{ apiKey: OAUTH_DUMMY_KEY, fetch }`, and `methods` has 3 entries

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

- GIVEN `pendingOAuth.state` is `"ABC"`
- WHEN callback receives `state=XYZ`
- THEN server responds 400 with `HTML_ERROR("Invalid state")`
- AND callback promise rejects

#### Scenario: Error parameter in redirect

- GIVEN Microsoft redirects with `error=access_denied&error_description=User+denied`
- WHEN callback receives the error
- THEN the server responds with `HTML_ERROR("User denied")`
- AND the callback promise rejects

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

### Requirement: Device Code Flow

The `authorize` method MUST POST to `/{tenant}/oauth2/v2.0/devicecode`, return the verification URL and `user_code`, and poll the token endpoint per RFC 8628.

#### Scenario: Device code succeeds

- GIVEN `device_code`, `user_code`, and `verification_uri` are returned
- WHEN the user authorizes and the poll receives a 200 response
- THEN tokens (refresh, access, expires) are saved as `Oauth`
- AND the method returns `{ type: "success" }`

#### Scenario: Slow down and authorization_pending

- GIVEN the token endpoint returns `{ error: "authorization_pending" }`
- WHEN polling at the server-suggested interval
- THEN the loop continues without error
- AND if `error: "slow_down"` is received, the interval is increased by >= 5s

### Requirement: Token Refresh (Loader)

The `loader` MUST return a `fetch` override that checks token expiry (stored `expires` or JWT `exp` claim) before every request and refreshes proactively with single-flight dedup.

#### Scenario: Proactive refresh before 401

- GIVEN stored `expires` is within 120s of `Date.now()` — or JWT `exp` is within skew
- WHEN a fetch call is made
- THEN a `refresh_token` grant is sent to the token endpoint
- AND rotated tokens are persisted as `Oauth`
- AND the fetch proceeds with the new `access_token`

#### Scenario: Concurrent refresh collapsed

- GIVEN two fetch calls arrive simultaneously
- WHEN both detect the token is expiring
- THEN only one HTTP refresh is issued
- AND both fetches resolve with the same refreshed token

### Requirement: Tenant Configuration

The plugin MUST accept a `tenant` option defaulting to `"common"`. Supported values: `"common"`, `"organizations"`, `"consumers"`, or a specific tenant ID.

#### Scenario: Tenant drives endpoint

- GIVEN `tenant` is `"contoso.com"`
- WHEN building the authorize or token URL
- THEN the endpoint is `https://login.microsoftonline.com/contoso.com/oauth2/v2.0/{action}`

### Requirement: Account ID Extraction

The `callback` MUST extract `accountId` from the ID token's `oid` claim, falling back to `sub`.

#### Scenario: oid claim present

- GIVEN the ID token JWT payload has `{ "oid": "guid-abc" }`
- WHEN the callback processes tokens
- THEN `accountId` is `"guid-abc"`

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

### Requirement: Plugin-Only Provider Model Registration

The system MUST register a provider that has no `models.dev` catalog entry when the provider is defined by a plugin (via its auth loader or `models` hook).

When a plugin-only provider is merged, the system MUST create a minimal provider entry from the plugin patch instead of silently dropping it. If the plugin exposes a `models` hook, the hook's model list MUST be merged into the provider entry. The system MUST tolerate a missing auth entry for a plugin-only provider (e.g., the admin-bypass login path) without failing provider initialization.

#### Scenario: Microsoft SSO user sees models in the UI

- GIVEN a user authenticated only via the Microsoft Entra ID login gate
- AND `auth.json` contains a `microsoft` OAuth entry
- AND the `models.dev` catalog has no top-level `microsoft` provider
- WHEN the provider service initializes
- THEN the `microsoft` provider is registered with the models declared by the plugin's `models` hook
- AND `GET /provider` returns `microsoft` in the `connected` list
- AND the prompt input renders a non-empty model list

#### Scenario: Admin-bypass login does not crash provider init

- GIVEN the admin username/password bypass path is used
- AND no `microsoft` auth entry exists in `auth.json`
- WHEN the plugin models hook loop runs
- THEN provider initialization succeeds without error
- AND the `microsoft` provider stub is still registered

#### Scenario: Future models.dev entry takes precedence

- GIVEN a future `models.dev` snapshot adds a top-level `microsoft` provider
- WHEN the provider is merged
- THEN the existing match-against-database path is used (deep merge with the catalog entry)
- AND the plugin-only fallback is not applied

### Non-Functional

- **Single-flight**: Concurrent fetch refreshes collapse into one HTTP call
- **Timeout**: Auth callback rejects after 5 minutes; prior pending auth is rejected on new `authorize()`
- **Safety margin**: Device code polling adds `OAUTH_POLLING_SAFETY_MARGIN_MS` to each wait

### Interface Contracts

**Client ID**: `process.env.MICROSOFT_CLIENT_ID` || plugin option `clientId`
**Endpoints**: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/{authorize|token|devicecode}`
**Scopes**: `openid email profile offline_access`
**Redirect**: `http://127.0.0.1:<os-assigned-port>/callback` derived from `server.address().port`
**Token storage**: `Oauth { type: "oauth", refresh, access, expires, accountId? }`
**Account ID**: from ID token `oid` claim (preferred), `sub` claim (fallback)
**ID token parse**: Unsigned JWT decode — `JSON.parse(atob(payload))` — for `oid`, `sub`, `tid`, `exp` only; no signature verification (trust decisions use token response from Microsoft, not local decode)
