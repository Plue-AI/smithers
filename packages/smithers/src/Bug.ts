/**
 * `smthrs bug`: a report an operator can send without pasting their secrets
 * into a browser.
 *
 * The value of the command is that it collects the context a maintainer always
 * asks for: versions, platform, and optionally the named run and its event
 * digest. A report is a diagnostic that leaves the machine, so the collected
 * value takes the shared diagnostic redaction rules before it does.
 *
 * @since 1.0.0
 */

import * as Redaction from "@smthrs/journal/Redaction"
import { isProxy } from "node:util/types"
import * as CliError from "./CliError.ts"

/**
 * Where reports are posted when the environment names no other endpoint.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultEndpoint = "https://bug.smithers.sh/api/bugs"

/** The two 0.x structural names not historically covered by journal text rules. */
const reportOnlySecretKey = /(?:dsn|connection)/i

const refusal = (reason: string): CliError.Refused =>
  new CliError.Refused({ fault: "bug", code: "bug_report_refused", message: `Bug report refused: ${reason}` })

const binarySize = (value: object): number | undefined => {
  if (value instanceof ArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  return undefined
}

const assertRenderable = (value: unknown): void => {
  let walked = 0
  const ancestors = new WeakSet<object>()

  const walk = (node: unknown, depth: number): void => {
    walked += 1
    if (walked > Redaction.binaryWalkLimit) {
      throw refusal(`the value exceeds the ${Redaction.binaryWalkLimit} member walk limit`)
    }
    if (depth > Redaction.maxDepth) {
      throw refusal(`the value exceeds the ${Redaction.maxDepth} container depth limit`)
    }
    if ((typeof node !== "object" && typeof node !== "function") || node === null) return
    if (typeof node === "function") {
      throw refusal("the value contains a callable member")
    }
    if (isProxy(node)) {
      throw refusal("the value contains a proxy, which could run code while the report is inspected")
    }
    if (ancestors.has(node)) return

    const size = binarySize(node)
    if (size !== undefined && size > Redaction.binaryWalkLimit) {
      throw refusal(`a binary value exceeds the ${Redaction.binaryWalkLimit} byte walk limit`)
    }
    if ("toJSON" in node) {
      throw refusal("a value defines toJSON, which could run code while the report is rendered")
    }

    ancestors.add(node)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(node)
      for (const descriptor of Object.values(descriptors)) {
        if (descriptor.enumerable !== true) continue
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          throw refusal("a value contains an accessor, which could run code while the report is rendered")
        }
        walk(descriptor.value, depth + 1)
      }
    } finally {
      ancestors.delete(node)
    }
  }

  walk(value, 0)
}

const applyReportOnlyKeys = (value: unknown): unknown => {
  const walk = (node: unknown, depth: number): unknown => {
    // `assertRenderable` has already admitted the exact tree against both
    // bounds, and redaction cannot add members or nesting.
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1))
    if (typeof node !== "object" || node === null) return node
    return Object.fromEntries(
      Object.entries(node).map(([key, entry]) => [
        key,
        reportOnlySecretKey.test(key) ? Redaction.placeholder : walk(entry, depth + 1)
      ])
    )
  }

  return walk(value, 0)
}

/**
 * Redacts secret-looking material inside free text.
 *
 * Reach for this when report prose must take the diagnostic rule set
 * (`Redaction.redactDiagnostic`). It is total for strings and returns the
 * shared journal markers for matched text.
 *
 * @category conversions
 * @since 1.0.0
 */
export const scrubText = (text: string): string => Redaction.redactDiagnostic(text) as string

/**
 * Recursively scrubs a JSON-safe value with the diagnostic rules and the retained
 * report-only `dsn` and `connection` key coverage. It refuses accessors,
 * executable `toJSON` hooks, excessive depth, and excessive walk size before
 * redaction so no partial report can be posted.
 *
 * @category conversions
 * @since 1.0.0
 */
export const scrub = (value: unknown): unknown => {
  assertRenderable(value)
  return applyReportOnlyKeys(Redaction.redactDiagnostic(value))
}

/**
 * The report body.
 *
 * @category models
 * @since 1.0.0
 */
export interface Report {
  readonly summary: string
  readonly version: string
  readonly platform: string
  readonly node: string
  readonly runs: unknown
  readonly digest?: unknown
}

/**
 * Assembles a scrubbed report for the bug endpoint. It throws before returning
 * when the value cannot be walked safely within the journal's bounds, which
 * prevents the caller from posting a partially inspected body.
 *
 * @category constructors
 * @since 1.0.0
 */
export const report = (input: Report): Report => scrub(input) as Report

/**
 * How long the post is allowed to take before the command gives up.
 *
 * @category constants
 * @since 1.0.0
 */
export const timeoutMs = 15_000
