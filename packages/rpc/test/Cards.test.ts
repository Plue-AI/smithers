import { describe, expect, test } from "vitest"
import { z } from "zod"
import { AGENT_ROLES } from "../src/AgentRoles.ts"
import type { Card } from "../src/Cards.ts"
import {
  CardPatchSchema,
  CardSchema,
  FORM_OPTION_PROVIDERS,
  GitHubRateLimitSchema,
  TargetDetailSchema,
  TargetsViewSchema
} from "../src/Cards.ts"
import { LSP_DIAGNOSTICS_CAP } from "../src/LocalLsp.ts"
import { AgentTurnFrameSchema } from "../src/NativeAgent.ts"
import { RepositoryHomeSchema } from "../src/RepositoryHome.ts"

const builtIn = AGENT_ROLES[0]!
const builtInCardRow = {
  id: builtIn.id,
  label: builtIn.label,
  purpose: builtIn.purpose,
  harness: builtIn.harness,
  model: builtIn.model,
  builtin: true,
  harnessName: "Claude",
  available: true,
  reason: "",
  account: "will@example.com"
}

const base = { id: "card-r1", title: "Aomi", status: "active", createdAt: 0, ordinal: 0 }

test("a write-only form rejects values in either persisted input map", () => {
  const payload = {
    flow: "model.credential.enroll",
    via: "user",
    fields: [{ name: "value", label: "API key", kind: "write-only", required: true }],
    draft: {},
    given: {}
  }
  expect(CardSchema.safeParse({ ...base, kind: "flow-form", payload }).success).toBe(true)
  expect(
    CardSchema.safeParse({
      ...base,
      kind: "flow-form",
      payload: {
        ...payload,
        payloadField: "input",
        given: { input: { value: "nested-private-fixture" } }
      }
    }).success
  ).toBe(false)
  for (const map of ["draft", "given"]) {
    expect(
      CardSchema.safeParse({ ...base, kind: "flow-form", payload: { ...payload, [map]: { value: "private-fixture" } } })
        .success
    ).toBe(false)
  }
})

/*
 * Lane citc (ADR 0002), completed by lane L3: the workspace card carries the
 * plue DTO. plue#446 landed, so `workspaceKind`, `head`, `ahead`, `behind`,
 * `startedAt`, `environment`, `persistence` and `sshHost` ARE part of the
 * contract — every one optional, so the payload a card persisted before that
 * lane carries parses and states none of them. The service-log contract
 * lands with it.
 */
describe("the workspace card", () => {
  const payload = {
    workspaceId: "ws-1",
    repo: "will/smithers",
    name: "review",
    targetBookmark: "main",
    status: "running",
    provisioningStage: null,
    bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" },
    sessions: [{ id: "sess-1", status: "running", createdAt: null }]
  }

  test("a card persisted before plue#446 carries the DTO plus the bookmark head, and defaults nothing", () => {
    const card = CardSchema.parse({ ...base, kind: "workspace", payload })
    if (card.kind !== "workspace") return
    expect(card.payload.status).toBe("running")
    expect(card.payload.bookmarkHead).toEqual({ changeId: "qupxosqw", commitId: "c0ffee1" })
    // An unstated field stays absent: the header renders nothing, never a guess.
    expect(Object.keys(card.payload).sort()).toEqual(Object.keys(payload).sort())
  })

  test("the post-plue#446 DTO round-trips: the sandbox kind, the workspace's own head, ahead/behind, uptime, the environment, persistence and the ssh host", () => {
    const richer = {
      ...payload,
      workspaceKind: "vm",
      head: { changeId: "ronvznsk", commitId: "deadbee" },
      ahead: 2,
      behind: 1,
      startedAt: "2026-09-05T08:00:00Z",
      environment: {
        source: ".smithers/environment.nix",
        revision: "4e87ac15",
        closureHash: "sha256-9f1c",
        image: "registry.jjhub.tech/env:4e87ac15"
      },
      persistence: "persistent",
      sshHost: "ws-1@ssh.jjhub.tech"
    }
    const card = CardSchema.parse({ ...base, kind: "workspace", payload: richer })
    if (card.kind !== "workspace") return
    expect(card.payload).toEqual(richer)
    expect(card.payload.ahead).toBe(2)
    expect(card.payload.behind).toBe(1)
  })

  test("a status outside plue's six is rejected", () => {
    expect(CardSchema.safeParse({ ...base, kind: "workspace", payload: { ...payload, status: "melting" } }).success)
      .toBe(false)
  })

  test("the bookmark head may be absent (an unread head is not a fact)", () => {
    const card = CardSchema.parse({ ...base, kind: "workspace", payload: { ...payload, bookmarkHead: null } })
    if (card.kind !== "workspace") return
    expect(card.payload.bookmarkHead).toBeNull()
  })
})

describe("the service-log card", () => {
  test("carries the service, its lines, and the follow state", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "service-log",
      payload: { workspaceId: "ws-1", repo: "will/smithers", service: "web", lines: ["listening"], follow: true }
    })
    if (card.kind !== "service-log") return
    expect(card.payload.follow).toBe(true)
    expect(card.payload.lines).toEqual(["listening"])
  })
})

/*
 * Code intelligence (apps/app/docs/code-intel/PLAN.md §5): the file card's
 * anchor, what the language server published, the hover answer, and the
 * server state live in the payload, all optional so a card persisted before
 * the lane parses unchanged and states none of them.
 */
describe("the file card", () => {
  const payload = { repo: "smithers", path: "apps/app/src/mainview/App.tsx", content: "export {}\n", truncated: false }
  const diagnostic = {
    line: 317,
    character: 62,
    endLine: 317,
    endCharacter: 68,
    severity: "error" as const,
    message: "Property 'lenght' does not exist on type 'string'.",
    source: "ts",
    code: "2551"
  }
  const parses = (extra: Record<string, unknown>): boolean =>
    CardSchema.safeParse({ ...base, kind: "file", payload: { ...payload, ...extra } }).success

  test("a card persisted before code intelligence parses and states no anchor, diagnostics, hover, or server", () => {
    const card = CardSchema.parse({ ...base, kind: "file", payload })
    if (card.kind !== "file") return
    expect(card.payload.line).toBeUndefined()
    expect(card.payload.column).toBeUndefined()
    expect(card.payload.diagnostics).toBeUndefined()
    expect(card.payload.hover).toBeUndefined()
    expect(card.payload.intel).toBeUndefined()
  })

  test("carries the anchor, what the server published, the hover answer, and the server state", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "file",
      payload: {
        ...payload,
        line: 317,
        column: 62,
        diagnostics: [diagnostic],
        hover: {
          line: 63,
          character: 7,
          contents: "const isRecord: (value: unknown) => value is Record<string, unknown>"
        },
        intel: { state: "missing", note: "npm i -g typescript-language-server typescript" }
      }
    })
    if (card.kind !== "file") return
    expect(card.payload.line).toBe(317)
    expect(card.payload.column).toBe(62)
    expect(card.payload.diagnostics).toEqual([diagnostic])
    expect(card.payload.hover?.contents).toContain("value is Record")
    expect(card.payload.intel).toEqual({ state: "missing", note: "npm i -g typescript-language-server typescript" })
  })

  test("a hover the server had nothing for is null, which is not the same as never asked", () => {
    const card = CardSchema.parse({ ...base, kind: "file", payload: { ...payload, hover: null } })
    if (card.kind !== "file") return
    expect(card.payload.hover).toBeNull()
  })

  test("refuses a 0-based anchor, a severity outside the four, a state outside the four, and more diagnostics than the host cap", () => {
    expect(parses({ line: 0 })).toBe(false)
    expect(parses({ column: 0 })).toBe(false)
    expect(parses({ diagnostics: [{ ...diagnostic, severity: "fatal" }] })).toBe(false)
    expect(parses({ diagnostics: Array.from({ length: LSP_DIAGNOSTICS_CAP }, () => diagnostic) })).toBe(true)
    expect(parses({ diagnostics: Array.from({ length: LSP_DIAGNOSTICS_CAP + 1 }, () => diagnostic) })).toBe(false)
    expect(parses({ intel: { state: "installing" } })).toBe(false)
  })
})

describe("the agent cards", () => {
  const row = builtInCardRow

  test("the agents card retains availability, resets edited built-in facts to the table, and keeps configured profiles as read", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "agents",
      payload: {
        native: true,
        agents: [
          { ...row, model: { provider: "openai", id: "gpt 5", label: "Edited" }, label: "Edited" },
          { ...row, id: "custom-reviewer", builtin: false, kind: "specialist" }
        ]
      }
    })
    // A built-in reads its facts from the table; a configured profile (smithers-ui-DESIGN.md §3.3) keeps its own.
    expect(card.payload).toEqual({
      native: true,
      agents: [row, { ...row, id: "custom-reviewer", builtin: false, kind: "specialist" }]
    })
  })

  test("a repository agent flow is a row with no harness and its flow id, path segments included", () => {
    const reviewer = {
      id: "checks/review",
      label: "checks/review",
      purpose: "Reviews the change.",
      model: { provider: "openai", id: "gpt-6-sol", label: "gpt-6-sol" },
      builtin: false,
      available: false,
      reason: "",
      account: ""
    }
    const card = CardSchema.parse({ ...base, kind: "agents", payload: { native: false, agents: [reviewer] } })
    expect(card.payload).toEqual({ native: false, agents: [reviewer] })
    // A model id that reads as a flag is still refused on every row.
    expect(
      CardSchema.safeParse({
        ...base,
        kind: "agents",
        payload: { native: false, agents: [{ ...reviewer, model: { ...reviewer.model, id: "-m x" } }] }
      }).success
    ).toBe(false)
  })

  test("the flow-form card holds the flow, who asked, the derived fields, the draft and what was given; a bad kind or provider is rejected", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "flow-form",
      payload: {
        flow: "tab.harness",
        via: "agent",
        fields: [
          { name: "id", label: "Id", kind: "text", required: true },
          {
            name: "harness",
            label: "Harness",
            kind: "select",
            required: true,
            optionsFrom: "cloud-repos",
            options: [
              { value: "codex", label: "Codex · OPENAI_API_KEY" },
              { value: "opencode", label: "OpenCode", disabled: true, reason: "no credential" }
            ]
          },
          { name: "model", label: "Model", kind: "text", required: true, options: [] },
          { name: "purpose", label: "Purpose", kind: "text", required: false }
        ],
        draft: { id: "implement", harness: "codex" },
        given: { id: "implement", harness: "codex" }
      }
    })
    if (card.kind !== "flow-form") return
    expect(card.payload.fields[1]?.options?.[1]).toEqual({
      value: "opencode",
      label: "OpenCode",
      disabled: true,
      reason: "no credential"
    })
    expect(card.payload.draft.harness).toBe("codex")
    const payload = card.payload
    expect(
      CardSchema.safeParse({
        ...base,
        kind: "flow-form",
        payload: { ...payload, fields: [{ name: "x", label: "X", kind: "date", required: true }] }
      }).success
    ).toBe(false)
    expect(
      CardSchema.safeParse({
        ...base,
        kind: "flow-form",
        payload: {
          ...payload,
          fields: [{ name: "x", label: "X", kind: "select", required: true, optionsFrom: "moons" }]
        }
      }).success
    ).toBe(false)
    expect(CardSchema.safeParse({ ...base, kind: "flow-form", payload: { ...payload, via: "system" } }).success).toBe(
      false
    )
  })

  test("the subagent card takes a built-in role id and its purpose, and still parses without one", () => {
    const payload = {
      harnessId: "codex",
      displayName: "Reviewer · GPT-5.6 Terra",
      roleId: "implement",
      purpose: "Reviews diffs.",
      tabId: "pty-1",
      sessionId: "pty-1",
      cwd: "/tmp",
      phase: "running",
      exitCode: null
    }
    const card = CardSchema.parse({ ...base, kind: "agent", payload })
    if (card.kind !== "agent") return
    // The agent payload is a union: the local tab card and the Smithers Cloud
    // session card that `cloud: true` marks. A subagent launched from the `+`
    // menu is the local variant, so pin that before reading the role fields —
    // narrowing alone would let a card that parsed as the cloud variant pass
    // this test without ever asserting a role.
    expect("cloud" in card.payload).toBe(false)
    if ("cloud" in card.payload) return
    expect(card.payload.roleId).toBe("implement")
    expect(card.payload.purpose).toBe("Reviews diffs.")
    const { roleId: _roleId, purpose: _purpose, ...bare } = payload
    expect(CardSchema.safeParse({ ...base, kind: "agent", payload: bare }).success).toBe(true)
    expect(CardSchema.safeParse({ ...base, kind: "agent", payload: { ...payload, roleId: "Not An Id" } }).success).toBe(
      false
    )
  })
})

