/**
 * The shell's state: one immutable snapshot behind `useSyncExternalStore`.
 *
 * No `useEffect` anywhere in the app. Everything that is not derived during
 * render is either an event handler calling an action here, or a module-level
 * subscription (see router.ts). Fetches run in actions and publish a new
 * snapshot when they resolve.
 *
 * Selectors must return a referentially stable slice, so the exposed hooks
 * read one whole field (or a primitive derived from one). `set` notifies every
 * subscriber, and `useSyncExternalStore` re-renders only the components whose
 * slice changed: a streamed token replaces `entries` and nothing else, so a
 * component that reads `draft` does not re-render. `useAppState` is the one
 * exception and belongs only in components that read most of what a turn
 * changes.
 */
import { useSyncExternalStore } from "react"
import type { AppCard, TurnFrame } from "../api.ts"
import * as client from "./client.ts"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type TranscriptEntry =
  | { readonly kind: "message"; readonly id: string; readonly role: "user" | "assistant" | "system"; readonly text: string }
  | { readonly kind: "cell"; readonly id: string; readonly ordinal: number; readonly source: string }
  | {
      readonly kind: "call"
      readonly id: string
      readonly flow: string
      readonly input: unknown
      readonly outcome: "success" | "failure"
      readonly message?: string
    }
  | { readonly kind: "card"; readonly id: string; readonly cardId: string }

export type TurnStatus = "idle" | "streaming" | "error"

export interface AppState {
  /** Current route path, e.g. "/build". Owned here so pages derive during render. */
  readonly route: string
  readonly sidebarCollapsed: boolean
  readonly search: string
  /** The Recent column, newest first, as `GET /api/session` returned it. */
  readonly sessions: ReadonlyArray<client.SessionSummary>
  /** Whether a `GET /api/session` read has succeeded, even one that returned nothing. */
  readonly sessionsLoaded: boolean
  /** Whether the latest `GET /api/session` read failed. */
  readonly sessionsFailed: boolean
  readonly sessionId: string
  readonly draft: string
  readonly entries: ReadonlyArray<TranscriptEntry>
  readonly cards: Readonly<Record<string, AppCard>>
  readonly status: TurnStatus
  readonly error: string | undefined
  /** Card id presented as a fullscreen overlay, if any. */
  readonly maximizedCardId: string | undefined
  /** Whether the "Browse all" template drawer is open. */
  readonly templatesOpen: boolean
  /** Composer model label; the Build page's "Aomi" dropdown. */
  readonly model: string
  readonly previewEnabled: boolean
}

// The Worker only accepts a flat identifier of at most 128 characters, and
// never the registry object's name (`worker/guard.ts`). A single
// `Math.random().toString(36)` can be as short as one character, so the
// fallback concatenates until it is 16 wide: a session id is also the only
// thing standing between two browsers and each other's transcript.
const newId = (prefix: string): string => {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid !== undefined) return `${prefix}_${uuid}`
  let random = ""
  while (random.length < 16) random += Math.random().toString(36).slice(2)
  return `${prefix}_${random.slice(0, 16)}`
}

let state: AppState = {
  route: "/build",
  sidebarCollapsed: false,
  search: "",
  sessions: [],
  sessionsLoaded: false,
  sessionsFailed: false,
  sessionId: newId("ses"),
  draft: "",
  entries: [],
  cards: {},
  status: "idle",
  error: undefined,
  maximizedCardId: undefined,
  templatesOpen: false,
  model: "Aomi",
  previewEnabled: false
}

const listeners = new Set<() => void>()

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getSnapshot = (): AppState => state

