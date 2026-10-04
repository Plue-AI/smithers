import { httpCommandSelector } from "./state/CommandSelection"
import type { ClientErrorReporter } from "./state/ClientErrors"
import { isWriterOwnershipError } from "./state/StorageRecoveryContract"
import { selectFirstRunRepository } from "./state/BootRepositoryTarget"
import { Effect } from "effect"
import { hasCapability } from "@smthrs/rpc/AppBootstrap"
import { loadRuntimeApplicationClient } from "./runtime/ApplicationTransport"
import { beginRepositoryEntry, openRequestedRepo, requestedRepo, withoutRepoParam } from "./RepoLink"
import { createBrowserFrameHistory } from "./runtime/FrameHistory"
import { BootstrapFailure, createRuntime, warmBootstrap, unavailableAgent } from "./runtime/Runtime"
import { createAppController } from "./state/AppController"
import type { AppController } from "./state/AppController"
import { createAppStore } from "./state/AppStore"
import { canPaintAppBeforeIdentity, loadControllerBootInputs } from "./ControllerBootMemo"
import { createTurnEraser } from "./runtime/TurnErasure"
import { liveChannel } from "./runtime/LiveChannel"

const promiseEffect = <A>(label: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => isWriterOwnershipError(cause) || cause instanceof BootstrapFailure
      // Keep the cause: the startup panel presents a tagged cause by its `_tag`,
      // and an untagged one's raw text only in Details (failureDetail's "Caused by").
      ? cause : new Error(`Startup could not ${label}.`, { cause })
  })

/*
 * Browser-only boot. Promise-shaped factories enter the Effect program at
 * this boundary.
 *
 * The app's chat is the host's agent: the HTTP agent against the app origin
 * (LOCAL-APP.md), or the unavailable adapter when this runtime has no agent
 * capability. There is no second, in-page loop to choose between.
 */
/** How the one boot runs; AppMount.tsx sets it before the first render. */
export interface ControllerBootOptions {
  readonly clientErrors?: ClientErrorReporter
  /** Keep the address bar on the entry URL (runtime/FrameHistory.ts `keepUrl`). */
  readonly keepUrl?: boolean
}

