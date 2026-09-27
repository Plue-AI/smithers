import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import type { Card } from "../state/AppState"
import { agentCardFamily, AgentsCardBody } from "./AgentCards"

/*
 * Agents as data (custom-agents.md): the Agents card's rows and acts, and
 * the models card. Every act is asserted as the flow it names. The New-agent
 * form is the generic flow form (FlowFormCards.test.tsx; CustomAgents.test.ts
 * renders it from the live harness seam).
 */

GlobalRegistrator.register()
const roots: Root[] = []

afterAll(async () => {
  for (const root of roots) flushSync(() => root.unmount())
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type AgentsCard = Extract<Card, { kind: "agents" }>

const base = { title: "Agents", status: "active" as const, createdAt: 0, ordinal: 0 }

const agentsCard = (payload: AgentsCard["payload"]): AgentsCard => ({ ...base, id: "agents", kind: "agents", payload })

const orchestrator: Extract<AgentsCard["payload"], { native: boolean }>["agents"][number] = {
  id: "orchestrator",
  label: "Orchestrator",
  purpose: "Plans and delegates.",
  harness: "claude",
  harnessName: "Claude Code",
  model: { provider: "anthropic", id: "claude-fable-5", label: "Fable 5" },
  builtin: true,
  available: true,
  reason: "",
  account: "will@example.com"
}
const mount = (node: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    const root = createRoot(host)
    roots.push(root)
    root.render(node)
  })
  return host
}

const recorder = () => {
  const calls: Array<[string, string | undefined]> = []
  return { calls, onRunCommand: (name: string, args?: string) => void calls.push([name, args]) }
}

const click = (host: HTMLElement, selector: string): void => {
  const element = host.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`no element for ${selector}`)
  element.click()
}

describe("the Agents card", () => {
  test("on the web host it lists nothing local and says where agents run", () => {
    const host = mount(<AgentsCardBody onRunCommand={() => {}} card={agentsCard({ native: false, agents: [] })} />)
    expect(host.textContent).toBe("Agents run on the native app's harnesses.")
    expect(host.querySelector("[data-flow]")).toBeNull()
  })

  test("a repository agent flow is a row like a built-in: label, model, and its Runs door is runs.list on its flow id", () => {
    const { calls, onRunCommand } = recorder()
    const reviewer: typeof orchestrator = {
      id: "checks/review",
      label: "checks/review",
      purpose: "Reviews the change.",
      model: { provider: "openai", id: "gpt-6-sol", label: "gpt-6-sol" },
      builtin: false,
      available: false,
      reason: "",
      account: ""
    }
    const host = mount(<AgentsCardBody onRunCommand={onRunCommand} card={agentsCard({ native: false, agents: [orchestrator, reviewer] })} />)
    const row = host.querySelector<HTMLElement>('[data-agent="checks/review"]')
    expect(row?.textContent).toContain("checks/review")
    expect(row?.textContent).toContain("gpt-6-sol")
    expect(row?.querySelector("[title]")?.getAttribute("title")).toBe("Reviews the change.")
    click(host, '[data-testid="agent-runs-checks/review"]')
    expect(calls).toEqual([["runs.list", JSON.stringify({ flow: "checks/review" })]])
  })

  test("the last act's refusal stays on the card", () => {
    const host = mount(<AgentsCardBody onRunCommand={() => {}} card={agentsCard({ native: true, agents: [orchestrator], error: "The server answered 500" })} />)
    expect(host.querySelector("[role=alert]")?.textContent).toBe("The server answered 500")
  })
})

/*
 * The agent card's cloud variant (UI-COVERAGE-GAPS.md "agents · Cloud agent
 * sessions"): the session's header, its SSE-fed transcript rows, and the Stop
 * door while the session is active. Rendered through the family's entry, so
 * the variant dispatch is what the test covers.
 */
