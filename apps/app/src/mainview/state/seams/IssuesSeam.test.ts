import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { processRepositoryEvents } from "../RepositoryNotifications"
import { initialSetup } from "@smthrs/rpc/RepositorySetup"

/*
 * The issues seam, driven through the one command run path: issues.list /
 * issues.view / issues.close / issues.comment against stubbed platform routes.
 * Substance lands as cards ("issue-list", "issue") in store.collections.cards;
 * failures come back as honest error strings (CommandOutcome "failed"), never
 * throws. One loaded repository ("will/flows") stands in for the repo
 * resolution, matching the RepoContext single-repository rule.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type RouteAnswer = Response | ((request: Request) => Response | Promise<Response>)

/**
 * Route stub keyed "METHOD /path" (pathname only — the query is recorded in
 * `calls` so tests can assert it). Unstubbed routes answer 404 honestly.
 */
const backend = (routes: Record<string, RouteAnswer>, calls: string[] = []): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push(`${method} ${absolute.pathname}${absolute.search}`)
    for (const [route, answer] of Object.entries(routes)) {
      const spaceIndex = route.indexOf(" ")
      const routeMethod = route.slice(0, spaceIndex)
      const routePath = route.slice(spaceIndex + 1)
      if (routeMethod !== method || absolute.pathname !== routePath) continue
      return typeof answer === "function"
        ? answer(new Request(absolute.toString(), init))
        : answer.clone()
    }
    return json(404, { status: "error", message: `no stub for ${method} ${absolute.pathname}` })
  }
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const signedIn = async (store: AppStore, login = "will"): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login,
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

/** ONE loaded repo, so repo resolution answers "will/flows" without an argument. */
const reposChosen = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
  })
  await settled()
}

/** Opening a checkout pins it (AppProjection "opening pins"), so a pin alone never means "not imported". */
const openCheckout = (store: AppStore): Promise<unknown> =>
  store.dispatch({
    type: "repos.loaded",
    actor: "system",
    repos: [{
      id: "repo-flows",
      name: "will/flows",
      path: "/Users/will/flows",
      warnings: [],
      git: { branch: "main", remote: "git@github.com:will/flows.git" },
      smithers: { detected: false, workspaceFile: null, declarationFiles: [], workspaces: [], reason: "none" }
    }]
  }).isPersisted.promise

const issuesController = async (services: AppServices) => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const controller = createAppController(store, unavailableAgent, services)
  await signedIn(store)
  await reposChosen(store)
  return { store, controller, storage }
}

/* Plue's issue wire shape (multi src/smithersCloud/issues.ts). */
const wireIssue = (number: number, overrides: Record<string, unknown> = {}) => ({
  id: number * 100,
  number,
  title: `Fix the flake ${number}`,
  body: "It **flakes** on CI.",
  state: "open",
  labels: [{ id: 1, name: "bug", color: "d73a4a", description: "" }],
  assignees: [],
  author: { id: 3, login: "ana" },
  milestone_id: null,
  comment_count: 2,
  created_at: "2026-08-10T09:00:00Z",
  updated_at: "2026-08-11T09:00:00Z",
  closed_at: null,
  ...overrides
})

test.each([
  { name: "unconfigured", enabled: false, owner: "will", tips: 1 },
  { name: "enabled CI", enabled: true, owner: "will", tips: 0 },
  { name: "another account's CI", enabled: true, owner: "someone-else", tips: 1 }
])("issue creation suggests optional CI once for $name", async scenario => {
  const { store, controller } = await issuesController(backend({
    "POST /api/repos/will/flows/issues": json(201, wireIssue(8)),
    "GET /api/repos/will/flows/issues/8": json(200, wireIssue(8)),
    "GET /api/repos/will/flows/issues/8/comments": json(200, [])
  }))
  try {
    const setup = initialSetup("will/flows", "ci", scenario.owner)
    if (scenario.enabled) setup.active = { revision: 1, digest: "test", registrationId: "test", sourceRevision: "test", enabled: true }
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "ci-settings", kind: "repository-setup", title: "CI", createdAt: 1, ordinal: 1, status: "active", payload: setup
    } }).isPersisted.promise
    await controller.commands.run("issues.create", "Improve logging")
    await controller.commands.run("issues.create", "Improve tests")
    await store.settled?.()
    const tips = [...store.collections.toasts.values()].filter(toast => toast.action?.flow === "ci.setup")
    expect(tips).toHaveLength(scenario.tips)
    if (scenario.tips) expect(tips[0]).toMatchObject({ status: "ok", action: { label: "Set up CI", args: "will/flows" } })
  } finally { await controller.dispose(); await store.dispose?.() }
})

/* GitHub's issue wire shape off the source read (multi src/smithersCloud/githubIssues.ts). */
const wireGithubIssue = (number: number, overrides: Record<string, unknown> = {}) => ({
  id: number * 1000,
  number,
  title: `Upstream bug ${number}`,
  body: "Seen on main.",
  state: "open",
  user: { login: "octo", avatar_url: "https://avatars.test/octo" },
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: [],
  comments: 4,
  html_url: `https://github.com/will/flows/issues/${number}`,
  created_at: "2026-08-09T09:00:00Z",
  updated_at: "2026-08-10T09:00:00Z",
  ...overrides
})

/* Plue's IssueCommentResponse wire shape (multi src/smithersCloud/issueComments.ts). */
const wireComment = (id: number, body: string) => ({
  id,
  issue_id: 7,
  user_id: 4,
  commenter: "bob",
  body,
  type: "comment",
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T10:00:00Z"
})

/*
 * The platform's own 404 bodies on the issues routes (plue pkg/errors
 * NotFound → `{code, fault, message}`, restated by the Worker): issue.go
 * answers "issue not found" for a number it does not have and "repository not
 * found" for a namespace it does not have. ONE code for both causes, so no 404
 * here can prove the repository was never imported.
 */
const ISSUE_NOT_FOUND = { status: "error", code: "not_found", message: "issue not found" }
const REPOSITORY_NOT_FOUND = { status: "error", code: "not_found", message: "repository not found" }

const cardOfKind = <K extends Card["kind"]>(
  store: AppStore,
  id: string,
  kind: K
): Extract<Card, { kind: K }> => {
  const card: Card | undefined = store.collections.cards.get(id)
  if (card === undefined || card.kind !== kind) {
    throw new Error(`Expected card ${id} of kind ${kind}, got ${card?.kind ?? "nothing"}`)
  }
  return card as Extract<Card, { kind: K }>
}

