/* T-APP-12: live metadata and bytes; no seed or shared-user fallback. */
import { useMemo, type ReactNode } from "react"
import { Terminal, type TerminalStream } from "@smthrs/ui/adapters/terminal"
import { useController } from "../ControllerContext"
import { useTopic } from "../state/useTopic"
import { createTerminalBinding } from "../state/seams/TerminalSeam"
import { cardActions, type CardCommandDispatch } from "../flows/cardActions"
import type { CardActions, CardFamily, CardOf } from "./CardFamily"
import type { TerminalCard } from "@smthrs/rpc/TerminalCard"
import { TerminalView } from "./views/TerminalView"

export const terminalSlot = (model: TerminalCard, stream: TerminalStream | undefined, typed: (data: string) => void): ReactNode => {
  const readOnly = !model.viewer_is_owner || model.frozen
  return <Terminal key={model.id} stream={stream} onData={readOnly ? undefined : typed} readOnly={readOnly}
    palette="paper" fontSize={12.5} cursorBlink={!readOnly} aria-label={`${model.title} terminal`} />
}

export const TerminalCardBody = ({ card, actions }: { readonly card: CardOf<"terminal">; readonly actions: CardActions }) => {
  const controller = useController()
  const source = controller.terminalCards
  const id = card.payload.id
  const branch = source?.available() ? source.branch(id) : undefined
  const topic = branch === undefined ? undefined : `branch:${branch}`
  const snapshot = useTopic(topic, controller.live)
  const binding = useMemo(() => source && branch && controller.live ? createTerminalBinding({
    repo: source.repo, branch, id, client: controller.cloudTerminal,
    viewer: source.viewer, available: source.available,
    metadata: () => { const current = controller.live!.getSnapshot(`branch:${branch}`); return current?.error ? undefined : current?.data }
  }) : undefined, [source, branch, id, controller])
  const model = snapshot?.error ? undefined : binding?.model()
  if (!model || !binding) return null
  const dispatch: CardCommandDispatch = (tag, input) =>
    controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })
  const readOnly = !model.viewer_is_owner || model.frozen
  return <TerminalView model={model} actions={[]} gestures={{}} onAction={cardActions(dispatch, []).onAction}
    view={{ maximized: actions.presentation === "maximized" }} onView={() => {}}
    terminal={<Terminal key={model.id} stream={binding.stream} onData={readOnly ? undefined : binding.input}
      onResize={readOnly ? undefined : binding.resize} readOnly={readOnly} palette="paper" fontSize={12.5}
      cursorBlink={!readOnly} aria-label={`${model.title} terminal`} />} />
}

/** The `terminal` kind: a subject-only card (card-kinds.md), one per member session. */
export const terminalCardFamily: CardFamily<"terminal"> = {
  terminal: { render: (card, actions) => <TerminalCardBody card={card} actions={actions} />, pill: () => "" }
}
