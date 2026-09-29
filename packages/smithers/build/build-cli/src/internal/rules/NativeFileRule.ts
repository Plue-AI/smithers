/**
 * Planning and execution of a single copied or literal file.
 *
 * @since 1.0.0
 */

import * as Input from "@smthrs/targets/Input"
import type * as NodeArtifact from "@smthrs/targets/NodeArtifact"
import * as Target from "@smthrs/targets/Target"
import { constants } from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import type * as Rule from "../RuleContract.ts"
import * as NativeArtifactOutput from "./NativeArtifactOutput.ts"

type Selection = Extract<Rule.Selection, { readonly rule: "Copy" | "Literal" }> & {
  readonly outFiles: readonly [string]
}
interface Request {
  readonly rule: "Copy" | "Literal"
  readonly attrs: unknown
  readonly packagePath: string
  readonly labelFor: (target: Target.AnyTarget) => string
}
interface Context extends Rule.ExecutionContext {
  readonly nodes: ReadonlyMap<string, Rule.PlannedRule>
}

/** The native file contract; artifact caching is owned by the coordinator.
 * @category execution
 * @since 1.0.0
 */
export const contract: Rule.Contract<Selection, Request, void, Context> = {
  plan: ({ rule, attrs, packagePath, labelFor }) => {
    if (rule === "Literal") {
      const literal = attrs as (typeof NodeArtifact.LiteralAttrs)["Type"]
      return {
        ok: true,
        value: {
          family: "files",
          rule,
          lane: { kind: "native-file", flavor: "literal", text: literal.content },
          outFiles: [Input.resolvePath(packagePath, literal.path)]
        }
      }
    }
    const copy = attrs as (typeof NodeArtifact.CopyAttrs)["Type"]
    return {
      ok: true,
      value: {
        family: "files",
        rule,
        lane: Target.isTarget(copy.from)
          ? { kind: "native-file", flavor: "copy", sourceLabel: labelFor(copy.from) }
          : { kind: "native-file", flavor: "copy", source: Input.resolvePath(packagePath, copy.from.path) },
        outFiles: [Input.resolvePath(packagePath, copy.to)]
      }
    }
  },
  execute: async (node, { root, nodes, signal }) => {
    if (node.lane.flavor === "literal") {
      await NativeArtifactOutput.publish(root, node.outFiles[0], async (temporary, checkParent) => {
        await checkParent()
        await Fs.writeFile(temporary, node.lane.text ?? "", { encoding: "utf8", flag: "wx", signal })
      }, signal)
      return
    }
    let source = node.lane.source
    if (source === undefined && node.lane.sourceLabel !== undefined) {
      const producer = nodes.get(node.lane.sourceLabel)
      if (producer === undefined) throw new Error(`copy source ${node.lane.sourceLabel} was not planned`)
      if (producer.outFiles.length !== 1) {
        throw new Error(`copy source ${node.lane.sourceLabel} must declare exactly one output file`)
      }
      source = producer.outFiles[0]
    }
    if (source === undefined) throw new Error("copy source did not resolve to a file")
    const absoluteSource = NodePath.join(root, ...source.split("/"))
    await NativeArtifactOutput.publish(root, node.outFiles[0], async (temporary, checkParent) => {
      await checkParent()
      await Fs.copyFile(absoluteSource, temporary, constants.COPYFILE_EXCL)
    }, signal)
  }
}

/** Narrows the scheduler's node at this rule's dispatch boundary.
 * @category guards
 * @since 1.0.0
 */
export const accepts = (node: Rule.PlannedRule): node is Rule.Planned<Selection> =>
  node.family === "files" && node.lane.kind === "native-file" && node.outFiles.length === 1
