/** Terminal metadata only; T-APP-12 validates the live socket boundary. */
import type { Actor } from "./CardPrimitives.ts"

export type TerminalCard = {
  id: string
  title: string
  branch: string
  owner: Actor
  agents: Actor[]
  watchers: Actor[]
  command?: string
  viewer_is_owner: boolean
  frozen: boolean
}
