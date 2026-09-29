import { describe, expect, test } from "bun:test"
import type { CommandActions } from "./Flows"
import { adminFlows, baseFlows } from "./Flows"
import { nameOf } from "./registry"
import { flowPlanParts, hasGrammar, payloadFor } from "./SlashPayload"

/*
 * The composer boundary refuses what it cannot parse exactly. `files.list`
 * and `files.read` already reject extra tokens; `flow.run` and `admin.grant`
 * silently dropped every token after the second, so `/admin.grant 25 octocat
 * 1000` granted 25 with the typo invisible. Extra tokens are now refused.
 */

describe("slash payload argument counts", () => {
  test("issue actions accept an issue number and use product words for invalid numbers", () => {
    for (const name of ["issues.fix", "issues.verify"] as const) {
      expect(payloadFor(name, "42")).toEqual({ payload: { number: 42 } })
      expect(payloadFor(name, "42 will/flows")).toEqual({ payload: { number: 42, repo: "will/flows" } })
      for (const input of ["zero", "0", "-1", "1.5"]) {
        expect(payloadFor(name, input)).toEqual({ error: `${name} needs an issue number` })
      }
    }
  })

  test("chat.clear is local by default and summarization requires its exact flag", () => {
    expect(payloadFor("chat.clear", "")).toEqual({ payload: {} })
    expect(payloadFor("chat.clear", "--summarize")).toEqual({ payload: { summarize: true } })
    for (const input of ["true", "--sumarize", "--summarize extra", "--summarize --summarize"]) {
      expect(payloadFor("chat.clear", input)).toHaveProperty("error")
    }
  })

  test("flow.run refuses extra text that is not a JSON input object", () => {
    const parsed = payloadFor("flow.run", "create-flow will/flows extra")
    expect(parsed).toEqual({ error: "Flow input is not valid JSON. Fix the JSON object before running it." })
  })

  test("flow.run still takes its name and optional repo", () => {
    expect(payloadFor("flow.run", "create-flow")).toEqual({ payload: { name: "create-flow" } })
    expect(payloadFor("flow.run", "create-flow will/flows")).toEqual({
      payload: { name: "create-flow", repo: "will/flows" }
    })
    expect(payloadFor("flow.run", "")).toEqual({
      error: "flow.run needs a flow name"
    })
  })

  test("flow.plan takes the launch's own line, and the run to compare it against", () => {
    expect(payloadFor("flow.plan", "review")).toEqual({ payload: { name: "review" } })
    expect(payloadFor("flow.plan", "against=run-9 review will/flows")).toEqual({
      payload: { name: "review", repo: "will/flows", against: "run-9" }
    })
    expect(payloadFor("flow.plan", 'sourceCard=card-1 against=run-9 review {"pr":4}')).toEqual({
      payload: { name: "review", input: { pr: 4 }, against: "run-9", sourceCard: "card-1" }
    })
  })

  test("flow.run takes no run to compare against: only the plan door previews", () => {
    // A launch reads the token as the flow it was asked to run, which is what
    // the launch grammar has always done with a leading word.
    expect(payloadFor("flow.run", "against=run-9 review")).toEqual({
      payload: { name: "against=run-9", repo: "review" }
    })
  })

  test("flowPlanParts keeps the tokens a half-typed plan line already carries", () => {
    expect(flowPlanParts("sourceCard=card-1 against=run-9 review will/flows")).toEqual({
      name: "review",
      repo: "will/flows",
      sourceCard: "card-1",
      against: "run-9"
    })
    expect(flowPlanParts("review")).toEqual({ name: "review" })
  })

  test("admin.grant refuses a third token instead of dropping it", () => {
    const parsed = payloadFor("admin.grant", "25 octocat 1000")
    expect(parsed).toEqual({ error: "admin.grant takes an amount in dollars and a login" })
  })

  test("admin.grant still takes its amount and login", () => {
    expect(payloadFor("admin.grant", "25 octocat")).toEqual({ payload: { amountUsd: 25, login: "octocat" } })
    expect(payloadFor("admin.grant", "octocat")).toEqual({
      error: "admin.grant needs an amount in dollars and a login: /admin.grant 25 octocat"
    })
  })

  test("the files.* boundary the others now match", () => {
    expect(payloadFor("files.list", "src will/flows extra")).toEqual({
      error: "files.list takes a path and optionally an owner/repo"
    })
  })
})

