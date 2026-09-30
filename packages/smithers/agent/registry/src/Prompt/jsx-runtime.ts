/**
 * JSX values rendered as Markdown prompt text.
 * @since 1.0.0-rc.1
 */

/**
 * The fragment marker used by compiled MDX.
 * @category constants
 * @since 1.0.0-rc.1
 */
export const Fragment = Symbol.for("@smthrs/registry/Prompt/Fragment")

/**
 * A text element's attributes and children.
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Props {
  readonly children?: Content
  readonly [key: string]: unknown
}

/**
 * JSX content, including optional expressions and nested components.
 * @category models
 * @since 1.0.0-rc.1
 */
export type Content = string | number | boolean | null | undefined | Element | ReadonlyArray<Content>

/**
 * A retained element allows list and code rendering to see its children.
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Element {
  readonly type: string | typeof Fragment
  readonly props: Props
}

/**
 * Construct a text element or call an MDX component.
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const jsx = (type: string | typeof Fragment | ((props: Props) => Content), props: Props): Content =>
  typeof type === "function" ? type(props) : { type, props }

/**
 * The automatic JSX runtime uses the same constructor for multiple children.
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const jsxs = jsx

const destination = (value: unknown): string =>
  String(value ?? "").replace(
    /[\s()<>]/gu,
    (character) => character === "(" ? "%28" : character === ")" ? "%29" : encodeURIComponent(character)
  )

const title = (value: unknown): string => typeof value === "string" ? ` ${JSON.stringify(value)}` : ""

const contentText = (content: Content): string => {
  if (content === null || content === undefined || typeof content === "boolean") return ""
  if (typeof content === "string" || typeof content === "number") return String(content)
  if (Array.isArray(content)) return content.map(contentText).join("")
  const { props, type } = content as Element
  const text = contentText(props.children)
  if (type === Fragment && Array.isArray(props.children)) {
    let output = ""
    for (const child of props.children) {
      if (child === "\n") {
        if (!output.endsWith("\n\n")) output += output.endsWith("\n") ? "\n" : "\n\n"
      } else output += contentText(child)
    }
    return output
  }
  if (type === Fragment) return text
  if (/^h[1-6]$/.test(type)) return `${"#".repeat(Number(type[1]))} ${text}\n\n`
  switch (type) {
    case "p":
      return `${text}\n\n`
    case "strong":
      return `**${text}**`
    case "em":
      return `*${text}*`
    case "del":
      return `~~${text}~~`
    case "br":
      return "\n"
    case "hr":
      return "---\n\n"
    case "a":
      return `[${text}](${destination(props.href)}${title(props.title)})`
    case "img":
      return `![${String(props.alt ?? "").replace(/[[\]\\]/g, "\\$&")}](${destination(props.src)}${title(props.title)})`
    case "blockquote":
      return `${text.trimEnd().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`
    case "code": {
      if (text.length === 0) return ""
      const fence = "`".repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)))
      const padding = text.startsWith("`") || text.endsWith("`") || (/^\s|\s$/u.test(text) && text.trim().length > 0)
        ? " "
        : ""
      return `${fence}${padding}${text}${padding}${fence}`
    }
    case "pre": {
      const child = props.children
      const code =
        typeof child === "object" && child !== null && !Array.isArray(child) && (child as Element).type === "code"
          ? child as Element
          : undefined
      const value = contentText(code === undefined ? child : code.props.children).replace(/\n$/, "")
      const language = typeof code?.props.className === "string" ? code.props.className.replace(/^language-/, "") : ""
      const fence = "`".repeat(Math.max(3, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1)))
      return `${fence}${language}\n${value}\n${fence}\n\n`
    }
    case "ul":
    case "ol": {
      const children = Array.isArray(props.children) ? props.children : [props.children]
      let ordinal = typeof props.start === "number" ? props.start : 1
      return children.filter((child) => typeof child === "object" && child !== null && !Array.isArray(child)).map(
        (child) => {
          const contents = (child as Element).props.children
          const parts = Array.isArray(contents) ? contents : [contents]
          const item = parts.map((part) => {
            const nestedList = typeof part === "object" && part !== null && !Array.isArray(part) &&
              ((part as Element).type === "ul" || (part as Element).type === "ol")
            return (nestedList ? "\n" : "") + contentText(part)
          }).join("").trimEnd()
          const marker = type === "ol" ? `${ordinal++}. ` : "- "
          const lines = item.split("\n")
          return marker + lines[0] + lines.slice(1).map((line) => `\n${" ".repeat(marker.length)}${line}`).join("")
        }
      ).join("\n") + "\n\n"
    }
    default:
      return text
  }
}

/**
 * Render an MDX value into Markdown text.
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const render = (content: Content): string => contentText(content).trimEnd()
