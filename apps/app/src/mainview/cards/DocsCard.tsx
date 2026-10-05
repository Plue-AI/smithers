import type { ComponentType } from "react"
import type { DocsViewProps } from "@smthrs/rpc/DocsCard"
import { useController } from "../ControllerContext"
import { cardActions, type CardCommandDispatch } from "../flows/cardActions"
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { DocsView } from "./views/DocsView"

type StoredDocs = Extract<Card, { kind: "docs" }>

export const DocsCard = ({ card, View, dispatch, available, maximized = false }: {
  card: StoredDocs; View: ComponentType<DocsViewProps>; dispatch: CardCommandDispatch;
  available: boolean; maximized?: boolean
}) => {
  const bindings = cardActions<"open">(dispatch, available ? [{
    tag: "docs", label: "Open", gesture: "open", command_input: {},
    resolve_input: input => ({ page: input.page })
  }] : [])
  return <View model={{
    toc: card.payload.toc ?? [{ slug: card.payload.page, title: card.title }],
    page: { slug: card.payload.page, title: card.title, summary: card.payload.summary ?? "", markdown: card.payload.markdown },
    ...(card.payload.anchor ? { anchor: card.payload.anchor } : {}),
    ...(card.payload.not_found ? { not_found: card.payload.not_found } : {})
  }} {...bindings} view={{ maximized }} onView={() => {}} />
}
const DocsBody = ({ card, maximized }: { card: StoredDocs; maximized: boolean }) => {
  const controller = useController()
  return <DocsCard card={card} View={DocsView} maximized={maximized} available={controller.docsAvailable()}
    dispatch={(name, payload) => controller.commands.submit({ name, payload: payload ?? {}, actor: "user" })} />
}
export const docsCardFamily: CardFamily<"docs"> = {
  docs: { render: (card, actions) => <DocsBody card={card} maximized={actions.presentation === "maximized"} />, pill: settledPill }
}
