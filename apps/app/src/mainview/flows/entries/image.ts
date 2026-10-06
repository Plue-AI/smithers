import { Schema } from "effect"
import { flow, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

export const imageFlows = (actions: CommandActions): readonly FlowEntry[] => [
 flow({ name: "image.add", summary: "Add to machine image", args: "<name>", input: Schema.Struct({ name: Schema.NonEmptyString }),
  grammar: args => {
   if (!args?.trim().startsWith("{")) return { payload: args?.trim() ? { name: args.trim() } : {} }
   try { return { payload: JSON.parse(args) as Record<string, unknown> } } catch { return { error: "Invalid package input" } }
  },
  form: { submitLabel: "Draft", fields: { name: { label: "Package" } }, args: payload => JSON.stringify(payload) },
  handler: ({ name }) => actions.draftImagePackage(name) })
]
