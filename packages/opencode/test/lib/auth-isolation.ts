// Auth store isolation for tests.
//
// `Auth` (src/auth/index.ts) computes its backing file once at module load:
// `path.join(Global.Path.data, "auth.json")` and reads/writes it through
// `FSUtil`. `Global.Path.data` only points at a scratch dir because the global
// test preload (`test/preload.ts`) sets `XDG_DATA_HOME` before any src import —
// an ambient guarantee that disappears if the tests are run without the preload
// (e.g. from the repo root, or through a different runner). Any write then
// lands in the user's real auth store (~/.local/share/opencode/auth.json) and
// can clobber real credentials.
//
// This helper makes isolation explicit instead of ambient: it compiles the
// `Auth` layer node with `FSUtil` replaced by a mock that redirects every
// auth.json read/write to a unique temp file per test file. The real store
// path is never read or written, so this works with or without the preload.
//
// Call `createAuthIsolation()` once at the top level of each test file. The
// returned `testEffectAuth` is bound to a store file unique to that call site,
// and the file-scoped `afterAll` registered here removes it when that test
// file finishes. This matters because bun runs all test files in one process:
// a single shared store would let one file's writes leak into the next file,
// and a module-level cleanup hook would run once after the first file only.
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { afterAll } from "bun:test"
import { Effect, Layer } from "effect"
import * as NFS from "fs/promises"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Auth } from "../../src/auth"
import { testEffect } from "./effect"

const isAuthFile = (filePath: string) => filePath.endsWith("auth.json")

export const createAuthIsolation = () => {
  const authTestFile = path.join(
    os.tmpdir(),
    `opencode-auth-test-${process.pid}-${randomUUID()}.json`,
  )

  afterAll(async () => {
    await NFS.rm(authTestFile, { force: true })
  })

  // Only readJson/writeJson are exercised by Auth; anything else throws the
  // Layer.mock UnimplementedError, which is exactly the signal we want if Auth
  // ever grows a new filesystem dependency.
  const redirectLayer = Layer.mock(FSUtil.Service, {
    readJson: (filePath) =>
      isAuthFile(filePath)
        ? Effect.tryPromise({
            try: async () => JSON.parse(await NFS.readFile(authTestFile, "utf8")),
            catch: (cause) => new FSUtil.FileSystemError({ method: "readJson", cause }),
          })
        : Effect.fail(
            new FSUtil.FileSystemError({
              method: "readJson",
              cause: new Error(`unexpected non-auth read: ${filePath}`),
            }),
          ),
    writeJson: (filePath, data, mode) =>
      isAuthFile(filePath)
        ? Effect.tryPromise({
            try: async () => {
              await NFS.writeFile(authTestFile, JSON.stringify(data, null, 2))
              if (mode !== undefined) await NFS.chmod(authTestFile, mode)
            },
            catch: (cause) => new FSUtil.FileSystemError({ method: "writeJson", cause }),
          })
        : Effect.fail(
            new FSUtil.FileSystemError({
              method: "writeJson",
              cause: new Error(`unexpected non-auth write: ${filePath}`),
            }),
          ),
  })

  const redirectNode = makeGlobalNode({
    service: FSUtil.Service,
    layer: redirectLayer,
    deps: [],
  })

  return {
    authTestFile,
    testEffectAuth: () => testEffect(LayerNode.compile(Auth.node, [[FSUtil.node, redirectNode]])),
  }
}
