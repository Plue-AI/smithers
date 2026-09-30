import { describe, expect, test } from "bun:test"
import { flowArgs } from "./FlowArgs"
import type { FlowInput, FlowWithInput } from "./FlowArgs"
import { FLOW_NAMES } from "./FlowName"
import type { FlowName } from "./FlowName"
import { payloadFor } from "./SlashPayload"
import { triggersFlows } from "./entries/triggers"
import type { CommandActions } from "./Flows"
import { nameOf } from "./registry"

/*
 * The button door's contract: what a card hands over comes back out of the
 * flow's own grammar unchanged. Every case here is a value the cards used to
 * interpolate into a template literal — a path, a label, a steer message, a
 * template name, a filter query — and the ones holding a space are the ones
 * that used to arrive as something else.
 */

/** The input, the line it must produce, and the payload the grammar must give back. */
const roundTrip = <N extends FlowWithInput>(name: N, input: FlowInput[N], line: string, payload: Record<string, unknown>): void => {
  expect(flowArgs(name, input)).toBe(line)
  expect(payloadFor(name, line)).toEqual({ payload })
}

describe("flowArgs — one serialisation, and the grammar gives the values back", () => {
  test("a box chooser keeps authoring and prototype prose distinct from the selected repository", () => {
    roundTrip("flow.create", { description: "Compare owner/other with today", repo: "will/flows" },
      '{"description":"Compare owner/other with today","repo":"will/flows"}',
      { description: "Compare owner/other with today", repo: "will/flows" })
    roundTrip("feature.prototype", { request: "Inspect owner/other first", repo: "will/flows" },
      '{"request":"Inspect owner/other first","repo":"will/flows"}',
      { request: "Inspect owner/other first", repo: "will/flows" })
  })
  test("integrations.admit's button carries only its repository, so the form asks for the ids", () => {
    roundTrip("integrations.admit", { repo: "owner/repo" }, '{"repo":"owner/repo"}', { repo: "owner/repo" })
    roundTrip("integrations.admit", { connection_id: "slack-main", scope_id: "T0123", conversation_id: "C0123", external_user_id: "U0123", repo: "owner/repo" },
      '{"connection_id":"slack-main","scope_id":"T0123","conversation_id":"C0123","external_user_id":"U0123","repo":"owner/repo"}',
      { connection_id: "slack-main", scope_id: "T0123", conversation_id: "C0123", external_user_id: "U0123", repo: "owner/repo" })
  })
  test("integrations.admit's slash line reads ids in order, an optional user, and a trailing repository", () => {
    expect(payloadFor("integrations.admit", "slack-main T0123 C0123")).toEqual({ payload: { connection_id: "slack-main", scope_id: "T0123", conversation_id: "C0123" } })
    expect(payloadFor("integrations.admit", "slack-main T0123 C0123 U0123 owner/repo")).toEqual({ payload: { connection_id: "slack-main", scope_id: "T0123", conversation_id: "C0123", external_user_id: "U0123", repo: "owner/repo" } })
    expect(payloadFor("integrations.admit", "slack-main T0123 owner/repo")).toEqual({ payload: { connection_id: "slack-main", scope_id: "T0123", repo: "owner/repo" } })
    expect(payloadFor("integrations.admit", undefined)).toEqual({ payload: {} })
    expect(payloadFor("integrations.admit", "a b c d e")).toHaveProperty("error")
    expect(payloadFor("integrations.admit", '{"conversation_id":"C0123","other":1}')).toHaveProperty("error")
  })
  test("change.request carries its pushed source ref through a box chooser continuation", () => {
    roundTrip("change.request", { prompt: "Fix the flaky check", from: "topic", repo: "owner/repo" },
      "Fix the flaky check from:topic owner/repo", { prompt: "Fix the flaky check", from: "topic", repo: "owner/repo" })
  })
  test("flow.plan keeps input and comparison target through a box chooser continuation", () => {
    roundTrip("flow.plan", { name: "checks/fast", repo: "owner/repo", input: { branch: "topic" }, against: "older-plan" },
      'against=older-plan checks/fast owner/repo {"branch":"topic"}',
      { name: "checks/fast", repo: "owner/repo", input: { branch: "topic" }, against: "older-plan" })
  })
  test("cloud session controls carry the session and its repository", () => {
    for (const name of ["agent.session.view", "agent.session.stop"] as const) {
      roundTrip(name, { sessionId: "session-1", repo: "will/other" }, "session-1 will/other", { sessionId: "session-1", repo: "will/other" })
      for (const known of [new Set<string>(), new Set(["will/flows"])]) {
        expect(payloadFor(name, flowArgs(name, { sessionId: "session-1", repo: "will/other" }), undefined, known))
          .toEqual({ payload: { sessionId: "session-1", repo: "will/other" } })
        expect(payloadFor(name, "session-1", undefined, known)).toEqual({ payload: { sessionId: "session-1" } })
        for (const args of ["", "will/other", "session-1 extra will/other", "session-1 invalid-repo"]) {
          expect(payloadFor(name, args, undefined, known)).toHaveProperty("error")
        }
      }
    }
  })

  test("runs.trace.select preserves the source, node and optional recorded sequence", () => {
    for (const seq of [undefined, 0, 17]) {
      const input = { sourceCard: "flow-run-source", runId: "run-1", nodeId: "frame-2", ...(seq === undefined ? {} : { seq }) }
      roundTrip("runs.trace.select", input, `sourceCard=flow-run-source run-1 frame-2${seq === undefined ? "" : ` ${seq}`}`, input)
    }
    roundTrip("runs.trace.select", { runId: "run-1", nodeId: "frame-2", seq: 17 }, "run-1 frame-2 17", { runId: "run-1", nodeId: "frame-2", seq: 17 })
  })

  test("graph selection round-trips node addresses including spaces and slashes", () => {
    for (const nodeId of ["root.flow.all.hello world", "root.flow.all.a/b", 'root.flow.all. \"quoted\" ']) {
      for (const [name, input] of [
        ["runs.graph.select", { runId: "run-1", nodeId }],
        ["flow.plan.select", { cardId: "plan-1", nodeId }]
      ] as const) expect(payloadFor(name, flowArgs(name, input))).toEqual({ payload: input })
    }
  })

  test("runs.steer carries a message that holds spaces", () => {
    roundTrip("runs.steer", { runId: "run-1", body: "focus on the failing test" }, "run-1 focus on the failing test", {
      runId: "run-1",
      body: "focus on the failing test"
    })
  })

  test("model.assign carries the seat and the name, and `default` is a name", () => {
    roundTrip("model.assign", { seat: "explainer", recordId: "default" }, "explainer default", { seat: "explainer", recordId: "default" })
  })

  test("a composer edit rides as JSON, newlines and quotes intact, and an omitted field stays omitted", () => {
    const prompt = { id: "writer", system: "Answer in one line.\nNo \"quotes\".", maxTokens: 64, temperature: "" }
    roundTrip("model.prompt", prompt, JSON.stringify(prompt), prompt)
    const field = { id: "judge", key: "diff", kind: "diff", value: "@@ -1 +1 @@\n-a\n+b", was: "patch" }
    roundTrip("model.state", field, JSON.stringify(field), field)
    roundTrip("model.state", { id: "judge", key: "diff", remove: true }, "{\"id\":\"judge\",\"key\":\"diff\",\"remove\":true}", { id: "judge", key: "diff", remove: true })
    const question = { id: "judge", question: "q1", type: "choice", instructions: "Which one?", criteria: { a: "the first", b: "" } }
    roundTrip("model.question", question, JSON.stringify(question), question)
    roundTrip("model.question", { id: "judge" }, "{\"id\":\"judge\"}", { id: "judge" })
    const option = { id: "judge", question: "q1", option: "b", about: "the second" }
    roundTrip("model.option", option, JSON.stringify(option), option)
  })

  test("change.pins carries both pins", () => {
    roundTrip("change.pins", { changeId: "ch-1", from: "parent", to: "current" }, "ch-1 parent current", {
      changeId: "ch-1",
      from: "parent",
      to: "current"
    })
  })

  test("change.diff carries a path that holds a space", () => {
    roundTrip("change.diff", { changeId: "ch-1", from: "parent", to: "current", path: "src/my notes.md" }, "ch-1 parent current src/my notes.md", {
      changeId: "ch-1",
      from: "parent",
      to: "current",
      path: "src/my notes.md"
    })
  })

  test("change.diff without pins is the change's own diff", () => {
    roundTrip("change.diff", { changeId: "ch-1" }, "ch-1", { changeId: "ch-1" })
  })

  test("change.resolve carries a conflicted path that holds a space", () => {
    roundTrip("change.resolve", { changeId: "ch-1", path: "docs/my guide.md" }, "ch-1 docs/my guide.md", {
      changeId: "ch-1",
      path: "docs/my guide.md"
    })
  })


  test("form.set carries a value that holds a space, and clears the field when it is blank", () => {
    roundTrip("form.set", { cardId: "card-1", field: "message", value: "two words" }, "card-1 message two words", {
      cardId: "card-1",
      field: "message",
      value: "two words"
    })
    roundTrip("form.set", { cardId: "card-1", field: "message", value: "" }, "card-1 message", {
      cardId: "card-1",
      field: "message",
      value: ""
    })
  })
})

