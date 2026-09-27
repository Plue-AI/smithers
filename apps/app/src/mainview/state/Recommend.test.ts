import { describe, expect, test } from "bun:test"
import type { CatalogItem, CommandState } from "../flows/registry"
import {
  COMMANDS_MAX,
  isMaterialTransition,
  MAX_RECOMMENDATIONS,
  parseRecommendation,
  RECOMMEND_RETRY_MAX_MS,
  recommendRequest,
  recommendRetryAt,
  recommendServiceOrigin,
  recommendTail,
  repositoryRecommendationTail,
  ruleSuggestions,
  TAIL_MAX_CHARS,
  TAIL_MAX_MESSAGES
} from "./Recommend"

/*
 * The recommender's pure half: what triggers it, the request the contract
 * fixes, how the server's answer is validated against the registry, and the
 * rule it falls back to.
 */

const catalog: ReadonlyArray<CatalogItem> = [
  { name: "connect", summary: "Connect a repository" },
  { name: "wiki", summary: "Open the wiki notes" },
  { name: "flow.list", summary: "List the flows on your workspace" },
  { name: "issues.view", summary: "View an issue", args: "<number>" },
  { name: "card.maximize", summary: "Maximize a card", hidden: true }
]

const state: CommandState = {
  surface: "chat",
  typing: false,
  hasConnectors: true,
  admin: false,
  signedOut: false,
  identity: "signed-in as will"
}

describe("recommend: triggers", () => {
  test("material transitions regenerate; keystrokes, deltas, menus, and its own write do not", () => {
    for (const type of ["connector.local.connected", "message.response.completed", "tab.opened"]) {
      expect(isMaterialTransition(type)).toBe(true)
    }
    for (
      const type of [
        "composer.changed",
        "message.response.delta",
        "add-menu.toggled",
        "recommendations.updated",
        "flow.invoked",
        "toast.shown"
      ]
    ) {
      expect(isMaterialTransition(type)).toBe(false)
    }
  })
})

describe("recommend: the request", () => {
  for (const repo of ["practice:smithersai/hello-server", "local:checkout", null]) {
    test(`a non-hosted target ${repo} is null at the recommendation wire boundary`, () => {
      const input = { repo, catalog, messages: [] }
      expect(recommendRequest(input).repo).toBeNull()
      expect(input.repo).toBe(repo)
    })
  }

  test("carries the repo, the tail with wire roles, and every offerable flow with its summary", () => {
    const request = recommendRequest({
      repo: "smithersai/smithers",
      catalog,
      messages: [
        { role: "user", text: "what is failing in CI?" },
        { role: "smithers", text: "Smithers ran /flows", act: "Smithers ran /flows" },
        { role: "smithers", text: "   " },
        { role: "smithers", text: "The typecheck target is red.\n" }
      ]
    })
    expect(request.repo).toBe("smithersai/smithers")
    expect(request.tail).toEqual([
      { role: "user", text: "what is failing in CI?" },
      { role: "assistant", text: "The typecheck target is red." }
    ])
    expect(request.commands).toEqual([
      { name: "connect", summary: "Connect a repository" },
      { name: "wiki", summary: "Open the wiki notes" },
      { name: "flow.list", summary: "List the flows on your workspace" },
      { name: "issues.view", summary: "View an issue" }
    ])
    expect(request.commands.map((command) => command.name)).not.toContain("card.maximize")
  })

  test("the tail keeps the newest 12 messages and drops the oldest past 4000 characters", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, text: `m${index}` }))
    const capped = recommendTail(many)
    expect(capped.length).toBe(TAIL_MAX_MESSAGES)
    expect(capped[0]?.text).toBe("m8")
    expect(capped.at(-1)?.text).toBe("m19")

    const long = "x".repeat(3000)
    const heavy = recommendTail([
      { role: "user", text: long },
      { role: "smithers", text: long },
      { role: "user", text: "latest" }
    ])
    expect(heavy.map((entry) => entry.text)).toEqual([long, "latest"])
    expect(heavy.reduce((sum, entry) => sum + entry.text.length, 0)).toBeLessThanOrEqual(TAIL_MAX_CHARS)

    const [lone] = recommendTail([{ role: "user", text: `${"a".repeat(4000)}tail` }])
    expect(lone?.text.length).toBe(TAIL_MAX_CHARS)
    expect(lone?.text.endsWith("tail")).toBe(true)
  })

  test("the command list is capped at 300", () => {
    const wide = Array.from({ length: 350 }, (_, index) => ({ name: `flow.${index}`, summary: `Flow ${index}` }))
    expect(recommendRequest({ repo: null, catalog: wide, messages: [] }).commands.length).toBe(COMMANDS_MAX)
  })
})

