import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CardSchema } from "@smthrs/rpc/Cards"
import { LandingCardBody } from "./LandingCards"

const render = (state: string, draft = false) => {
  const card = CardSchema.parse({ id: "pr", kind: "pr", title: "Fix", status: "active", ordinal: 0, createdAt: 1,
    payload: { repo: "owner/repo", number: 2, title: "Fix", state, draft, author: "owner", prBody: "Verified fix", reviews: [], checks: [{ context: "test", state: "success" }] } })
  if (card.kind !== "pr") throw Error("Expected PR")
  return renderToStaticMarkup(<LandingCardBody card={card} onRunCommand={() => {}} />)
}

const renderTab = (payload: Record<string, unknown>) => {
  const card = CardSchema.parse({ id: "pr", kind: "pr", title: "Fix", status: "active", ordinal: 0, createdAt: 1,
    payload: { repo: "owner/repo", number: 2, title: "Fix", state: "merged", author: "owner", prBody: "", reviews: [], checks: [], ...payload } })
  if (card.kind !== "pr") throw Error("Expected PR")
  return renderToStaticMarkup(<LandingCardBody card={card} onRunCommand={() => {}} />)
}

test("finished or queued PRs retain their checks without offering another merge or review", () => {
  for (const state of ["merged", "landed", "closed", "queued", "landing"]) {
    const html = render(state)
    expect(html).toContain("Verified fix")
    expect(html).toContain("test")
    expect(html).not.toContain('data-flow="prs.land"')
    expect(html).not.toContain('data-flow="prs.review"')
  }
})

test("open and failed PRs retain their actions; drafts can be reviewed but not landed", () => {
  for (const state of ["open", "failed"]) {
    expect(render(state)).toContain('data-flow="prs.land"')
    expect(render(state)).toContain('data-flow="prs.review"')
  }
  for (const [state, draft] of [["draft", false], ["open", true]] as const) {
    expect(render(state, draft)).not.toContain('data-flow="prs.land"')
    expect(render(state, draft)).toContain('data-flow="prs.review"')
  }
})

test("failed and successful-empty tab reads are distinct, and failure retries the same PR", () => {
  const failed = renderTab({ tab: "files", readErrors: { files: "Files unavailable (change not found)" } })
  expect(failed).toContain('role="alert"')
  expect(failed).toContain("Files unavailable (change not found)")
  expect(failed).toContain('data-flow="prs.view"')
  expect(failed).toContain('data-flow-args="2 owner/repo"')
  expect(failed).toContain(">Retry</button>")

  const empty = renderTab({ tab: "files", files: [] })
  expect(empty).toContain("No file changes in this pull request.")
  expect(empty).not.toContain('role="alert"')
  expect(empty).not.toContain(">Retry</button>")
})

test("review actions carry the Beta label and its limitations; finished PRs show neither", () => {
  const open = render("open")
  expect(open).toContain('data-maturity="beta"')
  expect(open).toContain(">Beta</span>")
  expect(open).toContain("No line comments or suggested changes yet")
  const merged = render("merged")
  expect(merged).not.toContain('data-maturity="beta"')
})
