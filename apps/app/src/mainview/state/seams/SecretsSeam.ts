import { SecretsCardSchema } from "@smthrs/rpc/SecretsCard"
import type { LiveChannel } from "../../runtime/LiveChannel"
import { preparedView, type ViewAction } from "../PreparedView"
/*
 * The secrets seam: a repository's CI secrets (/api/repos/{owner}/{repo}/secrets,
 * RepositorySecrets.ts), one store for the card and for list, set, delete,
 * scope and bind. plue serves secret METADATA only: name, the main-only mark,
 * the egress binding (hosts, match_headers) and the updated time. No value exists on the
 * wire, so none can reach a card, the journal or the model. A value the
 * person types reaches the seam only through the form's write-only gesture,
 * lives in one background closure until its PUT is sent, and is never
 * persisted, re-read or replayed: a reload settles an unfinished save as
 * failed and the person enters the value again.
 *
 */
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { readRepositorySecrets, repositorySecretsUrl, type RepositorySecret } from "./RepositorySecrets"
import type { SeamContext } from "./SeamContext"
import { captureCloudOwner, readErrorMessage, readResult } from "./SeamContext"
import type { CommandGesture } from "../../flows/CommandGesture"
import type { FailureController } from "../controller/failures"
import { TOAST_SUPERSEDED } from "../controller/failures"
import { randomUuid } from "../../runtime/RandomUuid"

type SecretsCard = Extract<Card, { kind: "secrets" }>

export interface SecretsSeam {
  readonly listSecrets: ViewAction<[repo?: string]>
  /** Mark a repository secret main-only (D-24), or give it to every run again. */
  readonly scopeSecret: (name: string, scope: "main-only" | "all", repo?: string) => Promise<{ readonly value: string } | string>
  /** Set the hosts and headers a repository secret may be sent to (#3175); CI receives only bound secrets. */
  readonly bindSecret: (input: SecretInput) => Promise<{ readonly value: string } | string>
  /** Add or rotate one repository secret; the value comes only from the gesture's write-only field. */
  readonly setSecret: (input: SecretInput, gesture?: CommandGesture) => Promise<{ readonly value: string } | string>
  readonly deleteSecret: (name: string, repo?: string) => Promise<{ readonly value: string } | string>
  /** Settle secret writes a reload interrupted: deletes replay, saves fail (their value is gone). */
  readonly resumeSecretRequests: () => void
}

export interface SecretInput {
  readonly scope?: "all_branches" | "main_only"
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
  readonly fallback?: {
    rows: () => ReadonlyArray<RepositorySecret>
    set: (name: string, scope: "all_branches" | "main_only") => unknown
    remove: (name: string) => unknown
  }
  readonly install?: boolean
  readonly live?: Pick<LiveChannel, "subscribe" | "getSnapshot">
  readonly onDispose?: (stop: () => void) => void
}

type Flight = { readonly current: () => boolean; readonly admitted: Promise<boolean> }
/*
 * In-flight work is shared by the user's and the agent's seam (ActorBindings
 * builds one of each over the same store), so a duplicate from either door
 * joins the running request instead of starting a second one.
 */
const shared = new WeakMap<object, {
  readonly inFlight: Map<string, Flight>
  readonly secretReads: Map<string, number>; readonly secretApplied: Map<string, number>
}>()
const sharedFor = (store: object) => {
  let state = shared.get(store)
  if (!state) shared.set(store, state = { inFlight: new Map(), secretReads: new Map(), secretApplied: new Map() })
  return state
}