describe("issues seam — the list", () => {
  test("rejects malformed top-level lists instead of reporting an empty success", async () => {
    for (const body of [{}, "not a list", null]) {
      const { store, controller } = await issuesController(
        backend({ "GET /api/repos/will/flows/issues": json(200, body) })
      )
      const outcome = await controller.commands.run("issues.list")
      expect(outcome.status).toBe("failed")
      expect(store.collections.cards.get("issues-will/flows")).toMatchObject({ status: "error", loading: false })
    }
  })
  /*
   * Canary D-5: one refusal reached the person as two sentences. The
   * transcript said the true one ("Sign in with GitHub to read issues on …",
   * with the button) while the card beside it wore a FAILED headline and
   * "This view couldn't be loaded. Try opening it again." — opening it again
   * will never work, and the louder of the two was the false one. The
   * sign-in prompt is the whole answer.
   */
  test("a signed-out read answers with the sign-in prompt alone, not a failed view card", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableAgent,
      backend({ "GET /api/repos/smithersai/smithers/issues": json(401, { status: "error", message: "sign in first" }) }))
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null })
    store.dispatch({ type: "repositories.loaded", actor: "system",
      repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: null, catalog: true }] })
    await settled()
    await controller.commands.run("issues.list", "open smithersai/smithers")
    await settled()
    const prompts = [...store.collections.messages.values()].filter((message) => message.action?.flow === "auth.sign-in")
    expect(prompts.map((message) => message.text)).toEqual(["Sign in with GitHub to read issues on smithersai/smithers."])
    for (const card of store.collections.cards.values()) {
      expect(card.status).not.toBe("error")
      expect(card.body ?? "").not.toContain("This view couldn't be loaded")
    }
  })

  test("issues.list upserts the issue-list card with defensively parsed rows and asks state=open", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend(
        {
          "GET /api/repos/will/flows/issues": json(200, [
            wireIssue(7),
            "junk",
            { title: "no number at all" },
            wireIssue(9, { state: "closed", author: null, comment_count: "not-a-number", updated_at: null })
          ])
        },
        calls
      )
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.title).toBe("Issues · will/flows")
    expect(card.status).toBe("active")
    expect(card.payload.repo).toBe("will/flows")
    expect(card.payload.filter).toBe("open")
    // The two real rows survive; garbage entries drop; missing fields go null/zero.
    expect(card.payload.issues).toMatchObject([
      {
        number: 7,
        title: "Fix the flake 7",
        state: "open",
        author: "ana",
        comments: 2,
        updatedAt: "2026-08-11T09:00:00Z",
        source: "smithers-cloud"
      },
      {
        number: 9,
        title: "Fix the flake 9",
        state: "closed",
        author: null,
        comments: 0,
        updatedAt: null,
        source: "smithers-cloud"
      }
    ])
    expect(calls).toContain("GET /api/repos/will/flows/issues?state=open")
    // GitHub's issues are read beside Smithers Cloud's own; an unstubbed (404) GitHub route is a stated refusal, never a silent absence.
    expect(calls).toContain("GET /api/user/github-repos/will/flows/issues?state=open")
    expect(card.payload.github?.refusal).toBeTruthy()
  })

  test("issues.list all omits the state param — Plue rejects state=all", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend({ "GET /api/repos/will/flows/issues": json(200, []) }, calls)
    )
    const outcome = await controller.commands.run("issues.list", "all")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.payload.filter).toBe("all")
    expect(card.payload.issues).toEqual([])
    expect(calls).toContain("GET /api/repos/will/flows/issues")
    // Smithers Cloud's own route never sees state=all; GitHub's accepts it.
    expect(calls.some((call) => call.startsWith("GET /api/repos/") && call.includes("state=all"))).toBe(false)
    expect(calls).toContain("GET /api/user/github-repos/will/flows/issues?state=all")
  })

  test("a mirrored repo lists Smithers Cloud's own issues AND GitHub's, each row labeled, with the read's provenance from plue's headers", async () => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues": json(200, [wireIssue(7)]),
        "GET /api/user/github-repos/will/flows/issues": new Response(JSON.stringify([wireGithubIssue(12)]), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-metadata-source": "synced",
            "x-metadata-synced-at": "2026-09-02T16:00:00Z",
            "x-metadata-stale": "true",
            "x-metadata-sync-error": "rate limited at 15:59"
          }
        })
      })
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.payload.issues.map((issue) => [issue.number, issue.source])).toEqual([[7, "smithers-cloud"], [12, "github"]])
    expect(card.payload.issues[1]?.htmlUrl).toBe("https://github.com/will/flows/issues/12")
    expect(card.payload.github).toEqual({
      source: "synced",
      syncedAt: "2026-09-02T16:00:00Z",
      stale: true,
      syncError: "rate limited at 15:59",
      refusal: null
    })
    // The model reads the rows as text, GitHub rows marked.
    expect(outcome.status === "executed" ? outcome.value : "").toContain("#12 Upstream bug 12 · open · GitHub")
  })

  test("a GitHub refusal (not linked, not mirrored) is stated on the card while Smithers Cloud's own issues still list", async () => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues": json(200, [wireIssue(7)]),
        "GET /api/user/github-repos/will/flows/issues": json(403, { message: "GitHub is not linked for this account" })
      })
    )
    expect((await controller.commands.run("issues.list")).status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.payload.issues.map((issue) => issue.number)).toEqual([7])
    expect(card.payload.github?.refusal).toBe("GitHub is not linked for this account")
  })
})

describe("issues seam — the detail", () => {
  test.each(["run", "runForAgent"] as const)("issues.view fetches the issue AND its comments and upserts the detail card (%s)", async (door) => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues/7": json(200, wireIssue(7)),
        "GET /api/repos/will/flows/issues/7/comments": json(200, [
          wireComment(1, "First!"),
          "junk"
        ])
      })
    )
    const outcome = await controller.commands[door]("issues.view", "7")
    expect(outcome.status).toBe("executed")
    const value = outcome.status === "executed" ? outcome.value : undefined
    for (const text of ["will/flows", "#7 Fix the flake 7 · open", "ana", "It **flakes** on CI.", "bug", "bob", "First!", "2026-08-11T10:00:00Z"]) {
      expect(value).toContain(text)
    }
    await settled()
    const card = cardOfKind(store, "issue-will/flows-7", "issue")
    expect(card.payload).toMatchObject({
      repo: "will/flows",
      number: 7,
      title: "Fix the flake 7",
      state: "open",
      author: "ana",
      issueBody: "It **flakes** on CI.",
      labels: ["bug"],
      comments: [{ author: "bob", commentBody: "First!", createdAt: "2026-08-11T10:00:00Z" }]
    })
  })
})

test("issue detail bounds the model value while retaining the card body", async () => {
  const body = "large issue body ".repeat(2_000)
  const { store, controller } = await issuesController(backend({
    "GET /api/repos/will/flows/issues/7": json(200, wireIssue(7, { body })),
    "GET /api/repos/will/flows/issues/7/comments": json(200, [])
  }))
  const outcome = await controller.commands.runForAgent("issues.view", "7")
  expect(outcome.status).toBe("executed")
  const value = outcome.status === "executed" ? outcome.value : undefined
  expect(value).toContain("#7 Fix the flake 7 · open")
  expect(value).toContain("[truncated]")
  expect(value?.length).toBeLessThanOrEqual(16_000)
  expect(cardOfKind(store, "issue-will/flows-7", "issue").payload.issueBody).toBe(body)
})

