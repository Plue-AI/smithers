import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { failedModelTest, modelCallDefault, ModelsCardPayloadSchema } from "@smthrs/rpc/ConfiguredModel"
import type { ModelTestFailure, ModelTestRecord } from "@smthrs/rpc/ConfiguredModel"
import type { Card } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { memoryStorage } from "../state/TestFixtures"
import type { CardActions } from "./CardFamily"
import { FLOW_NAMES } from "../flows/FlowName"
import { modelCardFamily, ModelsCardBody } from "./ModelCards"

/*
 * The Models card in both presentations. Every act is asserted as the flow it
 * names and every state through the DOM contract the real suite reads
 * (data-model-id, data-test-state, data-failure-code, data-seat).
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type ModelsCard = Extract<Card, { kind: "models" }>
type Payload = ModelsCard["payload"]

const base = { title: "Models", status: "active" as const, createdAt: 0, ordinal: 0 }

const user: Payload["models"][number] = {
  id: "fast-kimi",
  protocol: "openai-chat",
  baseUrl: "https://openrouter.ai/api",
  modelId: "moonshotai/kimi-k3",
  credential: "OPENROUTER_API_KEY"
}
const builtin: Payload["models"][number] = {
  id: "cerebras",
  protocol: "openai-chat",
  baseUrl: "https://api.cerebras.ai",
  modelId: "gpt-oss-120b",
  credential: "CEREBRAS_API_KEY",
  builtin: true
}
const jev: Payload["models"][number] = {
  id: "jev",
  protocol: "evaluation",
  modelId: "typesafe-ai/jev",
  credential: "AI_GATEWAY_API_KEY",
  builtin: true
}
const credentials: Payload["credentials"] = [
  { name: "OPENROUTER_API_KEY", present: false, origins: ["https://openrouter.ai"] },
  { name: "CEREBRAS_API_KEY", present: true, origins: ["https://api.cerebras.ai"] },
  { name: "AI_GATEWAY_API_KEY", present: true, origins: ["https://ai-gateway.vercel.sh"] }
]

/** A payload the wire accepts: a fixture the schema refuses would prove nothing about the card. */
const modelsCard = (payload: Partial<Payload>): ModelsCard => ({
  ...base,
  id: "models",
  kind: "models",
  payload: ModelsCardPayloadSchema.parse({ models: [], seats: [], credentials, tests: [], testing: [], host: "observed", ...payload })
})

/** The refusal a host with an identity seam answers a signed-out caller with. */
const signInRefusal: ModelTestFailure = { code: "host_refused", refusal: "sign_in_required", status: 401, fault: "user" }

const passed = (id: string, latencyMs: number, sample = "ok"): ModelTestRecord => ({ id, testedAt: 1, result: { ok: true, latencyMs, sample } })
const failed = (id: string, failure: ModelTestFailure): ModelTestRecord => ({ id, testedAt: 1, result: failedModelTest(failure, 40, "local") })

const mount = (node: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(node)
  })
  return host
}

const recorder = () => {
  const calls: Array<[string, string | undefined]> = []
  return { calls, onRunCommand: (name: string, args?: string) => void calls.push([name, args]) }
}

const row = (host: HTMLElement, id: string): HTMLElement => {
  const element = host.querySelector<HTMLElement>(`[data-model-id="${id}"]`)
  if (element === null) throw new Error(`no row for ${id}`)
  return element
}

/** The buttons under one element as `[accessible name, flow, args]`. */
const acts = (root: Element): Array<[string, string | null, string | null]> =>
  [...root.querySelectorAll("button")].map((button) => [button.textContent ?? "", button.getAttribute("data-flow"), button.getAttribute("data-flow-args")])

const many = (count: number): Payload["models"] => Array.from({ length: count }, (_, index) => ({ ...user, id: `model-${index}` }))

