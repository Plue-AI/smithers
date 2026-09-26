/**
 * Role edits to the wiki: the whole-wiki grant, the protected authority and
 * configuration pages (by name, by case, through links), the host journal's
 * guard and record, the size caps, the evidence a task gets, and the
 * `wiki-edit` binding a `wiki-write` grant produces.
 */
import { Effect } from "effect"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Grants from "../src/Grants.ts"
import * as KnowledgePath from "../src/internal/knowledgePath.ts"
import * as WikiEdit from "../src/internal/wikiEdit.ts"
import type * as Profile from "../src/Profile.ts"
import * as RoleHost from "../src/RoleHost.ts"
import { baseHost, fileServices, loadSnapshot, wikiRoot } from "./dispatchSupport.ts"
import { flip, flipWith, run } from "./support.ts"

const everything = () => true

const options = (root: string, request: WikiEdit.Request, extra: Partial<WikiEdit.Options> = {}): WikiEdit.Options => ({
  root,
  principal: "docs",
  request,
  admit: everything,
  protected: [],
  maxFileBytes: 1_000,
  maxCallBytes: 100,
  ...extra
})

const refusal = async (root: string, request: WikiEdit.Request, extra: Partial<WikiEdit.Options> = {}) =>
  (await flip(WikiEdit.apply(options(root, request, extra)))).message

describe("the whole-wiki grant", () => {
  it("is exactly ./, the subtree of no segments, and covers every admissible file", () => {
    const whole = KnowledgePath.parse("./")
    expect(whole).toEqual({ ok: true, path: { kind: "subtree", segments: [] } })
    const root = (whole as { path: KnowledgePath.KnowledgePath }).path
    const file = KnowledgePath.parse("HQ.md") as { path: KnowledgePath.KnowledgePath }
    const deep = KnowledgePath.parse("Areas/Product/") as { path: KnowledgePath.KnowledgePath }
    expect(KnowledgePath.covers(root, file.path)).toBe(true)
    expect(KnowledgePath.covers(root, deep.path)).toBe(true)
    expect(KnowledgePath.covers(root, root)).toBe(true)
    expect(KnowledgePath.covers(deep.path, root)).toBe(false)
    for (const text of ["./x", ".", "./.", "/", ".//"]) expect(KnowledgePath.parse(text).ok).toBe(false)
  })

  it("lets a principal read every non-hidden page, and never widens a hire", async () => {
    const snapshot = await loadSnapshot()
    const lead = snapshot.roster.profiles.get("lead")!
    const whole: Profile.Profile = { ...lead, grants: { ...lead.grants, knowledge: ["./"] } }
    expect(Grants.canReadKnowledge(whole, "Now.md")._tag).toBe("Success")
    expect(Grants.canReadKnowledge(whole, ".git/config")._tag).toBe("Failure")
    const child = { ...lead.grants, knowledge: ["./"] }
    expect(Grants.widenings(child, lead.grants).map((found) => found.detail)).toContain(
      "knowledge ./ is not inside a parent grant"
    )
    const narrower = { ...lead.grants, knowledge: ["Areas/", "Now.md"] }
    const knowledge = (child: Profile.Grants, parent: Profile.Grants) =>
      Grants.widenings(child, parent).filter((found) => found.grant === "knowledge")
    expect(knowledge(narrower, { ...lead.grants, knowledge: ["./"] })).toEqual([])
    expect(knowledge(child, { ...lead.grants, knowledge: ["./"] })).toEqual([])
  })
})

describe("protected pages", () => {
  it("covers the fixed pages, AGENTS.md and CLAUDE.md anywhere, hidden segments, and the named ones, case-folded", () => {
    for (
      const path of [
        "Org/Roles/docs.md",
        "org/roles/docs.md",
        "ORG/Policy/Gates.md",
        "Org/Organization.md",
        "Org/Routines.md",
        "Org/Specialists/x.md",
        "Org/Common Operating Instructions.md",
        "Org/Setup/README.md",
        "AGENTS.md",
        "Areas/claude.md",
        ".github/x.md",
        "Areas/.hidden.md"
      ]
    ) expect(RoleHost.isProtectedWikiPath(path), path).toBe(true)
    for (const path of ["Org/Team/docs/Onboarding.md", "Org/Proposals/a.md", "Org/Rolesx.md", "Now.md"]) {
      expect(RoleHost.isProtectedWikiPath(path), path).toBe(false)
    }
    expect(RoleHost.isProtectedWikiPath("Wiki/Config/Page.md", ["Wiki/Config/"])).toBe(true)
    expect(RoleHost.isProtectedWikiPath("Wiki/Page.md", ["", "/"])).toBe(false)
    expect(RoleHost.isProtectedWikiPath("Org/Roles/lead.md".normalize("NFD"))).toBe(true)
  })

  it("names the pages an organization page points at", () => {
    expect(RoleHost.protectedWikiPaths({
      rosterDir: "Team/",
      skillsDir: "Team/Skills",
      casesDir: "Team/Cases/",
      policyFile: "Team/Gates.md",
      commonFile: "Team/Common.md",
      routinesFile: "Team/Routines.md",
      meetingsFile: 7
    } as never)).toEqual([
      "Org/Organization.md",
      "Team/Roles/",
      "Team/Specialists/",
      "Team/Skills/",
      "Team/Cases/",
      "Team/Gates.md",
      "Team/Routines.md",
      "Team/Common.md"
    ])
    expect(RoleHost.protectedWikiPaths({ rosterDir: "Org" }, "Config/Org.md")).toEqual([
      "Config/Org.md",
      "Org/Roles/",
      "Org/Specialists/"
    ])
    expect(RoleHost.fixedProtectedWikiPaths).toContain("Org/Roles/")
  })
})

