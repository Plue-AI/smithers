import type { CardCallbacks, CardCommandInput, CardProps, CatalogTag } from "@smthrs/rpc/CardAction"
import { describe, expect, test } from "bun:test"
import { cardActions, type CardCommandDispatch } from "./cardActions"
import { flowAction } from "./FlowAction"

// These compile-only assertions keep catalog inputs correlated with their tags.
// The function is never called: invalid definitions must not reach dispatch.
const assertCommandTypes = (run: CardCommandDispatch): void => {
  cardActions(run, [{ tag: "file", label: "File", command_input: { path: "a.ts" } }])
  // @ts-expect-error TODO commands do not accept a file payload.
  cardActions(run, [{ tag: "todo.retry", label: "Retry", command_input: { path: "a.ts" } }])
  // @ts-expect-error Required TODO input is not optional.
  cardActions(run, [{ tag: "todo.retry", label: "Retry", command_input: undefined }])
  // @ts-expect-error Catalog flowAction remains closed to arbitrary names.
  flowAction(() => {}, "invented.command")
  const callbacks: CardCallbacks<"file" | "todo.retry"> = {
    file: (input) => {
      void input.path
    },
    "todo.retry": (input) => {
      void input.n
    }
  }
  callbacks.file({ path: "a.ts" })
  // @ts-expect-error Per-command callbacks keep required input fields.
  callbacks["todo.retry"]({ path: "a.ts" })
  const props: CardProps<{ title: string }> = {
    model: { title: "T12" },
    actions: [],
    view: { maximized: false },
    onAction: () => {},
    onView: () => {}
  }
  props.onAction("todo.retry")
  // @ts-expect-error View callbacks accept only catalog tags.
  props.onAction("invented.command")
  props.onView({ maximized: true })
  props.onView({ tab: "files", filter: "failed" })
  // @ts-expect-error Presentation patches do not accept model fields.
  props.onView({ title: "T13" })
  // @ts-expect-error Presentation state preserves field types.
  props.onView({ maximized: "true" })
}
void assertCommandTypes

const recordingDispatch = () => {
  const calls: Array<{ tag: CatalogTag; input: CardCommandInput[CatalogTag] }> = []
  const run: CardCommandDispatch = (tag, input) => {
    calls.push({ tag, input })
  }
  return { calls, run }
}