describe("the Models card, embedded", () => {
  test("no models is two words and one act", () => {
    const { onRunCommand } = recorder()
    const host = mount(<ModelsCardBody card={modelsCard({ host: "observed" })} onRunCommand={onRunCommand} presentation="embedded" />)
    expect(host.querySelector("[data-presentation]")?.getAttribute("data-presentation")).toBe("embedded")
    expect(host.querySelector('[data-testid="models-empty"]')?.textContent).toBe("No models.")
    expect(host.textContent).toBe("No models.New")
    expect(acts(host)).toEqual([["New", "model.new", null]])
  })

  test("a few rows, the overflow as a count, and neither the detail nor the seats", () => {
    const { onRunCommand } = recorder()
    const host = mount(<ModelsCardBody card={modelsCard({ models: many(6), selected: "model-5", seats: [{ id: "explainer", recordId: null, resolvable: true }] })}
      onRunCommand={onRunCommand} presentation="embedded" />)
    expect(host.querySelectorAll('[data-testid="models-list"] > [data-model-id]').length).toBe(4)
    expect(host.querySelector('[data-testid="models-more"]')?.textContent).toBe("+2")
    expect(host.querySelector('[data-testid="model-detail"]')).toBeNull()
    expect(host.querySelector('[data-testid="model-seats"]')).toBeNull()
    expect(host.querySelector("select")).toBeNull()
    expect(host.querySelector('[data-flow="model.show"]')).toBeNull()
    expect(host.querySelectorAll('[data-testid="model-new"]').length).toBe(1)
  })

  test("the user's own models come before the host's, so the overflow never hides their Test", () => {
    const { onRunCommand } = recorder()
    const hosts = many(5).map((model) => ({ ...model, id: `host-${model.id}`, builtin: true }))
    const host = mount(<ModelsCardBody card={modelsCard({ models: [...hosts, user] })} onRunCommand={onRunCommand} presentation="embedded" />)
    const shown = [...host.querySelectorAll('[data-testid="models-list"] > [data-model-id]')].map((element) => element.getAttribute("data-model-id"))
    expect(shown).toEqual(["fast-kimi", "host-model-0", "host-model-1", "host-model-2"])
    expect(host.querySelector('[data-testid="models-more"]')?.textContent).toBe("+2")
  })

  test("the model just saved or tested leads the few rows, so the overflow never hides it", () => {
    const { onRunCommand } = recorder()
    const host = mount(<ModelsCardBody card={modelsCard({ models: many(6), selected: "model-5" })} onRunCommand={onRunCommand} presentation="embedded" />)
    const shown = [...host.querySelectorAll('[data-testid="models-list"] > [data-model-id]')].map((element) => element.getAttribute("data-model-id"))
    expect(shown).toEqual(["model-5", "model-0", "model-1", "model-2"])
    expect(row(host, "model-5").getAttribute("data-selected")).toBeNull()
  })

  test("a row names its model, its kind, and the four acts through their flows", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<ModelsCardBody card={modelsCard({ models: [user, jev] })} onRunCommand={onRunCommand} presentation="embedded" />)
    const mine = row(host, "fast-kimi")
    expect(mine.getAttribute("data-testid")).toBe("model-row-fast-kimi")
    expect(mine.getAttribute("data-test-state")).toBe("idle")
    expect(mine.hasAttribute("data-builtin")).toBe(false)
    expect(mine.textContent).toContain("fast-kimi")
    expect(mine.textContent).toContain("generation")
    expect(row(host, "jev").textContent).toContain("decision")
    expect(acts(mine)).toEqual([["Test", "model.test", "fast-kimi"], ["Compose", "model.compose", "fast-kimi"], ["Edit", "model.edit", "fast-kimi"], ["Remove", "model.remove", "fast-kimi"]])
    for (const button of mine.querySelectorAll("button")) button.click()
    expect(calls).toEqual([["model.test", "fast-kimi"], ["model.compose", "fast-kimi"], ["model.edit", "fast-kimi"], ["model.remove", "fast-kimi"]])
  })

  test("a host row can only be tested and composed against", () => {
    const { onRunCommand } = recorder()
    const host = mount(<ModelsCardBody card={modelsCard({ models: [builtin] })} onRunCommand={onRunCommand} presentation="embedded" />)
    expect(row(host, "cerebras").getAttribute("data-builtin")).toBe("true")
    expect(acts(row(host, "cerebras"))).toEqual([["Test", "model.test", "cerebras"], ["Compose", "model.compose", "cerebras"]])
  })

  test("an untyped refresh error says our sentence with Retry; its words stay behind Details", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<ModelsCardBody card={modelsCard({ host: "unavailable", error: "The server answered 500" })} onRunCommand={onRunCommand} presentation="embedded" />)
    const alert = host.querySelector<HTMLElement>('[data-testid="models-error"]')!
    expect(alert.getAttribute("role")).toBe("alert")
    expect(alert.dataset.failure).toBe("ModelsFailed")
    expect(alert.dataset.fault).toBe("infra")
    expect(alert.querySelector("p")?.textContent).toBe("Smithers could not list models. Not your fault.")
    expect(alert.querySelector("details")?.open).toBe(false)
    expect(alert.querySelector("details pre")?.textContent).toBe("The server answered 500")
    alert.querySelector<HTMLButtonElement>('button[data-flow="model.list"]')!.click()
    expect(calls).toEqual([["model.list", undefined]])
  })

  /* Every code a failed catalog read can carry: its fault, its sentence, and whether Retry is offered. The code line is only the detail. */
  test("a typed refresh failure picks its sentence by code, never showing the code line", () => {
    const cases: ReadonlyArray<[ModelTestFailure, string, string, boolean]> = [
      [{ code: "unreachable" }, "dependency", "The model host did not answer. Not your fault.", true],
      [{ code: "empty_output" }, "dependency", "The model host answered with nothing. Not your fault.", true],
      [{ code: "refused", status: 429 }, "wait", "The model host is busy. Not your fault.", true],
      [{ code: "refused", status: 503 }, "dependency", "The model host failed to list models. Not your fault.", true],
      [{ code: "refused", status: 403 }, "user", "The model host refused to list models. Check its credential.", true],
      [{ code: "timeout", deadlineMs: 5000 }, "dependency", "The model host took too long to answer. Not your fault.", true],
      [{ code: "invalid", field: "baseUrl" }, "user", "A model setting is invalid. Edit it and try again.", false],
      [{ code: "credential_missing", credential: "OPENROUTER_API_KEY" }, "infra", "A credential this host needs is not set. Not your fault.", true],
      [{ code: "credential_unknown", credential: "OPENROUTER_API_KEY" }, "user", "A model names a credential this host does not know.", false],
      [{ code: "endpoint_forbidden" }, "user", "A credential is not allowed for this model's address.", false],
      [{ code: "model_not_allowed" }, "user", "This model is not allowed for decisions.", false],
      [{ code: "host_refused", refusal: "upstream_refused", status: 502, fault: "infra" }, "infra", "Smithers could not list models. Not your fault.", true],
      [{ code: "host_refused", refusal: "request_invalid", status: 400, fault: "user" }, "user", "Smithers refused to list models.", true]
    ]
    for (const [failure, fault, sentence, retry] of cases) {
      const { onRunCommand } = recorder()
      const line = `${failure.code} · raw`
      const host = mount(<ModelsCardBody card={modelsCard({ host: "unavailable", refresh: { state: "failed", failure }, error: line })}
        onRunCommand={onRunCommand} presentation="embedded" />)
      const alert = host.querySelector<HTMLElement>('[data-testid="models-error"]')!
      expect(alert.dataset.failure).toBe(`models.${failure.code}`)
      expect(alert.dataset.fault).toBe(fault)
      expect(alert.querySelector("p")?.textContent).toBe(sentence)
      expect(alert.querySelector("p")?.textContent).not.toMatch(/·|_|raw/)
      expect(alert.querySelector("details pre")?.textContent).toBe(line)
      expect(alert.querySelector('button[data-flow="model.list"]') !== null).toBe(retry)
      host.remove()
    }
  })

  /* A catalog nobody read says nothing about what the host holds. */
  test("an unread catalog never claims there are no models", () => {
    const { onRunCommand } = recorder()
    const host = mount(<ModelsCardBody card={modelsCard({ host: "unavailable" })} onRunCommand={onRunCommand} presentation="embedded" />)
    expect(host.querySelector('[data-testid="models-empty"]')).toBeNull()
    expect(host.textContent).not.toContain("No models")
    expect(acts(host)).toEqual([["New", "model.new", null]])
  })

  /*
   * Will, signed out on production: "No models." beside a red `host_refused ·
   * sign_in_required`. Being signed out is an expected condition, so it is a
   * step — one button, no alert, no sentence.
   */
  test("a host that wants a session offers the sign-in step, never a red line", () => {
    const { onRunCommand } = recorder()
    const host = mount(<ModelsCardBody
      card={modelsCard({ host: "unavailable", refresh: { state: "failed", failure: signInRefusal }, error: "host_refused · sign_in_required" })}
      onRunCommand={onRunCommand} presentation="embedded" />)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.textContent).not.toContain("sign_in_required")
    expect(acts(host)).toEqual([["Sign in", "auth.prompt", null], ["New", "model.new", null]])
  })

  test("a session that lapsed mid-use offers the same step in place of Test or Edit", () => {
    const { onRunCommand } = recorder()
    const host = mount(<ModelsCardBody
      card={modelsCard({ models: [builtin], tests: [failed("cerebras", signInRefusal)], attention: { kind: "test-failed", recordId: "cerebras" } })}
      onRunCommand={onRunCommand} presentation="embedded" />)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[data-testid="models-attention-fix"]')?.getAttribute("data-flow")).toBe("auth.prompt")
    expect(acts(host)).toEqual([["Sign in", "auth.prompt", null]])
  })
})

