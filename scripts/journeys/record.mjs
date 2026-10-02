import { spawn } from "node:child_process"
import { mkdir, stat } from "node:fs/promises"
import { join, dirname } from "node:path"
import { cli, command, createStepLog, isMain, childEnvironment } from "./lib.mjs"
import { sshTarget } from "./outside-save.mjs"

const quoteShell = (value) => `'${value.replaceAll("'", "'\\''")}'`
const remoteRecordingScript = `import sys,json,pathlib,subprocess,signal,os
os.umask(0o077)
p=json.loads(sys.stdin.readline())
path=pathlib.Path(p['path'])
path.parent.mkdir(parents=True,exist_ok=True)
if path.exists(): raise ValueError('recording path already exists')
child=subprocess.Popen(['/usr/sbin/screencapture','-v','-x',str(path)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def terminate(*args):
 if child.poll() is None:
  child.send_signal(signal.SIGINT)
  try: child.wait(timeout=10)
  except subprocess.TimeoutExpired: child.kill();child.wait();raise RuntimeError('recording stop timed out')
for sig in [signal.SIGHUP,signal.SIGTERM]: signal.signal(sig,terminate)
try:
 try: child.wait(timeout=0.1)
 except subprocess.TimeoutExpired: pass
 else: raise RuntimeError('recording failed to start')
 print('READY',flush=True)
 if sys.stdin.readline().strip()!='STOP': raise RuntimeError('recording control closed')
finally: terminate()
if child.returncode not in (0,-signal.SIGINT) or not path.exists() or path.stat().st_size==0: raise RuntimeError('recording did not finalize')
print('STOPPED',flush=True)`

export async function startRemoteMacRecording({ target, remotePath, path, log = async () => {}, spawnImpl = spawn, execImpl = command,
  startupTimeoutMs = 10_000, stopTimeoutMs = 15_000 }) {
  sshTarget(target)
  if (typeof remotePath !== "string" || !/^\/[a-zA-Z0-9_./-]+\.mov$/.test(remotePath) || remotePath.split("/").some((part, index) => index > 0 && (!part || part === "." || part === ".."))) throw new Error("Remote recording needs a safe absolute .mov path")
  if (typeof path !== "string" || !path || ![startupTimeoutMs, stopTimeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid recording path or timeout")
  await mkdir(dirname(path), { recursive: true })
  const child = spawnImpl("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target,
    `python3 -c ${quoteShell(remoteRecordingScript)}`], { env: childEnvironment(), stdio: ["pipe", "pipe", "pipe"], shell: false })
  let ended = false
  let exitCode
  let transportError
  let ready = false
  let output = ""
  let startupTimer
  let resolveReady
  let rejectReady
  const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const completed = new Promise((resolve) => child.once("close", (code) => {
    ended = true
    exitCode = code
    if (!ready) rejectReady(new Error("Remote recording ended before READY"))
    resolve()
  }))
  child.stderr.resume()
  child.on("error", (error) => { transportError = error; rejectReady(error) })
  child.stdin.on("error", (error) => { transportError = error; rejectReady(error) })
  child.stdout.on("data", (data) => {
    if (ready) return
    output += data.toString()
    if (output.length > 4096) rejectReady(new Error("Remote recording startup output exceeded its limit"))
    if (output.includes("\n")) {
      if (output.split("\n")[0].trim() !== "READY") rejectReady(new Error("Remote recording returned an invalid startup receipt"))
      else { ready = true; clearTimeout(startupTimer); resolveReady() }
    }
  })
  const stopSSH = async () => {
    if (!ended) {
      try { child.stdin.end("STOP\n") } catch (error) { transportError = error }
    }
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => { child.kill("SIGTERM"); resolve("timeout") }, stopTimeoutMs)
    })
    try {
      if (await Promise.race([completed, timeout]) === "timeout") {
        if (!ended) child.kill("SIGKILL")
        throw new Error("Remote recording did not stop in time")
      }
    } finally { clearTimeout(timer) }
    if (transportError || exitCode !== 0) throw new Error("Remote recording SSH did not finalize")
  }
  try {
    startupTimer = setTimeout(() => rejectReady(new Error("Remote recording READY timed out")), startupTimeoutMs)
    try { child.stdin.write(`${JSON.stringify({ path: remotePath })}\n`) } catch (error) { rejectReady(error) }
    await started
    await log({ event: "recording.remote.start", target, remotePath, path, pid: child.pid })
  } catch (error) {
    if (child.pid && !ended) {
      try { await stopSSH() } catch (cleanup) { throw new AggregateError([error, cleanup], "Remote recording startup and cleanup failed") }
    }
    throw error
  } finally { clearTimeout(startupTimer) }
  let stopping
  return { path, remotePath, target, stop() {
    return stopping ??= (async () => {
      await stopSSH()
      await execImpl("scp", ["-B", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", `${target}:${remotePath}`, path])
      if ((await stat(path)).size === 0) throw new Error("Remote recording copied empty footage")
      await log({ event: "recording.remote.stop", target, remotePath, path })
      return path
    })()
  } }
}

export async function startMacRecording({ path, platform = process.platform, spawnImpl = spawn, log = async () => {} }) {
  if (platform !== "darwin") throw new Error("Screen recordings require macOS")
  await mkdir(dirname(path), { recursive: true })
  const child = spawnImpl("/usr/sbin/screencapture", ["-v", "-x", path], { env: childEnvironment(), stdio: ["ignore", "ignore", "pipe"], shell: false })
  let ended = false
  let exitCode
  let exitSignal
  const completed = new Promise((resolve) => child.once("close", (code, signal) => { ended = true; exitCode = code; exitSignal = signal; resolve() }))
  child.stderr.resume()
  const stopProcess = async () => {
    if (!ended) child.kill("SIGINT")
    let timedOut = false
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); resolve() }, 10_000)
    })
    try { await Promise.race([completed, timeout]) } finally { clearTimeout(timer) }
    if (timedOut) throw new Error("Screen recording did not stop")
  }
  try {
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject) })
    await log({ event: "recording.start", path, pid: child.pid })
  } catch (error) {
    if (child.pid && !ended) {
      try { await stopProcess() } catch (cleanup) { throw new AggregateError([error, cleanup], "Screen recording startup and cleanup failed") }
    }
    throw error
  }
  let stopping
  return { path, pid: child.pid, stop() {
    return stopping ??= (async () => {
      await stopProcess()
      if ((exitCode !== 0 && !(exitCode === null && exitSignal === "SIGINT")) || (await stat(path)).size === 0) throw new Error("Screen recording did not finalize")
      await log({ event: "recording.stop", path })
      return path
    })()
  } }
}

