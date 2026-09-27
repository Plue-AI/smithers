/**
 * Late stamp resolution. Values are deliberately read only immediately before spawn.
 *
 * @since 0.1.0
 */

import * as Stamp from "@smthrs/targets/Stamp"
import * as PackageTree from "./PackageTree.ts"

/**
 * The `{smthrs:stamp:<payload>}` token spelling a planned argv carries, shared
 * with the declaration side that produced it.
 *
 * @category constants
 * @since 0.1.0
 */
export const token = Stamp.token

/**
 * The stamp names {@link Stamp.Value} admits, as a runtime set.
 *
 * The payload is decoded from a token in a planned argv, not through the
 * schema, so an unrecognized name has to be rejected here. Returning empty
 * text instead would stamp a produced binary with nothing and leave no trace
 * that a stamp was dropped.
 */
const stampNames = new Set(["version", "commit", "commitDate", "buildTime", "versionMeta"])

const stampValue = async (
  root: string,
  value: { readonly _tag?: unknown; readonly name?: unknown } | string
): Promise<string> => {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null || value._tag !== "Stamp") {
    throw new Error("invalid build stamp: only public stamps and literals are supported")
  }
  if (typeof value.name !== "string" || !stampNames.has(value.name)) {
    throw new Error(`unknown build stamp: ${JSON.stringify(String(value.name))}`)
  }
  switch (value.name) {
    case "version":
      return (await PackageTree.runGit(root, ["describe", "--tags", "--always", "--dirty"])).trim()
    case "commit":
      return (await PackageTree.runGit(root, ["rev-parse", "HEAD"])).trim()
    case "commitDate":
      return (await PackageTree.runGit(root, ["show", "-s", "--format=%cI", "HEAD"])).trim()
    case "buildTime":
      return new Date().toISOString()
    default: {
      // `tag --points-at` represents an untagged commit with successful empty
      // output, so an actual git failure remains distinguishable from "dev".
      const exact = await PackageTree.runGit(root, ["tag", "--points-at", "HEAD"])
      return exact.trim() === "" ? "dev" : ""
    }
  }
}

const expression = /\{smthrs:stamp:([A-Za-z0-9_-]+)\}/g

/**
 * Substitutes every stamp token in a planned argv immediately before spawn.
 *
 * Resolution is late on purpose: `version`, `commit`, and `commitDate` read
 * the repository as it stands when the target runs, not as it stood when the
 * plan was built. An unrecognized stamp name and a corrupt token both fail the
 * target rather than resolving to empty text, because a binary stamped with
 * nothing is indistinguishable from one stamped correctly. The substitution
 * uses the function form of `String.prototype.replace`, so a `$&` or `$1` in a
 * git tag is inserted literally rather than expanded.
 *
 * @category execution
 * @since 0.1.0
 */
export const resolveArgv = async (root: string, argv: ReadonlyArray<string>): Promise<Array<string>> => {
  const resolved: Array<string> = []
  for (const arg of argv) {
    let text = arg
    for (const match of arg.matchAll(expression)) {
      let payload: {
        readonly name: string
        readonly value: { readonly _tag?: unknown; readonly name?: unknown } | string
      }
      try {
        payload = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"))
      } catch (cause) {
        throw new Error(`invalid build stamp token in ${JSON.stringify(arg)}`, { cause })
      }
      if (typeof payload !== "object" || payload === null) {
        throw new Error(`invalid build stamp token in ${JSON.stringify(arg)}`)
      }
      const stamped = await stampValue(root, payload.value)
      text = text.replace(match[0], () => stamped)
    }
    resolved.push(text)
  }
  return resolved
}
