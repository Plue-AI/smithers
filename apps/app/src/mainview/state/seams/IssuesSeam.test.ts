import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { processRepositoryEvents } from "../RepositoryNotifications"
import { invalidatePreparedViews } from "../PreparedView"
import { initialSetup, setupCandidate, type SetupRecoveryResponse } from "@smthrs/rpc/RepositorySetup"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { applicationIdentityFromFetch, waitFor } from "../TestFixtures"
import { fetchIssuePayload, readIssueOptions } from "./IssuesSeam"
import type { SeamContext } from "./SeamContext"

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

const selectedUserBackend = (routes: Record<string, RouteAnswer>, calls: string[] = []): AppServices => {
  const services = backend(routes, calls)
  return {
    ...services,
    applicationIdentity: applicationIdentityFromFetch(services.fetchImpl!, "https://app.test"),
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: "redirect", sandbox: null,
      capabilities: cloudCapabilities({ identity: true, cloud: true, agent: false, checkout: false, terminal: false }) }
  }
}

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
  // The suggestion reads the host's verified registration for the signed-in
  // account (#2536): a saved card, even another account's enabled CI, is not will's.
  const verified = initialSetup("will/flows", "ci", "will")
  const registration = (job: string): SetupRecoveryResponse["registration"] => scenario.enabled && scenario.owner === "will" && job === "ci"
    ? { state: "known", active: { registrationId: "test", workspaceId: "de29f26b-e593-4ec2-99fc-583d4711f20a", revision: verified.revision,
      digest: setupCandidate(verified), sourceRevision: "test", enabled: true, owned: true, draft: verified.draft } }
    : { state: "known" }
  const { store, controller } = await issuesController(backend({
    "GET /api/repository-setup/state": request => {
      const job = new URL(request.url).searchParams.get("job") ?? ""
      const body: SetupRecoveryResponse = { owner: "will", repo: "will/flows", job: job as SetupRecoveryResponse["job"], registration: registration(job), setup: { state: "none" } }
      return json(200, body)
    },
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
    await waitFor(() => [...store.collections.repositoryJobObservations.values()].some(row => row.job === "ci" && row.state === "completed"))
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

  test("native 200 and optional GitHub 401 keep authorized rows and source-specific refusal", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(selectedUserBackend({
      "GET /api/repos/will/flows/issues": json(200, [wireIssue(7)]),
      "GET /api/user/github-repos/will/flows/issues": json(401, { message: "GitHub connection required" }),
      "GET /api/user": json(200, { id: 1, username: "will", is_admin: false })
    }, calls))
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.status).toBe("active")
    expect(card.payload.issues.map(issue => [issue.number, issue.source])).toEqual([[7, "smithers-cloud"]])
    expect(card.payload.github).toMatchObject({ source: "refused", refusal: "GitHub connection required" })
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in")).toHaveLength(0)
    expect(calls.filter(call => call.includes("/issues?"))).toEqual([
      "GET /api/repos/will/flows/issues?state=open",
      "GET /api/user/github-repos/will/flows/issues?state=open"
    ])
  })

  test("a native 401 refuses the list before reading GitHub or publishing stale rows", async () => {
    const calls: string[] = []
    let authorized = true
    const { store, controller } = await issuesController(selectedUserBackend({
      "GET /api/repos/will/flows/issues": () => authorized
        ? json(200, [wireIssue(7)])
        : json(401, { message: "Native session expired" }),
      "GET /api/user/github-repos/will/flows/issues": json(200, [wireGithubIssue(12)]),
      "GET /api/user": json(200, { id: 1, username: "will", is_admin: false })
    }, calls))
    expect((await controller.commands.run("issues.list")).status).toBe("executed")
    await settled()
    authorized = false
    invalidatePreparedViews(store)
    const result = await controller.commands.run("issues.list")
    await settled()
    expect(result.status).toBe("executed")
    expect([...store.collections.messages.values()].some(message => message.action?.flow === "auth.sign-in")).toBe(true)
    expect(calls.filter(call => call.startsWith("GET /api/user/github-repos/"))).toHaveLength(1)
    const card = store.collections.cards.get("issues-will/flows")
    expect(card?.kind === "issue-list" && card.status === "active" && card.payload.issues.length > 0).toBe(false)
  })

  test("conversation-only reads native rows without calling GitHub", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(selectedUserBackend({
      "GET /api/repos/will/flows/issues": json(200, [wireIssue(7, { kind: "chat" })]),
      "GET /api/user/github-repos/will/flows/issues": json(401, { message: "GitHub connection required" }),
      "GET /api/user": json(200, { id: 1, username: "will", is_admin: false })
    }, calls))
    const outcome = await controller.commands.run("issues.list", "open --kind conversation will/flows")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.payload.issues.map(issue => issue.source)).toEqual(["smithers-cloud"])
    expect(card.payload.github).toBeUndefined()
    expect(calls).toContain("GET /api/repos/will/flows/issues?state=open&kind=chat")
    expect(calls.some(call => call.startsWith("GET /api/user/github-repos/"))).toBe(false)
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
      detail: "Refresh failed: Loading issue #7 in will/flows failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed.",
      action: { label: "Retry", flow: "issues.view", args: "7 will/flows" }
    })
    expect(store.collections.toasts.get("toast-issue.comment.refresh:will/flows:7")?.detail).not.toContain("Detail unavailable")
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
      detail: "Commenting on issue #7 in will/flows failed (500). That's a bug in Smithers, not something you did."
    })
    expect(store.collections.toasts.get("toast-command.failed.issues.comment")?.detail).not.toContain("Write refused")
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
      detail: "No response from issue #7 in will/flows."
    })
    /* The thrown text is diagnostics, never copy. */
    expect(JSON.stringify([...store.collections.toasts.values()])).not.toContain("connection reset")
    expect([...store.collections.toasts.values()].some(toast => toast.title.includes("didn't run"))).toBe(false)
    expect(calls.filter(call => call.includes("/issues/7"))).toEqual(["POST /api/repos/will/flows/issues/7/comments"])
  })

})

