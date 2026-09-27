/**
 * The deterministic Host bundle.
 *
 * It lives beside the contract suite because the two are one pair: the bundle
 * every Smithers test runs against, and the suite that proves it satisfies the
 * same closed Host list a real platform bundle does.
 *
 * **Node-only.** `effect/testing`'s `TestClock` reaches for `node:assert`, so
 * `scripts/browser-check.mjs` documents this module as a Node-only entry point
 * even though every service it composes is itself browser-safe.
 *
 * @since 1.0.0-rc.0
 */

import type { Jj } from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import * as BrowserChildProcessSpawner from "@smthrs/platform-browser/BrowserChildProcessSpawner"
import * as BrowserFileSystem from "@smthrs/platform-browser/BrowserFileSystem"
import { Effect, type FileSystem, Layer, Path, Random } from "effect"
import { TestClock } from "effect/testing"
import type { HttpClient as EffectHttpClient } from "effect/unstable/http/HttpClient"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/** POSIX-normalize so `/a/b`, `/a/b/`, and `/a/./b` are one key in the store. */
const normalize = (path: string): string => {
  const parts: Array<string> = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}

const enoent = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })

interface Entry {
  readonly type: "file" | "directory"
  readonly data: Uint8Array
}

/**
 * A Map-backed filesystem shaped like ZenFS, so the test bundle reuses the very
 * same `BrowserFileSystem` adapter the browser runs. A separate "test
 * FileSystem" would be a second implementation to keep honest; this way a bug in
 * the adapter shows up in tests.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeMemoryFs = (
  initial?: Readonly<Record<string, string>>
): BrowserFileSystem.ZenFsPromisesLike => {
  const entries = new Map<string, Entry>([["/", { type: "directory", data: new Uint8Array() }]])
  const encoder = new TextEncoder()

  const mkdirp = (path: string): void => {
    const parts = normalize(path).split("/").filter((p) => p !== "")
    let current = ""
    for (const part of parts) {
      current = `${current}/${part}`
      if (!entries.has(current)) entries.set(current, { type: "directory", data: new Uint8Array() })
    }
  }

  const put = (path: string, data: Uint8Array): void => {
    const key = normalize(path)
    mkdirp(key.replace(/\/[^/]*$/, "") || "/")
    entries.set(key, { type: "file", data: data.slice() })
  }

  for (const [path, contents] of Object.entries(initial ?? {})) put(path, encoder.encode(contents))

  const get = (path: string): Entry => {
    const entry = entries.get(normalize(path))
    if (entry === undefined) throw enoent(path)
    return entry
  }

  return {
    open: async (path) => {
      const entry = get(path)
      if (entry.type !== "file") throw enoent(path)
      return {
        read: async (buffer, offset, length, position) => {
          const bytesRead = Math.min(length, Math.max(0, entry.data.length - position))
          if (bytesRead > 0) {
            buffer.set(entry.data.subarray(position, position + bytesRead), offset)
          }
          return { bytesRead }
        },
        close: async () => {}
      }
    },
    readFile: async (path) => {
      const entry = get(path)
      if (entry.type !== "file") throw enoent(path)
      return entry.data.slice()
    },
    writeFile: async (path, data, options) => {
      if (options?.flag === "wx" && entries.has(normalize(path))) {
        throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" })
      }
      put(path, data)
    },
    mkdir: async (path, options) => {
      if (options?.recursive === true) mkdirp(path)
      else {
        const key = normalize(path)
        if (!entries.has(key.replace(/\/[^/]*$/, "") || "/")) throw enoent(path)
        entries.set(key, { type: "directory", data: new Uint8Array() })
      }
    },
    readdir: async (path) => {
      const dir = normalize(path)
      if (get(dir).type !== "directory") throw enoent(path)
      const prefix = dir === "/" ? "/" : `${dir}/`
      const names = new Set<string>()
      for (const key of entries.keys()) {
        if (key === dir || !key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const slash = rest.indexOf("/")
        names.add(slash === -1 ? rest : rest.slice(0, slash))
      }
      return [...names].sort()
    },
    realpath: async (path) => {
      get(path)
      return normalize(path)
    },
    stat: async (path) => {
      const entry = get(path)
      return {
        size: entry.data.byteLength,
        mode: entry.type === "directory" ? 0o040755 : 0o100644,
        /** Fixed epoch: file metadata must never make a test flaky. */
        mtimeMs: 0,
        isFile: () => entry.type === "file",
        isDirectory: () => entry.type === "directory",
        isSymbolicLink: () => false
      }
    },
    rm: async (path, options) => {
      const key = normalize(path)
      if (!entries.has(key)) {
        if (options?.force === true) return
        throw enoent(path)
      }
      const prefix = key === "/" ? "/" : `${key}/`
      if (
        entries.get(key)?.type === "directory" && options?.recursive !== true &&
        [...entries.keys()].some((other) => other !== key && other.startsWith(prefix))
      ) {
        throw Object.assign(new Error(`ENOTEMPTY: ${path}`), { code: "ENOTEMPTY" })
      }
      entries.delete(key)
      if (options?.recursive === true) {
        for (const other of [...entries.keys()]) {
          if (other.startsWith(prefix)) entries.delete(other)
        }
      }
    }
  }
}

