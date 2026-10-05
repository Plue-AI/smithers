import { todoActors, type ActorContext } from "../ProductActor"
import { TodoCardSchema, type TodoCard } from "@smthrs/rpc/TodoCard"
import { DraftCardSchema, type DraftCard } from "@smthrs/rpc/DraftCard"
import type { Card } from "@smthrs/rpc/Cards"
/* The routes and cards the model host's TODO commands share (@smthrs/rpc/TodoCommands). */
import { draftCard, issueDigest, todoCard, todoPath, TODOS_PATH, type DraftEntry, type TodoEntry } from "@smthrs/rpc/TodoCommands"
import { Data, Schema } from "effect"
import { TodoNewInput, TodoAmendInput } from "../../flows/entries/todo"
import { actorSharedState } from "../ActorBindings"
import type { SeamContext } from "./SeamContext"
import { readResult, unreachableSentence } from "./SeamContext"
import { randomUuid } from "../../runtime/RandomUuid"

class TodoTopicMismatch extends Data.TaggedError("TodoTopicMismatch") { readonly message = "TODO topic mismatch" }

export type { DraftEntry, TodoEntry }
type Request = TodoEntry["payload"]["requests"][number]
export interface TodoReceipt {
  readonly key: string
  /** Server transaction receipt, never inferred from HTTP admission. */
  readonly committed?: { readonly n: number; readonly rev: number }
  readonly outcome?: { readonly status: "ok" | "failed"; readonly detail: string }
}
/** What Make TODO drafts from: one GitHub issue and its discussion, as its issue card read them. */
export interface IssueDraftSource {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly comments: ReadonlyArray<{ readonly author: string | null; readonly body: string }>
}
/** The Draft's prompt: the issue's body, then each comment quoted under its author. */
const issuePrompt = (source: IssueDraftSource): string => [source.body.trim(), ...source.comments.flatMap(comment => comment.body.trim()
  ? [`@${comment.author ?? "someone"}:\n${comment.body.trim().split("\n").map(line => `> ${line}`).join("\n")}`] : [])]
  .filter(Boolean).join("\n\n") || source.title
