import { conversationTabIdOf, inConversation, type Card } from "./AppState"
import type { SeamContext } from "./seams/SeamContext"

/*
 * One web pane per repository. The repository update is the pane's home;
 * issue and PR lists and details are locations in the same frame, so
 * browsing pushes frame history (the card header's Back/Forward) instead
 * of appending transcript rows.
 */
type RepoPaneLocation = Extract<Card, { kind: "issue-list" | "issue" | "pr-list" | "pr" }>

/*
 * The pane rooted at the repository's overview: the update card itself, or a
 * frame that navigated away from it (the overview then lives in its history).
 */
export const repoPaneCard = (ctx: SeamContext, repo: string) => {
  const conversation = conversationTabIdOf(ctx.store.session())
  return [...ctx.store.collections.cards.values()]
    .filter(row => !(row.kind === "issue" && row.payload.conversation) && (row.kind === "repo-update" || row.kind === "issue-list" || row.kind === "issue" || row.kind === "pr-list" || row.kind === "pr") &&
      row.payload.repo === repo && inConversation(row, conversation))
    .sort((a, b) => b.ordinal - a.ordinal)
    .find(row => row.kind === "repo-update" ||
      (ctx.store.collections.cardHistories.get(row.id)?.entries ?? []).some(entry => entry.kind === "repo-update" && entry.payload.repo === repo))
}

/** Where a repo view lands: the overview-rooted pane when it exists, else the repo's most recent repo view. */
export const paneTarget = (ctx: SeamContext, repo: string) => {
  const pane = repoPaneCard(ctx, repo)
  if (pane) return pane
  const conversation = conversationTabIdOf(ctx.store.session())
  return [...ctx.store.collections.cards.values()]
    .filter(row => !(row.kind === "issue" && row.payload.conversation) && (row.viewRepo === repo || ((row.kind === "issue-list" || row.kind === "issue" || row.kind === "pr-list" || row.kind === "pr") &&
      row.payload.repo === repo)) && inConversation(row, conversation))
    .sort((a, b) => b.ordinal - a.ordinal)[0]
}

/** A repo view is a location in the repository's web pane, not a new transcript row. */
export async function publishRepoView(ctx: SeamContext, card: RepoPaneLocation): Promise<void> {
  const target = paneTarget(ctx, card.payload.repo)
  if (!target) {
    await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card }).isPersisted.promise
    return
  }
  const next = { ...card, id: target.id, ordinal: target.ordinal, createdAt: target.createdAt, tabId: target.tabId }
  /* Refreshing the location already on screen keeps its place in history; anything else navigates. */
  const sameLocation =
    (target.kind === "issue" && card.kind === "issue" && target.payload.number === card.payload.number &&
      (target.payload.source ?? "smithers-cloud") === (card.payload.source ?? "smithers-cloud")) ||
    (target.kind === "issue-list" && card.kind === "issue-list") ||
    (target.kind === "pr" && card.kind === "pr" && target.payload.number === card.payload.number) ||
    (target.kind === "pr-list" && card.kind === "pr-list")
  if (sameLocation) await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: { ...next, navigation: target.navigation } }).isPersisted.promise
  else await ctx.dispatch({ type: "card.navigated", actor: ctx.actor(), card: next }).isPersisted.promise
}

/** Issue detail is a location in the repository's web pane, not a new transcript row. */
export const publishIssueView = (ctx: SeamContext, card: Extract<Card, { kind: "issue" }>): Promise<void> => publishRepoView(ctx, card)
