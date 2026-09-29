import type { StorageApi } from "@tanstack/db"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { REPO_IMPORT_LOST_STREAM_DETAIL, repoImportPolling } from "./RepoImportSeam"

/*
 * The repo-import seam: /repos.import starts POST /api/github/import, tracks
 * the job on ONE upserted "repo-import" card (stable id, stable ordinal), and
 * polls GET /api/github/import/{jobId} to a terminal phase. Failures answer
 * honest strings — the seam never throws.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Spin until the predicate holds — the poll loop runs on real (1ms) timers. */
const until = async (predicate: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Routes the import endpoints behind the `/api/cloud/*` proxy; everything else answers 404. */
const importBackend = (
  start: () => Response | Promise<Response>,
  poll?: () => Response | Promise<Response>,
  retry?: () => Response | Promise<Response>
): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const path = new URL(url, "https://app.test").pathname
    const method = init?.method ?? "GET"
    if (path === "/api/github/import" && method === "POST") return start()
    if (path.startsWith("/api/github/import/") && path.endsWith("/retry") && method === "POST") {
      if (retry === undefined) return json(404, { message: `no retry stub for ${path}` })
      return retry()
    }
    if (path.startsWith("/api/github/import/") && method === "GET") {
      if (poll === undefined) return json(404, { message: `no poll stub for ${path}` })
      return poll()
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

/** Answers each poll in order, repeating the last answer once exhausted. */
const pollSequence = (answers: ReadonlyArray<() => Response>) => {
  let index = 0
  return () => {
    const answer = answers[Math.min(index, answers.length - 1)] as () => Response
    index += 1
    return answer()
  }
}

/** The reference wire shape (multi githubImport.ts parseImportJob). */
const jobBody = (
  status: "cloning" | "ready" | "failed",
  stage: string | null = null,
  error: string | null = null
) => ({
  importJobId: "job-1",
  repoOwner: "will",
  repoName: "flows",
  status,
  ...(stage === null ? {} : { stage }),
  ...(error === null ? {} : { error }),
  target_bookmark: "main",
  created_at: "2026-08-12T09:00:00.000Z",
  updated_at: "2026-08-12T09:00:00.000Z"
})

const freshController = async (services: AppServices) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    controller: createAppController(store, unavailableAgent, services)
  }
}

const signedIn = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const reposLoaded = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: ["will/flows"].map((fullName) => ({
      id: fullName,
      org: fullName.split("/")[0] ?? "",
      ownerKind: "user",
      name: fullName.split("/")[1] ?? "",
      head: null
    }))
  })
  await settled()
}

const readyStore = async (services: AppServices) => {
  const built = await freshController(services)
  await signedIn(built.store)
  await reposLoaded(built.store)
  return built
}

const CARD_ID = "repo-import-will/flows"

const importCard = (store: AppStore) =>
  store.collections.cards.get(CARD_ID) as Extract<Card, { kind: "repo-import" }> | undefined

/** Every journaled card.upsert of the import card, in dispatch order. */
const importUpserts = (store: AppStore): ReadonlyArray<Extract<Card, { kind: "repo-import" }>> =>
  [...store.collections.transitions.values()]
    .filter((record) => record.type === "card.upsert")
    .sort((a, b) => a.revision - b.revision)
    .map((record) => (JSON.parse(record.payload) as { card: Card }).card)
    .filter((card): card is Extract<Card, { kind: "repo-import" }> => card.kind === "repo-import")

beforeAll(() => {
  // The loop is setTimeout-driven; a 1ms cadence keeps the suite honest AND fast.
  repoImportPolling.delayMs = 1
})

afterAll(() => {
  repoImportPolling.delayMs = 2_000
})