/*
 * Lane runs — the run inbox and its acts. The filters take any order, the
 * signal's JSON keeps its spacing, and every id-scoped act refuses a blank.
 */
describe("the runs grammar", () => {
  test("runs.list takes its filters in any order, positionals last", () => {
    expect(payloadFor("runs.list", "")).toEqual({ payload: {} })
    expect(payloadFor("runs.list", "parked review-pr")).toEqual({
      payload: { status: "parked", flow: "review-pr" }
    })
    expect(payloadFor("runs.list", "lineage=lin-1 parked will/flows")).toEqual({
      payload: { lineage: "lin-1", status: "parked", repo: "will/flows" }
    })
    expect(payloadFor("runs.list", "sourceCard=list-a parked will/flows")).toEqual({ payload: { sourceCard: "list-a", status: "parked", repo: "will/flows" } })
    expect(payloadFor("runs.list", "by=octocat")).toEqual({ payload: { by: "octocat" } })
    expect(payloadFor("runs.list", "a b c")).toEqual({
      error: "runs.list takes [status] [flow] [by=…] [lineage=…] [sourceCard=…] [owner/repo]"
    })
  })

  test("runs.open takes a run id and an optional repo", () => {
    expect(payloadFor("runs.open", "run-1")).toEqual({ payload: { runId: "run-1" } })
    expect(payloadFor("runs.open", "run-1 will/flows")).toEqual({ payload: { runId: "run-1", repo: "will/flows" } })
    expect(payloadFor("runs.open", "")).toEqual({
      error: "runs.open needs a run id: /runs.open <runId> [owner/repo]"
    })
  })

  test("runs.signal keeps the JSON payload verbatim", () => {
    expect(payloadFor("runs.signal", "run-1 deploy-done")).toEqual({
      payload: { runId: "run-1", name: "deploy-done" }
    })
    expect(payloadFor("runs.signal", `run-1 deploy-done {"ok": true}`)).toEqual({
      payload: { runId: "run-1", name: "deploy-done", payload: `{"ok": true}` }
    })
    expect(payloadFor("runs.signal", "run-1")).toEqual({
      error: "runs.signal needs the signal's name: /runs.signal <runId> <name> [json]"
    })
  })

  test("runs.steer keeps the whole message after the run id", () => {
    expect(payloadFor("runs.steer", "run-1 use the smaller diff")).toEqual({
      payload: { runId: "run-1", body: "use the smaller diff" }
    })
    expect(payloadFor("runs.steer", "run-1")).toEqual({ error: "runs.steer needs the message to deliver" })
  })

  test("runs.logs takes --follow anywhere and nothing else", () => {
    expect(payloadFor("runs.logs", "run-1")).toEqual({ payload: { runId: "run-1" } })
    expect(payloadFor("runs.logs", "run-1 --follow")).toEqual({ payload: { runId: "run-1", follow: true } })
    expect(payloadFor("runs.logs", "--follow run-1")).toEqual({ payload: { runId: "run-1", follow: true } })
    expect(payloadFor("runs.logs", "run-1 extra")).toEqual({
      error: "runs.logs takes a run id and optionally --follow"
    })
  })

  test("flow.run.stop takes an optional reason after the card id", () => {
    expect(payloadFor("flow.run.stop", "card-1")).toEqual({ payload: { cardId: "card-1" } })
    expect(payloadFor("flow.run.stop", "card-1 it hung")).toEqual({
      payload: { cardId: "card-1", reason: "it hung" }
    })
    expect(payloadFor("flow.run.stop", "")).toEqual({ error: "flow.run.stop needs the card id" })
  })

  test("the id-scoped acts refuse a blank run id", () => {
    for (const name of ["runs.resume", "runs.rerun", "runs.events", "runs.steps", "approvals.open"]) {
      expect(payloadFor(name, "")).toEqual({ error: `${name} needs a run id` })
    }
  })

  test("the trace's reader gestures take a filter word, or a node with an optional journal seq", () => {
    expect(payloadFor("runs.trace.filter", "run-1 failed")).toEqual({ payload: { runId: "run-1", filter: "failed" } })
    expect(payloadFor("runs.trace.filter", "")).toEqual({ error: "runs.trace.filter needs a run id" })
    expect(payloadFor("runs.trace.filter", "run-1")).toEqual({
      error: "runs.trace.filter needs one of all, running, failed, model, flow, forks, messages"
    })
    expect(payloadFor("runs.trace.filter", "run-1 calls")).toEqual({
      error: "runs.trace.filter needs one of all, running, failed, model, flow, forks, messages"
    })
    expect(payloadFor("runs.trace.filter", "run-1 failed extra")).toEqual({
      error: "runs.trace.filter takes a run id and one filter"
    })
    expect(payloadFor("runs.trace.select", "run-1 call-2")).toEqual({ payload: { runId: "run-1", nodeId: "call-2" } })
    expect(payloadFor("runs.trace.select", "run-1 call-2 7")).toEqual({ payload: { runId: "run-1", nodeId: "call-2", seq: 7 } })
    expect(payloadFor("runs.trace.select", "run-1")).toEqual({ error: "runs.trace.select needs the trace node to select" })
    expect(payloadFor("runs.trace.select", "run-1 call-2 soon")).toEqual({
      error: "runs.trace.select's seq is a journal sequence number"
    })
    expect(payloadFor("runs.trace.select", "")).toEqual({ error: "runs.trace.select needs a run id" })
  })

  /*
   * The graph's drill-in (L5): a select takes a node or nothing at all, and a
   * tab takes one of the four words the drawer answers to.
   */
  test("the graph drill-ins take a node to open, or nothing to close the one that is open", () => {
    expect(payloadFor("runs.graph.select", "run-1 root.flow")).toEqual({ payload: { runId: "run-1", nodeId: "root.flow" } })
    expect(payloadFor("runs.graph.select", "run-1")).toEqual({ payload: { runId: "run-1" } })
    expect(payloadFor("runs.graph.select", "")).toEqual({ error: "runs.graph.select needs a run id" })
    expect(payloadFor("runs.graph.select", "run-1 root.flow extra")).toEqual({
      error: "runs.graph.select takes a run id and at most one node"
    })
    expect(payloadFor("runs.graph.tab", "run-1 code")).toEqual({ payload: { runId: "run-1", tab: "code" } })
    expect(payloadFor("runs.graph.tab", "run-1 frames")).toEqual({
      error: "runs.graph.tab needs one of in, declaration, code, output, events, attempts"
    })
    expect(payloadFor("runs.graph.tab", "run-1")).toEqual({
      error: "runs.graph.tab needs one of in, declaration, code, output, events, attempts"
    })
    expect(payloadFor("flow.plan.select", "flow-plan-1 gate")).toEqual({ payload: { cardId: "flow-plan-1", nodeId: "gate" } })
    expect(payloadFor("flow.plan.select", "flow-plan-1")).toEqual({ payload: { cardId: "flow-plan-1" } })
    expect(payloadFor("flow.plan.select", "")).toEqual({ error: "flow.plan.select needs the plan card it draws on" })
    expect(payloadFor("flow.plan.tab", "flow-plan-1 declaration")).toEqual({
      payload: { cardId: "flow-plan-1", tab: "declaration" }
    })
    expect(payloadFor("flow.plan.tab", "flow-plan-1 output")).toEqual({
      payload: { cardId: "flow-plan-1", tab: "output" }
    })
    /* A word the drawer has no tab for is refused by name (the mock's `input` is not one the engine can fill). */
    expect(payloadFor("flow.plan.tab", "flow-plan-1 input")).toEqual({
      error: "flow.plan.tab needs one of in, declaration, code, output, events, attempts"
    })
  })

  test("approvals.list takes just an owner/repo", () => {
    expect(payloadFor("approvals.list", "")).toEqual({ payload: {} })
    expect(payloadFor("approvals.list", "will/flows")).toEqual({ payload: { repo: "will/flows" } })
    expect(payloadFor("approvals.list", "will/flows extra")).toEqual({
      error: "approvals.list takes just an owner/repo name"
    })
  })
})


