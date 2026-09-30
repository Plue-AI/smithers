import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { createLandingsSeam, readLandingOptions } from "./LandingsSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The landings seam through the real command path: controller.commands.run
 * drives prs.* exactly as buttons and slash do, the stubbed backend answers
 * the platform shapes (multi src/smithersCloud/landings.ts), and the
 * transcript cards state the truth. Landing QUEUES — the card state after a
 * land reads "queued", never a terminal claim.
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

const backend = (
  routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>
): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    for (const [route, answer] of Object.entries(routes)) {
      if (path === route || path.startsWith(`${route}?`)) {
        return typeof answer === "function"
          ? answer(new Request(absolute.toString(), init))
          : answer.clone()
      }
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const signedIn = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const reposChosen = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
  })
  await settled()
}

/** A signed-in controller watching exactly will/flows, over the given backend. */
const ready = async (services: AppServices) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, services)
  await signedIn(store)
  await reposChosen(store)
  return { store, controller }
}

/* ---- platform payload builders (the wire shapes multi's parsers accept) ---- */

const landing = (number: number, state: string) => ({
  number,
  title: `Wire the seam ${number}`,
  body: "The **stack** description.",
  state,
  author: { id: 7, login: "will" },
  change_ids: ["chg-a", "chg-b"],
  target_bookmark: "main",
  conflict_status: "clean",
  stack_size: 2,
  created_at: "2026-08-10T10:00:00.000Z",
  updated_at: "2026-08-11T10:00:00.000Z"
})

const reviewRow = (id: number, type: string, body: string) => ({
  id,
  landing_request_id: 3,
  reviewer_id: 9,
  type,
  body,
  state: "submitted",
  created_at: "2026-08-11T11:00:00.000Z",
  updated_at: "2026-08-11T11:00:00.000Z"
})

const statusRow = (id: number, context: string, status: string, createdAt: string) => ({
  id,
  repository_id: 1,
  change_id: "chg-b",
  commit_sha: null,
  context,
  status,
  description: "",
  target_url: "",
  workflow_run_id: null,
  created_at: createdAt,
  updated_at: createdAt
})

const LANDINGS = "/api/repos/will/flows/landings"
const STATUSES = "/api/repos/will/flows/commits/chg-b/statuses"

describe("landings seam — prs.list", () => {
  test.each(["run", "runForAgent"] as const)("surfaces the pr-list card from the platform answer, skipping malformed rows (%s)", async (door) => {
    const { store, controller } = await ready(
      backend({
        [LANDINGS]: json(200, [landing(3, "open"), { nonsense: true }, landing(4, "queued")])
      })
    )
    const outcome = await controller.commands[door]("prs.list")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toBe(
      "Pull requests · will/flows\n#3 Wire the seam 3 · open\n#4 Wire the seam 4 · queued"
    )
    await settled()
    const card = store.collections.cards.get("prs-will/flows")
    if (card === undefined || card.kind !== "pr-list") throw new Error("expected the pr-list card")
    expect(card.title).toBe("Pull requests · will/flows")
    expect(card.status).toBe("active")
    expect(card.payload.repo).toBe("will/flows")
    expect(card.payload.landings).toEqual([
      {
        number: 3,
        title: "Wire the seam 3",
        state: "open",
        author: "will",
        updatedAt: "2026-08-11T10:00:00.000Z"
      },
      {
        number: 4,
        title: "Wire the seam 4",
        state: "queued",
        author: "will",
        updatedAt: "2026-08-11T10:00:00.000Z"
      }
    ])
  })

  test("the agent receives an explicit empty PR list", async () => {
    const { controller } = await ready(backend({ [LANDINGS]: json(200, []) }))
    const outcome = await controller.commands.runForAgent("prs.list")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toBe("No pull requests in will/flows.")
  })

  test("a 500 answers what failed and whose fault it was, never the platform's words, and keeps the failed view visible", async () => {
    const { store, controller } = await ready(
      backend({ [LANDINGS]: json(500, { message: "the platform fell over" }) })
    )
    const outcome = await controller.commands.run("prs.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Pull requests for will/flows couldn't be listed. That's a bug in Smithers, not something you did.")
      expect(outcome.error).not.toContain("the platform fell over")
    }
    expect(store.collections.cards.get("prs-will/flows")).toMatchObject({ status: "error", loading: false })
  })

  test("with no loaded repository the answer is the missing-repository form", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableAgent,
      backend({})
    )
    await signedIn(store)
    /* THE FORM LAW: the missing repository is asked for, never guessed (tutorial stage 3). */
    const outcome = await controller.commands.run("prs.list")
    expect(outcome.status).toBe("executed")
    const form = store.collections.cards.get("form-prs.list")
    expect(form?.kind).toBe("flow-form")
    if (form?.kind === "flow-form") expect(form.payload.fields.map(field => field.name)).toContain("repo")
  })
})

