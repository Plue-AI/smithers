import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { end, type Event, item, merge as mergeEvents, parse, start } from "../notes/calendar-events/events.ts"
import * as EventsFlowFile from "../notes/calendar-events/flow.ts"
import EventsFlow from "../notes/calendar-events/flow.ts"
import { day } from "../notes/note.ts"
import * as TractionFlowFile from "../notes/traction/flow.ts"
import TractionFlow from "../notes/traction/flow.ts"
import { header, merge as mergeTraction } from "../notes/traction/traction.ts"

const fixture = (name: string) => readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8")

/** A real local HTTP server whose routes a test rewrites between runs; it records every request. */
const serve = async (t: TestContext) => {
  const routes = new Map<string, { status: number; body: string }>()
  const requests: Array<string> = []
  const server: Server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    const route = routes.get(request.url ?? "")
    response.writeHead(route?.status ?? 404, { "content-type": "application/json" })
    response.end(route?.body ?? "{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, routes, requests }
}

const workspace = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "notes-flow-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

/** A real in-memory engine running `flow` with `implementation`. */
const engine = (t: TestContext, flow: any, implementation: Layer.Layer<any, never, any>) => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(Interpreter.layer(flow), implementation).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    ) as Layer.Layer<any, never, never>
  )
  t.after(() => runtime.dispose())
  return runtime
}

const errorOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  const found = Exit.findErrorOption(exit)
  return found._tag === "Some" ? found.value : undefined
}

// ---------------------------------------------------------------- traction

const row = (date: string, status = "ok") => `| ${date} | 1 | 30 | 5 | 2 | ${status} |`
const title = "## npm pkg · GitHub o/r"

test("traction merge creates its section, appends by date, keeps a complete row and replaces a failed one", () => {
  const created = mergeTraction("", title, "2026-09-30", row("2026-09-30"))
  assert.equal(created.outcome, "added")
  assert.equal(created.text, `${title}\n\n${header}\n|---|---|---|---|---|---|\n${row("2026-09-30")}\n`)

  const prose = "# Traction\n\nHand notes.\n"
  const appended = mergeTraction(prose, title, "2026-09-30", row("2026-09-30"))
  assert.equal(appended.text.startsWith(`${prose}\n${title}\n`), true)

  const next = mergeTraction(`${created.text}\n## Later\n`, title, "2026-10-01", row("2026-10-01"))
  assert.equal(next.outcome, "added")
  assert.match(
    next.text,
    new RegExp(`${row("2026-09-30").replace(/\|/g, "\\|")}\n${row("2026-10-01").replace(/\|/g, "\\|")}\n\n## Later`)
  )

  const kept = mergeTraction(created.text, title, "2026-09-30", row("2026-09-30", "failed: github (HTTP 503)"))
  assert.deepEqual([kept.outcome, kept.text, kept.row], ["unchanged", created.text, row("2026-09-30")])

  const failed = mergeTraction("", title, "2026-09-30", row("2026-09-30", "failed: github (HTTP 503)")).text
  const replaced = mergeTraction(failed, title, "2026-09-30", row("2026-09-30"))
  assert.deepEqual([replaced.outcome, replaced.text], ["replaced", created.text])
  const again = mergeTraction(failed, title, "2026-09-30", row("2026-09-30", "failed: github (HTTP 503)"))
  assert.equal(again.outcome, "unchanged")

  // A section whose table was deleted by hand gets a fresh table, not a second heading.
  const bare = mergeTraction(`${title}\n\n## Other\n`, title, "2026-09-30", row("2026-09-30"))
  assert.equal(bare.text, `${title}\n\n${header}\n|---|---|---|---|---|---|\n${row("2026-09-30")}\n\n## Other\n`)
})

const tractionPayload = { note: "Traction.md", npmPackage: "@smthrs/cli", repository: "smithersai/smithers" }

const healthy = (routes: Map<string, { status: number; body: string }>) => {
  routes.set("/downloads/point/last-day/@smthrs/cli", { status: 200, body: JSON.stringify({ downloads: 845 }) })
  routes.set("/downloads/point/last-month/@smthrs/cli", { status: 200, body: JSON.stringify({ downloads: 124104 }) })
  routes.set("/repos/smithersai/smithers", {
    status: 200,
    body: JSON.stringify({ stargazers_count: 338, forks_count: 43 })
  })
}

