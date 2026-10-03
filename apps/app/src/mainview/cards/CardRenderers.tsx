import { SetupCard, type SetupCardProps } from "./SetupCard"
import { SetupView } from "./views/SetupView"
import { runTraceCardFamily } from "./RunTraceCard"
import type { ConfirmViewProps } from "@smthrs/rpc/ConfirmCard"
import { ConfirmView } from "./views/ConfirmView"
import { repositoryUpdateCardFamily } from "./RepositoryUpdateCard"
import { repositoryHomeCardFamily } from "./RepositoryHomeCard"
import { useLiveQuery } from "@tanstack/react-db"
import { projectRepositoryUpdate } from "../state/CardProjection"
/*
 * The card renderer map: every card kind, from the family that owns it.
 *
 * Each family file under ./ exports its slice (CardFamily.ts). This file
 * spreads the slices into one record keyed by kind; the mapped type makes a
 * kind without an entry a compile error, and CardRenderers.test.ts proves the
 * slices are disjoint and cover exactly the wire's card kinds. A new card kind
 * is one import plus one spread line here.
 */
import type { Card } from "../state/AppState"
import { accountCardFamily } from "./AccountCard"
import { agentCardFamily } from "./AgentCards"
import { anonymousCeilingCardFamily } from "./AnonymousCeilingCard"
import { approvalCardFamily } from "./ApprovalCard"
import { branchesCardFamily } from "./BranchesCard"
import type { CardActions, CardFamily, CardFamilyEntry, CardProjectionAuthority } from "./CardFamily"
import { changeCardFamily } from "./ChangeCards"
import { commitCardFamily } from "./CommitCards"
import { conversationCardFamily } from "./ConversationCards"
import { envCardFamily } from "./EnvCard"
import { fileCardFamily } from "./FileCards"
import { flowFormCardFamily } from "./FlowFormCards"
import { flowPlanCardFamily } from "./FlowPlanCard"
import { stackCardFamily } from "./StackCard"
import { issueCardFamily } from "./IssueCards"
import { landingCardFamily } from "./LandingCards"
import { RepositoryChoiceCard } from "./RepositoryChoiceCard"
import { repoImportCardFamily } from "./RepoImportCard"
import { runsCardFamily } from "./RunsCards"
import { searchResultsCardFamily } from "./SearchResultsCard"
import { secretsCardFamily } from "./SecretsCard"
import { syncCardFamily } from "./SyncCards"
import { triggersCardFamily } from "./TriggersCard"
import { turnCardFamily } from "./TurnCards"
import { wikiCardFamily } from "./WikiCards"
import { workflowCardFamily } from "./FlowCard"
import { workspaceCardFamily } from "./WorkspaceCard"

/* The tutorial's two embedded surfaces: the ranked repository chooser and the Library shelf. */
const repositoryChoiceCardFamily: CardFamily<"repository-choice"> = {
  "repository-choice": {
    render: (card, actions) => <RepositoryChoiceCard payload={card.payload} onRunCommand={actions.onRunCommand}
      signedIn={signedInFor(actions)} />,
    pill: card => card.payload.created === null ? "" : "done"
  }
}

/** Wire kinds retained for old journals, with no live producer or UI. */
export { RETIRED_CARD_KINDS } from "../state/CardAvailability"
import { RETIRED_CARD_KINDS } from "../state/CardAvailability"
type RetiredCardKind = (typeof RETIRED_CARD_KINDS)[number]
/** T-APP-02 supplies Containers; design supplies these Views before registration. */
export const PENDING_CARD_KINDS = ["todo", "draft"] as const
const isPendingCard = (card: Card): card is Extract<Card, { kind: typeof PENDING_CARD_KINDS[number] }> =>
  (PENDING_CARD_KINDS as readonly string[]).includes(card.kind)
type RenderedCardKind = Exclude<Card["kind"], RetiredCardKind | typeof PENDING_CARD_KINDS[number]>
export const isRetiredCard = (card: Card): card is Extract<Card, { kind: RetiredCardKind }> =>
  (RETIRED_CARD_KINDS as readonly string[]).includes(card.kind)

