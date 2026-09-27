/*
 * The palette's pure half (Search and Command Palette Spec 2026-09-07):
 * the §1 prefix grammar, the §2 fuzzy tiers and ranking on a fixture, and
 * the actions a result offers, computed against the real registry.
 */
import { describe, expect, test } from "bun:test"
import type { SearchItem } from "@smthrs/rpc/Cards"
import type { CommandActions } from "./Flows"
import { baseFlows } from "./Flows"
import { actionsFor, frecency, heads, matchTier, parseQuery, PREFIXES, rankItems, RECENCY_WINDOW_MS, TIER } from "./SearchQuery"

/** Every controller call answers with nothing: registration never invokes a handler. */
const inertActions = new Proxy({}, { get: () => () => undefined }) as CommandActions
const entries = baseFlows(inertActions)

const item = (kind: SearchItem["kind"], ref: string, title: string, subtitle?: string): SearchItem => ({
  kind,
  ref,
  title,
  ...(subtitle === undefined ? {} : { subtitle }),
  actions: []
})

describe("§1 prefixes: the first token decides the mode", () => {
  test("sentences and long prose are not paths just because they contain punctuation", () => {
    expect(parseQuery("What does this repository do? Answer in two sentences.").mode).toBe("all")
    expect(parseQuery("Explain src/Composer.tsx please").mode).toBe("all")
    expect(parseQuery("A sentence. ".repeat(200).slice(0, 2000)).mode).toBe("all")
  })

  test("every §1 prefix parses to its mode with the prefix stripped", () => {
    expect(parseQuery("redact")).toMatchObject({ mode: "all", prefix: "", query: "redact" })
    expect(parseQuery("src/Redaction")).toMatchObject({ mode: "path", prefix: "", query: "src/Redaction" })
    expect(parseQuery("Composer.tsx")).toMatchObject({ mode: "path", query: "Composer.tsx" })
    expect(parseQuery("@redact")).toMatchObject({ mode: "all", prefix: "", query: "@redact" })
    expect(parseQuery("@@redact")).toMatchObject({ mode: "all", prefix: "", query: "@@redact" })
    expect(parseQuery(":120")).toMatchObject({ mode: "line", line: { line: 120 } })
    expect(parseQuery(":120:8")).toMatchObject({ mode: "line", line: { line: 120, column: 8 } })
    expect(parseQuery("text:useEffect")).toMatchObject({ mode: "all", prefix: "", query: "text:useEffect" })
    expect(parseQuery("/flows")).toMatchObject({ mode: "flows", prefix: "/", query: "flows" })
    expect(parseQuery("//apps/app:test")).toMatchObject({ mode: "targets", prefix: "//", query: "apps/app:test" })
    expect(parseQuery("wiki: redaction")).toMatchObject({ mode: "wiki", prefix: "wiki:", query: "redaction" })
    expect(parseQuery("history: retry")).toMatchObject({ mode: "history", query: "retry" })
    expect(parseQuery("ask:where is it")).toMatchObject({ mode: "ask", query: "where is it" })
    expect(parseQuery("run:run-9")).toMatchObject({ mode: "runs", query: "run-9" })
    expect(parseQuery("change:")).toMatchObject({ mode: "changes", query: "" })
    expect(parseQuery("#412")).toMatchObject({ mode: "issues", prefix: "#", query: "412" })
    expect(parseQuery("box:main")).toMatchObject({ mode: "boxes", query: "main" })
    expect(parseQuery("secret:NPM")).toMatchObject({ mode: "secrets", query: "NPM" })
    expect(parseQuery("user:will")).toMatchObject({ mode: "all", query: "user:will" })
    expect(parseQuery("?")).toMatchObject({ mode: "help", prefix: "?" })
  })

  test("qualifiers come out of the query in any mode; an unknown word: stays text", () => {
    const parsed = parseQuery("useEffect path:apps/app -path:*.test.*")
    expect(parsed.query).toBe("useEffect")
    expect(parsed.qualifiers).toEqual([
      { key: "path", value: "apps/app", negated: false },
      { key: "path", value: "*.test.*", negated: true }
    ])
    expect(parseQuery("#label:bug")).toMatchObject({ mode: "issues", query: "", qualifiers: [{ key: "label", value: "bug", negated: false }] })
    expect(parseQuery("history: retry section:tried").qualifiers).toEqual([{ key: "section", value: "tried", negated: false }])
    expect(parseQuery("note: about x")).toMatchObject({ mode: "all", query: "note: about x", qualifiers: [] })
  })

  test("a prefix mid-line is not a mode switch", () => {
    expect(parseQuery("find wiki:redaction")).toMatchObject({ mode: "all", query: "find wiki:redaction" })
  })

  test("the prefix table lists every §1 row once, with the signed-in ones marked", () => {
    expect(PREFIXES.map((row) => row.label)).toEqual([
      "(none)", "path", ":", "/", "//", "wiki:", "history:", "ask:", "run:", "change:", "#", "box:", "secret:", "?"
    ])
    expect(PREFIXES.filter((row) => row.signedIn).map((row) => row.mode)).toEqual(["boxes", "secrets"])
  })
})

