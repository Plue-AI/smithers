import * as CloudSession from "@smthrs/cli/CloudSession"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as IssueViews from "../src/issue-views.ts"
import * as Panels from "../src/panels.ts"

const views = [
  { id: "bugs", title: "Open bugs", state: "open", labels: ["bug", "p1"] },
  { id: "everything", title: "Everything", state: "all" }
]
const issue = (number: number, state = "open") => ({ number, title: `Issue ${number}`, state, labels: [] })

/** A deferred answer the test settles by hand. */
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** A session whose GETs answer from `answer` and are recorded. */
const session = (answer: (path: string) => Promise<unknown> | unknown) => {
  const paths: Array<string> = []
  const cloud: IssueViews.Cloud = { get: async (path) => (paths.push(path), await answer(path)) }
  return { cloud, paths }
}

const valid = (panel: Panels.Panel) => expect(Panels.decode(panel)).toEqual(panel)

describe("issue views data source", () => {
  it("reads the declared views, dropping malformed entries, and lists one view's first page", async () => {
    const { cloud, paths } = session((path) =>
      path.endsWith("/issue-views")
        ? [...views, { id: "Bad", title: "x" }, { id: "ok", title: " " }, "junk"]
        : [issue(9), { title: "no number" }, issue(7, "fixed")]
    )
    expect(await IssueViews.loadViews(cloud.get, "o/r")).toEqual(views)
    expect(await IssueViews.loadIssues(cloud.get, "o/r", "bugs")).toEqual({
      issues: [{ number: 9, title: "Issue 9", state: "open" }, { number: 7, title: "Issue 7", state: "fixed" }],
      more: false
    })
    expect(paths).toEqual(["/api/repos/o/r/issue-views", "/api/repos/o/r/issues?view=bugs&limit=100"])
    const full = session(() => Array.from({ length: IssueViews.pageSize }, (_, i) => issue(i + 1)))
    expect((await IssueViews.loadIssues(full.cloud.get, "o/r", "bugs")).more).toBe(true)
    await expect(IssueViews.loadViews(session(() => ({})).cloud.get, "o/r")).rejects.toThrow("unreadable")
    await expect(IssueViews.loadIssues(session(() => null).cloud.get, "o/r", "bugs")).rejects.toThrow("unreadable")
  })

  it("names view rows so the host can route Enter to select", () => {
    expect(IssueViews.rowId("bugs")).toBe("issue-view:bugs")
    expect(IssueViews.viewOf("issue-view:bugs")).toBe("bugs")
    expect(IssueViews.viewOf("issue-view:Bugs")).toBeUndefined()
    expect(IssueViews.viewOf("issue-view-issue:bugs:9")).toBeUndefined()
    expect(IssueViews.viewOf("factory:todo")).toBeUndefined()
  })
})

