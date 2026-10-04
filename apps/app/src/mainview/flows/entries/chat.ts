import type { CommandGesture } from "../CommandGesture"
/*
 * The `chat` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace, Recommendation } from "../registry"
import type { CommandActions } from "./Declare"

/** The `chat` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "chat", label: "Chat", summary: "The conversation: send, retry, queue" }

/** While the model types, stopping is the only next step; away from the chat, returning to it leads. */
export const recommendations: ReadonlyArray<Recommendation> = [
  { name: "stop", when: (state) => state.typing, exclusive: true, rank: () => 0 },
  { name: "chat", when: (state) => state.surface !== "chat", rank: () => 0 }
]

/** The bare `chat` switch and the conversation's own controls. */
export const chatFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  const RETRY = {
    name: "chat.retry",
    summary: "Retry the last turn",
    input: NoPayload,
    handler: () => actions.retryLastTurn()
  }
  const SEND = {
    name: "chat.send",
    summary: "Submit the composer",
    userOnly: true,
    userOnlyReason: "the composer is the human's; the model is already the turn, and sending would nest one",
    args: "<text>",
    input: Schema.Struct({ text: Schema.String }),
    handler: ({ text }: { readonly text: string }, _signal: AbortSignal, _call: unknown, gesture?: CommandGesture) => {
      actions.send(text, undefined, gesture?.composerDraftCurrent)
    }
  }
  return [
  flow({
    /*
     * The three surface switches (chat, world, connect) are the app's own top
     * level, so they alone stay bare: `/chat` under any prefix reads wrong.
     */
    name: "chat",
    summary: "Back to the conversation",
    input: NoPayload,
    handler: () => actions.showChat()
  }),
  flow({ name: "chat.open", summary: "Open Chat using the selected input mode (C)", input: NoPayload,
    userOnly: true, userOnlyReason: "opening Chat and starting the selected microphone mode is the human's gesture",
    handler: (_payload, _signal, _call, gesture) => gesture?.chatInputCurrent?.() === false ? undefined : actions.openChat() }),
  flow({
    name: "chat.dictate",
    summary: "Start or stop dictation into the chat draft (⌘D)",
    userOnly: true,
    userOnlyReason: "microphone capture is the human's explicit gesture",
    input: NoPayload,
    handler: () => actions.toggleDictation()
  }),
  flow(RETRY),
  flow({
    name: "stop",
    summary: "Stop the current response",
    userOnly: true,
    userOnlyReason: "stopping the model's own turn is the human's Escape key",
    input: NoPayload,
    handler: () => actions.stop()
  }),
  flow(SEND),
  flow({ name: "chat.queue", summary: "Queue a follow-up", args: "<text>",
    userOnly: true, userOnlyReason: "the prompt queue is the human's composer",
    input: Schema.Struct({ text: Schema.String }), handler: ({ text }, _signal, _call, gesture) => actions.enqueuePrompt(text, gesture?.composerDraftCurrent) }),
  flow({ name: "chat.queue.edit", summary: "Edit a queued prompt", args: "<id>", hidden: true,
    userOnly: true, userOnlyReason: "the prompt queue is the human's composer",
    input: Schema.Struct({ id: Schema.String }), handler: ({ id }) => actions.removeQueuedPrompt(id, true) }),
  flow({ name: "chat.queue.remove", summary: "Remove a queued prompt", args: "<id>", hidden: true,
    userOnly: true, userOnlyReason: "the prompt queue is the human's composer",
    input: Schema.Struct({ id: Schema.String }), handler: ({ id }) => actions.removeQueuedPrompt(id) }),
  flow({ name: "chat.queue.restore", summary: "Restore queued prompts to Chat", hidden: true,
    userOnly: true, userOnlyReason: "the prompt queue is the human's composer",
    input: NoPayload, handler: () => actions.restoreQueuedPrompts() }),
  flow({ name: "chat.queue.resume", summary: "Resume queued prompts", hidden: true,
    userOnly: true, userOnlyReason: "the prompt queue is the human's composer",
    input: NoPayload, handler: () => actions.resumePromptQueue() })
  ]
}

/** The clipboard copy: a browser gesture that needs no controller call, so the block keeps the uniform signature. Registered after the frame flows. */
export const chatCopyFlows = (_actions: CommandActions): ReadonlyArray<FlowEntry> => {
  const COPY_MESSAGE = {
    name: "chat.copy-message",
    summary: "Copy a message to the clipboard",
    hidden: true,
    userOnly: true,
    userOnlyReason: "the clipboard write is the human's browser gesture",
    args: "<text>",
    input: Schema.Struct({ text: Schema.String }),
    /*
     * A.26: `void navigator.clipboard.writeText(...)` let the browser's
     * NotAllowedError escape as an unhandled rejection — the only trace was
     * a POST to /api/telemetry/errors, and the human who pressed Copy was told
     * nothing at all. The refusal is awaited and answered.
     */
    handler: async ({ text }: { readonly text: string }, _signal: AbortSignal, _call: unknown, gesture?: CommandGesture) => {
      const clipboard = navigator.clipboard
      if (clipboard === undefined) {
        return "This browser won't give Smithers the clipboard — select the text and copy it yourself."
      }
      try {
        await (gesture?.copyText ? gesture.copyText(text) : clipboard.writeText(text))
        return { value: "Copied to clipboard." }
      } catch (cause) {
        return cause instanceof Error && cause.name === "NotAllowedError"
          ? "The browser refused the clipboard — it only allows a copy while the page has focus."
          : "The copy didn't go through — select the text and copy it yourself."
      }
    }
  }
  return [
  flow(COPY_MESSAGE)
  ]
}

/** `chat.reload`, registered after the review and findings flows. `/help` (entries/help.ts) lists the commands. */
export const chatReloadFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  /* The one-keystroke recovery: reload the window (dev loop, stuck states). */
  const RELOAD = {
    name: "chat.reload",
    summary: "Reload the app",
    input: NoPayload,
    handler: () => actions.reloadApp()
  }
  return [
  flow(RELOAD)
  ]
}