describe("§2 fuzzy tiers", () => {
  test("name exact > prefix > contains > abbreviation > summary > subsequence > none", () => {
    expect(matchTier("flows", "flows")).toBe(TIER.exact)
    expect(matchTier("flow.list", "flow")).toBe(TIER.prefix)
    expect(matchTier("packages/journal/Redaction.ts", "redaction")).toBe(TIER.prefix)
    expect(matchTier("packages/journal/Redaction.ts", "journal")).toBe(TIER.contains)
    expect(matchTier("RedactionSeam.ts", "rs")).toBe(TIER.abbreviation)
    expect(matchTier("flow.list", "workspace", "List the flows on your workspace")).toBe(TIER.summary)
    expect(matchTier("Composer.tsx", "cpsr")).toBe(TIER.subsequence)
    expect(matchTier("Composer.tsx", "zzz")).toBe(TIER.none)
  })

  test("paths match per segment in order; CamelHump and snake_case heads abbreviate", () => {
    expect(matchTier("apps/app/src/mainview/Composer.tsx", "mainview/Comp")).toBe(TIER.contains)
    // Segments match in path order: the reversed pair is no match at all.
    expect(matchTier("apps/app/src/mainview/Composer.tsx", "Composer/mainview")).toBe(TIER.none)
    expect(heads("ChatMessagePanel")).toBe("cmp")
    expect(heads("redaction_hot_path.ts")).toBe("rhpt")
    expect(matchTier("redaction_hot_path.ts", "rhp")).toBe(TIER.abbreviation)
  })
})

describe("§2 ranking on a fixture", () => {
  const now = 1_000_000_000
  const items: ReadonlyArray<SearchItem> = [
    item("flow", "implement", "implement", "Implement a goal"),
    item("flow", "flow.list", "flow.list", "List the flows on your workspace"),
    item("file", "packages/journal/Redaction.ts", "packages/journal/Redaction.ts", "smithers"),
    item("file", "packages/journal/Redaction.test.ts", "packages/journal/Redaction.test.ts", "smithers"),
    item("history", "abc123", "Redact secrets before they reach the journal", "epic · 3 commits"),
    item("history", "def456", "tried: regex rescan per write, lost on latency", "note · Redact secrets"),
    item("run", "run-9", "run-9", "review · running")
  ]

  test("the recommended pills lead, groups order by their best match, and non-matches drop", () => {
    const groups = rankItems(items, "redact", { recents: [], now, recommended: ["implement"] })
    expect(groups.map((group) => group.label)).toEqual(["Files", "History"])
    expect(groups[0]?.items.map((row) => row.item.ref)).toEqual(["packages/journal/Redaction.ts", "packages/journal/Redaction.test.ts"])
    // The pill's flow does not match "redact" by name or summary, so it is not forced in.
    expect(groups.flatMap((group) => group.items).some((row) => row.item.ref === "implement")).toBe(false)
    const pills = rankItems(items, "impl", { recents: [], now, recommended: ["implement"] })
    expect(pills[0]).toMatchObject({ label: "Recommended" })
    expect(pills[0]?.items[0]?.recommended).toBe(true)
  })

  test("an empty query lists the pills, then the recents by frecency, and nothing else", () => {
    const recents = [
      { ref: "run-9", kind: "run", count: 1, lastSeen: now - 60_000 },
      { ref: "packages/journal/Redaction.ts", kind: "file", count: 4, lastSeen: now - 3_600_000 },
      { ref: "abc123", kind: "history", count: 9, lastSeen: now - RECENCY_WINDOW_MS - 1 }
    ]
    const groups = rankItems(items, "", { recents, now, recommended: ["implement"] })
    // The recent run lives in Recent, so no Runs group repeats it.
    expect(groups.map((group) => group.label)).toEqual(["Recommended", "Recent", "Flows", "Files", "History"])
    expect(groups[1]?.items.map((row) => row.item.ref)).toEqual(["packages/journal/Redaction.ts", "run-9"])
    // Eight days ago is outside the window: not recent, and its frecency is zero.
    expect(groups[1]?.items.some((row) => row.item.ref === "abc123")).toBe(false)
    expect(frecency(recents[2]!, now)).toBe(0)
  })

  test("a recent item outranks an equal match that was never opened", () => {
    const twins = [item("file", "a/Composer.tsx", "a/Composer.tsx"), item("file", "b/Composer.tsx", "b/Composer.tsx")]
    const groups = rankItems(twins, "Composer", { recents: [{ ref: "b/Composer.tsx", kind: "file", count: 2, lastSeen: now }], now, recommended: [] })
    expect(groups[0]?.items.map((row) => row.item.ref)).toEqual(["b/Composer.tsx", "a/Composer.tsx"])
  })
})

