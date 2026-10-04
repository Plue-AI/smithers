import type { CommandGesture } from "../../flows/CommandGesture"
import type { SeamContext } from "./SeamContext"
import { TOAST_SUPERSEDED, type FailureController } from "../controller/failures"
import { MODEL_CREDENTIALS, ModelCredentialRequestSchema, ModelCredentialResultSchema } from "@smthrs/rpc/ConfiguredModel"
import { actorSharedState } from "../ActorBindings"
import { installRequestId } from "./InstallRequestId"
import { InstallErrorSchema, InstallModelSchema, type InstallError, type InstallModel, type InstallStepId } from "./InstallModel"

/** T-APP-03: the shared /api/live transport supplies complete install projections after snapshots/deltas. */
export interface InstallTopic {
  readonly subscribe: (topic: "install", receive: (data: unknown) => void, refuse: (error: InstallError) => void) => () => void
}
export interface InstallSnapshot { readonly model?: InstallModel; readonly error?: InstallError }
export interface InstallSnapshots {
  readonly get: () => InstallSnapshot
  readonly subscribe: (listener: () => void) => () => void
}
export interface InstallSeamOptions {
  readonly topic?: InstallTopic
  readonly present?: (kind: "setup" | "settings") => void
  /** MOCK SEAM (state/seams/DesignWorld): while the seed stands in, a host where no install answers is a quiet state, not a failed notice. */
  readonly quietWithoutInstall?: boolean
}
export interface InstallAddress { readonly listen: "mac" | "network"; readonly bind: string; readonly origins: readonly string[] }
export interface SetupInput { readonly step: InstallStepId; readonly owner?: string; readonly repository?: string; readonly bind?: string; readonly origins?: readonly string[] }
export interface ModelKeyInput { readonly role: "fast" | "coding" | "jev"; readonly provider: string }
const error = (code: string, message: string, fault: InstallError["class"] = "infra"): InstallError => ({ code, class: fault, message })
const permission = error("owner_required", "Owner access required", "permission")

export const createInstallSeam = (ctx: SeamContext, withToast: FailureController["withToast"], options: InstallSeamOptions = {}) => {
  const shared = actorSharedState(ctx, "install", () => ({
    snapshot: {} as InstallSnapshot, listeners: new Set<() => void>(), pending: new Map<string, Promise<unknown>>(),
    stop: undefined as (() => void) | undefined, disposed: false, generation: 0,
    cancel: new Set<() => void>(), tail: Promise.resolve() as Promise<unknown>, subscribing: false
  }))
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
  const receive = (data: unknown) => {
    const parsed = InstallModelSchema.safeParse(data)
    if (!parsed.success) { publish({ ...shared.snapshot, error: error("invalid_install", "Install response unavailable") }); return }
    shared.generation++
    publish({ model: parsed.data })
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
  const request = async (path: string, init?: RequestInit): Promise<InstallModel | InstallError> => {
    try {
      const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api${path}`, {
        credentials: "same-origin", ...init,
        headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers }
      })
      const body: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const parsed = InstallErrorSchema.safeParse(body)
        return parsed.success ? parsed.data : error("invalid_error", "Install request failed")
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
    receive(result)
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
    // No install answered at all (no install error body, or no answer): with the seed standing in, nothing failed that the person can act on.
    if (failure && options.quietWithoutInstall && (failure.code === "invalid_error" || failure.code === "unreachable")) return TOAST_SUPERSEDED
    if (failure) return failure.message
    if (!current() || !shared.snapshot.model) return false
    if (kind === "settings" && !shared.snapshot.model.github.signed_in) {
      publish({ error: permission }); return permission.message
    }
    options.present?.(kind)
    const running = shared.snapshot.model.steps.find(step => step.state === "running")
    if (kind === "setup" && running) return await waitStep(running.id)
    return true
  }, kind === "setup" ? "Setup" : "Settings")
  const write = (key: string, path: string, body: unknown, setup = false) => {
    const model = shared.snapshot.model
    if (!model || (!setup && !model.github.signed_in)) { publish({ error: permission }); return permission.message }
    return background(setup ? key : key + ":" + JSON.stringify(body), setup ? "Setup" : "Saving", async () => {
      const prior = shared.tail
      let release!: () => void
      shared.tail = new Promise<void>(done => { release = done })
      await prior
      try {
        if (!current()) return false
        const generation = shared.generation
        const result = await request(path, { method: path === "/install" ? "PUT" : "POST",
          headers: { "Idempotency-Key": installRequestId() }, body: JSON.stringify(body) })
        if (!current()) return false
        if ("class" in result) {
          if (result.class === "permission") revoke(result)
          else {
            const model = shared.snapshot.model
            const address = path === "/install" && typeof body === "object" && body !== null && "address" in body
              ? body.address as InstallAddress : undefined
            const failedStep = setup ? (path.endsWith("/app") ? "app_manifest" : path.split("/").at(-1)) as InstallStepId : undefined
            publish({ ...shared.snapshot, error: result, model: model && address ? { ...model, address: { ...model.address,
              change_failed: { from: model.address.origins[0] ?? "", to: address.origins[0] ?? "", reason: result.message } } }
              : model && failedStep ? { ...model, steps: model.steps.map(step => step.id === failedStep
                ? { ...step, state: "failed", error: result } : step) } : model })
          }
          return result.message
        }
        if (generation === shared.generation) receive(result)
        release()
        if (setup) return await waitStep((path.endsWith("/app") ? "app_manifest" : path.split("/").at(-1)) as InstallStepId)
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
    if (step.state === "running" || step.state === "done") return { value: "Requested" }
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
    const model = shared.snapshot.model
    if (!Number.isInteger(parallel) || parallel < 0 || (model && parallel > model.capacity)) return "At once exceeds Machines"
    return write("parallel", "/install", { parallel })
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
    return background(`key:${input.role}`, "Saving key", async () => {
      if (!current()) { value = undefined; return false }
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
          const failure = parsed.success ? parsed.data : receipt.success && !receipt.data.ok
            ? error(receipt.data.failure.code, "Key refused", receipt.data.fault === "infra" ? "infra" : "user")
            : error("key_refused", "Key refused")
          const model = shared.snapshot.model
          if (failure.class === "permission") revoke(failure)
          else publish({ ...shared.snapshot, error: failure, model: model && { ...model,
            models: model.models.map(role => role.role === input.role ? { ...role, key: "failed", error: failure.message } : role) } })
          return failure.message
        }
        // Only the authoritative read can mark a key saved. Credential responses are never retained.
        const failure = await readInstall()
        return failure?.message ?? true
      } catch { const failure = error("unreachable", "Could not save key"); publish({ ...shared.snapshot, error: failure }); return failure.message }
      finally { value = undefined }
    })
  }
  return {
    snapshots, readInstall, showSetup: () => open("setup"), showSettings: () => open("settings"),
    setupStep, setInstallAddress: (input: InstallAddress) => write("address", "/install", { address: input }),
    setInstallCapacity, setInstallParallel, saveInstallModelKey,
    dispose: () => { shared.disposed = true; shared.generation++; shared.stop?.(); shared.stop = undefined;
      for (const cancel of shared.cancel) cancel()
      shared.listeners.clear() }
  }
}
export type InstallSeam = ReturnType<typeof createInstallSeam>