describe("FlowName — the seam's names are the registry's names", () => {
  test("every flow with a typed input is a declared flow", () => {
    const declared = new Set<string>(FLOW_NAMES)
    const named: ReadonlyArray<FlowWithInput> = [
      "change.diff",
      "change.pins",
      "change.resolve",
      "form.set",
      "model.assign",
      "model.option",
      "model.prompt",
      "model.question",
      "model.state",
      "runs.steer",
    ]
    expect(named.filter((name) => !declared.has(name))).toEqual([])
  })

  test("a misspelled flow name is not a FlowName", () => {
    const good: FlowName = "repo.select"
    // @ts-expect-error the plural is not a flow: this is the mistake the union exists to refuse.
    const bad: FlowName = "repos.select"
    expect([good, bad] as ReadonlyArray<string>).toEqual(["repo.select", "repos.select"])
  })

  test("a flow's input is not another flow's input", () => {
    // @ts-expect-error change.pins takes both pins; `to` is not optional.
    const pins: FlowInput["change.pins"] = { changeId: "ch-1", from: "parent" }
    expect(pins.changeId).toBe("ch-1")
  })
})

/*
 * The plan door is the flow row's second button, and it hands over the same
 * values the Run door does. Without a grammar of its own the line came back as
 * nothing and the door raised an empty form instead of planning the flow it
 * names.
 */
