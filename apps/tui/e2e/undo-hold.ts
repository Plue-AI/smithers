/**
 * The real undo module whose `commit` waits for the test: it writes
 * `$SMITHERS_TUI_UNDO_HOLD.held` on entry and proceeds once the test creates
 * `$SMITHERS_TUI_UNDO_HOLD`, so an undo stays pending for as long as a case needs.
 */
import { existsSync, writeFileSync } from "node:fs"
import * as Real from "../src/undo.ts"

export * from "../src/undo.ts"

const gate = process.env.SMITHERS_TUI_UNDO_HOLD!
export const commit: typeof Real.commit = async (...args) => {
  writeFileSync(`${gate}.held`, "")
  while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 20))
  return Real.commit(...args)
}