describe("a model's test result", () => {
  const render = (payload: Partial<Payload>): HTMLElement => {
    const { onRunCommand } = recorder()
    return mount(<ModelsCardBody card={modelsCard({ models: [user], ...payload })} onRunCommand={onRunCommand} presentation="embedded" />)
  }

  test("a pass is a dot and its latency, and the sample is never shown", () => {
    const mine = row(render({ tests: [passed("fast-kimi", 412, "sk-live-abc123")] }), "fast-kimi")
    expect(mine.getAttribute("data-test-state")).toBe("passed")
    expect(mine.hasAttribute("data-failure-code")).toBe(false)
    expect(mine.hasAttribute("data-failure-fault")).toBe(false)
    expect(mine.textContent).toContain("412 ms")
    expect(mine.innerHTML).not.toContain("sk-live-abc123")
  })

  test("a running test wears no stale result and cannot be asked twice", () => {
    const mine = row(render({ tests: [failed("fast-kimi", { code: "unreachable" })], testing: ["fast-kimi"] }), "fast-kimi")
    expect(mine.getAttribute("data-test-state")).toBe("running")
    expect(mine.hasAttribute("data-failure-code")).toBe(false)
    expect(mine.textContent).not.toContain("unreachable")
    expect(mine.querySelector<HTMLButtonElement>('[data-flow="model.test"]')?.disabled).toBe(true)
  })

  test("a timeout reads the deadline from the record that armed it", () => {
    const mine = row(render({ tests: [failed("fast-kimi", { code: "timeout", deadlineMs: 7321 })] }), "fast-kimi")
    expect(mine.getAttribute("data-test-state")).toBe("failed")
    expect(mine.getAttribute("data-failure-code")).toBe("timeout")
    expect(mine.getAttribute("data-failure-fault")).toBe("dependency")
    expect(mine.textContent).toContain("timeout · 7321 ms")
  })

  const cases: ReadonlyArray<[ModelTestFailure, string, string]> = [
    [{ code: "refused", status: 401 }, "refused · 401", "user"],
    [{ code: "refused", status: 429 }, "refused · 429", "wait"],
    [{ code: "invalid", field: "baseUrl" }, "invalid · baseUrl", "user"],
    [{ code: "credential_missing", credential: "OPENROUTER_API_KEY" }, "credential_missing · OPENROUTER_API_KEY", "user"],
    [{ code: "credential_unknown", credential: "HOME" }, "credential_unknown · HOME", "user"],
    [{ code: "unreachable" }, "unreachable", "dependency"],
    [{ code: "endpoint_forbidden" }, "endpoint_forbidden", "user"],
    [{ code: "model_not_allowed" }, "model_not_allowed", "user"],
    [{ code: "host_refused", refusal: "sign_in_required", status: 401, fault: "user" }, "host_refused · sign_in_required", "user"],
    [{ code: "host_refused", refusal: null, status: 503, fault: "infra" }, "host_refused · 503", "infra"],
    [{ code: "host_refused", refusal: null, status: null, fault: "infra" }, "host_refused", "infra"]
  ]
  for (const [failure, text, fault] of cases) {
    test(`${text} is the code and its number, with its fault`, () => {
      const mine = row(render({ tests: [failed("fast-kimi", failure)] }), "fast-kimi")
      expect(mine.getAttribute("data-failure-code")).toBe(failure.code)
      expect(mine.getAttribute("data-failure-fault")).toBe(fault)
      expect(mine.querySelector(".models-test")?.textContent).toBe(text)
    })
  }
})