test("the plan door's line carries the flow, its workspace and its input", () => {
  roundTrip("flow.plan", { name: "review", sourceCard: "author-run", repo: "o/r", against: "old-plan", input: {} },
    "sourceCard=author-run against=old-plan review o/r {}",
    { name: "review", sourceCard: "author-run", repo: "o/r", against: "old-plan", input: {} })
  roundTrip("flow.plan", { name: "gateway/GraphFixture", repo: "codeplanesmithers/smithers-demo", input: { label: "e2e" } },
    `gateway/GraphFixture codeplanesmithers/smithers-demo ${JSON.stringify({ label: "e2e" })}`,
    { name: "gateway/GraphFixture", repo: "codeplanesmithers/smithers-demo", input: { label: "e2e" } })
  // The row's own button names no workspace: the source card is what says
  // which one, exactly as the Run door beside it does.
  roundTrip("flow.plan", { name: "gateway/GraphFixture", sourceCard: "workflow-list-card" },
    "sourceCard=workflow-list-card gateway/GraphFixture",
    { name: "gateway/GraphFixture", sourceCard: "workflow-list-card" })
})

test("source-qualified flow input preserves arbitrary JSON", () => {
  const input = { requestExecutionId: "native  id", message: "sourceCard=literal  spaces" }
  roundTrip("flow.run", { name: "coding/vibe", sourceCard: "source-card", input },
    `sourceCard=source-card coding/vibe ${JSON.stringify(input)}`, { name: "coding/vibe", sourceCard: "source-card", input })
  expect(payloadFor("flow.list", "sourceCard=source-card")).toEqual({ payload: { sourceCard: "source-card" } })
})