describe("issues seam — mutations re-fetch so the card states the new truth", () => {
  test("issues.close PATCHes {state:'closed'} then upserts the re-fetched closed card", async () => {
    let patched: unknown
    const { store, controller } = await issuesController(
      backend({
        "PATCH /api/repos/will/flows/issues/7": async (request) => {
          patched = await request.json()
          return json(200, wireIssue(7, { state: "closed", closed_at: "2026-08-12T09:30:00Z" }))
        },
        "GET /api/repos/will/flows/issues/7": json(
          200,
          wireIssue(7, { state: "closed", closed_at: "2026-08-12T09:30:00Z" })
        ),
        "GET /api/repos/will/flows/issues/7/comments": json(200, [])
      })
    )
    const outcome = await controller.commands.run("issues.close", "7")
    expect(outcome.status).toBe("executed")
    expect(patched).toEqual({ state: "closed" })
    await settled()
    const card = cardOfKind(store, "issue-will/flows-7", "issue")
    expect(card.payload.state).toBe("closed")
    expect(card.payload.comments).toEqual([])
  })

  test("issues.comment POSTs {body} then upserts the card carrying the new comment", async () => {
    let posted: unknown
    const { store, controller } = await issuesController(
      backend({
        "POST /api/repos/will/flows/issues/7/comments": async (request) => {
          posted = await request.json()
          return json(201, wireComment(2, "hello"))
        },
        "GET /api/repos/will/flows/issues/7": json(200, wireIssue(7, { comment_count: 3 })),
        "GET /api/repos/will/flows/issues/7/comments": json(200, [
          wireComment(1, "First!"),
          wireComment(2, "hello")
        ])
      })
    )
    const outcome = await controller.commands.run("issues.comment", "7 hello")
    expect(outcome.status).toBe("executed")
    expect(posted).toEqual({ body: "hello" })
    await settled()
    const card = cardOfKind(store, "issue-will/flows-7", "issue")
    expect(card.payload.comments.map((comment) => comment.commentBody)).toEqual([
      "First!",
      "hello"
    ])
  })

  test("CAP-003: a posted comment with a failed refresh stays successful and retries only the read", async () => {
    const calls: string[] = []
    let detailReads = 0
    const { store, controller } = await issuesController(backend({
      "POST /api/repos/will/flows/issues/7/comments": json(201, wireComment(2, "hello")),
      "GET /api/repos/will/flows/issues/7": () => {
        detailReads += 1
        return detailReads === 1
          ? json(503, { message: "Detail unavailable" })
          : json(200, wireIssue(7, { comment_count: 3 }))
      },
      "GET /api/repos/will/flows/issues/7/comments": json(200, [wireComment(2, "hello")])
    }, calls))

    expect(controller.runCommand("issues.comment", "7 hello")).toBe(true)
    for (let turn = 0; turn < 10 && store.collections.toasts.get("toast-issue.comment.refresh:will/flows:7") === undefined; turn += 1) {
      await settled()
    }
    expect(store.collections.toasts.get("toast-issue.comment.refresh:will/flows:7")).toMatchObject({
      title: "Comment posted",
      status: "failed",
      detail: "Refresh failed: Detail unavailable",
      action: { label: "Retry", flow: "issues.view", args: "7 will/flows" }
    })
    expect([...store.collections.toasts.values()].some(toast => toast.title.includes("didn't run"))).toBe(false)
    expect(calls.filter(call => call.startsWith("POST "))).toHaveLength(1)

    expect((await controller.commands.run("issues.view", "7 will/flows")).status).toBe("executed")
    expect(calls.filter(call => call.startsWith("POST "))).toHaveLength(1)
    expect(calls.filter(call => call === "GET /api/repos/will/flows/issues/7")).toHaveLength(2)
    expect(calls.filter(call => call === "GET /api/repos/will/flows/issues/7/comments")).toHaveLength(1)
  })

  test("CAP-003: a refused comment write never claims it posted", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(backend({
      "POST /api/repos/will/flows/issues/7/comments": json(500, { message: "Write refused" })
    }, calls))

    expect(controller.runCommand("issues.comment", "7 hello")).toBe(true)
    for (let turn = 0; turn < 10 && store.collections.toasts.get("toast-command.failed.issues.comment") === undefined; turn += 1) {
      await settled()
    }
    expect(calls.filter(call => call.includes("/issues/7"))).toEqual(["POST /api/repos/will/flows/issues/7/comments"])
    expect(store.collections.toasts.get("toast-command.failed.issues.comment")).toMatchObject({
      title: "Comment on an issue didn't run",
      status: "failed",
      detail: "Write refused"
    })
    expect([...store.collections.toasts.values()].some(toast =>
      toast.title.includes("posted") || toast.detail.includes("posted")
    )).toBe(false)
  })

  test("CAP-003: a lost comment response reports an unknown write outcome and does not refresh", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(backend({
      "POST /api/repos/will/flows/issues/7/comments": () => { throw new TypeError("connection reset") }
    }, calls))

    expect(controller.runCommand("issues.comment", "7 hello")).toBe(true)
    for (let turn = 0; turn < 10 && store.collections.toasts.get("toast-issue.comment.unknown:will/flows:7") === undefined; turn += 1) {
      await settled()
    }
    expect(store.collections.toasts.get("toast-issue.comment.unknown:will/flows:7")).toMatchObject({
      title: "Comment status unknown",
      status: "failed",
      detail: "No response from issue #7 in will/flows: connection reset"
    })
    expect([...store.collections.toasts.values()].some(toast => toast.title.includes("didn't run"))).toBe(false)
    expect(calls.filter(call => call.includes("/issues/7"))).toEqual(["POST /api/repos/will/flows/issues/7/comments"])
  })

})

describe("issues seam — honest failures, never throws", () => {
  test("a 500 answers the backend's message as a failed outcome and keeps the failed view visible", async () => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues": json(500, { message: "the platform exploded" })
      })
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the platform exploded")
    await settled()
    expect(store.collections.cards.get("issues-will/flows")).toMatchObject({ status: "error", loading: false })
  })

  test("a network throw answers an honest string and keeps the failed view visible", async () => {
    // Only the issues routes throw; everything else 404s so startup seams stay honest.
    const throwingBackend: AppServices = {
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const path = new URL(url, "https://app.test").pathname
        if (path.startsWith("/api/repos/")) throw new TypeError("socket hangup")
        return json(404, { status: "error", message: `no stub for ${path}` })
      }
    }
    const { store, controller } = await issuesController(throwingBackend)
    const outcome = await controller.commands.run("issues.view", "7")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toContain("Could not reach the backend")
      expect(outcome.error).toContain("socket hangup")
    }
    await settled()
    expect(store.collections.cards.get("issue-will/flows-7")).toMatchObject({ status: "error", loading: false })
  })

  test("with several loaded repositories and no argument, the answer is the missing-repository form", async () => {
    const { store, controller } = await issuesController(backend({}))
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        { id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null },
        { id: "will/smithers", org: "will", ownerKind: "user", name: "smithers", head: null }
      ]
    })
    await settled()
    /* THE FORM LAW: the missing repository is asked for, never guessed (tutorial stage 3). */
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("executed")
    const form = store.collections.cards.get("form-issues.list")
    expect(form?.kind).toBe("flow-form")
    if (form?.kind === "flow-form") expect(form.payload.fields.map(field => field.name)).toContain("repo")
    expect(store.collections.cards.get("issues-will/flows")).toBeUndefined()
  })
})

/*
 * IMPORT-READINESS degradation (multi importReadiness.ts + githubIssues.ts):
 * the imported namespace 404s for a source-only repo, so the list falls back
 * to the GET-only GitHub-source read; detail and mutations answer honest
 * strings pointing at /repos.import and never touch the source namespace.
 */
