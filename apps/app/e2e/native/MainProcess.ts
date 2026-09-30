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
import { CString, JSCallback, type Pointer } from "bun:ffi"
import * as os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { fakeNativeWrapper } from "./FakeNativeWrapper.ts"
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
 * macOS delivers smithers:// links through Electrobun's native wrapper, faked
 * with 2.0.1's string lifetime (FakeNativeWrapper.ts, #3061): links that
 * arrive before launch are buffered, and each link is freed right after the
 * handler is called. Loading the fake SDK installs the SDK's own handler, a
 * threadsafe callback that emits "open-url" when its task runs, exactly as
 * `electrobun/main` does while it evaluates.
 */
const nativeWrapper = fakeNativeWrapper()
for (const url of scenario.openUrlsAtLaunch ?? []) nativeWrapper.openUrl(url)
const sdkUrlOpenHandler = new JSCallback(
  (url: Pointer) => emit("open-url", { url: new CString(url).toString() }),
  { args: ["ptr"], returns: "void", threadsafe: true }
)
mock.module("../../src/bun/NativeWrapper.ts", () => ({ nativeUrlOpenHost: () => nativeWrapper }))

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
  if (!sdkLoaded) nativeWrapper.setURLOpenHandler(sdkUrlOpenHandler.ptr!)
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

for (const url of scenario.openUrlsAfterStart ?? []) nativeWrapper.openUrl(url)

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
