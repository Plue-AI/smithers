import { Cause, Effect, Exit, Fiber } from "effect"
import { inspect } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fromIntegrationError } from "../src/core/ActionFailure.ts"
import { type IntegrationError, isIntegrationError } from "../src/core/IntegrationError.ts"
import { DEFAULT_API_BASE_URL, DEFAULT_REQUEST_TIMEOUT, resolve } from "../src/linear/Config.ts"
import { make, normalizePriority, type Priority, retryDelayMs } from "../src/linear/LinearClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"

const API_KEY = "lin_api_fixture"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
  vi.unstubAllGlobals()
})

const client = () => make({ apiKey: API_KEY, apiBaseUrl: (fixture as Fixture).origin })

const operation = (body: string): string => {
  const parsed = JSON.parse(body) as { query: string }
  return /(?:query|mutation)\s+(\w+)/.exec(parsed.query)?.[1] ?? "unknown"
}

const TEAM = { id: "team-eng-id", key: "ENG", name: "Engineering" }
const STATES = [{ id: "state-todo", name: "Todo" }, { id: "state-progress", name: "In Progress" }]
const LABELS = [{ id: "label-bug", name: "Bug" }, { id: "label-infra", name: "Infra" }]
const ISSUE = {
  id: "issue-uuid",
  identifier: "ENG-1",
  title: "t",
  url: "https://linear.app/x",
  team: { id: TEAM.id, key: "ENG" }
}

/** A GraphQL fixture that answers the operations the client actually sends. */
const graphql = async (overrides: Partial<Record<string, unknown>> = {}) =>
  startFixture((request, response) => {
    const name = operation(request.body)
    if (Object.hasOwn(overrides, name)) {
      json(response, 200, { data: overrides[name] })
      return
    }
    switch (name) {
      case "TeamByKey":
        return json(response, 200, { data: { teams: { nodes: [TEAM] } } })
      case "WorkflowStates":
        return json(response, 200, { data: { workflowStates: { nodes: STATES } } })
      case "IssueLabels":
        return json(response, 200, { data: { issueLabels: { nodes: LABELS } } })
      case "Issue":
        return json(response, 200, { data: { issue: ISSUE } })
      case "IssueCreate":
        return json(response, 200, { data: { issueCreate: { success: true, issue: ISSUE } } })
      case "IssueUpdate":
        return json(response, 200, { data: { issueUpdate: { success: true, issue: ISSUE } } })
      case "CommentCreate":
        return json(response, 200, {
          data: {
            commentCreate: {
              success: true,
              comment: { id: "c1", body: "hi", issue: { id: ISSUE.id, identifier: "ENG-1" } }
            }
          }
        })
      default:
        return json(response, 200, { data: {} })
    }
  })

describe("Linear config", () => {
  it("prefers explicit values over the environment", () => {
    const env = {
      SMITHERS_LINEAR_API_KEY: "env-key",
      SMITHERS_LINEAR_WEBHOOK_SECRET: "env-secret",
      SMITHERS_LINEAR_API_BASE_URL: "https://linear.test/graphql"
    }
    expect(resolve({ apiKey: "explicit" }, env).apiKey).toBe("explicit")
    expect(resolve({}, env)).toEqual({
      apiKey: "env-key",
      webhookSecret: "env-secret",
      apiBaseUrl: "https://linear.test/graphql",
      requestTimeout: DEFAULT_REQUEST_TIMEOUT
    })
    expect(resolve({}, {}).apiBaseUrl).toBe(DEFAULT_API_BASE_URL)
  })
})

describe("normalizePriority", () => {
  it("maps Linear's vocabulary", () => {
    expect(normalizePriority("none")).toBe(0)
    expect(normalizePriority("urgent")).toBe(1)
    expect(normalizePriority("HIGH" as "high")).toBe(2)
    expect(normalizePriority("normal")).toBe(3)
    expect(normalizePriority("medium")).toBe(3)
    expect(normalizePriority("low")).toBe(4)
    expect(normalizePriority(2)).toBe(2)
    expect(normalizePriority(undefined)).toBeUndefined()
  })

  it("refuses a number outside 0-4 and an unknown name", () => {
    expect(() => normalizePriority(5)).toThrow(/expected 0-4/)
    expect(() => normalizePriority(-1)).toThrow(/expected 0-4/)
    expect(() => normalizePriority(1.5)).toThrow(/expected 0-4/)
    expect(() => normalizePriority("critical" as "high")).toThrow(/Unknown Linear priority/)
  })
})

describe("retryDelayMs", () => {
  it("honors Retry-After and the reset header, capped at 30 seconds", () => {
    expect(retryDelayMs(new Headers({ "retry-after": "2" }))).toBe(2000)
    expect(retryDelayMs(new Headers({ "retry-after": "600" }))).toBe(30_000)
    expect(retryDelayMs(new Headers({ "retry-after": "soon" }))).toBeUndefined()
    expect(retryDelayMs(new Headers({ "x-ratelimit-requests-reset": "1005" }), 1000)).toBe(5)
    expect(retryDelayMs(new Headers({ "x-ratelimit-requests-reset": "500" }), 1000)).toBe(0)
    expect(retryDelayMs(new Headers({ "x-ratelimit-requests-reset": "soon" }), 1000)).toBeUndefined()
    expect(retryDelayMs(new Headers())).toBeUndefined()
  })
})

