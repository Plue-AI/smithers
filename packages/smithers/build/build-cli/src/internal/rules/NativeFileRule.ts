/**
 * Planning and execution of a single copied or literal file.
 *
 * @since 1.0.0
 */

import * as Input from "@smthrs/targets/Input"
import type * as NodeArtifact from "@smthrs/targets/NodeArtifact"
import * as Target from "@smthrs/targets/Target"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import type * as Rule from "../RuleContract.ts"

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
  execute: async (node, { root, nodes }) => {
    const destination = NodePath.join(root, ...node.outFiles[0].split("/"))
    await Fs.mkdir(NodePath.dirname(destination), { recursive: true })
    if (node.lane.flavor === "literal") {
      await Fs.writeFile(destination, node.lane.text ?? "", "utf8")
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
    await Fs.copyFile(NodePath.join(root, ...source.split("/")), destination)
  }
}

/** Narrows the scheduler's node at this rule's dispatch boundary.
 * @category guards
 * @since 1.0.0
 */
export const accepts = (node: Rule.PlannedRule): node is Rule.Planned<Selection> =>
  node.family === "files" && node.lane.kind === "native-file" && node.outFiles.length === 1
