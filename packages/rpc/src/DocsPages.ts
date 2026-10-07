/**
 * The `docs` flow shared by every host that runs it (M-35): the bundled pages
 * it answers from, its agent argument grammar, the page a read hands the
 * agent, and the read-only Docs card it embeds. The app binds its `docs` flow
 * to these; the model host binds the app agent's `docs` command to the same
 * ones, over the same pages its build bundles.
 * @since 1.0.0
 */

import { z } from "zod"
import type { Card } from "./Cards.ts"

/**
 * One bundled page: its slug (the file name without `.md`), its frontmatter
 * title and summary, and the Markdown after the frontmatter.
 * @since 1.0.0
 * @category models
 */
export interface DocsPage {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly markdown: string
}

/**
 * The Docs card the flow embeds.
 * @since 1.0.0
 * @category models
 */
export type DocsPageCard = Extract<Card, { readonly kind: "docs" }>

/**
 * What the flow's payload carries: a page (with an optional `#anchor`) and the
 * read mode, which returns the page as data and embeds nothing.
 * @since 1.0.0
 * @category models
 */
export interface DocsInput {
  readonly page?: string | undefined
  readonly mode?: "read" | undefined
}

const DocsInputSchema = z.strictObject({
  page: z.string().optional(),
  mode: z.literal("read").optional()
})

const pageList = (pages: ReadonlyArray<DocsPage>): string => pages.map((page) => page.slug).join(", ")

/**
 * The refusal for a slug no page answers: it names every page there is.
 * @since 1.0.0
 * @category formatting
 */
export const unknownDocsPage = (pages: ReadonlyArray<DocsPage>, slug: string): string =>
  `There is no docs page named ${slug}. Pages: ${pageList(pages)}.`

/**
 * The agent's argument text for `docs`: a JSON payload (`{"mode":"read","page":"quickstart"}`), or the page as
 * the slash writes it (`quickstart#put-https-in-front`), which embeds it.
 * @since 1.0.0
 * @category parsers
 */
export const parseDocsArgs = (
  args: string | undefined
): { readonly payload: DocsInput } | { readonly error: string } => {
  const text = (args ?? "").trim()
  if (!text.startsWith("{")) return { payload: text === "" ? {} : { page: text } }
  try {
    const parsed = DocsInputSchema.safeParse(JSON.parse(text))
    if (parsed.success) return { payload: parsed.data }
  } catch {
    // Malformed JSON gets the same answer as a payload with other fields.
  }
  return { error: "docs takes a page, or {\"mode\":\"read\",\"page\":\"<page>\"} to read one." }
}

/**
 * `docs {mode:"read", page}`: the page's title, summary and Markdown as the
 * JSON the agent reads, or the refusal naming every page.
 * @since 1.0.0
 * @category constructors
 */
export const readDocsPage = (
  pages: ReadonlyArray<DocsPage>,
  page: string
): { readonly value: string } | { readonly error: string } => {
  const slug = page.trim()
  if (slug === "") return { error: `Name a docs page to read. Pages: ${pageList(pages)}.` }
  const found = pages.find((candidate) => candidate.slug === slug)
  if (found === undefined) return { error: unknownDocsPage(pages, slug) }
  return { value: JSON.stringify({ title: found.title, summary: found.summary, markdown: found.markdown }) }
}

/**
 * `docs [page][#anchor]`: the Docs card for a page, in the pages' order as its
 * table of contents. No page named opens the first; a slug no page answers
 * opens the first with a not-found state and drops the anchor. The value tells
 * the agent what was embedded.
 * @since 1.0.0
 * @category constructors
 */
export const docsCard = (
  pages: ReadonlyArray<DocsPage>,
  wanted: string | undefined,
  ordinal: number,
  createdAt: number
): { readonly card: DocsPageCard; readonly value: string } => {
  const first = pages[0]
  if (first === undefined) throw new Error("The docs have no pages.")
  const [named = "", anchor] = (wanted?.trim() ?? "").split("#", 2)
  const slug = named === "" ? first.slug : named
  const requested = pages.find((page) => page.slug === slug)
  const found = requested ?? first
  return {
    card: {
      id: `docs-${found.slug}`,
      kind: "docs",
      title: found.title,
      status: "active",
      createdAt,
      ordinal,
      payload: {
        page: found.slug,
        markdown: found.markdown,
        summary: found.summary,
        toc: pages.map(({ slug, title }) => ({ slug, title })),
        ...(requested !== undefined && anchor ? { anchor } : {}),
        ...(requested === undefined ? { not_found: slug } : {})
      }
    },
    value: `Embedded the ${found.title} docs page.`
  }
}