describe("LinearClient over a real HTTP server", () => {
  it("sends the API key raw in Authorization and never elsewhere", async () => {
    fixture = await graphql()
    await Effect.runPromise(client().resolveTeam({ teamKey: "ENG" }))
    const [sent] = fixture.requests
    expect(sent?.headers["authorization"]).toBe(API_KEY)
    expect(sent?.body).not.toContain(API_KEY)
  })

  it("fails with credentials-missing when no key is configured", async () => {
    fixture = await graphql()
    const failure = await Effect.runPromise(
      Effect.flip(make({ apiBaseUrl: fixture.origin }, {}).query("query X { x }"))
    )
    expect(failure.reason).toBe("credentials-missing")
    expect(fixture.requests).toHaveLength(0)
  })

  it("caches a team lookup per client", async () => {
    fixture = await graphql()
    const linear = client()
    await Effect.runPromise(linear.resolveTeam({ teamKey: "ENG" }))
    await Effect.runPromise(linear.resolveTeam({ teamKey: "eng" }))
    expect(fixture.requests.filter((request) => operation(request.body) === "TeamByKey")).toHaveLength(1)
  })

  it("passes an explicit team id through without a lookup", async () => {
    fixture = await graphql()
    expect(await Effect.runPromise(client().resolveTeam({ teamId: "team-x" }))).toEqual({
      id: "team-x",
      key: undefined
    })
    expect(fixture.requests).toHaveLength(0)
  })

  it("requires a team and reports an unknown key", async () => {
    fixture = await graphql({ TeamByKey: { teams: { nodes: [] } } })
    expect((await Effect.runPromise(Effect.flip(client().resolveTeam({})))).message).toContain("pass teamId or teamKey")
    expect((await Effect.runPromise(Effect.flip(client().resolveTeam({ teamKey: "  " })))).message)
      .toContain("pass teamId or teamKey")
    expect((await Effect.runPromise(Effect.flip(client().resolveTeam({ teamKey: "NOPE" })))).message)
      .toContain("team with key \"NOPE\" not found")
  })

  it("resolves a state name case-insensitively and caches the list", async () => {
    fixture = await graphql()
    const linear = client()
    expect(await Effect.runPromise(linear.resolveStateId(TEAM.id, "in progress"))).toBe("state-progress")
    await Effect.runPromise(linear.resolveStateId(TEAM.id, "Todo"))
    expect(fixture.requests.filter((request) => operation(request.body) === "WorkflowStates")).toHaveLength(1)
  })

  it("names the states it knows when one is missing", async () => {
    fixture = await graphql()
    const failure = await Effect.runPromise(Effect.flip(client().resolveStateId(TEAM.id, "Shipped")))
    expect(failure.message).toContain("\"Shipped\" not found")
    expect(failure.details).toMatchObject({ known: ["Todo", "In Progress"] })
  })

  it("resolves label names and reports every missing one at once", async () => {
    fixture = await graphql()
    const linear = client()
    expect(await Effect.runPromise(linear.resolveLabelIds(TEAM.id, ["bug", "Infra"])))
      .toEqual(["label-bug", "label-infra"])
    const failure = await Effect.runPromise(Effect.flip(linear.resolveLabelIds(TEAM.id, ["Bug", "Nope", "Other"])))
    expect(failure.message).toContain("Nope, Other")
    expect(fixture.requests.filter((request) => operation(request.body) === "IssueLabels")).toHaveLength(1)
  })

  it("creates an issue, resolving the team, state, and labels by name", async () => {
    fixture = await graphql()
    const issue = await Effect.runPromise(
      client().createIssue({
        teamKey: "ENG",
        title: "Broken build",
        description: "d",
        priority: "high",
        stateName: "In Progress",
        labels: ["Bug"],
        assigneeId: "user-1",
        projectId: "project-1",
        estimate: 3,
        dueDate: "2026-01-01"
      })
    )
    expect(issue.identifier).toBe("ENG-1")
    const created = fixture.requests.find((request) => operation(request.body) === "IssueCreate")
    expect(JSON.parse(created?.body ?? "{}").variables.input).toEqual({
      title: "Broken build",
      description: "d",
      assigneeId: "user-1",
      projectId: "project-1",
      estimate: 3,
      dueDate: "2026-01-01",
      priority: 2,
      stateId: "state-progress",
      labelIds: ["label-bug"],
      teamId: TEAM.id
    })
  })

  it("passes explicit state and label ids through unresolved", async () => {
    fixture = await graphql()
    await Effect.runPromise(
      client().createIssue({
        teamId: TEAM.id,
        title: "t",
        stateId: "state-x",
        labelIds: ["label-x"]
      })
    )
    expect(fixture.requests.map((request) => operation(request.body))).toEqual(["IssueCreate"])
  })

  it("refuses over-specified create fields before sending a mutation", async () => {
    fixture = await graphql()
    for (
      const fields of [
        { stateId: "state-todo", stateName: "Todo" },
        { labelIds: ["label-bug"], labels: ["Bug"] }
      ]
    ) {
      const exit = await Effect.runPromise(Effect.exit(
        client().createIssue({
          teamId: TEAM.id,
          title: "t",
          ...fields
        })
      ))
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
      expect(failure).toMatchObject({ reason: "decode-failed" })
    }
    expect(fixture.requests.some((request) => operation(request.body) === "IssueCreate")).toBe(false)
  })

  it("refuses over-specified update fields before sending a mutation", async () => {
    fixture = await graphql()
    for (
      const fields of [
        { stateId: "state-todo", stateName: "Todo" },
        { labelIds: ["label-bug"], labels: ["Bug"] }
      ]
    ) {
      const exit = await Effect.runPromise(Effect.exit(client().updateIssue("issue-uuid", fields)))
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
      expect(failure).toMatchObject({ reason: "decode-failed" })
    }
    expect(fixture.requests.some((request) => operation(request.body) === "IssueUpdate")).toBe(false)
  })

  it("reports a mutation that did not return an issue", async () => {
    fixture = await graphql({ IssueCreate: { issueCreate: { success: false } } })
    const failure = await Effect.runPromise(Effect.flip(client().createIssue({ teamId: TEAM.id, title: "t" })))
    expect(failure.message).toContain("issueCreate did not return an issue")
  })

  it("resolves an ENG-123 identifier to a UUID before mutating", async () => {
    fixture = await graphql()
    await Effect.runPromise(client().updateIssue("ENG-1", { title: "renamed" }))
    const updated = fixture.requests.find((request) => operation(request.body) === "IssueUpdate")
    expect(JSON.parse(updated?.body ?? "{}").variables.id).toBe("issue-uuid")
  })

  it("updates by UUID without a lookup when no names need resolving", async () => {
    fixture = await graphql()
    await Effect.runPromise(client().updateIssue("issue-uuid", { title: "renamed" }))
    expect(fixture.requests.map((request) => operation(request.body))).toEqual(["IssueUpdate"])
  })

  it("looks the issue up for its team when a state name needs resolving", async () => {
    fixture = await graphql()
    await Effect.runPromise(client().updateIssue("issue-uuid", { stateName: "Todo" }))
    expect(fixture.requests.map((request) => operation(request.body)))
      .toEqual(["Issue", "WorkflowStates", "IssueUpdate"])
  })

  it("refuses to resolve a name when the issue carries no team", async () => {
    fixture = await graphql({ Issue: { issue: { ...ISSUE, team: null } } })
    const linear = client()
    expect((await Effect.runPromise(Effect.flip(linear.updateIssue("issue-uuid", { stateName: "Todo" })))).message)
      .toContain("requires the issue's team")
    expect((await Effect.runPromise(Effect.flip(linear.updateIssue("issue-uuid", { labels: ["Bug"] })))).message)
      .toContain("requires the issue's team")
  })

  it("reports an update and a comment that did not come back", async () => {
    fixture = await graphql({
      IssueUpdate: { issueUpdate: { success: false } },
      CommentCreate: { commentCreate: { success: false } }
    })
    expect((await Effect.runPromise(Effect.flip(client().updateIssue("issue-uuid", { title: "t" })))).message)
      .toContain("issueUpdate did not return an issue")
    expect((await Effect.runPromise(Effect.flip(client().commentOnIssue("issue-uuid", "hi")))).message)
      .toContain("commentCreate did not return a comment")
  })

  it("comments on an issue by identifier and by UUID", async () => {
    fixture = await graphql()
    const linear = client()
    expect((await Effect.runPromise(linear.commentOnIssue("ENG-1", "hi"))).id).toBe("c1")
    expect(fixture.requests.map((request) => operation(request.body))).toEqual(["Issue", "CommentCreate"])
    await Effect.runPromise(linear.commentOnIssue("issue-uuid", "hi"))
    expect(fixture.requests.map((request) => operation(request.body)).slice(2)).toEqual(["CommentCreate"])
  })

  it("reports a missing issue", async () => {
    fixture = await graphql({ Issue: { issue: null } })
    expect((await Effect.runPromise(Effect.flip(client().getIssue("ENG-9")))).message).toContain("\"ENG-9\" not found")
  })

  it("surfaces a GraphQL error list", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { errors: [{ message: "Entity not found" }, { message: "Access denied" }] })
    )
    const failure = await Effect.runPromise(Effect.flip(client().query("query X { x }")))
    expect(failure.message).toContain("Entity not found; Access denied")
  })

  it("surfaces an errorless non-2xx response", async () => {
    fixture = await startFixture((_request, response) => json(response, 400, { errors: [{ message: "bad" }] }))
    const failure = await Effect.runPromise(Effect.flip(client().query("query X { x }")))
    expect(failure.message).toContain("responded 400")
    expect(failure.details).toMatchObject({ status: 400 })
  })

  it("reports a non-JSON body", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" })
      response.end("<html>maintenance</html>")
    })
    const failure = await Effect.runPromise(Effect.flip(client().query("query X { x }")))
    expect(failure.reason).toBe("decode-failed")
  })

  it("reports a transport failure", async () => {
    const closed = await startFixture((_request, response) => {
      response.end()
    })
    const origin = closed.origin
    await closed.close()
    const failure = await Effect.runPromise(
      Effect.flip(make({ apiKey: API_KEY, apiBaseUrl: origin }).query("query X { x }"))
    )
    expect(failure.message).toContain("network error")
  })

  it("retries a 429 that names its delay, then succeeds", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 429, { errors: [] }, { "retry-after": "0" })
        return
      }
      json(response, 200, { data: { ok: true } })
    })
    expect(await Effect.runPromise(client().query("query X { x }"))).toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it("uses exponential backoff when a retryable response names no delay", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 503, {})
        return
      }
      json(response, 200, { data: { ok: true } })
    })
    const startedAt = Date.now()
    expect(await Effect.runPromise(client().query("query X { x }"))).toEqual({ ok: true })
    expect(calls).toBe(2)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200)
  })

  it("gives up after five attempts on a persistent 5xx", async () => {
    fixture = await startFixture((_request, response) => json(response, 503, {}, { "retry-after": "0" }))
    const failure = await Effect.runPromise(Effect.flip(client().query("query X { x }")))
    expect(failure.message).toContain("after 5 attempts")
    expect(fixture.requests).toHaveLength(5)
  })

  it("interrupting the fiber aborts the request in flight", async () => {
    fixture = await startFixture(() => {
      // Never answers: the only way out is the interrupt.
    })
    const server = fixture
    // The fixture, not a duration, says when the request is in flight and when
    // its socket closed, so a loaded machine cannot interrupt before the
    // server ever saw the request. Interrupting the fiber is the interruption
    // a cancelled run delivers.
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(client().query("query X { x }"))
        yield* Effect.promise(() => server.arrived)
        yield* Fiber.interrupt(fiber)
        yield* Effect.timeout(Effect.promise(() => server.closed), "10 seconds")
        return yield* Effect.exit(Fiber.join(fiber))
      })
    )
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(server.requests).toHaveLength(1)
  })

  it("does not start a request for an already-aborted run signal", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { data: { x: true } }))
    await expect(
      Effect.runPromise(client().query("query X { x }"), { signal: AbortSignal.abort("already stopped") })
    ).rejects.toThrow()
    expect(fixture.requests).toHaveLength(0)
  })
})

