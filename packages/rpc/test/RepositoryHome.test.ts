import { describe, expect, it, test } from "vitest"
import { RepositoryHomeBlockSchema, RepositoryHomeSchema } from "../src/RepositoryHome.ts"

describe("resolved repository homepage blocks (unit)", () => {
  test.each([
    { type: "prompt" },
    { type: "prompt", flow: "create-flow/design", title: "Create a flow", placeholder: "What should it do?" },
    { type: "app", flow: "review", title: "Review", picture: "review" },
    { type: "flows" },
    { type: "flows", title: "Flows" },
    { type: "markdown", path: "docs/start.md", markdown: "# Start", title: "Start" },
    { type: "text", text: "Ready", title: "Status" },
    { type: "stack" },
    { type: "stack", title: "Changes" },
    { type: "links", title: "Docs", links: [{ label: "Guide", url: "https://example.com/guide" }] }
  ])("decodes the resolved block without changing its presentation: %j", (block) => {
    expect(RepositoryHomeBlockSchema.parse(block)).toEqual(block)
  })

  test.each(["issue", "review", "wiki", "schedule"])("decodes app picture %s", (picture) => {
    expect(RepositoryHomeBlockSchema.parse({ type: "app", flow: "review", title: "Review", picture }))
      .toEqual({ type: "app", flow: "review", title: "Review", picture })
  })

  test.each([
    undefined,
    null,
    {},
    { type: "ci-benchmark" },
    { type: "app", flow: "review", title: "Review", picture: "terminal" },
    { type: "app", title: "Review", picture: "review" },
    { type: "app", flow: "review", picture: "review" },
    { type: "markdown", path: "README.md" },
    { type: "markdown", markdown: "# Start" },
    { type: "text" },
    { type: "links" }
  ])("rejects unknown or incomplete block %j", (block) => {
    expect(RepositoryHomeBlockSchema.safeParse(block).success).toBe(false)
  })

  test.each(["review", "create-flow/design", "history.fold", "ci/check_1", "1-review"])(
    "preserves a catalog flow id %s in prompt and app blocks",
    (flow) => {
      expect(RepositoryHomeBlockSchema.parse({ type: "prompt", flow })).toEqual({ type: "prompt", flow })
      expect(RepositoryHomeBlockSchema.parse({ type: "app", flow, title: "Run", picture: "schedule" }))
        .toEqual({ type: "app", flow, title: "Run", picture: "schedule" })
    }
  )

  test.each(["", "/review", "review/", "history..fold", "ci//check", "Review", "review flow", null, 1])(
    "rejects malformed flow id %s in prompt and app blocks",
    (flow) => {
      expect(RepositoryHomeBlockSchema.safeParse({ type: "prompt", flow }).success).toBe(false)
      expect(RepositoryHomeBlockSchema.safeParse({ type: "app", flow, title: "Run", picture: "review" }).success)
        .toBe(false)
    }
  )

  test.each([
    { type: "prompt" },
    { type: "app", flow: "review", picture: "review" },
    { type: "flows" },
    { type: "markdown", path: "README.md", markdown: "" },
    { type: "text", text: "Ready" },
    { type: "stack" },
    { type: "links", links: [{ label: "Docs", url: "https://example.com" }] }
  ])("enforces one to 120 characters for titles on %j", (block) => {
    for (const title of ["R", "R".repeat(120)]) {
      expect(RepositoryHomeBlockSchema.parse({ ...block, title })).toEqual({ ...block, title })
    }
    for (const title of ["", "R".repeat(121), null, 1]) {
      expect(RepositoryHomeBlockSchema.safeParse({ ...block, title }).success).toBe(false)
    }
  })

  test("bounds prompt placeholders independently of the optional title", () => {
    expect(RepositoryHomeBlockSchema.parse({ type: "prompt", placeholder: "R".repeat(120) }))
      .toEqual({ type: "prompt", placeholder: "R".repeat(120) })
    for (const placeholder of ["", "R".repeat(121), null, 1]) {
      expect(RepositoryHomeBlockSchema.safeParse({ type: "prompt", placeholder }).success).toBe(false)
    }
  })

  test.each([
    { title: "界".repeat(120), utf16Length: 120, utf8Length: 360 },
    { title: "😀".repeat(120), utf16Length: 240, utf8Length: 480 },
    { title: "e\u0301".repeat(60), utf16Length: 120, utf8Length: 180 }
  ])(
    "bounds Unicode titles and placeholders by 120 code points",
    ({ title, utf16Length, utf8Length }) => {
      expect(title).toHaveLength(utf16Length)
      expect([...title]).toHaveLength(120)
      expect(new TextEncoder().encode(title)).toHaveLength(utf8Length)
      expect(RepositoryHomeBlockSchema.parse({ type: "prompt", title, placeholder: title }))
        .toEqual({ type: "prompt", title, placeholder: title })
      expect(RepositoryHomeBlockSchema.safeParse({ type: "prompt", title: title + "R" }).success).toBe(false)
      expect(RepositoryHomeBlockSchema.safeParse({ type: "prompt", placeholder: title + "R" }).success).toBe(false)
    }
  )

  test("accepts text at one and 4096 characters and refuses empty or oversized text", () => {
    for (const text of ["R", "R".repeat(4096)]) {
      expect(RepositoryHomeBlockSchema.parse({ type: "text", text })).toEqual({ type: "text", text })
    }
    for (const text of ["", "R".repeat(4097), null, 1]) {
      expect(RepositoryHomeBlockSchema.safeParse({ type: "text", text }).success).toBe(false)
    }
  })
})