describe("issues seam — source-only fallback (repo not imported)", () => {
  test("issues.list on an imported-namespace 404 reads the GitHub source and marks the card", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend(
        {
          "GET /api/repos/will/flows/issues": json(404, { message: "repository not found" }),
          "GET /api/user/github-repos/will/flows/issues": json(200, [
            wireGithubIssue(12),
            // GitHub's issues endpoint includes pull requests — the row drops.
            wireGithubIssue(99, { pull_request: { url: "https://api.github.test/pulls/99" } }),
            "junk",
            wireGithubIssue(15, {
              state: "closed",
              user: null,
              comments: "not-a-number",
              updated_at: null
            })
          ])
        },
        calls
      )
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toBe(
      "#12 Upstream bug 12 · open · GitHub\n#15 Upstream bug 15 · closed · GitHub"
    )
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.title).toBe("Issues · will/flows")
    expect(card.body).toBe("Read from GitHub — import for full features: /repos.import will/flows")
    expect(card.payload.repo).toBe("will/flows")
    expect(card.payload.filter).toBe("open")
    // GitHub spellings land in the same rows: user.login → author, comments → comments.
    expect(card.payload.issues).toMatchObject([
      {
        number: 12,
        source: "github",
        htmlUrl: "https://github.com/will/flows/issues/12",
        title: "Upstream bug 12",
        state: "open",
        author: "octo",
        comments: 4,
        updatedAt: "2026-08-10T09:00:00Z"
      },
      {
        number: 15,
        source: "github",
        htmlUrl: "https://github.com/will/flows/issues/15",
        title: "Upstream bug 15",
        state: "closed",
        author: null,
        comments: 0,
        updatedAt: null
      }
    ])
    expect(calls).toContain("GET /api/repos/will/flows/issues?state=open")
    expect(calls).toContain("GET /api/user/github-repos/will/flows/issues?state=open")
  })

  test.each(["open", "closed", "all"])("empty source list answers a value for %s", async (filter) => {
    const { controller } = await issuesController(backend({
      "GET /api/repos/will/flows/issues": json(404, { message: "repository not found" }),
      "GET /api/user/github-repos/will/flows/issues": json(200, [])
    }))
    const outcome = await controller.commands.runForAgent("issues.list", filter)
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toBe(
      `No ${filter === "all" ? "" : `${filter} `}issues in will/flows (read from GitHub).`
    )
  })

  test("issues.list all asks the GitHub source with state=all — only Plue rejects state=all", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend(
        {
          "GET /api/repos/will/flows/issues": json(404, { message: "repository not found" }),
          "GET /api/user/github-repos/will/flows/issues": json(200, [wireGithubIssue(3)])
        },
        calls
      )
    )
    const outcome = await controller.commands.run("issues.list", "all")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.payload.filter).toBe("all")
    expect(card.payload.issues.map((issue) => issue.number)).toEqual([3])
    expect(calls).toContain("GET /api/user/github-repos/will/flows/issues?state=all")
  })

  test("the GitHub source failing too answers the honest error and keeps the failed view visible", async () => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues": json(404, { message: "repository not found" }),
        "GET /api/user/github-repos/will/flows/issues": json(404, {
          message: "GitHub answered 404 for will/flows"
        })
      })
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("GitHub answered 404 for will/flows")
    }
    await settled()
    expect(store.collections.cards.get("issues-will/flows")).toMatchObject({ status: "error", loading: false })
  })

  test("native issues.view on a 404 names the explicit GitHub door without switching trackers", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend({ "GET /api/repos/will/flows/issues/7": json(404, { message: "not found" }) }, calls)
    )
    const outcome = await controller.commands.run("issues.view", "7")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toContain("Issue #7 in will/flows answered 404")
      expect(outcome.error).toContain("/issues.view 7 will/flows --source github")
    }
    expect(calls.some((call) => call.includes("/api/user/github-repos/"))).toBe(false)
    expect(store.collections.cards.get("issue-will/flows-7")).toMatchObject({ status: "error", loading: false })
  })

  /*
   * Was "mutations on a 404 answer the repos.import error": nothing was
   * stubbed, so every route answered a code-less 404 and the seam read it as a
   * missing import. The deployed platform codes both causes `not_found`, so
   * `/issue.close 999` in a repository the user just listed was told to import
   * it. Assertion changed deliberately; the two traffic guards are unchanged.
   */
  test("mutations on a coded not-found name the resource, never an import, and never write to the source", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(backend({
      "POST /api/repos/will/flows/issues": json(404, REPOSITORY_NOT_FOUND),
      "PATCH /api/repos/will/flows/issues/7": json(404, ISSUE_NOT_FOUND),
      "POST /api/repos/will/flows/issues/7/comments": json(404, ISSUE_NOT_FOUND)
    }, calls))
    const mutations: ReadonlyArray<readonly [string, string, string]> = [
      ["issues.create", "A brand new idea", "will/flows was not found"],
      ["issues.close", "7", "Issue #7 in will/flows was not found"],
      ["issues.reopen", "7", "Issue #7 in will/flows was not found"],
      ["issues.comment", "7 hello there", "Issue #7 in will/flows was not found"]
    ]
    for (const [command, args, error] of mutations) {
      const outcome = await controller.commands.run(command, args)
      expect(outcome.status).toBe("failed")
      if (outcome.status === "failed") expect(outcome.error).toBe(error)
    }
    // Zero fallback traffic: the GET-only source namespace was never touched.
    expect(calls.some((call) => call.includes("/api/user/github-repos/"))).toBe(false)
    await settled()
    expect(store.collections.cards.get("issue-will/flows-7")).toBeUndefined()
  })

  test("closing an issue number the platform does not have answers that, not the import", async () => {
    const calls: string[] = []
    const { controller } = await issuesController(backend({
      "PATCH /api/repos/will/flows/issues/999": json(404, ISSUE_NOT_FOUND)
    }, calls))
    const outcome = await controller.commands.run("issues.close", "999")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Issue #999 in will/flows was not found")
    // One request, the PATCH itself: nothing is asked a second time to explain the 404.
    expect(calls.filter((call) => call.includes("/issues"))).toEqual(["PATCH /api/repos/will/flows/issues/999"])
  })

  test("a 404 carrying another code keeps the platform's own message", async () => {
    const { controller } = await issuesController(backend({
      "PATCH /api/repos/will/flows/issues/7": json(404, { status: "error", code: "route_not_found", message: "Not found." })
    }))
    const outcome = await controller.commands.run("issues.close", "7")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Not found.")
  })

  /* The one cause local state does name: a checkout the sidebar pins that Cloud has never taken. */
  test("a pinned checkout Cloud does not have keeps the import guidance", async () => {
    const { store, controller } = await issuesController(backend({
      "POST /api/repos/will/flows/issues": json(404, REPOSITORY_NOT_FOUND)
    }))
    await store.dispatch({
      type: "repo.pinned",
      actor: "user",
      pin: { id: "pin-flows", name: "will/flows", path: "/Users/will/flows", branch: "main", origin: "local", pinnedAt: 1 }
    }).isPersisted.promise
    const outcome = await controller.commands.run("issues.create", "A brand new idea")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("will/flows isn't imported yet — run /repos.import will/flows first")
    }
  })

  test("closing a missing number in an open, imported checkout answers the number, not the import", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(backend({
      "GET /api/repos/will/flows/issues": json(200, [wireIssue(7)]),
      "PATCH /api/repos/will/flows/issues/999": json(404, ISSUE_NOT_FOUND)
    }, calls))
    await openCheckout(store)
    // The state the defect needed: the open checkout is pinned, and its issues list came back imported.
    expect([...store.collections.pinnedRepos.values()].map((pin) => pin.name)).toEqual(["will/flows"])
    expect((await controller.commands.run("issues.list", "")).status).toBe("executed")
    const outcome = await controller.commands.run("issues.close", "999")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Issue #999 in will/flows was not found")
    expect(calls.filter((call) => call.startsWith("PATCH"))).toEqual(["PATCH /api/repos/will/flows/issues/999"])
  })

  test("creating an issue in an open checkout the platform 404s names the repository, not the import", async () => {
    const { store, controller } = await issuesController(backend({
      "POST /api/repos/will/flows/issues": json(404, REPOSITORY_NOT_FOUND)
    }))
    await openCheckout(store)
    const outcome = await controller.commands.run("issues.create", "A brand new idea")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("will/flows was not found")
  })

  /* A pin says the checkout is here, never that a number exists, so a number-scoped 404 keeps its own sentence. */
  test("a pinned, unopened checkout still answers the number on a number-scoped 404", async () => {
    const { store, controller } = await issuesController(backend({
      "PATCH /api/repos/will/flows/issues/999": json(404, ISSUE_NOT_FOUND)
    }))
    await store.dispatch({
      type: "repo.pinned",
      actor: "user",
      pin: { id: "pin-flows", name: "will/flows", path: "/Users/will/flows", branch: "main", origin: "local", pinnedAt: 1 }
    }).isPersisted.promise
    const outcome = await controller.commands.run("issues.close", "999")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Issue #999 in will/flows was not found")
  })

  test("a pinned, unopened checkout keeps the platform's message when the 404 carries another code", async () => {
    const { store, controller } = await issuesController(backend({
      "POST /api/repos/will/flows/issues": json(404, { status: "error", code: "route_not_found", message: "Not found." })
    }))
    await store.dispatch({
      type: "repo.pinned",
      actor: "user",
      pin: { id: "pin-flows", name: "will/flows", path: "/Users/will/flows", branch: "main", origin: "local", pinnedAt: 1 }
    }).isPersisted.promise
    const outcome = await controller.commands.run("issues.create", "A brand new idea")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Not found.")
  })

  test("a 404 with no code keeps the platform's message, and an unreadable 404 answers the act's own sentence", async () => {
    const { controller } = await issuesController(backend({
      "PATCH /api/repos/will/flows/issues/7": json(404, { status: "error", message: "issue not found" }),
      "POST /api/repos/will/flows/issues/7/comments": new Response("<!doctype html>404", { status: 404, headers: { "content-type": "text/html" } })
    }))
    const closed = await controller.commands.run("issues.close", "7")
    expect(closed.status).toBe("failed")
    if (closed.status === "failed") expect(closed.error).toBe("issue not found")
    const commented = await controller.commands.run("issues.comment", "7 hello there")
    expect(commented.status).toBe("failed")
    if (commented.status === "failed") expect(commented.error).toBe("Issue #7 in will/flows was not found")
  })
})

