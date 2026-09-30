import type { SeamFetch } from "./SeamContext"

export const MAX_CONTENTS_ENTRIES = 10_000
const MAX_CONTENTS_PAGES = 100

type ContentsResult =
  | { readonly kind: "response"; readonly response: Response; readonly body: unknown }
  | { readonly kind: "error"; readonly error: string }

/** Read every directory page without turning a partial listing into a complete one. */
export const readContentsPages = async (http: SeamFetch, url: string): Promise<ContentsResult> => {
  const entries: unknown[] = []
  const seen = new Set<string>()
  let cursor = ""
  let commit = ""
  let pages = 0
  for (;;) {
    if (++pages > MAX_CONTENTS_PAGES) return { kind: "error", error: "Directory listing did not finish." }
    let pageUrl = url
    if (cursor !== "") {
      const [path = "", query = ""] = url.split("?", 2)
      const params = new URLSearchParams(query)
      params.set("ref", commit)
      params.set("after", cursor)
      pageUrl = `${path}?${params.toString()}`
    }
    const response = await http(pageUrl)
    if (!response.ok) return { kind: "response", response, body: null }
    const body: unknown = await response.json().catch(() => null)
    if (!Array.isArray(body)) {
      return entries.length === 0
        ? { kind: "response", response, body }
        : { kind: "error", error: "Directory listing returned an invalid page." }
    }
    if (entries.length + body.length > MAX_CONTENTS_ENTRIES) {
      return { kind: "error", error: "Directory listing exceeds 10,000 entries." }
    }
    entries.push(...body)
    const pageCommit = response.headers.get("X-Contents-Commit") ?? ""
    if (cursor !== "" && pageCommit !== commit) {
      return { kind: "error", error: "Directory changed while listing." }
    }
    const header = response.headers.get("X-Next-Cursor") ?? ""
    if (header === "") return { kind: "response", response, body: entries }
    // The backend percent-encodes the cursor so edge whitespace survives the header.
    let next: string
    try {
      next = decodeURIComponent(header)
    } catch {
      return { kind: "error", error: "Directory listing returned an invalid page." }
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(pageCommit)) {
      return { kind: "error", error: "Directory listing has no revision." }
    }
    commit = pageCommit
    if (seen.has(next) || body.length === 0) {
      return { kind: "error", error: "Directory listing cursor did not advance." }
    }
    seen.add(next)
    cursor = next
  }
}
