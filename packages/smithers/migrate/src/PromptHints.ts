/**
 * Converts MDX prompts to template literals.
 *
 * A 0.x prompt is an `.mdx` file imported as a React component and rendered
 * with props. The 1.0 target is `prompt: (payload) => string` on an
 * `AgentAction`, or a markdown flow for a standalone prompt. A prompt whose
 * only expressions are `{props.x}` and `{JSON.stringify(props.x)}` converts
 * exactly, so the migration does not have to ask a model to retype prose.
 *
 * A prompt that imports a module or renders a component is `jsx`: it carries
 * composition the template literal cannot express, and the agent decides what
 * it becomes.
 *
 * @since 1.0.0-rc.0
 */

import type { Detection } from "./Detect.ts"
import * as Detect from "./Detect.ts"
import * as Sort from "./internal/Sort.ts"

/**
 * One converted prompt.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface PromptHint {
  readonly file: string
  readonly classification: "interpolation-only" | "jsx"
  /** The `props.<name>` identifiers the prompt reads, sorted. */
  readonly props: ReadonlyArray<string>
  /** The template-literal body, when the prompt is interpolation only. */
  readonly template: string | undefined
}

/**
 * Classifies one prompt body.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const classify = (text: string): PromptHint["classification"] => Detect.classifyPrompt(text).classification

const escape = (text: string): string => text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")

/**
 * Prints the template-literal body for one interpolation-only prompt.
 *
 * The result is the inside of a template literal, with each `{props.x}` turned
 * into `${payload.x}`. Backticks, backslashes, and `${` in the prose are
 * escaped so the prompt still reads as the author wrote it.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const print = (text: string, payloadName = "payload"): string => {
  let result = ""
  let index = 0
  while (index < text.length) {
    const open = text.indexOf("{", index)
    if (open === -1) {
      result += escape(text.slice(index))
      break
    }
    const close = text.indexOf("}", open)
    if (close === -1) {
      result += escape(text.slice(index))
      break
    }
    result += escape(text.slice(index, open))
    const body = text.slice(open + 1, close).trim()
    result += `\${${body.replace(/\bprops\./g, `${payloadName}.`)}}`
    index = close + 1
  }
  return result.trim()
}

/**
 * Every prompt the project holds, converted where it can be.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const hints = (detection: Detection): ReadonlyArray<PromptHint> =>
  detection.prompts
    .map((prompt): PromptHint => {
      const text = detection.sources.get(prompt.path)
      const template = prompt.classification === "interpolation-only" && text !== undefined
        ? print(text)
        : undefined
      return {
        file: prompt.path,
        classification: prompt.classification,
        props: prompt.props,
        template
      }
    })
    .sort(Sort.by((hint: PromptHint) => hint.file))