describe("source-qualified issue identity", () => {
  test("same-number native and GitHub rows open their own details and remain separate in history", async () => {
    const calls: string[] = []
    const { store, controller, storage } = await issuesController(backend({
      "GET /api/repos/will/flows/issues": json(200, [wireIssue(1, { title: "Native issue" })]),
      "GET /api/repos/will/flows/issues/1": json(200, wireIssue(1, { title: "Native issue" })),
      "GET /api/repos/will/flows/issues/1/comments": json(200, []),
      "GET /api/user/github-repos/will/flows/issues": json(200, [wireGithubIssue(1, { title: "GitHub issue" })]),
      "GET /api/user/github-repos/will/flows/issues/1/comments": json(200, [{ user: { login: "octo" }, body: "GitHub comment", created_at: "2026-09-14T12:00:00Z" }])
    }, calls))
    expect((await controller.commands.run("issues.list", "will/flows")).status).toBe("executed")
    const list = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(list.payload.issues.map(row => [row.number, row.source])).toEqual([[1, "smithers-cloud"], [1, "github"]])
    expect((await controller.commands.run("issues.view", "1 will/flows --source smithers-cloud")).status).toBe("executed")
    expect(cardOfKind(store, list.id, "issue").payload.title).toBe("Native issue")
    calls.length = 0
    expect((await controller.commands.run("issues.view", "1 will/flows --source github")).status).toBe("executed")
    const detail = cardOfKind(store, list.id, "issue")
    expect(detail.payload).toMatchObject({ number: 1, source: "github", title: "GitHub issue", issueBody: "Seen on main.", author: "octo", labels: ["bug"], comments: [{ author: "octo", commentBody: "GitHub comment" }] })
    expect(calls.filter(call => call.includes("/issues"))).toEqual([
      "GET /api/user/github-repos/will/flows/issues?state=all&per_page=100&page=1",
      "GET /api/user/github-repos/will/flows/issues/1/comments?per_page=100&page=1"
    ])
    const history = store.collections.cardHistories.get(list.id)!
    expect(history.entries.filter(entry => entry.kind === "issue").map(entry => entry.payload.title)).toEqual(["Native issue", "GitHub issue"])
    await controller.dispose()
    await store.settled?.()
    await store.dispose?.()
    const restored = await createAppStore({ kind: "localStorage", storage })
    expect(cardOfKind(restored, list.id, "issue").payload.source).toBe("github")
    await restored.dispatch({ type: "card.history.moved", actor: "user", id: list.id, delta: -1 }).isPersisted.promise
    expect(cardOfKind(restored, list.id, "issue").payload.title).toBe("Native issue")
    await restored.dispatch({ type: "card.history.moved", actor: "user", id: list.id, delta: 1 }).isPersisted.promise
    expect(cardOfKind(restored, list.id, "issue").payload.source).toBe("github")
  })

  test("GitHub read follows metadata pagination and refuses a missing source issue without reading native detail", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(backend({
      "GET /api/user/github-repos/will/flows/issues": request => new URL(request.url).searchParams.get("page") === "1"
        ? new Response(JSON.stringify([wireGithubIssue(2)]), { headers: { link: '<https://untrusted.example/path?page=2>; rel="next"' } })
        : json(200, [wireGithubIssue(1)]),
      "GET /api/user/github-repos/will/flows/issues/1/comments": json(200, [])
    }, calls))
    expect((await controller.commands.run("issues.view", "1 will/flows --source github")).status).toBe("executed")
    expect(cardOfKind(store, "issue-github-will/flows-1", "issue").payload.title).toBe("Upstream bug 1")
    expect(calls).toContain("GET /api/user/github-repos/will/flows/issues?state=all&per_page=100&page=2")
    expect((await controller.commands.run("issues.view", "99 will/flows --source github")).status).toBe("failed")
    expect(calls.some(call => /\/api\/repos\/.*\/issues/.test(call) || call.includes("untrusted"))).toBe(false)
  })

  test("missing issue number preserves GitHub source and repository in the shared form", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(backend({
      "GET /api/user/github-repos/will/flows/issues": json(200, [wireGithubIssue(1)]),
      "GET /api/user/github-repos/will/flows/issues/1/comments": json(200, [])
    }, calls))
    const outcome = await controller.commands.run("issues.view", "will/flows --source github")
    expect(outcome.status).toBe("form")
    await settled()
    const form = [...store.collections.cards.values()].find(card => card.kind === "flow-form")
    expect(form?.kind).toBe("flow-form")
    if (form?.kind !== "flow-form") throw Error("Missing form")
    expect(form.payload.draft).toMatchObject({ source: "github", repo: "will/flows" })
    expect(form.payload.fields.find(field => field.name === "number")?.required).toBe(true)
    expect((await controller.commands.run("form.set", `${form.id} number 1`)).status).toBe("executed")
    expect((await controller.commands.run("form.submit", form.id)).status).toBe("executed")
    expect(cardOfKind(store, "issue-github-will/flows-1", "issue").payload.source).toBe("github")
    expect(calls.some(call => /\/api\/repos\/.*\/issues/.test(call))).toBe(false)
  })

  test("opening a GitHub issue marks only that tracker read and failed reads leave receipts unread", async () => {
    const { store, controller } = await issuesController(backend({
      "GET /api/user/github-repos/will/flows/issues": json(200, [wireGithubIssue(1)]),
      "GET /api/user/github-repos/will/flows/issues/1/comments": json(200, [])
    }))
    const notices = processRepositoryEvents("github:will", "will/flows", ["smithers", "github"].flatMap(source => [1, 99].map(number => ({
      source, sourceId: String(number), kind: "issue" as const, number, title: `${source} ${number}`, state: "open", updatedAt: null, tags: []
    }))), [], 0).rows
    await store.dispatch({ type: "repo.update.published", actor: "system", notifications: notices, card: {
      id: "activity", kind: "repo-update", title: "Activity", status: "active", createdAt: 0, ordinal: 0,
      payload: { repo: "will/flows", scope: "github:will", checkedAt: 0, summary: "", openIssues: 4, openPrs: 0, problems: [], items: [] }
    } }).isPersisted.promise
    expect((await controller.commands.run("issues.view", "1 will/flows --source github")).status).toBe("executed")
    expect((await controller.commands.run("issues.view", "99 will/flows --source github")).status).toBe("failed")
    for (const notice of store.collections.repositoryNotifications.values()) {
      expect(notice.readVersion === notice.version).toBe(notice.source === "github" && notice.number === 1)
    }
  })
})

