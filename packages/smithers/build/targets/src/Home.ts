/**
 * The homepage a factory declares for its repository: `.smithers/home.json`.
 *
 * A repository's workspace chat opens with its homepage message, a README
 * alternative the maintainer declares in
 * `.smithers/FACTORY.ts` as `export const home = Smithers.Factory.Home({ blocks })`,
 * the second export beside the factory itself. Blocks are declared values,
 * never raw HTML: a prompt, markdown file, text, links, featured flows, and
 * the repository's live mythical stack.
 * The app renders every block from data; a string carrying an HTML tag is refused where
 * it is written.
 *
 * The declaration is inert, like {@link Flow.Flow}. The `FactoryProjection`
 * target (`Factory.ts`) projects it into a checked-in JSON file beside
 * `.smithers/factory.json` the same way `ci.yml` and the root `tsconfig.json`
 * are projected: `write` renders it, `check` fails on drift, and the `lint`
 * verb never writes. The file is checked in so the public mirror serves it
 * signed out and a workspace without `node_modules` never has to evaluate
 * `FACTORY.ts`.
 *
 * @since 1.0.0
 */

import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as NodeUtil from "node:util/types"

/**
 * Maximum length of one block's title or one link's label.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumTitleLength = 120

/**
 * Maximum length of one text block.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumTextLength = 4096

/**
 * Maximum length of one link URL.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumUrlLength = 2048

/**
 * Maximum number of blocks one home declares.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumBlocks = 32

/**
 * The shape of raw HTML in a string: a tag, a closing tag, a comment, or a
 * processing instruction opener. Prose that mentions `a < b` does not match;
 * `<b>bold</b>` and `<!-- note -->` do.
 *
 * @category constants
 * @since 1.0.0
 */
export const htmlPattern = /<\/?[A-Za-z!?]/

const noHtml = Schema.makeFilter<string>(
  (text) => htmlPattern.test(text) ? "must not contain HTML; blocks are declared values, never markup" : true
)

/**
 * A one-line title or label: non-empty, bounded, one line, no HTML.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Title = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumTitleLength),
  Schema.isPattern(/^[^\r\n]*$/),
  noHtml
)

/**
 * A paragraph of plain text: non-empty, bounded, no HTML.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Prose = Schema.NonEmptyString.check(Schema.isMaxLength(maximumTextLength), noHtml)

/**
 * A link target: an absolute `http` or `https` URL.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Url = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumUrlLength),
  Schema.isPattern(/^https?:\/\/[^\s<>"']+$/)
)

/**
 * A relative path that cannot escape the repository.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RepositoryPath = Schema.NonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.makeFilter<string>((path) =>
    path.startsWith("/") || path.startsWith("\\") || path.includes("\\") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      /[%:?#\x00-\x1f]/.test(path)
      ? "must be a relative in-repository path" :
      true
  )
)

/**
 * A slash leaf name or repository flow id.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PromptFlow = Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9_-]+(?:[./][a-z0-9_-]+)*$/))

/**
 * A paragraph of plain text under an optional title.
 *
 * @category schemas
 * @since 1.0.0
 */
export const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  title: Schema.optional(Title),
  text: Prose
})

/**
 * One link: the label the app shows and the URL it opens.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Link = Schema.Struct({
  label: Title,
  url: Url
})

/**
 * A list of links under an optional title.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LinksBlock = Schema.Struct({
  type: Schema.Literal("links"),
  title: Schema.optional(Title),
  links: Schema.NonEmptyArray(Link)
})

/**
 * The repository's featured flows, read by the app from the `flows` rows of
 * `.smithers/factory.json`. The block carries no rows: the projection is the
 * one source of the featured set, and an absent projection renders as absent.
 *
 * @category schemas
 * @since 1.0.0
 */
export const FlowsBlock = Schema.Struct({
  type: Schema.Literal("flows"),
  title: Schema.optional(Title)
})

/**
 * A prompt that sends through the workspace chat, with optional copy.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PromptBlock = Schema.Struct({
  type: Schema.Literal("prompt"),
  flow: Schema.optional(PromptFlow),
  /** The heading over the composer ("What should we work on?"). */
  title: Schema.optional(Title),
  placeholder: Schema.optional(Title)
})

/**
 * The pictures an app tile may wear: what the app's result looks like. The
 * app draws each one; a tile with a last result shows that result instead.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AppPicture = Schema.Literals(["issue", "review", "wiki", "schedule"])

/**
 * An app: a featured flow with a picture (PRODUCT.md D-18). The tile names
 * the flow it opens; opening it renders that flow's form (one input, one
 * button), then the run card. There is no app model beyond this block.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AppBlock = Schema.Struct({
  type: Schema.Literal("app"),
  flow: PromptFlow,
  title: Title,
  picture: AppPicture
})

/**
 * A repository markdown file resolved at main by the server.
 *
 * @category schemas
 * @since 1.0.0
 */
export const MarkdownBlock = Schema.Struct({
  type: Schema.Literal("markdown"),
  path: RepositoryPath,
  title: Schema.optional(Title)
})