describe("the models card", () => {
  const payload = { models: [], seats: [], credentials: [], tests: [], testing: [], host: "observed" }
  const model = {
    id: "ollama",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:11434",
    modelId: "llama3",
    credential: "OLLAMA"
  }

  test("carries models, seats, credential names, what is running and the last result per model", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "models",
      payload: {
        ...payload,
        models: [model],
        seats: [{ id: "explainer", recordId: "ollama", resolvable: false }],
        credentials: [{ name: "OLLAMA", present: false, origins: ["http://127.0.0.1:11434"] }],
        tests: [{
          id: "ollama",
          testedAt: 5,
          result: {
            ok: false,
            latencyMs: 15_000,
            failure: { code: "timeout", deadlineMs: 15_000 },
            fault: "dependency"
          }
        }],
        testing: ["ollama"],
        selected: "ollama",
        attention: { kind: "seat-unresolved", seat: "explainer" }
      }
    })
    if (card.kind !== "models") throw new Error("the models card decoded as another kind")
    expect(card.payload.models).toEqual([model])
    expect(card.payload.tests[0]?.result).toEqual({
      ok: false,
      latencyMs: 15_000,
      failure: { code: "timeout", deadlineMs: 15_000 },
      fault: "dependency"
    })
    expect(card.payload.attention).toEqual({ kind: "seat-unresolved", seat: "explainer" })
  })

  test("refuses a key anywhere a value could ride: on a model, on a credential, on a result", () => {
    const refused = (patch: Record<string, unknown>): boolean =>
      !CardSchema.safeParse({ ...base, kind: "models", payload: { ...payload, ...patch } }).success
    expect(refused({ models: [{ ...model, apiKey: "sk-live" }] })).toBe(true)
    expect(refused({ credentials: [{ name: "OLLAMA", present: true, origins: [], value: "sk-live" }] })).toBe(true)
    expect(refused({
      tests: [{ id: "ollama", testedAt: 1, result: { ok: true, latencyMs: 1, sample: "ok", message: "sk-live" } }]
    })).toBe(true)
  })

  test("refuses a seat nothing reads, a failure code off the union, and attention of an unknown kind", () => {
    const refused = (patch: Record<string, unknown>): boolean =>
      !CardSchema.safeParse({ ...base, kind: "models", payload: { ...payload, ...patch } }).success
    expect(refused({ seats: [{ id: "role:ui", recordId: null, resolvable: true }] })).toBe(true)
    expect(refused({
      tests: [{
        id: "ollama",
        testedAt: 1,
        result: { ok: false, latencyMs: 1, failure: { code: "authentication" }, fault: "user" }
      }]
    })).toBe(true)
    expect(refused({ attention: { kind: "celebrate" } })).toBe(true)
  })

  test("the model-call card holds the composed request, the answer it got and what is out, and no value", () => {
    const request = {
      kind: "decision",
      state: [{ key: "text", kind: "text", value: "The sky is blue." }],
      questions: { ok: { type: "boolean", instructions: "Does it mention a color?" } }
    }
    const card = CardSchema.parse({
      ...base,
      kind: "model-call",
      payload: {
        model: "ollama",
        request,
        response: {
          askedAt: 5,
          request,
          result: {
            ok: true,
            latencyMs: 12,
            sample: "true 0.97",
            output: { kind: "decision", answers: { ok: { type: "boolean", value: true, probability: 0.97 } } }
          }
        },
        pending: {
          requestId: "6f0a2c1e-ask-0001",
          request,
          binding: { protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" },
          owner: "will"
        },
        fixture: "Evaluator.layerScripted(() => ({ [\"ok\"]: { probability: 0.97 } }))"
      }
    })
    if (card.kind !== "model-call") throw new Error("the model-call card decoded as another kind")
    expect(card.payload.request).toEqual(request)
    expect(card.payload.response?.result.ok).toBe(true)
    expect(card.payload.pending?.request).toEqual(request)
    // A draft that is not yet askable is still a card: the composer says what is wrong.
    expect(
      CardSchema.safeParse({
        ...base,
        kind: "model-call",
        payload: { model: "ollama", request: { ...request, questions: {} } }
      }).success
    ).toBe(true)
    const refused = (patch: Record<string, unknown>): boolean =>
      !CardSchema.safeParse({ ...base, kind: "model-call", payload: { model: "ollama", request, ...patch } }).success
    expect(refused({ apiKey: "sk-live" })).toBe(true)
    expect(refused({ request: { kind: "generation", system: "", prompt: "hi", maxTokens: 8, apiKey: "sk-live" } }))
      .toBe(true)
    expect(
      refused({ response: { askedAt: 1, request, result: { ok: true, latencyMs: 1, sample: "", message: "sk-live" } } })
    ).toBe(true)
    // An ask that is out names its binding by credential NAME, like a record: no field a value could ride in.
    const binding = { protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" }
    expect(refused({ pending: { requestId: "6f0a2c1e-ask-0001", request, binding, owner: null } })).toBe(false)
    expect(
      refused({
        pending: { requestId: "6f0a2c1e-ask-0001", request, binding: { ...binding, apiKey: "sk-live" }, owner: null }
      })
    ).toBe(true)
  })

  test("a retired agent-models card still decodes as retired beside it", () => {
    const retired = CardSchema.parse({ ...base, kind: "agent-models", payload: { models: [model] } })
    expect(retired).toEqual({ ...base, kind: "retired", title: "", status: "acted", payload: {}, loading: false })
    expect(CardSchema.parse({ ...base, kind: "models", payload }).kind).toBe("models")
  })

  test("a model form draws its selects from models, credentials and seats, and model.save is not a retired flow", () => {
    expect(FORM_OPTION_PROVIDERS).toEqual(expect.arrayContaining(["models", "credentials", "seats"]))
    const form = CardSchema.parse({
      ...base,
      kind: "flow-form",
      payload: {
        flow: "model.save",
        via: "user",
        fields: [
          { name: "credential", label: "Credential", kind: "select", required: true, optionsFrom: "credentials" },
          { name: "seat", label: "Seat", kind: "select", required: true, optionsFrom: "seats" },
          { name: "recordId", label: "Model", kind: "select", required: true, optionsFrom: "models" }
        ],
        draft: {},
        given: {}
      }
    })
    expect(form.kind).toBe("flow-form")
  })
})

describe("card patch validation", () => {
  test("the native card.update frame requires the same kind validation", () => {
    expect(
      AgentTurnFrameSchema.safeParse({
        runId: "run-1",
        type: "card.update",
        id: base.id,
        patch: { kind: "file", payload: { line: 0 } }
      }).success
    ).toBe(false)
    expect(
      AgentTurnFrameSchema.safeParse({
        runId: "run-1",
        type: "card.update",
        id: base.id,
        patch: { kind: "file", payload: { line: 1 } }
      }).success
    ).toBe(true)
  })

  test("metadata is optional but kind is required", () => {
    expect(CardPatchSchema.parse({ kind: "file", title: "After" })).toEqual({ kind: "file", title: "After" })
    expect(CardPatchSchema.safeParse({ title: "After" }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ kind: "agent", payload: { roleId: "Bad Id" } }).success).toBe(false)
  })

  const diagnostic = { line: 1, character: 1, endLine: 1, endCharacter: 2, severity: "error", message: "bad" }
  test("refuses file diagnostics above the cap on card.update", () => {
    expect(
      CardPatchSchema.safeParse({
        kind: "file",
        payload: {
          diagnostics: Array.from({ length: LSP_DIAGNOSTICS_CAP + 1 }, () => diagnostic)
        }
      }).success
    ).toBe(false)
  })
  test("accepts partial file payloads at the cap and rejects invalid anchors and missing kinds", () => {
    expect(CardPatchSchema.parse({
      kind: "file",
      payload: {
        diagnostics: Array.from({ length: LSP_DIAGNOSTICS_CAP }, () => diagnostic)
      }
    })).toMatchObject({ kind: "file" })
    expect(CardPatchSchema.safeParse({ kind: "file", payload: { line: 0 } }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ payload: { line: 1 } }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ kind: "file", payload: { intel: { state: "installing" } } }).success).toBe(false)
  })
})

describe("card patches never invent defaults", () => {
  test("a repository-setup patch that omits previousReceipts decodes without it", () => {
    expect(CardPatchSchema.parse({ kind: "repository-setup", payload: { inspectedAt: 5 } })).toEqual({
      kind: "repository-setup",
      payload: { inspectedAt: 5 }
    })
  })
  test("an empty payload patch stays empty for every card kind with an object payload", () => {
    const objectPayloads = CardSchema.options.filter((option) => option.shape.payload instanceof z.ZodObject)
    expect(objectPayloads.length).toBeGreaterThan(CardSchema.options.length / 2)
    for (const option of objectPayloads) {
      const kind = option.shape.kind.value
      const patch = CardPatchSchema.parse({ kind, payload: {} })
      expect({ kind, payload: patch.payload }).toEqual({ kind, payload: {} })
    }
  })
})

describe("env card persistence", () => {
  test("redacts values on initial decoding, patches, and repeated reads", () => {
    const vars = [{ name: "DATABASE_URL", value: "postgres://user:password@host/db" }, { name: "PIN", value: "12" }]
    const card = CardSchema.parse({
      ...base,
      kind: "env",
      payload: { repo: "smithers", vars, setupScript: null, secretNames: ["TOKEN"] }
    })
    expect(card.payload).toMatchObject({ vars: [{ name: "DATABASE_URL", value: "pos…" }, { name: "PIN", value: "…" }] })
    expect(JSON.stringify(card)).not.toContain("password")
    expect(CardSchema.parse(card)).toEqual(card)
    expect(CardPatchSchema.parse({ kind: "env", payload: { vars } })).toMatchObject({
      payload: {
        vars: [
          { name: "DATABASE_URL", value: "pos…" },
          { name: "PIN", value: "…" }
        ]
      }
    })
  })
})