describe("landings seam — prs.view", () => {
  test.each(["run", "runForAgent"] as const)("surfaces the pr card with body, reviews, and newest-per-context checks (%s)", async (door) => {
    const { store, controller } = await ready(
      backend({
        [`${LANDINGS}/3`]: json(200, landing(3, "open")),
        [`${LANDINGS}/3/reviews`]: json(200, [reviewRow(1, "approve", "Ship it")]),
        [STATUSES]: json(200, [
          // created_at DESC with a context repeated across re-runs: the
          // NEWEST ci/test row (success) must win over the older pending.
          statusRow(2, "ci/test", "success", "2026-08-11T12:00:00.000Z"),
          statusRow(3, "ci/lint", "failure", "2026-08-11T12:00:00.000Z"),
          statusRow(1, "ci/test", "pending", "2026-08-11T09:00:00.000Z")
        ])
      })
    )
    // The card-row arg shape: "<number> <owner/repo>" through splitTrailingRepo.
    const outcome = await controller.commands[door]("prs.view", "3 will/flows")
    expect(outcome.status).toBe("executed")
    const value = outcome.status === "executed" ? outcome.value : undefined
    for (const text of ["will/flows", "#3 Wire the seam 3 · open", "will", "The **stack** description.", "approve", "Ship it", "ci/test · success", "ci/lint · failure"]) {
      expect(value).toContain(text)
    }
    expect(value).not.toContain("pending")
    await settled()
    const card = store.collections.cards.get("pr-will/flows-3")
    if (card === undefined || card.kind !== "pr") throw new Error("expected the pr card")
    expect(card.title).toBe("#3 Wire the seam 3 · will/flows")
    expect(card.payload).toEqual({
      repo: "will/flows",
      number: 3,
      title: "Wire the seam 3",
      state: "open",
      author: "will",
      prBody: "The **stack** description.",
      reviews: [{ author: null, type: "approve", reviewBody: "Ship it" }],
      checks: [
        { context: "ci/test", state: "success" },
        { context: "ci/lint", state: "failure" }
      ],
      baseBranch: "main",
      createdAt: "2026-08-10T10:00:00.000Z",
      readErrors: {
        commits: "Commits unavailable (no stub for /api/repos/will/flows/landings/3/changes?limit=20)",
        files: "Files unavailable (no stub for /api/repos/will/flows/landings/3/diff)"
      }
    })
  })

  test("reads the stack for the Commits and Files tabs: commits bottom → top, files merged by path, a patch only for a file one change touched", async () => {
    const change = (id: string, sha: string, description: string) => ({ change_id: id, commit_id: sha, description, author_name: "Will", timestamp: "2026-08-10T10:00:00.000Z" })
    const fileDiff = (path: string, additions: number, deletions: number, patch: string) => ({ path, change_type: "modified", additions, deletions, patch })
    const { store, controller } = await ready(
      backend({
        [`${LANDINGS}/3`]: json(200, landing(3, "open")),
        [`${LANDINGS}/3/reviews`]: json(200, []),
        [STATUSES]: json(200, []),
        [`${LANDINGS}/3/changes`]: json(200, [change("chg-a", "aaa111", "Add the logger\n\nbody"), change("chg-b", "bbb222", "Wire it")]),
        [`${LANDINGS}/3/diff`]: json(200, { changes: [
          { change_id: "chg-a", file_diffs: [fileDiff("src/log.ts", 10, 0, "@@ a"), fileDiff("src/server.ts", 2, 1, "@@ b")] },
          { change_id: "chg-b", file_diffs: [fileDiff("src/server.ts", 3, 0, "@@ c")] }
        ] })
      })
    )
    const outcome = await controller.commands.run("prs.view", "3 will/flows")
    expect(outcome.status).toBe("executed")
    const value = outcome.status === "executed" ? outcome.value : undefined
    expect(value).toContain("File: src/server.ts +5 −1")
    await settled()
    const card = store.collections.cards.get("pr-will/flows-3")
    if (card === undefined || card.kind !== "pr") throw new Error("expected the pr card")
    expect(card.payload.commits).toEqual([
      { changeId: "chg-a", commitId: "aaa111", message: "Add the logger\n\nbody", author: "Will", timestamp: "2026-08-10T10:00:00.000Z" },
      { changeId: "chg-b", commitId: "bbb222", message: "Wire it", author: "Will", timestamp: "2026-08-10T10:00:00.000Z" }
    ])
    expect(card.payload.files).toEqual([
      { path: "src/log.ts", status: "modified", additions: 10, deletions: 0, patch: "@@ a" },
      { path: "src/server.ts", status: "modified", additions: 5, deletions: 1 }
    ])
  })

  test("a network throw answers an honest string, never an exception", async () => {
    const { controller } = await ready({
      fetchImpl: async () => {
        throw new Error("socket dropped")
      }
    })
    const outcome = await controller.commands.run("prs.view", "3")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Pull request #3 couldn't be read — the platform didn't answer.")
    }
  })

  test("retry replaces failed section state without retaining another read's stale content", async () => {
    let attempt = 0
    const services = backend({
      [`${LANDINGS}/3`]: json(200, landing(3, "merged")),
      [`${LANDINGS}/3/reviews`]: json(200, []),
      [STATUSES]: json(200, []),
      [`${LANDINGS}/3/changes`]: () => attempt === 0
        ? json(404, { message: "change not found" })
        : json(200, [{ change_id: "chg-a", commit_id: "aaa111", description: "Retained commit", author_name: "Will", timestamp: "2026-08-10T10:00:00.000Z" }]),
      [`${LANDINGS}/3/diff`]: () => {
        attempt += 1
        return attempt === 1
          ? json(503, { message: "repo host unavailable" })
          : json(200, { changes: [{ change_id: "chg-a", file_diffs: [] }] })
      }
    })
    const { store, controller } = await ready(services)
    expect((await controller.commands.run("prs.view", "3 will/flows")).status).toBe("executed")
    await settled()
    let card = store.collections.cards.get("pr-will/flows-3")
    if (card?.kind !== "pr") throw new Error("expected the pr card")
    expect(card.payload.readErrors).toEqual({ commits: "Commits unavailable (change not found)", files: "Files unavailable (Read failed. Something on Smithers' side failed. Not your fault, and nothing your request could have changed.)" })
    expect(card.payload.readErrors?.files).not.toContain("repo host unavailable")
    expect(card.payload.commits).toBeUndefined()
    expect(card.payload.files).toBeUndefined()

    expect((await controller.commands.run("prs.view", "3 will/flows")).status).toBe("executed")
    await settled()
    card = store.collections.cards.get("pr-will/flows-3")
    if (card?.kind !== "pr") throw new Error("expected the pr card")
    expect(card.payload.readErrors).toBeUndefined()
    expect(card.payload.commits?.map(commit => commit.message)).toEqual(["Retained commit"])
    expect(card.payload.files).toEqual([])
  })
})

