import { noticeDismissDelay, shouldShowSettlement } from "@smthrs/ui/notification-policy"
import { claimWorkToast } from "./backgroundWork"
import type { CommandOutcome } from "../../flows/Commands"
import { ToastSchema, type Toast } from "../AppState"
import { spokenLostAct } from "../BrowserWriteFailure"
import type { ControllerContext } from "./context"
import { claimedSpokenLines,claimSpokenLine, forgetVanishedClaims,latestOrdinal } from "./spokenLines"

/**
 * Launch Checklist D-4's exhausted-balance refusal, shared between the
 * `zeroBalanceGuard` that renders it on the embedded out-of-credit plans card
 * (with its Upgrade door) and
 * `surfaceCommandFailure`, which recognizes it to skip its toast (the
 * refusal is already an embedded chat message; a toast would double-surface
 * it). Names the upgrade path per the definition of done: "how to proceed".
 */
export const ZERO_BALANCE_EXHAUSTED_TEXT =
  "Add credit to keep working. Pro includes $50 of model credit each month."

/**
 * A settled run with nothing to report: the work it named was superseded —
 * a newer identity or account epoch owns the answer — so it wrote nothing.
 * `withToast` dismisses the notice instead of resolving it, because stating
 * "done" for a result that was thrown away is the silent-lie shape.
 */
export const TOAST_SUPERSEDED: unique symbol = Symbol("toast.superseded")

/** The worker confirmed cancellation; this is neither completion nor failure. */
export const TOAST_CANCELLED: unique symbol = Symbol("toast.cancelled")

/** Readiness invalidates only the earlier "still preparing" notice for this workspace. */
export const dismissReadyWorkspaceFailures = (
  ctx: ControllerContext, repo: string, workspaceId?: string
): void => {
  const detail = `The workspace for ${repo} is still being prepared. Try again in a moment.`
  const catalog = workspaceId === undefined ? `flow.catalog.workflow-list-${repo}`
    : `flow.catalog.workflow-list@${encodeURIComponent(repo)}@${encodeURIComponent(workspaceId)}`
  const keys = new Set([catalog, `flow.provision.${repo}.${workspaceId ?? "legacy"}`])
  for (const toast of ctx.store.collections.toasts.values()) {
    if (toast.status === "failed" && keys.has(toast.key) &&
      (toast.detail === detail || toast.detail.startsWith("workspace_starting — "))) {
      ctx.store.dispatch({ type: "toast.dismissed", actor: "system", id: toast.id })
    }
  }
}