/** T-APP-08 binds the shared live transport; the payload is the todo:<n> projection. */
export interface TodoTopics {
  readonly subscribe: (topic: `todo:${number}`, receive: (model: unknown, receipts?: readonly TodoReceipt[]) => void) => () => void
}
export interface TodoSeamOptions {
  readonly actors?: () => ActorContext
  readonly topics?: TodoTopics
  readonly debounceMs?: number
  /** How often an open Home reads GET /api/todos again; 2 s by default. */
  readonly listPollMs?: number
  readonly onDispose?: (stop: () => void) => void
}
/** GET /api/todos as Home reads it where this host serves no `home` topic (T-APP-01): every TODO card, or why the read failed. */
export interface TodoListSnapshot {
  readonly todos?: ReadonlyArray<TodoCard>
  /** `forbidden` drops the list; `internal`, `invalid` and `unreachable` keep the last list read. */
  readonly error?: "forbidden" | "internal" | "invalid" | "unreachable"
}
export interface TodoListSnapshots {
  readonly get: () => TodoListSnapshot
  /** The first reader starts the reads: one at once, then one every `listPollMs` until the last reader leaves. */
  readonly subscribe: (listener: () => void) => () => void
}
export const createTodoSeam = (ctx: SeamContext, options: TodoSeamOptions = {}) => {
  const shared = actorSharedState(ctx, "todo", () => ({
    sending: new Set<string>(), aborts: new Map<string, AbortController>(), watches: new Map<number, () => void>(),
    timers: new Map<string, ReturnType<typeof setTimeout>>(), epoch: ctx.store.collections.identitySessions.get("identity")?.ownerRevision ?? ctx.store.collections.identitySessions.get("identity")?.revision,
    list: { snapshot: {} as TodoListSnapshot, listeners: new Set<() => void>(), timer: undefined as ReturnType<typeof setTimeout> | undefined, reading: false, disposed: false }
  }))
  const owner = () => ctx.store.collections.identitySessions.get("identity")?.login
  const identity = () => ctx.store.collections.identitySessions.get("identity")
  const current = (login: string | null | undefined, revision: number | undefined) =>
    !ctx.isDisposed?.() && identity()?.state === "signed-in" && owner() === login
    && (identity()?.ownerRevision ?? identity()?.revision) === revision
  const entry = (n: number): TodoEntry | undefined => {
    const row = ctx.store.collections.cards.get(`todo:${n}`)
    return row?.kind === "todo" ? row : undefined
  }
  const draft = (id: string): DraftEntry | undefined => {
    const row = ctx.store.collections.cards.get(id)
    return row?.kind === "draft" ? row : undefined
  }
  const write = async (card: Card, actor: "user" | "smithers" | "system" = ctx.actor()) => {
    await ctx.dispatch({ type: "card.upsert", actor, card }).isPersisted.promise
  }
  const blank = (n: number): TodoEntry => todoCard(n, undefined, ctx.nextOrdinal(), Date.now())
  const noticeKey = (key: string) => `todo.request.${key}`
  const needsYouKey = (n: number, wait: string) => `todo.needs-you.${n}.${wait}`
  const showNotice = (request: Request, title: string) => {
    if (shared.timers.has(request.key)) return
    const timer = setTimeout(() => {
      shared.timers.delete(request.key)
      if (!ctx.isDisposed?.() && owner() === request.owner && identity()?.state === "signed-in") ctx.dispatch({ type: "toast.shown", actor: "system", key: noticeKey(request.key), title })
    }, options.debounceMs ?? 300)
    shared.timers.set(request.key, timer)
  }
  const finishNotice = (key: string, title: string, outcome: NonNullable<TodoReceipt["outcome"]>) => {
    const timer = shared.timers.get(key)
    if (timer) clearTimeout(timer)
    shared.timers.delete(key)
    if (!ctx.store.collections.toasts.has(`toast-${noticeKey(key)}`)) {
      ctx.dispatch({ type: "toast.shown", actor: "system", key: noticeKey(key), title })
    }
    ctx.resolveToast?.(noticeKey(key), outcome)
  }
  const signedIn = (): string | undefined => identity()?.state === "signed-in" && owner() ? undefined : "Sign in to work on TODOs."
  const watch = (n: number) => {
    if (shared.watches.has(n)) return
    const login = owner(), revision = identity()?.ownerRevision ?? identity()?.revision
    let active = true, published = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = options.topics?.subscribe(`todo:${n}`, (value, receipts = []) => {
      if (!active || !current(login, revision)) return
      let model: TodoCard
      // Only a publication that validates replaces the REST refresh; malformed live data leaves recovery running.
      try { model = projection(n, value) } catch (error) { ctx.report?.("todo.projection", error); return }
      published = true
      if (timer) clearTimeout(timer)
      void applyModel(n, model, receipts, () => active && current(login, revision)).catch(error => ctx.report?.("todo.projection", error))
    })
    // Until this host publishes the topic, refresh persisted source facts through its read route.
    const refresh = async () => {
      if (!active || published || !current(login, revision)) return
      try {
        const response = await ctx.http(`${ctx.baseUrl}${todoPath(n)}`, { credentials: "include" })
        if (response.ok && active && !published && current(login, revision)) {
          await applyProjection(n, await response.json(), [], () => active && !published && current(login, revision))
        }
      } catch (error) { ctx.report?.("todo.refresh", error) }
      if (active && !published && current(login, revision)) timer = setTimeout(() => { void refresh() }, 1000)
    }
    timer = setTimeout(() => { void refresh() }, 1000)
    shared.watches.set(n, () => { active = false; if (timer) clearTimeout(timer); unsubscribe?.() })
  }
  /** The todo:<n> model a payload carries; a payload for another TODO is a mismatch. */
  const projection = (n: number, value: unknown): TodoCard => {
    const model = TodoCardSchema.parse(todoActors(value, options.actors?.()))
    if (model.n !== n) throw new TodoTopicMismatch()
    return model
  }
  const applyProjection = async (n: number, value: unknown, receipts: readonly TodoReceipt[] = [], stillCurrent?: () => boolean) => {
    const login = owner(), revision = identity()?.ownerRevision ?? identity()?.revision
    const live = stillCurrent ?? (() => current(login, revision))
    if (!live()) return
    await applyModel(n, projection(n, value), receipts, live)
  }
  const applyModel = async (n: number, model: TodoCard, receipts: readonly TodoReceipt[], live: () => boolean) => {
    const card = entry(n) ?? blank(n)
    // REST snapshots are durable source facts too: admission alone never clears a Draft or a toast.
    const observed: TodoReceipt[] = card.payload.requests.flatMap<TodoReceipt>(request => {
      if (request.state !== "accepted" || receipts.some(receipt => receipt.key === request.key)) return []
      if (request.operation === "merge") return model.state === "merged"
        ? [{ key: request.key, outcome: { status: "ok" as const, detail: "Merged" } }] : []
      // An accepted answer is done once its question is no longer open.
      if (request.operation === "answer") return model.waits.some(wait => wait.id === request.body.wait)
        ? [] : [{ key: request.key, outcome: { status: "ok" as const, detail: "Answered" } }]
      // A drop settles once the TODO is dropped.
      if (request.operation === "drop") return model.state === "dropped"
        ? [{ key: request.key, outcome: { status: "ok" as const, detail: "Dropped" } }] : []
      // A retry settles once the attempt its receipt named runs: Working or past it, or failed again.
      if (request.operation === "retry" || request.operation === "retry-current-flow") {
        if (model.state === "dropped") return [{ key: request.key, outcome: { status: "failed" as const, detail: "Dropped" } }]
        if (request.attempt === undefined || (model.run?.attempt ?? 0) < request.attempt || ["queued", "starting"].includes(model.state)) return []
        return [{ key: request.key, outcome: model.state === "failed"
          ? { status: "failed" as const, detail: model.failure?.message ?? "Failed" } : { status: "ok" as const, detail: "Working" } }]
      }
      // A move settles once the card shows the place its receipt named, or the TODO has left the stack.
      if (request.operation === "move") return model.place === undefined || model.place === request.place
        ? [{ key: request.key, outcome: { status: "ok" as const, detail: "Moved" } }] : []
      if (request.operation !== "create" || model.title !== request.body.title || model.prompt_revisions[0]?.text !== request.body.prompt) return []
      const terminal = ["in_review", "merged", "failed", "dropped"].includes(model.state)
      return [{ key: request.key, committed: { n, rev: 1 }, ...(terminal ? {
        outcome: model.state === "failed" || model.state === "dropped"
          ? { status: "failed" as const, detail: model.failure?.message ?? "Dropped" }
          : { status: "ok" as const, detail: model.state === "merged" ? "Merged" : "In review" }
      } : {}) }]
    })
    receipts = [...receipts, ...observed]
    await write({ ...card, title: model.title, payload: { ...card.payload, model,
      requests: card.payload.requests.filter(request => !receipts.some(receipt => receipt.key === request.key && receipt.outcome)),
      ...(receipts.some(receipt => receipt.outcome?.status === "ok" && card.payload.requests.some(request => request.key === receipt.key && request.operation === "steer"))
        ? { answerDraft: undefined, answeredBy: undefined } : {})
    } }, "system")
    // Needs you (M-14): each question the agent opens raises one toast with its Answer for the TODO's owner and anyone
    // on its branch, settled when the question is.
    const asked = (value: TodoCard | undefined) => new Set((value?.waits ?? []).filter(wait => wait.kind === "question").map(wait => wait.id))
    const before = asked(card.payload.model), after = asked(model)
    const toasted = model.owner.login === owner() || model.present.some(actor => actor.kind === "person" && actor.login === owner())
    for (const id of after) {
      if (toasted && !before.has(id) && live()) ctx.dispatch({ type: "toast.shown", actor: "system", key: needsYouKey(n, id), title: `T${n} needs you`,
        sourceCard: card.id, action: { flow: "todo", args: `T${n}`, label: "Answer" } })
    }
    for (const id of before) if (!after.has(id) && live()) ctx.resolveToast?.(needsYouKey(n, id), { status: "ok", detail: "Answered" })
    for (const receipt of receipts) {
      if (!live()) return
      const original = card.payload.requests.find(request => request.key === receipt.key)
      for (const row of ctx.store.collections.cards.values()) {
        if (row.kind !== "draft" || row.payload.request?.key !== receipt.key) continue
        if (receipt.committed) {
          await write({ ...row, audience_member_id: null, payload: { ...row.payload, private: false,
            committed: receipt.committed, request: receipt.outcome ? undefined : row.payload.request } }, "system")
        } else if (receipt.outcome?.status === "ok") {
          await write({ ...row, payload: { ...row.payload, request: undefined } }, "system")
        } else if (receipt.outcome?.status === "failed") {
          await write({ ...row, payload: { ...row.payload, request: { ...row.payload.request, state: "failed", error: receipt.outcome.detail } } }, "system")
        }
      }
      if (live() && original && receipt.outcome) finishNotice(receipt.key, model.title, receipt.outcome)
    }
  }
  const updateRequest = async (cardId: string, request: Request) => {
    const row = ctx.store.collections.cards.get(cardId)
    if (row?.kind === "draft") await write({ ...row, payload: { ...row.payload, request } })
    if (row?.kind === "todo") await write({ ...row, payload: { ...row.payload,
      requests: [...row.payload.requests.filter(old => old.key !== request.key), request] } })
  }
  const send = (cardId: string, request: Request): void => {
    if (shared.sending.has(request.key) || request.owner !== owner() || signedIn()) return
    shared.sending.add(request.key)
    const abort = new AbortController()
    shared.aborts.set(request.key, abort)
    const login = owner(), revision = identity()?.ownerRevision ?? identity()?.revision
    const row = ctx.store.collections.cards.get(cardId)
    const title = row?.title ?? "TODO"
    showNotice(request, title)
    // An answer has its own route (POST /api/todos/{n}/answer); the other controls share the TODO's.
    const control = ["steer", "stop", "resume", "retry", "retry-current-flow", "drop", "move"].includes(request.operation)
    const route = request.operation === "create" ? TODOS_PATH
      : `${todoPath(request.n!)}${request.operation === "amend" || control ? "" : `/${request.operation}`}`
    void (async () => {
      let response: Response
      try {
        response = await ctx.http(`${ctx.baseUrl}${route}`, {
          method: request.operation === "amend" ? "PATCH" : "POST", credentials: "include", signal: abort.signal,
          headers: { "Content-Type": "application/json", "Idempotency-Key": request.key, ...(ctx.actor() === "smithers" ? { "Smithers-Via": "smithers" } : {}) }, body: JSON.stringify(control ? { op: request.operation, ...request.body } : request.body)
        })
      } catch (error) {
        if (current(login, revision)) await fail(unreachableSentence("TODOs", error))
        return
      }
      if (!current(login, revision)) return
      const body: unknown = await response.json().catch(() => null)
      if (!current(login, revision)) return
      const result = body && typeof body === "object" ? body as Record<string, unknown> : {}
      if (!response.ok) {
        if (response.status === 409 && request.operation === "answer" && typeof result.answered_by === "string") {
          const todo = entry(request.n!)
          if (todo) await write({ ...todo, payload: { ...todo.payload, answerDraft: String(request.body.answer), answeredBy: result.answered_by } })
        }
        const message = typeof result.message === "string" ? result.message : "TODO request failed."
        const fault = result.class === "infra" || result.class === "capacity" ? `${message} Not your fault.` : message
        await fail(fault)
        return
      }
      if (result.state !== "requested" && result.state !== "accepted") {
        await fail("TODO admission was not confirmed.")
        return
      }
      const n = request.n ?? (typeof result.n === "number" && Number.isInteger(result.n) && result.n > 0 ? result.n : undefined)
      const latest = ctx.store.collections.cards.get(cardId)
      // A live receipt may have beaten the HTTP response; do not resurrect completed work.
      const held = latest?.kind === "todo" ? latest.payload.requests.find(r => r.key === request.key)
        : latest?.kind === "draft" ? latest.payload.request : undefined
      if (held?.key !== request.key || latest?.kind === "draft" && latest.payload.committed) return
      const attempt = typeof result.attempt === "number" && Number.isInteger(result.attempt) && result.attempt > 0 ? result.attempt : undefined
      const place = typeof result.place === "number" && Number.isInteger(result.place) && result.place > 0 ? result.place : undefined
      const accepted: Request = { ...request, n, state: result.state, ...(attempt === undefined ? {} : { attempt }), ...(place === undefined ? {} : { place }) }
      await updateRequest(cardId, accepted)
      if (n) {
        if (cardId !== `todo:${n}`) {
          const todo = entry(n) ?? blank(n)
          await write({ ...todo, payload: { ...todo.payload, requests: [...todo.payload.requests.filter(r => r.key !== request.key), accepted] } })
        }
        watch(n)
      } else await fail("TODO admission did not name a TODO.")
    })().catch(error => ctx.report?.("todo.request", error)).finally(() => { shared.sending.delete(request.key); shared.aborts.delete(request.key) })
    async function fail(message: string) {
      await updateRequest(cardId, { ...request, state: "failed", error: message })
      finishNotice(request.key, title, { status: "failed", detail: message })
    }
  }
  const request = async (n: number, operation: Request["operation"], body: Record<string, unknown>, key?: string) => {
    const refusal = signedIn(); if (refusal) return refusal
    const row = entry(n) ?? blank(n)
    const existing = row.payload.requests.find(old => old.owner === owner() && old.operation === operation && JSON.stringify(old.body) === JSON.stringify(body))
    const pending = existing ?? { key: key ?? randomUuid(), owner: owner()!, operation, n, body, state: "requested" as const }
    await updateOrCreate(row, pending)
    watch(n)
    if (pending.state !== "accepted" || !shared.sending.has(pending.key)) send(row.id, pending)
    return { value: "Requested" }
  }
  const updateOrCreate = async (row: TodoEntry, pending: Request) => write({ ...row, payload: { ...row.payload,
    requests: [...row.payload.requests.filter(old => old.key !== pending.key), pending] } })
  const showTodo = async (n: number) => {
    const refusal = signedIn(); if (refusal) return refusal
    const login = owner(), revision = identity()?.ownerRevision ?? identity()?.revision
    try {
      const response = await ctx.http(`${ctx.baseUrl}${todoPath(n)}`, { credentials: "include" })
      if (!current(login, revision)) return
      if (!response.ok) return "Could not open the TODO."
      const model = TodoCardSchema.parse(todoActors(await response.json(), options.actors?.()))
      await applyProjection(n, model)
      watch(n)
      return readResult(JSON.stringify(model))
    } catch (error) { return unreachableSentence("TODOs", error) }
  }
  const publishList = (snapshot: TodoListSnapshot) => {
    shared.list.snapshot = snapshot
    for (const listener of shared.list.listeners) listener()
  }
  /** One read of every TODO; an answer for an earlier sign-in is dropped. */
  const readList = async () => {
    if (signedIn()) return
    const login = owner(), revision = identity()?.ownerRevision ?? identity()?.revision
    let next: TodoListSnapshot
    try {
      const response = await ctx.http(`${ctx.baseUrl}${TODOS_PATH}`, { credentials: "include" })
      const body: unknown = response.ok ? await response.json() : undefined
      const parsed = Array.isArray(body) ? TodoCardSchema.array().safeParse(body.map(value => todoActors(value, options.actors?.()))) : undefined
      next = response.status === 401 || response.status === 403 ? { error: "forbidden" }
        : !response.ok ? { ...shared.list.snapshot, error: "internal" }
        : parsed?.success ? { todos: parsed.data } : { ...shared.list.snapshot, error: "invalid" }
    } catch { next = { ...shared.list.snapshot, error: "unreachable" } }
    if (current(login, revision)) publishList(next)
  }
  const pollList = () => {
    const list = shared.list
    if (list.disposed || list.reading || list.timer !== undefined || list.listeners.size === 0) return
    list.reading = true
    void readList().catch(error => ctx.report?.("todo.list", error)).finally(() => {
      list.reading = false
      if (!list.disposed && list.listeners.size > 0) list.timer = setTimeout(() => { list.timer = undefined; pollList() }, options.listPollMs ?? 2000)
    })
  }
  const list: TodoListSnapshots = {
    get: () => shared.list.snapshot,
    subscribe: listener => {
      shared.list.listeners.add(listener)
      pollList()
      return () => {
        shared.list.listeners.delete(listener)
        if (shared.list.listeners.size === 0 && shared.list.timer !== undefined) { clearTimeout(shared.list.timer); shared.list.timer = undefined }
      }
    }
  }
  /** Review & merge (T-APP-04): the person's private Confirm card for Tn in review, read live from the TODO card. */
  const reviewMerge = async (n: number) => {
    const shown = await showTodo(n)
    const model = entry(n)?.payload.model
    if (model === undefined) return typeof shown === "string" ? shown : `No TODO T${n}`
    if (model.state === "merged") return `T${n} already merged`
    if (model.state !== "in_review" || !model.pr) return "Not in review yet"
    const id = `confirm:merge:todo:${n}`, existing = ctx.store.collections.cards.get(id), title = `Merge T${n} into main?`
    await write({ id, kind: "confirm", audience_member_id: owner()!, title, status: "active", createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(), payload: { id: `merge:todo:${n}` } })
    return { value: `Opened ${title}` }
  }
  const loadDraftPlaces = (id: string) => {
    const login = owner(), revision = identity()?.ownerRevision ?? identity()?.revision
    void (async () => {
      let options: DraftCard["place"]["options"] | undefined, failure: string | undefined
      try {
        const response = await ctx.http(`${ctx.baseUrl}${TODOS_PATH}`, { credentials: "include" })
        if (!response.ok) failure = "Could not load TODO placement."
        else options = TodoCardSchema.array().parse(await response.json()).filter((model): model is typeof model & { state: DraftCard["place"]["options"][number]["state"] } => model.state !== "merged" && model.state !== "dropped")
          .map(model => ({ n: model.n, title: model.title, state: model.state }))
      } catch { failure = "Could not load TODO placement." }
      if (!current(login, revision)) return
      const latest = draft(id)
      if (!latest || latest.payload.committed) return
      await write({ ...latest, payload: { ...latest.payload, optionsFailure: failure,
        place: { ...latest.payload.place, options: options ?? latest.payload.place.options } } })
    })().catch(error => ctx.report?.("todo.placement", error))
  }
  const placeOptions = (): DraftCard["place"]["options"] => [...ctx.store.collections.cards.values()]
    .flatMap(row => row.kind === "todo" && row.payload.model && row.payload.model.state !== "merged" && row.payload.model.state !== "dropped"
      ? [{ n: row.payload.n, title: row.title, state: row.payload.model.state }] : [])
  const newTodo = async (input: Schema.Schema.Type<typeof TodoNewInput>) => {
    const refusal = signedIn(); if (refusal) return refusal
    if (!input.cardId) {
      const id = `draft:${randomUuid()}`
      await write(draftCard({ id, author: owner()!, text: input.text ?? "", title: input.title, acceptance: input.acceptance, context: input.context, before: input.before,
        options: placeOptions(), idempotencyKey: randomUuid() }, ctx.nextOrdinal(), Date.now()))
      loadDraftPlaces(id)
      return { value: "Drafted" }
    }
    return commitDraft(input.cardId)
  }
  /** Make TODO: the author's private Draft of the issue and its discussion, committed like any Draft (spec §14.5.1). */
  const draftFromIssue = async (source: IssueDraftSource) => {
    const refusal = signedIn(); if (refusal) return refusal
    const open = [...ctx.store.collections.cards.values()].some(row => row.kind === "draft" && row.audience_member_id === owner()
      && !row.payload.committed && row.payload.issue?.number === source.number)
    if (open) return { value: "Drafted" }
    let digest: string
    try { digest = issueDigest(source.title, source.body) } catch { return "This issue's text cannot be read." }
    const id = `draft:${randomUuid()}`
    await write(draftCard({ id, author: owner()!, text: issuePrompt(source), title: source.title, options: placeOptions(),
      issue: { number: source.number, title: source.title, url: source.url, fixes: true }, issueDigest: digest,
      idempotencyKey: randomUuid() }, ctx.nextOrdinal(), Date.now()))
    loadDraftPlaces(id)
    return { value: "Drafted" }
  }
  const commitDraft = async (cardId: string) => {
    const refusal = signedIn(); if (refusal) return refusal
    const row = draft(cardId)
    if (!row || row.audience_member_id !== owner() && !row.payload.committed) return "This draft belongs to its author."
    if (row.payload.committed) return { value: `Committed T${row.payload.committed.n}` }
    if (row.payload.request?.state === "accepted") return { value: "Requested" }
    const parsed = DraftCardSchema.safeParse(row.payload)
    if (!parsed.success) return "Invalid draft value."
    const model = { ...row.payload, ...parsed.data }
    const place = model.place
    if (!model.title.trim() || !model.prompt.trim()) return "A TODO needs a title and prompt."
    if (place.mode !== "append" && !place.options.some(option => option.n === place.n && !["merged", "dropped"].includes(option.state))) return "Choose an unmerged TODO."
    const pending = model.request ?? { key: model.idempotencyKey, owner: owner()!, operation: place.mode === "amend" ? "amend" as const : "create" as const,
      n: place.mode === "amend" ? place.n : undefined, state: "requested" as const,
      body: { title: model.title, prompt: model.prompt, acceptance: model.acceptance,
        ...(model.context === undefined ? {} : { context: model.context }),
        ...(place.mode === "amend" ? {} : { place: { mode: place.mode, ...(place.mode !== "append" ? { n: place.n } : {}) } }),
        ...(model.issue ? { issue: model.issue.number, fixes: model.issue.fixes, ...(model.issueDigest ? { issue_digest: model.issueDigest } : {}) } : {}) } }
    const retry: Request = { ...pending, state: "requested", error: undefined }
    await updateRequest(cardId, retry)
    send(cardId, retry)
    return { value: "Requested" }
  }
  const setTodoFormField = async (cardId: string, field: string, value: string): Promise<string | void> => {
    const row = draft(cardId)
    if (!row || row.audience_member_id !== owner() || row.payload.committed) return "This draft belongs to its author."
    if (row.payload.request && row.payload.request.state !== "failed") return "Commit is pending."
    if (row.payload.request) return "Retry the pending commit before editing."
    let patch: Partial<DraftCard>
    try {
      switch (field) {
        case "title": case "prompt": patch = { [field]: value }; break
        case "acceptance": {
          const lines: unknown = value.trim().startsWith("[") ? JSON.parse(value) : value.split("\n").filter(Boolean)
          if (!Array.isArray(lines) || lines.some(line => typeof line !== "string")) return "Invalid draft value."
          patch = { acceptance: lines }; break
        }
        case "place": {
          const place: unknown = JSON.parse(value)
          if (!place || typeof place !== "object" || Array.isArray(place)) return "Invalid draft value."
          const input = place as Record<string, unknown>
          if (Object.keys(input).some(key => key !== "mode" && key !== "n") || input.mode === "append" && "n" in input) return "Invalid draft value."
          patch = { place: { ...input, options: row.payload.place.options } as DraftCard["place"] }; break
        }
        case "fixes": if (value !== "true" && value !== "false") return "Invalid draft value."; patch = { issue: row.payload.issue ? { ...row.payload.issue, fixes: value === "true" } : undefined }; break
        default: return "Unknown draft field."
      }
      const model = DraftCardSchema.parse({ ...row.payload, ...patch })
      const place = model.place
      if (place.mode !== "append" && !place.options.some(option => option.n === place.n && !["merged", "dropped"].includes(option.state))) return "Choose an unmerged TODO."
      await write({ ...row, title: model.title, payload: { ...row.payload, ...model } })
    } catch { return "Invalid draft value." }
  }
  const dismissTodoDraft = (cardId: string): string | void => {
    const row = draft(cardId)
    if (!row || row.audience_member_id !== owner()) return "This draft belongs to its author."
    if (row.payload.committed) return "This draft was committed."
    if (row.payload.request) return "Commit was requested."
    ctx.dispatch({ type: "card.removed", actor: ctx.actor(), id: cardId })
  }
  const amendTodo = (input: Schema.Schema.Type<typeof TodoAmendInput>) => input.cardId
    ? commitDraft(input.cardId) : request(input.n, "amend", { prompt: input.text }, input.idempotencyKey)
  const resumeTodos = () => {
    const epoch = identity()?.ownerRevision ?? identity()?.revision
    if (epoch !== shared.epoch) { stop(); shared.epoch = epoch; publishList({}) }
    if (signedIn()) return
    pollList()
    for (const row of ctx.store.collections.cards.values()) {
      if (row.kind === "todo") {
        // Follow only TODOs this seam fetched or requested; a row without either is the design seed's (MOCK SEAM).
        if (row.payload.model || row.payload.requests.length > 0) watch(row.payload.n)
        for (const pending of row.payload.requests) {
          if (pending.owner === owner() && pending.state !== "failed") { showNotice(pending, row.title); send(row.id, pending) }
        }
      }
      if (row.kind === "draft" && row.audience_member_id === owner()) {
        if (row.payload.request && row.payload.request.state !== "failed") send(row.id, row.payload.request)
        if (!row.payload.request) loadDraftPlaces(row.id)
      }
    }
  }
  const stop = () => {
    for (const abort of shared.aborts.values()) abort.abort()
    shared.aborts.clear()
    for (const unsubscribe of shared.watches.values()) unsubscribe()
    shared.watches.clear()
    for (const timer of shared.timers.values()) clearTimeout(timer)
    shared.timers.clear()
    if (shared.list.timer !== undefined) { clearTimeout(shared.list.timer); shared.list.timer = undefined }
  }
  const subscription = ctx.store.collections.identitySessions.subscribeChanges(() => queueMicrotask(resumeTodos))
  options.onDispose?.(() => { subscription.unsubscribe(); shared.list.disposed = true; stop() })
  return { list, mergeTodo: (n: number, head: string) => request(n, "merge", { reviewed_head_sha: head }), reviewMerge, showTodo, newTodo, draftFromIssue, amendTodo, setTodoFormField, dismissTodoDraft, resumeTodos, applyTodoProjection: applyProjection,
    answerTodo: (n: number, answer: string, wait?: string) => {
      const waits = entry(n)?.payload.model?.waits.filter(row => row.actions.some(action => action.tag === "todo.answer")) ?? []
      const id = wait ?? (waits.length === 1 ? waits[0]!.id : undefined)
      if (!id || !waits.some(row => row.id === id)) return Promise.resolve("Choose an open wait.")
      return request(n, "answer", { answer, wait: id })
    },
    steerTodo: (n: number, text: string) => request(n, "steer", { text }),
    controlTodo: (n: number, operation: "stop" | "resume" | "retry" | "retry-current-flow" | "drop", text?: string) => request(n, operation, text ? { steer: text } : {}),
    /** Move up or Move down (POST /api/todos/{n} {op: move, direction}); a press while the last is pending is that press. */
    moveTodo: (n: number, direction: "up" | "down") => request(n, "move", { direction }),
    disposeTodos: stop }
}
export type TodoSeam = ReturnType<typeof createTodoSeam>