const forbidden = new Set(["click", "dblclick", "hover", "tap", "dragTo", "check", "uncheck", "setChecked", "fill", "selectOption"])

export function keyboardOnly(page, origin, log = async () => {}) {
  const app = () => new URL(page.url()).origin === origin
  const wrap = (target, mouse = false) => new Proxy(target, { get(object, key) {
    const member = Reflect.get(object, key)
    if (key === "mouse") return wrap(member, true)
    if (key === "keyboard") return wrap(member)
    if (typeof member !== "function") return member
    return (...args) => {
      if (app() && (mouse || forbidden.has(key))) throw new Error(`Keyboard-only guard refused ${mouse ? "mouse." : ""}${String(key)}`)
      const result = member.apply(object, args)
      if (["locator", "getByRole", "getByText", "getByLabel", "getByTestId", "getByPlaceholder", "getByTitle", "getByAltText", "filter", "nth", "first", "last", "frameLocator", "contentFrame", "frame", "mainFrame"].includes(key)) return result && wrap(result)
      if (key === "frames") return result.map((frame) => wrap(frame))
      if (key === "waitForEvent" && args[0] === "popup") return result.then((popup) => keyboardOnly(popup, origin, log))
      if (["press", "type", "down", "up", "pressSequentially"].includes(key)) void log({ event: "keyboard.api", method: String(key), origin: app() ? "app" : "excluded" })
      return result
    }
  } })
  return wrap(page)
}

// One context per browser step gives each step its own video and trace.
// Storage state passes in memory to the next step and is never an artifact.
async function closeBrowser(context, browser) {
  const errors = []
  if (context) try { await context.close() } catch (error) { errors.push(error) }
  try { await browser.close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, "Browser recording cleanup failed")
}

