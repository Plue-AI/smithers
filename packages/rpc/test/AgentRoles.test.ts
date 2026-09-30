import { describe, expect, test } from "vitest"
import {
  AGENT_ROLE_IDS,
  AGENT_ROLES,
  agentRole,
  AgentRoleIdSchema,
  AgentRoleSchema,
  agentRoleTitle,
  CLOUD_AGENT_ROLE_IDS,
  CLOUD_AGENT_ROLES,
  cloudRole,
  cloudRoleModelId,
  CloudRoleSchema,
  findAgentRole,
  isCloudRoleId,
  knownModelLabel
} from "../src/AgentRoles.ts"
import type { AgentRole } from "../src/AgentRoles.ts"
import { HARNESS_IDS } from "../src/LocalApp.ts"

const custom = {
  id: "reviewer",
  label: "Reviewer",
  purpose: "Reviews diffs for correctness and tests.",
  model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  harness: "codex",
  delegates: false,
  builtin: false,
  createdAt: 10,
  updatedAt: 10
} satisfies AgentRole

describe("the agent role registry", () => {
  test.each([
    { id: "not-a-role", message: "Unknown agent role not-a-role" },
    { id: "", message: "Unknown agent role " },
    { id: "librarian", message: "Unknown agent role librarian" }
  ])("the public JavaScript agentRole call rejects '$id' without changing its registry", ({ id, message }) => {
    const before = structuredClone(AGENT_ROLES)
    expect(() => Reflect.apply(agentRole, undefined, [id])).toThrowError(new Error(message))
    expect(AGENT_ROLES).toEqual(before)
  })

  test("seeds every built-in once, bound to a real harness and the verified model id, and stores no argv", () => {
    expect(AGENT_ROLES.map((role) => role.id)).toEqual([...AGENT_ROLE_IDS])
    for (const role of AGENT_ROLES) {
      expect(HARNESS_IDS).toContain(role.harness)
      expect(role.purpose.length).toBeGreaterThan(10)
      expect(role.builtin).toBe(true)
      expect(AgentRoleSchema.safeParse(role).success).toBe(true)
      expect("launch" in role).toBe(false)
    }
    expect(agentRole("orchestrator")).toMatchObject({
      model: { id: "claude-fable-5" },
      harness: "claude",
      delegates: true
    })
    expect(agentRole("explainer")).toMatchObject({
      model: { id: "kimi-for-coding/k3", provider: "kimi-for-coding" },
      harness: "opencode-kimi"
    })
    expect(agentRole("implementation")).toMatchObject({ model: { id: "gpt-6.1-sol" }, harness: "codex" })
    expect(agentRole("trivial-implementation")).toMatchObject({ model: { id: "gpt-6-luna" }, harness: "codex" })
    expect(agentRole("ui")).toMatchObject({ harness: "opencode-kimi", model: { id: "kimi-for-coding/k3" } })
    expect(agentRole("fast-ui")).toMatchObject({ harness: "opencode-cerebras", model: { id: "cerebras/qwen-3.8-27b" } })
    expect(AGENT_ROLES.filter((role) => role.delegates).map((role) => role.id)).toEqual(["orchestrator"])
  })

  test("titles pair the role with its model; a well-formed id is recognised whether or not a row exists", () => {
    expect(agentRoleTitle(agentRole("explainer"))).toBe("Explainer · Kimi K3")
    expect(AgentRoleIdSchema.safeParse("fast-ui").success).toBe(true)
    expect(AgentRoleIdSchema.safeParse("reviewer").success).toBe(true)
    expect(AgentRoleIdSchema.safeParse("claude").success).toBe(true)
    expect(AGENT_ROLE_IDS).toContain("fast-ui")
    expect(AGENT_ROLE_IDS).not.toContain("reviewer")
    expect(findAgentRole("reviewer")).toBeUndefined()
    expect(findAgentRole("reviewer", [...AGENT_ROLES, custom])?.label).toBe("Reviewer")
  })
})

describe("known model names", () => {
  test("a model id a built-in or cloud role runs on has its display name; any other id has none", () => {
    expect(knownModelLabel("gpt-6.1-sol")).toBe("GPT-6.1 Sol")
    expect(knownModelLabel("claude-fable-5")).toBe("Fable 5")
    expect(knownModelLabel("qwen-3.8-27b")).toBe("Cerebras Qwen 3.8 27B")
    expect(knownModelLabel("gpt-6-sol")).toBeUndefined()
    expect(knownModelLabel("sol")).toBeUndefined()
    expect(knownModelLabel("")).toBeUndefined()
  })
})

describe("the cloud roles", () => {
  test.each([
    { id: "not-a-role", message: "Unknown cloud role not-a-role" },
    { id: "", message: "Unknown cloud role " },
    { id: "explainer", message: "Unknown cloud role explainer" }
  ])("the public JavaScript cloudRole call rejects '$id' without changing its registry", ({ id, message }) => {
    const before = structuredClone(CLOUD_AGENT_ROLES)
    expect(() => Reflect.apply(cloudRole, undefined, [id])).toThrowError(new Error(message))
    expect(CLOUD_AGENT_ROLES).toEqual(before)
  })

  test("librarian and flows are served on Cerebras, carry no harness, and never join the agents store's built-ins", () => {
    expect(CLOUD_AGENT_ROLES.map((role) => role.id)).toEqual([...CLOUD_AGENT_ROLE_IDS])
    for (const role of CLOUD_AGENT_ROLES) {
      expect(CloudRoleSchema.safeParse(role).success).toBe(true)
      expect(role.seat).toBe("cloud")
      expect(role.model.provider).toBe("cerebras")
      expect(role.purpose.length).toBeGreaterThan(10)
      expect("harness" in role).toBe(false)
      expect(AGENT_ROLE_IDS as ReadonlyArray<string>).not.toContain(role.id)
      expect(AgentRoleSchema.safeParse(role).success).toBe(false)
    }
    expect(cloudRole("librarian")).toMatchObject({
      model: { id: "qwen-3.8-27b" },
      modelEnv: "CEREBRAS_MODEL_LIBRARIAN"
    })
    expect(cloudRole("flows")).toMatchObject({ model: { id: "qwen-3.8-27b" }, modelEnv: "CEREBRAS_MODEL_FLOWS" })
    expect(isCloudRoleId("librarian")).toBe(true)
    expect(isCloudRoleId("explainer")).toBe(false)
    expect(isCloudRoleId("")).toBe(false)
  })

  test("the served model is the env override when it is a model id, else the table default", () => {
    const librarian = cloudRole("librarian")
    expect(cloudRoleModelId(librarian, {})).toBe("qwen-3.8-27b")
    expect(cloudRoleModelId(librarian, { CEREBRAS_MODEL_LIBRARIAN: " gpt-oss-120b " })).toBe("gpt-oss-120b")
    expect(cloudRoleModelId(librarian, { CEREBRAS_MODEL_FLOWS: "gpt-oss-120b" })).toBe("qwen-3.8-27b")
    expect(cloudRoleModelId(librarian, { CEREBRAS_MODEL_LIBRARIAN: "" })).toBe("qwen-3.8-27b")
    // A flag-shaped override is ignored, never launched.
    expect(cloudRoleModelId(librarian, { CEREBRAS_MODEL_LIBRARIAN: "--model evil" })).toBe("qwen-3.8-27b")
  })
})
