import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, beforeEach, test } from "node:test"
import * as Actions from "../../packages/smithers/agent/organization/src/Actions.ts"
import { main } from "./cli.ts"
import { init } from "./setup/init.ts"
import type { Io } from "./setup/settings.ts"

const scratch = mkdtempSync(join(tmpdir(), "org-cli-"))
const root = join(scratch, "wiki"), stateDir = join(scratch, "state")
const credential = "test-credential"

interface Call {
  readonly tag: string
  readonly payload: any
  readonly authorization: string | undefined
}

// A stand-in control RPC: Plan, Approve, and Run start `run-1`; List answers `runs`.
const calls: Array<Call> = []
let runs: Array<Record<string, unknown>> = []
let joined = false
let server: Server
let port = ""

const exit = (id: string, value: unknown) =>
  `${JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Success", value } })}\n`

before(async () => {
  await init({ dir: root, stateDir, appName: "Smithers Org" })
  writeFileSync(join(stateDir, "credential"), `${credential}\n`, { mode: 0o600 })
  server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => body += chunk)
    request.on("end", () => {
      const message = JSON.parse(body.trim())
      calls.push({ tag: message.tag, payload: message.payload, authorization: request.headers.authorization })
      const value = message.tag === "Plan"
        ? {
          planId: "plan-1",
          digest: "d1",
          envelope: { flowId: message.payload.flowId },
          approval: { planId: "plan-1", digest: "d1" }
        }
        : message.tag === "Run"
        ? { _tag: joined ? "Joined" : "Accepted", runId: "run-1" }
        : message.tag === "List"
        ? {
          items: runs.filter((run) =>
            message.payload.filters.runId === undefined || run.runId === message.payload.filters.runId
          )
        }
        : {}
      response.writeHead(200, { "content-type": "application/ndjson" }).end(exit(message.id, value))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = String((server.address() as AddressInfo).port)
})
after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(scratch, { recursive: true, force: true })
})
beforeEach(() => {
  calls.length = 0
  runs = []
  joined = false
})

const capture = (env: Io["env"] = {}) => {
  const out: Array<string> = [], err: Array<string> = []
  const io: Io = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { SMITHERS_ORG_POLL_MS: "5", ...env },
    cwd: scratch
  }
  return { io, out, err }
}

/** Runs a client command line against the stand-in host. */
const cli = async (...argv: Array<string>) => {
  const { io, out, err } = capture()
  const code = await main([...argv, "--port", port, "--state-dir", stateDir], io)
  return { code, out, err }
}

/** The flow and input the command planned, after checking it approved and ran that plan with the credential. */
const planned = () => {
  assert.deepEqual(calls.map((call) => call.tag), ["Plan", "Approve", "Run"])
  for (const call of calls) assert.equal(call.authorization, `Bearer ${credential}`)
  const [plan, approve, run] = calls
  assert.equal(approve!.payload.planId, "plan-1")
  assert.equal(run!.payload.planId, "plan-1")
  assert.equal(run!.payload.idempotencyKey, plan!.payload.idempotencyKey.replace(/^plan:/, "run:"))
  return {
    flowId: plan!.payload.flowId as string,
    input: plan!.payload.input,
    key: plan!.payload.idempotencyKey as string
  }
}

test("hire plans organization/hire with the parent, need, and first task", async () => {
  const result = await cli(
    "hire",
    "lead",
    "Competitor",
    "research",
    "--task",
    "Compare pricing.",
    "--acceptance",
    "dated",
    "--acceptance",
    "sourced",
    "--key",
    "h1"
  )
  assert.deepEqual(result, { code: 0, out: ["started run-1"], err: [] })
  assert.deepEqual(planned(), {
    flowId: "organization/hire",
    input: {
      key: "cli:h1",
      parent: "lead",
      need: "Competitor research",
      task: "Compare pricing.",
      acceptance: ["dated", "sourced"]
    },
    key: "plan:cli:h1"
  })
})

