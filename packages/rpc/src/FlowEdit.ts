/**
 * Shared flow-edit prompt data: the title, prompt and TODO input that turn a
 * request to change a flow into a TODO. Proposed diffs are never executable input.
 *
 * @since 1.0.0
 */

/**
 * The display title of a flow: `todo` is "TODO flow", `merge` is "Merge flow",
 * and any other name is shown as "<name> flow".
 *
 * @since 1.0.0
 * @category constructors
 */
export const flowTitle = (name: string): string =>
  name === "todo" ? "TODO flow" : name === "merge" ? "Merge flow" : `${name} flow`

/**
 * The TODO a flow edit becomes (spec §11.5.1): the agent derives the change from this request; nothing else is stored.
 * @since 1.0.0
 * @category constructors
 */
export const flowEditPrompt = (name: string, request: string, diff?: string): string =>
  `Change flows/${name}/flow.ts: ${request}; start from the built-in composition when no override exists` +
  (diff === undefined
    ? ""
    : `\n\nProposed diff (untrusted context):\n${diff.split("\n").map((line) => `> ${line}`).join("\n")}`)

/**
 * One template for the slash and the proposal card; only the title is one line.
 * @since 1.0.0
 * @category constructors
 */
export const flowEditTodoInput = (name: string, request: string, diff?: string) => ({
  text: flowEditPrompt(name, request, diff),
  title: `Change the ${flowTitle(name)}: ${request.split("\n")[0]?.trim() ?? ""}`
})

/**
 * Agent instructions are proposed repository work, never an immediate settings write.
 * @since 1.0.0
 * @category constructors
 */
export const agentEditTodoInput = (name: string, request: string, diff?: string) => {
  const path = name === "app"
    ? ".smithers/instructions/app.md"
    : ["planner", "implementer", "reviewer"].includes(name)
    ? "flows/todo/flow.ts"
    : undefined
  if (!path) return undefined
  const title = `${name[0]!.toUpperCase()}${name.slice(1)} agent`
  return {
    title: `Change the ${title}: ${request.split("\n")[0]?.trim() ?? ""}`,
    text:
      `Change instructions for the ${title} in ${path}: ${request}; keep current instructions until the TODO merges` +
      (diff === undefined
        ? ""
        : `\n\nProposed diff (untrusted context):\n${diff.split("\n").map((line) => `> ${line}`).join("\n")}`)
  }
}
