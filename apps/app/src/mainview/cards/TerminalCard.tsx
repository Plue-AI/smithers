/* Live metadata and bytes take over the design fallback; installs never seed terminals. */
import { useMemo, useRef, useSyncExternalStore, type ReactNode } from "react"
import { Terminal, type TerminalStream, type TerminalWriter } from "@smthrs/ui/adapters/terminal"
import { useController } from "../ControllerContext"
import { useTopic } from "../state/useTopic"
import { createTerminalBinding } from "../state/seams/TerminalSeam"
import { cardActions, type CardCommandDispatch } from "../flows/cardActions"
import type { CardActions, CardFamily, CardOf } from "./CardFamily"
import type { TerminalCard } from "@smthrs/rpc/TerminalCard"
import { TerminalView } from "./views/TerminalView"
import { designTerminalStream, ownerInput } from "../state/seams/DesignWorld/terminal"
import { useDesignWorldOf } from "../state/seams/DesignWorld/hooks"
import { designTerminalModel } from "../state/seams/DesignWorld/branch"

export const terminalSlot = (model: TerminalCard, stream: TerminalStream | undefined, typed: (data: string) => void, resize?: (size: { cols: number; rows: number }) => void): ReactNode => {
  const readOnly = !model.viewer_is_owner || model.frozen
  return <Terminal key={model.id} stream={stream} onData={readOnly ? undefined : typed} onResize={readOnly ? undefined : resize} readOnly={readOnly}
    data-testid={`terminal-${model.id}`} data-control-focus-id={`terminal:${model.id}`} data-control-focus-kind="terminal"
    palette="paper" fontSize={12.5} cursorBlink={!readOnly} aria-label={`${model.title} terminal`} />
}

const noSubscription = () => () => {}

export const TerminalCardBody = ({ card, actions }: { readonly card: CardOf<"terminal">; readonly actions: CardActions }) => {
  const controller = useController()
  const source = controller.terminalCards
  const id = card.payload.id
  useSyncExternalStore(source?.subscribe ?? noSubscription, () => source?.viewer(), () => undefined)
  const branch = useSyncExternalStore(source?.subscribe ?? noSubscription,
    () => source?.available() ? source.branch(id) : undefined, () => undefined)
  const topic = branch === undefined ? undefined : `branch:${branch}`
  const snapshot = useTopic(topic, controller.live)
  const binding = useMemo(() => source && branch && controller.live ? createTerminalBinding({
    repo: source.repo, branch, id, client: controller.cloudTerminal,
    viewer: source.viewer, available: source.available,
    metadata: () => { const current = controller.live!.getSnapshot(`branch:${branch}`); return current?.error ? undefined : current?.data }
  }) : undefined, [source, branch, id, controller])
  const model = snapshot?.error ? undefined : binding?.model()
  if (!model || !binding) return <DesignTerminalCard key={id} card={card} actions={actions} />
  const dispatch: CardCommandDispatch = (tag, input) =>
    controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })
  return <TerminalView model={model} actions={[]} gestures={{}} onAction={cardActions(dispatch, []).onAction}
    view={{ maximized: actions.presentation === "maximized" }} onView={() => {}}
    terminal={terminalSlot(model, binding.stream, binding.input, binding.resize)} />
}

/** The `terminal` kind: a subject-only card (card-kinds.md), one per member session. */
export const terminalCardFamily: CardFamily<"terminal"> = {
  terminal: { render: (card, actions) => <TerminalCardBody card={card} actions={actions} />, pill: () => "" }
}

export function DesignTerminalCard({ card, actions }: { card: CardOf<"terminal">; actions: CardActions }) {
  const controller = useController()
  const design = controller.design
  const world = useDesignWorldOf(design)
  const id = card.payload.id
  const writer = useRef<TerminalWriter | undefined>(undefined)
  const stream = useMemo(() => designTerminalStream(design, id, write => { writer.current = write }), [design, id])
  const input = useMemo(() => ownerInput(() => writer.current, command =>
    controller.commands.submit({ name: "terminal", payload: { operation: "command", id, command }, actor: "user", originCardId: card.id })), [controller, id, card.id])
  const terminal = world.terminals.find(each => each.id === id)
  if (!terminal) return null
  const model = designTerminalModel(world, terminal, design.viewer())
  return <TerminalView model={model} actions={[]} gestures={{}} onAction={() => {}}
    view={{ maximized: actions.presentation === "maximized" }} onView={() => {}}
    terminal={terminalSlot(model, stream, input)} />
}