test.each(["smithers-cloud", "github"] as const)("%s issue reads retain forge assignees through persisted card schemas", async source => {
  const wire = wireIssue(1, { assignees: [{ id: 7, login: "ada", avatar_url: "https://avatars.githubusercontent.com/u/7" }],
    author: { login: "ana", avatar_url: "https://avatars.githubusercontent.com/u/3" },
    user: { login: "ana", avatar_url: "https://avatars.githubusercontent.com/u/3" }, comments: 0 })
  const { store, controller } = await issuesController(backend({
    "GET /api/repos/will/flows/issues": source === "github" ? json(404, REPOSITORY_NOT_FOUND) : json(200, [wire]),
    "GET /api/repos/will/flows/issues/1": json(200, wire),
    "GET /api/repos/will/flows/issues/1/comments": json(200, []),
    "GET /api/user/github-repos/will/flows/issues": json(200, [wire]),
    "GET /api/user/github-repos/will/flows/issues/1/comments": json(200, [])
  }))
  try {
    expect((await controller.commands.run("issues.list")).status).toBe("executed")
    const row = cardOfKind(store, "issues-will/flows", "issue-list").payload.issues[0]!
    expect(row.assignees).toEqual([{ login: "ada", avatar: "https://avatars.githubusercontent.com/u/7" }])
    expect(row.labelColors).toEqual({ bug: "d73a4a" })
    expect((await controller.commands.run("issues.view", `1 will/flows --source ${source}`)).status).toBe("executed")
    const detail = cardOfKind(store, "issues-will/flows", "issue").payload
    expect(detail.assignees).toEqual(row.assignees)
    expect(detail.createdAt).toBe(wire.created_at)
    expect(detail.authorAvatar).toBe("https://avatars.githubusercontent.com/u/3")
  } finally { await controller.dispose(); await store.dispose?.() }
})

test("private chat creation, persona comments, edits and deletes use the existing issue paths", async () => {
  const writes: unknown[] = []
  let comments = [{ ...wireComment(31, "hello"), persona: { username: "Reviewer", iconEmoji: ":robot_face:" } }]
  const { store, controller } = await issuesController(backend({
    "POST /api/repos/will/flows/issues": async request => { writes.push(await request.json()); return json(201, wireIssue(8, { kind: "chat", visibility: "private" })) },
    "GET /api/repos/will/flows/issues/8": () => json(200, wireIssue(8, { kind: "chat", visibility: "private" })),
    "GET /api/repos/will/flows/issues/8/comments": () => json(200, comments),
    "PATCH /api/repos/will/flows/issues/comments/31": async request => { const body = await request.json() as { body: string }; comments[0]!.body = body.body; writes.push(body); return json(200, comments[0]) },
    "DELETE /api/repos/will/flows/issues/comments/31": () => { comments = []; return new Response(null, { status: 204 }) }
  }))
  try {
    expect(await controller.createIssue("sync test", "will/flows", "chat")).toBeUndefined()
    expect(writes[0]).toEqual({ title: "sync test", kind: "chat", visibility: "private" })
    expect([...store.collections.toasts.values()].some(toast => toast.action?.flow === "ci.setup")).toBe(false)
    const card = [...store.collections.cards.values()].find(row => row.kind === "issue")!
    if (card.kind !== "issue") throw Error("Wrong card")
    expect(card.payload).toMatchObject({ kind: "chat", visibility: "private", comments: [{ id: 31, persona: { username: "Reviewer" } }] })
    expect(await controller.editIssueComment(8, 31, "edited", "will/flows")).toBeUndefined()
    expect(writes[1]).toEqual({ body: "edited" })
    expect(await controller.deleteIssueComment(8, 31, "will/flows")).toBeUndefined()
    expect((store.collections.cards.get(card.id) as typeof card).payload.comments).toEqual([])
  } finally { await controller.dispose(); await store.dispose?.() }
})

test("comment pagination uses scoped opaque cursors and projects each message once", async () => {
  const calls: string[] = []
  const { store, controller } = await issuesController(backend({
    "GET /api/repos/will/flows/issues/8": json(200, wireIssue(8, { kind: "chat", visibility: "private" })),
    "GET /api/repos/will/flows/issues/8/comments": request => {
      const cursor = new URL(request.url).searchParams.get("cursor")
      if (cursor) return json(200, [wireComment(32, "second")])
      return new Response(JSON.stringify([wireComment(31, "first")]), { headers: { "content-type": "application/json", link: '<https://untrusted.invalid/wrong?cursor=MzE>; rel="next"' } })
    }
  }, calls))
  try {
    expect((await controller.commands.run("issues.view", "8 will/flows")).status).toBe("executed")
    const card = [...store.collections.cards.values()].find(row => row.kind === "issue")!
    if (card.kind !== "issue") throw Error("Wrong card")
    expect(card.payload.comments.map(row => row.id)).toEqual([31, 32])
    expect(calls).toContain("GET /api/repos/will/flows/issues/8/comments?cursor=MzE")
  } finally { await controller.dispose(); await store.dispose?.() }
})