describe("the Models card, surfaced unasked", () => {
  const attentionActs = (payload: Partial<Payload>) => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<ModelsCardBody card={modelsCard({ models: [user, builtin, jev], ...payload })} onRunCommand={onRunCommand} presentation="embedded" />)
    return { calls, host }
  }

  test("a failed user model is that one row and Edit", () => {
    const { calls, host } = attentionActs({ tests: [failed("fast-kimi", { code: "refused", status: 401 })], attention: { kind: "test-failed", recordId: "fast-kimi" } })
    expect(host.querySelector('[data-testid="models-attention"]')?.getAttribute("data-kind")).toBe("test-failed")
    expect(host.querySelectorAll("[data-model-id]").length).toBe(1)
    expect(row(host, "fast-kimi").textContent).toContain("refused · 401")
    expect(acts(host)).toEqual([["Edit", "model.edit", "fast-kimi"]])
    expect(host.querySelector("button")?.getAttribute("data-testid")).toBe("models-attention-fix")
    host.querySelector("button")?.click()
    expect(calls).toEqual([["model.edit", "fast-kimi"]])
  })

  test("a user model that failed through no mistake of its own is that one row and Test", () => {
    for (const failure of [{ code: "refused", status: 429 }, { code: "timeout", deadlineMs: 15000 }, { code: "unreachable" }] as const) {
      const { calls, host } = attentionActs({ tests: [failed("fast-kimi", failure)], attention: { kind: "test-failed", recordId: "fast-kimi" } })
      expect(host.querySelectorAll("[data-model-id]").length).toBe(1)
      expect(acts(host)).toEqual([["Test", "model.test", "fast-kimi"]])
      expect(host.querySelector("button")?.getAttribute("data-testid")).toBe("models-attention-fix")
      host.querySelector("button")?.click()
      expect(calls).toEqual([["model.test", "fast-kimi"]])
    }
  })

  test("a failed host model cannot be edited, so its one act is Test", () => {
    const { host } = attentionActs({ tests: [failed("cerebras", { code: "unreachable" })], attention: { kind: "test-failed", recordId: "cerebras" } })
    expect(host.querySelectorAll("[data-model-id]").length).toBe(1)
    expect(acts(host)).toEqual([["Test", "model.test", "cerebras"]])
  })

  test("an unresolved seat is the seat, what it pointed at, and Assign", () => {
    const { host } = attentionActs({ seats: [{ id: "explainer", recordId: "gone", resolvable: false }], attention: { kind: "seat-unresolved", seat: "explainer" } })
    const attention = host.querySelector('[data-testid="models-attention"]')
    expect(attention?.getAttribute("data-kind")).toBe("seat-unresolved")
    expect(attention?.textContent).toBe("ExplainergoneAssign")
    expect(host.querySelector("[data-model-id]")).toBeNull()
    expect(acts(host)).toEqual([["Assign", "model.assign", "explainer"]])
  })

  test("a Chat seat with a missing credential offers Assign", () => {
    const model = { ...user, credential: "OWNER_E2E" }
    const { host } = attentionActs({ models: [model], seats: [{ id: "chat", recordId: model.id, resolvable: false }],
      attention: { kind: "seat-unresolved", seat: "chat" } })
    expect(host.querySelector('[data-testid="models-attention"]')?.textContent).toBe("Chatcredential_missing · OWNER_E2EAssign")
    expect(acts(host)).toEqual([["Assign", "model.assign", "chat"]])
  })

  test("attention on a model that is gone falls back to the list", () => {
    const { host } = attentionActs({ attention: { kind: "test-failed", recordId: "removed" } })
    expect(host.querySelector('[data-testid="models-attention"]')).toBeNull()
    expect(host.querySelectorAll("[data-model-id]").length).toBe(3)
  })

  test("maximized ignores attention: the whole list is already there", () => {
    const { onRunCommand } = recorder()
    const host = mount(<ModelsCardBody card={modelsCard({ models: [user, builtin], attention: { kind: "test-failed", recordId: "fast-kimi" } })}
      onRunCommand={onRunCommand} presentation="maximized" />)
    expect(host.querySelector('[data-testid="models-attention"]')).toBeNull()
    expect(host.querySelectorAll("[data-model-id]").length).toBe(2)
  })
})

