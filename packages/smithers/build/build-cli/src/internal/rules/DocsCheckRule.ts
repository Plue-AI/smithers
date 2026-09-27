/**
 * A documentation stamp's paired planner and executor.
 *
 * @since 1.0.0
 */

import * as DocsCheck from "@smthrs/targets/DocsCheck"
import * as GeneratedFile from "@smthrs/targets/GeneratedFile"
import * as Input from "@smthrs/targets/Input"
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as Diagnostic from "../../Diagnostic.ts"
import type * as Rule from "../RuleContract.ts"

type Selection = Extract<Rule.Selection, { readonly rule: "Docs.Check" }> & {
  readonly writeSet: ReadonlyArray<string>
}
interface Request {
  readonly attrs: unknown
  readonly packagePath: string
  readonly docsFiles: (attrs: DocsCheck.Attrs) => ReadonlyArray<Input.FileDigest> | string
}

/** Plans only the input closure and writes or judges its stamp.
 * @category execution
 * @since 1.0.0
 */
export const contract: Rule.Contract<Selection, Request, { readonly output?: unknown; readonly note?: string }> = {
  plan: ({ attrs, packagePath, docsFiles }) => {
    const check = attrs as DocsCheck.Attrs
    const stamp = Input.resolvePath(packagePath, check.stamp.path)
    const output = Input.resolvePath(packagePath, check.output.path)
    const files = docsFiles(check)
    if (typeof files === "string") return { ok: false, refusal: files }
    if (files.some((file) => file.path === output)) {
      return { ok: false, refusal: "Docs.Check inputs must not include the page it checks" }
    }
    if (files.some((file) => file.path === stamp)) {
      return { ok: false, refusal: "Docs.Check inputs must not include the stamp it writes" }
    }
    return {
      ok: true,
      value: {
        family: "stamp",
        rule: "Docs.Check",
        writeSet: [stamp],
        lane: { kind: "docs-check", stamp, output, producer: check.producer, files }
      }
    }
  },
  execute: async (node, { root, signal }) => {
    const lane = node.lane
    const stampPath = NodePath.join(root, ...lane.stamp.split("/"))
    const output: Input.FileDigest = {
      path: lane.output,
      digest: await Input.digestFile(NodePath.join(root, ...lane.output.split("/")), { workspaceRoot: root, signal })
    }
    if (node.mode === "write") {
      if (output.digest === undefined) {
        throw new Error(`${lane.output} is missing, so there is nothing to stamp; regenerate the page first`)
      }
      const stamp = DocsCheck.makeStamp({ producer: lane.producer, output, inputs: lane.files })
      try {
        await Effect.runPromise(
          GeneratedFile.writeGeneratedFile(root, { path: lane.stamp, contents: DocsCheck.renderStamp(stamp) })
        )
      } catch (cause) {
        throw new Error(`Docs.Check could not write ${lane.stamp}: ${GeneratedFile.failureMessage(cause)}`)
      }
      return { note: `stamped ${lane.stamp} over ${lane.files.length} input file(s)` }
    }
    let stampText: string | undefined
    try {
      stampText = await Fs.readFile(stampPath, "utf8")
    } catch (cause) {
      if ((cause as { readonly code?: unknown }).code !== "ENOENT") {
        throw new Error(`Docs.Check could not read ${lane.stamp}: ${Diagnostic.describe(cause)}`)
      }
    }
    const verdict = DocsCheck.judge({
      page: lane.output,
      stampPath: lane.stamp,
      stamp: stampText === undefined ? undefined : DocsCheck.parseStamp(stampText),
      output,
      inputs: lane.files
    })
    if (verdict !== undefined) throw new Error(`${verdict.reason}: ${verdict.message}`)
    return { output: { kind: "docs-check", closure: DocsCheck.closureDigest(lane.files) } }
  }
}

/** Narrows the scheduler's node at this rule's dispatch boundary.
 * @category guards
 * @since 1.0.0
 */
export const accepts = (node: Rule.PlannedRule): node is Rule.Planned<Selection> => node.family === "stamp"