test("a restored chat card refreshes remote edits and deletes without a second transcript store", async () => {
  let messages: Record<string, unknown>[] = [{ ...wireComment(31, "from Slack"), commenter: "U0HUMAN", persona: { username: "" } }]
  const { store, controller } = await issuesController(backend({
    "GET /api/repos/will/flows/issues/8": () => json(200, wireIssue(8, { kind: "chat", visibility: "private" })),
    "GET /api/repos/will/flows/issues/8/comments": () => json(200, messages)
  }))
  try {
    await controller.commands.run("issues.view", "8 will/flows")
    const card = [...store.collections.cards.values()].find(row => row.kind === "issue")!
    if (card.kind !== "issue") throw Error("Wrong card")
    await store.dispatch({ type: "card.view.loaded", actor: "system", card: { ...card, payload: { ...card.payload,
      conversation: { branchId: store.session().activeBranchId!, owner: "will", creationKey: "test-binding" }
    } } }).isPersisted.promise
    expect(store.collections.messages.get(`issue-comment:${card.id}:31`)).toMatchObject({ text: "from Slack", role: "user" })
    expect(card.payload.comments[0]).toMatchObject({ author: "U0HUMAN" })
    expect(card.payload.comments[0]?.persona).toBeUndefined()
    messages = [wireComment(31, "edited in Slack"), { ...wireComment(32, "reply"), persona: { username: "Reviewer" } }]
    await new Promise(resolve => setTimeout(resolve, 2_100))
    expect((store.collections.cards.get(card.id) as typeof card).payload.comments.map(row => row.commentBody)).toEqual(["edited in Slack", "reply"])
    expect(store.collections.messages.get(`issue-comment:${card.id}:31`)?.text).toBe("edited in Slack")
    expect(store.collections.messages.get(`issue-comment:${card.id}:32`)).toMatchObject({ text: "reply", role: "smithers" })
    messages = []
    await new Promise(resolve => setTimeout(resolve, 2_100))
    expect((store.collections.cards.get(card.id) as typeof card).payload.comments).toEqual([])
    expect([...store.collections.cards.values()].filter(row => row.kind === "issue")).toHaveLength(1)
    expect([...store.collections.messages.values()].filter(row => row.issueCardId === card.id)).toEqual([])
  } finally { await controller.dispose(); await store.dispose?.() }
}, 10_000)

test.each(["slack", "telegram"] as const)("%s mapping uses generic settings and projects delivery state", async provider => {
  const requests: unknown[] = []
  const { store, controller } = await issuesController(backend({
    "PUT /api/repos/will/flows/issues/8/sync": async request => { requests.push(await request.json()); return json(200, {}) },
    "GET /api/repos/will/flows/issues/8": json(200, wireIssue(8, { kind: "chat", visibility: "private" })),
    "GET /api/repos/will/flows/issues/8/comments": json(200, []),
    "GET /api/repos/will/flows/issues/8/sync": json(200, { provider, connection_id: "connection", scope_id: "scope", conversation_id: "conversation", thread_id: "thread", state: "pending", error: null })
  }))
  try {
    await controller.commands.run("issues.view", "8 will/flows")
    const mapping = { provider, connectionId: "connection", scopeId: "scope", conversationId: "conversation", threadId: "thread", externalUserId: "user" }
    expect(await controller.mapIssueSync(8, mapping, "will/flows")).toBeUndefined()
    expect(requests).toEqual([{ provider, connection_id: "connection", scope_id: "scope", conversation_id: "conversation", thread_id: "thread", external_user_id: "user" }])
    const card = [...store.collections.cards.values()].find(row => row.kind === "issue")!
    expect(card.kind === "issue" && card.payload.sync).toEqual({ provider, connectionId: "connection", scopeId: "scope", conversationId: "conversation", threadId: "thread", state: "pending", error: null })
  } finally { await controller.dispose(); await store.dispose?.() }
})

