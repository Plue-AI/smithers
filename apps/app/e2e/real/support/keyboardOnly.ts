import { randomUUID } from "node:crypto"
import type { BrowserContext, Page } from "@playwright/test"

export type KeyboardInput = {
  readonly at: string
  readonly method: string
  readonly origin: string
  readonly result: "allowed" | "excluded" | "refused"
}

const forbidden = new Set([
  "click", "dblclick", "hover", "tap", "dragTo", "check", "uncheck", "setChecked", "fill", "selectOption",
  // These bypass physical keyboard traversal just as fill does.
  "focus", "dispatchEvent", "setInputFiles"
])
const keyboard = new Set(["press", "pressSequentially", "type", "down", "up", "insertText"])
const factories = new Set([
  "locator", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTestId", "getByTitle", "getByAltText",
  "first", "last", "nth", "filter", "and", "or", "frameLocator", "contentFrame", "owner", "page", "context",
  "newPage", "pages", "frames", "mainFrame", "frame", "$", "$$", "waitForSelector", "elementHandle", "elementHandles", "all"
])

/**
 * Guard the existing real context in place, including popups and chained locators.
 * Install before creating locators or handles. No input text, selectors, arguments,
 * URLs with query strings, cookies or token bytes enter the evidence log.
 * Existing browser-keyboard tests use setContent and cannot serve this release check.
 */
export function installKeyboardOnly(context: BrowserContext, origin: string, log: KeyboardInput[]): void {
  const target = new URL(origin)
  if (!/^https?:$/.test(target.protocol) || target.origin !== origin) throw new Error("Keyboard guard requires an HTTP(S) origin")
  const seen = new WeakSet<object>()
  const patch = (value: unknown, pageOrigin: () => string, device?: "mouse" | "touchscreen" | "keyboard"): void => {
    if (Array.isArray(value)) { for (const child of value) patch(child, pageOrigin); return }
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    const object = value as Record<string, unknown>
    const currentOrigin = typeof object.url === "function"
      ? () => { try { return new URL(Reflect.apply(object.url as Function, value, [])).origin } catch { return "unopened" } }
      : pageOrigin
    for (const name of new Set([...forbidden, ...keyboard, ...factories, ...(device === "mouse" ? ["move", "wheel"] : [])])) {
      const original = object[name]
      if (typeof original !== "function") continue
      object[name] = (...args: unknown[]) => {
        const input = forbidden.has(name) || keyboard.has(name) || device === "mouse" || device === "touchscreen"
        if (input) {
          const observed = currentOrigin()
          // GitHub App/OAuth pages are the check's only browser exclusions.
          // Unknown origins and unopened pages fail closed, rather than quietly escaping the guard.
          const excluded = observed === "https://github.com"
          const blocked = forbidden.has(name) || device === "mouse" || device === "touchscreen" || name === "insertText"
          const result = excluded ? "excluded" : observed !== target.origin || blocked ? "refused" : "allowed"
          log.push({ at: new Date().toISOString(), method: `${device ?? "surface"}.${name}`, origin: observed, result })
          if (result === "refused") throw new Error(`C-UI-01 keyboard guard refused ${device ?? "surface"}.${name} at ${observed}`)
        }
        const result: unknown = Reflect.apply(original, value, args)
        if (!factories.has(name)) return result
        if (result instanceof Promise) return result.then(child => { patch(child, currentOrigin); return child })
        patch(result, currentOrigin)
        return result
      }
    }
    for (const kind of ["keyboard", "mouse", "touchscreen"] as const) patch(object[kind], currentOrigin, kind)
  }
  const watchPage = (page: Page) => {
    patch(page, () => "unopened")
  }
  patch(context, () => "unopened")
  for (const page of context.pages()) watchPage(page)
  context.on("page", watchPage)
}

/** Observe an independent headed operator as well as automation. No key,
 * coordinate, field value or query parameter enters the input log. */
