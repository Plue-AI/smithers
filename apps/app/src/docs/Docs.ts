/*
 * The in-app docs (M-35): one Markdown file per page under pages/, each
 * opening with exactly a `title` and a `summary` in its frontmatter, in the
 * order toc.ts lists them. This module is pure: it parses the files it is
 * handed. bundled.ts hands it the build's files; the test suites hand it the
 * same files read from disk (DiskPages.ts).
 */
import { resolveMarkdownLink } from "../mainview/cards/MarkdownLinks"
import { TOC, type DocsSection } from "./toc"

export type { DocsSection } from "./toc"

/** One page: its slug (the file name without `.md`), its frontmatter, and the Markdown after it. */
export interface DocsPage {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly markdown: string
}

/** Every page, in toc order, beside the sections that order them. */
export interface Docs {
  readonly sections: ReadonlyArray<DocsSection>
  readonly pages: ReadonlyArray<DocsPage>
}

const KEYS = ["title", "summary"] as const
type Key = (typeof KEYS)[number]
const isKey = (key: string): key is Key => (KEYS as ReadonlyArray<string>).includes(key)

/** A page's frontmatter and body, or why the frontmatter is not exactly a non-empty title and summary. */
export type ParsedPage =
  | { readonly title: string; readonly summary: string; readonly markdown: string }
  | { readonly error: string }

/**
 * Reads a page file. The frontmatter is strict: a `---` line, one `key: value`
 * line for each of `title` and `summary` and nothing else, and a closing `---`
 * line. Values are taken as written, trimmed; there is no quoting.
 */
export const parsePage = (source: string): ParsedPage => {
  const lines = source.replace(/\r\n/g, "\n").split("\n")
  if (lines[0] !== "---") return { error: "The page must open with a --- frontmatter block." }
  const close = lines.indexOf("---", 1)
  if (close === -1) return { error: "The frontmatter block never closes with ---." }
  const values = new Map<Key, string>()
  for (const line of lines.slice(1, close)) {
    const match = /^([A-Za-z][\w-]*):(.*)$/.exec(line)
    if (match === null) return { error: `The frontmatter line ${JSON.stringify(line)} is not key: value.` }
    const key = match[1]!
    const value = match[2]!.trim()
    if (!isKey(key)) return { error: `The frontmatter key ${key} is not title or summary.` }
    if (values.has(key)) return { error: `The frontmatter repeats ${key}.` }
    if (value === "") return { error: `The frontmatter ${key} is empty.` }
    values.set(key, /^".*"$/.test(value) ? JSON.parse(value) : value)
  }
  for (const key of KEYS) if (!values.has(key)) return { error: `The frontmatter is missing ${key}.` }
  return {
    title: values.get("title")!,
    summary: values.get("summary")!,
    markdown: lines.slice(close + 1).join("\n").replace(/^(?:[ \t]*\n)+/, "")
  }
}

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*"
const PAGE_FILE = new RegExp(`^\\./pages/(${SLUG})\\.md$`)
const SIBLING_PAGE = new RegExp(`^(${SLUG})\\.md$`)

/**
 * Builds the docs from the page files, keyed `./pages/<slug>.md` as Vite's
 * glob keys them. A file that is not a valid page, a toc slug without a page,
 * a page the toc leaves out and a slug listed twice all throw: the docs ship
 * whole or the suite fails.
 */
export const loadDocs = (files: Readonly<Record<string, string>>, toc: ReadonlyArray<DocsSection> = TOC): Docs => {
  const parsed = new Map<string, DocsPage>()
  for (const [path, source] of Object.entries(files)) {
    const name = path.replace(/^\.\//, "")
    const slug = PAGE_FILE.exec(path)?.[1]
    if (slug === undefined) throw new Error(`${name} is not named <slug>.md.`)
    const page = parsePage(source)
    if ("error" in page) throw new Error(`${name}: ${page.error}`)
    parsed.set(slug, { slug, ...page })
  }
  const listed = toc.flatMap((section) => section.pages)
  if (listed.length === 0) throw new Error("toc.ts lists no pages.")
  const seen = new Set<string>()
  for (const slug of listed) {
    if (seen.has(slug)) throw new Error(`toc.ts lists ${slug} twice.`)
    seen.add(slug)
    if (!parsed.has(slug)) throw new Error(`toc.ts lists ${slug}, but pages/${slug}.md does not exist.`)
  }
  for (const slug of parsed.keys()) if (!seen.has(slug)) throw new Error(`pages/${slug}.md is not in toc.ts.`)
  return { sections: toc, pages: listed.map((slug) => parsed.get(slug)!) }
}

/** The page with this slug, or undefined. */
export const docsPage = (docs: Docs, slug: string): DocsPage | undefined =>
  docs.pages.find((page) => page.slug === slug)

/** The refusal for a slug no page answers: it names every page there is. */
export const unknownDocsPage = (docs: Docs, slug: string): string =>
  `There is no docs page named ${slug}. Pages: ${docs.pages.map((page) => page.slug).join(", ")}.`

/**
 * Where a link inside a docs page goes. Pages link to each other as sibling
 * files (`flows.md`, `flows.md#anchor`); a bare `#anchor` is a heading on the
 * same page; web links stay the browser's. Anything else (a nested path, a
 * file that is not a page, another scheme) goes nowhere.
 */
export type DocsLink =
  | { readonly kind: "page"; readonly slug: string; readonly fragment?: string }
  | { readonly kind: "fragment"; readonly fragment: string }
  | { readonly kind: "external" }
  | { readonly kind: "blocked" }

export const docsLinkTarget = (from: string, href: string): DocsLink => {
  const link = resolveMarkdownLink(`${from}.md`, href)
  if (link.kind === "fragment" || link.kind === "external" || link.kind === "blocked") return link
  const slug = link.kind === "file" ? SIBLING_PAGE.exec(link.path)?.[1] : undefined
  if (slug === undefined) return { kind: "blocked" }
  return link.fragment === undefined ? { kind: "page", slug } : { kind: "page", slug, fragment: link.fragment }
}
