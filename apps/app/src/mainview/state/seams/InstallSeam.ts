import { submitGitHubAppManifest } from "../../flows/cardActions"
import type { CommandGesture } from "../../flows/CommandGesture"
import type { SeamContext } from "./SeamContext"
import { TOAST_SUPERSEDED, type FailureController } from "../controller/failures"
import { MODEL_CREDENTIALS, ModelCredentialRequestSchema, ModelCredentialResultSchema } from "@smthrs/rpc/ConfiguredModel"
import { actorSharedState } from "../ActorBindings"
import { installRequestId } from "./InstallRequestId"
import { InstallErrorSchema, InstallModelSchema, InstallReceiptSchema, type InstallManifest, type InstallError, type InstallModel, type InstallStepId } from "./InstallModel"

/** T-APP-03: the shared /api/live transport supplies complete install projections after snapshots/deltas. */
export interface InstallTopic {
  readonly subscribe: (topic: "install", receive: (data: unknown) => void, refuse: (error: InstallError) => void) => () => void
}
export interface InstallSnapshot { readonly model?: InstallModel; readonly error?: InstallError; readonly seed?: true }
export interface InstallSnapshots {
  readonly get: () => InstallSnapshot
  readonly subscribe: (listener: () => void) => () => void
}
export interface InstallSeamOptions {
  readonly handoff?: (receipt: InstallManifest) => void
  readonly topic?: InstallTopic
  readonly present?: (kind: "setup" | "settings") => void | Promise<void>
  /**
   * MOCK SEAM (state/seams/DesignWorld): while the seed stands in, a host with no install route (GET /api/install
   * answers 404, or a page that is not an install's JSON) opens quietly. An install that exists and is unreachable
   * or errors keeps its visible, retryable failure.
   */
  readonly quietWithoutInstall?: boolean
}
export interface InstallAddress { readonly listen: "mac" | "network"; readonly bind: string; readonly origins: readonly string[] }
export interface SetupInput { readonly step: InstallStepId; readonly owner?: string; readonly repository?: string; readonly bind?: string; readonly origins?: readonly string[] }
export interface ModelKeyInput { readonly role: "fast" | "coding" | "jev"; readonly provider: string; readonly model?: string }
const error = (code: string, message: string, fault: InstallError["class"] = "infra"): InstallError => ({ code, class: fault, message })
const permission = error("owner_required", "Owner access required", "permission")
/** GET /api/install found no install route on this host (see quietWithoutInstall). */
export const NO_INSTALL = "no_install"
/**
 * The App step's lease (packages/backend github_app_manifest.go Begin: ten minutes, and the state cookie's Max-Age).
 * GET /api/install serves no expiry and still serves a lapsed lease as running, so the request row carries its own,
 * stamped before the POST leaves, never later than the host's. Delete it once the host serves a lapsed lease as failed.
 */
const APP_LEASE_MS = 10 * 60_000