export async function installNativeKeyboardOnly(context: BrowserContext, origin: string, log: KeyboardInput[]): Promise<void> {
  const target = new URL(origin)
  if (!/^https?:$/.test(target.protocol) || target.origin !== origin) throw new Error("Keyboard guard requires an HTTP(S) origin")
  const name = `__cui_${randomUUID().replaceAll("-", "")}`
  const kinds = new Set(["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "dblclick", "click"])
  await context.exposeBinding(name, (source, input: { kind?: unknown }) => {
    const kind = typeof input?.kind === "string" && kinds.has(input.kind) ? input.kind : "invalid"
    let observed = "unopened"
    try { observed = new URL(source.frame.url()).origin } catch { /* refuse unknown pages */ }
    const result = kind === "invalid" ? "refused" : observed === "https://github.com" ? "excluded"
      : observed === target.origin && kind === "keydown" ? "allowed" : "refused"
    log.push({ at: new Date().toISOString(), method: `dom.${kind}`, origin: observed, result })
  })
  const attach = ({ binding, expected }: { binding: string; expected: string }) => {
    const send = (window as unknown as Record<string, (input: { kind: string }) => Promise<void>>)[binding]!
    const listen = (event: Event) => {
      // Enter/Space generate a zero-detail click. That is a keyboard activation.
      if (event.type === "click" && (event as MouseEvent).detail === 0) return
      const excluded = location.origin === "https://github.com"
      if (!excluded && (location.origin !== expected || event.type !== "keydown")) {
        event.preventDefault(); event.stopImmediatePropagation()
      }
      void send({ kind: event.type }).catch(() => {})
    }
    for (const kind of ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "dblclick", "click"]) {
      window.addEventListener(kind, listen, { capture: true, passive: false })
    }
  }
  const args = { binding: name, expected: origin }
  await context.addInitScript(attach, args)
  // Helpers can also attach to a page that has already reached the install.
  for (const page of context.pages()) for (const frame of page.frames()) await frame.evaluate(attach, args)
}

/** Call before accepting keyboard evidence, even if a helper caught an input error. */
export function assertKeyboardOnly(log: readonly KeyboardInput[]): void {
  if (log.some(input => input.result === "refused")) throw new Error("C-UI-01 refused input remains in the guard log")
  if (!log.some(input => input.result === "allowed")) throw new Error("C-UI-01 no app keyboard input was observed")
}

export type KeyboardFocus = {
  readonly at: string
  readonly element: string
  readonly focusVisible: boolean
  readonly outlineStyle: string
  readonly outlineWidth: number
  readonly ringMatches: boolean
}

/** Read after an action AND after its asynchronous card/live update settles.
 * Deliberately retains no text, labels, field values or URL query parameters.
 * This observation alone never proves completion of a release journey.
 */
export async function recordKeyboardFocus(page: Page, log: KeyboardFocus[]): Promise<void> {
  const observation = await page.evaluate(() => {
    let active = document.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    const style = active ? getComputedStyle(active) : undefined
    const ring = style?.getPropertyValue("--ring-border").trim()
    const probe = document.createElement("span")
    probe.style.outlineColor = ring || "transparent"
    probe.hidden = true
    document.body.append(probe)
    const expected = getComputedStyle(probe).outlineColor
    probe.remove()
    return {
      at: new Date().toISOString(),
      element: active?.tagName.toLowerCase() ?? "none",
      focusVisible: active?.matches(":focus-visible") ?? false,
      outlineStyle: style?.outlineStyle ?? "none",
      outlineWidth: Number.parseFloat(style?.outlineWidth ?? "0"),
      ringMatches: Boolean(ring && style?.outlineColor === expected)
    }
  })
  log.push(observation)
  assertKeyboardFocus([observation])
}

/** Caught failures must remain failures when the evidence is finalized. */
export function assertKeyboardFocus(log: readonly KeyboardFocus[]): void {
  if (!log.length) throw new Error("C-UI-01 no focus observations were recorded")
  if (log.some(observation =>
    ["body", "html", "none"].includes(observation.element) || !observation.focusVisible ||
    observation.outlineStyle === "none" || observation.outlineStyle === "hidden" ||
    !(observation.outlineWidth > 0) || !observation.ringMatches)) {
    throw new Error("C-UI-01 focus is missing or does not show the --ring-border outline")
  }
}
