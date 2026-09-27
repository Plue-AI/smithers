/**
 * Paired native rules selected once for both planning and execution.
 *
 * @since 1.0.0
 */

import type * as DocsCheck from "@smthrs/targets/DocsCheck"
import type * as Input from "@smthrs/targets/Input"
import type * as Target from "@smthrs/targets/Target"
import type * as Rule from "../RuleContract.ts"
import * as DocsCheckRule from "./DocsCheckRule.ts"
import * as FetchRule from "./FetchRule.ts"
import * as NativeFileRule from "./NativeFileRule.ts"

interface Request {
  readonly rule: string
  readonly target: Target.AnyTarget
  readonly attrs: unknown
  readonly packagePath: string
  readonly labelFor: (target: Target.AnyTarget) => string
  readonly docsFiles: (attrs: DocsCheck.Attrs) => ReadonlyArray<Input.FileDigest> | string
}
interface Context extends Rule.ExecutionContext {
  readonly nodes: ReadonlyMap<string, Rule.PlannedRule>
}
interface Result {
  readonly output?: unknown
  readonly note?: string
}
interface Entry {
  readonly plan: (request: Request) => Rule.PlanResult<Rule.Selection & Partial<Rule.SharedFields>>
  readonly cache: "artifacts" | "result"
  readonly prepare: (node: Rule.PlannedRule, context: Context) => (signal?: AbortSignal) => Promise<Result>
}

const file: Entry = {
  plan: (request) =>
    NativeFileRule.contract.plan({ ...request, rule: request.rule === "Literal" ? "Literal" : "Copy" }),
  cache: "artifacts",
  prepare: (node, context) => {
    if (!NativeFileRule.accepts(node)) throw new Error(`${node.rule} planned no single output file`)
    return async (signal = context.signal) => {
      await NativeFileRule.contract.execute(node, { ...context, signal })
      return {}
    }
  }
}

const entries: Readonly<Record<string, Entry>> = {
  Fetch: {
    plan: FetchRule.contract.plan,
    cache: "artifacts",
    prepare: (node, context) => {
      if (node.family !== "fetch") throw new Error("Fetch planned no single output file")
      return async (signal = context.signal) => {
        const result = await FetchRule.contract.execute(node, { ...context, signal })
        return { note: `fetched ${result.bytes} byte(s)` }
      }
    }
  },
  Copy: file,
  Literal: file,
  "Docs.Check": {
    plan: DocsCheckRule.contract.plan,
    cache: "result",
    prepare: (node, context) => {
      if (!DocsCheckRule.accepts(node)) throw new Error("Docs.Check planned no closure")
      return (signal = context.signal) => DocsCheckRule.contract.execute(node, { ...context, signal })
    }
  }
}

/** Resolves a paired rule. The coordinator owns cache replay and publication.
 * @category execution
 * @since 1.0.0
 */
export const get = (rule: string): Entry | undefined => Object.hasOwn(entries, rule) ? entries[rule] : undefined
