import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { FlowFormCardBody } from "./FlowFormCards"
import { payloadFor } from "../flows/SlashPayload"
import { ControllerContext } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import type { FlowSubmission } from "../flows/Commands"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, loadBox } from "../state/TestFixtures"

test("a write-only input stays outside form.set, clears before submit, and travels only through the gesture", () => {
  const requests: FlowSubmission[] = []
  const calls: string[] = []
  const controller = { submitCommand: async (request: FlowSubmission) => {
    expect(document.querySelector<HTMLInputElement>("input[type=password]")?.value).toBe("")
    requests.push(request)
    return { status: "executed" }
  } } as unknown as AppController
  const host = mount(<ControllerContext value={controller}><FlowFormCardBody card={formCard({
    flow: "secrets.connect", via: "user", fields: [{ name: "value", label: "Anthropic API key", kind: "write-only", required: true }], draft: {}, given: {}
  })} onRunCommand={name => calls.push(name)} /></ControllerContext>)
  input(host, "flow-form-value", "dom-private-fixture")
  expect(calls).toEqual([])
  expect(host.innerHTML).not.toContain("dom-private-fixture")
  flushSync(() => host.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")!.click())
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests)).not.toContain("dom-private-fixture")
  expect(requests[0]?.name).toBe("form.submit")
  expect(requests[0]?.gesture?.takeWriteOnly?.("value")).toBe("dom-private-fixture")
  expect(requests[0]?.gesture?.takeWriteOnly?.("value")).toBeUndefined()
})

test("a disabled write-only field keeps Submit disabled and shows its reason", () => {
  const card = formCard({ flow: "secrets.connect", via: "user", fields: [
    { name: "value", label: "Anthropic API key", kind: "write-only", required: true, disabledReason: "Sign in required" }
  ], draft: {}, given: {} })
  const host = mount(<FlowFormCardBody card={card} onRunCommand={() => {}} />)
  expect(host.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")!.disabled).toBe(true)
  expect(host.textContent).toContain("Sign in required")
})

/*
 * THE FORM LAW (flow-forms.md): the generic form card. One control per
 * field kind, an unpickable option disabled with its reason, every field
 * commit through form.set with the card id, Submit as form.submit (disabled
 * until the required fields are filled), Cancel as card.dismiss, and a
 * submitted card that keeps its record and offers nothing further.
 */

GlobalRegistrator.register()
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type FlowFormCard = Extract<Card, { kind: "flow-form" }>

const base = { title: "/tab.harness", status: "active" as const, createdAt: 0, ordinal: 0 }

const formCard = (payload: Partial<FlowFormCard["payload"]> = {}, status: Card["status"] = "active"): FlowFormCard => ({
  ...base,
  id: "form-tab.harness",
  kind: "flow-form",
  status,
  payload: {
    flow: "tab.harness",
    via: "agent",
    fields: [
      { name: "id", label: "Id", kind: "text", required: true },
      {
        name: "harness",
        label: "Harness",
        kind: "select",
        required: true,
        optionsFrom: "cloud-repos",
        options: [
          { value: "claude", label: "Claude Code · will@example.com" },
          { value: "codex", label: "Codex · OPENAI_API_KEY" },
          { value: "opencode", label: "OpenCode", disabled: true, reason: "no credential" },
          { value: "pi", label: "Pi", disabled: true, reason: "not installed" }
        ]
      },
      {
        name: "bookmark",
        label: "Bookmark",
        kind: "text",
        required: true,
        optionsFrom: "bookmarks",
        options: [{ value: "main", label: "main" }, { value: "work", label: "work" }]
      },
      { name: "seq", label: "Seq", kind: "number", required: false },
      { name: "follow", label: "Follow", kind: "boolean", required: false },
      { name: "purpose", label: "Purpose", kind: "text", required: false, placeholder: "Reviews diffs" }
    ],
    draft: {},
    given: {},
    ...payload
  }
})

const mount = (node: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  flushSync(() => {
    root.render(node)
  })
  return host
}

test("a completed PR box form offers its retained Review action only on its ready selected box", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "will/flows" }).isPersisted.promise
  const boxId = "0b0c0d0e-0000-4000-8000-00000000000a"
  const calls: Array<[string, string | undefined]> = []
  const controller = { store } as unknown as AppController
  const card = formCard({ flow: "box.open", via: "user", fields: [], draft: { repo: "will/flows" }, given: { repo: "will/flows" },
    afterBox: { kind: "prs.triage", repo: "will/flows", number: 17, owner: "will", workspaceId: boxId } }, "acted")
  const host = mount(<ControllerContext value={controller}><FlowFormCardBody card={card} onRunCommand={(name, args) => { calls.push([name, args]) }} /></ControllerContext>)
  const button = () => host.querySelector<HTMLButtonElement>("[data-testid=flow-form-after-box]")
  expect(button()?.textContent).toBe("Review PR #17")
  expect(button()?.disabled).toBe(true)
  await loadBox(store, "will/flows", boxId, "running")
  await store.dispatch({ type: "repo.selected", actor: "user", id: `will/flows#workspace:${boxId}` }).isPersisted.promise
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(button()?.disabled).toBe(false)
  flushSync(() => button()!.click())
  expect(calls).toEqual([["form.submit", card.id]])
  await store.dispatch({ type: "repo.selected", actor: "user", id: "will/flows" }).isPersisted.promise
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(button()?.disabled).toBe(true)
  const consumed = mount(<ControllerContext value={controller}><FlowFormCardBody card={formCard({ ...card.payload,
    afterBox: { ...card.payload.afterBox!, consumed: true } }, "acted")} onRunCommand={(name, args) => { calls.push([name, args]) }} /></ControllerContext>)
  const claimed = consumed.querySelector<HTMLButtonElement>("[data-testid=flow-form-after-box]")!
  expect(claimed.textContent).toBe("Review requested")
  expect(claimed.getAttribute("aria-disabled")).toBe("true")
  flushSync(() => claimed.click())
  expect(calls).toHaveLength(1)
  await store.dispose?.()
})

