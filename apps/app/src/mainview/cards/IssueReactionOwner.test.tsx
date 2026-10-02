import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import type { CardProjectionAuthority } from "./CardFamily"
import { fixtureCards } from "./fixtures/UiSurfaces"
import { IssueThreadBody } from "./IssueThread"

const render = (viewer?: string) => {
  const card = fixtureCards().find((candidate): candidate is Extract<Card, { kind: "issue" }> => candidate.kind === "issue")!
  const comment = card.payload.comments[0]!
  card.payload.comments = [{ ...comment, id: 33, reactions: [
    { name: "eyes", actor: "owner", active: true },
    { name: "eyes", actor: "another-person", active: true },
    { name: "thumbsup", actor: "slack:T001:owner", active: true },
    { name: "heart", actor: "owner", active: false }
  ] }]
  const projectionStore = { collections: {
    identitySessions: new Map([["identity", { login: viewer }]]),
    cloudSessions: new Map(), cards: new Map()
  } } as unknown as CardProjectionAuthority
  return renderToStaticMarkup(<IssueThreadBody card={card} onRunCommand={() => {}} projectionStore={projectionStore} />)
}

test("reloaded login reactions expose a native keyboard Remove control only for their owner", () => {
  const html = render("owner")
  const owned = html.match(/<button[^>]*aria-label="Remove your eyes reaction"[^>]*>eyes 2<\/button>/)?.[0]
  expect(owned).toBeDefined()
  expect(owned).toContain('type="button"')
  expect(owned).toContain('data-flow="issues.comment.react"')
  expect(owned).toContain('&quot;commentId&quot;:33')
  expect(owned).toContain('&quot;active&quot;:false')
  expect(html).toContain('<span class="thread-reaction">thumbsup 1</span>')
  expect(html).not.toContain("Remove your thumbsup")
  expect(html).not.toContain("heart 1")
  expect(html.match(/aria-label="Remove your/g)).toHaveLength(1)
})

test("an unrelated viewer and a signed-out viewer cannot remove anyone's reactions", () => {
  for (const viewer of ["unrelated", undefined]) {
    const html = render(viewer)
    expect(html).not.toContain("Remove your")
    expect(html).toContain('<span class="thread-reaction">eyes 2</span>')
    expect(html).toContain('<span class="thread-reaction">thumbsup 1</span>')
  }
})
