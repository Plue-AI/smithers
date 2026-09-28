/*
 * The Electrobun main process (LOCAL-APP.md, "Runtime topology"). The only
 * file that imports the Electrobun SDK. The packaging supervisor supplies the
 * shared Go backend origin; this process opens one window and exposes only
 * platform transport/configuration doors. Product behavior stays in the
 * common backend and browser application.
 */
import type { SmithersNativeRPC } from "@smthrs/rpc/NativeRPC"
import type { BrowserWindow as NativeBrowserWindow } from "electrobun/main"
import { deepLinkPath } from "./DeepLink"
import { nativeBackendConfig } from "./NativeBackendConfig"
import { startNativeBackend } from "./NativeBackendProcess"
import { parseNativeApiOrigin } from "./NativeApiOrigin"
import { startNativeRendererServer } from "./NativeRendererServer"
import { createNativeShutdown } from "./NativeShutdown"
import { nativeStateDirectory } from "./NativeState"
import { encodeRgbaPng, startPackagedE2EBridge } from "./PackagedE2EBridge"
import { defaultDistDir, startLocalServer } from "./server"

// This must stay dynamic: Bun hoists external static imports even from lazy
// local modules. A daemon must never dlopen/initialize Electrobun's native SDK.
const { default: Electrobun, BrowserView, BrowserWindow, BuildConfig, Screen, Utils } = await import("electrobun/main")

/*
 * `smithers://open/<owner>/<repo>` (DeepLink.ts). Registered before anything
 * awaits: a cold launch by URL delivers it while the backend is still
 * starting, before a window exists, so the newest valid link waits in
 * `pendingDeepLink` and becomes the window's first URL. `SMITHERS_OPEN_URL`
 * is the same link for the dev build `smthrs open` starts.
 */
let pendingDeepLink: string | undefined
let openDeepLink: ((path: string) => void) | undefined
const receiveDeepLink = (url: string): void => {
  const path = deepLinkPath(url)
  if (path === null) {
    console.error("Refused a smithers:// link that is not smithers://open/<owner>/<repo>.")
    return
  }
  if (openDeepLink === undefined) pendingDeepLink = path
  else openDeepLink(path)
}
Electrobun.events.on(
  "open-url",
  (event: { readonly data: { readonly url: string } }) => receiveDeepLink(event.data.url)
)
const launchLink = Bun.env.SMITHERS_OPEN_URL
// Read once: the backend and agents inherit Bun.env.
delete Bun.env.SMITHERS_OPEN_URL
if (launchLink) receiveDeepLink(launchLink)

const headless = Bun.env.SMITHERS_LOCAL_HEADLESS === "1"
const hiddenE2EWindow = Bun.env.SMITHERS_E2E_BRIDGE === "1" && Bun.env.SMITHERS_NATIVE_E2E_VISIBLE !== "1"
const port = Bun.env.SMITHERS_LOCAL_PORT === undefined ? undefined : Number(Bun.env.SMITHERS_LOCAL_PORT)

/** http(s) only: the page must not launch arbitrary local schemes through the privileged side. */
const openExternal = async (url: string): Promise<boolean> => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false
  return Utils.openExternal(parsed.toString())
}

const stopResources = async (...stops: ReadonlyArray<() => unknown>): Promise<Array<unknown>> => {
  const results = await Promise.allSettled(stops.map((stop) => Promise.resolve().then(stop)))
  return results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
}

/** Application state that outlives a launch: macOS Application Support, else XDG data. */
const stateDir = nativeStateDirectory()

/*
 * The packaged E2E tier (e2e/packaged/PackagedApp.ts) spawns the BUILT app
 * and asserts `stub: <message>` in its transcript, so the deterministic agent
 * has to be inside this bundle; there is no seam to inject one through once
 * the binary is spawned. It is reached only behind SMITHERS_CHAT_STUB, and
 * it lives in the test tree with the tier that owns it.
 */
const stubAgent = Bun.env.SMITHERS_CHAT_STUB === "1"
  ? (await import("../../e2e/support/ChatStub")).createChatStub
  : undefined

