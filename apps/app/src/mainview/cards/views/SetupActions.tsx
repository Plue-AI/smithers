import type { CardProps } from "@smthrs/rpc/CardAction"
import { SetupAction } from "./SetupAction"
export function SetupActions({ actions, onAction }: Pick<CardProps<unknown>, "actions" | "onAction">) {
  const rows = []
  for (const [index, action] of actions.entries()) rows.push(<SetupAction key={index} action={action} onAction={onAction} />)
  return <div className="setup-actions">{rows}</div>
}