/*
 * The line anchor (docs/code-intel/PLAN.md §1, the grammar C7 reserved for
 * `code.goto`): `files.read <path>[:<line>[:<col>]] [owner/repo]`. Only a
 * TRAILING numeric suffix comes off the path token, so a repository path
 * with a colon of its own keeps working; the parser stays first-token-is-path.
 */
describe("the files.read line anchor", () => {
  test("a trailing :line or :line:col comes off the path token into the payload", () => {
    expect(payloadFor("files.read", "src/x.ts:12")).toEqual({ payload: { path: "src/x.ts", line: 12 } })
    expect(payloadFor("files.read", "src/x.ts:12:5 will/flows")).toEqual({
      payload: { path: "src/x.ts", line: 12, column: 5, repo: "will/flows" }
    })
    expect(payloadFor("files.read", "/smithersai/smithers/src/x.ts:317")).toEqual({
      payload: { path: "/smithersai/smithers/src/x.ts", line: 317 }
    })
  })

  test("a colon inside the path is the path's own", () => {
    expect(payloadFor("files.read", "notes/a:b.md")).toEqual({ payload: { path: "notes/a:b.md" } })
    expect(payloadFor("files.read", "notes/a:b.md:4")).toEqual({ payload: { path: "notes/a:b.md", line: 4 } })
    expect(payloadFor("files.read", "v1:2:3.txt")).toEqual({ payload: { path: "v1:2:3.txt" } })
  })

  test("zero is refused by name: lines and columns are 1-based", () => {
    const error = "files.read lines and columns count from 1: /files.read <path>[:<line>[:<col>]]"
    expect(payloadFor("files.read", "src/x.ts:0")).toEqual({ error })
    expect(payloadFor("files.read", "src/x.ts:3:0")).toEqual({ error })
    expect(payloadFor("files.read", ":12")).toEqual({ error: "files.read needs a file path" })
  })

  test("files.list keeps a path exactly as typed", () => {
    expect(payloadFor("files.list", "src:1")).toEqual({ payload: { path: "src:1" } })
  })
})

