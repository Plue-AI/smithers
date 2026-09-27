import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { RepositoryChoicePayload } from "../state/controller/tutorialRepository"
import { RepositoryChoiceCard, SEARCH_LIMIT } from "./RepositoryChoiceCard"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })

const payload: RepositoryChoicePayload = {
  cutoff: "2026-06-01T00:00:00.000Z", partial: false, error: null, selected: null, created: null,
  repositories: [{ fullName: "example/repo", count: 3, latest: "2026-09-01T00:00:00.000Z", coverage: "default-branch", error: null }]
}

test("the button that creates a repository names the repository it creates, never Skip", () => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<RepositoryChoiceCard payload={payload} onRunCommand={(name, args) => { calls.push([name, args]) }} />))
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons.map(button => button.textContent)).not.toContain("Skip")
    const create = buttons.find(button => button.dataset.flow === "repo.create")!
    create.click()
    expect(calls).toEqual([["repo.create", "smithers-playground"]])
    expect(create.textContent).toBe("Create smithers-playground")
  } finally { flushSync(() => root.unmount()); host.remove() }
})

test("a large account shows the recent eight, marks the selection, and finds the rest by search, never hundreds of rows", () => {
  const repositories = Array.from({ length: 414 }, (_, index) => ({
    ...payload.repositories[0]!, fullName: `example/repo-${String(index).padStart(3, "0")}`
  }))
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const rows = () => [...host.querySelectorAll<HTMLButtonElement>('button[data-flow="repo.choose"]')]
  const search = (text: string) => {
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!
    // React tracks the value through the native setter. It loaded before happy-dom registered, so it
    // reads typing through its focus + keyup polyfill; a browser's input event takes the same onChange.
    flushSync(() => {
      input.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text)
      input.dispatchEvent(new Event("input", { bubbles: true }))
      input.dispatchEvent(new Event("keyup", { bubbles: true }))
    })
  }
  try {
    flushSync(() => root.render(<RepositoryChoiceCard payload={{ ...payload, repositories, selected: "example/repo-002" }}
      onRunCommand={(name, args) => { calls.push([name, args]) }} />))
    // Recent eight, then a bounded page of the rest behind the disclosure: 28 rows, not 414.
    expect(host.querySelector("summary")?.textContent).toBe("All repositories (414)")
    expect(rows()).toHaveLength(8 + SEARCH_LIMIT)
    expect(host.textContent).toContain(`${SEARCH_LIMIT} of 406`)
    // The current repository reads as selected; no other row does.
    expect(rows().filter(row => row.getAttribute("aria-pressed") === "true").map(row => row.dataset.flowArgs ?? row.textContent))
      .toEqual([expect.stringContaining("example/repo-002")])
    // A search narrows every repository, recent ones included.
    search("repo-41")
    expect(rows().slice(8).map(row => row.querySelector(".repository-choice-name")?.textContent))
      .toEqual(["example/repo-410", "example/repo-411", "example/repo-412", "example/repo-413"])
    expect(host.textContent).not.toContain(" of ")
    rows().at(-1)!.click()
    expect(calls).toEqual([["repo.choose", "example/repo-413"]])
    search("absent")
    expect(rows()).toHaveLength(8)
    expect(host.textContent).toContain("No matches")
    // Nothing is created without a press.
    expect(calls.some(([name]) => name === "repo.create")).toBe(false)
  } finally { flushSync(() => root.unmount()); host.remove() }
})
