import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import {
  enforceMicrosoftLogin,
  hasMicrosoftAuth,
  storeMicrosoftTokens,
} from "../../src/cli/login-gate"
import { testEffect } from "../lib/effect"

// The admin bypass only prompts when stdin/stdout are TTYs, which they never
// are under bun test, so swap in PassThrough streams with isTTY set.
// bun's readline shim does not consume data buffered before rl.question is
// called, so the answers are dripped in after the prompt subscribes.
function withFakeTTY(answerLines: Array<[string, number]>): () => void {
  const originalStdin = process.stdin
  const originalStdout = process.stdout
  const fakeStdin = Object.assign(new PassThrough(), { isTTY: true })
  const fakeStdout = Object.assign(new PassThrough(), { isTTY: true })
  process.stdin = fakeStdin as unknown as typeof process.stdin
  process.stdout = fakeStdout as unknown as typeof process.stdout
  const drips = answerLines.map(([line, delay]) => setTimeout(() => fakeStdin.write(line), delay))
  return () => {
    for (const timer of drips) clearTimeout(timer)
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
    process.env["MICROSOFT_LOGIN_BYPASS"] = "1"
    try {
      await withTimeout(
        enforceMicrosoftLogin(),
        "enforceMicrosoftLogin hung — bypass env var was not honored and it fell through to the OAuth flow",
      )
    } finally {
      delete process.env["MICROSOFT_LOGIN_BYPASS"]
    }
  })

  test("accepts admin credentials bypass via the TTY prompt", async () => {
    delete process.env["MICROSOFT_LOGIN_BYPASS"]
    const restore = withFakeTTY([
      ["admin\n", 20],
      ["opencode-admin\n", 60],
      ["admin\nopencode-admin\n", 120],
    ])
    try {
      await withTimeout(
        enforceMicrosoftLogin(),
        "enforceMicrosoftLogin hung — admin credentials were not accepted and it fell through to the OAuth flow",
      )
    } finally {
      restore()
    }
  })
})

const it = testEffect(Auth.defaultLayer)

describe("login gate OAuth state", () => {
  it.effect("persists Microsoft tokens and flips the auth state", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const prior = yield* auth.get("microsoft")
      const priorAuthed = prior?.type === "oauth" && !!prior.access && !!prior.refresh

      return yield* Effect.gen(function* () {
        // The gate must agree with whatever is persisted before any writes.
        expect(yield* hasMicrosoftAuth).toBe(priorAuthed)

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
      }).pipe(
        // The helpers write to the real global auth.json, so restore whatever
        // was stored before the test to avoid destroying real credentials.
        Effect.ensuring(prior ? auth.set("microsoft", prior) : auth.remove("microsoft")),
      )
    }),
  )
})
