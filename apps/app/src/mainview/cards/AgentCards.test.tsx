import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import type { Card } from "../state/AppState"
import { AgentsCardBody } from "./AgentCards"

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
      model: { provider: "openai", id: "gpt-6-sol", label: "GPT-6 Sol" },
      builtin: false,
      available: false,
      reason: "",
      account: ""
    }
    const host = mount(<AgentsCardBody onRunCommand={onRunCommand} card={agentsCard({ native: false, agents: [orchestrator, reviewer] })} />)
    const row = host.querySelector<HTMLElement>('[data-agent="checks/review"]')
    expect(row?.textContent).toContain("checks/review")
    expect(row?.textContent).toContain("GPT-6 Sol")
    expect(row?.querySelector("[title]")?.getAttribute("title")).toBe("Reviews the change.")
    click(host, '[data-testid="agent-runs-checks/review"]')
    expect(calls).toEqual([["runs.list", JSON.stringify({ flow: "checks/review" })]])
  })

  test("the last act's refusal reads as one sentence; the server's words stay behind Details", () => {
    const host = mount(<AgentsCardBody onRunCommand={() => {}} card={agentsCard({ native: true, agents: [orchestrator], error: "The server answered 500" })} />)
    const alert = host.querySelector<HTMLElement>("[role=alert]")
    expect(alert?.dataset.testid).toBe("agents-failure")
    expect(alert?.dataset.fault).toBe("infra")
    expect(alert?.dataset.failure).toBe("AgentsFailed")
    expect(alert?.querySelector("p")?.textContent).toBe("Smithers could not update your agents. Not your fault.")
    expect(alert?.querySelector("p")?.textContent).not.toContain("500")
    expect(alert?.querySelector("details pre")?.textContent).toBe("The server answered 500")
    expect(alert?.querySelector("details")?.open).toBe(false)
    expect(alert?.querySelector("button")).toBeNull()
  })
})

