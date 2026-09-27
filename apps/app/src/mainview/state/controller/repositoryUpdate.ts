import { repositoryScope } from "../RepositoryContext"
import { captureCloudOwner, readResult } from "../seams/SeamContext"
import type { SeamContext } from "../seams/SeamContext"
import { readRepositoryUpdate } from "../seams/RepositoryUpdateSource"
import { processRepositoryEvents } from "../RepositoryNotifications"
import { conversationTabIdOf, type Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"

type UpdateCard = Extract<Card, { kind: "repo-update" }>
export function repositoryUpdateScope(ctx: SeamContext, repo: string): string {
  return repositoryScope(ctx.store, repo)
}
export function createRepositoryUpdate(ctx: SeamContext, disposed: () => boolean = () => false) {
  const pending = new Map<string, { current: () => boolean; work: Promise<string | { value: string }> }>()
  const readUpdate = async (explicit?: string, show = false): Promise<string | { value: string }> => {
    if (disposed() || ctx.isDisposed?.()) return "The controller is closed."
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const scope = repositoryUpdateScope(ctx, repo)
    const session = ctx.store.session()
    const conversation = conversationTabIdOf(session)
    const context = JSON.stringify([scope, conversation, session.activeRepoKey, session.activeWorkspaceId, session.activeBranchId])
    const ownerCurrent = captureCloudOwner(ctx, false)
    const retired = (): string | undefined => {
      if (disposed() || ctx.isDisposed?.()) return "The controller is closed."
      const current = ctx.store.session()
      if (!ownerCurrent() || JSON.stringify([repositoryUpdateScope(ctx, repo), conversationTabIdOf(current), current.activeRepoKey, current.activeWorkspaceId, current.activeBranchId]) !== context) {
        return "The repository or account changed while its update was loading."
      }
    }
    const key = JSON.stringify([scope, repo, conversation])
    const pendingKey = JSON.stringify([key, show])
    const prior = pending.get(pendingKey)
    if (prior?.current()) return prior.work
    const work = (async () => {
      const snapshot = await readRepositoryUpdate(ctx, repo)
      const readRefusal = retired()
      if (readRefusal) return readRefusal
      const at = Date.now()
      const processed = processRepositoryEvents(scope, repo, [...snapshot.issues.events, ...snapshot.prs.events, ...snapshot.notifications.events], [...ctx.store.collections.repositoryNotifications.values()], at)
      const fresh = processed.fresh
      const newIssues = fresh.filter(row => row.kind === "issue")
      const prs = fresh.filter(row => row.kind === "pr")
      const notices = fresh.filter(row => row.kind === "notification")
      const problems = [...new Set([...snapshot.issues.problems, ...snapshot.prs.problems, ...snapshot.notifications.problems])]
      const summary = fresh.length === 0
        ? problems.length ? "Some repository activity could not be checked." : "You're up to date. No new issue or PR updates since my last check."
        : `${newIssues.length} issue ${newIssues.length === 1 ? "update" : "updates"}, ${prs.length} PR ${prs.length === 1 ? "update" : "updates"}${notices.length ? `, and ${notices.length} ${notices.length === 1 ? "notification" : "notifications"}` : ""} since my last check.`
      const events = [...snapshot.issues.events, ...snapshot.prs.events, ...snapshot.notifications.events]
      const data = {
        repo, checkedAt: at, ...(snapshot.branch ? { branch: snapshot.branch.slice(0, 250) } : {}),
        openIssues: snapshot.issues.available ? snapshot.issues.events.filter(row => row.state === "open").length : null,
        openPrs: snapshot.prs.available ? snapshot.prs.events.filter(row => row.state === "open").length : null,
        problems: problems.slice(0, 10).map(value => value.slice(0, 250)),
        items: [...events].sort((a, b) => Number(b.state === "open") - Number(a.state === "open")).slice(0, 20).map(row => ({
          source: row.source.slice(0, 80), kind: row.kind, ...(row.number ? { number: row.number } : {}),
          title: row.title.slice(0, 250), state: row.state.slice(0, 80), tags: row.tags.slice(0, 5).map(tag => tag.slice(0, 80))
        })),
        truncated: events.length > 20
      }
      await ctx.dispatch({ type: "repo.update.observed", actor: ctx.actor(),
        context: { id: key, scope, conversation, data }, notifications: processed.rows
      }).isPersisted.promise
      const observedRefusal = retired()
      if (observedRefusal) return observedRefusal
      if (!show) return readResult(JSON.stringify(data))
      const id = `repo-update-${encodeURIComponent(key)}`
      const existing = ctx.store.collections.cards.get(id)
      const visible = new Map(fresh.map(row => [row.id, row]))
      // Refreshing does not erase notices the user has yet to read.
      for (const row of processed.rows) if (row.announcedVersion === row.version && row.readVersion !== row.version) visible.set(row.id, row)
      const items = [...visible.values()].map(row => ({ id: row.id, version: row.version, source: row.source, kind: row.kind, number: row.number, title: row.title, state: row.state, tags: row.tags, read: row.readVersion === row.version }))
      const card: UpdateCard = { id, kind: "repo-update", title: "Activity",
        status: "active", createdAt: existing?.createdAt ?? at, ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
        payload: { repo, scope, checkedAt: at, summary, items, problems, branch: snapshot.branch,
          openIssues: snapshot.issues.available ? snapshot.issues.events.filter(row => row.state === "open").length : null,
          openPrs: snapshot.prs.available ? snapshot.prs.events.filter(row => row.state === "open").length : null } }
      const announced = new Set(fresh.map(row => row.id))
      /*
       * The update is the repository pane's home (state/EmbeddedHistory.ts).
       * Refreshing while the pane shows another location snaps it home; the
       * frame's Back still walks the snapshots the user already saw.
       */
      await ctx.dispatch({ type: "repo.update.published", actor: ctx.actor(), card,
        notifications: processed.rows.map(row => announced.has(row.id) ? { ...row, announcedVersion: row.version } : row)
      }).isPersisted.promise
      const publishedRefusal = retired()
      if (publishedRefusal) return publishedRefusal
      return readResult(`${summary}\n${items.map(row => `${row.kind}${row.number ? ` #${row.number}` : ""}: ${row.title}`).join("\n")}${problems.length ? `\nPartial update: ${problems.join(" ")}` : ""}`)
    })()
    const entry = { current: () => retired() === undefined, work }
    pending.set(pendingKey, entry)
    try { return await work } finally { if (pending.get(pendingKey) === entry) pending.delete(pendingKey) }
  }
  const markUpdateRead = async (cardId: string): Promise<string | void> => {
    const card = ctx.store.collections.cards.get(cardId)
    if (card?.kind !== "repo-update") return "That repository update is no longer available."
    if (card.payload.scope !== repositoryUpdateScope(ctx, card.payload.repo)) return "This update belongs to another account."
    await ctx.dispatch({ type: "notifications.read", actor: ctx.actor(), receipts: card.payload.items.map(row => ({ id: row.id, version: row.version })) }).isPersisted.promise
  }
  const tagNotification = async (id: string, tag: string): Promise<string | void> => {
    const row = ctx.store.collections.repositoryNotifications.get(id)
    if (!row || row.scope !== repositoryUpdateScope(ctx, row.repo)) return "That notification is not available in this account."
    if (!tag.trim() || tag.trim().length > 48) return "Use a tag between 1 and 48 characters."
    await ctx.dispatch({ type: "notification.tagged", actor: ctx.actor(), id, tag: tag.trim() }).isPersisted.promise
  }
  return { updateRepo: (repo?: string) => readUpdate(repo), showRepoOverview: (repo?: string) => readUpdate(repo, true), markUpdateRead, tagNotification }
}
