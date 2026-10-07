/** Shared flow-edit prompt data. Proposed diffs are never executable input.
 * @since 1.0.0
 */
export const flowTitle = (name: string): string => name === "todo" ? "TODO flow" : name === "merge" ? "Merge flow" : `${name} flow`

/** The TODO a flow edit becomes (spec §11.5.1): the agent derives the change from this request; nothing else is stored.
 * @since 1.0.0
 */
export const flowEditPrompt = (name: string, request: string, diff?: string): string =>
  `Change flows/${name}/flow.ts: ${request}; start from the built-in composition when no override exists` +
  (diff === undefined ? "" : `\n\nProposed diff (untrusted context):\n${diff.split("\n").map(line => `> ${line}`).join("\n")}`)

/** One template for the slash and the proposal card; only the title is one line.
 * @since 1.0.0
 */
export const flowEditTodoInput = (name: string, request: string, diff?: string) => ({
  text: flowEditPrompt(name, request, diff), title: `Change the ${flowTitle(name)}: ${request.split("\n")[0]?.trim() ?? ""}`
})

