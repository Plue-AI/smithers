import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { command } from "./lib.mjs"
import { keyboardOnly, startBrowserStep, startMacRecording, startRemoteMacRecording } from "./record.mjs"
import { OUTSIDE_SAVE_SCRIPT, outsideSave, outsideVersions, sshTarget } from "./outside-save.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const origin = "https://factory.example"
const digest = value => createHash("sha256").update(value).digest("hex")

async function temporaryDirectory(t) {
  const parent = join(root, ".artifacts", "journey-record-unit")
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, "test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

// Browser and SSH fakes below are isolated unit boundaries, never journey evidence.
async function browserBoundary(t, options = {}) {
  const directory = await temporaryDirectory(t)
  const video = join(directory, "unit.webm")
  if (!options.missingVideo) await writeFile(video, options.emptyVideo ? "" : "unit video")
  const calls = []
  const inputs = []
  const screenshots = []
  let binding
  let initScript
  const page = {
    url: () => origin,
    click: () => assert.fail("pointer action escaped its guard"),
    keyboard: { press: async key => { calls.push(`key:${key}`) } },
    goto: async url => { calls.push(`goto:${url}`) },
    screenshot: async ({ path }) => {
      screenshots.push(path)
      if (options.screenshotFailure) throw new Error("screenshot failed")
      await writeFile(path, "unit screenshot")
    },
    video: () => options.noVideoHandle ? undefined : { path: async () => video },
  }
  const pages = [page]
  const context = {
    marker: "context-marker",
    tracing: {
      start: async () => { calls.push("trace.start") },
      stop: async ({ path }) => {
        calls.push("trace.stop")
        if (options.traceFailure) throw new Error("trace failed")
        await writeFile(path, "unit trace")
      },
    },
    exposeBinding: async (name, callback) => {
      assert.equal(name, "journeyInput")
      binding = callback
    },
    addInitScript: async (callback, parameters) => {
      assert.equal(parameters.expectedOrigin, origin)
      initScript = callback
    },
    newPage: async () => {
      if (options.pageFailure) throw new Error("page failed")
      return page
    },
    pages: () => pages,
    readMarker() { return this.marker },
    storageState: async () => {
      if (options.stateFailure) throw new Error("state failed")
      return { cookies: [] }
    },
    close: async () => {
      calls.push("context.close")
      if (options.contextFailure) throw new Error("context failed")
    },
  }
  const browser = {
    newContext: async () => {
      if (options.contextStartupFailure) throw new Error("context startup failed")
      return context
    },
    close: async () => {
      calls.push("browser.close")
      if (options.browserFailure) throw new Error("browser failed")
    },
  }
  const configuration = { browserType: { launch: async () => browser }, directory, origin, theme: "light",
    log: async entry => { inputs.push(entry) } }
  return { directory, video, calls, inputs, screenshots, page, context, configuration,
    get binding() { return binding }, get initScript() { return initScript } }
}

function installDOM(t, boundary) {
  const handlers = new Map()
  const events = []
  const location = { origin }
  const body = { append: () => {} }
  const focused = { tagName: "BUTTON", matches: () => true }
  const style = { outlineStyle: "solid", outlineWidth: "2px", outlineColor: "rgb(255, 0, 0)",
    outline: "2px solid rgb(255, 0, 0)", getPropertyValue: () => "#ff0000" }
  const document = { body, activeElement: focused,
    createElement: () => ({ style: {}, remove: () => {} }) }
  const globals = { location, document,
    addEventListener: (type, handler, capture) => {
      assert.equal(capture, true)
      handlers.set(type, handler)
    },
    requestAnimationFrame: callback => callback(),
    getComputedStyle: element => element === focused || element === body ? style : { color: "rgb(255, 0, 0)" },
    window: { journeyInput: event => { events.push(event) } },
  }
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    })
  }
  boundary.initScript({ expectedOrigin: origin })
  return { handlers, events, location, document, focused, style }
}

