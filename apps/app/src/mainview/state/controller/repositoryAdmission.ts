import type { ControllerContext } from "./context"
import type { RepositoryEntry } from "../AppState"
import { TOAST_SUPERSEDED, type FailureController } from "./failures"

/** A catalog wait is admission, not authorization. The registry rechecks the bound payload after it settles. */
export const createRepositoryReadiness = (
  ctx: ControllerContext,
  surfaceCommandFailure: FailureController["surfaceCommandFailure"],
  refresh: (repo: string, requestId: string, isCurrent: () => boolean, scope?: "command") => Promise<string | void>
) => {
  const pending = () => ctx.store.session().pendingCommand
  const accountOwner = ctx.accountOwner
  const target = (request: ReturnType<typeof pending>): { entry: RepositoryEntry; scope?: "command" } | undefined => {
    if (request?.requirement !== "repository-ready") return
    try {
      const payload = JSON.parse(request.args ?? "")
      if (typeof payload?.repo !== "string") return
      const repo: string = payload.repo.toLowerCase()
      const session = ctx.store.session()
      const routeEntry = session.repositoryEntry
      const commandEntry = session.repositoryCommandEntry
      if (routeEntry != null && routeEntry.repo.toLowerCase() === repo) return { entry: routeEntry }
      if (commandEntry !== undefined && commandEntry.repo.toLowerCase() === repo && commandEntry.owner === accountOwner()) {
        return { entry: commandEntry, scope: "command" }
      }
    } catch { /* The waiting task reports malformed saved requests. */ }
  }
  const keyOf = (value: ReturnType<typeof pending>) => value?.requirement === "repository-ready"
    ? JSON.stringify([value, target(value)?.scope, target(value)?.entry.requestId]) : undefined
  let active: string | undefined
  // Hydrated requests wait for this boot's identity answer; a fresh user admission may start immediately.
  let activated = false
  const persisting = new Map<string, Promise<unknown>>()
  const resolving = new Map<string, object>()
  const wakeups = new Set<() => void>()
  const launchCommandTarget = (request: ReturnType<typeof pending>) => {
    const bound = target(request)
    if (bound?.scope !== "command" || bound.entry.phase !== "pending" || resolving.has(bound.entry.requestId) ||
      persisting.has(JSON.stringify([request?.name, request?.args])) ||
      !request || !ctx.commands.find(request.name)?.metadata.requires?.includes("repo-source")) return
    const { requestId, repo } = bound.entry
    const owner = accountOwner()
    const epoch = ctx.accountEpoch
    const token = {}
    resolving.set(requestId, token)
    const owned = () => !ctx.disposed && accountOwner() === owner && ctx.store.session().repositoryCommandEntry?.requestId === requestId
    const current = () => owned() && ctx.accountEpoch === epoch
    const fail = (error: string) => {
      const entry = ctx.store.session().repositoryCommandEntry
      if (owned() && entry?.phase === "pending") ctx.store.dispatch({ type: "repository.command.changed", actor: "system",
        entry: { ...entry, phase: "failed", failureKind: "unavailable", error } })
    }
    void refresh(repo, requestId, current, "command")
      .catch(() => { fail("The public repository catalog could not be read.") })
      .finally(() => {
        if (!current()) fail("The repository request changed. Run the command again.")
        if (resolving.get(requestId) === token) resolving.delete(requestId)
      })
  }
  const resume = (launch = false): void => {
    if (ctx.disposed || !activated) return
    const request = pending()
    // Only hydrated boot or a completed durable admission may start network work.
    if (launch) launchCommandTarget(request)
    const key = keyOf(request)
    if (!request || key === undefined || key === active) return
    active = key
    const epoch = ctx.accountEpoch
    const owner = accountOwner()
    const owns = () => !ctx.disposed && ctx.accountEpoch === epoch && accountOwner() === owner && keyOf(pending()) === key
    void ctx.withToast("repository.ready", "Loading repository…", "Ready", async () => {
      // Projection subscriptions see optimistic rows during dispatch, before its promise is registered.
      await Promise.resolve()
      await persisting.get(JSON.stringify([request.name, request.args]))
      if (!owns()) return TOAST_SUPERSEDED
      if (!ctx.commands.find(request.name)?.metadata.requires?.includes("repo-source")) return "The saved repository command is unavailable."
      let payload: Record<string, unknown>
      try { payload = JSON.parse(request.args ?? "") } catch { return "The saved repository request could not be read. Run the command again." }
      if (typeof payload?.repo !== "string") return "The saved repository request has no target. Run the command again."
      const repo = payload.repo.toLowerCase()
      const waiting = await new Promise<string | undefined | typeof TOAST_SUPERSEDED>(resolve => {
        const check = () => {
          if (!owns()) { wakeups.delete(check); resolve(TOAST_SUPERSEDED); return }
          const entry = target(request)?.entry
          if (!entry || entry.repo.toLowerCase() !== repo) { wakeups.delete(check); resolve("Repository changed. Run the command again."); return }
          if (entry.phase === "pending") return
          wakeups.delete(check)
          resolve(entry.phase === "failed" && entry.failureKind !== "not-public" ? entry.error ?? "The repository could not be opened. Try again." : undefined)
        }
        wakeups.add(check)
        check()
      })
      if (!owns() || waiting === TOAST_SUPERSEDED) return TOAST_SUPERSEDED
      const bound = target(request)
      const entryId = bound?.entry.requestId
      const selection = ctx.store.session().activeRepoKey
      await ctx.store.dispatch({ type: "command.deferral.cleared", actor: "system" }).isPersisted.promise
      if (ctx.disposed || ctx.accountEpoch !== epoch || accountOwner() !== owner || active !== key || pending() != null ||
        target(request)?.entry.requestId !== entryId || (bound?.scope !== "command" && ctx.store.session().activeRepoKey !== selection)) return TOAST_SUPERSEDED
      if (waiting !== undefined) return waiting
      const display = ctx.commands.find(request.name)?.metadata.form?.args?.(payload)
      const outcome = await ctx.commands.submit({ name: request.name, payload, actor: "user", display })
      if (outcome.status === "form" || pending() != null) return TOAST_SUPERSEDED
      return outcome.status === "failed" ? outcome.error : outcome.status === "executed" ? true : "The requested command is unavailable."
    }).then(outcome => {
      if (typeof outcome === "string" && !ctx.disposed && active === key && !ctx.store.collections.toasts.has("toast-repository.ready")) surfaceCommandFailure(request.name, { status: "failed", error: outcome })
    }).finally(() => { if (active === key) active = undefined })
  }
  const subscription = ctx.store.collections.sessions.subscribeChanges(() => {
    for (const wake of [...wakeups]) wake()
    resume()
  })
  ctx.onDispose(() => { subscription.unsubscribe(); for (const wake of [...wakeups]) wake(); wakeups.clear() })
  return {
    resume: () => { activated = true; resume(true) },
    defer: async (name: string, payload: Record<string, unknown>, options: { refresh?: boolean; scope?: "command" } = {}): Promise<void> => {
      activated = true
      const args = JSON.stringify(payload)
      const signature = JSON.stringify([name, args])
      const old = pending()
      const entry = ctx.store.session().repositoryEntry
      const repositoryRetry = options.scope !== "command" && options.refresh && entry?.phase === "failed" && entry.failureKind !== "not-public" &&
        typeof payload.repo === "string" && entry.repo.toLowerCase() === payload.repo.toLowerCase()
        ? { repo: entry.repo, requestId: crypto.randomUUID() } : undefined
      const epoch = ctx.accountEpoch
      const owner = accountOwner()
      const selection = ctx.store.session().activeRepoKey
      const commandEntry = ctx.store.session().repositoryCommandEntry
      const repositoryRequest = options.scope === "command" && owner !== undefined && typeof payload.repo === "string" &&
        (commandEntry?.repo.toLowerCase() !== payload.repo.toLowerCase() || commandEntry.owner !== owner || commandEntry.phase !== "pending")
        ? { requestId: crypto.randomUUID(), repo: payload.repo, owner } : undefined
      if (repositoryRequest !== undefined || repositoryRetry !== undefined || old?.requirement !== "repository-ready" || old.name !== name || old.args !== args) {
        const saving = ctx.store.dispatch({ type: "command.deferred", actor: "user", name, args, requirement: "repository-ready",
          ...(repositoryRetry === undefined ? {} : { repositoryRetry }), ...(repositoryRequest === undefined ? {} : { repositoryRequest }) }).isPersisted.promise
        persisting.set(signature, saving)
        try { await saving } finally { if (persisting.get(signature) === saving) persisting.delete(signature) }
      } else {
        await persisting.get(signature)
      }
      if (ctx.disposed || ctx.accountEpoch !== epoch || accountOwner() !== owner) return
      resume(true)
      if (repositoryRetry !== undefined) {
        const stillOwned = () => !ctx.disposed && accountOwner() === owner && ctx.store.session().repositoryEntry?.requestId === repositoryRetry.requestId
        const current = () => stillOwned() && ctx.accountEpoch === epoch && ctx.store.session().activeRepoKey === selection
        const fail = (error: string) => {
          if (stillOwned() && ctx.store.session().repositoryEntry?.phase === "pending") ctx.store.dispatch({
            type: "repository.entry.changed", actor: "system", entry: { ...repositoryRetry, phase: "failed", failureKind: "unavailable", error }
          })
        }
        if (!current()) { fail("The repository request changed. Run the command again."); return }
        void refresh(repositoryRetry.repo, repositoryRetry.requestId, current)
          .catch(() => { fail("The public repository catalog could not be read.") })
          .finally(() => { if (!current()) fail("The repository request changed. Run the command again.") })
      }
    }
  }
}
