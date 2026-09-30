/*
 * The stack seam: one repository's mythical stack (epic #1745), its history
 * (D-20), through
 * `@smthrs/rpc/Mythical`. `GET …/mythical` is the authoritative snapshot;
 * `GET …/mythical/events` is a stream of hints, each of which coalesces into
 * one more snapshot read (at most one read in flight, at most one a second).
 *
 * The snapshot is live server state, held here in memory and read by the
 * History card and the homepage block through `snapshots`; it is never
 * journaled. The History card (`stack:<repo>`) holds only what the person
 * asked for: the durable bootstrap request and the last failed act.
 *
 * Writes (bootstrap, backfill, lane count, retry) are acknowledged at once and
 * finished in the shared toast stack. Bootstrap's notice runs until the stack
 * reads active, or fails with the worker's error or a freeze. Lane notices
 * follow the items the snapshots show moving: shown after the debounce while
 * an item is in a lane, progressed through its states (a rebase conflict
 * included), and settled only when it reaches an open pull request, lands, or
 * stops.
 *
 * `refreshWiki` asks the stack to refresh the repository Wiki now (or retry a
 * failed refresh). The request is durable (`session.wikiRequests`) before it
 * is acknowledged; its notice runs until the snapshot's Wiki reads `current`
 * or `failed`, reconnects after a reload in `resumeStacks`, and a failure
 * offers Retry (`wiki.create`).
 */
import type { MythicalItem, MythicalStack, MythicalWiki } from "@smthrs/rpc/Mythical"
import { MythicalItemSchema, mythicalRoute, MythicalStackSchema } from "@smthrs/rpc/Mythical"
import { ACTIVE_ITEM_STATES, itemReason, itemStateLabel, itemTitle, retryable, stackCounts } from "@smthrs/rpc/StackView"
import { Data } from "effect"
import { actorSharedState } from "../ActorBindings"
import type { Card, Toast } from "../AppState"
import type { FailureController } from "../controller/failures"
import { TOAST_SUPERSEDED } from "../controller/failures"
import { resolveTargetRepo } from "../RepoContext"
import type { CloudFailure } from "./CloudClient"
import { CloudAnswerUnusable, cloudFailure, cloudUnreachable, createCloudClient } from "./CloudClient"
import type { SeamContext } from "./SeamContext"
import { readResult } from "./SeamContext"

type StackCard = Extract<Card, { kind: "stack" }>
type Failure = NonNullable<StackCard["payload"]["failure"]>
type Result = { readonly value: string } | string
type StackView = NonNullable<StackCard["payload"]["view"]>

export const stackCardId = (repo: string): string => `stack:${repo}`

/** What a reader sees for one repository: the last snapshot and why the last read failed. */
export interface StackSnapshot {
  readonly stack: MythicalStack | null
  readonly error: string | null
}

/** The in-memory snapshots, one per watched repository; `version` changes with every write. */
export interface StackSnapshots {
  readonly get: (repo: string) => StackSnapshot | undefined
  readonly subscribe: (listener: () => void) => () => void
}

/** The history's event stream said this viewer lost access; the read fails as a 403. */
class HistoryAccessRevoked extends Data.TaggedError("HistoryAccessRevoked")<Record<never, never>> {}

export interface StackSeam {
  readonly showStack: (repo?: string) => Promise<Result>
  /** The History card's view: its issue list or its metrics; surfaces the card when absent. */
  readonly setStackView: (view: StackView, repo?: string) => Promise<Result>
  /** One snapshot without a card: the watched one, else a single read. */
  readonly readStack: (repo?: string) => Promise<MythicalStack | string>
  readonly heldStack: (repo: string) => MythicalStack | undefined
  readonly bootstrapStack: (repo: string) => Promise<Result>
  readonly backfillStack: (repo?: string) => Promise<Result>
  readonly setStackParallel: (value: number, repo?: string) => Promise<Result>
  readonly retryStackItem: (id: string, repo?: string) => Promise<Result>
  /** A maintainer's Land on a proposed TODO: ask the stack to merge it at `head` and follow it until it lands or stops. */
  readonly landStackItem: (id: string, head: string, repo?: string) => Promise<Result>
  /** File a TODO for the factory and follow it until the factory settles it. */
  readonly fileTodo: (title: string, body?: string, repo?: string) => Promise<Result>
  /** Refresh the repository Wiki now, or retry a failed refresh. */
  readonly refreshWiki: (repo?: string) => Promise<Result>
  /** The repository homepage declares a stack block: keep its snapshot live. */
  readonly watchHomeStack: (repo: string) => void
  /** Boot and identity changes: reconnect every stored card and bootstrap request. */
  readonly resumeStacks: () => void
  readonly snapshots: StackSnapshots
}

export interface StackSeamOptions {
  /** Reconnect waits (ms), doubled per failure up to the cap; tests shorten them. */
  readonly retryMs?: number
  readonly retryCapMs?: number
  /** The least time between two snapshot reads of one repository. */
  readonly minReadMs?: number
  readonly random?: () => number
  /** The shared toast stack's debounce (ControllerContext.toastDebounceMs). */
  readonly debounceMs?: number
  /** The controller's lifetime: every watch stops with it. */
  readonly onDispose?: (finalizer: () => void) => void
}

interface Watch {
  readonly repo: string
  readonly abort: AbortController
  readonly current: () => boolean
  /** The last snapshot this watch applied: generations only compare within one watch. */
  stack: MythicalStack | null
  reading: Promise<void> | undefined
  dirty: boolean
  lastReadAt: number
  readonly waiters: Set<(stack: MythicalStack | string | typeof TOAST_SUPERSEDED) => void>
  readonly timers: Map<string, ReturnType<typeof setTimeout>>
  /** Items whose running notice the person dismissed: not raised again until the item leaves its lane. */
  readonly dismissed: Set<string>
  /** Items whose running notice this watch put up. */
  readonly shown: Set<string>
}

