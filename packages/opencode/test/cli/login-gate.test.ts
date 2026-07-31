import { describe, expect, mock, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { createAuthIsolation } from "../lib/auth-isolation"

// Deterministic UI stubs. The admin bypass only prompts when stdin/stdout are
// TTYs, which they never are under bun test, so withFakeTTY() swaps in
// PassThrough streams with isTTY set. UI.input is stubbed via mock.module
// (registered before login-gate is imported below) so the answers are served
// synchronously instead of racing readline with timer-based drips — a stale
// drip could previously be consumed as the wrong prompt's answer and drive
// checkAdminBypass into process.exit(1), killing the whole test process.
let adminAnswers: string[] = []
let adminPrompted = false

void mock.module("../../src/cli/ui", () => ({
  UI: {
    Style: {
      TEXT_INFO: "",
      TEXT_NORMAL: "",
      TEXT_SUCCESS_BOLD: "",
      TEXT_DANGER_BOLD: "",
    },
    println: () => {
      adminPrompted = true
    },
    error: () => {},
    input: async () => adminAnswers.shift() ?? "",
  },
}))

// The OAuth flow is never supposed to run in these tests. If a regression lets
// the gate fall through to it, this stub keeps a real browser from opening.
// NOTE: the flow would still hang waiting for a callback — withTimeout rejects
// the assertion at 2s, but the dangling runMicrosoftOAuth keeps the OAuth
// server bound on port 53800 and only rejects after the ~5min callback
// timeout, at which point login-gate's catch calls process.exit(1), killing
// the whole test process. Fixing that (injectable layer / cancellable flow)
// is tracked; the stub at least prevents the real-browser side effect.
void mock.module("open", () => ({
  default: async () => {
    throw new Error("browser open() stubbed — OAuth flow should never be reached in login-gate tests")
  },
}))

// Import AFTER the mocks so login-gate picks up the stubs.
const { enforceMicrosoftLogin, hasMicrosoftAuth, storeMicrosoftTokens } = await import("../../src/cli/login-gate")

function withFakeTTY(): () => void {
  const originalStdin = process.stdin
  const originalStdout = process.stdout
  const fakeStdin = Object.assign(new PassThrough(), { isTTY: true })
  const fakeStdout = Object.assign(new PassThrough(), { isTTY: true })
  process.stdin = fakeStdin as unknown as typeof process.stdin
  process.stdout = fakeStdout as unknown as typeof process.stdout
  return () => {
    fakeStdin.destroy()
    fakeStdout.destroy()
    process.stdin = originalStdin
    process.stdout = originalStdout
  }
}

// Rejects when the promise does not settle quickly. Falling through to the
// OAuth flow would hang waiting for a browser callback, so a fast settle is
// the assertion that the gate short-circuited.
function withTimeout<T>(promise: Promise<T>, message: string, ms = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

describe("login gate admin bypass", () => {
  test("skips Microsoft login when MICROSOFT_LOGIN_BYPASS is set", async () => {
    adminPrompted = false
    process.env["MICROSOFT_LOGIN_BYPASS"] = "1"
    try {
      await withTimeout(
        enforceMicrosoftLogin(),
        "enforceMicrosoftLogin hung — bypass env var was not honored and it fell through to the OAuth flow",
      )
      // The bypass short-circuits before the admin prompt is ever reached.
      expect(adminPrompted).toBe(false)
    } finally {
      delete process.env["MICROSOFT_LOGIN_BYPASS"]
    }
  })

  test("accepts admin credentials bypass via the TTY prompt", async () => {
    delete process.env["MICROSOFT_LOGIN_BYPASS"]
    const restore = withFakeTTY()
    adminAnswers = ["admin", "opencode-admin"]
    adminPrompted = false
    try {
      await withTimeout(
        enforceMicrosoftLogin(),
        "enforceMicrosoftLogin hung — admin credentials were not accepted and it fell through to the OAuth flow",
      )
      expect(adminPrompted).toBe(true)
    } finally {
      restore()
    }
  })

  test('MICROSOFT_LOGIN_BYPASS must be exactly "1" to short-circuit', async () => {
    // "true" must NOT count as the bypass: the gate has to fall through to the
    // admin TTY prompt instead of returning early.
    process.env["MICROSOFT_LOGIN_BYPASS"] = "true"
    const restore = withFakeTTY()
    adminAnswers = ["admin", "opencode-admin"]
    adminPrompted = false
    try {
      await withTimeout(
        enforceMicrosoftLogin(),
        "enforceMicrosoftLogin hung — it fell through to the OAuth flow",
      )
      expect(adminPrompted).toBe(true)
    } finally {
      delete process.env["MICROSOFT_LOGIN_BYPASS"]
      restore()
    }
  })
})

// Isolated auth store (unique temp file per test file) — never touches the
// real ~/.local/share/opencode/auth.json, even without the test preload.
const { testEffectAuth } = createAuthIsolation()
const it = testEffectAuth()

describe("login gate OAuth state", () => {
  it.effect("persists Microsoft tokens and flips the auth state", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service

      // The isolated store starts empty, so the gate must not see an existing
      // session before anything is written.
      expect(yield* hasMicrosoftAuth).toBe(false)

      // Storing a valid oauth entry → gate must skip the interactive flow.
      yield* storeMicrosoftTokens({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
      })
      expect(yield* hasMicrosoftAuth).toBe(true)

      // A non-oauth entry under the same key must not count as authenticated.
      yield* auth.set("microsoft", { type: "api", key: "api-key" })
      expect(yield* hasMicrosoftAuth).toBe(false)
    }),
  )
})
