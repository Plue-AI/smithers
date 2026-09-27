import * as NodePath from "@effect/platform-node/NodePath"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Fiber, FileSystem, Layer, Result } from "effect"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"

// A Windows helper must be an actual executable. This small SEA runs the
// adjacent test program in the same process, so cancellation kills the PID
// that owns the protocol streams, with no shell or orphaned wrapper child.
let windowsLauncher: string | undefined
let launcherDirectory: string | undefined
beforeAll(async () => {
  if (process.platform !== "win32") return
  launcherDirectory = await mkdtemp(join(tmpdir(), "smithers-batch-launcher-"))
  const main = join(launcherDirectory, "main.cjs")
  const config = join(launcherDirectory, "sea.json")
  windowsLauncher = join(launcherDirectory, "helper.exe")
  await writeFile(main, "const file=process.execPath+'.cjs';require('node:module').createRequire(file)(file)")
  await writeFile(
    config,
    JSON.stringify({
      main,
      output: windowsLauncher,
      disableExperimentalSEAWarning: true,
      execArgvExtension: "none"
    })
  )
  await promisify(execFile)(process.execPath, ["--build-sea", config], { timeout: 60_000 })
}, 60_000)
afterAll(async () => {
  if (launcherDirectory !== undefined) {
    await rm(launcherDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

const roots: Array<string> = []
const temporary = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-batch-failure-")))
  roots.push(root)
  return root
}
// Windows keeps a just-exited helper.exe locked for a moment (the image
// mapping and the runner's malware scan), so removal waits it out there.
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const guarded = (root: string, host = AtomicFileSystem.layer) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(host),
    Layer.provide(NodePath.layer),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )
const run = (
  root: string,
  requests: ReadonlyArray<KernelFileSystem.BatchRequest>,
  options: AtomicFileSystem.Options = {}
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return yield* KernelFileSystem.batch(fs)!.execute(requests)
    }).pipe(Effect.provide(guarded(root, AtomicFileSystem.layerWith(options))))
  )
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const executable = async (body: string) => {
  if (windowsLauncher !== undefined) {
    const path = join(await temporary(), "helper.exe")
    await copyFile(windowsLauncher, path)
    await writeFile(`${path}.cjs`, body)
    return path
  }
  const path = join(await temporary(), "helper")
  await writeFile(path, `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(body)}\n`)
  await chmod(path, 0o755)
  return path
}
const frame = (value: unknown) => {
  const body = JSON.stringify(value)
  return `flows-atomic/1 ${Buffer.byteLength(body)}\n${body}`
}
const writing = async (value: unknown) =>
  executable(
    `process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(frame(value))}));`
  )
const rootIdentity = async (root: string) => {
  const info = await lstat(root, { bigint: true })
  return `${info.dev}:${info.ino}`
}
const valueFor = (text: string, content = false) => ({
  digest: sha(text),
  sizeBytes: Buffer.byteLength(text),
  ...(content ? { base64: Buffer.from(text).toString("base64") } : {})
})

describe("batch resource ceilings", () => {
  it.each([-1, 0, 1])("enforces exact per-member response bytes at N%+i", async (delta) => {
    const root = await temporary()
    const text = "x".repeat(600)
    await writeFile(join(root, "a"), text)
    const n = Buffer.byteLength(JSON.stringify({ ok: true, value: valueFor(text, true) }))
    const response = await run(root, [{ operation: "digest", path: "a", content: true }], {
      limits: { batchEntry: n + delta }
    })
    const result = response.entries[0]!.result
    if (delta < 0) expect(result).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "BadResource" } } })
    else expect(Result.getOrThrow(result)).toMatchObject({ operation: "digest", digest: sha(text), sizeBytes: 600 })
  })

  it.each([-1, 0, 1])("enforces exact aggregate response bytes at N%+i", async (delta) => {
    const root = await temporary()
    await writeFile(join(root, "a"), "abc")
    const response = {
      ok: true,
      value: {
        rootIdentity: await rootIdentity(root),
        entries: [{ index: 0, path: join(root, "a"), result: { ok: true, value: valueFor("abc") } }]
      }
    }
    const n = Buffer.byteLength(JSON.stringify(response))
    const result = run(root, [{ operation: "digest", path: "a" }], { limits: { response: n + delta } })
    if (delta < 0) await expect(result).rejects.toMatchObject({ reason: { _tag: "BadResource" } })
    else expect(Result.getOrThrow((await result).entries[0]!.result)).toMatchObject({ digest: sha("abc") })
  })

  it.each([2, 3, 4])("retains the per-file content quota at %i bytes", async (size) => {
    const root = await temporary()
    await writeFile(join(root, "a"), "x".repeat(size))
    const response = await run(root, [{ operation: "digest", path: "a" }], { limits: { content: 3 } })
    if (size > 3) {
      expect(response.entries[0]!.result).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "BadResource" } }
      })
    } else {expect(Result.getOrThrow(response.entries[0]!.result)).toMatchObject({
        digest: sha("x".repeat(size)),
        sizeBytes: size
      })}
  })

  it("refuses unusably small entry/error ceilings and invalid batch limits", async () => {
    const root = await temporary()
    await writeFile(join(root, "a"), "a")
    await expect(run(root, [{ operation: "digest", path: "a" }], { limits: { batchEntry: 1 } })).rejects.toMatchObject({
      reason: { _tag: "BadResource" }
    })
    await expect(run(root, [{ operation: "digest", path: "a" }], { limits: { batchSize: 129 } })).rejects.toMatchObject(
      { reason: { _tag: "BadArgument" } }
    )
  })
})