/** The notice a lane's item wears; one per item. */
const itemToastKey = (repo: string, id: string): string => `stack.item.${encodeURIComponent(repo)}#${id}`
const itemDetail = (item: MythicalItem): string => {
  const reason = itemReason(item)
  return reason === undefined ? itemStateLabel(item) : `${itemStateLabel(item)} · ${reason}`
}
/** Fresh snapshots a followed TODO may be missing from before its notice says so. */
const TODO_ABSENT_READS = 3
/** A refusal that no reconnect will change: stop watching and say so. */
const final = (failure: CloudFailure): boolean => failure.status === 401 || failure.status === 403 || failure.status === 404

export const createStackSeam = (
  ctx: SeamContext,
  withToast: FailureController["withToast"],
  options: StackSeamOptions = {}
): StackSeam => {
  const retryMs = options.retryMs ?? 2_000
  const retryCapMs = options.retryCapMs ?? 60_000
  const minReadMs = options.minReadMs ?? 1_000
  const random = options.random ?? Math.random
  const debounceMs = options.debounceMs ?? 300
  const { url, get, send } = createCloudClient(ctx)
  const route = (name: Parameters<typeof mythicalRoute>[0], repo: string, id?: string): string => {
    const [owner = "", repoName = ""] = repo.split("/")
    // createCloudClient prefixes `/api`.
    return mythicalRoute(name, owner, repoName, id).replace(/^\/api/, "")
  }
  const login = (): string | null => {
    const identity = ctx.store.collections.identitySessions.get("identity")
    return identity?.state === "signed-in" ? identity.login : null
  }
  const shared = actorSharedState(ctx, "stack", () => ({
    watches: new Map<string, Watch>(),
    acts: new Map<string, Promise<unknown>>(),
    homes: new Set<string>(),
    values: new Map<string, StackSnapshot>(),
    listeners: new Set<() => void>(),
    owner: login(),
    subscribed: false,
    /* Items a filed TODO's notice follows: the lane notices leave them to it. */
    followed: new Set<string>(),
    /* The filings whose notices run now, by request key. */
    filings: new Set<string>()
  }))
  const publish = (repo: string, value: StackSnapshot): void => {
    shared.values.set(repo, value)
    for (const listener of shared.listeners) listener()
  }
  const snapshots: StackSnapshots = {
    get: (repo) => shared.values.get(repo),
    subscribe: (listener) => {
      shared.listeners.add(listener)
      return () => { shared.listeners.delete(listener) }
    }
  }
  const card = (repo: string): StackCard | undefined => {
    const value = ctx.store.collections.cards.get(stackCardId(repo))
    return value?.kind === "stack" ? value : undefined
  }
  const disposed = (): boolean => ctx.isDisposed?.() === true

  /** Write the card; `surface` adds it (or moves it) to the end of the transcript. */
  const write = async (repo: string, patch: Partial<StackCard["payload"]>, surface = false): Promise<void> => {
    const previous = card(repo)
    if (previous === undefined && !surface) return
    const payload: StackCard["payload"] = { repo, failure: previous?.payload.failure ?? null,
      ...(previous?.payload.bootstrap === undefined ? {} : { bootstrap: previous.payload.bootstrap }),
      ...(previous?.payload.view === undefined ? {} : { view: previous.payload.view }),
      ...(previous?.payload.todos === undefined ? {} : { todos: previous.payload.todos }), ...patch }
    if (patch.bootstrap === undefined && "bootstrap" in patch) delete (payload as { bootstrap?: unknown }).bootstrap
    if (payload.todos?.length === 0) delete (payload as { todos?: unknown }).todos
    const next: StackCard = {
      id: stackCardId(repo),
      kind: "stack",
      title: `History · ${repo}`,
      status: "active",
      createdAt: previous?.createdAt ?? Date.now(),
      ordinal: surface || previous === undefined ? ctx.nextOrdinal() : previous.ordinal,
      payload
    }
    if (!surface && previous !== undefined && JSON.stringify(previous.payload) === JSON.stringify(payload)) return
    await ctx.dispatch({ type: "card.upsert", actor: "system", card: next }).isPersisted.promise
  }

  /* ---- lane notices ---- */

  const settleItem = (repo: string, stack: MythicalStack, item: MythicalItem): void => {
    const key = itemToastKey(repo, item.id)
    const title = itemTitle(stack, item)
    const reason = itemReason(item)
    switch (item.state) {
      case "proposed":
        ctx.resolveToast?.(key, { status: "ok", title, detail: item.pullRequest === undefined ? "PR open" : `PR #${item.pullRequest.number}` })
        return
      case "landed":
      case "cancelled":
        ctx.resolveToast?.(key, { status: "ok", title, detail: item.state })
        return
      case "skipped":
      case "declined":
        ctx.resolveToast?.(key, { status: "ok", title, detail: reason === undefined ? item.state : `${item.state} · ${reason}` })
        return
      case "blocked":
      case "rejected":
        // The card keeps the Retry row; the notice leaves on its own so blocked items never pile up.
        ctx.resolveToast?.(key, { status: "failed", title, detail: itemDetail(item), autoDismissMs: 30_000,
          ...(item.issue === undefined ? {} : { action: { flow: "history.retry", args: `${item.id} ${repo}`, label: "Retry" } }) })
        return
      default:
    }
  }
  const observeItems = (watch: Watch, previous: MythicalStack | null, next: MythicalStack): void => {
    const { repo } = watch
    const before = new Map((previous?.items ?? []).map((item) => [item.id, item]))
    const listed = new Set<string>()
    for (const item of next.items) {
      listed.add(item.id)
      if (shared.followed.has(item.id)) continue
      const key = itemToastKey(repo, item.id)
      const toast = ctx.store.collections.toasts.get(`toast-${key}`)
      const prior = before.get(item.id)
      if (ACTIVE_ITEM_STATES.has(item.state)) {
        if (toast?.status === "running") {
          if (prior === undefined || itemDetail(prior) !== itemDetail(item)) {
            ctx.dispatch({ type: "toast.progressed", actor: "system", key, detail: itemDetail(item) })
          }
          continue
        }
        // A lane starting on the item (first sight, or again after a settled notice) waits out the debounce.
        if (toast === undefined && watch.shown.has(item.id)) watch.dismissed.add(item.id)
        if (watch.timers.has(item.id) || watch.dismissed.has(item.id) || (prior !== undefined && ACTIVE_ITEM_STATES.has(prior.state) && toast !== undefined)) continue
        const timer = setTimeout(() => {
          watch.timers.delete(item.id)
          const stack = watch.stack
          const now = stack?.items.find((row) => row.id === item.id)
          if (!watch.current() || stack === null || now === undefined || !ACTIVE_ITEM_STATES.has(now.state)) return
          const shownKey = itemToastKey(repo, now.id)
          watch.shown.add(now.id)
          ctx.dispatch({ type: "toast.shown", actor: "system", key: shownKey, title: itemTitle(stack, now) })
          ctx.dispatch({ type: "toast.progressed", actor: "system", key: shownKey, detail: itemDetail(now) })
        }, debounceMs)
        ;(timer as { unref?: () => void }).unref?.()
        watch.timers.set(item.id, timer)
        continue
      }
      const timer = watch.timers.get(item.id)
      if (timer !== undefined) { clearTimeout(timer); watch.timers.delete(item.id) }
      watch.dismissed.delete(item.id)
      watch.shown.delete(item.id)
      if (toast?.status === "running") settleItem(repo, next, item)
    }
    // An item the snapshot no longer lists has nothing left to report.
    const prefix = itemToastKey(repo, "")
    for (const toast of ctx.store.collections.toasts.values()) {
      if (toast.status === "running" && toast.key.startsWith(prefix) && !listed.has(toast.key.slice(prefix.length))) {
        ctx.dispatch({ type: "toast.dismissed", actor: "system", id: toast.id })
      }
    }
  }

  /* ---- the snapshot ---- */

  const apply = (watch: Watch, stack: MythicalStack): void => {
    if (!watch.current()) return
    // Only the stack's own changes raise the generation; an older one is a stale answer.
    if (watch.stack !== null && stack.generation < watch.stack.generation) return
    const previous = watch.stack
    watch.stack = stack
    publish(watch.repo, { stack, error: null })
    observeItems(watch, previous, stack)
    if (stack.state === "active" && card(watch.repo)?.payload.bootstrap !== undefined) {
      write(watch.repo, { bootstrap: undefined }).catch(() => {})
    }
    for (const waiter of [...watch.waiters]) waiter(stack)
  }
  const readFailed = (watch: Watch, failure: CloudFailure): void => {
    if (!watch.current()) return
    publish(watch.repo, { stack: watch.stack, error: failure.error })
    if (final(failure)) stopWatch(watch.repo, failure.error)
  }
  const pause = (watch: Watch, ms: number): Promise<void> => new Promise((resolve) => {
    if (!watch.current() || ms <= 0) { resolve(); return }
    const done = (): void => { clearTimeout(timer); watch.abort.signal.removeEventListener("abort", done); resolve() }
    const timer = setTimeout(done, ms)
    ;(timer as { unref?: () => void }).unref?.()
    watch.abort.signal.addEventListener("abort", done, { once: true })
  })
  /** One read at a time per repository; hints during a read coalesce into one more. */
  const refresh = (watch: Watch): Promise<void> => {
    if (watch.reading !== undefined) { watch.dirty = true; return watch.reading }
    watch.reading = (async () => {
      try {
        do {
          watch.dirty = false
          await pause(watch, watch.lastReadAt + minReadMs - Date.now())
          if (!watch.current()) return
          watch.lastReadAt = Date.now()
          const answer = await get(route("stack", watch.repo), "the stack", watch.abort.signal)
          if (!watch.current()) return
          if ("error" in answer) { readFailed(watch, answer); continue }
          const parsed = MythicalStackSchema.safeParse(answer.body)
          if (parsed.success) apply(watch, parsed.data)
          else readFailed(watch, cloudUnreachable(new CloudAnswerUnusable({ expected: "stack" })))
        } while (watch.dirty && watch.current())
      } catch (error) {
        if (watch.current()) readFailed(watch, cloudUnreachable(error))
      } finally { watch.reading = undefined }
    })()
    return watch.reading
  }
  /** Read the hint stream until it ends; every `mythical` frame is one more snapshot read. */
  const listen = async (watch: Watch): Promise<CloudFailure | undefined> => {
    const stream = ctx.stream
    if (stream === undefined) {
      // A host without the streaming door re-reads on an interval instead.
      await pause(watch, 15_000)
      await refresh(watch)
      return undefined
    }
    const response = await stream(url(route("events", watch.repo)), {
      headers: { accept: "text/event-stream" }, signal: watch.abort.signal
    })
    if (!watch.current()) { await response.body?.cancel().catch(() => {}); return undefined }
    if (!response.ok || response.body === null || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const failure = response.ok ? cloudUnreachable(new CloudAnswerUnusable({ expected: "history event stream" })) :
        await cloudFailure(response, `Smithers Cloud could not open the history's event stream (HTTP ${response.status}).`)
      await response.body?.cancel().catch(() => {})
      return failure
    }
    // The stream only carries hints from now on: a read after it opens covers every earlier one.
    void refresh(watch)
    const reader = response.body.getReader()
    const cancel = (): void => { void reader.cancel().catch(() => {}) }
    watch.abort.signal.addEventListener("abort", cancel, { once: true })
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (watch.current()) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() ?? ""
        if (blocks.some((block) => /^event:\s*revoked\s*$/m.test(block))) {
          const failure = cloudUnreachable(new HistoryAccessRevoked())
          return { ...failure, status: 403 }
        }
        if (blocks.some((block) => /^event:\s*mythical\s*$/m.test(block))) void refresh(watch)
      }
    } finally {
      watch.abort.signal.removeEventListener("abort", cancel)
      await reader.cancel().catch(() => {})
    }
    return undefined
  }
  /** `reason`: a final refusal every waiter settles with; without one the work was superseded. */
  function stopWatch(repo: string, reason?: string): void {
    const watch = shared.watches.get(repo)
    if (watch === undefined) return
    shared.watches.delete(repo)
    watch.abort.abort()
    for (const timer of watch.timers.values()) clearTimeout(timer)
    watch.timers.clear()
    for (const waiter of [...watch.waiters]) waiter(reason ?? TOAST_SUPERSEDED)
    // A snapshot nobody keeps current is not shown as if it were live; a final refusal stays readable.
    if (reason === undefined && shared.values.delete(repo)) for (const listener of shared.listeners) listener()
    const prefix = itemToastKey(repo, "")
    for (const toast of ctx.store.collections.toasts.values()) {
      if (toast.status === "running" && toast.key.startsWith(prefix)) ctx.dispatch({ type: "toast.dismissed", actor: "system", id: toast.id })
    }
  }
  /** Keep one repository's snapshot live until sign-out, an account change, or a final refusal. */
  const watch = (repo: string): Watch => {
    const existing = shared.watches.get(repo)
    if (existing?.current()) return existing
    if (existing !== undefined) stopWatch(repo)
    const owner = login()
    const abort = new AbortController()
    const next: Watch = {
      repo, abort,
      current: () => !disposed() && !abort.signal.aborted && owner !== null && login() === owner && shared.watches.get(repo) === next,
      stack: null, reading: undefined, dirty: false, lastReadAt: 0, waiters: new Set(), timers: new Map(), dismissed: new Set(), shown: new Set()
    }
    shared.watches.set(repo, next)
    void (async () => {
      let failures = 0
      while (next.current()) {
        let failure: CloudFailure | undefined
        try { failure = await listen(next) } catch (error) {
          failure = abort.signal.aborted ? undefined : cloudUnreachable(error)
        }
        if (!next.current()) break
        if (failure !== undefined) {
          // A hint stream that will not open leaves a fresh snapshot fresh: only a final refusal, or no snapshot at all, is stated.
          if (final(failure) || next.stack === null) readFailed(next, failure)
          else void refresh(next)
          if (final(failure)) break
          failures += 1
        } else failures = 0
        const wait = Math.min(retryCapMs, retryMs * 2 ** Math.min(failures, 10))
        await pause(next, Math.max(wait * (0.5 + random() / 2), (failure?.retryAfterSeconds ?? 0) * 1000))
      }
    })()
    return next
  }

  /* ---- the acts ---- */

  const target = (repoArg?: string): { readonly repo: string } | { readonly error: string } => {
    if (login() === null) return { error: "Sign in to see the history." }
    return resolveTargetRepo(ctx.store, repoArg)
  }
  const summary = (stack: MythicalStack): string => {
    const counts = stackCounts(stack)
    const lanes = stack.items.filter((item) => item.lane !== undefined && ACTIVE_ITEM_STATES.has(item.state))
      .map((item) => `lane ${(item.lane ?? 0) + 1}: ${itemTitle(stack, item)} (${itemDetail(item)})`)
    const rows = stack.items.filter((item) => item.state !== "landed" && item.state !== "cancelled").slice(0, 50)
      .map((item) => `${item.id} ${itemTitle(stack, item)}: ${itemDetail(item)}${item.pullRequest === undefined ? "" : ` PR #${item.pullRequest.number}`}`)
    return [
      `History of ${stack.repository}: ${stack.state}${stack.reason === undefined ? "" : ` (${stack.reason})`}, ${counts.changes} changes, ${counts.busy}/${counts.maxParallel} lanes busy, ${counts.queued} queued, ${counts.open} pull requests open, ${counts.blocked} blocked, ${counts.declined} declined. The History card shows it live.`,
      ...lanes, ...rows
    ].join("\n")
  }
  const showStack: StackSeam["showStack"] = async (repoArg) => {
    const resolved = target(repoArg)
    if ("error" in resolved) return resolved.error
    const { repo } = resolved
    await write(repo, {}, true)
    const handle = watch(repo)
    await refresh(handle)
    const value = shared.values.get(repo)
    if (value?.stack == null) return value?.error ?? "The history could not be read."
    return readResult(summary(value.stack))
  }
  const setStackView: StackSeam["setStackView"] = async (view, repoArg) => {
    const resolved = target(repoArg)
    if ("error" in resolved) return resolved.error
    const { repo } = resolved
    if (card(repo) === undefined) {
      await write(repo, { view }, true)
      return showStack(repo)
    }
    await write(repo, { view })
    return { value: `The History card shows its ${view}.` }
  }

  /**
   * Admit one act: acknowledged as soon as the card records it, then run in
   * the shared toast stack. A second request for the same act joins the first.
   */
  type ActKind = Failure["act"] | "wiki" | "land"
  const actKey = (repo: string, kind: ActKind, args: string): string => `stack.${kind}.${encodeURIComponent(repo)}#${args}`
  /** The notice an act wears: one per act and repository; a newer request of the act owns it. */
  const actToastKey = (repo: string, kind: ActKind, args: string): string =>
    args === repo ? `stack.${kind}.${repo}` : `stack.${kind}.${repo}#${args.split(" ")[0]}`
  /**
   * `before` replaces the default card write; `retry` states a failure on the
   * notice with that Retry instead of on the card (an act the card has no row for).
   */
  const act = async (
    repo: string,
    kind: ActKind,
    args: string,
    titles: { readonly running: string; readonly done: string },
    work: () => Promise<true | string | typeof TOAST_SUPERSEDED>,
    options: { readonly before?: () => Promise<void>; readonly retry?: NonNullable<Toast["action"]> } = {}
  ): Promise<Result> => {
    const { before, retry } = options
    // The same request joins the one in flight; the claim is taken before anything awaits.
    const claim = actKey(repo, kind, args)
    if (shared.acts.has(claim)) return { value: "Requested" }
    const key = actToastKey(repo, kind, args)
    let admitted!: () => void
    const admission = new Promise<void>((resolve) => { admitted = resolve })
    shared.acts.set(claim, admission)
    try {
      await (before?.() ?? write(repo, card(repo)?.payload.failure?.act === kind ? { failure: null } : {}, card(repo) === undefined))
      const owner = login()
      const current = (): boolean => !disposed() && login() === owner
      const running = withToast(key, titles.running, titles.done, async () => {
        const outcome = await work()
        if (!current()) return TOAST_SUPERSEDED
        if (typeof outcome === "string" && kind !== "wiki" && kind !== "land") await write(repo, { failure: { act: kind, message: outcome, args } })
        return outcome
      }, false, current).then((outcome) => {
        if (typeof outcome !== "string" || !current()) return outcome
        // A refusal inside the debounce showed nothing; it is still a failure the stack states.
        if (ctx.store.collections.toasts.get(`toast-${key}`) === undefined) {
          ctx.dispatch({ type: "toast.shown", actor: "system", key, title: titles.running })
          ctx.resolveToast?.(key, { status: "failed", detail: outcome, ...(retry === undefined ? {} : { action: retry }) })
        } else if (retry !== undefined) ctx.resolveToast?.(key, { status: "failed", detail: outcome, action: retry })
        return outcome
      }).finally(() => { if (shared.acts.get(claim) === running) shared.acts.delete(claim) })
      shared.acts.set(claim, running)
    } catch (error) {
      shared.acts.delete(claim)
      throw error
    } finally { admitted() }
    return { value: "Requested" }
  }
  /** A write that answers with the snapshot: the watch takes it at once. */
  const writeAndApply = async (repo: string, method: "POST" | "PUT", path: string, body: Record<string, unknown>): Promise<true | string> => {
    const answer = await send(method, path, body, "the stack")
    const handle = watch(repo)
    if ("error" in answer) {
      // A timeout may still have done the work: the card reads what the server holds either way.
      void refresh(handle)
      return answer.error
    }
    const parsed = MythicalStackSchema.safeParse(answer.body)
    if (parsed.success) apply(handle, parsed.data)
    else void refresh(handle)
    return true
  }

  /** Resolves when the stack reads active (true), frozen or failing (its reason), or the watch ends. */
  const untilActive = (repo: string): Promise<true | string | typeof TOAST_SUPERSEDED> => new Promise((resolve) => {
    const handle = watch(repo)
    const check = (stack: MythicalStack | string | typeof TOAST_SUPERSEDED): void => {
      const done = (outcome: true | string | typeof TOAST_SUPERSEDED): void => { handle.waiters.delete(check); resolve(outcome) }
      if (stack === TOAST_SUPERSEDED || typeof stack === "string") done(stack)
      else if (stack.state === "active") done(true)
      else if (stack.state === "frozen") done(stack.reason ?? "The history is frozen.")
      else if (stack.state === "bootstrapping" && stack.lastError !== undefined && stack.lastError !== "") done(stack.lastError)
    }
    handle.waiters.add(check)
    void refresh(handle)
  })
  const runBootstrap = (repo: string, post: boolean, before?: () => Promise<void>): Promise<Result> =>
    act(repo, "bootstrap", repo, { running: "Creating the history…", done: "History ready" }, async () => {
      if (post) {
        const answer = await send("POST", route("bootstrap", repo), {}, "the stack")
        if ("error" in answer) {
          await write(repo, { bootstrap: undefined })
          return answer.error
        }
        const parsed = MythicalStackSchema.safeParse(answer.body)
        // The acknowledgement shows the request; lastError from an earlier pass is not this one's answer.
        if (parsed.success) apply(watch(repo), { ...parsed.data, lastError: undefined })
      }
      const outcome = await untilActive(repo)
      if (typeof outcome === "string") await write(repo, { bootstrap: undefined })
      return outcome
    }, { before })
  const bootstrapStack: StackSeam["bootstrapStack"] = async (repoArg) => {
    const resolved = target(repoArg)
    if ("error" in resolved) return resolved.error
    const { repo } = resolved
    // The request is durable before it is acknowledged.
    return runBootstrap(repo, true, () => write(repo, { bootstrap: { requestedAt: Date.now() }, failure: null }, true))
  }
  const backfillStack: StackSeam["backfillStack"] = async (repoArg) => {
    const resolved = target(repoArg)
    if ("error" in resolved) return resolved.error
    const { repo } = resolved
    return act(repo, "backfill", repo, { running: "Admitting open issues…", done: "Issues admitted" },
      () => writeAndApply(repo, "POST", route("backfill", repo), {}))
  }
  const setStackParallel: StackSeam["setStackParallel"] = async (value, repoArg) => {
    if (!Number.isInteger(value) || value < 1 || value > 8) return "Choose a lane count from 1 to 8."
    const resolved = target(repoArg)
    if ("error" in resolved) return resolved.error
    const { repo } = resolved
    return act(repo, "parallel", `${value} ${repo}`, { running: `Setting ${value} lanes…`, done: `${value} lanes` },
      () => writeAndApply(repo, "PUT", route("config", repo), { maxParallel: value }))
  }
  const retryStackItem: StackSeam["retryStackItem"] = async (id, repoArg) => {
    const resolved = target(repoArg)
    if ("error" in resolved) return resolved.error
    const { repo } = resolved
    return act(repo, "retry", `${id} ${repo}`, { running: "Retrying…", done: "Retry requested" }, async () => {
      const answer = await send("POST", route("retry", repo, id), {}, "the stack")
      void refresh(watch(repo))
      return "error" in answer ? answer.error : true
    })
  }

  /**
   * Resolves when a TODO a maintainer asked to land lands (true), or stops
   * short of it (its words): its pull request closes, its automerge is taken
   * off, or the stack holds it on a failure.
   */
  const untilLanded = (repo: string, id: string, since: string): Promise<true | string | typeof TOAST_SUPERSEDED> => new Promise((resolve) => {
    const handle = watch(repo)
    const check = (stack: MythicalStack | string | typeof TOAST_SUPERSEDED): void => {
      const done = (outcome: true | string | typeof TOAST_SUPERSEDED): void => { handle.waiters.delete(check); resolve(outcome) }
      if (stack === TOAST_SUPERSEDED || typeof stack === "string") { done(stack); return }
      const item = stack.items.find((row) => row.id === id)
      // A read that began before the land was accepted still shows the item without automerge.
      if (item === undefined || item.state === "proposed" && item.automerge !== true && item.updatedAt <= since) return
      if (item.state === "landed") done(true)
      else if (item.state !== "proposed" || item.automerge !== true || item.failure !== undefined) done(itemDetail(item))
    }
    handle.waiters.add(check)
    void refresh(handle)
  })
  const landStackItem: StackSeam["landStackItem"] = async (id, head, repoArg) => {
    const resolved = target(repoArg)
    if ("error" in resolved) return resolved.error
    const { repo } = resolved
    const args = `${id} ${head} ${repo}`
    return act(repo, "land", args, { running: "Landing…", done: "Landed" }, async () => {
      const answer = await send("POST", route("land", repo, id), { head }, "the TODO")
      if ("error" in answer) return answer.error
      const accepted = MythicalItemSchema.safeParse(answer.body)
      return untilLanded(repo, id, accepted.success ? accepted.data.updatedAt : "")
    }, { retry: { flow: "history.land", args, label: "Retry" } })
  }

  /*
   * A filed TODO (POST …/mythical/todos) is durable on the History card
   * before it is acknowledged. Its notice runs through the filing and the
   * factory's work: it follows the item the stack answered through its lane
   * states, and settles when its pull request opens or it lands (done), or
   * it stops (its words, with Retry where a person may retry it). A filing
   * GitHub refused states its failure on the card, and Retry files it again.
   * After a reload the request reconnects without being sent again: a filing
   * whose answer was lost is found by its title among the items filed since.
   */
  type TodoRequest = NonNullable<StackCard["payload"]["todos"]>[number]
  type TodoOutcome = { readonly ok: true; readonly detail: string } | { readonly ok: false; readonly detail: string; readonly action?: NonNullable<Toast["action"]> } | typeof TOAST_SUPERSEDED
  const todoToastKey = (repo: string, key: string): string => `stack.todo.${encodeURIComponent(repo)}#${key}`
  /** A TODO's request key is its text (FNV-1a): the same TODO is one request and one notice. */
  const todoRequestKey = (title: string, body: string): string => {
    let hash = 0x811c9dc5
    for (const unit of `${title}\u0000${body}`) {
      hash ^= unit.codePointAt(0) ?? 0
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, "0")
  }
  const todoArgs = (repo: string, request: Pick<TodoRequest, "title" | "body">): string =>
    JSON.stringify({ title: request.title, ...(request.body === "" ? {} : { body: request.body }), repo })
  const todos = (repo: string): ReadonlyArray<TodoRequest> => card(repo)?.payload.todos ?? []
  const writeTodo = (repo: string, key: string, change: (request: TodoRequest) => TodoRequest | undefined): Promise<void> =>
    write(repo, { todos: todos(repo).flatMap((row) => {
      if (row.key !== key) return [row]
      const next = change(row)
      return next === undefined ? [] : [next]
    }) })
  /** Follows one item until it settles; the notice's detail is its state as the snapshots show it. */
  const untilTodoSettled = (repo: string, id: string, progress: (detail: string) => void): Promise<TodoOutcome | string> => new Promise((resolve) => {
    const handle = watch(repo)
    // The snapshot lists a bounded number of items: one absent from several fresh reads is out of sight, not settled.
    let absent = 0
    const check = (stack: MythicalStack | string | typeof TOAST_SUPERSEDED, fresh = true): void => {
      const done = (outcome: TodoOutcome | string): void => { handle.waiters.delete(check); resolve(outcome) }
      if (stack === TOAST_SUPERSEDED || typeof stack === "string") { done(stack); return }
      const item = stack.items.find((row) => row.id === id)
      if (item === undefined) {
        if (fresh && ++absent >= TODO_ABSENT_READS) done("The history no longer lists this TODO. Open History to see it.")
        return
      }
      absent = 0
      const reason = itemReason(item)
      switch (item.state) {
        case "proposed":
          done({ ok: true, detail: item.pullRequest === undefined ? itemStateLabel(item) : `PR #${item.pullRequest.number}` }); return
        case "landed":
          done({ ok: true, detail: itemStateLabel(item) }); return
        case "blocked": case "rejected": case "declined": case "skipped": case "cancelled":
          done({ ok: false, detail: reason === undefined ? itemStateLabel(item) : `${itemStateLabel(item)} · ${reason}`,
            ...(retryable(item) ? { action: { flow: "history.retry", args: `${item.id} ${repo}`, label: "Retry" } } : {}) })
          return
        default:
          progress(itemDetail(item))
      }
    }
    handle.waiters.add(check)
    if (handle.stack !== null) check(handle.stack, false)
    void refresh(handle)
  })
  /** The filing's request id: the server answers the same id with the TODO it already filed. */
  const todoRequestId = (request: TodoRequest): string => `${request.key}-${request.requestedAt.toString(36)}`
  /**
   * The filing's own answer: the item id, or why it was not filed; `settled`
   * when the server refused it (nothing was filed), else the outcome is
   * unknown and the request stays to be sent again under its id.
   */
  const sendTodo = async (repo: string, request: TodoRequest): Promise<{ readonly id: string } | { readonly error: string; readonly settled: boolean }> => {
    const answer = await send("POST", route("todos", repo),
      { title: request.title, ...(request.body === "" ? {} : { body: request.body }), request: todoRequestId(request) }, "the TODO")
    if ("error" in answer) return { error: answer.error, settled: answer.status !== null && answer.status >= 400 && answer.status < 500 }
    const id = typeof answer.body === "object" && answer.body !== null ? (answer.body as { id?: unknown }).id : undefined
    return typeof id === "string" && id !== "" ? { id } : { error: "Smithers Cloud did not answer with the filed TODO.", settled: false }
  }
  const followTodo = (repo: string, request: TodoRequest): void => {
    const claim = `${repo}#${request.key}`
    if (shared.filings.has(claim)) return
    shared.filings.add(claim)
    const owner = login()
    const current = (): boolean => !disposed() && login() === owner
    const key = todoToastKey(repo, request.key)
    let detail = ""
    let shown = false
    const timer = setTimeout(() => {
      if (!current()) return
      shown = true
      ctx.dispatch({ type: "toast.shown", actor: "system", key, title: request.title })
      if (detail !== "") ctx.dispatch({ type: "toast.progressed", actor: "system", key, detail })
    }, debounceMs)
    ;(timer as { unref?: () => void }).unref?.()
    const progress = (next: string): void => {
      if (next === detail) return
      detail = next
      if (shown) ctx.dispatch({ type: "toast.progressed", actor: "system", key, detail })
    }
    void (async (): Promise<TodoOutcome | string> => {
      let id = request.item
      if (id === undefined) {
        // Sent again after a reload or a lost answer: the id makes it one filing.
        const filed = await sendTodo(repo, request)
        if (!current()) return TOAST_SUPERSEDED
        if ("error" in filed) {
          // A refusal filed nothing; an unknown outcome keeps the request, whose Retry sends the same id.
          if (filed.settled) await writeTodo(repo, request.key, () => undefined)
          await write(repo, { failure: { act: "todo", message: filed.error, args: todoArgs(repo, request) } })
          return { ok: false, detail: filed.error, action: { flow: "history.todo", args: todoArgs(repo, request), label: "Retry" } }
        }
        id = filed.id
        await writeTodo(repo, request.key, (row) => ({ ...row, item: filed.id }))
      }
      shared.followed.add(id)
      // The TODO's notice owns its item: a lane notice already pending or shown for it leaves.
      const lane = shared.watches.get(repo)
      const pending = lane?.timers.get(id)
      if (pending !== undefined) { clearTimeout(pending); lane?.timers.delete(id) }
      const laneToast = ctx.store.collections.toasts.get(`toast-${itemToastKey(repo, id)}`)
      if (laneToast?.status === "running") ctx.dispatch({ type: "toast.dismissed", actor: "system", id: laneToast.id })
      try {
        return await untilTodoSettled(repo, id, progress)
      } finally { shared.followed.delete(id) }
    })().catch((error: unknown) => {
      try { ctx.report?.(`stack.todo.follow ${repo}`, error) } catch { /* Diagnostics must not strand the filing. */ }
      return { ok: false as const, detail: "Smithers lost track of this TODO. Open History to see its state." }
    })
      .then(async (outcome) => {
        clearTimeout(timer)
        shared.filings.delete(claim)
        if (outcome === TOAST_SUPERSEDED || !current()) {
          if (!disposed() && ctx.store.collections.toasts.get(`toast-${key}`)?.status === "running") ctx.dispatch({ type: "toast.dismissed", actor: "system", id: `toast-${key}` })
          return
        }
        const settled: Exclude<TodoOutcome, typeof TOAST_SUPERSEDED> = typeof outcome === "string" ? { ok: false, detail: outcome } : outcome
        if (settled.ok || todos(repo).find((row) => row.key === request.key)?.item !== undefined) await writeTodo(repo, request.key, () => undefined)
        if (ctx.store.collections.toasts.get(`toast-${key}`) === undefined) ctx.dispatch({ type: "toast.shown", actor: "system", key, title: request.title })
        ctx.resolveToast?.(key, settled.ok ? { status: "ok", detail: settled.detail }
          : { status: "failed", detail: settled.detail, ...(settled.action === undefined ? {} : { action: settled.action }) })
      }).catch(() => {})
  }
  const fileTodo: StackSeam["fileTodo"] = async (title, body = "", repoArg) => {
    const resolved = target(repoArg)
    if ("error" in resolved) return resolved.error
    const { repo } = resolved
    const request = { title: title.trim(), body: body.trim() }
    if (request.title === "") return "A TODO needs a title."
    // The same TODO asked for again joins the one still followed; a retried
    // filing takes over its failed notice and sends its request id again.
    const key = todoRequestKey(request.title, request.body)
    const clear = card(repo)?.payload.failure?.act === "todo" ? { failure: null } : {}
    const existing = todos(repo).find((row) => row.key === key)
    if (existing !== undefined) {
      if (!shared.filings.has(`${repo}#${key}`)) {
        await write(repo, clear)
        followTodo(repo, existing)
      }
      return { value: "Requested" }
    }
    const row: TodoRequest = { key, ...request, requestedAt: Date.now() }
    // The request is durable before it is acknowledged.
    await write(repo, { todos: [...todos(repo), row], ...clear }, card(repo) === undefined)
    followTodo(repo, row)
    return { value: "Requested" }
  }

  /*
   * The Wiki's answer to a request: `current` is done, `failed` is its error.
   * `baseline` is the Wiki the request's acknowledgement showed: the failure
   * a retry was asked for is not the retry's answer, so an unchanged failed
   * Wiki keeps the notice running until the next attempt settles.
   */
  const wikiOutcome = (wiki: MythicalWiki | undefined, baseline: MythicalWiki | undefined): true | string | undefined => {
    if (wiki === undefined) return "This repository declares no Wiki."
    if (wiki.state === "current") return true
    if (wiki.state !== "failed") return undefined
    if (baseline?.state === "failed" && baseline.attempt === wiki.attempt && baseline.commit === wiki.commit) return undefined
    return wiki.error ?? "The Wiki refresh failed."
  }
  const untilWikiSettled = (repo: string, baseline: MythicalWiki | undefined): Promise<true | string | typeof TOAST_SUPERSEDED> => new Promise((resolve) => {
    const handle = watch(repo)
    const check = (stack: MythicalStack | string | typeof TOAST_SUPERSEDED): void => {
      const outcome = stack === TOAST_SUPERSEDED || typeof stack === "string" ? stack : wikiOutcome(stack.wiki, baseline)
      if (outcome === undefined) return
      handle.waiters.delete(check)
      resolve(outcome)
    }
    handle.waiters.add(check)
    if (baseline !== undefined && handle.stack !== null) check(handle.stack)
    else void refresh(handle)
  })
  const wikiTitles = { running: "Refreshing the Wiki…", done: "Wiki current" }
  const wikiRetry = (repo: string): NonNullable<Toast["action"]> => ({ flow: "wiki.create", args: repo, label: "Retry" })
  const wikiRequests = () => ctx.store.session().wikiRequests ?? []
  const writeWikiRequests = async (requests: NonNullable<ReturnType<typeof ctx.store.session>["wikiRequests"]>): Promise<void> => {
    await ctx.dispatch({ type: "stack.wiki.requests.changed", actor: "system", requests }).isPersisted.promise
  }
  const otherWikiRequests = (repo: string, owner: string) => wikiRequests().filter((row) => row.repo !== repo || row.owner !== owner)
  const pendingWiki = (repo: string, owner: string | null): boolean =>
    owner !== null && wikiRequests().some((row) => row.repo === repo && row.owner === owner)
  /** A settled request leaves the session; one superseded by an account change waits for that account's return. */
  const settleWiki = async (repo: string, owner: string, work: () => Promise<true | string | typeof TOAST_SUPERSEDED>) => {
    const outcome = await work()
    if (!disposed() && (outcome !== TOAST_SUPERSEDED || login() === owner) && pendingWiki(repo, owner)) {
      await writeWikiRequests(otherWikiRequests(repo, owner))
    }
    return outcome
  }
  const refreshWiki: StackSeam["refreshWiki"] = async (repoArg) => {
    const resolved = target(repoArg)
    if ("error" in resolved) return resolved.error
    const { repo } = resolved
    const owner = login()!
    return act(repo, "wiki", repo, wikiTitles, () => settleWiki(repo, owner, async () => {
      const answer = await send("POST", route("wiki", repo), {}, "the stack")
      const handle = watch(repo)
      if ("error" in answer) {
        void refresh(handle)
        return answer.error
      }
      const parsed = MythicalStackSchema.safeParse(answer.body)
      if (!parsed.success) return untilWikiSettled(repo, undefined)
      apply(handle, parsed.data)
      return untilWikiSettled(repo, parsed.data.wiki)
    }), {
      // The request is durable before it is acknowledged.
      before: async () => {
        await write(repo, {}, card(repo) === undefined)
        await writeWikiRequests([...otherWikiRequests(repo, owner), { repo, owner, requestedAt: Date.now() }])
      },
      retry: wikiRetry(repo)
    })
  }
  /** A request from an earlier page load follows the snapshot to its end without being sent again. */
  const resumeWiki = (repo: string): void => {
    const owner = login()
    if (owner === null || !pendingWiki(repo, owner) || shared.acts.has(actKey(repo, "wiki", repo))) return
    void act(repo, "wiki", repo, wikiTitles, () => settleWiki(repo, owner, () => untilWikiSettled(repo, undefined)),
      { before: async () => {}, retry: wikiRetry(repo) }).catch(() => {})
  }

  /* One homepage is on screen at a time: the previous repository's watch ends unless its card still needs it. */
  const watchHomeStack: StackSeam["watchHomeStack"] = (repo) => {
    if (disposed()) return
    for (const previous of shared.homes) {
      if (previous !== repo && card(previous) === undefined) stopWatch(previous)
    }
    shared.homes.clear()
    shared.homes.add(repo)
    if (login() !== null && shared.watches.get(repo)?.current() !== true) void refresh(watch(repo))
  }
  const resumeStacks: StackSeam["resumeStacks"] = () => {
    if (disposed()) return
    const owner = login()
    if (owner !== shared.owner) {
      // Another account's snapshots never stay on screen.
      shared.owner = owner
      for (const repo of [...shared.watches.keys()]) stopWatch(repo)
      shared.values.clear()
      for (const listener of shared.listeners) listener()
    }
    if (owner === null) return
    const repos = new Set(shared.homes)
    for (const value of ctx.store.collections.cards.values()) if (value.kind === "stack") repos.add(value.payload.repo)
    for (const request of wikiRequests()) if (request.owner === owner) repos.add(request.repo)
    for (const repo of repos) {
      // A watch already live for this account has nothing to reconnect.
      if (shared.watches.get(repo)?.current()) continue
      const handle = watch(repo)
      void refresh(handle)
      resumeWiki(repo)
      for (const request of todos(repo)) followTodo(repo, request)
      if (card(repo)?.payload.bootstrap !== undefined && !shared.acts.has(actKey(repo, "bootstrap", repo))) {
        // Re-send only when the server has no record of the request.
        void (async () => {
          await refresh(handle)
          const stack = shared.values.get(repo)?.stack
          if (stack == null || card(repo)?.payload.bootstrap === undefined) return
          await runBootstrap(repo, stack.state === "absent")
        })().catch(() => {})
      }
    }
  }

  if (!shared.subscribed) {
    shared.subscribed = true
    const subscription = ctx.store.collections.cards.subscribeChanges((changes) => {
      for (const change of changes) {
        const key = String(change.key)
        if (change.type !== "delete" || !key.startsWith("stack:")) continue
        const repo = key.slice("stack:".length)
        if (!shared.homes.has(repo)) stopWatch(repo)
      }
    })
    const identity = ctx.store.collections.identitySessions.subscribeChanges(() => queueMicrotask(resumeStacks))
    const stop = (): void => {
      subscription.unsubscribe()
      identity.unsubscribe()
      for (const repo of [...shared.watches.keys()]) stopWatch(repo)
    }
    // Without a lifetime hook the controller's dispose check still stops every loop.
    options.onDispose?.(stop)
  }

  /** A watched snapshot, only while the account that read it is still signed in. */
  const heldStack: StackSeam["heldStack"] = (repo) => {
    const current = login()
    if (current === null || current !== shared.owner) return undefined
    return shared.values.get(repo)?.stack ?? undefined
  }

  /** One snapshot for a reader that shows no card (search.history): the live one when watched, else one read. */
  const readStack: StackSeam["readStack"] = async (repoArg) => {
    const resolved = target(repoArg)
    if ("error" in resolved) return resolved.error
    const held = heldStack(resolved.repo)
    if (held !== undefined) return held
    const answer = await get(route("stack", resolved.repo), "the history")
    if ("error" in answer) return answer.error
    const parsed = MythicalStackSchema.safeParse(answer.body)
    return parsed.success ? parsed.data : "The history could not be read."
  }

  return { showStack, setStackView, readStack, heldStack, bootstrapStack, backfillStack, setStackParallel, retryStackItem, landStackItem, fileTodo, refreshWiki, watchHomeStack, resumeStacks, snapshots }
}