describe("repo import — the happy path", () => {
  test("starting → running → done on one card with one stable ordinal", async () => {
    const { store, controller } = await readyStore(
      importBackend(
        () => json(202, jobBody("cloning", "resolving")),
        pollSequence([
          () => json(200, jobBody("cloning", "pushing_mirror")),
          () => json(200, jobBody("ready", "provisioning_workspace"))
        ])
      )
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    // Success = the job STARTED and the card tracks it — not finished yet.
    expect(outcome.status).toBe("executed")
    expect(importCard(store)?.payload.phase).toBe("running")
    expect(importCard(store)?.payload.jobId).toBe("job-1")

    await until(() => importCard(store)?.payload.phase === "done", "the done phase")
    const card = importCard(store)
    expect(card?.status).toBe("acted")
    expect(card?.title).toBe("Import · will/flows")

    const upserts = importUpserts(store)
    const phases = upserts.map((entry) => entry.payload.phase)
    expect(phases[0]).toBe("starting")
    expect(phases).toContain("running")
    expect(phases[phases.length - 1]).toBe("done")
    // The creation-time ordinal rides every upsert — the card never jumps.
    const ordinals = new Set(upserts.map((entry) => entry.ordinal))
    expect(ordinals.size).toBe(1)
    expect(card?.ordinal).toBe(upserts[0]?.ordinal as number)
    // Statuses track the phases: active while moving, acted at the end.
    expect(upserts.map((entry) => entry.status)).toEqual([
      ...upserts.slice(0, -1).map(() => "active" as const),
      "acted"
    ])
  })

  test("a poll's stage surfaces as the card's human detail", async () => {
    const { store, controller } = await readyStore(
      importBackend(
        () => json(202, jobBody("cloning", "resolving")),
        pollSequence([
          () => json(200, jobBody("cloning", "cloning_github")),
          () => json(200, jobBody("ready"))
        ])
      )
    )
    await controller.commands.run("repos.import", "will/flows")
    await until(() => importCard(store)?.payload.phase === "done", "the done phase")
    const details = importUpserts(store).map((entry) => entry.payload.detail)
    expect(details).toContain("Downloading from GitHub…")
  })
})

describe("repo import — already imported", () => {
  test("an unclassified 409 remains a retryable failure", async () => {
    const { store, controller } = await readyStore(
      importBackend(() => json(409, { message: "repository 'flows' already exists" }))
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    await until(() => importCard(store)?.payload.phase === "failed", "the refused import")
    const card = importCard(store)
    expect(card?.payload.phase).toBe("failed")
    expect(card?.payload.detail).toBe("repository 'flows' already exists")
    expect(card?.status).toBe("error")
  })

  test("an already-active 409 tracks its named job without claiming completion", async () => {
    let release!: (response: Response) => void
    const poll = new Promise<Response>(resolve => { release = resolve })
    const { store, controller } = await readyStore(importBackend(() => json(409, {
      code: "github_import_already_active", importJobId: "job-1",
      message: "this GitHub repository is already being imported"
    }), () => poll))
    await controller.commands.run("repos.import", "will/flows")
    await until(() => importCard(store)?.payload.phase === "running", "the already-active receipt")
    expect(importCard(store)?.payload.detail).toBe("this GitHub repository is already being imported")
    expect(importCard(store)?.payload.jobId).toBe("job-1")
    expect(importCard(store)?.status).toBe("active")
    release(json(200, jobBody("ready")))
    await until(() => importCard(store)?.payload.phase === "done", "the actual completion")
    controller.dispose()
  })

  test("the poll budget outlives a large clone: thirty minutes at the production cadence", () => {
    expect(repoImportPolling.maxAttempts * 2_000).toBeGreaterThanOrEqual(30 * 60_000)
  })

  test("a start answer already 'ready' is stated as already imported", async () => {
    const { store, controller } = await readyStore(
      importBackend(() => json(202, jobBody("ready")))
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    expect(importCard(store)?.payload.phase).toBe("done")
    expect(importCard(store)?.payload.detail).toBe("already imported")
  })
})

describe("repo import — honest failures", () => {
  test("a 500 start is acknowledged immediately and remains visible on the card", async () => {
    const { store, controller } = await readyStore(
      importBackend(() => json(500, { message: "the mirror pool is full" }))
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    await until(() => importCard(store)?.payload.phase === "failed", "the failed launch")
    const card = importCard(store)
    expect(card?.payload.phase).toBe("failed")
    expect(card?.status).toBe("error")
    expect(card?.payload.detail).toBe("the mirror pool is full")
  })

  test("a network throw on start answers an honest string, never a throw", async () => {
    const { store, controller } = await readyStore({
      fetchImpl: async () => {
        throw new Error("socket dropped")
      }
    })
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    await until(() => importCard(store)?.payload.phase === "failed", "the failed launch")
    const card = importCard(store)
    expect(card?.payload.phase).toBe("failed")
    expect(card?.status).toBe("error")
    /* The thrown text is diagnostics, never the card's sentence. */
    expect(card?.payload.detail).toBe("The import couldn't start. Nothing answered; try again.")
    expect(JSON.stringify(card)).not.toContain("socket dropped")
  })

  test("a failed job lands the job's error on the card", async () => {
    const { store, controller } = await readyStore(
      importBackend(
        () => json(202, jobBody("cloning", "resolving")),
        pollSequence([() => json(200, jobBody("failed", "cloning_github", "clone timed out"))])
      )
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    await until(() => importCard(store)?.payload.phase === "failed", "the failed phase")
    const card = importCard(store)
    expect(card?.status).toBe("error")
    expect(card?.payload.detail).toBe("clone timed out")
  })

  test("a poll the server refuses reads its message verbatim with Retry — never the lost-stream detail", async () => {
    /* Review finding 6: any non-OK poll counted as a drop and, after three, read as a lost stream. */
    const { store, controller } = await readyStore(
      importBackend(
        () => json(202, jobBody("cloning", "resolving")),
        () => json(500, { message: "the mirror pool is full" })
      )
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    await until(() => importCard(store)?.payload.phase === "failed", "the failed phase")
    const card = importCard(store)
    expect(card?.status).toBe("error")
    expect(card?.payload.detail).toBe("the mirror pool is full")
    expect(card?.payload.error).toBe("the mirror pool is full")
    expect(card?.payload.jobId).toBe("job-1")
    expect(importUpserts(store).some((entry) => entry.payload.detail === REPO_IMPORT_LOST_STREAM_DETAIL)).toBe(false)
  })

  test("a structured 429 during polling lands the rate-limit facts and the message on the card", async () => {
    const { store, controller } = await readyStore(
      importBackend(
        () => json(202, jobBody("cloning", "resolving")),
        () =>
          json(429, {
            code: "github_rate_limited",
            message: "GitHub rate limit exhausted",
            limit: 5000,
            remaining: 0,
            reset_at: "2026-09-02T13:00:00Z"
          })
      )
    )
    await controller.commands.run("repos.import", "will/flows")
    await until(() => importCard(store)?.payload.phase === "failed", "the failed phase")
    const card = importCard(store)
    expect(card?.payload.detail).toBe("GitHub rate limit exhausted")
    expect(card?.payload.rateLimit).toEqual({ limit: 5000, remaining: 0, resetAt: "2026-09-02T13:00:00Z" })
  })

  test("persistent poll failures give up honestly with the lost-stream detail", async () => {
    const { store, controller } = await readyStore(
      importBackend(
        () => json(202, jobBody("cloning", "resolving")),
        () => {
          throw new Error("poll dropped")
        }
      )
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    await until(
      () => importCard(store)?.payload.detail === REPO_IMPORT_LOST_STREAM_DETAIL,
      "the lost-stream detail"
    )
    const card = importCard(store)
    // Honest standstill: the job may still run upstream — active, not failed.
    expect(card?.payload.phase).toBe("running")
    expect(card?.status).toBe("active")
  })
})

describe("repo import — lane sync", () => {
  test("the job's counts, repository, and workspace land on the card as the wire carries them", async () => {
    const withProgress = {
      ...jobBody("cloning", "importing_refs"),
      counts: {
        refs: { done: 214, total: 214 },
        objects: { done: 900, total: 1200 },
        issues: { done: 3, total: 41 }
      }
    }
    const doneBody = {
      ...jobBody("ready", "provisioning_workspace"),
      workspace_id: "ws-9",
      repository: { owner: "will", name: "flows" }
    }
    const { store, controller } = await readyStore(
      importBackend(
        () => json(202, withProgress),
        pollSequence([() => json(200, doneBody)])
      )
    )
    await controller.commands.run("repos.import", "will/flows")

    /* The start answer's counts render while the job runs. */
    expect(importCard(store)?.payload.counts).toEqual({
      refs: { done: 214, total: 214 },
      objects: { done: 900, total: 1200 },
      issues: { done: 3, total: 41 }
    })

    await until(() => importCard(store)?.payload.phase === "done", "the done phase")
    const card = importCard(store)
    expect(card?.payload.repository).toEqual({ owner: "will", name: "flows" })
    expect(card?.payload.workspaceId).toBe("ws-9")
  })

  test("a structured 429 start lands the refusal and the rate-limit facts on the card", async () => {
    const { store, controller } = await readyStore(
      importBackend(() =>
        json(429, {
          code: "github_rate_limited",
          message: "GitHub rate limit exhausted",
          limit: 5000,
          remaining: 0,
          reset_at: "2026-09-02T13:00:00Z"
        })
      )
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    await until(() => importCard(store)?.payload.phase === "failed", "the rate-limited launch")
    const card = importCard(store)
    expect(card?.payload.detail).toBe("GitHub rate limit exhausted")
    expect(card?.payload.rateLimit).toEqual({ limit: 5000, remaining: 0, resetAt: "2026-09-02T13:00:00Z" })
  })

  test("repos.import.retry re-runs the failed job on the same card slot", async () => {
    const { store, controller } = await readyStore(
      importBackend(
        () => json(202, jobBody("cloning", "resolving")),
        pollSequence([
          () => json(200, jobBody("failed", "cloning_github", "clone timed out")),
          () => json(200, jobBody("ready", "provisioning_workspace"))
        ]),
        () => json(202, jobBody("cloning", "resolving"))
      )
    )
    await controller.commands.run("repos.import", "will/flows")
    await until(() => importCard(store)?.payload.phase === "failed", "the failed phase")
    const ordinalBefore = importCard(store)?.ordinal

    const retry = await controller.commands.run("repos.import.retry", "job-1")
    expect(retry.status).toBe("executed")
    expect(importCard(store)?.payload.phase).toBe("running")
    expect(importCard(store)?.ordinal).toBe(ordinalBefore)

    await until(() => importCard(store)?.payload.phase === "done", "the retried done phase")
    expect(importCard(store)?.status).toBe("acted")
  })

  test("repos.import.retry without a tracked job refuses honestly", async () => {
    const { controller } = await readyStore(importBackend(() => json(202, jobBody("cloning"))))
    const outcome = await controller.commands.run("repos.import.retry", "job-nope")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "No import card tracks job job-nope — the retry button lives on the failed import's card."
      )
    }
  })
})

/*
 * The epoch fence between an import's tracking loop and the starts that
 * supersede it.
 */
describe("repo import — instant background lifecycle", () => {
  test("the public command returns before launch, deduplicates, and keeps one toast through remote completion", async () => {
    let releaseLaunch: (response: Response) => void = () => {}
    const launch = new Promise<Response>((resolve) => { releaseLaunch = resolve })
    let releasePoll: (response: Response) => void = () => {}
    const poll = new Promise<Response>((resolve) => { releasePoll = resolve })
    let starts = 0
    const { store, controller } = await readyStore({
      toastDebounceMs: 5,
      fetchImpl: async (input, init) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://app.test").pathname
        if (path === "/api/github/import" && (init?.method ?? "GET") === "POST") { starts += 1; return launch }
        if (path.endsWith("/github/import/job-1")) return poll
        return json(404, {})
      }
    })
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    expect(importCard(store)?.payload.phase).toBe("starting")
    expect((await controller.commands.run("chat.open")).status).toBe("executed")
    expect(await controller.commands.run("repos.import", "will/flows")).toMatchObject({ status: "executed" })
    expect(starts).toBe(1)
    await until(() => store.collections.toasts.get("toast-repos.import.will/flows")?.status === "running", "the import toast")
    releaseLaunch(json(202, jobBody("cloning", "resolving")))
    await until(() => importCard(store)?.payload.phase === "running", "the running receipt")
    expect(store.collections.toasts.get("toast-repos.import.will/flows")?.status).toBe("running")
    releasePoll(json(200, jobBody("ready", "provisioning_workspace")))
    await until(() => store.collections.toasts.get("toast-repos.import.will/flows")?.status === "ok", "the completed toast")
    expect(importCard(store)?.payload.phase).toBe("done")
  })

  test("reload reconnects a persisted running job without launching another import", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await signedIn(store)
    await reposLoaded(store)
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: CARD_ID, kind: "repo-import", title: "Import · will/flows", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: "will/flows", jobId: "job-1", phase: "running", detail: null,
        requestId: "persisted-request", requestKind: "start", accountOwner: "will" }
    } }).isPersisted.promise
    let starts = 0
    let polls = 0
    createAppController(store, unavailableAgent, {
      toastDebounceMs: 0,
      fetchImpl: async (input, init) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://app.test").pathname
        if ((init?.method ?? "GET") === "POST") { starts += 1; return json(500, {}) }
        if (path.endsWith("/github/import/job-1")) { polls += 1; return json(200, jobBody("ready")) }
        return json(404, {})
      }
    })
    await until(() => importCard(store)?.payload.phase === "done", "the reconnected import")
    expect(starts).toBe(0)
    expect(polls).toBe(1)
  })

  test("reload observes an unresolved retry before deciding whether to repeat it", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await signedIn(store)
    await reposLoaded(store)
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: CARD_ID, kind: "repo-import", title: "Import · will/flows", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: "will/flows", jobId: "job-1", phase: "starting", detail: null,
        requestId: "persisted-retry", requestKind: "retry", accountOwner: "will" }
    } }).isPersisted.promise
    let retries = 0
    createAppController(store, unavailableAgent, {
      fetchImpl: async (input, init) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://app.test").pathname
        if (path.endsWith("/retry") && init?.method === "POST") { retries += 1; return json(409, { message: "only failed import jobs can be retried" }) }
        if (path.endsWith("/github/import/job-1")) return json(200, jobBody("ready"))
        return json(404, {})
      }
    })
    await until(() => importCard(store)?.payload.phase === "done", "the recovered retry receipt")
    expect(retries).toBe(0)
  })

  test("retry recovery does not POST after its held observation crosses an owner switch", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await signedIn(store)
    await reposLoaded(store)
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: CARD_ID, kind: "repo-import", title: "Import · will/flows", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: "will/flows", jobId: "job-1", phase: "starting", detail: null,
        requestId: "persisted-retry", requestKind: "retry", accountOwner: "will" }
    } }).isPersisted.promise
    let releaseObservation: (response: Response) => void = () => {}
    const observation = new Promise<Response>(resolve => { releaseObservation = resolve })
    let retries = 0
    createAppController(store, unavailableAgent, { fetchImpl: async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://app.test").pathname
      if (path.endsWith("/retry") && init?.method === "POST") { retries += 1; return json(202, jobBody("cloning")) }
      if (path.endsWith("/github/import/job-1")) return observation
      return json(404, {})
    } })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    releaseObservation(json(200, jobBody("failed", null, "retry me")))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(retries).toBe(0)
  })

  test("retry recovery keeps a failed GET visible and does not guess that retry is safe", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await signedIn(store)
    await reposLoaded(store)
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: CARD_ID, kind: "repo-import", title: "Import · will/flows", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: "will/flows", jobId: "job-1", phase: "starting", detail: null,
        requestId: "persisted-retry", requestKind: "retry", accountOwner: "will" }
    } }).isPersisted.promise
    let retries = 0
    createAppController(store, unavailableAgent, { fetchImpl: async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://app.test").pathname
      if (path.endsWith("/retry") && init?.method === "POST") { retries += 1; return json(202, jobBody("cloning")) }
      if (path.endsWith("/github/import/job-1")) return json(500, { message: "job lookup unavailable" })
      return json(404, {})
    } })
    await until(() => importCard(store)?.payload.phase === "failed", "the failed retry observation")
    expect(importCard(store)?.payload.detail).toBe("job lookup unavailable")
    expect(retries).toBe(0)
  })

  test("two quick retries keep one attempt identity and issue one retry", async () => {
    let releaseRetry: (response: Response) => void = () => {}
    const retryResponse = new Promise<Response>(resolve => { releaseRetry = resolve })
    let retries = 0
    const { store, controller } = await readyStore(importBackend(
      () => json(202, jobBody("cloning")),
      pollSequence([() => json(200, jobBody("failed", null, "clone failed")), () => json(200, jobBody("ready"))]),
      () => { retries += 1; return retryResponse }
    ))
    await controller.commands.run("repos.import", "will/flows")
    await until(() => importCard(store)?.payload.phase === "failed", "the failed import")
    await controller.commands.run("repos.import.retry", "job-1")
    const requestId = importCard(store)?.payload.requestId
    await controller.commands.run("repos.import.retry", "job-1")
    expect(importCard(store)?.payload.requestId).toBe(requestId)
    expect(retries).toBe(1)
    releaseRetry(json(202, jobBody("cloning")))
    await until(() => importCard(store)?.payload.phase === "done", "the deduplicated retry")
  })

  test("a rejected request receipt becomes a retryable failure and never launches", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await signedIn(store)
    await reposLoaded(store)
    const dispatch = store.dispatch
    let rejectReceipt = true
    Object.assign(store, { dispatch: ((transition: Parameters<AppStore["dispatch"]>[0]) => {
      const receipt = dispatch(transition)
      if (!rejectReceipt || transition.type !== "card.upsert" || transition.card.kind !== "repo-import") return receipt
      rejectReceipt = false
      return { ...receipt, isPersisted: { ...receipt.isPersisted, promise: Promise.reject(new Error("disk full")) } }
    }) as AppStore["dispatch"] })
    let starts = 0
    const controller = createAppController(store, unavailableAgent, importBackend(() => { starts += 1; return json(202, jobBody("ready")) }))
    expect((await controller.commands.run("repos.import", "will/flows")).status).toBe("failed")
    await until(() => importCard(store)?.payload.phase === "failed", "the persistence failure")
    expect(importCard(store)?.payload.detail).toBe("The import request couldn't be saved.")
    expect(starts).toBe(0)
  })

  for (const boundary of ["owner switch", "controller disposal"] as const) {
    test(`held persistence cannot launch after ${boundary}`, async () => {
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      await signedIn(store)
      await reposLoaded(store)
      let releasePersistence: () => void = () => {}
      const held = new Promise<void>(resolve => { releasePersistence = resolve })
      const dispatch = store.dispatch
      let holdReceipt = true
      Object.assign(store, { dispatch: ((transition: Parameters<AppStore["dispatch"]>[0]) => {
        const receipt = dispatch(transition)
        if (!holdReceipt || transition.type !== "card.upsert" || transition.card.kind !== "repo-import") return receipt
        holdReceipt = false
        return { ...receipt, isPersisted: { ...receipt.isPersisted, promise: receipt.isPersisted.promise.then(() => held) } }
      }) as AppStore["dispatch"] })
      let starts = 0
      const controller = createAppController(store, unavailableAgent,
        importBackend(() => { starts += 1; return json(202, jobBody("ready")) }))
      const admission = controller.commands.run("repos.import", "will/flows")
      await settled()
      if (boundary === "owner switch") {
        await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other",
          allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      } else {
        await controller.dispose()
      }
      releasePersistence()
      await admission
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(starts).toBe(0)
    })
  }

  test("legacy adoption held in persistence cannot turn into a new-owner import", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await signedIn(store)
    await reposLoaded(store)
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: CARD_ID, kind: "repo-import", title: "Import · will/flows", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: "will/flows", jobId: "legacy-job", phase: "running", detail: null }
    } }).isPersisted.promise
    let releasePersistence: () => void = () => {}
    const held = new Promise<void>(resolve => { releasePersistence = resolve })
    const dispatch = store.dispatch
    let holdAdoption = true
    Object.assign(store, { dispatch: ((transition: Parameters<AppStore["dispatch"]>[0]) => {
      const receipt = dispatch(transition)
      if (!holdAdoption || transition.type !== "card.upsert" || transition.card.kind !== "repo-import" ||
        transition.card.payload.requestId === undefined) return receipt
      holdAdoption = false
      return { ...receipt, isPersisted: { ...receipt.isPersisted, promise: receipt.isPersisted.promise.then(() => held) } }
    }) as AppStore["dispatch"] })
    let starts = 0
    const controller = createAppController(store, unavailableAgent, { fetchImpl: async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://app.test").pathname
      if (path.endsWith("/github/import") && init?.method === "POST") starts += 1
      return json(202, jobBody("ready"))
    } })
    const admission = controller.commands.run("repos.import", "will/flows")
      await settled()
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    releasePersistence()
      await admission
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(starts).toBe(0)
  })

  test("retry refuses a job explicitly owned by another account", async () => {
    const { store, controller } = await readyStore(importBackend(() => json(202, jobBody("ready"))))
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: CARD_ID, kind: "repo-import", title: "Import · will/flows", status: "error", createdAt: 1, ordinal: 1,
      payload: { repo: "will/flows", jobId: "other-job", phase: "failed", detail: "failed",
        requestId: "other-request", requestKind: "retry", accountOwner: "other" }
    } }).isPersisted.promise
    const outcome = await controller.commands.run("repos.import.retry", "other-job")
    expect(outcome).toMatchObject({ status: "failed", error: "This import belongs to another account. Start a new import for the current account." })
  })

  test("a stale persistence rejection cannot fail a newer owner's card", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await signedIn(store)
    await reposLoaded(store)
    let rejectPersistence: (error: Error) => void = () => {}
    const held = new Promise<void>((_, reject) => { rejectPersistence = reject })
    const dispatch = store.dispatch
    let holdReceipt = true
    Object.assign(store, { dispatch: ((transition: Parameters<AppStore["dispatch"]>[0]) => {
      const receipt = dispatch(transition)
      if (!holdReceipt || transition.type !== "card.upsert" || transition.card.kind !== "repo-import") return receipt
      holdReceipt = false
      return { ...receipt, isPersisted: { ...receipt.isPersisted, promise: held } }
    }) as AppStore["dispatch"] })
    const controller = createAppController(store, unavailableAgent, importBackend(() => json(202, jobBody("ready"))))
    const admission = controller.commands.run("repos.import", "will/flows")
    await until(() => importCard(store) !== undefined, "the persisted intent")
    const old = importCard(store)!
    await store.dispatch({ type: "card.upsert", actor: "system", card: { ...old,
      payload: { ...old.payload, requestId: "new-owner-request", accountOwner: "other", phase: "starting", detail: null } } }).isPersisted.promise
    rejectPersistence(new Error("old receipt failed"))
    await admission
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(importCard(store)?.payload.requestId).toBe("new-owner-request")
    expect(importCard(store)?.payload.phase).toBe("starting")
    expect(importCard(store)?.payload.detail).toBeNull()
  })

  test("an explicit import under a new owner starts fresh without the prior owner's job", async () => {
    let postedBody: unknown
    const { store } = await readyStore(importBackend(async () => json(202, jobBody("ready"))))
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: CARD_ID, kind: "repo-import", title: "Import · will/flows", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: "will/flows", jobId: "owner-a-job", phase: "starting", detail: null,
        requestId: "owner-a-request", requestKind: "start", accountOwner: "owner-a" }
    } }).isPersisted.promise
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner-b",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const services: AppServices = { fetchImpl: async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://app.test").pathname
      if (path.endsWith("/github/import") && init?.method === "POST") { postedBody = JSON.parse(String(init.body)); return json(202, jobBody("ready")) }
      return json(404, {})
    } }
    const fresh = createAppController(store, unavailableAgent, services)
    await fresh.commands.run("repos.import", "will/flows")
    await until(() => importCard(store)?.payload.phase === "done", "the new owner's import")
    expect(postedBody).toEqual({ owner: "will", repo: "flows" })
    expect(importUpserts(store).at(-2)?.payload.jobId).toBeNull()
  })

  test("an account switch while polling cannot mutate the prior owner's card", async () => {
    let releasePoll: (response: Response) => void = () => {}
    const poll = new Promise<Response>(resolve => { releasePoll = resolve })
    const { store, controller } = await readyStore(importBackend(() => json(202, jobBody("cloning")), () => poll))
    await controller.commands.run("repos.import", "will/flows")
    await until(() => importCard(store)?.payload.phase === "running", "the running receipt")
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const upsertsBeforeRelease = importUpserts(store).length
    releasePoll(json(200, jobBody("failed", null, "old account failed")))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(importUpserts(store)).toHaveLength(upsertsBeforeRelease)
    expect(importUpserts(store).some(card => card.payload.detail === "old account failed")).toBe(false)
  })

  test("a stale unresolved launch cannot overwrite a newer persisted attempt", async () => {
    let releaseLaunch: (response: Response) => void = () => {}
    const launch = new Promise<Response>((resolve) => { releaseLaunch = resolve })
    const { store, controller } = await readyStore(importBackend(() => launch))
    await controller.commands.run("repos.import", "will/flows")
    const first = importCard(store)
    expect(first?.payload.phase).toBe("starting")
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      ...first!, payload: { ...first!.payload, requestId: "newer-attempt", phase: "starting", detail: null }
    } }).isPersisted.promise
    releaseLaunch(json(500, { message: "old launch failed" }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(importCard(store)?.payload.requestId).toBe("newer-attempt")
    expect(importCard(store)?.payload.phase).toBe("starting")
    expect(importCard(store)?.payload.detail).toBeNull()
  })
})


