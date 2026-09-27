/*
 * The integrations seam (DESIGN §3.6): the services that sync with a
 * repository's threads, tasks and wiki, read from what the backend already
 * serves — Linear's integration list (`GET /api/repos/{o}/{r}/linear`) and,
 * when the chat-sync mapping routes land, Slack's channel admissions
 * (`GET …/issues/slack/channels`). The rows ride the existing connect card
 * (`connect-embedded`), which the connect surface already renders; a service
 * without a backend wears Coming soon and no action; a refused read wears the
 * server's own words. Reads run in the background under the shared toast.
 */
import type { IntegrationRow } from "@smthrs/rpc/Threads"
import type { Card } from "../AppState"
import { TOAST_SUPERSEDED } from "../controller/failures"
import { resolveTargetRepo } from "../RepoContext"
import { captureCloudOwner, readErrorMessage, readResult, unreachableSentence } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

export interface IntegrationsSeam {
  readonly listIntegrations: (repo?: string) => Promise<string | void | { readonly value: string }>
}

const CONNECT_CARD_ID = "connect-embedded"
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const asString = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined

export const createIntegrationsSeam = (ctx: SeamContext): IntegrationsSeam => {
  const repoPath = (repo: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    return `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  }

  const linearRow = async (repo: string): Promise<IntegrationRow> => {
    let response: Response
    try { response = await ctx.http(`${repoPath(repo)}/linear`) }
    catch (error) { return { id: "linear", state: "error", error: unreachableSentence("read the Linear integration", error) } }
    if (response.status === 404) return { id: "linear", state: "not-connected" }
    if (!response.ok) return { id: "linear", state: "error", error: await readErrorMessage(response, `Reading the Linear integration failed (${response.status})`) }
    const body: unknown = await response.json().catch(() => null)
    const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.integrations) ? body.integrations : []
    const integration = rows.find((row): row is Record<string, unknown> => isRecord(row))
    if (integration === undefined) return { id: "linear", state: "not-connected" }
    const remediation = asString(integration.remediation_state)
    const team = asString(integration.linear_team_key) ?? asString(integration.linear_team_name) ?? asString(integration.linear_team_id)
    return {
      id: "linear",
      state: remediation !== undefined ? "error" : integration.is_active === false ? "not-connected" : "connected",
      ...(team === undefined ? {} : { detail: team }),
      ...(remediation === undefined ? {} : { error: remediation }),
      ...(asString(integration.last_sync_at) === undefined ? {} : { lastSyncAt: integration.last_sync_at as string })
      // No action yet: the app retired its Linear sync-ops card (Cards.ts retiredKinds); the Linear agent's slice brings the door back (#2116).
    }
  }

  const slackRow = async (repo: string): Promise<IntegrationRow> => {
    let response: Response
    try { response = await ctx.http(`${repoPath(repo)}/issues/slack/channels`) }
    catch (error) { return { id: "slack", state: "error", error: unreachableSentence("read the Slack channels", error) } }
    if (response.status === 404 || response.status === 405) return { id: "slack", state: "not-connected" }
    if (!response.ok) return { id: "slack", state: "error", error: await readErrorMessage(response, `Reading the Slack channels failed (${response.status})`) }
    const body: unknown = await response.json().catch(() => null)
    const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.channels) ? body.channels : []
    const channels = rows.flatMap((row) => isRecord(row) ? [asString(row.channel_name) ?? asString(row.channel_id)] : []).filter((name): name is string => name !== undefined)
    return channels.length === 0 ? { id: "slack", state: "not-connected" } : { id: "slack", state: "connected", detail: channels.join(", ") }
  }

  return {
    listIntegrations: async (explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const existing = ctx.store.collections.cards.get(CONNECT_CARD_ID)
      const base: Extract<Card, { kind: "connect" }> = existing?.kind === "connect" ? existing : {
        id: CONNECT_CARD_ID, kind: "connect", title: "Connect work to Smithers", status: "active", createdAt: Date.now(), ordinal: ctx.nextOrdinal(),
        payload: { github: { connected: false, login: null }, nativeAvailable: false }
      }
      const current = captureCloudOwner(ctx, false)
      const actor = ctx.actor()
      const work = async () => {
        const [slack, linear] = await Promise.all([slackRow(repo), linearRow(repo)])
        if (!current()) return TOAST_SUPERSEDED
        const rows: Array<IntegrationRow> = [slack, linear, { id: "notion", state: "coming-soon" }]
        const latest = ctx.store.collections.cards.get(CONNECT_CARD_ID)
        const card = latest?.kind === "connect" ? latest : base
        await ctx.dispatch({ type: "card.upsert", actor, card: { ...card, payload: { ...card.payload, integrations: { repo, rows } } } }).isPersisted.promise
        return readResult(rows.map((row) => `${row.id}: ${row.state}${row.detail === undefined ? "" : ` · ${row.detail}`}${row.error === undefined ? "" : ` · ${row.error}`}`).join("\n"))
      }
      if (existing?.kind !== "connect") await ctx.dispatch({ type: "card.upsert", actor, card: base }).isPersisted.promise
      const result = ctx.withToast ? await ctx.withToast(`integrations.read:${repo}`, "Reading integrations", "Integrations", work, false, current, CONNECT_CARD_ID) : await work()
      if (result === TOAST_SUPERSEDED) return
      return result
    }
  }
}
