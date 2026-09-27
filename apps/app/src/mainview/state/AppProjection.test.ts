import { describe,expect,test } from "bun:test"
import { appProjectionHash } from "./AppEventStream"
import {
APP_PROJECTION_COLLECTION_NAMES,APP_PROJECTION_SCHEMAS,APP_TRANSITION_TYPES,
appProjectionKey,appTransitionErasesPrivateState,emptyAppProjection,projectAppEvent,seedAppProjection,
type AppProjectionSnapshot
} from "./AppProjection"
import type { ConfiguredModel,ModelTestRecord } from "@smthrs/rpc/ConfiguredModel"
import type { AppTransition,Card,CloudWorkspaceInput } from "./AppState"
import { cardFrameId,DEFAULT_BRANCH_ID,parseRepoSelection,repoKeyOf } from "./AppState"
import type { RepositoryNotification } from "./RepositoryNotifications"
import { workspaceCardFacts } from "./WorkspaceViews"

const boot = () => seedAppProjection(emptyAppProjection(), { createdAt: 100, theme: "dark" })
const apply = (state: AppProjectionSnapshot, transition: AppTransition, createdAt = 200): AppProjectionSnapshot =>
  projectAppEvent(state, { transition, createdAt, revision: state.sessions[0]!.revision + 1, persistenceMode: "memory" })
const freeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}
const fileCard: Card = {
  id: "file-a", kind: "file", title: "First view", status: "active", createdAt: 10, ordinal: 1,
  payload: { repo: "org/repo", path: "a.ts", content: "one", truncated: false, line: 3 }
}
const gate: Card = {
  id: "approval-1", kind: "approval", title: "Read the file?", status: "active", createdAt: 10, ordinal: 2,
  payload: { capability: "fs:read", detail: "Read a.ts", runId: "run-1", requestId: "gate-1",
    approval: { target: { _tag: "Node", runId: "run-1", requestId: "gate-1" }, scope: "run", idempotencyKey: "gate" } }
}
const notification: RepositoryNotification = {
  id: "notice", scope: "github:alice", repo: "org/repo", source: "github", sourceId: "3", kind: "issue",
  title: "Fix greeting", state: "open", updatedAt: "2026-09-10T00:00:00Z", version: "v1", tags: [], processedAt: 100
}
const observed: AppTransition = { type: "repo.update.observed", actor: "system", context: {
  id: "context", scope: "github:alice", data: { repo: "org/repo", checkedAt: 100, openIssues: 1,
    openPrs: 0, problems: [], items: [], truncated: false }
}, notifications: [notification] }
const workspace: CloudWorkspaceInput = {
  id: "computer", repoId: "org/repo", name: "Computer", status: "running", targetBookmark: "main",
  provisioningStage: null, suspendedAt: null, createdAt: null, head: { changeId: "change", commitId: "commit" }
}

