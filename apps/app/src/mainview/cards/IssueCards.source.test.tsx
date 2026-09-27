import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { CardSchema } from "@smthrs/rpc/Cards"
import { IssueListCardBody, IssueCardBody } from "./IssueCards"
import { repositoryUpdateCardFamily } from "./RepositoryUpdateCard"
import type { CardActions } from "./CardFamily"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })
const render = (node: React.ReactNode) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(node))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  return host
}
const base = { id: "issues", title: "Issues", status: "active" as const, createdAt: 0, ordinal: 0 }

test("same-number issue row buttons carry distinct source identities", () => {
  const commands: unknown[] = []
  const card: Extract<Card, { kind: "issue-list" }> = { ...base, kind: "issue-list", payload: {
    repo: "will/flows", filter: "open", issues: ["smithers-cloud", "github"].map(source => ({
      number: 1, title: `${source} issue`, source: source as "github" | "smithers-cloud", author: null, state: "open", comments: 0, updatedAt: null
    }))
  } }
  const host = render(<IssueListCardBody card={card} onRunCommand={(name, args) => { commands.push([name, args]) }} />)
  for (const button of host.querySelectorAll<HTMLButtonElement>('[data-flow="issues.view"]')) {
    button.focus()
    expect(document.activeElement).toBe(button)
    button.click()
  }
  expect(commands).toEqual([["issues.view", "1 will/flows --source smithers-cloud"], ["issues.view", "1 will/flows --source github"]])
})

test("restored GitHub detail retains its identity and cannot mutate a same-number native issue", () => {
  const card = CardSchema.parse({ ...base, kind: "issue", payload: {
    repo: "will/flows", number: 1, title: "GitHub issue", source: "github", htmlUrl: "https://github.com/will/flows/issues/1",
    state: "open", author: null, issueBody: "", labels: [], comments: []
  } })
  if (card.kind !== "issue") throw Error("Wrong card")
  const host = render(<IssueCardBody card={card} onRunCommand={() => { throw Error("A read cannot mutate") }} />)
  expect(card.payload.source).toBe("github")
  expect(host.querySelector("a")?.href).toBe("https://github.com/will/flows/issues/1")
  expect(host.querySelector('[data-flow="issues.close"]')).toBeNull()
  expect(host.querySelector('[data-flow="issues.comment"]')).toBeNull()
  expect(host.querySelector('[data-flow="issues.link-linear"]')).toBeNull()
  expect(host.querySelector('[data-flow="issue.repro"]')).toBeNull()
})

test("saved Activity rows recover GitHub identity from older notification receipts", () => {
  const commands: unknown[] = []
  const noop = () => {}
  const actions: CardActions = {
    onDecideApproval: noop, onGrantConfirm: noop, onGrantCancel: noop, onQueueApprove: noop,
    onConnectGitHub: noop, onRunWorkflow: noop, onStopRun: noop, onRetryRun: noop,
    onChooseWorkflowRepo: noop, onChangeWorldDocument: noop, worldDocuments: [],
    onRunCommand: (name, args) => { commands.push([name, args]) }
  }
  const card = CardSchema.parse({ ...base, kind: "repo-update", payload: {
    repo: "will/flows", scope: "github:will", checkedAt: 0, summary: "", openIssues: 2, openPrs: 0, problems: [],
    items: ["smithers", "github"].map(source => ({
      id: JSON.stringify(["github:will", "will/flows", source, "issue", "1"]), version: "1", kind: "issue", number: 1,
      title: `${source} issue`, state: "open", tags: [], read: false
    }))
  } })
  if (card.kind !== "repo-update") throw Error("Wrong card")
  const host = render(repositoryUpdateCardFamily["repo-update"].render(card, actions))
  for (const button of host.querySelectorAll<HTMLButtonElement>('[data-flow="issues.view"]')) button.click()
  expect(commands).toEqual([["issues.view", "1 will/flows --source smithers-cloud"], ["issues.view", "1 will/flows --source github"]])
})

test("the assignee section distinguishes an unknown read from known unassigned", () => {
  const card: Extract<Card, { kind: "issue" }> = { ...base, kind: "issue", payload: {
    repo: "will/flows", number: 1, title: "Issue", state: "open", author: null, issueBody: "", labels: [], comments: []
  } }
  const unknown = render(<IssueCardBody card={card} onRunCommand={() => {}} />)
  expect(unknown.textContent).not.toContain("Assignees")
  const known = render(<IssueCardBody card={{ ...card, payload: { ...card.payload, assignees: [] } }} onRunCommand={() => {}} />)
  expect(known.textContent).toContain("Assignees")
  expect(known.textContent).toContain("No one assigned")
})

test("an empty conversations list says conversations, not issues", () => {
  const card: Extract<Card, { kind: "issue-list" }> = { ...base, kind: "issue-list", payload: { repo: "will/flows", filter: "open", kind: "conversation", issues: [] } }
  const host = render(<IssueListCardBody card={card} onRunCommand={() => {}} />)
  expect(host.querySelector(".ghc-empty")?.textContent).toBe("No open conversations in will/flows.")
  const issues = render(<IssueListCardBody card={{ ...card, payload: { ...card.payload, kind: "issue" } }} onRunCommand={() => {}} />)
  expect(issues.querySelector(".ghc-empty")?.textContent).toBe("No open issues in will/flows.")
})
