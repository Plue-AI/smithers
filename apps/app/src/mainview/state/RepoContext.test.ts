/*
 * The one target-repo rule every repo-scoped command rides (RepoContext.ts):
 * which trailing token is a target, which repository a bare command means,
 * and the honest refusals when the choice is the user's. Grid review
 * ui-state-store/testing/3: a free-text argument ending in a relative path
 * (`fix the crash in src/index.ts`) used to lose its last word to a
 * `src/index.ts` repository.
 */
import { describe, expect, test } from "bun:test"
import { payloadFor } from "../flows/SlashPayload"

import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { knownRepositories, repositoryJobBinding, resolveTargetRepo, splitTrailingRepo } from "./RepoContext"

const freshStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const dispatch = (store: AppStore, transition: Parameters<AppStore["dispatch"]>[0]): Promise<unknown> =>
  store.dispatch(transition).isPersisted.promise

const repository = (id: string) => {
  const [org, name] = id.split("/") as [string, string]
  return { id, org, ownerKind: "user" as const, name, head: null }
}

const loadRepositories = (store: AppStore, ...ids: ReadonlyArray<string>) =>
  dispatch(store, { type: "repositories.loaded", actor: "system", repositories: ids.map(repository) })

const openBoxes = async (store: AppStore, ...ids: string[]) => {
  await dispatch(store, { type: "workspaces.loaded", actor: "system", workspaces: ids.map(id => ({ id, repoId: id, name: id, targetBookmark: null, status: "running", provisioningStage: null, suspendedAt: null, createdAt: null })) })
  await dispatch(store, { type: "repo.selected", actor: "user", id: `${ids[0]}#workspace:${ids[0]}` })
}

describe("splitTrailingRepo", () => {
  const known = new Set(["will/flows"])

  test("an explicit trailing token that names a known repository wins", () => {
    expect(splitTrailingRepo("12 will/flows", known)).toEqual({ rest: "12", repo: "will/flows" })
    expect(splitTrailingRepo("fix the crash will/flows", known)).toEqual({ rest: "fix the crash", repo: "will/flows" })
  })

  test("a path-like trailing token stays in the text when it names no known repository", () => {
    expect(splitTrailingRepo("fix the crash in src/index.ts", known)).toEqual({ rest: "fix the crash in src/index.ts" })
    expect(splitTrailingRepo("summarize docs/README.md", known)).toEqual({ rest: "summarize docs/README.md" })
    expect(splitTrailingRepo("open a PR for packages/rpc", known)).toEqual({ rest: "open a PR for packages/rpc" })
  })

  test("an unknown token that is the whole text stays intact", () => {
    expect(splitTrailingRepo("src/index.ts", known)).toEqual({ rest: "src/index.ts" })
    expect(splitTrailingRepo("  acme/brand-new  ", new Set())).toEqual({ rest: "acme/brand-new" })
  })

  test("repository-only commands can still name an unloaded repository", () => {
    expect(payloadFor("repos.import", "acme/brand-new", undefined, known)).toEqual({
      payload: { repo: "acme/brand-new" }
    })
  })

  test("without the known set the token's shape alone decides", () => {
    expect(splitTrailingRepo("summarize docs/README.md")).toEqual({ rest: "summarize", repo: "docs/README.md" })
    expect(splitTrailingRepo("12 will/flows")).toEqual({ rest: "12", repo: "will/flows" })
  })

  test("blank text and a non-repo last word split to nothing", () => {
    expect(splitTrailingRepo(undefined, known)).toEqual({ rest: "" })
    expect(splitTrailingRepo("   ", known)).toEqual({ rest: "" })
    expect(splitTrailingRepo("12 flows", known)).toEqual({ rest: "12 flows" })
    expect(splitTrailingRepo("a/b/c", known)).toEqual({ rest: "a/b/c" })
  })
})

describe("knownRepositories", () => {
  test("names loaded repositories and the active working copy's parseable repository", async () => {
    const store = await freshStore()
    await loadRepositories(store, "will/flows", "will/smithers")
    await openBoxes(store, "acme/flows")
    const known = knownRepositories(store)
    expect(known.has("will/flows")).toBe(true)
    expect(known.has("will/smithers")).toBe(true)
    expect(known.has("acme/flows")).toBe(true)
    expect(splitTrailingRepo("fix crash acme/flows", known)).toEqual({ rest: "fix crash", repo: "acme/flows" })
    expect(known.has("src/index.ts")).toBe(false)
  })
})

