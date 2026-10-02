import { registrationCardFamily } from "./RegistrationCard"
import { repositoryUpdateCardFamily } from "./RepositoryUpdateCard"
import { repositorySetupCardFamily } from "./RepositorySetupCard"
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
import { adminCardFamily } from "./AdminCards"
import { agentCardFamily } from "./AgentCards"
import { anonymousCeilingCardFamily } from "./AnonymousCeilingCard"
import { approvalCardFamily } from "./ApprovalCard"
import { billingCardFamily } from "./BillingCards"
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
import { notificationsCardFamily } from "./NotificationsCard"
import { LibrarianLibraryCard } from "../plugins/tutorial2-librarian-card"
import { RepositoryChoiceCard } from "./RepositoryChoiceCard"
import { repoImportCardFamily } from "./RepoImportCard"
import { runsCardFamily } from "./RunsCards"
import { searchResultsCardFamily } from "./SearchResultsCard"
import { secretsCardFamily } from "./SecretsCard"
import { syncCardFamily } from "./SyncCards"
import { themePickerCardFamily } from "./ThemePickerCard"
import { triggersCardFamily } from "./TriggersCard"
import { turnCardFamily } from "./TurnCards"
import { wikiCardFamily } from "./WikiCards"
import { workflowCardFamily } from "./WorkflowCards"
import { workspaceCardFamily } from "./WorkspaceCard"

/* The tutorial's two embedded surfaces: the ranked repository chooser and the Library shelf. */
const repositoryChoiceCardFamily: CardFamily<"repository-choice"> = {
  "repository-choice": {
    render: (card, actions) => <RepositoryChoiceCard payload={card.payload} onRunCommand={actions.onRunCommand}
      signedIn={signedInFor(actions)} />,
    pill: card => card.payload.created === null ? "" : "done"
  }
}

const pluginLibraryCardFamily: CardFamily<"plugin-library"> = {
  "plugin-library": {
    render: card => <LibrarianLibraryCard tutorial={card.payload.tutorial} />,
    pill: () => "done"
  }
}

/** Wire kinds retained for old journals, with no live producer or UI. */
export const RETIRED_CARD_KINDS = ["models", "model-call", "retired", "service-log", "repo", "targets", "target-run", "graph", "run-timeline", "run-history", "affected", "ci-matrix"] as const
type RetiredCardKind = (typeof RETIRED_CARD_KINDS)[number]
type RenderedCardKind = Exclude<Card["kind"], RetiredCardKind>
export const isRetiredCard = (card: Card): card is Extract<Card, { kind: RetiredCardKind }> =>
  (RETIRED_CARD_KINDS as readonly string[]).includes(card.kind)

/** The families in registration order; the test reads this list to prove the slices are disjoint. */
export const CARD_FAMILIES: ReadonlyArray<CardFamily<never>> = [
  repositoryHomeCardFamily,
  repositorySetupCardFamily,
  turnCardFamily,
  approvalCardFamily,
  billingCardFamily,
  adminCardFamily,
  conversationCardFamily,
  workflowCardFamily,
  flowPlanCardFamily,
  triggersCardFamily,
  runsCardFamily,
  issueCardFamily,
  landingCardFamily,
  changeCardFamily,
  notificationsCardFamily,
  repositoryUpdateCardFamily,
  envCardFamily,
  secretsCardFamily,
  accountCardFamily,
  stackCardFamily,
  repoImportCardFamily,
  registrationCardFamily,
  syncCardFamily,
  branchesCardFamily,
  fileCardFamily,
  themePickerCardFamily,
  agentCardFamily,
  flowFormCardFamily,
  workspaceCardFamily,
  anonymousCeilingCardFamily,
  searchResultsCardFamily,
  repositoryChoiceCardFamily,
  pluginLibraryCardFamily,
  wikiCardFamily,
  commitCardFamily
]

/** One entry per card kind. Written as a literal so a missing kind fails to compile. */
export const CARD_RENDERERS: CardFamily<RenderedCardKind> = {
  ...repositoryHomeCardFamily,
  ...repositorySetupCardFamily,
  ...turnCardFamily,
  ...approvalCardFamily,
  ...billingCardFamily,
  ...adminCardFamily,
  ...conversationCardFamily,
  ...workflowCardFamily,
  ...flowPlanCardFamily,
  ...triggersCardFamily,
  ...runsCardFamily,
  ...issueCardFamily,
  ...landingCardFamily,
  ...changeCardFamily,
  ...commitCardFamily,
  ...notificationsCardFamily,
  ...repositoryUpdateCardFamily,
  ...envCardFamily,
  ...secretsCardFamily,
  ...accountCardFamily,
  ...stackCardFamily,
  ...repoImportCardFamily,
  ...registrationCardFamily,
  ...syncCardFamily,
  ...branchesCardFamily,
  ...fileCardFamily,
  ...themePickerCardFamily,
  ...agentCardFamily,
  ...flowFormCardFamily,
  ...workspaceCardFamily,
  ...anonymousCeilingCardFamily,
  ...searchResultsCardFamily,
  ...repositoryChoiceCardFamily,
  ...pluginLibraryCardFamily,
  ...wikiCardFamily
}

/** The entry for one kind, typed to that kind's card. */
export const cardRenderer = <K extends RenderedCardKind>(kind: K): CardFamilyEntry<K> => CARD_RENDERERS[kind]

/**
 * The header's status word. Forms keep refusals in their body; other error cards wear "failed";
 * otherwise the family that owns the kind answers.
 */
export const pillStatus = (card: Card): string => {
  if (isRetiredCard(card)) return ""
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
  isRetiredCard(card) ? null : card.kind === "repo-update" && actions.projectionStore !== undefined
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