describe("mutations are not repeated on an ambiguous answer", () => {
  // Linear may have committed the mutation and lost the answer, so a repeat
  // files a second issue. The action's tier says irreversible.
  it("issues a mutation exactly once when the server errors", async () => {
    const runs: ReadonlyArray<() => Effect.Effect<unknown, IntegrationError>> = [
      () => client().createIssue({ teamId: "team-eng-id", title: "t" }),
      () => client().updateIssue("issue-uuid", { title: "t" }),
      () => client().commentOnIssue("issue-uuid", "hi")
    ]
    for (const run of runs) {
      fixture = await startFixture((_request, response) => json(response, 503, {}, { "retry-after": "0" }))
      const failure = await Effect.runPromise(Effect.flip(run()))
      expect(fixture.requests).toHaveLength(1)
      expect(failure.details).toMatchObject({ outcomeUnknown: true })
      expect(failure.message).toContain("outcome is unknown")
      await fixture.close()
      fixture = undefined
    }
  })

  it("marks a write's dropped connection as an unknown outcome", async () => {
    fixture = await startFixture((_request, response) => {
      response.destroy()
    })
    const failure = await Effect.runPromise(
      Effect.flip(client().createIssue({ teamId: "team-eng-id", title: "t" }))
    )
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.message).toContain("write failed")
    expect(failure.message).toContain("outcome is unknown")
    expect(failure.details).toMatchObject({ outcomeUnknown: true })
    expect(fixture.requests).toHaveLength(1)
  })

  it("still retries a read, where repeating costs nothing", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 503, {}, { "retry-after": "0" })
        return
      }
      json(response, 200, { data: { issue: ISSUE } })
    })
    await Effect.runPromise(client().getIssue("issue-uuid"))
    expect(calls).toBe(2)
  })
})