describe("the run trace card's graph view", () => {
  const trace = (payload: Record<string, unknown>) =>
    CardSchema.safeParse({
      ...base,
      kind: "run-trace",
      payload: {
        repo: "smithersai/smithers",
        runId: "run-1",
        workflow: "review",
        phase: "running",
        steps: [],
        result: null,
        lastSeq: 0,
        ...payload
      }
    })

  test("a row persisted before the graph view still parses, and gains nothing", () => {
    const before = trace({ traceView: "timeline", filter: "failed" })
    expect(before.success).toBe(true)
    expect(Object.keys(before.data?.payload ?? {})).not.toContain("plan")
    expect(Object.keys(before.data?.payload ?? {})).not.toContain("graph")
  })

  test("the plan a launch snapshotted and the camera flag round-trip", () => {
    const node = {
      id: "root.flow.then.map.all.steady",
      kind: "step",
      key: "key1_1d19f029117886d2",
      dependsOn: ["root.flow.andThen"],
      tier: "sealed",
      action: "gateway/graph/Steady",
      status: "run"
    }
    const parsed = trace({
      traceView: "graph",
      plan: { planId: "plan-1", digest: "d1", nodes: [node] },
      graph: { follow: true, execution: "c7eac2d2" }
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.payload).toMatchObject({
      traceView: "graph",
      plan: { planId: "plan-1", digest: "d1", nodes: [node] },
      graph: { follow: true, execution: "c7eac2d2" }
    })
    // The plan carries the node's address, its key, its edges, its tier and
    // what it dispatches. A node's key MATERIAL is tens of kilobytes of JSON
    // schema and a card payload is written to disk, so a caller that hands the
    // whole plan node over persists the drawn part and nothing else.
    const whole = trace({
      plan: { planId: "plan-1", digest: "d1", nodes: [{ ...node, material: { kind: "sealed", body: {} } }] }
    })
    expect((whole.data?.payload as { plan: { nodes: ReadonlyArray<unknown> } }).plan.nodes).toEqual([node])
    expect(trace({ traceView: "canvas" }).success).toBe(false)
    expect(trace({ plan: { planId: "plan-1", nodes: [] } }).success).toBe(false)
  })
})

/*
 * The persistence contract, kind by kind. Cards.ts states that "everything in
 * a card payload is written to disk", and apps/app's FrameSnapshotSchema reads
 * a whole transcript back through `cards: z.array(CardSchema)` — so a field
 * that stops parsing rejects a snapshot, not one card. Dozens of fields are
 * marked "optional so cards persisted before the lane parse", which is a
 * promise about payloads nobody can rewrite.
 *
 * Every kind therefore carries two fixtures: `minimal` is the payload with
 * only the fields the schema requires (what a card written before every later
 * lane holds) and `full` is the payload with every field the schema accepts.
 * Both must parse, both must come back unchanged, and a minimal payload must
 * gain nothing on the way through. Making an optional field required,
 * renaming a kind or tightening an enum breaks a fixture here instead of a
 * reader's transcript.
 */

/** A canonical non-nil gateway workspace id (GatewayWorkspace.ts). */
const gatewayWorkspaceId = "6f1b9c2e-6a4a-4c0e-9f52-2c1a7f0b39d1"
const rateLimit = { limit: 5000, remaining: 42, resetAt: "2026-09-05T10:00:00Z" }

/*
 * A complete StatusRollup (Health.ts): the observation a health host attaches
 * to a run or a session. It is optional wherever it appears, so it belongs in
 * `full` only, stated whole (`reason` and `provenance` included) because the
 * field audit reads top-level keys and would miss a nested field left out.
 */
const statusRollup = (subjectId: string, state: string, activity: string) => ({
  subjectId,
  state,
  activity,
  health: "healthy",
  attention: "none",
  freshness: "fresh",
  reason: "ok",
  provenance: {
    checkerId: "checker-1",
    monitorId: "monitor-1",
    observedAt: 1_757_000_000_000,
    expiresAt: 1_757_000_030_000,
    evidenceSeq: 7,
    incarnation: "inc-1",
    version: 1
  },
  updatedAt: 1_757_000_000_000
})

/*
 * Repository setup (src/RepositorySetup.ts). A draft is a required payload
 * field, so both fixtures carry one; `choreEvent` is stated because it is
 * defaulted, and a fixture that left it out would not equal what decoding
 * produces. `setupReceipt` is the host's evidence for one executed operation.
 */
const setupDraft = {
  steps: [{ id: "research", name: "Research issue", mode: "automatic", prompt: "Classify the issue." }],
  checks: [],
  cases: [],
  replies: "draft",
  landing: "ask",
  scope: "future",
  label: "",
  schedule: "",
  choreEvent: "none",
  budgetMinutes: 10,
  connectIssues: false,
  trialTitle: "[Smithers test] Handle issues",
  trialBody: "A scoped setup trial."
}

const setupDigest = "0".repeat(64)

const setupReceipt = (requestId: string, operation: string, phase: string) => ({
  requestId,
  runId: `run-${requestId}`,
  jobRunId: `job-${requestId}`,
  revision: 1,
  operation,
  phase,
  digest: setupDigest,
  updatedAt: 1_757_000_000_000,
  results: [{
    caseId: "case-1",
    status: "passed",
    observed: "the reply cited the failing line",
    evidence: ["https://example.invalid/run/1"],
    executionId: "exec-1"
  }],
  evidence: ["https://example.invalid/run/1"],
  error: "the workspace went away",
  trialIssue: { source: "github", number: 12, url: "https://example.invalid/issues/12" },
  registrationId: "registration-1",
  sourceRevision: "abc1234"
})

type KindFixtures = {
  /** Only the fields the schema requires: what a card persisted before every later lane carries. */
  readonly minimal: Record<string, unknown>
  /** Every field the schema accepts, including the ones later lanes added. */
  readonly full: Record<string, unknown>
  /** What decoding must produce when it rewrites the payload (the env card redacts). */
  readonly decodedFull?: Record<string, unknown>
}

const FIXTURES: Record<Card["kind"], KindFixtures> = {
  "factory.home": {
    minimal: { repo: "org/repo", home: { kind: "none" }, flows: [] },
    full: {
      repo: "org/repo",
      home: {
        kind: "blocks",
        blocks: [
          { type: "prompt", placeholder: "Change it…" },
          { type: "markdown", path: "README.md", markdown: "# Hello" }
        ]
      },
      flows: [{ id: "review", summary: "Review", description: "Review code", featured: true }]
    }
  },
  "repo-update": {
    minimal: {
      repo: "org/repo",
      scope: "github:alice",
      checkedAt: 1,
      summary: "Up to date",
      openIssues: null,
      openPrs: null,
      problems: [],
      items: []
    },
    full: {
      repo: "org/repo",
      scope: "github:alice",
      checkedAt: 2,
      summary: "One issue update",
      branch: "main",
      openIssues: 1,
      openPrs: 0,
      problems: ["Notifications unavailable"],
      items: [{
        id: "notice-1",
        version: "v1",
        kind: "issue",
        number: 3,
        title: "Fix greeting",
        state: "open",
        tags: ["bug"],
        read: false
      }]
    }
  },
  plan: {
    minimal: { items: [] },
    full: { items: [{ id: "p1", title: "Read the route", status: "done" }] }
  },
  approval: {
    minimal: { capability: "network" },
    full: {
      capability: "network",
      detail: "POST https://api.github.com",
      runId: "run-1",
      requestId: "gate-1",
      approval: { _tag: "ApprovalTarget.Node", node: "call-3" },
      answerDraft: { question: "a".repeat(64), text: "The scheduler owns the budget." },
      question: {
        kind: "select",
        prompt: "Which environment?",
        name: "environment",
        options: ["staging", "production"],
        attempt: 1,
        maxAttempts: 3
      },
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      decision: "approved",
      decidedAt: 1_757_000_000_000,
      pending: true,
      error: "the gateway refused (503)",
      chain: true,
      background: false,
      flow: "review.land"
    }
  },
  "billing-plans": {
    minimal: { planKey: null, sandbox: null, plans: [], checkout: false },
    full: {
      planKey: "free",
      checkout: true,
      sandbox: {
        concurrentSandboxes: 1,
        concurrentInUse: 1,
        idleTimeoutSecs: 1800,
        hoursPerDay: 4,
        secondsUsedToday: 3600,
        dayResetsAt: "2026-09-16T00:00:00Z"
      },
      plans: [{
        key: "pro",
        display_name: "Pro",
        price_cents: 5000,
        interval: "monthly",
        checkout_available: true,
        limits: {
          concurrent_sandboxes: 3,
          idle_timeout_secs: 14400,
          hours_per_day: -1,
          private_repos: -1,
          storage_bytes: -1,
          ci_minutes: -1,
          agent_runs: -1,
          seats: 1
        }
      }],
      refusal: {
        status: 402,
        code: "plan_limit_exceeded",
        message: "Upgrade or suspend a sandbox.",
        plan_key: "free",
        limit_kind: "concurrent_sandboxes",
        upgrade_plan_key: "pro"
      }
    }
  },
  balance: {
    minimal: {
      totalUsd: "0.00",
      state: "empty",
      allowedToStartWork: false,
      lifetimeChargedUsd: "0.00",
      chargeCount: 0,
      introUsd: null
    },
    full: {
      totalUsd: "500.00",
      state: "ok",
      allowedToStartWork: true,
      lifetimeChargedUsd: "12.50",
      chargeCount: 3,
      introUsd: "500.00"
    }
  },
  status: {
    minimal: {},
    full: { progress: 0.5, note: "reading the route" }
  },
  "grant-confirm": {
    minimal: { login: "ada", amountUsd: 25, phase: "confirm" },
    full: { login: "ada", amountUsd: 25, phase: "failed", grantId: "grant-1", error: "the grant call failed (500)" }
  },
  "request-queue": {
    minimal: { requests: [], approving: null },
    full: {
      requests: [{ login: "ada", note: "reviewing smithers", createdAt: "2026-09-05T09:00:00Z" }],
      approving: "ada",
      error: "the allowlist add failed (500)"
    }
  },
  "admin-health": {
    minimal: { services: [], queueDepth: null, charges: null, checkedAt: "2026-09-05T09:00:00Z" },
    full: {
      services: [{ name: "gateway", status: "ok", detail: "200 in 12 ms" }],
      queueDepth: 3,
      charges: { chargeCount: 2, lifetimeChargedUsd: "1.00" },
      checkedAt: "2026-09-05T09:00:00Z"
    }
  },
  connect: {
    minimal: { github: { connected: false, login: null }, nativeAvailable: false },
    full: {
      provider: "github",
      github: { connected: true, login: "will" },
      nativeAvailable: true,
      integrations: {
        repo: "smithersai/smithers",
        rows: [{
          id: "linear",
          state: "error",
          detail: "ENG",
          error: "token revoked",
          lastSyncAt: "2026-09-26T09:40:00Z"
        }]
      }
    }
  },
  world: {
    minimal: { documents: [] },
    full: {
      documents: [{
        id: "doc-1",
        path: "docs/adr/0003-change.md",
        title: "The change is the unit",
        confidence: 0.9,
        cloud: { repo: "smithersai/smithers", slug: "adr-0003", revision: 4 }
      }],
      selectedDocumentId: "doc-1",
      view: "document",
      index: { repo: "smithersai/smithers", page: 1, hasNext: false }
    }
  },
  browser: {
    minimal: { url: "https://smithers.sh", finalUrl: null, status: null, frameable: false, blockReason: null },
    full: {
      url: "https://smithers.sh",
      finalUrl: "https://smithers.sh/docs",
      status: 200,
      frameable: false,
      blockReason: "x-frame-options: deny",
      error: "the fetch failed (503)"
    }
  },
  "run-trace": {
    minimal: {
      repo: "smithersai/smithers",
      runId: "run-1",
      workflow: "review",
      phase: "running",
      steps: [],
      result: null,
      lastSeq: 0
    },
    full: {
      authoring: { requestId: "author-request-1", owner: "will", launchError: "offline" },
      statusRollup: statusRollup("run:run-1", "running", "working"),
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      runId: "run-1",
      workflow: "review",
      phase: "quiet",
      steps: ["read the diff"],
      result: "3 findings",
      error: "the executor exited 1",
      failure: { class: "dependency", tag: "@smthrs/flow/DependencyUnavailable" },
      observationError: "the events projection refused (500)",
      lastSeq: 42,
      quietForMs: 600_000,
      input: { repo: "smithersai/smithers" },
      kind: "prototype",
      waiting: "approval",
      steeringPending: true,
      facet: "transcript",
      facetRequest: {
        id: "facet-request-1",
        owner: "will",
        repo: "smithersai/smithers",
        runId: "run-1",
        workspaceId: gatewayWorkspaceId,
        facet: "transcript",
        state: "failed",
        follow: true,
        toggleFollow: true,
        error: "Transcript unavailable"
      },
      follow: true,
      transcriptRows: [{ sequence: 1, turn: 1, at: 1_757_000_000_000, kind: "message", text: "reading" }],
      transcriptAtRevision: 17,
      events: [{ seq: 1, type: "call.started" }],
      selection: "span-3",
      cursorSeq: 41,
      filter: "failed",
      liveTail: false,
      traceView: "graph",
      plan: {
        planId: "plan-1",
        digest: "8d6fcaa8b2922fa83791714f8e688b495e4dbd7aebf63e4e4114af660e3fbd98",
        nodes: [{
          id: "root.flow.then.map.all.steady",
          kind: "step",
          key: "key1_1d19f029117886d2",
          dependsOn: ["root.flow.andThen"],
          tier: "sealed",
          action: "gateway/graph/Steady",
          status: "run"
        }],
        graph: {
          edges: [{ from: "root.flow.andThen", to: "root.flow.then.map.all.steady", reason: "value" }],
          nodes: [{
            id: "root.flow.then.map.all.steady",
            declaredAt: { path: "flows/graph-fixture/flow.ts", line: 42 }
          }],
          sourceRevision: "a03f5f1ea03f5f1ea03f5f1ea03f5f1ea03f5f1e"
        }
      },
      graph: {
        follow: true,
        node: "root.flow.then.map.all.steady",
        tab: "events",
        codeError: {
          path: "flows/graph-fixture/flow.ts",
          message: "Path not found: flows/graph-fixture/flow.ts in smithersai/smithers"
        }
      },
      takeover: { terminalSessionId: "pty-1" },
      codingChangeId: "qupxosqw"
    }
  },
  "workflow-list": {
    minimal: { repo: "smithersai/smithers", workflows: [] },
    full: {
      repo: "smithersai/smithers",
      catalogRequest: { id: "catalog-request", owner: "smithersai", state: "pending" },
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      workflows: [{
        key: "issue.repro",
        description: "Research an issue",
        prompt: "Read and reproduce the issue.",
        inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] }
      }],
      issueContext: { number: 3, title: "Fix greeting" },
      research: "Reproduced the missing-name case."
    }
  },
  "flow-plan": {
    minimal: { repo: "smithersai/smithers", flowId: "review", status: "pending" },
    full: {
      previousPlan: { planId: "plan-0", digest: "b".repeat(64), nodes: [] },
      sourceReceipt: { runCardId: "author-run-1", receipt: "copy:1:event" },
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      flowId: "review",
      input: { pr: 4821 },
      planRequest: { id: "plan-request-1", owner: "will" },
      // A re-plan that was refused keeps the graph it last drew, so the card
      // states the refusal without blanking what the person was reading.
      status: "failed",
      error: "The workspace has no flow called review.",
      planId: "plan-1",
      digest: "d".repeat(64),
      nodes: [
        {
          id: "root.read",
          kind: "step",
          key: `key1_${"0".repeat(64)}`,
          dependsOn: [],
          tier: "sealed",
          action: "files/read",
          status: "run"
        },
        {
          id: "root.review",
          kind: "agent",
          key: `key1_${"1".repeat(64)}`,
          dependsOn: ["root.read"],
          tier: "compensable",
          status: "run"
        }
      ],
      graph: {
        edges: [{ from: "root.read", to: "root.review", reason: "value" }],
        nodes: [
          { id: "root.read", declaredAt: { path: "flows/review/flow.ts", line: 12 } },
          { id: "root.review" }
        ],
        // The revision those sites were read at: what the Code tab reads AT.
        sourceRevision: "a03f5f1ea03f5f1ea03f5f1ea03f5f1ea03f5f1e"
      },
      // The re-key preview against a run that really did settle a node clean.
      against: "run-1",
      rekey: { rerun: 3, total: 11, etaMs: 24, wasMs: 1_182, cleanSettlements: 1 },
      view: {
        node: "root.read",
        tab: "declaration",
        codeError: {
          path: "flows/review/flow.ts",
          message: "Path not found: flows/review/flow.ts in smithersai/smithers"
        }
      }
    }
  },
  "trigger-list": {
    minimal: { repo: "smithersai/smithers", triggers: [] },
    full: {
      repo: "smithersai/smithers",
      preparations: [{
        id: "prep-1",
        owner: "will",
        workspaceId: "0b5e8c1a-2f3d-4e6a-9b7c-1d2e3f4a5b6c",
        phase: "ready",
        draft: { flow: "ci", slug: "nightly", schedule: "0 * * * *", input: "{}", tokens: 1200, minutes: 3 },
        receipt: { text: "prepared", args: "--slug nightly" },
        error: ""
      }],
      pauseRequests: [{ id: "pause-1", slug: "nightly", owner: "will", phase: "completed" }],
      declared: [{ event: "push", flow: "ci", description: "run ci on every push" }],
      live: true,
      triggers: [{
        id: "trg-1",
        slug: "nightly",
        flowId: "ci",
        cron: "0 * * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: 1_757_003_600_000
      }]
    }
  },
  "run-list": {
    minimal: { repo: "smithersai/smithers", runs: [] },
    full: {
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      listRequest: {
        id: "list-request",
        owner: "will",
        repo: "smithersai/smithers",
        workspaceId: gatewayWorkspaceId,
        status: "running",
        flow: "review",
        lineage: "lin-1",
        state: "failed"
      },
      statuses: ["running", "completed"],
      status: "running",
      flow: "review",
      lineage: "lin-1",
      approvals: [{ runId: "run-1", requestId: "gate-1", title: "POST https://api.github.com" }],
      observationError: "the runs projection refused (500)",
      observedAt: 1_757_000_000_000,
      runs: [{
        runId: "run-1",
        flowId: "review",
        status: "running",
        waiting: "approval",
        statusRollup: statusRollup("run:run-1", "running", "working"),
        createdAt: 1_757_000_000_000,
        turns: 3,
        calls: 12
      }]
    }
  },
  "approvals-inbox": {
    minimal: { repo: "smithersai/smithers", approvals: [] },
    full: {
      repo: "smithersai/smithers",
      workspaceId: gatewayWorkspaceId,
      gatewayBindingVersion: 1,
      approvals: [{
        runId: "run-1",
        requestId: "gate-1",
        title: "POST https://api.github.com",
        approval: { _tag: "ApprovalTarget.Node", node: "call-3" },
        answerDraft: { question: "b".repeat(64), text: "Ship the canary first." },
        requestedAt: 1_757_000_000_000,
        decision: "denied",
        decidedAt: 1_757_000_060_000,
        decisionError: "the gateway refused (503)",
        pending: true
      }]
    }
  },
  "workflow-repo": {
    minimal: { intent: "create", description: "a flow that lands the change", repos: [], chosen: null },
    full: {
      intent: "create",
      description: "a flow that lands the change",
      repos: ["smithersai/smithers", "will/plue"],
      chosen: "smithersai/smithers"
    }
  },
  "issue-list": {
    minimal: { repo: "smithersai/smithers", filter: "open", issues: [] },
    full: {
      repo: "smithersai/smithers",
      filter: "all",
      kind: "issue",
      issues: [{
        number: 1634,
        title: "rc0 CI green",
        state: "fixed",
        author: "will",
        comments: 4,
        updatedAt: "2026-09-05T09:00:00Z",
        source: "github",
        htmlUrl: "https://github.com/smithersai/smithers/issues/1634",
        kind: "chat",
        task: {
          owner: {
            id: "assistant",
            name: "Assistant",
            iconUrl: "https://example.com/assistant.png",
            agentId: "assistant"
          },
          due: "2026-09-27",
          priority: 1,
          parent: { number: 1600, title: "CI" },
          fixedBy: {
            id: "assistant",
            name: "Assistant",
            iconUrl: "https://example.com/assistant.png",
            agentId: "assistant"
          },
          verifiedBy: {
            id: "assistant",
            name: "Assistant",
            iconUrl: "https://example.com/assistant.png",
            agentId: "assistant"
          }
        }
      }],
      github: {
        source: "synced",
        syncedAt: "2026-09-05T08:00:00Z",
        stale: true,
        syncError: "the mirror refused (500)",
        refusal: "not linked"
      }
    }
  },
  issue: {
    minimal: {
      repo: "smithersai/smithers",
      number: 1634,
      title: "rc0 CI green",
      state: "open",
      author: null,
      issueBody: "",
      labels: [],
      comments: []
    },
    full: {
      repo: "smithersai/smithers",
      number: 1634,
      title: "rc0 CI green",
      kind: "chat",
      visibility: "private",
      task: {
        owner: {
          id: "assistant",
          name: "Assistant",
          iconUrl: "https://example.com/assistant.png",
          agentId: "assistant"
        },
        due: "2026-09-27",
        priority: 0,
        parent: { number: 1600 },
        fixedBy: {
          id: "assistant",
          name: "Assistant",
          iconUrl: "https://example.com/assistant.png",
          agentId: "assistant"
        },
        verifiedBy: {
          id: "assistant",
          name: "Assistant",
          iconUrl: "https://example.com/assistant.png",
          agentId: "assistant"
        }
      },
      conversation: { branchId: "branch-main", owner: "will", creationKey: "conversation-1" },
      commentDraft: "Reply",
      pendingComments: [{ id: "request-1", text: "Hello", actor: "user", status: "requested" }],
      sync: { provider: "slack", connectionId: "slack", scopeId: "T1", conversationId: "C1", threadId: "1.1" },
      state: "verified",
      author: "will",
      issueBody: "shard-3 wedges on sqlite",
      source: "github",
      htmlUrl: "https://github.com/smithersai/smithers/issues/1634",
      labels: ["ci", "flaky"],
      comments: [{
        id: 31,
        author: null,
        persona: { username: "Reviewer", iconEmoji: ":robot_face:", iconUrl: "https://example.com/avatar.png" },
        commentBody: "reproduced",
        createdAt: "2026-09-05T09:00:00Z"
      }],
      createdAt: "2026-09-04T08:00:00Z",
      assignees: [{ login: "ada", avatar: "https://avatars.githubusercontent.com/u/1" }],
      labelColors: { ci: "0e8a16", flaky: "d93f0b" },
      authorAvatar: "https://avatars.githubusercontent.com/u/2"
    }
  },
  "pr-list": {
    minimal: { repo: "smithersai/smithers", landings: [] },
    full: {
      repo: "smithersai/smithers",
      landings: [{
        number: 12,
        title: "Serve repository files",
        state: "queued",
        author: "will",
        updatedAt: "2026-09-05T09:00:00Z"
      }]
    }
  },
  pr: {
    minimal: {
      repo: "smithersai/smithers",
      number: 12,
      title: "Serve repository files",
      state: "queued",
      author: null,
      prBody: "",
      reviews: [],
      checks: []
    },
    full: {
      tab: "files",
      repo: "smithersai/smithers",
      number: 12,
      title: "Serve repository files",
      state: "queued",
      author: "will",
      prBody: "one bounded route",
      reviews: [{ author: "ada", type: "APPROVED", reviewBody: "ship it" }],
      checks: [{ context: "typecheck", state: "success" }],
      readErrors: { commits: "Reading commits failed (500)", files: "Reading files failed (500)" },
      branch: "serve-files",
      baseBranch: "main",
      draft: false,
      createdAt: "2026-09-04T08:00:00Z",
      authorAvatar: "https://avatars.githubusercontent.com/u/2",
      labels: ["api"],
      labelColors: { api: "1d76db" },
      commits: [{
        changeId: "kkmpptxz",
        commitId: "a1b2c3d4",
        message: "Serve repository files",
        author: "will",
        timestamp: "2026-09-04T08:00:00Z"
      }],
      files: [{
        path: "src/files.ts",
        oldPath: "src/read.ts",
        status: "renamed",
        additions: 12,
        deletions: 3,
        patch: "@@ -1 +1 @@"
      }]
    }
  },
  notifications: {
    minimal: { unread: 0, items: [] },
    full: {
      unread: 1,
      items: [{
        id: "n-1",
        title: "review requested",
        repo: "smithersai/smithers",
        reason: "review_requested",
        createdAt: "2026-09-05T09:00:00Z",
        read: false
      }]
    }
  },
  env: {
    minimal: { repo: "smithersai/smithers", vars: [], setupScript: null },
    full: {
      repo: "smithersai/smithers",
      vars: [{ name: "DATABASE_URL", value: "postgres://user:password@host/db" }, { name: "PIN", value: "12" }],
      setupScript: "pnpm install",
      reconnect: true
    },
    decodedFull: {
      repo: "smithersai/smithers",
      vars: [{ name: "DATABASE_URL", value: "pos…" }, { name: "PIN", value: "…" }],
      setupScript: "pnpm install",
      reconnect: true
    }
  },
  stack: {
    minimal: { repo: "smithersai/smithers", failure: null },
    full: {
      repo: "smithersai/smithers",
      failure: { act: "backfill", message: "Refused", args: "smithersai/smithers" },
      bootstrap: { requestedAt: 1 },
      view: "metrics"
    }
  },
  "provider-accounts": {
    minimal: { accounts: [] },
    full: {
      accounts: [
        {
          id: "conn-1",
          provider: "claude",
          label: "work",
          email: "ada@example.com",
          state: "active",
          limitedUntil: "2026-09-25T10:15:00Z"
        },
        { id: "conn-2", provider: "codex", label: "codex-1", email: null, state: "refresh_failed", limitedUntil: null }
      ],
      pending: { userCode: "ABCD-EFGH", verificationUri: "https://auth.openai.com/codex/device" },
      unavailable: true
    }
  },
  secrets: {
    minimal: { repo: "smithersai/smithers", scope: "repository", secrets: [] },
    full: {
      repo: "smithersai/smithers",
      scope: "repository",
      secrets: [{
        name: "OPENAI_API_KEY",
        hosts: ["api.openai.com"],
        matchHeaders: ["authorization"],
        updatedAt: "2026-09-05T09:00:00Z",
        reconnect: true
      }]
    }
  },
  models: {
    minimal: { models: [], seats: [], credentials: [], tests: [], testing: [], host: "unavailable" },
    full: {
      models: [
        {
          id: "cerebras",
          protocol: "openai-chat",
          baseUrl: "https://api.cerebras.ai",
          modelId: "gpt-oss-120b",
          credential: "CEREBRAS_API_KEY",
          builtin: true
        },
        {
          id: "ollama",
          protocol: "openai-chat",
          baseUrl: "http://127.0.0.1:11434",
          path: "/v1/chat/completions",
          modelId: "llama3",
          credential: "OLLAMA"
        }
      ],
      seats: [
        { id: "explainer", recordId: "ollama", resolvable: true },
        { id: "front-door", recordId: null, resolvable: true }
      ],
      credentials: [
        { name: "CEREBRAS_API_KEY", present: false, origins: ["https://api.cerebras.ai"] },
        { name: "OLLAMA", present: true, origins: ["http://127.0.0.1:11434"] }
      ],
      tests: [
        { id: "ollama", testedAt: 1, result: { ok: true, latencyMs: 41, sample: "ok" } },
        {
          id: "cerebras",
          testedAt: 2,
          result: {
            ok: false,
            latencyMs: 0,
            failure: { code: "credential_missing", credential: "CEREBRAS_API_KEY" },
            fault: "user"
          }
        }
      ],
      testing: ["ollama"],
      refresh: { state: "requested" },
      enrollment: { available: true },
      credentialRequests: [],
      host: "observed",
      selected: "ollama",
      attention: { kind: "test-failed", recordId: "cerebras" },
      error: "The host did not list its models."
    }
  },
  "model-call": {
    minimal: {
      model: "ollama",
      request: { kind: "generation", system: "", prompt: "Reply with the single word: ok", maxTokens: 32 }
    },
    full: {
      model: "judge",
      request: {
        kind: "decision",
        state: [
          { key: "path", kind: "path", value: "src/a.ts" },
          { key: "diff", kind: "diff", value: "@@ -1 +1 @@\n-a\n+b" },
          { key: "passed", kind: "boolean", value: "true" }
        ],
        questions: {
          ok: { type: "boolean", instructions: "Did it pass?", criteria: { true: "it passed", false: "it failed" } },
          which: { type: "choice", instructions: "Which file?", criteria: { a: "src/a.ts", b: "src/b.ts" } },
          risk: { type: "score", instructions: "How risky?", criteria: ["low", "high"] }
        }
      },
      response: {
        askedAt: 7,
        request: {
          kind: "decision",
          state: [{ key: "text", kind: "text", value: "The sky is blue." }],
          questions: { ok: { type: "boolean", instructions: "Does it mention a color?" } }
        },
        result: {
          ok: true,
          latencyMs: 41,
          sample: "true 0.97",
          output: { kind: "decision", answers: { ok: { type: "boolean", value: true, probability: 0.97 } } }
        },
        binding: { protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" }
      },
      pending: {
        requestId: "6f0a2c1e-ask-0001",
        request: { kind: "generation", system: "", prompt: "A", maxTokens: 32, temperature: "0.2" },
        binding: {
          protocol: "openai-chat",
          baseUrl: "http://127.0.0.1:4010",
          modelId: "e2e-slow",
          credential: "LOOPBACK"
        },
        owner: null
      },
      asking: true,
      fixture: "Evaluator.layerScripted(() => ({ [\"ok\"]: { probability: 0.97 } }))"
    }
  },
  account: {
    minimal: { login: "will", scopes: [], allowlisted: false, accessRequested: false, boxes: [] },
    full: {
      login: "will",
      provider: "github",
      scopes: [{ scope: "repo", plain: "read and write your repositories" }],
      refresh: { id: "account-read", state: "failed", error: "Permissions could not be loaded." },
      allowlisted: true,
      accessRequested: true,
      boxes: [{ id: "ws-1", repoId: "smithersai/smithers", name: "review", status: "running" }]
    }
  },
  "repo-import": {
    minimal: { repo: "smithersai/smithers", jobId: null, phase: "starting", detail: null },
    full: {
      repo: "smithersai/smithers",
      jobId: "job-1",
      phase: "failed",
      detail: "provisioning the workspace",
      stage: "provisioning_workspace",
      counts: {
        refs: { done: 214, total: 214 },
        objects: { done: 90_000, total: 90_000 },
        issues: { done: 12, total: 40 }
      },
      error: "the import failed (500)",
      repository: { owner: "smithersai", name: "smithers" },
      workspaceId: "ws-1",
      rateLimit,
      requestId: "import-request-1",
      requestKind: "retry",
      retryMode: "restart",
      accountOwner: "smithersai",
      registration: true
    }
  },
  registration: {
    minimal: {
      link: "acme/widgets",
      repo: "acme/widgets",
      phase: "importing",
      startedAt: 0,
      error: null,
      cloudRepo: null,
      replay: 0,
      accountOwner: null
    },
    full: {
      link: "https://github.com/acme/widgets",
      repo: "acme/widgets",
      phase: "failed",
      startedAt: 1_790_000_000_000,
      error: "The import failed.",
      cloudRepo: "acme/widgets",
      replay: 2,
      accountOwner: "acme"
    }
  },
  "connector-setup": {
    minimal: { connector: "github", repo: "smithersai/smithers", phase: "setup", steps: [] },
    full: {
      connector: "github",
      repo: "smithersai/smithers",
      phase: "connected",
      steps: [{
        id: "authorize",
        label: "Authorize",
        state: "error",
        detail: "authorized as will",
        error: "authorization expired"
      }],
      installationId: 4212,
      configured: true,
      installUrl: "https://github.com/apps/smithers/installations/new",
      rateLimit,
      error: "the connector refused (500)"
    }
  },
  "sync-ops": {
    minimal: { subject: "Mirror · smithersai/smithers", source: "github-mirror", runState: null, ops: [] },
    full: {
      subject: "Mirror · smithersai/smithers",
      source: "github-mirror",
      integrationId: "7",
      repo: "smithersai/smithers",
      runId: "run-1",
      runState: "running",
      counts: { total: 40, done: 12, failed: 1 },
      mirrorStatus: "behind",
      behindRefs: 3,
      failedRefs: 1,
      trigger: "sync started",
      ops: [{
        id: "op-1",
        source: "github-mirror",
        target: "github",
        entity: "issue",
        entityId: "ENG-482",
        action: "upsert",
        status: "failed",
        error: "the wire refused (500)",
        retryable: true,
        at: "2026-09-05T09:00:00Z"
      }],
      opsNote: "the feed did not answer",
      window: "24h",
      expanded: true,
      hasOlder: true,
      opsCursor: "cursor-1",
      rateLimit,
      error: "the retry refused (500)"
    }
  },
  branches: {
    minimal: { repo: "smithersai/smithers", bookmarks: [] },
    full: { repo: "smithersai/smithers", bookmarks: [{ name: "main", head: "4e87ac15" }, { name: "wip", head: null }] }
  },
  "file-list": {
    minimal: { repo: "smithersai/smithers", path: "packages/rpc", entries: [] },
    full: {
      repo: "smithersai/smithers",
      localRepoId: "repo-1",
      path: "packages/rpc",
      entries: [{ name: "src", kind: "dir" }, { name: "PACKAGE.ts", kind: "file" }],
      truncated: true,
      address: "/smithersai/smithers/packages/rpc",
      readAt: { changeId: "qupxosqw", commitId: "a03f5f1e", source: "working-copy" }
    }
  },
  file: {
    minimal: { repo: "smithersai/smithers", path: "README.md", content: "# hi\n", truncated: false },
    full: {
      repo: "smithersai/smithers",
      localRepoId: "repo-1",
      path: "README.md",
      content: "# hi\n",
      truncated: true,
      binary: false,
      address: "/smithersai/smithers/README.md",
      readAt: { changeId: "qupxosqw", commitId: "a03f5f1e", seq: 5, source: "head" },
      ref: "a03f5f1ea03f5f1ea03f5f1ea03f5f1ea03f5f1e",
      line: 317,
      column: 62,
      digest: "sha256-9f1c",
      diagnostics: [{
        line: 317,
        character: 62,
        endLine: 317,
        endCharacter: 68,
        severity: "warning",
        message: "unused",
        source: "ts",
        code: "6133"
      }],
      diagnosticsTotal: 900,
      hover: { line: 63, character: 7, contents: "const isRecord", truncated: true },
      intel: { state: "ready", note: "typescript-language-server 4.3.3" }
    }
  },
  change: {
    minimal: {
      repo: "smithersai/smithers",
      changeId: "qupxosqw",
      description: "Serve repository files",
      commitId: null,
      currentSeq: null,
      revisionCount: null,
      revisions: [],
      authorName: null,
      timestamp: null,
      repos: [],
      diff: null,
      checks: null,
      findings: null,
      reviews: null,
      threads: null,
      conflicts: null,
      stack: null,
      changeset: null
    },
    full: {
      repo: "smithersai/smithers",
      changeId: "qupxosqw",
      description: "Serve repository files through one bounded route",
      commitId: "a03f5f1e",
      currentSeq: 5,
      revisionCount: 5,
      revisions: [{
        seq: 5,
        commitId: "a03f5f1e",
        parentCommitId: "9910aa2b",
        source: "agent",
        agentSessionId: "sess-1",
        workspaceSnapshotId: "snap-1",
        operationIds: ["op-1"],
        createdAt: "2026-09-05T09:00:00Z"
      }],
      authorName: "will",
      timestamp: "2026-09-05T09:00:00Z",
      repos: [{ repo: "smithersai/smithers", additions: 312, deletions: 41 }],
      diff: {
        from: "parent",
        to: "current",
        files: [{
          path: "src/a.ts",
          oldPath: "src/old.ts",
          changeType: "renamed",
          isBinary: false,
          additions: 3,
          deletions: 1,
          patch: "@@ -1 +1 @@",
          patchLines: 1,
          conflicted: true
        }],
        sinceReview: { reviewer: "will", seq: 4 }
      },
      checks: [{
        context: "typecheck",
        state: "success",
        targetsAffected: 12,
        targetsRan: 3,
        targetsCached: 9,
        durationMs: 4900,
        workspaceId: "ws-1"
      }],
      checksAt: 5,
      findings: [{
        id: 7,
        analyzer: "lint",
        source: "eslint",
        severity: "warn",
        path: "src/a.ts",
        line: 3,
        summary: "unused",
        suggestion: "delete it",
        raisedAtSeq: 3,
        commitId: "9910aa2b",
        state: "stale",
        feedback: "useful"
      }],
      analyzers: [{
        name: "lint",
        state: "failed",
        seq: 5,
        startedAt: "2026-09-05T09:00:00Z",
        finishedAt: "2026-09-05T09:01:00Z",
        pausedBy: null,
        pausedReason: null,
        failureReason: "exit 1"
      }],
      reviews: [{
        reviewer: "sess-2",
        reviewerLogin: "Reviewer · Astra",
        reviewerKind: "agent",
        verdict: "concerns",
        type: "request_changes",
        confidence: "high",
        summary: "the route is unbounded",
        commitId: "a03f5f1e",
        seq: 5,
        lastReviewedSeq: 4
      }],
      threads: [{
        id: 3,
        path: "src/a.ts",
        line: 12,
        currentLine: 14,
        body: "why bounded?",
        author: null,
        createdAt: "2026-09-05T09:00:00Z",
        state: "done",
        anchor: "moved",
        commitId: "a03f5f1e",
        resolvedInRevision: { commitId: "a03f5f1e", seq: 5 }
      }],
      reviewRequests: [{
        id: 9,
        reviewer: "will",
        agent: null,
        requestedBy: "ada",
        state: "requested",
        createdAt: "2026-09-05T09:00:00Z"
      }],
      conflicts: [{ path: "src/a.ts", state: "unresolved" }],
      stack: {
        landingNumber: 12,
        state: "open",
        position: 2,
        size: 3,
        changeIds: ["yyyrqlqw", "qupxosqw", "ronvznsk"],
        targetBookmark: "main",
        conflictStatus: "none",
        positionFrom: "server",
        landablePrefix: 1,
        blockedBy: [{
          kind: "owner",
          name: "will",
          repo: "smithersai/smithers",
          missing: "approval",
          count: 1,
          path: "src/a.ts",
          candidates: ["will", "ada"]
        }]
      },
      turn: {
        party: "author",
        actorId: "u-1",
        actorLogin: "will",
        since: "2026-09-05T09:00:00Z",
        reason: "changes requested"
      },
      owners: {
        touchedPaths: [{
          path: "src/a.ts",
          owners: ["will"],
          agentPolicy: "human-approve",
          satisfiedBy: { login: "will", seq: 5 }
        }],
        requiredApprovers: ["will"],
        suggestedReviewers: ["ada"],
        missingApprovals: [{ path: "src/b.ts", candidates: ["ada"] }]
      },
      landed: {
        at: "2026-09-05T09:02:00Z",
        by: "will",
        landingRequestNumber: 12,
        approvedBy: [{ login: "will", seq: 5 }]
      },
      walkthrough: {
        seq: 5,
        sections: [{ title: "The route", markdown: "one bounded read", diagram: null }],
        quiz: []
      },
      changeset: {
        id: 7,
        organization: "smithersai",
        superproject: "smithersai/super",
        changeId: "qupxosqw",
        state: "landed",
        failureReason: null,
        targetBookmark: "main",
        members: [{
          repository: "smithersai/api",
          path: "api",
          changeId: "qupxosqw",
          commitId: "a03f5f1e",
          targetBookmark: "main",
          previousCommitId: null,
          landedCommitId: "a03f5f1e"
        }]
      },
      unread: {
        diff: "Reading the diff failed (500)",
        conflicts: "Reading conflicts failed (500)",
        checks: "Reading statuses failed (500)",
        findings: "Reading findings failed (500)",
        reviews: "Reading reviews failed (500)",
        threads: "Reading threads failed (500)",
        reviewRequests: "Reading review requests failed (500)",
        stack: "upstream down",
        changeset: "Reading the changeset failed (500)",
        walkthrough: "Reading the walkthrough failed (500)"
      },
      facet: "diff",
      error: "Land refused (409)"
    }
  },
  diff: {
    minimal: {
      repo: "smithersai/smithers",
      changeId: "qupxosqw",
      from: "parent",
      to: "current",
      pin: { changeId: "qupxosqw", seq: null, commitId: null },
      files: []
    },
    full: {
      repo: "smithersai/smithers",
      changeId: "qupxosqw",
      from: "4",
      to: "5",
      pin: { changeId: "qupxosqw", seq: 5, commitId: "a03f5f1e" },
      files: [{
        path: "src/a.ts",
        oldPath: "src/old.ts",
        changeType: "renamed",
        isBinary: false,
        additions: 3,
        deletions: 1,
        patch: "@@ -1 +1 @@",
        patchLines: 1,
        conflicted: true
      }],
      path: "src/a.ts",
      error: "Reading the diff failed (500)"
    }
  },
  workspace: {
    minimal: {
      workspaceId: "ws-1",
      repo: "will/smithers",
      name: "review",
      targetBookmark: null,
      status: "pending",
      provisioningStage: null,
      bookmarkHead: null,
      sessions: []
    },
    full: {
      workspaceId: "ws-1",
      snapshot: true,
      repo: "will/smithers",
      name: "review",
      targetBookmark: "main",
      status: "failed",
      failureCode: "egress_proxy_unavailable",
      failureMessage: "the egress proxy is unavailable",
      provisioningStage: "provisioning_workspace",
      suspendedAt: "2026-09-05T08:00:00Z",
      bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" },
      workspaceKind: "desktop",
      agentSessionId: "sess-1",
      head: { changeId: "ronvznsk", commitId: "deadbee" },
      ahead: 2,
      behind: 1,
      startedAt: "2026-09-05T08:00:00Z",
      environment: {
        source: ".smithers/environment.nix",
        revision: "4e87ac15",
        closureHash: "sha256-9f1c",
        image: "registry.jjhub.tech/env:4e87ac15"
      },
      persistence: "persistent",
      sshHost: "ws-1@ssh.jjhub.tech",
      sessions: [{ id: "sess-1", status: "running", createdAt: null, kind: "lsp", language: "typescript" }],
      lspLanguages: ["typescript"],
      files: [{ name: "src", path: "src", type: "dir", size: null }],
      filesPath: "",
      services: [{ name: "web", state: "running", port: 8787, url: "http://localhost:8787" }],
      egress: [{
        occurredAt: "2026-09-05T09:00:00Z",
        host: "api.openai.com",
        method: "POST",
        path: "/v1/responses",
        status: 200,
        allowed: true,
        swappedSecretNames: ["OPENAI_API_KEY"]
      }],
      egressCursor: "cursor-1",
      desktop: { ready: true, streamUrl: "/vnc", session: { id: "vnc-1", expiresAt: "2026-09-05T09:05:00Z" } },
      desktopRefusal: { status: 503, message: "desktop not ready", code: "desktop_not_ready", retryAfterSeconds: 5 },
      desktopStage: "starting",
      desktopProgress: "Starting desktop",
      terminalRefusal: { status: 503, message: "guest not ready", code: "guest_not_ready", retryAfterSeconds: 3 },
      facet: "desktop",
      terminalSessionId: "pty-1",
      error: "Resume refused (409)",
      egressProxyUnavailable: true
    }
  },
  "environment-images": {
    minimal: { repo: "smithersai/smithers", images: [] },
    full: {
      repo: "smithersai/smithers",
      images: [{
        id: "img-1",
        kind: "vm",
        source: ".smithers/environment.nix",
        sourceRevision: "4e87ac15",
        closureHash: "sha256-9f1c",
        image: "registry.jjhub.tech/env:4e87ac15",
        status: "built",
        platformBase: false,
        coldPull: true
      }]
    }
  },
  "service-log": {
    minimal: { workspaceId: "ws-1", repo: "will/smithers", service: "web", lines: [], follow: false },
    full: { workspaceId: "ws-1", repo: "will/smithers", service: "web", lines: ["listening"], follow: true }
  },
  "theme-picker": {
    minimal: { selected: "ember" },
    full: { selected: "ember" }
  },
  targets: {
    minimal: { repoId: "repo-1", repoName: "smithers", status: "pending", targets: [], warnings: [] },
    full: {
      repoId: "repo-1",
      repoKey: "/work/smithers",
      repoName: "smithers",
      status: "done",
      targets: [{
        id: "t-1",
        label: "//packages/rpc:test",
        target: "test",
        kinds: ["test"],
        package: "//packages/rpc",
        name: "test",
        workspace: ".",
        summary: "the rpc suite",
        featured: true
      }],
      warnings: ["one declaration failed to load"],
      highlighted: "//packages/rpc:test",
      view: {
        mode: "all",
        query: "rpc",
        kinds: ["test"],
        states: ["passed"],
        workspace: ".",
        selected: "//packages/rpc:test",
        expanded: ["//...:test"],
        picked: { "//...:test": ["//packages/rpc:test"] }
      },
      runs: [{
        runId: "run-1",
        repoId: "repo-1",
        label: "//packages/rpc:test",
        labels: ["//packages/rpc:test"],
        status: "done",
        startedAt: 1_757_000_000_000,
        endedAt: 1_757_000_004_900,
        exitCode: 0,
        summary: {
          total: 1,
          hit: 0,
          ran: 1,
          failed: 0,
          skipped: 0,
          durationMs: 4900,
          ok: true,
          criticalPath: ["//packages/rpc:test"]
        },
        journal: { state: "degraded", error: "one frame was lost" }
      }],
      details: {
        "//packages/rpc:test": {
          status: "done",
          node: {
            label: "//packages/rpc:test",
            package: "//packages/rpc",
            name: "test",
            rule: "Vitest",
            kinds: ["test"],
            private: false,
            plan: { mode: "execute", cacheable: true, key: "9f1c", argv: ["vitest", "run"] },
            source: { file: "packages/rpc/PACKAGE.ts", line: 12 }
          },
          deps: ["//packages/rpc:build"],
          rdeps: ["//:ci"],
          error: "the plan refused"
        }
      },
      starred: ["//packages/rpc:test"]
    }
  },
  "target-run": {
    minimal: {
      runId: "run-1",
      repoId: "repo-1",
      label: "//packages/rpc:test",
      status: "running",
      exitCode: null,
      output: ""
    },
    full: {
      runId: "run-1",
      repoId: "repo-1",
      label: "//packages/rpc:test",
      verb: "ci",
      pattern: "//packages/...",
      status: "done",
      exitCode: 0,
      output: "1 passed",
      startedAt: 1_757_000_000_000,
      endedAt: 1_757_000_004_900,
      nodes: [{
        label: "//packages/rpc:test",
        status: "ran",
        startedAt: 1_757_000_000_000,
        endedAt: 1_757_000_004_900,
        durationMs: 4900,
        key: "9f1c",
        reason: "the host bin is absent",
        exitCode: 0,
        rule: "Vitest"
      }],
      summary: {
        total: 1,
        hit: 0,
        ran: 1,
        failed: 0,
        skipped: 0,
        durationMs: 4900,
        ok: true,
        criticalPath: ["//packages/rpc:test"]
      },
      nodeOutput: { "//packages/rpc:test": "1 passed" }
    }
  },
  repo: {
    minimal: {
      repo: {
        id: "repo-1",
        path: "/Users/will/smithers",
        name: "smithers",
        git: null,
        warnings: [],
        smithers: {
          detected: false,
          workspaceFile: null,
          declarationFiles: [],
          reason: "no .smithers/WORKSPACE.ts",
          workspaces: []
        }
      }
    },
    full: {
      repo: {
        id: "repo-1",
        path: "/Users/will/smithers",
        name: "smithers",
        git: { branch: "main", remote: "origin" },
        jj: { changeId: "qupxosqw", commitId: "a03f5f1e", ahead: 2, bookmark: "main" },
        warnings: ["one declaration failed to load"],
        smithers: {
          detected: true,
          workspaceFile: ".smithers/WORKSPACE.ts",
          declarationFiles: ["packages/rpc/PACKAGE.ts"],
          reason: "",
          workspaces: [{ path: ".", title: "smithers" }]
        }
      }
    }
  },
  graph: {
    minimal: { repoId: "repo-1", repoName: "smithers", status: "pending" },
    full: {
      repoId: "repo-1",
      repoName: "smithers",
      status: "done",
      graph: {
        repoId: "repo-1",
        nodes: [{
          label: "//packages/rpc:test",
          package: "//packages/rpc",
          name: "test",
          rule: "Vitest",
          kinds: ["test"],
          private: false,
          plan: {
            mode: "execute",
            cacheable: true,
            key: "9f1c",
            refusal: "the host bin is absent",
            argv: ["vitest", "run"],
            sandbox: "seatbelt",
            outDirs: ["dist"],
            outFiles: ["dist/index.js"],
            inputs: ["src/**"]
          },
          source: { file: "packages/rpc/PACKAGE.ts", line: 12 }
        }],
        edges: [{ from: "//packages/rpc:test", to: "//packages/rpc:build", kind: "deps" }],
        warnings: [],
        generatedAt: "2026-09-05T09:00:00Z",
        digest: "sha256-9f1c",
        durationMs: 1
      },
      error: "graph load failed: exit 1",
      focus: "//packages/rpc:test",
      view: { query: "rpc", showPrivate: true },
      runId: "run-1",
      run: {
        nodes: [{ label: "//packages/rpc:test", status: "ran", durationMs: 4900 }],
        summary: {
          total: 1,
          hit: 0,
          ran: 1,
          failed: 0,
          skipped: 0,
          durationMs: 4900,
          ok: true,
          criticalPath: ["//packages/rpc:test"]
        }
      }
    }
  },
  "run-timeline": {
    minimal: { repoId: "repo-1", runId: "run-1", label: "//packages/rpc:test", status: "pending", nodes: [] },
    full: {
      repoId: "repo-1",
      runId: "run-1",
      label: "//packages/rpc:test",
      status: "done",
      nodes: [{ label: "//packages/rpc:test", status: "ran", durationMs: 4900 }],
      summary: {
        total: 1,
        hit: 0,
        ran: 1,
        failed: 0,
        skipped: 0,
        durationMs: 4900,
        ok: true,
        criticalPath: ["//packages/rpc:test"]
      },
      cursor: 1_757_000_002_000,
      extent: { start: 1_757_000_000_000, end: 1_757_000_004_900 },
      logs: { "//packages/rpc:test": "1 passed" },
      error: "the stream failed"
    }
  },
  "run-history": {
    minimal: { repoId: "repo-1", status: "pending", runs: [] },
    full: {
      repoId: "repo-1",
      status: "done",
      runs: [{
        runId: "run-1",
        repoId: "repo-1",
        label: "//packages/rpc:test",
        labels: ["//packages/rpc:test"],
        status: "failed",
        startedAt: 1_757_000_000_000,
        endedAt: 1_757_000_004_900,
        exitCode: 1,
        summary: {
          total: 1,
          hit: 0,
          ran: 1,
          failed: 1,
          skipped: 0,
          durationMs: 4900,
          ok: false,
          criticalPath: ["//packages/rpc:test"]
        },
        journal: { state: "degraded", error: "one frame was lost" }
      }],
      selected: "run-1",
      error: "the history read failed"
    }
  },
  affected: {
    minimal: { repoId: "repo-1", status: "pending" },
    full: {
      repoId: "repo-1",
      status: "done",
      result: {
        repoId: "repo-1",
        base: "origin/main",
        changedFiles: ["packages/rpc/src/Cards.ts"],
        affected: [{ label: "//packages/rpc:test", reason: "packages/rpc/src/Cards.ts" }],
        signal: "declared inputs",
        limits: ["the CLI does not expose every input"],
        durationMs: 12
      },
      error: "not a git repo"
    }
  },
  "ci-matrix": {
    minimal: { repoId: "repo-1", status: "pending" },
    full: {
      repoId: "repo-1",
      status: "done",
      result: {
        repoId: "repo-1",
        workflows: [{
          name: "ci",
          path: ".github/workflows/ci.yml",
          yaml: "name: ci\n",
          source: "scratch-render",
          jobs: [{ name: "test", targets: ["//packages/rpc:test"], matrix: { shard: ["1/4", "2/4"] } }]
        }],
        warnings: ["one workflow could not be rendered"],
        durationMs: 12
      },
      error: "the render failed"
    }
  },
  agent: {
    minimal: {
      harnessId: "codex",
      displayName: "Codex",
      tabId: "pty-1",
      sessionId: "pty-1",
      cwd: "/tmp",
      phase: "running",
      exitCode: null
    },
    full: {
      statusRollup: statusRollup("session:pty-1", "exited", "idle"),
      harnessId: "codex",
      displayName: "Reviewer · GPT-6 Astra",
      roleId: "implement",
      purpose: "Reviews diffs.",
      task: "review the rpc change",
      tabId: "pty-1",
      sessionId: "pty-1",
      cwd: "/tmp",
      phase: "exited",
      exitCode: 0
    }
  },
  explain: {
    minimal: { question: "what is a change?", answer: "", phase: "asking", answeredBy: "" },
    full: {
      question: "what is a change?",
      answer: "A document with revisions.",
      phase: "failed",
      answeredBy: "kimi-for-coding/k3",
      error: "the explainer refused (503)"
    }
  },
  agents: {
    minimal: { native: false, agents: [] },
    full: {
      native: true,
      agents: [builtInCardRow],
      error: "the harness signals failed"
    }
  },
  "flow-form": {
    minimal: { flow: "tab.harness", via: "user", fields: [], draft: {}, given: {} },
    full: {
      flow: "tab.harness",
      via: "agent",
      fields: [{
        name: "harness",
        label: "Harness",
        kind: "select",
        required: true,
        placeholder: "codex",
        options: [{ value: "opencode", label: "OpenCode", disabled: true, reason: "no credential" }],
        optionsFrom: "cloud-repos"
      }],
      draft: { id: "implement", retries: 2, verbose: true },
      given: { id: "implement" },
      submitting: true,
      submitLabel: "Run flow",
      payloadField: "input",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      error: "the submit refused (500)",
      errorKind: "run"
    }
  },
  "search-results": {
    minimal: { query: "bounded", flow: "search.wiki", items: [] },
    full: {
      query: "bounded",
      flow: "search.wiki",
      args: "--kind wiki",
      items: [{
        kind: "wiki",
        ref: "wiki/bounded-reads.md",
        title: "Bounded reads",
        subtitle: "Librarian",
        actions: [{ flow: "wiki.open", args: "wiki/bounded-reads.md", label: "Open", role: "open" }]
      }]
    }
  },
  "wiki-links": {
    minimal: { path: "wiki/bounded-reads.md", title: "Bounded reads", backlinks: [], linksOut: [], unresolved: [] },
    full: {
      path: "wiki/bounded-reads.md",
      title: "Bounded reads",
      backlinks: [{ path: "wiki/routes.md", title: "Routes" }],
      linksOut: [{ path: "wiki/caps.md", title: "Caps" }],
      unresolved: ["quarantine"]
    }
  },
  "wiki-graph": {
    minimal: { path: null, notes: [], links: [] },
    full: {
      path: "wiki/bounded-reads.md",
      notes: [{
        path: "wiki/bounded-reads.md",
        title: "Bounded reads",
        linksOut: ["wiki/caps.md"],
        backlinks: ["wiki/routes.md"],
        missing: false
      }],
      links: [{ source: "wiki/bounded-reads.md", target: "wiki/caps.md" }]
    }
  },
  /* A wiki page's history (#1922): every field is required but a revision's attachment; the full one carries a rename and the deletion. */
  "wiki-history": {
    minimal: {
      repo: "smithersai/smithers",
      space: "public",
      pageId: 1,
      title: "Home",
      path: "Home.md",
      revisions: [],
      page: 1,
      hasNext: false
    },
    full: {
      repo: "smithersai/smithers",
      space: "private",
      pageId: 3,
      title: "logo.png",
      path: "assets/logo.png",
      revisions: [
        {
          revision: 3,
          title: "logo.png",
          path: "assets/logo.png",
          author: "will",
          at: "2026-09-26T03:00:00Z",
          deleted: true,
          digest: "c".repeat(64)
        },
        {
          revision: 2,
          title: "logo.png",
          path: "assets/logo.png",
          author: "ada",
          at: "2026-09-26T02:00:00Z",
          deleted: false,
          digest: "b".repeat(64),
          attachment: { digest: "b".repeat(64), mediaType: "image/png", size: 68 }
        },
        {
          revision: 1,
          title: "logo.png",
          path: "Old/logo.png",
          author: "will",
          at: "2026-09-26T01:00:00Z",
          deleted: false,
          digest: "a".repeat(64),
          attachment: { digest: "a".repeat(64), mediaType: "image/png", size: 68 }
        }
      ],
      page: 1,
      hasNext: true
    }
  },
  "anonymous-ceiling": {
    minimal: { message: "too many turns from this address", retryAt: null },
    full: { message: "too many turns from this address", retryAt: "2026-09-05T10:00:00Z" }
  },
  "commit-list": {
    minimal: { repo: "smithersai/smithers", branch: null, commits: [] },
    full: {
      repo: "smithersai/smithers",
      branch: "main",
      commits: [{
        commitId: "a1b2c3d4",
        changeId: "kkmpptxz",
        title: "Serve repository files",
        author: {
          name: "Will",
          email: "will@example.com",
          login: "will",
          avatarUrl: "https://avatars.githubusercontent.com/u/2"
        },
        authoredAt: "2026-09-05T09:00:00Z",
        status: "success",
        verified: true
      }],
      truncated: true,
      error: "the history read stopped at its cap"
    }
  },
  commit: {
    minimal: {
      repo: "smithersai/smithers",
      commit: {
        commitId: "a1b2c3d4",
        changeId: null,
        title: "Serve repository files",
        author: { name: null, email: null },
        authoredAt: null
      },
      message: "Serve repository files",
      parents: [],
      files: []
    },
    full: {
      repo: "smithersai/smithers",
      commit: {
        commitId: "a1b2c3d4",
        changeId: "kkmpptxz",
        title: "Serve repository files",
        author: { name: "Will", email: "will@example.com" },
        authoredAt: "2026-09-05T09:00:00Z"
      },
      message: "Serve repository files\n\nOne bounded route.",
      committer: { name: "Will", email: "will@example.com" },
      parents: [{ changeId: "zzzzzzzz", commitId: "0000aaaa" }],
      files: [{
        path: "src/files.ts",
        oldPath: "src/read.ts",
        changeType: "renamed",
        isBinary: false,
        additions: 12,
        deletions: 3,
        patch: "@@ -1 +1 @@"
      }],
      diffError: "the diff exceeded its cap",
      error: "the status read failed"
    }
  },
  /* The tutorial's repository chooser: every field is required, so both fixtures name all six. */
  "repository-choice": {
    minimal: {
      cutoff: "2026-08-10T00:00:00Z",
      partial: false,
      error: null,
      selected: null,
      created: null,
      repositories: []
    },
    full: {
      cutoff: "2026-08-10T00:00:00Z",
      partial: true,
      error: "GitHub answered 403 for one repository",
      selected: "smithersai/smithers",
      created: { fullName: "owner/smithers-playground" },
      repositories: [{
        fullName: "smithersai/smithers",
        count: 12,
        latest: "2026-09-05T09:00:00Z",
        coverage: "default-branch",
        error: null
      }]
    }
  },
  /*
   * Repository setup: the editable candidate plus the host's evidence about it.
   * `previousReceipts` carries a default, so a card written before that field
   * decodes with an empty history rather than with the field absent, and the
   * minimal fixture states what that card reads back as.
   */
  "repository-setup": {
    minimal: {
      repo: "smithersai/smithers",
      job: "issues",
      revision: 1,
      owner: null,
      draft: setupDraft,
      view: "flows",
      selectedStep: "research",
      sources: [],
      previousReceipts: []
    },
    full: {
      repo: "smithersai/smithers",
      job: "issues",
      revision: 2,
      owner: "will",
      workspaceId: "9f1d4d7e-6d1f-4a2b-8d0e-2f3a4b5c6d7e",
      draft: setupDraft,
      view: "work",
      selectedStep: "research",
      manualDraft: { stepId: "research", prompt: "Look at the flake", source: "github", number: 12 },
      guidance: { id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", state: "admitted", error: "the model refused" },
      sources: [{ path: "CONTRIBUTING.md", status: "read", summary: "states the review rules", revision: "abc1234" }],
      inspectedAt: 1_757_000_000_000,
      request: {
        id: "request-1",
        operation: "run",
        revision: 2,
        digest: setupDigest,
        state: "running",
        error: "the host refused the request",
        manual: {
          stepId: "research",
          prompt: "Look at the flake",
          subject: { source: "github", kind: "issue", number: 12 }
        },
        observeOnly: false
      },
      evaluation: setupReceipt("evaluate-1", "evaluate", "completed"),
      trial: setupReceipt("trial-1", "trial", "completed"),
      receipt: setupReceipt("apply-1", "apply", "running"),
      previousReceipts: [setupReceipt("inspect-1", "inspect", "completed")],
      active: {
        revision: 1,
        digest: setupDigest,
        registrationId: "registration-1",
        sourceRevision: "abc1234",
        enabled: true,
        owned: true,
        draft: setupDraft,
        schedule: { expression: "0 9 * * 1", nextFireAt: "2026-09-21T09:00:00+00:00" }
      },
      recovery: {
        id: "recovery-1",
        baseRevision: 1,
        baseDigest: setupDigest,
        adoptDraft: true,
        state: "completed",
        registrationState: "known",
        error: "the registry did not answer",
        trialRegistration: {
          registrationId: "registration-1",
          workspaceId: "9f1d4d7e-6d1f-4a2b-8d0e-2f3a4b5c6d7e",
          revision: 1,
          digest: setupDigest,
          sourceRevision: "abc1234",
          enabled: false,
          owned: true,
          draft: setupDraft,
          schedule: { expression: "0 9 * * 1", nextFireAt: "2026-09-21T09:00:00+00:00" }
        }
      }
    }
  },
  retired: { minimal: {}, full: {} },
  "plugin-library": {
    minimal: { tutorial: false },
    full: { tutorial: true }
  }
}

test("repository home schema decodes every resolution and refuses unsafe paths", () => {
  expect(RepositoryHomeSchema.safeParse({ kind: "none" }).success).toBe(true)
  expect(RepositoryHomeSchema.safeParse({ kind: "readme", markdown: "# Hello" }).success).toBe(true)
  expect(RepositoryHomeSchema.safeParse(FIXTURES["factory.home"].full.home).success).toBe(true)
  for (
    const path of ["/etc/passwd", "../README.md", "a/../README.md", "https://example.com", "a\\b", "%2e%2e/secret"]
  ) {
    expect(
      RepositoryHomeSchema.safeParse({ kind: "blocks", blocks: [{ type: "markdown", path, markdown: "x" }] }).success
    ).toBe(false)
  }
  expect(
    RepositoryHomeSchema.safeParse({ kind: "blocks", blocks: [{ type: "ci-benchmark", measures: ["cold"] }] }).success
  ).toBe(false)
})

const kinds = CardSchema.options.map((option) => option.shape.kind.value)
const card = (kind: string, payload: unknown): unknown => ({ ...base, kind, payload })

/** The fields a kind's payload declares, or null when the payload is a union of stages rather than one object. */
const payloadFields = (kind: string): Record<string, z.ZodType> | null => {
  const payload = CardSchema.options.find((option) => option.shape.kind.value === kind)?.shape.payload
  return payload instanceof z.ZodObject ? payload.shape as Record<string, z.ZodType> : null
}

/**
 * True when the schema accepts the field's absence and leaves it absent: the
 * "optional so older cards parse" promise. A field carrying a default also
 * accepts absence, but fills itself in, so the payload read back off disk
 * states it. It belongs in the minimal fixture, where the assertions below can
 * see exactly what a card written before that field now decodes to.
 */
const optional = (schema: z.ZodType): boolean => {
  const absent = schema.safeParse(undefined)
  return absent.success && absent.data === undefined
}

/** Union payloads have branch-specific compatibility checks below. */
const objectKinds = kinds.filter((kind) => payloadFields(kind) !== null)

describe("every persisted card kind", () => {
  test("has fixtures: a kind added to the union without them is the gap this table closes", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...kinds].sort())
  })

  test("agents: the local roster and a repository's cloud sessions parse, and neither takes the other's fields", () => {
    const cloud = {
      cloud: true,
      repo: "smithersai/smithers",
      sessions: [{
        id: "s-1",
        title: "Fix CI",
        status: "running",
        messageCount: 3,
        createdAt: null,
        workspaceId: "ws-1"
      }]
    }
    const read = CardSchema.parse(card("agents", cloud))
    expect(read.payload).toEqual(cloud)
    expect(CardSchema.safeParse(card("agents", { ...cloud, cloud: false })).success).toBe(false)
    expect(CardSchema.safeParse(card("agents", { cloud: true, repo: "smithersai/smithers" })).success).toBe(false)
    expect(CardSchema.safeParse(card("agents", { native: true })).success).toBe(false)
  })

  test("every union payload has an explicit branch audit below", () => {
    expect(kinds.filter((kind) => payloadFields(kind) === null)).toEqual(["agent", "agents"])
  })

  test.each(objectKinds)("%s: the fixtures name every field the payload declares, and no more", (kind) => {
    const fields = payloadFields(kind)!
    const { full, minimal } = FIXTURES[kind]
    /*
     * The full fixture is the whole contract, so adding a field to a payload
     * fails here until a fixture states it; the minimal fixture is exactly
     * the required set, so promoting an optional field to required fails
     * here too — which is the compatibility promise those fields carry.
     */
    expect(Object.keys(full).sort()).toEqual(Object.keys(fields).sort())
    expect(Object.keys(minimal).sort()).toEqual(
      Object.keys(fields).filter((field) => !optional(fields[field]!)).sort()
    )
  })

  test.each(kinds)("%s parses at its minimum and at its maximum, and neither is rewritten", (kind) => {
    const { decodedFull, full, minimal } = FIXTURES[kind]

    const lean = CardSchema.parse(card(kind, minimal))
    expect(lean.kind).toBe(kind)
    expect(lean.payload).toEqual(minimal)
    /*
     * Nothing is defaulted into a payload written before a later lane: an
     * unstated field stays absent, so the body renders nothing rather than a
     * guess, and re-persisting the card cannot invent history.
     */
    expect(Object.keys(lean.payload).sort()).toEqual(Object.keys(minimal).sort())

    const rich = CardSchema.parse(card(kind, full))
    expect(rich.payload).toEqual(decodedFull ?? full)

    /* Decoding is idempotent: a card read back off disk decodes to itself. */
    expect(CardSchema.parse(lean)).toEqual(lean)
    expect(CardSchema.parse(rich)).toEqual(rich)
  })

  test("a whole frame snapshot of one card per kind parses (apps/app FrameSnapshotSchema)", () => {
    const snapshot = z.object({ cards: z.array(CardSchema) })
    const cards = kinds.map((kind, ordinal) => ({ ...base, kind, ordinal, payload: FIXTURES[kind].full }))
    expect(snapshot.parse({ cards }).cards).toHaveLength(kinds.length)
  })

  test("an unknown kind is refused, so a card from a newer build is quarantined rather than half-read", () => {
    expect(CardSchema.safeParse({ ...base, kind: "moons", payload: {} }).success).toBe(false)
  })

  test("PR read failures and repository import launch identity refuse invalid persisted values", () => {
    expect(CardSchema.safeParse(card("pr", { ...FIXTURES.pr.full, readErrors: { commits: 500 } })).success).toBe(false)
    expect(CardSchema.safeParse(card("repo-import", { ...FIXTURES["repo-import"].full, requestId: 1 })).success).toBe(
      false
    )
    expect(
      CardSchema.safeParse(card("repo-import", { ...FIXTURES["repo-import"].full, requestKind: "resume" })).success
    ).toBe(false)
    expect(CardSchema.safeParse(card("repo-import", { ...FIXTURES["repo-import"].full, accountOwner: 1 })).success)
      .toBe(false)
  })
})