test("opening a diff file preserves a frame id and a path containing spaces", () => {
  const input = { cardId: "diff-frame", path: "src/my file.ts" }
  expect(payloadFor("files.open-diff", flowArgs("files.open-diff", input))).toEqual({ payload: input })
})


test("repository detail buttons preserve typed issue and PR targets", () => {
  for (const flow of ["issues.view", "prs.view"] as const) {
    expect(payloadFor(flow, flowArgs(flow, { number: 3, repo: "owner/repo" }))).toEqual({ payload: { number: 3, repo: "owner/repo" } })
  }
})

test("issue detail preserves the tracker even when native and GitHub numbers collide", () => {
  for (const source of ["github", "smithers-cloud"] as const) {
    roundTrip("issues.view", { number: 1, repo: "will/flows", source }, `1 will/flows --source ${source}`, { number: 1, repo: "will/flows", source })
  }
  roundTrip("issues.view", { number: 1, source: "github" }, "1 --source github", { number: 1, source: "github" })
  roundTrip("issues.view", { number: 1, repo: "will/flows" }, "1 will/flows", { number: 1, repo: "will/flows" })
  expect(payloadFor("issues.view", "will/flows --source github")).toHaveProperty("error")
})

test("issues.comment keeps a Markdown comment's newlines, indentation and fences", () => {
  const text = "First paragraph.\n\n```ts\nconst  x = 1\n  return x\n```\n\n- one\n- two"
  const unloaded = new Set<string>()
  expect(payloadFor("issues.comment", flowArgs("issues.comment", { number: 3, text, repo: "will/flows" }), undefined, unloaded))
    .toEqual({ payload: { number: 3, text, repo: "will/flows" } })
  expect(payloadFor("issues.comment", flowArgs("issues.comment", { number: 3, text }))).toEqual({ payload: { number: 3, text } })
  // The typed slash line keeps everything between the number and a trailing repository.
  expect(payloadFor("issues.comment", `3 ${text} will/flows`, undefined, new Set(["will/flows"])))
    .toEqual({ payload: { number: 3, text, repo: "will/flows" } })
  expect(payloadFor("issues.comment", `3\n${text}`)).toEqual({ payload: { number: 3, text } })
  for (const bad of ['{"number":0,"text":"x"}', '{"number":3,"text":"  "}', '{"number":3,"text":"x","repo":7}', "{not json", "3", "x hello"]) {
    expect(payloadFor("issues.comment", bad)).toHaveProperty("error")
  }
})

 test("Wiki heading buttons retain their card scope", () => {
  roundTrip("wiki.heading", { line: "5", cardId: "wiki-open-plans" }, "5 wiki-open-plans", { line: "5", cardId: "wiki-open-plans" })
  roundTrip("wiki.heading", { line: "5" }, "5", { line: "5" })
})

test("import issue action keeps the repository after the default filter", () => {
 const args = flowArgs("issues.list", {repo: "acme/web"})
 expect(args).toBe("open acme/web")
 expect(payloadFor("issues.list", args)).toMatchObject({payload: {filter:"open",repo:"acme/web"}})
})