describe("batch helper admission", () => {
  it("rejects empty, absent and excessive member arrays before starting a helper", async () => {
    const before = AtomicFileSystem.helperSpawns()
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const atomic = (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
        // A batch names its members, so neither `undefined` nor an empty list
        // is a request a caller can build. They reach an executor only across
        // the serialized boundary these stand in for, and are refused before
        // any helper starts.
        const malformed = [
          undefined,
          [],
          Array.from({ length: 129 }, () => ({ operation: "stat" as const, path: "/a" }))
        ] as unknown as ReadonlyArray<ReadonlyArray<KernelFileSystem.BatchRequest>>
        for (const requests of malformed) {
          expect(yield* Effect.flip(atomic.execute({ operation: "batch", requests }))).toMatchObject({
            reason: { _tag: "BadArgument" }
          })
        }
        expect(AtomicFileSystem.helperSpawns()).toBe(before)
      }).pipe(Effect.provide(AtomicFileSystem.layer))
    )
  })
  const mutations: ReadonlyArray<readonly [string, (value: any) => void]> = [
    ["foreign root", (value) => {
      value.rootIdentity = "0:0"
    }],
    ["missing entries", (value) => {
      value.entries = null
    }],
    ["incomplete entries", (value) => {
      value.entries.pop()
    }],
    ["out of range index", (value) => {
      value.entries[0].index = 9
    }],
    ["duplicate index", (value) => {
      value.entries[1].index = 0
    }],
    ["foreign path", (value) => {
      value.entries[0].path += "other"
    }],
    ["out of order", (value) => {
      value.entries.reverse()
    }],
    ["non object entry", (value) => {
      value.entries[0] = null
    }],
    ["bad envelope", (value) => {
      value.entries[0].result = { ok: 1 }
    }],
    ["non numeric size", (value) => {
      value.entries[0].result.value.sizeBytes = "1"
    }],
    ["oversized content", (value) => {
      value.entries[0].result.value.sizeBytes = 17 * 1024 * 1024
    }],
    ["invalid digest", (value) => {
      value.entries[0].result.value.digest = "BAD"
    }],
    ["non string digest", (value) => {
      value.entries[0].result.value.digest = 0
    }],
    ["missing requested content", (value) => {
      delete value.entries[0].result.value.base64
    }],
    ["mismatched size", (value) => {
      value.entries[0].result.value.sizeBytes = 2
    }]
  ]
  it.each(mutations)("fails closed on %s", async (_name, mutate) => {
    const root = await temporary()
    const value = {
      rootIdentity: await rootIdentity(root),
      entries: ["a", "b"].map((path, index) => ({
        index,
        path: join(root, path),
        result: { ok: true, value: valueFor("a", true) }
      }))
    }
    mutate(value)
    await expect(
      run(
        root,
        [{ operation: "digest", path: "a", content: true }, { operation: "digest", path: "b", content: true }],
        { executable: await writing({ ok: true, value }) }
      )
    ).rejects.toMatchObject({ reason: { _tag: "PermissionDenied" } })
  })

  it("rejects an oversized member even when the whole frame fits", async () => {
    const root = await temporary()
    const value = {
      rootIdentity: await rootIdentity(root),
      entries: [{ index: 0, path: join(root, "a"), result: { ok: true, value: valueFor("x".repeat(1024), true) } }]
    }
    await expect(
      run(root, [{ operation: "digest", path: "a", content: true }], {
        executable: await writing({ ok: true, value }),
        limits: { batchEntry: 256 }
      })
    ).rejects.toMatchObject({ reason: { _tag: "PermissionDenied" } })
  })

  it("retains per-path helper failures without inventing errno", async () => {
    const root = await temporary()
    const value = {
      rootIdentity: await rootIdentity(root),
      entries: [{ index: 0, path: join(root, "a"), result: { ok: false } }]
    }
    const response = await run(root, [{ operation: "digest", path: "a" }], {
      executable: await writing({ ok: true, value })
    })
    expect(response.entries[0]!.result).toMatchObject({
      _tag: "Failure",
      failure: { reason: { _tag: "PermissionDenied" } }
    })
  })

  it.each(["process.exit(7)", "process.stdout.write('x'.repeat(10000))"])(
    "fails closed on a crashed or overflowing helper: %s",
    async (body) => {
      const root = await temporary()
      await expect(
        run(root, [{ operation: "stat", path: "a" }], { executable: await executable(body), limits: { response: 256 } })
      ).rejects.toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }
  )

  it("kills a hung helper on its deadline", async () => {
    const root = await temporary()
    await expect(
      run(root, [{ operation: "stat", path: "a" }], {
        executable: await executable("setInterval(()=>{},1000)"),
        timeoutMs: 50
      })
    ).rejects.toMatchObject({
      reason: { _tag: "PermissionDenied", description: expect.stringContaining("did not answer within 50 ms") }
    })
  })

  it("cancels an active helper and releases its process permit", async () => {
    const root = await temporary()
    const marker = join(await temporary(), "pid")
    // A file exists before writeFileSync fills it. Keep that window open so
    // readiness cannot mistake Number("") === 0 for the helper's PID.
    const binary = await executable(
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'');
       setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},String(process.pid)),100);setInterval(()=>{},1000)`
    )
    const helperPid = async () => {
      for (let attempt = 0; attempt < 500; attempt++) {
        const pid = Number(await readFile(marker, "utf8").catch(() => undefined))
        if (Number.isInteger(pid) && pid > 0) return pid
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error("helper did not report its pid")
    }
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const pending = yield* KernelFileSystem.batch(fs)!.execute([{ operation: "stat", path: "a" }]).pipe(
          Effect.forkChild
        )
        const pid = yield* Effect.promise(helperPid)
        yield* Fiber.interrupt(pending)
        yield* Effect.promise(async () => {
          for (let attempt = 0; attempt < 500; attempt++) {
            try {
              process.kill(pid, 0)
            } catch {
              return
            }
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          throw new Error("cancelled helper survived")
        })
        // A second request reaches a new helper under the sole permit, then
        // cancellation tears it down too. No wall-clock timeout is the oracle.
        yield* Effect.promise(() => rm(marker))
        const next = yield* KernelFileSystem.batch(fs)!.execute([{ operation: "stat", path: "b" }]).pipe(
          Effect.forkChild
        )
        yield* Effect.promise(helperPid)
        yield* Fiber.interrupt(next)
      }).pipe(Effect.provide(guarded(root, AtomicFileSystem.layerWith({ executable: binary, concurrency: 1 }))))
    )
  })
})

describe("batch confinement and concurrent mutation", () => {
  it("refuses symlink and hard-link members while returning unrelated successes", async () => {
    const root = await temporary()
    const outside = await temporary()
    await writeFile(join(outside, "secret"), "outside")
    await symlink(join(outside, "secret"), join(root, "link"))
    await link(join(outside, "secret"), join(root, "hard"))
    await writeFile(join(root, "safe"), "inside")
    const response = await run(root, ["link", "hard", "safe"].map((path) => ({ operation: "digest", path })))
    const results = new Map(response.entries.map((entry) => [entry.index, entry.result]))
    expect(results.get(0)).toMatchObject({ _tag: "Failure" })
    expect(results.get(1)).toMatchObject({ _tag: "Failure" })
    expect(Result.getOrThrow(results.get(2)!)).toMatchObject({ digest: sha("inside") })
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("outside")
  })

  it("refuses an ancestor swapped after grants and before the helper starts", async () => {
    const root = await temporary()
    const outside = await temporary()
    await mkdir(join(root, "dir"))
    await writeFile(join(root, "dir/a"), "inside")
    await writeFile(join(outside, "a"), "outside")
    const host = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const atomic = (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
        return KernelFileSystem.withAtomicFileSystem(fs, {
          ...atomic,
          execute: (request) =>
            Effect.promise(async () => {
              await rename(join(root, "dir"), join(root, "moved"))
              await symlink(outside, join(root, "dir"))
            }).pipe(Effect.andThen(atomic.execute(request)))
        })
      })
    ).pipe(Layer.provide(AtomicFileSystem.layer))
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return yield* KernelFileSystem.batch(fs)!.execute([{ operation: "digest", path: "dir/a" }])
      }).pipe(Effect.provide(guarded(root, host)))
    )
    expect(result.entries[0]!.result).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "BadResource" } } })
  })
})
