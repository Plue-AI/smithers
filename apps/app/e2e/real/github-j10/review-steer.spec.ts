import { execFileSync } from "node:child_process"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import type { Browser, BrowserContext, Locator, Page, TestInfo } from "@playwright/test"
import { awaitBoot, realApi, reloadApp, test } from "../support"
import { scenario } from "../coverage/types"
import { attachJson, expect, JourneyUnavailable, observe, required, runSlash, withReference, type Actor, type Member, type Reference } from "../todo/reference"

// C-J10-02 (T-GH-04): Alice's "Request changes" review with one line comment
// on a TODO's PR reaches the TODO's run as her steer within 60 s, the TODO
// returns to Working, and the agent's fix updates the same PR. It runs on the
// reference install against real GitHub, and on the composed install
// (TestReviewSteerJourneyComposedInstall) against the GitHub fake, whose own
// controls stand in for people on github.com. Every expectation is a
// committed literal or an independent GitHub, database or live-channel read.

const STEER = "Use the existing backoff helper"
const OUTSIDER_NOTE = "Outsider note on the retry change"
const PATH = "src/retry.ts"

type Logins = { readonly owner: string; readonly alice: string; readonly dana: string }
type Pull = { readonly number: number; readonly ref: string; readonly head: string; readonly state: string }

/** What people do on github.com, outside the App. Each write answers once GitHub returned 2xx. */
type People = {
  /** Alice requests changes with one line comment at PATH:line; answers the review id. */
  readonly requestChanges: (pr: number, line: number) => Promise<number>
  /** Dana, who reads the repository and is no member, comments on the PR's conversation. */
  readonly comment: (pr: number) => Promise<number>
  /** The owner approves the PR; answers the review id. */
  readonly approve: (pr: number) => Promise<number>
  readonly pulls: () => Promise<Pull[]>
  /** The App's writes into the PR's review threads: replies, reviews and line comments. */
  readonly threadWrites: (pr: number) => Promise<string[]>
  /** The PR's patch of PATH (reference host: a real model must call the helper). */
  readonly patch?: (pr: number) => Promise<string>
}

type ReviewInstall = {
  readonly members: Record<Actor, Member>
  /** The TODO In review whose PR changes PATH, and the line Alice comments on. */
  readonly todo: number
  readonly line: number
  readonly logins: Logins
  readonly people: People
  /** Restarts the host and answers once it serves again. */
  readonly restart: () => Promise<void>
  readonly read: (actor: Actor, path: string) => Promise<any>
  readonly sql: (query: string) => any[]
}

/** What TestReviewSteerJourneyComposedInstall writes for the spec (SMITHERS_JOURNEY_COMPOSED_HOST). */
type ComposedHost = {
  readonly origin: string
  readonly repository: string
  readonly commit: string
  readonly members: Record<Actor, ReadonlyArray<{ readonly name: string; readonly value: string }>>
  readonly github: { readonly url: string; readonly logins: Logins }
  readonly todo: number
  readonly line: number
  readonly restart: { readonly request: string; readonly done: string }
}

const threadPath = (repo: string, pr: number): RegExp => new RegExp(`^/repos/${repo}/pulls/(?:${pr}/(?:comments|reviews)|comments/\\d+)`)