/*
 * The code-intel positions (docs/code-intel/PLAN.md §4): `code.hover` and
 * `code.definition` take `<path>:<line>:<col> [owner/repo]` with BOTH numbers
 * required and 1-based; `code.diagnostics` takes the path alone. The path
 * keeps a colon of its own exactly as files.read's anchor does.
 */
describe("the code.* positions", () => {
  test("code.hover and code.definition take a path, a line, a column, and the optional repo", () => {
    expect(payloadFor("code.hover", "src/x.ts:12:5")).toEqual({ payload: { path: "src/x.ts", line: 12, column: 5 } })
    expect(payloadFor("code.definition", "src/x.ts:12:5 will/flows")).toEqual({
      payload: { path: "src/x.ts", line: 12, column: 5, repo: "will/flows" }
    })
    expect(payloadFor("code.hover", "/smithersai/smithers/src/x.ts:317:9")).toEqual({
      payload: { path: "/smithersai/smithers/src/x.ts", line: 317, column: 9 }
    })
    expect(payloadFor("code.hover", "notes/a:b.ts:4:2")).toEqual({ payload: { path: "notes/a:b.ts", line: 4, column: 2 } })
  })

  test("a position without both numbers, a zero, or an extra token is refused by name", () => {
    const usage = "/code.hover <path>:<line>:<col> [owner/repo]"
    expect(payloadFor("code.hover", "")).toEqual({ error: `code.hover needs a position: ${usage}` })
    expect(payloadFor("code.hover", "src/x.ts")).toEqual({ error: `code.hover needs <path>:<line>:<col>: ${usage}` })
    expect(payloadFor("code.hover", "src/x.ts:12")).toEqual({ error: `code.hover needs <path>:<line>:<col>: ${usage}` })
    expect(payloadFor("code.hover", "src/x.ts:0:1")).toEqual({ error: `code.hover lines and columns count from 1: ${usage}` })
    expect(payloadFor("code.hover", "src/x.ts:1:0")).toEqual({ error: `code.hover lines and columns count from 1: ${usage}` })
    expect(payloadFor("code.hover", "src/x.ts:1:1 will/flows extra")).toEqual({
      error: "code.hover takes a position and optionally an owner/repo"
    })
    expect(payloadFor("code.definition", ":1:1")).toEqual({
      error: "code.definition needs <path>:<line>:<col>: /code.definition <path>:<line>:<col> [owner/repo]"
    })
  })

  test("code.diagnostics takes the path and the optional repo, and refuses a third token", () => {
    expect(payloadFor("code.diagnostics", "src/x.ts")).toEqual({ payload: { path: "src/x.ts" } })
    expect(payloadFor("code.diagnostics", "src/x.ts will/flows")).toEqual({ payload: { path: "src/x.ts", repo: "will/flows" } })
    expect(payloadFor("code.diagnostics", "")).toEqual({
      error: "code.diagnostics needs a file path: /code.diagnostics <path> [owner/repo]"
    })
    expect(payloadFor("code.diagnostics", "src/x.ts will/flows extra")).toEqual({
      error: "code.diagnostics takes a path and optionally an owner/repo"
    })
  })
})