describe("wiki edits", () => {
  it("writes, appends, and edits, creating directories, and tells the journal", async () => {
    const root = wikiRoot()
    const recorded: Array<WikiEdit.Edit> = []
    const guarded: Array<string> = []
    const journal: WikiEdit.Journal = {
      guard: (path) => Effect.sync(() => void guarded.push(path)),
      record: (edit) => Effect.sync(() => void recorded.push(edit))
    }
    const edit = (request: WikiEdit.Request) => run(WikiEdit.apply(options(root, request, { journal })))
    expect(await edit({ op: "write", path: "Org/Team/docs/Notes.md", content: "one" })).toEqual({
      principal: "docs",
      path: "Org/Team/docs/Notes.md",
      op: "write",
      bytes: 3
    })
    await edit({ op: "append", path: "Org/Team/docs/Notes.md", content: "two\n" })
    await edit({ op: "append", path: "Org/Team/docs/Notes.md", content: "three\n" })
    await edit({ op: "edit", path: "Org/Team/docs/Notes.md", oldString: "two", newString: "$& 2" })
    await edit({ op: "append", path: "Org/Team/New.md", content: "fresh\n" })
    expect(readFileSync(join(root, "Org/Team/docs/Notes.md"), "utf8")).toBe("one\n$& 2\nthree\n")
    expect(readFileSync(join(root, "Org/Team/New.md"), "utf8")).toBe("fresh\n")
    expect(recorded.map((entry) => entry.op)).toEqual(["write", "append", "append", "edit", "append"])
    expect(guarded).toEqual(Array(5).fill("Org/Team/docs/Notes.md").slice(0, 4).concat("Org/Team/New.md"))
    // Without a journal the edit still happens.
    await run(WikiEdit.apply(options(root, { op: "write", path: "Org/Team/Plain.md", content: "x" })))
    expect(readFileSync(join(root, "Org/Team/Plain.md"), "utf8")).toBe("x")
  })

  it("refuses its own role page by name, by case, through a file link, a directory link, and a missing directory under one", async () => {
    const root = wikiRoot()
    mkdirSync(join(root, "Org", "Team"))
    symlinkSync(join(root, "Org", "Roles", "lead.md"), join(root, "Org", "Team", "lead.md"))
    symlinkSync(join(root, "Org", "Roles"), join(root, "Org", "Team", "roles"))
    const write = (path: string) => refusal(root, { op: "write", path, content: "grants: everything" })
    expect(await write("Org/Roles/lead.md")).toContain("is an authority or configuration page")
    expect(await write("org/roles/lead.md")).toContain("is an authority or configuration page")
    expect(await write("Org/Team/lead.md")).toBe("resolves to an authority or configuration page")
    expect(await write("Org/Team/roles/lead.md")).toBe("resolves to an authority or configuration page")
    expect(await write("Org/Team/roles/new/lead.md")).toBe("resolves to an authority or configuration page")
    expect(await write("Org/roles/../Roles/lead.md")).toBe("is not a relative Markdown wiki file path")
    expect(await write("Org/./Roles/lead.md")).toBe("is not a relative Markdown wiki file path")
    expect(await write("AGENTS.md")).toContain("is an authority or configuration page")
    expect((await run(WikiEdit.apply(options(root, { op: "write", path: "Org/Team/x.md", content: "x" })))).path).toBe(
      "Org/Team/x.md"
    )
    expect(readFileSync(join(root, "Org", "Roles", "lead.md"), "utf8")).toContain("id: lead")
    expect(await refusal(root, { op: "write", path: "Areas/Page.md", content: "x" }, { protected: ["Areas/"] }))
      .toContain("is an authority or configuration page")
  })

  it("refuses ungranted, escaping, malformed, oversized and conflicting edits", async () => {
    const root = wikiRoot()
    const outside = wikiRoot()
    mkdirSync(join(root, "Areas"))
    writeFileSync(join(root, "Areas", "Big.md"), "x".repeat(2_000))
    writeFileSync(join(root, "Areas", "Twice.md"), "a a")
    mkdirSync(join(root, "Areas", "Folder.md"))
    mkdirSync(join(root, "Secret"))
    writeFileSync(join(root, "Secret", "Plan.md"), "secret")
    symlinkSync(join(root, "Secret", "Plan.md"), join(root, "Areas", "Plan.md"))
    symlinkSync(join(root, "Secret", "Plan.md"), join(root, "Areas", "Plan.txt.md"))
    symlinkSync(join(outside, "Org"), join(root, "Areas", "Away"))
    symlinkSync(join(outside, "Org", "Roles", "lead.md"), join(root, "Areas", "Away.md"))
    const areasOnly = { admit: (path: string) => path.startsWith("Areas/") }
    expect(await refusal(root, { op: "write", path: "Areas/page.txt", content: "x" })).toBe(
      "is not a relative Markdown wiki file path"
    )
    expect(await refusal(root, { op: "write", path: "Areas/", content: "x" })).toBe(
      "is not a relative Markdown wiki file path"
    )
    expect(await refusal(root, { op: "write", path: "Now.md", content: "x" }, areasOnly)).toBe("is not granted")
    expect(await refusal(root, { op: "write", path: "Areas/Plan.md", content: "x" }, areasOnly)).toBe(
      "resolves to a path that is not granted"
    )
    expect(await refusal(root, { op: "write", path: "Areas/Away/x.md", content: "x" })).toBe(
      "resolves outside the wiki root"
    )
    expect(await refusal(root, { op: "write", path: "Areas/Away.md", content: "x" })).toBe(
      "resolves outside the wiki root"
    )
    expect(await refusal(root, { op: "write", path: "Areas/New.md" })).toBe("write needs content")
    expect(await refusal(root, { op: "edit", path: "Areas/New.md", newString: "x" })).toBe(
      "an edit needs oldString and newString"
    )
    expect(await refusal(root, { op: "edit", path: "Areas/New.md", oldString: "a" })).toBe(
      "an edit needs oldString and newString"
    )
    expect(await refusal(root, { op: "write", path: "Areas/New.md", content: "é".repeat(51) })).toBe(
      "one call writes at most 100 bytes"
    )
    expect(await refusal(root, { op: "append", path: "Areas/Big.md", content: "x" })).toBe("is over 1000 bytes")
    expect(await refusal(root, { op: "append", path: "Areas/Folder.md", content: "x" })).toBe("is not a regular file")
    expect(await refusal(root, { op: "edit", path: "Areas/Twice.md", oldString: "b", newString: "c" })).toBe(
      "does not contain oldString"
    )
    expect(await refusal(root, { op: "edit", path: "Areas/Twice.md", oldString: "a", newString: "c" })).toBe(
      "contains oldString more than once"
    )
    expect(await refusal(root, { op: "write", path: "Areas/New.md", content: "x".repeat(100) }, { maxFileBytes: 50 }))
      .toBe(
        "would be over 50 bytes"
      )
    const journal: WikiEdit.Journal = {
      guard: () => Effect.fail("has uncommitted changes the host did not make"),
      record: () => Effect.void
    }
    expect(await refusal(root, { op: "write", path: "Areas/Twice.md", content: "x" }, { journal })).toBe(
      "has uncommitted changes the host did not make"
    )
    expect(readFileSync(join(root, "Areas", "Twice.md"), "utf8")).toBe("a a")
  })

  it("names the filesystem step that failed", async () => {
    const root = wikiRoot()
    mkdirSync(join(root, "Areas"))
    writeFileSync(join(root, "Areas", "Page.md"), "page")
    const edit = (path = "Areas/Page.md") => WikiEdit.apply(options(root, { op: "append", path, content: "x" }))
    const failed = async (fault: (method: string, path: string) => boolean, path?: string) =>
      (await flipWith(edit(path), fault)).message
    expect(await failed((method, path) => method === "realPath" && path === root)).toBe(
      "the wiki root could not be resolved"
    )
    expect(await failed((method, path) => method === "exists" && path.endsWith("Areas"))).toBe("could not be checked")
    expect(await failed((method, path) => method === "realPath" && path.endsWith("Areas"))).toBe(
      "could not be resolved"
    )
    expect(await failed((method, path) => method === "exists" && path.endsWith("Page.md"))).toBe("could not be checked")
    expect(await failed((method, path) => method === "realPath" && path.endsWith("Page.md"))).toBe(
      "could not be resolved"
    )
    expect(await failed((method) => method === "stat")).toBe("could not be read")
    expect(await failed((method) => method === "readFileString")).toBe("could not be read")
    expect(await failed((method) => method === "makeDirectory", "Areas/Deep/New.md")).toBe(
      "a directory could not be created"
    )
    expect(await failed((method) => method === "writeFileString")).toBe("could not be written")
    expect(await failed((method) => method === "rename")).toBe("could not be renamed into place")
  })

  it("becomes file evidence on a role result, and leaves anything else alone", () => {
    const result = { status: "done", evidence: [{ kind: "note", ref: "n", detail: "" }] }
    const edit: WikiEdit.Edit = { principal: "docs", path: "Org/Team/a.md", op: "append", bytes: 3 }
    expect(WikiEdit.withEvidence(result, [edit]).evidence).toEqual([
      { kind: "note", ref: "n", detail: "" },
      { kind: "file", ref: "Org/Team/a.md", detail: "wiki-edit append by docs: 3 bytes" }
    ])
    expect(WikiEdit.withEvidence(result, [])).toBe(result)
    expect(WikiEdit.withEvidence("text", [edit])).toBe("text")
  })
})

