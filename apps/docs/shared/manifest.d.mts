export interface DocumentationSite {
  slug: string
  name: string
  dir: string
  description: string
  title: string
  domain: string
  siteDir: string
}
export const docsRoot: string
export const repoRoot: string
export const sites: DocumentationSite[]
export const bySlug: Map<string, DocumentationSite>
export const siteRowProblems: (row: readonly [unknown, unknown, unknown]) => string[]