const recorder = () => {
  const calls: Array<[string, string | undefined]> = []
  return { calls, onRunCommand: (name: string, args?: string) => void calls.push([name, args]) }
}

const input = (host: HTMLElement, testId: string, value: string): void => {
  const input = host.querySelector<HTMLInputElement>(`[data-testid=${testId}]`)
  if (input === null) throw new Error(`no field ${testId}`)
  input.value = value
  flushSync(() => input.dispatchEvent(new InputEvent("input", { bubbles: true })))
}

describe("the flow form card", () => {
  test("a multiline handoff is editable through form.set and uses the clipboard submit label", () => {
    const recorder = { calls: [] as Array<[string, string | undefined]> }
    const host = mount(<FlowFormCardBody card={formCard({
      fields: [{ name: "text", label: "Handoff brief", kind: "textarea", required: true }],
      draft: { text: "Goal\nEvidence" }, submitLabel: "Copy brief"
    })} onRunCommand={(name, args) => recorder.calls.push([name, args])} />)
    expect(host.querySelector("textarea")?.value).toBe("Goal\nEvidence")
    input(host, "flow-form-text", "Goal\nEvidence\nNext step")
    expect(recorder.calls[0]).toEqual(["form.set", "form-tab.harness text Goal\nEvidence\nNext step"])
    const copy = [...host.querySelectorAll("button")].find(button => button.textContent === "Copy brief")
    copy?.click()
    expect(recorder.calls[1]).toEqual(["form.submit", "form-tab.harness"])
  })
  test("renders one control per field kind: text, select, text with a datalist, number, checkbox", () => {
    const host = mount(<FlowFormCardBody card={formCard()} onRunCommand={() => {}} />)
    expect(host.querySelector("[data-testid=flow-form-id]")?.getAttribute("type")).toBe("text")
    expect(host.querySelector("[data-testid=flow-form-harness]")?.tagName).toBe("SELECT")
    const bookmark = host.querySelector<HTMLInputElement>("[data-testid=flow-form-bookmark]")
    expect(bookmark?.getAttribute("type")).toBe("text")
    expect(bookmark?.getAttribute("list")).toBe("flow-form-options-form-tab.harness-bookmark")
    expect([...host.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"))).toEqual(["main", "work"])
    expect(host.querySelector("[data-testid=flow-form-seq]")?.getAttribute("type")).toBe("number")
    expect(host.querySelector("[data-testid=flow-form-follow]")?.getAttribute("type")).toBe("checkbox")
    expect(host.querySelector<HTMLInputElement>("[data-testid=flow-form-purpose]")?.placeholder).toBe("Reviews diffs")
    // The rows say which fields are required; nothing else is added.
    expect([...host.querySelectorAll("[data-field]")].map((row) => [row.getAttribute("data-field"), row.getAttribute("data-required")])).toEqual([
      ["id", "true"],
      ["harness", "true"],
      ["bookmark", "true"],
      ["seq", "false"],
      ["follow", "false"],
      ["purpose", "false"]
    ])
  })

  test("an option the human cannot pick is disabled and carries its reason; an unpicked select offers the empty choice", () => {
    const host = mount(<FlowFormCardBody card={formCard()} onRunCommand={() => {}} />)
    const options = [...host.querySelectorAll<HTMLOptionElement>("[data-testid=flow-form-harness] option")]
    expect(options.map((option) => [option.value, option.disabled, option.textContent])).toEqual([
      ["", false, ""],
      ["claude", false, "Claude Code · will@example.com"],
      ["codex", false, "Codex · OPENAI_API_KEY"],
      ["opencode", true, "OpenCode · no credential"],
      ["pi", true, "Pi · not installed"]
    ])
    expect(options[3]?.getAttribute("title")).toBe("no credential")
    // Once picked, the empty choice is gone.
    const picked = mount(<FlowFormCardBody card={formCard({ draft: { harness: "codex" } })} onRunCommand={() => {}} />)
    expect([...picked.querySelectorAll<HTMLOptionElement>("[data-testid=flow-form-harness] option")].map((option) => option.value)).toEqual(["claude", "codex", "opencode", "pi"])
    expect(picked.querySelector<HTMLSelectElement>("[data-testid=flow-form-harness]")?.value).toBe("codex")
  })

  test("every field commits through form.set with the card id; a blank commit clears; Cancel is card.dismiss", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<FlowFormCardBody card={formCard({ draft: { purpose: "old" } })} onRunCommand={onRunCommand} />)
    input(host, "flow-form-id", "reviewer")
    const harness = host.querySelector<HTMLSelectElement>("[data-testid=flow-form-harness]")
    if (harness === null) throw new Error("no harness select")
    harness.value = "codex"
    harness.dispatchEvent(new Event("change", { bubbles: true }))
    input(host, "flow-form-bookmark", "work")
    input(host, "flow-form-seq", "3")
    const follow = host.querySelector<HTMLInputElement>("[data-testid=flow-form-follow]")
    if (follow === null) throw new Error("no checkbox")
    follow.click()
    input(host, "flow-form-purpose", "")
    // Returning to the rendered value still commits, even before the previous edit re-renders.
    input(host, "flow-form-purpose", "old")
    host.querySelector<HTMLButtonElement>("[data-testid=flow-form-cancel]")?.click()
    expect(calls).toEqual([
      ["form.set", "form-tab.harness id reviewer"],
      ["form.set", "form-tab.harness harness codex"],
      ["form.set", "form-tab.harness bookmark work"],
      ["form.set", "form-tab.harness seq 3"],
      ["form.set", "form-tab.harness follow true"],
      ["form.set", "form-tab.harness purpose"],
      ["form.set", "form-tab.harness purpose old"],
      ["card.dismiss", "form-tab.harness"]
    ])
    expect(host.querySelector("[data-testid=flow-form-cancel]")?.getAttribute("data-flow")).toBe("card.dismiss")
  })

  test("input commits the live draft, enables Submit without blur, and preserves focus and spaces across updates", () => {
    let card = formCard({ fields: [{ name: "description", label: "What should this issue flow do?", kind: "text", required: true }] })
    const calls: Array<[string, string | undefined]> = []
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
    const render = () => root.render(<FlowFormCardBody card={card} onRunCommand={(name, args) => {
      calls.push([name, args])
      if (name !== "form.set") return
      const parsed = payloadFor(name, args)
      if (!("payload" in parsed)) throw new Error("field commit did not parse")
      card = { ...card, payload: { ...card.payload, draft: { description: String(parsed.payload.value) } } }
      render()
    }} />)
    flushSync(render)
    const field = host.querySelector<HTMLInputElement>("input")!
    const submit = host.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")!
    expect(submit.disabled).toBe(true)
    field.focus()
    for (const value of ["Research", "Research ", "Research errors"]) {
      input(host, "flow-form-description", value)
      expect(host.querySelector("input")).toBe(field)
      expect(document.activeElement).toBe(field)
      expect(field.value).toBe(value)
      expect(submit.disabled).toBe(false)
    }
    submit.click()
    expect(calls.at(-1)).toEqual(["form.submit", card.id])
    input(host, "flow-form-description", "")
    expect(submit.disabled).toBe(true)
  })

  test("Enter submits a complete single-line field once and holds focus in the form; composition and incomplete or busy forms do not submit", () => {
    for (const state of ["ready", "composing", "empty", "busy", "acted"] as const) {
      const { calls, onRunCommand } = recorder()
      const host = mount(<FlowFormCardBody card={formCard({
        fields: [{ name: "id", label: "Id", kind: "text", required: true }],
        draft: state === "empty" ? {} : { id: "reviewer" }, submitting: state === "busy"
      }, state === "acted" ? "acted" : "active")} onRunCommand={onRunCommand} />)
      const field = host.querySelector<HTMLInputElement>("input")!
      field.focus()
      flushSync(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: state === "composing" })))
      expect(calls).toEqual(state === "ready" ? [["form.submit", "form-tab.harness"]] : [])
      if (state === "ready") expect(document.activeElement).toBe(host.querySelector("form"))
    }
  })

  test("Enter in a multiline field leaves newline editing to the control", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<FlowFormCardBody card={formCard({ fields: [{ name: "text", label: "Brief", kind: "textarea", required: true }], draft: { text: "Goal" } })} onRunCommand={onRunCommand} />)
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    host.querySelector("textarea")!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(calls).toEqual([])
  })

  test("a number field accepts fractional values on the form submission path", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<FlowFormCardBody card={formCard({ fields: [{ name: "amount", label: "Amount", kind: "number", required: true }], draft: { amount: 0.5 } })} onRunCommand={onRunCommand} />)
    expect(host.querySelector<HTMLInputElement>("input")!.checkValidity()).toBe(true)
    host.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")!.click()
    expect(calls).toEqual([["form.submit", "form-tab.harness"]])
  })

  test("Submit is form.submit, disabled until every required field is filled; a boolean never blocks it", () => {
    const { calls, onRunCommand } = recorder()
    const empty = mount(<FlowFormCardBody card={formCard()} onRunCommand={onRunCommand} />)
    const disabled = empty.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")
    expect(disabled?.disabled).toBe(true)
    expect(disabled?.getAttribute("data-flow")).toBe("form.submit")
    const filled = mount(
      <FlowFormCardBody card={formCard({ draft: { id: "reviewer", harness: "codex", bookmark: "work" } })} onRunCommand={onRunCommand} />
    )
    const submit = filled.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")
    expect(submit?.disabled).toBe(false)
    expect(submit?.textContent).toBe("Submit")
    submit?.click()
    expect(calls).toEqual([["form.submit", "form-tab.harness"]])
  })

  test("a submitted card keeps its record with the controls disabled and no acts; a refused submit shows the reason and stays editable", () => {
    const acted = mount(
      <FlowFormCardBody card={formCard({ draft: { id: "reviewer", harness: "codex", bookmark: "work" } }, "acted")} onRunCommand={() => {}} />
    )
    expect(acted.querySelector("[data-testid=flow-form-submit]")).toBeNull()
    expect(acted.querySelector("[data-testid=flow-form-cancel]")).toBeNull()
    expect(acted.querySelector<HTMLInputElement>("[data-testid=flow-form-id]")?.disabled).toBe(true)
    expect(acted.querySelector<HTMLInputElement>("[data-testid=flow-form-id]")?.value).toBe("reviewer")
    const refused = mount(
      <FlowFormCardBody
        card={formCard({ draft: { id: "ui", harness: "codex", bookmark: "work" }, error: "The harness is unavailable." }, "error")}
        onRunCommand={() => {}}
      />
    )
    expect(refused.querySelector("[role=alert]")?.textContent).toBe("The harness is unavailable.")
    expect(refused.querySelector<HTMLInputElement>("[data-testid=flow-form-id]")?.disabled).toBe(false)
    expect(refused.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")?.disabled).toBe(false)
  })

  test("the form's own sentence about the input stands as is; a failed read or run says one sentence and keeps its text behind Details", () => {
    const own = mount(<FlowFormCardBody card={formCard({ error: "The form still needs: Id." }, "error")} onRunCommand={() => {}} />)
      .querySelector<HTMLElement>("[data-testid=flow-form-failure]")!
    expect(own.querySelector("p")?.textContent).toBe("The form still needs: Id.")
    expect(own.dataset.fault).toBe("user")
    expect(own.dataset.failure).toBe("FlowFormInput")
    expect(own.querySelector("details")).toBeNull()
    const cases = [
      { kind: "read", status: "active", tag: "FlowFormReadFailed", sentence: "Smithers could not load the choices for this form. Not your fault.", raw: "Listing issues for o/r failed (500): upstream timeout" },
      { kind: "run", status: "error", tag: "FlowFormRunFailed", sentence: "Smithers could not run this. Not your fault.", raw: "TypeError: Cannot read properties of undefined (reading 'id')" }
    ] as const
    for (const { kind, status, tag, sentence, raw } of cases) {
      const host = mount(<FlowFormCardBody card={formCard({ draft: { id: "ui", harness: "codex", bookmark: "work" }, error: raw, errorKind: kind }, status)} onRunCommand={() => {}} />)
      const notice = host.querySelector<HTMLElement>("[data-testid=flow-form-failure]")!
      expect(notice.getAttribute("role")).toBe("alert")
      expect(notice.dataset.fault).toBe("infra")
      expect(notice.dataset.failure).toBe(tag)
      expect(notice.querySelector("p")?.textContent).toBe(sentence)
      expect(notice.querySelector("p")?.textContent).not.toContain(raw)
      expect(notice.querySelector("details:not([open]) pre")?.textContent).toBe(raw)
      /* Submit is the retry: the notice adds no button of its own, and the form stays editable. */
      expect(notice.querySelectorAll("button")).toHaveLength(0)
      expect(host.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")?.disabled).toBe(false)
    }
  })
})

 test("a user form receives focus from its invoking button without stealing unrelated editing focus", () => {
   const trigger = document.createElement("button")
   trigger.dataset.flow = "tab.harness"
   document.body.append(trigger)
   cleanups.push(() => trigger.remove())
   trigger.focus()
   const form = mount(<FlowFormCardBody card={formCard({ via: "user" })} onRunCommand={() => {}} />)
   expect(document.activeElement).toBe(form.querySelector("input"))
   const editor = document.createElement("textarea")
   document.body.append(editor)
   cleanups.push(() => editor.remove())
   editor.focus()
   mount(<FlowFormCardBody card={formCard({ via: "user" })} onRunCommand={() => {}} />)
   expect(document.activeElement).toBe(editor)
   trigger.focus()
   mount(<FlowFormCardBody card={formCard({ via: "agent" })} onRunCommand={() => {}} />)
   expect(document.activeElement).toBe(trigger)
 })

