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
import type { CloudWikiDocument } from "../../wiki/CloudWiki"
import type { CloudWikiState } from "../../wiki/CloudWikiState"
import type { PreparedWikiEdit } from "../../flows/CommandGesture"
import { actorSharedState } from "../ActorBindings"
import type { Card, WorldDocument } from "../AppState"
import { DEFAULT_BRANCH_ID } from "../AppState"
import type { ControllerContext } from "./context"

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
          new CloudWikiError({ message: "The Wiki edit could not be saved locally. Check storage before retrying." })
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
              catch: () => new CloudWikiError({ message: "Could not clear the revoked Wiki page from local storage." })
            }).pipe(Effect.tap(() => Effect.sync(() => watches.get(id)?.stop())))
          )
        }
        const saved = ctx.store.committedWorldDocument(id)?.cloud
        // An optimistic failure alone is not evidence that it survived storage.
        if (document.cloud.phase === "offline" && document.cloud.error === error.message &&
          saved?.phase === "offline" && saved.error === error.message &&
          saved.accountLogin === document.cloud.accountLogin && saved.branchId === document.cloud.branchId) return Effect.void
        return persist({ ...document, cloud: { ...document.cloud, phase: "offline", error: error.message } })
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
              message: "The Wiki text and collaborative state disagree. Local edits were retained."
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
          const answer = yield* api.update(cloud.repo, cloud.slug, cloud.pageId, pending.updateId, pending.update)
          if (!watch.valid() || watches.get(id) !== watch) return
          if (
            answer.update_id !== pending.updateId || answer.document.page.id !== cloud.pageId ||
            answer.accepted_revision > answer.document.page.revision
          ) {
            return yield* Effect.fail(
              new CloudWikiError({
                message: "The Wiki returned an acknowledgement for another edit. Your edit is still pending."
              })
            )
          }
          const contains = yield* Effect.try({
            try: () => wikiStateContains(answer.document.state, pending.update),
            catch: () =>
              new CloudWikiError({
                message: "The Wiki returned invalid collaborative state. Your edit is still pending."
              })
          })
          if (!contains) {
            return yield* Effect.fail(
              new CloudWikiError({
                message: "The Wiki acknowledgement does not contain this edit. Your edit is still pending."
              })
            )
          }
          yield* accept(cloud.repo, answer.document, cloud.accountLogin, cloud.branchId, "system", pending.updateId)
        }
      }).pipe(Effect.catch((error: CloudWikiError) =>
        Effect.as(
          watches.get(id) === operationWatch && operationWatch?.valid() === true ? setFailure(id, error) : Effect.void,
          error.message
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
            current.cloud.remoteRevision
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
                const incoming = yield* api.read(row.cloud.repo, event.slug)
                if (!handle.valid()) return
                if (incoming.page.id !== row.cloud.pageId) {
                  return yield* Effect.fail(
                    new CloudWikiError({
                      message: "The Wiki slug now belongs to another page. Local edits were retained.",
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
          if (ended) yield* setFailure(id, new CloudWikiError({ message: "Reconnecting to Wiki revisions…" }))
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
    const changed = () => {
      if (owner === login() && originBranch === branch()) return
      owner = login()
      originBranch = branch()
      detach()
    }
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
      for (const handle of watches.values()) handle.stop()
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
      login,
      disposed: () => disposed
    }
  })

  const listCloudWiki = async (repo: string, page = 1): Promise<string | { value: string }> => {
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
        const pages = yield* api.list(repo, page)
        if (
          shared.disposed() || shared.login() !== owner || shared.branch() !== originBranch
        ) return "The account or conversation changed while the Wiki was loading."
        const cardId = `wiki-index-${repo}`
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
              cloud: { repo, slug: item.slug, revision: item.revision }
            })),
            index: { repo, page, hasNext: pages.length === 50 },
            view: "outline"
          }
        }
        yield* Effect.tryPromise({
          try: () => ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card }).isPersisted.promise,
          catch: () => new CloudWikiError({ message: "The Wiki index could not be saved locally." })
        })
        return {
          value: `Embedded Wiki pages for ${repo}: ${
            pages.map((item) => `${item.slug} (revision ${item.revision})`).join(", ") || "none"
          }.`
        }
      }).pipe(Effect.catch((error: CloudWikiError) => Effect.succeed(error.message)))
    )
  }

  const openCloudWiki = async (
    repo: string,
    slug: string,
    expectedPageId?: number
  ): Promise<string | { value: string }> => {
    const owner = shared.login()
    if (owner === null) return "Sign in to read and edit the repository Wiki."
    try {
      wikiPagePath(repo, slug)
    } catch (error) {
      return error instanceof CloudWikiError ? error.message : "Invalid Wiki page."
    }
    const originBranch = shared.branch()
    const actor = ctx.commandActor
    return shared.run(
      Effect.gen(function*() {
        const api = yield* CloudWikiTransport
        const incoming = yield* api.read(repo, slug)
        if (
          shared.disposed() || shared.login() !== owner || shared.branch() !== originBranch
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
        yield* shared.accept(repo, incoming, owner, originBranch, actor)
        shared.watch(id)
        const document = shared.read(id)!
        yield* shared.persist({ ...document, cloud: { ...document.cloud, phase: "live" } }, actor)
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
            view: previous?.kind === "world" ? previous.payload.view : "outline"
          }
        }
        yield* Effect.tryPromise({
          try: () => ctx.store.dispatch({ type: "card.upsert", actor, card }).isPersisted.promise,
          catch: () => new CloudWikiError({ message: "The Wiki card could not be saved locally." })
        })
        // Only this explicit open resumes pending writes, and only in their original account/branch.
        void shared.flush(id)
        return { value: `Embedded ${document.path} at page revision ${incoming.page.revision}.\n\n${document.body}` }
      }).pipe(Effect.catch((error: CloudWikiError) => Effect.succeed(error.message)))
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
          return error instanceof CloudWikiError ? error.message : "The Wiki edit could not be saved locally."
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
      return error instanceof CloudWikiError ? error.message : "The Wiki edit could not be saved locally."
    }
  }

  const retryCloudWiki = async (id: string): Promise<string | void | { value: string }> => {
    const document = shared.read(id)
    if (document === undefined) return "This cloud Wiki page is no longer available."
    // Refresh can explicitly publish recovered/refused input. It cannot
    // authorize an edit whose own command is still awaiting admission.
    const retry = new Set(document.cloud.pending.filter(item => item.admitted === false &&
      !shared.preparations.has(item.updateId)).map(item => item.updateId))
    const result = await openCloudWiki(document.cloud.repo, document.cloud.slug, document.cloud.pageId)
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
      return error instanceof CloudWikiError ? error.message : "The Wiki edit could not be saved locally."
    }
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
  return { listCloudWiki, openCloudWiki, editCloudWiki, prepareCloudWiki, retryCloudWiki, attachWorldEditor, scrollEditor }
}
