import { preparedView, type ViewAction } from "../PreparedView"
/*
 * The secrets seam: the secrets a repository's sessions may use, read off the
 * agent-environment document (GET /api/repos/{owner}/{repo}/agent-environment,
 * EnvironmentSeam.ts). plue serves secret METADATA only: name, the egress
 * binding (hosts, match_headers) and the updated time. No value exists on the
 * wire, so none can reach a card, the journal or the model. A value the
 * person types reaches the seam only through the form's write-only gesture,
 * lives in one background closure until its PUT is sent, and is never
 * persisted, re-read or replayed: a reload settles an unfinished save as
 * failed and the person enters the value again.
 *
 * The same seam owns the account's coding-provider pool
 * (/api/user/provider-connections): Claude token enrollment, Codex device
 * sign-in, pool order and revocation, each acknowledged once its intent is
 * durable and finished in the shared toast stack, and the Accounts card.
 */
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { environmentUrl, readEnvironment, type EnvironmentConfig } from "./EnvironmentSeam"
import type { SeamContext } from "./SeamContext"
import { captureCloudOwner, readErrorMessage, readResult } from "./SeamContext"
import type { CommandGesture } from "../../flows/CommandGesture"
import type { FailureController } from "../controller/failures"
import { TOAST_SUPERSEDED } from "../controller/failures"

const CONNECTIONS = "/api/user/provider-connections"
const CONNECTION_ITEM = "/api/user/provider-connections/"
const CONNECTION_ORDER = "/api/user/provider-connections/order"
const CODEX_DEVICE = "/api/user/provider-connections/codex/device"
const ACCOUNTS_CARD = "provider-accounts"
const connectionId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value)
const deviceId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)
/* An Anthropic API key. A Claude subscription token is never accepted (#2777). */
const claudeToken = (value: string | undefined): value is string =>
  value !== undefined && value.startsWith("sk-ant-api") && !/\s/.test(value)
type Connection = { id: string; provider: string; state: string; label: string; email: string | null; limitedUntil: string | null; sortOrder: number }
const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null
const connections = (raw: unknown): Connection[] | undefined => Array.isArray(raw) && raw.every(row =>
  row && typeof row === "object" && connectionId(row.id) && typeof row.provider === "string" && typeof row.state === "string" && typeof row.label === "string")
  ? raw.map((row, index) => ({
    id: row.id, provider: row.provider, state: row.state, label: row.label, email: text(row.account_email),
    limitedUntil: text(row.limited_until), sortOrder: typeof row.sort_order === "number" ? row.sort_order : index
  })) : undefined
const PROVIDERS = ["claude", "codex"] as const
/*
 * plue answers every provider-connections route with the feature gate's 403
 * when the deployment does not store subscription logins (hosted smithers.sh;
 * self-hosters opt in with SMITHERS_FEATURE_FLAGS_SUBSCRIPTION_CONNECTIONS).
 */
const UNAVAILABLE = "Coding accounts are not available on this deployment."
const featureGated = async (response: Response): Promise<boolean> => {
  if (response.status !== 403) return false
  const body = await response.clone().json().catch(() => undefined) as { message?: unknown } | undefined
  return typeof body?.message === "string" && body.message.startsWith("feature not available")
}
type AccountsCard = Extract<Card, { kind: "provider-accounts" }>
type SecretsCard = Extract<Card, { kind: "secrets" }>
type Account = AccountsCard["payload"]["accounts"][number]
type PendingCode = NonNullable<AccountsCard["payload"]["pending"]>
/** One provider's live accounts in pool order. */
const pool = (rows: ReadonlyArray<Connection>, provider: string): Connection[] =>
  rows.filter(row => row.provider === provider && row.state !== "revoked")
    .map((row, index) => ({ row, index })).sort((a, b) => a.row.sortOrder - b.row.sortOrder || a.index - b.index).map(({ row }) => row)
const accountsOf = (rows: ReadonlyArray<Connection>): Account[] => PROVIDERS.flatMap(provider => pool(rows, provider).map(row => ({
  id: row.id, provider, label: row.label, email: row.email, state: row.state, limitedUntil: row.limitedUntil
})))
type Device = { id: string; state: string; userCode: string; verificationUri: string; interval: number; expiresAt: string }
const httpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false
  try { return new URL(value).protocol === "https:" } catch { return false }
}
const deviceOf = (raw: unknown): Device | undefined => {
  if (!raw || typeof raw !== "object") return undefined
  const row = raw as Record<string, unknown>
  if (!deviceId(row.id) || typeof row.state !== "string" || !["pending", "connected", "expired", "failed"].includes(row.state)) return undefined
  if (typeof row.user_code !== "string" || !httpsUrl(row.verification_uri) || typeof row.expires_at !== "string") return undefined
  const interval = typeof row.interval_seconds === "number" && Number.isFinite(row.interval_seconds) ? row.interval_seconds : 5
  return { id: row.id, state: row.state, userCode: row.user_code, verificationUri: row.verification_uri, interval, expiresAt: row.expires_at }
}

