/*
 * The integrations seam (DESIGN §3.6): the services that sync with a
 * repository's conversations, issues and wiki, read from the routes the
 * backend registers (compose/router.go) — the owner's admitted chat channels
 * (`GET /api/repos/{o}/{r}/issues/sync/channels`, the rows
 * `PUT …/issues/sync/channels` wrote) and the owner's Linear integrations
 * (`GET /api/integrations/linear`, filtered to the repository). The rows ride
 * the existing connect card (`connect-embedded`), which the connect surface
 * already renders. A missing route is `unavailable`, never "not connected":
 * a server without Linear, or this host's proxy, which refuses every Linear
 * path until the Linear slice returns (#2116). A service without a backend
 * wears Coming soon and no action; a refused read wears the server's own
 * words. Reads run in the background under the shared toast. Admitting a
 * Slack channel (`integrations.admit`) PUTs the same route and settles only
 * once the readback lists the channel.
 */
import type { IntegrationRow } from "@smthrs/rpc/Threads"
import type { Card } from "../AppState"
import { TOAST_SUPERSEDED } from "../controller/failures"
import { resolveTargetRepo } from "../RepoContext"
import { captureCloudOwner, readErrorMessage, readResult, unreachableSentence } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

/** The ids one Slack admission carries; `external_user_id` is the optional Slack user the admission is for. */
export interface SlackAdmission {
  readonly connection_id: string
  readonly scope_id: string
  readonly conversation_id: string
  readonly external_user_id?: string | undefined
}

export interface IntegrationsSeam {
  readonly listIntegrations: (repo?: string) => Promise<string | void | { readonly value: string }>
  readonly admitSlackChannel: (admission: SlackAdmission, repo?: string) => Promise<string | void | { readonly value: string }>
}

const CONNECT_CARD_ID = "connect-embedded"
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
/** The backend's Slack id shapes (services/issue_sync.go `validate`): checked here so a mistyped id never leaves the app. */
const SLACK_ID = /^[A-Z][A-Z0-9]{2,31}$/
const SLACK_CHANNEL = /^[CDG][A-Z0-9]{2,31}$/
const asString = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined

export const createIntegrationsSeam = (ctx: SeamContext): IntegrationsSeam => {
  const repoPath = (repo: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    return `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  }

  /** The owner's Linear integrations are one list across repositories; the row is the one bound to this repository. */
  const linearRow = async (repo: string): Promise<IntegrationRow> => {
    let response: Response
    try { response = await ctx.http(`${ctx.baseUrl}/api/integrations/linear`) }
    catch (error) { return { id: "linear", state: "error", error: unreachableSentence("the Linear integrations", error) } }
    if (response.status === 404 || response.status === 405) return { id: "linear", state: "unavailable" }
    if (!response.ok) return { id: "linear", state: "error", error: await readErrorMessage(response, `Reading the Linear integrations failed (${response.status})`) }
    const body: unknown = await response.json().catch(() => null)
    const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.integrations) ? body.integrations : null
    if (rows === null) return { id: "linear", state: "error", error: "Smithers Cloud's answer for the Linear integrations was malformed" }
    const [owner = "", name = ""] = repo.toLowerCase().split("/")
    const integration = rows.find((row): row is Record<string, unknown> => isRecord(row) && asString(row.repo_owner)?.toLowerCase() === owner && asString(row.repo_name)?.toLowerCase() === name)
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

  /** The owner's admitted chat channels for the repository; the Slack ones are the row, in the conversation ids the admission recorded. */
  const slackRow = async (repo: string): Promise<IntegrationRow> => {
    let response: Response
    try { response = await ctx.http(`${repoPath(repo)}/issues/sync/channels`) }
    catch (error) { return { id: "slack", state: "error", error: unreachableSentence("the Slack channels", error) } }
    if (response.status === 404 || response.status === 405) return { id: "slack", state: "unavailable" }
    if (!response.ok) return { id: "slack", state: "error", error: await readErrorMessage(response, `Reading the Slack channels failed (${response.status})`) }
    const body: unknown = await response.json().catch(() => null)
    const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.channels) ? body.channels : null
    if (rows === null) return { id: "slack", state: "error", error: "Smithers Cloud's answer for the Slack channels was malformed" }
    const channels = rows.flatMap((row) => isRecord(row) && row.provider === "slack" ? [asString(row.conversation_id)] : []).filter((name): name is string => name !== undefined)
    return channels.length === 0 ? { id: "slack", state: "not-connected" } : { id: "slack", state: "connected", detail: channels.join(", ") }
  }

  const connectBase = (): Extract<Card, { kind: "connect" }> => {
    const existing = ctx.store.collections.cards.get(CONNECT_CARD_ID)
    return existing?.kind === "connect" ? existing : {
      id: CONNECT_CARD_ID, kind: "connect", title: "Connect work to Smithers", status: "active", createdAt: Date.now(), ordinal: ctx.nextOrdinal(),
      payload: { github: { connected: false, login: null }, nativeAvailable: false }
    }
  }
  const ensureCard = async (actor: ReturnType<SeamContext["actor"]>) => {
    if (ctx.store.collections.cards.get(CONNECT_CARD_ID)?.kind !== "connect") await ctx.dispatch({ type: "card.upsert", actor, card: connectBase() }).isPersisted.promise
  }
  /** Read both services into the connect card; undefined when the owner changed meanwhile. */
  const refresh = async (repo: string, current: () => boolean, actor: ReturnType<SeamContext["actor"]>) => {
    const [slack, linear] = await Promise.all([slackRow(repo), linearRow(repo)])
    if (!current()) return undefined
    const rows: Array<IntegrationRow> = [slack, linear]
    const card = connectBase()
    await ctx.dispatch({ type: "card.upsert", actor, card: { ...card, payload: { ...card.payload, integrations: { repo, rows } } } }).isPersisted.promise
    return rows
  }
  const summary = (rows: ReadonlyArray<IntegrationRow>) => readResult(rows.map((row) => `${row.id}: ${row.state}${row.detail === undefined ? "" : ` · ${row.detail}`}${row.error === undefined ? "" : ` · ${row.error}`}`).join("\n"))
  const admitting = new Set<string>()

  return {
    listIntegrations: async (explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const current = captureCloudOwner(ctx, false)
      const actor = ctx.actor()
      const work = async () => {
        const rows = await refresh(repo, current, actor)
        return rows === undefined ? TOAST_SUPERSEDED : summary(rows)
      }
      await ensureCard(actor)
      const result = ctx.withToast ? await ctx.withToast(`integrations.read:${repo}`, "Reading integrations", "Integrations", work, false, current, CONNECT_CARD_ID) : await work()
      if (result === TOAST_SUPERSEDED) return
      return result
    },

    /*
     * Admit one Slack channel: PUT the admission the authenticated route
     * validates (write access, cross-repository conflict), then read the
     * admitted channels back. The act settles only when the readback lists the
     * channel, so a refused or unseen write never renders a connection. A
     * repeat of a submit still in flight writes nothing.
     */
    admitSlackChannel: async (admission, explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const ids = {
        connection_id: admission.connection_id.trim(), scope_id: admission.scope_id.trim(), conversation_id: admission.conversation_id.trim(),
        external_user_id: (admission.external_user_id ?? "").trim()
      }
      if (ids.connection_id === "" || ids.connection_id.length > 128) return "Slack admission needs a connection id of at most 128 characters."
      if (!SLACK_ID.test(ids.scope_id)) return "Slack admission needs a workspace id such as T0123."
      if (!SLACK_CHANNEL.test(ids.conversation_id)) return "Slack admission needs a channel id such as C0123."
      if (ids.external_user_id !== "" && !SLACK_ID.test(ids.external_user_id)) return "Slack admission takes a user id such as U0123."
      const key = `${repo.toLowerCase()}\n${ids.connection_id}\n${ids.scope_id}\n${ids.conversation_id}\n${ids.external_user_id}`
      if (admitting.has(key)) return `Admitting ${ids.conversation_id} is already under way.`
      admitting.add(key)
      const current = captureCloudOwner(ctx, false)
      const actor = ctx.actor()
      const work = async () => {
        let response: Response
        try {
          response = await ctx.http(`${repoPath(repo)}/issues/sync/channels`, {
            method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "slack", ...ids })
          })
        } catch (error) { return unreachableSentence("the Slack channels", error) }
        if (!response.ok) return await readErrorMessage(response, `Admitting ${ids.conversation_id} failed (${response.status})`)
        const rows = await refresh(repo, current, actor)
        if (rows === undefined) return TOAST_SUPERSEDED
        const slack = rows.find((row) => row.id === "slack")
        if (slack?.state === "error") return slack.error ?? `Admitting ${ids.conversation_id} could not be confirmed.`
        if (slack?.detail?.split(", ").includes(ids.conversation_id) !== true) return `Slack channel ${ids.conversation_id} was not among the admitted channels afterwards.`
        return readResult(`Admitted ${ids.conversation_id} to ${repo}.`)
      }
      try {
        await ensureCard(actor)
        const result = ctx.withToast ? await ctx.withToast(`integrations.admit:${key}`, "Admitting Slack channel", "Integrations", work, false, current, CONNECT_CARD_ID) : await work()
        if (result === TOAST_SUPERSEDED) return
        return result
      } finally { admitting.delete(key) }
    }
  }
}