describe("landings seam — prs.land (queues, never a terminal claim)", () => {
  const TIP_CHANGE = "/api/repos/will/flows/changes/chg-b"
  const tipChange = json(200, { change_id: "chg-b", commit_id: "c0ffee42", description: "tip", parent_change_ids: ["chg-a"] })

  test("PUT …/land names the tip change's commit_id, is accepted (202), and the re-read card states \"queued\"", async () => {
    let landCalls = 0
    let landBody: unknown = null
    const { store, controller } = await ready(
      backend({
        [`${LANDINGS}/3/land`]: async (request) => {
          if (request.method !== "PUT") return json(405, { message: "land is a PUT" })
          landCalls += 1
          landBody = await request.json().catch(() => null)
          return json(202, landing(3, "queued"))
        },
        [`${LANDINGS}/3`]: json(200, landing(3, "queued")),
        [`${LANDINGS}/3/reviews`]: json(200, []),
        [TIP_CHANGE]: tipChange,
        [STATUSES]: json(200, [])
      })
    )
    // prs.land is trigger:"user"; commands.run is the user path.
    const outcome = await controller.commands.run("prs.land", "3")
    expect(outcome.status).toBe("executed")
    expect(landCalls).toBe(1)
    /* plue's LandLandingRequestInput requires commit_id: the tip change's current commit, read right before the PUT. */
    expect(landBody).toEqual({ commit_id: "c0ffee42" })
    await settled()
    const card = store.collections.cards.get("pr-will/flows-3")
    if (card === undefined || card.kind !== "pr") throw new Error("expected the pr card")
    expect(card.payload.state).toBe("queued")
  })

  test("even when the re-read fails the land stays a success and the card says \"queued\"", async () => {
    let landingReads = 0
    const { store, controller } = await ready(
      backend({
        [`${LANDINGS}/3/land`]: (request) => request.method === "PUT" ? json(202, landing(3, "queued")) : json(405, {}),
        /* The pre-land read answers; the re-read after the PUT explodes. */
        [`${LANDINGS}/3`]: () => {
          landingReads += 1
          return landingReads === 1 ? json(200, landing(3, "open")) : json(500, { message: "re-read exploded" })
        },
        [TIP_CHANGE]: tipChange
      })
    )
    const outcome = await controller.commands.run("prs.land", "3")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = store.collections.cards.get("pr-will/flows-3")
    if (card === undefined || card.kind !== "pr") throw new Error("expected the pr card")
    expect(card.payload.state).toBe("queued")
    expect(card.payload.title).toBe("Wire the seam 3")
  })

  test("a rejected land (409) answers the platform's honest message", async () => {
    const { controller } = await ready(
      backend({
        [`${LANDINGS}/3`]: json(200, landing(3, "open")),
        [TIP_CHANGE]: tipChange,
        [`${LANDINGS}/3/land`]: json(409, { message: "already queued" })
      })
    )
    const outcome = await controller.commands.run("prs.land", "3")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("already queued")
  })

  test("a land whose tip commit can't be read PUTs nothing and says so", async () => {
    let landCalls = 0
    const { controller } = await ready(
      backend({
        [`${LANDINGS}/3`]: json(200, landing(3, "open")),
        [TIP_CHANGE]: json(500, { message: "repo host down" }),
        [`${LANDINGS}/3/land`]: () => {
          landCalls += 1
          return json(202, landing(3, "queued"))
        }
      })
    )
    const outcome = await controller.commands.run("prs.land", "3")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("The tip change chg-b of #3 couldn't be read. That's a bug in Smithers, not something you did.")
      expect(outcome.error).not.toContain("repo host down")
    }
    expect(landCalls).toBe(0)
  })
})

