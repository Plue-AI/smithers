/**
 * `smthrs todo`: the install's TODOs from a terminal. `todo answer` answers
 * the open question a TODO's agent asked (Needs you), as the app's Answer
 * does: the first answer settles it and resumes the run. In a branch's
 * terminal the CLI signs in with the terminal's credential, which answers
 * only that branch's TODO; the answer shows as that terminal's, or as the
 * agent's working in it ("Claude Code for Ben").
 * @since 1.0.0
 */

import { Refused, UsageError } from "../../CliError.ts"
import { list, object, str } from "./Client.ts"
import * as ProductApi from "./ProductApi.ts"
import type { Handler } from "./Resources.ts"

/** A TODO number as people write it: `3`, `T3` or `#3`. */
const todoNumber = (value: unknown): number => {
  const raw = str(value).trim()
  if (!/^[Tt#]?\d{1,15}$/.test(raw) || Number(raw.replace(/^[Tt#]/, "")) <= 0) {
    throw new UsageError({ message: "Expected a TODO number (3 or T3)" })
  }
  return Number(raw.replace(/^[Tt#]/, ""))
}

/** @private
 * @since 1.0.0
 */
export const todos: Record<string, Handler> = {
  "todo answer": async (c, a, o) => {
    const n = todoNumber(a.todo)
    const answer = str(a.answer)
    if (answer.trim() === "") throw new UsageError({ message: "An answer is required" })
    let wait = str(o.wait).trim()
    if (wait === "") {
      // The one question the TODO asks now; with several, the caller names one.
      const asked = list((await ProductApi.getApiTodosN(c, { path: { n } })).waits).map(object)
        .filter((row) => row.kind === "question")
      if (asked.length === 0) throw new Refused({ fault: "user", code: "no_question", message: `T${n} asks nothing` })
      if (asked.length > 1) {
        throw new Refused({
          fault: "user",
          code: "several_questions",
          message: `T${n} asks ${asked.length} questions; name one with --wait (${
            asked.map((row) => str(row.id)).join(", ")
          })`
        })
      }
      wait = str(asked[0]!.id)
    }
    const receipt = await ProductApi.postApiTodosNAnswer(c, { path: { n }, body: { wait, answer } })
    return { todo: n, wait, ...receipt }
  }
}

/**
 * Each TODO command's human body.
 * @private
 * @since 1.0.0
 */
export const humans: Record<string, (value: unknown) => string> = {
  "todo answer": (value) => `Answered T${object(value).todo}`
}
