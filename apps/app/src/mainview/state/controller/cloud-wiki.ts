import type { MarkdownEditorHandle } from "@smthrs/ui/adapters/markdown-editor"
import { parseWikilinks, restoreWikilinks } from "@smthrs/ui/vault"
import { Effect, Fiber, Stream } from "effect"
import {
  CloudWikiError,
  CloudWikiTransport,
  editWikiState,
  makeCloudWikiTransport,
  mergeWikiState,
  wikiDocumentId,
  wikiDocumentPath,
  wikiPagePath,
  wikiStateContains
} from "../../wiki/CloudWiki"
import type { CloudWikiDocument, CloudWikiIndex, WikiSpace } from "../../wiki/CloudWiki"
import type { CloudWikiState } from "../../wiki/CloudWikiState"
import type { CommandGesture, PreparedWikiEdit } from "../../flows/CommandGesture"
import { actorSharedState } from "../ActorBindings"
import type { Card, WikiIndexRow, WorldDocument } from "../AppState"
import { DEFAULT_BRANCH_ID, WIKI_DISPLAY_NAME, wikiIndexRowId } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import type { ControllerContext } from "./context"

/** The space a page row lives in; rows saved before spaces existed were public. */
export const spaceOf = (cloud: Pick<CloudWikiState, "visibility">): WikiSpace => cloud.visibility ?? "public"

/**
 * The live navigation indexes, one per repository and space: what the Wiki
 * pane's tree, the card's tree and the backlinks rail read (the way the
 * Stack views read `stackSnapshots`). A snapshot of the backend's index,
 * replaced whole on every read, never persisted.
 */
export interface WikiIndexStore {
  readonly get: (repo: string, space: WikiSpace) => WikiIndexRow | undefined
  readonly subscribe: (listener: () => void) => () => void
}

/** The index rows as the store keeps them: metadata and backlinks in the app's own names. */
export const wikiIndexOf = (index: CloudWikiIndex): Pick<WikiIndexRow, "pages" | "folders" | "tags"> => ({
  pages: index.pages.map((page) => ({
    id: page.id, slug: page.slug, title: page.title, path: page.path ?? `${page.slug}.md`, revision: page.revision, updatedAt: page.updated_at,
    ...(page.attachment === undefined ? {} : { attachment: { digest: page.attachment.digest, mediaType: page.attachment.media_type, size: page.attachment.size } }),
    tags: page.metadata.tags ?? [], aliases: page.metadata.aliases ?? [], headings: page.metadata.headings ?? [],
    links: (page.metadata.links ?? []).map((link) => ({ target: link.target, embed: link.embed,
      ...(link.heading === undefined ? {} : { heading: link.heading }), ...(link.alias === undefined ? {} : { alias: link.alias }),
      ...(link.page_id === undefined ? {} : { pageId: link.page_id }) })),
    backlinks: (page.backlinks ?? []).map((row) => ({ pageId: row.page_id, path: row.path, embed: row.embed, ...(row.heading === undefined ? {} : { heading: row.heading }) })),
    ...(page.metadata.error === undefined ? {} : { error: page.metadata.error })
  })),
  folders: [...(index.folders ?? [])],
  tags: [...(index.tags ?? [])]
})

type Actor = "user" | "smithers"
type DocumentInput = Omit<WorldDocument, "updatedAt" | "updatedBy" | "revision">
type CloudDocument = WorldDocument & { cloud: CloudWikiState }
const cloudDocument = (value: WorldDocument | undefined): value is CloudDocument => value?.cloud !== undefined

