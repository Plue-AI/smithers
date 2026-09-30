/**
 * Repair Git patch headers using jj's structured path metadata.
 *
 * @since 1.0.0
 */

import { JjInternalFault } from "./JjInternalFault.ts"

/** Git's pathname quoting, rather than JSON's unsupported \u escapes. */
const quotePath = (path: string): string => {
  const characters = Array.from(path)
  if (!characters.some((char) => char <= " " || char === "\x7f" || char === "\"" || char === "\\")) return path
  return `"${
    characters.map((char) => {
      switch (char) {
        case "\n":
          return "\\n"
        case "\r":
          return "\\r"
        case "\t":
          return "\\t"
        case "\"":
          return "\\\""
        case "\\":
          return "\\\\"
        default:
          return char < " " || char === "\x7f" ? `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}` : char
      }
    }).join("")
  }"`
}

/**
 * jj 0.39 emits literal paths in Git headers (jj-vcs/jj v0.39.0,
 * cli/src/diff_util.rs::show_git_diff). Read paths from its JSON template:
 * splitting raw headers on whitespace cannot distinguish pathname bytes.
 * Consume complete known paths before looking for the next header, and never
 * rewrite hunk contents, even when they resemble headers. Accept the quoted
 * form as well so normalization is idempotent.
 *
 * @private
 * @since 1.0.0
 */
export const quoteGitPatchPaths = (patch: string, paths: string): string => {
  const entries = paths === "" ? [] : paths.trimEnd().split("\n").map((line): string => {
    const path: unknown = JSON.parse(line)
    if (typeof path !== "string") {
      throw new JjInternalFault({ code: "patch_path_metadata_invalid", message: "Invalid jj diff path metadata" })
    }
    return path
  })
  if (entries.length % 2 !== 0) {
    throw new JjInternalFault({ code: "patch_path_metadata_incomplete", message: "Incomplete jj diff path metadata" })
  }
  let cursor = 0
  const output: Array<string> = []
  const consume = (text: string) => {
    if (!patch.startsWith(text, cursor)) {
      throw new JjInternalFault({
        code: "patch_headers_disagree",
        message: "jj diff headers disagree with path metadata"
      })
    }
    cursor += text.length
  }
  const pathField = (prefix: string, path: string, suffix = "\n") => {
    const quoted = quotePath(path)
    const raw = `${prefix}${path}${suffix}`
    consume(patch.startsWith(raw, cursor) ? raw : `${prefix}${quoted}${suffix}`)
    output.push(`${prefix}${quoted}${suffix}`)
  }
  for (let index = 0; index < entries.length; index += 2) {
    const source = entries[index]!
    const target = entries[index + 1]!
    pathField("diff --git ", `a/${source}`, " ")
    pathField("", `b/${target}`)
    while (true) {
      const metadata = /^(?:(?:new file|deleted file|old|new) mode [0-7]+|index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]+)?)\n/
        .exec(patch.slice(cursor))
      if (metadata !== null) {
        consume(metadata[0])
        output.push(metadata[0])
      } else if (patch.startsWith("rename from ", cursor) || patch.startsWith("copy from ", cursor)) {
        const operation = patch.startsWith("rename", cursor) ? "rename" : "copy"
        pathField(`${operation} from `, source)
        pathField(`${operation} to `, target)
      } else break
    }
    if (patch.startsWith("--- ", cursor)) {
      pathField("--- ", patch.startsWith("--- /dev/null\n", cursor) ? "/dev/null" : `a/${source}`)
      pathField("+++ ", patch.startsWith("+++ /dev/null\n", cursor) ? "/dev/null" : `b/${target}`)
    } else if (patch.startsWith("Binary files ", cursor)) {
      pathField(
        "Binary files ",
        patch.startsWith("Binary files /dev/null and ", cursor) ? "/dev/null" : `a/${source}`,
        " and "
      )
      pathField("", patch.startsWith("/dev/null differ\n", cursor) ? "/dev/null" : `b/${target}`, " differ\n")
    }
    // Hunk lines start with a space, +, -, @, or backslash; an unprefixed
    // diff header can only begin the next entry after consuming its paths.
    const next = patch.startsWith("diff --git ", cursor) ? cursor : patch.indexOf("\ndiff --git ", cursor)
    const end = next < 0 ? patch.length : next === cursor ? cursor : next + 1
    output.push(patch.slice(cursor, end))
    cursor = end
  }
  if (cursor !== patch.length) {
    throw new JjInternalFault({
      code: "patch_output_unexpected",
      message: "Unexpected jj diff output after path metadata"
    })
  }
  return output.join("")
}
