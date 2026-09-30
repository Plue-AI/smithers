import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { combinedStatus, defaultBranch, personOf, titleOf } from "./CommitsSeam"

/*
 * The commits seam through the real command path: controller.commands.run
 * drives commits.list and commits.read exactly as the branches row, the
 * commit rows and the agent do; the stubbed backend answers plue's jj change
 * routes, and the cards state only what the wire said.
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


const page = (items: unknown[], nextCursor = "") => json(200, { items, next_cursor: nextCursor })
const change = (id: string, commit: string, parents: string[], description: string, email = "ada@example.com") => ({
  change_id: id,
  commit_id: commit,
  description,
  author_name: "Ada",
  author_email: email,
  timestamp: "2026-09-10T12:00:00Z",
  parent_change_ids: parents
})
const commitStatus = (id: number, context: string, status: string, createdAt: string) => ({
  id,
  repository_id: 1,
  change_id: "c2",
  commit_sha: "ccc2",
  context,
  status,
  description: "",
  target_url: "",
  workflow_run_id: null,
  targets_affected: 0,
  targets_ran: 0,
  targets_cached: 0,
  duration_ms: 0,
  workspace_id: null,
  created_at: createdAt,
  updated_at: createdAt
})
const ROOT = "/api/repos/will/flows"

describe("commits seam — commits.list", () => {
  test("walks the named branch's first parents newest first, stopping at the root, and the card groups nothing it was not told", async () => {
    const { store, controller } = await ready(backend({
      [`${ROOT}/bookmarks`]: page([{ name: "main", target_change_id: "m1", target_commit_id: "aaa" }, { name: "feat", target_change_id: "c3", target_commit_id: "ccc3" }]),
      [`${ROOT}/changes`]: page([
        change("c3", "ccc3", ["c2"], "Third\n\nbody", "7+octo@users.noreply.github.com"),
        change("c2", "ccc2", ["c1", "x9"], "Second"),
        change("zz", "0000000000", [], "")
      ]),
      /* c1 is missing from the listing: the walk reads it one by one. */
      [`${ROOT}/changes/c1`]: json(200, change("c1", "ccc1", ["zz"], "First"))
    }))
    const outcome = await controller.commands.run("commits.list", "feat will/flows")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = store.collections.cards.get("commits-will/flows-feat")
    if (card === undefined || card.kind !== "commit-list") throw new Error("expected the commit-list card")
    expect(card.title).toBe("Commits · feat · will/flows")
    expect(card.payload.branch).toBe("feat")
    expect(card.payload.truncated).toBeUndefined()
    expect(card.payload.commits.map((row) => [row.commitId, row.title])).toEqual([["ccc3", "Third"], ["ccc2", "Second"], ["ccc1", "First"]])
    expect(card.payload.commits[0]!.author).toEqual({ name: "Ada", email: "7+octo@users.noreply.github.com", login: "octo", avatarUrl: "https://avatars.githubusercontent.com/u/7?v=4" })
    expect(card.payload.commits[1]!.author).toEqual({ name: "Ada", email: "ada@example.com" })
    expect(card.payload.commits.every((row) => row.verified === undefined && row.status === undefined)).toBe(true)
  })

  test("a bare list walks main; an unknown branch is refused by name and draws no card", async () => {
    const { store, controller } = await ready(backend({
      [`${ROOT}/bookmarks`]: page([{ name: "landing/1", target_change_id: "l1", target_commit_id: "" }, { name: "main", target_change_id: "m1", target_commit_id: "aaa" }]),
      [`${ROOT}/changes`]: page([change("m1", "aaa", [], "Init")])
    }))
    expect((await controller.commands.run("commits.list")).status).toBe("executed")
    await settled()
    const card = store.collections.cards.get("commits-will/flows-main")
    if (card === undefined || card.kind !== "commit-list") throw new Error("expected main's list")
    expect(card.payload.commits.map((row) => row.title)).toEqual(["Init"])
    const refused = await controller.commands.run("commits.list", "nope will/flows")
    expect(JSON.stringify(refused)).toContain("has no branch named nope")
    expect(store.collections.cards.get("commits-will/flows-nope")).toBeUndefined()
  })
})