/**
 * A scripted stand-in for just-bash: commands are looked up in a table, and an
 * unlisted command fails the way a real shell reports a missing binary. Tests
 * that need shell output declare it; tests that do not, cannot accidentally
 * depend on a host tool being installed.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeStubBash = (
  responses?: Readonly<
    Record<string, {
      stdout?: string
      stderr?: string
      exitCode?: number
      delayMs?: number
      pending?: boolean
    }>
  >
): BrowserChildProcessSpawner.JustBashLike => ({
  exec: async (command, options) => {
    const scripted = responses !== undefined && Object.hasOwn(responses, command) ? responses[command] : undefined
    if (scripted === undefined) {
      return { stdout: "", stderr: `command not found: ${command}\n`, exitCode: 127 }
    }
    if (scripted.delayMs !== undefined) {
      // Ambient `setTimeout` on purpose: this stub implements a foreign
      // promise-returning interface (`JustBashLike`), so there is no Effect
      // fiber here to sleep on `Clock`. The delay exists only to make a
      // scripted command observably slow to its caller.
      await new Promise((resolve) => setTimeout(resolve, scripted.delayMs))
    }
    if (scripted.pending === true) {
      await new Promise<never>((_resolve, reject) => {
        const signal = options?.signal
        if (signal?.aborted === true) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    }
    return {
      stdout: scripted.stdout ?? "",
      stderr: scripted.stderr ?? "",
      exitCode: scripted.exitCode ?? 0
    }
  }
})

/**
 * Seeded PRNG (mulberry32) as a `Random` layer.
 *
 * `Random.withSeed` exists but is an `Effect` combinator, and a Host bundle has
 * to be a `Layer` — so we provide the two-method `Random` reference directly.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerSeededRandom = (seed = 42): Layer.Layer<never> =>
  Layer.sync(Random.Random)(
    () => {
      let state = seed >>> 0
      const nextDoubleUnsafe = (): number => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      return {
        nextDoubleUnsafe,
        nextIntUnsafe: () => Math.floor(nextDoubleUnsafe() * Number.MAX_SAFE_INTEGER)
      }
    }
  )

/**
 * The complete deterministic Host surface.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TestHost =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | Jj
  | EffectHttpClient

/**
 * The deterministic Host bundle.
 *
 * Every source of nondeterminism is pinned: an in-memory filesystem, a scripted
 * interpreter, `TestClock` (time only moves when a test calls
 * `TestClock.adjust`), and a seeded PRNG. `Jj` reuses its package's
 * ticket-failing browser layer so a test that reaches for it fails loudly
 * instead of touching the real machine.
 * Each layer build allocates its own filesystem and restarts the PRNG from
 * the configured seed, including when the same layer value is reused.
 *
 * The spawner is provided *over* the filesystem and path layers, exactly the
 * way `NodeChildProcessSpawner` is, so the interpreter and the `FileSystem`
 * service agree about what exists rather than each holding its own store.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (options?: {
  readonly files?: Readonly<Record<string, string>>
  readonly commands?: Readonly<
    Record<string, {
      stdout?: string
      stderr?: string
      exitCode?: number
      delayMs?: number
      pending?: boolean
    }>
  >
  readonly seed?: number
}): Layer.Layer<TestHost> => {
  // Allocate per build while retaining the browser layer's isolation attestation.
  const isolatedFileSystem = Layer.unwrap(
    Effect.sync(() => BrowserFileSystem.layer(makeMemoryFs(options?.files)))
  ).pipe(Layer.orDie)
  const platform = Layer.mergeAll(
    isolatedFileSystem,
    // POSIX by design: the in-memory volume has no host path syntax.
    Path.layer
  )
  return Layer.mergeAll(
    platform,
    Layer.provide(BrowserChildProcessSpawner.layer(makeStubBash(options?.commands)), platform),
    HttpClient.layerNoop(),
    BrowserJj.layerUnsupported,
    TestClock.layer(),
    layerSeededRandom(options?.seed)
  )
}

/**
 * The zero-config bundle: empty filesystem, no scripted commands, seed 42.
 *
 * Reach for {@link layer} instead when a test needs seeded files, scripted
 * commands, or a different PRNG seed.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const TestHost: Layer.Layer<TestHost> = layer()