describe("typed failures the client used to raise as defects", () => {
  // `normalizePriority` throws, and a throw inside `Effect.gen` is a defect, so
  // a caller's `catchAll` on `IntegrationError` missed it entirely.
  it("fails decode-failed for a priority outside the scale", async () => {
    fixture = await graphql()
    for (const priority of [9, -1, 1.5, "urgentish"] as ReadonlyArray<Priority>) {
      const failure = await Effect.runPromise(
        Effect.flip(client().createIssue({ teamId: "team-eng-id", title: "t", priority }))
      )
      expect(failure.reason).toBe("decode-failed")
    }
  })

  it("fails decode-failed rather than throwing on a connection of the wrong shape", async () => {
    fixture = await graphql({ WorkflowStates: { workflowStates: { nodes: { not: "an array" } } } })
    const failure = await Effect.runPromise(Effect.flip(client().resolveStateId("team-eng-id", "Todo")))
    expect(failure.reason).toBe("decode-failed")
    expect(failure.details).toMatchObject({ path: "workflowStates.nodes" })
  })

  it("names the member path of a malformed node", async () => {
    fixture = await graphql({ IssueLabels: { issueLabels: { nodes: [{ name: "Bug" }] } } })
    const failure = await Effect.runPromise(Effect.flip(client().resolveLabelIds("team-eng-id", ["Bug"])))
    expect(failure.details).toMatchObject({ path: "issueLabels.nodes[0].id" })
  })

  it("keeps an absent state name as undefined", async () => {
    fixture = await graphql({ WorkflowStates: { workflowStates: { nodes: [{ id: "state-unnamed" }] } } })
    const failure = await Effect.runPromise(Effect.flip(client().resolveStateId("team-eng-id", "Todo")))
    expect(failure.reason).toBe("decode-failed")
    expect(failure.details).toMatchObject({ known: [undefined] })
  })

  it("names an issue payload that is not an object", async () => {
    fixture = await graphql({ Issue: { issue: "ENG-1" } })
    const failure = await Effect.runPromise(Effect.flip(client().getIssue("ENG-1")))
    expect(failure.reason).toBe("decode-failed")
    expect(failure.details).toMatchObject({ path: "issue" })
  })

  it("fails decode-failed for a mutation result missing a field it promises", async () => {
    fixture = await graphql({ IssueCreate: { issueCreate: { success: true, issue: { id: "i" } } } })
    const failure = await Effect.runPromise(Effect.flip(client().createIssue({ teamId: "t", title: "t" })))
    expect(failure.reason).toBe("decode-failed")
    expect(failure.details).toMatchObject({ path: "issueCreate.issue.identifier" })
  })

  it("never carries the response body into the failure", async () => {
    fixture = await graphql({ Issue: { issue: { id: 7, secret: "do-not-persist" } } })
    const failure = await Effect.runPromise(Effect.flip(client().getIssue("issue-uuid")))
    expect(JSON.stringify(failure.details)).not.toContain("do-not-persist")
  })
})