test("a repeated key joins the run it started", async () => {
  joined = true
  assert.deepEqual((await cli("retire", "lead.researcher", "--key", "r1")).out, ["joined run-1"])
  assert.deepEqual(planned().input, { key: "cli:r1", principal: "lead.researcher" })
})

test("delegate plans organization/delegate with inputs and acceptance", async () => {
  const result = await cli(
    "delegate",
    "lead",
    "lead.researcher",
    "Compare",
    "pricing.",
    "--input",
    "Org/Plans/a.md",
    "--acceptance",
    "dated"
  )
  assert.equal(result.code, 0)
  const { flowId, input } = planned()
  assert.equal(flowId, "organization/delegate")
  assert.match(input.key, /^cli:[0-9a-f-]{36}$/)
  assert.deepEqual({ ...input, key: "" }, {
    key: "",
    parent: "lead",
    specialist: "lead.researcher",
    objective: "Compare pricing.",
    inputs: ["Org/Plans/a.md"],
    acceptance: ["dated"]
  })
})

test("meetings plan plans organization/meetings-plan with no payload", async () => {
  assert.equal((await cli("meetings", "plan")).code, 0)
  const { flowId, input, key } = planned()
  assert.equal(flowId, "organization/meetings-plan")
  assert.deepEqual(input, {})
  assert.match(key, /^plan:meetings-plan:cli:/)
})

test("book plans organization/meetings-book with the role, minutes, purpose, and earliest time", async () => {
  const result = await cli(
    "book",
    "builder",
    "30",
    "Review",
    "the",
    "plan",
    "--not-before",
    "2026-10-01T09:00:00Z",
    "--key",
    "b1"
  )
  assert.equal(result.code, 0)
  assert.deepEqual(planned(), {
    flowId: "organization/meetings-book",
    input: {
      key: "cli:b1",
      requestedBy: "builder",
      purpose: "Review the plan",
      minutes: 30,
      notBefore: Date.parse("2026-10-01T09:00:00Z")
    },
    key: "plan:cli:b1"
  })
})

test("usage errors exit 2 and send nothing", async () => {
  for (
    const argv of [
      ["hire", "lead"],
      ["hire", "lead", "A need", "--acceptance", "dated"],
      ["delegate", "lead", "lead.researcher"],
      ["retire"],
      ["retire", "a", "b"],
      ["meetings"],
      ["meetings", "list"],
      ["book", "builder", "4", "Too short"],
      ["book", "builder", "241", "Too long"],
      ["book", "builder", "30.5", "Fractional"],
      ["book", "builder", "ten", "Not a number"],
      ["book", "builder", "30"],
      ["book", "builder", "30", "Bad time", "--not-before", "someday"]
    ]
  ) {
    const result = await cli(...argv)
    assert.equal(result.code, 2, argv.join(" "))
    assert.match(result.err[0]!, new RegExp(`^usage: ${argv[0]} `), argv.join(" "))
  }
  assert.deepEqual(calls, [])
})

test("a refusal from the host exits 1 with its tag", async () => {
  const { io, err } = capture()
  const refusing = createServer((_, response) =>
    response.end(
      `${
        JSON.stringify({
          _tag: "Exit",
          exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "FlowNotFound", message: "no such flow" } }] }
        })
      }\n`
    )
  )
  await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve))
  try {
    const code = await main([
      "retire",
      "x",
      "--port",
      String((refusing.address() as AddressInfo).port),
      "--state-dir",
      stateDir
    ], io)
    assert.equal(code, 1)
    assert.deepEqual(err, ["Plan refused (FlowNotFound): no such flow"])
  } finally {
    await new Promise((resolve) => refusing.close(resolve))
  }
})