test("a GitHub-signed-in import opens issues without requesting a separate cloud sign-in", async () => {
  const backend = importBackend(() => json(202, jobBody("ready")))
  const requests: string[] = []
  const { store, controller } = await readyStore({ fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const path = new URL(url, "https://app.test").pathname
    requests.push(path)
    if (path === "/api/repos/will/flows/issues") return json(200, [])
    if (path === "/api/user/github-repos/will/flows/issues") return json(200, { issues: [] })
    return backend.fetchImpl!(input, init)
  } })
  expect(store.collections.cloudSessions.get("cloud")?.state).not.toBe("signed-in")
  expect((await controller.commands.run("repos.import", "will/flows")).status).toBe("executed")
  expect(importCard(store)?.payload.phase).toBe("done")
  expect((await controller.commands.run("issues.list", "will/flows")).status).toBe("executed")
  const issues = [...store.collections.cards.values()].find(card => card.kind === "issue-list")
  expect(issues).toMatchObject({ kind: "issue-list", payload: { repo: "will/flows" } })
  expect(store.collections.cloudSessions.get("cloud")?.state).not.toBe("signed-in")
  expect(requests).toContain("/api/repos/will/flows/issues")
  expect(requests.some(path => /workspaces|cloud.*sign-in/.test(path))).toBe(false)
})