test("manual setup work preserves source identity and multiline instructions across all command doors", () => {
  const work = { cardId: "setup:repo:issues", operation: "run", manual: { stepId: "fix", prompt: "Preserve old APIs.\nAdd a regression test.", subject: { source: "smithers-cloud", kind: "issue", number: 42 } } } as const
  roundTrip("setup.run", work, JSON.stringify(work), work)
  const edit = { cardId: work.cardId, stepId: "fix", field: "prompt", value: work.manual.prompt } as const
  roundTrip("setup.work", edit, JSON.stringify(edit), edit)
})

/*
 * The Pause door (CHAT.md B1). `triggers.pause` declares `grammar: carried(...)`,
 * which reads ONE JSON object and refuses a positional line — the canary
 * walk's slash path filled the form's Slug field and was answered with
 * "triggers.pause takes the values its button carries". A button never meets
 * that refusal, because it carries the object the grammar reads.
 */
test("the Pause button's values are what triggers.pause's own grammar reads back", () => {
  const entry = triggersFlows({} as unknown as CommandActions).find((flow) => nameOf(flow) === "triggers.pause")
  const line = flowArgs("triggers.pause", { slug: "nightly", repo: "will/flows" })
  expect(line).toBe(JSON.stringify({ slug: "nightly", repo: "will/flows" }))
  expect(payloadFor("triggers.pause", line, entry?.metadata.grammar)).toEqual({ payload: { slug: "nightly", repo: "will/flows" } })
  expect(entry?.metadata.grammar?.buttonOnly).toBe(true)
  expect(payloadFor("triggers.pause", "nightly will/flows", entry?.metadata.grammar)).toHaveProperty("error")
})

test("split preserves each file path through the real slash parser", () => {
  const input = { changeId: "change-1", paths: ["docs/My Notes.md", 'src/a "quote".ts', "src/back\\slash.ts"] }
  expect(payloadFor("change.split", flowArgs("change.split", input))).toEqual({ payload: input })
})

test("card configuration args round-trip through their production grammars", () => {
  const cases = [
    ["runs.seat", { runId: "r1", seat: "code" }],
    ["runs.tools", { runId: "r1", toolNames: "read,write" }],
    ["runs.thinking", { runId: "r1", thinking: "high" }],
    ["change.checks", { changeId: "c1", seq: 3 }],
    ["issues.close", { number: 3, repo: "owner/repo" }],
    ["issues.reopen", { number: 3, repo: "owner/repo" }],
    ["commits.list", { branch: "feature/topic", repo: "owner/repo" }],
    ["box.facet", { workspaceId: "w1", facet: "files" }],
    ["secrets.move", { id: "conn-1", direction: "down" }],
    ["box.open", { repo: "owner/repo", kind: "desktop" }],
    ["box.open", { repo: "owner/repo" }],
    ["box.delete", { workspaceId: "w1", confirmName: "My workspace" }],
    ["box.egress", { workspaceId: "w1", cursor: "next" }],
    ["box.session.destroy", { workspaceId: "w1", sessionId: "s1" }],
    ["review.request", { changeId: "c1", reviewer: "alice" }],
    ["review.unrequest", { changeId: "c1", requestId: 7 }],
    ["review.done", { changeId: "c1", threadId: 7 }],
    ["review.ack", { changeId: "c1", threadId: 7 }],
    ["review.reopen", { changeId: "c1", threadId: 7 }],
    ["findings.please-fix", { changeId: "c1", findingId: 7 }],
    ["findings.not-useful", { changeId: "c1", findingId: 7 }],
    ["flow.run.stop-all", { sourceCard: "card1", repo: "owner/repo" }]
  ] as const
  for (const [name, input] of cases) expect(payloadFor(name, flowArgs(name, input))).toEqual({ payload: input })
})