const fakePeople = (url: string, repo: string, logins: Logins): People => {
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(new URL(path, url), { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    expect(response.ok, `GitHub fake ${method} ${path}: ${response.status} ${await response.clone().text()}`).toBe(true)
    return response.status === 204 ? null : response.json()
  }
  return {
    requestChanges: async (pr, line) => (await call("POST", "/_fake/reviews", { repo, number: pr, login: logins.alice, state: "CHANGES_REQUESTED", body: STEER, path: PATH, line })).id,
    comment: async pr => (await call("POST", "/_fake/comments", { repo, number: pr, login: logins.dana, body: OUTSIDER_NOTE })).id,
    approve: async pr => (await call("POST", "/_fake/reviews", { repo, number: pr, login: logins.owner, state: "APPROVED" })).id,
    pulls: async () => (await call("GET", `/_fake/pulls?repo=${encodeURIComponent(repo)}`) as any[])
      .map(pull => ({ number: pull.number, ref: pull.head.ref, head: pull.head.sha, state: pull.state })),
    threadWrites: async pr => (await call("GET", "/_fake/writes") as { method: string; path: string }[])
      .filter(write => write.method !== "GET" && threadPath(repo, pr).test(write.path)).map(write => `${write.method} ${write.path}`)
  }
}

const githubPeople = (f: Reference): People => {
  const asDana = async (method: string, path: string, data: unknown): Promise<any> => {
    const response = await f.members.Ben.context.request.fetch(`https://api.github.com/repos/${f.repo}${path}`, {
      method, data, headers: { Authorization: `Bearer ${required("SMITHERS_JOURNEY_DANA_GITHUB_TOKEN")}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
    })
    expect(response.ok(), `GitHub ${method} ${path} as Dana: ${response.status()}`).toBe(true)
    return response.json()
  }
  return {
    requestChanges: async (pr, line) => (await f.github("Alice", "POST", `/pulls/${pr}/reviews`,
      { event: "REQUEST_CHANGES", body: STEER, comments: [{ path: PATH, line, side: "RIGHT", body: STEER }] }) as { id: number }).id,
    comment: async pr => (await asDana("POST", `/issues/${pr}/comments`, { body: OUTSIDER_NOTE })).id,
    approve: async pr => (await f.github("Will", "POST", `/pulls/${pr}/reviews`, { event: "APPROVE" }) as { id: number }).id,
    pulls: async () => (await f.github("Ben", "GET", "/pulls?state=all&per_page=100") as any[])
      .map(pull => ({ number: pull.number, ref: pull.head.ref, head: pull.head.sha, state: pull.state })),
    // The install's outbound GitHub recorder (append-only JSONL), never browser traffic.
    threadWrites: async pr => readFileSync(required("SMITHERS_JOURNEY_GITHUB_AUDIT_LOG"), "utf8").split("\n").filter(Boolean)
      .map(line => JSON.parse(line) as { method: string; path: string })
      .filter(write => write.method.toUpperCase() !== "GET" && threadPath(f.repo, pr).test(write.path)).map(write => `${write.method} ${write.path}`),
    patch: async pr => ((await f.github("Ben", "GET", `/pulls/${pr}/files?per_page=100`)) as { filename: string; patch?: string }[])
      .find(file => file.filename === PATH)?.patch ?? ""
  }
}

const positive = (name: string): number => {
  const value = Number(required(name))
  if (!Number.isInteger(value) || value <= 0) throw new JourneyUnavailable(`${name} must be a positive integer`)
  return value
}

const withReviewInstall = async (browser: Browser, info: TestInfo, body: (install: ReviewInstall) => Promise<void>): Promise<void> => {
  const composed = process.env.SMITHERS_JOURNEY_COMPOSED_HOST
  if (!composed) {
    // Reference setup (C-J10-02): the owner seeded T3 In review on a scratch
    // canary repository; its PR changes PATH with a delay loop at line N.
    await withReference(browser, info, f => body({
      members: f.members, todo: positive("SMITHERS_JOURNEY_REVIEW_TODO"), line: positive("SMITHERS_JOURNEY_REVIEW_LINE"),
      logins: { owner: required("SMITHERS_JOURNEY_WILL_LOGIN"), alice: required("SMITHERS_JOURNEY_ALICE_LOGIN"), dana: required("SMITHERS_JOURNEY_DANA_LOGIN") },
      people: githubPeople(f), read: f.read, sql: f.sql,
      restart: async () => {
        // The operator's restart of the installed host, e.g. a launchctl kickstart.
        const argv = JSON.parse(required("SMITHERS_JOURNEY_RESTART_COMMAND")) as string[]
        execFileSync(argv[0]!, argv.slice(1), { stdio: "inherit", timeout: 300_000 })
      }
    }))
    return
  }
  const host = JSON.parse(readFileSync(composed, "utf8")) as ComposedHost
  if (!/^https?:\/\//.test(host.origin) || process.env.SMITHERS_REAL_BASE_URL !== host.origin) {
    throw new JourneyUnavailable("The composed install's origin must be the real-tier base URL")
  }
  await attachJson(info, "install-version-commit", { install: "composed", commit: host.commit, origin: host.origin })
  const contexts: BrowserContext[] = []
  const members = {} as Record<Actor, Member>
  try {
    for (const actor of ["Will", "Ben", "Alice"] as const) {
      const context = await browser.newContext({ baseURL: host.origin, recordVideo: { dir: info.outputPath(`video-${actor}`) } })
      contexts.push(context)
      await context.addCookies(host.members[actor].map(cookie => ({ ...cookie, url: host.origin, httpOnly: cookie.name !== "__csrf" })))
      const page = await context.newPage()
      await page.goto(`${host.origin}/${host.repository}`)
      await awaitBoot(page)
      members[actor] = { context, page }
    }
    await body({
      members, todo: host.todo, line: host.line, logins: host.github.logins,
      people: fakePeople(host.github.url, host.repository, host.github.logins),
      read: async (actor, path) => {
        const page = members[actor].page
        const response = await realApi(page, page.context().request, "GET", path)
        expect(response.status(), path).toBe(200)
        return response.json()
      },
      sql: observe,
      restart: async () => {
        const nonce = `restart-${Date.now()}`
        writeFileSync(`${host.restart.request}.tmp`, nonce)
        renameSync(`${host.restart.request}.tmp`, host.restart.request)
        await expect.poll(() => { try { return readFileSync(host.restart.done, "utf8") } catch { return "" } },
          { message: "the composed install restarts", timeout: 180_000, intervals: [250] }).toBe(nonce)
      }
    })
  } finally {
    for (const context of contexts) {
      await context.close()
    }
  }
}

type Delta = { readonly at: number; readonly type: string; readonly state?: string; readonly steered: boolean }

/**
 * The todo:<n> deltas the page's real /api/live sockets receive (no
 * interception), each with its arrival time and whether its card carries
 * Alice's steer. Attach before the socket opens.
 */
const observeTodo = (page: Page, n: number): Delta[] => {
  const deltas: Delta[] = []
  const parse = (payload: string | Buffer): any => { try { return typeof payload === "string" ? JSON.parse(payload) : undefined } catch { return undefined } }
  page.on("websocket", socket => {
    if (!new URL(socket.url()).pathname.endsWith("/api/live")) return
    const topics = new Map<number, string>()
    socket.on("framesent", ({ payload }) => {
      const frame = parse(payload)
      if (frame?.t === "sub") topics.set(frame.id, frame.topic)
    })
    socket.on("framereceived", ({ payload }) => {
      const frame = parse(payload)
      if (frame?.t !== "delta" || topics.get(frame.id) !== `todo:${n}`) return
      const card = frame.data?.Data?.card
      deltas.push({ at: Date.now(), type: frame.data?.Type ?? "", state: card?.state, steered: JSON.stringify(card?.steers ?? []).includes(STEER) })
    })
  })
  return deltas
}

const todoCard = (page: Page, n: number): Locator => page.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
const stateOf = (card: Locator): Locator => card.locator("header .state")
const steerRows = (card: Locator, text: string): Locator => card.locator(".todo-authored").filter({ hasText: text })
const openTodo = async (page: Page, n: number): Promise<Locator> => {
  await runSlash(page, `/todo ${n}`)
  const card = todoCard(page, n)
  await expect(card).toBeVisible()
  return card
}

/** Every activity entry GitHub gave TODO n: product_job_events, read-only. */
const githubInputs = (f: ReviewInstall, n: number): { object: string; kind: string; text: string; by: any; from: string; to: string }[] => f.sql(
  `SELECT data->>'object' AS object, data->>'kind' AS kind, data->>'text' AS text, data->'by' AS by, data->>'from' AS "from", data->>'to' AS "to"
   FROM product_job_events WHERE event_type = 'todo.github_input' AND data->>'n' = '${n}' ORDER BY sequence`)
const steerJobs = (f: ReviewInstall, text?: string): number => Number(f.sql(
  `SELECT count(*) AS n FROM product_job_requests WHERE operation = 'flow.runtime.steer'${text === undefined ? "" : ` AND payload::text LIKE '%${text}%'`}`)[0]?.n ?? 0)
const landApproved = (f: ReviewInstall, n: number): boolean =>
  f.sql(`SELECT checks ? 'land' AS land FROM mythical_items WHERE checks->>'todo' = 'true' AND number = ${n}`)[0]?.land === true
const steersWith = (card: { steers: { text: string; by: any }[] }, text: string) => card.steers.filter(steer => steer.text.includes(text))

test("C-J10-02 a GitHub review steers the TODO and its fix updates the same PR", scenario("journey-review-steer", {
  capabilities: [],
  coverage: ["action:todo.steer", "host:local", "path:success", "path:permission", "door:slash", "door:user-only", "surface:todo", "dimension:github-review", "dimension:live", "dimension:host-restart", "evidence:database-readback", "evidence:github-write-log"],
  description: "C-J10-02: Alice's GitHub review steers the TODO within 60 s and its fix updates the same PR; a restart adds no second steer; an outsider's comment and the owner's approval change nothing."
}), async ({ browser }, info) => {
  test.setTimeout(45 * 60_000)
  await withReviewInstall(browser, info, async f => {
    const ben = f.members.Ben.page
    const n = f.todo
    const before = await f.read("Ben", `/api/todos/${n}`)
    expect(before.state, `T${n} starts In review`).toBe("in_review")
    const pr: number = before.pr.number
    const opened = (await f.people.pulls()).find(pull => pull.number === pr)
    expect(opened, `GitHub holds T${n}'s PR #${pr}`).toMatchObject({ state: "open", head: before.pr.head })
    expect(steersWith(before, STEER)).toEqual([])
    const threadBefore = await f.people.threadWrites(pr)

    // Ben watches the TODO's card; his live socket is observed from its opening.
    const deltas = observeTodo(ben, n)
    await reloadApp(ben)
    const card = await openTodo(ben, n)
    await expect(stateOf(card)).toHaveAttribute("data-state", "in_review")

    // Step 1: Alice requests changes with one line comment; t0 when GitHub answers 2xx.
    const review = await f.people.requestChanges(pr, f.line)
    const t0 = Date.now()

    // Step 2: the todo:<n> delta that shows her steer arrives within 60 s.
    await expect.poll(() => deltas.some(delta => delta.at >= t0 && delta.steered),
      { message: "Ben's page receives the steer's todo delta", timeout: 120_000, intervals: [250] }).toBe(true)
    const shown = deltas.find(delta => delta.at >= t0 && delta.steered)!
    await attachJson(info, "timing", { t0: new Date(t0).toISOString(), t1: new Date(shown.at).toISOString(), ms: shown.at - t0, review })
    expect(shown.at - t0, "t1 - t0").toBeLessThanOrEqual(60_000)
    expect(shown.type).toBe("todo.github_input")
    // Working never shows before the steer's event exists.
    expect(deltas.filter(delta => delta.at >= t0 && delta.at < shown.at && delta.state === "working")).toEqual([])
    const steer = steerRows(card, STEER)
    await expect(steer).toHaveCount(1)
    await expect(steer).toContainText(`${PATH}:${f.line}`)
    await expect(steer.locator('.avatar[data-kind="person"]')).toBeVisible()
    await expect(steer.locator(".avatar[data-agent], .avatar[data-smithers]")).toHaveCount(0)
    await expect(stateOf(card)).toHaveAttribute("data-state", "working", { timeout: 300_000 })
    const steered = await f.read("Ben", `/api/todos/${n}`)
    const hers = steersWith(steered, STEER)
    expect(hers).toHaveLength(1)
    expect(hers[0]!.by).toMatchObject({ kind: "person", login: f.logins.alice })
    expect(hers[0]!.text).toContain(`${PATH}:${f.line}`)
    // One activity row for her review, attributed to her, with the GitHub mark.
    const recorded = githubInputs(f, n).filter(row => row.text?.includes(STEER))
    await attachJson(info, "step-2-github-inputs", recorded)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ object: `review:${review}`, kind: "github", from: "in_review", by: { kind: "person", login: f.logins.alice } })
    expect(["working", "queued"]).toContain(recorded[0]!.to)
    const herJobs = steerJobs(f, STEER)
    expect(herJobs).toBeLessThanOrEqual(1)

    // Step 3: the agent's fix updates the same PR and the TODO is In review again.
    await expect(stateOf(card)).toHaveAttribute("data-state", "in_review", { timeout: 30 * 60_000 })
    const fixed = await f.read("Ben", `/api/todos/${n}`)
    expect(fixed.pr.number).toBe(pr)
    expect(fixed.pr.head).not.toBe(before.pr.head)
    const branchPulls = (await f.people.pulls()).filter(pull => pull.ref === opened!.ref)
    await attachJson(info, "step-3-pr-before-after", { before: opened, after: branchPulls })
    expect(branchPulls).toEqual([{ number: pr, ref: opened!.ref, head: fixed.pr.head, state: "open" }])
    if (f.people.patch) expect(await f.people.patch(pr)).toContain(required("SMITHERS_JOURNEY_BACKOFF_HELPER"))
    // The agent pushed commits; it never replied inside the review thread.
    expect(await f.people.threadWrites(pr)).toEqual(threadBefore)

    // Step 4: restart the host and wait 2 min; still one steer and one event.
    const sync = (await f.read("Ben", "/api/github/sync")).last_success_at
    await f.restart()
    await ben.waitForTimeout(120_000)
    await expect.poll(async () => (await f.read("Ben", "/api/github/sync")).last_success_at,
      { message: "GitHub is read again after the restart", timeout: 180_000 }).not.toBe(sync)
    const restarted = await f.read("Ben", `/api/todos/${n}`)
    expect(steersWith(restarted, STEER)).toHaveLength(1)
    expect(githubInputs(f, n).filter(row => row.text?.includes(STEER))).toHaveLength(1)
    expect(steerJobs(f, STEER)).toBe(herJobs)
    await reloadApp(ben)
    const reopened = await openTodo(ben, n)
    await expect(steerRows(reopened, STEER)).toHaveCount(1)

    // Step 5: Dana's comment is activity with the GitHub mark; never a steer.
    const quiet = await f.read("Ben", `/api/todos/${n}`)
    const jobs = steerJobs(f)
    await f.people.comment(pr)
    await expect.poll(async () => ((await f.read("Ben", `/api/todos/${n}/events`)).Events as { Type: string; Data: any }[])
      .filter(event => event.Type === "todo.github_input" && event.Data?.text?.includes(OUTSIDER_NOTE)).map(event => event.Data.by),
    { message: "Dana's comment reaches the TODO's activity", timeout: 120_000 }).toEqual([{ kind: "github", login: f.logins.dana, color_index: 7 }])
    const outsider = await f.read("Ben", `/api/todos/${n}`)
    expect(outsider.state).toBe(quiet.state)
    expect(outsider.steers).toEqual(quiet.steers)
    expect(steerJobs(f)).toBe(jobs)
    await expect(steerRows(reopened, OUTSIDER_NOTE)).toHaveCount(0)

    // Step 6: the owner's approval on GitHub is recorded and changes nothing.
    const approval = await f.people.approve(pr)
    await expect.poll(() => githubInputs(f, n).filter(row => row.object === `review:${approval}`).length,
      { message: "the approval is recorded", timeout: 120_000 }).toBe(1)
    const approved = await f.read("Ben", `/api/todos/${n}`)
    expect(approved.state).toBe(quiet.state)
    expect(approved.steers).toEqual(quiet.steers)
    expect(landApproved(f, n), "no checks.Land approval").toBe(false)
    expect(steerJobs(f)).toBe(jobs)
    await attachJson(info, "activity", githubInputs(f, n))
    expect(approved.pr.reviews, "the PR card lists the owner's approval").toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "APPROVED" })]))
    await expect(reopened).toContainText("Approved by")
  })
})