describe("every card patch", () => {
  test.each(kinds)("%s takes an empty patch and its own full payload", (kind) => {
    expect(CardPatchSchema.parse({ kind })).toEqual({ kind })
    expect(CardPatchSchema.safeParse({ kind, payload: FIXTURES[kind].full }).success).toBe(true)
  })

  test.each(kinds)("%s refuses a negative ordinal, a foreign payload field, and a patch with no kind", (kind) => {
    expect(CardPatchSchema.safeParse({ kind, ordinal: -1 }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ kind, ordinal: 1.5 }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ kind, status: "melting" }).success).toBe(false)
    expect(CardPatchSchema.safeParse({ payload: FIXTURES[kind].full }).success).toBe(false)
  })

  test("an unknown kind is refused", () => {
    expect(CardPatchSchema.safeParse({ kind: "moons" }).success).toBe(false)
  })
})

/*
 * The targets table's own state and the rate-limit line: read off a card
 * payload, so they carry the same persistence promise as the cards do.
 */
describe("the targets table's view and detail", () => {
  test("an empty view is the default view: every field is optional and none is defaulted in", () => {
    expect(TargetsViewSchema.parse({})).toEqual({})
  })

  test("a full view round-trips, and a mode or run state outside the enums is refused", () => {
    const view = FIXTURES.targets.full.view
    expect(TargetsViewSchema.parse(view)).toEqual(view)
    expect(TargetsViewSchema.safeParse({ mode: "starred" }).success).toBe(false)
    expect(TargetsViewSchema.safeParse({ states: ["flaky"] }).success).toBe(false)
    expect(TargetsViewSchema.safeParse({ picked: { "//...:test": "one" } }).success).toBe(false)
  })

  test("a detail states its status alone until the plan is read, and refuses a status outside the three", () => {
    expect(TargetDetailSchema.parse({ status: "pending" })).toEqual({ status: "pending" })
    expect(TargetDetailSchema.safeParse({ status: "running" }).success).toBe(false)
    expect(TargetDetailSchema.safeParse({}).success).toBe(false)
  })
})