const bootProgram = (options: ControllerBootOptions = {}) =>
  Effect.gen(function*() {
    // Read the entry URL before the controller exists: creating it installs the
    // frame history, which writes the first history entry within the first
    // frame, long before identity has loaded.
    const requested = yield* Effect.sync(() => requestedRepo(window.location))
    // The entry URL's query, read before frame history rewrites the address bar: the OAuth and
    // GitHub App setup-URL returns ride on it, and by the end of boot it is gone.
    const entrySearch = yield* Effect.sync(() => window.location.search)
    const client = yield* promiseEffect("resolve application backend", loadRuntimeApplicationClient)
    const http = client.fetch
    const bootstrapRead = warmBootstrap(http)
    const { bootstrap, store } = yield* promiseEffect("prepare runtime and persisted state", () =>
      loadControllerBootInputs(() => bootstrapRead, () => createAppStore(undefined, { eraseTurn: createTurnEraser(http) })))
    const repositoryEntryId = yield* Effect.sync(() => store.savedStoreUnavailable ? undefined : beginRepositoryEntry(store, requested))
    const runtime = yield* Effect.sync(() => createRuntime({
      bootstrap,
      http,
    }))
    const agent = yield* Effect.sync(() => runtime.backend.agent ?? unavailableAgent())
    const pageLifetime = new AbortController()
    const controller = yield* Effect.sync(() =>
      createAppController(
        store,
        agent,
        {
          fetchImpl: runtime.http,
          live: liveChannel(),
          // Selection needs a backend that serves it; one that does not advertises no row and turns run on the pinned commands.
          ...(hasCapability(bootstrap, "commands.select") ? { commandSelector: httpCommandSelector(runtime.http, client.baseUrl) } : {}),
          pageLifetime: pageLifetime.signal,
          clientErrors: options.clientErrors,
          baseUrl: client.baseUrl,
          applicationTarget: client.target,
          localIdentity: client.localIdentity,
          applicationIdentity: client.identity,
          authorizeSocket: client.authorizeWebSocket,
          bootstrap: runtime.bootstrap,
          repositoryApp: store.savedStoreUnavailable ? undefined : requested ?? undefined,
          frameHistory: createBrowserFrameHistory(window, { keepUrl: options.keepUrl === true }),
        }
      )
    )

    // Chromium can reject interrupted fetches before pagehide. Fence their
    // observers first; release collections only once the page is hidden.
    window.addEventListener("beforeunload", () => pageLifetime.abort())
    window.addEventListener("pagehide", () => {
      pageLifetime.abort()
      void controller.dispose().catch(() => {})
    })
    // A history-cache restore must reconnect durable work with a fresh scope.
    window.addEventListener("pageshow", event => {
      if (event.persisted && pageLifetime.signal.aborted) window.location.reload()
    })
    // Stop can cancel a navigation after beforeunload without hiding this
    // document. Reconnect its retired scope, unless another page is replacing it.
    type NavigationAttempt = Event & { readonly signal: AbortSignal; readonly destination: { readonly sameDocument: boolean } }
    const navigation = (window as Window & { readonly navigation?: EventTarget }).navigation
    let navigating: NavigationAttempt | undefined
    navigation?.addEventListener("navigate", raw => {
      const attempt = raw as NavigationAttempt
      navigating = attempt
      attempt.signal.addEventListener("abort", () => {
        setTimeout(() => {
          if (pageLifetime.signal.aborted && (navigating === attempt || navigating?.destination.sameDocument)) window.location.reload()
        }, 0)
      }, { once: true })
    })

    // The recorded store is still on disk. A temporary empty store must not
    // route URLs, resume deferred commands through identity, or start new work.
    if (store.savedStoreUnavailable) return controller

    if (!hasCapability(bootstrap, "identity")) {
      yield* promiseEffect("record unavailable identity", () => controller.adoptSession({
        state: "unavailable",
        login: null,
        admin: false
      }))
    } else if (canPaintAppBeforeIdentity({
      requestedRepo: requested,
      hasTranscript: store.collections.cards.size > 0 || store.collections.messages.size > 0,
      identityState: store.collections.identitySessions.get("identity")?.state,
      identityLogin: store.collections.identitySessions.get("identity")?.login,
      accountOwnerLogin: store.collections.identitySessions.get("identity")?.accountOwnerLogin,
    })) {
      /*
       * The desktop shell never gates on sign-in (LOCAL-APP.md), and its
       * identity read rides a proxied seam — a slow or captive network held
       * the whole boot on the session shell for as long as the upstream took.
       * It runs beside the other inventory loads, never on the paint path:
       * identity "unknown" is a first-class state the app already renders,
       * and the answer lands in the store whenever it comes.
       * A fresh anonymous entry is public content: its real controls need
       * not wait on identity. Retained content/account ownership keep the
       * cloud identity barrier.
       */
      yield* Effect.sync(() => {
        // A failed read is an answer too (BootRepositoryTarget.ts): both sides
        // settle, or a rejected identity promise parks a command forever.
        const settle = () => { if (requested === null) selectFirstRunRepository(store, controller.settleFirstRunTarget) }
        void controller.loadSession().then(settle, settle)
      })
    } else {
      /*
       * A web origin — hosted or self-hosted — gates the transcript on the
       * signed-out answer, so the probe stays on the boot path: awaiting it
       * keeps the gate from flashing the opening read first. Same-origin, never a proxy hop.
       */
      yield* promiseEffect("load identity session", () => controller.loadSession())
    }
    // The awaited branch above has its identity answer here; the non-blocking
    // one does not, so this call is its own no-op and the `.then()` decides.
    if (requested === null) yield* Effect.sync(() => selectFirstRunRepository(store, controller.settleFirstRunTarget))
    // `/api/user` above is also the selected backend's Cloud-capability
    // identity; no second native/cloud session probe is started.
    // Both URL rewrites keep the entry's state: on a repository path the
    // frame history stores the frame location there, not in the URL.
    // A GitHub App setup-URL return carries its own parameters.
    if (controller.handleInstallReturn(entrySearch)) {
      window.history.replaceState(window.history.state, "", window.location.pathname)
    }
    if (controller.handleAuthReturn(entrySearch)) {
      window.history.replaceState(window.history.state, "", window.location.pathname)
    }
    // `/owner/name` (or the landing page's `/?repo=owner/name`) preselects a public-catalog repository.
    // The path stays in the address bar; the parameter leaves it.
    if (requested !== null) {
      yield* Effect.sync(() => void openRequestedRepo(controller, runtime.http, requested, repositoryEntryId))
      if (window.location.search !== "") {
        window.history.replaceState(window.history.state, "", withoutRepoParam(window.location))
      }
    }
    return controller
  })

export const runControllerBoot = (options: ControllerBootOptions = {}): Promise<AppController> =>
  Effect.runPromise(bootProgram(options))
