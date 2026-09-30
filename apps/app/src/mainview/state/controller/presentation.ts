import { identityProviderFor, hasGitHubIdentity } from "../IdentityProvider"
import { TOOLS_BROWSER_FETCH_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { Card,Palette } from "../AppState"
import { conversationTabIdOf,DEFAULT_PALETTE,isPalette,MAIN_TAB_ID,PALETTES,WIKI_DISPLAY_NAME } from "../AppState"
import { THEME_PICKER_CARD_ID } from "../AppStore"
import { parseDiagnosticQuery,readDiagnostics } from "../Diagnostics"
import type { ControllerContext,NetEntry } from "./context"
import { all as allChat, CHAT_KINDS, subagentsFromCards, toggle as toggleChat } from "../ChatTimeline"

export interface PresentationController {
  readonly showChat: () => void
  readonly showWorld: () => void
  /** The Wiki pane beside the chat (#1922): toggles, and reads the shown space's index on opening. */
  readonly showWikiPane: () => void
  readonly showConnectors: () => void
  /** The ctrl+s overview of every subagent beside the chat (#2190): toggles. */
  readonly showSubagents: () => void
  readonly toggleDevtools: () => void
  readonly toggleChatFilterMenu: () => { readonly value: string }
  readonly toggleChatFilter: (target: string) => string | { readonly value: string }
  readonly grepChatFilter: (query: string) => { readonly value: string }
  readonly resetChatFilter: () => { readonly value: string }
  readonly addFiles: () => void
  readonly askReset: () => void
  readonly cancelReset: () => void
  readonly describeAgentBackend: (backend: string) => string | { readonly value: string }
  readonly debugSnapshot: () => { readonly value: string }
  readonly debugEvents: () => { readonly value: string }
  readonly debugErrors: (query?: string) => string | { readonly value: string }
  readonly netTapEntries: () => ReadonlyArray<NetEntry>
  readonly netTap: () => string
  readonly debugNet: () => { readonly value: string }
  readonly debugSeams: () => Promise<string | void | { readonly value: string }>
  readonly openBrowser: (url: string) => Promise<string | void | { readonly value: string }>
  readonly toggleTheme: () => void
  readonly setPalette: (args: string) => string | void
}

export const createPresentationController = (
  ctx: ControllerContext,
  adminHealth: () => Promise<string | void>
): PresentationController => {
  const showChat = (): void => {
    ctx.store.dispatch({ type: "surface.changed", actor: ctx.commandActor, surface: "chat" })
  }

  /*
   * Toggles toggle (§2c): invoking the command for the currently-open pane
   * returns to the chat. And THE EMBED LAW's in-app half (§2c″): the AGENT's
   * invocation renders an embedded card in the transcript instead — a
   * surface-maximizing takeover is structurally unavailable to the model.
   */
  const showWorld = (): void => {
      const snapshot = ctx.store.worldStateSnapshot()
      let highest = -1
      for (const message of ctx.store.collections.messages.values()) highest = Math.max(highest, message.ordinal)
      for (const card of ctx.store.collections.cards.values()) highest = Math.max(highest, card.ordinal)
      const card: Card = {
        id: "world-embedded",
        kind: "world",
        title: WIKI_DISPLAY_NAME,
        status: "active",
        createdAt: Date.now(),
        ordinal: highest + 1,
        payload: {
          documents: snapshot.documents.map((document) => ({
            id: document.id,
            path: document.path,
            title: document.title,
            confidence: document.confidence
          }))
        }
      }
      ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
  }

  const showWikiPane = (): void => {
    const open = ctx.store.session().surface === "world"
    ctx.store.dispatch({ type: "surface.changed", actor: ctx.commandActor, surface: open ? "chat" : "world" })
  }

  /*
   * The overview is a pane of the main conversation. From a worker's or a
   * card's tab, ctrl+s brings the conversation forward with it; only a shown
   * overview closes.
   */
  const showSubagents = (): void => {
    const session = ctx.store.session()
    const mainShown = (session.activeTabId ?? MAIN_TAB_ID) === MAIN_TAB_ID || conversationTabIdOf(session) !== undefined
    if (session.surface === "subagents" && mainShown) {
      ctx.store.dispatch({ type: "surface.changed", actor: ctx.commandActor, surface: "chat" })
      return
    }
    if (!mainShown) ctx.store.dispatch({ type: "tab.selected", actor: ctx.commandActor, id: MAIN_TAB_ID })
    ctx.store.dispatch({ type: "surface.changed", actor: ctx.commandActor, surface: "subagents" })
  }

  const showConnectors = (): void => {
    const identity = ctx.store.collections.identitySessions.get("identity")
    const provider = identityProviderFor(ctx.services)
    const connected = hasGitHubIdentity(identity, provider)
    let highest = -1
    for (const message of ctx.store.collections.messages.values()) highest = Math.max(highest, message.ordinal)
    for (const card of ctx.store.collections.cards.values()) highest = Math.max(highest, card.ordinal)
    const card: Card = {
      id: "connect-embedded",
      kind: "connect",
      title: "Connect work to Smithers",
      status: "active",
      createdAt: Date.now(),
      ordinal: highest + 1,
      payload: {
        provider,
        github: {
          connected,
          login: connected ? identity?.login ?? null : null
        },
        nativeAvailable: false
      }
    }
    ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
  }

  const toggleDevtools = (): void => {
    // The command registers only for admins; the guard keeps the state
    // honest even if a stale binding fires in a non-admin session.
    const identity = ctx.store.collections.identitySessions.get("identity")
    if (identity?.state !== "signed-in" || !identity.admin) return
    ctx.store.dispatch({ type: "devtools.toggled", actor: "user", open: !ctx.store.session().devtoolsOpen })
  }

  const toggleChatFilterMenu = (): { readonly value: string } => {
    const open = ctx.store.session().chatFilterMenuOpen !== true
    ctx.store.dispatch({ type: "chat-filter.menu.toggled", actor: ctx.commandActor, open })
    return { value: open ? "Filter opened." : "Filter closed." }
  }
  const toggleChatFilter = (target: string): string | { readonly value: string } => {
    const subagents = subagentsFromCards([...ctx.store.collections.cards.values()])
    const valid = ["chat", ...subagents.map(subagent => subagent.id), ...CHAT_KINDS]
    if (!valid.includes(target)) return `Choose one of: ${valid.join(", ")}`
    const filter = toggleChat(ctx.store.session().chatFilter ?? allChat, target)
    ctx.store.dispatch({ type: "chat-filter.changed", actor: ctx.commandActor,
      filter: { sources: [...filter.sources], kinds: [...filter.kinds], query: filter.query } })
    return { value: `${target}: ${filter.sources.includes(target) || filter.kinds.includes(target as typeof CHAT_KINDS[number]) ? "hidden" : "shown"}.` }
  }
  const grepChatFilter = (query: string): { readonly value: string } => {
    ctx.store.dispatch({ type: "chat-filter.changed", actor: ctx.commandActor,
      filter: { sources: [...(ctx.store.session().chatFilter?.sources ?? [])], kinds: [...(ctx.store.session().chatFilter?.kinds ?? [])], query } })
    return { value: query === "" ? "Search cleared." : `Search: ${query}` }
  }
  const resetChatFilter = (): { readonly value: string } => {
    ctx.store.dispatch({ type: "chat-filter.changed", actor: ctx.commandActor, filter: { sources: [], kinds: [], query: "" } })
    return { value: "Showing all." }
  }

  /*
   * The `+` menu's first entry. No host exposes a file-attach seam yet (the
   * native RPC surface is exactly pickLocalRepository and openExternal), so
   * the flow answers with the truth instead of a dead picker.
   */
  const addFiles = (): void => {
    ctx.store.dispatch({
      type: "message.appended",
      actor: "system",
      text: "Attachments aren't available on this host yet. Connect a repository and Smithers can read its files."
    })
  }

  const askReset = (): void => {
    if (ctx.store.session().resetConfirmOpen === true) return
    ctx.store.dispatch({ type: "conversation.reset.asked", actor: "user", open: true })
  }

  const cancelReset = (): void => {
    if (ctx.store.session().resetConfirmOpen !== true) return
    ctx.store.dispatch({ type: "conversation.reset.asked", actor: "user", open: false })
  }

  /*
   * The one backend, named once. `/debug.backend` reports it and the manual
   * checklist quotes it, so drift between what runs and what is claimed shows
   * up as a failing row rather than as a confident wrong sentence.
   */
  const AGENT_BACKEND = "http (the host agent over /api/agent/turn)"

  /*
   * DESIGN.md §14: what drives a turn. A read, not a switch — Smithers has one
   * backend, so there is nothing here to flip and an argument is answered
   * honestly rather than silently ignored.
   */
  const describeAgentBackend = (backend: string): string | { readonly value: string } => {
    const asked = backend.trim()
    if (asked !== "") {
      return `there is one backend and it cannot be switched: ${AGENT_BACKEND}`
    }
    const value = `agent backend: ${AGENT_BACKEND}`
    // A backend answer the human cannot see is a backend they cannot trust.
    if (ctx.commandActor !== "smithers") {
      ctx.store.dispatch({ type: "message.appended", actor: "system", text: value })
    }
    return { value }
  }

  /*
   * The debug reads (§2d): one typed surface the dev-tools panel renders and
   * the agent invokes to answer "what is happening" for admin sessions.
   */
  /*
   * A debug read the HUMAN asked for renders in the transcript.
   *
   * `{ value }` is the agent boundary's channel and never renders on its own
   * (§2b), so a read whose only answer is a value is a silent no-op for the
   * person who typed it. `debug.seams` already showed the shape: surface
   * first, return the value second. These four now do the same. The agent's
   * own invocation still renders nothing — it reads the value in its tool
   * result, and pasting the payload into the chat as well would be noise.
   */
  const DEBUG_READ_LIMIT = 4000
  const surfaceDebugRead = (title: string, payload: string): { readonly value: string } => {
    if (ctx.commandActor !== "smithers") {
      const shown = payload.length <= DEBUG_READ_LIMIT
        ? payload
        : `${
          payload.slice(0, DEBUG_READ_LIMIT)
        }\n\n… truncated at ${DEBUG_READ_LIMIT} of ${payload.length} characters. The dev-tools panel (/admin.devtools) holds the whole read.`
      ctx.store.dispatch({
        type: "message.appended",
        actor: "system",
        text: `${title}\n\n\`\`\`json\n${shown}\n\`\`\``
      })
    }
    return { value: payload }
  }

  const debugSnapshot = (): { readonly value: string } => {
    const identity = ctx.store.collections.identitySessions.get("identity")
    const billing = ctx.store.collections.billingAccounts.get("billing")
    return surfaceDebugRead(
      "App state snapshot",
      JSON.stringify({
        surface: ctx.store.session().surface,
        phase: ctx.store.session().phase,
        revision: ctx.store.session().revision,
        messages: ctx.store.collections.messages.size,
        cards: [...ctx.store.collections.cards.values()].map((card) => `${card.kind}:${card.status}`),
        worldDocuments: ctx.store.collections.worldDocuments.size,
        identity: identity === undefined
          ? null
          : { state: identity.state, login: identity.login, admin: identity.admin },
        billing: billing === undefined ? null : { state: billing.state, totalUsd: billing.totalUsd },
        repositories: [...ctx.store.collections.repositories.keys()],
        commands: ctx.commands.entries().map((entry) => ({
          name: entry.binding.descriptor.name,
          trigger: entry.binding.descriptor.modelInvocable ? "both" : "user",
          hidden: entry.metadata.hidden === true
        }))
      })
    )
  }

  const debugEvents = (): { readonly value: string } => {
    const tail = [...ctx.store.collections.transitions.values()]
      .sort((left, right) => left.revision - right.revision)
      .slice(-40)
      .map((record) => ({
        revision: record.revision,
        actor: record.actor,
        type: record.type,
        at: new Date(record.createdAt).toISOString()
      }))
    return surfaceDebugRead("Transition journal tail", JSON.stringify(tail))
  }

  const debugErrors = (query?: string): string | { readonly value: string } => {
    const filters = parseDiagnosticQuery(query)
    if (typeof filters === "string") return filters
    const result = readDiagnostics({
      operations: ctx.failures.recent(),
      transitions: [...ctx.store.collections.transitions.values()],
      toasts: [...ctx.store.collections.toasts.values()],
      toolCalls: [...ctx.store.collections.toolCalls.values()],
      network: ctx.netRing
    }, filters)
    // A human gets a readable transcript answer; the agent receives the bounded structured result.
    if (ctx.commandActor !== "smithers") {
      const lines = result.items.map(item => `${item.at} · ${item.source} · ${item.status}\n${item.title}${item.detail ? `\n${item.detail}` : ""}`)
      ctx.store.dispatch({ type: "message.appended", actor: "system", text: [
        lines.length === 0 ? "No matching errors or notifications in the retained app history." : lines.join("\n\n"),
        ...(result.hasMore ? [`Showing ${result.items.length} of ${result.totalMatching} matching records. Narrow the filters to read more.`] : []),
        result.coverage.note
      ].join("\n\n") })
    }
    return { value: JSON.stringify(result) }
  }

  const netTapEntries = (): ReadonlyArray<NetEntry> => [...ctx.netRing].reverse()

  const netTap = (): string => JSON.stringify(netTapEntries())

  const debugNet = (): { readonly value: string } => surfaceDebugRead("Network tap", netTap())

  const debugSeams = async (): Promise<string | void | { readonly value: string }> => {
    // admin.health is a VIEW over this same read, not a separate path.
    await adminHealth()
    const card = ctx.store.collections.cards.get("admin-health")
    if (card === undefined || card.kind !== "admin-health") {
      return "The seam probe didn't land — see the honest line in the chat."
    }
    return { value: JSON.stringify(card.payload) }
  }

  /*
   * The browser tool + surface (§2d/§2d′): the server-side guarded fetch
   * reads the page; the embedded card shows it (iframe when the site allows
   * framing, the honest blocked state when not). The agent's invocation
   * hands the extracted text back as the tool result — the transcript only
   * ever carries the one-line act ("Smithers read <host>").
   */
  const openBrowserImpl = async (url: string): Promise<true | string | { readonly value: string }> => {
    let outcome:
      | {
        status?: unknown
        finalUrl?: unknown
        text?: unknown
        frameable?: unknown
        blockReason?: unknown
      }
      | undefined
    try {
      const response = await ctx.boundedFetch(`${ctx.baseUrl}${TOOLS_BROWSER_FETCH_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url })
      })
      if (!response.ok) {
        const message = await ctx.errorMessageOf(response, "That page couldn't be read.")
        const card = browserCard(url, { error: message })
        ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
        return message
      }
      outcome = (await response.json().catch(() => undefined)) as typeof outcome
    } catch {
      const message = "That page couldn't be read — the browser service didn't answer."
      ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: browserCard(url, { error: message }) })
      return message
    }
    if (outcome === undefined || typeof outcome.status !== "number") {
      const message = "The browser service answered in a shape I didn't understand."
      ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: browserCard(url, { error: message }) })
      return message
    }
    const card = browserCard(url, {
      finalUrl: typeof outcome.finalUrl === "string" ? outcome.finalUrl : url,
      status: outcome.status,
      frameable: outcome.frameable !== false,
      blockReason: typeof outcome.blockReason === "string" ? outcome.blockReason : null
    })
    ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    const text = typeof outcome.text === "string" ? outcome.text : ""
    if (ctx.commandActor === "smithers") {
      // The read IS the tool result for the model; the card is the surface.
      return { value: text === "" ? `Read ${url} (HTTP ${outcome.status}) — the page had no readable text.` : text }
    }
    return true
  }

  const browserCardId = (url: string): string => `browser-${url}`

  const browserCard = (
    url: string,
    result:
      | { finalUrl: string; status: number; frameable: boolean; blockReason: string | null }
      | { error: string }
  ): Card => {
    const id = browserCardId(url)
    const existing = ctx.store.collections.cards.get(id)
    let highest = -1
    for (const message of ctx.store.collections.messages.values()) highest = Math.max(highest, message.ordinal)
    for (const card of ctx.store.collections.cards.values()) highest = Math.max(highest, card.ordinal)
    const payload: Extract<Card, { kind: "browser" }>["payload"] = "error" in result
      ? { url, finalUrl: null, status: null, frameable: false, blockReason: null, error: result.error }
      : {
        url,
        finalUrl: result.finalUrl,
        status: result.status,
        frameable: result.frameable,
        blockReason: result.blockReason
      }
    return {
      id,
      kind: "browser",
      title: (() => {
        try {
          return new URL(url).host
        } catch {
          return url
        }
      })(),
      status: "error" in result ? "error" : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? highest + 1,
      payload
    }
  }

  const openBrowser = (url: string): Promise<string | void | { readonly value: string }> => {
    let host = url
    try {
      host = new URL(url).host
    } catch {
      // The invalid-URL case is the impl's honest error.
    }
    return ctx.withToast("browser.fetch", `Reading ${host}…`, `Read ${host}`, () => openBrowserImpl(url)).then(
      (outcome) => {
        if (outcome === true) return undefined
        return outcome
      }
    )
  }

  const toggleTheme = (): void => {
    ctx.store.dispatch({
      type: "theme.changed",
      actor: "user",
      theme: ctx.store.session().theme === "dark" ? "light" : "dark"
    })
  }

  /*
   * The color theme (/theme), the axis orthogonal to the light/dark toggle.
   * Which palette to wear is the human's own choice, so an unrecognized key
   * is never rounded to the nearest one: the answer is the list itself, one
   * calm line, and a bare /theme states where they already are.
   */
  const themePickerCard = (): Extract<Card, { kind: "theme-picker" }> | undefined => {
    const card = ctx.store.collections.cards.get(THEME_PICKER_CARD_ID)
    return card?.kind === "theme-picker" ? card : undefined
  }

  /*
   * Bare /theme answers with the picker card, not a sentence: one swatch per
   * palette, each painted in its own colors, upserted to the transcript's
   * tail like the repo chooser. An unrecognized key opens the same picker —
   * the list of valid answers IS the interface.
   */
  const openThemePicker = (selected: Palette): void => {
    const existing = themePickerCard()
    let highest = -1
    for (const message of ctx.store.collections.messages.values()) highest = Math.max(highest, message.ordinal)
    for (const card of ctx.store.collections.cards.values()) highest = Math.max(highest, card.ordinal)
    ctx.store.dispatch({
      type: "card.upsert",
      actor: "user",
      card: {
        id: THEME_PICKER_CARD_ID,
        kind: "theme-picker",
        title: "Color themes",
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: highest + 1,
        payload: { selected }
      }
    })
  }

  const setPalette = (args: string): string | void => {
    const requested = args.trim().toLowerCase()
    const current = ctx.store.session().palette ?? DEFAULT_PALETTE
    if (requested === "") {
      openThemePicker(current)
      return
    }
    if (!isPalette(requested)) {
      openThemePicker(current)
      return `theme needs one of: ${PALETTES.join(", ")}`
    }
    ctx.store.dispatch({ type: "palette.changed", actor: "user", palette: requested })
    // The open picker follows the choice, so its "current" mark stays honest.
    const picker = themePickerCard()
    if (picker !== undefined) {
      ctx.store.dispatch({
        type: "card.upsert",
        actor: "user",
        card: { ...picker, payload: { selected: requested } }
      })
    }
  }

  return {
    showChat,
    showWorld,
    showWikiPane,
    showConnectors,
    showSubagents,
    toggleDevtools,
    toggleChatFilterMenu,
    toggleChatFilter,
    grepChatFilter,
    resetChatFilter,
    addFiles,
    askReset,
    cancelReset,
    describeAgentBackend,
    debugSnapshot,
    debugEvents,
    debugErrors,
    netTapEntries,
    netTap,
    debugNet,
    debugSeams,
    openBrowser,
    toggleTheme,
    setPalette
  }
}
