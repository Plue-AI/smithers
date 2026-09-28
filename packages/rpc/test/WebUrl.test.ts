import { describe, expect, test } from "vitest"
import { CardSchema, WorkspaceDesktopSchema, WorkspaceServiceSchema } from "../src/Cards.ts"
import { CloudAuthStartResponseSchema } from "../src/CloudTunnel.ts"
import { MythicalIssueSchema, MythicalPullRequestSchema } from "../src/Mythical.ts"
import { HttpUrlSchema, RelativeUrlPathSchema } from "../src/WebUrl.ts"

/*
 * Every URL a contract hands a renderer to link, embed or open is http(s) or
 * origin-relative. A `javascript:` href or iframe src runs in the app origin;
 * `data:` and `file:` reach content the app never meant to show.
 */
const hostile = [
  "javascript:alert(document.domain)",
  "JavaScript:alert(1)",
  " javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "smithers://open",
  "//evil.example/x",
  "/relative",
  ""
]

const base = { id: "card-url", title: "t", status: "active", createdAt: 0, ordinal: 0 }

describe("URL contracts", () => {
  test("HttpUrlSchema accepts http(s) and nothing else", () => {
    for (const url of ["https://github.com/a/b/issues/1", "http://localhost:4000/login?x=1", "HTTPS://Example.com"]) {
      expect(HttpUrlSchema.safeParse(url).success).toBe(true)
    }
    for (const url of hostile) expect(HttpUrlSchema.safeParse(url).success).toBe(false)
  })

  test("RelativeUrlPathSchema accepts one origin-relative path and refuses another host or scheme", () => {
    expect(RelativeUrlPathSchema.safeParse("/api/workspaces/ws-1/desktop/stream").success).toBe(true)
    for (
      const path of ["//evil.example/x", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "/a\nb"]
    ) {
      expect(RelativeUrlPathSchema.safeParse(path).success).toBe(false)
    }
  })

  test("Mythical issue and pull request links and the cloud sign-in URL are http(s)", () => {
    for (const url of hostile) {
      expect(MythicalIssueSchema.safeParse({ number: 1, title: "t", url }).success).toBe(false)
      expect(MythicalPullRequestSchema.safeParse({ number: 1, url, state: "open" }).success).toBe(false)
      expect(CloudAuthStartResponseSchema.safeParse({ url }).success).toBe(false)
    }
    expect(CloudAuthStartResponseSchema.safeParse({ url: "http://127.0.0.1:4000/api/auth/github/cli" }).success)
      .toBe(true)
  })

  test("workspace service and desktop stream URLs refuse script and cross-host forms", () => {
    for (const url of hostile) {
      expect(WorkspaceServiceSchema.safeParse({ name: "web", state: "up", url }).success).toBe(false)
    }
    for (const streamUrl of ["javascript:alert(1)", "//evil.example/vnc", "https://evil.example/vnc"]) {
      expect(WorkspaceDesktopSchema.safeParse({ streamUrl, session: null }).success).toBe(false)
    }
  })

  test("a frameable browser card embeds only an http(s) page", () => {
    const browser = (payload: Record<string, unknown>) =>
      CardSchema.safeParse({
        ...base,
        kind: "browser",
        payload: {
          url: "https://smithers.sh",
          finalUrl: null,
          status: 200,
          frameable: true,
          blockReason: null,
          ...payload
        }
      }).success
    expect(browser({})).toBe(true)
    expect(browser({ url: "javascript:alert(document.domain)" })).toBe(false)
    expect(browser({ finalUrl: "javascript:alert(document.domain)" })).toBe(false)
    expect(browser({ url: "data:text/html,<script>alert(1)</script>", finalUrl: null })).toBe(false)
    // A refused request is still reported: the URL shows as text, never framed.
    expect(browser({ url: "ftp://example.com", frameable: false, status: null, error: "Only https:// pages" }))
      .toBe(true)
  })

  test("issue, commit and connector card links refuse script-capable schemes", () => {
    const issue = {
      repo: "smithersai/smithers",
      number: 1,
      title: "t",
      state: "open",
      author: null,
      issueBody: "",
      labels: [],
      comments: []
    }
    expect(
      CardSchema.safeParse({ ...base, kind: "issue", payload: { ...issue, htmlUrl: "https://github.com/x" } }).success
    )
      .toBe(true)
    expect(
      CardSchema.safeParse({ ...base, kind: "issue", payload: { ...issue, htmlUrl: "javascript:alert(1)" } }).success
    ).toBe(false)
    const withComment = (iconUrl: string) =>
      CardSchema.safeParse({
        ...base,
        kind: "issue",
        payload: {
          ...issue,
          comments: [{
            id: 1,
            author: null,
            persona: { username: "r", iconUrl },
            commentBody: "",
            createdAt: null
          }]
        }
      }).success
    expect(withComment("https://avatars.githubusercontent.com/u/1")).toBe(true)
    expect(withComment("javascript:alert(1)")).toBe(false)
    const commit = (avatarUrl: string) => ({
      repo: "smithersai/smithers",
      commit: {
        commitId: "a1b2c3d4",
        changeId: null,
        title: "t",
        author: { name: null, email: null, avatarUrl },
        authoredAt: null
      },
      message: "t",
      parents: [],
      files: []
    })
    expect(
      CardSchema.safeParse({ ...base, kind: "commit", payload: commit("https://avatars.githubusercontent.com/u/2") })
        .success
    )
      .toBe(true)
    expect(CardSchema.safeParse({ ...base, kind: "commit", payload: commit("javascript:alert(1)") }).success).toBe(
      false
    )
  })
})
