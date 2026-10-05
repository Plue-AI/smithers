/*
 * Starting an agent CLI on the host and binding its session to the
 * conversation (#3730, mvp.md M-38). The door answers "Requested" at once and
 * the launch runs in the background under one toast, which settles when the
 * host has bound the session or refused (AGENTS.md "Instant chat"). The bound
 * session is an `agent-session` card, so the conversation shows it after a
 * reload. A second press of the same launch while it runs joins the first.
 */
import { EXTERNAL_LAUNCH_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { ControllerContext } from "./context"

export type LaunchableAgent = "codex" | "claude-code"
export type StartAgent = (agent: LaunchableAgent, prompt: string) => Promise<string | { readonly value: string }>

const NAMES: Record<LaunchableAgent, string> = { codex: "Codex", "claude-code": "Claude Code" }

/** What the app says for each reason the host gives (src/bun/AgentLaunch.ts LaunchFailure); the host's own words are diagnostics. */
const FAILURES: Record<string, (name: string) => string> = {
  exited: name => `${name} exited before it started a session.`,
  timeout: name => `${name} started no session in time.`,
  stopping: () => "This machine is stopping."
}
const failureReason = (body: unknown): string | undefined => {
  const error = (body as { error?: { reason?: unknown } } | undefined)?.error
  return typeof error?.reason === "string" ? error.reason : undefined
}

const launched = (body: unknown, agent: LaunchableAgent): string | undefined => {
  const value = body as { agent?: unknown; session?: unknown } | undefined
  return value?.agent === agent && typeof value.session === "string" && value.session !== "" ? value.session : undefined
}

export const createAgentLaunch = (
  ctx: Pick<ControllerContext, "store" | "withToast" | "resolveToast" | "commandActor" | "errorMessageOf" | "disposed" | "failures">,
  http: (path: string, init?: RequestInit) => Promise<Response>
): { readonly startAgent: StartAgent } => {
  const inFlight = new Map<string, Promise<unknown>>()
  let launches = 0
  const launch = async (agent: LaunchableAgent, prompt: string, actor: ControllerContext["commandActor"]): Promise<string | { readonly value: string }> => {
    const name = NAMES[agent]
    const response = await http(EXTERNAL_LAUNCH_PATH, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, prompt })
    })
    if (!response.ok) {
      const worded = FAILURES[failureReason(await response.clone().json().catch(() => undefined)) ?? ""]
      return worded === undefined ? ctx.errorMessageOf(response, `${name} did not start.`) : worded(name)
    }
    const session = launched(await response.json().catch(() => undefined), agent)
    if (session === undefined) return `${name} started, but the host did not name its session.`
    const id = `agent-session:${session}`
    const existing = ctx.store.collections.cards.get(id)
    await ctx.store.dispatch({ type: "card.upsert", actor, card: {
      id, kind: "agent-session", title: name, status: "active", createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.store.nextOrdinal(), payload: { agent, session }
    } }).isPersisted.promise
    return { value: `Started ${name}` }
  }
  return {
    startAgent: async (agent, prompt) => {
      const claim = `${agent}\0${prompt.trim()}`
      if (inFlight.has(claim)) return { value: "Requested" }
      const name = NAMES[agent]
      // Whoever asked binds the session, though it is bound after the door answered.
      const actor = ctx.commandActor
      launches += 1
      const key = `agent.launch.${agent}.${launches}`
      const running = ctx.withToast(key, `Starting ${name}`, `${name} started`, () => launch(agent, prompt.trim(), actor)).then(outcome => {
        // A refusal inside the toast debounce showed nothing; it is still a failure the person must see.
        if (typeof outcome === "string" && !ctx.disposed && ctx.store.collections.toasts.get(`toast-${key}`) === undefined) {
          ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title: `Starting ${name}` })
          ctx.resolveToast(key, { status: "failed", detail: outcome })
        }
      }).catch(error => ctx.failures.report("toast.work", error)).finally(() => inFlight.delete(claim))
      inFlight.set(claim, running)
      return { value: "Requested" }
    }
  }
}