describe("commits seam — commits.read", () => {
  test("renders message, parents, the combined status (newest per context) and the diff files", async () => {
    const { store, controller } = await ready(backend({
      [`${ROOT}/changes/c2`]: json(200, change("c2", "ccc2", ["c1"], "Second\n\nWhy it matters.\n")),
      [`${ROOT}/changes/c1`]: json(200, change("c1", "ccc1", [], "First")),
      [`${ROOT}/changes/c2/diff`]: json(200, { change_id: "c2", file_diffs: [
        { path: "src/a.ts", change_type: "modified", patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n", is_binary: false, additions: 1, deletions: 1 },
        { path: "logo.png", change_type: "added", is_binary: true, additions: 0, deletions: 0 }
      ] }),
      [`${ROOT}/commits/ccc2/statuses`]: json(200, [
        commitStatus(2, "ci", "success", "2026-09-10T12:05:00Z"),
        commitStatus(1, "ci", "failure", "2026-09-10T12:01:00Z")
      ])
    }))
    expect((await controller.commands.run("commits.read", "c2 will/flows")).status).toBe("executed")
    await settled()
    const card = store.collections.cards.get("commit-will/flows-c2")
    if (card === undefined || card.kind !== "commit") throw new Error("expected the commit card")
    expect(card.payload.message).toBe("Second\n\nWhy it matters.")
    expect(card.payload.commit.status).toBe("success")
    expect(card.payload.parents).toEqual([{ changeId: "c1", commitId: "ccc1" }])
    expect(card.payload.files.map((file) => [file.path, file.changeType, file.isBinary, file.patch !== undefined])).toEqual([
      ["src/a.ts", "modified", false, true],
      ["logo.png", "added", true, false]
    ])
    expect(card.payload.diffError).toBeUndefined()
  })

  test.each([
    ["failure", [commitStatus(1, "ci", "success", "2026-09-10T12:01:00Z"), commitStatus(2, "ci", "failure", "2026-09-10T12:05:00Z"), commitStatus(3, "review", "pending", "2026-09-10T12:04:00Z")], "failure"],
    ["pending", [commitStatus(1, "ci", "success", "2026-09-10T12:05:00Z"), commitStatus(2, "review", "pending", "2026-09-10T12:04:00Z")], "pending"],
    ["error", [commitStatus(1, "ci", "error", "2026-09-10T12:05:00Z"), commitStatus(2, "review", "success", "2026-09-10T12:04:00Z")], "failure"]
  ] as const)("canonical %s status appears on the persisted card and in the model answer", async (_case, rows, expected) => {
    const { store, controller } = await ready(backend({
      [`${ROOT}/changes/c2`]: json(200, change("c2", "ccc2", [], "Second")),
      [`${ROOT}/changes/c2/diff`]: json(200, { change_id: "c2", file_diffs: [] }),
      [`${ROOT}/commits/ccc2/statuses`]: json(200, rows)
    }))
    const outcome = await controller.commands.run("commits.read", "c2 will/flows")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toContain(`Status: ${expected}`)
    await settled()
    const card = store.collections.cards.get("commit-will/flows-c2")
    if (card === undefined || card.kind !== "commit") throw new Error("expected the persisted commit card")
    expect(card.payload.commit.status).toBe(expected)
  })

  test("an unreadable diff keeps the commit and says why", async () => {
    const { store, controller } = await ready(backend({
      [`${ROOT}/changes/c1`]: json(200, change("c1", "ccc1", [], "First")),
      [`${ROOT}/changes/c1/diff`]: json(500, { message: "repo host down" })
    }))
    await controller.commands.run("commits.read", "c1 will/flows")
    await settled()
    const card = store.collections.cards.get("commit-will/flows-c1")
    if (card === undefined || card.kind !== "commit") throw new Error("expected the commit card")
    expect(card.payload.diffError).toBe("The diff of c1 couldn't be read. That's a bug in Smithers, not something you did.")
    expect(card.payload.diffError).not.toContain("repo host down")
    expect(card.payload.commit.status).toBeUndefined()
  })
})

describe("commits seam — pure rules", () => {
  test("titles, people, default branch, combined status", () => {
    expect(titleOf("\n  Fix it  \nbody")).toBe("Fix it")
    expect(titleOf("")).toBe("(no description)")
    expect(personOf("A", "octo@users.noreply.github.com")).toEqual({ name: "A", email: "octo@users.noreply.github.com", login: "octo" })
    expect(personOf("A", "a@b.c")).toEqual({ name: "A", email: "a@b.c" })
    const row = (name: string) => ({ name, targetChangeId: name, targetCommitId: null, isTrackingRemote: false })
    expect(defaultBranch([row("landing/2"), row("dev")])?.name).toBe("dev")
    expect(defaultBranch([row("dev"), row("master")])?.name).toBe("master")
    expect(combinedStatus([])).toBeUndefined()
    expect(combinedStatus([{ context: "legacy", state: "failure", created_at: "2026-09-10T12:05:00Z" }])).toBeUndefined()
    expect(combinedStatus([
      { context: "ci", state: "failure", created_at: "2026-09-10T12:05:00Z" },
      { context: "ci", status: "success", created_at: "2026-09-10T12:01:00Z" }
    ])).toBe("success")
    expect(combinedStatus([{ context: "a", status: "pending" }, { context: "b", status: "success" }])).toBe("pending")
    expect(combinedStatus([{ context: "a", status: "error" }, { context: "b", status: "pending" }])).toBe("failure")
  })
})