describe("the Models card, maximized", () => {
  const seats: Payload["seats"] = [
    { id: "explainer", recordId: "fast-kimi", resolvable: true },
    { id: "front-door", recordId: null, resolvable: true }
  ]
  const render = (payload: Partial<Payload> = {}) => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<ModelsCardBody card={modelsCard({ models: [builtin, user, jev], seats, ...payload })} onRunCommand={onRunCommand} presentation="maximized" />)
    return { calls, host }
  }

  test("every row, and selecting one is the model.show flow", () => {
    const { calls, host } = render({ models: many(6) })
    expect(host.querySelector("[data-presentation]")?.getAttribute("data-presentation")).toBe("maximized")
    expect(host.querySelectorAll("[data-model-id]").length).toBe(6)
    expect(host.querySelector('[data-testid="models-more"]')).toBeNull()
    const select = row(host, "model-3").querySelector<HTMLElement>('[data-flow="model.show"]')
    expect(select?.getAttribute("data-flow-args")).toBe("model-3")
    select?.click()
    expect(calls).toEqual([["model.show", "model-3"]])
  })

  test("the detail is the selected model's facts, and only the row carries data-model-id", () => {
    const { host } = render({ selected: "fast-kimi" })
    const detail = host.querySelector('[data-testid="model-detail"]')
    expect(detail?.hasAttribute("data-model-id")).toBe(false)
    expect(detail?.querySelector("[data-model-id]")).toBeNull()
    expect(detail?.textContent).toContain("openai-chat")
    expect(detail?.textContent).toContain("moonshotai/kimi-k3")
    expect(detail?.textContent).toContain("https://openrouter.ai/api")
    expect(row(host, "fast-kimi").getAttribute("data-selected")).toBe("true")
    expect(row(host, "cerebras").hasAttribute("data-selected")).toBe(false)
    expect(host.querySelectorAll('[data-model-id="fast-kimi"]').length).toBe(1)
  })

  test("the detail's acts are Test, Compose, Edit and Remove; a host model's are Test and Compose", () => {
    const mine = render({ selected: "fast-kimi" }).host.querySelector('[data-testid="model-detail"]')!
    expect(acts(mine)).toEqual([["Test", "model.test", "fast-kimi"], ["Compose", "model.compose", "fast-kimi"], ["Edit", "model.edit", "fast-kimi"], ["Remove", "model.remove", "fast-kimi"]])
    const hosts = render({ selected: "cerebras" }).host.querySelector('[data-testid="model-detail"]')!
    expect(acts(hosts)).toEqual([["Test", "model.test", "cerebras"], ["Compose", "model.compose", "cerebras"]])
  })

  test("with nothing selected the detail is the first row's", () => {
    const { host } = render()
    expect(host.querySelector('[data-testid="model-detail"]')?.textContent).toContain("gpt-oss-120b")
    expect(row(host, "cerebras").getAttribute("data-selected")).toBe("true")
  })

  test("the credential cell is a name and whether the host holds it", () => {
    const missing = render({ selected: "fast-kimi" }).host.querySelector('[data-testid="model-credential"]')
    expect(missing?.getAttribute("data-present")).toBe("false")
    expect(missing?.textContent).toBe("OPENROUTER_API_KEY · missing")
    const present = render({ selected: "cerebras" }).host.querySelector('[data-testid="model-credential"]')
    expect(present?.getAttribute("data-present")).toBe("true")
    expect(present?.textContent).toBe("CEREBRAS_API_KEY")
  })

  test("one select per seat the host listed, offering only the models the seat accepts", () => {
    const { host } = render()
    const table = host.querySelector('[data-testid="model-seats"]')!
    expect([...table.querySelectorAll("[data-seat-row]")].map((tr) => [tr.getAttribute("data-seat-row"), tr.getAttribute("data-resolvable")]))
      .toEqual([["explainer", "true"], ["front-door", "true"]])
    const options = (seat: string) => [...table.querySelectorAll(`select[data-seat="${seat}"] option`)].map((option) => [option.getAttribute("value"), option.textContent])
    expect(options("explainer")).toEqual([["default", "Default"], ["cerebras", "cerebras"], ["fast-kimi", "fast-kimi"]])
    expect(options("front-door")).toEqual([["default", "Default"], ["jev", "jev"]])
    expect(table.querySelector<HTMLSelectElement>('select[data-seat="explainer"]')?.value).toBe("fast-kimi")
    expect(table.querySelector<HTMLSelectElement>('select[data-seat="front-door"]')?.value).toBe("default")
    expect(table.querySelector('select[data-seat="explainer"]')?.getAttribute("data-flow")).toBe("model.assign")
    expect(table.querySelector<HTMLSelectElement>('select[data-seat="explainer"]')?.getAttribute("aria-label")).toBe("Explainer")
  })

  test("changing a seat runs model.assign, and default is a value, never blank", () => {
    const { calls, host } = render()
    const select = host.querySelector<HTMLSelectElement>('select[data-seat="explainer"]')!
    select.value = "cerebras"
    select.dispatchEvent(new Event("change", { bubbles: true }))
    select.value = "default"
    select.dispatchEvent(new Event("change", { bubbles: true }))
    expect(calls).toEqual([["model.assign", "explainer cerebras"], ["model.assign", "explainer default"]])
  })

  test("a seat whose record is gone still shows what it points at", () => {
    const { host } = render({ seats: [{ id: "explainer", recordId: "gone", resolvable: false }] })
    expect(host.querySelector('[data-seat-row="explainer"]')?.getAttribute("data-resolvable")).toBe("false")
    expect(host.querySelector<HTMLSelectElement>('select[data-seat="explainer"]')?.value).toBe("gone")
  })

  test("a host that lists no seats gets no seats table", () => {
    expect(render({ seats: [] }).host.querySelector('[data-testid="model-seats"]')).toBeNull()
  })

  test("no models: the empty line, New, and no detail", () => {
    const { host } = render({ models: [], seats: [] })
    expect(host.textContent).toBe("No models.New")
    expect(host.querySelector('[data-testid="model-detail"]')).toBeNull()
  })
})