test("browser DOM listeners block every pointer input at the app, allow keyboard clicks and exclude GitHub", async t => {
  const boundary = await browserBoundary(t)
  const recording = await startBrowserStep(boundary.configuration)
  const dom = installDOM(t, boundary)
  for (const type of ["pointerdown", "mousedown", "touchstart", "click", "dblclick", "dragstart", "mouseover"]) {
    let prevented = 0
    let stopped = 0
    const event = { detail: 1, preventDefault: () => { prevented++ }, stopImmediatePropagation: () => { stopped++ } }
    dom.handlers.get(type)(event)
    assert.equal(prevented, 1, type)
    assert.equal(stopped, 1, type)
    assert.deepEqual(dom.events.at(-1), { origin, kind: "pointer", method: type, violation: `Pointer input: ${type}` })
  }
  const count = dom.events.length
  dom.handlers.get("click")({ detail: 0, preventDefault: () => assert.fail(), stopImmediatePropagation: () => assert.fail() })
  dom.location.origin = "https://github.com"
  dom.handlers.get("pointerdown")({ detail: 1, preventDefault: () => assert.fail(), stopImmediatePropagation: () => assert.fail() })
  assert.equal(dom.events.length, count)
  await recording.stop()
})

test("browser DOM keyboard receipts redact characters and detect absent focus, token, outline and wrong color", async t => {
  const boundary = await browserBoundary(t)
  const recording = await startBrowserStep(boundary.configuration)
  const dom = installDOM(t, boundary)
  dom.handlers.get("keydown")({ key: "s" })
  assert.equal(dom.events.at(-1).key, "character")
  assert.equal(dom.events.at(-1).violation, null)
  for (const change of [
    () => { dom.document.activeElement = null },
    () => { dom.document.activeElement = dom.document.body },
    () => { dom.focused.matches = () => false },
    () => { dom.style.getPropertyValue = () => "" },
    () => { dom.style.outlineStyle = "none" },
    () => { dom.style.outlineWidth = "0px" },
    () => { dom.style.outlineColor = "rgb(0, 0, 255)" },
  ]) {
    dom.document.activeElement = dom.focused
    dom.focused.matches = () => true
    Object.assign(dom.style, { outlineStyle: "solid", outlineWidth: "2px", outlineColor: "rgb(255, 0, 0)", getPropertyValue: () => "#ff0000" })
    change()
    dom.handlers.get("keydown")({ key: "Tab" })
    assert.equal(dom.events.at(-1).violation, "Focus or visible ring lost")
  }
  dom.location.origin = "https://github.com"
  dom.handlers.get("keydown")({ key: "Enter" })
  assert.equal(dom.events.at(-1).violation, null)
  assert.equal(dom.events[1].focus, null)
  assert.equal(dom.events[1].outline, null)
  await recording.stop()
})

test("browser screenshot queue is bounded, records every input and preserves the final evidence", async t => {
  const boundary = await browserBoundary(t)
  const recording = await startBrowserStep(boundary.configuration)
  const pending = Array.from({ length: 6 }, () => boundary.binding({ page: boundary.page }, { origin, kind: "keyboard", key: "Tab" }))
  pending.push(boundary.binding({ page: boundary.page }, { origin, kind: "keyboard", key: "character" }))
  pending.push(boundary.binding({ page: boundary.page }, { origin: "https://github.com", kind: "keyboard", key: "Enter" }))
  await Promise.all(pending)
  assert.equal(boundary.screenshots.length, 4)
  assert.equal(boundary.inputs.filter(entry => entry.event === "keyboard.input").length, 8)
  assert.equal(boundary.inputs.filter(entry => entry.event === "evidence.screenshot").length, 4)
  await boundary.binding({ page: boundary.page }, { origin, kind: "keyboard", key: "Escape" })
  assert.equal(boundary.screenshots.length, 5)
  const stopped = recording.stop()
  assert.equal(recording.stop(), stopped)
  await stopped
  assert.equal(boundary.screenshots.at(-1), join(boundary.directory, "final.png"))
  assert.equal(await readFile(boundary.screenshots[0], "utf8"), "unit screenshot")
})

test("browser returned context wraps new pages and listed pages while binding ordinary methods", async t => {
  const boundary = await browserBoundary(t)
  const recording = await startBrowserStep(boundary.configuration)
  assert.throws(() => (recording.context.pages()[0]).click(), /Keyboard-only/)
  const opened = await recording.context.newPage()
  assert.throws(() => opened.click(), /Keyboard-only/)
  await opened.keyboard.press("Enter")
  assert.equal(recording.context.readMarker(), "context-marker")
  assert.equal(recording.context.marker, "context-marker")
  await recording.stop()
})

