import { projectWikiCardRows } from "../WikiProjection"
import { accountOwnerOf } from "../AccountOwner"
import { MODEL_STREAM_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { parseWikilinks, restoreWikilinks } from "@smthrs/ui/vault"
import { DEFAULT_BRANCH_ID, DEFAULT_WORKSPACE_ID, rootFrameId, WIKI_DISPLAY_NAME } from "../AppState"
import type { Card, WorldDocument } from "../AppState"
import type { AppStore } from "../AppStore"
import type { PreparedWikiEdit } from "../../flows/CommandGesture"
import { linkGraphOf, linksOf, neighbourhoodOf, notesOf, resolveLink } from "../../wiki/VaultAdapter"
import { actorSharedState } from "../ActorBindings"
import type { ControllerContext } from "./context"
import { sweepConversation, SweepRequestTooLargeError } from "./ConversationSweep"
import type { SweepNote } from "./ConversationSweep"

const documentPath = (store: AppStore): string => {
  const paths = new Set([...store.collections.worldDocuments.values()].map((document) => document.path))
  let suffix = 1
  while (paths.has(`Untitled ${suffix}.md`)) suffix += 1
  return `Untitled ${suffix}.md`
}

const updateDocumentBody = (document: WorldDocument, body: string) => {
  const restoredBody = restoreWikilinks(body)
  return {
    id: document.id,
    path: document.path,
    title: document.title,
    body: restoredBody,
    links: [...new Set(parseWikilinks(restoredBody).map((link) => link.target).filter(Boolean))],
    tags: document.tags,
    sources: [...new Set([...document.sources, "user:world-editor"])],
    confidence: document.confidence
  }
}

export interface WorldController {
  readonly clearConversation: (options?: { readonly summarize?: boolean }) => Promise<string | void>
  readonly selectWorldDocument: (id: string) => string | void
  readonly changeWorldDocument: (id: string, body: string) => Promise<string | void>
  readonly prepareWorldDocument: (id: string, body: string) => PreparedWikiEdit | undefined
  readonly selectWikiCardDocument: (cardId: string, documentId: string) => string | void
  readonly setWikiCardView: (cardId: string, view: "outline" | "read" | "document") => string | void
  readonly createWorldDocument: () => void
  readonly removeWorldDocument: (id: string) => string | void
  readonly confirmWorldDelete: () => string | void
  readonly cancelWorldDelete: () => void
  /** `wiki.open <path>` embeds the note for either actor and returns its links to the agent. */
  readonly openWorldDocument: (path: string) => string | void | { readonly value: string }
  /** `wiki.backlinks <path>`: the note's link rail as a card, for either actor; the agent also gets the names as the value. */
  readonly showWorldLinks: (path: string) => string | void | { readonly value: string }
  /** `wiki.graph [path]` embeds the graph for either actor and returns its counts to the agent. */
  readonly showWorldGraph: (path?: string) => string | void | { readonly value: string }
  /** The open note's editor, registered by its mount and released on unmount; the seam `wiki.heading` scrolls through. */
  readonly attachWikiEditor: (editor: WikiEditorHandle | null) => void
  /** `wiki.heading <line>`: bring the open note's heading at that source line into view. */
  readonly jumpToHeading: (line: string, cardId?: string) => Promise<string | void>
}

/** What the Wiki pane's editor answers to (the markdown-editor adapter's handle, cut to the one act the pane needs). */
export interface WikiEditorHandle {
  readonly scrollToLine: (line: number) => boolean
}

export const createWorldController = (
  ctx: ControllerContext,
  deps: { readonly nextOrdinal: () => number; readonly cloudWiki?: { readonly scrollEditor?: (id: string, cardId: string, line: number) => boolean; readonly editCloudWiki: (id: string, body: string) => Promise<string | void>; readonly prepareCloudWiki?: (id: string, body: string) => PreparedWikiEdit | undefined; readonly hasIndexedPage?: (id: string) => boolean } }
): WorldController => {
  let pendingClear: AbortController | undefined
  let disposed = false
  ctx.onDispose(() => {
    disposed = true
    pendingClear?.abort()
  })

  // Toasts, unrelated Wiki edits and a re-probe of the same owner must not
  // invalidate a summary. Changes to the conversation or its owner do: never
  // clear unseen input.
  const conversationVersion = (): string =>
    JSON.stringify({
      branch: ctx.store.session().activeBranchId,
      workspace: ctx.store.session().activeWorkspaceId,
      draft: ctx.store.session().draft,
      messages: [...ctx.store.collections.messages.values()],
      cards: [...ctx.store.collections.cards.values()],
      owner: ctx.accountOwner(),
      turn: ctx.activeTurn?.id,
      accountEpoch: ctx.accountEpoch
    })

  const clearConversation: WorldController["clearConversation"] = async (options = {}) => {
    if (disposed) return "This conversation is closed."
    pendingClear?.abort()
    const operation = new AbortController()
    pendingClear = operation
    const summarize = options.summarize === true
    try {
      const outcome = await ctx.withToast(
        "chat.clear",
        summarize ? "Summarizing the conversation…" : "Archiving the conversation…",
        "Conversation archived",
        async () => {
          const version = conversationVersion()
          let notes: SweepNote[] = []
          if (summarize) {
            const identity = ctx.store.collections.identitySessions.get("identity")
            if (identity?.state !== "signed-in" || !identity.allowlisted) {
              return "Sign in to summarize, or run /chat.clear without arguments to archive locally."
            }
            const transcript = ctx.contextMessages()
            if (transcript.length > 0) {
              try {
                notes = await sweepConversation(
                  ctx.http,
                  `${ctx.baseUrl}${MODEL_STREAM_PATH}`,
                  transcript,
                  operation.signal
                )
              } catch (error) {
                if (error instanceof SweepRequestTooLargeError) {
                  return "This conversation is too large for a summary (768 KiB request limit). Nothing was cleared or saved; run /chat.clear without arguments to archive it locally."
                }
                ctx.failures.report("command.boundary", error, "chat.clear")
                return "The summary did not finish; nothing was cleared or saved. Run /chat.clear without arguments to archive locally, or try summarizing again."
              }
            }
          }
          if (operation.signal.aborted || version !== conversationVersion()) {
            return "The conversation changed while I was reviewing it. Nothing was cleared or saved; try again."
          }
          const branchId = `branch-${crypto.randomUUID()}`
          const workspaceId = ctx.store.session().activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
          const previousBranchId = ctx.store.session().activeBranchId ?? DEFAULT_BRANCH_ID
          const accountEpoch = ctx.accountEpoch
          const turn = ctx.activeTurn
          const pumps = [...ctx.runPumps.entries()]
          // Fence the old stream before publishing the optimistic new branch.
          // Do not detach a newer turn that starts while this commit is pending.
          ctx.activeTurn = undefined
          if (turn !== undefined) {
            void Promise.resolve().then(() => ctx.agent.cancelTurn(turn.id)).catch(() => {
              if (
                disposed || ctx.accountEpoch !== accountEpoch || ctx.store.session().activeBranchId !== branchId
              ) return
              void ctx.store.dispatch({
                type: "message.appended",
                actor: "system",
                text: "Stopping the archived turn could not be confirmed by the remote agent."
              }).isPersisted.promise.catch(error => ctx.failures.report("archive.notice", error, branchId))
            })
          }
          try {
            await ctx.store.dispatch({
              type: "conversation.cleared",
              actor: "user",
              branchId,
              notes,
              ...(turn === undefined ? {} : { interruptedTurnId: turn.id })
            }).isPersisted.promise
          } catch {
            if (
              turn !== undefined && ctx.activeTurn === undefined && !disposed &&
              ctx.accountEpoch === accountEpoch && ctx.store.session().activeBranchId === previousBranchId
            ) {
              // The transcript survived, but a stopped live stream cannot be
              // resumed. Mark that distinction if storage can accept a retry.
              await ctx.store.dispatch({
                type: "message.response.cancelled",
                actor: "system",
                turnId: turn.id,
                detail: "This turn stopped while trying to archive the conversation; the archive was not saved."
              }).isPersisted.promise.catch(error => ctx.failures.report("archive.notice", error, branchId))
            }
            return "The archive could not be saved. Your conversation and Wiki notes were not cleared; check local storage and reload before retrying."
          }
          for (const [cardId, pump] of pumps) {
            pump.stopped = true
            if (ctx.runPumps.get(cardId) === pump) ctx.runPumps.delete(cardId)
          }
          if (!disposed && ctx.accountEpoch === accountEpoch && ctx.store.session().activeBranchId === branchId) {
            // The old branch's root is a stable recovery URL, including after reload.
            try {
              ctx.services.frameHistory?.replace({
                workspaceId,
                branchId: previousBranchId,
                frameId: rootFrameId(previousBranchId)
              })
              ctx.services.frameHistory?.push({ workspaceId, branchId, frameId: rootFrameId(branchId) })
            } catch {
              // History is presentation, not the commit point. Its failure
              // must not tell the user that a saved archive failed to save.
              void ctx.store.dispatch({
                type: "message.appended",
                actor: "system",
                text:
                  "The archive was saved, but browser history could not be updated. Use the archive link above to open it."
              }).isPersisted.promise.catch(error => ctx.failures.report("archive.notice", error, branchId))
            }
          }
          return true
        }
      )
      return outcome === true ? undefined : outcome
    } finally {
      if (pendingClear === operation) pendingClear = undefined
    }
  }

  /*
   * A.34: an id-scoped act used to dispatch blindly, so a note id that does
   * not exist was a silent no-op — the reducer dropped it and the human was
   * told nothing. An act names what it could not find.
   */
  const selectWorldDocument = (id: string): string | void => {
    if (ctx.store.collections.worldDocuments.get(id) === undefined && deps.cloudWiki?.hasIndexedPage?.(id) !== true) {
      return `There is no ${WIKI_DISPLAY_NAME} note with id ${id}.`
    }
    ctx.store.dispatch({ type: "world.document.selected", actor: "user", id })
  }

  const prepareWorldDocument = (id: string, body: string): PreparedWikiEdit | undefined => {
    const document = ctx.store.collections.worldDocuments.get(id)
    if (disposed || document === undefined || ctx.commandActor !== "user") return undefined
    if (document.cloud !== undefined) return deps.cloudWiki?.prepareCloudWiki?.(id, restoreWikilinks(body))
    const saved = ctx.store.dispatch({ type: "world.document.upserted", actor: "user",
      document: updateDocumentBody(document, body), select: false }).isPersisted.promise
    void saved.catch(() => {})
    return { complete: async () => { await saved }, release: () => {} }
  }

  const changeWorldDocument = async (id: string, body: string): Promise<string | void> => {
    const document = ctx.store.collections.worldDocuments.get(id)
    if (document === undefined || document.body === body) return
    if (document.cloud !== undefined) return deps.cloudWiki?.editCloudWiki(id, restoreWikilinks(body)) ?? "Refresh this cloud Wiki before editing it."
    await ctx.store.dispatch({ type: "world.document.upserted", actor: ctx.commandActor, document: updateDocumentBody(document, body), select: false }).isPersisted.promise
  }

  const createWorldDocument = (): void => {
    const path = documentPath(ctx.store)
    const title = path.replace(/\.md$/, "")
    ctx.store.dispatch({
      type: "world.document.upserted",
      actor: ctx.commandActor,
      document: {
        id: crypto.randomUUID(),
        path,
        title,
        body: `# ${title}\n\n`,
        links: [],
        tags: [],
        sources: ["user:world-editor"],
        confidence: 1
      }
    })
    openWorldDocument(path)
  }

  /*
   * §10.6 / §28.4 / A.34: deleting a note is not undoable, so `/wiki.delete`
   * ASKS — from the trash button and from the composer alike. It used to
   * delete outright whenever it was typed, because the only confirm lived in
   * a component's local state and the flow bypassed it.
   */
  const removeWorldDocument = (id: string): string | void => {
    if (ctx.store.collections.worldDocuments.get(id) === undefined) {
      return `There is no ${WIKI_DISPLAY_NAME} note with id ${id} to delete.`
    }
    ctx.store.dispatch({ type: "world.delete.asked", actor: ctx.commandActor, id })
  }

  /** The human's answer to that question: yes. */
  const confirmWorldDelete = (): string | void => {
    const id = ctx.store.session().pendingWorldDeleteId ?? null
    if (id === null) return "No note is waiting to be deleted."
    ctx.store.dispatch({ type: "world.document.removed", actor: "user", id })
  }

  /** The human's answer to that question: no. */
  const cancelWorldDelete = (): void => {
    ctx.store.dispatch({ type: "world.delete.asked", actor: "user", id: null })
  }

  /** The one refusal every path-taking wiki flow shares (A.34: an act names what it could not find). */
  const noNote = (path: string): string => `There is no ${WIKI_DISPLAY_NAME} note at ${path}. Create one with wiki.new-note.`

  /*
   * The editor handle is presentation the pane registers; both actor
   * projections of this controller share the one registration.
   */
  const editor = actorSharedState(ctx, "wikiEditor", (): { current: WikiEditorHandle | null } => ({ current: null }))

  const attachWikiEditor = (handle: WikiEditorHandle | null): void => {
    editor.current = handle
  }

  const jumpToHeading = async (line: string, cardId?: string): Promise<string | void> => {
    const wanted = Number.parseInt(line, 10)
    if (!Number.isInteger(wanted) || wanted < 1 || String(wanted) !== line.trim()) return `${line} is not a line number.`
    if (cardId !== undefined) {
      const card = ctx.store.collections.cards.get(cardId)
      if (card?.kind !== "world") return "This Wiki card is no longer available."
      const selected = card.payload.selectedDocumentId ?? card.payload.documents[0]?.id
      const document = selected === undefined ? undefined : ctx.store.collections.worldDocuments.get(selected)
      if (document === undefined) return `No ${WIKI_DISPLAY_NAME} note is open in the editor.`
      if (wanted > document.body.split("\n").length) return `${document.path} has no line ${wanted}.`
      const error = setWikiCardView(cardId, "document")
      if (error) return error
      const epoch = ctx.accountEpoch
      const deadline = Date.now() + 5_000
      while (!disposed && ctx.accountEpoch === epoch && Date.now() < deadline) {
        const current = ctx.store.collections.cards.get(cardId)
        if (current?.kind !== "world" || current.payload.view !== "document" ||
          (current.payload.selectedDocumentId ?? current.payload.documents[0]?.id) !== selected) return
        if (deps.cloudWiki?.scrollEditor?.(document.id, cardId, wanted)) return
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (!disposed && ctx.accountEpoch === epoch) return `The editor for ${document.title} is still loading; try again in a moment.`
      return
    }
    const session = ctx.store.session()
    const selected = session.selectedWorldDocumentId ?? null
    const document = selected === null ? undefined : ctx.store.collections.worldDocuments.get(selected)
    if (document === undefined || session.surface !== "world" || session.wikiPane === "graph") {
      return `No ${WIKI_DISPLAY_NAME} note is open in the editor.`
    }
    if (editor.current === null) return `The editor for ${document.title} is still loading; try again in a moment.`
    if (!editor.current.scrollToLine(wanted)) return `${document.path} has no line ${wanted}.`
  }

  const embed = (card: Omit<Card, "createdAt" | "ordinal" | "status">): void => {
    const existing = ctx.store.collections.cards.get(card.id)
    ctx.store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: { ...card, status: "active", createdAt: existing?.createdAt ?? Date.now(), ordinal: deps.nextOrdinal() } as Card
    })
  }

  /*
   * `wiki.open <path>` embeds one note in the existing world card for either
   * actor. Selection and outline/document view belong to its durable payload.
   */
  const openWorldDocument = (path: string): string | void | { readonly value: string } => {
    const notes = notesOf(ctx.store)
    const document = resolveLink(notes, path)
    if (document === undefined) return noNote(path)
    embed({
      id: `wiki-open-${document.id}`,
      kind: "world",
      title: document.title,
      payload: { documents: [{ id: document.id, path: document.path, title: document.title, confidence: document.confidence }], selectedDocumentId: document.id }
    })
    return { value: `Embedded ${document.path}. ${linkSummary(notes, document.path)}` }
  }

  const selectWikiCardDocument = (cardId: string, documentId: string): string | void => {
    const card = ctx.store.collections.cards.get(cardId)
    const document = ctx.store.collections.worldDocuments.get(documentId)
    if (card?.kind !== "world" || !projectWikiCardRows(card, [...ctx.store.collections.worldDocuments.values()], accountOwnerOf(ctx.store.collections.identitySessions.get("identity"))).some(({ entry }) =>
      entry.id === documentId || (entry.id === undefined && document !== undefined && entry.path === document.path))) return "This Wiki page is not in this card."
    ctx.store.dispatch({ type: "card.updated", actor: ctx.commandActor, id: cardId, patch: { kind: "world", payload: { selectedDocumentId: documentId } } })
  }

  const setWikiCardView = (cardId: string, view: "outline" | "read" | "document"): string | void => {
    const card = ctx.store.collections.cards.get(cardId)
    if (card?.kind !== "world") return "This Wiki card is no longer available."
    ctx.store.dispatch({ type: "card.updated", actor: ctx.commandActor, id: cardId, patch: { kind: "world", payload: { view } } })
  }

  const titled = (notes: ReadonlyArray<WorldDocument>, paths: ReadonlyArray<string>) =>
    paths.map((row) => ({ path: row, title: notes.find((note) => note.path === row)?.title ?? row }))

  const names = (rows: ReadonlyArray<{ readonly title: string }>): string =>
    rows.length === 0 ? "none" : rows.map((row) => row.title).join(", ")

  /** One line the agent can cite: who links here, where it links out, and the targets no note answers. */
  const linkSummary = (notes: ReadonlyArray<WorldDocument>, path: string): string => {
    const links = linksOf(notes, path)
    if (links === undefined) return ""
    const unresolved = links.unresolved.length === 0 ? "none" : links.unresolved.join(", ")
    return `Backlinks: ${names(titled(notes, links.backlinks))}. Links out: ${names(titled(notes, links.linksOut))}. Unresolved: ${unresolved}.`
  }

  /** `wiki.backlinks <path>`: a read, so both actors get the same embedded card; the agent also gets the names. */
  const showWorldLinks = (path: string): string | void | { readonly value: string } => {
    const notes = notesOf(ctx.store)
    const document = resolveLink(notes, path)
    if (document === undefined) return noNote(path)
    const links = linksOf(notes, document.path)
    if (links === undefined) return noNote(path)
    embed({
      id: `wiki-links-${document.id}`,
      kind: "wiki-links",
      title: `Links · ${document.title}`,
      payload: {
        path: document.path,
        title: document.title,
        backlinks: titled(notes, links.backlinks),
        linksOut: titled(notes, links.linksOut),
        unresolved: [...links.unresolved]
      }
    })
    if (ctx.commandActor === "smithers") return { value: `Embedded the links of ${document.path}. ${linkSummary(notes, document.path)}` }
  }

  /*
   * `wiki.graph [path]` embeds the same graph for either actor. A path
   * focuses the note and its neighbours one hop away.
   */
  const showWorldGraph = (path?: string): string | void | { readonly value: string } => {
    const notes = notesOf(ctx.store)
    const wanted = path?.trim() === "" ? undefined : path?.trim()
    const focus = wanted === undefined ? undefined : resolveLink(notes, wanted)
    if (wanted !== undefined && focus === undefined) return noNote(wanted)
      const whole = linkGraphOf(notes)
      const graph = focus === undefined ? whole : neighbourhoodOf(whole, focus.path) ?? whole
      embed({
        id: focus === undefined ? "wiki-graph" : `wiki-graph-${focus.id}`,
        kind: "wiki-graph",
        title: focus === undefined ? `${WIKI_DISPLAY_NAME} graph` : `${WIKI_DISPLAY_NAME} graph · ${focus.title}`,
        payload: {
          path: focus?.path ?? null,
          notes: graph.notes.map((note) => ({
            path: note.path,
            title: note.title,
            linksOut: [...note.linksOut],
            backlinks: [...(note.backlinks ?? [])],
            missing: note.frontmatter?.missing === true
          })),
          links: graph.links.map((link) => ({ source: link.source, target: link.target }))
        }
      })
      const missing = graph.notes.filter((note) => note.frontmatter?.missing === true).map((note) => note.title)
      const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`
      return {
        value: `Embedded the ${WIKI_DISPLAY_NAME} graph${focus === undefined ? "" : ` around ${focus.path}`}: ${
          count(graph.notes.length - missing.length, "note")
        }, ${count(graph.links.length, "link")}, ${count(missing.length, "unresolved target")}${
          missing.length === 0 ? "" : ` (${missing.join(", ")})`
        }.`
      }
  }

  return {
    clearConversation,
    selectWorldDocument,
    changeWorldDocument,
    prepareWorldDocument,
    createWorldDocument,
    removeWorldDocument,
    confirmWorldDelete,
    cancelWorldDelete,
    openWorldDocument,
    showWorldLinks,
    showWorldGraph,
    attachWikiEditor,
    jumpToHeading,
    selectWikiCardDocument,
    setWikiCardView
  }
}
