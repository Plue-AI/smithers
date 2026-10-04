import { todoActors, type ActorContext } from "../ProductActor"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { DraftCardSchema, type DraftCard } from "@smthrs/rpc/DraftCard"
import type { Card } from "@smthrs/rpc/Cards"
import { Data, Schema } from "effect"
import { TodoNewInput, TodoAmendInput } from "../../flows/entries/todo"
import { actorSharedState } from "../ActorBindings"
import type { SeamContext } from "./SeamContext"
import { readResult, unreachableSentence } from "./SeamContext"

class TodoTopicMismatch extends Data.TaggedError("TodoTopicMismatch") { readonly message = "TODO topic mismatch" }

export type TodoEntry = Extract<Card, { kind: "todo" }>
export type DraftEntry = Extract<Card, { kind: "draft" }>
type Request = TodoEntry["payload"]["requests"][number]
export interface TodoReceipt {
  readonly key: string
  /** Server transaction receipt, never inferred from HTTP admission. */
  readonly committed?: { readonly n: number; readonly rev: number }
  readonly outcome?: { readonly status: "ok" | "failed"; readonly detail: string }
}
/** T-APP-08 binds the shared live transport; the payload is the todo:<n> projection. */
export interface TodoTopics {
  readonly subscribe: (topic: `todo:${number}`, receive: (model: unknown, receipts?: readonly TodoReceipt[]) => void) => () => void
}
export interface TodoSeamOptions {
  readonly actors?: () => ActorContext
  readonly topics?: TodoTopics
  readonly debounceMs?: number
  readonly onDispose?: (stop: () => void) => void
}
export const createTodoSeam = (ctx: SeamContext, options: TodoSeamOptions = {}) => {
  const shared = actorSharedState(ctx, "todo", () => ({
    sending: new Set<string>(), aborts: new Map<string, AbortController>(), watches: new Map<number, () => void>(),
    timers: new Map<string, ReturnType<typeof setTimeout>>(), epoch: ctx.store.collections.identitySessions.get("identity")?.ownerRevision ?? ctx.store.collections.identitySessions.get("identity")?.revision
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
  const blank = (n: number): TodoEntry => ({
    id: `todo:${n}`, kind: "todo", title: `T${n}`, status: "active", createdAt: Date.now(),
    ordinal: ctx.nextOrdinal(), payload: { n, requests: [] }
  })
  const noticeKey = (key: string) => `todo.request.${key}`
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
    const unsubscribe = options.topics?.subscribe(`todo:${n}`, (model, receipts = []) => {
      if (!active || !current(login, revision)) return
      published = true
      if (timer) clearTimeout(timer)
      void applyProjection(n, model, receipts, () => active && current(login, revision)).catch(error => ctx.report?.("todo.projection", error))
    })
    // Until this host publishes the topic, refresh persisted source facts through its read route.
    const refresh = async () => {
      if (!active || published || !current(login, revision)) return
      try {
        const response = await ctx.http(`${ctx.baseUrl}/api/todos/${n}`, { credentials: "include" })
        if (response.ok && active && !published && current(login, revision)) {
          await applyProjection(n, await response.json(), [], () => active && !published && current(login, revision))
        }
      } catch (error) { ctx.report?.("todo.refresh", error) }
      if (active && !published && current(login, revision)) timer = setTimeout(() => { void refresh() }, 1000)
    }
    timer = setTimeout(() => { void refresh() }, 1000)
    shared.watches.set(n, () => { active = false; if (timer) clearTimeout(timer); unsubscribe?.() })
  }
  const applyProjection = async (n: number, value: unknown, receipts: readonly TodoReceipt[] = [], stillCurrent?: () => boolean) => {
    const login = owner(), revision = identity()?.ownerRevision ?? identity()?.revision
    const live = stillCurrent ?? (() => current(login, revision))
    if (!live()) return
    const model = TodoCardSchema.parse(todoActors(value, options.actors?.()))
    if (model.n !== n) throw new TodoTopicMismatch()
    const card = entry(n) ?? blank(n)
    // REST snapshots are durable source facts too: admission alone never clears a Draft or a toast.
    const observed: TodoReceipt[] = card.payload.requests.flatMap<TodoReceipt>(request => {
      if (request.state !== "accepted" || receipts.some(receipt => receipt.key === request.key)) return []
      if (request.operation === "merge") return model.state === "merged"
        ? [{ key: request.key, outcome: { status: "ok" as const, detail: "Merged" } }] : []
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
    const control = ["answer", "steer", "stop", "resume", "retry", "retry-current-flow", "drop"].includes(request.operation)
    const route = request.operation === "create" ? "/api/todos"
      : `/api/todos/${request.n}${request.operation === "amend" || control ? "" : `/${request.operation}`}`
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
      const accepted: Request = { ...request, n, state: result.state }
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
    const pending = existing ?? { key: key ?? crypto.randomUUID(), owner: owner()!, operation, n, body, state: "requested" as const }
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
      const response = await ctx.http(`${ctx.baseUrl}/api/todos/${n}`, { credentials: "include" })
      if (!current(login, revision)) return
      if (!response.ok) return "Could not open the TODO."
      const model = TodoCardSchema.parse(todoActors(await response.json(), options.actors?.()))
      await applyProjection(n, model)
      watch(n)
      return readResult(JSON.stringify(model))
    } catch (error) { return unreachableSentence("TODOs", error) }
  }
  const loadDraftPlaces = (id: string) => {
    const login = owner(), revision = identity()?.ownerRevision ?? identity()?.revision
    void (async () => {
      let options: DraftCard["place"]["options"] | undefined, failure: string | undefined
      try {
        const response = await ctx.http(`${ctx.baseUrl}/api/todos`, { credentials: "include" })
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
  const newTodo = async (input: Schema.Schema.Type<typeof TodoNewInput>) => {
    const refusal = signedIn(); if (refusal) return refusal
    if (!input.cardId) {
      const id = `draft:${crypto.randomUUID()}`
      const text = input.text ?? ""
      await write({ id, kind: "draft", audience_member_id: owner()!, title: input.title ?? text.split("\n")[0]!,
        status: "active", createdAt: Date.now(), ordinal: ctx.nextOrdinal(), payload: {
          title: input.title ?? text.split("\n")[0]!, prompt: text, acceptance: [...input.acceptance ?? []],
          place: { ...(input.before ? { mode: "before" as const, n: input.before } : { mode: "append" as const }), options: [...ctx.store.collections.cards.values()]
            .flatMap(row => row.kind === "todo" && row.payload.model && row.payload.model.state !== "merged" && row.payload.model.state !== "dropped"
              ? [{ n: row.payload.n, title: row.title, state: row.payload.model.state }] : []) },
          private: true, idempotencyKey: crypto.randomUUID()
        } })
      loadDraftPlaces(id)
      return { value: "Drafted" }
    }
    return commitDraft(input.cardId)
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
        ...(place.mode === "amend" ? {} : { place: { mode: place.mode, ...(place.mode !== "append" ? { n: place.n } : {}) } }),
        ...(model.issue ? { issue: model.issue.number, fixes: model.issue.fixes } : {}) } }
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
    if (epoch !== shared.epoch) { stop(); shared.epoch = epoch }
    if (signedIn()) return
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
  }
  const subscription = ctx.store.collections.identitySessions.subscribeChanges(() => queueMicrotask(resumeTodos))
  options.onDispose?.(() => { subscription.unsubscribe(); stop() })
  return { mergeTodo: (n: number, head: string) => request(n, "merge", { reviewed_head_sha: head }), showTodo, newTodo, amendTodo, setTodoFormField, dismissTodoDraft, resumeTodos, applyTodoProjection: applyProjection,
    answerTodo: (n: number, answer: string, wait?: string) => {
      const waits = entry(n)?.payload.model?.waits.filter(row => row.actions.some(action => action.tag === "todo.answer")) ?? []
      const id = wait ?? (waits.length === 1 ? waits[0]!.id : undefined)
      if (!id || !waits.some(row => row.id === id)) return Promise.resolve("Choose an open wait.")
      return request(n, "answer", { answer, wait: id })
    },
    steerTodo: (n: number, text: string) => request(n, "steer", { text }),
    controlTodo: (n: number, operation: "stop" | "resume" | "retry" | "retry-current-flow" | "drop", text?: string) => request(n, operation, text ? { steer: text } : {}),
    disposeTodos: stop }
}
export type TodoSeam = ReturnType<typeof createTodoSeam>