let backendProcess: Awaited<ReturnType<typeof startNativeBackend>> | undefined
let rendererServer: ReturnType<typeof startNativeRendererServer> | undefined
let testServer: Awaited<ReturnType<typeof startLocalServer>> | undefined
let mainWindow: NativeBrowserWindow | undefined
let bridge: ReturnType<typeof startPackagedE2EBridge> | undefined
let rollback: "inactive" | "cleaning" | "finished" = "inactive"
// Quit waits until startup has acquired its resources or finished rolling them back.
const startupSettled = Promise.withResolvers<void>()
let backendFailure: Error | undefined
const shutdown = createNativeShutdown({
  stop: async () => {
    await startupSettled.promise
    if (rollback !== "inactive") return
    const failures = await stopResources(
      () => bridge?.stop(),
      () => rendererServer?.stop(),
      () => testServer?.stop(),
      () => backendProcess?.stop()
    )
    if (backendFailure !== undefined) failures.push(backendFailure)
    if (failures.length > 0) throw new AggregateError(failures, "Native runtime shutdown failed.")
  },
  quit: (code) => {
    if (rollback === "inactive") process.exit(code)
  },
  onBeforeQuit: (handler) => {
    Electrobun.events.on("before-quit", (event: { response?: { allow: boolean } }) => {
      if (rollback === "finished") return
      if (rollback === "cleaning") event.response = { allow: false }
      else handler(event)
    })
  },
  log: (message) => console.error(message)
})
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())

