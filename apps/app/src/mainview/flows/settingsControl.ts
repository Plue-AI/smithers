import type { CardCommandInput } from "@smthrs/rpc/CardAction"
import type { CardActionDefinition } from "./cardActions"

export type SettingsOperation = NonNullable<NonNullable<CardCommandInput["settings"]>["operation"]>

/** Bound operation arguments distinguish controls that share the Settings door. */
export const settingsControl = (operation: SettingsOperation, definition: CardActionDefinition<"settings">): CardActionDefinition<"settings"> => ({
  ...definition, args: { ...definition.args, operation }, command_input: { ...definition.command_input, operation },
  ...(definition.resolve_input ? { resolve_input: (input: Record<string, string>) => ({ ...definition.resolve_input!(input), operation }) } : {})
})
