/**
 * The event that opens a turn, written the way a host hands it to a role:
 * the time, where the event arrived, the conversation so far, and the new
 * message. Nothing else about the world is in the prompt; the role looks the
 * rest up through its tools.
 *
 * @since 0.1.0
 */
import type * as Suite from "./suite.ts"
import type * as World from "./world.ts"

const nameOf = (world: World.World, role: string, id: string): string => {
  if (id === "owner") return world.data.owner.name
  if (id === role) return "You"
  if (id === "system") return "System"
  return world.data.team.find((member) => member.id === id)?.name ?? id
}

const weekday = (iso: string): string => {
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`)
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
}

const stamp = (iso: string | undefined): string => (iso === undefined ? "" : `[${weekday(iso)} ${iso.slice(11, 16)}] `)

/** Where the event arrived, in words. */
export const whereOf = (world: World.World, role: string, where: string): string => {
  if (where === "dm") return `your direct messages with ${world.data.owner.name}`
  if (where.startsWith("agent:")) return `a direct message from ${nameOf(world, role, where.slice(6))}`
  if (where.startsWith("channel:")) {
    return `the #${where.slice(8)} channel (every agent and ${world.data.owner.name} can read it)`
  }
  if (where === "event") return "a scheduled event (no one wrote to you; nothing is posted unless you send it)"
  return where
}

/** Renders the turn's prompt. */
export const render = (options: {
  readonly world: World.World
  readonly role: string
  readonly where: string
  readonly history: ReadonlyArray<Suite.Message>
  readonly trigger: Suite.Message
}): string => {
  const { history, role, trigger, where, world } = options
  const now = world.data.now
  const date = new Date(now)
  const local = `${weekday(now)} ${now.slice(0, 4)}, ${now.slice(11, 16)} (${world.data.owner.timezone})`
  const lines = [
    `Now: ${Number.isNaN(date.getTime()) ? now : local}`,
    `Where: ${whereOf(world, role, where)}`
  ]
  if (history.length > 0) {
    lines.push("", "Earlier in this conversation:")
    for (const message of history) {
      lines.push(`${stamp(message.at)}${nameOf(world, role, message.from)}: ${message.text}`)
    }
  }
  lines.push(
    "",
    trigger.from === "system" ? "Event:" : `New message from ${nameOf(world, role, trigger.from)}:`,
    trigger.text
  )
  return lines.join("\n")
}