/** A controller scope owns handles and fibers; all document bytes and pending edits belong to TanStack DB. */
export const createCloudWikiController = (ctx: ControllerContext, nextOrdinal: () => number) => {
  const shared = actorSharedState(ctx, "cloudWiki", () => {
    const transport = makeCloudWikiTransport({ http: ctx.http, baseUrl: ctx.baseUrl })
    const watches = new Map<string, { stop: () => void; valid: () => boolean }>()
    const sends = new Map<string, Promise<string | void>>()
    const editors = new Map<string, Map<string, MarkdownEditorHandle>>()
    const clients = new Map<string, number>()
    const preparations = new Set<string>()
    let disposed = false
    let lifetime = new AbortController()
    const branch = () => ctx.store.session().activeBranchId ?? DEFAULT_BRANCH_ID
    const indexes = new Map<string, WikiIndexRow>()
    const indexListeners = new Set<() => void>()
    const wikiIndexes: WikiIndexStore = {
      get: (repo, space) => indexes.get(wikiIndexRowId(repo, space)),
      subscribe: (listener) => { indexListeners.add(listener); return () => { indexListeners.delete(listener) } }
    }
    const notifyIndexes = () => {
      for (const listener of indexListeners) {
        try { listener() } catch (error) { ctx.failures.report("wiki.index.listener", error) }
      }
    }
    const setIndex = (repo: string, space: WikiSpace, answer: Pick<WikiIndexRow, "pages" | "folders" | "tags"> | { readonly error: string; readonly retainMetadata?: boolean }) => {
      const id = wikiIndexRowId(repo, space)
      const existing = "error" in answer && answer.retainMetadata ? indexes.get(id) : undefined
      indexes.set(id, "error" in answer
        ? { id, repo, space, pages: existing?.pages ?? [], folders: existing?.folders ?? [], tags: existing?.tags ?? [], error: answer.error, loadedAt: Date.now() }
        : { id, repo, space, ...answer, loadedAt: Date.now() })
      notifyIndexes()
    }
    const clearIndexes = () => {
      indexes.clear()
      notifyIndexes()
    }
    /** The space the pane shows (session), the default for every door that names none. */
    const space = (): WikiSpace => ctx.store.session().wikiSpace ?? "public"
    const login = () => {
      const identity = ctx.store.collections.identitySessions.get("identity")
      return identity?.state === "signed-in" ? identity.login : null
    }
    const provide = <A, E>(effect: Effect.Effect<A, E, CloudWikiTransport>) =>
      Effect.provideService(effect, CloudWikiTransport, transport)
    const run = <A, E>(effect: Effect.Effect<A, E, CloudWikiTransport>) => {
      changed()
      return Effect.runPromise(provide(effect), { signal: lifetime.signal })
    }
    const persist = (document: DocumentInput, actor: Actor | "system" = "system") =>
      Effect.tryPromise({
        try: () =>
          ctx.store.dispatch({ type: "world.document.upserted", actor, document, select: false }).isPersisted.promise,
        catch: () =>
          new CloudWikiError({ sentence: "The Wiki edit could not be saved locally. Check storage before retrying." })
      })
    const read = (id: string) => {
      const document = ctx.store.collections.worldDocuments.get(id)
      return cloudDocument(document) ? document : undefined
    }
    const setFailure = (id: string, error: CloudWikiError) =>
      Effect.suspend(() => {
        const document = read(id)
        if (document === undefined) return Effect.void
        if (error.status === 401 || error.status === 403) {
          return Effect.uninterruptible(
            Effect.tryPromise({
              try: () =>
                ctx.store.dispatch({ type: "world.document.removed", actor: "system", id }).isPersisted.promise,
              catch: () => new CloudWikiError({ sentence: "Could not clear the revoked Wiki page from local storage." })
            }).pipe(Effect.tap(() => Effect.sync(() => watches.get(id)?.stop())))
          )
        }
        const saved = ctx.store.committedWorldDocument(id)?.cloud
        // An optimistic failure alone is not evidence that it survived storage.
        if (document.cloud.phase === "offline" && document.cloud.error === error.sentence &&
          saved?.phase === "offline" && saved.error === error.sentence &&
          saved.accountLogin === document.cloud.accountLogin && saved.branchId === document.cloud.branchId) return Effect.void
        return persist({ ...document, cloud: { ...document.cloud, phase: "offline", error: error.sentence } })
      })

    const accept = (
      repo: string,
      incoming: CloudWikiDocument,
      owner: string,
      originBranch: string,
      actor: Actor | "system",
      acknowledged?: string
    ) =>
      Effect.gen(function*() {
        const id = wikiDocumentId(repo, incoming.page.id)
        const previous = read(id)
        const previousCloud = previous?.cloud
        const sameScope = previousCloud?.accountLogin === owner && previousCloud.branchId === originBranch
        const pending = sameScope ? previousCloud.pending.filter((item) => item.updateId !== acknowledged) : []
        // A stale response can acknowledge one UUID, but cannot regress a newer bootstrap.
        const newer = sameScope && previousCloud.remoteRevision > incoming.page.revision
        const baseState = newer ? previousCloud.state : incoming.state
        const merged = yield* Effect.try({
          try: () => {
            if (!newer && mergeWikiState(incoming.state).body !== incoming.page.body) {
              throw new Error("State/body mismatch")
            }
            return mergeWikiState(baseState, ...pending.map((item) => item.update))
          },
          catch: () =>
            new CloudWikiError({
              sentence: "The Wiki text and collaborative state disagree. Local edits were retained."
            })
        })
        const slug = newer ? previousCloud.slug : incoming.page.slug
        yield* persist({
          id,
          path: wikiDocumentPath(repo, slug),
          title: newer ? previous!.title : incoming.page.title,
          body: merged.body,
          links: [...new Set(parseWikilinks(merged.body).map((link) => link.target).filter(Boolean))],
          tags: previous?.tags ?? [],
          sources: [`plue:${repo}/wiki/${slug}`],
          confidence: 1,
          cloud: {
            repo,
            pageId: incoming.page.id,
            slug,
            visibility: incoming.page.visibility ?? previousCloud?.visibility ?? "public",
            ...(incoming.page.path === undefined ? previousCloud?.path === undefined ? {} : { path: previousCloud.path } : { path: incoming.page.path }),
            remoteRevision: newer ? previousCloud.remoteRevision : incoming.page.revision,
            remoteAuthor: newer ? previousCloud.remoteAuthor : incoming.page.author.login,
            remoteUpdatedAt: newer ? previousCloud.remoteUpdatedAt : incoming.page.updated_at,
            state: merged.state,
            pending,
            accountLogin: owner,
            branchId: originBranch,
            phase: watches.has(id) ? "live" : "cached",
            error: null
          }
        }, actor)
      })

    const flush = (id: string): Promise<string | void> => {
      const sending = sends.get(id)
      if (sending !== undefined) return sending
      const operationWatch = watches.get(id)
      const operation = Effect.gen(function*() {
        const api = yield* CloudWikiTransport
        while (!disposed) {
          const document = read(id)
          const watch = watches.get(id)
          if (document === undefined || watch?.valid() !== true || watch !== operationWatch) return
          // Optimistic rows may include newer input or an admission write
          // still in storage. Only the committed, admitted prefix may leave.
          const saved = ctx.store.committedWorldDocument(id)?.cloud
          if (saved?.accountLogin !== document.cloud.accountLogin || saved.branchId !== document.cloud.branchId ||
            saved.pageId !== document.cloud.pageId) return
          const pending = saved.pending[0]
          if (pending === undefined || pending.admitted === false) return
          const { cloud } = document
          const answer = yield* api.update(cloud.repo, cloud.slug, cloud.pageId, pending.updateId, pending.update, spaceOf(cloud))
          if (!watch.valid() || watches.get(id) !== watch) return
          if (
            answer.update_id !== pending.updateId || answer.document.page.id !== cloud.pageId ||
            answer.accepted_revision > answer.document.page.revision
          ) {
            return yield* Effect.fail(
              new CloudWikiError({
                sentence: "The Wiki returned an acknowledgement for another edit. Your edit is still pending."
              })
            )
          }
          const contains = yield* Effect.try({
            try: () => wikiStateContains(answer.document.state, pending.update),
            catch: () =>
              new CloudWikiError({
                sentence: "The Wiki returned invalid collaborative state. Your edit is still pending."
              })
          })
          if (!contains) {
            return yield* Effect.fail(
              new CloudWikiError({
                sentence: "The Wiki acknowledgement does not contain this edit. Your edit is still pending."
              })
            )
          }
          yield* accept(cloud.repo, answer.document, cloud.accountLogin, cloud.branchId, "system", pending.updateId)
        }
      }).pipe(Effect.catch((error: CloudWikiError) =>
        Effect.as(
          watches.get(id) === operationWatch && operationWatch?.valid() === true ? setFailure(id, error) : Effect.void,
          error.sentence
        )
      ))
      const promise = run(operation).catch(() => "The Wiki edit could not be saved locally.")
      sends.set(id, promise)
      void promise.finally(() => {
        if (sends.get(id) === promise) sends.delete(id)
      })
      return promise
    }

    const watch = (id: string) => {
      if (watches.get(id)?.valid()) return
      watches.get(id)?.stop()
      const initial = read(id)
      if (initial === undefined) return
      const owner = login()
      const originBranch = branch()
      if (owner === null || initial.cloud.accountLogin !== owner || initial.cloud.branchId !== originBranch) return
      let active = true
      let fiber: Fiber.Fiber<void, never> | undefined
      const handle = {
        valid: () => active && !disposed && login() === owner && branch() === originBranch && read(id) !== undefined,
        stop: () => {
          active = false
          if (watches.get(id) === handle) watches.delete(id)
          if (fiber !== undefined) Effect.runFork(Fiber.interrupt(fiber))
        }
      }
      watches.set(id, handle)
      const program = Effect.gen(function*() {
        const api = yield* CloudWikiTransport
        // Replay is per-page and DB-backed. Reconnection delays never acknowledge an edit.
        while (handle.valid()) {
          const current = read(id)!
          const consume = api.revisions(
            current.cloud.repo,
            current.cloud.slug,
            current.cloud.pageId,
            current.cloud.remoteRevision,
            spaceOf(current.cloud)
          ).pipe(
            Stream.takeUntil(event => event.deleted),
            Stream.runForEach((event) =>
              Effect.gen(function*() {
                if (!handle.valid()) return
                const row = read(id)!
                if (event.revision <= row.cloud.remoteRevision) return
                if (event.deleted) {
                  yield* persist({
                    ...row,
                    cloud: {
                      ...row.cloud,
                      phase: "deleted",
                      error: "This page was deleted. Pending edits were kept locally."
                    }
                  })
                  active = false
                  if (watches.get(id) === handle) watches.delete(id)
                  return
                }
                const incoming = yield* api.read(row.cloud.repo, event.slug, spaceOf(row.cloud))
                if (!handle.valid()) return
                if (incoming.page.id !== row.cloud.pageId) {
                  return yield* Effect.fail(
                    new CloudWikiError({
                      sentence: "The Wiki slug now belongs to another page. Local edits were retained.",
                      status: 409
                    })
                  )
                }
                yield* accept(row.cloud.repo, incoming, owner, originBranch, "system")
              })
            )
          )
          const ended = yield* consume.pipe(
            Effect.as(true),
            Effect.catch((error) => (handle.valid() ? setFailure(id, error) : Effect.void).pipe(Effect.as(false)))
          )
          if (!handle.valid()) return
          if (ended) yield* setFailure(id, new CloudWikiError({ sentence: "Reconnecting to Wiki revisions…" }))
          yield* Effect.sleep("2 seconds")
        }
      }).pipe(Effect.catch(() => Effect.void))
      fiber = Effect.runFork(provide(program))
    }

    const detach = (resetRows = false) => {
      lifetime.abort()
      lifetime = new AbortController()
      for (const handle of watches.values()) handle.stop()
      if (!resetRows) return
      for (const document of ctx.store.collections.worldDocuments.values()) {
        if (document.cloud !== undefined && document.cloud.phase !== "deleted" && document.cloud.phase !== "cached") {
          ctx.store.dispatch({
            type: "world.document.upserted",
            actor: "system",
            select: false,
            document: { ...document, cloud: { ...document.cloud, phase: "cached" } }
          })
        }
      }
    }
    let owner = login()
    let originBranch = branch()
    let accountEpoch = ctx.accountEpoch
    const changed = () => {
      const accountChanged = owner !== login() || accountEpoch !== ctx.accountEpoch
      if (!accountChanged && originBranch === branch()) return
      owner = login()
      originBranch = branch()
      accountEpoch = ctx.accountEpoch
      detach()
      if (accountChanged) clearIndexes()
    }
    const stopAccountChanges = ctx.onAccountChange(changed)
    const identitySubscription = ctx.store.collections.identitySessions.subscribeChanges(changed)
    const sessionSubscription = ctx.store.collections.sessions.subscribeChanges(changed)
    const documentSubscription = ctx.store.collections.worldDocuments.subscribeChanges(() => {
      for (const [id, handles] of editors) {
        const document = ctx.store.collections.worldDocuments.get(id)
        if (document === undefined) continue
        for (const editor of handles.values()) {
          if (restoreWikilinks(editor.getMarkdown()) !== document.body) editor.setMarkdown(document.body)
        }
      }
    })
    detach(true)
    ctx.onDispose(() => {
      disposed = true
      lifetime.abort()
      clearIndexes()
      for (const handle of watches.values()) handle.stop()
      stopAccountChanges()
      identitySubscription.unsubscribe()
      sessionSubscription.unsubscribe()
      documentSubscription.unsubscribe()
      editors.clear()
      preparations.clear()
    })
    return {
      provide,
      run,
      persist,
      read,
      accept,
      flush,
      watch,
      watches,
      editors,
      clients,
      preparations,
      branch,
      space,
      login,
      wikiIndexes,
      setIndex,
      disposed: () => disposed
    }
  })

  /** The repository a wiki door targets: the one named, else the active one. */
  const targetRepo = (repo?: string): string | { readonly error: string } => {
    const target = resolveTargetRepo(ctx.store, repo)
    return "error" in target ? { error: target.error } : target.repo
  }
  const refusal = (error: unknown): string => error instanceof CloudWikiError ? error.sentence : `The ${WIKI_DISPLAY_NAME} request failed.`

  const indexFailure = (error: unknown) => ({
    error: refusal(error),
    retainMetadata: !(error instanceof CloudWikiError) || error.status === undefined ||
      error.status === 408 || error.status === 429 || error.status >= 500
  })

  /**
   * The space's navigation index, read into the collection (`wikiIndexes`).
   * A read the person asked for shows its notice; the background read the
   * pane makes on opening a space is quiet, so only a refusal is stated.
   */
  const indexReads = new Map<string, number>()
  const loadWikiIndex = async (repoArg?: string, spaceArg?: WikiSpace, quiet = true): Promise<string | { value: string }> => {
    const repo = targetRepo(repoArg)
    if (typeof repo !== "string") return repo.error
    const owner = shared.login()
    if (owner === null) return `Sign in to read the repository ${WIKI_DISPLAY_NAME}.`
    const accountEpoch = ctx.accountEpoch
    const originBranch = shared.branch()
    const at = spaceArg ?? shared.space()
    const key = wikiIndexRowId(repo, at)
    const generation = (indexReads.get(key) ?? 0) + 1
    indexReads.set(key, generation)
    const current = () => indexReads.get(key) === generation && !ctx.disposed && !shared.disposed() && ctx.accountEpoch === accountEpoch &&
      shared.login() === owner && shared.branch() === originBranch
    const outcome = await ctx.withToast(`wiki.index.${repo}.${at}`, `Reading the ${at} ${WIKI_DISPLAY_NAME}…`, `${WIKI_DISPLAY_NAME} read`, async () => {
      const answer = await shared.run(Effect.gen(function*() {
        const api = yield* CloudWikiTransport
        return wikiIndexOf(yield* api.index(repo, at))
      }).pipe(Effect.catch((error: CloudWikiError) => Effect.succeed(indexFailure(error))))).catch(indexFailure)
      if (ctx.disposed || shared.disposed()) return "The app closed while the Wiki was loading."
      if (!current()) {
        return "The account or conversation changed while the Wiki was loading."
      }
      if ("error" in answer) {
        shared.setIndex(repo, at, answer)
        return answer.error
      }
      shared.setIndex(repo, at, answer)
      return answer
    }, quiet, current)
    if (typeof outcome === "string") return outcome
    if (!current()) return "The account or conversation changed while the Wiki was loading."
    return { value: `${outcome.pages.length} ${at} ${WIKI_DISPLAY_NAME} page${outcome.pages.length === 1 ? "" : "s"} in ${repo}: ${outcome.pages.map((page) => page.path).join(", ") || "none"}.` }
  }

  /** `wiki.view <read|edit>`: the pane shows the page rendered, or its editor. */
  const setWikiPageView = async (view: string): Promise<string | void> => {
    if (view !== "read" && view !== "edit") return "A Wiki page view is read or edit."
    if ((ctx.store.session().wikiPageView ?? "read") !== view) ctx.store.dispatch({ type: "wiki.page-view.changed", actor: ctx.commandActor, view })
  }

  let paneRead = 0

  const readWikiForPane = async (): Promise<void> => {
    const generation = ++paneRead
    const repo = targetRepo(undefined)
    if (typeof repo !== "string" || shared.login() === null || ctx.store.session().surface !== "world") return
    const space = shared.space()
    const owner = shared.login()
    const epoch = ctx.accountEpoch
    const branch = shared.branch()
    const current = () => generation === paneRead && !ctx.disposed && !shared.disposed() &&
      ctx.accountEpoch === epoch && shared.login() === owner && shared.branch() === branch &&
      ctx.store.session().surface === "world" && shared.space() === space && targetRepo(undefined) === repo
    await loadWikiIndex(repo, space)
    if (!current()) return
    const first = shared.wikiIndexes.get(repo, space)?.pages[0]
    if (first?.attachment !== undefined) {
      ctx.store.dispatch({ type: "world.document.selected", actor: ctx.commandActor, id: wikiDocumentId(repo, first.id) })
    } else if (first !== undefined) {
      try { await openCloudWiki(repo, first.slug, first.id, space, current) }
      catch (error) { if (current()) ctx.failures.report("seam.failure", error, "wiki.pane.read") }
    }
  }

  /** `wiki.space <public|private>`: the pane shows that space, and its index is read. */
  const setWikiSpace = async (spaceArg: string, repoArg?: string): Promise<string | void> => {
    if (spaceArg !== "public" && spaceArg !== "private") return "A Wiki space is public or private."
    if (shared.space() !== spaceArg) ctx.store.dispatch({ type: "wiki.space.changed", actor: ctx.commandActor, space: spaceArg })
    const repo = targetRepo(repoArg)
    if (typeof repo !== "string" || shared.login() === null) return
    ++paneRead
    if (ctx.store.session().surface === "world") void readWikiForPane()
    else void loadWikiIndex(repo, spaceArg)
  }

  const listCloudWiki = async (repo: string, page = 1, spaceArg?: WikiSpace): Promise<string | { value: string }> => {
    const space = spaceArg ?? shared.space()
    const owner = shared.login()
    if (owner === null) return "Sign in to read the repository Wiki."
    if (!Number.isSafeInteger(page) || page < 1) return "Choose a positive Wiki page number."
    try {
      wikiPagePath(repo, "home")
    } catch {
      return "Choose a repository as owner/repo."
    }
    const originBranch = shared.branch()
    return shared.run(
      Effect.gen(function*() {
        const api = yield* CloudWikiTransport
        const pages = yield* api.list(repo, page, space)
        if (
          shared.disposed() || shared.login() !== owner || shared.branch() !== originBranch
        ) return "The account or conversation changed while the Wiki was loading."
        // The listing is the index's page list; the pane's tree reads the navigation index beside it.
        void loadWikiIndex(repo, space)
        const cardId = `wiki-index-${repo}-${space}`
        const previous = ctx.store.collections.cards.get(cardId)
        const card: Card = {
          id: cardId,
          kind: "world",
          title: `Wiki · ${repo}`,
          status: "active",
          createdAt: previous?.createdAt ?? Date.now(),
          ordinal: nextOrdinal(),
          payload: {
            documents: pages.map((item) => ({
              id: wikiDocumentId(repo, item.id),
              path: wikiDocumentPath(repo, item.slug),
              title: item.title,
              confidence: 1,
              cloud: { repo, slug: item.slug, revision: item.revision, visibility: space, accountLogin: owner }
            })),
            index: { repo, page, hasNext: pages.length === 50, space },
            view: "outline"
          }
        }
        yield* Effect.tryPromise({
          try: () => ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card }).isPersisted.promise,
          catch: () => new CloudWikiError({ sentence: "The Wiki index could not be saved locally." })
        })
        return {
          value: `Embedded ${space} Wiki pages for ${repo}: ${
            pages.map((item) => `${item.slug} (revision ${item.revision})`).join(", ") || "none"
          }.`
        }
      }).pipe(Effect.catch((error: CloudWikiError) => Effect.succeed(error.sentence)))
    )
  }

  const openCloudWiki = async (
    repo: string,
    slug: string,
    expectedPageId?: number,
    spaceArg?: WikiSpace,
    isCurrent: () => boolean = () => true
  ): Promise<string | { value: string }> => {
    const space = spaceArg ?? shared.space()
    const owner = shared.login()
    if (owner === null) return "Sign in to read and edit the repository Wiki."
    try {
      wikiPagePath(repo, slug)
    } catch (error) {
      return error instanceof CloudWikiError ? error.sentence : "Invalid Wiki page."
    }
    const originBranch = shared.branch()
    const actor = ctx.commandActor
    return shared.run(
      Effect.gen(function*() {
        const api = yield* CloudWikiTransport
        const incoming = yield* api.read(repo, slug, space)
        if (
          shared.disposed() || shared.login() !== owner || shared.branch() !== originBranch || !isCurrent()
        ) return "The account or conversation changed while the Wiki was loading."
        if (expectedPageId !== undefined && incoming.page.id !== expectedPageId) {
          const oldId = wikiDocumentId(repo, expectedPageId)
          shared.watches.get(oldId)?.stop()
          const previous = shared.read(oldId)
          const message = "A different page now uses this Wiki slug. Saved edits for the original page were retained."
          if (previous !== undefined) {
            yield* shared.persist({ ...previous, cloud: { ...previous.cloud, phase: "deleted", error: message } })
          }
          return message
        }
        const id = wikiDocumentId(repo, incoming.page.id)
        yield* shared.accept(repo, { ...incoming, page: { ...incoming.page, visibility: incoming.page.visibility ?? space } }, owner, originBranch, actor)
        if (!isCurrent()) return "The Wiki selection changed while the page was loading."
        shared.watch(id)
        const document = shared.read(id)!
        yield* shared.persist({ ...document, cloud: { ...document.cloud, phase: "live" } }, actor)
        if (!isCurrent()) return "The Wiki selection changed while the page was loading."
        // With the Wiki pane open, the page opened is the page shown (the pane reads the session's selection), and no card doubles it in the chat.
        if (ctx.store.session().surface === "world" && actor === "user") {
          ctx.store.dispatch({ type: "world.document.selected", actor, id })
          void shared.flush(id)
          return { value: `Opened ${document.path} at page revision ${incoming.page.revision}.` }
        }
        const cardId = `wiki-open-${id}`
        const previous = ctx.store.collections.cards.get(cardId)
        const card: Card = {
          id: cardId,
          kind: "world",
          title: `${incoming.page.title} · ${repo}`,
          status: "active",
          createdAt: previous?.createdAt ?? Date.now(),
          ordinal: nextOrdinal(),
          payload: {
            documents: [{ id, path: document.path, title: document.title, confidence: document.confidence }],
            selectedDocumentId: id,
            view: previous?.kind === "world" ? previous.payload.view ?? "read" : "read"
          }
        }
        yield* Effect.tryPromise({
          try: () => ctx.store.dispatch({ type: "card.upsert", actor, card }).isPersisted.promise,
          catch: () => new CloudWikiError({ sentence: "The Wiki card could not be saved locally." })
        })
        // Only this explicit open resumes pending writes, and only in their original account/branch.
        void shared.flush(id)
        return { value: `Embedded ${document.path} at page revision ${incoming.page.revision}.\n\n${document.body}` }
      }).pipe(Effect.catch((error: CloudWikiError) => Effect.succeed(error.sentence)))
    )
  }

  const stageEdit = (id: string, body: string, needsAdmission: boolean): PreparedWikiEdit | string => {
    const document = shared.read(id)
    if (document === undefined) return "This cloud Wiki page is no longer available."
    const unchanged = document.body === body
    if (unchanged && document.cloud.pending.length === 0) return { complete: async () => {}, release: () => {} }
    const watch = shared.watches.get(id)
    if (watch?.valid() !== true || document.cloud.phase === "deleted") {
      return "Refresh this Wiki page before editing it. Its recorded text has been preserved."
    }
    let updateId = document.cloud.pending.at(-1)?.updateId ?? ""
    let saved: Promise<unknown> = Promise.resolve()
    if (!unchanged) {
      let clientId = shared.clients.get(id)
      if (clientId === undefined) {
        clientId = crypto.getRandomValues(new Uint32Array(1))[0]!
        shared.clients.set(id, clientId)
      }
      const edit = editWikiState(document.cloud.state, body, clientId)
      updateId = crypto.randomUUID()
      if (needsAdmission) shared.preparations.add(updateId)
      saved = shared.run(shared.persist({
        ...document,
        body,
        links: [...new Set(parseWikilinks(body).map((link) => link.target).filter(Boolean))],
        cloud: {
          ...document.cloud,
          state: edit.state,
          error: null,
          pending: [...document.cloud.pending, {
            updateId, update: edit.update, actor: ctx.commandActor,
            ...(needsAdmission ? { admitted: false } : {})
          }]
        }
      }, ctx.commandActor))
    }
    void saved.catch(() => {})
    return {
      release: () => { if (!unchanged) shared.preparations.delete(updateId) },
      complete: async () => {
        try {
          await saved
          if (!watch.valid() || shared.watches.get(id) !== watch) return "Refresh this Wiki page before editing it. Its recorded text has been preserved."
          const current = shared.read(id)!
          const index = current.cloud.pending.findIndex(item => item.updateId === updateId)
          // The accepted text includes its earlier local edits, but never
          // a newer keystroke. Delayed handlers authorize without replaying.
          if (index !== -1 && current.cloud.pending.slice(0, index + 1).some(item => item.admitted === false)) {
            await shared.run(shared.persist({ ...current, cloud: { ...current.cloud,
              pending: current.cloud.pending.map((item, ordinal) => ordinal <= index ? { ...item, admitted: true } : item)
            } }, ctx.commandActor))
          }
          return await shared.flush(id)
        } catch (error) {
          return error instanceof CloudWikiError ? error.sentence : "The Wiki edit could not be saved locally."
        }
      }
    }
  }

  const prepareCloudWiki = (id: string, body: string): PreparedWikiEdit | undefined => {
    if (ctx.commandActor !== "user") return undefined
    try {
      const edit = stageEdit(id, body, true)
      return typeof edit === "string" ? undefined : edit
    } catch {
      // Invalid text still reaches the ordinary flow's validation/refusal.
      return undefined
    }
  }

  const editCloudWiki = async (id: string, body: string): Promise<string | void> => {
    try {
      const edit = stageEdit(id, body, false)
      return typeof edit === "string" ? edit : await edit.complete()
    } catch (error) {
      return error instanceof CloudWikiError ? error.sentence : "The Wiki edit could not be saved locally."
    }
  }

  const retryCloudWiki = async (id: string): Promise<string | void | { value: string }> => {
    const document = shared.read(id)
    if (document === undefined) return "This cloud Wiki page is no longer available."
    // Refresh can explicitly publish recovered/refused input. It cannot
    // authorize an edit whose own command is still awaiting admission.
    const retry = new Set(document.cloud.pending.filter(item => item.admitted === false &&
      !shared.preparations.has(item.updateId)).map(item => item.updateId))
    const result = await openCloudWiki(document.cloud.repo, document.cloud.slug, document.cloud.pageId, spaceOf(document.cloud))
    if (typeof result === "string" || retry.size === 0) return result
    const current = shared.read(id)
    if (current === undefined || current.cloud.accountLogin !== document.cloud.accountLogin ||
      current.cloud.branchId !== document.cloud.branchId || shared.watches.get(id)?.valid() !== true) return result
    try {
      await shared.run(shared.persist({ ...current, cloud: { ...current.cloud,
        pending: current.cloud.pending.map(item => retry.has(item.updateId) ? { ...item, admitted: true } : item)
      } }, ctx.commandActor))
      return await shared.flush(id) ?? result
    } catch (error) {
      return error instanceof CloudWikiError ? error.sentence : "The Wiki edit could not be saved locally."
    }
  }

  /** The page a slug names in the space: its loaded row, else the index's entry. */
  const pageOf = (repo: string, space: WikiSpace, slug: string): { readonly pageId: number; readonly title: string; readonly path: string; readonly revision: number } | undefined => {
    for (const document of ctx.store.collections.worldDocuments.values()) {
      if (document.cloud?.repo === repo && document.cloud.slug === slug && spaceOf(document.cloud) === space) {
        return { pageId: document.cloud.pageId, title: document.title, path: document.cloud.path ?? `${slug}.md`, revision: document.cloud.remoteRevision }
      }
    }
    const row = shared.wikiIndexes.get(repo, space)?.pages.find((page) => page.slug === slug)
    return row === undefined ? undefined : { pageId: row.id, title: row.title, path: row.path, revision: row.revision }
  }

  /** Whether an id names a page some read index lists (an attachment has no document; selecting it shows its bytes). */
  const hasIndexedPage = (id: string): boolean => {
    const match = /^wiki:(.+):(\d+)$/.exec(id)
    if (match === null) return false
    for (const space of ["public", "private"] as const) {
      if (shared.wikiIndexes.get(match[1]!, space)?.pages.some((page) => String(page.id) === match[2])) return true
    }
    return false
  }

  /** `wiki.history <slug> [owner/repo]`: the page's revisions as a card, renames and the deletion included. */
  const showWikiHistory = async (slug: string, repoArg?: string, page = 1, spaceArg?: WikiSpace): Promise<string | void | { value: string }> => {
    const repo = targetRepo(repoArg)
    if (typeof repo !== "string") return repo.error
    if (shared.login() === null) return `Sign in to read the repository ${WIKI_DISPLAY_NAME}.`
    const space = spaceArg ?? shared.space()
    const found = pageOf(repo, space, slug)
    if (found === undefined) return `There is no ${space} ${WIKI_DISPLAY_NAME} page ${slug} in ${repo}. Open the space first.`
    const actor = ctx.commandActor
    const outcome = await ctx.withToast(`wiki.history.${repo}.${space}.${found.pageId}`, `Reading the history of ${found.path}…`, `History of ${found.path}`, async () => {
      const answer = await shared.run(Effect.gen(function*() {
        const api = yield* CloudWikiTransport
        return yield* api.history(repo, space, found.pageId, page)
      }).pipe(Effect.catch((error: CloudWikiError) => Effect.succeed(error.sentence)))).catch(refusal)
      if (typeof answer === "string") return answer
      if (shared.disposed()) return "The app closed while the history was loading."
      const cardId = `wiki-history-${repo}-${space}-${found.pageId}`
      const previous = ctx.store.collections.cards.get(cardId)
      const card: Card = {
        id: cardId, kind: "wiki-history", title: `History · ${found.path}`, status: "active",
        createdAt: previous?.createdAt ?? Date.now(), ordinal: nextOrdinal(),
        payload: {
          repo, space, pageId: found.pageId, slug, title: found.title, path: found.path, page, hasNext: answer.length === 50,
          revisions: answer.map((row) => ({
            revision: row.revision, title: row.title, path: row.path, author: row.author.login, at: row.updated_at, deleted: row.deleted, digest: row.content_digest,
            ...(row.attachment === undefined ? {} : { attachment: { digest: row.attachment.digest, mediaType: row.attachment.media_type, size: row.attachment.size } })
          }))
        }
      }
      await ctx.store.dispatch({ type: "card.upsert", actor, card }).isPersisted.promise
      return card.payload.revisions
    })
    if (typeof outcome === "string") return outcome
    return { value: `Embedded the history of ${found.path} (${space}): ${outcome.map((row) => `r${row.revision} ${row.deleted ? "deleted" : row.path} by ${row.author}`).join("; ") || "no revisions"}.` }
  }

  /** `wiki.cloud.new <title> [owner/repo]`: a Markdown page in the space, then opened. */
  const createCloudWikiPage = async (title: string, repoArg?: string): Promise<string | void | { value: string }> => {
    const repo = targetRepo(repoArg)
    if (typeof repo !== "string") return repo.error
    if (shared.login() === null) return `Sign in to write the repository ${WIKI_DISPLAY_NAME}.`
    const name = title.trim()
    if (name === "") return "A page needs a title."
    const space = shared.space()
    const outcome = await ctx.withToast(`wiki.new.${repo}.${space}`, `Creating ${name}…`, `${name} created`, async () => {
      const answer = await shared.run(Effect.gen(function*() {
        const api = yield* CloudWikiTransport
        return yield* api.create(repo, space, { title: name, body: `# ${name}\n\n` })
      }).pipe(Effect.catch((error: CloudWikiError) => Effect.succeed(error.sentence)))).catch(refusal)
      if (typeof answer === "string") return answer
      if (shared.disposed()) return "The app closed while the page was being created."
      void loadWikiIndex(repo, space)
      const opened = await openCloudWiki(repo, answer.slug, answer.id, space)
      return typeof opened === "string" ? opened : answer
    })
    if (typeof outcome === "string") return outcome
    return { value: `Created ${outcome.path ?? `${outcome.slug}.md`} in the ${space} ${WIKI_DISPLAY_NAME} of ${repo}.` }
  }

  /** `wiki.cloud.rename <slug> <path> [owner/repo]`: the path, checked against the revision the person saw; a stale revision is refused, never overwritten. */
  const renameCloudWikiPage = async (slug: string, path: string, repoArg?: string): Promise<string | void> => {
    const repo = targetRepo(repoArg)
    if (typeof repo !== "string") return repo.error
    if (shared.login() === null) return `Sign in to write the repository ${WIKI_DISPLAY_NAME}.`
    const space = shared.space()
    const found = pageOf(repo, space, slug)
    if (found === undefined) return `There is no ${space} ${WIKI_DISPLAY_NAME} page ${slug} in ${repo}. Open the space first.`
    const next = path.trim()
    if (next === "" || next === found.path) return
    const outcome = await ctx.withToast(`wiki.rename.${repo}.${space}.${found.pageId}`, `Renaming ${found.path}…`, `Renamed to ${next}`, async () => {
      const answer = await shared.run(Effect.gen(function*() {
        const api = yield* CloudWikiTransport
        return yield* api.patch(repo, space, slug, { path: next, expected_revision: found.revision })
      }).pipe(Effect.catch((error: CloudWikiError) =>
        Effect.succeed(error.status === 409 ? `${found.path} changed since you opened it (revision ${found.revision}). Refresh the page and rename it again.` : error.sentence)))).catch(refusal)
      if (typeof answer === "string") return answer
      if (shared.disposed()) return "The app closed while the page was being renamed."
      void loadWikiIndex(repo, space)
      const id = wikiDocumentId(repo, answer.id)
      const document = shared.read(id)
      if (document !== undefined) await shared.run(shared.persist({ ...document, cloud: { ...document.cloud, path: answer.path ?? next, remoteRevision: answer.revision } }))
      return true
    })
    return typeof outcome === "string" ? outcome : undefined
  }

  /** `wiki.cloud.delete <slug> [owner/repo]`: the page leaves the space; its history stays. */
  const deleteCloudWikiPage = async (slug: string, repoArg?: string): Promise<string | void> => {
    const repo = targetRepo(repoArg)
    if (typeof repo !== "string") return repo.error
    if (shared.login() === null) return `Sign in to write the repository ${WIKI_DISPLAY_NAME}.`
    const space = shared.space()
    const found = pageOf(repo, space, slug)
    if (found === undefined) return `There is no ${space} ${WIKI_DISPLAY_NAME} page ${slug} in ${repo}. Open the space first.`
    const outcome = await ctx.withToast(`wiki.delete.${repo}.${space}.${found.pageId}`, `Deleting ${found.path}…`, `${found.path} deleted`, async () => {
      const answer = await shared.run(Effect.gen(function*() {
        const api = yield* CloudWikiTransport
        yield* api.remove(repo, space, slug)
        return true as const
      }).pipe(Effect.catch((error: CloudWikiError) => Effect.succeed(error.sentence)))).catch(refusal)
      if (typeof answer === "string") return answer
      if (shared.disposed()) return "The app closed while the page was being deleted."
      void loadWikiIndex(repo, space)
      const id = wikiDocumentId(repo, found.pageId)
      const document = shared.read(id)
      if (document !== undefined) {
        shared.watches.get(id)?.stop()
        await shared.run(shared.persist({ ...document, cloud: { ...document.cloud, phase: "deleted", error: "This page was deleted. Pending edits were kept locally." } }))
      }
      return true
    })
    return typeof outcome === "string" ? outcome : undefined
  }

  /**
   * `wiki.attach <slug> <path> [owner/repo]`: the bytes the human's file
   * dialog chose (the gesture), put under the slug at the path. Revision 0
   * creates; a later put names the current revision, so a stale one is
   * refused rather than overwritten.
   */
  const attachCloudWiki = async (slug: string, path: string, repoArg: string | undefined, gesture?: CommandGesture): Promise<string | void | { value: string }> => {
    const repo = targetRepo(repoArg)
    if (typeof repo !== "string") return repo.error
    if (shared.login() === null) return `Sign in to write the repository ${WIKI_DISPLAY_NAME}.`
    const file = gesture?.takeFile?.()
    if (file === undefined) return "Choose a file to attach."
    if (file.size > 16 * 1024 * 1024) return "An attachment is at most 16 MiB."
    const target = path.trim() || file.name
    if (target === "" || /\.md$/i.test(target) || target.startsWith("/") || target.split("/").some((part) => part === "" || part === "." || part === "..")) return "An attachment path is a relative file path, not a Markdown page."
    const space = shared.space()
    const existing = pageOf(repo, space, slug)
    const expectedRevision = existing?.revision ?? 0
    const mediaType = file.type || "application/octet-stream"
    const outcome = await ctx.withToast(`wiki.attach.${repo}.${space}.${slug}`, `Attaching ${target}…`, `${target} attached`, async () => {
      const answer = await shared.run(Effect.gen(function*() {
        const bytes = yield* Effect.tryPromise({
          try: async () => new Uint8Array(await file.arrayBuffer()),
          catch: () => new CloudWikiError({ sentence: "The attachment could not be read. Choose the file again." })
        })
        const api = yield* CloudWikiTransport
        return yield* api.attach(repo, space, slug, { path: target, mediaType, expectedRevision, bytes })
      }).pipe(Effect.catch((error: CloudWikiError) =>
        Effect.succeed(error.status === 409 ? `${target} changed since you opened it (revision ${expectedRevision}). Refresh and attach it again.` : error.sentence)))).catch(refusal)
      if (typeof answer === "string") return answer
      if (shared.disposed()) return "The app closed while the file was uploading."
      void loadWikiIndex(repo, space)
      return answer
    })
    if (typeof outcome === "string") return outcome
    return { value: `Attached ${outcome.path ?? target} (${mediaType}, revision ${outcome.revision}) to the ${space} ${WIKI_DISPLAY_NAME} of ${repo}.` }
  }

  const attachWorldEditor = (id: string, slot: string, editor: MarkdownEditorHandle | null): void => {
    const handles = shared.editors.get(id) ?? new Map<string, MarkdownEditorHandle>()
    if (editor === null) handles.delete(slot)
    else {
      handles.set(slot, editor)
      const document = ctx.store.collections.worldDocuments.get(id)
      if (document !== undefined && restoreWikilinks(editor.getMarkdown()) !== document.body) editor.setMarkdown(document.body)
    }
    if (handles.size === 0) shared.editors.delete(id)
    else shared.editors.set(id, handles)
  }
  const scrollEditor = (id: string, cardId: string, line: number): boolean => {
    for (const [slot, editor] of shared.editors.get(id) ?? []) {
      if (slot.startsWith(`${cardId}:`) && editor.scrollToLine(line)) return true
    }
    return false
  }
  return { listCloudWiki, openCloudWiki, editCloudWiki, prepareCloudWiki, retryCloudWiki, attachWorldEditor, scrollEditor,
    loadWikiIndex, readWikiForPane, setWikiSpace, setWikiPageView, showWikiHistory, createCloudWikiPage, renameCloudWikiPage, deleteCloudWikiPage, attachCloudWiki,
    wikiIndexes: shared.wikiIndexes, hasIndexedPage }
}
