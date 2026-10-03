import * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Effect, Schema } from "effect"
import { StorageRecoveryError } from "../chain/StorageRecovery"
import { recoveryFailure } from "../chain/StorageFailureCopy"
import {
  STORAGE_RECOVERY_EXPORT,
  STORAGE_RECOVERY_RESET,
  STORAGE_RECOVERY_USER_ONLY_REASON,
  STORAGE_RESET_USER_ONLY_REASON
} from "../state/StorageRecoveryContract"
import type { FlowEntry } from "./registry"

const input = Schema.Struct({})
const declaration = ({ capabilities: [], effects: undefined,
  name: STORAGE_RECOVERY_EXPORT,
  description: "Prepare a private local recovery download",
  input,
  output: Schema.Struct({}),
})

/** One declaration/binding factory for startup, slash, button and agent refusal. */
export const storageRecoveryExportFlow = (run: () => Promise<string | void>): FlowEntry => ({
  binding: FlowBinding.make({
    flow: declaration,
    modelInvocable: false,
    publicError: (message: string) => message,
    handler: () =>
      Effect.tryPromise({
        try: run,
        catch: () => recoveryFailure(new StorageRecoveryError("unreadable"))
      }).pipe(Effect.flatMap((refusal) => refusal === undefined ? Effect.succeed({}) : Effect.fail(refusal)))
  }),
  input,
  metadata: {
    summary: "Download a private local recovery file",
    hidden: true,
    userOnlyReason: STORAGE_RECOVERY_USER_ONLY_REASON
  }
})

const resetDeclaration = ({ capabilities: [], effects: undefined,
  name: STORAGE_RECOVERY_RESET,
  description: "Erase this browser's saved Smithers data and reload",
  input,
  output: Schema.Struct({}),
})

/**
 * The same erase from the startup panel, a slash line, or the agent's refusal.
 * The handler is the action's two-press `reset`, so the first invocation arms
 * the act and the second runs it; neither door reaches the browser directly.
 */
export const storageRecoveryResetFlow = (run: () => Promise<string | void>): FlowEntry => ({
  binding: FlowBinding.make({
    flow: resetDeclaration,
    modelInvocable: false,
    publicError: (message: string) => message,
    handler: () =>
      Effect.tryPromise({
        try: run,
        catch: () => recoveryFailure(new StorageRecoveryError("unreadable"))
      }).pipe(Effect.flatMap((refusal) => refusal === undefined ? Effect.succeed({}) : Effect.fail(refusal)))
  }),
  input,
  metadata: {
    summary: "Reset this browser's data",
    hidden: true,
    userOnlyReason: STORAGE_RESET_USER_ONLY_REASON
  }
})

/** The startup button has no app registry yet, but executes the same binding. */
export const invokeStartupRecovery = (entry: FlowEntry): Promise<Cell.CallResult> => {
  const descriptor = entry.binding.descriptor
  return Effect.runPromise(entry.binding.run(
    new Cell.Call({
      flowName: descriptor.name,
      input: {},
      capabilities: descriptor.capabilities,
      effects: descriptor.effects,
      placement: descriptor.placement,
      identity: new Cell.CallIdentity({
        session: "startup-recovery",
        frame: 0,
        cell: "startup-recovery",
        ordinal: 0,
        declaration: Cell.declarationDigest(descriptor),
        layers: []
      })
    })
  ))
}