test("chat sends persist and acknowledge before an unresolved POST, dedupe repeated input, and settle the shared toast from completion", async () => {
  let finish!: () => void
  let posted = false
  const requests: Array<{ body: string; idempotency_key: string }> = []
  const { store, controller } = await issuesController(backend({
    "GET /api/repos/will/flows/issues/8": () => json(200, wireIssue(8, { kind: "chat", visibility: "private" })),
    "GET /api/repos/will/flows/issues/8/comments": () => json(200, posted ? [wireComment(31, "hello")] : []),
    "POST /api/repos/will/flows/issues/8/comments": async request => {
      requests.push(await request.json() as { body: string; idempotency_key: string })
      await new Promise<void>(resolve => { finish = resolve })
      posted = true
      return json(201, wireComment(31, "hello"))
    }
  }))
  try {
    await controller.commands.run("issues.view", "8 will/flows")
    const card = [...store.collections.cards.values()].find(row => row.kind === "issue")!
    if (card.kind !== "issue") throw Error("Wrong card")
    await controller.draftIssueComment(card.id, "hello")
    expect(await controller.commentOnIssue(8, "hello", "will/flows")).toEqual({ value: "Requested" })
    expect(await controller.commentOnIssue(8, "hello", "will/flows")).toEqual({ value: "Requested" })
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(posted).toBe(false)
    expect(requests).toHaveLength(1)
    const pending = (store.collections.cards.get(card.id) as typeof card).payload
    expect(pending.pendingComments).toMatchObject([{ id: requests[0]!.idempotency_key, text: "hello", owner: "will", status: "requested" }])
    expect(pending.commentDraft).toBe("")
    expect(store.session().phase).toBe("idle")
    const toast = [...store.collections.toasts.values()].find(row => row.key === `issue.message:${requests[0]!.idempotency_key}`)!
    expect(toast.status).toBe("running")
    finish()
    for (let i = 0; i < 50 && (store.collections.cards.get(card.id) as typeof card).payload.pendingComments?.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
    await new Promise(resolve => setTimeout(resolve, 20))
    const saved = (store.collections.cards.get(card.id) as typeof card).payload
    expect(saved.pendingComments).toEqual([])
    expect(saved.comments.map(row => row.commentBody)).toEqual(["hello"])
    expect(store.collections.toasts.get(toast.id)?.status).toBe("ok")
  } finally { finish?.(); await controller.dispose(); await store.dispose?.() }
})

test("failed chat messages remain retryable with the same durable idempotency key", async () => {
  const requests: string[] = []
  const { store, controller } = await issuesController(backend({
    "GET /api/repos/will/flows/issues/8": () => json(200, wireIssue(8, { kind: "chat", visibility: "private" })),
    "GET /api/repos/will/flows/issues/8/comments": () => json(200, requests.length > 1 ? [wireComment(31, "retry me")] : []),
    "POST /api/repos/will/flows/issues/8/comments": async request => {
      requests.push((await request.json() as { idempotency_key: string }).idempotency_key)
      return requests.length === 1 ? json(503, { message: "Try again" }) : json(201, wireComment(31, "retry me"))
    }
  }))
  try {
    await controller.commands.run("issues.view", "8 will/flows")
    const card = [...store.collections.cards.values()].find(row => row.kind === "issue")!
    if (card.kind !== "issue") throw Error("Wrong card")
    await controller.commentOnIssue(8, "retry me", "will/flows")
    await new Promise(resolve => setTimeout(resolve, 50))
    const pending = (store.collections.cards.get(card.id) as typeof card).payload.pendingComments![0]!
    expect(pending).toMatchObject({ status: "failed", error: "Try again" })
    await controller.retryIssueComment(card.id, pending.id)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(requests).toEqual([pending.id, pending.id])
    expect((store.collections.cards.get(card.id) as typeof card).payload.pendingComments).toEqual([])
  } finally { await controller.dispose(); await store.dispose?.() }
})

test("restored requested messages replay once through their persisted backend idempotency key", async () => {
  const storage = memoryStorage()
  let store = await createAppStore({ kind: "localStorage", storage })
  await signedIn(store)
  await reposChosen(store)
  const card: Extract<Card, { kind: "issue" }> = { id: "restored-chat", kind: "issue", title: "sync test", status: "active", createdAt: 0, ordinal: 1, payload: {
    repo: "will/flows", number: 8, kind: "chat", visibility: "private", title: "sync test", state: "open", author: "will", issueBody: "", labels: [], comments: [],
    commentDraft: "next draft", pendingComments: [{ id: "stable-request", text: "after restart", actor: "user", status: "requested" }]
  } }
  await store.dispatch({ type: "card.upsert", actor: "user", card }).isPersisted.promise
  await store.dispose?.()
  store = await createAppStore({ kind: "localStorage", storage })
  const requests: unknown[] = []
  const controller = createAppController(store, unavailableAgent, backend({
    "POST /api/repos/will/flows/issues/8/comments": async request => { requests.push(await request.json()); return json(201, wireComment(31, "after restart")) },
    "GET /api/repos/will/flows/issues/8": () => json(200, wireIssue(8, { kind: "chat", visibility: "private" })),
    "GET /api/repos/will/flows/issues/8/comments": () => json(200, [wireComment(31, "after restart")])
  }))
  try {
    await signedIn(store)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(requests).toEqual([{ body: "after restart", idempotency_key: "stable-request" }])
    const restored = store.collections.cards.get(card.id)
    expect(restored?.kind === "issue" && restored.payload).toMatchObject({ commentDraft: "next draft", pendingComments: [], comments: [{ commentBody: "after restart" }] })
  } finally { await controller.dispose(); await store.dispose?.() }
})

test.each(["slack", "telegram"] as const)("%s delivery remains running through dispatch and exposes an unknown outcome without reposting", async provider => {
  let state = "pending"
  let posts = 0
  const { store, controller } = await issuesController(backend({
    "GET /api/repos/will/flows/issues/8": () => json(200, wireIssue(8, { kind: "chat", visibility: "private" })),
    "GET /api/repos/will/flows/issues/8/comments": () => json(200, []),
    "GET /api/repos/will/flows/issues/8/sync": () => json(200, { issue_id: 800, provider, connection_id: "connection", scope_id: "T1", conversation_id: "C1", thread_id: "1.1", state, error: null }),
    "POST /api/repos/will/flows/issues/8/comments": () => { posts++; return json(201, {}) }
  }))
  try {
    await controller.commands.run("issues.view", "8 will/flows")
    await new Promise(resolve => setTimeout(resolve, 350))
    const toast = [...store.collections.toasts.values()].find(row => row.key.startsWith("issue.delivery:"))!
    expect(toast.status).toBe("running")
    await signedIn(store)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(store.collections.toasts.get(toast.id)?.status).toBe("running")
    state = "outcome_unknown"
    await new Promise(resolve => setTimeout(resolve, 2_000))
    expect(store.collections.toasts.get(toast.id)).toMatchObject({ status: "failed", detail: "Message delivery is unconfirmed. Reconciliation is required." })
    expect(posts).toBe(0)
  } finally { await controller.dispose(); await store.dispose?.() }
}, 5_000)

test("an account switch retires a delayed chat creation receipt and never sends the previous owner's pending text", async () => {
  let release!: () => void
  let reading!: () => void
  const started = new Promise<void>(resolve => { reading = resolve })
  const body = new Promise<void>(resolve => { release = resolve })
  let creates = 0, posts = 0
  const { store, controller } = await issuesController(backend({
    "GET /api/repos/will/flows/issues/8": () => json(200, wireIssue(8, { kind: "chat", visibility: "private" })),
    "GET /api/repos/will/flows/issues/8/comments": () => json(200, []),
    "POST /api/repos/will/flows/issues": () => {
      creates++
      return new Response(new ReadableStream({ async start(stream) {
        reading(); await body; stream.enqueue(new TextEncoder().encode(JSON.stringify({ number: 9 }))); stream.close()
      } }), { status: 201, headers: { "content-type": "application/json" } })
    },
    "POST /api/repos/will/flows/issues/9/comments": () => { posts++; return json(201, wireComment(31, "private text")) }
  }))
  try {
    await controller.commands.run("issues.view", "8 will/flows")
    const card = [...store.collections.cards.values()].find(row => row.kind === "issue")!
    if (card.kind !== "issue") throw Error("Wrong card")
    await store.dispatch({ type: "card.upsert", actor: "user", card: { ...card, payload: { ...card.payload, number: 0,
      conversation: { branchId: store.session().activeBranchId!, owner: "will", creationKey: "private-create" },
      pendingComments: [{ id: "owner-bound-request", text: "private text", owner: "will", actor: "user", status: "requested" }]
    } } }).isPersisted.promise
    await started
    await signedIn(store, "another-owner")
    release()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(creates).toBe(1)
    expect(posts).toBe(0)
    expect(store.collections.cards.get(card.id)).toBeUndefined()
    await store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...card.payload,
      pendingComments: [{ id: "restored-other-owner", owner: "will", text: "private text", actor: "user", status: "requested" }]
    } } }).isPersisted.promise
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(posts).toBe(0)
    expect((store.collections.cards.get(card.id) as typeof card).payload.pendingComments?.[0]?.status).toBe("requested")
  } finally { release?.(); await controller.dispose(); await store.dispose?.() }
})

test("a delayed poll cannot replace a newer mutation receipt and does not overlap itself", async () => {
  let release!: () => void
  let reading!: () => void
  const started = new Promise<void>(resolve => { reading = resolve })
  const body = new Promise<void>(resolve => { release = resolve })
  let reads = 0, text = "original"
  const { store, controller } = await issuesController(backend({
    "GET /api/repos/will/flows/issues/8": () => json(200, wireIssue(8, { kind: "chat", visibility: "private" })),
    "GET /api/repos/will/flows/issues/8/comments": () => {
      reads++
      if (reads === 2) return new Response(new ReadableStream({ async start(stream) {
        reading(); await body; stream.enqueue(new TextEncoder().encode(JSON.stringify([wireComment(31, "stale poll")]))); stream.close()
      } }), { status: 200, headers: { "content-type": "application/json" } })
      return json(200, [wireComment(31, text)])
    },
    "PATCH /api/repos/will/flows/issues/comments/31": () => { text = "edited"; return json(200, wireComment(31, text)) }
  }))
  try {
    await controller.commands.run("issues.view", "8 will/flows")
    const card = [...store.collections.cards.values()].find(row => row.kind === "issue")!
    if (card.kind !== "issue") throw Error("Wrong card")
    await started
    await new Promise(resolve => setTimeout(resolve, 2_100))
    expect(reads).toBe(2)
    await controller.editIssueComment(8, 31, "edited", "will/flows")
    expect((store.collections.cards.get(card.id) as typeof card).payload.comments[0]?.commentBody).toBe("edited")
    release()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect((store.collections.cards.get(card.id) as typeof card).payload.comments[0]?.commentBody).toBe("edited")
  } finally { release?.(); await controller.dispose(); await store.dispose?.() }
}, 10_000)
