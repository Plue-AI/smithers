/**
 * Small, dependency-free HTML renderers for web retrieval.
 *
 * @since 1.0.0
 */

const comments = /<!--[\s\S]*?-->/g
const entities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }

const dropSkipped = (html: string): string => {
  const lower = html.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const opening = /<(head|script|style|noscript|iframe|object|embed)\b/gi
  let output = ""
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = opening.exec(html)) !== null) {
    output += html.slice(cursor, match.index)
    const marker = `</${match[1]!.toLowerCase()}`
    let close = lower.indexOf(marker, opening.lastIndex)
    while (close !== -1) {
      let end = close + marker.length
      while (/\s/.test(lower[end] ?? "")) end++
      if (lower[end] === ">") {
        cursor = end + 1
        opening.lastIndex = cursor
        break
      }
      close = lower.indexOf(marker, close + marker.length)
    }
    if (close === -1) return output
  }
  return output + html.slice(cursor)
}

const decode = (value: string): string =>
  value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const number = Number.parseInt(
        entity.slice(entity[1]!.toLowerCase() === "x" ? 2 : 1),
        entity[1]!.toLowerCase() === "x" ? 16 : 10
      )
      return number <= 0x10ffff
          && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number)
        : match
    }
    const key = entity.toLowerCase()
    return Object.hasOwn(entities, key) ? entities[key]! : match
  })

const source = (html: string): string => dropSkipped(html.replace(comments, ""))

/**
 * Extracts readable text while dropping executable and presentation-only elements.
 *
 * @category rendering
 * @since 1.0.0
 */
export const toText = (html: string): string =>
  decode(source(html).replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, " "))
    .replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim()

/**
 * Converts a conservative subset of HTML into readable Markdown.
 *
 * @category rendering
 * @since 1.0.0
 */
export const toMarkdown = (html: string): string => {
  const markdown = source(html)
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_all, level: string, text: string) => `\n\n${"#".repeat(Number(level))} ${toText(text)}\n\n`
    )
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_all, href: string, text: string) => `[${toText(text)}](${href})`
    )
    .replace(/<li\b[^>]*>/gi, "\n- ").replace(
      /<\/?(ul|ol|p|div|section|article|main|blockquote|pre|tr)\b[^>]*>/gi,
      "\n"
    )
    .replace(/<br\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, "")
  return decode(markdown).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}
