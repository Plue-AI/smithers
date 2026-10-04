import type { CardCommandInput, CatalogTag } from "@smthrs/rpc/CardAction"
import { writeOnlyGesture, type CommandGesture } from "../flows/CommandGesture"
import type { CardActionDefinition, CardCommandDispatch } from "../flows/cardActions"
import type { InstallModel } from "../state/seams/InstallModel"

/** The command host forwards this nonserializable gesture to commands.submit. */
export type InstallCardDispatch = <Tag extends CatalogTag>(tag: Tag, input: CardCommandInput[Tag], gesture?: CommandGesture) => unknown

// T-APP-03: direct key fields and slash-opened forms use the same write-only door.
export const installKeyAction = (dispatch: InstallCardDispatch, model: InstallModel) => {
  let reserved: CommandGesture | undefined
  const coding = model.models.find(role => role.role === "coding")!
  const definition: CardActionDefinition<"settings.model-key"> = {
    tag: "settings.model-key", label: "Change model key", command_input: { role: "coding", provider: coding.provider },
    resolve_input: input => {
      reserved?.release()
      reserved = input.value ? writeOnlyGesture("settings.model-key", { value: input.value }) : undefined
      delete input.value
      const role = input.role === "fast" || input.role === "jev" ? input.role : "coding"
      return { role, provider: input.provider ?? model.models.find(model => model.role === role)!.provider, ...(input.model ? { model: input.model } : {}) }
    }
  }
  const run: CardCommandDispatch = (tag, input) => {
    const gesture = reserved
    reserved = undefined
    try {
      const result = dispatch(tag, input, tag === "settings.model-key" ? gesture : undefined)
      if (result instanceof Promise) void result.finally(() => gesture?.release()).catch(() => {})
      return result
    } catch (cause) { gesture?.release(); throw cause }
  }
  return { definition, dispatch: run }
}
