import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { BOOKMARK_WIRE } from "./fixtures/BookmarkWire"

/*
 * The bookmarks seam through the real command path: controller.commands.run
 * drives branches.list exactly as buttons and slash do, the stubbed backend
 * answers plue's cursor-paginated wire shape (multi src/smithersCloud/
 * bookmarks.ts), and the "branches" card states the truth.
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

/* ---- the wire shape multi's bookmark parser accepts ---- */

const bookmark = BOOKMARK_WIRE.row

const page = (items: unknown[], nextCursor = "") => json(200, BOOKMARK_WIRE.page(items, nextCursor))

const BOOKMARKS = "/api/repos/will/flows/bookmarks"

describe("bookmarks seam — branches.list", () => {
  test("surfaces the branches card: names, heads (empty commit → null), malformed rows skipped", async () => {
    const { store, controller } = await ready(
      backend({
        [BOOKMARKS]: page([
          bookmark("main", "chg-a", "f00dfeedcafe0123"),
          bookmark("feature-x", "chg-c"),
          { nonsense: true }
        ])
      })
    )
    const outcome = await controller.commands.run("branches.list")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = store.collections.cards.get("branches-will/flows")
    if (card === undefined || card.kind !== "branches") throw new Error("expected the branches card")
    expect(card.title).toBe("Branches · will/flows")
    expect(card.status).toBe("active")
    expect(card.payload).toEqual({
      repo: "will/flows",
      bookmarks: [
        { name: "main", head: "f00dfeedcafe0123" },
        { name: "feature-x", head: null }
      ]
    })
  })

  test("walks every cursor page so a late-sorting base bookmark is not lost", async () => {
    const cursors: Array<string> = []
    const { store, controller } = await ready(
      backend({
        [BOOKMARKS]: (request) => {
          const cursor = new URL(request.url).searchParams.get("cursor") ?? ""
          cursors.push(cursor)
          return cursor === ""
            ? json(200, {
              items: [bookmark("landing/one", "chg-l1", "aaa111")],
              next_cursor: "page-2"
            })
            : json(200, { items: [bookmark("main", "chg-a", "bbb222")], next_cursor: "" })
        }
      })
    )
    const outcome = await controller.commands.run("branches.list")
    expect(outcome.status).toBe("executed")
    expect(cursors).toEqual(["", "page-2"])
    await settled()
    const card = store.collections.cards.get("branches-will/flows")
    if (card === undefined || card.kind !== "branches") throw new Error("expected the branches card")
    expect(card.payload.bookmarks).toEqual([
      { name: "landing/one", head: "aaa111" },
      { name: "main", head: "bbb222" }
    ])
  })

  test("an explicit owner/repo argument targets that repository", async () => {
    const { store, controller } = await ready(
      backend({
        "/api/repos/acme/site/bookmarks": page([bookmark("main", "chg-z", "cafe1234")])
      })
    )
    const outcome = await controller.commands.run("branches.list", "acme/site")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = store.collections.cards.get("branches-acme/site")
    if (card === undefined || card.kind !== "branches") throw new Error("expected the branches card")
    expect(card.title).toBe("Branches · acme/site")
    expect(card.payload.repo).toBe("acme/site")
  })

  test("a 500 answers what failed and whose fault it was, never the platform's words, and keeps the failed view visible", async () => {
    const { store, controller } = await ready(
      backend({ [BOOKMARKS]: json(500, { message: "the bookmark store fell over" }) })
    )
    const outcome = await controller.commands.run("branches.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Branches for will/flows couldn't be listed. That's a bug in Smithers, not something you did.")
      expect(outcome.error).not.toContain("the bookmark store fell over")
    }
    expect(store.collections.cards.get("branches-will/flows")).toMatchObject({ status: "error", loading: false })
  })

  test("a network throw answers an honest string, never an exception", async () => {
    const { controller } = await ready({
      fetchImpl: async () => {
        throw new Error("socket dropped")
      }
    })
    const outcome = await controller.commands.run("branches.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "Branches for will/flows couldn't be listed — the platform didn't answer."
      )
    }
  })

  test("a payload that is not plue's page shape answers honestly", async () => {
    const { controller } = await ready(
      backend({ [BOOKMARKS]: json(200, ["not", "a", "page"]) })
    )
    const outcome = await controller.commands.run("branches.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "Branches for will/flows answered with a payload this app couldn't read."
      )
    }
  })

  test("a pagination cursor that does not advance answers honestly instead of spinning", async () => {
    let calls = 0
    const { controller } = await ready(
      backend({
        [BOOKMARKS]: () => {
          calls += 1
          return json(200, { items: [bookmark("main", "chg-a")], next_cursor: "stuck" })
        }
      })
    )
    const outcome = await controller.commands.run("branches.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "Branches for will/flows couldn't be fully listed — the pagination cursor didn't advance."
      )
    }
    expect(calls).toBe(2)
  })

  test("with no loaded repository the answer is the resolution error, verbatim", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableAgent,
      backend({})
    )
    await signedIn(store)
    const outcome = await controller.commands.run("branches.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo"
      )
    }
  })
})