describe("catalog card action bindings", () => {
  test("ordered View props omit command payloads and launch nothing during construction", () => {
    const { calls, run } = recordingDispatch()
    const definitions = [
      { tag: "todo.retry", label: "Retry", primary: true, command_input: { n: 12 } },
      { tag: "todo.stop", label: "Stop", disabled: { reason: "Paused" }, command_input: { n: 12 } }
    ] satisfies Parameters<typeof cardActions>[1]
    const bindings = cardActions(run, definitions)
    expect(bindings.actions).toEqual([
      { tag: "todo.retry", label: "Retry", primary: true },
      { tag: "todo.stop", label: "Stop", disabled: { reason: "Paused" } }
    ])
    expect(calls).toEqual([])
    expect(definitions[0].command_input).toEqual({ n: 12 })
    bindings.onAction("todo.retry")
    expect(calls).toEqual([{ tag: "todo.retry", input: { n: 12 } }])
  })

  test("empty action lists and unavailable or disabled actions fail before dispatch", () => {
    const { calls, run } = recordingDispatch()
    const empty = cardActions(run, [])
    expect(empty.actions).toEqual([])
    expect(() => empty.onAction("todo.retry")).not.toThrow()
    const disabled = cardActions(run, [
      { tag: "todo.retry", label: "Retry", command_input: { n: 12 }, disabled: { reason: "Waiting for T11" } }
    ])
    expect(() => disabled.onAction("todo.retry")).not.toThrow()
    expect(() => disabled.onAction("todo.drop")).not.toThrow()
    expect(calls).toEqual([])
  })

  test("same command binds independently to multiple row scopes", () => {
    const { calls, run } = recordingDispatch()
    const bindings = cardActions(run, [
      { scope: "T12", tag: "todo.retry", label: "Retry", command_input: { n: 12 } },
      { scope: "T13", tag: "todo.retry", label: "Retry", command_input: { n: 13 } }
    ])
    expect(bindings.actions).toEqual([])
    bindings.forScope("T13").onAction("todo.retry")
    bindings.forScope("T12").onAction("todo.retry")
    expect(calls).toEqual([{ tag: "todo.retry", input: { n: 13 } }, { tag: "todo.retry", input: { n: 12 } }])
    expect(bindings.forScope("T12").actionProps("todo.retry")).toMatchObject({
      "data-flow": "todo.retry",
      "data-flow-args": "{\"n\":12}"
    })
  })

  test("card and row scopes do not leak actions or command inputs", () => {
    const { calls, run } = recordingDispatch()
    const failures: string[] = []
    const bindings = cardActions(run, [
      { tag: "todo.retry", label: "Retry card", command_input: { n: 1 } },
      { scope: "T12", tag: "todo.retry", label: "Retry row", command_input: { n: 12 } },
      { scope: "T12", tag: "todo.drop", label: "Drop row", command_input: { n: 12 } }
    ], (failure) => {
      failures.push(failure.reason)
    })
    expect(bindings.actions).toEqual([{ tag: "todo.retry", label: "Retry card" }])
    expect(bindings.forScope("T12").actions).toEqual([{ tag: "todo.retry", label: "Retry row" }, {
      tag: "todo.drop",
      label: "Drop row"
    }])
    expect(bindings.forScope("missing").actions).toEqual([])
    bindings.onAction("todo.retry")
    bindings.forScope("T12").onAction("todo.retry")
    bindings.forScope("missing").onAction("todo.retry")
    expect(calls).toEqual([{ tag: "todo.retry", input: { n: 1 } }, { tag: "todo.retry", input: { n: 12 } }])
    expect(failures).toEqual(["Card action is unavailable: todo.retry"])
    expect(() =>
      cardActions(run, [
        { scope: "T12", tag: "todo.retry", label: "First", command_input: { n: 12 } },
        { scope: "T12", tag: "todo.retry", label: "Second", command_input: { n: 13 } }
      ])
    ).toThrow("Duplicate card action in scope T12")
    expect(() =>
      cardActions(run, [
        { tag: "stack", label: "First", command_input: undefined },
        { tag: "stack", label: "Second", command_input: undefined }
      ])
    ).toThrow("Duplicate card action in scope card")
  })

  test("Container attributes preload the same scoped and resolved arguments that click dispatches", async () => {
    const { Window } = await import("happy-dom")
    const { bindFlowPreloading } = await import("./FlowAction")
    const window = new Window()
    const { calls, run } = recordingDispatch()
    const bindings = cardActions(run, [{
      scope: "T12",
      tag: "todo.steer",
      label: "Steer",
      command_input: { n: 12, text: "Original" },
      resolve_input: (input) => ({ n: 12, text: input.text! })
    }, { tag: "stack", label: "Stack", command_input: undefined }])
    const binding = bindings.forScope("T12").actionProps("todo.steer", { text: "Changed" })
    expect(calls).toEqual([])
    expect(bindings.actionProps("stack")["data-flow-args"]).toBeUndefined()
    const button = window.document.createElement("button")
    button.setAttribute("data-flow", binding["data-flow"])
    button.setAttribute("data-flow-args", binding["data-flow-args"]!)
    button.onclick = binding.onClick
    window.document.body.append(button)
    const warmed: Array<{ tag: string; input: unknown }> = []
    const stop = bindFlowPreloading(window.document as unknown as Document, async (tag, args) => {
      warmed.push({ tag, input: JSON.parse(args!) })
    })
    try {
      button.dispatchEvent(new window.Event("focusin", { bubbles: true }))
      expect(warmed).toEqual([{ tag: "todo.steer", input: { n: 12, text: "Changed" } }])
      expect(calls).toEqual([])
      button.click()
      expect(warmed).toEqual(calls)
    } finally {
      stop()
      await window.happyDOM.close()
    }
  })

  test("unavailable and disabled gestures report failures without throwing", () => {
    const failures: string[] = []
    const { calls, run } = recordingDispatch()
    const bindings = cardActions(run, [{
      tag: "todo.retry",
      label: "Retry",
      command_input: { n: 12 },
      disabled: { reason: "Waiting" }
    }], (failure) => {
      failures.push(failure.reason)
    })
    expect(() => bindings.onAction("todo.retry")).not.toThrow()
    expect(() => bindings.onAction("todo.drop")).not.toThrow()
    expect(failures).toEqual(["Waiting", "Card action is unavailable: todo.drop"])
    expect(calls).toEqual([])
  })

  test("commands without arguments and structured flow inputs retain their value shape", () => {
    const { calls, run } = recordingDispatch()
    const input = { name: "checks", input: { retries: 2, paths: ["a.ts", "b.ts"] } }
    const bindings = cardActions(run, [
      { tag: "stack", label: "Stack", command_input: undefined },
      { tag: "flow.run", label: "Run", command_input: input }
    ])
    bindings.onAction("stack")
    bindings.onAction("flow.run")
    expect(calls).toEqual([{ tag: "stack", input: undefined }, { tag: "flow.run", input }])
    expect(calls[1]!.input).toBe(input)
  })

  test("form values resolve to typed command input; defaults remain intact", () => {
    const { calls, run } = recordingDispatch()
    const received: Record<string, string>[] = []
    const bindings = cardActions(run, [{
      tag: "todo.steer",
      label: "Steer",
      command_input: { n: 12, text: "Original" },
      input: [{ name: "text", label: "Text", kind: "text", required: true }],
      resolve_input: (input) => {
        received.push(input)
        return { n: 12, text: input.text! }
      }
    }])
    bindings.onAction("todo.steer")
    bindings.onAction("todo.steer", { text: "Use the shared helper" })
    expect(received).toEqual([{ text: "Use the shared helper" }])
    expect(calls).toEqual([
      { tag: "todo.steer", input: { n: 12, text: "Original" } },
      { tag: "todo.steer", input: { n: 12, text: "Use the shared helper" } }
    ])
    expect(bindings.actions[0]).toEqual({
      tag: "todo.steer",
      label: "Steer",
      input: [{ name: "text", label: "Text", kind: "text", required: true }]
    })
  })

  test("supplied form values require a resolver and are never silently discarded", () => {
    const { calls, run } = recordingDispatch()
    const bindings = cardActions(run, [{ tag: "todo.retry", label: "Retry", command_input: { n: 12 } }])
    expect(() => bindings.onAction("todo.retry", { n: "13" })).toThrow("resolver")
    expect(() => bindings.onAction("todo.retry", {})).toThrow("resolver")
    expect(calls).toEqual([])
  })

  test("disabled actions never resolve form values and launch acknowledgments return immediately", () => {
    let resolved = false
    let launched = false
    let complete!: () => void
    const pending = new Promise<void>((resolve) => {
      complete = resolve
    })
    const disabled = cardActions(() => {
      launched = true
    }, [{
      tag: "todo.retry",
      label: "Retry",
      command_input: { n: 12 },
      disabled: { reason: "Waiting" },
      resolve_input: () => {
        resolved = true
        return { n: 13 }
      }
    }])
    expect(() => disabled.onAction("todo.retry", { n: "13" })).not.toThrow()
    expect(resolved).toBe(false)
    expect(launched).toBe(false)
    const running = cardActions(() => {
      launched = true
      return pending
    }, [
      { tag: "todo.retry", label: "Retry", command_input: { n: 12 } }
    ])
    expect(running.onAction("todo.retry")).toBeUndefined()
    expect(launched).toBe(true)
    complete()
  })

  test("input validation and dispatch failures propagate without a second launch", () => {
    const { calls, run } = recordingDispatch()
    const invalid = cardActions(run, [{
      tag: "todo.retry",
      label: "Retry",
      command_input: { n: 12 },
      resolve_input: () => {
        throw new Error("Invalid TODO")
      }
    }])
    expect(() => invalid.onAction("todo.retry", { n: "bad" })).toThrow("Invalid TODO")
    expect(calls).toEqual([])
    let attempts = 0
    const failed = cardActions(() => {
      attempts++
      throw new Error("Dispatch failed")
    }, [
      { tag: "todo.retry", label: "Retry", command_input: { n: 12 } }
    ])
    expect(() => failed.onAction("todo.retry")).toThrow("Dispatch failed")
    expect(attempts).toBe(1)
  })
})