describe("structured flow input", () => {
  test("an optional JSON object preserves nested values and string whitespace with or without a repo", () => {
    const input = { plan: { prompt: "Keep  two spaces.\nNext line.", changes: [{ title: "One" }] }, count: 3, enabled: true }
    expect(payloadFor("flow.run", `coding will/repo ${JSON.stringify(input)}`)).toEqual({ payload: { name: "coding", repo: "will/repo", input } })
    expect(payloadFor("flow.run", `coding ${JSON.stringify(input)}`)).toEqual({ payload: { name: "coding", input } })
    for (const body of ["[]", "null", '"text"', "3", "true", "{} trailing", "{bad"]) {
      expect(payloadFor("flow.run", `coding will/repo ${body}`)).toHaveProperty("error")
    }
  })
})

test("run source parsing preserves repository context for slash-shaped run IDs", () => {
  const known = new Set(["will/flows"])
  expect(payloadFor("runs.open", "sourceCard=list-a jobs/run-1", undefined, known)).toEqual({
    payload: { runId: "jobs/run-1", sourceCard: "list-a" }
  })
  expect(payloadFor("runs.open", "sourceCard=list-a jobs/run-1 will/flows", undefined, known)).toEqual({
    payload: { runId: "jobs/run-1", repo: "will/flows", sourceCard: "list-a" }
  })
})


/*
 * The declaration/grammar gate. Argument grammar lives in one table, keyed by
 * name, beside declarations that carry their own `args` hint and input schema;
 * a declaration the table forgets decodes to the EMPTY payload, so what the
 * human typed is discarded in silence. `triggers.register` shipped exactly
 * that: it declares `[owner/repo]`, forwards `repo` to registerTrigger, and
 * had no decoder, so a named repository never reached it.
 */
describe("every declaration that takes arguments names a decoder", () => {
  /** Registration never invokes a handler, so every controller call answers with nothing. */
  const inertActions = new Proxy({}, { get: () => () => undefined }) as CommandActions

  test("a flow declaring an args hint carries a decoder, in the table or on the declaration", () => {
    const undecoded = [...baseFlows(inertActions), ...adminFlows(inertActions)]
      .filter((entry) => entry.metadata.args !== undefined)
      .map(nameOf)
      .filter((name) => !hasGrammar(name))
    expect(undecoded).toEqual([])
  })

  test("triggers.register preserves the repository it was given, as triggers.list does", () => {
    expect(payloadFor("triggers.register", "other/repo")).toEqual({ payload: { repo: "other/repo" } })
    expect(payloadFor("triggers.list", "other/repo")).toEqual({ payload: { repo: "other/repo" } })
    expect(payloadFor("triggers.register", "")).toEqual({ payload: {} })
    expect(payloadFor("triggers.register", "other/repo extra")).toEqual({
      error: "triggers.register takes an owner/repo and --flow, --slug, --schedule, --input, --tokens, --minutes"
    })
    expect(payloadFor("triggers.register", 'other/repo --flow nightly-lint --slug nightly --schedule 0 9 * * 1-5 --input {"label":"a"}')).toEqual({
      payload: { repo: "other/repo", flow: "nightly-lint", slug: "nightly", schedule: "0 9 * * 1-5", input: '{"label":"a"}' }
    })
    /* The limits every unattended fire may spend, when the person names them rather than taking the flow's own ceiling. */
    expect(payloadFor("triggers.register", "other/repo --flow nightly-lint --slug nightly --schedule 0 9 * * 1-5 --tokens 150000 --minutes 20")).toEqual({
      payload: { repo: "other/repo", flow: "nightly-lint", slug: "nightly", schedule: "0 9 * * 1-5", tokens: "150000", minutes: "20" }
    })
  })
})