/** Notices name registered acts in words; unrelated paths in seam errors stay intact. */
export const humanCommandText = (commands: ControllerContext["commands"], text: string): string =>
  text.replace(/(^|[\s`(])\/([a-z][\w-]*(?:\.[\w-]+)*)(?![\w/-])/g,
    (reference, prefix: string, name: string) => {
      const summary = commands.find(name)?.metadata.summary
      return summary ? `${prefix}${summary}` : reference
    })

export interface FailureController {
  /** `quiet` work states nothing it succeeds at; only its failure is surfaced. */
  readonly withToast: <T>(
    key: string,
    title: string,
    doneTitle: string,
    work: () => Promise<T | string>,
    quiet?: boolean,
    current?: () => boolean,
    sourceCard?: string
  ) => Promise<T | string>
  /**
   * Resolve the toast on `key`; ok and cancelled outcomes dismiss after
   * toastAutoDismissMs. Every ok resolution goes through here.
   */
  readonly resolveToast: (
    key: string,
    outcome: { readonly status: "ok" | "failed" | "cancelled"; readonly title?: string; readonly detail: string; readonly action?: Toast["action"]; readonly autoDismissMs?: number }
  ) => void
  readonly dismissToast: (id: string) => void
  /**
   * State a settled command's failure. `saidBefore` is the transcript's latest
   * ordinal as of the moment this act was admitted: only a door's own sentence
   * spoken after that point stands in for the line this owes the person. A
   * caller without one gets a duplicate line at worst, never silence.
   */
  readonly surfaceCommandFailure: (name: string, outcome: CommandOutcome, saidBefore?: number) => void
}

export const createFailureController = (ctx: ControllerContext): FailureController => {
  /*
   * The door lines already spent on an act (controller/spokenLines.ts),
   * shared with the other surface that yields to one — the form card's error
   * row (controller/forms.ts). It is pruned to the lines the transcript still
   * holds on every claim.
   */
  const claimedLines = claimedSpokenLines(ctx)
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const dismissals = new Map<string, { timer: ReturnType<typeof setTimeout>; snapshot: string }>()
  let stopObservingToasts: (() => void) | undefined
  // TanStack replaces row objects and virtual sync metadata on persistence.
  // Compare only the schema's domain fields when observing external changes.
  const toastSnapshot = (toast: Toast): string => JSON.stringify(ToastSchema.parse(toast))
  const cancelDismissal = (id: string): void => {
    const pending = dismissals.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    timers.delete(pending.timer)
    dismissals.delete(id)
  }
  const later = (work: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!ctx.disposed) work()
    }, delay)
    timers.add(timer)
    ctx.unref(timer)
    return timer
  }
  ctx.onDispose(() => {
    stopObservingToasts?.()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    dismissals.clear()
    ctx.toastRuns.clear()
  })
  /*
   * The one place an ok toast learns to leave. The sign-in handoff's
   * "Signed in" (2026-09-01) dispatched toast.resolved directly, so nothing
   * ever dismissed it: it stood for the rest of the session, and only a
   * failure toast offers a dismiss control. The dismissal is guarded by the
   * scheduled settlement and any intervening toast change. Wall-clock timestamps
   * cannot identify a settlement: two results can share a millisecond.
   */
  const resolveToast: FailureController["resolveToast"] = (key, outcome) => {
    if (ctx.disposed) return
    const id = `toast-${key}`
    if (ctx.store.collections.toasts.get(id) === undefined) return
    ctx.store.dispatch({
      type: "toast.resolved",
      actor: "system",
      key,
      status: outcome.status,
      ...(outcome.title === undefined ? {} : { title: outcome.title }),
      detail: outcome.detail,
      action: outcome.action
    })
    cancelDismissal(id)
    const delay = noticeDismissDelay(outcome.status, ctx.toastAutoDismissMs, outcome.autoDismissMs)
    if (delay === undefined) return
    const resolved = ctx.store.collections.toasts.get(id)
    if (resolved === undefined) return
    const snapshot = toastSnapshot(resolved)
    if (stopObservingToasts === undefined) {
      const subscription = ctx.store.collections.toasts.subscribeChanges(changes => {
        for (const change of changes) {
          const pending = dismissals.get(change.value.id)
          if (pending === undefined) continue
          const current = ctx.store.collections.toasts.get(change.value.id)
          if (current === undefined || toastSnapshot(current) !== pending.snapshot) cancelDismissal(change.value.id)
        }
      })
      stopObservingToasts = () => subscription.unsubscribe()
    }
    const timer = later(() => {
      if (dismissals.get(id)?.timer !== timer) return
      dismissals.delete(id)
      const current = ctx.store.collections.toasts.get(id)
      if (current === undefined || toastSnapshot(current) !== snapshot) return
      ctx.store.dispatch({ type: "toast.dismissed", actor: "system", id })
    }, delay)
    dismissals.set(id, { timer, snapshot })
  }
  /** A thrown flow is still an honest failure — never a toast stuck "running". */
  const unexpectedFailure = (title: string): string =>
    `${title.replace(/…$/, "")} didn't finish — the app hit an unexpected error.`
  /*
   * Work the user never asked for has no result they can see, so it says
   * nothing until it fails: no running notice, no done title, and no claim on
   * the key's run slot, which leaves the work a user DID ask for owning its
   * own notice and resolving it. A failure is shown and resolved in one go,
   * because resolveToast writes nothing onto a key with no toast on screen —
   * which also means quiet work surfaces a failure at any speed.
   *
   * Succeeding is how quiet work takes its own failure back down. The
   * sentence a failed read left says the read did not happen; the next one
   * that did makes it false, and nothing else on screen would ever clear it.
   * Only a failure, and only with no announcing run holding the key: a
   * running notice and a "done" the user asked for are not this run's to move.
   */
  const quietly = async <T>(key: string, title: string, work: () => Promise<T | string>, current?: () => boolean): Promise<T | string> => {
    let outcome: T | string
    try {
      outcome = await work()
    } catch (error) {
      ctx.failures.report("toast.work", error, key)
      outcome = unexpectedFailure(title)
    }
    if (ctx.disposed || current?.() === false) return outcome
    const id = `toast-${key}`
    if (typeof outcome !== "string") {
      if (outcome !== TOAST_SUPERSEDED && !ctx.toastRuns.has(key)
        && ctx.store.collections.toasts.get(id)?.status === "failed") {
        ctx.store.dispatch({ type: "toast.dismissed", actor: "system", id })
      }
      return outcome
    }
    ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title })
    resolveToast(key, { status: "failed", detail: outcome })
    return outcome
  }
  /*
   * The 300ms toast law (2026-08-09): background work not settled within
   * 300ms states what is running on the shared toast stack; work under
   * 300ms never flashes a success. Failures remain visible at any speed.
   * `work` answers true on success or the
   * honest failure line — a failure toast stays until dismissed, an ok
   * toast resolves into the result and dismisses itself.
   */
  /*
   * Ownership is allocated, never counted: `toastRuns` says who owns a key's
   * toast right now, and a settled run's terminal delete used to hand its
   * number straight back. With A pending, B settling and C starting after,
   * C was issued A's number and A could then resolve C's toast. This
   * sequence is controller-wide and monotonic, so no deletion can recycle a
   * number while the run that holds it is still in flight.
   */
  let nextRun = 0
  /*
   * One toast per flow key, so a re-run of the same flow owns the slot: the
   * run counter keeps a finished run from resolving OR auto-dismissing the
   * toast a newer run is using — a running notice must never silently vanish
   * while the work it names is still in flight.
   */
  const withToast = async <T>(
    key: string,
    title: string,
    doneTitle: string,
    work: () => Promise<T | string>,
    quiet = false,
    current?: () => boolean,
    sourceCard?: string
  ): Promise<T | string> => {
    if (sourceCard !== undefined) claimWorkToast(ctx.store, sourceCard, key)
    if (quiet) return quietly(key, title, work, current)
    nextRun += 1
    const run = nextRun
    ctx.toastRuns.set(key, run)
    let shown = false
    const debounce = later(() => {
      if (ctx.toastRuns.get(key) !== run || current?.() === false) return
      shown = true
      ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title, ...(sourceCard === undefined ? {} : { sourceCard }) })
    }, ctx.toastDebounceMs)
    let outcome: T | string
    try {
      outcome = await work()
    } catch (error) {
      ctx.failures.report("toast.work", error, key)
      outcome = unexpectedFailure(title)
    } finally {
      clearTimeout(debounce)
      timers.delete(debounce)
    }
    // A newer run of the same flow owns the toast now; this one reports nothing.
    if (ctx.disposed || ctx.toastRuns.get(key) !== run) return outcome
    // Superseded work has no result to state: whatever it read belongs to an
    // account the app no longer has open, so the notice leaves silently
    // rather than resolving into a doneTitle nothing backs.
    if (outcome === TOAST_SUPERSEDED || current?.() === false) {
      const id = `toast-${key}`
      if (ctx.store.collections.toasts.get(id) !== undefined) {
        ctx.store.dispatch({ type: "toast.dismissed", actor: "system", id })
      }
      ctx.toastRuns.delete(key)
      return outcome
    }
    // Resolve whatever is on screen for this key — including a toast an
    // earlier (slower) run put up, or a failed one this run just retried.
    const hasToast = ctx.store.collections.toasts.get(`toast-${key}`) !== undefined
    if (!shouldShowSettlement(typeof outcome === "string", shown || hasToast)) {
      // Settled with nothing ever shown: the run slot is terminal, so the
      // counter entry leaves with it (the map otherwise grows one entry per
      // flow key and never lets go).
      ctx.toastRuns.delete(key)
      return outcome
    }
    if (!hasToast) {
      ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title, ...(sourceCard === undefined ? {} : { sourceCard }) })
    }
    // A cancellation has its own receipt; a string is the honest failure line.
    // Other outcomes are success
    // (true, or a value the caller consumes — e.g. the browser tool's read).
    const ok = typeof outcome !== "string"
    // Success may name one fact the person needs beside the done title (a partial read's count).
    const named: unknown = ok && typeof outcome === "object" && outcome !== null ? (outcome as { toastDetail?: unknown }).toastDetail : undefined
    const detail = typeof named === "string" ? named : ""
    // Settled work states its result, never the running sentence: an ok
    // toast reads as done for the seconds before it dismisses itself, and
    // a failure keeps the attempt's title with the honest line under it.
    resolveToast(key, outcome === TOAST_CANCELLED ? { status: "cancelled", title, detail: "Cancelled" }
      : ok ? { status: "ok", title: doneTitle, detail } : { status: "failed", detail: outcome as string })
    // The run is over either way, so its counter entry is terminal and
    // leaves now. The ok toast's self-dismissal is guarded by the toast's
    // own state in resolveToast, so no stale timer can claim the slot a
    // newer run is using. The toast itself stays keyed `toast-${key}`, so a
    // later run of the same flow still resolves it.
    ctx.toastRuns.delete(key)
    return outcome
  }

  const dismissToast = (id: string): void => {
    if (ctx.disposed) return
    ctx.store.dispatch({ type: "toast.dismissed", actor: "user", id })
  }

  /*
   * A failed flow has no channel of its own to answer into — dropping the
   * outcome reads as a silent no-op (the "did it even run?" bug). Every
   * invocation the human makes — a pointer press OR a name typed into the
   * composer — states its refusal as a toast; executes that render their own
   * error UI return void and never reach this. The zero-balance refusal is
   * the one exception: `zeroBalanceGuard` already dispatched it as an
   * embedded transcript message, so toasting it too would double-surface the
   * same refusal.
   */
  const surfaceCommandFailure = (name: string, outcome: CommandOutcome, saidBefore?: number): void => {
    if (ctx.disposed) return
    if (outcome.status === "form") {
      /*
       * THE FORM LAW: the slash line lacked its input, so the form card is in
       * the transcript; the composer's line points at it and says nothing
       * about arguments. An ok toast: it resolves and leaves on its own.
       */
      const key = `command.form.${name}`
      ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title: "Fill in the form above" })
      resolveToast(key, { status: "ok", detail: "" })
      return
    }
    if (outcome.status !== "failed") return
    if (outcome.error === ZERO_BALANCE_EXHAUSTED_TEXT) return
    /*
     * A refusal the app decided about what the person typed is a
     * misunderstanding between them and a door, not a notification: it belongs
     * where the answer to that line would have been, and it has to still be
     * there when they look. `/chat.clear --summarize` refused into a toast
     * that auto-dismissed, so the walk found the submission had added nothing
     * at all (W1-d-doors.json `L99-summarizeSubmission.grew: 0`). The match is
     * exhaustive: a refusal kind added without a surface is a compile error.
     */
    if (outcome.refusal !== undefined) {
      switch (outcome.refusal.kind) {
        case "unknown-flag":
          ctx.store.dispatch({ type: "message.appended", actor: "system", text: outcome.error })
          return
      }
    }
    /*
     * A lost write is never silent. `writeRefused` means this browser would
     * not take the person's act, so the control they used snaps back to the
     * value it already had — exactly as a refusal makes it snap back, and
     * indistinguishable from one. A toast that leaves after four seconds
     * cannot be the only word for that: the sentence goes to the transcript
     * too, where they are still looking a minute later when the draft they
     * edited submits the value they replaced (walk run 3, B3-N5).
     *
     * The flag is what a door sets when it classified the failure itself. The
     * second test covers every door that did not: a handler's throw is
     * classified at the flow boundary and arrives here as one of this app's
     * own lost-act sentences, with no flag to carry it. Recognizing our own
     * sentence keeps that rule from depending on each door remembering it.
     *
     * Said once, and said once FOR THIS ACT. The doors on the repository setup
     * card put their own sentence in the transcript as they refuse, and this
     * act's line is theirs when it is theirs: a line marked `Message.spoken`,
     * appended since this act was admitted (controller/spokenLines.ts, the
     * same window the form card yields on), AND not already spent on another
     * act. The window alone was not enough: the sentences are a closed table,
     * so two acts overlapping in time carry the same sentence with both
     * windows open, and the one that surfaced last matched the other's line
     * and said nothing — two lost acts, two toasts, one line. Claiming makes
     * a door's line stand in for at most one act, so the count is exact in
     * both directions. A caller that carries no window claims nothing and
     * repeats a line rather than swallowing one.
     */
    if (outcome.writeRefused === true || spokenLostAct(outcome.error)) {
      const since = saidBefore ?? latestOrdinal(ctx.store.collections)
      if (!claimSpokenLine(ctx.store.collections, outcome.error, since, claimedLines)) {
        ctx.store.dispatch({ type: "message.appended", actor: "system", text: outcome.error })
      }
      forgetVanishedClaims(ctx.store.collections, claimedLines)
    }
    const key = `command.failed.${name}`
    // A seam can refuse before the requirement axis knows the session is gone.
    // Turn its explicit sign-in command into the same human gesture as the prompt.
    const signIn = outcome.error.match(/\/(auth\.sign-in|cloud\.sign-in)\b/)?.[1]
    const flow = signIn === "auth.sign-in" || signIn === "cloud.sign-in" ? signIn : undefined
    const entry = flow === undefined ? undefined : ctx.commands.find(flow)
    const action: Toast["action"] = flow && entry ? { flow, label: entry.metadata.summary } : undefined
    const summary = ctx.commands.find(name)?.metadata.summary ?? "This action"
    ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title: `${summary} didn't run` })
    resolveToast(key, { status: "failed", detail: humanCommandText(ctx.commands, outcome.error), action,
      autoDismissMs: ctx.toastAutoDismissMs })
  }

  return { withToast, resolveToast, dismissToast, surfaceCommandFailure }
}
