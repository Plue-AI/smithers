import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import { BranchesCardBody } from "./BranchesCard"
import { CommitDetailBody, CommitListBody, dayLabel, groupByDay } from "./CommitCards"

/*
 * The commit cards render what the payload states and bind every act to a
 * registered flow: rows and parents open commits.read, the sha chip copies
 * through chat.copy-message, and a branches row opens commits.list.
 */

const base = { title: "t", status: "active" as const, createdAt: 1, ordinal: 1 }
const author = { name: "Ada Lovelace", email: "7+ada@users.noreply.github.com", login: "ada", avatarUrl: "https://avatars.githubusercontent.com/u/7?v=4" }
const row = (commitId: string, changeId: string, title: string, authoredAt: string | null, extra: object = {}) => ({
  commitId, changeId, title, author, authoredAt, ...extra
})

const list: Extract<Card, { kind: "commit-list" }> = {
  ...base,
  id: "commits-will/flows-main",
  kind: "commit-list",
  payload: {
    repo: "will/flows",
    branch: "main",
    commits: [
      row("aaaaaaa1111", "c3", "Third", "2026-09-10T15:00:00Z", { status: "success", verified: true }),
      row("bbbbbbb2222", "c2", "Second", "2026-09-10T09:00:00Z"),
      row("ccccccc3333", "c1", "First", "2026-09-08T12:00:00Z", { status: "failure" })
    ]
  }
}

describe("commit-list card", () => {
  test("groups rows under GitHub's day headings, newest first", () => {
    expect(dayLabel("2026-09-10T15:00:00Z")).toBe("Commits on Sep 10, 2026")
    expect(dayLabel(null)).toBe("Commits with no date")
    expect(groupByDay(list.payload.commits).map((group) => [group.label, group.commits.length])).toEqual([
      ["Commits on Sep 10, 2026", 2],
      ["Commits on Sep 8, 2026", 1]
    ])
  })

  test("each row carries its title, author, short sha copy and only the badges its data states", () => {
    const html = renderToStaticMarkup(<CommitListBody card={list} onRunCommand={() => {}} />)
    expect(html).toContain("3 commits on <code>main</code>")
    expect(html).toContain("Commits on Sep 10, 2026")
    expect(html).toContain('data-flow="commits.read"')
    expect(html).toContain('data-flow="chat.copy-message"')
    expect(html).toContain("<code>aaaaaaa</code>")
    expect(html).toContain(">ada<")
    expect(html.match(/class="commit-verified"/g)?.length).toBe(1)
    expect(html.match(/class="commit-status"/g)?.length).toBe(2)
    expect(html).toContain('aria-label="Some checks failed"')
  })

  test("a row names commits.read with its change id and repo", () => {
    const calls: Array<[string, string | undefined]> = []
    const element = CommitListBody({ card: list, onRunCommand: (name, args) => void calls.push([name, args]) })
    const buttons: Array<{ props: { onClick?: () => void; "data-flow"?: string } }> = []
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return
      if (Array.isArray(node)) return node.forEach(walk)
      const el = node as { type?: unknown; props?: { children?: unknown; onClick?: () => void; "data-flow"?: string } }
      if (el.type === "button" && el.props?.["data-flow"] === "commits.read") buttons.push(el as never)
      walk(el.props?.children)
    }
    walk(element)
    buttons[0]?.props.onClick?.()
    expect(calls).toEqual([["commits.read", "c3 will/flows"]])
  })
})

describe("commit card", () => {
  test("shows the full message, parents as commits.read doors, and each file's diff or why not", () => {
    const card: Extract<Card, { kind: "commit" }> = {
      ...base,
      id: "commit-will/flows-c3",
      kind: "commit",
      payload: {
        repo: "will/flows",
        commit: row("aaaaaaa1111", "c3", "Third", "2026-09-10T15:00:00Z", { status: "pending" }),
        message: "Third\n\nThe body line.",
        parents: [{ changeId: "c2", commitId: "bbbbbbb2222" }, { changeId: null, commitId: null }],
        files: [
          { path: "logo.png", changeType: "added", isBinary: true, additions: 0, deletions: 0 },
          { path: "src/a.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1 }
        ]
      }
    }
    const html = renderToStaticMarkup(<CommitDetailBody card={card} onRunCommand={() => {}} />)
    expect(html).toContain("The body line.")
    expect(html).toContain("2 parents")
    expect(html.match(/data-flow="commits.read"/g)).toHaveLength(1)
    expect(html).toContain("<code>bbbbbbb</code>")
    expect(html).toContain('data-slot="commit"')
    expect(html).toContain("logo.png is binary")
    expect(html).toContain("No patch was returned for src/a.ts.")
    expect(html).toContain('aria-label="Checks in progress"')
  })
})

describe("branches card", () => {
  test("a row is a commits.list door for that branch", () => {
    const html = renderToStaticMarkup(
      <BranchesCardBody
        card={{ ...base, id: "branches-will/flows", kind: "branches", payload: { repo: "will/flows", bookmarks: [{ name: "feat/x", head: "0123456789" }] } }}
        onRunCommand={() => {}}
      />
    )
    expect(html).toContain('data-flow="commits.list"')
    expect(html).toContain('aria-label="Commits on feat/x"')
    expect(html).toContain("01234567")
    expect(html).not.toContain("/prs.create")
  })
})