/**
 * The repository's mythical stack, live: the app reads it from
 * `GET /api/repos/{owner}/{repo}/mythical` (`@smthrs/rpc/Mythical`). The
 * block carries no rows; an unreadable stack renders its refusal.
 *
 * @category schemas
 * @since 1.0.0
 */
export const StackBlock = Schema.Struct({
  type: Schema.Literal("stack"),
  title: Schema.optional(Title)
})

/**
 * One declared block.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Block = Schema.Union([TextBlock, LinksBlock, FlowsBlock, PromptBlock, MarkdownBlock, StackBlock, AppBlock])

/**
 * One declared block.
 *
 * @category models
 * @since 1.0.0
 */
export type Block = typeof Block.Type

/**
 * The home declaration `.smithers/FACTORY.ts` exports as `home`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Declaration = Schema.TaggedStruct("HomeDeclaration", {
  blocks: Schema.NonEmptyArray(Block).check(Schema.isMaxLength(maximumBlocks))
})

/**
 * The home declaration `.smithers/FACTORY.ts` exports as `home`.
 *
 * @category models
 * @since 1.0.0
 */
export type Declaration = typeof Declaration.Type

/**
 * The document `.smithers/home.json` holds: the blocks, in declaration order.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Document = Schema.Struct({
  blocks: Schema.Array(Block)
})

/**
 * The document `.smithers/home.json` holds.
 *
 * @category models
 * @since 1.0.0
 */
export type Document = typeof Document.Type

/**
 * Reports whether a value is a home declaration.
 *
 * @category guards
 * @since 1.0.0
 */
export const isHomeDeclaration: (value: unknown) => value is Declaration = Schema.is(Declaration)

const formatIssue = SchemaIssue.makeFormatterDefault()

/**
 * Reads one constructor's options as a plain object of enumerable data
 * properties, exactly once, or throws the reason it is not one. Shared with
 * the factory declaration in `Factory.ts`, so every declaration constructor
 * refuses the same shapes with the same words.
 *
 * @category validation
 * @since 1.0.0
 */