describe("team resolution", () => {
  // Documented as exactly one of the two. Preferring `teamId` silently filed
  // on a team the caller did not name, on an irreversible action.
  it("refuses both a team id and a team key", async () => {
    fixture = await graphql()
    const failure = await Effect.runPromise(
      Effect.flip(client().resolveTeam({ teamId: "team-eng-id", teamKey: "ENG" }))
    )
    expect(failure.reason).toBe("decode-failed")
    expect(failure.message).toContain("not both")
    expect(fixture.requests).toHaveLength(0)
  })

  // The cache was keyed uppercase while the query sent the raw key, so the
  // same call succeeded or failed depending on unrelated history.
  it("decides the same way for a lowercase key on a cold client and a warm one", async () => {
    fixture = await graphql()
    const cold = client()
    expect((await Effect.runPromise(cold.resolveTeam({ teamKey: "eng" }))).id).toBe(TEAM.id)
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}").variables.key).toBe("ENG")

    const warm = client()
    await Effect.runPromise(warm.resolveTeam({ teamKey: "ENG" }))
    const before = fixture.requests.length
    expect((await Effect.runPromise(warm.resolveTeam({ teamKey: "eng" }))).id).toBe(TEAM.id)
    expect(fixture.requests).toHaveLength(before)
  })

  // The cache hands the same object to every later call on this client, so a
  // consumer that mutated it would change the identity the next mutation uses.
  it("hands back a frozen team", async () => {
    fixture = await graphql()
    const team = await Effect.runPromise(client().resolveTeam({ teamKey: "ENG" }))
    expect(Object.isFrozen(team)).toBe(true)
  })
})

describe("label clearing", () => {
  // `labels: []` used to read as an absent field, so the name path could not
  // remove a label at all.
  it("maps an explicit empty label list to an empty labelIds", async () => {
    fixture = await graphql()
    await Effect.runPromise(client().updateIssue("issue-uuid", { labels: [] }))
    const update = fixture.requests.find((request) => operation(request.body) === "IssueUpdate")
    expect(JSON.parse(update?.body ?? "{}").variables.input).toEqual({ labelIds: [] })
  })

  it("still leaves labels alone when the field is absent", async () => {
    fixture = await graphql()
    await Effect.runPromise(client().updateIssue("issue-uuid", { title: "t" }))
    const update = fixture.requests.find((request) => operation(request.body) === "IssueUpdate")
    expect(JSON.parse(update?.body ?? "{}").variables.input).not.toHaveProperty("labelIds")
  })
})

