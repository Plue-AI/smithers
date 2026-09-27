import { useLiveQuery } from "@tanstack/react-db"
import { useMemo } from "react"
import { cardActions } from "../cards/CardActions"
import { CardView } from "../ChatCards"
import { useController } from "../ControllerContext"
import { SubagentCrumb, subagentCrumbOf } from "../SubagentGrid"
import { useCardRows, useFileCardRows, useFlowDurationRows, useTriggerListRows, useWorkflowCatalogRows } from "../state/useCardRows"

/*
 * A card tab's body (docs/LOCAL-APP.md "Cards"): the SAME card component
 * over the SAME store record the transcript renders, so the tab is a
 * presentation of the card and never a second implementation. The command
 * bindings are literally the ones App.tsx gives the transcript's copy
 * (cards/CardActions.ts), so the tab can never again lose an act the
 * transcript has — it used to keep its own copy and had no frame controls.
 * Every in-card act still routes through the registry.
 */
export function CardTabBody({ cardId }: { readonly cardId: string }) {
  const controller = useController()
  const { collections } = controller.store
  const cardRows = useCardRows(collections.cards)
  const workflowCatalogs = useWorkflowCatalogRows(collections.cards)
  const triggerCatalogs = useTriggerListRows(collections.cards)
  const flowDurations = useFlowDurationRows(collections.flowDurations)
  const fileCards = useFileCardRows(collections.cards)
  const { data: worldDocumentRows } = useLiveQuery(collections.worldDocuments)
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      maximizedCardId: session.maximizedCardId,
      verbose: session.verbose
    }))
  )
  const worldDocuments = useMemo(
    () => [...worldDocumentRows].sort((left, right) => left.path.localeCompare(right.path)),
    [worldDocumentRows]
  )
  const card = cardRows.find((candidate) => candidate.id === cardId)
  if (card === undefined) {
    // The card left the transcript (a /clear, a sign-out): the tab states it and offers nothing else.
    return <p className="card-tab-gone">This card is no longer in the conversation.</p>
  }
  const crumb = subagentCrumbOf(cardRows, { card })
  return (
    <div className="card-tab">
      {crumb === undefined ? null : <SubagentCrumb title={crumb.title} color={crumb.color} onRunCommand={controller.runCommand} />}
      <CardView
        card={card}
        maximized={sessionRows[0]?.maximizedCardId === card.id}
        presentation="maximized"
        debugVerbose={sessionRows[0]?.verbose === true}
        worldDocuments={worldDocuments}
        workflowCatalogs={workflowCatalogs}
        triggerCatalogs={triggerCatalogs}
        flowDurations={flowDurations}
        fileCards={fileCards}
        {...cardActions(controller, card)}
      />
    </div>
  )
}