describe("issue views controller", () => {
  it("selects a view, lists its issues, and renders both as a valid panel", async () => {
    const states: Array<IssueViews.State["phase"]> = []
    const { cloud, paths } = session((path) => path.endsWith("/issue-views") ? views : [issue(9), issue(8)])
    const control = IssueViews.controller(async () => cloud, "o/r", (state) => states.push(state.phase))
    expect(IssueViews.panel(control.state()).summary).toBe("Reading views")
    await control.refresh()
    valid(IssueViews.panel(control.state()))
    expect(IssueViews.panel(control.state()).summary).toBe("2 views")
    const loading = control.select("bugs")
    const pending = IssueViews.panel(control.state())
    expect(pending.rows[0]).toMatchObject({
      id: "issue-view:bugs",
      status: "requested",
      details: [{ text: "open · bug · p1" }]
    })
    await loading
    const shown = IssueViews.panel(control.state())
    valid(shown)
    expect(shown.summary).toBe("Open bugs · 2")
    expect(shown.rows.map((row) => row.label)).toEqual(["Open bugs", "Everything", "#9 Issue 9", "#8 Issue 8"])
    expect(shown.rows[0]!.status).toBe("done")
    expect(shown.rows[1]).toEqual({ id: "issue-view:everything", label: "Everything", details: [] })
    expect(paths).toEqual(["/api/repos/o/r/issue-views", "/api/repos/o/r/issues?view=bugs&limit=100"])
    expect(states).toEqual(["ready", "ready", "ready"])
  })

  it("joins a repeated selection and never lets an older answer replace a newer one", async () => {
    const bugs = deferred<unknown>()
    const everything = deferred<unknown>()
    const { cloud, paths } = session((path) =>
      path.endsWith("/issue-views") ? views : path.includes("view=bugs") ? bugs.promise : everything.promise
    )
    const control = IssueViews.controller(async () => cloud, "o/r")
    await control.refresh()
    const first = control.select("bugs")
    const again = control.select("bugs")
    expect(again).toBe(first)
    const second = control.select("everything")
    everything.resolve([issue(3, "closed")])
    await second
    bugs.resolve([issue(9)])
    await first
    const state = control.state()
    expect(state.phase === "ready" && state.selected).toMatchObject({
      id: "everything",
      phase: "loaded",
      issues: [{ number: 3 }]
    })
    expect(paths.filter((path) => path.includes("view=bugs"))).toHaveLength(1)
  })

  it("keeps a failed read visible and retries it on the next selection", async () => {
    let fail = true
    const { cloud } = session((path) => {
      if (path.endsWith("/issue-views")) return views
      if (fail) throw new Error("HTTP 404: issue view \"bugs\" not found")
      return [issue(9)]
    })
    const control = IssueViews.controller(async () => cloud, "o/r")
    await control.refresh()
    await control.select("bugs")
    const failed = IssueViews.panel(control.state())
    valid(failed)
    expect(failed.rows[0]!.status).toBe("failed")
    expect(failed.rows.at(-1)).toMatchObject({ status: "failed", label: "HTTP 404: issue view \"bugs\" not found" })
    fail = false
    await control.select("bugs")
    expect(IssueViews.panel(control.state()).summary).toBe("Open bugs · 1")
  })

  it("ignores undeclared views and keeps a selection only while it is still declared", async () => {
    let declared: ReadonlyArray<unknown> = views
    const { cloud, paths } = session((path) => path.endsWith("/issue-views") ? declared : [issue(1)])
    const control = IssueViews.controller(async () => cloud, "o/r")
    await control.select("bugs")
    expect(control.state().phase).toBe("idle")
    await control.refresh()
    await control.select("missing")
    expect(paths).toEqual(["/api/repos/o/r/issue-views"])
    await control.select("bugs")
    await control.refresh()
    expect(control.state()).toMatchObject({ phase: "ready", selected: { id: "bugs", phase: "loaded" } })
    declared = [views[1]]
    await control.refresh()
    expect(control.state()).toEqual({
      phase: "ready",
      views: [{ id: "everything", title: "Everything", state: "all" }]
    })
  })

  it("says signed out without a session or when Cloud refuses it, and reports other failures", async () => {
    const out = IssueViews.controller(async () => undefined, "o/r")
    await out.refresh()
    expect(IssueViews.panel(out.state())).toEqual({
      id: "issue-views",
      title: "Issue views",
      summary: "Sign in: smthrs auth login",
      rows: []
    })
    let signIns = 0
    const refusing = IssueViews.controller(async () => (signIns++, {
      get: async () => {
        throw new Error("HTTP 401: sign in")
      }
    }), "o/r")
    await refusing.refresh()
    expect(refusing.state().phase).toBe("signed-out")
    await refusing.refresh()
    expect(signIns).toBe(2)
    const broken = IssueViews.controller(async () => ({
      get: async () => {
        throw new Error("")
      }
    }), "o/r")
    await broken.refresh()
    const panel = IssueViews.panel(broken.state())
    valid(panel)
    expect(panel.rows).toEqual([{ id: "issue-views:failed", label: "Read failed", status: "failed", details: [] }])
    const none = IssueViews.controller(async () => {
      throw new Error("unused")
    }, undefined)
    expect((await none.refresh()).phase).toBe("idle")
  })

  it("drops answers after the caller aborts", async () => {
    const answer = deferred<unknown>()
    const { cloud } = session((path) => path.endsWith("/issue-views") ? views : answer.promise)
    const control = IssueViews.controller(async () => cloud, "o/r")
    await control.refresh()
    const abort = new AbortController()
    const run = control.select("bugs", abort.signal)
    abort.abort()
    answer.resolve([issue(1)])
    await run
    expect(control.state()).toMatchObject({ phase: "ready", selected: { id: "bugs", phase: "loading" } })
    const stale = deferred<unknown>()
    const late = IssueViews.controller(async () => ({ get: () => stale.promise }), "o/r")
    const aborted = new AbortController()
    const refreshing = late.refresh(aborted.signal)
    aborted.abort()
    stale.resolve(views)
    expect((await refreshing).phase).toBe("idle")
  })
})

const servers: Array<() => void> = []
afterEach(() => {
  for (const close of servers.splice(0)) close()
})

it("reads views and a view's issues from Cloud as the signed-in person", async () => {
  const received: Array<{ path: string; auth: string | undefined }> = []
  const server = createServer((request, response) => {
    received.push({ path: request.url ?? "", auth: request.headers.authorization })
    const body = request.url === "/api/repos/o/r/issue-views" ? views : [issue(5)]
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(() => server.close())
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const control = IssueViews.controller(
    () =>
      CloudSession.signedIn({
        HOME: mkdtempSync(join(tmpdir(), "tui-views-")),
        XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "tui-views-")),
        SMITHERS_API_ORIGIN: origin,
        SMITHERS_TOKEN: "tok_views"
      }),
    "o/r"
  )
  await control.refresh()
  await control.select("everything")
  expect(IssueViews.panel(control.state()).summary).toBe("Everything · 1")
  expect(received.map((each) => each.path)).toEqual([
    "/api/repos/o/r/issue-views",
    "/api/repos/o/r/issues?view=everything&limit=100"
  ])
  expect(received.every((each) => each.auth === "token tok_views")).toBe(true)
})