describe("adversarial mutation results", () => {
  it("names a team member of the wrong shape on an issue", async () => {
    fixture = await graphql({ Issue: { issue: { ...ISSUE, team: "ENG" } } })
    expect((await Effect.runPromise(Effect.flip(client().getIssue("issue-uuid")))).details)
      .toMatchObject({ path: "issue.team" })
    await fixture.close()
    fixture = await graphql({ Issue: { issue: { ...ISSUE, team: { key: "ENG" } } } })
    expect((await Effect.runPromise(Effect.flip(client().getIssue("issue-uuid")))).details)
      .toMatchObject({ path: "issue.team.id" })
  })

  it("names a comment field of the wrong shape", async () => {
    fixture = await graphql({ CommentCreate: { commentCreate: { success: true, comment: "hi" } } })
    expect((await Effect.runPromise(Effect.flip(client().commentOnIssue("issue-uuid", "hi")))).details)
      .toMatchObject({ path: "commentCreate.comment" })
    await fixture.close()
    fixture = await graphql({ CommentCreate: { commentCreate: { success: true, comment: { id: "c1" } } } })
    expect((await Effect.runPromise(Effect.flip(client().commentOnIssue("issue-uuid", "hi")))).details)
      .toMatchObject({ path: "commentCreate.comment.body" })
  })

  it("reports a mutation envelope that is not a record", async () => {
    fixture = await graphql({ IssueUpdate: { issueUpdate: "nope" } })
    const failure = await Effect.runPromise(Effect.flip(client().updateIssue("issue-uuid", { title: "t" })))
    expect(failure.reason).toBe("delivery-failed")
  })

  it("reports a comment mutation payload that is not a record", async () => {
    fixture = await graphql({ CommentCreate: { commentCreate: "nope" } })
    const failure = await Effect.runPromise(Effect.flip(client().commentOnIssue("issue-uuid", "hi")))
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.details).toMatchObject({ success: false, idOrIdentifier: "issue-uuid" })
  })

  it("preserves absent and null issue links on a returned comment", async () => {
    for (const issue of [undefined, null]) {
      const comment = { id: "c", body: "hi", ...(issue === undefined ? {} : { issue }) }
      fixture = await graphql({ CommentCreate: { commentCreate: { success: true, comment } } })
      const returned = await Effect.runPromise(client().commentOnIssue("issue-uuid", "hi"))
      expect(returned.issue).toBe(issue)
      await fixture.close()
      fixture = undefined
    }
  })

  it("reports a connection that is not an object", async () => {
    fixture = await graphql({ WorkflowStates: { workflowStates: "nope" } })
    expect((await Effect.runPromise(Effect.flip(client().resolveStateId("team-eng-id", "Todo")))).details)
      .toMatchObject({ path: "workflowStates" })
    await fixture.close()
    fixture = await graphql({ IssueLabels: { issueLabels: { nodes: [7] } } })
    expect((await Effect.runPromise(Effect.flip(client().resolveLabelIds("team-eng-id", ["Bug"])))).details)
      .toMatchObject({ path: "issueLabels.nodes[0]" })
  })

  // Erasing a wrong-typed member silently turned "Linear changed this field"
  // into "no state by that name", which reads as a caller error.
  it("names a wrong-typed optional member instead of erasing it", async () => {
    fixture = await graphql({ WorkflowStates: { workflowStates: { nodes: [{ id: "s", name: 7 }] } } })
    expect((await Effect.runPromise(Effect.flip(client().resolveStateId("team-eng-id", "Todo")))).details)
      .toMatchObject({ path: "workflowStates.nodes[0].name" })
    await fixture.close()

    fixture = await graphql({ Issue: { issue: { ...ISSUE, team: { id: "t", key: 7 } } } })
    expect((await Effect.runPromise(Effect.flip(client().getIssue("issue-uuid")))).details)
      .toMatchObject({ path: "issue.team.key" })
    await fixture.close()

    fixture = await graphql({
      CommentCreate: { commentCreate: { success: true, comment: { id: "c", body: "b", issue: { id: 7 } } } }
    })
    expect((await Effect.runPromise(Effect.flip(client().commentOnIssue("issue-uuid", "hi")))).details)
      .toMatchObject({ path: "commentCreate.comment.issue.id" })
  })

  it("treats an absent connection as no members", async () => {
    fixture = await graphql({ IssueLabels: { issueLabels: null } })
    const failure = await Effect.runPromise(Effect.flip(client().resolveLabelIds("team-eng-id", ["Bug"])))
    expect(failure.message).toContain("label(s) not found")
    await fixture.close()
    // A connection object that carries no `nodes` key at all says the same
    // thing as one whose `nodes` is null: there are none.
    fixture = await graphql({ IssueLabels: { issueLabels: {} } })
    expect((await Effect.runPromise(Effect.flip(client().resolveLabelIds("team-eng-id", ["Bug"])))).message)
      .toContain("label(s) not found")
  })

  // A GraphQL error list is provider-shaped, so a member without a `message`
  // has to read as an unnamed error rather than as "undefined".
  it("names a GraphQL error that carries no message", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { errors: [{}, { message: "nope" }] }))
    const failure = await Effect.runPromise(Effect.flip(client().getIssue("issue-uuid")))
    expect(failure.message).toContain("unknown")
    expect(failure.message).toContain("nope")
  })

  // A 200 with neither `data` nor `errors` is a contract change. It must reach
  // the caller as a mutation that returned nothing, not as a crash reading a
  // member off undefined.
  it("reports a success envelope that carries no data at all", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    const failure = await Effect.runPromise(
      Effect.flip(client().createIssue({ teamId: "team-eng-id", title: "t" }))
    )
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.details).toMatchObject({ success: false })
  })

  // `success` absent is not `success: false`, and the failure detail has to say
  // which one Linear sent rather than inventing a value.
  it("reports a mutation payload that omits success", async () => {
    const cases: ReadonlyArray<readonly [string, () => Effect.Effect<unknown, IntegrationError>]> = [
      ["IssueCreate", () => client().createIssue({ teamId: "team-eng-id", title: "t" })],
      ["IssueUpdate", () => client().updateIssue("issue-uuid", { title: "t" })],
      ["CommentCreate", () => client().commentOnIssue("issue-uuid", "hi")]
    ]
    for (const [operationName, run] of cases) {
      const key = operationName.charAt(0).toLowerCase() + operationName.slice(1)
      fixture = await graphql({ [operationName]: { [key]: { issue: ISSUE, comment: { id: "c" } } } })
      const failure = await Effect.runPromise(Effect.flip(run()))
      expect(failure.details).toMatchObject({ success: false })
      await fixture.close()
      fixture = undefined
    }
  })

  it("names a comment's issue member when it is not an object", async () => {
    fixture = await graphql({
      CommentCreate: { commentCreate: { success: true, comment: { id: "c", body: "b", issue: "ENG-1" } } }
    })
    expect((await Effect.runPromise(Effect.flip(client().commentOnIssue("issue-uuid", "hi")))).details)
      .toMatchObject({ path: "commentCreate.comment.issue" })
  })

  // The same rule `namedNodes` follows for a state or a label: erasing a
  // wrong-typed member turns "Linear changed this field" into "this team has no
  // key", which reads as a caller error and hides the contract change.
  it("names a wrong-typed member on a resolved team instead of erasing it", async () => {
    for (const [member, path] of [["key", "teams.nodes[0].key"], ["name", "teams.nodes[0].name"]] as const) {
      fixture = await graphql({ TeamByKey: { teams: { nodes: [{ id: "team-eng-id", [member]: 7 }] } } })
      const failure = await Effect.runPromise(Effect.flip(client().createIssue({ teamKey: "ENG", title: "t" })))
      expect(failure.reason).toBe("decode-failed")
      expect(failure.details).toMatchObject({ path })
      await fixture.close()
      fixture = undefined
    }
  })

  // Linear may answer a team lookup with the id alone. That is usable, so it
  // resolves rather than failing, and the optional members read as absent.
  it("accepts a team that carries only an id", async () => {
    fixture = await graphql({
      TeamByKey: { teams: { nodes: [{ id: "team-eng-id" }] } },
      IssueCreate: { issueCreate: { success: true, issue: ISSUE } }
    })
    const created = await Effect.runPromise(client().createIssue({ teamKey: "ENG", title: "t" }))
    expect(created.id).toBe(ISSUE.id)
  })
})