test("invoking a persisted form again hands focus back without refocusing on draft edits", () => {
 const trigger = document.createElement("button")
 trigger.dataset.flow = "tab.harness"
 const host = document.createElement("div")
 document.body.append(trigger, host)
 const root = createRoot(host)
 cleanups.push(() => { flushSync(() => root.unmount()); host.remove(); trigger.remove() })
 const card = formCard({ via: "user" })
 const render = (ordinal: number, draft = {}) => flushSync(() => root.render(<FlowFormCardBody card={{ ...card, ordinal, payload: { ...card.payload, draft } }} onRunCommand={() => {}} />))
 render(1)
 trigger.focus()
 render(2)
 expect(document.activeElement).toBe(host.querySelector("input"))
 const second = host.querySelector("select")!
 second.focus()
 render(2, { id: "saved" })
 expect(document.activeElement).toBe(second)
})

/*
 * The slash door (CT005, 2026-09-16): the composer hides before the form
 * mounts, so `document.activeElement` is <body> and no button names the flow.
 * The controller records the human's own request as a focus handoff
 * (controller/forms.ts); the card claims it once. Nothing persisted, so a
 * restored form, an agent's form, and a draft edit never take the keyboard.
 */
import { ControllerTestProvider } from "../ControllerContext"

const handoffFor = (cardId: string | undefined) => {
  let pending = cardId
  const controller = {
    formFocus: { take: (id: string): boolean => { if (pending !== id) return false; pending = undefined; return true } }
  } as unknown as AppController
  return { controller, pending: () => pending }
}

