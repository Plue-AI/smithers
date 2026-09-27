import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { groupByKind, SearchResultsCardBody } from "./SearchResultsCard"

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type ResultsCard = Extract<Card, { kind: "search-results" }>

/** The §9 mock's rows as one search.open answer. */
const fixture: ResultsCard = {
  id: "search-search.open",
  kind: "search-results",
  title: "Search · redact",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    query: "redact",
    flow: "search.open",
    args: "redact",
    items: [
      {
        kind: "history",
        ref: "abc1234",
        title: "Redact secrets before they reach the journal",
        subtitle: "epic · 3 commits",
        actions: [{ flow: "history.show", label: "Show the mythical history", role: "open" }]
      },
      {
        kind: "file",
        ref: "packages/smithers/journal/src/Redaction.ts",
        title: "packages/smithers/journal/src/Redaction.ts",
        subtitle: "opened 2h ago",
        actions: [
          { flow: "files.read", args: "packages/smithers/journal/src/Redaction.ts r1", label: "Read a file from a repository", role: "open" },
          { flow: "code.diagnostics", args: "packages/smithers/journal/src/Redaction.ts", label: "Diagnostics", role: "other" }
        ]
      },
      {
        kind: "file",
        ref: "packages/smithers/journal/src/Redaction.test.ts",
        title: "packages/smithers/journal/src/Redaction.test.ts",
        actions: [{ flow: "files.read", args: "packages/smithers/journal/src/Redaction.test.ts r1", label: "Read a file from a repository", role: "open" }]
      }
    ]
  }
}

const render = (card: ResultsCard) => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<SearchResultsCardBody card={card} onRunCommand={(name, args) => calls.push([name, args])} />)
  })
  return { host, calls }
}

describe("the search-results card", () => {
  test("groups the rows by kind in the ranking's order, files before history", () => {
    expect(groupByKind(fixture.payload.items).map((group) => [group.kind, group.items.length])).toEqual([["file", 2], ["history", 1]])
    const { host } = render(fixture)
    const labels = Array.from(host.querySelectorAll(".search-results-group-label")).map((node) => node.textContent)
    expect(labels).toEqual(["Files", "History"])
    expect(host.querySelector("[data-testid='search-results-query']")?.textContent).toBe("/search.open redact · 3 results")
  })

  test("every action is a button carrying its flow and args, dispatched through onRunCommand", () => {
    const { host, calls } = render(fixture)
    const open = host.querySelector<HTMLButtonElement>("[data-testid='search-item-file-packages/smithers/journal/src/Redaction.ts'] [data-role='open']")
    expect(open?.dataset["flow"]).toBe("files.read")
    flushSync(() => open?.click())
    expect(calls).toEqual([["files.read", "packages/smithers/journal/src/Redaction.ts r1"]])
    const history = host.querySelector<HTMLButtonElement>("[data-testid='search-item-history-abc1234'] [data-flow='history.show']")
    flushSync(() => history?.click())
    expect(calls[1]).toEqual(["history.show", undefined])
  })

  test("the card re-runs its own flow with its own query", () => {
    const { host, calls } = render(fixture)
    const again = host.querySelector<HTMLButtonElement>("[data-testid='search-results-rerun']")
    expect(again?.dataset["flow"]).toBe("search.open")
    flushSync(() => again?.click())
    expect(calls).toEqual([["search.open", "redact"]])
  })

  test("an answer with no rows says so and offers only the re-run", () => {
    const { host } = render({ ...fixture, payload: { ...fixture.payload, items: [] } })
    expect(host.querySelector("[data-testid='search-results-empty']")?.textContent).toBe("No results for redact.")
    expect(host.querySelectorAll("[data-role]").length).toBe(0)
  })
})

const savedFile = (ref: string, args: string, flow = "files.read"): ResultsCard => ({
  ...fixture, payload: { ...fixture.payload, items: [{ kind: "file", ref, title: ref,
    actions: [{ flow, args, label: "Open", role: "open" }] }] }
})

test("an ambiguous saved file row can be searched again but cannot follow the current repository", () => {
  const { host, calls } = render(savedFile("README.md", "README.md"))
  expect(host.querySelectorAll("[data-role]").length).toBe(0)
  flushSync(() => host.querySelector<HTMLButtonElement>("[data-testid='search-results-rerun']")?.click())
  expect(calls).toEqual([["search.open", "redact"]])
})

test("a saved global file address becomes an explicit repository argument", () => {
  const { host, calls } = render(savedFile("/alpha/one/docs/README.md", "/alpha/one/docs/README.md"))
  flushSync(() => host.querySelector<HTMLButtonElement>("[data-role='open']")?.click())
  expect(calls).toEqual([["files.read", "docs/README.md alpha/one"]])
})

test("a saved workspace file keeps its explicit workspace and quoted path", () => {
  const { host, calls } = render(savedFile("notes/read me.md", '\"notes/read me.md\" ws-1', "box.file"))
  flushSync(() => host.querySelector<HTMLButtonElement>("[data-role='open']")?.click())
  expect(calls).toEqual([["box.file", '\"notes/read me.md\" ws-1']])
})
