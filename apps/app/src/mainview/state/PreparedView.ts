import { conversationTabIdOf,type Card } from "./AppState";
import { paneTarget } from "./EmbeddedHistory";
import { signInRequired } from "./seams/SeamContext";
import type { SeamContext } from "./seams/SeamContext";

export type ViewResult = string | { readonly card: Card; readonly value?: string }
export type ViewAction<A extends unknown[]> = ((...args: A) => Promise<string | void | { readonly value: string }>) & {
  readonly preload?: (...args: A) => Promise<void>
}
interface DirectView { readonly run: () => Promise<string | void | { readonly value: string }> }
interface ViewPlan {
  readonly id: string
  readonly title: string
  readonly placeholder?: Card
  readonly project?: (card: Card) => Card
  /** Include every input that changes the read, including filters and revisions. */
  readonly key?: string
  readonly pane?: string
  /** An already-open surface whose explicit navigation should replace it in place. */
  readonly target?: Card
  readonly read: () => Promise<ViewResult>
  readonly before?: () => Promise<string | void | true>
  readonly after?: () => void | Promise<void>
}

const scopes = new WeakMap<SeamContext["store"], {
  cache: Map<string, { promise: Promise<ViewResult>; expires: number; settled: boolean }>
  active: Map<string, symbol>
}>()
const stateFor = (ctx: SeamContext) => {
  let state = scopes.get(ctx.store)
  if (!state) scopes.set(ctx.store, state = { cache: new Map(), active: new Map() })
  return state
}
const scopeOf = (ctx: SeamContext) => {
  const identity = ctx.store.collections.identitySessions.get("identity")
  const cloud = ctx.store.collections.cloudSessions.get("cloud")
  return JSON.stringify([
    identity && [identity.state, identity.accountOwnerLogin, identity.login, identity.admin, identity.ownerRevision ?? identity.revision],
    cloud && [cloud.state, cloud.username, cloud.scopes, cloud.ownerRevision ?? cloud.revision],
    ctx.store.session().activeRepoKey,
    ctx.store.session().activeWorkspaceId,
    ctx.store.session().activeBranchId,
    conversationTabIdOf(ctx.store.session()),
  ])
}

/** Mutations and identity changes discard speculative reads, including in-flight results. */
export function disposePreparedViews(store: SeamContext["store"]) {
  scopes.get(store)?.active.clear()
  scopes.get(store)?.cache.clear()
  scopes.delete(store)
}

export function invalidatePreparedViews(store: SeamContext["store"]) {
  scopes.get(store)?.cache.clear()
}

