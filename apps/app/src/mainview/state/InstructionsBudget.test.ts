import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import { initialSetup, REPOSITORY_JOB_TITLES, type RepositoryJob } from "@smthrs/rpc/RepositorySetup"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { MAX_TURN_REQUEST_BYTES, turnRequestBytes } from "./AgentTurnPolicy"
import { CODE_INTEL_LINE, smithersInstructions } from "./Instructions"
import { worldContextDocuments } from "./WorldContext"
import { addWorldNote } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * 2026-09-02: a turn failed with "Smithers Cloud chat failed (HTTP 400):
 * instructions must be a string within the size limit". The prompt then grew
 * a 16 KiB budget that degraded the catalog, cut World notes, and shed card
 * lines and setup drafts. That cap was stale: the backend turn route takes
 * 1 MiB, and since #3313 the prompt lists only pinned and disclosed commands.
 * The budget is gone. What stays pinned here, against the REAL registry with
 * a repository open: the largest sessions the app builds still send one turn
 * under MAX_TURN_REQUEST_BYTES, and nothing in them is cut to get there.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}

const NATIVE_EVERYTHING = {
  apiVersion: 1 as const,
  host: "local" as const,
  version: "0",
  buildSha: "x",
  capabilities: ["agent", "identity", "cloud"] as const,
  authFlow: "both" as const,
  sandbox: null
}

/** The web app the alpha ships: the cloud Worker's bootstrap, no local capability. */
const CLOUD_HOST = {
  apiVersion: 1 as const,
  host: "cloud" as const,
  version: "0",
  buildSha: "x",
  capabilities: ["identity"] as const,
  authFlow: "redirect" as const,
  sandbox: null
}

/** The largest session the app builds a prompt for: a repository open, every local capability on, and whatever the test adds to the store. */
const capturedTurn = async (prepare: (store: Awaited<ReturnType<typeof createAppStore>>) => void, host: typeof NATIVE_EVERYTHING | typeof CLOUD_HOST = NATIVE_EVERYTHING, message = "hi") => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  // The selected note a person keeps, which the budget spends room on first.
  await addWorldNote(store, true)
  prepare(store)
  let captured: StartAgentTurnRequest | undefined
  const agent: AgentPort = {
    available: true,
    startTurn: async (request) => {
      captured = request
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: () => () => {}
  }
  const controller = createAppController(store, agent, { bootstrap: { ...host, capabilities: [...host.capabilities] } })
  await controller.send(message)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const instructions = captured?.instructions ?? ""
  // What the seam actually measures is the COMPOSED string the Bun side sends: prompt plus the rendered runtime context.
  const composed = composeAgentInstructions(instructions, captured?.context)
  if (captured === undefined) throw new Error("no turn captured")
  return { store, instructions, context: captured.context, composed, requestBytes: turnRequestBytes(captured) }
}

