import { WORK_NOTICE_DELAY_MS, NOTICE_SETTLE_MS } from "@smthrs/ui/notification-policy"
import { createOperationalFailureReporter, type OperationalFailureReporter } from "../OperationalFailures"
import { Effect } from "effect"
import { failureDetail } from "@smthrs/rpc/UserFailure"
import { readErrorMessage } from "../seams/SeamContext"
import type { AgentChatMessage, FetchLike } from "@smthrs/rpc/NativeAgent"
import { accountOwnerOf, accountProviderChanged } from "../AccountOwner"
import { gatewayBindingFor } from "../RepoContext"
import { createGatewaySeam } from "./gateway"
import type { CommandRegistry } from "../../flows/Commands"

import type { AgentPort } from "../../runtime/AgentPort"
import type { AppServices } from "../AppController"
import type { Toast } from "../AppState"
import type { AppStore } from "../AppStore"
import type { ImpossibleAskClass } from "../Instructions"
import type { GatewaySeam } from "./gateway"

export interface PendingToolCall {
  readonly callId: string
  readonly name: string
  readonly args: string
}

export interface ActiveTurn {
  readonly id: string
  /** HTTP attempts own durable turn/leg projections; other adapters retain their own runtime. */
  readonly httpAttemptId?: string
  receivedText: boolean
  /** Executed tool legs of this logical turn (capped at MAX_TOOL_LEGS). */
  toolLegs: number
  /** The function_call / function_call_output items accumulated across legs. */
  readonly toolItems: AgentChatMessage[]
  pendingCall: PendingToolCall | undefined
  /*
   * Wave 12 §1: the run-launch command this turn actually executed, if any.
   * Once set, the model's remaining text for the turn is held back and only
   * rendered if it claims nothing about run state (see RunClaims.ts).
   */
  runLaunch: string | undefined
  /*
   * Wave 13c: the impossible-ask class the user's message asked for, if any
   * (detected from the ask alone at send time). Once set, the model's text
   * for the turn is held back like a launch turn's and only rendered if it
   * offers the act the class names — never for ordinary conversation.
   */
  askClass: ImpossibleAskClass | undefined
  /** Text deltas withheld from the transcript while a claim check is pending. */
  claimBuffer: string
}

export interface NetEntry {
  readonly at: number
  readonly method: string
  readonly url: string
  readonly status: number | "error"
  readonly ms: number
}

export interface ControllerContext {
  readonly store: AppStore
  readonly agent: AgentPort
  readonly services: AppServices
  readonly baseUrl: string
  readonly rawHttp: FetchLike
  http: FetchLike
  boundedFetch: (url: string, init?: RequestInit) => Promise<Response>
  errorMessageOf: (response: Response, fallback: string) => Promise<string>
  readonly unref: (timer: ReturnType<typeof setTimeout>) => void
  /**
   * Register a finalizer for something this controller opened (a
   * subscription, a host listener, a channel). Everything registered runs
   * when the controller's scope closes via `dispose` — nothing a controller
   * opened outlives it.
   */
  readonly onDispose: (finalizer: () => void | Promise<void>) => void | Promise<void>
  /** Release in reverse order, awaiting each resource; repeated calls share the completion/failure. */
  readonly dispose: () => Promise<void>
  /** Becomes true synchronously when disposal begins, before asynchronous finalizers run. */
  readonly disposed: boolean
  readonly toastDebounceMs: number
  readonly toastAutoDismissMs: number
  readonly workflowPollMs: number
  readonly workflowPreparationTimeoutMs: number
  readonly failures: OperationalFailureReporter
  readonly netRing: NetEntry[]
  readonly toastRuns: Map<string, number>
  readonly pumpPokes: Map<string, () => void>
  readonly runPumps: Map<string, { stopped: boolean }>
  activeTurn: ActiveTurn | undefined
  commandActor: "user" | "smithers"
  /**
   * The account generation: it increments exactly when `accountOwner()`
   * changes (sign-in, sign-out, another login), and never on a re-probe that
   * names the same owner or on an identity outage. Work in flight fences on
   * the epoch it captured together with the owner it admitted.
   */
  readonly accountEpoch: number
  /** Synchronously revoke account work when its generation ends. */
  readonly onAccountChange: (listener: () => void) => () => void
  /** The owner of this page's account data (state/AccountOwner.ts). */
  readonly accountOwner: () => string | null | undefined
  /**
   * A completed sign-out ends the account generation at once, before local
   * cleanup writes the signed-out row, and even when that cleanup fails: the
   * session is gone, so no work admitted under it may land.
   */
  readonly endAccount: () => void
  identityChanged: () => void
  authReprobeAt: number
  loadSession: () => Promise<void>
  resumeWorkflowRuns: () => void
  observeFlowAuthoring: (cardId: string) => Promise<void>
  resumeFlowAuthoring: (retryCardId?: string) => void
  resumeDeferredCommand: () => void
  /**
   * Late-bound by AppController: make the first-run target choice for the
   * identity answer this read just wrote (state/FirstRunRepository.ts), and
   * settle it. Only the read that writes the row announces it.
   */
  settleFirstRunTarget: () => void
  stopWorkflowPumps: () => void
  contextMessages: () => ReadonlyArray<AgentChatMessage>
  /** Open a repository through a native grant or explicit headless path. */
  /**
   * The workspace gateway, as this app calls it. Allocated once the transport
   * exists, because it is built over `boundedFetch`.
   */
  gateway: GatewaySeam
  commands: CommandRegistry
  withToast: <T>(
    key: string,
    title: string,
    doneTitle: string,
    work: () => Promise<T | string>,
    quiet?: boolean, current?: () => boolean, sourceCard?: string
  ) => Promise<T | string>
  /** Resolve a toast; an ok outcome dismisses itself (failures.ts resolveToast). */
  resolveToast: (
    key: string,
    outcome: { readonly status: "ok" | "failed" | "cancelled"; readonly title?: string; readonly detail: string; readonly action?: Toast["action"]; readonly autoDismissMs?: number }
  ) => void
}