describe("trailing repositories from working copies", () => {
  test("an inactive working copy does not turn trailing text into a target", async () => {
    const store = await freshStore()
    await loadRepositories(store, "will/flows")
    await openBoxes(store, "acme/flows", "packages/rpc")
    expect(store.session().activeRepoKey).toBe("acme/flows#workspace:acme/flows")
    expect(splitTrailingRepo("fix packages/rpc", knownRepositories(store))).toEqual({ rest: "fix packages/rpc" })
    await dispatch(store, { type: "repo.selected", actor: "user", id: "packages/rpc#workspace:packages/rpc" })
    expect(splitTrailingRepo("fix packages/rpc", knownRepositories(store))).toEqual({ rest: "fix", repo: "packages/rpc" })
  })
})

describe("resolveTargetRepo", () => {
  test("an explicit owner/repo wins even when it is not loaded; a malformed one is refused by name", async () => {
    const store = await freshStore()
    await loadRepositories(store, "will/flows")
    expect(resolveTargetRepo(store, "acme/other")).toEqual({ repo: "acme/other" })
    expect(resolveTargetRepo(store, "src")).toEqual({ error: "\"src\" is not an owner/repo name" })
  })

  test("no repository loaded is an honest error naming the two ways out", async () => {
    const store = await freshStore()
    const target = resolveTargetRepo(store, undefined)
    expect(target).toEqual({ error: "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo" })
  })

  test("one loaded repository is the target; several loaded and none selected names the choice", async () => {
    const store = await freshStore()
    await loadRepositories(store, "will/flows")
    expect(resolveTargetRepo(store, undefined)).toEqual({ repo: "will/flows" })
    await loadRepositories(store, "will/flows", "will/smithers")
    expect(resolveTargetRepo(store, undefined)).toEqual({
      error: "Several repositories are loaded (will/flows, will/smithers) — name one as owner/repo"
    })
  })

  test("the active working copy's repository is the target over several loaded ones", async () => {
    const store = await freshStore()
    await loadRepositories(store, "will/flows", "will/smithers")
    await openBoxes(store, "acme/flows")
    expect(store.session().activeRepoKey).toBe("acme/flows#workspace:acme/flows")
    expect(resolveTargetRepo(store, undefined)).toEqual({ repo: "acme/flows" })
  })


})

/*
 * The symptom end to end: the production slash parser and the real issues
 * seam, will/flows the sole loaded repository, an issue title ending in a
 * relative path. The title reaches will/flows whole; no request names a
 * `src/index.ts` repository.
 */
describe("a repo-scoped command whose text ends in a path", () => {
  const unavailableAgent: AgentPort = {
    available: false,
    startTurn: async () => ({ status: "error", message: "unavailable" }),
    cancelTurn: async () => {},
    subscribe: () => () => {}
  }
  
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  test.each([
    ["Fix the crash in src/index.ts", "Fix the crash in src/index.ts", "will/flows"],
    ["summarize docs/README.md", "summarize docs/README.md", "will/flows"],
    ["open a PR for packages/rpc", "open a PR for packages/rpc", "will/flows"],
    ["src/index.ts", "src/index.ts", "will/flows"],
    ["Fix the crash will/flows", "Fix the crash", "will/flows"],
    ["Fix the crash acme/other", "Fix the crash", "acme/other"]
  ])("issues.create preserves the title and posts to the right repository: %s", async (args, title, target) => {
    const calls: string[] = []
    const bodies: unknown[] = []
    const services: AppServices = {
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const absolute = new URL(url, "https://app.test")
        const method = (init?.method ?? "GET").toUpperCase()
        calls.push(`${method} ${absolute.pathname}`)
        if (method === "POST" && absolute.pathname === `/api/repos/${target}/issues`) {
          bodies.push(JSON.parse(String(init?.body)))
          return json(201, { number: 9 })
        }
        return json(404, { status: "error", message: `no stub for ${method} ${absolute.pathname}` })
      }
    }
    const store = await freshStore()
    const controller = createAppController(store, unavailableAgent, services)
    await dispatch(store, {
      type: "identity.session.loaded", actor: "system", state: "signed-in",
      login: "will", allowlisted: true, admin: false, scopesPlain: null
    })
    await loadRepositories(store, "will/flows")
    if (target !== "will/flows") {
      await loadRepositories(store, "will/flows", target)
      await dispatch(store, { type: "repo.selected", actor: "user", id: "will/flows" })
    }
    try {
      await controller.commands.run("issues.create", args)
      expect(bodies).toEqual([{ title }])
      expect(calls.filter((call) => call.startsWith("POST "))).toEqual([`POST /api/repos/${target}/issues`])
    } finally {
      await controller.dispose()
    }
  })
})

