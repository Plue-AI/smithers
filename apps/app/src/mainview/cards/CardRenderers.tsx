import { SetupCard, type SetupCardProps } from "./SetupCard"
import { SetupView } from "./views/SetupView"
import { HomeCard } from "./HomeContainer"
import { runTraceCardFamily } from "./RunTraceCard"
import type { ConfirmViewProps } from "@smthrs/rpc/ConfirmCard"
import { ConfirmView } from "./views/ConfirmView"
import { repositoryUpdateCardFamily } from "./RepositoryUpdateCard"
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
import { flowCardFamily, workflowCardFamily } from "./FlowCard"
import { workspaceCardFamily } from "./WorkspaceCard"
import { settingsCardFamily } from "./SettingsContainer"
import { membersCardFamily } from "./MembersCard"
import { commandsCardFamily } from "./CommandsContainer"
import { todoCardFamily } from "./TodoCard"
import { draftCardFamily } from "./DraftCard"
import { confirmCardFamily } from "./ActCard"
import { branchCardFamily } from "./BranchCard"
import { terminalCardFamily } from "./TerminalCard"
import { runCardFamily } from "./RunContainer"

/* The tutorial's two embedded surfaces: the ranked repository chooser and the Library shelf. */
const repositoryChoiceCardFamily: CardFamily<"repository-choice"> = {
  "repository-choice": {
    render: (card, actions) => <RepositoryChoiceCard payload={card.payload} onRunCommand={actions.onRunCommand}
      signedIn={signedInFor(actions)} />,
    pill: card => card.payload.created === null ? "" : "done"
  }
}

/* MOCK SEAM (state/seams/DesignWorld): `design:` cards read the seeded world through their own bodies. */
import { isDesignCard } from "../state/seams/DesignWorld/subjects"
import { DesignSubjectBody } from "./SubjectCards"
type RenderedCardKind = Exclude<Card["kind"], "retired" | "balance" | "billing-plans" | "stack" | "factory.home">
export const isRetiredCard = (card: Card): card is Extract<Card, { kind: "retired" }> =>
  card.kind === "retired"

/** The families in registration order; the test reads this list to prove the slices are disjoint. */
export const CARD_FAMILIES: ReadonlyArray<CardFamily<never>> = [
  settingsCardFamily,
  membersCardFamily,
  commandsCardFamily,
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
  commitCardFamily,
  todoCardFamily,
  draftCardFamily,
  confirmCardFamily,
  branchCardFamily,
  terminalCardFamily,
  runCardFamily,
  flowCardFamily
]

/** One entry per card kind. Written as a literal so a missing kind fails to compile. */
export const CARD_RENDERERS: CardFamily<RenderedCardKind> = {
  ...settingsCardFamily,
  ...membersCardFamily,
  ...commandsCardFamily,
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
  ...wikiCardFamily,
  ...todoCardFamily,
  ...draftCardFamily,
  ...confirmCardFamily,
  ...branchCardFamily,
  ...terminalCardFamily,
  ...runCardFamily,
  ...flowCardFamily
}

/** The entry for one kind, typed to that kind's card. */
export const cardRenderer = <K extends RenderedCardKind>(kind: K): CardFamilyEntry<K> => CARD_RENDERERS[kind]

/**
 * The header's status word. Forms keep refusals in their body; other error cards wear "failed";
 * otherwise the family that owns the kind answers.
 */
export const pillStatus = (card: Card): string => {
  if (isRetiredCard(card) || card.kind === "balance" || card.kind === "billing-plans" || card.kind === "stack" || card.kind === "factory.home" || isDesignCard(card)) return ""
  if (card.status === "error" && card.kind !== "flow-form") return "failed"
  return cardRenderer(card.kind).pill(card)
}

/* The repository list reads GitHub only for a signed-in identity (repositoryChoice.ts); without a store, assume it did. */
const signedInFor = (actions: CardActions): boolean => {
  const identities = actions.projectionStore?.collections.identitySessions
  return identities === undefined || identities.get("identity")?.state === "signed-in"
}

/** The card's body, from the family that owns its kind. */
export const renderCardBody = (card: Card, actions: CardActions) =>
  isRetiredCard(card) || card.kind === "balance" || card.kind === "billing-plans" || card.kind === "stack" || card.kind === "factory.home" ? null : isDesignCard(card) ? <DesignSubjectBody card={card} />
    : card.kind === "repo-update" && actions.projectionStore !== undefined
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
/** The Home card of `main`'s conversation and `/stack` (T-APP-01); HomeCard composes role, admission, dispatch and view state from the controller. */
export const renderHomeCard = () => <HomeCard />

/** T-FLW-06: the live proposals caller supplies its scoped model and admitted commands. */
export { ProposalContainer as renderProposalCard } from "./ProposalContainer"
