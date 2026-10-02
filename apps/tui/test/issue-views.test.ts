import { Refused } from "@smthrs/cli/CliError"
import * as CloudSession from "@smthrs/cli/CloudSession"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as IssueViews from "../src/issue-views.ts"
import * as Log from "../src/log.ts"
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
    // The superseded selection read at most once and never showed.
    expect(paths.filter((path) => path.includes("view=bugs")).length).toBeLessThanOrEqual(1)
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
    expect(failed.rows.at(-1)).toMatchObject({
      status: "failed",
      label: "That command could not run. Details: /conversation"
    })
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
        throw new Refused({ code: "cloud_request_failed", fault: "user", message: "HTTP 401: sign in" })
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
    expect(panel.rows).toEqual([{
      id: "issue-views:failed",
      label: "That command could not run. Details: /conversation",
      status: "failed",
      details: []
    }])
    const none = IssueViews.controller(async () => {
      throw new Error("unused")
    }, undefined)
    expect((await none.refresh()).phase).toBe("idle")
  })

  it("drops a kept selection whose view's filters changed, and orders refreshes", async () => {
    let declared: ReadonlyArray<IssueViews.View> = views
    const { cloud } = session((path) => path.endsWith("/issue-views") ? declared : [issue(1)])
    const control = IssueViews.controller(async () => cloud, "o/r")
    await control.refresh()
    await control.select("bugs")
    declared = [{ ...views[0]!, state: "closed" }, views[1]!]
    await control.refresh()
    expect(control.state()).toEqual({ phase: "ready", views: declared })

    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const queue = [first, second]
    let gets = 0
    const ordered = IssueViews.controller(async () => ({ get: () => (gets++, queue.shift()!.promise) }), "o/r")
    const older = ordered.refresh()
    while (gets === 0) await Promise.resolve()
    const newer = ordered.refresh()
    while (gets === 1) await Promise.resolve()
    second.resolve([views[1]!])
    await newer
    first.resolve(views)
    await older
    expect(ordered.state()).toEqual({ phase: "ready", views: [views[1]!] })
  })

  it("never shows an answer read as a session Cloud has since refused", async () => {
    const bugs = deferred<unknown>()
    let refuse = false
    const cloud: IssueViews.Cloud = {
      get: async (path) => {
        if (path.endsWith("/issue-views")) {
          if (refuse) throw new Refused({ code: "cloud_request_failed", fault: "user", message: "HTTP 401: sign in" })
          return views
        }
        return path.includes("view=bugs") ? bugs.promise : Promise.reject(
          new Refused({ code: "cloud_request_failed", fault: "user", message: "HTTP 403: forbidden" })
        )
      }
    }
    const control = IssueViews.controller(async () => cloud, "o/r")
    await control.refresh()
    const pending = control.select("bugs")
    refuse = true
    await control.refresh()
    expect(control.state().phase).toBe("signed-out")
    bugs.resolve([issue(9)])
    await pending
    expect(control.state().phase).toBe("signed-out")
    refuse = false
    await control.refresh()
    await control.select("everything")
    expect(control.state().phase).toBe("signed-out")
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
    // A cancelled read leaves what was shown before it: here, no selection.
    expect(control.state()).toEqual({ phase: "ready", views })
    const stale = deferred<unknown>()
    const late = IssueViews.controller(async () => ({ get: () => stale.promise }), "o/r")
    const aborted = new AbortController()
    const refreshing = late.refresh(aborted.signal)
    aborted.abort()
    stale.resolve(views)
    expect((await refreshing).phase).toBe("idle")
  })

  it("classifies typed Cloud refusals by their code and fault, not diagnostic text", async () => {
    for (const selection of [false, true]) {
      for (
        const [code, fault, signedOut] of [
          ["cloud_request_failed", "user", true],
          ["cloud_request_failed", "infra", false],
          ["cloud_response_invalid", "infra", false],
          ["cloud_path_refused", "bug", false],
          ["other_refusal", "user", false]
        ] as const
      ) {
        let fail = true
        let signIns = 0
        const failure = new Refused({
          code,
          fault,
          message: signedOut ? "The session expired" : "HTTP 401: private diagnostic"
        })
        const { cloud } = session((path) => {
          if (fail && (!selection || !path.endsWith("/issue-views"))) throw failure
          return path.endsWith("/issue-views") ? views : [issue(1)]
        })
        const control = IssueViews.controller(async () => (signIns++, cloud), "o/r")
        await control.refresh()
        if (selection) await control.select("bugs")
        expect(control.state().phase).toBe(signedOut ? "signed-out" : selection ? "ready" : "failed")
        if (!signedOut) {
          const shown = IssueViews.panel(control.state())
          valid(shown)
          expect(shown.rows.at(-1)?.status).toBe("failed")
          expect(JSON.stringify(shown)).not.toContain("private diagnostic")
        }
        fail = false
        await control.refresh()
        await control.select("bugs")
        expect(IssueViews.panel(control.state()).summary).toBe("Open bugs · 1")
        expect(signIns).toBe(signedOut ? 2 : 1)
      }
    }
  })

  it("keeps the session after uncertain HTTP metadata or old authentication-looking text", async () => {
    const old = { _tag: "/cli/Refused", code: "cloud_request_failed", fault: "user", message: "HTTP 401" }
    for (const selection of [false, true]) {
      for (
        const failure of [
          ...[408, 409, 429, 503, undefined, "401", 401.5].map((httpStatus) => ({ ...old, httpStatus })),
          new Error("HTTP 401", { cause: { ...old, httpStatus: 401 } })
        ]
      ) {
        let fail = true
        let signIns = 0
        const { cloud } = session((path) => {
          if (fail && (!selection || !path.endsWith("/issue-views"))) throw failure
          return path.endsWith("/issue-views") ? views : [issue(1)]
        })
        const control = IssueViews.controller(async () => (signIns++, cloud), "o/r")
        await control.refresh()
        if (selection) await control.select("bugs")
        expect(control.state().phase).toBe(selection ? "ready" : "failed")
        fail = false
        await control.refresh()
        await control.select("bugs")
        expect(IssueViews.panel(control.state()).summary).toBe("Open bugs · 1")
        expect(signIns).toBe(1)
      }
    }
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

it("keeps raw Cloud failures out of the issue views panel", async () => {
  const raw = "HTTP 503: private backend stack trace"
  const control = IssueViews.controller(async () => ({
    get: async () => {
      throw new Error(raw)
    }
  }), "o/r")
  await control.refresh()
  expect(control.state().phase).toBe("failed")
  expect(JSON.stringify(IssueViews.panel(control.state()))).not.toContain(raw)
})

for (const selection of [false, true]) {
  for (
    const [name, status, body, diagnostic] of [
      ["transport", 503, "private backend stack", "HTTP 503"],
      ["JSON validation", 200, "not JSON", "response is not JSON"],
      ["payload validation", 200, "{}", "unreadable payload"]
    ] as const
  ) {
    it(`keeps ${selection ? "selection" : "list"} ${name} failures safe, logged and recoverable over HTTP`, async () => {
      const previous = process.env.SMITHERS_TUI_SESSION_DIR
      const root = mkdtempSync(join(tmpdir(), "tui-views-failure-"))
      process.env.SMITHERS_TUI_SESSION_DIR = root
      let fail = true
      let signIns = 0
      const received: string[] = []
      const server = createServer((request, response) => {
        const path = request.url ?? ""
        received.push(path)
        const list = path.endsWith("/issue-views")
        const fails = fail && (selection ? !list : list)
        response.writeHead(fails ? status : 200, { "content-type": "application/json" })
        response.end(fails ? body : JSON.stringify(list ? views : [issue(5)]))
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      servers.push(() => server.close())
      try {
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        const control = IssueViews.controller(() => {
          signIns++
          return CloudSession.signedIn({
            HOME: root,
            XDG_CONFIG_HOME: root,
            SMITHERS_API_ORIGIN: origin,
            SMITHERS_TOKEN: "tok_views"
          })
        }, "o/r")
        await control.refresh()
        if (selection) await control.select("bugs")
        const failed = control.state()
        expect(failed.phase).toBe(selection ? "ready" : "failed")
        const shown = IssueViews.panel(failed)
        valid(shown)
        expect(shown.rows.at(-1)).toMatchObject({
          label: "That command could not run. Details: /conversation",
          status: "failed",
          details: []
        })
        expect(JSON.stringify(failed)).not.toContain(diagnostic)
        expect(JSON.stringify(shown)).not.toContain(body)
        const records = readFileSync(Log.path(), "utf8").trim().split("\n").map((line) => JSON.parse(line))
        expect(records).toHaveLength(1)
        expect(records[0].tag).toBe("failure.command")
        expect(records[0].detail).toContain(diagnostic)
        expect(statSync(Log.path()).mode & 0o777).toBe(0o600)
        expect(received).toHaveLength(selection ? 2 : 1)
        expect(control.state()).toEqual(failed)
        fail = false
        if (!selection) await control.refresh()
        await control.select("bugs")
        expect(IssueViews.panel(control.state()).summary).toBe("Open bugs · 1")
        expect(signIns).toBe(1)
        expect(received).toHaveLength(3)
        expect(readFileSync(Log.path(), "utf8").trim().split("\n")).toHaveLength(1)
      } finally {
        if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
        else process.env.SMITHERS_TUI_SESSION_DIR = previous
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
}

it("retains nested failure diagnostics only in the private redacted log", async () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-views-diagnostic-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    const token = `ghp_${"x".repeat(36)}`
    const raw = new Error("private transport trace", { cause: new Error(`Authorization: Token ${token}`) })
    for (const selection of [false, true]) {
      const { cloud } = session((path) => {
        if (selection && path.endsWith("/issue-views")) return views
        throw raw
      })
      const control = IssueViews.controller(async () => cloud, "o/r")
      await control.refresh()
      if (selection) await control.select("bugs")
      expect(JSON.stringify(control.state())).not.toContain("private transport trace")
      expect(JSON.stringify(IssueViews.panel(control.state()))).not.toContain(token)
    }
    const saved = readFileSync(Log.path(), "utf8")
    const records = saved.trim().split("\n").map((line) => JSON.parse(line))
    expect(records).toHaveLength(2)
    for (const record of records) {
      expect(record.tag).toBe("failure.command")
      expect(record.detail).toContain("Error: private transport trace")
      expect(record.detail).toContain("Caused by: Error: Authorization: [REDACTED")
    }
    expect(saved).not.toContain(token)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it("drops and reopens the real Cloud session after list and selection authentication refusals", async () => {
  for (const selection of [false, true]) {
    for (const status of [401, 403]) {
      let fail = true
      let signIns = 0
      const root = mkdtempSync(join(tmpdir(), "tui-views-auth-"))
      const server = createServer((request, response) => {
        const list = request.url?.endsWith("/issue-views") === true
        const refuses = fail && (selection ? !list : list)
        response.writeHead(refuses ? status : 200, { "content-type": "application/json" })
        response.end(JSON.stringify(refuses ? { message: "private auth diagnostic" } : list ? views : [issue(5)]))
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      servers.push(() => server.close())
      try {
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        const control = IssueViews.controller(() => {
          signIns++
          return CloudSession.signedIn({
            HOME: root,
            XDG_CONFIG_HOME: root,
            SMITHERS_API_ORIGIN: origin,
            SMITHERS_TOKEN: "tok_views"
          })
        }, "o/r")
        await control.refresh()
        if (selection) await control.select("bugs")
        expect(control.state()).toEqual({ phase: "signed-out" })
        expect(IssueViews.panel(control.state()).rows).toEqual([])
        fail = false
        await control.refresh()
        await control.select("bugs")
        expect(IssueViews.panel(control.state()).summary).toBe("Open bugs · 1")
        expect(signIns).toBe(2)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
})
