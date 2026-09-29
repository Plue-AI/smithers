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

test("an inventory failure reads one sentence with Retry; GitHub's words stay behind Details", () => {
  const raw = "Error: GitHub read unavailable (500)."
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<RepositoryChoiceCard payload={{ ...payload, partial: true, repositories: [], error: raw }}
      onRunCommand={(name, args) => { calls.push([name, args]) }} />))
    const notice = host.querySelector<HTMLElement>("[data-testid=repository-choice-failure]")!
    expect(notice.getAttribute("role")).toBe("alert")
    expect(notice.dataset.fault).toBe("infra")
    expect(notice.dataset.failure).toBe("RepositoryChoiceFailed")
    expect(notice.querySelector("p")?.textContent).toBe("Smithers could not list your GitHub repositories. Not your fault.")
    expect(notice.querySelector("p")?.textContent).not.toContain("500")
    expect(notice.querySelector("details")?.open).toBe(false)
    expect(notice.querySelector("details pre")?.textContent).toBe(raw)
    const retry = [...notice.querySelectorAll<HTMLButtonElement>("button")]
    expect(retry.map(button => button.textContent)).toEqual(["Retry"])
    flushSync(() => retry[0]!.click())
    expect(calls).toEqual([["repo.choose", undefined]])
  } finally { flushSync(() => root.unmount()); host.remove() }
})

test("a row's failure reads one quiet sentence and no button; the row still chooses its repository", () => {
  const raw = "commits read refused (HTTP 502)"
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<RepositoryChoiceCard payload={{ ...payload, repositories: [{ ...payload.repositories[0]!, error: raw }] }}
      onRunCommand={() => {}} />))
    const notice = host.querySelector<HTMLElement>("[data-testid=repository-choice-row-failure]")!
    expect(notice.getAttribute("role")).toBe("status")
    expect(notice.dataset.fault).toBe("infra")
    expect(notice.dataset.failure).toBe("RepositoryChoiceRowFailed")
    expect(notice.querySelector("p")?.textContent).toBe("Smithers could not read this repository's activity. Not your fault.")
    expect(notice.querySelector("p")?.textContent).not.toContain("502")
    expect(notice.querySelector("details pre")?.textContent).toBe(raw)
    expect(notice.querySelector("button")).toBeNull()
    expect(host.querySelector("[data-testid=repository-choice-failure]")).toBeNull()
    expect(host.querySelector('button[data-flow="repo.choose"]')).not.toBeNull()
  } finally { flushSync(() => root.unmount()); host.remove() }
})

test("signed out, the list failure is the person's to fix: one sentence and the sign-in door, no infra claim", () => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<RepositoryChoiceCard signedIn={false}
      payload={{ ...payload, partial: true, repositories: [], error: "Sign in to list GitHub repositories." }}
      onRunCommand={(name, args) => { calls.push([name, args]) }} />))
    const notice = host.querySelector<HTMLElement>("[data-testid=repository-choice-failure]")!
    expect(notice.dataset.fault).toBe("user")
    expect(notice.dataset.failure).toBe("RepositoryChoiceSignedOut")
    expect(notice.querySelector("p")?.textContent).toBe("Sign in to list your GitHub repositories.")
    expect(notice.textContent).not.toContain("Not your fault")
    expect(notice.querySelector("details")).toBeNull()
    const buttons = [...notice.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons.map(button => [button.textContent, button.dataset.flow])).toEqual([["Sign in", "auth.sign-in"]])
    flushSync(() => buttons[0]!.click())
    expect(calls).toEqual([["auth.sign-in", undefined]])
  } finally { flushSync(() => root.unmount()); host.remove() }
})