describe("a GitHub call's rate limit", () => {
  test("carries the three wire facts, with a null reset when the wire names none", () => {
    expect(GitHubRateLimitSchema.parse(rateLimit)).toEqual(rateLimit)
    expect(GitHubRateLimitSchema.parse({ limit: 0, remaining: 0, resetAt: null }).resetAt).toBeNull()
  })

  test("refuses a negative or fractional count and an absent reset — an unread reset is null, never missing", () => {
    expect(GitHubRateLimitSchema.safeParse({ limit: -1, remaining: 0, resetAt: null }).success).toBe(false)
    expect(GitHubRateLimitSchema.safeParse({ limit: 5000, remaining: 1.5, resetAt: null }).success).toBe(false)
    expect(GitHubRateLimitSchema.safeParse({ limit: 5000, remaining: 42 }).success).toBe(false)
  })
})

/** Cloud observations retain routing, unknown provider, and transcript identity through persistence. */
const cloudAgentFixtures: KindFixtures = {
  minimal: {
    cloud: true,
    displayName: "Agent session",
    sessionId: "session-1",
    repo: "org/repo",
    provider: null,
    workspaceId: null,
    state: "active",
    transcript: []
  },
  full: {
    cloud: true,
    statusRollup: statusRollup("session:session-1", "completed", "idle"),
    displayName: "Review the change",
    sessionId: "session-1",
    repo: "org/repo",
    provider: "codex",
    workspaceId: "workspace-1",
    state: "completed",
    task: "Review the change",
    transcript: [{
      id: 7,
      role: "assistant",
      sequence: 2,
      createdAt: "2026-09-15T00:00:00Z",
      parts: [{ type: "text", text: "The change is ready." }]
    }],
    error: "The status refresh failed"
  }
}