test("page frame and popup wrappers retain keyboard guards and allow auth-page key receipts", async () => {
  const receipts = []
  const frame = { click: () => assert.fail(), press: () => "pressed" }
  const popup = { url: () => origin, click: () => assert.fail() }
  let currentOrigin = origin
  const page = { url: () => currentOrigin, title: "unit page", frames: () => [frame, frame],
    frame: () => null, waitForEvent: async type => type === "popup" ? popup : { type },
    press: () => "pressed" }
  const guarded = keyboardOnly(page, origin, async event => { receipts.push(event) })
  assert.equal(guarded.title, "unit page")
  assert.equal(guarded.frame(), null)
  for (const opened of guarded.frames()) assert.throws(() => opened.click(), /Keyboard-only/)
  const guardedPopup = await guarded.waitForEvent("popup")
  assert.throws(() => guardedPopup.click(), /Keyboard-only/)
  assert.deepEqual(await guarded.waitForEvent("download"), { type: "download" })
  currentOrigin = "https://github.com"
  assert.equal(guarded.press("Tab"), "pressed")
  assert.equal(receipts.at(-1).origin, "excluded")
})

test("browser stop aggregates independent evidence failures and closes every resource", async t => {
  const boundary = await browserBoundary(t, { screenshotFailure: true, stateFailure: true, traceFailure: true,
    contextFailure: true, browserFailure: true, noVideoHandle: true })
  const recording = await startBrowserStep(boundary.configuration)
  await assert.rejects(recording.stop(), error => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors.map(item => item.message), ["screenshot failed", "state failed", "trace failed", "Browser recording cleanup failed", "Browser video missing"])
    assert.deepEqual(error.errors[3].errors.map(item => item.message), ["context failed", "browser failed"])
    return true
  })
  assert.deepEqual(boundary.calls.slice(-3), ["trace.stop", "context.close", "browser.close"])
})

test("browser stop rejects absent or empty footage after successful trace and resource cleanup", async t => {
  for (const options of [{ noVideoHandle: true }, { missingVideo: true }, { emptyVideo: true }]) {
    const boundary = await browserBoundary(t, options)
    const recording = await startBrowserStep(boundary.configuration)
    await assert.rejects(recording.stop(), /video missing|ENOENT/)
    assert.deepEqual(boundary.calls.slice(-3), ["trace.stop", "context.close", "browser.close"])
  }
})

test("browser startup closes a browser without a context and reports cleanup failures", async t => {
  const boundary = await browserBoundary(t, { contextStartupFailure: true, browserFailure: true })
  await assert.rejects(startBrowserStep(boundary.configuration), error => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors[0].message, "context startup failed")
    assert.equal(error.errors[1].errors[0].message, "browser failed")
    return true
  })
  assert.deepEqual(boundary.calls, ["browser.close"])
})

function macProcess({ ignoreInterrupt = false, onInterrupt } = {}) {
  const child = new EventEmitter()
  child.pid = 900
  child.stderr = new PassThrough()
  child.signals = []
  child.kill = signal => {
    child.signals.push(signal)
    if (signal === "SIGINT") onInterrupt?.()
    if (signal !== "SIGINT" || !ignoreInterrupt) process.nextTick(() => child.emit("close", null, signal))
    return true
  }
  process.nextTick(() => child.emit("spawn"))
  return child
}

test("Mac stop waits its full production deadline before SIGKILL and fails without a finalized receipt", async t => {
  const directory = await temporaryDirectory(t)
  let child
  const recording = await startMacRecording({ path: join(directory, "unit.mov"), platform: "darwin",
    spawnImpl: () => { child = macProcess({ ignoreInterrupt: true }); return child } })
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const stopped = recording.stop()
  t.mock.timers.tick(9_999)
  assert.deepEqual(child.signals, ["SIGINT"])
  t.mock.timers.tick(1)
  await assert.rejects(stopped, /did not stop/)
  assert.deepEqual(child.signals, ["SIGINT", "SIGKILL"])
  assert.equal(recording.stop(), stopped)
})

test("Mac startup preserves both receipt and cleanup failures when its child ignores SIGINT", async t => {
  const directory = await temporaryDirectory(t)
  let cleanupStarted
  const interrupted = new Promise(resolve => { cleanupStarted = resolve })
  let child
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const started = startMacRecording({ path: join(directory, "unit.mov"), platform: "darwin",
    spawnImpl: () => { child = macProcess({ ignoreInterrupt: true, onInterrupt: cleanupStarted }); return child },
    log: async () => { throw new Error("start receipt failed") } })
  await interrupted
  t.mock.timers.tick(10_000)
  await assert.rejects(started, error => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors.map(item => item.message), ["start receipt failed", "Screen recording did not stop"])
    return true
  })
  assert.deepEqual(child.signals, ["SIGINT", "SIGKILL"])
})