export const createSecretsSeam = (ctx: SeamContext, withToast: FailureController["withToast"], options: SecretsSeamOptions = {}): SecretsSeam => {
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
  const report = (outcome: unknown, current: () => boolean): void => {
    if (current() && typeof outcome === "string") ctx.dispatch({ type: "message.appended", actor: "system", text: outcome })
  }
  /** One repository's secrets card from the platform's metadata answer. */
  const secretsCard = (repo: string, secrets: ReadonlyArray<RepositorySecret>, ordinal: number): SecretsCard => ({
    id: `secrets-${repo}`,
    kind: "secrets",
    title: `Secrets · ${repo}`,
    status: "active",
    createdAt: Date.now(),
    ordinal,
    payload: {
      repo,
      scope: "repository",
      secrets: secrets.map((secret) => ({
        name: secret.name,
        mainOnly: secret.mainOnly,
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
  let source: "real" | "seed" | undefined
  let liveStop: (() => void) | undefined
  let liveRepo: string | undefined
  const readSecrets = async (repo: string): Promise<ReadonlyArray<RepositorySecret> | string> => {
    if (!options.install) {
      const rows = await readRepositorySecrets(ctx, repo)
      if (typeof rows !== "string") { source = "real"; return rows }
      if (source !== "real" && options.fallback) { source = "seed"; return options.fallback.rows() }
      return rows
    }
    if (!options.live) return "Secrets unavailable"
    liveRepo = repo
    const authorized = captureCloudOwner(ctx, false)
    const decode = (): ReadonlyArray<RepositorySecret> | string | undefined => {
      const snapshot = options.live!.getSnapshot("secrets")
      if (snapshot?.error) return "Secrets unavailable"
      if (snapshot?.data === undefined) return undefined
      const parsed = SecretsCardSchema.safeParse(snapshot.data)
      if (!parsed.success) return "Secrets unavailable"
      return parsed.data.secrets.map(secret => ({ name: secret.name, mainOnly: secret.scope === "main_only",
        hosts: secret.hosts ?? [], matchHeaders: [], updatedAt: null, reconnect: false }))
    }
    const update = () => {
      const rows = decode()
      if (!authorized() || !liveRepo || rows === undefined || ctx.isDisposed?.()) return
      if (typeof rows === "string") {
        const previous = ctx.store.collections.cards?.get(`secrets-${liveRepo}`)
        if (previous?.kind === "secrets") ctx.dispatch({ type: "card.upsert", actor: "system", card: { ...previous, payload: { ...previous.payload, secrets: [] } } })
        return
      }
      const previous = ctx.store.collections.cards?.get(`secrets-${liveRepo}`)
      if (previous?.kind === "secrets") ctx.dispatch({ type: "card.upsert", actor: "system", card: {
        ...secretsCard(liveRepo, rows, previous.ordinal), createdAt: previous.createdAt } })
    }
    if (!liveStop) {
      liveStop = options.live.subscribe("secrets", update)
      options.onDispose?.(() => { liveStop?.(); liveStop = undefined })
    }
    const current = decode()
    if (current !== undefined) return current
    return new Promise(resolve => {
      let stop = () => {}
      const receive = () => { const rows = decode(); if (rows !== undefined) { stop(); resolve(rows) } }
      stop = options.live!.subscribe("secrets", receive)
      options.onDispose?.(() => { stop(); resolve("Secrets unavailable") })
      receive()
    })
  }
  const secretUrl = (repo: string, name?: string) => options.install
    ? `${ctx.baseUrl}/api/secrets${name === undefined ? "" : `/${encodeURIComponent(name)}`}`
    : repositorySecretsUrl(ctx, repo, name)
  /** Re-read an open secrets card in place after a write; a failed read keeps the rows it had. */
  const refreshSecrets = async (repo: string, current: () => boolean): Promise<void> => {
    if (ctx.store.collections.cards?.get(`secrets-${repo}`)?.kind !== "secrets") return
    const seq = secretRead(repo)
    if (options.install) return
    const config = await readSecrets(repo).catch(() => "unread")
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
    const response = await ctx.http(secretUrl(row.repo, options.install ? undefined : row.name), { method: "DELETE", headers: { "Idempotency-Key": row.id, "content-type": "application/json" }, ...(options.install ? { body: JSON.stringify({ name: row.name }) } : {}) })
    if (!current()) return TOAST_SUPERSEDED
    if (response.status !== 204 && response.status !== 404) {
      const message = await readErrorMessage(response, `${row.name} couldn't be deleted (HTTP ${response.status}).`)
      return await saveSecretRequest({ ...row, state: "failed" }, current) ? message : TOAST_SUPERSEDED
    }
    if (!await saveSecretRequest({ ...row, state: "completed" }, current)) return TOAST_SUPERSEDED
    void refreshSecrets(row.repo, current)
    return true
  }
  const sendScope = async (row: SecretRequest, current: () => boolean): Promise<true | string | typeof TOAST_SUPERSEDED> => {
    const response = await ctx.http(secretUrl(row.repo, row.name), { method: "PATCH",
      headers: { "content-type": "application/json", "Idempotency-Key": row.id }, body: JSON.stringify({ main_only: row.mainOnly }) })
    if (!current()) return TOAST_SUPERSEDED
    await response.body?.cancel()
    if (!await saveSecretRequest({ ...row, state: response.ok ? "completed" : "failed" }, current)) return TOAST_SUPERSEDED
    return response.ok ? true : `${row.name} couldn't be changed (HTTP ${response.status}).`
  }
  const runSecret = (row: SecretRequest, flight: Flight, work: () => Promise<true | string | typeof TOAST_SUPERSEDED>): void => {
    const verb = row.action === "delete" ? ["Deleting", "deleted"] : ["Saving", "saved"]
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
      if (options.install && !options.live) return "Secrets unavailable"
      if (!login) return "Sign in to save a secret."
      const target = resolveTargetRepo(ctx.store, input.repo)
      if ("error" in target) return target.error
      const name = input.name.trim()
      if (!SECRET_NAME.test(name)) return "Use letters, digits and _ for the name."
      if (!value) return "Enter the value."
      const hosts = listOf(input.hosts)
      const headers = listOf(input.headers)
      if ((hosts.length === 0) !== (headers.length === 0)) return "Give both hosts and headers, or neither."
      if (source === "seed" && options.fallback) {
        const answer = options.fallback.set(name, input.scope ?? (options.fallback.rows().find(row => row.name === name)?.mainOnly === true ? "main_only" : "all_branches"))
        if (typeof answer === "string") return answer
        await refreshSecrets(target.repo, current)
        return { value: "Requested" }
      }
      const row: SecretRequest = { id: randomUuid(), owner: login, repo: target.repo, name, action: "set", state: "requested" }
      const admitted = await admitSecret(row, current)
      if (typeof admitted === "string") return admitted
      let sending: string | undefined = value
      value = undefined
      runSecret(row, admitted.flight, async () => {
        try {
          if (!current()) return TOAST_SUPERSEDED
          // An omitted binding keeps a replaced secret's stored one.
          const body = JSON.stringify({ name, value: sending, ...(input.scope ? { main_only: input.scope === "main_only" } : {}), ...(hosts.length === 0 ? {} : { hosts, match_headers: headers }) })
          sending = undefined
          const response = await ctx.http(secretUrl(row.repo), { method: options.install ? "PUT" : "POST", headers: { "content-type": "application/json", "Idempotency-Key": row.id }, body })
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
    if (options.install && !options.live) return "Secrets unavailable"
    if (!login) return "Sign in to delete a secret."
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const name = input.trim()
    if (!SECRET_NAME.test(name)) return "Use letters, digits and _ for the name."
    if (source === "seed" && options.fallback) { const answer = options.fallback.remove(name); if (typeof answer === "string") return answer; await refreshSecrets(target.repo, current); return { value: "Requested" } }
    const row: SecretRequest = { id: randomUuid(), owner: login, repo: target.repo, name, action: "delete", state: "requested" }
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
        if (row.action === "scope") return sendScope(row, current)
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
    const config = await readSecrets(target.repo)
    if (typeof config === "string") return config
    // A list is the person's newest read: it applies, and any earlier refresh still in flight is dropped.
    state.secretApplied.set(target.repo, Math.max(seq, state.secretApplied.get(target.repo) ?? 0))
    const card = secretsCard(target.repo, config, ctx.nextOrdinal())
    return { card, ...readResult(card.payload.secrets.length === 0
      ? `No secrets in ${card.payload.repo}.`
      : [
        `Secrets · ${card.payload.repo}`,
        ...card.payload.secrets.map((secret) =>
          `${secret.name} · ${secret.mainOnly ? "main only" : "all branches"} · hosts: ${secret.hosts.join(", ") || "none"} · headers: ${secret.matchHeaders.join(", ") || "none"} · updated: ${secret.updatedAt ?? "unknown"}`)
      ].join("\n")) }
    } }
  })

  /*
   * A main-only repository secret reaches only trusted runs on the default
   * bookmark. The platform answers with the stored mark, which the reply names.
   */
  const scopeSecret: SecretsSeam["scopeSecret"] = async (name, scope, repo) => {
    if (options.install && !options.live) return "Secrets unavailable"
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    if (source === "seed" && options.fallback) {
      if (!options.fallback.rows().some(row => row.name === name)) return "Secret not found"
      const answer = options.fallback.set(name, scope === "main-only" ? "main_only" : "all_branches")
      if (typeof answer === "string") return answer
      await refreshSecrets(target.repo, captureCloudOwner(ctx, false)); return { value: "Requested" }
    }
    if (options.install) {
      const login = owner()
      if (!login) return "Sign in to change a secret."
      const current = captureCloudOwner(ctx, false)
      const row: SecretRequest = { id: randomUuid(), owner: login, repo: target.repo, name, action: "scope", mainOnly: scope === "main-only", state: "requested" }
      const admitted = await admitSecret(row, current)
      if (typeof admitted === "string") return admitted
      runSecret(row, admitted.flight, () => sendScope(row, current))
      return { value: "Requested" }
    }
    let response: Response
    try {
      response = await ctx.http(
        secretUrl(target.repo, name),
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ main_only: scope === "main-only" }) }
      )
    } catch {
      return `${name} couldn't be changed in ${target.repo} — the platform didn't answer.`
    }
    if (!response.ok) return readErrorMessage(response, `${name} couldn't be changed in ${target.repo} (HTTP ${response.status}).`)
    const stored = await response.json().catch(() => undefined) as { main_only?: unknown } | undefined
    return { value: `${name}: ${stored?.main_only === true ? "main only" : "all branches"}` }
  }

  /*
   * A repository secret's egress binding, without its value. Both lists are
   * required: an omitted field never clears a stored binding. The reply names
   * the stored hosts.
   */
  const bindSecret: SecretsSeam["bindSecret"] = async (input) => {
    const target = resolveTargetRepo(ctx.store, input.repo)
    if ("error" in target) return target.error
    const name = input.name.trim()
    if (!SECRET_NAME.test(name)) return "Use letters, digits and _ for the name."
    const hosts = listOf(input.hosts)
    const headers = listOf(input.headers)
    if (hosts.length === 0 || headers.length === 0) return "Give both hosts and headers."
    let response: Response
    try {
      response = await ctx.http(
        secretUrl(target.repo, name),
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ hosts, match_headers: headers }) }
      )
    } catch {
      return `${name} couldn't be changed in ${target.repo} — the platform didn't answer.`
    }
    if (!response.ok) return readErrorMessage(response, `${name} couldn't be changed in ${target.repo} (HTTP ${response.status}).`)
    const stored = await response.json().catch(() => undefined) as { hosts?: unknown } | undefined
    const bound = Array.isArray(stored?.hosts) ? stored.hosts.filter((host): host is string => typeof host === "string") : []
    return { value: `${name}: ${bound.join(", ")}` }
  }

  return {
    listSecrets, scopeSecret, bindSecret,
    setSecret, deleteSecret, resumeSecretRequests
  }
}