test("without a credential a client command names the file and sends nothing", async () => {
  const { io, err } = capture()
  assert.equal(await main(["retire", "x", "--port", port, "--state-dir", join(scratch, "empty")], io), 1)
  assert.match(err[0]!, /^no host credential at .*empty\/credential/)
  assert.deepEqual(calls, [])
})

test("--wait prints the settled run and the receipt the flow wrote", async () => {
  const dir = join(root, "Org/Runs", Actions.runDirectory("cli:h2"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "hire.json"), JSON.stringify({ report: { status: "hired", summary: "lead.researcher" } }))
  runs = [{ runId: "run-1", flowId: "organization/hire", status: "completed" }]
  const result = await cli("hire", "lead", "A researcher.", "--key", "h2", "--wait", "--root", root)
  assert.deepEqual(result.out, [
    "started run-1",
    "run-1 completed",
    `hired: lead.researcher\nreceipt Org/Runs/${Actions.runDirectory("cli:h2")}/hire.json`
  ])
  assert.equal(result.code, 0)

  runs = [{ runId: "run-1", flowId: "organization/meetings-plan", status: "failed" }]
  const failed = await cli("meetings", "plan", "--wait", "--root", root)
  assert.deepEqual(failed.out, ["started run-1", "run-1 failed"])
  assert.equal(failed.code, 1)
})

test("status prints the glance; --run prints one run and its gates", async () => {
  runs = [
    { runId: "run-1", flowId: "organization/intake", status: "completed" },
    { runId: "run-2", flowId: "organization/hire", status: "running" }
  ]
  assert.deepEqual((await cli("status")).out, [
    "running 1  parked 0  failed 0  done 1",
    "running run-2  organization/hire"
  ])
  assert.deepEqual((await cli("status", "--run", "run-1")).out, ["run-1  organization/intake  completed"])
  assert.deepEqual((await cli("status", "--run", "run-9")).out, ["no runs"])
  runs = []
  assert.deepEqual((await cli("status")).out, ["no runs"])
})

test("specialists lists hired principals from the roster", async () => {
  const { io, out } = capture({ SMITHERS_ORG_ROOT: root })
  assert.equal(await main(["specialists", "--state-dir", stateDir], io), 0)
  assert.deepEqual(out, ["no specialists"])

  writeFileSync(
    join(root, "Org/Specialists/lead.researcher.md"),
    [
      "---",
      "id: lead.researcher",
      "name: Researcher",
      "kind: specialist",
      "status: active",
      "version: 1.0.0",
      "reportsTo: lead",
      "seat: openai:gpt-6-sol",
      "grants:",
      "  tools: [memory, wiki-read]",
      "  connections: []",
      "  knowledge: [\"Org/Roles/\"]",
      "  repositories: []",
      "  personalAccounts: false",
      "  contact: via-assistant",
      "budget: { tokensPerTask: 100000, tasksPerDay: 5, concurrency: 1 }",
      "memory: { namespace: agent-lead.researcher }",
      "skills: []",
      "cases: []",
      "identities: {}",
      "hiredBy: lead",
      "hiredAt: 2026-09-20T16:00:00Z",
      "---",
      "",
      "## Objective",
      "",
      "Research.",
      "",
      "## Responsibilities",
      "",
      "- Compare sources.",
      "",
      "## Inputs",
      "",
      "- The question.",
      "",
      "## Allowed actions",
      "",
      "- Read.",
      "",
      "## Output",
      "",
      "- report — the answer",
      "",
      "## Evidence",
      "",
      "- A link per claim.",
      "",
      "## Escalation",
      "",
      "- Private data: tell the lead.",
      "",
      "## Success criteria",
      "",
      "- Every claim is sourced.",
      ""
    ].join("\n")
  )
  const listed = capture()
  assert.equal(
    await main(["specialists", "--root", root, "--state-dir", stateDir], listed.io),
    0,
    listed.err.join("\n")
  )
  assert.deepEqual(listed.out, ["lead.researcher  active  specialist  lead  Researcher"])
})