import { GatewayWorkspaceIdSchema, isGatewayWorkspaceId } from "@smthrs/rpc/GatewayWorkspace"
import { CardSchema } from "@smthrs/rpc/Cards"
import { memoryStorage } from "./TestFixtures"

const createAppController = scopedControllers()

test("all persisted gateway cards accept exactly the Worker's canonical non-nil identity", () => {
  for (const value of ["ffffffff-ffff-ffff-ffff-ffffffffffff", "83e75ae5-0920-4000-8000-000000000001", "00000000-0000-0000-0000-000000000000", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "../other"]) {
    expect(GatewayWorkspaceIdSchema.safeParse(value).success).toBe(isGatewayWorkspaceId(value))
    const card = { id: "inbox", title: "Approvals", createdAt: 1, ordinal: 1, status: "active", kind: "approvals-inbox", payload: { repo: "o/r", workspaceId: value, approvals: [] } }
    expect(CardSchema.safeParse(card).success).toBe(isGatewayWorkspaceId(value))
  }
})

test("completed imports resolve button arguments before repository inventory refresh", async () => {
 const store = await freshStore()
 for (const phase of ["running", "failed", "done"] as const) {
  await dispatch(store, {type:"card.upsert", actor:"system", card:{id:"import-new",kind:"repo-import",title:"Import",status:phase === "done" ? "acted" : "active",createdAt:1,ordinal:1,payload:{repo:"acme/new",jobId:"job-new",phase,detail:null,repository:{owner:"acme",name:"new"}}}})
  const known = knownRepositories(store)
  expect(known.has("acme/new")).toBe(phase === "done")
  if (phase === "done") {
   expect(payloadFor("issues.list", "open acme/new", undefined, known)).toEqual({payload:{filter:"open",repo:"acme/new"}})
   expect(payloadFor("issues.create", "title acme/new", undefined, known)).toEqual({payload:{title:"title",repo:"acme/new"}})
  }
 }
})

describe("repositoryJobBinding (#2475)", () => {
  const REPO = "will/flows"
  const BOX_A = "0b0c0d0e-0000-4000-8000-00000000000a"
  const BOX_B = "0b0c0d0e-0000-4000-8000-00000000000b"
  const BOX_SETTLING = "0b0c0d0e-0000-4000-8000-00000000000c"
  const twoBoxes = async () => {
    const store = await freshStore()
    await dispatch(store, { type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null })
    await loadRepositories(store, REPO)
    await dispatch(store, { type: "workspaces.loaded", actor: "system", workspaces: [[BOX_A, "running"], [BOX_B, "running"], [BOX_SETTLING, "starting"]].map(([id, status]) =>
      ({ id: id!, repoId: REPO, name: id!, targetBookmark: null, status: status as "running", provisioningStage: null, suspendedAt: null, createdAt: null })) })
    return store
  }
  const select = (store: AppStore, box: string) => dispatch(store, { type: "repo.selected", actor: "user", id: `${REPO}#workspace:${box}` })
  /* A store whose cards hold this account's setup recorded on `box`. */
  const recordedOn = (store: AppStore, box: string): AppStore => ({ ...store, collections: { ...store.collections,
    cards: new Map([["setup", { kind: "repository-setup", payload: { repo: REPO, owner: "will", workspaceId: box } }]]) } }) as unknown as AppStore

  test("several boxes and no selection: the refusal offers them", async () => {
    const binding = repositoryJobBinding(await twoBoxes(), REPO)
    expect("error" in binding && binding.choices?.map(box => box.id)).toEqual([BOX_A, BOX_B])
  })

  test("several boxes: the selected one of them is the pick", async () => {
    const store = await twoBoxes()
    await select(store, BOX_B)
    expect(repositoryJobBinding(store, REPO)).toEqual({ workspaceId: BOX_B })
  })

  test("a selected box that is not one of the choices is no pick", async () => {
    const store = await twoBoxes()
    await select(store, BOX_SETTLING)
    expect(repositoryJobBinding(store, REPO)).toMatchObject({ error: `Select a box of ${REPO} first.` })
  })

  test("a recorded job box is never re-picked by the selection", async () => {
    const store = await twoBoxes()
    await select(store, BOX_B)
    expect(repositoryJobBinding(recordedOn(store, BOX_A), REPO)).toEqual({ workspaceId: BOX_A })
  })
})