/*
 * The model flows. A name or a seat holds no whitespace (ConfiguredModel.ts
 * MODEL_RECORD_ID, MODEL_SEAT_IDS), so a whole line runs: `/model.test <name>`
 * and `/model.assign <seat> <name>` never meet a form. A short line decodes
 * to what it gave, which is what the form opens prefilled with.
 */
describe("the model grammars", () => {
  test("a name runs the flow, and a second token is refused rather than read as part of the name", () => {
    for (const name of ["model.show", "model.edit", "model.remove", "model.test"]) {
      expect(payloadFor(name, " fast-kimi ")).toEqual({ payload: { id: "fast-kimi" } })
      expect(payloadFor(name, "")).toEqual({ payload: {} })
      expect(payloadFor(name, "fast-kimi extra")).toEqual({ error: `${name} takes one model name` })
    }
  })

  test("model.assign takes a seat and a model name, and `default` is a name like any other", () => {
    expect(payloadFor("model.assign", "explainer fast-kimi")).toEqual({ payload: { seat: "explainer", recordId: "fast-kimi" } })
    expect(payloadFor("model.assign", "explainer default")).toEqual({ payload: { seat: "explainer", recordId: "default" } })
    // The seat alone is what the card's Assign button gives: the form asks for the model.
    expect(payloadFor("model.assign", "explainer")).toEqual({ payload: { seat: "explainer" } })
    expect(payloadFor("model.assign", "")).toEqual({ payload: {} })
    expect(payloadFor("model.assign", "explainer fast-kimi extra")).toEqual({ error: "model.assign takes a seat and a model name" })
  })

  test("model.save reads its flags onto the record's own field names", () => {
    expect(payloadFor("model.save", "--name fast-kimi --protocol openai-chat --model kimi-for-coding/k3 --credential OLLAMA --url http://127.0.0.1:11434 --path /v1/chat/completions")).toEqual({
      payload: { name: "fast-kimi", protocol: "openai-chat", modelId: "kimi-for-coding/k3", credential: "OLLAMA", baseUrl: "http://127.0.0.1:11434", path: "/v1/chat/completions" }
    })
    // A short line is the edit door's prefill; a flag with no value gives nothing.
    expect(payloadFor("model.save", "--name fast-kimi --url")).toEqual({ payload: { name: "fast-kimi" } })
    expect(payloadFor("model.save", undefined)).toEqual({ payload: {} })
    const refusal = { error: "model.save takes --name, --protocol, --model, --credential, --url, --path" }
    expect(payloadFor("model.save", "fast-kimi")).toEqual(refusal)
    expect(payloadFor("model.save", "--name fast-kimi --key sk-1")).toEqual(refusal)
  })
})


test("coding connection revocation decodes its ID and requires a missing ID", () => {
  expect(payloadFor("secrets.revoke", "conn-1")).toEqual({ payload: { id: "conn-1" } })
  expect(payloadFor("secrets.revoke", undefined)).toEqual({ error: "Choose a coding connection" })
  expect(payloadFor("secrets.scope", "DEPLOY main-only")).toEqual({ payload: { name: "DEPLOY", scope: "main-only" } })
  expect(payloadFor("secrets.scope", "DEPLOY all will/flows")).toEqual({ payload: { name: "DEPLOY", scope: "all", repo: "will/flows" } })
  expect(payloadFor("secrets.scope", "DEPLOY")).toEqual({ error: "secrets.scope takes a secret name and main-only or all" })
})