describe("recommend: the answer contract", () => {
  test("drops unknown and hidden flows, dedupes, caps, golds the first, and labels with the summary", () => {
    const answer = parseRecommendation(
      {
        id: "rec-1",
        model: "gpt-oss-120b",
        commands: ["/issues.view", "card.maximize", "made.up", "issues.view", "wiki", 7, "connect", "flow.list"]
      },
      catalog
    )
    expect(answer?.id).toBe("rec-1")
    expect(answer?.model).toBe("gpt-oss-120b")
    expect(answer?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["issues.view", "wiki", "connect"])
    expect(answer?.suggestions.length).toBe(MAX_RECOMMENDATIONS)
    expect(answer?.suggestions[0]).toMatchObject({ id: "reco-issues.view", label: "View an issue", emphasis: "primary" })
    expect(answer?.suggestions[1]?.emphasis).toBe("secondary")
  })

  test("the surface the user is already on is never recommended", () => {
    const withChat = [...catalog, { name: "chat", summary: "Back to the conversation" }]
    const body = { id: "rec-2", model: "m", commands: ["chat", "wiki"] }
    expect(parseRecommendation(body, withChat, "chat")?.suggestions.map((s) => s.flow)).toEqual(["wiki"])
    // The pane's persisted surface id stays "wiki"; the flow that opens it is "wiki".
    expect(parseRecommendation(body, withChat, "world")?.suggestions.map((s) => s.flow)).toEqual(["chat"])
    expect(parseRecommendation({ id: "rec-3", commands: ["connect"] }, withChat, "connectors")?.suggestions).toEqual([])
    // Without a surface the parser keeps its old contract.
    expect(parseRecommendation(body, withChat)?.suggestions.map((s) => s.flow)).toEqual(["chat", "wiki"])
  })

  test("an answer naming nothing offerable is an id with no pills; a body without an id or list is no answer", () => {
    expect(parseRecommendation({ id: "rec-4", model: "m", commands: [] }, catalog)).toEqual({
      id: "rec-4",
      model: "m",
      suggestions: []
    })
    expect(parseRecommendation({ id: "rec-5", commands: ["made.up"] }, catalog)?.suggestions).toEqual([])
    expect(parseRecommendation("wiki", catalog)).toBeUndefined()
    expect(parseRecommendation(null, catalog)).toBeUndefined()
    expect(parseRecommendation({ commands: ["wiki"] }, catalog)).toBeUndefined()
    expect(parseRecommendation({ id: "rec-6", commands: "wiki" }, catalog)).toBeUndefined()
  })
})

describe("recommend: the rule", () => {
  test("the repo step leads, then the registry's recommendation order, capped", () => {
    const suggestions = ruleSuggestions({ state: { ...state, hasConnectors: false }, catalog })
    expect(suggestions.map((suggestion) => suggestion.flow)).toEqual(["connect", "wiki"])
    expect(suggestions[0]?.emphasis).toBe("primary")
  })

  test("with a repository open the repo step is gone and the first recommendation is gold", () => {
    const suggestions = ruleSuggestions({ state, catalog })
    expect(suggestions.map((suggestion) => suggestion.flow)).toEqual(["wiki", "connect"])
    expect(suggestions[0]?.emphasis).toBe("primary")
  })

  const lifecycleCatalog: ReadonlyArray<CatalogItem> = [
    ...catalog,
    { name: "approvals.list", summary: "List approvals" },
    { name: "runs.list", summary: "List runs" }
  ]

  test("an active approval leads ahead of the repo step and takes precedence over a live run", () => {
    const suggestions = ruleSuggestions({
      state,
      catalog: lifecycleCatalog,
      cards: [
        { kind: "approval", title: "Approve deployment", status: "active" },
        { kind: "run-trace", title: "Deploy", status: "active" }
      ]
    })
    expect(suggestions.map((suggestion) => suggestion.flow)).toEqual(["approvals.list", "wiki", "connect"])
    expect(suggestions[0]).toEqual({
      id: "reco-approvals.list",
      label: "Decide approvals",
      flow: "approvals.list",
      emphasis: "primary",
      why: "A run is parked on your decision."
    })
  })

  test("an active run without a pending approval leads ahead of the repo step", () => {
    const suggestions = ruleSuggestions({
      state,
      catalog: lifecycleCatalog,
      cards: [
        { kind: "approval", title: "Approved deployment", status: "acted" },
        { kind: "run-trace", title: "Deploy", status: "active" }
      ]
    })
    expect(suggestions.map((suggestion) => suggestion.flow)).toEqual(["runs.list", "wiki", "connect"])
    expect(suggestions[0]).toEqual({
      id: "reco-runs.list",
      label: "See your runs",
      flow: "runs.list",
      emphasis: "primary",
      why: "Runs are live on your workspace."
    })
  })

  test("an acted approval contributes no lifecycle suggestion", () => {
    const input = { state, catalog: lifecycleCatalog }
    expect(ruleSuggestions({
      ...input,
      cards: [{ kind: "approval", title: "Approved deployment", status: "acted" }]
    })).toEqual(ruleSuggestions(input))
  })

  test("lifecycle suggestions require an offerable command", () => {
    const input = {
      state,
      cards: [
        { kind: "approval" as const, title: "Approve deployment", status: "active" as const },
        { kind: "run-trace" as const, title: "Deploy", status: "active" as const }
      ]
    }
    for (const unavailableCatalog of [
      catalog,
      lifecycleCatalog.map((command) => command.name === "approvals.list" || command.name === "runs.list"
        ? { ...command, hidden: true }
        : command)
    ]) {
      expect(ruleSuggestions({ ...input, catalog: unavailableCatalog })).toEqual(
        ruleSuggestions({ state, catalog: unavailableCatalog })
      )
    }
    expect(ruleSuggestions({
      ...input,
      catalog: lifecycleCatalog.filter((command) => command.name !== "approvals.list")
    })[0]?.flow).toBe("runs.list")
  })

  test("a streaming turn offers nothing: the pills are disabled anyway", () => {
    expect(ruleSuggestions({ state: { ...state, typing: true }, catalog })).toEqual([])
  })
})