describe("landings seam — prs.review", () => {
  const TIP_CHANGE = "/api/repos/will/flows/changes/chg-b"
  const tipChange = json(200, { change_id: "chg-b", commit_id: "c0ffee42" })

  test("posts the verdict and re-reads the card so it states the new truth", async () => {
    const posted: unknown[] = []
    const { store, controller } = await ready(
      backend({
        [`${LANDINGS}/3/reviews`]: async (request) => {
          if (request.method === "POST") {
            posted.push(await request.json())
            return json(201, reviewRow(2, "approve", ""))
          }
          return json(200, [reviewRow(2, "approve", "")])
        },
        [`${LANDINGS}/3`]: json(200, landing(3, "open")),
        [TIP_CHANGE]: tipChange,
        [STATUSES]: json(200, [])
      })
    )
    const outcome = await controller.commands.run("prs.review", "3 approve")
    expect(outcome.status).toBe("executed")
    expect(posted).toEqual([{ type: "approve", body: "", commit_id: "c0ffee42" }])
    await settled()
    const card = store.collections.cards.get("pr-will/flows-3")
    if (card === undefined || card.kind !== "pr") throw new Error("expected the pr card")
    expect(card.payload.reviews).toEqual([{ author: null, type: "approve", reviewBody: "" }])
  })

  test.each(["comment", "request-changes"])("%s pins the reviewed revision", async (type) => {
    const posted: unknown[] = []
    const { controller } = await ready(backend({
      [`${LANDINGS}/3`]: json(200, landing(3, "open")),
      [TIP_CHANGE]: tipChange,
      [`${LANDINGS}/3/reviews`]: async request => {
        if (request.method === "POST") {
          posted.push(await request.json())
          return json(201, reviewRow(2, type, "needs work"))
        }
        return json(200, [])
      },
      [STATUSES]: json(200, [])
    }))
    expect((await controller.commands.run("prs.review", `3 ${type} needs work`)).status).toBe("executed")
    expect(posted).toEqual([{ type: type.replace("-", "_"), body: "needs work", commit_id: "c0ffee42" }])
  })

  test("an unreadable review tip never posts an unpinned review", async () => {
    let posts = 0
    const { controller } = await ready(backend({
      [`${LANDINGS}/3`]: json(200, landing(3, "open")),
      [TIP_CHANGE]: json(503, { message: "tip unavailable" }),
      [`${LANDINGS}/3/reviews`]: () => { posts++; return json(201, {}) }
    }))
    const outcome = await controller.commands.run("prs.review", "3 comment needs work")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("The tip change chg-b of #3 couldn't be read. Something on Smithers' side failed. Not your fault, and nothing your request could have changed.")
      expect(outcome.error).not.toContain("tip unavailable")
    }
    expect(posts).toBe(0)
  })

  test("request-changes without text answers honestly before touching the wire", async () => {
    let touched = 0
    const { controller } = await ready({
      fetchImpl: async () => {
        touched += 1
        return json(404, { message: "should not be reached" })
      }
    })
    const before = touched
    const outcome = await controller.commands.run("prs.review", "3 request-changes")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("A request-changes review needs text: /prs.review 3 request-changes <why>")
    }
    expect(touched).toBe(before)
  })

  test("a 422 from the platform round-trips as the honest error", async () => {
    const { controller } = await ready(
      backend({
        [`${LANDINGS}/3`]: json(200, landing(3, "open")),
        [TIP_CHANGE]: tipChange,
        [`${LANDINGS}/3/reviews`]: json(422, { message: "body is required" })
      })
    )
    const outcome = await controller.commands.run("prs.review", "3 comment needs work")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("body is required")
  })
})