describe("Linear response lifecycle", () => {
  it.each([429, 503])("cancels unread %i bodies before retrying", async (status) => {
    const cancelled = vi.fn()
    let signal: AbortSignal | null | undefined
    const request = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
      signal = init?.signal
      return new Response(new ReadableStream({ cancel: cancelled }), {
        status,
        headers: { "retry-after": "0" }
      })
    }).mockImplementationOnce(async () => {
      expect(cancelled).toHaveBeenCalledOnce()
      expect(signal?.aborted).toBe(true)
      return Response.json({ data: { x: true } })
    })
    vi.stubGlobal("fetch", request)
    expect(await Effect.runPromise(make({ apiKey: API_KEY }).query("query X { x }"))).toEqual({ x: true })
    expect(request).toHaveBeenCalledTimes(2)
  })

  // A caller running its own mutation through `query` used to get 5xx
  // retries by default, so a write Linear had committed ran twice.
  it.each([
    "mutation Archive { issueArchive(id: \"x\") { success } }",
    "# archive\nmutation { issueArchive(id: \"x\") { success } }",
    "fragment F on Issue { id }\nmutation M { issueArchive(id: \"x\") { success } }"
  ])("does not repeat a caller-supplied mutation on a 502 by default: %s", async (gql) => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response("bad gateway", { status: 502 }))
    vi.stubGlobal("fetch", request)
    const failure = await Effect.runPromise(Effect.flip(make({ apiKey: API_KEY }).query(gql)))
    expect(failure.details).toMatchObject({ outcomeUnknown: true })
    expect(request).toHaveBeenCalledOnce()
  })

  it("still retries a caller-supplied mutation that opts in", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(Response.json({ data: { x: true } }))
    vi.stubGlobal("fetch", request)
    const data = await Effect.runPromise(
      make({ apiKey: API_KEY }).query("mutation X { x }", {}, { retryServerErrors: true })
    )
    expect(data).toEqual({ x: true })
    expect(request).toHaveBeenCalledTimes(2)
  })

  // Serialization runs before anything is sent, so its failure is a caller
  // error with a known outcome, never a network failure.
  it("fails invalid-config without sending when variables cannot be serialized", async () => {
    const request = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", request)
    const failure = await Effect.runPromise(Effect.flip(
      make({ apiKey: API_KEY }).query("mutation X { x }", { big: 1n }, { retryServerErrors: false })
    ))
    expect(failure.reason).toBe("invalid-config")
    expect(failure.details).toMatchObject({ outcomeUnknown: false })
    expect(request).not.toHaveBeenCalled()
  })

  it("cancels an unread write 503 without repeating the write", async () => {
    const cancelled = vi.fn()
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream({ cancel: cancelled }), { status: 503 })
    )
    vi.stubGlobal("fetch", request)
    const failure = await Effect.runPromise(Effect.flip(
      make({ apiKey: API_KEY }).query("mutation X { x }", {}, { retryServerErrors: false })
    ))
    expect(failure.details).toMatchObject({ outcomeUnknown: true })
    expect(cancelled).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([true, false])("preserves write ambiguity on a body reset (readOnly=%s)", async (readOnly) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{\"data\":"))
          },
          pull(controller) {
            controller.error(new Error("connection reset"))
          }
        })
      )
    )
    vi.stubGlobal("fetch", request)
    const failure = await Effect.runPromise(Effect.flip(
      make({ apiKey: API_KEY }).query(readOnly ? "query X { x }" : "mutation X { x }", {}, {
        retryServerErrors: readOnly
      })
    ))
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.details).toMatchObject({ outcomeUnknown: !readOnly, cause: "connection reset" })
    expect(request).toHaveBeenCalledOnce()
  })

  it("does not retry a fetch rejection", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection reset"))
    vi.stubGlobal("fetch", request)
    const failure = await Effect.runPromise(Effect.flip(make({ apiKey: API_KEY }).query("query X { x }")))
    expect(failure.reason).toBe("delivery-failed")
    expect(request).toHaveBeenCalledOnce()
  })
})

it("redacts a primitive body read failure and preserves write ambiguity", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(`connection reset ${API_KEY}`)
          }
        })
      )
    )
  )
  const failure = await Effect.runPromise(Effect.flip(
    make({ apiKey: API_KEY }).query("mutation X { x }", {}, { retryServerErrors: false })
  ))
  expect(failure.details).toMatchObject({ cause: "connection reset [REDACTED]", outcomeUnknown: true })
  expect(JSON.stringify(failure)).not.toContain(API_KEY)
})

it("cancels the response before entering rate-limit backoff", async () => {
  const cancelled = vi.fn()
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(new ReadableStream({ cancel: cancelled }), {
      status: 429,
      headers: { "retry-after": "30" }
    })
  )
  vi.stubGlobal("fetch", request)
  const controller = new AbortController()
  const running = Effect.runPromiseExit(make({ apiKey: API_KEY }).query("query X { x }"), {
    signal: controller.signal
  })
  try {
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
    expect(request).toHaveBeenCalledOnce()
  } finally {
    controller.abort()
    await running
  }
})

it("interrupts a pending Linear response body read", async () => {
  let closed = false
  fixture = await startFixture((_request, response) => {
    response.on("close", () => {
      closed = true
    })
    response.writeHead(200, { "content-type": "application/json" })
    response.write("{\"data\":")
  })
  const exit = await Effect.runPromise(Effect.exit(Effect.timeout(client().query("query X { x }"), "100 millis")))
  expect(exit._tag).toBe("Failure")
  await vi.waitFor(() => expect(closed).toBe(true))
  expect(fixture.requests).toHaveLength(1)
})