describe("the turn size without a budget", () => {
  test("the full live registry with a repository open sends a turn under the request limit, listing the pinned commands in full", async () => {
    const { instructions, requestBytes } = await capturedTurn(() => {})
    expect(instructions).toMatch(/Commands for this conversation \(\d+ exist; the list action with a "query" finds the rest, with their arguments\):/)
    // auth.prompt is named by the standing instructions, so its line is there in full.
    expect(instructions).toMatch(/^- \/auth\.prompt\b.* — /m)
    expect(requestBytes).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
  })

  /*
   * World notes are bounded by the World context's own budget
   * (WorldContext.ts), never cut further to fit a prompt cap.
   */
  test("a session with World notes at the body budget carries exactly the World context's bodies, under the request limit", async () => {
    const { store, context, requestBytes } = await capturedTurn((store) => {
      for (const index of [1, 2, 3]) {
        store.dispatch({
          type: "world.document.upserted",
          actor: "user",
          select: false,
          document: {
            id: `world-note-${index}`,
            path: `notes/note-${index}.md`,
            title: `Note ${index}`,
            body: Array.from({ length: 80 }, (_line, line) => `note ${index} line ${line}: a fact recorded nowhere else in the repository`).join("\n"),
            links: [],
            tags: [],
            sources: [],
            confidence: 0.9
          }
        })
      }
    })
    if (context === undefined) throw new Error("no context captured")
    expect(requestBytes).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
    const expected = worldContextDocuments(store.agentContextSnapshot().worldState.documents, store.session().selectedWorldDocumentId)
    expect(context.worldState.documents).toEqual(expected)
    const notes = context.worldState.documents.filter((document) => document.path.startsWith("notes/"))
    expect(notes).toHaveLength(3)
    for (const note of notes) expect(note.body?.length ?? 0).toBeGreaterThan(0)
  })

  /*
   * The open setups' drafts (controller/repositorySetup.ts setupContextSummary)
   * used to be shed oldest first to fit 16 KiB: three setup cards behind ten
   * file cards lost the issues draft. Every draft in the card window rides now.
   */
  test("every open setup's draft in the card window rides the turn, however busy the window", async () => {
    const setupCards = (store: Awaited<ReturnType<typeof createAppStore>>, jobs: ReadonlyArray<RepositoryJob>) => {
      for (const job of jobs) {
        store.dispatch({ type: "card.upsert", actor: "user", card: {
          id: `setup:will:will%2Fcanary:${job}`, kind: "repository-setup", title: REPOSITORY_JOB_TITLES[job],
          status: "active", createdAt: 1, ordinal: store.nextOrdinal(),
          payload: { ...initialSetup("will/canary", job, "will"), inspectedAt: 1234 }
        } })
      }
    }
    const drafted = (turn: { readonly context?: AgentRuntimeContext }) =>
      (turn.context?.recentCards ?? []).filter((card) => card.setup !== undefined).map((card) => card.id)

    const one = await capturedTurn((store) => setupCards(store, ["issues"]))
    expect(one.requestBytes).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
    expect(drafted(one)).toEqual(["setup:will:will%2Fcanary:issues"])
    expect(one.composed).toContain("- Research issue: automatic |")
    expect(one.composed).toContain("Settings: replies draft, landing ask, time limit 10 minutes, apply to new and edited issues.")

    const open = await capturedTurn((store) => setupCards(store, ["issues", "review", "ci"]))
    expect(open.requestBytes).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
    expect(drafted(open)).toEqual([
      "setup:will:will%2Fcanary:issues",
      "setup:will:will%2Fcanary:review",
      "setup:will:will%2Fcanary:ci"
    ])
    expect(open.composed).toContain("- Run repository checks: automatic |")

    const busy = await capturedTurn((store) => {
      setupCards(store, ["issues", "review", "ci"])
      for (let index = 0; index < 10; index += 1) {
        store.dispatch({ type: "card.upsert", actor: "user", card: {
          id: `run-trace-${index}`, kind: "file", title: `Run ${index} — a long-ish card title like the run cards carry`,
          status: "active", createdAt: 2, ordinal: store.nextOrdinal(),
          payload: { repo: "will/canary", path: `file-${index}.md`, content: "Source", truncated: false }
        } })
      }
    })
    // The window holds the newest twelve of thirteen cards: ten file cards and the review and CI setups. Neither draft is shed.
    expect(busy.requestBytes).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
    expect((busy.context?.recentCards ?? []).length).toBe(12)
    expect(drafted(busy)).toEqual(["setup:will:will%2Fcanary:review", "setup:will:will%2Fcanary:ci"])
    expect(busy.composed).toContain("- Run repository checks: automatic |")
  })

  /*
   * Canary walk run 3, B3 step 3 (ACTUAL PRODUCTION, 11:23:04Z): "what will run
   * automatically?" asked in the conversation B3-20's receipt lists card by card
   * — an issues setup, nine repository/setup run cards, the setup question form
   * and a review setup — answered "I couldn't complete that turn. The model
   * service refused this turn (HTTP 400)." / "Turn failed". Twelve card lines
   * spend the whole budget: every draft is shed AND the composition still
   * passes the app's own limit, which the composer used to send anyway. The
   * 16 KiB limit was stale; the same conversation now sends whole.
   */
  test("the canary's twelve-card conversation sends under the request limit and answers from the open setups' drafts", async () => {
    const repo = "codeplanesmithers/canary-sandbox"
    const workspaceId = "af1e3bc5-6388-419e-98cc-e13372a89646"
    const setupId = (job: RepositoryJob) => `setup:codeplanesmithers:${encodeURIComponent(repo)}:${job}`
    const turn = await capturedTurn((store) => {
      store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "codeplanesmithers", admin: false, scopesPlain: null })
      store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "codeplanesmithers", ownerKind: "user", name: "canary-sandbox", head: null }] })
      const setupCard = (job: RepositoryJob) => store.dispatch({ type: "card.upsert", actor: "user", card: {
        id: setupId(job), kind: "repository-setup", title: REPOSITORY_JOB_TITLES[job], status: "active", createdAt: 1, ordinal: store.nextOrdinal(),
        payload: { ...initialSetup(repo, job, "codeplanesmithers"), inspectedAt: 1234 } } })
      setupCard("issues")
      for (const runId of ["run-1", "run-2", "run-3", "run-4", "run-5", "run-7", "run-8", "run-10", "run-11"]) {
        store.dispatch({ type: "card.upsert", actor: "user", card: {
          id: `flow-run@${encodeURIComponent(repo)}@${workspaceId}@${runId}`, kind: "run-trace",
          title: `repository/setup — ${repo}`, status: "active", createdAt: 2, ordinal: store.nextOrdinal(),
          payload: { repo, workspaceId, runId, workflow: "repository/setup", phase: "completed", steps: [], result: null, lastSeq: 0 } } })
      }
      store.dispatch({ type: "card.upsert", actor: "user", card: {
        id: `form-setup.ask:${setupId("issues")}`, kind: "flow-form", title: "Keep issue research, duplicate lookup and bug reproduction automatic?",
        status: "active", createdAt: 3, ordinal: store.nextOrdinal(),
        payload: { flow: "setup.ask", via: "agent", fields: [], draft: {}, given: {} } } })
      setupCard("review")
    }, CLOUD_HOST, "what will run automatically?")
    const cards = turn.context?.recentCards ?? []
    expect(turn.requestBytes).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
    expect(cards).toHaveLength(12)
    // The draft is what an ordinary question beside the card is answered from.
    expect(cards.filter((card) => card.setup !== undefined).map((card) => card.id)).toEqual([setupId("issues"), setupId("review")])
    expect(turn.composed).toContain("- Research issue: automatic |")
    expect(turn.composed).toContain("- Find duplicates: automatic |")
    expect(turn.composed).toContain("- Reproduce bugs: automatic |")
  })

  /*
   * A card title is bounded at 250 characters (controller/turns.ts), so a
   * full window of them is a state the product itself allows. It once cost
   * card lines; it now costs nothing.
   */
  test("a full card window of 250-character titles keeps every card line, each title bounded", async () => {
    const turn = await capturedTurn((store) => {
      for (let index = 0; index < 12; index += 1) {
        store.dispatch({ type: "card.upsert", actor: "user", card: {
          id: `file-${index}`, kind: "file", title: `Card ${index} `.padEnd(260, "long title "), status: "active",
          createdAt: 2, ordinal: store.nextOrdinal(), payload: { repo: "will/canary", path: `file-${index}.md`, content: "Source", truncated: false } } })
      }
    })
    expect(turn.requestBytes).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
    const titles = (turn.context?.recentCards ?? []).map((card) => card.title)
    expect(titles).toHaveLength(12)
    for (const title of titles) expect(title).toHaveLength(250)
  })

  test("code intelligence is stated only where its flows are registered", async () => {
    const honesty = { host: "web", github: { connected: true, login: "will", repositories: 1 }, localRepositories: [], localRepositoriesAvailable: false } as const
    const catalog = [{ name: "files.read", summary: "Read a file" }]
    expect(smithersInstructions(catalog, honesty)).not.toContain("code.hover")
    expect(smithersInstructions(catalog, honesty)).toContain("code intelligence (hover, definitions, diagnostics)")
    const native = smithersInstructions([...catalog, { name: "code.hover", summary: "The type at a position" }], { ...honesty, host: "native" })
    expect(native).toContain(CODE_INTEL_LINE)
    expect(native).not.toContain("code intelligence (hover, definitions, diagnostics) need the native app")
  })
})