/** The families in registration order; the test reads this list to prove the slices are disjoint. */
export const CARD_FAMILIES: ReadonlyArray<CardFamily<never>> = [
  repositoryHomeCardFamily,
  turnCardFamily,
  approvalCardFamily,
  conversationCardFamily,
  workflowCardFamily,
  runTraceCardFamily,
  flowPlanCardFamily,
  triggersCardFamily,
  runsCardFamily,
  issueCardFamily,
  landingCardFamily,
  changeCardFamily,
  repositoryUpdateCardFamily,
  envCardFamily,
  secretsCardFamily,
  accountCardFamily,
  stackCardFamily,
  repoImportCardFamily,
  syncCardFamily,
  branchesCardFamily,
  fileCardFamily,
  agentCardFamily,
  flowFormCardFamily,
  workspaceCardFamily,
  anonymousCeilingCardFamily,
  searchResultsCardFamily,
  repositoryChoiceCardFamily,
  wikiCardFamily,
  commitCardFamily
]

/** One entry per card kind. Written as a literal so a missing kind fails to compile. */
export const CARD_RENDERERS: CardFamily<RenderedCardKind> = {
  ...repositoryHomeCardFamily,
  ...turnCardFamily,
  ...approvalCardFamily,
  ...conversationCardFamily,
  ...workflowCardFamily,
  ...runTraceCardFamily,
  ...flowPlanCardFamily,
  ...triggersCardFamily,
  ...runsCardFamily,
  ...issueCardFamily,
  ...landingCardFamily,
  ...changeCardFamily,
  ...commitCardFamily,
  ...repositoryUpdateCardFamily,
  ...envCardFamily,
  ...secretsCardFamily,
  ...accountCardFamily,
  ...stackCardFamily,
  ...repoImportCardFamily,
  ...syncCardFamily,
  ...branchesCardFamily,
  ...fileCardFamily,
  ...agentCardFamily,
  ...flowFormCardFamily,
  ...workspaceCardFamily,
  ...anonymousCeilingCardFamily,
  ...searchResultsCardFamily,
  ...repositoryChoiceCardFamily,
  ...wikiCardFamily
}

/** The entry for one kind, typed to that kind's card. */
export const cardRenderer = <K extends RenderedCardKind>(kind: K): CardFamilyEntry<K> => CARD_RENDERERS[kind]

/**
 * The header's status word. Forms keep refusals in their body; other error cards wear "failed";
 * otherwise the family that owns the kind answers.
 */
export const pillStatus = (card: Card): string => {
  if (isRetiredCard(card) || isPendingCard(card)) return ""
  if (card.status === "error" && card.kind !== "flow-form") return "failed"
  return cardRenderer(card.kind).pill(card)
}

/* The repository list reads GitHub only for a signed-in identity (tutorialRepository.ts); without a store, assume it did. */
const signedInFor = (actions: CardActions): boolean => {
  const identities = actions.projectionStore?.collections.identitySessions
  return identities === undefined || identities.get("identity")?.state === "signed-in"
}

/** The card's body, from the family that owns its kind. */
export const renderCardBody = (card: Card, actions: CardActions) =>
  isRetiredCard(card) || isPendingCard(card) ? null : card.kind === "repo-update" && actions.projectionStore !== undefined
    ? <ProjectedRepositoryUpdateBody card={card} actions={actions} store={actions.projectionStore} />
    : cardRenderer(card.kind).render(card, actions)

const ProjectedRepositoryUpdateBody = ({ card, actions, store }: {
  readonly card: Extract<Card, { kind: "repo-update" }>
  readonly actions: CardActions
  readonly store: CardProjectionAuthority
}) => {
  const { data: saved } = useLiveQuery(store.collections.savedRepositoryUpdates)
  const { data: notifications } = useLiveQuery(store.collections.repositoryNotifications)
  const { data: receipts } = useLiveQuery(store.collections.notificationReceipts)
  const committed = saved.find(update => update.id === card.id)
  // A completed activity body must survive reload. While a refresh saves,
  // continue showing the last committed update, including its source refusals.
  return committed === undefined ? null : cardRenderer("repo-update").render(projectRepositoryUpdate(committed, notifications, receipts), {
    ...actions, repositoryUpdatePending: JSON.stringify(card.payload) !== JSON.stringify(committed.payload)
  })
}

/** T-APP-09 private actor projection enables this mount; legacy approval rows remain dark. */
export const renderConfirmCard = (props: ConfirmViewProps) => <ConfirmView {...props} />

/** Browser-private setup projection; shared persistence activates in the later phase. */
export const renderSetupCard = (props: Omit<SetupCardProps, "View">) => <SetupCard {...props} View={SetupView} />