describe("repo import account fences", () => {
  test("a held launch cannot show a debounced private toast after logout", async () => {
    let release!: (response: Response) => void
    let starts = 0
    const held = new Promise<Response>(resolve => { release = resolve })
    const { store, controller } = await readyStore(importBackend(() => { starts++; return held }))
    try {
      await controller.importRepository("will/flows")
      await until(() => starts === 1, "held launch")
      await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
      await new Promise(resolve => setTimeout(resolve, 350))
      expect(store.collections.toasts.get("toast-repos.import.will/flows")).toBeUndefined()
      release(json(202, jobBody("ready")))
      await settled()
      expect(store.collections.toasts.get("toast-repos.import.will/flows")).toBeUndefined()
      expect(importCard(store)).toBeUndefined()
    } finally { controller.dispose() }
  })

  test("a new account can request the same repository while an old launch is unresolved", async () => {
    let release!: (response: Response) => void
    let starts = 0
    const held = new Promise<Response>(resolve => { release = resolve })
    const { store, controller } = await readyStore(importBackend(() => ++starts === 1 ? held : json(202, jobBody("ready"))))
    try {
      await controller.importRepository("will/flows")
      await until(() => starts === 1, "old launch")
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      await controller.importRepository("will/flows")
      await until(() => importCard(store)?.payload.phase === "done", "new owner's import")
      expect(starts).toBe(2)
      expect(importCard(store)?.payload.accountOwner).toBe("other")
      release(json(202, jobBody("failed", null, "old account failure")))
      await settled()
      expect(importCard(store)?.payload.phase).toBe("done")
      expect(importCard(store)?.payload.accountOwner).toBe("other")
    } finally { controller.dispose() }
  })

  test("retrying an unavailable poll reconnects the existing job without restarting it", async () => {
    let starts = 0
    let polls = 0
    let retries = 0
    const { store, controller } = await readyStore(importBackend(
      () => { starts++; return json(202, jobBody("cloning")) },
      () => ++polls === 1 ? json(503, { message: "temporarily unavailable" }) : json(200, jobBody("ready")),
      () => { retries++; return json(500, { message: "must not restart" }) }
    ))
    try {
      await controller.importRepository("will/flows")
      await until(() => importCard(store)?.payload.phase === "failed", "poll refusal")
      await settled()
      await controller.retryImport("job-1")
      await until(() => importCard(store)?.payload.phase === "done", "reconnected completion")
      expect(starts).toBe(1)
      expect(retries).toBe(0)
      expect(polls).toBe(2)
    } finally { controller.dispose() }
  })

  test("a held start cannot restore the previous owner's import card", async () => {
    let release!: (response: Response) => void
    let requested!: () => void
    const started = new Promise<void>(resolve => { requested = resolve })
    const held = new Promise<Response>(resolve => { release = resolve })
    const { store, controller } = await readyStore(importBackend(() => { requested(); return held }))
    const pending = controller.importRepository("will/flows")
    await started
    await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    release(json(202, jobBody("ready")))
    await pending
    expect(importCard(store)).toBeUndefined()
    expect(importUpserts(store).some(card => card.payload.phase === "done")).toBe(false)
  })

  test("a held poll cannot restore the previous owner's progress after sign-out", async () => {
    let release!: (response: Response) => void
    let requested!: () => void
    const started = new Promise<void>(resolve => { requested = resolve })
    const held = new Promise<Response>(resolve => { release = resolve })
    const { store, controller } = await readyStore(importBackend(
      () => json(202, jobBody("cloning")),
      () => { requested(); return held }
    ))
    await controller.importRepository("will/flows")
    await started
    await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    release(json(200, jobBody("ready")))
    await settled()
    expect(importCard(store)).toBeUndefined()
    expect(importUpserts(store).some(card => card.payload.phase === "done")).toBe(false)
  })
})

