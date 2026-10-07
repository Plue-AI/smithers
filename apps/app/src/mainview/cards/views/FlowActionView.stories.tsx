import type { Action } from "@smthrs/rpc/CardAction"
import { FlowActionView } from "./FlowActionView"
import type { ViewStory } from "./stories"

const actions: readonly Action[] = [
  { tag: "help", label: "Open" },
  { tag: "help", label: "Open", primary: true, args: { source: "fixture" } },
  { tag: "help", label: "Retry", disabled: { reason: "Unavailable" } }
]
export const stories: ViewStory[] = actions.map((action, index) => ({
  name: String(index), expect: [action.label], actions: [action],
  render: (callbacks, supplied = [action]) => <>{(supplied as readonly Action[]).map((item, key) => <FlowActionView key={key} action={item} onAction={callbacks.onAction} />)}</>
}))
