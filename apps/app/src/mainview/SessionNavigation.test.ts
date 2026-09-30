import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { modeShortcut } from "./SessionNavigation"

// This tests the exported predicate only. The mounted navigation uses bindPressActions.
const ownedGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>()
let ownsDOM = false

const sameDescriptor = (left: PropertyDescriptor | undefined, right: PropertyDescriptor | undefined): boolean => {
  if (left === undefined || right === undefined) return left === right
  return left.configurable === right.configurable && left.enumerable === right.enumerable &&
    left.writable === right.writable && Object.is(left.value, right.value) && left.get === right.get && left.set === right.set
}

beforeAll(() => {
  const before = new Map(Reflect.ownKeys(globalThis).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)!]))
  GlobalRegistrator.register()
  ownsDOM = true
  for (const key of new Set([...before.keys(), ...Reflect.ownKeys(globalThis)])) {
    if (!sameDescriptor(before.get(key), Object.getOwnPropertyDescriptor(globalThis, key))) ownedGlobals.set(key, before.get(key))
  }
})

afterEach(() => { if (ownsDOM) document.body.replaceChildren() })

afterAll(async () => {
  const failures: unknown[] = []
  try {
    if (ownsDOM) await GlobalRegistrator.unregister()
  } catch (error) {
    failures.push(error)
  } finally {
    // The registrator restores string descriptors; include its added symbols too.
    for (const [key, descriptor] of ownedGlobals) {
      try {
        if (descriptor === undefined) {
          if (!Reflect.deleteProperty(globalThis, key)) throw new Error(`Could not remove owned DOM global ${String(key)}`)
        } else Object.defineProperty(globalThis, key, descriptor)
      } catch (error) {
        failures.push(error)
      }
      try {
        expect(sameDescriptor(Object.getOwnPropertyDescriptor(globalThis, key), descriptor)).toBe(true)
      } catch (error) {
        failures.push(new Error(`Owned DOM global was not restored: ${String(key)}`, { cause: error }))
      }
    }
    ownsDOM = false
  }
  if (failures.length > 0) throw new AggregateError(failures, "Owned DOM cleanup failed")
})

const evaluate = (init: KeyboardEventInit = {}, target: EventTarget | null = null): boolean => {
  const event = new KeyboardEvent("keydown", { key: "m", bubbles: true, cancelable: true, ...init })
  if (target === null) {
    expect(event.target).toBeNull()
    return modeShortcut(event)
  }
  let result: boolean | undefined
  const inspect = (received: Event) => {
    expect(received).toBe(event)
    expect(received.target).toBe(target)
    result = modeShortcut(event)
  }
  target.addEventListener("keydown", inspect, { once: true })
  try { target.dispatchEvent(event) } finally { target.removeEventListener("keydown", inspect) }
  if (result === undefined) throw new Error("Keyboard event did not reach its target")
  return result
}

describe("modeShortcut predicate", () => {
  test.each([
    { key: "m", expected: true },
    { key: "M", expected: true },
    { key: "w", expected: false },
    { key: "d", expected: false },
    { key: "", expected: false },
    { key: "mm", expected: false },
    { key: "ｍ", expected: false }
  ])("key '$key' returns $expected", ({ key, expected }) => {
    expect(evaluate({ key })).toBe(expected)
  })

  test("the old direct dictation chord is rejected", () => {
    expect(evaluate({ key: "d", metaKey: true })).toBe(false)
  })

  test.each([
    { label: "repeat", init: { repeat: true } },
    { label: "composition", init: { isComposing: true } },
    { label: "Meta", init: { metaKey: true } },
    { label: "Control", init: { ctrlKey: true } },
    { label: "Alt", init: { altKey: true } },
    { label: "Shift", init: { shiftKey: true } },
    { label: "combined modifiers", init: { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true } },
    { label: "repeat during composition", init: { repeat: true, isComposing: true } }
  ])("rejects $label for either M spelling", ({ init }) => {
    expect(evaluate({ key: "m", ...init })).toBe(false)
    expect(evaluate({ key: "M", ...init })).toBe(false)
  })

  test.each([
    { label: "text input", html: '<input data-target type="text">', expected: false },
    { label: "checkbox input", html: '<input data-target type="checkbox">', expected: false },
    { label: "textarea", html: '<textarea data-target></textarea>', expected: false },
    { label: "select", html: '<select data-target><option>One</option></select>', expected: false },
    { label: "select descendant", html: '<select><option data-target>One</option></select>', expected: false },
    { label: "empty contenteditable", html: '<div data-target contenteditable></div>', expected: false },
    { label: "true contenteditable", html: '<div data-target contenteditable="true"></div>', expected: false },
    { label: "plaintext contenteditable", html: '<div data-target contenteditable="plaintext-only"></div>', expected: false },
    { label: "editable descendant", html: '<div contenteditable="true"><span data-target></span></div>', expected: false },
    { label: "false contenteditable", html: '<div data-target contenteditable="false"></div>', expected: true },
    { label: "noneditable descendant", html: '<div contenteditable="false"><span data-target></span></div>', expected: true },
    { label: "ordinary button", html: '<button data-target type="button">Mode</button>', expected: true },
    { label: "button descendant", html: '<button type="button"><span data-target>Mode</span></button>', expected: true },
    { label: "noneditable neighbor", html: '<textarea></textarea><button data-target type="button">Mode</button>', expected: true }
  ])("$label returns $expected with its natural event target", ({ html, expected }) => {
    document.body.innerHTML = html
    const target = document.querySelector("[data-target]")
    if (!target) throw new Error("Missing keyboard target")
    expect(evaluate({}, target)).toBe(expected)
  })

  test("document targets allow bare M without an Element.closest method", () => {
    expect(evaluate({}, document)).toBe(true)
  })
})