export interface SecretsSeam {
  readonly listSecrets: ViewAction<[repo?: string]>
  /** Mark a repository secret main-only (D-24), or give it to every run again. */
  readonly scopeSecret: (name: string, scope: "main-only" | "all", repo?: string) => Promise<{ readonly value: string } | string>
  /** Set or clear the hosts and headers a repository secret may be sent to (#3175); CI receives only bound secrets. */
  readonly bindSecret: (input: SecretInput) => Promise<{ readonly value: string } | string>
  readonly connectCodingProvider: (gesture?: CommandGesture) => Promise<{ readonly value: string } | string>
  readonly connectCodex: () => Promise<{ readonly value: string } | string>
  readonly listCodingProviders: () => Promise<{ readonly value: string } | string>
  readonly revokeCodingProvider: (id: string) => Promise<{ readonly value: string } | string>
  readonly moveCodingProvider: (id: string, direction: "up" | "down") => Promise<{ readonly value: string } | string>
  readonly resumeCodingProviders: () => void
  /** Add or rotate one repository secret; the value comes only from the gesture's write-only field. */
  readonly setSecret: (input: SecretInput, gesture?: CommandGesture) => Promise<{ readonly value: string } | string>
  readonly deleteSecret: (name: string, repo?: string) => Promise<{ readonly value: string } | string>
  /** Settle secret writes a reload interrupted: deletes replay, saves fail (their value is gone). */
  readonly resumeSecretRequests: () => void
}

export interface SecretInput {
  readonly name: string
  /** Comma- or space-separated; both blank keeps an existing secret's binding. */
  readonly hosts?: string
  readonly headers?: string
  readonly repo?: string
}

/* plue's agentEnvironmentNamePattern and header shape (packages/backend agent_environment.go). */
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/
const listOf = (value: string | undefined): string[] => (value ?? "").split(/[\s,]+/).filter(item => item !== "")