const set = (next: Partial<AppState>): void => {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export const store = { subscribe, getSnapshot }

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * The whole snapshot. Stable between changes, so destructuring is safe, but
 * the caller re-renders on every change to any field, including each streamed
 * token. Prefer `useField`.
 */
export const useAppState = (): AppState => useSyncExternalStore(subscribe, getSnapshot)

/** One field of the snapshot; the caller re-renders only when that field changes. */
export const useField = <K extends keyof AppState>(key: K): AppState[K] =>
  useSyncExternalStore(subscribe, () => state[key])

/** Whether the transcript has any entry: the Build page's hero-or-thread switch. */
export const useStarted = (): boolean => useSyncExternalStore(subscribe, () => state.entries.length > 0)

export const useRoute = (): string => useSyncExternalStore(subscribe, () => state.route)

/** The Recent column's sessions. */
export const useSessions = (): ReadonlyArray<client.SessionSummary> =>
  useSyncExternalStore(subscribe, () => state.sessions)

export const useTranscript = (): ReadonlyArray<TranscriptEntry> =>
  useSyncExternalStore(subscribe, () => state.entries)

// ---------------------------------------------------------------------------
// Frame reduction
// ---------------------------------------------------------------------------

/** Appends `text` to the trailing assistant message, or opens a new one. */
const appendDelta = (entries: ReadonlyArray<TranscriptEntry>, text: string): ReadonlyArray<TranscriptEntry> => {
  const last = entries[entries.length - 1]
  if (last !== undefined && last.kind === "message" && last.role === "assistant") {
    return [...entries.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...entries, { kind: "message", id: newId("msg"), role: "assistant", text }]
}

/** Folds one frame into the snapshot. Exported for tests. */
export const applyFrame = (previous: AppState, frame: TurnFrame): Partial<AppState> => {
  switch (frame.type) {
    case "delta":
      return { entries: appendDelta(previous.entries, frame.text) }
    case "cell":
      return {
        entries: [...previous.entries, { kind: "cell", id: newId("cell"), ordinal: frame.ordinal, source: frame.source }]
      }
    case "call":
      return {
        entries: [
          ...previous.entries,
          {
            kind: "call",
            id: newId("call"),
            flow: frame.flow,
            input: frame.input,
            outcome: frame.outcome,
            ...(frame.message === undefined ? {} : { message: frame.message })
          }
        ]
      }
    case "card":
      return {
        cards: { ...previous.cards, [frame.card.id]: frame.card },
        entries: [...previous.entries, { kind: "card", id: `card:${frame.card.id}`, cardId: frame.card.id }]
      }
    case "card.update": {
      const known = previous.cards[frame.card.id] !== undefined
      return {
        cards: { ...previous.cards, [frame.card.id]: frame.card },
        entries: known
          ? previous.entries
          : [...previous.entries, { kind: "card", id: `card:${frame.card.id}`, cardId: frame.card.id }]
      }
    }
    case "park":
      return {
        entries: [
          ...previous.entries,
          { kind: "message", id: newId("msg"), role: "system", text: `${frame.reason}: ${frame.message}` }
        ]
      }
    case "done":
      return { status: "idle" }
    case "error":
      return {
        status: "error",
        error: frame.message,
        entries: [...previous.entries, { kind: "message", id: newId("msg"), role: "system", text: frame.message }]
      }
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

let inflight: AbortController | undefined
let loading: AbortController | undefined
let selectionGeneration = 0

const cancelLoad = (): void => {
  loading?.abort()
  loading = undefined
}

const leaveSession = (): void => {
  selectionGeneration += 1
  cancelLoad()
  inflight?.abort()
  inflight = undefined
}

/** How often a running flow re-reads its card, and how long it keeps trying. */
const FLOW_POLL_MS = 750
const FLOW_POLL_TICKS = 320

/** Whether a `flow-run` card has reached a phase that will not change again. */
const isSettled = (card: AppCard | undefined): boolean =>
  card !== undefined && card.kind === "flow-run" && card.phase !== "running" && card.phase !== "waiting-approval"

export const actions = {
  setRoute: (route: string): void => set({ route }),
  setDraft: (draft: string): void => set({ draft }),
  setSearch: (search: string): void => set({ search }),
  setModel: (model: string): void => set({ model }),
  togglePreview: (): void => set({ previewEnabled: !state.previewEnabled }),
  toggleSidebar: (): void => set({ sidebarCollapsed: !state.sidebarCollapsed }),
  openTemplates: (): void => set({ templatesOpen: true }),
  closeTemplates: (): void => set({ templatesOpen: false }),
  maximizeCard: (cardId: string): void => set({ maximizedCardId: cardId }),
  restoreCard: (): void => set({ maximizedCardId: undefined }),

  /** Clears the transcript and starts a fresh session id. */
  newSession: (): void => {
    leaveSession()
    set({ sessionId: newId("ses"), entries: [], cards: {}, draft: "", status: "idle", error: undefined })
  },

  selectSession: (sessionId: string): void => {
    leaveSession()
    set({ sessionId, entries: [], cards: {}, status: "idle", error: undefined })
    void actions.loadSession(sessionId)
  },

  /**
   * Replaces the Recent column from `GET /api/session`.
   *
   * An empty answer is a real answer: a Worker with no runs has an empty
   * column, and showing the last successful read instead would claim sessions
   * that are gone. A failed read keeps whatever is on screen, because a network
   * blip is not a reason to empty the column.
   */
  refreshSessions: async (): Promise<void> => {
    try {
      set({ sessions: await client.listSessions(), sessionsLoaded: true, sessionsFailed: false })
    } catch {
      set({ sessionsFailed: true })
    }
  },

  /** Rehydrates one session's transcript from `GET /api/session?id=`. */
  loadSession: async (sessionId: string): Promise<void> => {
    if (state.sessionId !== sessionId) return
    cancelLoad()
    const controller = new AbortController()
    loading = controller
    const isCurrent = (): boolean =>
      loading === controller && !controller.signal.aborted && state.sessionId === sessionId
    try {
      const session = await client.getSession(sessionId, controller.signal)
      if (!isCurrent() || session.id !== sessionId) return
      const cards: Record<string, AppCard> = {}
      for (const card of session.cards) cards[card.id] = card
      const messages = new Map(session.messages.map((message) => [message.id, message]))
      // Old Workers did not return shared order or card timestamps. Retain
      // their messages-then-cards fallback until the Worker is upgraded.
      const order = session.entries ?? [
        ...session.messages.map((message) => ({ kind: "message" as const, messageId: message.id })),
        ...session.cards.map((card) => ({ kind: "card" as const, cardId: card.id }))
      ]
      const entries = order.flatMap((entry): Array<TranscriptEntry> => {
        if (entry.kind === "card") {
          return cards[entry.cardId] === undefined
            ? []
            : [{ kind: "card", id: `card:${entry.cardId}`, cardId: entry.cardId }]
        }
        const message = messages.get(entry.messageId)
        return message === undefined
          ? []
          : [{ kind: "message", id: message.id, role: message.role, text: message.text }]
      })
      // Cards have no revision timestamp: the same id can hold new HTML or
      // flow progress. Compare the decoded JSON content, retaining unchanged
      // slices so a poll does not remount cards or notify subscribers.
      const sameCards = JSON.stringify(cards) === JSON.stringify(state.cards)
      const sameEntries = JSON.stringify(entries) === JSON.stringify(state.entries)
      const status = session.busy ? "streaming" : "idle"
      if (sameCards && sameEntries && state.status === status && state.error === undefined) return
      set({
        cards: sameCards ? state.cards : cards,
        entries: sameEntries ? state.entries : entries,
        status,
        error: undefined
      })
    } catch (cause) {
      if (!isCurrent()) return
      set({ status: "error", error: client.publicMessage(cause) })
    } finally {
      if (loading === controller) loading = undefined
    }
  },

  /** Posts a turn and folds its NDJSON frames into the transcript. */
  submit: async (message: string, flowId = "chat"): Promise<void> => {
    const text = message.trim()
    if (text.length === 0 || state.status === "streaming") return
    cancelLoad()
    const controller = new AbortController()
    inflight = controller
    set({
      draft: "",
      status: "streaming",
      error: undefined,
      entries: [...state.entries, { kind: "message", id: newId("msg"), role: "user", text }]
    })
    try {
      for await (const frame of client.streamTurn({ sessionId: state.sessionId, flowId, message: text }, controller.signal)) {
        if (inflight !== controller || controller.signal.aborted) return
        set(applyFrame(state, frame))
      }
      if (inflight !== controller || controller.signal.aborted) return
      // Re-read: a `done` or `error` frame may already have settled the turn.
      if (store.getSnapshot().status === "streaming") set({ status: "idle" })
    } catch (cause) {
      if (inflight !== controller) return
      if (controller.signal.aborted) {
        set({ status: "idle" })
      } else {
        const detail = client.publicMessage(cause)
        set({
          status: "error",
          error: detail,
          entries: [...state.entries, { kind: "message", id: newId("msg"), role: "system", text: detail }]
        })
      }
    } finally {
      if (inflight === controller) inflight = undefined
    }
  },

  /**
   * Starts a pipeline flow and follows its `flow-run` card to a settled phase.
   *
   * `POST /api/flows/run` answers with an execution id and nothing else: the
   * run outlives the request and writes its progress into the session as one
   * card that it keeps replacing. There is no stream to read it from, so the
   * card is re-read on a timer until it settles. A poll rather than a socket is
   * the whole cost of the fire-and-forget route, and it is bounded so a run
   * that never settles does not poll forever.
   *
   * TODO(worker): serve the run's `card.update` frames on a stream of their own
   * so this loop becomes a subscription (worker/router.ts, `Routes.flowRun`).
   */
  runFlow: async (flowId: string, payload: unknown): Promise<void> => {
    const sessionId = state.sessionId
    const generation = selectionGeneration
    const isCurrent = (): boolean => state.sessionId === sessionId && selectionGeneration === generation
    let executionId: string
    try {
      executionId = await client.runFlow({ sessionId, flowId, payload })
      if (!isCurrent()) return
    } catch (cause) {
      if (!isCurrent()) return
      set({ status: "error", error: client.publicMessage(cause) })
      return
    }
    for (let tick = 0; tick < FLOW_POLL_TICKS; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, FLOW_POLL_MS))
      // The user moved on. The run keeps going in the Worker; its card is
      // waiting in the session whenever they come back to it.
      if (!isCurrent()) return
      await actions.loadSession(sessionId)
      if (!isCurrent()) return
      if (isSettled(store.getSnapshot().cards[executionId])) return
    }
  },

  /** Stops the streaming turn locally and tells the Worker to drop it. */
  stop: (): void => {
    inflight?.abort()
    inflight = undefined
    set({ status: "idle" })
    void client.cancelTurn(state.sessionId).catch(() => undefined)
  }
}