describe("nothing on the card is a credential value", () => {
  test("the card renders names, origins never, and no input a value could be typed into", () => {
    const { onRunCommand } = recorder()
    const host = mount(<ModelsCardBody card={modelsCard({ models: [user, builtin], selected: "fast-kimi", tests: [passed("fast-kimi", 9, "Bearer sk-or-v1-deadbeef")] })}
      onRunCommand={onRunCommand} presentation="maximized" />)
    expect(host.innerHTML).not.toContain("sk-or-v1-deadbeef")
    expect(host.querySelector("input, textarea")).toBeNull()
  })
})

describe("the family entry", () => {
  const actions = (presentation?: "embedded" | "maximized"): CardActions =>
    ({ onRunCommand: () => undefined, ...(presentation === undefined ? {} : { presentation }) }) as unknown as CardActions

  test("presentation arrives through CardActions, and a static preview reads as embedded", () => {
    const card = modelsCard({ models: [user], seats: [{ id: "explainer", recordId: null, resolvable: true }] })
    expect(mount(modelCardFamily.models.render(card, actions("maximized"))).querySelector('[data-testid="model-seats"]')).not.toBeNull()
    expect(mount(modelCardFamily.models.render(card, actions("embedded"))).querySelector('[data-testid="model-seats"]')).toBeNull()
    expect(mount(modelCardFamily.models.render(card, actions())).querySelector("[data-presentation]")?.getAttribute("data-presentation")).toBe("embedded")
  })

  test("the pill is running while a test is out, failed while it needs someone, settled otherwise", () => {
    expect(modelCardFamily.models.pill(modelsCard({ models: [user], testing: ["fast-kimi"], attention: { kind: "test-failed", recordId: "fast-kimi" } }))).toBe("running")
    expect(modelCardFamily.models.pill(modelsCard({ models: [user], attention: { kind: "test-failed", recordId: "fast-kimi" } }))).toBe("failed")
    expect(modelCardFamily.models.pill(modelsCard({}))).toBe("done")
  })
})