test("hidden repository observations fit the recommender contract without cutting structured data", () => {
  const tail = repositoryRecommendationTail({
    messages: [{ role: "user", text: "x".repeat(4000) }],
    repositoryUpdate: {
      repo: "owner/repo", checkedAt: 1, openIssues: 20, openPrs: null,
      problems: ["partial"], truncated: false,
      items: Array.from({ length: 20 }, (_, number) => ({ source: "github", kind: "issue", number,
        title: '"'.repeat(250), state: "open", tags: ["x".repeat(80), "y".repeat(80)] }))
    }
  })
  expect(tail.reduce((sum, row) => sum + row.text.length, 0)).toBeLessThanOrEqual(TAIL_MAX_CHARS)
  const observation = tail.at(-1)!
  expect(observation.role).toBe("system")
  expect(JSON.parse(observation.text.slice(observation.text.indexOf("\n") + 1))).toMatchObject({ truncated: true, openIssues: 20 })
})

describe("recommend: the retry window a 429 names", () => {
  const now = Date.parse("2026-09-17T00:00:00.000Z")
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()

  test("the body's retryAt is the window, exact to the millisecond, and beats the header", () => {
    expect(recommendRetryAt({ body: { status: "error", retryAt: iso(90_500) }, retryAfter: "3600" }, now)).toBe(now + 90_500)
  })

  test("without a body window, Retry-After delta seconds or an HTTP-date stands in", () => {
    expect(recommendRetryAt({ body: undefined, retryAfter: "120" }, now)).toBe(now + 120_000)
    expect(recommendRetryAt({ body: "<html>", retryAfter: " 7 " }, now)).toBe(now + 7_000)
    expect(recommendRetryAt({ body: { retryAt: "soon" }, retryAfter: new Date(now + 30_000).toUTCString() }, now)).toBe(now + 30_000)
  })

  test("a missing, unparseable, past or present window is no window", () => {
    expect(recommendRetryAt({ body: { status: "error" }, retryAfter: null }, now)).toBeUndefined()
    expect(recommendRetryAt({ body: { retryAt: "not-a-date" }, retryAfter: "later" }, now)).toBeUndefined()
    expect(recommendRetryAt({ body: { retryAt: 12345 }, retryAfter: "-5" }, now)).toBeUndefined()
    expect(recommendRetryAt({ body: { retryAt: iso(-1) }, retryAfter: "0" }, now)).toBeUndefined()
    expect(recommendRetryAt({ body: { retryAt: iso(0) }, retryAfter: null }, now)).toBeUndefined()
    expect(recommendRetryAt({ body: null, retryAfter: "" }, now)).toBeUndefined()
  })

  test("a window past the daily bucket is clamped to it, never trusted whole", () => {
    expect(recommendRetryAt({ body: { retryAt: iso(10 * RECOMMEND_RETRY_MAX_MS) }, retryAfter: null }, now)).toBe(now + RECOMMEND_RETRY_MAX_MS)
    expect(recommendRetryAt({ body: undefined, retryAfter: String(3 * 24 * 60 * 60) }, now)).toBe(now + RECOMMEND_RETRY_MAX_MS)
    expect(recommendRetryAt({ body: { retryAt: iso(RECOMMEND_RETRY_MAX_MS - 1) }, retryAfter: null }, now)).toBe(now + RECOMMEND_RETRY_MAX_MS - 1)
  })
})

test("recommendation quota origins normalize hosts and resolve the current browser service", () => {
  expect(recommendServiceOrigin("https://ALPHA.example:443/api", "https://beta.example/app")).toBe("https://alpha.example")
  expect(recommendServiceOrigin("/service", "https://beta.example/app")).toBe("https://beta.example")
  expect(recommendServiceOrigin("", "https://beta.example/owner/repo")).toBe("https://beta.example")
  expect(recommendServiceOrigin("")).toBe("same-origin")
})

test("an invalid or opaque recommendation service does not retain a quota window", () => {
  expect(recommendServiceOrigin("https://[")).toBeUndefined()
  expect(recommendServiceOrigin("data:text/plain,hello")).toBeUndefined()
  expect(recommendServiceOrigin("", "about:blank")).toBeUndefined()
})