/*
 * prs.create assembles plue's required payload the way multi does
 * (landingsStore executeCreate): live bookmarks → source/target tips, repo
 * changes → the parent walk, and the FULL target..source stack as change_ids.
 */
describe("landings seam — prs.create", () => {
  const BOOKMARKS = "/api/repos/will/flows/bookmarks"
  const CHANGES = "/api/repos/will/flows/changes"

  const bookmark = (name: string, changeId: string) => ({
    name,
    target_change_id: changeId,
    target_commit_id: "",
    is_tracking_remote: true
  })

  const change = (id: string, parents: string[]) => ({
    change_id: id,
    commit_id: `sha-${id}`,
    parent_change_ids: parents
  })

  /** main at chg-a; feature-x two changes ahead at chg-c (chg-c → chg-b → chg-a). */
  const bookmarksAnswer = () =>
    json(200, {
      items: [bookmark("landing/one", "chg-l1"), bookmark("main", "chg-a"), bookmark("feature-x", "chg-c")],
      next_cursor: ""
    })

  const changesAnswer = () => json(200, [change("chg-c", ["chg-b"]), change("chg-b", ["chg-a"]), change("chg-a", [])])

  test("POSTs multi's exact payload — full base-first stack — and surfaces the pr card", async () => {
    const posted: unknown[] = []
    const { store, controller } = await ready(
      backend({
        [BOOKMARKS]: bookmarksAnswer(),
        [CHANGES]: changesAnswer(),
        [LANDINGS]: async (request) => {
          if (request.method !== "POST") return json(405, { message: "create is a POST" })
          posted.push(await request.json())
          return json(201, landing(7, "open"))
        },
        [`${LANDINGS}/7`]: json(200, landing(7, "open")),
        [`${LANDINGS}/7/reviews`]: json(200, []),
        [STATUSES]: json(200, [])
      })
    )
    const outcome = await controller.commands.run("prs.create", "Fix the parser from:feature-x")
    expect(outcome.status).toBe("executed")
    expect(posted).toEqual([
      {
        title: "Fix the parser",
        body: "",
        source_bookmark: "feature-x",
        target_bookmark: "main",
        change_ids: ["chg-b", "chg-c"]
      }
    ])
    await settled()
    const card = store.collections.cards.get("pr-will/flows-7")
    if (card === undefined || card.kind !== "pr") throw new Error("expected the pr card")
    expect(card.title).toBe("#7 Wire the seam 7 · will/flows")
    expect(card.payload.number).toBe(7)
    expect(card.payload.state).toBe("open")
  })

  test("without from: the answer is the honest source-branch error, before touching the wire", async () => {
    let touched = 0
    const { controller } = await ready({
      fetchImpl: async () => {
        touched += 1
        return json(404, { message: "should not be reached" })
      }
    })
    const before = touched
    const outcome = await controller.commands.run("prs.create", "Fix the parser")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "prs.create needs a source branch — run /branches.list, then /prs.create <title> from:<bookmark>"
      )
    }
    expect(touched).toBe(before)
  })

  test("an unknown source bookmark answers honestly with the /branches.list pointer", async () => {
    const { controller } = await ready(backend({ [BOOKMARKS]: bookmarksAnswer() }))
    const outcome = await controller.commands.run("prs.create", "Fix the parser from:no-such")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "Bookmark \"no-such\" wasn't found in will/flows — run /branches.list for the choices."
      )
    }
  })

  test("a source already at the target tip refuses honestly — nothing to land", async () => {
    const { controller } = await ready(
      backend({
        [BOOKMARKS]: json(200, {
          items: [bookmark("main", "chg-a"), bookmark("feature-x", "chg-a")],
          next_cursor: ""
        })
      })
    )
    const outcome = await controller.commands.run("prs.create", "Fix the parser from:feature-x")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("No changes over main — commit to feature-x first.")
    }
  })

  test("an underivable stack (merge in the walk) is a hard local refusal — no POST", async () => {
    let posts = 0
    const { controller } = await ready(
      backend({
        [BOOKMARKS]: bookmarksAnswer(),
        // chg-c is a merge: two parents makes the linear walk ambiguous.
        [CHANGES]: json(200, [
          change("chg-c", ["chg-b", "chg-x"]),
          change("chg-b", ["chg-a"]),
          change("chg-a", [])
        ]),
        [LANDINGS]: () => {
          posts += 1
          return json(201, landing(7, "open"))
        }
      })
    )
    const outcome = await controller.commands.run("prs.create", "Fix the parser from:feature-x")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Couldn't derive the branch's change stack.")
    }
    expect(posts).toBe(0)
  })

  test("a rejected create (422) answers the platform's honest message", async () => {
    const { controller } = await ready(
      backend({
        [BOOKMARKS]: bookmarksAnswer(),
        [CHANGES]: changesAnswer(),
        [LANDINGS]: json(422, { message: "target bookmark is protected" })
      })
    )
    const outcome = await controller.commands.run("prs.create", "Fix the parser from:feature-x")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("target bookmark is protected")
  })

  test("a network throw on the POST answers an honest string, never an exception", async () => {
    const { controller } = await ready(
      backend({
        [BOOKMARKS]: bookmarksAnswer(),
        [CHANGES]: changesAnswer(),
        [LANDINGS]: () => {
          throw new Error("socket dropped")
        }
      })
    )
    const outcome = await controller.commands.run("prs.create", "Fix the parser from:feature-x")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("The pull request couldn't be opened — the platform didn't answer.")
    }
  })

  test("a create whose re-read fails still states the created number honestly", async () => {
    const { controller } = await ready(
      backend({
        [BOOKMARKS]: bookmarksAnswer(),
        [CHANGES]: changesAnswer(),
        [LANDINGS]: json(201, landing(7, "open")),
        [`${LANDINGS}/7`]: json(500, { message: "re-read exploded" })
      })
    )
    const outcome = await controller.commands.run("prs.create", "Fix the parser from:feature-x")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Pull request #7 was opened, but couldn't be re-read: Pull request #7 on will/flows couldn't be read. That's a bug in Smithers, not something you did.")
      expect(outcome.error).not.toContain("re-read exploded")
    }
  })
})