describe("pure app event projection", () => {
  test("removing a maximized card clears its navigation and retained live views", () => {
    let state = apply(boot(), { type: "card.upsert", actor: "user", card: fileCard })
    state = apply(state, { type: "card.maximized", actor: "user", id: fileCard.id })
    const frame = state.frames.find(frame => frame.cardId === fileCard.id)!
    expect(state.sessions[0]!.activeFrameId).toBe(frame.id)
    state = apply(state, { type: "card.removed", actor: "user", id: fileCard.id })
    expect(state.sessions[0]!.maximizedCardId).toBeNull()
    expect(state.sessions[0]!.activeFrameId).not.toBe(frame.id)
    expect(state.frames.some(frame => frame.cardId === fileCard.id)).toBe(false)
    expect(state.cardHistories.some(history => history.id === fileCard.id)).toBe(false)
    expect(state.frames.some(frame => frame.snapshot?.cards.some(card => card.id === fileCard.id))).toBe(false)
  })

  test("retry removes only the retried turn's tool acts", () => {
    let state = boot()
    for (const turnId of ["earlier", "retry"]) {
      state = apply(state, { type: "message.submitted", actor: "user", turnId, text: turnId })
      state = apply(state, { type: "message.tool.executed", actor: "smithers", turnId, text: `act ${turnId}`, answersTurn: true })
      state = apply(state, { type: "message.response.failed", actor: "system", turnId, message: "upstream unavailable" })
    }
    expect(state.messages.filter(message => message.act)).toHaveLength(2)
    state = apply(state, { type: "message.retried", actor: "user", turnId: "retry" })
    expect(state.messages.filter(message => message.act).map(message => message.text)).toEqual(["act earlier"])
    expect(state.messages.filter(message => message.role === "user").map(message => message.text)).toEqual(["earlier", "retry"])
  })

  test("owns exactly the domain roster and its stable keys", () => {
    expect(APP_PROJECTION_COLLECTION_NAMES).toHaveLength(42)
    expect(Object.keys(emptyAppProjection())).toEqual(Object.keys(APP_PROJECTION_SCHEMAS))
    expect(APP_PROJECTION_COLLECTION_NAMES).not.toContain("appEvents")
    expect(appProjectionKey("githubAppStatuses", { repo: "org/repo" })).toBe("org/repo")
    expect(appProjectionKey("cards", fileCard)).toBe(fileCard.id)
    expect(() => appProjectionKey("cards", { repo: "org/repo" })).toThrow("projection key")
    expect(APP_TRANSITION_TYPES["card.navigated"]).toBe(true)
  })

  test("late prepared runtime views update only their historical destination and pin its projection revision", () => {
    let state = apply(boot(), { type: "card.upsert", actor: "user", card: fileCard })
    const pending: Card = { id: fileCard.id, kind: "status", title: "Loading run", status: "active", createdAt: 10, ordinal: 1,
      viewKey: "run-a", loading: true, payload: {} }
    state = apply(state, { type: "card.navigated", actor: "user", card: pending })
    state = apply(state, { type: "card.history.moved", actor: "user", id: fileCard.id, delta: -1 })
    const loaded: Card = { ...pending, kind: "run-trace", title: "Run", loading: false, payload: {
      repo: "org/repo", runId: "run-a", workflow: "Test", phase: "running", steps: [], result: null, lastSeq: 0
    } }
    const previous = freeze(state)
    const next = apply(previous, { type: "card.view.loaded", actor: "system", card: loaded })
    expect(next.cards[0]!.kind).toBe("file")
    expect(next.cards[0]!.loading).toBeUndefined()
    expect(next.cardHistories[0]!.entries[1]).toMatchObject({ kind: "run-trace", loading: false,
      runtimeView: { version: 1, revision: next.sessions[0]!.revision } })
    expect(appProjectionHash(apply(previous, { type: "card.view.loaded", actor: "system", card: loaded }))).toBe(appProjectionHash(next))
  })

  test("seed, local observations and domain replay use only supplied clocks", () => {
    const now = Date.now
    let initial!: AppProjectionSnapshot, projected!: AppProjectionSnapshot
    try {
      Date.now = () => { throw new Error("ambient clock read") }
      initial = boot()
      projected = apply(initial, { type: "repo.pinned", actor: "user", pin: {
        id: "local:/work/repo", name: "Repo", path: "/work/repo", branch: "main", origin: "local", pinnedAt: 111
      } }, 222)
      projected = apply(projected, { type: "theme.changed", actor: "user", theme: "light" }, 333)
    } finally { Date.now = now }
    expect(initial.cloudSessions[0]!.updatedAt).toBe(100)
    expect(initial.identitySessions[0]!.updatedAt).toBe(100)
    expect(initial.worldDocuments).toEqual([])
    expect(initial.workspaces[0]!.createdAt).toBe(100)
    expect(projected.workingCopies[0]!.updatedAt).toBe(222)
    expect(projected.sessions[0]!.theme).toBe("light")
    expect(projected.transitions.map(row => row.createdAt)).toEqual([222, 333])
  })

  test("a representative transcript stream is deterministic and leaves its inputs untouched", () => {
    const events: AppTransition[] = [
      { type: "composer.changed", actor: "user", draft: "Hello" },
      { type: "message.submitted", actor: "user", turnId: "t1", text: " Hello " },
      { type: "message.response.delta", actor: "smithers", turnId: "t1", channel: "reasoning", delta: "Thinking" },
      { type: "message.response.delta", actor: "smithers", turnId: "t1", channel: "text", delta: "Hi" },
      { type: "message.response.delta", actor: "smithers", turnId: "t1", channel: "text", delta: " there" },
      { type: "message.response.completed", actor: "smithers", turnId: "t1" },
      { type: "card.upsert", actor: "system", card: fileCard },
      { type: "card.updated", actor: "smithers", id: fileCard.id, patch: { payload: { line: undefined } } },
      observed,
      { type: "notifications.read", actor: "user", receipts: [{ id: notification.id, version: notification.version }] },
      { type: "workspace.updated", actor: "system", workspace },
      { type: "repo.selected", actor: "user", id: "org/repo#workspace:computer" }
    ]
    const initial = freeze(boot()), before = structuredClone(initial)
    const input = freeze(events), originalEvents = structuredClone(events)
    const replay = () => input.reduce((state, event, index) => apply(state, event, 1000 + index), initial)
    const first = replay(), second = replay()
    expect(first).toEqual(second)
    expect(initial).toEqual(before)
    expect(events).toEqual(originalEvents)
    expect([...first.messages].sort((a, b) => a.ordinal - b.ordinal).map(row => row.text)).toEqual(["Hello", "Hi there"])
    expect(first.messages.find(row => row.role === "smithers")!.reasoning).toBe("Thinking")
    expect(first.sessions[0]).toMatchObject({ phase: "idle", activeRepoKey: "org/repo#workspace:computer", revision: events.length })
    expect(first.repositoryNotifications[0]!.readVersion).toBe("v1")
    const payload = first.cards[0]!.payload
    expect("line" in payload && payload.line).toBeUndefined()
    expect(Object.hasOwn(payload, "line")).toBe(true)
    expect([...first.transitions].sort((a, b) => a.revision - b.revision).map(row => row.actor)).toEqual(events.map(event => event.actor))
    expect(first.connectors).toBe(initial.connectors)
  })

  test("writes are detached from mutable event payloads", () => {
    const event: AppTransition = { type: "card.upsert", actor: "system", card: structuredClone(fileCard) }
    const next = apply(boot(), event)
    event.card.title = "Caller changed its input"
    if (event.card.kind === "file") event.card.payload.content = "changed"
    expect(next.cards[0]!.title).toBe("First view")
    expect(next.cards[0]!.payload).toMatchObject({ content: "one" })
  })

  test("refused events preserve the same snapshot and cannot leak tentative writes", () => {
    const state = apply(boot(), { type: "card.upsert", actor: "system", card: gate })
    const refused: AppTransition[] = [
      { type: "message.submitted", actor: "user", turnId: "t1", text: "  " },
      { type: "card.updated", actor: "smithers", id: gate.id, patch: { title: "Untrusted wording" } },
      { type: "repo.selected", actor: "user", id: "missing/repo" },
      { type: "repo.update.published", actor: "smithers", card: gate, notifications: [notification] } as unknown as AppTransition
    ]
    for (const event of refused) expect(apply(state, event)).toBe(state)
    expect(state.repositoryNotifications).toEqual([])
  })

  test("the reducer rejects gaps, unknown transitions and invalid payload writes", () => {
    const state = freeze(boot())
    const context = { revision: 1, createdAt: 10, persistenceMode: "memory" as const }
    expect(() => projectAppEvent(state, { ...context, revision: 2,
      transition: { type: "composer.changed", actor: "user", draft: "hello" } })).toThrow("projected revision")
    expect(() => projectAppEvent(state, { ...context,
      transition: { type: "future.unknown", actor: "user" } as unknown as AppTransition })).toThrow("Unknown app transition")
    expect(() => apply(state, { type: "card.upsert", actor: "system",
      card: { ...fileCard, payload: {} } as Card })).toThrow()
    expect(state.sessions[0]!.revision).toBe(0)
  })

  test("card history retains provenance and frame snapshots remain historical", () => {
    let state = apply(boot(), { type: "card.upsert", actor: "system", card: fileCard })
    state = apply(state, { type: "card.maximized", actor: "user", id: fileCard.id })
    const frameId = cardFrameId(DEFAULT_BRANCH_ID, fileCard.id)
    const captured = structuredClone(state.frames.find(row => row.id === frameId)!.snapshot)
    state = apply(state, { type: "card.navigated", actor: "user", card: { ...fileCard, title: "Second view" } })
    expect(state.cardHistories[0]!.entries.map(row => row.title)).toEqual(["First view", "Second view"])
    expect(state.cards[0]).toMatchObject({ createdAt: 10, ordinal: 1, navigation: { index: 1, length: 2 } })
    state = apply(state, { type: "card.history.moved", actor: "user", id: fileCard.id, delta: -1 })
    expect(state.cards[0]!.title).toBe("First view")
    expect(state.frames.find(row => row.id === frameId)!.snapshot).toEqual(captured)
  })

  test("workspace selection folds backend observations without consulting a live query", () => {
    let state = apply(boot(), { type: "workspace.updated", actor: "system", workspace })
    expect(state.workingCopies).toEqual([])
    state = apply(state, { type: "repo.selected", actor: "user", id: "org/repo#workspace:computer" })
    expect(state.sessions[0]!.activeRepoKey).toBe("org/repo#workspace:computer")
    const card: Card = { id: "workspace-computer", kind: "workspace", title: "Computer", status: "active", createdAt: 1, ordinal: 1,
      payload: { ...workspaceCardFacts(workspace), bookmarkHead: null, sessions: [], files: [], facet: "files" } }
    state = apply(state, { type: "card.upsert", actor: "system", card })
    state = apply(state, { type: "card.maximized", actor: "user", id: card.id })
    const frameId = cardFrameId(DEFAULT_BRANCH_ID, card.id)
    state = apply(state, { type: "workspace.updated", actor: "system", workspace: { ...workspace, name: "New name" } })
    expect(state.cloudWorkspaces[0]!.name).toBe("New name")
    expect(state.frames.find(row => row.id === frameId)!.snapshot!.cards[0]!.payload).toMatchObject({ name: "Computer", snapshot: true })
  })

  test("a repository can be selected through the shared grammar", () => {
    expect(parseRepoSelection("smithersai/hello-server")).toEqual({ repoId: "smithersai/hello-server" })
    expect(parseRepoSelection("practice:smithersai/hello-server")).toBeNull()
    const observed = apply(boot(), { type: "repositories.loaded", actor: "system", repositories: [
      { id: "smithersai/hello-server", org: "smithersai", name: "hello-server", ownerKind: "user", head: null }
    ] })
    expect(apply(observed, { type: "repo.selected", actor: "user", id: "smithersai/hello-server" }).sessions[0]!.activeRepoKey).toBe("smithersai/hello-server")
  })

  test("approval authority survives presentation attacks and answers cannot be replayed twice", () => {
    const empty = boot()
    expect(apply(empty, { type: "card.upsert", actor: "smithers", card: gate })).toBe(empty)
    let state = apply(empty, { type: "card.upsert", actor: "system", card: gate })
    state = apply(state, { type: "card.approval.decided", actor: "user", id: gate.id, decision: "approved", decidedAt: 300 })
    expect(state.cards[0]!.payload).toMatchObject({ decision: "approved", decidedAt: 300 })
    expect(state.approvalRequests[0]!.payload).not.toHaveProperty("decision")
    expect(apply(state, { type: "card.upsert", actor: "system", card: gate })).toBe(state)
    expect(apply(state, { type: "card.approval.decided", actor: "user", id: gate.id, decision: "denied", decidedAt: 400 })).toBe(state)
  })

  test("account clearing erases histories and repository observations as well as the live transcript", () => {
    let state = apply(boot(), observed)
    state = apply(state, { type: "card.upsert", actor: "system", card: fileCard })
    state = apply(state, { type: "card.navigated", actor: "user", card: { ...fileCard, title: "Private second view" } })
    const old = state
    state = apply(state, { type: "identity.session.cleared", actor: "user" }, 900)
    for (const name of ["cards", "messages", "cardHistories", "repositoryContexts", "repositoryNotifications"] as const) {
      expect(state[name]).toEqual([])
    }
    expect(state.cloudSessions[0]!.updatedAt).toBe(900)
    expect(state.worldDocuments).toEqual(old.worldDocuments)
    expect(state.transitions).toHaveLength(1)
    expect(old.cardHistories).toHaveLength(1)
  })

  test("observed sign-in answers restored prompts while preserving their recorded history", () => {
    let state = apply(boot(), { type: "message.appended", actor: "system", text: "Sign in to continue",
      action: { flow: "auth.sign-in", label: "Sign in" } })
    const prompt = state.messages.at(-1)!
    const before = state.sessions[0]!
    state = apply(state, { type: "conversation.cleared", actor: "user", branchId: "next-conversation", notes: [] })
    const archive = state.branches.find(row => row.id === before.activeBranchId)!.snapshot!
    const signedIn: AppTransition = { type: "identity.session.loaded", actor: "system", state: "signed-in",
      login: "alice", allowlisted: true, admin: false, scopesPlain: null }
    expect(appTransitionErasesPrivateState(state, signedIn)).toBe(false)
    state = apply(state, signedIn, 450)
    expect(state.identitySessions[0]!.sessionObservation).toEqual({ at: 450, revision: 3 })
    state = apply(state, { type: "frame.navigated", actor: "user", workspaceId: before.activeWorkspaceId!,
      branchId: before.activeBranchId!, frameId: before.activeFrameId! })
    expect(state.messages.find(row => row.id === prompt.id)).toMatchObject({ action: undefined,
      answeredAction: { answer: "Signed in with GitHub as @alice.", answeredAt: 450 } })
    expect(state.branches.find(row => row.id === before.activeBranchId)!.snapshot).toEqual(archive)
    expect(archive.messages.find(row => row.id === prompt.id)!.action).toBeDefined()
    expect(appTransitionErasesPrivateState(state, { ...signedIn, login: "bob" })).toBe(true)
    expect(appTransitionErasesPrivateState(state, { ...signedIn, state: "unavailable", login: null })).toBe(false)
  })

  test("toast progress updates only running notifications and preserves their action", () => {
    const progress = { type: "toast.progressed", actor: "system", key: "desktop", detail: "Booting · 8s elapsed", title: "Starting" } as const
    let state = apply(boot(), progress, 100)
    expect(state.toasts).toEqual([])
    state = apply(state, { type: "toast.shown", actor: "system", key: "desktop", title: "Desktop",
      action: { flow: "workspace.view", args: "ws-1", label: "Open details" } }, 200)
    state = apply(state, progress, 300)
    expect(state.toasts[0]).toMatchObject({ title: "Starting", detail: progress.detail, updatedAt: 300, createdAt: 200,
      action: { flow: "workspace.view", args: "ws-1", label: "Open details" } })
    state = apply(state, { ...progress, title: undefined, detail: "Activating" }, 350)
    expect(state.toasts[0]!.title).toBe("Starting")
    for (const status of ["ok", "failed", "cancelled"] as const) {
      state = apply(state, { type: "toast.resolved", actor: "system", key: "desktop", status, detail: "Settled" }, 400)
      const settled = state.toasts[0]
      state = apply(state, progress, 500)
      expect(state.toasts[0]).toEqual(settled)
    }
  })

  test("cloud observations answer prompts only with sufficient scopes and toast reuse clears its old answer", () => {
    let state = apply(boot(), { type: "message.appended", actor: "system", text: "Connect Cloud",
      action: { flow: "cloud.sign-in", label: "Sign in" } })
    state = apply(state, { type: "toast.shown", actor: "system", key: "auth", title: "Sign in" })
    state = apply(state, { type: "toast.resolved", actor: "system", key: "auth", status: "failed", detail: "Needs sign in",
      action: { flow: "cloud.sign-in", label: "Sign in" } })
    const cloud: AppTransition = { type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "alice",
      expiresAt: null, scopes: "degraded" }
    state = apply(state, cloud)
    expect(state.messages[0]!.action).toBeDefined()
    state = apply(state, { ...cloud, scopes: null }, 500)
    expect(state.messages[0]!.answeredAction).toMatchObject({ answer: "Signed in to Smithers Cloud as @alice.", answeredAt: 500 })
    expect(state.toasts[0]!.answeredAction).toBeDefined()
    state = apply(state, { type: "toast.shown", actor: "system", key: "auth", title: "New task" })
    expect(state.toasts[0]!.answeredAction).toBeUndefined()
  })

  test("boot expires process-lifetime observations, while retained state and migration stay deterministic", () => {
    let state = apply(boot(), { type: "repo-tree.loaded", actor: "system", copyId: "local:/repo", path: "", entries: [], truncated: false })
    state = apply(state, { type: "repository-flows.loaded", actor: "system", repo: "org/repo", flows: [
      { id: "flow", description: "A flow", summary: null, featured: false, modelInvocable: true }
    ] })
    expect(state.repoTree).toHaveLength(1)
    const seeded = seedAppProjection(freeze(state), { createdAt: 500, theme: "light" })
    expect(seeded.repoTree).toEqual([])
    expect(seeded.repositoryFlows).toEqual([])
    expect(seeded.worldDocuments).toBe(state.worldDocuments)
    expect(seeded.sessions[0]!.theme).toBe("dark")
    expect(seedAppProjection(state, { createdAt: 500, theme: "light" })).toEqual(seeded)
  })

  test("reset clears the explicit projection roster and can be booted again", () => {
    let state = apply(boot(), { type: "card.upsert", actor: "system", card: fileCard })
    state = apply(state, { type: "app.reset", actor: "user" })
    for (const name of APP_PROJECTION_COLLECTION_NAMES) {
      if (name !== "sessions" && name !== "transitions") expect(state[name]).toEqual([])
    }
    expect(state.sessions[0]).toMatchObject({ theme: "light", revision: 2 })
    state = seedAppProjection(state, { createdAt: 800, theme: "dark" })
    expect(state.tabs).toHaveLength(1)
    expect(state.frames).toHaveLength(1)
    expect(state.cloudSessions[0]!.updatedAt).toBe(800)
    expect(state.worldDocuments).toEqual([])
  })

  test("bounded diagnostics retain the latest event revisions without dropping execution authority", () => {
    let state = apply(boot(), { type: "card.upsert", actor: "system", card: fileCard })
    for (let index = 0; index < 505; index++) state = apply(state, { type: "composer.changed", actor: "user", draft: String(index) }, 1000 + index)
    expect(state.transitions).toHaveLength(500)
    expect(Math.min(...state.transitions.map(row => row.revision))).toBe(7)
    expect(Math.max(...state.transitions.map(row => row.revision))).toBe(506)
    expect(state.cards).toHaveLength(1)
    expect(state.sessions[0]!.draft).toBe("504")
  })

  test("local repository synchronization pins using the supplied event time", () => {
    const repo = APP_PROJECTION_SCHEMAS.repos.parse({ id: "server-1", name: "Repo", path: "/work/repo", git: null, warnings: [], smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "No manifest", workspaces: [] } })
    const state = apply(boot(), { type: "repos.loaded", actor: "system", repos: [repo] }, 678)
    expect(state.pinnedRepos[0]).toMatchObject({ id: repoKeyOf(repo.path), pinnedAt: 678 })
    expect(state.workingCopies[0]).toMatchObject({ updatedAt: 678, revision: 1 })
    expect(state.sessions[0]!.activeRepoKey).toBe(repoKeyOf(repo.path))
  })

  test("physical row ordering cannot change fallback documents, tab selection or interrupted-turn reconciliation", () => {
    const base = boot()
    const document = base.worldDocuments[0]!
    const state: AppProjectionSnapshot = {
      ...base,
      sessions: [{ ...base.sessions[0]!, selectedWorldDocumentId: "removed", activeTabId: "a-tab", phase: "responding", turnId: null }],
      worldDocuments: [{ ...document, id: "z-note" }, { ...document, id: "removed" }, { ...document, id: "a-note" }],
      tabs: [...base.tabs, { id: "z-tab", kind: "card", title: "Z", cardId: "z", ordinal: 1 },
        { id: "a-tab", kind: "card", title: "A", cardId: "a", ordinal: 1 }],
      messages: [
        { id: "message-z-user", role: "user", text: "Z", status: "complete", createdAt: 1, ordinal: 1 },
        { id: "message-a-user", role: "user", text: "A", status: "complete", createdAt: 1, ordinal: 1 },
        { id: "message-z-smithers", role: "smithers", text: "Pending", status: "complete", createdAt: 2, ordinal: 2 }
      ]
    }
    const shuffled = Object.fromEntries(APP_PROJECTION_COLLECTION_NAMES.map(name => [name, [...state[name]].reverse()])) as unknown as AppProjectionSnapshot
    expect(appProjectionHash(shuffled)).toBe(appProjectionHash(state))
    for (const event of [
      { type: "world.document.removed", actor: "user", id: "removed" },
      { type: "tab.closed", actor: "user", id: "a-tab" },
      { type: "session.turn.orphaned", actor: "system" }
    ] as AppTransition[]) expect(appProjectionHash(apply(shuffled, event))).toBe(appProjectionHash(apply(state, event)))
    expect(apply(state, { type: "world.document.removed", actor: "user", id: "removed" }).sessions[0]!.selectedWorldDocumentId).toBe("a-note")
  })
})