test("the traction flow writes one row a day, records a failed source in the note, and recovers the same day", {
  timeout: 60_000
}, async (t) => {
  const root = await workspace(t)
  const api = await serve(t)
  healthy(api.routes)
  let now = new Date("2026-09-30T16:00:00Z")
  const runtime = engine(
    t,
    TractionFlow,
    TractionFlowFile.make({ root, fetch: globalThis.fetch, now: () => now, npm: api.base, github: api.base })
  )
  await writeFile(join(root, "Traction.md"), "# Traction\n")

  const first = await runtime.runPromise(TractionFlow.execute(tractionPayload, { executionId: "traction-1" }))
  assert.deepEqual(first, {
    note: "Traction.md",
    date: "2026-09-30",
    row: "| 2026-09-30 | 845 | 124104 | 338 | 43 | ok |",
    outcome: "added",
    failures: []
  })
  const written = await readFile(join(root, "Traction.md"), "utf8")

  // A repeated input the same day edits nothing.
  const repeat = await runtime.runPromise(TractionFlow.execute(tractionPayload, { executionId: "traction-2" }))
  assert.equal(repeat.outcome, "unchanged")
  assert.equal(await readFile(join(root, "Traction.md"), "utf8"), written)

  // A failed source the next day is visible in the note and fails the run with its receipt.
  now = new Date("2026-10-01T16:00:00Z")
  api.routes.set("/repos/smithersai/smithers", { status: 503, body: "<html>secret upstream page</html>" })
  const failed = await runtime.runPromiseExit(TractionFlow.execute(tractionPayload, { executionId: "traction-3" }))
  assert.deepEqual(errorOf(failed), {
    note: "Traction.md",
    date: "2026-10-01",
    row: "| 2026-10-01 | 845 | 124104 | — | — | failed: github (HTTP 503) |",
    outcome: "added",
    failures: ["github (HTTP 503)"]
  })
  assert.doesNotMatch(await readFile(join(root, "Traction.md"), "utf8"), /secret upstream page/)

  // The source recovers the same day: the failed row is replaced, never duplicated.
  healthy(api.routes)
  const recovered = await runtime.runPromise(TractionFlow.execute(tractionPayload, { executionId: "traction-4" }))
  assert.equal(recovered.outcome, "replaced")
  const note = await readFile(join(root, "Traction.md"), "utf8")
  assert.equal(note.match(/\| 2026-10-01 \|/g)?.length, 1)
  assert.equal(note.match(/^## npm @smthrs\/cli · GitHub smithersai\/smithers$/gm)?.length, 1)
  assert.match(note, /^# Traction\n\n## npm/)

  // Every request was a read.
  assert.equal(api.requests.every((request) => request.startsWith("GET ")), true)
  assert.equal(api.requests.length, 12)
})

test("an unreachable or malformed source is named without response text", { timeout: 60_000 }, async (t) => {
  const root = await workspace(t)
  const api = await serve(t)
  api.routes.set("/downloads/point/last-day/pkg", { status: 200, body: "not json" })
  api.routes.set("/downloads/point/last-month/pkg", { status: 200, body: JSON.stringify({ downloads: -4 }) })
  const runtime = engine(
    t,
    TractionFlow,
    TractionFlowFile.make({
      root,
      fetch: globalThis.fetch,
      now: () => new Date("2026-09-30T00:00:00Z"),
      npm: api.base,
      github: "http://127.0.0.1:1"
    })
  )
  const exit = await runtime.runPromiseExit(
    TractionFlow.execute({ note: "T.md", npmPackage: "pkg", repository: "o/r" }, { executionId: "traction-down" })
  )
  const receipt = errorOf(exit)
  assert.equal(
    typeof receipt === "object" && "row" in receipt && receipt.row,
    "| 2026-09-30 | — | — | — | — | failed: npm 1d (invalid response); npm 30d (invalid response); github (unreachable) |"
  )
  assert.match(await readFile(join(root, "T.md"), "utf8"), /github \(unreachable\)/)
})

test("the traction flow refuses notes outside the workspace and payloads that could reshape its URLs", {
  timeout: 60_000
}, async (t) => {
  const root = await workspace(t)
  const outside = await workspace(t)
  await mkdir(join(root, "linked"))
  await symlink(outside, join(root, "escape"))
  await symlink(join(outside, "x.md"), join(root, "linked", "x.md"))
  const api = await serve(t)
  healthy(api.routes)
  const runtime = engine(
    t,
    TractionFlow,
    TractionFlowFile.make({ root, fetch: globalThis.fetch, now: () => new Date(), npm: api.base, github: api.base })
  )
  const refused = async (payload: typeof tractionPayload, id: string) =>
    errorOf(await runtime.runPromiseExit(TractionFlow.execute(payload, { executionId: id })))
  assert.equal(await refused({ ...tractionPayload, note: "../x.md" }, "r1"), "note must stay inside the workspace")
  assert.equal(
    await refused({ ...tractionPayload, note: join(outside, "x.md") }, "r2"),
    "note must be a relative .md path"
  )
  assert.equal(await refused({ ...tractionPayload, note: "escape/x.md" }, "r3"), "note must stay inside the workspace")
  assert.equal(await refused({ ...tractionPayload, note: "linked/x.md" }, "r4"), "note must be a regular file")
  assert.equal(await refused({ ...tractionPayload, note: "missing/x.md" }, "r5"), "note directory does not exist")
  assert.equal(await refused({ ...tractionPayload, note: "Traction.txt" }, "r6"), "note must be a relative .md path")
  for (
    const [field, value] of [["npmPackage", "../../x"], ["npmPackage", "a?b"], ["repository", "o/r/../../x"], [
      "repository",
      "o/.."
    ]]
  ) {
    const exit = await runtime.runPromiseExit(
      TractionFlow.execute({ ...tractionPayload, [field!]: value }, { executionId: `bad-${field}-${value}` })
    )
    assert.equal(Exit.isFailure(exit), true, `${field}=${value} is refused`)
  }
  assert.deepEqual(api.requests, [])
  await assert.rejects(readFile(join(outside, "x.md")), { code: "ENOENT" })
})

// ---------------------------------------------------------- calendar events

const now = new Date("2026-09-30T16:00:00Z")

test("parse unfolds lines, dates UTC instants in the listing zone, and makes hostile text inert", async () => {
  const events = parse(await fixture("notes-calendar.ics"), "America/Los_Angeles")
  assert.deepEqual(events.map((event) => [event.date, event.title]), [
    ["2026-09-30", "GenAI SF Meetup"],
    ["2026-10-05", "Agents Night: evals and durable runs"],
    ["2026-10-03", "Hack Day; SF"],
    ["2026-10-20", "Far Future Summit"],
    ["2026-09-01", "Last Month Mixer"],
    ["2026-10-02", "\\[click\\](https://evil.example) \\<!-- /calendar-events --\\>"],
    ["2026-10-04", "Stablecoin Sessions"]
  ])
  assert.equal(events[0]!.location, "Frontier Tower")
  assert.equal(events[0]!.url, "https://luma.com/genai-sf-oct")
  assert.equal(events[5]!.url, "")
  // The same instant in UTC is the next day.
  assert.equal(parse(await fixture("notes-calendar.ics"), "UTC")[0]!.date, "2026-10-01")
})

const event = (date: string, title: string): Event => ({ date, title, location: "", url: "" })

test("calendar merge owns one block: adds, keeps checked items, dedupes, and replaces failure lines", () => {
  const empty = mergeEvents("", [event("2026-10-02", "B"), event("2026-10-01", "A")], [], "2026-09-30")
  assert.equal(empty.text, `## Upcoming events\n\n${start}\n- [ ] 2026-10-01 — A\n- [ ] 2026-10-02 — B\n${end}\n`)

  // The flow's lines go directly under an existing heading; the rest of the note is untouched.
  const note = "# M\n\n## Upcoming events\n- Will's own pick: Dinner\n\n## Log\n"
  const first = mergeEvents(note, [event("2026-10-02", "Dinner"), event("2026-10-03", "Talk")], [
    { feed: "https://a.example/cal.ics", reason: "HTTP 503" }
  ], "2026-09-30")
  assert.equal(first.added, 1)
  assert.equal(
    first.text,
    `# M\n\n## Upcoming events\n${start}\n- [ ] 2026-10-03 — Talk\n- failed 2026-09-30: https://a.example/cal.ics (HTTP 503)\n${end}\n- Will's own pick: Dinner\n\n## Log\n`
  )

  // Checking an item off survives the next run, which also clears the recovered failure.
  const checked = first.text.replace("- [ ] 2026-10-03 — Talk", "- [x] 2026-10-03 — Talk")
  const second = mergeEvents(checked, [event("2026-10-03", "Talk"), event("2026-10-01", "Early")], [], "2026-10-01")
  assert.equal(second.added, 1)
  assert.match(second.text, new RegExp(`${start}\n- \\[ \\] 2026-10-01 — Early\n- \\[x\\] 2026-10-03 — Talk\n${end}`))
  assert.doesNotMatch(second.text, /failed/)
  assert.equal(
    mergeEvents(second.text, [event("2026-10-03", "Talk"), event("2026-10-01", "Early")], [], "2026-10-01").text,
    second.text
  )

  // A recurring title on a new date is a new event; the same one on the same date is not.
  const recurring = mergeEvents(
    second.text,
    [event("2026-10-10", "Talk"), event("2026-10-10", "Talk")],
    [],
    "2026-10-01"
  )
  assert.equal(recurring.added, 1)
})

test("the calendar flow merges a feed once, records a failed feed in the note, and clears it on recovery", {
  timeout: 60_000
}, async (t) => {
  const root = await workspace(t)
  const api = await serve(t)
  api.routes.set("/cal.ics", { status: 200, body: await fixture("notes-calendar.ics") })
  api.routes.set("/html", { status: 200, body: "<html>not a calendar</html>" })
  await mkdir(join(root, "Areas"))
  const original = await fixture("notes-marketing.md")
  await writeFile(join(root, "Areas", "Marketing.md"), original)
  const runtime = engine(t, EventsFlow, EventsFlowFile.make({ root, fetch: globalThis.fetch, now: () => now }))
  const payload = { note: "Areas/Marketing.md", feeds: [`${api.base}/cal.ics`], timeZone: "America/Los_Angeles" }

  const first = await runtime.runPromise(EventsFlow.execute(payload, { executionId: "events-1" }))
  assert.deepEqual(first, { note: "Areas/Marketing.md", added: 4, changed: true, failures: [] })
  const written = await readFile(join(root, "Areas", "Marketing.md"), "utf8")
  assert.equal(
    written,
    original.replace(
      "## Upcoming events\n",
      `## Upcoming events\n${start}\n${
        [
          item({
            date: "2026-09-30",
            title: "GenAI SF Meetup",
            location: "Frontier Tower",
            url: "https://luma.com/genai-sf-oct"
          }),
          "- [ ] 2026-10-02 — \\[click\\](https://evil.example) \\<!-- /calendar-events --\\>",
          "- [ ] 2026-10-03 — Hack Day; SF",
          "- [ ] 2026-10-05 — Agents Night: evals and durable runs — [link](https://luma.com/agents-night)"
        ].join("\n")
      }\n${end}\n`
    )
  )
  assert.equal(written.split(end).length, 2)

  const repeat = await runtime.runPromise(EventsFlow.execute(payload, { executionId: "events-2" }))
  assert.deepEqual(repeat, { note: "Areas/Marketing.md", added: 0, changed: false, failures: [] })
  assert.equal(await readFile(join(root, "Areas", "Marketing.md"), "utf8"), written)

  const broken = { ...payload, feeds: [`${api.base}/cal.ics`, `${api.base}/gone.ics`, `${api.base}/html`] }
  const failed = await runtime.runPromiseExit(EventsFlow.execute(broken, { executionId: "events-3" }))
  assert.deepEqual(errorOf(failed), {
    note: "Areas/Marketing.md",
    added: 0,
    changed: true,
    failures: [`${api.base}/gone.ics (HTTP 404)`, `${api.base}/html (not an iCalendar feed)`]
  })
  const noted = await readFile(join(root, "Areas", "Marketing.md"), "utf8")
  assert.match(
    noted,
    new RegExp(
      `- failed 2026-09-30: ${api.base}/gone.ics \\(HTTP 404\\)\n- failed 2026-09-30: ${api.base}/html \\(not an iCalendar feed\\)\n${end}`
    )
  )

  const recovered = await runtime.runPromise(EventsFlow.execute(payload, { executionId: "events-4" }))
  assert.equal(recovered.changed, true)
  assert.equal(await readFile(join(root, "Areas", "Marketing.md"), "utf8"), written)
  assert.equal(api.requests.every((request) => request.startsWith("GET ")), true)
})

test("the calendar flow refuses empty or non-web feeds, bad windows and unknown zones before any request", {
  timeout: 60_000
}, async (t) => {
  const root = await workspace(t)
  const api = await serve(t)
  const runtime = engine(t, EventsFlow, EventsFlowFile.make({ root, fetch: globalThis.fetch, now: () => now }))
  const base = { note: "E.md", feeds: [`${api.base}/cal.ics`] }
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ feeds: [] }, "feeds must name at least one feed"],
    [{ feeds: ["file:///etc/passwd"] }, "feeds must be http or https URLs"],
    [{ days: 400 }, "days must be an integer from 0 to 366"],
    [{ days: -1 }, "days must be an integer from 0 to 366"],
    [{ timeZone: "Mars/Olympus" }, "timeZone must be an IANA time zone"],
    [{ note: "../E.md" }, "note must stay inside the workspace"]
  ]
  for (const [change, reason] of cases) {
    const exit = await runtime.runPromiseExit(
      EventsFlow.execute({ ...base, ...change } as typeof base, {
        executionId: `bad-${reason}-${JSON.stringify(change)}`
      })
    )
    assert.equal(errorOf(exit), reason)
  }
  assert.deepEqual(api.requests, [])
  // Zero days is today only.
  api.routes.set("/cal.ics", { status: 200, body: await fixture("notes-calendar.ics") })
  const today = await runtime.runPromise(
    EventsFlow.execute({ ...base, days: 0, timeZone: "America/Los_Angeles" }, { executionId: "today" })
  )
  assert.equal(today.added, 1)
  assert.equal(day(now, "America/Los_Angeles"), "2026-09-30")
})
