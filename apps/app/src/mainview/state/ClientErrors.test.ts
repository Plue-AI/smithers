import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { ClientErrorFetch, ClientErrorReport } from "./ClientErrors"
import {
  byteLength,
  CLIENT_ERROR_BODY_MAX_BYTES,
  CLIENT_ERROR_MESSAGE_MAX_BYTES,
  CLIENT_ERROR_REPORT_LIMIT,
  CLIENT_ERROR_STACK_MAX_BYTES,
  CLIENT_ERROR_TYPE_MAX_BYTES,
  CLIENT_ERROR_URL_MAX_BYTES,
  CLIENT_ERRORS_PATH,
  clientErrorBody,
  createClientErrorReporter,
  diagnosticText
} from "./ClientErrors"

/*
 * E14.4 — client errors reach a sink.
 *
 * Two halves are proved here, and only one of them is about this module.
 *
 * The half that matters is the CONTRACT with the sinks: the path the page
 * posts to is the path the Go backend routes (the desktop app's default
 * target, and Plue behind it) and the Worker routes for the web build, the
 * body decodes into the backend's report struct, the biggest body this
 * reporter can build is one the Worker will accept, measured in its unit
 * (UTF-8 bytes on the wire), and AppIsland.tsx reports through THIS module
 * rather than through a copy of it. Every one of those can break from a change
 * made in a different file, in a way nothing else in the suite would notice:
 * the sink would simply go quiet, which looks exactly like no crashes.
 *
 * The second half is the reporter's own behaviour. It is worth pinning because
 * the size bound above depends on the truncation being real.
 */

const readSource = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

/*
 * The Go backend is the sink the desktop app reaches through the relay. Its
 * router and report struct are read from source, so a rename on the Go side
 * turns this suite red instead of pointing every desktop crash at a 404.
 */
const goRouter = readSource("../../../../../packages/backend/internal/compose/router.go")
const goTelemetry = readSource("../../../../../packages/backend/internal/routes/telemetry.go")
/** The registered path: the top-level route group enclosing the handler, plus its own path. */
const goRoute = (): string => {
  const handler = /\.Post\("([^"]+)", telemetryHandler\.PostClientError\)/.exec(goRouter)
  expect(handler).not.toBeNull()
  const groups = [...goRouter.matchAll(/\n\tr\.Route\("([^"]+)"/g)].filter((group) => group.index < (handler?.index ?? 0))
  return `${groups.at(-1)?.[1]}${handler?.[1]}`
}
/** The json tags of one Go struct, by field order. */
const goJsonTags = (struct: string): Array<string> => {
  const body = new RegExp(`type ${struct} struct \\{([^}]*)\\}`).exec(goTelemetry)?.[1]
  expect(body).toBeDefined()
  return [...(body ?? "").matchAll(/json:"([^",]+)/g)].map((match) => match[1] as string)
}
const goConstant = (name: string): number => Number(new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(goTelemetry)?.[1])

/* The Worker route's cap (apps/server/src/proxies.ts CLIENT_ERROR_MAX_BODY). */
const SINK_MAX_BODY_BYTES = 16 * 1024
const mainSource = readSource("../main.tsx")
const islandSource = readSource("../AppIsland.tsx")
const watchdogSource = readSource("../StartupWatchdog.ts")

interface Sent {
  readonly input: string
  readonly init: RequestInit
}

const recordingFetch = (): { readonly sends: Array<Sent>; readonly fetchImpl: ClientErrorFetch } => {
  const sends: Array<Sent> = []
  const fetchImpl: ClientErrorFetch = (input, init) => {
    sends.push({ input, init })
    return Promise.resolve(new Response(null, { status: 204 }))
  }
  return { sends, fetchImpl }
}

const bodyOf = (sent: Sent): ClientErrorReport => JSON.parse(String(sent.init.body)) as ClientErrorReport
const reportOf = (posted: string): ClientErrorReport => JSON.parse(posted) as ClientErrorReport