test("Mac recording recognizes a child that already finalized before stop and uses the host platform default", async t => {
  const directory = await temporaryDirectory(t)
  const path = join(directory, "unit.mov")
  await writeFile(path, "unit finalized video")
  let child
  const started = startMacRecording({ path, spawnImpl: () => { child = macProcess(); return child } })
  if (process.platform !== "darwin") {
    await assert.rejects(started, /macOS/)
    return
  }
  const recording = await started
  child.emit("close", 0)
  assert.equal(await recording.stop(), path)
  assert.deepEqual(child.signals, [])
})

function remoteProcess({ initial = "READY\n", pid = 901, error, stdinError, stopError = false, closeEarly = false } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.inputs = []
  child.stdin.on("data", data => {
    const input = data.toString()
    child.inputs.push(input)
    if (input === "STOP\n") process.nextTick(() => child.emit("close", 0))
    else process.nextTick(() => {
      if (error) child.emit("error", new Error(error))
      else if (stdinError) child.stdin.emit("error", new Error(stdinError))
      else if (closeEarly) child.emit("close", 1)
      else child.stdout.write(initial)
    })
  })
  if (stopError) child.stdin.end = () => {
    process.nextTick(() => child.emit("close", 0))
    throw new Error("stdin stop failed")
  }
  child.kill = () => { child.emit("close", 1); return true }
  return child
}

test("remote startup rejects malformed or oversized READY messages, early exits and spawn errors without copying", async t => {
  const directory = await temporaryDirectory(t)
  for (const processOptions of [{ initial: "WRONG\n" }, { initial: "x".repeat(4097) },
    { closeEarly: true }, { error: "spawn failed", pid: null }, { stdinError: "stdin failed" }]) {
    let copies = 0
    await assert.rejects(startRemoteMacRecording({ target: "owner@unit-host", remotePath: "/tmp/unit.mov",
      path: join(directory, "unit.mov"), spawnImpl: () => remoteProcess(processOptions),
      execImpl: async () => { copies++ } }))
    assert.equal(copies, 0)
  }
})

test("remote stop refuses stdin transport errors and ignores later protocol output after READY", async t => {
  const directory = await temporaryDirectory(t)
  let child
  let copied = false
  const recording = await startRemoteMacRecording({ target: "owner@unit-host", remotePath: "/tmp/unit.mov",
    path: join(directory, "unit.mov"), spawnImpl: () => { child = remoteProcess({ stopError: true }); return child },
    execImpl: async () => { copied = true } })
  child.stdout.write("later protocol output\n")
  await assert.rejects(recording.stop(), /SSH did not finalize/)
  assert.equal(copied, false)
})

test("remote startup handles stdin write failure and preserves cleanup failure without an unsettled READY promise", async t => {
  const directory = await temporaryDirectory(t)
  let child
  const started = startRemoteMacRecording({ target: "owner@unit-host", remotePath: "/tmp/unit.mov",
    path: join(directory, "unit.mov"), spawnImpl: () => {
      child = remoteProcess({ stopError: true })
      child.stdin.write = () => { throw new Error("stdin config failed") }
      return child
    }, execImpl: async () => assert.fail("copy after startup failure") })
  await assert.rejects(started, error => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors.map(item => item.message), ["stdin config failed", "Remote recording SSH did not finalize"])
    return true
  })
})

const edits = { untouchedLine: 1, typedLine: 2, untouchedText: "safe", typedText: "overlap" }

function outsideBoundary(overrides = {}) {
  const requests = []
  const events = []
  const options = { target: "owner@unit-host", root: "/unit/worktree", path: "source.txt", ...edits,
    beforeSave: async () => {}, log: async event => { events.push(event) },
    execImpl: async (file, argv, { input }) => {
      const request = JSON.parse(input)
      requests.push(request)
      const content = request.action === "read" ? "one\ntwo\n" : request.content
      return { stdout: JSON.stringify({ content, digest: digest(content) }) }
    }, ...overrides }
  return { options, requests, events }
}