describe("resolved homepage markdown paths (unit)", () => {
  test.each(["README.md", "docs/start.md", "docs/Getting Started.md", ".smithers/home.md", "docs/入門.md"])(
    "preserves safe repository-relative path %s",
    (path) => {
      expect(RepositoryHomeBlockSchema.parse({ type: "markdown", path, markdown: "# Start" }))
        .toEqual({ type: "markdown", path, markdown: "# Start" })
    }
  )

  test.each([
    "",
    "/README.md",
    "//README.md",
    "docs\\README.md",
    "README.md?raw=1",
    "README.md#start",
    "https:README.md",
    "%2e%2e/README.md",
    "docs/%2f/README.md",
    "README\u0000.md",
    "README\u001f.md",
    "docs\n/README.md",
    ".",
    "..",
    "./README.md",
    "../README.md",
    "docs/./README.md",
    "docs/../README.md",
    "docs//README.md",
    "docs/",
    null,
    1
  ])("rejects unsafe or malformed repository path %j", (path) => {
    expect(RepositoryHomeBlockSchema.safeParse({ type: "markdown", path, markdown: "# Start" }).success).toBe(false)
  })

  test("bounds the path at 1024 characters", () => {
    const path = ["docs", ...Array.from({ length: 4 }, () => "r".repeat(250)), "r".repeat(12) + ".md"].join("/")
    expect(path).toHaveLength(1024)
    expect(RepositoryHomeBlockSchema.parse({ type: "markdown", path, markdown: "" }))
      .toEqual({ type: "markdown", path, markdown: "" })
    expect(RepositoryHomeBlockSchema.safeParse({ type: "markdown", path: path + "r", markdown: "" }).success).toBe(
      false
    )
  })
})

