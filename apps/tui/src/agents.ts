/**
 * Custom agents: a repository's markdown flows (`flows/<name>/flow.mdx` or
 * `SKILL.md`) run as interactive worker tabs.
 *
 * The descriptor is the agent definition: its body is the system prompt,
 * `model` the seat, `effort` the reasoning effort, `flows` the standard flows
 * it may call and `capabilities` its envelope. The body is read only when a
 * tab launches, never when it is requested.
 */
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { FlowBodyPrompt } from "@smthrs/registry/Descriptor"
import * as MarkdownFlow from "@smthrs/registry/MarkdownFlow"
import { Schema } from "effect"
import * as Extension from "./extension.ts"
import type * as Flows from "./flows.ts"

export type Code = "unknown_agent" | "not_an_agent" | "not_invocable" | "unreadable" | "unknown_seat" | "unknown_effort"

/** A refusal or launch failure: a code and one line of text. */
export class AgentError extends Error {
  constructor(readonly code: Code, message: string) {
    super(message.split("\n")[0]!.trim())
  }
}

/** What `host.run` applies to a worker turn. Empty `flows` and `envelope` keep the host's defaults. */
export interface Profile {
  readonly name: string
  readonly digest: string
  readonly system: string
  /** The declared seat, resolved; undefined when the file names none. */
  readonly seat?: string
  readonly fallbackSeats?: ReadonlyArray<string>
  readonly thinking?: ModelRequest.ReasoningEffort
  readonly flows: ReadonlyArray<string>
  readonly envelope: ReadonlyArray<string>
}

/** The listed agent `name`, or a typed refusal. Only a person may start a `disable-model-invocation` agent. */
export const find = (
  listed: ReadonlyArray<Extension.Descriptor>,
  name: string,
  by: "user" | "agent"
): Extension.Descriptor => {
  const found = listed.find((each) => each.name === name)
  if (found === undefined) throw new AgentError("unknown_agent", `No agent named ${name}`)
  if (!Extension.isAgent(found)) {
    throw new AgentError("not_an_agent", `${name} is a module flow; run it with smithers.run or /flow`)
  }
  if (by === "agent" && !found.modelInvocable) throw new AgentError("not_invocable", `${name} is for a person to start`)
  return found
}

const isEffort = Schema.is(ModelRequest.ReasoningEffort)

export const profile = (
  descriptor: Extension.Descriptor,
  body: Flows.Body,
  seatOf: (declared: string) => string | undefined
): Profile => {
  const seat = descriptor.seat === undefined ? undefined : seatOf(descriptor.seat)
  if (descriptor.seat !== undefined && seat === undefined) {
    throw new AgentError("unknown_seat", `Unknown model ${descriptor.seat}`)
  }
  const fallbackSeats = descriptor.fallbackSeats?.map((declared) => {
    const seat = seatOf(declared)
    if (seat === undefined) throw new AgentError("unknown_seat", `Unknown model ${declared}`)
    return seat
  })
  if (descriptor.effort !== undefined && !isEffort(descriptor.effort)) {
    throw new AgentError("unknown_effort", `Unknown effort ${descriptor.effort}`)
  }
  // The file's own list: the registry widens a body that declares `flows:` to `*`, but the
  // worker enforces this envelope per call, so the declared narrowing still holds.
  const declared = body.capabilities ?? descriptor.capabilities
  // A bare `*` (no `capabilities:`) is the host default.
  const envelope = declared.filter((capability) => capability !== "*")
  return {
    name: descriptor.name,
    digest: body.digest,
    system: MarkdownFlow.renderPrompt(new FlowBodyPrompt({ text: body.text, baseDirectory: body.baseDirectory }), {
      args: ""
    }),
    ...(seat === undefined ? {} : { seat }),
    ...(fallbackSeats === undefined ? {} : { fallbackSeats }),
    ...(descriptor.effort === undefined ? {} : { thinking: descriptor.effort }),
    flows: descriptor.flows,
    envelope: envelope.length === declared.length ? envelope : []
  }
}

/** A failed body read, as the tab's typed failure. */
export const unreadable = (error: unknown): AgentError =>
  error instanceof AgentError
    ? error
    : new AgentError("unreadable", error instanceof Error ? error.message : String(error))

/** The coordinator's `Agents:` context: model-invocable agents, at most 20. */
export const context = (listed: ReadonlyArray<Extension.Descriptor>): string =>
  JSON.stringify(
    listed.filter((each) => Extension.isAgent(each) && each.modelInvocable).slice(0, 20).map((
      { name, description }
    ) => ({
      name,
      description
    }))
  )

/** Where a workspace finds agents: the last listing, and a fresh listing plus body at launch. */
export interface Port {
  /** The last discovery; undefined before the first one. */
  readonly listed: () => ReadonlyArray<Extension.Descriptor> | undefined
  /** Re-lists, so edits apply, then reads the body. */
  readonly load: (name: string) => Promise<{ readonly descriptor: Extension.Descriptor; readonly body: Flows.Body }>
}

/** Agents over the flow runs' discovery and the flows port's body read. */
export const port = (
  runs: {
    readonly known: () => ReadonlyArray<Extension.Descriptor> | undefined
    readonly listing: () => Promise<ReadonlyArray<Extension.Descriptor>>
  },
  flows: Pick<Flows.Port, "body">
): Port => ({
  listed: runs.known,
  load: async (name) => {
    const descriptor = find(await runs.listing(), name, "user")
    return { descriptor, body: await flows.body(name) }
  }
})
