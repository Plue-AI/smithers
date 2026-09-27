/**
 * The apps the directory's homepage declares (`.smithers/home.json`, the
 * projection of `.smithers/FACTORY.ts`; PRODUCT.md D-18): the TUI home lists
 * them, and a row whose flow is discovered here runs it. Read once per
 * directory; a missing or malformed file declares nothing.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface App {
  readonly flow: string
  readonly title: string
  readonly picture: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** The `app` blocks of `<cwd>/.smithers/home.json`, in declaration order. */
export const read = (cwd: string): ReadonlyArray<App> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(cwd, ".smithers", "home.json"), "utf8"))
  } catch {
    return []
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["blocks"])) return []
  return parsed["blocks"].flatMap((block): Array<App> => {
    if (!isRecord(block) || block["type"] !== "app") return []
    const { flow, title, picture } = block
    if (typeof flow !== "string" || flow === "" || typeof title !== "string" || title === "") return []
    return [{ flow, title, picture: typeof picture === "string" ? picture : "" }]
  })
}
