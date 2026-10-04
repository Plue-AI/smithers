import type { CardViewProps } from "../ChatCards"
import type { AppController } from "../state/AppController"
import type { Card } from "../state/AppState"

/*
 * The CardView command bindings, built once per controller.
 *
 * Every act a card raises is a flow name, bound to the same controller.
 *
 * Bindings are cached by controller and card record. Unchanged cards keep
 * the same callbacks through unrelated transcript renders, and replaced
 * records can be collected. Their origin affects presentation, never permission.
 */

/** The CardView callbacks that dispatch its flows. */
type CardBindings = Omit<
  CardViewProps,
  "card" | "maximized" | "worldDocuments" | "debugVerbose" | "signedOut" | "workflowCatalogs" | "triggerCatalogs" | "fileCards"
>

const bound = new WeakMap<AppController, CardBindings>()
const cardBound = new WeakMap<AppController, WeakMap<Card, CardBindings>>()

/** Stable bindings capture the originating card, never its mutable presentation. */
export const controllerCardActions = (controller: AppController, card?: Card): CardBindings => {
  const cards = cardBound.get(controller) ?? new WeakMap<Card, CardBindings>()
  if (card !== undefined) cardBound.set(controller, cards)
  const cached = card === undefined ? bound.get(controller) : cards.get(card)
  if (cached !== undefined) return cached
  const runCommand: AppController["runCommand"] = (name, args) => card === undefined
    ? controller.runCommand(name, args)
    : controller.runCommand(name, args, card.id)
  const actions: CardBindings = {
    projectionStore: controller.store,
    // Saved confirmations retain their command door; removed commands report
    // the controller's explicit refusal rather than silently doing nothing.
    onDecideApproval: (id, decision, answer, question) =>
      // Structured human answers keep their value shape through the controller.
      answer === undefined
        ? runCommand(
          decision === "approved" ? "approval.approve" : "approval.deny",
          id
        )
        : controller.answerApproval(id, answer, question),
    onMaximize: (id) => runCommand("card.maximize", id),
    onMinimize: () => runCommand("card.minimize"),
    onFrameBack: () => runCommand("frame.back"),
    onFrameForward: () => runCommand("frame.forward"),
    onConnectGitHub: () => runCommand("sign-in"),
    onRunWorkflow: (name) => runCommand("flow.run", name),
    onStopRun: (id) => runCommand("flow.run.stop", id),
    onRetryRun: (id) => runCommand("flow.run.retry", id),
    onChooseWorkflowRepo: (name) => runCommand("flow.repo.choose", name),
    onChangeWorldDocument: (id, body) =>
      runCommand("wiki.edit", `${id} ${JSON.stringify(body)}`),
    onAttachWorldEditor: controller.attachWorldEditor,
    onRunCommand: (name, commandArgs) => runCommand(name, commandArgs)
  }
  if (card === undefined) bound.set(controller, actions)
  else cards.set(card, actions)
  return actions
}
