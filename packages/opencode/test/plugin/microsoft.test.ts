import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  MicrosoftAuthPlugin,
  buildAuthorizeUrl,
  buildRedirectUri,
  generatePKCE,
  generateState,
  makeMicrosoftModel,
  readMicrosoftModels,
  readMicrosoftModelsBaseURL,
  startOAuthServer,
  stopOAuthServer,
} from "@/plugin/microsoft"

const GITHUB_MODELS_INFERENCE_URL = "https://models.github.ai/inference"

const originalEnv = new Map<string, string | undefined>()

const rememberEnv = (k: string) => {
  if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
}

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
})

// The github-copilot-models test constructs plugins with `as never` inputs; the
// hook under test does not touch the input, so a minimal one is fine.
const hooks = () =>
  MicrosoftAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

test("microsoft models hook returns a non-empty GitHub Models inference surface", async () => {
  // Clear ambient overrides so the default surface is asserted.
  rememberEnv("MICROSOFT_MODELS")
  rememberEnv("MICROSOFT_MODELS_BASE_URL")
  delete process.env["MICROSOFT_MODELS"]
  delete process.env["MICROSOFT_MODELS_BASE_URL"]

  const models = await (await hooks()).provider!.models!({} as never, {} as never)

  expect(Object.keys(models).length).toBeGreaterThan(0)

  const model = models["gpt-4.1"]
  expect(model).toBeDefined()
  expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
  expect(model.api.url).toBe(GITHUB_MODELS_INFERENCE_URL)
  expect(model.limit.context).toBeGreaterThan(0)
  expect(model.providerID).toBe("microsoft")
})

test("microsoft models hook honors MICROSOFT_MODELS and MICROSOFT_MODELS_BASE_URL overrides", async () => {
  rememberEnv("MICROSOFT_MODELS")
  rememberEnv("MICROSOFT_MODELS_BASE_URL")
  process.env["MICROSOFT_MODELS"] = "gpt-4o, custom-model"
  process.env["MICROSOFT_MODELS_BASE_URL"] = "https://example.com/inference"

  const models = await (await hooks()).provider!.models!({} as never, {} as never)

  expect(Object.keys(models).toSorted()).toEqual(["custom-model", "gpt-4o"])
  expect(models["gpt-4o"].api.npm).toBe("@ai-sdk/openai-compatible")
  expect(models["gpt-4o"].api.url).toBe("https://example.com/inference")
  expect(models["custom-model"].api.url).toBe("https://example.com/inference")
})

test("model helpers produce a complete model surface", () => {
  // Clear ambient overrides so the default surface is asserted.
  rememberEnv("MICROSOFT_MODELS")
  rememberEnv("MICROSOFT_MODELS_BASE_URL")
  delete process.env["MICROSOFT_MODELS"]
  delete process.env["MICROSOFT_MODELS_BASE_URL"]

  expect(readMicrosoftModels()).toContain("gpt-4.1")
  expect(readMicrosoftModelsBaseURL()).toBe(GITHUB_MODELS_INFERENCE_URL)

  const model = makeMicrosoftModel("gpt-4o-mini")
  expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
  expect(model.capabilities.toolcall).toBe(true)
  expect(model.limit.context).toBeGreaterThan(0)
})

// --- Dynamic OAuth loopback port (microsoft-oauth-dynamic-port) ---

test("buildRedirectUri produces the exact loopback redirect format", () => {
  expect(buildRedirectUri(53800)).toBe("http://127.0.0.1:53800/callback")
  expect(buildRedirectUri(42951)).toBe("http://127.0.0.1:42951/callback")
  expect(buildRedirectUri(1)).toBe("http://127.0.0.1:1/callback")
})

test("buildAuthorizeUrl uses the passed redirectUri literal for the redirect_uri param", async () => {
  const pkce = await generatePKCE()
  const state = generateState()
  const redirectUri = "http://127.0.0.1:49123/callback"
  const url = buildAuthorizeUrl(
    "example.onmicrosoft.com",
    pkce,
    state,
    "client-123",
    "openid profile",
    redirectUri,
  )
  expect(new URL(url).searchParams.get("redirect_uri")).toBe(redirectUri)
})

test("buildAuthorizeUrl redirect_uri reflects a different dynamic port", async () => {
  const pkce = await generatePKCE()
  const redirectUri = buildRedirectUri(0)
  const url = buildAuthorizeUrl("t", pkce, "s", "c", "openid", redirectUri)
  expect(new URL(url).searchParams.get("redirect_uri")).toBe(redirectUri)
})

test("startOAuthServer binds port 0, returns a real port and matching redirectUri; reuses it on second call", async () => {
  try {
    const first = await startOAuthServer()
    expect(first.port).toBeGreaterThan(0)
    expect(first.redirectUri).toBe(buildRedirectUri(first.port))

    const second = await startOAuthServer()
    expect(second).toEqual(first)
  } finally {
    stopOAuthServer()
  }
})

test("stopOAuthServer clears the port and allows a fresh bind on the next start", async () => {
  const first = await startOAuthServer()
  stopOAuthServer()
  try {
    const bound = await startOAuthServer()
    expect(bound.port).toBeGreaterThan(0)
    expect(bound.redirectUri).toBe(buildRedirectUri(bound.port))
  } finally {
    stopOAuthServer()
  }
})
