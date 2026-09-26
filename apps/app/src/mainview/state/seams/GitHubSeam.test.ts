import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
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
 * files the row in the collection), reconcile posts plue's admin route and
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

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean; readonly isDisposed?: () => boolean } & GitHubSeamDeps = {}
) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<string> = []
  /* The controller's door (failures.ts), which is the only one that dismisses an ok toast. */
  const resolved: Array<{ key: string; status: "ok" | "failed" | "cancelled" }> = []
  const ctx: SeamContext = {
    http: async (input, init) => {
      const method = init?.method ?? "GET"
      const path = input.startsWith("/") ? input.slice(1) : input
      const key = `${method} ${path}`
      requests.push(key)
      const route = routes[key] ?? routes[path]
      if (route === undefined) return new Response("404 page not found", { status: 404 })
      return route()
    },
    baseUrl: "",
    isDisposed: options.isDisposed,
    store,
    dispatch: store.dispatch,
    resolveToast: (key, outcome) => {
      resolved.push({ key, status: outcome.status })
      void store.dispatch({ type: "toast.resolved", actor: "system", key, status: outcome.status, detail: outcome.detail })
    },
    actor: () => "user",
    nextOrdinal: () => 0
  }
  if (options.signedIn !== false) {
    await store.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: "signed-in",
      username: "will",
      expiresAt: null,
      scopes: null
    })
  }
  await store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [
      {
        id: "will/smithers",
        org: "will",
        ownerKind: "user",
        name: "smithers",
        head: { bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" }
      }
    ]
  })
  const { signedIn: _signedIn, isDisposed: _isDisposed, ...deps } = options
  return { store, seam: createGitHubSeam(ctx, deps), requests, resolved }
}

const textOf = (result: unknown): string | undefined =>
  typeof result === "string" ? result : (result as { value?: string } | null | undefined)?.value

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

    expect(textOf(result)).toBe("GitHub rate limit exhausted")
    const payload = payloadOf(store)
    expect(payload?.error).toBe("GitHub rate limit exhausted")
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
      Object.assign(mirrorSyncPolling, previous)
    }
  })

  test("a reconcile whose status re-read is refused still tracks the run plue started (plue#502)", async () => {
    const previous = { ...mirrorSyncPolling }
    mirrorSyncPolling.delayMs = 1
    mirrorSyncPolling.maxAttempts = 6
    try {
      const { store, seam } = await harness({
        [`POST ${RECONCILE_PATH}`]: json(202, { run_id: 91, id: 91, state: "queued", refs: [] }),
        [STATUS_PATH]: json(502, { message: "github is unreachable" }),
        [`${MIRROR_PATH}/91`]: json(200, mirrorRun("succeeded", []))
      })

      const result = await seam.reconcile()

      /* The refused read is answered in the server's own words, on its own card. */
      expect(textOf(result)).toBe("github is unreachable")
      expect(payloadOf(store)?.error).toBe("github is unreachable")
      /* The run the platform started is not dropped with it. */
      expect(mirrorPayloadOf(store)?.runId).toBe("91")
      await waitUntil(() => mirrorPayloadOf(store)?.runState === "succeeded", "the reconcile run to settle")
    } finally {
      Object.assign(mirrorSyncPolling, previous)
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
    const { store, seam } = await harness({ [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 }) })

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
      Object.assign(mirrorSyncPolling, previous)
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
      Object.assign(mirrorSyncPolling, previous)
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
        [`POST ${MIRROR_PATH}`]: json(202, { run_id: 88 }),
        [`${MIRROR_PATH}/88`]: json(403, { message: "read:repository scope required" })
      })

      await seam.mirrorSync()
      await waitUntil(() => mirrorPayloadOf(store)?.error !== undefined)

      expect(mirrorPayloadOf(store)?.error).toBe("read:repository scope required")
    } finally {
      Object.assign(mirrorSyncPolling, previous)
    }
  })

  test("mirrorSync with no route renders the verbatim 404 on the card", async () => {
    const { store, seam } = await harness({})

    const result = await seam.mirrorSync()

    expect(textOf(result)).toBe("The mirror sync failed (404)")
    expect(mirrorPayloadOf(store)?.error).toBe("The mirror sync failed (404)")
  })

  test("mirrorSync on a structured 429 carries the rate-limit facts", async () => {
    const { store, seam } = await harness({
      [`POST ${MIRROR_PATH}`]: json(429, {
        code: "github_rate_limited",
        message: "GitHub rate limit exhausted",
        limit: 5000,
        remaining: 0,
        reset_at: "2026-09-02T13:00:00Z"
      })
    })

    const result = await seam.mirrorSync()

    expect(textOf(result)).toBe("GitHub rate limit exhausted")
    expect(mirrorPayloadOf(store)?.rateLimit).toEqual({ limit: 5000, remaining: 0, resetAt: "2026-09-02T13:00:00Z" })
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
    let release: (response: Response) => void = () => {}
    const answer = new Promise<Response>((resolve) => {
      release = resolve
    })
    return { route: () => answer, release: (response: Response): void => release(response) }
  }

  const settleTicks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

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
        ]))() as Response
      )
      await settleTicks()

      /* The card still states run 90 and nothing run 88 answered. */
      expect(mirrorPayloadOf(store)?.runId).toBe("90")
      expect(mirrorPayloadOf(store)?.runState).toBeNull()
      expect(mirrorPayloadOf(store)?.ops).toEqual([])
      third.release(json(200, mirrorRun("succeeded", []))() as Response)
    } finally {
      Object.assign(mirrorSyncPolling, previous)
    }
  })

  const identity = (login: string | null, provider: "github" | "local" = "github") => ({
    type: "identity.session.loaded" as const, actor: "system" as const,
    state: login === null ? "signed-out" as const : "signed-in" as const,
    login, provider, allowlisted: login !== null, admin: false, scopesPlain: null
  })

  for (const change of ["account", "sign-out", "provider", "away-and-back", "cloud-account", "dispose", "refresh"] as const) {
    test.each(["success", "refusal", "drop"] as const)(`pending mirror %s respects ${change}`, async result => {
      const previous = { ...mirrorSyncPolling }
      mirrorSyncPolling.delayMs = 1
      const read = Promise.withResolvers<Response>()
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
        if (change === "refresh") {
          await waitUntil(() => result === "success" ? mirrorPayloadOf(store)?.runState === "failed" : result === "refusal" ? mirrorPayloadOf(store)?.error !== undefined : mirrorPayloadOf(store)?.trigger === MIRROR_LOST_STREAM_TRIGGER)
        } else {
          await settleTicks()
          await store.settled?.()
          expect(mirrorPayloadOf(store)).toEqual(before)
          expect((await store.eventHistory()).head).toEqual(head)
          expect(requests).toHaveLength(count)
        }
      } finally {
        read.resolve(json(200, mirrorRun("failed"))())
        Object.assign(mirrorSyncPolling, previous)
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
    await settleTicks()
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
      Object.assign(mirrorSyncPolling, previous)
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
      Object.assign(mirrorSyncPolling, previous)
    }
  })
})