describe("the composer card, bound to the store", () => {
  test("Last test appears once a Test lands, read from the model's record, with no rewrite of the card", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "model.saved", actor: "user", model: { id: "judge", protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" } }).isPersisted.promise
    const composer: Card = { id: "model-call-judge", kind: "model-call", title: "judge", status: "active", createdAt: 0, ordinal: 1, payload: { model: "judge", request: modelCallDefault("decision") } }
    await store.dispatch({ type: "card.upsert", actor: "user", card: composer }).isPersisted.promise
    const saved = structuredClone(store.collections.cards.get(composer.id))
    const noop = () => {}
    const Bound = () => modelCardFamily["model-call"].render(composer as Extract<Card, { kind: "model-call" }>, { projectionStore: store, worldDocuments: [], onRunCommand: noop,
      onDecideApproval: noop, onGrantConfirm: noop, onGrantCancel: noop, 
      onConnectGitHub: noop, onRunWorkflow: noop, onStopRun: noop,
      onRetryRun: noop, onChooseWorkflowRepo: noop, onChangeWorldDocument: noop })
    const host = mount(<Bound />)
    try {
      expect(host.querySelector('[data-testid="model-call-recall"]')).toBeNull()
      await store.dispatch({ type: "model.tested", actor: "system", test: passed("judge", 12) }).isPersisted.promise
      await new Promise((resolve) => setTimeout(resolve, 0))
      flushSync(() => {})
      expect(host.querySelector('[data-testid="model-call-recall"]')?.textContent).toBe("Last test")
      expect(store.collections.cards.get(composer.id)).toEqual(saved)
    } finally {
      await store.settled?.()
      await store.dispose?.()
    }
  })
})

/* Smithers Cloud runs models on platform keys and charges credit: there is no bring-your-own-key door. */
describe("no model credential enrollment", () => {
  test("no model.credential flow exists", () => {
    expect(FLOW_NAMES.filter(name => name.startsWith("model.credential"))).toEqual([])
  })

  test("a host that still lists enrollment gets no Add credential, Rotate or Remove", () => {
    for (const presentation of ["embedded", "maximized"] as const) {
      const managed = { name: "MINE", origins: ["https://provider.example"], present: true, managed: true }
      const payload = { credentials: [...credentials, managed], enrollment: { available: true as const }, selected: "fast-kimi",
        tests: [failed("fast-kimi", { code: "credential_missing", credential: "MINE" })], attention: { kind: "test-failed" as const, recordId: "fast-kimi" } }
      const host = mount(<ModelsCardBody card={modelsCard({ models: [user], ...payload })} onRunCommand={() => {}} presentation={presentation} />)
      expect(host.textContent).not.toContain("Add credential")
      expect([...host.querySelectorAll("button")].map(button => button.textContent)).not.toContain("Rotate")
      expect(host.querySelector('[data-flow^="model.credential"], [data-testid="model-credentials"]')).toBeNull()
    }
  })
})
