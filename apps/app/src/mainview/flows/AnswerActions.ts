import { cardActions, type CardCommandDispatch } from "./cardActions"

/** J9 answer doors. The answer View renders these viewer-filtered actions. */
export const answerActions = (dispatch: CardCommandDispatch, text: string) => cardActions(dispatch, [
  { tag: "todo.new", label: "Make TODO", command_input: { text } },
  { tag: "wiki.save", label: "Save to wiki", command_input: { name: "" },
    input: [{ name: "name", label: "Name", kind: "text", required: true }],
    resolve_input: input => ({ name: input.name ?? "", text }) }
])
