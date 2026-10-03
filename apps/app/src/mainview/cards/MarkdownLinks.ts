/*
 * Where a link inside a repository's markdown file goes (#3132). The editor
 * renders the link as written; followed by the browser, a relative href
 * resolves against the app's URL and lands on the site's 404. The file card
 * resolves it here instead, from the document's own directory in its own
 * repository or box, and opens the target through the card's read flows.
 *
 * - `file` / `directory`: a path inside the source, relative to its root.
 *   A leading `/` is the root, as on GitHub. A trailing `/`, `.` or `..`
 *   names a directory; anything else is read as a file.
 * - `fragment`: a same-document `#anchor`.
 * - `external`: http(s), mailto and protocol-relative links, left to the browser.
 * - `blocked`: every other scheme, a path that climbs above the root, and a
 *   malformed one. The click does nothing.
 */
export type MarkdownLink =
  | { readonly kind: "file" | "directory"; readonly path: string; readonly fragment?: string }
  | { readonly kind: "fragment"; readonly fragment: string }
  | { readonly kind: "external" }
  | { readonly kind: "blocked" }

const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto"])

export const resolveMarkdownLink = (documentPath: string, href: string): MarkdownLink => {
  const trimmed = href.trim()
  if (trimmed === "") return { kind: "blocked" }
  if (trimmed.startsWith("#")) return { kind: "fragment", fragment: trimmed.slice(1) }
  if (trimmed.startsWith("//")) return { kind: "external" }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]
  if (scheme !== undefined) return EXTERNAL_SCHEMES.has(scheme.toLowerCase()) ? { kind: "external" } : { kind: "blocked" }
  const hash = trimmed.indexOf("#")
  const fragment = hash === -1 ? "" : trimmed.slice(hash + 1)
  const beforeHash = hash === -1 ? trimmed : trimmed.slice(0, hash)
  const query = beforeHash.indexOf("?")
  const raw = query === -1 ? beforeHash : beforeHash.slice(0, query)
  if (raw.includes("\\")) return { kind: "blocked" }
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return { kind: "blocked" }
  }
  if (decoded.includes("\0")) return { kind: "blocked" }
  const segments = decoded.startsWith("/") ? [] : documentPath.split("/").slice(0, -1).filter((segment) => segment !== "")
  const written = decoded.split("/")
  for (const segment of written) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return { kind: "blocked" }
      segments.pop()
    } else segments.push(segment)
  }
  const last = written[written.length - 1]
  const directory = segments.length === 0 || last === "" || last === "." || last === ".."
  return {
    kind: directory ? "directory" : "file",
    path: segments.join("/"),
    ...(fragment === "" ? {} : { fragment })
  }
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export const headingAnchor = (heading: string): string =>
  heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-")

/**
 * The 1-based source line of the ATX heading a same-document `#anchor` names,
 * with GitHub's `-1`, `-2` suffixes for repeated headings; undefined when no
 * heading carries it. Fenced code is not searched.
 */
export const headingLine = (markdown: string, fragment: string): number | undefined => {
  let target: string
  try {
    target = decodeURIComponent(fragment).toLowerCase()
  } catch {
    return undefined
  }
  const seen = new Map<string, number>()
  let inFence = false
  const lines = markdown.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    const heading = inFence ? null : /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading === null) continue
    const base = headingAnchor(heading[1]!)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    if ((count === 0 ? base : `${base}-${count}`) === target) return index + 1
  }
  return undefined
}