export async function startBrowserStep({ browserType, directory, origin, theme, storageState, navigate = true, log = async () => {} }) {
  await mkdir(directory, { recursive: true })
  const browser = await browserType.launch({ headless: false })
  let context
  try {
    context = await browser.newContext({ colorScheme: theme, ...(storageState ? { storageState } : {}), recordVideo: { dir: directory } })
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    const violations = []
    let captureIndex = 0
    let pendingScreenshots = 0
    let captures = Promise.resolve()
    await context.exposeBinding("journeyInput", ({ page }, input) => {
      const screenshot = input.origin === origin && input.kind === "keyboard" &&
        ["Tab", "Enter", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(input.key) && pendingScreenshots < 4
      if (screenshot) pendingScreenshots++
      captures = captures.then(async () => {
        try {
        await log({ event: "keyboard.input", ...input })
        if (input.violation) violations.push(input.violation)
        if (screenshot) {
          const path = join(directory, `card-${++captureIndex}.png`)
          await page.screenshot({ path })
          await log({ event: "evidence.screenshot", path })
        }
        } finally { if (screenshot) pendingScreenshots-- }
      })
      return captures
    })
    await context.addInitScript(({ expectedOrigin }) => {
      const app = () => location.origin === expectedOrigin
      for (const type of ["pointerdown", "mousedown", "touchstart", "click", "dblclick", "dragstart", "mouseover"]) {
        addEventListener(type, (event) => {
          // A keyboard activation creates a click with detail=0.
          if (!app() || (type === "click" && event.detail === 0)) return
          event.preventDefault()
          event.stopImmediatePropagation()
          void window.journeyInput({ origin: location.origin, kind: "pointer", method: type, violation: `Pointer input: ${type}` })
        }, true)
      }
      addEventListener("keydown", (event) => {
        const key = event.key.length === 1 ? "character" : event.key
        requestAnimationFrame(() => {
          const element = document.activeElement
          const style = element && getComputedStyle(element)
          const focused = !!element && element !== document.body
          const ringToken = style?.getPropertyValue("--ring-border").trim()
          const probe = document.createElement("span")
          probe.style.color = "var(--ring-border)"
          document.body.append(probe)
          const ringColor = getComputedStyle(probe).color
          probe.remove()
          const ring = focused && ringToken && element.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && style.outlineColor === ringColor
          void window.journeyInput({ origin: location.origin, kind: "keyboard", key,
            focus: element?.tagName ?? null, outline: style?.outline ?? null,
            violation: app() && (!focused || !ring) ? "Focus or visible ring lost" : null })
        })
      }, true)
    }, { expectedOrigin: origin })
    const page = await context.newPage()
    if (navigate) await page.goto(origin)
    let stopping
    const guardedContext = new Proxy(context, { get(object, key) {
      const member = Reflect.get(object, key)
      if (key === "newPage") return async (...args) => keyboardOnly(await member.apply(object, args), origin, log)
      if (key === "pages") return () => member.call(object).map((opened) => keyboardOnly(opened, origin, log))
      return typeof member === "function" ? member.bind(object) : member
    } })
    return { page: keyboardOnly(page, origin, log), context: guardedContext, stop() {
      return stopping ??= (async () => {
      let state
      const errors = []
      const attempt = async (action) => {
        try { return await action() } catch (error) { errors.push(error) }
      }
      try {
        await attempt(() => captures)
        const screenshot = join(directory, "final.png")
        await attempt(() => page.screenshot({ path: screenshot }))
        state = await attempt(() => context.storageState())
        await attempt(() => context.tracing.stop({ path: join(directory, "trace.zip") }))
      } finally { await attempt(() => closeBrowser(context, browser)) }
      if (violations.length) errors.push(new Error(`Keyboard-only check failed: ${violations.join(", ")}`))
      const video = await attempt(async () => {
        const path = await page.video()?.path()
        if (!path || (await stat(path)).size === 0) throw new Error("Browser video missing")
        return path
      })
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Browser recording failed")
      await log({ event: "evidence.browser", directory, trace: join(directory, "trace.zip"), video })
      return { storageState: state, trace: join(directory, "trace.zip"), video }
      })()
    } }
  } catch (error) {
    try { await closeBrowser(context, browser) } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Browser recording initialization and cleanup failed")
    }
    throw error
  }
}

if (isMain(import.meta.url)) await cli(async () => {
  const { createInterface } = await import("node:readline/promises")
  const directory = new URL(`../../.artifacts/checks/C-J1-01/${new Date().toISOString()}/`, import.meta.url).pathname
  const log = await createStepLog(directory)
  const recording = await startMacRecording({ path: join(directory, "screen.mov"), log })
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try { await terminal.question("Recording. Press Enter to stop: ") } finally { terminal.close(); await recording.stop() }
})