describe("text Linear wrote", () => {
  it("reaches the journal with the API key removed", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { errors: [{ message: `Authentication failed for ${API_KEY}` }] })
    )
    const failure = await Effect.runPromise(Effect.flip(client().query("query X { x }")))
    expect(failure.message).not.toContain(API_KEY)
    expect(failure.message).toContain("Authentication failed for [REDACTED]")
    expect(failure.details?.["errors"]).toEqual(["Authentication failed for [REDACTED]"])
    expect(fromIntegrationError(failure).message).not.toContain(API_KEY)
  })

  it("keeps the API key out of the details of a non-2xx answer", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 403, { errors: [{ message: `key ${API_KEY} is revoked` }] })
    )
    const failure = await Effect.runPromise(Effect.flip(client().query("query X { x }")))
    expect(failure.details?.["errors"]).toEqual(["key [REDACTED] is revoked"])
    expect(JSON.stringify(failure.details)).not.toContain(API_KEY)
  })

  // A structured `message` could nest the key anywhere, so it is reported as an
  // unnamed error rather than stringified into the journal.
  it("does not copy a non-string GraphQL message into the failure", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { errors: [{ message: { token: API_KEY } }] })
    )
    const failure = await Effect.runPromise(Effect.flip(client().query("query X { x }")))
    expect(failure.message).toContain("unknown")
    expect(JSON.stringify(failure.details)).not.toContain(API_KEY)
  })
})

// Inspect includes non-enumerable cause/stack fields that JSON serialization omits.
const expectRedacted = (failure: IntegrationError, secret: string) => {
  expect(inspect(failure, { depth: null })).not.toContain(secret)
  expect(JSON.stringify(failure)).not.toContain(secret)
  expect(JSON.stringify(fromIntegrationError(failure))).not.toContain(secret)
}

describe("credential redaction", () => {
  it.each(["fetch", "body", "primitive"])("sanitizes a %s failure and its retained cause", async (stage) => {
    const message = `rejected Bearer ${API_KEY}; ${API_KEY}; Bearer ${API_KEY}`
    const cause = Object.assign(new Error(message, { cause: new Error(message) }), { authorization: message })
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => {
        if (stage === "fetch") throw cause
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(stage === "primitive" ? message : cause)
            }
          })
        )
      })
    )
    const failure = await Effect.runPromise(
      Effect.flip(make({ apiKey: `Bearer ${API_KEY}` }, {}).query("mutation X { x }", {}, { retryServerErrors: false }))
    )
    expectRedacted(failure, API_KEY)
    expect(failure.cause).toBeInstanceOf(Error)
    expect((failure.cause as Error).message).toBe("rejected [REDACTED]; [REDACTED]; [REDACTED]")
    expect(failure.details).toMatchObject({ outcomeUnknown: true })
  })
})

it("redacts credentials in a JSON parse cause", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(API_KEY)))
  const failure = await Effect.runPromise(Effect.flip(make({ apiKey: API_KEY }, {}).query("query X { x }")))
  expect(failure.reason).toBe("decode-failed")
  expectRedacted(failure, API_KEY)
})

it("redacts the raw OAuth token as well as its Authorization header", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      errors: [{ message: `Bearer ${API_KEY} rejected ${API_KEY}; ${API_KEY}` }]
    }))
  )
  const failure = await Effect.runPromise(Effect.flip(make({ apiKey: `Bearer ${API_KEY}` }, {}).query("query X { x }")))
  expectRedacted(failure, API_KEY)
  expect(failure.summary).toContain("[REDACTED] rejected [REDACTED]; [REDACTED]")
})

// The five-attempt budget counts completed attempts, so a peer that answers
// with headers and then trickles the body forever is outside it.
describe("Linear request deadline", () => {
  const stalled = (onClose: () => void) =>
    startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.write("{\"data\":")
      response.on("close", onClose)
    })

  const deadlined = () =>
    make({ apiKey: API_KEY, apiBaseUrl: (fixture as Fixture).origin, requestTimeout: "200 millis" })

  it("fails a stalled query within the deadline and closes the socket", async () => {
    let closed!: () => void
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    fixture = await stalled(closed)
    const started = Date.now()
    const failure = await Effect.runPromise(Effect.flip(deadlined().query("query Q { viewer { id } }")))
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.summary).toContain("timed out")
    // A query applied nothing, so it is a plain transport failure.
    expect(failure.details).toMatchObject({ timedOut: true, outcomeUnknown: false })
    await socketClosed
  })

  it("reports a timed-out mutation as an unknown outcome", async () => {
    fixture = await stalled(() => {})
    const failure = await Effect.runPromise(
      Effect.flip(deadlined().query("mutation M { issueCreate { success } }", {}, { retryServerErrors: false }))
    )
    expect(failure.details).toMatchObject({ timedOut: true, outcomeUnknown: true })
    expect(failure.summary).toContain("outcome is unknown")
  })

  it("refuses a deadline that is not finite and positive", () => {
    for (const requestTimeout of [0, -1, "Infinity"] as const) {
      let thrown: unknown
      try {
        make({ apiKey: API_KEY, requestTimeout }, {})
      } catch (cause) {
        thrown = cause
      }
      expect(isIntegrationError(thrown) && thrown.reason, String(requestTimeout)).toBe("invalid-config")
    }
    expect(resolve({}, {}).requestTimeout).toEqual(DEFAULT_REQUEST_TIMEOUT)
  })
})

describe("Linear redirects", () => {
  it("fails on a redirect and never sends the API key to its target", async () => {
    fixture = await startFixture((request, response) => {
      if (request.url === "/captured") return json(response, 200, { data: { x: 1 } })
      response.writeHead(307, { location: "/captured" })
      response.end()
    })
    const failure = await Effect.runPromise(Effect.flip(client().query("query X { x }")))
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.details).toMatchObject({ status: 307 })
    expect(fixture.requests).toHaveLength(1)
  })
})
