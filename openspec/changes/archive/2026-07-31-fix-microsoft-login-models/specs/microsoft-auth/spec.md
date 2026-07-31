# Delta for microsoft-auth

## ADDED Requirements

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