/**
 * Allocate the controller's one shared mutable context. Transport construction
 * order is deliberate: ring, recorder, raw fetch, late-bound unauthorized
 * door, tapped fetch, then bounded fetch.
 */
export const createControllerContext = (
  store: AppStore,
  agent: AgentPort,
  services: AppServices
): ControllerContext => {
  /*
   * The wire tap (DESIGN.md §14 debug mode): a bounded in-memory ring around
   * the one fetch seam every controller call flows through. Records method,
   * url, status, and duration. Never persisted. This is the only capture
   * debug mode adds beyond what the app already stores.
   */
  const netRing: NetEntry[] = []
  const failures = createOperationalFailureReporter({ clientErrors: services.clientErrors })
  const accountOwner = (): string | null | undefined => accountOwnerOf(store.collections.identitySessions.get("identity"))
  let owner = accountOwner()
  let provider = store.collections.identitySessions.get("identity")?.provider
  let accountEpoch = 0
  const accountListeners = new Set<() => void>()
  const advance = (next: string | null | undefined): void => {
    owner = next
    accountEpoch += 1
    netRing.length = 0
    failures.reset()
    for (const listener of [...accountListeners]) {
      try { listener() }
      catch {
        // Do not retain an old account's exception text in the new diagnostics.
        failures.report("account.revoke", new Error("Account work could not be fully disconnected."))
      }
    }
  }
  const recordNet = (entry: NetEntry, generation: number): void => {
    if (generation !== accountEpoch) return
    netRing.push(entry)
    if (netRing.length > 100) netRing.shift()
  }
  const rawHttp: FetchLike = services.fetchImpl ?? fetch.bind(globalThis)
  const unref = (timer: ReturnType<typeof setTimeout>): void => {
    // Bun/Node timers hold the process open (e2e scripts); browser timers don't.
    ;(timer as { unref?: () => void }).unref?.()
  }
  /*
   * The controller's disposal scope (Ruling B, docs/persistence.md): the
   * acquisition half lives where the resource is opened (the agent
   * subscription in turns.ts, the cross-tab identity listeners in
   * auth-billing.ts, the workflow pumps), and closing the scope releases
   * all of it. Previously the agent unsubscribe was discarded and the
   * identity listeners and BroadcastChannel leaked for the page lifetime.
   */
  const finalizers: Array<() => void | Promise<void>> = []
  let disposed = false
  let completion: Promise<void> | undefined
  const ctx = {
    store,
    agent,
    services,
    baseUrl: services.baseUrl ?? "",
    rawHttp,
    toastDebounceMs: services.toastDebounceMs ?? WORK_NOTICE_DELAY_MS,
    toastAutoDismissMs: services.toastAutoDismissMs ?? NOTICE_SETTLE_MS,
    workflowPollMs: services.workflowPollMs ?? 2500,
    workflowPreparationTimeoutMs: services.workflowPreparationTimeoutMs ?? 21 * 60_000,
    netRing,
    failures,
    toastRuns: new Map<string, number>(),
    pumpPokes: new Map<string, () => void>(),
    runPumps: new Map<string, { stopped: boolean }>(),
    activeTurn: undefined,
    commandActor: "user",
    get accountEpoch() { return accountEpoch },
    accountOwner,
    onAccountChange: (listener: () => void) => {
      accountListeners.add(listener)
      return () => { accountListeners.delete(listener) }
    },
    endAccount: () => { advance(null) },
    identityChanged: () => {},
    authReprobeAt: 0,
    loadSession: async () => {},
    resumeWorkflowRuns: () => {},
    observeFlowAuthoring: async () => {},
    resumeFlowAuthoring: () => {},
    resumeDeferredCommand: () => {},
    settleFirstRunTarget: () => {},
    stopWorkflowPumps: () => {},
    contextMessages: () => [],
    gateway: undefined as unknown as GatewaySeam,
    commands: undefined as unknown as CommandRegistry,
    withToast: undefined as unknown as ControllerContext["withToast"],
    resolveToast: undefined as unknown as ControllerContext["resolveToast"],
    unref,
    get disposed() { return disposed || services.pageLifetime?.aborted === true },
    onDispose: (finalizer) => {
      // Registering after disposal runs the finalizer at once, so a late
      // acquisition never leaks either.
      if (disposed) {
        return finalizer()
      }
      finalizers.push(finalizer)
    },
    dispose: () => {
      if (completion !== undefined) return completion
      disposed = true
      let resolve!: () => void
      let reject!: (error: unknown) => void
      completion = new Promise<void>((done, failed) => { resolve = done; reject = failed })
      const closing = completion
      const pending = finalizers.splice(0).reverse()
      // Invoke synchronous releases immediately; only an asynchronous resource
      // delays its host's release. Record the completion before invoking user
      // finalizers, so reentrant disposal cannot run any of them twice.
      void (async () => {
        const errors: unknown[] = []
        // Stop producers before releasing resources they can still call.
        try { ctx.stopWorkflowPumps() } catch (error) { errors.push(error) }
        for (const finalizer of pending) {
          try {
            const result = finalizer()
            if (result === closing) throw new Error("A resource finalizer cannot await its own scope's disposal")
            if (result !== undefined) await result
          } catch (error) { errors.push(error) }
        }
        if (errors.length > 0) throw new AggregateError(errors, "Controller resource cleanup failed")
      })().then(resolve, reject)
      return completion
    },
    http: undefined as unknown as FetchLike,
    boundedFetch: undefined as unknown as ControllerContext["boundedFetch"],
    errorMessageOf: undefined as unknown as ControllerContext["errorMessageOf"]
  } satisfies ControllerContext

  /*
   * The one producer of the account generation. Registered before any
   * controller subscribes, so every later identity subscriber and every
   * resume already reads the new epoch. The wire tap matches the persisted
   * diagnostic scrub, including requests still in flight.
   */
  const ownerChanges = store.collections.identitySessions.subscribeChanges(() => {
    const next = accountOwner()
    const nextProvider = store.collections.identitySessions.get("identity")?.provider
    if (next !== owner || accountProviderChanged(provider, nextProvider)) advance(next)
    provider = nextProvider
  })
  ctx.onDispose(() => { ownerChanges.unsubscribe(); accountListeners.clear() })

  /*
   * Mid-session 401 recovery (multi's AUTH_REQUIRED discipline, one seam):
   * a 401 off any /api call while the app believes it is signed in means the
   * cookie expired — bursts collapse into ONE identity re-probe, and the
   * definitive answer drives the auth conversation state (loadSession never
   * 401s itself: the Worker restates signed-out as 200). A 401 while
   * signed-out is the expected state and probes nothing.
   */
  const noteUnauthorized = (url: string): void => {
    if (!url.includes("/api/") || url.includes("/api/auth/")) return
    const identity = store.collections.identitySessions.get("identity")
    if (identity?.state !== "signed-in") return
    const now = Date.now()
    if (now - ctx.authReprobeAt < 10_000) return
    ctx.authReprobeAt = now
    void ctx.loadSession()
  }
  ctx.http = async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = Date.now()
    const generation = accountEpoch
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    try {
      const response = await rawHttp(input, init)
      recordNet({ at: started, method, url, status: response.status, ms: Date.now() - started }, generation)
      if (response.status === 401) noteUnauthorized(url)
      return response
    } catch (error) {
      recordNet({ at: started, method, url, status: "error", ms: Date.now() - started }, generation)
      throw error
    }
  }
  const seamTimeoutMs = services.seamTimeoutMs ?? 30_000
  const maxResponseBytes = 8 * 1024 * 1024
  /*
   * A request that never answers has to become an answer.
   *
   * §22.6 / A.18: `POST /api/workflow/provision` never replied, so
   * "Preparing your … box…" stood past 120s with no run card, no
   * timeout and no error — the silent-failure family with a spinner on top.
   * A bounded wait turns it into an honest refusal. It rides only on the
   * request/response seams; the streaming paths (the turn, the model relay)
   * carry no deadline, because a long stream is not a hang.
   */
  /**
   * One request, with a deadline covering headers and the complete body.
   *
   * The deadline is Effect's timeout (Ruling B, docs/persistence.md): when
   * it wins, the request fiber is interrupted and tryPromise aborts the
   * fetch's signal and cancels the body reader. Cleanup never waits for the
   * transport to acknowledge cancellation. A settled request clears its clock.
   * The response body is buffered with a byte cap before returning, so callers'
   * json/text reads cannot wait on the network outside this deadline. The
   * public shape stays a promise of a Response rejecting with plain Errors,
   * and the deadline still rejects
   * with `seam timeout`. `Effect.timeout` alone would reject with a
   * `TimeoutError` whose `message` is undefined, so the fallback is explicit.
   */
  ctx.boundedFetch = (url: string, init?: RequestInit): Promise<Response> =>
    Effect.runPromise(
      Effect.tryPromise({
        // Retain caller cancellation through response-body consumption too.
        try: async (signal) => {
          const seamSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal
          const response = await ctx.http(url, { ...init, signal: seamSignal })
          if (seamSignal.aborted) {
            void response.body?.cancel().catch(() => {})
            throw new Error("seam timeout")
          }
          if (response.body === null) return response
          const reader = response.body.getReader()
          const cancel = (): void => { void reader.cancel().catch(() => {}) }
          seamSignal.addEventListener("abort", cancel, { once: true })
          const chunks: Uint8Array[] = []
          let bytes = 0
          try {
            while (true) {
              const chunk = await reader.read()
              if (seamSignal.aborted) throw new Error("seam timeout")
              if (chunk.done) break
              bytes += chunk.value.byteLength
              if (bytes > maxResponseBytes) throw new Error("seam response exceeds 8 MiB")
              chunks.push(chunk.value)
            }
            const body = new Uint8Array(bytes)
            let offset = 0
            for (const chunk of chunks) {
              body.set(chunk, offset)
              offset += chunk.byteLength
            }
            // Some transports expose an empty stream for bodyless responses.
            // Browsers reject even a zero-byte body for 204/205/304.
            const bodyless = response.status === 204 || response.status === 205 || response.status === 304 || init?.method?.toUpperCase() === "HEAD"
            return new Response(bodyless ? null : body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            })
          } finally {
            seamSignal.removeEventListener("abort", cancel)
            cancel()
            reader.releaseLock()
          }
        },
        catch: (error) => (error instanceof Error ? error : new Error(failureDetail(error), { cause: error }))
      }).pipe(
        Effect.timeoutOrElse({
          duration: seamTimeoutMs,
          orElse: () => Effect.fail(new Error("seam timeout"))
        })
      ),
      { signal: init?.signal ?? undefined }
    )
  /* A body's words reach the reader only through refusalLine: a non-JSON body, a 5xx and a Worker code never do. */
  ctx.errorMessageOf = readErrorMessage
  /*
   * The gateway seam rides the same bounded transport every other controller
   * call does, so a workspace that stops answering becomes the seam's own
   * honest refusal rather than a request that never returns.
   */
  ctx.gateway = createGatewaySeam({
    baseUrl: ctx.baseUrl,
    observationGuard: () => {
      const generation = accountEpoch
      return () => !ctx.disposed && generation === accountEpoch
    },
    bindingFor: (repo, runId) => gatewayBindingFor(ctx.store, repo, runId),
    fetch: (url, init) => ctx.boundedFetch(url, init),
    errorMessageOf: (response, fallback) => ctx.errorMessageOf(response, fallback)
  })
  return ctx
}
