import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import { initialSetup, REPOSITORY_JOB_TITLES, type RepositoryJob } from "@smthrs/rpc/RepositorySetup"
import { CHAT_INSTRUCTIONS_CAP_BYTES, CODE_INTEL_LINE, INSTRUCTIONS_BUDGET_BYTES, INSTRUCTIONS_HEADROOM_BYTES, instructionStageOf, smithersInstructions } from "./Instructions"
import { WORLD_BODY_BUDGET, WORLD_BODY_PER_DOCUMENT } from "./WorldContext"
import { addWorldNote } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * 2026-09-02: a turn failed with "Smithers Cloud chat failed (HTTP 400):
 * instructions must be a string within the size limit" — the chat seam caps
 * instructions at 16 KiB and the live catalog had grown past it. The prompt
 * now has a budget and degrades its catalog honestly instead of failing the
 * turn. This pins the budget against the REAL registry with a repository open
 * and every local capability on, the largest prompt the app builds.
 */

const CHAT_SEAM_CAP_BYTES = 16 * 1024
const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}

const bytes = (text: string): number => new TextEncoder().encode(text).length

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
  // A cloud session has no local checkout to list; only a native host does.
  if ((host.capabilities as readonly string[]).includes("local.repositories")) store.dispatch({
    type: "repos.loaded",
    actor: "system",
    repos: [{
      id: "r1",
      path: "/Users/will/smithers",
      name: "smithersai/smithers",
      git: { branch: "main", remote: "git@github.com:smithersai/smithers.git" },
      warnings: [],
      smithers: { detected: true, workspaceFile: "WORKSPACE.ts", declarationFiles: [], reason: "1 workspace detected", workspaces: [{ path: ".", title: "smithers" }] }
    }]
  })
  prepare(store)
  let captured: { instructions?: string; context?: AgentRuntimeContext } | undefined
  const agent: AgentPort = {
    available: true,
    startTurn: async (request) => {
      captured = request as { instructions?: string; context?: AgentRuntimeContext }
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
  return { store, instructions, context: captured?.context, composed }
}

describe("the instructions budget", () => {
  test("the full live registry with a repository open fits the chat seam's cap with headroom", async () => {
    const { instructions, composed } = await capturedTurn(() => {})
    expect(instructions).toContain("What you can do is EXACTLY this")
    expect(bytes(composed)).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - 256)
    expect(CHAT_SEAM_CAP_BYTES).toBe(CHAT_INSTRUCTIONS_CAP_BYTES)
    expect(INSTRUCTIONS_BUDGET_BYTES).toBeLessThanOrEqual(CHAT_SEAM_CAP_BYTES - 2048)
    // The lane report reads the stage the live catalog lands in with an empty context.
    console.info(`instructions budget: empty-context session lands in stage ${instructionStageOf(instructions)} (${bytes(instructions)} prompt bytes, ${bytes(composed)} composed)`)
  })

  /*
   * The floor. Stage 2 had no floor: with World notes at WORLD_BODY_BUDGET
   * and the orchestrator roles present, the composed string measured 22 650
   * bytes and the seam's 400 came back as a failed turn. The World bodies
   * now give way before the cap does, each cut note saying so, and only
   * with none left does the catalog fall to stage 3.
   */
  test("a session with World notes at the body budget composes under the cap, and the notes are cut before the turn is", async () => {
    const { instructions, context, composed } = await capturedTurn((store) => {
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
    expect(bytes(composed)).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES)
    /*
     * The catalog degrades only as far as it must. Since the local backend
     * retired (docs/LOCAL-BACKEND-RETIREMENT.md) the registry is smaller, so
     * the namespace list at stage 2 leaves room the notes then spend — the
     * assertions below are what proves that room went to the notes.
     */
    /*
     * With every note cut, the names-by-namespace catalog alone left 23
     * bytes under the cap once the stack flows (#1745) joined the registry
     * it no longer fits, so the catalog falls to namespaces and counts —
     * the documented floor — and the notes keep the room it frees.
     */
    expect(instructionStageOf(instructions)).toBe(3)
    expect(instructions).toContain("Commands: ")
    // Every note is still listed with its body (the head of it) and says when it was cut; none silently vanished.
    const notes = context.worldState.documents.filter((document) => document.path.startsWith("notes/"))
    expect(notes).toHaveLength(3)
    for (const note of notes) expect(note.body).toBeDefined()
    expect(notes.some((note) => note.bodyTruncated === true)).toBe(true)
    expect(notes.reduce((sum, note) => sum + (note.body?.length ?? 0), 0)).toBeGreaterThan(0)
    expect(notes.reduce((sum, note) => sum + (note.body?.length ?? 0), 0)).toBeLessThan(Math.min(WORLD_BODY_BUDGET, 3 * WORLD_BODY_PER_DOCUMENT))
    /*
     * The cut spends the room it has: a one-step cut by the overshoot used to
     * land on a zero budget with hundreds of bytes unused (and passed this
     * floor by a single line only while the catalog stayed small enough).
     * Bisection stops within a few characters, so the slack under the cap is
     * bounded by one note line plus the search's resolution.
     */
    expect(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES - bytes(composed)).toBeLessThan(256)
    console.info(`instructions budget: World notes at budget land in stage ${instructionStageOf(instructions)} (${bytes(instructions)} prompt bytes, ${bytes(composed)} composed)`)
  })

  /*
   * The open setups' drafts (controller/repositorySetup.ts setupContextSummary)
   * are the last thing the cap cuts. Budgeting them by their JSON size instead
   * admitted two drafts that the RENDERED turn had no room for: three setup
   * cards behind ten file cards composed 17 292 bytes, past the seam's cap,
   * which it answers with "instructions must be a string within the size
   * limit". composeTurn now sheds them oldest first.
   */
  test("the open setups' drafts ride the turn while there is room and are shed before the cap is passed", async () => {
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
    expect(bytes(one.composed)).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES)
    expect(one.composed).toContain("- Research issue: automatic |")
    expect(one.composed).toContain("Settings: replies draft, landing ask, time limit 10 minutes, apply to new and edited issues.")
    console.info(`instructions budget: one open issues setup carries ${drafted(one).length} draft (${bytes(one.composed)} composed)`)

    const open = await capturedTurn((store) => setupCards(store, ["issues", "review", "ci"]))
    expect(bytes(open.composed)).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES)
    // Three drafts and nothing else still fit: a draft is shed only under pressure.
    expect(drafted(open)).toEqual([
      "setup:will:will%2Fcanary:issues",
      "setup:will:will%2Fcanary:review",
      "setup:will:will%2Fcanary:ci"
    ])
    expect(open.composed).toContain("- Run repository checks: automatic |")
    console.info(`instructions budget: three open setups carry ${drafted(open).length} drafts (${bytes(open.composed)} composed)`)

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
    /*
     * Twelve card lines alone spent this fixture's headroom (16 062 bytes with
     * no draft at all, and past the limit the composer then sent anyway). The
     * card window holds twelve of the thirteen cards; the drafts are what
     * gives way, oldest first, and the newest one the person is looking at
     * still rides the turn.
     */
    expect(bytes(busy.composed)).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES)
    expect((busy.context?.recentCards ?? []).length).toBe(12)
    expect(drafted(busy)).toEqual(["setup:will:will%2Fcanary:review", "setup:will:will%2Fcanary:ci"])
    console.info(`instructions budget: the same setups behind ten cards carry ${drafted(busy).length} drafts in ${(busy.context?.recentCards ?? []).length} card lines (${bytes(busy.composed)} composed)`)
  })

  /*
   * Canary walk run 3, B3 step 3 (ACTUAL PRODUCTION, 11:23:04Z): "what will run
   * automatically?" asked in the conversation B3-20's receipt lists card by card
   * — an issues setup, nine repository/setup run cards, the setup question form
   * and a review setup — answered "I couldn't complete that turn. The model
   * service refused this turn (HTTP 400)." / "Turn failed". Twelve card lines
   * spend the whole budget: every draft is shed AND the composition still
   * passes the app's own limit, which the composer used to send anyway.
   */
  test("the canary's twelve-card conversation composes under the cap and still answers from the open setups' drafts", async () => {
    const repo = "codeplanesmithers/canary-sandbox"
    const workspaceId = "af1e3bc5-6388-419e-98cc-e13372a89646"
    const setupId = (job: RepositoryJob) => `setup:codeplanesmithers:${encodeURIComponent(repo)}:${job}`
    const turn = await capturedTurn((store) => {
      store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "codeplanesmithers", allowlisted: true, admin: false, scopesPlain: null })
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
    expect(bytes(turn.composed)).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES)
    // The draft is what an ordinary question beside the card is answered from.
    expect(cards.filter((card) => card.setup !== undefined).map((card) => card.id)).toEqual([setupId("issues"), setupId("review")])
    expect(turn.composed).toContain("- Research issue: automatic |")
    expect(turn.composed).toContain("- Find duplicates: automatic |")
    expect(turn.composed).toContain("- Reproduce bugs: automatic |")
    console.info(`instructions budget: the canary's twelve-card conversation carries ${cards.filter((card) => card.setup !== undefined).length} drafts in ${cards.length} card lines (${bytes(turn.composed)} composed)`)
  })

  /*
   * The floor under every stage. A card title is bounded at 250 characters
   * (controller/turns.ts), so a full window of them is a state the product
   * itself allows: it must cost card lines, never the turn.
   */
  test("a card window whose titles alone pass the cap loses card lines, not the turn", async () => {
    const turn = await capturedTurn((store) => {
      for (let index = 0; index < 12; index += 1) {
        store.dispatch({ type: "card.upsert", actor: "user", card: {
          id: `file-${index}`, kind: "file", title: `Card ${index} `.padEnd(260, "long title "), status: "active",
          createdAt: 2, ordinal: store.nextOrdinal(), payload: { repo: "will/canary", path: `file-${index}.md`, content: "Source", truncated: false } } })
      }
    })
    expect(bytes(turn.composed)).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES)
    expect((turn.context?.recentCards ?? []).length).toBeLessThan(12)
    console.info(`instructions budget: a window of 250-character titles keeps ${(turn.context?.recentCards ?? []).length} card lines (${bytes(turn.composed)} composed)`)
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

  /*
   * Stage 1 — the argument grammars leave, every summary stays. Only stages
   * 0, 2 and 3 were pinned, so widening the stage-0 predicate to `stage <= 1`
   * kept every grammar in stage 1 and the suite stayed green: the oversized
   * fixture simply fell through to stage 2.
   */
  test("a catalog that fits only once the argument grammars go lands in stage 1, keeping every summary", () => {
    const honesty = { github: { connected: false, login: null, repositories: null }, localRepositories: [], localRepositoriesAvailable: true } as never
    const catalog = Array.from({ length: 40 }, (_entry, index) => ({
      name: `ns${index % 4}.command-${index}`,
      summary: `Does the ${index}th thing, in a sentence long enough to be worth keeping`,
      args: "<one> [two] [three]"
    }))
    // The two renderings the budget chooses between, measured through the public seam.
    const atStage0 = bytes(smithersInstructions(catalog, honesty, [], { lastStage: 0, budgetBytes: 0 }))
    const atStage1 = bytes(smithersInstructions(catalog, honesty, [], { lastStage: 1, budgetBytes: 0 }))
    // Dropping the grammars is what buys the room; without that, stage 1 is stage 0.
    expect(atStage0).toBeGreaterThan(atStage1)

    const text = smithersInstructions(catalog, honesty, [], { budgetBytes: atStage1 })
    expect(instructionStageOf(text)).toBe(1)
    expect(bytes(text)).toBeLessThanOrEqual(atStage1)
    // Every command keeps its name AND its summary — only the grammar left.
    for (const command of catalog) {
      expect(text).toContain(`- /${command.name} — ${command.summary}`)
    }
    expect(text).not.toContain("<one>")
    expect(text).not.toContain("[three]")
  })

  test("a catalog too large for the budget degrades in stages and never drops a command's name", () => {
    const honesty = { github: { connected: false, login: null, repositories: null }, localRepositories: [], localRepositoriesAvailable: true } as never
    const many = Array.from({ length: 400 }, (_entry, index) => ({
      name: `ns${index % 12}.command-${index}`,
      summary: `Does the ${index}th thing, at length, so that the catalog alone outgrows the budget many times over`,
      args: "<one> [two] [three]"
    }))
    const text = smithersInstructions(many, honesty, [], { lastStage: 2 })
    expect(bytes(text)).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET_BYTES + 4096)
    expect(text).toContain("Commands, by namespace")
    expect(instructionStageOf(text)).toBe(2)
    for (const command of many.slice(0, 20)) expect(text).toContain(`/${command.name}`)
    // A small catalog keeps every argument grammar.
    const small = smithersInstructions(many.slice(0, 5), honesty)
    expect(small).toContain("<one> [two] [three]")
    expect(instructionStageOf(small)).toBe(0)
    // The floor: a budget the namespace list cannot meet leaves the namespaces and their counts, every name behind the list action.
    const floor = smithersInstructions(many, honesty, [], { budgetBytes: 4096 })
    expect(instructionStageOf(floor)).toBe(3)
    expect(floor).toContain("Commands: 400, in these namespaces")
    expect(floor).toContain("ns0 (34)")
    expect(floor).not.toContain("/ns0.command-0")
    expect(bytes(floor)).toBeLessThan(bytes(text))
  })
})
