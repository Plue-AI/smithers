/*
 * The palette's hot path (Search and Command Palette Spec 2026-09-07 §2, §5).
 *
 * `controller.searchPalette(draft)` is what the composer calls on EVERY
 * keystroke while the overlay is open. Deriving an item's actions walks the
 * registry and derives a form per namespace flow, so doing it per indexed
 * fact made a thousand-row index cost tens of thousands of form derivations
 * per character. The seam ranks facts and derives actions only for the rows
 * it shows (PALETTE_GROUP_CAP per group) or answers (`limit`).
 *
 * These tests pin that as a CALL COUNT of actionsFor against a 500-row
 * fixture, not a description: attaching actions before ranking fails here
 * immediately with hundreds of calls per keystroke.
 *
 * The counted index is RUNS, not files: an indexed fact whose flow is already
 * known carries its own actions and skips the registry walk entirely, which is
 * how a file row retains the repository or working copy it was listed from
 * ("fix(app): retain file search repository and working-copy targets",
 * 3865852bcc, pinned by SearchSeam.test.ts "workspace files retain distinct
 * explicit targets"). A run row has no such shortcut, so it is the honest
 * ruler for the walk. The last case pins the file row's zero, so the shortcut
 * cannot quietly disappear either.
 */
import type { StorageApi } from "@tanstack/db"
import { afterEach, describe, expect, spyOn, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import * as SearchQuery from "../../flows/SearchQuery"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import { PALETTE_GROUP_CAP, SEARCH_DEFAULT_LIMIT } from "./SearchSeam"

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


const ROW_COUNT = 500

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A signed-in app holding two 500-row indexes: a run list whose rows all match
 * `run-`, and a file listing under src/ whose rows all match `src/f`.
 */
const ready = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, {
    fetchImpl: async () => new Response(JSON.stringify({ status: "error", message: "no backend" }), { status: 404 })
  })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: "runs-many",
      kind: "run-list",
      title: "runs",
      status: "active",
      createdAt: 1,
      ordinal: 1,
      payload: {
        repo: "smithers",
        runs: Array.from({ length: ROW_COUNT }, (_, index) => ({
          runId: `run-${String(index).padStart(3, "0")}`,
          flowId: "review",
          status: "running",
          createdAt: 1,
          turns: 1,
          calls: 1
        }))
      }
    }
  })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: "files-many",
      kind: "file-list",
      title: "files",
      status: "active",
      createdAt: 1,
      ordinal: 2,
      payload: {
        repo: "will/flows",
        path: "src",
        entries: Array.from({ length: ROW_COUNT }, (_, index) => ({ name: `file-${String(index).padStart(3, "0")}.ts`, kind: "file" as const }))
      }
    }
  })
  await settled()
  return { store, controller }
}

const derivations: Array<ReturnType<typeof spyOn>> = []

afterEach(() => {
  while (derivations.length > 0) derivations.pop()?.mockRestore()
})

const countActions = () => {
  const spy = spyOn(SearchQuery, "actionsFor")
  derivations.push(spy)
  return () => spy.mock.calls.length
}

describe("the palette hot path: actions are derived for shown rows only", () => {
  test("a run of keystrokes over 500 runs derives actions for the capped rows of each answer, never per indexed run", async () => {
    const { controller } = await ready()
    const calls = countActions()
    let shown = 0
    // Every draft reads in the runs mode (the `run:` prefix), so the answer is one Runs group.
    for (const draft of ["run:run-", "run:run-0", "run:run-00", "run:run-01", "run:run-02"]) {
      const answer = controller.searchPalette(draft)
      expect(answer.parsed.mode).toBe("runs")
      const rows = answer.groups.flatMap((group) => group.items)
      // The fixture is large enough that the cap, not the index, bounds the rows.
      expect(rows.length).toBe(PALETTE_GROUP_CAP)
      expect(rows.every((row) => row.item.kind === "run" && row.item.actions.length > 0)).toBe(true)
      shown += rows.length
    }
    expect(calls()).toBe(shown)
    expect(calls()).toBeLessThan(ROW_COUNT)
  })

  test("the flow door derives actions for the rows it answers (the default limit), not for the whole index", async () => {
    const { store, controller } = await ready()
    const calls = countActions()
    const outcome = await controller.commands.run("search.runs", "run-")
    expect(outcome.status).toBe("executed")
    const card = store.collections.cards.get("search-search.runs")
    if (card?.kind !== "search-results") throw new Error("expected the search-results card")
    expect(card.payload.items.length).toBe(SEARCH_DEFAULT_LIMIT)
    expect(card.payload.items.every((item) => item.actions.some((action) => action.flow === "runs.open"))).toBe(true)
    expect(calls()).toBe(SEARCH_DEFAULT_LIMIT)
    expect(calls()).toBeLessThan(ROW_COUNT)
  })

  test("a file row is listed with the flow that reads it, so showing one costs no derivation at all", async () => {
    const { controller } = await ready()
    const calls = countActions()
    const answer = controller.searchPalette("src/file")
    expect(answer.parsed.mode).toBe("path")
    const rows = answer.groups.flatMap((group) => group.items)
    expect(rows.length).toBe(PALETTE_GROUP_CAP)
    // The action names the repository the listing came from, which is why it cannot come from the registry walk.
    expect(rows.every((row) => row.item.kind === "file" && row.item.actions.some((action) => action.flow === "files.read"))).toBe(true)
    expect(calls()).toBe(0)
  })
})
