/** One derived private Registry shared by approval, authority and execution. */
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as MarkdownFlow from "@smthrs/registry/MarkdownFlow"
import * as Registry from "@smthrs/registry/Registry"
import { registryError } from "@smthrs/registry/RegistryError"
import { Effect, Option } from "effect"

const key = "smithersCodingWikiPolicy"
export const bindWikiRegistry = (base: Registry.Registry, policy: string): Registry.Registry => {
  const derived = (descriptor: Descriptor.FlowDescriptor) =>
    descriptor.flows.includes("coding/WikiCheck")
      ? new Descriptor.FlowDescriptor({ ...descriptor, frontmatter: { ...descriptor.frontmatter, [key]: policy } }) :
      descriptor
  const get = (name: string) => base.get(name).pipe(Effect.map(derived))
  const loadBody: Registry.Registry["loadBody"] = (name, expected) =>
    Effect.gen(function*() {
      const original = yield* base.get(name), descriptor = derived(original)
      if (expected !== undefined && Descriptor.executionDigest(descriptor) !== expected) {
        return yield* registryError({
          code: "execution_changed",
          method: "loadBody",
          path: original.path,
          description: `flow "${name}" or its host wiki policy changed after planning; create and approve a new plan`
        })
      }
      // Base load checks its unchanged source identity and exact body bytes. Never
      // send it the derived identity it cannot know, or omit the source fence.
      return yield* base.loadBody(name, Descriptor.executionDigest(original))
    })
  return Registry.Registry.of({
    list: () => base.list().pipe(Effect.map((values) => values.map(derived))),
    visible: () => base.visible().pipe(Effect.map((values) => values.map(derived))),
    get,
    getOption: (name) => base.getOption(name).pipe(Effect.map(Option.map(derived))),
    loadBody,
    runPrompt: (name, input) =>
      loadBody(name).pipe(Effect.flatMap((body) =>
        body._tag === "Prompt"
          ? Effect.succeed(MarkdownFlow.renderPrompt(body, input))
          : Effect.fail(
            registryError({
              code: "not_prompt_flow",
              method: "runPrompt",
              description: `flow "${name}" is module-backed`
            })
          )
      )),
    refresh: () => base.refresh(),
    warnings: () => base.warnings()
  })
}