test("PR detail bounds the model value while retaining the card body", async () => {
  const body = "large PR body ".repeat(2_000)
  const { store, controller } = await ready(backend({
    [`${LANDINGS}/3`]: json(200, { ...landing(3, "open"), body })
  }))
  const outcome = await controller.commands.runForAgent("prs.view", "3")
  expect(outcome.status).toBe("executed")
  const value = outcome.status === "executed" ? outcome.value : undefined
  expect(value).toContain("#3 Wire the seam 3 · open")
  expect(value).toContain("[truncated]")
  expect(value?.length).toBeLessThanOrEqual(16_000)
  const card = store.collections.cards.get("pr-will/flows-3")
  expect(card?.kind === "pr" ? card.payload.prBody : undefined).toBe(body)
})

describe("Review a PR source selection", () => {
  const cloudRepo = "/api/repos/will/flows"
  const githubPulls = "/api/user/github-repos/upstream/project/pulls"
  const source = { full_name: "will/flows", github_source: { owner: "upstream", repo: "project" } }

  test("the bare form reads GitHub PR choices for a ready import, not same-number Cloud landings", async () => {
    const calls: string[] = []
    const services = backend({
      [cloudRepo]: json(200, source),
      [`${githubPulls}?state=open&per_page=100`]: json(200, [
        { number: 7, title: "Upstream change", state: "open", user: { login: "writer" } },
        { number: 8, title: "Closed change", state: "closed" }
      ]),
      [`${cloudRepo}/landings?limit=100`]: json(200, [landing(7, "open")])
    })
    const options = await readLandingOptions({ baseUrl: "", http: async (url) => {
      calls.push(url)
      return services.fetchImpl!(url)
    } }, "will/flows")
    expect(options).toEqual({ options: [{ value: "7", label: "#7 Upstream change" }] })
    expect(calls).toEqual([cloudRepo, `${githubPulls}?state=open&per_page=100`])
  })

  test("native repositories still read Cloud landings, including an empty list", async () => {
    const calls: string[] = []
    const services = backend({
      [cloudRepo]: json(200, { full_name: "will/flows" }),
      [`${cloudRepo}/landings?limit=100`]: json(200, [])
    })
    const options = await readLandingOptions({ baseUrl: "", http: async (url) => {
      calls.push(url)
      return services.fetchImpl!(url)
    } }, "will/flows")
    expect(options).toEqual({ options: [] })
    expect(calls).toEqual([cloudRepo, `${cloudRepo}/landings?limit=100`])
  })

  test("repository identity accepts casing differences but no different owner", async () => {
    const native = backend({
      [cloudRepo]: json(200, { full_name: "Will/Flows" }),
      [`${cloudRepo}/landings?limit=100`]: json(200, [])
    })
    expect(await readLandingOptions({ baseUrl: "", http: (url) => native.fetchImpl!(url) }, "will/flows"))
      .toEqual({ options: [] })
    const different = backend({ [cloudRepo]: json(200, { full_name: "other/flows" }) })
    const refused = await readLandingOptions({ baseUrl: "", http: (url) => different.fetchImpl!(url) }, "will/flows")
    expect(refused.options).toEqual([])
    expect(refused.error).toContain("different repository")
  })

  test("a GitHub authorization failure never switches to a same-number Cloud PR", async () => {
    const calls: string[] = []
    const services = backend({
      [cloudRepo]: json(200, source),
      [`${githubPulls}?state=open&per_page=100`]: json(403, { message: "GitHub authorization required" }),
      [`${cloudRepo}/landings?limit=100`]: json(200, [landing(7, "open")])
    })
    const options = await readLandingOptions({ baseUrl: "", http: async (url) => {
      calls.push(url)
      return services.fetchImpl!(url)
    } }, "will/flows")
    expect(options.options).toEqual([])
    expect(options.error).toBeDefined()
    expect(calls).toEqual([cloudRepo, `${githubPulls}?state=open&per_page=100`])
  })

  test("a typed PR number reads the mapped GitHub PR and diff as Cloud flow context", async () => {
    const services = backend({
      [cloudRepo]: json(200, source),
      [`${githubPulls}/17`]: json(200, { number: 17, title: "Upstream PR", body: "Description", state: "open", user: { login: "writer" }, base: { ref: "main" } }),
      [`${githubPulls}/17/diff`]: new Response("diff --git a/a b/a\n+new code\n", { status: 200 }),
      [`${cloudRepo}/landings/17`]: json(200, landing(17, "open"))
    })
    const { store } = await ready(services)
    const calls: string[] = []
    const seam = createLandingsSeam({
      baseUrl: "", store, dispatch: store.dispatch.bind(store), actor: () => "user", nextOrdinal: () => 1,
      http: async (url) => { calls.push(url); return services.fetchImpl!(url) }
    } as SeamContext)
    expect(await seam.readLandingContext(17, "will/flows")).toEqual({
      repo: "will/flows", sourceRepo: "upstream/project", number: 17,
      title: "Upstream PR", body: "Description", state: "open", author: "writer", baseBranch: "main",
      diff: "diff --git a/a b/a\n+new code\n"
    })
    expect(calls).toEqual([cloudRepo, `${githubPulls}/17`, `${githubPulls}/17/diff`])
  })

  test("a typed PR authorization failure cannot review a same-number Cloud landing", async () => {
    const services = backend({
      [cloudRepo]: json(200, source),
      [`${githubPulls}/17`]: json(403, { message: "GitHub authorization required" }),
      [`${cloudRepo}/landings/17`]: json(200, landing(17, "open"))
    })
    const { store } = await ready(services)
    const calls: string[] = []
    const seam = createLandingsSeam({
      baseUrl: "", store, dispatch: store.dispatch.bind(store), actor: () => "user", nextOrdinal: () => 1,
      http: async (url) => { calls.push(url); return services.fetchImpl!(url) }
    } as SeamContext)
    expect(await seam.readLandingContext(17, "will/flows")).toContain("GitHub")
    expect(calls).toEqual([cloudRepo, `${githubPulls}/17`])
  })

  test("malformed source metadata refuses instead of guessing another owner", async () => {
    const services = backend({ [cloudRepo]: json(200, { full_name: "will/flows", github_source: { owner: "someone/else", repo: "project" } }) })
    const options = await readLandingOptions({ baseUrl: "", http: (url) => services.fetchImpl!(url) }, "will/flows")
    expect(options.options).toEqual([])
    expect(options.error).toContain("could not be verified")
  })

  test("conflicting ready imports refuse instead of using a Cloud PR with the same number", async () => {
    const calls: string[] = []
    const services = backend({
      [cloudRepo]: json(200, { full_name: "will/flows", github_source_ambiguous: true }),
      [`${cloudRepo}/landings?limit=100`]: json(200, [landing(17, "open")])
    })
    const options = await readLandingOptions({ baseUrl: "", http: async (url) => {
      calls.push(url)
      return services.fetchImpl!(url)
    } }, "will/flows")
    expect(options.options).toEqual([])
    expect(options.error).toContain("more than one GitHub source")
    expect(calls).toEqual([cloudRepo])
  })

  test("missing source store refuses even if native Cloud landings exist", async () => {
    const calls: string[] = []
    const services = backend({
      [cloudRepo]: json(200, { full_name: "will/flows", github_source_unavailable: true }),
      [`${cloudRepo}/landings?limit=100`]: json(200, [landing(17, "open")])
    })
    const options = await readLandingOptions({ baseUrl: "", http: async (url) => {
      calls.push(url)
      return services.fetchImpl!(url)
    } }, "will/flows")
    expect(options.options).toEqual([])
    expect(options.error).toContain("unavailable")
    expect(calls).toEqual([cloudRepo])
  })
})