export const plainOptions = (name: string, options: unknown, keys: ReadonlySet<string>): Record<string, unknown> => {
  if (
    typeof options !== "object" || options === null || Array.isArray(options) || NodeUtil.isProxy(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) throw new TypeError(`${name} options must be a plain object`)
  if (Object.getOwnPropertySymbols(options).length > 0) {
    throw new TypeError(`${name} options must not contain symbol properties`)
  }
  const plain: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(options)) {
    if (!keys.has(key)) throw new TypeError(`${name} received unknown option ${JSON.stringify(key)}`)
    const descriptor = Object.getOwnPropertyDescriptor(options, key) as PropertyDescriptor
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name} option ${key} must be an enumerable data property`)
    }
    if (descriptor.value !== undefined) plain[key] = descriptor.value
  }
  return plain
}

/**
 * Decodes a value through a schema or throws a `TypeError` naming the
 * constructor and the first issue.
 *
 * @category validation
 * @since 1.0.0
 */
export const decode = <S extends Schema.Decoder<unknown, never>>(
  name: string,
  schema: S,
  value: unknown
): S["Type"] => {
  const result = Schema.decodeUnknownResult(schema)(value)
  if (Result.isFailure(result)) throw new TypeError(`${name}: ${formatIssue(result.failure.issue)}`)
  return result.success
}

/**
 * Freezes a value and every nested object it holds, so a declaration never
 * changes after it is written.
 *
 * @category validation
 * @since 1.0.0
 */
export const freezeDeep = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested)
    Object.freeze(value)
  }
  return value
}

/**
 * What a `FACTORY.ts` writes for a text block.
 *
 * @category models
 * @since 1.0.0
 */
export interface TextOptions {
  readonly title?: string | undefined
  readonly text: string
}

/**
 * What a `FACTORY.ts` writes for a links block.
 *
 * @category models
 * @since 1.0.0
 */
export interface LinksOptions {
  readonly title?: string | undefined
  readonly links: ReadonlyArray<{ readonly label: string; readonly url: string }>
}

/**
 * What a `FACTORY.ts` writes for a flows block.
 *
 * @category models
 * @since 1.0.0
 */
export interface FlowsOptions {
  readonly title?: string | undefined
}

/**
 * What a `FACTORY.ts` writes for a prompt block.
 *
 * @category models
 * @since 1.0.0
 */
export interface PromptOptions {
  readonly flow?: string | undefined
  readonly title?: string | undefined
  readonly placeholder?: string | undefined
}

/**
 * What a `FACTORY.ts` writes for an app block.
 *
 * @category models
 * @since 1.0.0
 */
export interface AppOptions {
  readonly flow: string
  readonly title: string
  readonly picture: typeof AppPicture.Type
}

/**
 * What a `FACTORY.ts` writes for a markdown block.
 *
 * @category models
 * @since 1.0.0
 */
export interface MarkdownOptions {
  readonly path: string
  readonly title?: string | undefined
}

/**
 * What a `FACTORY.ts` writes for a stack block.
 *
 * @category models
 * @since 1.0.0
 */
export interface StackOptions {
  readonly title?: string | undefined
}

/**
 * What a `FACTORY.ts` writes for the home declaration.
 *
 * @category models
 * @since 1.0.0
 */
export interface HomeOptions {
  readonly blocks: ReadonlyArray<Block>
}

/**
 * Declares a paragraph of plain text.
 *
 * @category constructors
 * @since 1.0.0
 */
export const Text = (options: TextOptions): typeof TextBlock.Type =>
  freezeDeep(decode("Home.Text", TextBlock, {
    type: "text",
    ...plainOptions("Home.Text", options, new Set(["title", "text"]))
  }))

/**
 * Declares a list of links.
 *
 * @category constructors
 * @since 1.0.0
 */
export const Links = (options: LinksOptions): typeof LinksBlock.Type =>
  freezeDeep(decode("Home.Links", LinksBlock, {
    type: "links",
    ...plainOptions("Home.Links", options, new Set(["title", "links"]))
  }))

/**
 * Declares the featured-flows block.
 *
 * @category constructors
 * @since 1.0.0
 */
export const Flows = (options: FlowsOptions = {}): typeof FlowsBlock.Type =>
  freezeDeep(decode("Home.Flows", FlowsBlock, {
    type: "flows",
    ...plainOptions("Home.Flows", options, new Set(["title"]))
  }))

/**
 * Declares the homepage prompt.
 *
 * @category constructors
 * @since 1.0.0
 */
export const Prompt = (options: PromptOptions = {}): typeof PromptBlock.Type =>
  freezeDeep(decode("Home.Prompt", PromptBlock, {
    type: "prompt",
    ...plainOptions("Home.Prompt", options, new Set(["flow", "title", "placeholder"]))
  }))

/**
 * Declares an app: a flow presented as a picture tile on the home.
 *
 * @category constructors
 * @since 1.0.0
 */
export const App = (options: AppOptions): typeof AppBlock.Type =>
  freezeDeep(decode("Home.App", AppBlock, {
    type: "app",
    ...plainOptions("Home.App", options, new Set(["flow", "title", "picture"]))
  }))

/**
 * Declares a markdown file inside this repository.
 *
 * @category constructors
 * @since 1.0.0
 */
export const Markdown = (options: MarkdownOptions): typeof MarkdownBlock.Type =>
  freezeDeep(decode("Home.Markdown", MarkdownBlock, {
    type: "markdown",
    ...plainOptions("Home.Markdown", options, new Set(["path", "title"]))
  }))

/**
 * Declares the repository's live mythical stack.
 *
 * @category constructors
 * @since 1.0.0
 */
export const Stack = (options: StackOptions = {}): typeof StackBlock.Type =>
  freezeDeep(decode("Home.Stack", StackBlock, {
    type: "stack",
    ...plainOptions("Home.Stack", options, new Set(["title"]))
  }))

/**
 * Declares the repository's homepage from declared blocks.
 *
 * Every block has to be a value one of the block constructors returned, or
 * an equal plain value; a string, an element, or any other shape is refused
 * with the block index in the message.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const home = Smithers.Factory.Home({
 *   blocks: [
 *     Smithers.Home.Text({ text: "Smithers builds itself with Smithers." }),
 *     Smithers.Home.Flows({ title: "Try first" }),
 *     Smithers.Home.Markdown({ path: "README.md" })
 *   ]
 * })
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export const Home = (options: HomeOptions): Declaration => {
  const plain = plainOptions("Factory.Home", options, new Set(["blocks"]))
  const blocks = plain["blocks"]
  if (!Array.isArray(blocks)) throw new TypeError("Factory.Home blocks must be an array of declared blocks")
  blocks.forEach((block, index) => {
    if (typeof block !== "object" || block === null) {
      throw new TypeError(
        `Factory.Home block ${index} must be a declared block (Smithers.Home.Text, Links, Flows, Prompt, Markdown, Stack, App), not ${
          typeof block === "string" ? "a string" : typeof block
        }`
      )
    }
  })
  return freezeDeep(decode("Factory.Home", Declaration, { _tag: "HomeDeclaration", blocks }))
}

/**
 * Renders the projected document: two-space indentation and a trailing
 * newline, so the checked-in file diffs like a hand-written one.
 *
 * @category rendering
 * @since 1.0.0
 */
export const render = (declaration: Declaration): string =>
  `${JSON.stringify(Schema.encodeSync(Document)({ blocks: declaration.blocks }), null, 2)}\n`

/**
 * Reads a rendered document back, or reports why the text is not one.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parse = (text: string): Document | string => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    return `the homepage is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`
  }
  const result = Schema.decodeUnknownResult(Document)(value)
  return Result.isFailure(result)
    ? `the homepage does not have the .smithers/home.json shape: ${formatIssue(result.failure.issue)}`
    : result.success
}