describe("issues seam — honest failures, never throws", () => {
  test("a 500 answers what failed and whose fault it was, never the backend's words, as a failed outcome and keeps the failed view visible", async () => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues": json(500, { message: "the platform exploded" })
      })
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Listing issues for will/flows failed (500). That's a bug in Smithers, not something you did.")
      expect(outcome.error).not.toContain("the platform exploded")
    }
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
      expect(outcome.error).toContain("Could not reach the backend to load issue #7 in will/flows.")
      /* The thrown text stays in the fetch tap, never in the answer. */
      expect(outcome.error).not.toContain("socket hangup")
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
  test("Fix picker does not offer source issues when the imported tracker 404s", async () => {
    const calls: string[] = []
    const http = async (url: string): Promise<Response> => {
      calls.push(url)
      return json(404, { message: "repository not found" })
    }
    expect(await readIssueOptions({ http, baseUrl: "https://app.test" }, "will/flows")).toEqual({
      options: [],
      error: "Import will/flows to fix an issue: /repos.import will/flows"
    })
    expect(calls).toEqual(["https://app.test/api/repos/will/flows/issues?state=open"])
  })

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
      expect(outcome.error).toContain("Issue #7 in will/flows was not found.")
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

  test("a 404 carrying a Worker code answers the act's own sentence and the verdict, not the Worker's words", async () => {
    const { controller } = await issuesController(backend({
      "PATCH /api/repos/will/flows/issues/7": json(404, { status: "error", code: "route_not_found", message: "Not found." })
    }))
    const outcome = await controller.commands.run("issues.close", "7")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Could not close issue #7 in will/flows (404). There's nothing at that address.")
      expect(outcome.error).not.toContain("Not found.")
    }
  })

  /* The one cause local state does name: a checkout the sidebar pins that Cloud has never taken. */


  test("closing a missing number in a loaded repository answers the number, not the import", async () => {
    const calls: string[] = []
    const { controller } = await issuesController(backend({
      "GET /api/repos/will/flows/issues": json(200, [wireIssue(7)]),
      "PATCH /api/repos/will/flows/issues/999": json(404, ISSUE_NOT_FOUND)
    }, calls))
    // The state the defect needed: the open checkout is pinned, and its issues list came back imported.
    expect((await controller.commands.run("issues.list", "")).status).toBe("executed")
    const outcome = await controller.commands.run("issues.close", "999")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Issue #999 in will/flows was not found")
    expect(calls.filter((call) => call.startsWith("PATCH"))).toEqual(["PATCH /api/repos/will/flows/issues/999"])
  })

  test("creating an issue in a loaded repository the platform 404s names the repository, not the import", async () => {
    const { controller } = await issuesController(backend({
      "POST /api/repos/will/flows/issues": json(404, REPOSITORY_NOT_FOUND)
    }))
    const outcome = await controller.commands.run("issues.create", "A brand new idea")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("will/flows was not found")
  })

  test("a number-scoped 404 answers the number", async () => {
    const { controller } = await issuesController(backend({
      "PATCH /api/repos/will/flows/issues/999": json(404, ISSUE_NOT_FOUND)
    }))
    const outcome = await controller.commands.run("issues.close", "999")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Issue #999 in will/flows was not found")
  })

  test("a 404 with a Worker code answers the act's own sentence and the verdict", async () => {
    const { controller } = await issuesController(backend({
      "POST /api/repos/will/flows/issues": json(404, { status: "error", code: "route_not_found", message: "Not found." })
    }))
    const outcome = await controller.commands.run("issues.create", "A brand new idea")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Creating the issue in will/flows failed (404). There's nothing at that address.")
      expect(outcome.error).not.toContain("Not found.")
    }
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

test("a Smithers reply with trailing whitespace posts once and never PATCHes the stored, trimmed comment", async () => {
  // The backend stores strings.TrimSpace(body) (issue.go). The reply guard must compare what the server keeps.
  const comments: Array<Record<string, unknown>> = [{ ...wireComment(41, "hello"), idempotency_key: "message-t1-user" }]
  const posts: string[] = []
  const patches: string[] = []
  const { store, controller } = await issuesController(backend({
    "GET /api/repos/will/flows/issues/8": () => json(200, wireIssue(8, { kind: "chat", visibility: "private" })),
    "GET /api/repos/will/flows/issues/8/comments": () => json(200, comments),
    "POST /api/repos/will/flows/issues/8/comments": async request => {
      const body = await request.json() as { body: string; idempotency_key: string }
      posts.push(body.body)
      const row = { ...wireComment(42, body.body.trim()), idempotency_key: body.idempotency_key }
      comments.push(row)
      return json(201, row)
    },
    "PATCH /api/repos/will/flows/issues/comments/42": async request => {
      const body = await request.json() as { body: string }
      patches.push(body.body)
      comments[1]!.body = body.body.trim()
      return json(200, comments[1])
    }
  }))
  try {
    await controller.commands.run("issues.view", "8 will/flows")
    const card = [...store.collections.cards.values()].find(row => row.kind === "issue")!
    if (card.kind !== "issue") throw Error("Wrong card")
    await store.dispatch({ type: "card.view.loaded", actor: "system", card: { ...card, payload: { ...card.payload,
      conversation: { branchId: store.session().activeBranchId!, owner: "will", creationKey: "reply-binding" }
    } } }).isPersisted.promise
    await store.dispatch({ type: "message.submitted", actor: "user", turnId: "t1", text: "hello" }).isPersisted.promise
    await store.dispatch({ type: "message.response.delta", actor: "smithers", turnId: "t1", channel: "text", delta: "On it.\n" }).isPersisted.promise
    await store.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "t1" }).isPersisted.promise
    for (let i = 0; i < 50 && posts.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(posts).toEqual(["On it."])
    expect(patches).toEqual([])
    const saved = (store.collections.cards.get(card.id) as typeof card).payload
    expect(saved.pendingComments).toEqual([])
    expect(saved.comments.map(row => row.commentBody)).toEqual(["hello", "On it."])
  } finally { await controller.dispose(); await store.dispose?.() }
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
    expect(pending).toMatchObject({ status: "failed", error: "Posting the message failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed." })
    expect(pending.error).not.toContain("Try again")
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
    expect(store.collections.toasts.get(toast.id)).toMatchObject({ status: "failed", detail: "Delivery unconfirmed. Resolve to continue." })
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

test("owner resolution persists and returns before the receipt, deduplicates and exposes failure", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const receipts: unknown[] = []
  const { store, controller } = await issuesController(backend({
    "GET /api/repos/will/flows/issues/8": () => json(200, wireIssue(8, { kind: "chat", visibility: "private" })),
    "GET /api/repos/will/flows/issues/8/comments": () => json(200, []),
    "GET /api/repos/will/flows/issues/8/sync": () => json(200, { provider: "telegram", connection_id: "bot", scope_id: "123", conversation_id: "-100", state: "outcome_unknown", delivery_id: 41, resolution_token: "claim" }),
    "PUT /api/repos/will/flows/issues/sync/deliveries/41": async request => { receipts.push(await request.json()); await held; return json(503, { message: "offline" }) }
  }))
  try {
    await signedIn(store)
    await controller.commands.run("issues.view", "8 will/flows")
    const card = [...store.collections.cards.values()].find(row => row.kind === "issue")!
    expect(await controller.resolveIssueSync(card.id, 41, "retry", "Accept duplicate risk", "")).toBe("Resolution requested.")
    expect(await controller.resolveIssueSync(card.id, 41, "retry", "Accept duplicate risk", "")).toBe("Resolution requested.")
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(receipts).toEqual([{ resolution: "retry", expected_token: "claim", state: "pending", error: "Accept duplicate risk", message_id: "" }])
    const persisted = store.collections.cards.get(card.id)!
    expect(persisted.kind === "issue" && persisted.payload.sync?.resolution?.status).toBe("requested")
    const toast = [...store.collections.toasts.values()].find(row => row.key === `issue.resolve:${card.id}`)!
    expect(toast.status).toBe("running")
    release()
    await new Promise(resolve => setTimeout(resolve, 100))
    const failed = store.collections.cards.get(card.id)!
    expect(failed.kind === "issue" && failed.payload.sync?.resolution?.status).toBe("failed")
    expect(store.collections.toasts.get(toast.id)?.status).toBe("failed")
  } finally { release(); await controller.dispose(); await store.dispose?.() }
})

// Public helper units use exactly their declared HTTP/base URL authority, not a
// fabricated controller context or partial AppStore.
const issueReadContext = (routes: Record<string, RouteAnswer>, calls: string[]) => {
  const services = backend(routes, calls)
  if (services.fetchImpl === undefined) throw new Error("Fixture requires its owned HTTP boundary")
  return { baseUrl: "https://app.test", http: services.fetchImpl } satisfies Pick<SeamContext, "http" | "baseUrl">
}

describe("issue picker options through the public read boundary", () => {
  test("native issue options retain source order and lenient rows, omit conversations, and encode repository segments", async () => {
    const calls: string[] = []
    const ctx = issueReadContext({
      "GET /api/repos/team%20space/project%20%E2%98%83/issues": json(200, [
        wireIssue(7, { title: "Repair the native flake" }), wireIssue(8, { kind: "chat" }), null, "not a row", { number: "9" }, { number: 10 }
      ])
    }, calls)
    expect(await readIssueOptions(ctx, "team space/project ☃")).toEqual({ options: [
      { value: "7", label: "#7 Repair the native flake" }, { value: "10", label: "#10 " }
    ] })
    expect(calls).toEqual(["GET /api/repos/team%20space/project%20%E2%98%83/issues?state=open"])
  })

  test("native 404 answers the import door without reading GitHub source issues, and lists once imported", async () => {
    let imported = false
    const calls: string[] = []
    const ctx = issueReadContext({
      "GET /api/repos/will/flows/issues": () => imported ? json(200, [wireIssue(7, { title: "Imported bug" })]) : json(404, { message: "repository not imported" }),
      "GET /api/user/github-repos/will/flows/issues": json(200, [wireGithubIssue(12, { title: "Source bug" })])
    }, calls)
    expect(await readIssueOptions(ctx, "will/flows")).toEqual({ options: [], error: "Import will/flows to fix an issue: /repos.import will/flows" })
    expect(calls).toEqual(["GET /api/repos/will/flows/issues?state=open"])
    imported = true
    expect(await readIssueOptions(ctx, "will/flows")).toEqual({ options: [{ value: "7", label: "#7 Imported bug" }] })
    expect(calls).toEqual(["GET /api/repos/will/flows/issues?state=open", "GET /api/repos/will/flows/issues?state=open"])
  })

  test("native 403 returns its refusal without changing trackers, then the same read recovers", async () => {
    let refused = true
    const calls: string[] = []
    const ctx = issueReadContext({ "GET /api/repos/will/flows/issues": () => refused
      ? json(403, { message: "Issue access denied" }) : json(200, [wireIssue(7, { title: "Accessible again" })]) }, calls)
    expect(await readIssueOptions(ctx, "will/flows")).toEqual({ options: [], error: "Issue access denied" })
    expect(calls).toEqual(["GET /api/repos/will/flows/issues?state=open"])
    refused = false
    expect(await readIssueOptions(ctx, "will/flows")).toEqual({ options: [{ value: "7", label: "#7 Accessible again" }] })
    expect(calls).toEqual(["GET /api/repos/will/flows/issues?state=open", "GET /api/repos/will/flows/issues?state=open"])
  })

  test.each(["syntax", "null"] as const)("native %s payload is unreadable, not empty options or a fallback", async malformed => {
    let bad = true
    const calls: string[] = []
    const ctx = issueReadContext({ "GET /api/repos/will/flows/issues": () => bad
      ? malformed === "syntax" ? new Response("{not-json", { headers: { "content-type": "application/json" } }) : json(200, null)
      : json(200, []) }, calls)
    expect(await readIssueOptions(ctx, "will/flows")).toEqual({ options: [], error: "The backend answered issues for will/flows with an unreadable payload" })
    expect(calls).toEqual(["GET /api/repos/will/flows/issues?state=open"])
    bad = false
    expect(await readIssueOptions(ctx, "will/flows")).toEqual({ options: [] })
    expect(calls).toEqual(["GET /api/repos/will/flows/issues?state=open", "GET /api/repos/will/flows/issues?state=open"])
  })

  test("a rejected native options transport reports the connection and retries only that read", async () => {
    let disconnected = true
    const calls: string[] = []
    const ctx = issueReadContext({ "GET /api/repos/will/flows/issues": () => {
      if (disconnected) throw new TypeError("disconnected")
      return json(200, [])
    } }, calls)
    expect(await readIssueOptions(ctx, "will/flows")).toEqual({ options: [], error:
      "Could not reach the backend to list issues for will/flows. Nothing answered at all — that's the connection, not something you did. Try it again." })
    disconnected = false
    expect(await readIssueOptions(ctx, "will/flows")).toEqual({ options: [] })
    expect(calls).toEqual(["GET /api/repos/will/flows/issues?state=open", "GET /api/repos/will/flows/issues?state=open"])
  })
})

describe("coding-flow issue payload public read", () => {
  test("returns literal forge and task facts without fetching comments or publishing a card", async () => {
    const calls: string[] = []
    const ctx = issueReadContext({ "GET /api/repos/will/flows/issues/7": json(200, wireIssue(7, {
      title: "Fix with tests", body: "Keep the guard.", state: "fixed", visibility: "public",
      author: { login: "ana", avatar_url: "https://avatars.test/ana" },
      assignees: [{ login: "engineer", avatar_url: "https://avatars.test/engineer" }, null],
      labels: [{ name: "bug", color: "ff0000" }, null], fixed_by: { username: "engineer" }, verified_by: "reviewer"
    })) }, calls)
    expect(await fetchIssuePayload(ctx, "will/flows", 7)).toEqual({
      repo: "will/flows", number: 7, title: "Fix with tests", state: "fixed", author: "ana", createdAt: "2026-08-10T09:00:00Z",
      assignees: [{ login: "engineer", avatar: "https://avatars.test/engineer" }], labelColors: { bug: "ff0000" }, authorAvatar: "https://avatars.test/ana",
      visibility: "public", issueBody: "Keep the guard.", labels: ["bug"], comments: [],
      task: { fixedBy: { id: "engineer", name: "engineer" }, verifiedBy: { id: "reviewer", name: "reviewer" } }
    })
    expect(calls).toEqual(["GET /api/repos/will/flows/issues/7"])
  })

  test("a route_not_found 404 on an issue read is the failed load and its verdict, never a missing issue", async () => {
    const ctx = issueReadContext({ "GET /api/repos/will/flows/issues/7": json(404, { status: "error", code: "route_not_found", message: "Not found." }) }, [])
    expect(await fetchIssuePayload(ctx, "will/flows", 7)).toBe("Loading issue #7 in will/flows failed (404). There's nothing at that address.")
  })

  test("404 names the explicit GitHub read door without silently reading another tracker", async () => {
    const calls: string[] = []
    const ctx = issueReadContext({ "GET /api/repos/will/flows/issues/7": json(404, { message: "not found" }) }, calls)
    expect(await fetchIssuePayload(ctx, "will/flows", 7)).toBe("Issue #7 in will/flows was not found. For a GitHub issue, use /issues.view 7 will/flows --source github.")
    expect(calls).toEqual(["GET /api/repos/will/flows/issues/7"])
  })

  test("503 keeps the server sentence and a subsequent payload read recovers", async () => {
    let unavailable = true
    const calls: string[] = []
    const ctx = issueReadContext({ "GET /api/repos/will/flows/issues/7": () => unavailable
      ? json(503, { message: "Tracker is restarting" }) : json(200, { number: 7, title: "Back online" }) }, calls)
    expect(await fetchIssuePayload(ctx, "will/flows", 7)).toBe("Loading issue #7 in will/flows failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed.")
    unavailable = false
    expect(await fetchIssuePayload(ctx, "will/flows", 7)).toEqual({ repo: "will/flows", number: 7, title: "Back online", state: "open",
      author: null, issueBody: "", labels: [], comments: [] })
    expect(calls).toEqual(["GET /api/repos/will/flows/issues/7", "GET /api/repos/will/flows/issues/7"])
  })

  test.each(["syntax", "null"] as const)("%s detail refuses unreadable payload rather than inventing an empty issue", async malformed => {
    let bad = true
    const calls: string[] = []
    const ctx = issueReadContext({ "GET /api/repos/will/flows/issues/7": () => bad
      ? malformed === "syntax" ? new Response("{not-json", { headers: { "content-type": "application/json" } }) : json(200, null)
      : json(200, { title: "Valid minimal record" }) }, calls)
    expect(await fetchIssuePayload(ctx, "will/flows", 7)).toBe("The backend answered issue #7 in will/flows with an unreadable payload")
    bad = false
    expect(await fetchIssuePayload(ctx, "will/flows", 7)).toEqual({ repo: "will/flows", number: 7, title: "Valid minimal record", state: "open",
      author: null, issueBody: "", labels: [], comments: [] })
    expect(calls).toEqual(["GET /api/repos/will/flows/issues/7", "GET /api/repos/will/flows/issues/7"])
  })

  test("transport rejection has a literal connection refusal and supports a fresh read", async () => {
    let disconnected = true
    const calls: string[] = []
    const ctx = issueReadContext({ "GET /api/repos/will/flows/issues/7": () => {
      if (disconnected) throw new TypeError("disconnected")
      return json(200, { number: 7 })
    } }, calls)
    expect(await fetchIssuePayload(ctx, "will/flows", 7)).toBe("Could not reach the backend to load issue #7 in will/flows. Nothing answered at all — that's the connection, not something you did. Try it again.")
    disconnected = false
    expect(await fetchIssuePayload(ctx, "will/flows", 7)).toEqual({ repo: "will/flows", number: 7, title: "", state: "open", author: null, issueBody: "", labels: [], comments: [] })
    expect(calls).toEqual(["GET /api/repos/will/flows/issues/7", "GET /api/repos/will/flows/issues/7"])
  })
})

describe("comment pagination failures preserve honest view state", () => {
  test("a repeated opaque cursor refuses partial success, keeps requests scoped, and a fresh full read recovers", async () => {
    let repeated = true
    const calls: string[] = []
    const { store, controller } = await issuesController(backend({
      "GET /api/repos/will/flows/issues/7": json(200, wireIssue(7)),
      "GET /api/repos/will/flows/issues/7/comments": request => repeated
        ? new Response(JSON.stringify([wireComment(new URL(request.url).searchParams.has("cursor") ? 32 : 31, "partial")]), {
          headers: { "content-type": "application/json", link: '<https://untrusted.invalid/wrong?cursor=opaque%2F%2B%20%E2%98%83>; rel="next"' }
        }) : json(200, [wireComment(41, "Complete conversation")])
    }, calls))
    calls.length = 0
    const refused = await controller.commands.run("issues.view", "7 will/flows")
    expect(refused.status).toBe("failed")
    if (refused.status !== "failed") throw new Error("Repeated cursor must refuse")
    expect(refused.error).toBe("Comments for #7 did not finish loading.")
    const failed = cardOfKind(store, "issue-will/flows-7", "status")
    expect(failed).toMatchObject({ status: "error", loading: false, body: "Comments for #7 did not finish loading." })
    expect([...store.collections.cards.values()].filter(card => card.kind === "issue")).toHaveLength(0)
    expect(calls).toEqual(["GET /api/repos/will/flows/issues/7", "GET /api/repos/will/flows/issues/7/comments",
      "GET /api/repos/will/flows/issues/7/comments?cursor=opaque%2F%2B%20%E2%98%83"])
    repeated = false
    expect((await controller.commands.run("issues.view", "7 will/flows")).status).toBe("executed")
    await settled()
    const recovered = cardOfKind(store, failed.id, "issue")
    expect(recovered).toMatchObject({ status: "active", loading: false })
    expect(recovered.payload.comments).toEqual([{ id: 41, author: "bob", commentBody: "Complete conversation", createdAt: "2026-08-11T10:00:00Z" }])
    expect(calls).toEqual(["GET /api/repos/will/flows/issues/7", "GET /api/repos/will/flows/issues/7/comments",
      "GET /api/repos/will/flows/issues/7/comments?cursor=opaque%2F%2B%20%E2%98%83", "GET /api/repos/will/flows/issues/7", "GET /api/repos/will/flows/issues/7/comments"])
  })

  test("malformed comments after valid detail cannot publish an issue with invented empty comments and retry recovers", async () => {
    let malformed = true
    const calls: string[] = []
    const { store, controller } = await issuesController(backend({
      "GET /api/repos/will/flows/issues/7": json(200, wireIssue(7, { title: "Read the complete discussion" })),
      "GET /api/repos/will/flows/issues/7/comments": () => json(200, malformed ? { comments: [] } : [wireComment(31, "Recovered discussion")])
    }, calls))
    calls.length = 0
    const refused = await controller.commands.run("issues.view", "7 will/flows")
    expect(refused.status).toBe("failed")
    if (refused.status !== "failed") throw new Error("Malformed comments must refuse")
    expect(refused.error).toBe("The backend answered comments for #7 with an unreadable payload")
    const failed = cardOfKind(store, "issue-will/flows-7", "status")
    expect(failed).toMatchObject({ status: "error", loading: false, body: "The backend answered comments for #7 with an unreadable payload" })
    expect([...store.collections.cards.values()].filter(card => card.kind === "issue")).toHaveLength(0)
    expect(calls).toEqual(["GET /api/repos/will/flows/issues/7", "GET /api/repos/will/flows/issues/7/comments"])
    malformed = false
    expect((await controller.commands.run("issues.view", "7 will/flows")).status).toBe("executed")
    await settled()
    const recovered = cardOfKind(store, failed.id, "issue")
    expect(recovered).toMatchObject({ status: "active", loading: false, payload: { title: "Read the complete discussion" } })
    expect(recovered.payload.comments).toEqual([{ id: 31, author: "bob", commentBody: "Recovered discussion", createdAt: "2026-08-11T10:00:00Z" }])
    expect(calls).toEqual(["GET /api/repos/will/flows/issues/7", "GET /api/repos/will/flows/issues/7/comments",
      "GET /api/repos/will/flows/issues/7", "GET /api/repos/will/flows/issues/7/comments"])
  })
})
