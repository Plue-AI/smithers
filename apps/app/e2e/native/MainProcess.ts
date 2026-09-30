/*
 * The native main process, run for real, with no window.
 *
 * apps/app/src/bun/index.ts is a top-level-await module: importing it starts
 * the local origin, registers the RPC surface and constructs the window as a
 * side effect, once per process. So it cannot be re-imported for a second
 * scenario, and `electrobun/main` cannot be imported inside `bun test` at all:
 * it dlopens a native wrapper and installs a quit handler that keeps the
 * process alive.
 *
 * This driver is the way around both. It replaces `electrobun/main` wholesale
 * with a recording fake, imports the REAL entrypoint, exercises the handlers
 * the entrypoint registered, probes the origin it started, and prints one
 * JSON report on stdout. src/bun/Main.test.ts spawns it once per scenario.
 *
 * Nothing here fakes the product. The fake stands in for the HOST: the
 * window and the system browser, exactly the parts a headless machine does
 * not have. The local server is the real one.
 */
import { mock } from "bun:test"
import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi"
import * as os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { PROBE_MARKER } from "./Probe.ts"
import type { NativeProbeReport, ProbeScenario, RecordedWindow } from "./Probe.ts"

const scenario: ProbeScenario = JSON.parse(process.env.SMITHERS_NATIVE_PROBE ?? "{}") as ProbeScenario
const openExternalAnswer = scenario.openExternalAnswer ?? true

const logs: Array<string> = []
const windows: Array<RecordedWindow> = []
const openedExternally: Array<string> = []
const results: Record<string, unknown> = {}
let requestNames: ReadonlyArray<string> = []
let messageNames: ReadonlyArray<string> = []
let handlers: Record<string, unknown> = {}

const originalLog = console.log
console.log = (...parts: ReadonlyArray<unknown>): void => {
  logs.push(parts.map((part) => String(part)).join(" "))
}

const fakeRpc = { proxy: { request: {}, send: {} } }

interface RpcConfig {
  readonly handlers: {
    readonly requests: Record<string, unknown>
    readonly messages: Record<string, unknown>
  }
}

const listeners = new Map<string, Array<(event: unknown) => void>>()
const emit = (name: string, data: unknown): void => {
  for (const listener of listeners.get(name) ?? []) listener({ name, data })
}

/*
 * A cold launch by URL, delivered the way Electrobun 2.0.1 delivers it (#1969).
 * macOS may call application:openURLs: before the SDK loads; the native
 * wrapper keeps those URLs, and setURLOpenHandler, called while
 * `electrobun/main` evaluates, flushes them synchronously into a threadsafe
 * JSCallback. Bun runs such a callback as a task, even from the JS thread.
 * So this fake flushes the launch URLs through a real threadsafe JSCallback,
 * called from native code (libc qsort's comparator) while the fake SDK module
 * is first imported: a listener registered any later than the entrypoint's
 * would miss them. It passes strings this process owns, so it does not model
 * the native wrapper freeing each link before the callback reads it (#3061).
 */
const nativeCallbacks: Array<JSCallback> = []
const flushLaunchUrlsLikeNative = (urls: ReadonlyArray<string>): void => {
  if (urls.length === 0) return
  const pending = [...urls]
  const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    qsort: { args: [FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.function], returns: FFIType.void }
  })
  const callback = new JSCallback(() => {
    const url = pending.shift()
    if (url !== undefined) emit("open-url", { url })
    return 0
  }, { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32, threadsafe: true })
  nativeCallbacks.push(callback)
  // qsort compares n-1 times at least for n elements; one comparison per URL.
  const items = new Int32Array(urls.length + 1)
  libc.symbols.qsort(ptr(items), items.length, 4, callback.ptr)
}

const fakeSdk = {
  default: {
    events: {
      on: (name: string, listener: (event: unknown) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener])
      }
    }
  },
  BuildConfig: {
    getSync: () => ({
      isPackaged: false,
      channel: "dev",
      defaultRenderer: "native"
    })
  },
  BrowserView: {
    defineRPC: (config: RpcConfig) => {
      requestNames = Object.keys(config.handlers.requests)
      messageNames = Object.keys(config.handlers.messages)
      handlers = config.handlers.requests
      return fakeRpc
    }
  },
  BrowserWindow: class FakeBrowserWindow {
    readonly webview: { readonly loadURL: (url: string) => void }
    constructor(options: { title: unknown; url: unknown; frame: unknown; rpc: unknown; hidden: unknown; activate: unknown }) {
      const loaded: Array<string> = []
      windows.push({
        title: options.title,
        url: options.url,
        frame: options.frame,
        hidden: options.hidden,
        activate: options.activate,
        rpcBound: options.rpc === fakeRpc,
        loaded
      })
      this.webview = { loadURL: (url) => { loaded.push(url) } }
    }
    activate(): void {}
  },
  Screen: {
    captureRegion: () => null
  },
  Utils: {
    openExternal: (url: string): boolean => {
      openedExternally.push(url)
      return openExternalAnswer
    }
  }
}
// Both specifiers resolve to one file of the npm stub, so they share one mock.
let sdkLoaded = false
const loadFakeSdk = (): typeof fakeSdk => {
  if (!sdkLoaded) flushLaunchUrlsLikeNative(scenario.openUrlsAtLaunch ?? [])
  sdkLoaded = true
  return fakeSdk
}
mock.module("electrobun/main", loadFakeSdk)
mock.module("electrobun/bun", loadFakeSdk)

// A probe must never restore or rewrite the signed-in user's real application state.
// The caller may own the home so it can reach the state a scenario leaves behind.
const givenHome = process.env.SMITHERS_NATIVE_PROBE_HOME
const probeHome = givenHome ?? await mkdtemp(join(os.tmpdir(), "smithers-native-probe-home-"))
const hostOs = { ...os, homedir: () => probeHome }
mock.module("node:os", () => hostOs)

await import("../../src/bun/index.ts")

for (const url of scenario.openUrlsAfterStart ?? []) emit("open-url", { url })

for (const exercise of scenario.exercises ?? []) {
  const handler = handlers[exercise.request]
  if (typeof handler !== "function") {
    results[exercise.label] = { probeError: `no handler named ${exercise.request}` }
    continue
  }
  results[exercise.label] = await (handler as (params: unknown) => unknown)(exercise.params)
}

const originLine = logs.find((line) => line.startsWith("SMITHERS_LOCAL_ORIGIN="))
const origin = originLine === undefined ? null : originLine.slice("SMITHERS_LOCAL_ORIGIN=".length)
const health = origin === null ? null : await fetch(`${origin}/api/health`).then((response) => response.json()).catch(() => null)

console.log = originalLog

const report: NativeProbeReport = {
  logs,
  windows,
  requestNames,
  messageNames,
  openedExternally,
  origin,
  health,
  results
}
await Bun.write(Bun.stdout, `${PROBE_MARKER}${JSON.stringify(report)}\n`)

if (givenHome === undefined) await rm(probeHome, { recursive: true, force: true })
process.exit(0)