describe("§2 actions: every action is a registered flow whose input the ref fills", () => {
  test("a file opens with files.read and lists the code reads; nothing that needs more than the path", () => {
    const actions = actionsFor({ kind: "file", ref: "src/index.ts", title: "src/index.ts" }, entries)
    expect(actions[0]).toEqual({ flow: "files.read", args: "src/index.ts", label: "Read a file from a repository", role: "open" })
    const names = actions.map((action) => action.flow)
    expect(names).toContain("code.diagnostics")
    expect(names).toContain("files.list")
    // code.hover needs a line and a column the ref cannot supply.
    expect(names).not.toContain("code.hover")
    // Implement is the file's primary flow by §2, and it is not registered: no primary, never a made-up one.
    expect(actions.some((action) => action.role === "primary")).toBe(false)
  })

  test("an issue never borrows the pull-request flows that share its number field", () => {
    const actions = actionsFor({ kind: "issue", ref: "412", title: "#412 x" }, entries)
    expect(actions[0]).toMatchObject({ flow: "issues.view", args: "412", role: "open" })
    const names = actions.map((action) => action.flow)
    expect(names).toContain("issues.close")
    expect(names).not.toContain("prs.view")
    expect(names).not.toContain("issues.comment")
  })

  test("a box opens with box.view and its primary flow is the terminal; a run resumes on Cmd+Enter", () => {
    const box = actionsFor({ kind: "box", ref: "ws-1", title: "main" }, entries)
    expect(box.find((action) => action.role === "open")).toMatchObject({ flow: "box.view", args: "ws-1" })
    expect(box.find((action) => action.role === "primary")).toMatchObject({ flow: "box.terminal", args: "ws-1" })
    expect(box.map((action) => action.flow)).not.toContain("workspace.rename")
    const run = actionsFor({ kind: "run", ref: "run-9", title: "run-9" }, entries)
    expect(run.find((action) => action.role === "open")).toMatchObject({ flow: "runs.open", args: "run-9" })
    expect(run.find((action) => action.role === "primary")).toMatchObject({ flow: "runs.resume", args: "run-9" })
  })

  test("a flow item's one action is the flow itself; a secret name opens the secrets list and nothing more", () => {
    expect(actionsFor({ kind: "flow", ref: "flow.list", title: "flow.list" }, entries)).toEqual([
      { flow: "flow.list", label: "List the flows on your workspace", role: "open" }
    ])
    expect(actionsFor({ kind: "secret-name", ref: "NPM_TOKEN", title: "NPM_TOKEN" }, entries).map((action) => action.flow)).toEqual(["secrets.list"])
  })
})