export interface SecretsSeamOptions {
  /** The wait between device-sign-in polls; tests hold or skip it. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

type Flight = { readonly current: () => boolean; readonly admitted: Promise<boolean> }
/*
 * In-flight work is shared by the user's and the agent's seam (ActorBindings
 * builds one of each over the same store), so a duplicate from either door
 * joins the running request instead of starting a second one.
 */
const shared = new WeakMap<object, {
  readonly inFlight: Map<string, Flight>; moves: Promise<unknown>; reads: number; applied: number
  readonly secretReads: Map<string, number>; readonly secretApplied: Map<string, number>
}>()
const sharedFor = (store: object) => {
  let state = shared.get(store)
  if (!state) shared.set(store, state = { inFlight: new Map(), moves: Promise.resolve(), reads: 0, applied: 0, secretReads: new Map(), secretApplied: new Map() })
  return state
}

export const createSecretsSeam = (ctx: SeamContext, withToast: FailureController["withToast"], options: SecretsSeamOptions = {}): SecretsSeam => {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const state = sharedFor(ctx.store)
  const inFlight = state.inFlight
  const flightAt = (key: string): Flight | undefined => {
    const flight = inFlight.get(key)
    return flight?.current() ? flight : undefined
  }
  const release = (key: string, flight: Flight): void => {
    if (inFlight.get(key) === flight) inFlight.delete(key)
  }
  const owner = () => ctx.store.collections.identitySessions.get("identity")?.login ?? null
  type Pending = NonNullable<ReturnType<typeof ctx.store.session>["codingProviderRequests"]>[number]
  const requests = (): Pending[] => ctx.store.session().codingProviderRequests ?? []
  const save = async (row: Pending, current: () => boolean, supersedes: (item: Pending) => boolean = () => false): Promise<boolean> => {
    if (!current()) return false
    await ctx.dispatch({ type: "coding.provider.requests.changed", actor: "system", requests: [...requests().filter(item => item.id !== row.id && !supersedes(item)), row].slice(-64) }).isPersisted.promise
    return current()
  }
  const active = (row: Connection): boolean => row.provider === "claude" && row.state === "active" && connectionId(row.id)
  const admit = (row: Pending, current: () => boolean, supersedes?: (item: Pending) => boolean): Flight => {
    const flight = { current, admitted: save(row, current, supersedes).catch(() => false) }
    inFlight.set(row.id, flight)
    return flight
  }
  const acknowledgment = async (flight: Flight): Promise<{ readonly value: string } | string> =>
    await flight.admitted && flight.current() ? { value: "Requested" } : "Connection request could not be saved."
  const fail = async (row: Pending, current: () => boolean, message: string) =>
    await save({ ...row, state: "failed" }, current) ? message : TOAST_SUPERSEDED
  const report = (outcome: unknown, current: () => boolean): void => {
    if (current() && typeof outcome === "string") ctx.dispatch({ type: "message.appended", actor: "system", text: outcome })
  }
  /*
   * The Accounts card: one per app, re-surfaced at the end of the transcript
   * when listed or when a Codex sign-in needs the person, and updated in place
   * after any other change. `pending` undefined keeps the card's own code.
   */
  const accountsCard = (): AccountsCard | undefined => {
    const card = ctx.store.collections.cards?.get(ACCOUNTS_CARD)
    return card?.kind === "provider-accounts" ? card : undefined
  }
  /** Mark the Accounts card unavailable; its connect buttons disappear. */
  const withdraw = (surface: boolean): void => {
    const previous = accountsCard()
    if (!previous && !surface) return
    ctx.dispatch({ type: "card.upsert", actor: "system", card: {
      ...previous,
      id: ACCOUNTS_CARD, kind: "provider-accounts", title: "Accounts", status: "active", loading: false,
      createdAt: previous?.createdAt ?? Date.now(),
      ordinal: surface || !previous ? ctx.nextOrdinal() : previous.ordinal,
      payload: { accounts: [], unavailable: true }
    } })
  }
  /** A gated answer fails the request with the plain message and withdraws the card. */
  const gatedFailure = async (row: Pending, current: () => boolean) => {
    if (!current()) return TOAST_SUPERSEDED
    withdraw(false)
    return await fail(row, current, UNAVAILABLE)
  }
  const publish = (rows: ReadonlyArray<Connection> | undefined, pending: PendingCode | null | undefined, surface: boolean): void => {
    const previous = accountsCard()
    if (!previous && !surface) return
    const code = pending === undefined ? previous?.payload.pending : pending ?? undefined
    const card: AccountsCard = {
      ...previous,
      id: ACCOUNTS_CARD, kind: "provider-accounts", title: "Accounts", status: "active", loading: false,
      createdAt: previous?.createdAt ?? Date.now(),
      ordinal: surface || !previous ? ctx.nextOrdinal() : previous.ordinal,
      payload: {
        accounts: rows ? withPendingOrders(accountsOf(rows)) : previous?.payload.accounts ?? [],
        ...(!rows && previous?.payload.unavailable ? { unavailable: true } : {}),
        ...(code ? { pending: code } : {})
      }
    }
    ctx.dispatch({ type: "card.upsert", actor: "system", card })
  }
  /*
   * A provider whose order request is still pending keeps the order applied
   * locally: a read taken before the write lands would otherwise revert it,
   * and the next move would compute from the reverted order.
   */
  const withPendingOrders = (accounts: Account[]): Account[] => {
    const login = owner()
    const orders = requests().filter(row => row.owner === login && row.action === "order" && row.state === "requested" && row.provider && row.ids)
    if (orders.length === 0) return accounts
    return PROVIDERS.flatMap(provider => {
      const rows = accounts.filter(account => account.provider === provider)
      const ids = orders.filter(row => row.provider === provider).at(-1)?.ids
      if (!ids) return rows
      const rank = (id: string) => { const index = ids.indexOf(id); return index < 0 ? ids.length : index }
      return rows.map((account, index) => ({ account, index })).sort((a, b) => rank(a.account.id) - rank(b.account.id) || a.index - b.index).map(({ account }) => account)
    })
  }
  /** Reads are numbered; an answer older than one already applied is dropped. */
  const readPool = async (): Promise<{ readonly response: Response; readonly rows: Connection[] | undefined; readonly fresh: () => boolean }> => {
    const seq = ++state.reads
    const response = await ctx.http(`${ctx.baseUrl}${CONNECTIONS}`)
    const rows = response.ok ? connections(await response.json().catch(() => undefined)) : undefined
    return { response, rows, fresh: () => {
      if (seq < state.applied) return false
      state.applied = seq
      return true
    } }
  }
  /** Re-read the pool into the card; a failed read keeps the rows the card had. */
  const refresh = async (current: () => boolean): Promise<void> => {
    if (!accountsCard()) return
    try {
      const read = await readPool()
      if (!current()) return
      const gated = await featureGated(read.response)
      if (!current()) return
      if (gated) {
        if (read.fresh()) withdraw(false)
      } else if (read.rows && read.fresh()) publish(read.rows, undefined, false)
    } catch { /* A failed refresh leaves the last authoritative card intact. */ }
  }
  /*
   * Poll one Codex device sign-in at the server's interval until it settles.
   * The server answers `pending` to an early poll, so a transient refusal
   * (429, 5xx) waits for the next interval rather than failing the sign-in.
   */
  const poll = async (row: Pending, device: NonNullable<Pending["device"]>, current: () => boolean): Promise<true | string | typeof TOAST_SUPERSEDED> => {
    const deadline = Date.parse(device.expiresAt)
    const settle = async (state: "completed" | "failed", outcome: true | string) => {
      if (!await save({ ...row, device, state }, current)) return TOAST_SUPERSEDED
      publish(undefined, null, false)
      void refresh(current)
      return outcome
    }
    for (;;) {
      if (!Number.isNaN(deadline) && now() > deadline + 60_000) return settle("failed", "Codex sign-in expired. Retry.")
      await sleep(Math.min(Math.max(device.interval, 1), 60) * 1000)
      if (!current()) return TOAST_SUPERSEDED
      const response = await ctx.http(`${ctx.baseUrl}${CODEX_DEVICE}/${device.id}`, { method: "POST" })
      if (!current()) return TOAST_SUPERSEDED
      if (response.status === 429 || response.status >= 500) continue
      if (!response.ok) return settle("failed", `Codex sign-in failed (HTTP ${response.status}).`)
      const answer = deviceOf(await response.json().catch(() => undefined))
      if (!current()) return TOAST_SUPERSEDED
      if (!answer || answer.id !== device.id) return settle("failed", "Codex sign-in failed.")
      if (answer.state === "pending") continue
      if (answer.state === "connected") return settle("completed", true)
      return settle("failed", answer.state === "expired" ? "Codex sign-in expired. Retry." : "Codex sign-in failed.")
    }
  }
  /*
   * Write one persisted order. Writes run one at a time in the order they were
   * asked for, and each carries the provider's whole order, so a replay after
   * a reload lands the same result.
   */
  const sendOrder = (row: Pending, current: () => boolean): Promise<true | string | typeof TOAST_SUPERSEDED> => {
    const work = state.moves.then(async (): Promise<true | string | typeof TOAST_SUPERSEDED> => {
      if (!current()) return TOAST_SUPERSEDED
      if (!row.provider || !row.ids?.every(connectionId)) return await fail(row, current, "Invalid connection.")
      const put = await ctx.http(`${ctx.baseUrl}${CONNECTION_ORDER}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: row.provider, ids: row.ids })
      })
      if (!current()) return TOAST_SUPERSEDED
      if (put.status !== 204) {
        const outcome = await fail(row, current, `Connection move failed (HTTP ${put.status}).`)
        void refresh(current)
        return outcome
      }
      if (!await save({ ...row, state: "completed" }, current)) return TOAST_SUPERSEDED
      void refresh(current)
      return true
    })
    state.moves = work.catch(() => undefined)
    return work
  }
  const resumeCodingProviders: SecretsSeam["resumeCodingProviders"] = () => {
    const login = owner()
    if (!login) return
    for (const row of requests().filter(item => item.owner === login && item.state === "requested" && !flightAt(item.id))) {
      const current = captureCloudOwner(ctx, false)
      const flight = admit(row, current)
      if (row.action === "codex") {
        void withToast(`coding-provider-codex:${login}`, "Connecting Codex…", "Codex connected", async () => {
          try {
            if (!await flight.admitted || !current()) return TOAST_SUPERSEDED
            if (!row.device) return await fail(row, current, "Codex sign-in interrupted. Retry.")
            publish(undefined, { userCode: row.device.userCode, verificationUri: row.device.verificationUri }, !accountsCard())
            return await poll(row, row.device, current)
          } catch { return current() ? "Codex sign-in failed." : TOAST_SUPERSEDED }
          finally { release(row.id, flight) }
        }, false, current).then(outcome => report(outcome, current))
        continue
      }
      if (row.action === "order") {
        void withToast(`coding-provider-move:${login}`, "Moving connection…", "Connection moved", async () => {
          try {
            if (!await flight.admitted || !current()) return TOAST_SUPERSEDED
            return await sendOrder(row, current)
          } catch { return current() ? "Connection move failed." : TOAST_SUPERSEDED }
          finally { release(row.id, flight) }
        }, false, current).then(outcome => report(outcome, current))
        continue
      }
      void withToast(`coding-provider-${row.action === "revoke" ? "revoke" : "connect"}:${row.id}`, "Checking connection…", "Connection updated", async () => {
        try {
          if (!await flight.admitted || !current()) return TOAST_SUPERSEDED
          const response = await ctx.http(`${ctx.baseUrl}${CONNECTIONS}`)
          if (!current()) return TOAST_SUPERSEDED
          const rows = response.ok ? connections(await response.json().catch(() => undefined)) : undefined
          if (!current()) return TOAST_SUPERSEDED
          if (!rows) return "Connection check failed. Retry the check."
          if (row.action === "revoke") {
            if (!row.connectionId || !connectionId(row.connectionId)) return "Invalid connection."
            const match = rows.find(item => item.id === row.connectionId)
            if (!match || match.state === "revoked") return await save({ ...row, state: "completed" }, current) ? true : TOAST_SUPERSEDED
            if (match.state !== "active") return "Connection revocation needs a retry."
            const deleted = await ctx.http(`${ctx.baseUrl}${CONNECTION_ITEM}${row.connectionId}`, { method: "DELETE" })
            if (!current()) return TOAST_SUPERSEDED
            if (deleted.status !== 204) return `Connection revocation failed (HTTP ${deleted.status}).`
            return await save({ ...row, state: "completed" }, current) ? true : TOAST_SUPERSEDED
          }
          const match = rows.find(item => item.label === `web-${row.id}`)
          if (match && active(match)) return await save({ ...row, state: "completed" }, current) ? true : TOAST_SUPERSEDED
          if (match) { await save({ ...row, state: "failed" }, current); return "Claude connection is inactive. Retry with a fresh token." }
          await save({ ...row, state: "failed" }, current)
          return "Claude connection interrupted. Retry with a fresh token."
        } catch { return current() ? "Connection check failed. Retry the check." : TOAST_SUPERSEDED }
        finally { release(row.id, flight) }
      }, false, current).then(outcome => report(outcome, current))
    }
  }
  const connectCodingProvider: SecretsSeam["connectCodingProvider"] = async gesture => {
    const login = owner()
    const current = captureCloudOwner(ctx, false)
    const value = gesture?.takeWriteOnly?.("value")
    gesture?.release()
    if (!login) return "Sign in to connect Claude."
    const flightKey = `connect:${login}`
    const previous = flightAt(flightKey)
    if (previous) return acknowledgment(previous)
    const pending = requests().find(row => row.owner === login && (row.action ?? "connect") === "connect" && row.state === "requested")
    if (pending) {
      resumeCodingProviders()
      const flight = flightAt(pending.id)
      return flight ? acknowledgment(flight) : "Connection check failed."
    }
    if (!claudeToken(value)) return "Enter an Anthropic API key."
    const row: Pending = { id: crypto.randomUUID(), owner: login, action: "connect", state: "requested" }
    const flight = admit(row, current)
    inFlight.set(flightKey, flight)
    let body: string | undefined = JSON.stringify({ provider: "claude", label: `web-${row.id}`, access_token: value })
    const receipt = await acknowledgment(flight)
    if (typeof receipt === "string") {
      body = undefined
      release(flightKey, flight)
      release(row.id, flight)
      return receipt
    }
    void withToast(`coding-provider-connect:${login}`, "Connecting Claude…", "Claude connected", async () => {
      try {
        const sending = body
        body = undefined
        if (!current()) return TOAST_SUPERSEDED
        const response = await ctx.http(`${ctx.baseUrl}${CONNECTIONS}`, { method: "POST", headers: { "content-type": "application/json" }, body: sending })
        if (!current()) return TOAST_SUPERSEDED
        if (await featureGated(response)) return await gatedFailure(row, current)
        if (!response.ok) return await fail(row, current, `Claude connection failed (HTTP ${response.status}).`)
        // User-owned repositories resolve their owner's connection without a grant.
        // Organization repositories require an explicit grant through their own scope door.
        const result = await response.json().catch(() => undefined) as Connection | undefined
        if (!current()) return TOAST_SUPERSEDED
        if (!result || !active(result) || result.label !== `web-${row.id}`) return await fail(row, current, "Claude connection failed.")
        if (!await save({ ...row, state: "completed" }, current)) return TOAST_SUPERSEDED
        void refresh(current)
        return true
      } catch { return current() ? "Claude connection failed." : TOAST_SUPERSEDED }
      finally { release(flightKey, flight); release(row.id, flight); body = undefined }
    }, false, current).then(outcome => report(outcome, current))
    return receipt
  }
  const connectCodex: SecretsSeam["connectCodex"] = async () => {
    const login = owner()
    const current = captureCloudOwner(ctx, false)
    if (!login) return "Sign in to connect Codex."
    const flightKey = `codex:${login}`
    const previous = flightAt(flightKey)
    if (previous) return acknowledgment(previous)
    const pending = requests().find(row => row.owner === login && row.action === "codex" && row.state === "requested")
    if (pending) {
      resumeCodingProviders()
      const flight = flightAt(pending.id)
      return flight ? acknowledgment(flight) : "Connection check failed."
    }
    const row: Pending = { id: crypto.randomUUID(), owner: login, action: "codex", state: "requested" }
    const flight = admit(row, current)
    inFlight.set(flightKey, flight)
    const receipt = await acknowledgment(flight)
    if (typeof receipt === "string") {
      release(flightKey, flight)
      release(row.id, flight)
      return receipt
    }
    void withToast(`coding-provider-codex:${login}`, "Connecting Codex…", "Codex connected", async () => {
      try {
        if (!current()) return TOAST_SUPERSEDED
        const response = await ctx.http(`${ctx.baseUrl}${CODEX_DEVICE}`, { method: "POST" })
        if (!current()) return TOAST_SUPERSEDED
        if (await featureGated(response)) return await gatedFailure(row, current)
        if (!response.ok) return await fail(row, current, `Codex sign-in failed (HTTP ${response.status}).`)
        const answer = deviceOf(await response.json().catch(() => undefined))
        if (!current()) return TOAST_SUPERSEDED
        if (!answer || answer.state !== "pending") return await fail(row, current, "Codex sign-in failed.")
        const device = { id: answer.id, userCode: answer.userCode, verificationUri: answer.verificationUri, interval: answer.interval, expiresAt: answer.expiresAt }
        if (!await save({ ...row, device }, current)) return TOAST_SUPERSEDED
        publish(undefined, { userCode: device.userCode, verificationUri: device.verificationUri }, true)
        void refresh(current)
        return await poll(row, device, current)
      } catch { return current() ? "Codex sign-in failed." : TOAST_SUPERSEDED }
      finally { release(flightKey, flight); release(row.id, flight) }
    }, false, current).then(outcome => report(outcome, current))
    return receipt
  }
  /*
   * Move one account a place within its provider's pool. The new order is
   * computed from the Accounts card the person is looking at, applied to the
   * card at once (so a second press moves from there), and persisted as the
   * provider's whole order before the answer; the write runs in the background.
   */
  const moveCodingProvider: SecretsSeam["moveCodingProvider"] = async (id, direction) => {
    const login = owner()
    const current = captureCloudOwner(ctx, false)
    if (!login) return "Sign in to reorder coding connections."
    if (!connectionId(id)) return "Invalid connection."
    if (direction !== "up" && direction !== "down") return "Choose up or down."
    const card = accountsCard()
    if (!card) return "Show coding accounts first."
    const target = card.payload.accounts.find(account => account.id === id)
    if (!target) return "Connection not found."
    const peers = card.payload.accounts.filter(account => account.provider === target.provider)
    const from = peers.indexOf(target)
    const to = direction === "up" ? from - 1 : from + 1
    if (to < 0 || to >= peers.length) return { value: "Already in place." }
    const moved = [...peers]
    moved.splice(from, 1)
    moved.splice(to, 0, target)
    const row: Pending = { id: crypto.randomUUID(), owner: login, action: "order", provider: target.provider, ids: moved.map(account => account.id), state: "requested" }
    // The card takes the new order before any await, so a second press computes from it.
    ctx.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...card.payload,
      accounts: PROVIDERS.flatMap(provider => provider === target.provider ? moved : card.payload.accounts.filter(account => account.provider === provider)) } } })
    const flight = admit(row, current, item => item.owner === login && item.action === "order" && item.provider === target.provider && item.state === "requested")
    const receipt = await acknowledgment(flight)
    if (typeof receipt === "string") { release(row.id, flight); void refresh(current); return receipt }
    void withToast(`coding-provider-move:${login}`, "Moving connection…", "Connection moved", async () => {
      try { return await sendOrder(row, current) }
      catch { return current() ? "Connection move failed." : TOAST_SUPERSEDED }
      finally { release(row.id, flight) }
    }, false, current).then(outcome => report(outcome, current))
    return receipt
  }
  const listCodingProviders: SecretsSeam["listCodingProviders"] = async () => {
    const login = owner()
    const current = captureCloudOwner(ctx, false)
    if (!login) return "Sign in to list coding connections."
    try {
      const { response, rows, fresh } = await readPool()
      if (!current()) return "Account changed."
      const gated = await featureGated(response)
      if (!current()) return "Account changed."
      // Feature-gate replies participate in the same ordering as pool reads.
      if (gated) {
        if (!fresh()) return readResult("")
        withdraw(true)
        return UNAVAILABLE
      }
      if (!response.ok) return `Coding connections unavailable (HTTP ${response.status}).`
      if (!rows) return "Coding connections unavailable."
      if (!fresh()) return readResult("")
      publish(rows, undefined, true)
      const live = accountsOf(rows)
      return readResult(live.length ? live.map(row =>
        [row.id, row.provider, row.email ?? row.label, row.state, ...(row.limitedUntil ? [`limited until ${row.limitedUntil}`] : [])].join(" · ")).join("\n") : "No coding connections.")
    } catch { return "Coding connections unavailable." }
  }
  const revokeCodingProvider: SecretsSeam["revokeCodingProvider"] = async id => {
    const login = owner()
    const current = captureCloudOwner(ctx, false)
    if (!login) return "Sign in to revoke a coding connection."
    if (!connectionId(id)) return "Invalid connection."
    const flightKey = `revoke:${login}:${id}`
    const previous = flightAt(flightKey)
    if (previous) return acknowledgment(previous)
    const pending = requests().find(row => row.owner === login && row.action === "revoke" && row.connectionId === id && row.state === "requested")
    if (pending) {
      resumeCodingProviders()
      const flight = flightAt(pending.id)
      return flight ? acknowledgment(flight) : "Connection check failed."
    }
    const row: Pending = { id: crypto.randomUUID(), owner: login, action: "revoke", connectionId: id, state: "requested" }
    const flight = admit(row, current)
    inFlight.set(flightKey, flight)
    const receipt = await acknowledgment(flight)
    if (typeof receipt === "string") {
      release(flightKey, flight)
      release(row.id, flight)
      return receipt
    }
    void withToast(`coding-provider-revoke:${id}`, "Revoking connection…", "Connection revoked", async () => {
      try {
        if (!current()) return TOAST_SUPERSEDED
        const response = await ctx.http(`${ctx.baseUrl}${CONNECTION_ITEM}${id}`, { method: "DELETE" })
        if (!current()) return TOAST_SUPERSEDED
        if (response.status !== 204) return await fail(row, current, `Connection revocation failed (HTTP ${response.status}).`)
        if (!await save({ ...row, state: "completed" }, current)) return TOAST_SUPERSEDED
        void refresh(current)
        return true
      } catch { return current() ? "Connection revocation failed." : TOAST_SUPERSEDED }
      finally { release(flightKey, flight); release(row.id, flight) }
    }, false, current).then(outcome => report(outcome, current))
    return receipt
  }
  /** One repository's secrets card from the platform's metadata answer. */
  const secretsCard = (repo: string, config: EnvironmentConfig, ordinal: number): SecretsCard => ({
    id: `secrets-${repo}`,
    kind: "secrets",
    title: `Secrets · ${repo}`,
    status: "active",
    createdAt: Date.now(),
    ordinal,
    payload: {
      repo,
      scope: "repository",
      secrets: config.secrets.map((secret) => ({
        name: secret.name,
        hosts: [...secret.hosts],
        matchHeaders: [...secret.matchHeaders],
        updatedAt: secret.updatedAt,
        ...(secret.reconnect ? { reconnect: true } : {})
      }))
    }
  })
  /* Card reads (lists and refreshes) are numbered per repository; an answer older than one already applied is dropped. */
  const secretRead = (repo: string): number => {
    const seq = (state.secretReads.get(repo) ?? 0) + 1
    state.secretReads.set(repo, seq)
    return seq
  }
  const secretFresh = (repo: string, seq: number): boolean => {
    if (seq < (state.secretApplied.get(repo) ?? 0)) return false
    state.secretApplied.set(repo, seq)
    return true
  }
  /** Re-read an open secrets card in place after a write; a failed read keeps the rows it had. */
  const refreshSecrets = async (repo: string, current: () => boolean): Promise<void> => {
    if (ctx.store.collections.cards?.get(`secrets-${repo}`)?.kind !== "secrets") return
    const seq = secretRead(repo)
    const config = await readEnvironment(ctx, repo).catch(() => "unread")
    if (!current() || typeof config === "string" || !secretFresh(repo, seq)) return
    const previous = ctx.store.collections.cards?.get(`secrets-${repo}`)
    if (previous?.kind !== "secrets") return
    ctx.dispatch({ type: "card.upsert", actor: "system", card: { ...secretsCard(repo, config, previous.ordinal), createdAt: previous.createdAt } })
  }

  type SecretRequest = NonNullable<ReturnType<typeof ctx.store.session>["secretRequests"]>[number]
  const secretRequests = (): SecretRequest[] => ctx.store.session().secretRequests ?? []
  const saveSecretRequest = async (row: SecretRequest, current: () => boolean): Promise<boolean> => {
    if (!current()) return false
    await ctx.dispatch({ type: "secret.requests.changed", actor: "system", requests: [...secretRequests().filter(item => item.id !== row.id), row].slice(-64) }).isPersisted.promise
    return current()
  }
  const secretKey = (row: Pick<SecretRequest, "owner" | "repo" | "name">) => `secret:${row.owner}:${row.repo}:${row.name}`
  const secretPath = (repo: string, name: string) => `${environmentUrl(ctx, repo)}/secrets/${encodeURIComponent(name)}`
  /** Admit one secret write: durable before the acknowledgment, one per name at a time. */
  const admitSecret = async (row: SecretRequest, current: () => boolean): Promise<{ readonly flight: Flight } | string> => {
    const key = secretKey(row)
    if (flightAt(key) || secretRequests().some(item => item.state === "requested" && secretKey(item) === key)) return `${row.name} is already being changed.`
    const flight: Flight = { current, admitted: saveSecretRequest(row, current).catch(() => false) }
    inFlight.set(key, flight)
    if (await flight.admitted && current()) return { flight }
    release(key, flight)
    return "The request could not be saved."
  }
  /** Send one DELETE; a secret already gone is removed. */
  const sendDelete = async (row: SecretRequest, current: () => boolean): Promise<true | string | typeof TOAST_SUPERSEDED> => {
    const response = await ctx.http(secretPath(row.repo, row.name), { method: "DELETE" })
    if (!current()) return TOAST_SUPERSEDED
    if (response.status !== 204 && response.status !== 404) {
      const message = await readErrorMessage(response, `${row.name} couldn't be deleted (HTTP ${response.status}).`)
      return await saveSecretRequest({ ...row, state: "failed" }, current) ? message : TOAST_SUPERSEDED
    }
    if (!await saveSecretRequest({ ...row, state: "completed" }, current)) return TOAST_SUPERSEDED
    void refreshSecrets(row.repo, current)
    return true
  }
  const runSecret = (row: SecretRequest, flight: Flight, work: () => Promise<true | string | typeof TOAST_SUPERSEDED>): void => {
    const verb = row.action === "set" ? ["Saving", "saved"] : ["Deleting", "deleted"]
    void withToast(secretKey(row), `${verb[0]} ${row.name}…`, `${row.name} ${verb[1]}`, async () => {
      try { return await work() }
      catch {
        if (!flight.current()) return TOAST_SUPERSEDED
        await saveSecretRequest({ ...row, state: "failed" }, flight.current).catch(() => false)
        return `${row.name} couldn't be ${verb[1]}.`
      } finally { release(secretKey(row), flight) }
    }, false, flight.current).then(outcome => report(outcome, flight.current))
  }
  const setSecret: SecretsSeam["setSecret"] = async (input, gesture) => {
    let value = gesture?.takeWriteOnly?.("value")
    gesture?.release()
    try {
      const login = owner()
      const current = captureCloudOwner(ctx, false)
      if (!login) return "Sign in to save a secret."
      const target = resolveTargetRepo(ctx.store, input.repo)
      if ("error" in target) return target.error
      const name = input.name.trim()
      if (!SECRET_NAME.test(name)) return "Use letters, digits and _ for the name."
      if (!value) return "Enter the value."
      const hosts = listOf(input.hosts)
      const headers = listOf(input.headers)
      if ((hosts.length === 0) !== (headers.length === 0)) return "Give both hosts and headers, or neither."
      const row: SecretRequest = { id: crypto.randomUUID(), owner: login, repo: target.repo, name, action: "set", state: "requested" }
      const admitted = await admitSecret(row, current)
      if (typeof admitted === "string") return admitted
      let sending: string | undefined = value
      value = undefined
      runSecret(row, admitted.flight, async () => {
        try {
          if (!current()) return TOAST_SUPERSEDED
          // Rotation keeps the stored binding: an omitted binding would unbind it.
          let binding = { hosts, match_headers: headers }
          if (hosts.length === 0) {
            const config = await readEnvironment(ctx, row.repo)
            if (!current()) return TOAST_SUPERSEDED
            if (typeof config === "string") return await saveSecretRequest({ ...row, state: "failed" }, current) ? config : TOAST_SUPERSEDED
            const existing = config.secrets.find(secret => secret.name === name)
            binding = { hosts: [...existing?.hosts ?? []], match_headers: [...existing?.matchHeaders ?? []] }
          }
          const body = JSON.stringify({ value: sending, ...binding })
          sending = undefined
          const response = await ctx.http(secretPath(row.repo, name), { method: "PUT", headers: { "content-type": "application/json" }, body })
          if (!current()) return TOAST_SUPERSEDED
          if (!response.ok) {
            const message = await readErrorMessage(response, `${name} couldn't be saved (HTTP ${response.status}).`)
            return await saveSecretRequest({ ...row, state: "failed" }, current) ? message : TOAST_SUPERSEDED
          }
          // The answer is metadata only; nothing of it is kept but the receipt.
          await response.body?.cancel()
          if (!await saveSecretRequest({ ...row, state: "completed" }, current)) return TOAST_SUPERSEDED
          void refreshSecrets(row.repo, current)
          return true
        } finally { sending = undefined }
      })
      return { value: "Requested" }
    } finally { value = undefined }
  }
  const deleteSecret: SecretsSeam["deleteSecret"] = async (input, repo) => {
    const login = owner()
    const current = captureCloudOwner(ctx, false)
    if (!login) return "Sign in to delete a secret."
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const name = input.trim()
    if (!SECRET_NAME.test(name)) return "Use letters, digits and _ for the name."
    const row: SecretRequest = { id: crypto.randomUUID(), owner: login, repo: target.repo, name, action: "delete", state: "requested" }
    const admitted = await admitSecret(row, current)
    if (typeof admitted === "string") return admitted
    runSecret(row, admitted.flight, () => current() ? sendDelete(row, current) : Promise.resolve(TOAST_SUPERSEDED))
    return { value: "Requested" }
  }
  const resumeSecretRequests: SecretsSeam["resumeSecretRequests"] = () => {
    const login = owner()
    if (!login) return
    for (const row of secretRequests().filter(item => item.owner === login && item.state === "requested" && !flightAt(secretKey(item)))) {
      const current = captureCloudOwner(ctx, false)
      const flight: Flight = { current, admitted: Promise.resolve(true) }
      inFlight.set(secretKey(row), flight)
      runSecret(row, flight, async () => {
        if (!current()) return TOAST_SUPERSEDED
        if (row.action === "delete") return sendDelete(row, current)
        // The value was never persisted, so an interrupted save is not replayed.
        return await saveSecretRequest({ ...row, state: "failed" }, current) ? `Saving ${row.name} was interrupted. Enter it again.` : TOAST_SUPERSEDED
      })
    }
  }

  /*
   * One secrets card per repository, re-surfaced at the end of the transcript
   * on every list. Leaving it at its old ordinal would answer the command with
   * a silent no-op.
   */
  const listSecrets = preparedView(ctx, (repo?: string) => {
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    return { id: `secrets-${target.repo}`, title: `Secrets · ${target.repo}`, read: async () => {
    const seq = secretRead(target.repo)
    const config = await readEnvironment(ctx, target.repo)
    if (typeof config === "string") return config
    // A list is the person's newest read: it applies, and any earlier refresh still in flight is dropped.
    state.secretApplied.set(target.repo, Math.max(seq, state.secretApplied.get(target.repo) ?? 0))
    const card = secretsCard(target.repo, config, ctx.nextOrdinal())
    return { card, ...readResult(card.payload.secrets.length === 0
      ? `No secrets in ${card.payload.repo}.`
      : [
        `Secrets · ${card.payload.repo}`,
        ...card.payload.secrets.map((secret) =>
          `${secret.name} · hosts: ${secret.hosts.join(", ") || "none"} · headers: ${secret.matchHeaders.join(", ") || "none"} · updated: ${secret.updatedAt ?? "unknown"}`)
      ].join("\n")) }
    } }
  })

  /*
   * A main-only repository secret reaches only trusted runs on the default
   * bookmark. The platform answers with the stored mark, which the reply names.
   */
  const scopeSecret: SecretsSeam["scopeSecret"] = async (name, scope, repo) => {
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const [owner = "", repoName = ""] = target.repo.split("/")
    let response: Response
    try {
      response = await ctx.http(
        `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/secrets/${encodeURIComponent(name)}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ main_only: scope === "main-only" }) }
      )
    } catch {
      return `${name} couldn't be changed in ${target.repo} — the platform didn't answer.`
    }
    if (!response.ok) return readErrorMessage(response, `${name} couldn't be changed in ${target.repo} (HTTP ${response.status}).`)
    const stored = await response.json().catch(() => undefined) as { main_only?: unknown } | undefined
    return { value: `${name}: ${stored?.main_only === true ? "main only" : "every run"}` }
  }

  /*
   * A repository secret's egress binding, without its value. Both lists empty
   * unbind it. The reply names the stored binding.
   */
  const bindSecret: SecretsSeam["bindSecret"] = async (input) => {
    const target = resolveTargetRepo(ctx.store, input.repo)
    if ("error" in target) return target.error
    const name = input.name.trim()
    if (!SECRET_NAME.test(name)) return "Use letters, digits and _ for the name."
    const hosts = listOf(input.hosts)
    const headers = listOf(input.headers)
    if ((hosts.length === 0) !== (headers.length === 0)) return "Give both hosts and headers, or neither."
    const [owner = "", repoName = ""] = target.repo.split("/")
    let response: Response
    try {
      response = await ctx.http(
        `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/secrets/${encodeURIComponent(name)}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ hosts, match_headers: headers }) }
      )
    } catch {
      return `${name} couldn't be changed in ${target.repo} — the platform didn't answer.`
    }
    if (!response.ok) return readErrorMessage(response, `${name} couldn't be changed in ${target.repo} (HTTP ${response.status}).`)
    const stored = await response.json().catch(() => undefined) as { hosts?: unknown } | undefined
    const bound = Array.isArray(stored?.hosts) ? stored.hosts.filter((host): host is string => typeof host === "string") : []
    return { value: bound.length === 0 ? `${name}: unbound` : `${name}: ${bound.join(", ")}` }
  }

  return {
    listSecrets, scopeSecret, bindSecret, connectCodingProvider, connectCodex, listCodingProviders, revokeCodingProvider, moveCodingProvider, resumeCodingProviders,
    setSecret, deleteSecret, resumeSecretRequests
  }
}