describe("the client-error reporter's contract with the backend sink", () => {
  test("posts to the route the Go backend serves, by the method it routes", () => {
    // Red when either side renames the route: every desktop crash report
    // would 404 behind the relay and the backend's counter would stay flat.
    expect(CLIENT_ERRORS_PATH).toBe(goRoute())
    const { sends, fetchImpl } = recordingFetch()
    createClientErrorReporter({ fetchImpl, pathname: () => "/" }).report("error", new Error("boom"))
    expect(sends[0]?.input).toBe(CLIENT_ERRORS_PATH)
    expect(sends[0]?.init.method).toBe("POST")
  })

  test("the body decodes into the Go report struct and passes its client check", () => {
    // Red when a field is renamed on either side: Go's decoder drops an
    // unknown key silently, and a client other than "web" or "cli" is
    // answered 204 without being logged or counted.
    const posted = reportOf(clientErrorBody("error", new TypeError("boom"), new Date(0), "/chat"))
    expect(goJsonTags("ClientErrorReport")).toEqual(expect.arrayContaining(["client", "error", "context"]))
    expect(goJsonTags("ClientErrorDetail")).toEqual(expect.arrayContaining(Object.keys(posted.error)))
    expect(goJsonTags("ClientErrorContext")).toEqual(expect.arrayContaining(Object.keys(posted.context)))
    expect(goTelemetry).toContain(`report.Client != "${posted.client}"`)
    // The counter labels a known type by name; anything else is "other".
    expect(posted.error.type).toBe("TypeError")
    expect(goTelemetry).toContain(`"${posted.error.type}"`)
    expect(posted.error.message).toBe("boom")
    expect(posted.error.stack).toContain("ClientErrors.test")
    expect(posted.context.url).toBe("/chat")
  })

  test("cuts each field to the backend's own cap, so Go never splits a character", () => {
    // Go truncates by byte index, which can cut a UTF-8 sequence in half.
    expect(CLIENT_ERROR_MESSAGE_MAX_BYTES).toBe(goConstant("maxErrorMessageLen"))
    expect(CLIENT_ERROR_STACK_MAX_BYTES).toBe(goConstant("maxErrorStackLen"))
    expect(CLIENT_ERROR_TYPE_MAX_BYTES).toBe(goConstant("maxErrorTypeLen"))
    const error = new Error("亜".repeat(10_000))
    error.name = "亜".repeat(1_000)
    error.stack = "亜".repeat(10_000)
    const posted = reportOf(clientErrorBody("error", error, new Date(0), "/"))
    expect(byteLength(posted.error.message)).toBeLessThanOrEqual(CLIENT_ERROR_MESSAGE_MAX_BYTES)
    expect(byteLength(posted.error.message)).toBeGreaterThan(CLIENT_ERROR_MESSAGE_MAX_BYTES - 3)
    expect(byteLength(posted.error.stack)).toBeLessThanOrEqual(CLIENT_ERROR_STACK_MAX_BYTES)
    expect(byteLength(posted.error.stack)).toBeGreaterThan(CLIENT_ERROR_STACK_MAX_BYTES - 3)
    expect(byteLength(posted.error.type)).toBeLessThanOrEqual(CLIENT_ERROR_TYPE_MAX_BYTES)
  })

  test("bounds the body by the Worker route's number, in its own unit", () => {
    // The route measures `body.byteLength` — bytes on the wire — so the
    // client's bound has to be bytes too.
    expect(CLIENT_ERROR_BODY_MAX_BYTES).toBe(SINK_MAX_BODY_BYTES)
  })

  test("no report it can build exceeds the route's cap, in any alphabet", () => {
    // Red when the bound is raised, dropped, or counted in characters: the
    // route answers 413 and every one of these reports is lost, while the
    // client goes on believing it reported.
    const maxBody = SINK_MAX_BODY_BYTES
    const longPath = (unit: string): string => `/${unit.repeat(4_000)}`
    const runaways: ReadonlyArray<readonly [string, string, string]> = [
      ["ascii", "x".repeat(500_000), longPath("p")],
      // Three UTF-8 bytes a character: a stack trace in Japanese.
      ["japanese", "亜".repeat(500_000), longPath("亜")],
      // Four bytes, and two UTF-16 code units, so a slice can split one.
      ["astral", "\u{1d518}".repeat(200_000), longPath("\u{1d518}")],
      // JSON escapes a control character to six bytes.
      ["control", "\u0001".repeat(200_000), longPath("\u0001")],
      // A lone surrogate, which JSON.stringify escapes rather than emits.
      ["lone surrogate", "\ud800".repeat(200_000), longPath("\ud800")]
    ]
    for (const [name, runaway, path] of runaways) {
      const error = new Error(runaway)
      error.name = runaway
      error.stack = runaway
      const posted = clientErrorBody("error", error, new Date(0), path)
      // Named so a failure says which alphabet overflowed.
      expect({ name, over: byteLength(posted) > maxBody }).toEqual({ name, over: false })
      // A bound that cut the report to nothing would also pass the line
      // above. The point is to deliver the head of the stack.
      const report = reportOf(posted)
      expect({ name, kept: report.error.stack.length > 0 && report.error.message.length > 0 })
        .toEqual({ name, kept: true })
      expect(report.error.stack[0]).toBe(runaway[0] as string)
    }
  })

  test("caps the page path, so a runaway URL cannot crowd out the stack", () => {
    const posted = reportOf(clientErrorBody("error", new Error("boom"), new Date(0), `/${"亜".repeat(10_000)}`))
    expect(byteLength(posted.context.url)).toBeLessThanOrEqual(CLIENT_ERROR_URL_MAX_BYTES)
    expect(posted.error.message).toBe("boom")
  })

  test("main.tsx reports through this module and holds no bound of its own", () => {
    // The defect this pins: main.tsx once carried its own copy of the
    // reporter, with its own limit and its own truncation, so everything
    // asserted above was asserted about code the app never ran.
    // main.tsx renders AppIsland, and AppIsland is where the watchdog is built.
    expect(mainSource).toContain("from \"./AppIsland\"")
    expect(islandSource).toContain("from \"./StartupWatchdog\"")
    expect(watchdogSource).toContain("from \"./state/ClientErrors\"")
    expect(watchdogSource).toContain("createClientErrorReporter(")
    expect(watchdogSource).not.toMatch(/const CLIENT_ERROR/)
    expect(watchdogSource).not.toMatch(/\.slice\(0, 4_?000\)/)
    expect(watchdogSource).not.toMatch(/fetch\(\s*["'`]\/api\//)
  })

  test("main.tsx still routes both window listeners into a client-error report", () => {
    // Red when the wiring is deleted or one listener stops reporting. The
    // app keeps running, so nothing else here would ever notice.
    expect(watchdogSource).toContain("windowTarget.addEventListener(\"error\"")
    expect(watchdogSource).toContain("windowTarget.addEventListener(\"unhandledrejection\"")
    expect(watchdogSource).toMatch(/report\w*\("error"/)
    expect(watchdogSource).toMatch(/report\w*\("unhandledrejection"/)
  })

  test("no file in the app posts to a client-error path other than the constant", () => {
    // Red on the drift that started this effort: a literal renamed in one
    // place and left stale in another, with both sides still green.
    const literals = new Set<string>()
    const root = fileURLToPath(new URL("../../", import.meta.url))
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    for (const relative of files) {
      if (!/\.(ts|tsx)$/.test(relative)) continue
      if (relative.endsWith("ClientErrors.test.ts")) continue
      const text = readFileSync(`${root}${relative}`, "utf8")
      for (const match of text.matchAll(/["'`](\/api\/(?:client-error|telemetry\/error)[^"'`]*)["'`]/g)) {
        literals.add(match[1] as string)
      }
    }
    expect(files.length).toBeGreaterThan(50)
    expect([...literals]).toEqual([CLIENT_ERRORS_PATH])
  })
})

describe("the client-error reporter", () => {
  test("sends one JSON report carrying the kind, the stack, the page and the time", () => {
    const { sends, fetchImpl } = recordingFetch()
    const reporter = createClientErrorReporter({
      fetchImpl,
      now: () => new Date("2026-08-18T12:00:00.000Z"),
      pathname: () => "/chat"
    })
    reporter.report("error", new Error("boom"))
    expect(sends).toHaveLength(1)
    expect((sends[0]?.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json"
    )
    expect(sends[0]?.init.keepalive).toBe(true)
    const body = bodyOf(sends[0] as Sent)
    expect(body.kind).toBe("error")
    expect(body.context.url).toBe("/chat")
    expect(body.at).toBe("2026-08-18T12:00:00.000Z")
    expect(body.error).toMatchObject({ type: "Error", message: "boom" })
    expect(body.error.stack).toContain("ClientErrors.test")
  })

  test("diagnosticText keeps the stack, not just the error's name", () => {
    // Red if diagnosticText degrades to String(error): the startup panel
    // would read "Error: boom" for every crash and name no line of code.
    const message = diagnosticText(new Error("boom"))
    expect(message).toContain("ClientErrors.test")
  })

  test.each([
    ["WebKit frames", "boot@https://smithers.sh/app.js:3:1584", "StorageError: another database may exist\nboot@https://smithers.sh/app.js:3:1584"],
    ["Chromium heading", "StorageError: another database may exist\n    at boot (app.js:3:1584)", "StorageError: another database may exist\n    at boot (app.js:3:1584)"],
    ["CRLF heading", "StorageError: another database may exist\r\n    at boot (app.js:3:1584)", "StorageError: another database may exist\r\n    at boot (app.js:3:1584)"],
    ["heading without frames", "StorageError: another database may exist", "StorageError: another database may exist"],
    ["empty stack", "", "StorageError: another database may exist"],
    ["missing stack", undefined, "StorageError: another database may exist"]
  ] as const)("diagnosticText preserves the readable reason with %s", (_label, stack, expected) => {
    const error = new Error("another database may exist")
    error.name = "StorageError"
    error.stack = stack
    expect(diagnosticText(error)).toBe(expected)
  })

  test("diagnosticText keeps the full multiline reason before WebKit frames", () => {
    const error = new Error("The app-events store exceeds the limit.\nDownload a recovery file.")
    error.stack = "boot@https://smithers.sh/app.js:1:2"
    expect(diagnosticText(error)).toBe(`Error: ${error.message}\n${error.stack}`)
    error.stack = `Error: ${error.message}\n    at boot (app.js:1:2)`
    expect(diagnosticText(error)).toBe(error.stack)
  })

  test("diagnosticText preserves readable fields when the stack getter throws", () => {
    const error = new Error("Could not open the database")
    Object.defineProperty(error, "stack", { get() { throw new Error("cannot read stack") } })
    expect(diagnosticText(error)).toBe("Error: Could not open the database")
  })

  test("diagnosticText preserves the stack when the message getter throws", () => {
    const error = new Error("old message")
    error.stack = "boot@https://smithers.sh/app.js:1:2"
    Object.defineProperty(error, "message", { get() { throw new Error("cannot read message") } })
    expect(diagnosticText(error)).toBe("Error\nboot@https://smithers.sh/app.js:1:2")
  })

  test("diagnosticText contains hostile non-Error conversions", () => {
    expect(diagnosticText(Object.create(null))).toBe("[object Object]")
    expect(diagnosticText({
      [Symbol.toPrimitive]() { throw new Error("cannot stringify") },
      get [Symbol.toStringTag]() { throw new Error("cannot label") }
    })).toBe("Unknown error")
    expect(diagnosticText("plain rejection")).toBe("plain rejection")
    expect(diagnosticText(undefined)).toBe("undefined")
  })

  test("reports a rejection reason that is not an Error at all", () => {
    const { sends, fetchImpl } = recordingFetch()
    createClientErrorReporter({ fetchImpl, pathname: () => "/" }).report(
      "unhandledrejection",
      "plain string reason"
    )
    const body = bodyOf(sends[0] as Sent)
    expect(body.kind).toBe("unhandledrejection")
    expect(body.error).toEqual({ type: "", message: "plain string reason", stack: "" })
  })

  test("cuts a runaway message so the body it posts fits the cap", () => {
    const { sends, fetchImpl } = recordingFetch()
    createClientErrorReporter({ fetchImpl, pathname: () => "/" }).report("error", "y".repeat(100_000))
    expect(byteLength(String(sends[0]?.init.body))).toBeLessThanOrEqual(CLIENT_ERROR_BODY_MAX_BYTES)
    expect(bodyOf(sends[0] as Sent).error.message.startsWith("yyy")).toBe(true)
  })

  test.each([
    ["null-prototype object", Object.create(null), "[object Object]"],
    ["symbol", Symbol("rejected"), "Symbol(rejected)"],
    ["throwing conversion hooks", {
      [Symbol.toPrimitive]() { throw new Error("cannot stringify") },
      get [Symbol.toStringTag]() { throw new Error("cannot label") }
    }, "Unknown error"]
  ] as const)("delivers a report for a %s rejection reason without throwing", (_name, reason, message) => {
    const { sends, fetchImpl } = recordingFetch()
    const reporter = createClientErrorReporter({ fetchImpl, pathname: () => "/" })
    expect(() => reporter.report("unhandledrejection", reason)).not.toThrow()
    expect(sends).toHaveLength(1)
    expect(bodyOf(sends[0] as Sent)).toMatchObject({ kind: "unhandledrejection", error: { message } })
    expect(reporter.reported()).toBe(1)
  })

  test.each([
    ["clock callback", { now: () => { throw new Error("clock failed") } }],
    ["pathname callback", { pathname: () => { throw new Error("location failed") } }],
    ["date serialization", { now: () => new Date(NaN) }]
  ] as const)("contains failures in %s and still caps attempts", (_name, options) => {
    const { sends, fetchImpl } = recordingFetch()
    const reporter = createClientErrorReporter({ fetchImpl, pathname: () => "/", limit: 2, ...options })
    for (let index = 0; index < 3; index += 1) {
      expect(() => reporter.report("error", new Error("boom"))).not.toThrow()
    }
    expect(sends).toHaveLength(0)
    expect(reporter.reported()).toBe(2)
  })

  test("stops after the per-page cap however many times it is called", () => {
    const { sends, fetchImpl } = recordingFetch()
    const reporter = createClientErrorReporter({ fetchImpl, pathname: () => "/" })
    for (let index = 0; index < 25; index += 1) reporter.report("error", new Error(`e${index}`))
    expect(sends).toHaveLength(CLIENT_ERROR_REPORT_LIMIT)
    expect(reporter.reported()).toBe(CLIENT_ERROR_REPORT_LIMIT)
  })

  test("swallows a failing send instead of raising a second error", () => {
    const rejecting: ClientErrorFetch = () => Promise.reject(new Error("offline"))
    expect(() =>
      createClientErrorReporter({ fetchImpl: rejecting, pathname: () => "/" }).report(
        "error",
        new Error("boom")
      )
    ).not.toThrow()
    const throwing: ClientErrorFetch = () => {
      throw new TypeError("fetch is not defined")
    }
    expect(() =>
      createClientErrorReporter({ fetchImpl: throwing, pathname: () => "/" }).report(
        "error",
        new Error("boom")
      )
    ).not.toThrow()
  })
})

 test("operational reports have their own page budget", () => {
  const posts: unknown[] = []
  const reporter = createClientErrorReporter({ limit: 1, fetchImpl: async (_url, init) => {
    posts.push(JSON.parse(String(init.body))); return new Response()
  } })
  reporter.report("error", Error("crash"))
  reporter.report("error", Error("repeat"))
  reporter.report("operational", "run.pump")
  expect(posts).toHaveLength(2)
  expect(reporter.reported()).toBe(2)
})