test("outside save writes private snapshots and rejects a wrong remote digest before the second write", async t => {
  const directory = await temporaryDirectory(t)
  const boundary = outsideBoundary({ evidenceDirectory: directory })
  await outsideSave(boundary.options)
  assert.equal(await readFile(join(directory, "outside-untouched.txt"), "utf8"), "safe\ntwo\n")
  assert.equal(await readFile(join(directory, "outside-overlap.txt"), "utf8"), "safe\noverlap\n")
  assert.equal((await stat(join(directory, "outside-untouched.txt"))).mode & 0o777, 0o600)
  const requests = []
  await assert.rejects(outsideSave(outsideBoundary({ execImpl: async (file, argv, { input }) => {
    const request = JSON.parse(input)
    requests.push(request.action)
    return { stdout: JSON.stringify({ content: "one\ntwo", digest: "wrong digest" }) }
  } }).options), /digest mismatch/)
  assert.deepEqual(requests, ["read", "write"])
})

test("outside save refuses to write without a successful snapshot and retains the first receipt on later cancellation", async t => {
  const directory = await temporaryDirectory(t)
  const unavailable = outsideBoundary({ evidenceDirectory: join(directory, "missing") })
  await assert.rejects(outsideSave(unavailable.options), /ENOENT/)
  assert.deepEqual(unavailable.requests.map(request => request.action), ["read"])
  const cancelled = outsideBoundary({ beforeSave: async kind => { if (kind === "overlap") throw new Error("typists cancelled") } })
  await assert.rejects(outsideSave(cancelled.options), /typists cancelled/)
  assert.deepEqual(cancelled.requests.map(request => request.action), ["read", "write"])
  assert.deepEqual(cancelled.events.map(event => event.event), ["outside-save.start", "outside-save.completed"])
  assert.equal(cancelled.events[1].kind, "untouched")
})

test("outside argument validation rejects absent text, absent roots and non-string SSH targets", async () => {
  for (const target of [null, undefined, 1]) assert.throws(() => sshTarget(target), /Unsafe SSH/)
  for (const rootValue of [undefined, "", 1]) await assert.rejects(outsideSave(outsideBoundary({ root: rootValue }).options), /root/)
  assert.throws(() => outsideVersions("one\ntwo", { ...edits, typedText: undefined }), /one line/)
})

test("actual outside-save Python reads UTF-8 and rejects symlink escapes and oversize writes without replacing files", async t => {
  const directory = await temporaryDirectory(t)
  const worktree = join(directory, "worktree")
  await mkdir(worktree)
  const file = join(worktree, "source.txt")
  await writeFile(file, "café\n")
  const invoke = payload => command("python3", ["-c", OUTSIDE_SAVE_SCRIPT], { input: JSON.stringify({ root: worktree, path: "source.txt", ...payload }) })
  const result = await invoke({ action: "read" })
  assert.deepEqual(JSON.parse(result.stdout), { content: "café\n", digest: digest("café\n") })
  await assert.rejects(invoke({ action: "write", content: "x".repeat(1_048_577) }), /exited 1/)
  assert.equal(await readFile(file, "utf8"), "café\n")
  const boundaryText = "x".repeat(1_048_576)
  const accepted = await invoke({ action: "write", content: boundaryText })
  assert.equal(JSON.parse(accepted.stdout).digest, digest(boundaryText))
  assert.equal((await stat(file)).size, 1_048_576)
  const external = join(directory, "external.txt")
  await writeFile(external, "outside root")
  await symlink(external, join(worktree, "escape.txt"))
  await assert.rejects(invoke({ action: "write", path: "escape.txt", content: "bad" }), /exited 1/)
  assert.equal(await readFile(external, "utf8"), "outside root")
  await writeFile(file, Buffer.from([0xff, 0xfe]))
  await assert.rejects(invoke({ action: "read" }), /exited 1/)
  await writeFile(file, "x".repeat(1_048_577))
  await assert.rejects(invoke({ action: "read" }), /exited 1/)
})

test("outside-save CLI reports missing input and malformed JSON rather than exiting with unsettled top-level await", async t => {
  const directory = await temporaryDirectory(t)
  const script = join(root, "scripts/journeys/outside-save.mjs")
  const missing = await command(process.execPath, [script]).then(() => assert.fail("missing options succeeded"), error => error)
  assert.match(missing.message, /exited 1$/)
  const options = join(directory, "invalid.json")
  await writeFile(options, "{not JSON")
  await assert.rejects(command(process.execPath, [script, options]), /exited 1$/)
})