const mountWith = (controller: AppController, card: FlowFormCard, onRunCommand: (name: string, args?: string) => void = () => {}) =>
  mount(<ControllerTestProvider controller={controller}><FlowFormCardBody card={card} onRunCommand={onRunCommand} /></ControllerTestProvider>)

describe("form focus handoff from the slash door", () => {
  const optionForm = () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
    const card = formCard({ via: "user", fields: [{ name: "path", label: "Path", kind: "select", required: true }], draft: {} })
    const { controller } = handoffFor(card.id)
    const render = (options: ReadonlyArray<{ value: string; label: string }>) => flushSync(() => root.render(
      <ControllerTestProvider controller={controller}>
        <FlowFormCardBody card={{ ...card, payload: { ...card.payload, fields: card.payload.fields.map(field => ({ ...field, options: [...options] })) } }} onRunCommand={() => {}} />
      </ControllerTestProvider>
    ))
    return { host, render }
  }

  test("a focused field keeps the keyboard when arriving options replace its input and when they disappear", () => {
    const { host, render } = optionForm()
    render([])
    expect(document.activeElement).toBe(host.querySelector("input"))
    render([{ value: "README.md", label: "README.md" }])
    expect(document.activeElement).toBe(host.querySelector("select"))
    render([])
    expect(document.activeElement).toBe(host.querySelector("input"))
  })

  test("arriving options do not take the keyboard from an editor the human moved to", () => {
    const { host, render } = optionForm()
    render([])
    expect(document.activeElement).toBe(host.querySelector("input"))
    const editor = document.createElement("textarea")
    document.body.append(editor)
    cleanups.push(() => editor.remove())
    editor.value = "draft while file options arrive"
    editor.focus()
    render([{ value: "README.md", label: "README.md" }])
    expect(host.querySelector("select")).not.toBeNull()
    expect(document.activeElement).toBe(editor)
    expect(editor.value).toBe("draft while file options arrive")
  })

  test("a user form the controller handed focus takes it on mount from <body>, on its first unfilled required field", () => {
    const { controller, pending } = handoffFor("form-tab.harness")
    expect(document.activeElement).toBe(document.body)
    const host = mountWith(controller, formCard({ via: "user", draft: { id: "reviewer" } }))
    expect(document.activeElement).toBe(host.querySelector("[data-testid=flow-form-harness]"))
    expect(pending()).toBeUndefined()
  })

  test("the composer textarea, hidden once its slash ran, still counts as where the keyboard came from", () => {
    const wrap = document.createElement("div")
    wrap.className = "composer-wrap"
    wrap.hidden = true
    const textarea = document.createElement("textarea")
    wrap.append(textarea)
    document.body.append(wrap)
    cleanups.push(() => wrap.remove())
    textarea.focus()
    const { controller } = handoffFor("form-tab.harness")
    const host = mountWith(controller, formCard({ via: "user" }))
    expect(document.activeElement).toBe(host.querySelector("input"))
  })

  test("a restored form (no handoff), an agent's form, and a form the human has moved past leave focus alone", () => {
    mountWith(handoffFor(undefined).controller, formCard({ via: "user" }))
    expect(document.activeElement).toBe(document.body)
    const agent = handoffFor("form-tab.harness")
    mountWith(agent.controller, formCard({ via: "agent" }))
    expect(document.activeElement).toBe(document.body)
    expect(agent.pending()).toBeUndefined()
    const editor = document.createElement("textarea")
    document.body.append(editor)
    cleanups.push(() => editor.remove())
    editor.focus()
    const moved = handoffFor("form-tab.harness")
    mountWith(moved.controller, formCard({ via: "user" }))
    expect(document.activeElement).toBe(editor)
    // A request the human moved past is dropped, never fired later.
    expect(moved.pending()).toBeUndefined()
  })

  test("the handoff is claimed once: draft edits and a later re-request never refocus a form the human left", () => {
    const { controller } = handoffFor("form-tab.harness")
    const card = formCard({ via: "user" })
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
    const render = (ordinal: number, draft = {}) => flushSync(() => root.render(
      <ControllerTestProvider controller={controller}><FlowFormCardBody card={{ ...card, ordinal, payload: { ...card.payload, draft } }} onRunCommand={() => {}} /></ControllerTestProvider>
    ))
    render(1)
    const first = host.querySelector("input")!
    expect(document.activeElement).toBe(first)
    const second = host.querySelector("select")!
    second.focus()
    render(1, { id: "saved" })
    expect(document.activeElement).toBe(second)
    const elsewhere = document.createElement("button")
    document.body.append(elsewhere)
    cleanups.push(() => elsewhere.remove())
    elsewhere.focus()
    render(2, { id: "saved" })
    expect(document.activeElement).toBe(elsewhere)
  })

  test("a keyboard submission keeps focus at the card while its controls disable, returns it to the open field when refused, and holds it once acted", () => {
    const card = formCard({ fields: [{ name: "id", label: "Id", kind: "text", required: true }], draft: { id: "reviewer" } })
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
    const render = (payload: Partial<FlowFormCard["payload"]>, status: Card["status"] = "active") => flushSync(() => root.render(
      <FlowFormCardBody card={{ ...card, status, payload: { ...card.payload, ...payload } }} onRunCommand={() => {}} />
    ))
    render({})
    const field = host.querySelector("input")!
    const form = host.querySelector("form")!
    field.focus()
    render({ submitting: true })
    expect(field.disabled).toBe(true)
    expect(document.activeElement).toBe(form)
    render({ submitting: false, error: "The harness is unavailable." }, "error")
    expect(document.activeElement).toBe(field)
    field.focus()
    render({ submitting: true })
    render({ submitting: false }, "acted")
    expect(document.activeElement).toBe(form)
    // A submission that never held focus (pointer, or another field) does not grab it.
    field.focus()
    const editor = document.createElement("textarea")
    document.body.append(editor)
    cleanups.push(() => editor.remove())
    editor.focus()
    render({ submitting: true })
    expect(document.activeElement).toBe(editor)
  })

  test("Cancel from the keyboard moves focus to the next control after the card before the card leaves", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<FlowFormCardBody card={formCard()} onRunCommand={onRunCommand} />)
    const chat = document.createElement("button")
    chat.textContent = "Chat"
    document.body.append(chat)
    cleanups.push(() => chat.remove())
    const cancel = host.querySelector<HTMLButtonElement>("[data-testid=flow-form-cancel]")!
    cancel.focus()
    cancel.click()
    expect(document.activeElement).toBe(chat)
    expect(calls).toEqual([["card.dismiss", "form-tab.harness"]])
  })
})

