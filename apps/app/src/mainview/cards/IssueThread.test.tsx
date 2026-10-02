import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import { fixtureCards } from "./fixtures/UiSurfaces"
import { IssueCardBody, IssueListCardBody } from "./IssueCards"
import { dueWords, reactionChips, stateActions } from "./IssueThread"

const noop = () => {}
const issue = () => fixtureCards().find((card): card is Extract<Card, { kind: "issue" }> => card.kind === "issue")!
const list = () => fixtureCards().find((card): card is Extract<Card, { kind: "issue-list" }> => card.kind === "issue-list")!

describe("a conversation renders inside the issue card (smithers-ui-DESIGN.md §3.1, §3.2)", () => {
  test("messages are rows with their persona, grouped, with reactions and the task strip", () => {
    const html = renderToStaticMarkup(<IssueCardBody card={issue()} onRunCommand={noop} />)
    expect(html).toContain('data-testid="conversation-2101"')
    expect(html).toContain('data-kind="issue"')
    // Two consecutive Engineer messages within five minutes share one header.
    expect(html.match(/data-continued="true"/g)?.length).toBe(1)
    expect(html).toContain("👀 1")
    expect(html).toContain("✅ 1")
    // Without a signed-in viewer no chip is "mine"; with one, the chip the viewer set toggles off.
    expect(html).not.toContain("Remove your")
    expect(reactionChips([{ name: "👀", actor: "owner", active: true }, { name: "👀", actor: "U1", active: true }, { name: "✅", actor: "U1", active: false }], "owner")).toEqual([{ name: "👀", count: 2, mine: true }])
    expect(html).toContain('data-state="fixed"')
    expect(html).toContain("P1")
    expect(html).toContain("#2088 Wiki freshness")
    expect(html).toContain("fixed by")
    // A persona that names a configured profile is a door to the roster; here no roster is loaded, so the username is text.
    expect(html).toContain("assistant")
    // The GitHub-shaped layout does not render for a chat.
    expect(html).not.toContain("ghc-detail-grid")
  })

  test("a failed send keeps its text and offers Retry; the composer and Send are present while the thread is open", () => {
    const html = renderToStaticMarkup(<IssueCardBody card={issue()} onRunCommand={noop} />)
    expect(html).toContain('data-pending="failed"')
    expect(html).toContain("<p>Smithers could not send this message. Not your fault.</p>")
    expect(html).toContain('<pre tabindex="0" role="region" aria-label="Failure details">Posting the message failed (503)</pre>')
    expect(html).not.toContain("<p>Posting the message failed")
    expect(html).toContain("And add the test to the wiki suite.")
    expect(html).toContain('data-flow="issues.comment.retry"')
    expect(html).toContain('data-testid="thread-composer"')
    expect(html).toContain('data-flow="issues.comment"')
  })

  test("the state acts follow the backend's ladder and the fixer cannot verify their own fix", () => {
    const fixedByEngineer = issue()
    expect(stateActions(fixedByEngineer, "owner").map((act) => [act.flow, act.disabled])).toEqual([["issues.verify", undefined], ["issues.reopen", undefined]])
    const fixedByViewer = { ...fixedByEngineer, payload: { ...fixedByEngineer.payload, task: { ...fixedByEngineer.payload.task, fixedBy: { id: "owner", name: "Owner" } } } }
    expect(stateActions(fixedByViewer, "owner").map((act) => [act.flow, act.disabled])).toEqual([["issues.verify", "fixed by you"], ["issues.reopen", undefined]])
    const open = { ...fixedByEngineer, payload: { ...fixedByEngineer.payload, state: "open" as const } }
    expect(stateActions(open).map((act) => act.flow)).toEqual(["issues.fix", "issues.close"])
    const chat = { ...open, payload: { ...open.payload, task: undefined } }
    expect(stateActions(chat).map((act) => act.flow)).toEqual(["issues.close"])
    const closed = { ...chat, payload: { ...chat.payload, state: "closed" as const } }
    expect(renderToStaticMarkup(<IssueCardBody card={closed} onRunCommand={noop} />)).not.toContain('data-testid="thread-composer"')
  })

  test("due dates read in the fewest words and mark the past", () => {
    const now = Date.UTC(2026, 8, 26, 9, 0, 0)
    expect(dueWords(new Date(now).toISOString(), now)).toEqual({ words: "today", past: false })
    expect(dueWords(new Date(now + 86_400_000).toISOString(), now)).toEqual({ words: "tomorrow", past: false })
    expect(dueWords("2026-09-20", now)).toEqual({ words: "09-20", past: true })
  })
})

describe("the issue list carries conversations and issues", () => {
  test("a conversation row shows the compact issue strip; a GitHub row keeps its shape", () => {
    const html = renderToStaticMarkup(<IssueListCardBody card={list()} onRunCommand={noop} />)
    expect(html).toContain('data-kind="conversation"')
    expect(html).toContain('data-state="fixed"')
    expect(html).toContain("ghc-row-title-text")
    // The kind chips re-invoke issues.list with the kind, in the words the person sees.
    expect(html).toContain('data-flow="issues.list"')
    expect(html).toContain("--kind issue")
    expect(html).toContain(">Conversations<")
    expect(html).not.toContain("Threads")
    expect(html).toContain('aria-pressed="true"')
  })
})

describe("chat origin (#2489)", () => {
  const slackComment = (origin: "app" | "slack" | "telegram" | undefined) => {
    const card = issue()
    const base = card.payload.comments[0]!
    return { ...card, payload: { ...card.payload, comments: [{ ...base, origin }] } }
  }
  test("a comment from chat is marked with its provider; an app comment or unknown origin is not", () => {
    expect(renderToStaticMarkup(<IssueCardBody card={slackComment("slack")} onRunCommand={noop} />)).toContain(">· slack</span>")
    expect(renderToStaticMarkup(<IssueCardBody card={slackComment("telegram")} onRunCommand={noop} />)).toContain(">· telegram</span>")
    expect(renderToStaticMarkup(<IssueCardBody card={slackComment("app")} onRunCommand={noop} />)).not.toContain("thread-origin")
    expect(renderToStaticMarkup(<IssueCardBody card={slackComment(undefined)} onRunCommand={noop} />)).not.toContain("thread-origin")
  })

  test("a conversation row shows the last line with its origin and ages by it", () => {
    const card = list()
    const row = card.payload.issues.find(candidate => candidate.kind === "chat" || candidate.task !== undefined)!
    const withLast = (lastComment: NonNullable<typeof row.lastComment> | null) =>
      ({ ...card, payload: { ...card.payload, issues: [{ ...row, kind: "chat" as const, lastComment }] } })
    const html = renderToStaticMarkup(<IssueListCardBody card={withLast({ commenter: "bob", excerpt: "on it", origin: "slack", createdAt: "2026-08-12T09:00:00Z" })} onRunCommand={noop} />)
    expect(html).toContain('<span class="thread-row-last">on it<span class="thread-slack thread-origin" data-origin="slack">· slack</span></span>')
    expect(html).toContain('dateTime="2026-08-12T09:00:00Z"')
    const none = renderToStaticMarkup(<IssueListCardBody card={withLast(null)} onRunCommand={noop} />)
    expect(none).not.toContain("thread-row-last")
    expect(none).toContain(`dateTime="${row.updatedAt}"`)
  })
})