/** One read feeds intent preloading and activation. Only activation publishes application state. */
export function preparedView<A extends unknown[]>(ctx: SeamContext, resolve: (...args: A) => ViewPlan | DirectView | string): ViewAction<A> & { readonly preload: (...args: A) => Promise<void> } {
  const state = stateFor(ctx)
  const live = () => scopes.get(ctx.store) === state && ctx.isDisposed?.() !== true
  const request = (plan: ViewPlan, scope: string) => {
    const key = JSON.stringify([scope, plan.key ?? plan.id])
    const existing = state.cache.get(key)
    if (existing && (!existing.settled || existing.expires > Date.now())) return existing.promise
    const promise = Promise.resolve().then(plan.read)
    {
      const entry = { promise, expires: Date.now() + 15_000, settled: false }
      state.cache.delete(key)
      state.cache.set(key, entry)
      while (state.cache.size > 30) state.cache.delete(state.cache.keys().next().value!)
      void promise.then(result => {
        entry.settled = true
        entry.expires = Date.now() + 15_000
        if (typeof result === "string" && state.cache.get(key) === entry) state.cache.delete(key)
      }, () => { entry.settled = true; if (state.cache.get(key) === entry) state.cache.delete(key) })
    }
    return promise
  }
  const run = async (...args: A) => {
    if (!live()) return
    const plan = resolve(...args)
    if (typeof plan === "string") return plan
    if ("run" in plan) return plan.run()
    const scope = scopeOf(ctx)
    let activeScope = scope
    const actor = ctx.actor()
    const previous = plan.target ?? (plan.pane ? paneTarget(ctx, plan.pane) : undefined) ?? ctx.store.collections.cards.get(plan.id)
    const id = previous?.id ?? plan.id
    const key = plan.key ?? plan.id
    const token = Symbol()
    state.active.set(id, token)
    const valid = () => live() && state.active.get(id) === token && scopeOf(ctx) === activeScope && ctx.store.collections.cards.has(id)
    const current = () => valid() && ctx.store.collections.cards.get(id)?.viewKey === key
    const navigates = plan.pane !== undefined || plan.target !== undefined
    const common = { id, title: plan.title, viewKey: key, viewRepo: plan.pane ?? previous?.viewRepo, navigation: previous?.navigation, createdAt: previous?.createdAt ?? Date.now(), ordinal: navigates && previous ? previous.ordinal : ctx.nextOrdinal(), tabId: previous?.tabId }
    const pending: Card = previous?.viewKey === key && !previous.loading && previous.status !== "error"
      ? { ...previous, ...common }
      : plan.placeholder ? { ...plan.placeholder, ...common, loading: true } : { ...common, kind: "status", status: "active", loading: true, payload: {} }
    ctx.dispatch({ type: previous && !previous.loading && previous.viewKey !== key && navigates ? "card.navigated" : "card.upsert", actor, card: pending })
    // The first card creates its frame's workspace and branch synchronously.
    activeScope = scopeOf(ctx)
    try {
      const ready = await plan.before?.()
      const result = typeof ready === "string" ? ready : await request(plan, scope)
      if (!valid()) return
      if (typeof result === "string") {
        const navigation = ctx.store.collections.cards.get(id)?.navigation
        ctx.dispatch({ type: "card.view.loaded", actor, card: { ...pending, navigation, loading: false, status: "error", body: result } })
        return current() ? result : undefined
      }
      const navigation = ctx.store.collections.cards.get(id)?.navigation
      const card = plan.project?.(result.card) ?? result.card
      await ctx.dispatch({ type: "card.view.loaded", actor, card: { ...card, body: card.body, ...common, title: card.title, navigation, loading: false } }).isPersisted.promise
      if (!current()) return
      await plan.after?.()
      return result.value === undefined ? undefined : { value: result.value }
    } catch (error) {
      /*
       * A sign-in refusal is not a broken view. The caller answers it with
       * the sign-in step and its button, and "This view couldn't be loaded.
       * Try opening it again." beside that step says the opposite of the
       * truth — opening it again never works, signing in does. The read
       * produced no view, so the speculative card leaves and the refusal is
       * the whole answer; a view that was already loaded keeps what it had.
       */
      if (valid()) {
        if (!signInRequired(error)) {
          const navigation = ctx.store.collections.cards.get(id)?.navigation
          ctx.dispatch({ type: "card.view.loaded", actor, card: { ...pending, navigation, loading: false, status: "error", body: "This view couldn't be loaded. Try opening it again." } })
        } else if (previous !== undefined && !previous.loading) {
          ctx.dispatch({ type: "card.view.loaded", actor, card: previous })
        } else {
          ctx.dispatch({ type: "card.removed", actor, id })
        }
      }
      throw error
    } finally {
      const interrupted = live() ? ctx.store.collections.cards.get(id) : undefined
      if (live() && state.active.get(id) === token && scopeOf(ctx) !== activeScope && interrupted?.loading && interrupted.viewKey === key) {
        ctx.dispatch({ type: "card.view.loaded", actor, card: { ...interrupted, loading: false, status: "error", body: "Loading was interrupted. Open this view again to retry." } })
      }
      if (state.active.get(id) === token) state.active.delete(id)
      if (!state.active.has(id)) state.cache.delete(JSON.stringify([scope, key]))
    }
  }
  return Object.assign(run, { preload: async (...args: A) => {
    if (!live()) return
    const plan = resolve(...args)
    if (typeof plan !== "string" && !("run" in plan)) {
      if ([...state.cache.values()].filter(entry => !entry.settled).length >= 4) return
      await request(plan, scopeOf(ctx)).catch(() => {})
    }
  } })
}