describe("the persisted local and cloud agent variants", () => {
  const schema = CardSchema.options.find((option) => option.shape.kind.value === "agent")!.shape.payload
  const variants = [{ name: "local", fixture: FIXTURES.agent }, { name: "cloud", fixture: cloudAgentFixtures }]

  test("each union arm has one fixture, including every declared optional field", () => {
    expect(schema).toBeInstanceOf(z.ZodUnion)
    if (!(schema instanceof z.ZodUnion)) throw new Error("Agent variants must be explicit")
    expect(schema.options).toHaveLength(variants.length)
    for (const branch of schema.options) {
      expect(branch).toBeInstanceOf(z.ZodObject)
      if (!(branch instanceof z.ZodObject)) throw new Error("Agent variant must be an object")
      const matches = variants.filter(({ fixture }) => branch.safeParse(fixture.minimal).success)
      expect(matches).toHaveLength(1)
      const { minimal, full } = matches[0]!.fixture
      const fields = branch.shape as Record<string, z.ZodType>
      expect(Object.keys(full).sort()).toEqual(Object.keys(fields).sort())
      expect(Object.keys(minimal).sort()).toEqual(
        Object.keys(fields).filter((field) => !optional(fields[field]!)).sort()
      )
    }
  })

  test.each(variants)("$name rows survive card, patch and snapshot decoding without invented fields", ({ fixture }) => {
    for (const payload of [fixture.minimal, fixture.full]) {
      const encoded = JSON.parse(JSON.stringify(card("agent", payload)))
      const parsed = CardSchema.parse(encoded)
      expect(parsed.payload).toEqual(payload)
      expect(CardSchema.parse(parsed)).toEqual(parsed)
      expect(CardPatchSchema.parse({ kind: "agent", payload })).toEqual({ kind: "agent", payload })
      expect(z.object({ cards: z.array(CardSchema) }).parse({ cards: [encoded] }).cards).toEqual([parsed])
    }
  })

  test("cloud observations require their discriminator, routing, and transcript identity", () => {
    for (const field of ["cloud", "repo", "sessionId", "transcript"]) {
      const payload = { ...cloudAgentFixtures.minimal }
      delete payload[field]
      expect(CardSchema.safeParse(card("agent", payload)).success).toBe(false)
    }
    expect(CardSchema.safeParse(card("agent", { ...cloudAgentFixtures.minimal, provider: "guessed" })).success).toBe(
      false
    )
    expect(CardSchema.safeParse(card("agent", { ...cloudAgentFixtures.minimal, transcript: [{ id: "7" }] })).success)
      .toBe(false)
  })
})