try {
  backendProcess = stubAgent === undefined
    ? await startNativeBackend({ stateDir, webRoot: defaultDistDir(import.meta.dir) })
    : undefined

  // The retired Bun product host survives only as the deterministic packaged
  // test fixture. Production receives the actual shared Go backend origin from
  // the issue12 supervisor, or connects directly to Plue.
  rendererServer = backendProcess !== undefined
    ? startNativeRendererServer(
      defaultDistDir(import.meta.dir),
      backendProcess.mode === "own"
        ? backendProcess.origin ?? "" :
        Bun.env.SMITHERS_API_ORIGIN ?? "",
      Bun.env.SMITHERS_API_TOKEN ?? ""
    )
    : undefined
  testServer = stubAgent === undefined ? undefined : await startLocalServer({
    ...(port === undefined ? {} : { port }),
    distDir: defaultDistDir(import.meta.dir),
    stateDir,
    agent: stubAgent,
    cloudMode: "offline",
    // This process is the desktop shell, so its renderer origin says so (`native.shell`).
    nativeShell: true
  })
  const backend = testServer === undefined
    ? nativeBackendConfig(
      rendererServer === undefined ? Bun.env : {
        SMITHERS_API_ORIGIN: rendererServer.origin,
        SMITHERS_RENDERER_ORIGIN: rendererServer.origin,
        SMITHERS_API_TOKEN: Bun.env.SMITHERS_API_TOKEN
      },
      backendProcess!,
      rendererServer?.origin
    )
    : {
      rendererOrigin: testServer.origin,
      target: {
        apiVersion: 1,
        mode: "native-own",
        apiOrigin: testServer.origin,
        auth: { kind: "session" },
        cors: "same-origin",
        developerExternal: false
      } as const,
      token: null,
      bootstrapToken: null
    }
  let selectedBackend = backend

  void backendProcess?.failure?.then((failure) => {
    if (failure === undefined) return
    backendFailure = failure
    console.error(failure.message)
    if (rollback === "inactive") void shutdown()
  })

  if (headless) {
    console.log("SMITHERS_LOCAL_HEADLESS=1: serving without a window")
  } else {
    const rpc = BrowserView.defineRPC<SmithersNativeRPC>({
      handlers: {
        requests: {
          openExternal: async ({ url }) => ({ opened: await openExternal(url) }),
          applicationTarget: async () => ({ target: selectedBackend.target }),
          applicationToken: async () => ({ token: selectedBackend.token }),
          applicationBootstrapToken: async () => ({ token: selectedBackend.bootstrapToken }),
          switchApplicationTarget: async ({ origin, token }) => {
            if (rendererServer === undefined) throw new Error("Native backend selection is unavailable.")
            const credential = token.trim()
            const next = parseNativeApiOrigin(origin)
            // WebView script cannot re-point the relay, its cookie jars and bearer without the user's native consent.
            const { response } = await Utils.showMessageBox({
              type: "warning",
              message: `Connect to ${next.origin}?`,
              buttons: ["Connect", "Cancel"],
              defaultId: 1,
              cancelId: 1
            })
            if (response !== 0) throw new Error("Backend switch cancelled.")
            rendererServer.setTarget(next.origin, credential)
            selectedBackend = {
              rendererOrigin: rendererServer.origin,
              target: {
                apiVersion: 1,
                mode: credential ? "native-plue" : "native-own",
                apiOrigin: rendererServer.origin,
                auth: { kind: credential ? "bearer" : "session" },
                cors: "same-origin",
                developerExternal: false
              },
              token: credential || null,
              bootstrapToken: null
            }
            return { target: selectedBackend.target }
          }
        },
        messages: {}
      }
    })

    // The local origin, never views:// and never a Vite dev server.
    mainWindow = new BrowserWindow({
      title: "Smithers",
      url: `${backend.rendererOrigin}${pendingDeepLink ?? "/"}`,
      rpc,
      hidden: hiddenE2EWindow,
      activate: !hiddenE2EWindow,
      frame: {
        width: 1180,
        height: 800,
        x: 100,
        y: 60
      }
    })
    const window = mainWindow
    openDeepLink = (path) => {
      window.webview.loadURL(`${backend.rendererOrigin}${path}`)
      void window.activate()
    }
  }

  interface RendererEvalResponse {
    readonly ok: boolean
    readonly json?: string
    readonly valueUndefined?: boolean
    readonly error?: string
  }

  interface RendererEvalRPC {
    readonly requestProxy?: {
      readonly evaluateJavascriptWithResponse: (
        params: { readonly script: string }
      ) => Promise<unknown>
    }
  }

  const evaluateInMainWindow = async (script: string): Promise<unknown> => {
    const window = mainWindow
    if (window === undefined) throw new Error("The main WebView is not available.")
    // WKWebView may defer animation-driven rendering while another application
    // is frontmost. Packaged E2E assertions and captures must observe this app,
    // not whichever window happened to have focus when the runner launched it.
    if (!hiddenE2EWindow) {
      await window.activate()
      await Bun.sleep(50)
    }
    const rpc = window.webview.rpc as RendererEvalRPC | undefined
    const evaluator = rpc?.requestProxy?.evaluateJavascriptWithResponse
    if (evaluator === undefined) throw new Error("The main WebView is not available.")
    const response = await evaluator({
      script: `
return (async () => {
  try {
    const value = await (async () => {
${script}
    })()
    const serialized = JSON.stringify(value)
    if (serialized === undefined && value !== undefined) {
      throw new Error("The evaluation result is not JSON-serializable.")
    }
    return { ok: true, json: serialized ?? "null", valueUndefined: value === undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})()
`
    })
    if (typeof response !== "object" || response === null || !("ok" in response)) {
      throw new Error(`Renderer evaluation failed: ${String(response)}`)
    }
    const result = response as RendererEvalResponse
    if (!result.ok) throw new Error(result.error ?? "Renderer evaluation failed.")
    if (result.valueUndefined === true) return undefined
    if (typeof result.json !== "string") throw new Error("Renderer evaluation returned no serialized value.")
    return JSON.parse(result.json)
  }

  bridge = startPackagedE2EBridge({
    state: () => {
      const build = BuildConfig.getSync()
      const window = mainWindow
      return {
        app: {
          pid: process.pid,
          origin: backend.rendererOrigin,
          packaged: build.isPackaged,
          channel: build.channel,
          defaultRenderer: build.defaultRenderer
        },
        window: window === undefined ? null : {
          id: window.id,
          webviewId: window.webviewId,
          renderer: window.renderer,
          url: window.url,
          frame: window.getFrame()
        }
      }
    },
    evaluate: evaluateInMainWindow,
    screenshot: async () => {
      const window = mainWindow
      if (window === undefined || hiddenE2EWindow) return null
      await window.activate()
      await Bun.sleep(100)
      const frame = window.getFrame()
      if (frame === undefined) return null
      const width = Math.round(frame.width)
      const height = Math.round(frame.height)
      const pixels = Screen.captureRegion({ x: frame.x, y: frame.y, width, height })
      return pixels === null ? null : encodeRgbaPng(width, height, pixels)
    },
    quit: shutdown
  })

  console.log("Smithers app started!")
} catch (error) {
  // Closing the window or a concurrent backend failure can request shutdown.
  // Startup rollback owns cleanup and its failure until it finishes.
  rollback = "cleaning"
  const failures = await stopResources(
    () => bridge?.stop(),
    () => mainWindow?.close(),
    () => rendererServer?.stop(),
    () => testServer?.stop(),
    () => backendProcess?.stop()
  )
  const failure = failures.length > 0
    ? new AggregateError([error, ...failures], "Native runtime startup failed.", { cause: error })
    : error
  console.error(failure)
  rollback = "finished"
  // The SDK routes process.exit through before-quit and may return after
  // requesting native shutdown. Preserve the rejection in that case too.
  process.exit(1)
  throw failure
} finally {
  startupSettled.resolve()
}
