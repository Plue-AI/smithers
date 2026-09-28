import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")

/** Prose paragraphs with fenced code removed and line wrapping collapsed. */
const paragraphs = (markdown: string): ReadonlyArray<string> =>
  markdown.replace(/^```[\s\S]*?^```/gm, "").split(/\n\s*\n/).map((paragraph) => paragraph.replace(/\s+/g, " ").trim())

/** Level-two headings, in order, outside fenced code. */
const sections = (markdown: string): ReadonlyArray<string> =>
  Array.from(markdown.replace(/^```[\s\S]*?^```/gm, "").matchAll(/^## (.+)$/gm), ([, title]) => title!)

/** GitHub and Starlight anchor slug of a heading. */
const slug = (heading: string): string => heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-")

/** Barrel-exported modules whose source calls a journal write method. */
const journalWriters = Array.from(
  read("src/index.ts").matchAll(/export \* as (\w+) from "\.\/(\w+)\.ts"/g),
  ([, name]) => name!
).filter((name) => /\.(?:emitLossy|emitDurable|emitDurableUnfenced|checkpoint|compact)\(/.test(read(`src/${name}.ts`)))

describe("README layout", () => {
  it("keeps License as the closing section", () => {
    expect(sections(read("README.md")).at(-1)).toBe("License")
  })

  it("states the rewind contract next to the other contracts, before the API table", () => {
    const titles = sections(read("README.md"))
    expect(titles).toContain("Rewinds and cursor generations")
    expect(titles.indexOf("Rewinds and cursor generations")).toBeLessThan(titles.indexOf("Public API"))
  })
})

describe("read-only claim", () => {
  it("finds the journal writers the overviews must name", () => {
    expect(journalWriters).not.toHaveLength(0)
  })

  it.each(["README.md", "docs/README.md"])("%s scopes it to the sync read surface and names every writer", (page) => {
    const claims = paragraphs(read(page)).filter((paragraph) => paragraph.includes("cannot corrupt"))
    expect(claims).toHaveLength(1)
    const claim = claims[0]!
    expect(claim).not.toMatch(/nothing in this package|outside this package/i)
    for (const surface of ["SyncRpcs", "SyncClient", ...journalWriters]) expect(claim).toContain(`\`${surface}\``)
  })
})

describe("scopes and cursors", () => {
  const page = read("docs/concepts/scopes-and-cursors.md")

  it("defines RunCursor with its generation", () => {
    const definition = paragraphs(page).find((paragraph) => paragraph.startsWith("`RunCursor` is"))
    expect(definition).toContain("generation")
  })

  it("links the rewind contract to a heading the API reference carries", () => {
    const anchors = Array.from(page.matchAll(/\]\(\.\.\/api\.md#([a-z0-9-]+)\)/g), ([, anchor]) => anchor!)
    expect(anchors).toContain("rewind-generations")
    const headings = Array.from(read("docs/api.md").matchAll(/^#{2,6} (.+)$/gm), ([, heading]) => slug(heading!))
    for (const anchor of anchors) expect(headings).toContain(anchor)
  })
})

describe("keyring failure codes", () => {
  const guide = read("docs/guides/authorize-a-connection.md")
  const keyringParagraphs = paragraphs(guide).filter((paragraph) => /keyring|Web Crypto/.test(paragraph))

  it("names the code importHmacKey uses for a rejected secret", () => {
    const signer = read("src/internal/ShareSigner.ts")
    const importer = signer.slice(signer.indexOf("export const importHmacKey"))
    const importCode = /catch: \(cause\) =>\s+new SyncError\(\{\s+code: "(\w+)"/.exec(importer)![1]!
    expect(importCode).toBe("unknown")
    const cryptoFailure = keyringParagraphs.find((paragraph) =>
      /Web Crypto/.test(paragraph) && /fails? with/.test(paragraph)
    )
    expect(cryptoFailure).toContain(`\`${importCode}\``)
  })

  it("does not claim every keyring failure is invalid_request", () => {
    for (const paragraph of keyringParagraphs) expect(paragraph).not.toMatch(/Each fails with `invalid_request`/)
  })
})

describe("copyable secret reads", () => {
  const pages = ["docs/guides/authorize-a-connection.md", "docs/concepts/authorization.md", "docs/troubleshooting.md"]

  it.each(pages)("%s never reads a secret with a non-null assertion", (page) => {
    // `Redacted.make(process.env[...]!)` passes `undefined` when the variable
    // is unset, and the authority then refuses it as an unpaired surrogate:
    // closed, but with a diagnosis that sends the operator the wrong way.
    expect(read(page)).not.toMatch(/process\.env\[[^\]]+\]!/)
  })

  it("states how the rotation snippet fails on an unset variable", () => {
    const guide = read("docs/guides/authorize-a-connection.md")
    expect(guide).toContain("Config.Redacted(\"SYNC_SECRET_CURRENT\")")
    expect(paragraphs(guide).some((paragraph) => /unset variable fails .*`ConfigError`/.test(paragraph))).toBe(true)
  })
})

describe("branch server authorization", () => {
  const server = read("src/BranchServer.ts")
  /** Procedures whose handler body raises its own SyncError or inspects the principal. */
  const handlers = Array.from(server.matchAll(/^ {6}"(Branch\.\w+)": /gm), (match) => [match[1]!, match.index] as const)
  const enforcing = handlers
    .map(([name, start], index) => [name, server.slice(start, handlers[index + 1]?.[1])] as const)
    .filter(([, body]) => /new SyncError|SyncPrincipal\.isWorkspace/.test(body))
    .map(([name]) => name)

  it("finds the handlers that enforce adapter policy", () => {
    expect(enforcing).toEqual(["Branch.CreateBranch", "Branch.MintShare"])
  })

  it.each(["src/BranchServer.ts", "docs/concepts/branches.md"])("%s does not deny the adapter's own checks", (file) => {
    expect(read(file)).not.toMatch(/no authorization logic/)
    expect(read(file)).not.toMatch(/face (?:exactly )?the same rules/)
  })

  it("names every enforcing procedure where the concept page describes the wire group", () => {
    const page = read("docs/concepts/branches.md")
    const wireGroup = page.slice(page.indexOf("## The wire group"), page.indexOf("## Related pages"))
    for (const name of enforcing) expect(wireGroup).toContain(`\`${name}\``)
    expect(wireGroup).toMatch(/in-process/)
  })
})