describe("removed presentation compatibility", () => {
  const saved = (kind: string, payload: unknown) => ({ ...base, kind, payload, body: "Old content", loading: true })
  const retired = [
    ...["factory", "repo-onboarding", "repo-home", "agent-models", "agent-form"].map((kind) =>
      saved(kind, { draft: "old data" })
    ),
    saved("history", {
      repo: "smithersai/smithers",
      defaultBookmark: "main",
      mainCommits: null,
      mythical: { state: "absent" }
    }),
    saved("connector-setup", { connector: "linear" }),
    saved("sync-ops", { source: "linear" }),
    ...[
      "repo.welcome",
      "repo.explore",
      "repo.contribute",
      "repo.maintain",
      "repo.home",
      "factory.show",
      /* The 19 workspace.* commands renamed to box.* (#2147). */
      "workspace.delete",
      "workspace.desktop",
      "workspace.desktop.open",
      "workspace.desktop.rotate",
      "workspace.desktop.stop",
      "workspace.egress",
      "workspace.facet",
      "workspace.file",
      "workspace.files",
      "workspace.images",
      "workspace.list",
      "workspace.open",
      "workspace.resume",
      "workspace.services",
      "workspace.session.destroy",
      "workspace.sessions",
      "workspace.suspend",
      "workspace.terminal",
      "workspace.view",
      "workspace.fork",
      "workspace.snapshot",
      "workspace.snapshot.delete",
      "workspace.snapshot.fork",
      "workspace.template",
      "change.open-computer",
      "agent.create",
      "agent.edit",
      "agent.models",
      "agent.new",
      "agent.remove",
      "issues.link-linear",
      "issues.unlink-linear",
      "sync.retry",
      "sync.ops.load-older",
      "linear.setup",
      "stack.show",
      "stack.backfill",
      "stack.parallel",
      "stack.retry",
      "history.amend",
      "history.fold"
    ].map((flow) => saved("flow-form", { flow, via: "user", submitting: true, draft: { secret: "obsolete" } }))
  ]
  test.each(retired)("retires $kind without losing the card identity", (row) => {
    const result = CardSchema.parse(JSON.parse(JSON.stringify(row)))
    expect(result).toEqual({ ...base, kind: "retired", title: "", status: "acted", payload: {}, loading: false })
    expect(CardSchema.parse(result)).toEqual(result)
    expect(z.object({ cards: z.array(CardSchema) }).parse({ cards: [row] }).cards).toEqual([result])
    if (row.kind !== "flow-form") {
      expect(CardPatchSchema.safeParse({ kind: row.kind, payload: row.payload }).success).toBe(false)
    }
  })
  test("the old snapshot facet becomes a terminal while internal snapshot provenance survives", () => {
    const old = saved("workspace", {
      ...FIXTURES.workspace.minimal,
      facet: "snapshots",
      snapshot: true,
      snapshots: [{ id: "old", name: "Old", createdAt: null }]
    })
    const result = CardSchema.parse(old)
    expect(result.kind).toBe("workspace")
    expect(result.payload).toMatchObject({ facet: "terminal", snapshot: true, workspaceId: "ws-1" })
    expect(result.payload).not.toHaveProperty("snapshots")
  })
})

