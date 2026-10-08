import { MythicalStackSchema, mythicalRoute, type MythicalWiki } from "@smthrs/rpc/Mythical"
import { actorSharedState } from "../ActorBindings"
import type { FailureController } from "../controller/failures"
import { TOAST_SUPERSEDED } from "../controller/failures"
import { resolveTargetRepo } from "../RepoContext"
import { createCloudClient } from "./CloudClient"
import type { RepositoryHistorySeam } from "./RepositoryHistorySeam"
import type { SeamContext } from "./SeamContext"

/** Manual refresh asks the packaged wiki worker; failed runs on Home use
 * background.retry/background.dismiss and the same workflow_runs records.
 * Old persisted wiki requests remain readable and reconnect without a new POST.
 */
export function createWikiRefreshSeam(ctx: SeamContext, withToast: FailureController["withToast"], history: RepositoryHistorySeam, onDispose: (stop: () => void) => void, retryFailed?: (repo: string) => Promise<{ readonly value: string } | string> | undefined) {
  const { send } = createCloudClient(ctx)
  const login = () => { const identity = ctx.store.collections.identitySessions.get("identity"); return identity?.state === "signed-in" ? identity.login : null }
  const shared = actorSharedState(ctx, "wiki-refresh", () => ({ active: new Map<string, Promise<unknown>>() }))
  const requests = () => ctx.store.session().wikiRequests ?? []
  const save = (rows: ReturnType<typeof requests>) => ctx.dispatch({ type: "stack.wiki.requests.changed", actor: "system", requests: rows }).isPersisted.promise
  const keyOf = (repo: string, owner: string) => JSON.stringify([repo, owner])
  const outcome = (wiki: MythicalWiki | undefined, baseline?: MythicalWiki): true | string | undefined => {
    if (wiki === undefined) return "This repository declares no Wiki."
    if (wiki.state === "current") return true
    if (wiki.state !== "failed") return undefined
    if (baseline?.state === "failed" && baseline.attempt === wiki.attempt && baseline.commit === wiki.commit) return undefined
    return wiki.error ?? "The Wiki refresh failed."
  }
  const start = (repo: string, owner: string, post: boolean) => {
    const identity = keyOf(repo, owner)
    if (shared.active.has(identity)) return
    const current = () => ctx.isDisposed?.() !== true && login() === owner
    const key = `stack.wiki.${repo}` // Retain the persisted toast identity across the cutover.
    const action = { flow: "wiki.create" as const, args: repo, label: "Retry" }
    const work = withToast(key, "Refreshing the Wiki…", "Wiki current", async () => {
      let baseline: MythicalWiki | undefined
      if (post) {
        const [repoOwner = "", name = ""] = repo.split("/")
        const answer = await send("POST", mythicalRoute("wiki", repoOwner, name).replace(/^\/api/, ""), {}, "the Wiki")
        if (!current()) return TOAST_SUPERSEDED
        if ("error" in answer) return answer.error
        const parsed = MythicalStackSchema.safeParse(answer.body)
        if (parsed.success) { baseline = parsed.data.wiki; history.observe(repo, parsed.data) }
      }
      history.watchRepository(repo)
      return history.settled(repo, stack => outcome(stack.wiki, baseline))
    }, false, current).then(async result => {
      if (!current()) return
      if (typeof result === "string") {
        if (ctx.store.collections.toasts.get(`toast-${key}`) === undefined) ctx.dispatch({ type: "toast.shown", actor: "system", key, title: "Refreshing the Wiki…" })
        ctx.resolveToast?.(key, { status: "failed", detail: result, action })
      }
      await save(requests().filter(row => row.repo !== repo || row.owner !== owner))
    }).catch(error => ctx.report?.("Wiki refresh", error)).finally(() => { if (shared.active.get(identity) === work) shared.active.delete(identity) })
    shared.active.set(identity, work)
  }
  const launching = actorSharedState(ctx, "wiki-refresh-admission", () => new Map<string, Promise<{ readonly value: "Requested" }>>())
  const refreshWiki = async (repoArg?: string): Promise<{ readonly value: string } | string> => {
    const owner = login()
    if (owner === null) return "Sign in to see the history."
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const { repo } = target, key = keyOf(repo, owner)
    const retry = retryFailed?.(repo)
    if (retry) return retry
    if (launching.has(key)) return launching.get(key)!
    if (shared.active.has(key)) return { value: "Requested" }
    const work = (async () => {
      await save([...requests().filter(row => row.repo !== repo || row.owner !== owner), { repo, owner, requestedAt: Date.now() }])
      if (login() === owner && ctx.isDisposed?.() !== true) start(repo, owner, true)
      return { value: "Requested" } as const
    })().finally(() => launching.delete(key))
    launching.set(key, work)
    return work
  }
  const resume = () => { const owner = login(); if (owner !== null) for (const row of requests()) if (row.owner === owner) start(row.repo, owner, false) }
  const identity = ctx.store.collections.identitySessions.subscribeChanges(() => queueMicrotask(resume))
  onDispose(() => identity.unsubscribe())
  return { refreshWiki, resume }
}
export type WikiRefreshSeam = ReturnType<typeof createWikiRefreshSeam>