describe("models and seats", () => {
  const hosted: ConfiguredModel = { id: "cerebras", protocol: "openai-chat", baseUrl: "https://api.cerebras.ai", modelId: "gpt-oss-120b",
    credential: "CEREBRAS_API_KEY", builtin: true }
  const jev: ConfiguredModel = { id: "jev", protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY", builtin: true }
  const mine: ConfiguredModel = { id: "mine", protocol: "anthropic-messages", modelId: "claude-fable-5", credential: "ANTHROPIC_API_KEY" }
  const passed: ModelTestRecord = { id: "mine", testedAt: 300, result: { ok: true, latencyMs: 412, sample: "ok" } }
  const observe = (state: AppProjectionSnapshot, models: ReadonlyArray<ConfiguredModel>) =>
    apply(state, { type: "models.observed", actor: "system", models })
  const save = (state: AppProjectionSnapshot, model: ConfiguredModel) => apply(state, { type: "model.saved", actor: "user", model })

  test("nothing is seeded: a host that answered nothing shows no model and no seat", () => {
    expect(boot().models).toEqual([])
    expect(boot().seats).toEqual([])
  })

  test("an observation replaces the host's rows in place and never a user's record", () => {
    let state = observe(save(boot(), mine), [hosted, jev])
    expect(state.models.map((row) => row.id).sort()).toEqual(["cerebras", "jev", "mine"])
    state = observe(state, [{ ...hosted, modelId: "qwen-3" }])
    expect(state.models.find((row) => row.id === "cerebras")).toEqual({ ...hosted, modelId: "qwen-3" })
    expect(state.models.map((row) => row.id).sort()).toEqual(["cerebras", "mine"])
    // A host row spelled with a user's name does not take the record over.
    state = observe(state, [{ ...hosted, id: "mine" }])
    expect(state.models).toEqual([mine])
  })

  test("a host row is marked builtin whatever the transition claimed", () => {
    const { builtin: _builtin, ...unmarked } = hosted
    expect(observe(boot(), [unmarked]).models).toEqual([hosted])
  })

  test("a save never writes a host row, and never marks a user row builtin", () => {
    const state = save(observe(boot(), [hosted]), { ...mine, id: "cerebras" })
    expect(state.models).toEqual([hosted])
    expect(save(boot(), { ...mine, builtin: true }).models).toEqual([mine])
  })

  test("a test is evidence about one route: an edit that moves the route drops it", () => {
    const tested = apply(save(boot(), { ...mine, protocol: "openai-chat", baseUrl: "https://openrouter.ai", path: "/api/v1/chat/completions",
      credential: "OPENROUTER_API_KEY" }), { type: "model.tested", actor: "system", test: passed })
    expect(tested.models[0]!.lastTest).toEqual(passed)
    expect(save(tested, tested.models.map(({ lastTest: _lastTest, ...model }) => model)[0]!).models[0]!.lastTest).toEqual(passed)
    const rerouted = save(tested, mine)
    // The cleared optional fields leave the row; they do not linger from the old route.
    expect(rerouted.models).toEqual([mine])
  })

  test("a test of a model that is gone writes nothing", () => {
    const state = boot()
    expect(apply(state, { type: "model.tested", actor: "system", test: passed }).models).toEqual([])
  })

  test("a seat takes only a model of its kind, and default frees it", () => {
    let state = observe(save(boot(), mine), [jev])
    state = apply(state, { type: "seat.assigned", actor: "user", seat: "front-door", recordId: "mine" })
    state = apply(state, { type: "seat.assigned", actor: "user", seat: "explainer", recordId: "jev" })
    state = apply(state, { type: "seat.assigned", actor: "user", seat: "explainer", recordId: "absent" })
    expect(state.seats).toEqual([])
    state = apply(state, { type: "seat.assigned", actor: "user", seat: "explainer", recordId: "mine" })
    state = apply(state, { type: "seat.assigned", actor: "smithers", seat: "front-door", recordId: "jev" })
    expect(state.seats).toEqual([{ id: "explainer", recordId: "mine" }, { id: "front-door", recordId: "jev" }])
    state = apply(state, { type: "seat.assigned", actor: "user", seat: "explainer", recordId: null })
    expect(state.seats).toEqual([{ id: "front-door", recordId: "jev" }])
  })

  test("removing a model frees every seat it held, and a host row cannot be removed", () => {
    let state = observe(save(boot(), mine), [jev])
    state = apply(state, { type: "seat.assigned", actor: "user", seat: "explainer", recordId: "mine" })
    state = apply(state, { type: "seat.assigned", actor: "user", seat: "recommend", recordId: "jev" })
    state = apply(state, { type: "model.removed", actor: "user", id: "jev" })
    state = apply(state, { type: "model.removed", actor: "user", id: "mine" })
    expect(state.models).toEqual([jev])
    expect(state.seats).toEqual([{ id: "recommend", recordId: "jev" }])
  })

  test("a host that stops serving a model leaves its seat assigned, so the gap can be shown", () => {
    let state = apply(observe(boot(), [jev]), { type: "seat.assigned", actor: "user", seat: "recommend", recordId: "jev" })
    state = observe(state, [])
    expect(state.models).toEqual([])
    expect(state.seats).toEqual([{ id: "recommend", recordId: "jev" }])
  })

  test("reset forgets both", () => {
    let state = apply(save(boot(), mine), { type: "seat.assigned", actor: "user", seat: "explainer", recordId: "mine" })
    state = apply(state, { type: "app.reset", actor: "user" })
    expect([state.models, state.seats]).toEqual([[], []])
  })
})