test("a stored trigger card from the retired trigger store still decodes, without the fields nothing writes", () => {
  const row = {
    id: "trg-1",
    slug: "nightly",
    flowId: "ci",
    cron: "0 * * * *",
    enabled: true,
    nextFireAt: 1_757_003_600_000
  }
  const stored = {
    repo: "smithersai/smithers",
    live: true,
    triggers: [{
      ...row,
      lastFiredAt: 1_757_000_000_000,
      activeRunId: "run-1",
      nextFiresAt: [1_757_003_600_000],
      overlap: "skip",
      catchUp: "one",
      maxCatchUp: 3,
      pendingAt: 1_757_003_600_000,
      schedulerLastTickAt: 1_757_000_500_000,
      fires: [{ occurrenceAt: 1_757_000_000_000, outcome: "launched", runId: "run-1" }]
    }],
    webhooks: [{ name: "github", flowId: "ci" }]
  }
  const decoded = CardSchema.parse(card("trigger-list", stored)) as { payload: unknown }
  expect(decoded.payload).toEqual({ repo: "smithersai/smithers", live: true, triggers: [row] })
})

test("a saved local repository receipt drops its retired path", () => {
  const parsed = CardSchema.parse(card("repository-choice", {
    cutoff: "2026-08-10T00:00:00Z",
    partial: false,
    error: null,
    selected: "smithers-playground",
    created: { name: "smithers-playground", path: "/tmp/smithers-playground" },
    repositories: []
  }))
  if (parsed.kind !== "repository-choice") throw new Error("expected repository choice")
  expect(parsed.payload.created).toEqual({ fullName: "smithers-playground" })
})
