/*
 * The `confirm` kind: A✓, the app agent's one-click confirmation, and the
 * person's own Review & merge (mvp.md Appendix B, card-kinds.md Confirm).
 * Private to the person who presses it; everyone else sees nothing. The
 * primary button is the act's own flow, run as the person; once it has run,
 * the card is its receipt. A confirmation the install serves
 * (`confirmation:<id>`) reads the row the TODO seam keeps from
 * GET /api/confirmations; a Review & merge for this host's TODO Tn
 * (`merge:todo:<n>`) reads the TODO card the TODO seam keeps live from
 * /api/todos/<n>. MOCK SEAM: elsewhere the rows come from the seeded design
 * world (state/seams/DesignWorld/chat.ts).
 */
import { useSyncExternalStore } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import { ConfirmCardSchema } from "@smthrs/rpc/ConfirmCard"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { useController } from "../ControllerContext"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import { confirmSubject, designActCard, designMergeCard, useDesignAct } from "../state/seams/DesignWorld/chat"
import { useDesign, useDesignTodo, useDesignViewer, useDesignWorld } from "../state/seams/DesignWorld/hooks"
import { designAudience } from "../state/seams/DesignWorld/todo"
import { servedConfirmationId } from "../state/seams/TodoSeam"
import { useTodoCardRow } from "../state/useCardRows"
import type { CardFamily, CardOf } from "./CardFamily"
import { reviewMergeOf, useTodoRole } from "./TodoCard"
import { ConfirmView } from "./views/ConfirmView"

const ActBody = ({ card, actId }: { readonly card: CardOf<"confirm">; readonly actId: string }) => {
  const controller = useController()
  const design = useDesign()
  const world = useDesignWorld()
  const act = useDesignAct(actId)
  if (act === undefined) return null
  const confirm = designActCard(world, act)
  /* The press runs the act's flow through the registry; its success settles the act into a receipt. */
  const dispatch: CardCommandDispatch = (tag, input) => {
    const outcome = controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })
    if (tag !== "confirm.cancel") void outcome.then(settled => {
      if (settled.status !== "executed") return
      design.patch("acts", act.id, current => ({ ...current, state: "done" }))
      /* The card becomes its receipt: the header reads what was done. */
      void controller.presentSubject({ ...card, title: act.receipt })
    })
    return outcome
  }
  const bindings = cardActions(dispatch, confirm.actions)
  return <ConfirmView model={confirm.model} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction}
    view={{ maximized: false }} onView={() => {}} />
}

const MergeBody = ({ card, todoId }: { readonly card: CardOf<"confirm">; readonly todoId: string }) => {
  const controller = useController()
  const world = useDesignWorld()
  const viewer = useDesignViewer()
  const todo = useDesignTodo(todoId)
  const confirm = todo === undefined ? undefined : designMergeCard(world, todo, viewer)
  if (confirm === undefined) return null
  const dispatch: CardCommandDispatch = (tag, input) => {
    const outcome = controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })
    /* Merged, the card is its receipt: the header reads what was done. */
    if (tag === "merge") void outcome.then(settled => { if (settled.status === "executed") void controller.presentSubject({ ...card, title: `Merged ${todo!.ref}` }) })
    return outcome
  }
  const bindings = cardActions(dispatch, confirm.actions)
  return <ConfirmView model={confirm.model} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction}
    view={{ maximized: false }} onView={() => {}} />
}

/** Review & merge for this host's TODO Tn, private to the signed-in person it was opened for. */
const TodoMergeBody = ({ card, n }: { readonly card: CardOf<"confirm">; readonly n: number }) => {
  const controller = useController()
  const identity = useLiveQuery(controller.store.collections.identitySessions).data[0]
  const role = useTodoRole()
  const todo = TodoCardSchema.safeParse(useTodoCardRow(controller.store.collections.cards, n)?.payload.model)
  if (card.audience_member_id !== null && card.audience_member_id !== identity?.login || !todo.success) return null
  const login = identity?.login ?? ""
  const viewer = todo.data.owner.login === login ? todo.data.owner : { login, name: login, avatar_url: PlaceholderAvatarUrl }
  const confirm = reviewMergeOf(todo.data, role, viewer)
  if (confirm === undefined) return null
  /* Merge runs the TODO card's own flow: the TODO seam's POST /api/todos/<n>/merge with the browser session. */
  const dispatch: CardCommandDispatch = (tag, input) =>
    controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })
  const bindings = cardActions(dispatch, confirm.actions)
  return <ConfirmView model={confirm.model} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction}
    view={{ maximized: false }} onView={() => {}} />
}

/** A confirmation the install serves, private to the signed-in person it is for; settled, it is its receipt. */
const HostedConfirmBody = ({ card, id }: { readonly card: CardOf<"confirm">; readonly id: string }) => {
  const controller = useController()
  const identity = useLiveQuery(controller.store.collections.identitySessions).data[0]
  const rows = useSyncExternalStore(controller.confirmations.subscribe, controller.confirmations.get, controller.confirmations.get)
  const row = rows.find(each => each.id === id)
  const model = ConfirmCardSchema.safeParse(row?.card)
  /* Commit is the served act's own flow: todo.new approves this confirmation, which files the TODO. */
  if (card.audience_member_id !== identity?.login || row === undefined || !model.success || model.data.action.tag !== "todo.new") return null
  const actions: CardActionDefinition[] = row.state !== "pending" ? [] : [
    { tag: "todo.new", label: model.data.action.verb, primary: true, command_input: { confirmation: id } },
    { tag: "confirm.cancel", label: "Cancel", command_input: { confirmation: `confirmation:${id}`, revision: id } }
  ]
  const dispatch: CardCommandDispatch = (tag, input) =>
    controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })
  const bindings = cardActions(dispatch, actions)
  return <ConfirmView model={model.data} actions={bindings.actions} gestures={bindings.gestures} onAction={bindings.onAction}
    view={{ maximized: false }} onView={() => {}} />
}

/** Only the person the card is for sees it (C-ACC-02); the viewer comes from the design seed. */
const DesignConfirmBody = ({ card, subject }: { readonly card: CardOf<"confirm">; readonly subject: { readonly kind: "act" | "merge"; readonly id: string } }) => {
  const viewer = useDesignViewer()
  if (card.audience_member_id !== null && card.audience_member_id !== designAudience(viewer)) return null
  return subject.kind === "act" ? <ActBody card={card} actId={subject.id} /> : <MergeBody card={card} todoId={subject.id} />
}

const ConfirmBody = ({ card }: { readonly card: CardOf<"confirm"> }) => {
  const served = servedConfirmationId(card.payload.id)
  if (served !== undefined) return <HostedConfirmBody card={card} id={served} />
  const subject = confirmSubject(card.payload.id)
  if (subject === undefined) return null
  const hosted = subject.kind === "merge" ? /^todo:([1-9]\d*)$/.exec(subject.id) : null
  return hosted ? <TodoMergeBody card={card} n={Number(hosted[1])} /> : <DesignConfirmBody card={card} subject={subject} />
}

export const confirmCardFamily: CardFamily<"confirm"> = {
  confirm: { render: card => <ConfirmBody card={card} />, pill: () => "" }
}
