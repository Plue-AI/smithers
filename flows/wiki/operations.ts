/** Files, hashing and publication checks use injected Effect platform services. */
import { canonical } from "@smthrs/core/Digest"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { reviewEvidence, visibleLine } from "./evidence.ts"
import type { Provenance } from "./reuse.ts"
import { type PageSpec, type Receipt, type ReviewedPage, WikiError } from "./schema.ts"

const maxFileBytes = 512_000
const maxPageBytes = 300_000
const assessmentPolicy = "exact-single-line-ascii-boundary-trim-v1"
const fail = (code: WikiError["code"], message: string) => new WikiError({ code, message })
export const digest = (text: string) =>
  Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(text))
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")
  })
const safePath = (value: string) => {
  if (
    !/^[A-Za-z0-9_./@-]+$/.test(value) || value.startsWith("/") ||
    value.split("/").some((part) => part === "." || part === ".." || part === "")
  ) {
    throw fail("invalid-input", `Expected a repository-relative source path: ${value}`)
  }
  if (/^(?:\.git|\.jj|\.flows|node_modules|Smithers-Ops)(?:\/|$)/i.test(value) || /(?:^|\/)\.env(?:\.|$)/.test(value)) {
    throw fail("invalid-input", `Private/runtime path is not a wiki input: ${value}`)
  }
  return value
}

