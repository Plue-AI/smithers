import type { CardCallbacks, CardCommandInput, CardProps, CatalogTag } from "@smthrs/rpc/CardAction"
import { describe, expect, test } from "bun:test"
import { cardActions, type CardCommandDispatch } from "./cardActions"
import { flowArgs } from "./FlowArgs"
import { flowAction } from "./FlowAction"
import { payloadFor } from "./SlashPayload"

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
    gestures: {},
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
  // Card-specific view state and named gestures (ui-components.md CardProps<M, V, G>).
  const file = cardActions(run, [
    { tag: "file", label: "Hover", gesture: "hover", command_input: { path: "a.ts" } },
    { tag: "todo.retry", label: "Retry", command_input: { n: 12 } }
  ])
  const fileProps: CardProps<{ path: string }, { line?: number }, "hover" | "definition"> = {
    model: { path: "a.ts" },
    actions: file.actions,
    gestures: file.gestures,
    view: { maximized: false, line: 3 },
    onAction: file.onAction,
    onView: () => {}
  }
  fileProps.onView({ line: 4 })
  // @ts-expect-error The card's own view fields keep their types.
  fileProps.onView({ line: "4" })
  void fileProps.gestures.hover?.tag
  // @ts-expect-error Gestures are only the card's named ones.
  void fileProps.gestures.restore
  // @ts-expect-error A Container's gestures carry only the names its definitions declare.
  void file.gestures.definition
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
    // todo.retry has no canonical line encoder yet (T-CAT-01), so it preloads by name only.
    expect(bindings.forScope("T12").actionProps("todo.retry")).toMatchObject({ "data-flow": "todo.retry" })
    expect(bindings.forScope("T12").actionProps("todo.retry")["data-flow-args"]).toBeUndefined()
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

  test("Container attributes preload the canonical flowArgs line that payloadFor decodes to the dispatched input", async () => {
    const { Window } = await import("happy-dom")
    const { bindFlowPreloading } = await import("./FlowAction")
    const window = new Window()
    const { calls, run } = recordingDispatch()
    const bindings = cardActions(run, [{
      scope: "checks",
      tag: "flow.run",
      label: "Run",
      command_input: { name: "checks" },
      resolve_input: (input) => ({ name: "checks", input: { retries: Number(input.retries), note: input.note } })
    }, { tag: "stack", label: "Stack", command_input: undefined }])
    const binding = bindings.forScope("checks").actionProps("flow.run", { retries: "2", note: "two words" })
    expect(calls).toEqual([])
    expect(bindings.actionProps("stack")["data-flow-args"]).toBeUndefined()
    expect(binding["data-flow-args"]).toBe(
      flowArgs("flow.run", { name: "checks", input: { retries: 2, note: "two words" } })
    )
    const button = window.document.createElement("button")
    button.setAttribute("data-flow", binding["data-flow"])
    button.setAttribute("data-flow-args", binding["data-flow-args"]!)
    button.onclick = binding.onClick
    window.document.body.append(button)
    const warmed: Array<{ tag: string; input: unknown }> = []
    const stop = bindFlowPreloading(window.document as unknown as Document, async (tag, args) => {
      // The real decoder the command registry's preload uses (Commands.ts), never JSON.parse.
      const parsed = payloadFor(tag, args)
      if ("error" in parsed) throw new Error(parsed.error)
      warmed.push({ tag, input: parsed.payload })
    })
    try {
      button.dispatchEvent(new window.Event("focusin", { bubbles: true }))
      await Promise.resolve()
      expect(warmed).toEqual([{ tag: "flow.run", input: { name: "checks", input: { retries: 2, note: "two words" } } }])
      expect(calls).toEqual([])
      button.click()
      expect(warmed).toEqual(calls)
    } finally {
      stop()
      await window.happyDOM.close()
    }
  })

  test("a View passing an action's args back dispatches it, and args tell one tag's row actions apart", () => {
    const { calls, run } = recordingDispatch()
    const bindings = cardActions(run, [
      { scope: "T12", tag: "todo", label: "Open", args: { n: "12" }, command_input: { n: 12 } },
      {
        scope: "T12",
        tag: "stack.move",
        label: "Move up",
        args: { n: "12", direction: "up" },
        command_input: { n: 12, direction: "up" }
      },
      {
        scope: "T12",
        tag: "stack.move",
        label: "Move down",
        args: { n: "12", direction: "down" },
        command_input: { n: 12, direction: "down" }
      },
      {
        scope: "T12",
        tag: "todo.steer",
        label: "Steer",
        args: { n: "12" },
        input: [{ name: "text", label: "Steer", kind: "text", required: true }],
        command_input: { n: 12, text: "" },
        resolve_input: (input) => ({ n: Number(input.n), text: input.text! })
      }
    ])
    const row = bindings.forScope("T12")
    expect(row.actions.map((action) => [action.tag, action.label])).toEqual([
      ["todo", "Open"],
      ["stack.move", "Move up"],
      ["stack.move", "Move down"],
      ["todo.steer", "Steer"]
    ])
    // ui-components.md Rules: onAction(action.tag, {...action.args, ...input}).
    for (const action of row.actions) {
      row.onAction(action.tag, { ...action.args, ...(action.tag === "todo.steer" ? { text: "Keep it small" } : {}) })
    }
    expect(calls).toEqual([
      { tag: "todo", input: { n: 12 } },
      { tag: "stack.move", input: { n: 12, direction: "up" } },
      { tag: "stack.move", input: { n: 12, direction: "down" } },
      { tag: "todo.steer", input: { n: 12, text: "Keep it small" } }
    ])
    expect(() => row.onAction("todo", { n: "12", text: "extra" })).toThrow("Card action todo needs an input resolver")
    expect(() =>
      cardActions(run, [
        { tag: "stack.move", label: "Move up", args: { direction: "up", n: "12" }, command_input: { n: 12, direction: "up" } },
        { tag: "stack.move", label: "Up again", args: { n: "12", direction: "up" }, command_input: { n: 12, direction: "up" } }
      ])
    ).toThrow("Duplicate card action in scope card: stack.move")
  })

  test("a secret never reaches a DOM attribute or the preload path, while click still dispatches it", async () => {
    const { Window } = await import("happy-dom")
    const { bindFlowPreloading } = await import("./FlowAction")
    const window = new Window()
    const secret = "sk-test-0123456789abcdef"
    const { calls, run } = recordingDispatch()
    const bindings = cardActions(run, [
      // secrets.set's encoder is JSON of the whole payload, value included.
      {
        tag: "secrets.set",
        label: "Add",
        input: [
          { name: "name", label: "Name", kind: "text", required: true },
          { name: "value", label: "Value", kind: "secret", required: true }
        ],
        command_input: { name: "OPENAI_API_KEY", value: "" },
        resolve_input: (input) => ({ name: input.name!, value: input.value!, scope: "all_branches" })
      },
      // A secret-bearing command with its value bound by the Container and no form field.
      { scope: "row", tag: "secrets.set", label: "Replace", command_input: { name: "GITHUB_TOKEN", value: secret } },
      // A command with a canonical line grammar whose form has a secret field.
      {
        tag: "flow.run",
        label: "Deploy",
        input: [{ name: "token", label: "Token", kind: "secret", required: true }],
        command_input: { name: "deploy" },
        resolve_input: (input) => ({ name: "deploy", input: { token: input.token! } })
      }
    ])
    const bound = [
      bindings.actionProps("secrets.set", { name: "OPENAI_API_KEY", value: secret }),
      bindings.forScope("row").actionProps("secrets.set"),
      bindings.actionProps("flow.run", { token: secret })
    ]
    for (const props of bound) expect(props["data-flow-args"]).toBeUndefined()
    const buttons = bound.map((props) => {
      const button = window.document.createElement("button")
      button.setAttribute("data-flow", props["data-flow"])
      if (props["data-flow-args"] !== undefined) button.setAttribute("data-flow-args", props["data-flow-args"])
      button.addEventListener("click", props.onClick)
      window.document.body.append(button)
      return button
    })
    const warmed: Array<{ tag: string; args: string | undefined }> = []
    const stop = bindFlowPreloading(window.document as unknown as Document, async (tag, args) => {
      warmed.push({ tag, args })
    })
    try {
      for (const button of buttons) button.dispatchEvent(new window.Event("focusin", { bubbles: true }))
      await Promise.resolve()
      const attributes = [...window.document.querySelectorAll("*")]
        .flatMap((element) => [...element.attributes].map((attribute) => attribute.value ?? ""))
      expect(attributes.length).toBeGreaterThan(0)
      expect(attributes.some((value) => value.includes(secret))).toBe(false)
      expect(warmed.map(({ tag }) => tag)).toEqual(["secrets.set", "secrets.set", "flow.run"])
      expect(JSON.stringify(warmed).includes(secret)).toBe(false)
      expect(calls).toEqual([])
      for (const button of buttons) button.click()
      expect(calls).toEqual([
        { tag: "secrets.set", input: { name: "OPENAI_API_KEY", value: secret, scope: "all_branches" } },
        { tag: "secrets.set", input: { name: "GITHUB_TOKEN", value: secret } },
        { tag: "flow.run", input: { name: "deploy", input: { token: secret } } }
      ])
    } finally {
      stop()
      await window.happyDOM.close()
    }
  })

  test("structured flow input preloads through the flow's own grammar, not as a JSON flow name", () => {
    const { run } = recordingDispatch()
    const input = { name: "checks", input: { retries: 2, paths: ["a.ts", "b c.ts"] } }
    const args = cardActions(run, [{ tag: "flow.run", label: "Run", command_input: input }]).actionProps("flow.run")[
      "data-flow-args"
    ]
    expect(payloadFor("flow.run", args)).toEqual({ payload: input })
  })

  test("named gestures bind through the same dispatch, stay out of actions and keep row scopes", () => {
    const { calls, run } = recordingDispatch()
    const failures: string[] = []
    const bindings = cardActions(run, [
      {
        tag: "file",
        label: "Hover",
        gesture: "hover",
        command_input: { path: "a.ts" },
        resolve_input: (input) => ({ path: input.path! })
      },
      { tag: "todo.retry", label: "Retry", command_input: { n: 12 } },
      { scope: "T13", tag: "todo", label: "Open", gesture: "open", command_input: { n: 13 } },
      { scope: "T13", tag: "todo.drop", label: "Drop", gesture: "drop", disabled: { reason: "Merging" }, command_input: { n: 13 } }
    ], (failure) => {
      failures.push(failure.reason)
    })
    expect(bindings.actions).toEqual([{ tag: "todo.retry", label: "Retry" }])
    expect(bindings.gestures).toEqual({ hover: { tag: "file", label: "Hover" } })
    expect(bindings.forScope("T13").actions).toEqual([])
    expect(bindings.forScope("T13").gestures).toEqual({
      open: { tag: "todo", label: "Open" },
      drop: { tag: "todo.drop", label: "Drop", disabled: { reason: "Merging" } }
    })
    expect(bindings.forScope("missing").gestures).toEqual({})
    bindings.onAction(bindings.gestures.hover!.tag, { path: "b.ts" })
    bindings.forScope("T13").onAction("todo")
    bindings.forScope("T13").onAction("todo.drop")
    expect(calls).toEqual([{ tag: "file", input: { path: "b.ts" } }, { tag: "todo", input: { n: 13 } }])
    expect(failures).toEqual(["Merging"])
    expect(() =>
      cardActions(run, [
        { tag: "file", label: "Hover", gesture: "hover", command_input: { path: "a.ts" } },
        { tag: "todo", label: "Also hover", gesture: "hover", command_input: { n: 1 } }
      ])
    ).toThrow("Duplicate card gesture in scope card: hover")
    expect(() =>
      cardActions(run, [
        { tag: "file", label: "Hover", gesture: "hover", command_input: { path: "a.ts" } },
        { tag: "file", label: "Open", command_input: { path: "a.ts" } }
      ])
    ).toThrow("Duplicate card action in scope card: file")
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
    expect(calls).toEqual([])
    // An empty input carries no form value: the View's `{...action.args, ...input}` for an action with neither.
    bindings.onAction("todo.retry", {})
    expect(calls).toEqual([{ tag: "todo.retry", input: { n: 12 } }])
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


test("GitHub manifest handoff submits a native top-level form with one manifest field", async () => {
  const { Window } = await import("happy-dom")
  const { submitGitHubAppManifest } = await import("./cardActions")
  const page = new Window({ url: "http://localhost:4000" })
  const submissions: unknown[] = []
  page.HTMLFormElement.prototype.submit = function () {
    submissions.push({ action: this.action, method: this.method.toLowerCase(), target: this.target,
      fields: [...this.querySelectorAll("input")].map(input => ({ name: input.name, value: input.value })) })
  }
  const manifest = { name: "Smithers", redirect_url: "http://localhost:4000/setup/github/callback" }
  for (const action_url of ["https://github.com/settings/apps/new?state=one", "https://github.com/organizations/smithersai/settings/apps/new?state=two"])
    submitGitHubAppManifest({ action_url, manifest }, page.document as unknown as Document)
  expect(submissions).toEqual(["https://github.com/settings/apps/new?state=one", "https://github.com/organizations/smithersai/settings/apps/new?state=two"].map(action => ({ action, method: "post", target: "_self", fields: [{ name: "manifest", value: JSON.stringify(manifest) }] })))
  expect(page.document.querySelector("form")).toBeNull()
  for (const action_url of ["http://github.com/settings/apps/new", "https://github.com.evil.test/settings/apps/new", "https://github.com/login", "https://user:password@github.com/settings/apps/new"])
    expect(() => submitGitHubAppManifest({ action_url, manifest }, page.document as unknown as Document)).toThrow("refused")
  await page.happyDOM.close()
})