test("wiki selection preserves paths with spaces and signup preserves typed whitespace", () => {
  const selection = { cardId: "wiki-1", documentId: 'docs/My "Notes".md' }
  expect(payloadFor("wiki.card.select", flowArgs("wiki.card.select", selection))).toEqual({ payload: selection })
  const signup = { field: "account", value: "  Ada Lovelace \n" }
  expect(payloadFor("signup.set", flowArgs("signup.set", signup))).toEqual({ payload: signup })
})

test("structured commit, trace, wiki and landing actions match their grammars", () => {
  roundTrip("commits.read", { ref: "abc123", repo: "team/project" }, "abc123 team/project", { ref: "abc123", repo: "team/project" })
  roundTrip("runs.trace.view", { runId: "run-1", view: "timeline" }, "run-1 timeline", { runId: "run-1", view: "timeline" })
  roundTrip("runs.graph.follow", { runId: "run-1", follow: false }, "run-1 off", { runId: "run-1", follow: "off" })
  roundTrip("runs.coding.select", { runId: "run-1", changeId: "change-1" }, "run-1 change-1", { runId: "run-1", changeId: "change-1" })
  roundTrip("wiki.cloud", { repo: "team/project", page: 2 }, "team/project 2", { repo: "team/project", page: 2 })
  roundTrip("wiki.card.view", { cardId: "wiki-1", view: "list" }, "wiki-1 list", { cardId: "wiki-1", view: "list" })
  roundTrip("wiki.cloud.open", { slug: "my-page", repo: "team/project" }, "my-page team/project", { slug: "my-page", repo: "team/project" })
  roundTrip("prs.land", { number: 42, repo: "team/project" }, "42 team/project", { number: 42, repo: "team/project" })
  roundTrip("prs.review", { number: 42, verdict: "request-changes", repo: "team/project" }, '{"number":42,"verdict":"request-changes","repo":"team/project"}', { number: 42, verdict: "request_changes", text: "", repo: "team/project" })
})

test("Wiki Open carries an explicit repository before its inventory loads", () => {
  const payload = { slug: "my-page", repo: "team/project" }
  for (const known of [new Set<string>(), new Set(["team/other"])]) {
    expect(payloadFor("wiki.cloud.open", flowArgs("wiki.cloud.open", payload), undefined, known)).toEqual({ payload })
    for (const args of ["", "my-page", "team/project"]) {
      expect(payloadFor("wiki.cloud.open", args, undefined, known)).toHaveProperty("error")
    }
  }
})


test("preparation retry carries the original schedule, JSON input and both limits", () => {
  const draft = { repo: "will/flows", flow: "nightly-lint", slug: "nightly", schedule: "0 9 * * 1-5", input: JSON.stringify({ label: 'a "quoted" label', args: "line one --flow keep-this-as-input\nline two" }), tokens: 150000, minutes: 20 }
  const args = flowArgs("triggers.register", draft)
  const expected = { payload: { ...draft, tokens: "150000", minutes: "20" } }
  expect(payloadFor("triggers.register", args)).toEqual(expected)
  const entry = triggersFlows({} as unknown as CommandActions).find(flow => nameOf(flow) === "triggers.register")!
  const formArgs = entry.metadata.form!.args!(draft)
  expect(payloadFor("triggers.register", formArgs)).toEqual(expected)
  const slash = `${draft.repo} --flow ${draft.flow} --slug ${draft.slug} --schedule ${draft.schedule} --input ${draft.input} --tokens ${draft.tokens} --minutes ${draft.minutes}`
  expect(payloadFor("triggers.register", slash)).toEqual(expected)
})


test("a run-open retry round-trips its durable request and rejects duplicate or empty request IDs", () => {
  const input = { runId: "run-1", repo: "will/repo", requestId: "request-1" }
  expect(payloadFor("runs.open", flowArgs("runs.open", input))).toEqual({ payload: input })
  expect(payloadFor("runs.open", "requestId= run-1")).toHaveProperty("error")
  expect(payloadFor("runs.open", "requestId=a requestId=b run-1")).toHaveProperty("error")
})
