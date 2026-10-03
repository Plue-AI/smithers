import type { CardProps } from "@smthrs/rpc/CardAction"
import { SetupAction } from "./SetupAction"
export function SetupActions({ actions, onAction, inline = false }: Pick<CardProps<unknown>, "actions" | "onAction"> & { inline?: boolean }) {
  const rows = []
  for (const [index, action] of actions.entries()) rows.push(<SetupAction key={index} action={action} inline={inline} onAction={onAction} />)
  return <div className="setup-actions">{rows}</div>
}
