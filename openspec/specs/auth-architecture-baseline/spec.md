# auth-architecture-baseline Specification

## Purpose

Document the current authentication architecture in OpenCode as a baseline for implementing Microsoft Entra ID / Microsoft Account OAuth2/OIDC provider in a fork.

## Current Architecture

### Auth Storage (`packages/opencode/src/auth/index.ts`)

**Location**: `~/.local/share/opencode/auth.json` (or `OPENCODE_AUTH_CONTENT` env var)

**Schema** (lines 13-34):
```typescript
class Oauth {
  type: "oauth"
  refresh: string
  access: string
  expires: NonNegativeInt  // Unix timestamp
  accountId?: string
  enterpriseUrl?: string
}

class Api {
  type: "api"
  key: string
  metadata?: Record<string, string>
}

class WellKnown {
  type: "wellknown"
  key: string
  token: string
}
```

**Service Interface** (lines 42-47):
```typescript
interface Interface {
  get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  all: () => Effect.Effect<Record<string, Info>, AuthError>
  set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  remove: (key: string) => Effect.Effect<void, AuthError>
}
```

### Provider Auth System (`packages/opencode/src/provider/auth.ts`)

**AuthHook Definition** (`packages/plugin/src/index.ts` lines 88-208):
```typescript
type AuthHook = {
  provider: string  // Provider ID (e.g., "github-copilot", "azure")
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>
  methods: AuthMethod[]
}

type AuthMethod =
  | { type: "oauth"; label: string; prompts?: Prompt[]; authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult> }
  | { type: "api"; label: string; prompts?: Prompt[]; authorize?(inputs?: Record<string, string>): Promise<AuthApiResult> }

type AuthOAuthResult = { url: string; instructions: string } & (
  | { method: "auto"; callback(): Promise<AuthCallbackResult> }
  | { method: "code"; callback(code: string): Promise<AuthCallbackResult> }
)

type AuthCallbackResult =
  | { type: "success"; provider?: string } & ( { refresh: string; access: string; expires: number; accountId?: string; enterpriseUrl?: string } | { key: string; metadata?: Record<string, string> } )
  | { type: "failed" }
```

**ProviderAuth Service Flow** (`packages/opencode/src/provider/auth.ts`):
1. `methods()` — Returns available auth methods from plugin hooks
2. `authorize(input)` — Validates prompts, calls plugin's `authorize()`, stores pending OAuth result
3. `callback(input)` — Retrieves pending, calls plugin's `callback(code)`, saves result to auth storage:
   - If `key` in result → saves as `Api` type
   - If `refresh` in result → saves as `Oauth` type (refresh, access, expires, accountId, enterpriseUrl)

### Existing OAuth Providers

The following OAuth providers are registered in the system, including the Microsoft provider added by the `microsoft-auth` capability.

| Provider | Auth Method | Implementation |
|----------|-------------|----------------|
| **GitHub Copilot** | Device Code Flow | `packages/core/src/plugin/provider/github-copilot.ts` |
| **OpenAI (Codex)** | OAuth (Authorization Code + PKCE) | `packages/opencode/src/plugin/openai/codex.ts` |
| **Microsoft** | OAuth (Auth Code + PKCE + Device Code) | `packages/opencode/src/plugin/microsoft.ts` |
| **xAI (Grok)** | OAuth (Auth Code + PKCE + Device Code) | `packages/opencode/src/plugin/xai.ts` |
| **Azure** | API Key (no OAuth) | `packages/core/src/plugin/provider/azure.ts` |
| **Google Vertex** | API Key + custom fetch | `packages/core/src/plugin/provider/google-vertex.ts` |

### Console Web Auth (`packages/console/function/src/auth.ts`)

Uses `@openauthjs/openauth` with:
- `GithubProvider` (clientID + clientSecret)
- `GoogleOidcProvider` (clientID only)
- Stores in Cloudflare KV + Drizzle SQLite (`AuthTable`)

### Plugin Registration

Plugins register via `PluginV2.define()` returning hooks including `auth`:
- `packages/core/src/plugin/provider/*.ts` — each provider plugin
- Hooks collected by `ProviderAuth` service via `Plugin.Service.list()`

## Requirements

### Requirement: Provider ID Registration

The system MUST recognize `microsoft` as a well-known `ProviderV2.ID`.

#### Scenario: microsoft in provider ID list

- GIVEN the provider ID registry
- WHEN `ProviderV2.ID.make("microsoft")` is called
- THEN it returns a valid branded string
- AND it is usable as a provider key in auth storage and model routing

## Non-Goals

- Microsoft Graph API integration (separate concern)
- Copilot model consumption via Microsoft auth (requires separate provider implementation)
- SSO/Enterprise features beyond basic OAuth login

## References

- `packages/opencode/src/auth/index.ts` — Auth storage service
- `packages/opencode/src/provider/auth.ts` — Provider auth orchestration
- `packages/plugin/src/index.ts` — AuthHook type definitions
- `packages/core/src/plugin/provider/github-copilot.ts` — Device code flow example
- `packages/opencode/src/plugin/openai/codex.ts` — OAuth code flow example
- `packages/console/function/src/auth.ts` — Web OAuth with @openauthjs/openauth
- Microsoft Identity Platform docs: https://learn.microsoft.com/en-us/entra/identity-platform/