export const createInstallSeam = (ctx: SeamContext, withToast: FailureController["withToast"], options: InstallSeamOptions = {}) => {
  const shared = actorSharedState(ctx, "install", () => ({
    snapshot: {} as InstallSnapshot, authoritative: undefined as InstallModel | undefined, listeners: new Set<() => void>(), pending: new Map<string, Promise<unknown>>(),
    stop: undefined as (() => void) | undefined, disposed: false, generation: 0,
    cancel: new Set<() => void>(), tail: Promise.resolve() as Promise<unknown>, subscribing: false
  }))
  type SetupRequest = NonNullable<ReturnType<typeof ctx.store.session>["installRequests"]>[number]
  const requests = () => (ctx.store.session().installRequests ?? []).filter(row => row.origin === ctx.baseUrl)
  const saveRequest = (row: SetupRequest) => ctx.dispatch({ type: "install.requests.changed", actor: ctx.actor(),
    requests: [...(ctx.store.session().installRequests ?? []).filter(each => each.id !== row.id), row].slice(-32) }).isPersisted.promise
  /** An App request whose lease has run out: its handoff would reach GitHub with a state the host no longer accepts. */
  const lapsed = (row: SetupRequest) => row.step === "app_manifest" && !(Date.parse(row.expires_at ?? "") > Date.now())
  const current = () => !shared.disposed && ctx.isDisposed?.() !== true
  const publish = (snapshot: InstallSnapshot) => {
    if (!current()) return
    shared.snapshot = snapshot
    for (const listener of shared.listeners) listener()
  }
  const snapshots: InstallSnapshots = {
    get: () => shared.snapshot,
    subscribe: listener => { shared.listeners.add(listener); return () => { shared.listeners.delete(listener) } }
  }
  const revoke = (failure: InstallError) => {
    shared.generation++
    shared.stop?.(); shared.stop = undefined
    publish({ error: failure })
  }
  /**
   * The served install with this browser's own requests over it: a step it asked for reads running, an App lease
   * that ran out reads failed (retryable, like the host's own failure), and the App's owner is the one it asked for.
   */
  const projection = (served: InstallModel): InstallModel => {
    const active = requests().filter(row => (row.state === "requested" || row.state === "running") && !lapsed(row))
    const app = requests().filter(row => row.step === "app_manifest").at(-1)
    return { ...served,
      github: served.github.owner === undefined && typeof app?.body.owner === "string" ? { ...served.github, owner: app.body.owner } : served.github,
      steps: served.steps.map(step => step.state === "pending" && active.some(row => row.step === step.id) ? { ...step, state: "running" }
        : step.id === "app_manifest" && step.state === "running" && app && lapsed(app) ? { ...step, state: "failed" } : step) }
  }
  const receive = (data: unknown) => {
    const parsed = InstallModelSchema.safeParse(data)
    if (!parsed.success) { publish({ ...shared.snapshot, error: error("invalid_install", "Install response unavailable") }); return }
    shared.generation++
    shared.authoritative = parsed.data
    publish({ model: projection(parsed.data) })
    if (parsed.data.github.signed_in && !shared.stop && !shared.subscribing && options.topic) {
      shared.subscribing = true
      try {
        const stop = options.topic.subscribe("install", receive, failure => {
          shared.generation++
          if (failure.class === "permission") revoke(failure)
          else publish({ ...shared.snapshot, error: failure })
        })
        if (current() && shared.snapshot.model?.github.signed_in) shared.stop = stop
        else stop()
      } catch { publish({ ...shared.snapshot, error: error("subscription_failed", "Install updates unavailable") }) }
      finally { shared.subscribing = false }
    }
  }
  const request = async (path: string, init?: RequestInit): Promise<InstallModel | InstallError | ReturnType<typeof InstallReceiptSchema.parse>> => {
    try {
      const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api${path}`, {
        credentials: "same-origin", ...init,
        headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers }
      })
      const body: unknown = await response.json().catch(() => undefined)
      // No install route on this host: a 404, or a page that is not JSON (the hosted site's HTML fallback).
      if (response.status === 404 || (response.ok && body === undefined)) return error(NO_INSTALL, "No install on this host")
      if (!response.ok) {
        const parsed = InstallErrorSchema.safeParse(body)
        return parsed.success ? parsed.data : error("invalid_error", "Install request failed")
      }
      if (path.startsWith("/install/setup/") && response.ok) {
        const receipt = InstallReceiptSchema.safeParse(body)
        if (receipt.success) return receipt.data
      }
      const parsed = InstallModelSchema.safeParse(body)
      return parsed.success ? parsed.data : error("invalid_install", "Install response unavailable")
    } catch { return error("unreachable", "Could not reach this install") }
  }
  const readInstall = async (): Promise<InstallError | undefined> => {
    const generation = shared.generation
    const result = await request("/install")
    if (!current() || generation !== shared.generation) return
    if ("class" in result) {
      if (result.class === "permission") revoke(result)
      else publish({ ...shared.snapshot, error: result })
      return result
    }
    if ("steps" in result) receive(result)
    else { const failure = error("invalid_install", "Install response unavailable"); publish({ ...shared.snapshot, error: failure }); return failure }
  }
  const background = (key: string, title: string, work: () => Promise<boolean | string | typeof TOAST_SUPERSEDED>, doneTitle = "Saved") => {
    if (!current()) return "Install is closed"
    if (!shared.pending.has(key)) {
      // Register before work begins, including synchronous fake transports.
      const job = Promise.resolve().then(() => current() ? withToast(`install:${key}`, title, doneTitle, work) : false)
      shared.pending.set(key, job)
      void job.catch(() => publish({ ...shared.snapshot, error: error("request_failed", "Install request failed") }))
        .finally(() => { if (shared.pending.get(key) === job) shared.pending.delete(key) })
    }
    return { value: "Requested" }
  }
  const open = (kind: "setup" | "settings") => background(`open:${kind}`, kind === "setup" ? "Setup" : "Settings", async () => {
    const failure = await readInstall()
    // Only a host with no install route is quiet while the seed stands in; an unreachable or failing install stays visible.
    if (failure && options.quietWithoutInstall && failure.code === NO_INSTALL) return TOAST_SUPERSEDED
    if (failure) return failure.message
    if (!current() || !shared.snapshot.model) return false
    if (kind === "settings" && !shared.snapshot.model.github.signed_in) {
      publish({ error: permission }); return permission.message
    }
    await options.present?.(kind)
    // Recovery restores state and never navigates: the GitHub handoff runs only on a person's press (setupStep).
    for (const row of requests().filter(row => row.state === "requested" || row.state === "running")) {
      const served = shared.authoritative?.steps.find(step => step.id === row.step)?.state
      if (served === "done") await saveRequest({ ...row, state: "completed" })
      else if (served === "running" && !lapsed(row)) { if (row.state === "requested") await saveRequest({ ...row, state: "running" }) }
      // An unsent setup write resumes under its Idempotency-Key. An App request never replays: its answer is a handoff.
      else if (served === "pending" && row.state === "requested" && row.step !== "app_manifest") write(`setup:${row.step}`, `/install/setup/${row.step}`, row.body, true, row)
      // Failed, blocked, lapsed or no longer running on the install: dropped, so the step's own control starts again.
      else await saveRequest({ ...row, state: "failed" })
    }
    if (!current() || !shared.authoritative) return false
    publish({ ...shared.snapshot, model: projection(shared.authoritative) })
    if (!shared.snapshot.model) return false
    const running = shared.snapshot.model.steps.find(step => step.state === "running")
    if (kind === "setup" && running) {
      const outcome = await waitStep(running.id)
      // A refused write of this browser's own ends the wait, but a request the host still runs stays.
      const served = shared.authoritative?.steps.find(step => step.id === running.id)?.state
      if (current()) for (const row of requests().filter(row => row.step === running.id && (row.state === "requested" || row.state === "running")))
        if (outcome === true || served !== "running" || lapsed(row)) await saveRequest({ ...row, state: outcome === true ? "completed" : "failed" })
      return outcome
    }
    return true
  }, kind === "setup" ? "Setup" : "Settings")
  /** GitHub's manifest form POST leaves the app, so it runs only as the direct result of a person's press. */
  const handOff = (receipt: InstallManifest): InstallError | undefined => {
    try { (options.handoff ?? submitGitHubAppManifest)(receipt); return undefined }
    catch {
      const failure = error("handoff_failed", "GitHub App handoff unavailable")
      publish({ ...shared.snapshot, error: failure, model: shared.snapshot.model && { ...shared.snapshot.model,
        steps: shared.snapshot.model.steps.map(step => step.id === "app_manifest" ? { ...step, state: "failed", error: failure } : step) } })
      return failure
    }
  }
  const write = (key: string, path: string, body: unknown, setup = false, recovered?: SetupRequest) => {
    const model = shared.snapshot.model
    if (!model || (!setup && !model.github.signed_in)) { publish({ error: permission }); return permission.message }
    if (setup && shared.pending.has(key)) return { value: "Requested" }
    const stepId = (path.endsWith("/app") ? "app_manifest" : path.split("/").at(-1)) as InstallStepId
    const row: SetupRequest | undefined = setup ? recovered ?? { id: installRequestId(), origin: ctx.baseUrl, step: stepId,
      body: body as Record<string, unknown>, state: "requested",
      ...(stepId === "app_manifest" ? { expires_at: new Date(Date.now() + APP_LEASE_MS).toISOString() } : {}) } : undefined
    const saved = row ? saveRequest(row) : Promise.resolve()
    if (setup) publish({ model: { ...model, steps: model.steps.map(step => step.id === stepId ? { id: step.id, state: "running" } : step) } })
    return background(setup ? key : key + ":" + JSON.stringify(body), setup ? "Setup" : "Saving", async () => {
      const prior = shared.tail
      let release!: () => void
      shared.tail = new Promise<void>(done => { release = done })
      await prior
      try {
        await saved
        if (!current()) return false
        const generation = shared.generation
        const result = await request(path, { method: path === "/install" ? "PUT" : "POST",
          headers: { "Idempotency-Key": row?.id ?? installRequestId() }, body: JSON.stringify(body) })
        if (!current()) return false
        if ("class" in result) {
          if (generation !== shared.generation) return setup ? await waitStep(stepId) : TOAST_SUPERSEDED
          if (row) await saveRequest({ ...row, state: "failed" })
          if (result.class === "permission") revoke(result)
          else {
            const model = shared.snapshot.model
            const address = path === "/install" && typeof body === "object" && body !== null && "address" in body
              ? body.address as InstallAddress : undefined
            const failedStep = setup ? (path.endsWith("/app") ? "app_manifest" : path.split("/").at(-1)) as InstallStepId : undefined
            publish({ ...shared.snapshot, error: result, model: model && address ? { ...model, address: { ...model.address,
              change_failed: { from: model.address.origins[0] ?? "", to: address.origins[0] ?? "", reason: result.message } } }
              : model && path === "/install" && typeof body === "object" && body !== null && "wiki_sync.obsidian" in body
                ? { ...model, wiki_sync: { obsidian: { ...model.wiki_sync?.obsidian, path: model.wiki_sync?.obsidian?.path ?? "", error: result.message } } }
              : model && failedStep ? { ...model, steps: model.steps.map(step => step.id === failedStep
                ? { ...step, state: "failed", error: result } : step) } : model })
          }
          return result.message
        }
        if ("steps" in result) {
          if (generation === shared.generation) receive(result)
        } else {
          if (row) await saveRequest({ ...row, state: "running", ...("action_url" in result ? { handoff: result } : {}) })
          // The answer to the person's own press, unless the step finished meanwhile.
          if ("action_url" in result && shared.snapshot.model?.steps.find(step => step.id === stepId)?.state !== "done") {
            const failure = handOff(result)
            if (failure) { if (row) await saveRequest({ ...row, state: "failed" }); return failure.message }
          }
        }
        release()
        if (setup) {
          const outcome = await waitStep(stepId)
          if (current() && row) await saveRequest({ ...row, state: outcome === true ? "completed" : "failed" })
          return outcome
        }
        return true
      } finally { release() }
    }, setup ? path.endsWith("/source") ? "Source ready" : path.endsWith("/machine") ? "Machine ready" : "Setup" : "Saved")
  }
  const waitStep = (id: InstallStepId): Promise<boolean | string> => new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancel = () => { cleanup(); resolve(false) }
    const cleanup = () => { if (timer !== undefined) clearTimeout(timer); shared.listeners.delete(check); shared.cancel.delete(cancel) }
    const poll = () => {
      if (!current()) return cancel()
      timer = setTimeout(() => {
        timer = undefined
        void readInstall().then(() => {
          if (shared.listeners.has(check) && !shared.stop) poll()
        })
      }, 1000)
    }
    const check = () => {
      const step = shared.snapshot.model?.steps.find(step => step.id === id)
      if (!current()) return cancel()
      if (shared.snapshot.error || step?.state === "failed" || step?.state === "blocked") {
        cleanup(); resolve(shared.snapshot.error?.message ?? step?.error?.message ?? step?.blocked?.line ?? "Setup failed")
      } else if (step?.state === "done") {
        cleanup(); resolve(true)
      }
    }
    shared.listeners.add(check); shared.cancel.add(cancel); check()
    if (shared.listeners.has(check) && !shared.stop) poll()
  })
  const setupStep = (input: SetupInput) => {
    const model = shared.snapshot.model
    const index = model?.steps.findIndex(step => step.id === input.step) ?? -1
    const step = model?.steps[index]
    if (!step || model?.steps.slice(0, index).some(step => step.state !== "done")) return "Complete the earlier step"
    // A press while the host runs this browser's App attempt for the same owner continues it to GitHub.
    const attempt = input.step === "app_manifest" && shared.authoritative?.steps[index]?.state === "running"
      ? requests().filter(row => row.step === "app_manifest" && row.state === "running" && row.handoff && !lapsed(row)).at(-1) : undefined
    if (attempt?.handoff && (input.owner === undefined || input.owner === attempt.body.owner)) {
      const failure = handOff(attempt.handoff)
      if (failure) { void saveRequest({ ...attempt, state: "failed" }); return failure.message }
      return { value: "Requested" }
    }
    // Any other press on the running App step starts again; write joins one already in flight and the host refuses a live lease.
    if ((step.state === "running" && input.step !== "app_manifest") || step.state === "done") return { value: "Requested" }
    const id = input.step
    const body = id === "address" ? { bind: input.bind, origins: input.origins }
      : id === "app_manifest" ? { owner: input.owner }
      : id === "repository" ? { repository: input.repository } : {}
    if (id === "address" && (!input.bind || !input.origins?.length)) return "Enter bind and origins"
    if (id === "app_manifest" && !input.owner) return "Enter owner"
    if (id === "repository" && !input.repository) return "Choose repository"
    return write(`setup:${id}`, `/install/setup/${id === "app_manifest" ? "app" : id}`, body, true)
  }
  const setInstallCapacity = (capacity: number) => {
    const model = shared.snapshot.model
    if (!Number.isInteger(capacity) || capacity < 0 || (model && capacity > model.this_mac.capacity)) return "Machines exceed this Mac"
    return write("capacity", "/install", { capacity })
  }
  const setInstallParallel = (parallel: number) => {
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) return "Choose 1 to 8 TODOs at once"
    return write("parallel", "/install", { parallel })
  }
  // T-FLW-12: no seed or host-config mutation; an authoritative setting enables this door.
  const setInstallObsidian = (path: string) => {
    if (!shared.snapshot.model?.wiki_sync) return "Obsidian settings unavailable"
    if (!path.startsWith("/") || path.includes("\0")) return "Choose an absolute folder path"
    return write("obsidian", "/install", { "wiki_sync.obsidian": { path } })
  }
  const saveInstallModelKey = (input: ModelKeyInput, gesture?: CommandGesture) => {
    let value = gesture?.takeWriteOnly?.("value")
    gesture?.release()
    if (!value) return "Enter a key"
    if (!shared.snapshot.model?.github.signed_in) { value = undefined; publish({ error: permission }); return permission.message }
    const name = input.role === "jev" ? "AI_GATEWAY_API_KEY" : input.provider.toUpperCase().replace(/[ -]/g, "_") + "_API_KEY"
    const credential = MODEL_CREDENTIALS.find(credential => credential.name === name)
    if (!credential) { value = undefined; return "Choose a provider" }
    const prior = shared.snapshot.model.models.find(role => role.role === input.role)
    const rotate = prior?.provider === input.provider && prior.key === "saved"
    if (shared.pending.has(`key:${input.role}`)) { value = undefined; return { value: "Requested" } }
    const mark = (key: "validating" | "failed", reason?: string) => {
      const model = shared.snapshot.model
      if (model) publish({ ...shared.snapshot, model: { ...model, models: model.models.map(role => role.role !== input.role ? role
        : { role: role.role, provider: input.provider, key, ...(reason === undefined ? {} : { error: reason }) }) } })
    }
    return background(`key:${input.role}`, "Saving key", async () => {
      if (!current()) { value = undefined; return false }
      // A key is Validating while its one request is in flight; only the authoritative read below marks it Saved.
      mark("validating")
      // Values live only until the one HTTP request is constructed, never in install/card state.
      const requestId = installRequestId()
      const request = ModelCredentialRequestSchema.safeParse({ requestId, name: credential.name, value,
        ...(rotate ? { action: "rotate" } : { action: "enroll", origin: credential.origins[0] }) })
      value = undefined
      if (!request.success) { publish({ ...shared.snapshot, error: error("invalid_key", "Key refused", "user") }); return "Key refused" }
      const body = JSON.stringify(request.data)
      if ("value" in request.data) request.data.value = ""
      try {
        const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/model/credential`, {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": requestId }, body
        })
        if (!current()) return false
        const payload: unknown = await response.json().catch(() => undefined)
        const receipt = ModelCredentialResultSchema.safeParse(payload)
        if (!response.ok || !receipt.success || !receipt.data.ok || receipt.data.credential.name !== credential.name || !receipt.data.credential.present) {
          const parsed = InstallErrorSchema.safeParse(payload)
          // The provider's own refusal, when the host relays one, is the reason the role shows.
          const refusal = receipt.success && !receipt.data.ok && receipt.data.failure.code === "host_refused" ? receipt.data.failure.refusal : null
          const failure = parsed.success ? parsed.data : receipt.success && !receipt.data.ok
            ? error(receipt.data.failure.code, refusal ?? "Key refused", receipt.data.fault === "infra" ? "infra" : "user")
            : error("key_refused", "Key refused")
          if (failure.class === "permission") revoke(failure)
          else { mark("failed", failure.message); publish({ ...shared.snapshot, error: failure }) }
          return failure.message
        }
        if (input.role === "coding" && input.model) {
          const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/model/default`, {
            method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": installRequestId() },
            body: JSON.stringify({ model: { protocol: input.provider.toLowerCase() === "anthropic" ? "anthropic-messages"
              : input.provider.toLowerCase() === "openai" ? "openai-responses" : "openai-chat", modelId: input.model, credential: credential.name } })
          })
          if (!current()) return false
          const payload: unknown = await response.json().catch(() => undefined)
          if (!response.ok || typeof payload !== "object" || payload === null || !("ok" in payload) || payload.ok !== true) {
            const parsed = InstallErrorSchema.safeParse(payload)
            const failure = parsed.success ? parsed.data : error("model_refused", "Could not save model")
            mark("failed", failure.message); publish({ ...shared.snapshot, error: failure })
            return failure.message
          }
        }
        // Only the authoritative read can mark a key saved. Credential responses are never retained.
        const failure = await readInstall()
        return failure?.message ?? true
      } catch { const failure = error("unreachable", "Could not save key"); mark("failed", failure.message); publish({ ...shared.snapshot, error: failure }); return failure.message }
      finally { value = undefined }
    })
  }
  return {
    snapshots, readInstall, showSetup: () => open("setup"), showSettings: () => open("settings"),
    setupStep, setInstallAddress: (input: InstallAddress) => write("address", "/install", { address: input }),
    setInstallCapacity, setInstallParallel, setInstallObsidian, saveInstallModelKey,
    dispose: () => { shared.disposed = true; shared.generation++; shared.stop?.(); shared.stop = undefined;
      for (const cancel of shared.cancel) cancel()
      shared.listeners.clear() }
  }
}
export type InstallSeam = ReturnType<typeof createInstallSeam>