describe("the agent card's cloud variant", () => {
  type AgentCard = Extract<Card, { kind: "agent" }>
  type CloudPayload = Extract<AgentCard["payload"], { readonly cloud: true }>
  const cloudCard = (payload: CloudPayload): AgentCard => ({
    ...base,
    id: "agent-session-sess-1",
    kind: "agent",
    title: "Fix the retry loop · will/smithers",
    payload
  })
  const render = (card: AgentCard, onRunCommand: (name: string, args?: string) => void = () => {}): HTMLElement =>
    mount(<>{agentCardFamily.agent.render(card, { onRunCommand } as never)}</>)
  const transcript: CloudPayload["transcript"] = [
    { id: 41, role: "user", sequence: 1, createdAt: "2026-09-14T09:00:01Z", parts: [{ type: "text", text: "Fix the retry loop" }] },
    {
      id: 42,
      role: "assistant",
      sequence: 2,
      createdAt: "2026-09-14T09:00:20Z",
      parts: [
        { type: "tool_call", text: `{"name":"Read","arguments":{"path":"src/index.ts"}}` },
        { type: "text", text: "The loop never decrements." }
      ]
    }
  ]

  test("the header carries session · repository · provider · state, and the transcript its rows", () => {
    const { calls, onRunCommand } = recorder()
    const host = render(cloudCard({
      cloud: true,
      displayName: "Fix the retry loop",
      sessionId: "sess-1",
      repo: "will/smithers",
      provider: "codex",
      workspaceId: "ws-1",
      state: "active",
      task: "Fix the retry loop",
      transcript
    }), onRunCommand)
    expect(host.querySelector("[data-testid=agent-session-header]")?.textContent)
      .toBe("session sess-1 · will/smithers · codex · active")
    const rows = [...host.querySelectorAll<HTMLElement>("[data-testid=agent-session-transcript] > li")]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.dataset.role).toBe("user")
    expect(rows[0]?.textContent).toContain("Fix the retry loop")
    expect(rows[1]?.textContent).toContain("tool_call:")
    expect(rows[1]?.textContent).toContain("The loop never decrements.")
    /* Stop while active, bound to the flow with the session id. */
    const stop = host.querySelector("[data-testid=agent-session-stop-sess-1]")
    expect(stop?.getAttribute("data-flow")).toBe("agent.session.stop")
    click(host, "[data-testid=agent-session-stop-sess-1]")
    expect(calls).toEqual([["agent.session.stop", "sess-1"]])
  })

  test("a terminal session offers no Stop, and an unknown provider renders nothing in its place", () => {
    const host = render(cloudCard({
      cloud: true,
      displayName: "Fix the retry loop",
      sessionId: "sess-1",
      repo: "will/smithers",
      provider: null,
      workspaceId: null,
      state: "completed",
      transcript: []
    }))
    expect(host.querySelector("[data-testid=agent-session-header]")?.textContent).toBe("session sess-1 · will/smithers · completed")
    expect(host.querySelector("[data-flow]")).toBeNull()
    expect(host.querySelector("[data-testid=agent-session-transcript]")).toBeNull()
  })

  test("the last act's refusal stays on the card, and the pill is the session's state in the card words", () => {
    const host = render(cloudCard({
      cloud: true,
      displayName: "Fix the retry loop",
      sessionId: "sess-1",
      repo: "will/smithers",
      provider: "claude",
      workspaceId: null,
      state: "active",
      transcript: [],
      error: "agent session already has an active run"
    }))
    expect(host.querySelector("[role=alert]")?.textContent).toBe("agent session already has an active run")
    const pill = (state: string): string => agentCardFamily.agent.pill(cloudCard({
      cloud: true, displayName: "", sessionId: "sess-1", repo: "will/smithers", provider: null, workspaceId: null, state, transcript: []
    }))
    expect(pill("active")).toBe("running")
    expect(pill("completed")).toBe("done")
    expect(pill("failed")).toBe("failed")
    expect(pill("cancelled")).toBe("stopped")
  })
})


describe("cloud session inventory", () => {
  test("Open carries the repository; only active sessions offer Stop", () => {
    const record = recorder()
    const host = mount(<AgentsCardBody onRunCommand={record.onRunCommand} card={agentsCard({
      cloud: true, repo: "will/other", sessions: [
        { id: "active-id", title: "Fix retries", status: "active", messageCount: 2, createdAt: null, workspaceId: null },
        { id: "done-id", title: "", status: "completed", messageCount: 1, createdAt: null, workspaceId: null }
      ]
    })} />)
    expect(host.textContent).not.toContain("/agent.session.")
    expect(host.textContent).toContain("done-id")
    expect(host.querySelectorAll('[data-flow="agent.session.stop"]')).toHaveLength(1)
    click(host, '[data-session="active-id"] [data-flow="agent.session.view"]')
    click(host, '[data-session="active-id"] [data-flow="agent.session.stop"]')
    click(host, '[data-session="done-id"] [data-flow="agent.session.view"]')
    expect(record.calls).toEqual([
      ["agent.session.view", "active-id will/other"],
      ["agent.session.stop", "active-id will/other"],
      ["agent.session.view", "done-id will/other"]
    ])
  })
  test("an empty cloud list adds no instructions or local-harness warning", () => {
    const host = mount(<AgentsCardBody onRunCommand={() => {}} card={agentsCard({ cloud: true, repo: "will/other", sessions: [] })} />)
    expect(host.textContent).toBe("")
    expect(host.querySelectorAll("button")).toHaveLength(0)
  })
})