describe("the wiki-edit binding", () => {
  const profiles = async () => {
    const snapshot = await loadSnapshot()
    const lead = snapshot.roster.profiles.get("lead")!
    return {
      ...lead,
      grants: { ...lead.grants, tools: ["wiki-read", "wiki-write"], knowledge: ["./"] }
    } as Profile.Profile
  }

  it("binds wiki-edit with its notice for wiki-write, and refuses a host with no wiki", async () => {
    const profile = await profiles()
    const root = wikiRoot()
    const built = await Effect.runPromise(RoleHost.make({
      base: baseHost,
      system: ["Composed."],
      executionId: "run-1",
      profile,
      resources: { wiki: { root, services: fileServices } }
    }))
    expect(built.flows).toEqual(["wiki-edit", "wiki-read"])
    expect(built.host.system).toContain(RoleHost.wikiEditNotice)
    const exit = await Effect.runPromise(Effect.exit(RoleHost.make({
      base: baseHost,
      system: [],
      executionId: "run-1",
      profile: { ...profile, grants: { ...profile.grants, tools: ["wiki-write"] } },
      resources: {}
    })))
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain(
      "lead holds wiki-write, and this host configured no wiki"
    )
  })

  it("edits a granted page, logs it for the evidence, and refuses its own role page", async () => {
    const profile = await profiles()
    const root = wikiRoot()
    const logged: Array<RoleHost.WikiEdited> = []
    const call = async (input: unknown, log = true) => {
      const source = RoleHost.wikiEdit(
        profile,
        { root, services: fileServices, protected: ["Org/Team/Locked/"], maxEditBytes: 10, maxBytes: 100 },
        log ? { record: (edit) => Effect.sync(() => void logged.push(edit)) } : undefined
      )
      const [binding] = await Effect.runPromise(source.bindings())
      return Effect.runPromise(binding!.run({ identity: "c1", flow: RoleHost.wikiEditName, input } as never))
    }
    const done = await call({ op: "write", path: "Org/Team/lead/Notes.md", content: "hello" })
    expect(done.outcome).toBe("success")
    expect(JSON.stringify(done.value)).toContain("\"bytes\":5")
    expect((await call({ op: "append", path: "Org/Team/lead/Notes.md", content: "!" }, false)).outcome).toBe("success")
    expect(logged).toEqual([{ principal: "lead", path: "Org/Team/lead/Notes.md", op: "write", bytes: 5 }])
    expect(JSON.stringify(await call({ op: "write", path: "Org/Roles/lead.md", content: "x" }))).toContain(
      "Org/Roles/lead.md is an authority or configuration page"
    )
    expect(JSON.stringify(await call({ op: "write", path: "Org/Team/Locked/a.md", content: "x" }))).toContain(
      "is an authority or configuration page"
    )
    expect(JSON.stringify(await call({ op: "write", path: "Org/Team/a.md", content: "x".repeat(11) }))).toContain(
      "one call writes at most 10 bytes"
    )
    expect(readFileSync(join(root, "Org/Team/lead/Notes.md"), "utf8")).toBe("hello\n!")
    // With the host's defaults: 64 KiB a call, 256 KiB a page, the fixed protected pages.
    const [plain] = await Effect.runPromise(
      RoleHost.wikiEdit(profile, { root, services: fileServices }, undefined).bindings()
    )
    const wrote = await Effect.runPromise(
      plain!.run(
        {
          identity: "c2",
          flow: RoleHost.wikiEditName,
          input: { op: "write", path: "Org/Team/b.md", content: "x".repeat(20_000) }
        } as never
      )
    )
    expect(wrote.outcome).toBe("success")
  })
})