/*
 * A field whose options are suggestions, not a closed set: files.read's Path
 * (CT105, flows/entries/files.ts). The control is the same <input> before and
 * after the inventory lands, so the visible value, the persisted draft and the
 * submitted input never diverge. Every commit here goes through the
 * controller's own decision (state/controller/forms.ts), which accepts a typed
 * value for a text field and would refuse one for a select.
 */
import { decideFormFieldInput } from "../state/controller/forms"

describe("a text field whose options are suggestions", () => {
  const files = [{ value: "README.md", label: "README.md" }, { value: "src/index.ts", label: "src/index.ts" }]

  const pathForm = () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
    let card = formCard({ via: "user", fields: [{ name: "path", label: "Path", kind: "text", required: true, optionsFrom: "files" }] })
    const submitted: Array<string | number | boolean | undefined> = []
    const refusals: Array<string> = []
    const paint = (): void => root.render(<FlowFormCardBody card={card} onRunCommand={(name, args) => {
      if (name === "form.submit") {
        submitted.push(card.payload.draft["path"])
        return
      }
      if (name !== "form.set") return
      const parsed = payloadFor(name, args)
      if (!("payload" in parsed)) throw new Error("field commit did not parse")
      const decided = decideFormFieldInput(card, card.id, String(parsed.payload.field), String(parsed.payload.value))
      if ("error" in decided) {
        refusals.push(decided.error)
        return
      }
      card = decided.card
      paint()
    }} />)
    const arrive = (options: ReadonlyArray<{ value: string; label: string }>): void => {
      card = { ...card, payload: { ...card.payload, fields: card.payload.fields.map((field) => ({ ...field, options: [...options] })) } }
      flushSync(paint)
    }
    arrive([])
    return {
      host,
      submitted,
      refusals,
      arrive,
      draft: () => card.payload.draft["path"],
      field: () => host.querySelector<HTMLInputElement>("[data-testid=flow-form-path]")!,
      suggestions: () => [...host.querySelectorAll("datalist option")].map((option) => option.getAttribute("value")),
      submit: () => host.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")!
    }
  }

  test("the inventory arrives as suggestions without replacing the control the human is typing in", () => {
    const form = pathForm()
    const typed = form.field()
    typed.focus()
    input(form.host, "flow-form-path", "REA")
    form.arrive(files)
    expect(form.field() === typed).toBe(true)
    expect(document.activeElement === typed).toBe(true)
    expect(form.field().value).toBe("REA")
    expect(form.draft()).toBe("REA")
    expect(form.suggestions()).toEqual(["README.md", "src/index.ts"])
    expect(form.submit().disabled).toBe(false)
  })

  test("clearing the typed path keeps the same control, its focus and its suggestions", () => {
    const form = pathForm()
    form.field().focus()
    input(form.host, "flow-form-path", "REA")
    form.arrive(files)
    const typed = form.field()
    input(form.host, "flow-form-path", "")
    expect(form.field() === typed).toBe(true)
    expect(document.activeElement === typed).toBe(true)
    expect(form.field().value).toBe("")
    expect(form.draft()).toBeUndefined()
    expect(form.suggestions()).toEqual(["README.md", "src/index.ts"])
    expect(form.submit().disabled).toBe(true)
  })

  test("a suggestion taken from the keyboard commits the whole value, and Submit sends what the control shows", () => {
    const form = pathForm()
    form.arrive(files)
    form.field().focus()
    input(form.host, "flow-form-path", "README.md")
    expect(form.field().value).toBe("README.md")
    expect(form.draft()).toBe("README.md")
    expect(document.activeElement === form.field()).toBe(true)
    form.submit().click()
    expect(form.submitted).toEqual(["README.md"])
    expect(form.refusals).toEqual([])
  })
})