/** Heading sections keep the review obligation small and explicit. */
export const sections = (markdown: string) => {
  const result: Array<{ id: string; markdown: string }> = []
  let lines: Array<string> = [], fence = false
  const flush = () => {
    if (lines.join("\n").trim()) result.push({ id: `section-${result.length + 1}`, markdown: lines.join("\n").trim() })
    lines = []
  }
  for (const line of markdown.split("\n")) {
    if (/^```/.test(line)) fence = !fence
    if (!fence && /^#{1,3} /.test(line)) flush()
    lines.push(line)
  }
  flush()
  return result
}

export const operations = (
  options: {
    readonly root: string
    readonly output: string
    readonly fs?: FileSystem.FileSystem | undefined
    /** Host policy is reevaluated at publication, after potentially slow review. */
    readonly publicationRoot?: Effect.Effect<string, Error, FileSystem.FileSystem | Path.Path> | undefined
  }
) => {
  // Native action execution may replace construction-time context services.
  // A host-owned recipe can retain its explicitly injected filesystem here;
  // canonical source/output boundaries below still apply to every operation.
  const read = (relative: string) =>
    Effect.gen(function*() {
      const fs = options.fs ?? (yield* FileSystem.FileSystem), path = yield* Path.Path
      const root = yield* fs.realPath(options.root)
      const name = yield* Effect.try({ try: () => safePath(relative), catch: (error) => error as WikiError })
      const file = yield* fs.realPath(path.resolve(root, name))
      if (!file.startsWith(root + path.sep)) {
        return yield* Effect.fail(fail("invalid-input", `Source escapes repository: ${relative}`))
      }
      const stat = yield* fs.stat(file)
      if (stat.type !== "File" || stat.size > BigInt(maxFileBytes)) {
        return yield* Effect.fail(fail("invalid-input", `Source is not a bounded text file: ${relative}`))
      }
      const text = yield* fs.readFileString(file)
      if (text.includes("\0")) {
        return yield* Effect.fail(fail("invalid-input", `Binary source is not a wiki input: ${relative}`))
      }
      return { path: relative, digest: yield* digest(text), text }
    })
  const collect = (spec: PageSpec) =>
    Effect.gen(function*() {
      if (!/^[a-z][a-z0-9-]{0,80}$/.test(spec.id)) {
        return yield* Effect.fail(fail("invalid-input", "Invalid wiki page id"))
      }
      const names = [...new Set([spec.document, ...spec.inputs])].sort()
      const sources = yield* Effect.forEach(names, read)
      if (sources.reduce((total, source) => total + new TextEncoder().encode(source.text).length, 0) > maxPageBytes) {
        return yield* Effect.fail(
          fail(
            "invalid-input",
            `Page evidence exceeds ${maxPageBytes} bytes: ${spec.id}; split the page or narrow its owning files`
          )
        )
      }
      const markdown = sources.find((source) =>
        source.path === spec.document
      )!.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim() + "\n"
      const contentDigest = yield* digest(markdown)
      const inputDigest = yield* digest(
        canonical({ policy: 2, spec, sources: sources.map(({ path, digest }) => ({ path, digest })) })
      )
      const evidence = { spec, sources, markdown, contentDigest, inputDigest, sections: sections(markdown) }
      yield* Effect.try({ try: () => reviewEvidence(evidence), catch: (error) => error as WikiError })
      return evidence
    })
  const assess = (page: ReviewedPage) =>
    Effect.gen(function*() {
      if (page.review === null) return page
      const expected = page.evidence.sections.map((section) => section.id)
      if (JSON.stringify(page.review.sections.map((section) => section.id)) !== JSON.stringify(expected)) {
        return yield* Effect.fail(
          fail("review-failed", `Review must assess every section exactly once: ${page.evidence.spec.id}`)
        )
      }
      const invalidCitations: Array<{ section: string; path: string; line: number; quote: string }> = []
      let invalidCitationCount = 0
      for (const section of page.review.sections) {
        if (!section.explanation.trim()) {
          return yield* Effect.fail(fail("review-failed", "Review explanations cannot be empty"))
        }
        if (section.verdict === "supported" && section.citations.length === 0) {
          return yield* Effect.fail(fail("review-failed", "Supported sections require source citations"))
        }
        if (
          section.verdict === "supported" && page.evidence.spec.kind === "current" &&
          !section.citations.some((citation) => citation.path !== page.evidence.spec.document)
        ) {
          return yield* Effect.fail(
            fail("review-failed", "Current behavior cannot be verified by citing only its own explanation")
          )
        }
        for (const citation of section.citations) {
          const source = page.evidence.sources.find((entry) => entry.path === citation.path)
          const lines = source?.text.split("\n") ?? []
          // Preserve the raw receipt. Boundary padding is not part of the selected
          // fragment; interior bytes, the source line and excerpt must stay exact.
          const fragment = citation.quote.replace(/^[ \t]+|[ \t]+$/g, "")
          if (
            !source || !Number.isSafeInteger(citation.line) || citation.line < 1 || citation.line > lines.length ||
            !fragment || /[\r\n]/.test(fragment) || !lines[citation.line - 1]!.includes(fragment) ||
            !visibleLine(page.evidence, citation.path, citation.line)
          ) {
            invalidCitationCount++
            if (invalidCitations.length < 24) {
              invalidCitations.push({
                section: section.id.slice(0, 80),
                path: citation.path.slice(0, 320),
                line: citation.line,
                quote: citation.quote.slice(0, 320)
              })
            }
          }
        }
      }
      // One bounded repair needs all detected problems, not just the first one.
      // The original review remains unchanged; no inferred replacement is supplied.
      if (invalidCitationCount) {
        return yield* Effect.fail(
          fail(
            "review-failed",
            `Review citation is not exact source evidence: ${page.evidence.spec.id}/${invalidCitations[0]!.section}; ${
              JSON.stringify({ invalidCitationCount, citations: invalidCitations })
            }`
          )
        )
      }
      return page
    })
  const write = (
    pages: ReadonlyArray<ReviewedPage>,
    mode: "preview" | "verified",
    provenance: Readonly<Record<string, Provenance>> = {}
  ) =>
    Effect.gen(function*() {
      const fs = options.fs ?? (yield* FileSystem.FileSystem), path = yield* Path.Path
      if (
        !pages.length || new Set(pages.map((page) => page.evidence.spec.id)).size !== pages.length
      ) return yield* Effect.fail(fail("invalid-input", "Wiki page ids must be nonempty and unique"))
      const allIds = new Set(pages.map((page) => page.evidence.spec.id))
      for (const page of pages) {
        yield* assess(page)
        if (page.evidence.spec.related.some((id) => !allIds.has(id))) {
          return yield* Effect.fail(fail("invalid-input", `Broken related-page link: ${page.evidence.spec.id}`))
        }
        const current = yield* collect(page.evidence.spec)
        if (current.inputDigest !== page.evidence.inputDigest) {
          return yield* Effect.fail(fail("stale-source", `Source changed during review: ${page.evidence.spec.id}`))
        }
      }
      const verified = pages.every((page) =>
        page.review !== null && page.reviewer &&
        page.review.sections.every((section) => section.verdict === "supported")
      )
      const verification = verified
        ? "verified" as const
        : pages.some((page) => page.review !== null)
        ? "needs-changes" as const
        : "unreviewed" as const
      const inputDigest = yield* digest(
        canonical(pages.map((page) => ({ id: page.evidence.spec.id, digest: page.evidence.inputDigest })))
      )
      const sourceRevision = `sha256:${inputDigest}`
      const rendered = yield* Effect.forEach(pages, (page) =>
        Effect.gen(function*() {
          const { evidence, review, reviewer } = page
          const reviewDigest = review
            ? yield* digest(
              canonical({
                policy: 3,
                assessmentPolicy,
                inputDigest: evidence.inputDigest,
                contentDigest: evidence.contentDigest,
                reviewer,
                review
              })
            )
            : null
          const status = review === null
            ? "unreviewed"
            : review.sections.every((section) => section.verdict === "supported")
            ? "verified"
            : "needs-changes"
          const header = `---\nsmithers_generated: true\nschema_version: 1\nsource_revision: ${
            JSON.stringify(sourceRevision)
          }\ninput_digest: ${evidence.inputDigest}\ncontent_digest: ${evidence.contentDigest}\nverification_status: ${status}\nreview_digest: ${
            reviewDigest ?? "null"
          }\n---\n\n`
          const notice = `> ${
            evidence.spec.kind === "intent"
              ? "Product intent; this page does not assert implementation."
              : "Current behavior from the captured source snapshot."
          } ${
            status === "verified"
              ? "Model-reviewed against the cited source; this is not a formal proof or deployment receipt."
              : "Semantic review has not passed. Treat explanations as a draft."
          }\n\n`
          const links = evidence.spec.related.map((id) =>
            `[${pages.find((entry) => entry.evidence.spec.id === id)!.evidence.spec.title}](./${id}.md)`
          ).join(" · ")
          const sourceLinks = evidence.sources.map((source) =>
            `- [${source.path}](../sources/${source.path}) — \`${source.digest}\``
          ).join("\n")
          const body = header + notice + evidence.markdown +
            `\n## Related pages\n\n${links}\n\n## Exact source inputs\n\n${sourceLinks}\n`
          return {
            id: evidence.spec.id,
            slug: `generated-${evidence.spec.id}`,
            title: evidence.spec.title,
            purpose: evidence.spec.purpose,
            kind: evidence.spec.kind,
            spec: evidence.spec,
            body,
            contentDigest: evidence.contentDigest,
            bodyDigest: yield* digest(body),
            inputDigest: evidence.inputDigest,
            sources: evidence.sources.map(({ path, digest }) => ({ path, digest })),
            verification: {
              status,
              reviewer,
              reviewDigest,
              review,
              ...(provenance[evidence.spec.id] ? { provenance: provenance[evidence.spec.id] } : {})
            }
          }
        }))
      const snapshot = {
        schemaVersion: 1,
        digestPolicy: "canonical-json-v2",
        assessmentPolicy,
        sourceRevision,
        sourceKind: "content-addressed-working-tree",
        inputDigest,
        verification,
        pages: rendered
      }
      const files: Record<string, string> = { "snapshot.json": JSON.stringify(snapshot, null, 2) + "\n" }
      for (const page of pages) {
        for (const source of page.evidence.sources) files[`sources/${source.path}`] = source.text
      }
      for (const page of rendered) files[`pages/${page.id}.md`] = page.body
      files["README.md"] =
        `# Smithers engineering wiki\n\nSnapshot: \`${sourceRevision}\`. Semantic verification: **${verification}**.\n\nThe source snapshot is immutable content evidence, not a claim about the current main branch or production. Canonical human-authored pages are not overwritten; explicitly catalogued intent may appear as generated copies and archived source evidence.\n\n` +
        rendered.map((page) => `- [${page.title}](pages/${page.id}.md) — ${page.purpose}`).join("\n") + "\n"
      const requestedRoot = options.publicationRoot === undefined
        ? path.resolve(options.output)
        : yield* options.publicationRoot
      yield* fs.makeDirectory(requestedRoot, { recursive: true })
      const root = yield* fs.realPath(requestedRoot)
      if (
        root !== path.join(yield* fs.realPath(path.dirname(requestedRoot)), path.basename(requestedRoot))
      ) return yield* Effect.fail(fail("output-conflict", "Output must be a real, dedicated directory"))
      const artifactDigest = yield* digest(
        JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      )
      const version = path.join(root, "snapshots", artifactDigest)
      const currentPath = path.join(root, "current.json")
      // A single atomic pointer is the acceptance point. All pages and captured
      // sources live in an immutable version directory installed before it.
      yield* fs.makeDirectory(path.join(root, "snapshots"), { recursive: true })
      if ((yield* fs.realPath(path.join(root, "snapshots"))) !== path.join(root, "snapshots")) {
        return yield* Effect.fail(fail("output-conflict", "Snapshot directory cannot be a symlink"))
      }
      if (yield* fs.exists(currentPath)) {
        if ((yield* fs.realPath(currentPath)) !== currentPath) {
          return yield* Effect.fail(fail("output-conflict", "Current pointer cannot be a symlink"))
        }
        const previousText = yield* fs.readFileString(currentPath)
        const previous = yield* Effect.try({
          try: () => JSON.parse(previousText) as { smithersWikiProjection?: boolean; artifactDigest?: string },
          catch: () => fail("output-conflict", "Current pointer is not a Smithers projection")
        })
        if (
          previous.smithersWikiProjection !== true || !/^[a-f0-9]{64}$/.test(previous.artifactDigest ?? "")
        ) return yield* Effect.fail(fail("output-conflict", "Refusing to overwrite an unowned current pointer"))
      }
      const crypto = yield* Crypto.Crypto
      const stage = path.join(root, `.staging-${yield* crypto.randomUUIDv4}`)
      yield* fs.makeDirectory(stage)
      yield* Effect.gen(function*() {
        for (const [name, text] of Object.entries(files)) {
          const target = path.join(stage, name)
          yield* fs.makeDirectory(path.dirname(target), { recursive: true })
          yield* fs.writeFileString(target, text)
        }
        const verifyExisting = Effect.gen(function*() {
          for (const [name, text] of Object.entries(files)) {
            const target = path.join(version, name)
            if (
              (yield* fs.realPath(target)) !== target || (yield* fs.readFileString(target)) !== text
            ) return yield* Effect.fail(fail("output-conflict", `Immutable snapshot was edited: ${name}`))
          }
        })
        if (yield* fs.exists(version)) yield* verifyExisting
        else {yield* fs.rename(stage, version).pipe(Effect.catch((error) =>
            Effect.gen(function*() {
              // Another writer may install this exact content-addressed artifact
              // after our existence check. Accept only its complete expected bytes;
              // unrelated rename errors and edited snapshots remain failures.
              if (!(yield* fs.exists(version))) return yield* Effect.fail(error)
              yield* verifyExisting
            })
          ))}
        const pointer = path.join(root, `.current-${yield* crypto.randomUUIDv4}.json`)
        yield* fs.writeFileString(
          pointer,
          JSON.stringify(
            { smithersWikiProjection: true, artifactDigest, directory: `snapshots/${artifactDigest}`, ...snapshot },
            null,
            2
          ) + "\n"
        )
        yield* fs.rename(pointer, currentPath)
      }).pipe(Effect.ensuring(fs.remove(stage, { recursive: true, force: true }).pipe(Effect.ignore)))
      if (mode === "verified" && !verified) {
        return yield* Effect.fail(fail("review-failed", `Semantic review did not pass; inspect ${currentPath}`))
      }
      return {
        schemaVersion: 1,
        sourceRevision,
        inputDigest,
        output: root,
        pages: pages.length,
        verification
      } satisfies Receipt
    })
  const check = (specs: ReadonlyArray<PageSpec>, requireVerified = false) =>
    Effect.gen(function*() {
      const fs = options.fs ?? (yield* FileSystem.FileSystem), path = yield* Path.Path
      // A workspace root can have a logical OS alias (for example /var on
      // macOS). Compare immutable files under the same canonical output root
      // used by publication, while still refusing a linked output directory.
      const requestedRoot = path.resolve(options.output)
      const root = yield* fs.realPath(requestedRoot)
      if (root !== path.join(yield* fs.realPath(path.dirname(requestedRoot)), path.basename(requestedRoot))) {
        return yield* Effect.fail(fail("output-conflict", "Output must be a real, dedicated directory"))
      }
      const text = yield* fs.readFileString(path.join(root, "current.json"))
      const current = yield* Effect.try({
        try: () =>
          JSON.parse(text) as {
            artifactDigest: string
            directory: string
            verification: string
            pages: Array<{ id: string; inputDigest: string; body: string }>
          },
        catch: () => fail("output-conflict", "Invalid snapshot pointer")
      })
      if (
        !/^[a-f0-9]{64}$/.test(current.artifactDigest) || current.directory !== `snapshots/${current.artifactDigest}`
      ) return yield* Effect.fail(fail("output-conflict", "Invalid snapshot directory"))
      if (
        JSON.stringify(current.pages.map((page) => page.id)) !== JSON.stringify(specs.map((spec) => spec.id))
      ) return yield* Effect.fail(fail("stale-source", "The wiki catalog changed"))
      for (const spec of specs) {
        const page = current.pages.find((page) => page.id === spec.id)!
        const source = yield* collect(spec)
        if (source.inputDigest !== page.inputDigest) {
          return yield* Effect.fail(fail("stale-source", `Stale wiki page: ${spec.id}`))
        }
        if (
          (yield* fs.readFileString(path.resolve(root, current.directory, "pages", `${spec.id}.md`))) !== page.body
        ) return yield* Effect.fail(fail("output-conflict", `Generated page was edited: ${spec.id}`))
        for (const input of source.sources) {
          if (
            (yield* fs.readFileString(path.resolve(root, current.directory, "sources", input.path))) !== input.text
          ) return yield* Effect.fail(fail("output-conflict", `Captured source was edited: ${input.path}`))
        }
      }
      const archiveRoot = path.resolve(root, current.directory)
      const archived = JSON.parse(yield* fs.readFileString(path.join(archiveRoot, "snapshot.json"))) as Record<
        string,
        unknown
      >
      const pointer = JSON.parse(text) as Record<string, unknown>
      for (const key of ["smithersWikiProjection", "artifactDigest", "directory"]) delete pointer[key]
      if (JSON.stringify(pointer) !== JSON.stringify(archived)) {
        return yield* Effect.fail(fail("output-conflict", "Current pointer differs from its immutable snapshot"))
      }
      const names = new Set([
        "README.md",
        "snapshot.json",
        ...specs.map((spec) => `pages/${spec.id}.md`),
        ...specs.flatMap((spec) => [...spec.inputs, spec.document].map((name) => `sources/${name}`))
      ])
      const entries = yield* Effect.forEach([...names].sort(), (name) =>
        Effect.gen(function*() {
          const target = path.join(archiveRoot, name)
          if ((yield* fs.realPath(target)) !== target) {
            return yield* Effect.fail(fail("output-conflict", "Snapshot files cannot be symlinks"))
          }
          return [name, yield* fs.readFileString(target)] as const
        }))
      if ((yield* digest(JSON.stringify(entries))) !== current.artifactDigest) {
        return yield* Effect.fail(fail("output-conflict", "Snapshot content does not match its artifact digest"))
      }
      if (requireVerified && current.verification !== "verified") {
        return yield* Effect.fail(fail("review-failed", "The current snapshot has not passed semantic review"))
      }
      return { pages: specs.length, verification: current.verification }
    })
  const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.fail(
          error instanceof WikiError ? error : fail("io", error instanceof Error ? error.message : String(error))
        )
      )
    )
  return {
    check: (specs: ReadonlyArray<PageSpec>, requireVerified = false) => boundary(check(specs, requireVerified)),
    collect: (spec: PageSpec) => boundary(collect(spec)),
    assess,
    write: (
      pages: ReadonlyArray<ReviewedPage>,
      mode: "preview" | "verified",
      provenance?: Readonly<Record<string, Provenance>>
    ) => boundary(write(pages, mode, provenance))
  }
}