describe("resolved homepage links (unit)", () => {
  test("preserves ordered HTTP and HTTPS links and their labels", () => {
    expect(RepositoryHomeBlockSchema.parse({
      type: "links",
      links: [
        { label: "Guide", url: "https://example.com/guide?version=1#start" },
        { label: "Local docs", url: "http://localhost:8080/docs" }
      ]
    })).toEqual({
      type: "links",
      links: [
        { label: "Guide", url: "https://example.com/guide?version=1#start" },
        { label: "Local docs", url: "http://localhost:8080/docs" }
      ]
    })
  })

  test.each([
    "HTTP://example.com/guide",
    "HTTPS://example.com/guide",
    "HtTp://example.com/guide",
    "HtTpS://example.com/guide"
  ])("accepts case-insensitive HTTP(S) scheme and preserves the link URL %s", (url) => {
    expect(RepositoryHomeBlockSchema.parse({ type: "links", links: [{ label: "Guide", url }] }))
      .toEqual({ type: "links", links: [{ label: "Guide", url }] })
  })

  test.each([
    "ftp://example.com/guide",
    "file:///etc/passwd",
    "mailto:will@example.com",
    "javascript:alert(1)",
    "/guide",
    "example.com/guide",
    "https://",
    "",
    null,
    1
  ])("rejects unsupported or malformed link URL %s", (url) => {
    const result = RepositoryHomeBlockSchema.safeParse({ type: "links", links: [{ label: "Guide", url }] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(new Set(result.error.issues.map((issue) => issue.path.join(".")))).toEqual(new Set(["links.0.url"]))
    }
  })

  test("requires at least one complete link", () => {
    for (const links of [[], null, {}, [{ url: "https://example.com" }], [{ label: "Guide" }]]) {
      expect(RepositoryHomeBlockSchema.safeParse({ type: "links", links }).success).toBe(false)
    }
  })

  test("bounds each link label at one to 120 characters", () => {
    for (const label of ["R", "R".repeat(120)]) {
      expect(RepositoryHomeBlockSchema.parse({ type: "links", links: [{ label, url: "https://example.com" }] }))
        .toEqual({ type: "links", links: [{ label, url: "https://example.com" }] })
    }
    for (const label of ["", "R".repeat(121), null, 1]) {
      expect(
        RepositoryHomeBlockSchema.safeParse({ type: "links", links: [{ label, url: "https://example.com" }] }).success
      )
        .toBe(false)
    }
  })

  test("rejects one invalid link after a valid link instead of dropping it", () => {
    const result = RepositoryHomeBlockSchema.safeParse({
      type: "links",
      links: [{ label: "Guide", url: "https://example.com" }, { label: "Local file", url: "file:///etc/passwd" }]
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([["links", 1, "url"]])
  })
})

describe("homepage resolution envelopes (unit)", () => {
  test("decodes no-home, empty README, and ordered resolved blocks", () => {
    expect(RepositoryHomeSchema.parse({ kind: "none" })).toEqual({ kind: "none" })
    expect(RepositoryHomeSchema.parse({ kind: "readme", markdown: "" })).toEqual({ kind: "readme", markdown: "" })
    expect(RepositoryHomeSchema.parse({
      kind: "blocks",
      blocks: [{ type: "prompt" }, { type: "markdown", path: "docs/start.md", markdown: "# Start" }, { type: "stack" }]
    })).toEqual({
      kind: "blocks",
      blocks: [{ type: "prompt" }, { type: "markdown", path: "docs/start.md", markdown: "# Start" }, { type: "stack" }]
    })
  })

  test.each([0, 1, 32])("accepts %s resolved blocks", (count) => {
    const blocks = Array.from({ length: count }, () => ({ type: "stack" }))
    expect(RepositoryHomeSchema.parse({ kind: "blocks", blocks })).toEqual({ kind: "blocks", blocks })
  })

  test("refuses the 33rd block and an invalid nested block", () => {
    expect(
      RepositoryHomeSchema.safeParse({ kind: "blocks", blocks: Array.from({ length: 33 }, () => ({ type: "stack" })) })
        .success
    )
      .toBe(false)
    const result = RepositoryHomeSchema.safeParse({
      kind: "blocks",
      blocks: [{ type: "stack" }, { type: "text", text: "" }]
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([["blocks", 1, "text"]])
  })

  test("bounds README and block markdown at 262144 Unicode code points", () => {
    for (const markdown of ["", "m".repeat(256 * 1024)]) {
      expect(RepositoryHomeSchema.parse({ kind: "readme", markdown })).toEqual({ kind: "readme", markdown })
      expect(RepositoryHomeBlockSchema.parse({ type: "markdown", path: "README.md", markdown }))
        .toEqual({ type: "markdown", path: "README.md", markdown })
    }
    for (const markdown of ["m".repeat(256 * 1024 + 1), null, 1]) {
      expect(RepositoryHomeSchema.safeParse({ kind: "readme", markdown }).success).toBe(false)
      expect(RepositoryHomeBlockSchema.safeParse({ type: "markdown", path: "README.md", markdown }).success).toBe(false)
    }
  })

  test.each([
    { markdown: "界".repeat(262144), utf16Length: 262144, utf8Length: 786432 },
    { markdown: "😀".repeat(262144), utf16Length: 524288, utf8Length: 1048576 },
    { markdown: "e\u0301".repeat(131072), utf16Length: 262144, utf8Length: 393216 }
  ])(
    "measures Unicode markdown by code points",
    ({ markdown, utf16Length, utf8Length }) => {
      expect(markdown).toHaveLength(utf16Length)
      expect([...markdown]).toHaveLength(262144)
      expect(new TextEncoder().encode(markdown)).toHaveLength(utf8Length)
      expect(RepositoryHomeSchema.parse({ kind: "readme", markdown })).toEqual({ kind: "readme", markdown })
      expect(RepositoryHomeBlockSchema.parse({ type: "markdown", path: "README.md", markdown }))
        .toEqual({ type: "markdown", path: "README.md", markdown })
      expect(RepositoryHomeSchema.safeParse({ kind: "readme", markdown: markdown + "R" }).success).toBe(false)
      expect(
        RepositoryHomeBlockSchema.safeParse({ type: "markdown", path: "README.md", markdown: markdown + "R" }).success
      )
        .toBe(false)
    }
  )

  test.each([undefined, null, {}, { kind: "unknown" }, { kind: "readme" }, { kind: "blocks" }, {
    kind: "blocks",
    blocks: {}
  }])(
    "rejects malformed resolution envelope %j",
    (home) => {
      expect(RepositoryHomeSchema.safeParse(home).success).toBe(false)
    }
  )
})

describe("resolved homepage links", () => {
  const decode = (url: string) =>
    RepositoryHomeSchema.safeParse({
      kind: "blocks",
      blocks: [{ type: "links", links: [{ label: "Guide", url }] }]
    })

  it("preserves HTTP(S) scheme casing", () => {
    for (const scheme of ["HTTP", "HTTPS", "HtTp", "HtTpS"]) {
      const url = `${scheme}://example.com/guide`
      const result = decode(url)
      expect(result.success).toBe(true)
      if (result.success && result.data.kind === "blocks") {
        expect(result.data.blocks[0]).toEqual({ type: "links", links: [{ label: "Guide", url }] })
      }
    }
  })

  it("refuses unsupported schemes and malformed links", () => {
    for (
      const url of [
        "ftp://example.com/guide",
        "file:///guide",
        "mailto:x@example.com",
        "javascript:alert(1)",
        "https://",
        "HtTp://",
        "/relative"
      ]
    ) expect(decode(url).success).toBe(false)
  })
})