test("a held import start stays stale across an A to B to A account cycle", async () => {
  let release!: (response: Response) => void
  let requested!: () => void
  const started = new Promise<void>(resolve => { requested = resolve })
  const held = new Promise<Response>(resolve => { release = resolve })
  const { store, controller } = await readyStore(importBackend(() => { requested(); return held }))
  const pending = controller.importRepository("will/flows")
  await started
  for (const login of ["other", "will"]) {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  }
  release(json(202, jobBody("ready")))
  await pending
  expect(importCard(store)).toBeUndefined()
  expect(importUpserts(store).some(card => card.payload.phase === "done")).toBe(false)
})

  test("a same-account identity refresh does not retire the running import", async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { release = resolve })
    const { store, controller } = await readyStore(importBackend(() => json(202, jobBody("cloning")), () => pending))
    await controller.importRepository("will/flows")
    await until(() => importCard(store)?.payload.phase === "running", "running import")
    await signedIn(store)
    release(json(200, jobBody("ready")))
    await until(() => importCard(store)?.payload.phase === "done", "refreshed import completion")
    controller.dispose()
  })

test("the import toast waits for the terminal completion receipt to persist", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await signedIn(store)
  await reposLoaded(store)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const dispatch = store.dispatch
  Object.assign(store, { dispatch: ((transition: Parameters<AppStore["dispatch"]>[0]) => {
    const receipt = dispatch(transition)
    if (transition.type !== "card.upsert" || transition.card.kind !== "repo-import" || transition.card.payload.phase !== "done") return receipt
    return { ...receipt, isPersisted: { ...receipt.isPersisted, promise: receipt.isPersisted.promise.then(() => held) } }
  }) as AppStore["dispatch"] })
  const controller = createAppController(store, unavailableAgent, {
    ...importBackend(() => json(202, jobBody("cloning")), () => json(200, jobBody("ready"))),
    toastDebounceMs: 0
  })
  try {
    await controller.commands.run("repos.import", "will/flows")
    await until(() => importCard(store)?.payload.phase === "done", "the projected completion")
    expect(store.collections.toasts.get("toast-repos.import.will/flows")?.status).toBe("running")
    release()
    await until(() => store.collections.toasts.get("toast-repos.import.will/flows")?.status === "ok", "the durable completion")
  } finally { release(); controller.dispose() }
})
