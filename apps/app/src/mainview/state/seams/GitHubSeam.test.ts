import type { StorageApi } from "@tanstack/db"
import { afterEach, describe, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import {
  createGitHubSeam,
  lowRateLimit,
  MIRROR_LOST_STREAM_TRIGGER,
  mirrorSyncPolling,
  parseMirrorRef,
  readInstallReturn,
  SIGN_OUT_REFUSAL,
  trustedInstallUrl
} from "./GitHubSeam"
import type { GitHubSeamDeps } from "./GitHubSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The GitHub seam (lane sync, ADR 0005; lane L5 against the live routes):
 * github.app renders the connector-setup card from the status DTO (and
 * files the row in the collection), reconcile posts the repository write route and
 * surfaces its answer verbatim, mirror-sync starts a RUN and tracks its
 * per-ref results while the repository DTO's `mirror_status` word rides the
 * header, and a structured 429 or a low remaining budget renders the ADR's
 * rate-limit line.
 *
 * Every fixture is shaped as plue answers it (verified against `~/plue`
 * main, `internal/routes/git_mirror_sync.go` + `internal/services/
 * git_mirror_sync.go` + `internal/routes/repos.go`). Every route is a
 * double.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const json = (status: number, body: unknown): (() => Response) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const STATUS_PATH = "api/repos/will/smithers/github-app-status"
const REPO_PATH = "api/repos/will/smithers"
const MIRROR_PATH = "api/repos/will/smithers/mirror-sync"
/* plue#490: the per-repository reconcile every WRITER may run. */
const RECONCILE_PATH = "api/repos/will/smithers/github/reconcile"
/* plue#491: one ref's retry; the name is a single escaped segment. */
const REF_RETRY_PATH = "api/repos/will/smithers/github/mirror/refs/refs%2Fheads%2Fwip/retry"

/* The repository DTO, reduced to the one field the mirror card reads. */
const repoDto = (mirrorStatus: string, refs: { readonly behind?: number; readonly failed?: number } = {}) => ({
  id: 1,
  owner: "will",
  name: "smithers",
  full_name: "will/smithers",
  mirror_status: mirrorStatus,
  /* plue#491 (routes.RepoResponse): the counts beside the word. */
  behind_refs: refs.behind ?? 0,
  failed_refs: refs.failed ?? 0,
  last_mirror_at: null,
  last_mirror_error: null
})

/* One mirror run as `GET …/mirror-sync/{run_id}` answers it. */
const mirrorRun = (state: string, refs: ReadonlyArray<Record<string, unknown>> = []) => ({
  state,
  started_at: "2026-09-02T09:00:00Z",
  finished_at: null,
  refs
})

const INSTALLED = {
  github_app_installed: true,
  github_app_configured: true,
  installation_id: 5511,
  install_url: "https://github.com/apps/smithers/installations/new"
}

const MISSING = {
  github_app_installed: false,
  github_app_configured: false,
  install_url: "https://github.com/apps/smithers/installations/new"
}

type Route = () => Response | Promise<Response>

const ownedStores = new Set<AppStore>()
const retireOwners = new Set<() => void>()
const releaseReads = new Set<() => void>()
const pendingWork = new Set<Promise<unknown>>()
const unexpectedRequests: string[] = []
const restorePolling: Array<() => void> = []
let ownedPollDelay = 0

const responseWork = new WeakMap<Response, Set<Promise<unknown>>>()
const observe = <A>(work: Promise<A>, scope?: Set<Promise<unknown>>): Promise<A> => {
  pendingWork.add(work)
  scope?.add(work)
  const complete = () => { pendingWork.delete(work); scope?.delete(work) }
  void work.then(complete, complete)
  return work
}
const checkpoint = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const bounded = async <A>(work: Promise<A>, label: string): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out draining ${label}`)), 5_000)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
const drainWork = async (): Promise<void> => {
  do {
    await Promise.allSettled([...pendingWork])
    await checkpoint()
  } while (pendingWork.size !== 0)
}
const trackResponse = (response: Response, scope = responseWork.get(response)): Response => {
  const json = response.json.bind(response)
  const text = response.text.bind(response)
  const clone = response.clone.bind(response)
  response.json = () => observe(json(), scope)
  response.text = () => observe(text(), scope)
  response.clone = () => trackResponse(clone(), scope)
  return response
}
const drainRead = async (scope: Set<Promise<unknown>>): Promise<void> => {
  do {
    await Promise.allSettled([...scope])
    await checkpoint()
  } while (scope.size !== 0)
}
const settled = async (store: AppStore): Promise<void> => {
  if (store.settled === undefined) throw new Error("Fixture store must own persistence settlement")
  await store.settled()
}
const ownedRead = () => {
  const read = Promise.withResolvers<Response>()
  const work = new Set<Promise<unknown>>()
  observe(read.promise, work)
  const resolve = (response: Response): void => {
    responseWork.set(response, work)
    read.resolve(response)
  }
  releaseReads.add(() => resolve(json(503, { message: "Fixture retired" })()))
  return {
    promise: read.promise,
    resolve,
    reject: read.reject,
    completed: () => bounded(drainRead(work), "held HTTP and its response bodies")
  }
}
const unavailable = (...paths: string[]): Record<string, Route> => Object.fromEntries(
  paths.map(path => [path, () => new Response("404 page not found", { status: 404 })])
)

afterEach(async () => {
  const errors: unknown[] = []
  for (const retire of retireOwners) { try { retire() } catch (error) { errors.push(error) } }
  retireOwners.clear()
  for (const release of releaseReads) { try { release() } catch (error) { errors.push(error) } }
  releaseReads.clear()
  try {
    await bounded(drainWork(), "owned operations and HTTP")
    // The public seam exposes no poll join/cancel handle. Retired polls wake at
    // their real configured cadence, test the owner, and exit before reading.
    if (ownedPollDelay > 0) await new Promise(resolve => setTimeout(resolve, ownedPollDelay))
    await checkpoint()
    await bounded(drainWork(), "retired poll continuations")
  } catch (error) { errors.push(error) }
  ownedPollDelay = 0
  for (const store of ownedStores) {
    try { await settled(store) } catch (error) { errors.push(error) }
    try {
      if (store.dispose === undefined) throw new Error("Fixture store must own disposal")
      await store.dispose()
    } catch (error) { errors.push(error) }
  }
  ownedStores.clear()
  if (unexpectedRequests.length !== 0) errors.push(new Error(`Unexpected fixture HTTP: ${unexpectedRequests.splice(0).join(", ")}`))
  for (const restore of restorePolling.splice(0)) { try { restore() } catch (error) { errors.push(error) } }
  if (errors.length !== 0) throw new AggregateError(errors, "GitHub fixture cleanup failed")
})

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean; readonly isDisposed?: () => boolean } & GitHubSeamDeps = {}
) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  ownedStores.add(store)
  let retired = false
  retireOwners.add(() => { retired = true })
  const requests: Array<string> = []
  const resolved: Array<{ key: string; status: "ok" | "failed" | "cancelled" }> = []
  const ctx: SeamContext = {
    http: (input, init) => observe((async () => {
      const method = init?.method ?? "GET"
      const path = input.startsWith("/") ? input.slice(1) : input
      const key = `${method} ${path}`
      requests.push(key)
      const route = routes[key] ?? routes[path]
      if (route === undefined) {
        unexpectedRequests.push(key)
        throw new Error(`Unexpected fixture HTTP: ${key}`)
      }
      return trackResponse(await route())
    })()),
    baseUrl: "",
    isDisposed: () => retired || options.isDisposed?.() === true,
    store,
    dispatch: transition => {
      if (transition.type === "card.upsert" && transition.card.kind === "sync-ops" && transition.card.payload.runId !== undefined) {
        ownedPollDelay = Math.max(ownedPollDelay, mirrorSyncPolling.delayMs)
      }
      return store.dispatch(transition)
    },
    resolveToast: (key, outcome) => {
      resolved.push({ key, status: outcome.status })
      void store.dispatch({ type: "toast.resolved", actor: "system", key, status: outcome.status, detail: outcome.detail })
    },
    actor: () => "user",
    nextOrdinal: () => 0
  }
  if (options.signedIn !== false) {
    await store.dispatch({
      type: "cloud.session.loaded", actor: "system", state: "signed-in",
      username: "will", expiresAt: null, scopes: null
    }).isPersisted.promise
  }
  await store.dispatch({
    type: "repositories.loaded", actor: "system",
    repositories: [{ id: "will/smithers", org: "will", ownerKind: "user", name: "smithers",
      head: { bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" } }]
  }).isPersisted.promise
  const { signedIn: _signedIn, isDisposed: _isDisposed, ...deps } = options
  const raw = createGitHubSeam(ctx, deps)
  const seam: typeof raw = {
    app: (...args) => observe(raw.app(...args)),
    openInstall: (...args) => observe(raw.openInstall(...args)),
    chooseInstallation: (...args) => observe(raw.chooseInstallation(...args)),
    reconcile: (...args) => observe(raw.reconcile(...args)),
    mirrorSync: (...args) => observe(raw.mirrorSync(...args)),
    retryMirrorRef: (...args) => observe(raw.retryMirrorRef(...args)),
    handleInstallReturn: raw.handleInstallReturn
  }
  return { store, seam, requests, resolved }
}

const textOf = (result: unknown): string | undefined =>
  typeof result === "string" ? result : result !== null && typeof result === "object" && "value" in result && typeof result.value === "string" ? result.value : undefined

/** Spin until a background poll has landed what the assertion needs, or give up loudly. */
const waitUntil = async (ready: () => boolean, label = "the condition"): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`waitUntil gave up on ${label}`)
}

const cardOf = (store: AppStore) => store.collections.cards.get("connector-setup-github-will/smithers")

const payloadOf = (store: AppStore) => {
  const card = cardOf(store)
  return card?.kind === "connector-setup" ? card.payload : undefined
}

const mirrorPayloadOf = (store: AppStore) => {
  const card = store.collections.cards.get("sync-ops-mirror-will/smithers")
  return card?.kind === "sync-ops" ? card.payload : undefined
}

describe("trustedInstallUrl", () => {
  test("only github.com https origins are trusted", () => {
    expect(trustedInstallUrl("https://github.com/apps/smithers/installations/new")).toBe(
      "https://github.com/apps/smithers/installations/new"
    )
    expect(trustedInstallUrl("http://github.com/apps/smithers")).toBeNull()
    expect(trustedInstallUrl("https://github.com.evil.example/apps")).toBeNull()
    expect(trustedInstallUrl("not a url")).toBeNull()
  })
})

describe("lowRateLimit", () => {
  test("under a fifth of the budget is low", () => {
    expect(lowRateLimit({ limit: 5000, remaining: 999 })).toBe(true)
    expect(lowRateLimit({ limit: 5000, remaining: 1000 })).toBe(false)
    expect(lowRateLimit({ limit: 0, remaining: 0 })).toBe(false)
  })
})

describe("readInstallReturn", () => {
  test("a request filed against an org owner is its own answer", () => {
    expect(readInstallReturn("")).toBeNull()
    expect(readInstallReturn("?installation_id=5511&setup_action=install")).toEqual({ kind: "installed", installationId: "5511" })
    /* GitHub files a request instead of an installation when the person cannot administer the org. */
    expect(readInstallReturn("?setup_action=request")).toEqual({ kind: "requested" })
    expect(readInstallReturn("?setup_action=install")).toEqual({ kind: "unusable" })
    expect(readInstallReturn("?installation_id=nope&setup_action=install")).toEqual({ kind: "unusable" })
  })
})

describe("createGitHubSeam", () => {
  test("signed out, every act refuses with the sign-in wording", async () => {
    const { seam } = await harness({}, { signedIn: false })

    expect(textOf(await seam.app())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.openInstall())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.reconcile())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.mirrorSync())).toBe(SIGN_OUT_REFUSAL)
  })

  test("a pending org install request waits on its owner instead of inviting a second one", async () => {
    const { requests, resolved, seam, store } = await harness({})

    expect(seam.handleInstallReturn("?setup_action=request")).toBe(true)
    await waitUntil(() => store.collections.toasts.get("toast-github.install")?.status !== undefined
      && store.collections.toasts.get("toast-github.install")?.status !== "running", "the pending-request toast to settle")

    expect(store.collections.toasts.get("toast-github.install")?.title).toBe("Waiting for an org owner to approve the install.")
    /* The request is filed and waiting; a failed toast would read as Smithers losing it. */
    expect(store.collections.toasts.get("toast-github.install")?.status).toBe("ok")
    /* Only the controller's door dismisses an ok toast, and only a failed one draws a close control. */
    expect(resolved).toEqual([{ key: "github.install", status: "ok" }])
    expect(requests).toEqual([])
  })

  test("a return with nothing usable keeps the failure toast that owns its dismiss control", async () => {
    const { resolved, seam, store } = await harness({})

    expect(seam.handleInstallReturn("?setup_action=install")).toBe(true)
    await waitUntil(() => store.collections.toasts.get("toast-github.install")?.status === "failed", "the unusable-return toast")

    expect(store.collections.toasts.get("toast-github.install")?.title).toBe("Nothing came back from GitHub. Try again?")
    expect(resolved).toEqual([])
  })

  test("an install check that throws shows a product sentence, never the thrown text", async () => {
    const { seam, store } = await harness({
      "api/user/github-app/installations/5511": () => { throw new Error("ECONNRESET secret-socket-detail") }
    })

    expect(seam.handleInstallReturn("?installation_id=5511&setup_action=install")).toBe(true)
    await waitUntil(() => store.collections.toasts.get("toast-github.install")?.status === "failed", "the failed install toast")

    const title = store.collections.toasts.get("toast-github.install")?.title
    expect(title).toBe("Nothing came back from GitHub that I could confirm. Try again?")
    expect(title).not.toContain("secret-socket-detail")
  })

  test("github.app files the status row and renders the connected card", async () => {
    const { store, seam } = await harness({ [STATUS_PATH]: json(200, INSTALLED) })

    const result = await seam.app()

    expect(textOf(result)).toBe("The Smithers GitHub App is installed on will/smithers — the card tracks it.")
    const row = store.collections.githubAppStatuses.get("will/smithers")
    expect(row?.installed).toBe(true)
    expect(row?.configured).toBe(true)
    expect(row?.installationId).toBe(5511)
    expect(row?.installUrl).toBe("https://github.com/apps/smithers/installations/new")
    const card = cardOf(store)
    expect(card?.title).toBe("GitHub · will/smithers")
    expect(card?.status).toBe("acted")
    const payload = payloadOf(store)
    expect(payload?.connector).toBe("github")
    expect(payload?.phase).toBe("connected")
    expect(payload?.installationId).toBe(5511)
    expect(payload?.configured).toBe(true)
  })

  test("github.app on a missing App renders the setup phase with the install link", async () => {
    const { store, seam } = await harness({ [STATUS_PATH]: json(200, MISSING) })

    const result = await seam.app()

    expect(textOf(result)).toBe(
      "The Smithers GitHub App is not installed on will/smithers — the card has the install link."
    )
    const payload = payloadOf(store)
    expect(payload?.phase).toBe("setup")
    expect(payload?.installUrl).toBe("https://github.com/apps/smithers/installations/new")
    expect(cardOf(store)?.status).toBe("active")
  })

  test("github.app with the rate-limit facts under a fifth renders the rate-limit line", async () => {
    const { store, seam } = await harness({
      [STATUS_PATH]: json(200, {
        ...INSTALLED,
        github_rate_limit_limit: 5000,
        github_rate_limit_remaining: 400,
        github_rate_limit_reset: "2026-09-02T13:00:00Z"
      })
    })

    await seam.app()

    expect(payloadOf(store)?.rateLimit).toEqual({ limit: 5000, remaining: 400, resetAt: "2026-09-02T13:00:00Z" })
    expect(store.collections.githubAppStatuses.get("will/smithers")?.rateLimit).toEqual({
      limit: 5000,
      remaining: 400,
      resetAt: "2026-09-02T13:00:00Z"
    })
  })

  test("github.app with a healthy budget renders no rate-limit line", async () => {
    const { store, seam } = await harness({
      [STATUS_PATH]: json(200, {
        ...INSTALLED,
        github_rate_limit_limit: 5000,
        github_rate_limit_remaining: 4900
      })
    })

    await seam.app()

    expect(payloadOf(store)?.rateLimit).toBeUndefined()
    /* The row still carries what the wire said; only the card's line is gated. */
    expect(store.collections.githubAppStatuses.get("will/smithers")?.rateLimit?.remaining).toBe(4900)
  })

  test("github.app on a structured 429 renders the refusal and the rate-limit facts", async () => {
    const { store, seam } = await harness({
      [STATUS_PATH]: json(429, {
        code: "github_rate_limited",
        message: "GitHub rate limit exhausted",
        limit: 5000,
        remaining: 0,
        reset_at: "2026-09-02T13:00:00Z"
      })
    })

    const result = await seam.app()

    const line = "The GitHub App status for will/smithers couldn't be read (429). Something Smithers depends on failed. Not your doing."
    expect(textOf(result)).toBe(line)
    expect(textOf(result)).not.toContain("GitHub rate limit exhausted")
    const payload = payloadOf(store)
    expect(payload?.error).toBe(line)
    expect(payload?.rateLimit).toEqual({ limit: 5000, remaining: 0, resetAt: "2026-09-02T13:00:00Z" })
    expect(cardOf(store)?.status).toBe("error")
    /* No row: nothing was READ, only refused. */
    expect(store.collections.githubAppStatuses.get("will/smithers")).toBeUndefined()
  })

  test("github.app on a plain 429 invents no reset", async () => {
    const { store, seam } = await harness({ [STATUS_PATH]: json(429, { message: "too many requests" }) })

    const result = await seam.app()

    expect(textOf(result)).toBe("too many requests")
    expect(payloadOf(store)?.rateLimit).toBeUndefined()
  })

  test("openInstall opens the trusted install link from the card", async () => {
    const opened: Array<string> = []
    const { seam } = await harness(
      { [STATUS_PATH]: json(200, MISSING) },
      { openExternal: async (url) => (opened.push(url), true) }
    )
    await seam.app()

    await seam.openInstall()

    expect(opened).toEqual(["https://github.com/apps/smithers/installations/new"])
  })

  test("openInstall before any status read points at github.app first", async () => {
    const { seam } = await harness({})

    expect(await seam.openInstall()).toBe("No install link for will/smithers yet — /github.app reads the status first.")
  })

  test("reconcile posts the repository's own route, not the operator's (plue#490)", async () => {
    /* The pre-#502 answer: the run's own fields with no `run_id` alias beside them. */
    const { store, seam, requests } = await harness({
      [`POST ${RECONCILE_PATH}`]: json(202, { id: 91, state: "queued", behind_refs: 0, failed_refs: 0, refs: [] }),
      [STATUS_PATH]: json(200, INSTALLED)
    })

    const result = await seam.reconcile()

    expect(requests[0]).toBe(`POST ${RECONCILE_PATH}`)
    /* The admin route is an operator's; no flow in this app calls it any more. */
    expect(requests.some((request) => request.includes("admin"))).toBe(false)
    expect(textOf(result)).toBe("Reconciled — the GitHub card for will/smithers re-read the App status.")
    expect(payloadOf(store)?.phase).toBe("connected")
    expect(store.collections.githubAppStatuses.get("will/smithers")?.installationId).toBe(5511)
    /* An answer that names no run id is tracked as nothing: no mirror card, no poll. */
    expect(mirrorPayloadOf(store)).toBeUndefined()
    expect(requests.some((request) => request.includes("mirror-sync"))).toBe(false)
  })

  test("reconcile renders the run its 202 names and polls it to settled (plue#502)", async () => {
    const previous = { ...mirrorSyncPolling }
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 6
    try {
      let mirrorStatus = "behind"
      const { store, seam, requests } = await harness({
        /*
         * plue#502: the reconcile answers 202 with the whole mirror run —
         * `run_id` beside its `id` alias — so the card has its rows before
         * the first poll.
         */
        [`POST ${RECONCILE_PATH}`]: json(202, {
          run_id: 91,
          id: 91,
          state: "queued",
          behind_refs: 0,
          failed_refs: 0,
          started_at: null,
          finished_at: null,
          refs: []
        }),
        [STATUS_PATH]: json(200, INSTALLED),
        [REPO_PATH]: () => json(200, repoDto(mirrorStatus, { behind: 2 }))(),
        [`${MIRROR_PATH}/91`]: () => {
          mirrorStatus = "synced"
          return json(200, mirrorRun("succeeded", [
            { name: "refs/heads/main", from: "b775d9", to: "3f2a1b", status: "succeeded", error: "" }
          ]))()
        }
      })

      const result = await seam.reconcile()

      expect(textOf(result)).toBe(
        "Reconciled — the GitHub card for will/smithers re-read the App status; mirror run 91 tracks the refs."
      )
      /* The status re-read still lands: reconcile owns both cards. */
      expect(payloadOf(store)?.phase).toBe("connected")
      const queued = mirrorPayloadOf(store)
      expect(queued?.runId).toBe("91")
      expect(queued?.trigger).toBe("reconcile started · run 91")
      /* The 202 already named the run's state, so the card states it before polling. */
      expect(queued?.runState).toBe("queued")
      expect(queued?.mirrorStatus).toBe("behind")

      await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded", "the reconcile run to settle")
      await waitUntil(() => mirrorPayloadOf(store)?.mirrorStatus === "synced", "the mirror word to follow the run")
      expect(requests).toContain(`GET ${MIRROR_PATH}/91`)
      expect(mirrorPayloadOf(store)?.ops).toEqual([
        {
          id: "refs/heads/main",
          source: "b775d9",
          target: "3f2a1b",
          entity: "ref",
          entityId: "refs/heads/main",
          action: "push",
          status: "succeeded",
          retryable: false,
          at: null
        }
      ])
    } finally {
      restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    }
  })

  test("a reconcile whose status re-read is refused still tracks the run plue started (plue#502)", async () => {
    const previous = { ...mirrorSyncPolling }
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 6
    try {
      const { store, seam } = await harness({
        ...unavailable(REPO_PATH),
        [`POST ${RECONCILE_PATH}`]: json(202, { run_id: 91, id: 91, state: "queued", refs: [] }),
        [STATUS_PATH]: json(502, { message: "github is unreachable" }),
        [`${MIRROR_PATH}/91`]: json(200, mirrorRun("succeeded", []))
      })

      const result = await seam.reconcile()

      /* The refused read says what failed and whose fault it was, on its own card; a 5xx body's words stay hidden. */
      const line = "The GitHub App status for will/smithers couldn't be read (502). Something Smithers depends on failed. Not your doing."
      expect(textOf(result)).toBe(line)
      expect(textOf(result)).not.toContain("github is unreachable")
      expect(payloadOf(store)?.error).toBe(line)
      /* The run the platform started is not dropped with it. */
      expect(mirrorPayloadOf(store)?.runId).toBe("91")
      await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded", "the reconcile run to settle")
    } finally {
      restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    }
  })

  test("reconcile refused for the write scope reads plue's sentence and still re-reads the status", async () => {
    /* plue#490 gates the route on repository write: a reader's 403 is its own sentence. */
    const { store, seam, requests } = await harness({
      [`POST ${RECONCILE_PATH}`]: json(403, { message: "write access required" }),
      [STATUS_PATH]: json(200, INSTALLED)
    })

    const result = await seam.reconcile()

    expect(requests[0]).toBe(`POST ${RECONCILE_PATH}`)
    expect(textOf(result)).toBe("write access required")
    expect(store.collections.githubAppStatuses.get("will/smithers")?.installed).toBe(true)
    expect(payloadOf(store)?.error).toBe("write access required")
    /* A refused reconcile started no run, so no mirror card is invented for one. */
    expect(mirrorPayloadOf(store)).toBeUndefined()
  })

  test("mirrorSync starts a run and carries the repository's own mirror_status word", async () => {
    const { store, seam, requests } = await harness({
      [REPO_PATH]: json(200, repoDto("unconfigured")),
      [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 })
    })

    const result = await seam.mirrorSync()

    expect(requests).toContain(`GET ${REPO_PATH}`)
    expect(textOf(result)).toBe("Mirror run 88 started for will/smithers — the card tracks its refs.")
    const payload = mirrorPayloadOf(store)
    expect(payload?.subject).toBe("will/smithers → GitHub")
    expect(payload?.runId).toBe("88")
    expect(payload?.trigger).toBe("sync started · run 88")
    /* `unconfigured` is the word prod answers today, and it rides the header unchanged. */
    expect(payload?.mirrorStatus).toBe("unconfigured")
    expect(payload?.runState).toBeNull()
    expect(payload?.ops).toEqual([])
  })

  test("a repository DTO the app cannot read leaves the header with NO state word", async () => {
    /* ADR 0005: "from the mirror status DTO once it exists, else no state word at all". */
    const { store, seam } = await harness({ ...unavailable(REPO_PATH), [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 }) })

    await seam.mirrorSync()

    expect(mirrorPayloadOf(store)?.mirrorStatus).toBeUndefined()
  })

  test("the run poll renders one row per ref and stops when the run settles", async () => {
    const previous = { ...mirrorSyncPolling }
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 6
    try {
      let polls = 0
      let mirrorStatus = "behind"
      const { store, seam } = await harness({
        [REPO_PATH]: () => json(200, repoDto(mirrorStatus))(),
        [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 }),
        [`${MIRROR_PATH}/88`]: () => {
          polls += 1
          if (polls < 2) return json(200, mirrorRun("running"))()
          mirrorStatus = "synced"
          return json(200, mirrorRun("succeeded", [
            { name: "refs/heads/main", from: "b775d9", to: "3f2a1b", status: "succeeded", error: "" },
            { name: "refs/heads/wip", from: "", to: "aa11bb", status: "failed", error: "remote rejected: non-fast-forward" }
          ]))()
        }
      })

      await seam.mirrorSync()
      await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded")
      await waitUntil(() => mirrorPayloadOf(store)?.mirrorStatus === "synced")

      const payload = mirrorPayloadOf(store)
      expect(payload?.runState).toBe("succeeded")
      expect(payload?.ops).toEqual([
        {
          id: "refs/heads/main",
          source: "b775d9",
          target: "3f2a1b",
          entity: "ref",
          entityId: "refs/heads/main",
          action: "push",
          status: "succeeded",
          retryable: false,
          at: null
        },
        {
          id: "refs/heads/wip",
          source: "—",
          target: "aa11bb",
          entity: "ref",
          entityId: "refs/heads/wip",
          action: "push",
          status: "failed",
          error: "remote rejected: non-fast-forward",
          /* plue#491: a FAILED ref has its own retry route, so its row carries Retry. */
          retryable: true,
          at: null
        }
      ])
      /* The settled run re-reads the repository: the header word follows the mirror. */
      expect(payload?.mirrorStatus).toBe("synced")
    } finally {
      restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    }
  })

  test("parseMirrorRef keeps the wire's status word and error, and offers a retry only on a failed ref", () => {
    /* plue#491 retries one ref, and refuses the route for any status but `failed`. */
    const ref = parseMirrorRef({ name: "refs/heads/main", from: "b775d9", to: "", status: "pending", error: "" })
    expect(ref).toEqual({
      id: "refs/heads/main",
      source: "b775d9",
      target: "—",
      entity: "ref",
      entityId: "refs/heads/main",
      action: "push",
      status: "pending",
      retryable: false,
      at: null
    })
    expect(parseMirrorRef({ name: "refs/heads/wip", status: "failed", error: "rejected" })?.retryable).toBe(true)
    expect(parseMirrorRef({ name: "refs/heads/wip", status: "succeeded", error: "" })?.retryable).toBe(false)
    expect(parseMirrorRef({ from: "x" })).toBeNull()
  })

  test("the repository's behind_refs and failed_refs ride the card beside its mirror word (plue#491)", async () => {
    const { store, seam } = await harness({
      [REPO_PATH]: json(200, repoDto("behind", { behind: 3, failed: 1 })),
      [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 })
    })

    await seam.mirrorSync()

    const payload = mirrorPayloadOf(store)
    expect(payload?.mirrorStatus).toBe("behind")
    expect(payload?.behindRefs).toBe(3)
    expect(payload?.failedRefs).toBe(1)
  })

  test("a repository DTO that names the word but no counts carries no count", async () => {
    /* ADR 0005: a number the server did not state is never invented for the header. */
    const { store, seam } = await harness({
      [REPO_PATH]: json(200, {
        id: 1,
        owner: "will",
        name: "smithers",
        full_name: "will/smithers",
        mirror_status: "behind"
      }),
      [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 })
    })

    await seam.mirrorSync()

    expect(mirrorPayloadOf(store)?.mirrorStatus).toBe("behind")
    expect(mirrorPayloadOf(store)?.behindRefs).toBeUndefined()
    expect(mirrorPayloadOf(store)?.failedRefs).toBeUndefined()
  })

  test("retryMirrorRef posts the escaped ref and tracks the run plue answered (plue#491)", async () => {
    const previous = { ...mirrorSyncPolling }
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 4
    try {
      const { store, seam, requests } = await harness({
        [REPO_PATH]: json(200, repoDto("behind", { behind: 1, failed: 1 })),
        [`POST ${REF_RETRY_PATH}`]: json(202, { run_id: 92 }),
        [`${MIRROR_PATH}/92`]: json(200, mirrorRun("succeeded", [
          { name: "refs/heads/wip", from: "aa11bb", to: "cc22dd", status: "succeeded", error: "" }
        ]))
      })

      const result = await seam.retryMirrorRef("refs/heads/wip")

      /* The ref name carries slashes and rides as ONE escaped segment. */
      expect(requests).toContain(`POST ${REF_RETRY_PATH}`)
      expect(textOf(result)).toBe(
        "refs/heads/wip is being pushed again on will/smithers — run 92; the card tracks it."
      )
      expect(mirrorPayloadOf(store)?.runId).toBe("92")
      expect(mirrorPayloadOf(store)?.trigger).toBe("refs/heads/wip retried · run 92")
      await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded")
    } finally {
      restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    }
  })

  test("a per-ref retry the platform refuses reads its own sentence and starts no run", async () => {
    const { store, seam } = await harness({
      [REPO_PATH]: json(200, repoDto("behind", { behind: 1, failed: 1 })),
      [`POST ${REF_RETRY_PATH}`]: json(409, { message: "a mirror sync is already running" })
    })

    expect(textOf(await seam.retryMirrorRef("refs/heads/wip"))).toBe("a mirror sync is already running")
    expect(mirrorPayloadOf(store)?.error).toBe("a mirror sync is already running")
    expect(mirrorPayloadOf(store)?.runId).toBeUndefined()
  })

  test("retryMirrorRef without a ref calls nothing", async () => {
    const { seam, requests } = await harness({})
    expect(textOf(await seam.retryMirrorRef("  "))).toBe(
      "github.mirror.retry-ref needs a ref: /github.mirror.retry-ref <ref> [owner/repo]"
    )
    expect(requests).toEqual([])
  })

  test("a run read the server refuses lands its words on the card and stops the poll", async () => {
    const previous = { ...mirrorSyncPolling }
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 6
    try {
      const { store, seam } = await harness({
        ...unavailable(REPO_PATH),
        [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 }),
        [`${MIRROR_PATH}/88`]: json(403, { message: "read:repository scope required" })
      })

      await seam.mirrorSync()
      await waitUntil(() => mirrorPayloadOf(store)?.error !== undefined)

      expect(mirrorPayloadOf(store)?.error).toBe("read:repository scope required")
    } finally {
      restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    }
  })

  test("mirrorSync with no route renders the verbatim 404 on the card", async () => {
    const { store, seam } = await harness(unavailable(REPO_PATH, `POST ${MIRROR_PATH}`))

    const result = await seam.mirrorSync()

    expect(textOf(result)).toBe("The mirror sync failed (404)")
    expect(mirrorPayloadOf(store)?.error).toBe("The mirror sync failed (404)")
  })

  test("mirrorSync on a structured 429 carries the rate-limit facts", async () => {
    const { store, seam } = await harness({
      ...unavailable(REPO_PATH),
      [`POST ${MIRROR_PATH}`]: json(429, {
        code: "github_rate_limited",
        message: "GitHub rate limit exhausted",
        limit: 5000,
        remaining: 0,
        reset_at: "2026-09-02T13:00:00Z"
      })
    })

    const result = await seam.mirrorSync()

    expect(textOf(result)).toBe("The mirror sync failed (429). Something Smithers depends on failed. Not your doing.")
    expect(textOf(result)).not.toContain("GitHub rate limit exhausted")
    expect(mirrorPayloadOf(store)?.rateLimit).toEqual({ limit: 5000, remaining: 0, resetAt: "2026-09-02T13:00:00Z" })
  })
})

describe("GitHub mirror wire admission", () => {
  test.each([
    ["missing", {}],
    ["null", { refs: null }],
    ["object", { refs: { name: "refs/heads/main" } }]
  ])("a terminal run with %s refs preserves the running rows and skips the terminal refresh", async (_case, fields) => {
    const previous = { ...mirrorSyncPolling }
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 3
    const malformed = Promise.withResolvers<Response>()
    try {
      let polls = 0
      let repositoryReads = 0
      let runId = 88
      const { store, seam, requests } = await harness({
        [REPO_PATH]: () => {
          repositoryReads += 1
          return json(200, repoDto(repositoryReads === 1 ? "behind" : "synced"))()
        },
        [`POST ${MIRROR_PATH}`]: () => json(202, { run_id: runId })(),
        [`${MIRROR_PATH}/88`]: () => {
          polls += 1
          return polls === 1
            ? json(200, mirrorRun("running", [
              { name: "refs/heads/main", from: "old", to: "new", status: "pending", error: "" }
            ]))()
            : malformed.promise
        },
        [`${MIRROR_PATH}/89`]: json(200, mirrorRun("succeeded", []))
      })

      await seam.mirrorSync()
      await waitUntil(() => mirrorPayloadOf(store)?.runState === "running" && mirrorPayloadOf(store)?.ops.length === 1)
      await store.settled?.()
      const runningRows = mirrorPayloadOf(store)?.ops
      await waitUntil(() => requests.filter(request => request === `GET ${MIRROR_PATH}/88`).length === 2)
      expect(mirrorPayloadOf(store)?.runState).toBe("running")
      expect(mirrorPayloadOf(store)?.ops).toEqual(runningRows)
      malformed.resolve(json(200, { state: "succeeded", ...fields })())
      await waitUntil(() => mirrorPayloadOf(store)?.error !== undefined, "the malformed run error")

      expect(mirrorPayloadOf(store)?.error).toBe("The mirror run answer for will/smithers was malformed.")
      expect(mirrorPayloadOf(store)?.runState).toBe("running")
      expect(mirrorPayloadOf(store)?.ops).toEqual(runningRows)
      expect(mirrorPayloadOf(store)?.mirrorStatus).toBe("behind")
      expect(repositoryReads).toBe(1)
      expect(requests.filter(request => request === `GET ${MIRROR_PATH}/88`)).toHaveLength(2)

      runId = 89
      await seam.mirrorSync()
      await waitUntil(() => mirrorPayloadOf(store)?.runId === "89" && mirrorPayloadOf(store)?.runState === "succeeded")
      expect(mirrorPayloadOf(store)?.error).toBeUndefined()
      expect(mirrorPayloadOf(store)?.ops).toEqual([])
      expect(requests).toContain(`GET ${MIRROR_PATH}/89`)
      expect(repositoryReads).toBe(3)
    } finally {
      malformed.resolve(json(200, { state: "succeeded", ...fields })())
      Object.assign(mirrorSyncPolling, previous)
    }
  })

  test("a terminal run with refs: [] clears the rows and refreshes the repository", async () => {
    const previous = { ...mirrorSyncPolling }
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 3
    try {
      let polls = 0
      let repositoryReads = 0
      const { store, seam } = await harness({
        [REPO_PATH]: () => {
          repositoryReads += 1
          return json(200, repoDto(repositoryReads === 1 ? "behind" : "synced"))()
        },
        [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 }),
        [`${MIRROR_PATH}/88`]: () => {
          polls += 1
          return polls === 1
            ? json(200, mirrorRun("running", [
              { name: "refs/heads/main", from: "old", to: "new", status: "pending", error: "" }
            ]))()
            : json(200, mirrorRun("succeeded", []))()
        }
      })

      await seam.mirrorSync()
      await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded" && mirrorPayloadOf(store)?.mirrorStatus === "synced")

      expect(mirrorPayloadOf(store)?.ops).toEqual([])
      expect(mirrorPayloadOf(store)?.error).toBeUndefined()
      expect(repositoryReads).toBe(2)
    } finally {
      Object.assign(mirrorSyncPolling, previous)
    }
  })

  test.each(["sync", "retry", "reconcile"] as const)("%s admits only positive run IDs", async action => {
    const previous = { ...mirrorSyncPolling }
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 3
    try {
      const post = action === "sync" ? MIRROR_PATH : action === "retry" ? REF_RETRY_PATH : RECONCILE_PATH
      for (const runId of [0, -1]) {
        const { store, seam, requests } = await harness({
          [REPO_PATH]: json(200, repoDto("behind")),
          [STATUS_PATH]: json(200, INSTALLED),
          [`POST ${post}`]: json(202, { run_id: runId, state: "queued", refs: [] }),
          [`${MIRROR_PATH}/${runId}`]: json(400, { message: "invalid run id" })
        })

        const result = action === "sync" ? await seam.mirrorSync()
          : action === "retry" ? await seam.retryMirrorRef("refs/heads/wip") : await seam.reconcile()

        if (action === "reconcile") {
          expect(textOf(result)).toBe("Reconciled — the GitHub card for will/smithers re-read the App status.")
          expect(payloadOf(store)?.phase).toBe("connected")
          expect(mirrorPayloadOf(store)).toBeUndefined()
        } else {
          expect(mirrorPayloadOf(store)?.runId).toBeUndefined()
          expect(mirrorPayloadOf(store)?.error).toBe(textOf(result))
          expect(textOf(result)).toContain("without naming a run id")
        }
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(requests.filter(request => request.startsWith("POST "))).toEqual([`POST ${post}`])
        expect(requests.some(request => request.startsWith(`GET ${MIRROR_PATH}/`))).toBe(false)
      }

      const { store, seam, requests } = await harness({
        [REPO_PATH]: json(200, repoDto("behind")),
        [STATUS_PATH]: json(200, INSTALLED),
        [`POST ${post}`]: json(202, { run_id: 1, state: "queued", refs: [] }),
        [`${MIRROR_PATH}/1`]: json(200, mirrorRun("succeeded", []))
      })
      if (action === "sync") await seam.mirrorSync()
      else if (action === "retry") await seam.retryMirrorRef("refs/heads/wip")
      else await seam.reconcile()
      await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded", "the admitted positive run")
      expect(mirrorPayloadOf(store)?.runId).toBe("1")
      expect(requests).toContain(`GET ${MIRROR_PATH}/1`)
    } finally {
      Object.assign(mirrorSyncPolling, previous)
    }
  })

  test("legacy reconcile without a run ID still refreshes status without tracking a run", async () => {
    const { store, seam, requests } = await harness({
      [`POST ${RECONCILE_PATH}`]: json(202, { id: 91, state: "queued", refs: [] }),
      [STATUS_PATH]: json(200, INSTALLED)
    })

    expect(textOf(await seam.reconcile())).toBe("Reconciled — the GitHub card for will/smithers re-read the App status.")
    expect(requests).toEqual([`POST ${RECONCILE_PATH}`, `GET ${STATUS_PATH}`])
    expect(payloadOf(store)?.phase).toBe("connected")
    expect(mirrorPayloadOf(store)).toBeUndefined()
  })
})

/*
 * The two fences the mirror poll runs behind: the epoch that retires a
 * superseded loop, and the drop budget that separates a lost connection from
 * a run the platform refused to read out.
 */
describe("the mirror run poll's fences", () => {
  /** A route that answers only when the test releases it, so a poll can be parked. */
  const parked = () => {
    const read = ownedRead()
    return { route: () => read.promise, completed: read.completed, release: (response: Response): void => read.resolve(response) }
  }


  test("a poll parked across two newer runs never writes the run the card stopped tracking", async () => {
    /*
     * Review finding 4: the epoch used to be DELETED when a loop settled, so
     * the third run was handed epoch 1 again and the first run's parked poll
     * passed the fence and wrote its state over the card.
     */
    const previous = { ...mirrorSyncPolling }
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 6
    try {
      const first = parked()
      const third = parked()
      let runId = 88
      const { store, seam, requests } = await harness({
        [REPO_PATH]: json(200, repoDto("behind")),
        [`POST ${MIRROR_PATH}`]: () => json(202, { run_id: runId })(),
        [`${MIRROR_PATH}/88`]: first.route,
        [`${MIRROR_PATH}/89`]: json(200, mirrorRun("succeeded", [])),
        [`${MIRROR_PATH}/90`]: third.route
      })

      /* Run 88's first poll parks; run 89 settles and retires its epoch; run 90 takes the card. */
      await seam.mirrorSync()
      await waitUntil(() => requests.includes(`GET ${MIRROR_PATH}/88`), "run 88's poll to be in flight")
      runId = 89
      await seam.mirrorSync()
      await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded", "run 89 to settle")
      runId = 90
      await seam.mirrorSync()
      expect(mirrorPayloadOf(store)?.runId).toBe("90")

      first.release(
        json(200, mirrorRun("failed", [
          { name: "refs/heads/stale", from: "aa11bb", to: "cc22dd", status: "failed", error: "run 88 lost" }
        ]))()
      )
      await first.completed()

      /* The card still states run 90 and nothing run 88 answered. */
      expect(mirrorPayloadOf(store)?.runId).toBe("90")
      expect(mirrorPayloadOf(store)?.runState).toBeNull()
      expect(mirrorPayloadOf(store)?.ops).toEqual([])
      third.release(json(200, mirrorRun("succeeded", []))())
    } finally {
      restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    }
  })

  const identity = (login: string | null, provider: "github" | "local" = "github") => ({
    type: "identity.session.loaded" as const, actor: "system" as const,
    state: login === null ? "signed-out" as const : "signed-in" as const,
    login, provider, admin: false, scopesPlain: null
  })

  for (const change of ["account", "sign-out", "provider", "away-and-back", "cloud-account", "dispose", "refresh"] as const) {
    test.each(["success", "refusal", "drop"] as const)(`pending mirror %s respects ${change}`, async result => {
      const previous = { ...mirrorSyncPolling }
      mirrorSyncPolling.delayMs = 1
      const read = ownedRead()
      let disposed = false
      try {
        const { store, seam, requests } = await harness({
          [REPO_PATH]: json(200, repoDto("behind")),
          [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 }),
          [`${MIRROR_PATH}/88`]: () => read.promise
        }, { isDisposed: () => disposed })
        await store.dispatch(identity("will")).isPersisted.promise
        await seam.mirrorSync("will/smithers")
        await waitUntil(() => requests.includes(`GET ${MIRROR_PATH}/88`))
        if (change === "dispose") disposed = true
        else if (change === "cloud-account") await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "other", expiresAt: null, scopes: null }).isPersisted.promise
        else {
          await store.dispatch(identity(change === "sign-out" || change === "away-and-back" ? null : change === "account" ? "other" : "will", change === "provider" ? "local" : "github")).isPersisted.promise
          if (change === "away-and-back") await store.dispatch(identity("will")).isPersisted.promise
        }
        const before = structuredClone(mirrorPayloadOf(store)), count = requests.length
        const head = (await store.eventHistory()).head
        if (result === "drop") read.reject(new Error("Old account's socket failure"))
        else read.resolve(result === "refusal" ? json(403, { message: "Old account's private refusal" })() : json(200, mirrorRun("failed", [
          { name: "refs/heads/private", from: "aa", to: "bb", status: "failed", error: "Old account's private failure" }
        ]))())
        await read.completed()
        if (change === "refresh") {
          await waitUntil(() => result === "success" ? mirrorPayloadOf(store)?.runState === "failed" : result === "refusal" ? mirrorPayloadOf(store)?.error !== undefined : mirrorPayloadOf(store)?.trigger === MIRROR_LOST_STREAM_TRIGGER)
        } else {
          await settled(store)
          expect(mirrorPayloadOf(store)).toEqual(before)
          expect((await store.eventHistory()).head).toEqual(head)
          expect(requests).toHaveLength(count)
        }
      } finally {
        read.resolve(json(200, mirrorRun("failed"))())
        restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
      }
    })
  }

  test.each([
    ["sync", "preflight"], ["sync", "launch"], ["retry", "preflight"], ["retry", "launch"],
    ["reconcile", "launch"], ["reconcile", "status"], ["reconcile", "mirror"]
  ] as const)("%s retires across the %s account boundary", async (action, phase) => {
    const held = parked()
    const post = action === "reconcile" ? RECONCILE_PATH : action === "retry" ? REF_RETRY_PATH : MIRROR_PATH
    const heldKey = phase === "launch" ? `POST ${post}` : phase === "status" ? STATUS_PATH : REPO_PATH
    const { store, seam, requests } = await harness({
      [REPO_PATH]: json(200, repoDto("behind")), [STATUS_PATH]: json(200, INSTALLED),
      [`POST ${post}`]: json(202, { run_id: 88 }), [heldKey]: held.route
    })
    await store.dispatch(identity("will")).isPersisted.promise
    const pending = action === "reconcile" ? seam.reconcile("will/smithers") : action === "retry" ? seam.retryMirrorRef("refs/heads/wip", "will/smithers") : seam.mirrorSync("will/smithers")
    await waitUntil(() => requests.includes(heldKey.startsWith("POST") ? heldKey : `GET ${heldKey}`))
    await store.dispatch(identity("other")).isPersisted.promise
    const count = requests.length, head = (await store.eventHistory()).head
    held.release(json(200, phase === "launch" ? { run_id: 88 } : phase === "status" ? INSTALLED : repoDto("behind"))())
    expect(await pending).toBe(SIGN_OUT_REFUSAL)
    await held.completed()
    expect(requests).toHaveLength(count)
    expect(requests.filter(request => request.startsWith("POST"))).toHaveLength(phase === "preflight" ? 0 : 1)
    expect(mirrorPayloadOf(store)).toBeUndefined()
    expect(cardOf(store)).toBeUndefined()
    expect((await store.eventHistory()).head).toEqual(head)
  })

  test("one dropped run read is retried and the run still settles", async () => {
    /* Review finding 3: a single transport drop used to end tracking with an error card. */
    const previous = { ...mirrorSyncPolling }
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 6
    try {
      let polls = 0
      const { store, seam } = await harness({
        [REPO_PATH]: json(200, repoDto("synced")),
        [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 }),
        [`${MIRROR_PATH}/88`]: () => {
          polls += 1
          if (polls === 1) throw new Error("socket hung up")
          return json(200, mirrorRun("succeeded", []))()
        }
      })

      await seam.mirrorSync()
      await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded", "the run to settle after the drop")

      expect(mirrorPayloadOf(store)?.error).toBeUndefined()
      expect(store.collections.cards.get("sync-ops-mirror-will/smithers")?.status).toBe("acted")
    } finally {
      restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    }
  })

  test("drops past the budget hand off honestly, keeping the last state instead of failing the run", async () => {
    const previous = { ...mirrorSyncPolling }
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 20
    try {
      let polls = 0
      const { store, seam } = await harness({
        [REPO_PATH]: json(200, repoDto("behind")),
        [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 }),
        [`${MIRROR_PATH}/88`]: () => {
          polls += 1
          if (polls === 1) return json(200, mirrorRun("running", []))()
          throw new Error("socket hung up")
        }
      })

      await seam.mirrorSync()
      await waitUntil(
        () => mirrorPayloadOf(store)?.trigger === MIRROR_LOST_STREAM_TRIGGER,
        "the lost-stream hand-off"
      )

      /* The run keeps pushing refs upstream: an honest standstill, not an error. */
      expect(mirrorPayloadOf(store)?.runState).toBe("running")
      expect(mirrorPayloadOf(store)?.error).toBeUndefined()
      expect(store.collections.cards.get("sync-ops-mirror-will/smithers")?.status).toBe("active")
      /* One read plus the budget's drops, then the hand-off — never a drop per attempt. */
      expect(polls).toBe(1 + mirrorSyncPolling.networkRetries + 1)
    } finally {
      restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    }
  })
})


describe("GitHub setup account ownership", () => {
  const identity = (login: string | null, provider: "github" | "local" = "github") => ({ type: "identity.session.loaded" as const, actor: "system" as const,
    state: login === null ? "signed-out" as const : "signed-in" as const, login, provider, admin: false, scopesPlain: null })
  const inventory = { repos: [{ fullName: "will/private", installationId: 5511 }] }
  for (const action of ["status", "installation"] as const) for (const change of ["account", "provider", "away-and-back", "dispose", "cloud-sign-out", "refresh"] as const) {
    test.each(["success", "refusal", "drop"] as const)(`${action} %s respects ${change}`, async result => {
      const read = ownedRead()
      let disposed = false
      const path = action === "status" ? STATUS_PATH : "api/user/github-app/installations/5511"
      const { store, seam, requests } = await harness({ [path]: () => read.promise }, { isDisposed: () => disposed })
      await store.dispatch(identity("will")).isPersisted.promise
      const pending = action === "status" ? seam.app("will/smithers") : seam.chooseInstallation("5511")
      await waitUntil(() => requests.includes(`GET ${path}`), "the held setup HTTP to enter")
      if (change === "dispose") disposed = true
      else if (change === "cloud-sign-out") await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null }).isPersisted.promise
      else {
        await store.dispatch(identity(change === "account" ? "other" : change === "away-and-back" ? null : "will", change === "provider" ? "local" : "github")).isPersisted.promise
        if (change === "away-and-back") await store.dispatch(identity("will")).isPersisted.promise
        if (change === "refresh") await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
      }
      const head = (await store.eventHistory()).head
      if (result === "drop") read.reject(new Error("Private setup error"))
      else read.resolve(json(result === "refusal" ? 403 : 200, result === "refusal" ? { message: "Private setup refusal" } : action === "status" ? INSTALLED : inventory)())
      const answer = await pending
      await settled(store)
      if (change === "refresh") {
        if (result === "success") {
          expect(store.collections.githubAppStatuses.get(action === "status" ? "will/smithers" : "will/private")?.installationId).toBe(5511)
          if (action === "installation") expect(store.session().activeRepoKey).toBe("will/private")
        } else if (result === "refusal") expect(textOf(answer)).toContain("Private setup refusal")
        else {
          /* A dropped request's thrown text is never copy. */
          expect(textOf(answer)).not.toContain("Private setup error")
          expect(textOf(answer)).toMatch(action === "status" ? /^Could not reach Smithers Cloud\. / : /^Nothing came back from GitHub that I could confirm\. Try again\?$/)
        }
      } else {
        expect(answer).toBe(SIGN_OUT_REFUSAL)
        expect((await store.eventHistory()).head).toEqual(head)
        expect(cardOf(store)).toBeUndefined()
        expect(store.collections.githubAppStatuses.has("will/private")).toBe(false)
        expect(store.collections.repositories.has("will/private")).toBe(false)
      }
    })
  }

  test("an empty selected installation remains a retryable refusal", async () => {
    const { store, seam } = await harness({ "api/user/github-app/installations/5511": json(200, { repos: [] }) })
    await store.dispatch(identity("will")).isPersisted.promise
    expect(await seam.chooseInstallation("5511")).toContain("No installed repository is visible yet")
    expect(store.collections.toasts.get("toast-github.install")?.status).toBe("failed")
  })

  test("a new owner's chooser never joins the old check, whose completion cannot clear the new check", async () => {
    const reads: Array<ReturnType<typeof ownedRead>> = [], opened: string[] = []
    const { store, seam } = await harness({ "api/user/github-app/installations": () => {
      const read = ownedRead(); reads.push(read); return read.promise
    } }, { openExternal: async url => { opened.push(url); return true } })
    await store.dispatch(identity("will")).isPersisted.promise
    await store.dispatch(identity("first")).isPersisted.promise
    const first = seam.openInstall()
    await waitUntil(() => reads.length === 1)
    await store.dispatch(identity("second")).isPersisted.promise
    const second = seam.openInstall()
    await waitUntil(() => reads.length === 2)
    reads[0]!.resolve(json(200, { repos: [] })())
    expect(await first).toBe(SIGN_OUT_REFUSAL)
    const joined = seam.openInstall()
    await checkpoint()
    expect(reads).toHaveLength(2)
    reads[1]!.resolve(json(200, { repos: [{ fullName: "second/private", installationId: 99 }] })())
    expect(await second).toBeUndefined()
    expect(await joined).toBeUndefined()
    expect(store.session().activeRepoKey).toBe("second/private")
    expect(opened).toEqual([])
  })

  test("multiple installations render the chooser, while one installation adopts its newest repository", async () => {
    let rows = [{ fullName: "one/old", installationId: 1, pushedAt: "2026-01-01" }, { fullName: "two/new", installationId: 2, pushedAt: "2026-02-01" }]
    const { store, seam } = await harness({
      "api/user/github-app/installations": () => json(200, { repos: rows })(),
      "api/user/github-app/installations/2": () => json(200, { repos: rows })()
    }, { openExternal: async () => { throw new Error("No install page for an existing installation") } })
    await store.dispatch(identity("will")).isPersisted.promise
    await store.dispatch(identity("other")).isPersisted.promise
    await seam.openInstall()
    const form = store.collections.cards.get("form-github.app.choose")
    expect(form?.kind === "flow-form" ? form.payload.fields[0]?.options : undefined).toEqual([{ value: "1", label: "one" }, { value: "2", label: "two" }])
    rows = [{ fullName: "two/old", installationId: 2, pushedAt: "2026-01-01" }, { fullName: "two/new", installationId: 2, pushedAt: "2026-02-01" }]
    expect(await seam.chooseInstallation("2")).toBeUndefined()
    expect(store.session().activeRepoKey).toBe("two/new")
    expect(store.collections.repositories.has("two/old")).toBe(true)
  })
})

/* Public admission/recovery controls: HTTP doubles and actual durable stores.
 * Polling cases use real shortened cadence; these are component timing units. */
describe("GitHub public admission and recovery", () => {
  test.each([
    ["invalid JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    ["null", json(200, null)],
    ["wrong required booleans", json(200, { ...INSTALLED, github_app_configured: "true" })]
  ] as const)("status %s refuses without a verified row and recovers", async (_label, bad) => {
    let answer: Route = bad
    const { store, seam, requests } = await harness({ [STATUS_PATH]: () => answer() })
    expect(await seam.app()).toBe("The GitHub App status answer for will/smithers was malformed.")
    await settled(store)
    expect(store.collections.githubAppStatuses.has("will/smithers")).toBe(false)
    expect(cardOf(store)?.status).toBe("error")
    expect(payloadOf(store)?.error).toBe("The GitHub App status answer for will/smithers was malformed.")
    answer = json(200, INSTALLED)
    expect(textOf(await seam.app())).toBe("The Smithers GitHub App is installed on will/smithers — the card tracks it.")
    await settled(store)
    expect(store.collections.githubAppStatuses.get("will/smithers")?.installationId).toBe(5511)
    expect(payloadOf(store)?.phase).toBe("connected")
    expect(payloadOf(store)?.error).toBeUndefined()
    expect(cardOf(store)?.status).toBe("acted")
    expect(requests).toEqual([`GET ${STATUS_PATH}`, `GET ${STATUS_PATH}`])
  })

  test.each([
    ["invalid JSON", () => new Response("not-json", { headers: { "content-type": "application/json" } })],
    ["null", json(200, null)],
    ["mixed invalid repository", json(200, { repos: [{ fullName: "will/valid", installationId: 5511 }, { fullName: "invalid/path/extra", installationId: 5511 }] })]
  ] as const)("installation %s refuses atomically and accepts legacy aliases on retry", async (_label, bad) => {
    const path = "api/user/github-app/installations/5511"
    let answer: Route = bad
    const { store, seam, requests } = await harness({ [path]: () => answer() })
    const repositories = [...store.collections.repositories.values()]
    const active = store.session().activeRepoKey
    expect(await seam.chooseInstallation("5511")).toBe("Smithers Cloud returned an unreadable installation list. Try again.")
    await settled(store)
    expect([...store.collections.repositories.values()]).toEqual(repositories)
    expect(store.session().activeRepoKey).toBe(active)
    expect(store.collections.githubAppStatuses.size).toBe(0)
    expect(store.collections.toasts.get("toast-github.install")?.status).toBe("failed")
    expect(store.collections.toasts.get("toast-github.install")?.title).toBe("Smithers Cloud returned an unreadable installation list. Try again.")
    answer = json(200, { repos: [{ full_name: "will/recovered", installation_id: 5511, pushed_at: "2026-09-02" }] })
    expect(await seam.chooseInstallation("5511")).toBeUndefined()
    await settled(store)
    expect(store.session().activeRepoKey).toBe("will/recovered")
    expect(store.collections.repositories.has("will/recovered")).toBe(true)
    expect(store.collections.repositories.has("will/valid")).toBe(false)
    expect(store.collections.githubAppStatuses.get("will/recovered")?.installationId).toBe(5511)
    expect(requests).toEqual([`GET ${path}`, `GET ${path}`])
  })

  test.each(["", "5511/other"])("invalid chooser ID %s neither reads nor mutates", async id => {
    const { store, seam, requests } = await harness({})
    const head = (await store.eventHistory()).head
    expect(await seam.chooseInstallation(id)).toBe("Choose a GitHub App installation from the list.")
    await settled(store)
    expect((await store.eventHistory()).head).toEqual(head)
    expect(requests).toEqual([])
    expect(store.collections.cards.size).toBe(0)
    expect(store.collections.toasts.size).toBe(0)
  })

  test("native install refusal leaves the chooser retryable and rechecks inventory", async () => {
    const opened: string[] = []
    let opens = false
    const path = "api/user/github-app/installations"
    const { store, seam, requests } = await harness({ [path]: json(200, { repos: [] }) }, {
      openExternal: async url => { opened.push(url); return opens }
    })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [] }).isPersisted.promise
    expect(await seam.openInstall()).toBe("The GitHub install page could not open. Try again.")
    expect(store.collections.toasts.get("toast-github.install")?.status).toBe("failed")
    expect(store.collections.repositories.size).toBe(0)
    opens = true
    expect(await seam.openInstall()).toBeUndefined()
    expect(opened).toEqual([
      "https://github.com/apps/smitherspreviewrelease/installations/new",
      "https://github.com/apps/smitherspreviewrelease/installations/new"
    ])
    expect(requests).toEqual([`GET ${path}`, `GET ${path}`])
    expect(store.collections.repositories.size).toBe(0)
  })

  test.each([
    ["invalid JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    ["null", json(200, null)],
    ["missing state", json(200, { refs: [] })]
  ] as const)("poll %s stops honestly and a new run recovers", async (_label, bad) => {
    const previous = { ...mirrorSyncPolling }
    restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 4
    let id = 88
    const { store, seam, requests } = await harness({
      [REPO_PATH]: json(200, repoDto("behind")),
      [`POST ${MIRROR_PATH}`]: () => json(202, { run_id: id })(),
      [`${MIRROR_PATH}/88`]: bad,
      [`${MIRROR_PATH}/89`]: json(200, mirrorRun("succeeded", []))
    })
    await seam.mirrorSync()
    await waitUntil(() => mirrorPayloadOf(store)?.error !== undefined, "the malformed poll refusal")
    await bounded(drainWork(), "malformed poll response")
    await settled(store)
    expect(mirrorPayloadOf(store)?.error).toBe("The mirror run answer for will/smithers was malformed.")
    expect(mirrorPayloadOf(store)?.runState).toBeNull()
    expect(store.collections.cards.get("sync-ops-mirror-will/smithers")?.status).toBe("error")
    expect(requests.filter(request => request === `GET ${MIRROR_PATH}/88`)).toHaveLength(1)
    id = 89
    await seam.mirrorSync()
    await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded", "the successor run completion")
    await bounded(drainWork(), "successor poll response")
    await settled(store)
    expect(mirrorPayloadOf(store)?.runId).toBe("89")
    expect(mirrorPayloadOf(store)?.error).toBeUndefined()
    expect(store.collections.cards.get("sync-ops-mirror-will/smithers")?.status).toBe("acted")
    expect(requests.filter(request => request === `POST ${MIRROR_PATH}`)).toHaveLength(2)
  })

  test("a successful running read resets the consecutive transport-drop budget", async () => {
    const previous = { ...mirrorSyncPolling }
    restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 7
    let polls = 0, repoReads = 0
    const { store, seam, requests } = await harness({
      [REPO_PATH]: () => json(200, repoDto(++repoReads === 1 ? "behind" : "synced"))(),
      [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 }),
      [`${MIRROR_PATH}/88`]: () => {
        polls += 1
        if (polls === 1 || polls === 3 || polls === 4) throw new Error("controlled socket drop")
        return json(200, mirrorRun(polls === 2 ? "running" : "succeeded", []))()
      }
    })
    await seam.mirrorSync()
    await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded", "completion after separated drops")
    await bounded(drainWork(), "terminal mirror response")
    await settled(store)
    expect(polls).toBe(5)
    expect(mirrorPayloadOf(store)?.mirrorStatus).toBe("synced")
    expect(mirrorPayloadOf(store)?.trigger).toBe("sync started · run 88")
    expect(mirrorPayloadOf(store)?.error).toBeUndefined()
    expect(requests).toEqual([
      `GET ${REPO_PATH}`, `POST ${MIRROR_PATH}`,
      `GET ${MIRROR_PATH}/88`, `GET ${MIRROR_PATH}/88`, `GET ${MIRROR_PATH}/88`,
      `GET ${MIRROR_PATH}/88`, `GET ${MIRROR_PATH}/88`, `GET ${REPO_PATH}`
    ])
  })

  test("the attempt budget keeps the last running receipt without claiming completion", async () => {
    const previous = { ...mirrorSyncPolling }
    restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    mirrorSyncPolling.delayMs = 2
    mirrorSyncPolling.maxAttempts = 3
    let polls = 0
    const { store, seam, requests } = await harness({
      [REPO_PATH]: json(200, repoDto("behind")),
      [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 }),
      [`${MIRROR_PATH}/88`]: () => { polls += 1; return json(200, mirrorRun("running", [
        { name: "refs/heads/main", from: "old", to: "new", status: "pending", error: "" }
      ]))() }
    })
    await seam.mirrorSync()
    await waitUntil(() => polls === 3, "the third allowed read")
    await bounded(drainWork(), "last budgeted HTTP and body")
    await settled(store)
    // Observe the next real cadence boundary. This is a finite timer control,
    // not a public poll-join receipt or an execution-speed assertion.
    await new Promise(resolve => setTimeout(resolve, 2))
    await bounded(drainWork(), "post-budget cadence")
    expect(polls).toBe(3)
    expect(mirrorPayloadOf(store)?.runState).toBe("running")
    expect(mirrorPayloadOf(store)?.error).toBeUndefined()
    expect(mirrorPayloadOf(store)?.trigger).toBe("sync started · run 88")
    expect(mirrorPayloadOf(store)?.ops).toEqual([{
      id: "refs/heads/main", source: "old", target: "new", entity: "ref", entityId: "refs/heads/main",
      action: "push", status: "pending", retryable: false, at: null
    }])
    expect(store.collections.cards.get("sync-ops-mirror-will/smithers")?.status).toBe("active")
    expect(requests).toEqual([`GET ${REPO_PATH}`, `POST ${MIRROR_PATH}`, `GET ${MIRROR_PATH}/88`, `GET ${MIRROR_PATH}/88`, `GET ${MIRROR_PATH}/88`])
  })

  test("non-divisible rate-limit budgets and encoded callbacks retain exact boundaries", () => {
    expect(lowRateLimit({ limit: 7, remaining: 1 })).toBe(true)
    expect(lowRateLimit({ limit: 7, remaining: 2 })).toBe(false)
    expect(readInstallReturn("?installation_id=%35%35%31%31&setup_action=request")).toEqual({ kind: "installed", installationId: "5511" })
    expect(readInstallReturn("?unrelated=value")).toBeNull()
    expect(trustedInstallUrl("https://GITHUB.COM/apps/smithers/installations/new")).toBe("https://github.com/apps/smithers/installations/new")
    expect(trustedInstallUrl("https://github.com@evil.example/apps/smithers")).toBeNull()
  })
})

/* Backend GitMirrorSyncRunStatus requires refs[] (schema GitMirrorSyncRunStatus in docs/api/openapi/_root.yaml);
 * its poll route accepts only positive IDs (git_mirror_sync.go215-222). */
describe("GitHub mirror wire admission", () => {
  test.each([
    ["missing", { state: "succeeded" }],
    ["null", { state: "succeeded", refs: null }],
    ["object", { state: "succeeded", refs: {} }]
  ] as const)("%s refs cannot erase a verified running receipt; a later run recovers", async (_label, malformed) => {
    const previous = { ...mirrorSyncPolling }
    restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 4
    const terminal = ownedRead()
    let runId = 88, polls = 0
    const { store, seam, requests } = await harness({
      [REPO_PATH]: json(200, repoDto("behind")),
      [`POST ${MIRROR_PATH}`]: () => json(202, { run_id: runId })(),
      [`${MIRROR_PATH}/88`]: () => ++polls === 1 ? json(200, mirrorRun("running", [
        { name: "refs/heads/main", from: "old", to: "new", status: "pending", error: "" }
      ]))() : terminal.promise,
      [`${MIRROR_PATH}/89`]: json(200, mirrorRun("succeeded", [
        { name: "refs/heads/main", from: "old", to: "new", status: "succeeded", error: "" }
      ]))
    })
    expect(textOf(await seam.mirrorSync())).toBe("Mirror run 88 started for will/smithers — the card tracks its refs.")
    await waitUntil(() => polls === 2, "the second poll to enter after the persisted running receipt")
    await settled(store)
    expect(mirrorPayloadOf(store)?.runState).toBe("running")
    expect(mirrorPayloadOf(store)?.ops).toEqual([{
      id: "refs/heads/main", source: "old", target: "new", entity: "ref", entityId: "refs/heads/main",
      action: "push", status: "pending", retryable: false, at: null
    }])
    terminal.resolve(json(200, malformed)())
    await terminal.completed()
    await bounded(drainWork(), "malformed terminal response and continuations")
    await settled(store)
    expect({
      error: mirrorPayloadOf(store)?.error,
      runState: mirrorPayloadOf(store)?.runState,
      ops: mirrorPayloadOf(store)?.ops,
      cardStatus: store.collections.cards.get("sync-ops-mirror-will/smithers")?.status,
      requests
    }).toEqual({
      error: "The mirror run answer for will/smithers was malformed.",
      runState: "running",
      ops: [{
        id: "refs/heads/main", source: "old", target: "new", entity: "ref", entityId: "refs/heads/main",
        action: "push", status: "pending", retryable: false, at: null
      }],
      cardStatus: "error",
      requests: [`GET ${REPO_PATH}`, `POST ${MIRROR_PATH}`, `GET ${MIRROR_PATH}/88`, `GET ${MIRROR_PATH}/88`]
    })
    runId = 89
    expect(textOf(await seam.mirrorSync())).toBe("Mirror run 89 started for will/smithers — the card tracks its refs.")
    await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded", "the valid successor terminal receipt")
    await bounded(drainWork(), "successor response bodies")
    await settled(store)
    expect(mirrorPayloadOf(store)?.runId).toBe("89")
    expect(mirrorPayloadOf(store)?.error).toBeUndefined()
    expect(mirrorPayloadOf(store)?.ops).toEqual([{
      id: "refs/heads/main", source: "old", target: "new", entity: "ref", entityId: "refs/heads/main",
      action: "push", status: "succeeded", retryable: false, at: null
    }])
    expect(store.collections.cards.get("sync-ops-mirror-will/smithers")?.status).toBe("acted")
  })

  test("a genuine empty terminal array clears previous ref rows and refreshes repository facts", async () => {
    const previous = { ...mirrorSyncPolling }
    restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 4
    const terminal = ownedRead()
    let polls = 0, repoReads = 0
    const { store, seam, requests } = await harness({
      [REPO_PATH]: () => json(200, repoDto(++repoReads === 1 ? "behind" : "synced"))(),
      [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 }),
      [`${MIRROR_PATH}/88`]: () => ++polls === 1 ? json(200, mirrorRun("running", [
        { name: "refs/heads/main", from: "old", to: "new", status: "pending", error: "" }
      ]))() : terminal.promise
    })
    await seam.mirrorSync()
    await waitUntil(() => polls === 2, "the held terminal read")
    expect(mirrorPayloadOf(store)?.ops).toHaveLength(1)
    terminal.resolve(json(200, mirrorRun("succeeded", []))())
    await terminal.completed()
    await bounded(drainWork(), "empty terminal and repository refresh bodies")
    await settled(store)
    expect(mirrorPayloadOf(store)?.runState).toBe("succeeded")
    expect(mirrorPayloadOf(store)?.ops).toEqual([])
    expect(mirrorPayloadOf(store)?.error).toBeUndefined()
    expect(mirrorPayloadOf(store)?.mirrorStatus).toBe("synced")
    expect(store.collections.cards.get("sync-ops-mirror-will/smithers")?.status).toBe("acted")
    expect(requests).toEqual([`GET ${REPO_PATH}`, `POST ${MIRROR_PATH}`, `GET ${MIRROR_PATH}/88`, `GET ${MIRROR_PATH}/88`, `GET ${REPO_PATH}`])
  })

  test.each([0, -1])("accepted sync POST with run_id %s cannot admit a nonexistent polling URL", async runId => {
    const previous = { ...mirrorSyncPolling }
    restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 2
    const { store, seam, requests } = await harness({
      [REPO_PATH]: json(200, repoDto("behind")),
      [`POST ${MIRROR_PATH}`]: json(202, { run_id: runId }),
      // This explicit refusal models the documented backend boundary if the
      // client incorrectly attempts the invalid URL; it is not allowed traffic.
      [`${MIRROR_PATH}/${runId}`]: json(400, { message: "invalid mirror sync run id" })
    })
    const answer = await seam.mirrorSync()
    await bounded(drainWork(), "accepted launch response")
    await new Promise(resolve => setTimeout(resolve, 1))
    await bounded(drainWork(), "the next real polling cadence")
    await settled(store)
    expect({
      answer: textOf(answer),
      acceptedPosts: requests.filter(request => request === `POST ${MIRROR_PATH}`).length,
      runId: mirrorPayloadOf(store)?.runId,
      runState: mirrorPayloadOf(store)?.runState,
      error: mirrorPayloadOf(store)?.error,
      cardStatus: store.collections.cards.get("sync-ops-mirror-will/smithers")?.status,
      requests
    }).toEqual({
      answer: "Smithers Cloud started the mirror sync for will/smithers without naming a run id.",
      acceptedPosts: 1,
      runId: undefined,
      runState: null,
      error: "Smithers Cloud started the mirror sync for will/smithers without naming a run id.",
      cardStatus: "error",
      requests: [`GET ${REPO_PATH}`, `POST ${MIRROR_PATH}`]
    })
  })

  test("positive run_id 1 admits its exact polling URL and real completion", async () => {
    const previous = { ...mirrorSyncPolling }
    restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 2
    const { store, seam, requests } = await harness({
      [REPO_PATH]: json(200, repoDto("synced")),
      [`POST ${MIRROR_PATH}`]: json(202, { run_id: 1 }),
      [`${MIRROR_PATH}/1`]: json(200, mirrorRun("succeeded", []))
    })
    expect(textOf(await seam.mirrorSync())).toBe("Mirror run 1 started for will/smithers — the card tracks its refs.")
    await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded", "positive run completion")
    await bounded(drainWork(), "positive run and refreshed repository bodies")
    await settled(store)
    expect(mirrorPayloadOf(store)?.runId).toBe("1")
    expect(mirrorPayloadOf(store)?.error).toBeUndefined()
    expect(store.collections.cards.get("sync-ops-mirror-will/smithers")?.status).toBe("acted")
    expect(requests).toEqual([`GET ${REPO_PATH}`, `POST ${MIRROR_PATH}`, `GET ${MIRROR_PATH}/1`, `GET ${REPO_PATH}`])
  })
})

/* The same run-ID admission serves retry; reconcile has a separate legacy
 * accepted-without-run path, already retained in the earlier controls. */
describe("GitHub run-ID caller controls", () => {
  test.each([0, -1, 1])("retry run_id %s preserves accepted POST truth and admits only valid polling", async runId => {
    const previous = { ...mirrorSyncPolling }
    restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 2
    const { store, seam, requests } = await harness({
      [REPO_PATH]: json(200, repoDto("synced")),
      [`POST ${REF_RETRY_PATH}`]: json(202, { run_id: runId }),
      [`${MIRROR_PATH}/${runId}`]: runId === 1 ? json(200, mirrorRun("succeeded", [
        { name: "refs/heads/wip", from: "old", to: "new", status: "succeeded", error: "" }
      ])) : json(400, { message: "invalid mirror sync run id" })
    })
    const answer = await seam.retryMirrorRef("refs/heads/wip")
    if (runId === 1) await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded", "the valid retry completion")
    await bounded(drainWork(), "retry launch and response bodies")
    await new Promise(resolve => setTimeout(resolve, 1))
    await bounded(drainWork(), "the next retry cadence")
    await settled(store)
    if (runId === 1) {
      expect(textOf(answer)).toBe("refs/heads/wip is being pushed again on will/smithers — run 1; the card tracks it.")
      expect(mirrorPayloadOf(store)?.runId).toBe("1")
      expect(mirrorPayloadOf(store)?.runState).toBe("succeeded")
      expect(mirrorPayloadOf(store)?.error).toBeUndefined()
      expect(mirrorPayloadOf(store)?.ops).toEqual([{
        id: "refs/heads/wip", source: "old", target: "new", entity: "ref", entityId: "refs/heads/wip",
        action: "push", status: "succeeded", retryable: false, at: null
      }])
      expect(requests).toEqual([`GET ${REPO_PATH}`, `POST ${REF_RETRY_PATH}`, `GET ${MIRROR_PATH}/1`, `GET ${REPO_PATH}`])
    } else {
      expect({
        answer: textOf(answer), runId: mirrorPayloadOf(store)?.runId, error: mirrorPayloadOf(store)?.error,
        status: store.collections.cards.get("sync-ops-mirror-will/smithers")?.status, requests
      }).toEqual({
        answer: "Smithers Cloud retried refs/heads/wip on will/smithers without naming a run id.",
        runId: undefined,
        error: "Smithers Cloud retried refs/heads/wip on will/smithers without naming a run id.",
        status: "error", requests: [`GET ${REPO_PATH}`, `POST ${REF_RETRY_PATH}`]
      })
    }
  })

  test.each([0, -1])("reconcile run_id %s keeps its accepted reconciliation without inventing a run", async runId => {
    const previous = { ...mirrorSyncPolling }
    restorePolling.push(() => Object.assign(mirrorSyncPolling, previous))
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 2
    const { store, seam, requests } = await harness({
      [`POST ${RECONCILE_PATH}`]: json(202, { run_id: runId, state: "queued", refs: [] }),
      [STATUS_PATH]: json(200, INSTALLED),
      [REPO_PATH]: json(200, repoDto("behind")),
      [`${MIRROR_PATH}/${runId}`]: json(400, { message: "invalid mirror sync run id" })
    })
    const answer = await seam.reconcile()
    await bounded(drainWork(), "reconcile launch and status bodies")
    await new Promise(resolve => setTimeout(resolve, 1))
    await bounded(drainWork(), "the next reconcile cadence")
    await settled(store)
    expect({
      answer: textOf(answer), phase: payloadOf(store)?.phase,
      installationId: store.collections.githubAppStatuses.get("will/smithers")?.installationId,
      mirror: mirrorPayloadOf(store), requests
    }).toEqual({
      answer: "Reconciled — the GitHub card for will/smithers re-read the App status.",
      phase: "connected", installationId: 5511, mirror: undefined,
      requests: [`POST ${RECONCILE_PATH}`, `GET ${STATUS_PATH}`]
    })
  })
})
