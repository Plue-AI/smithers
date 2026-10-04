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

/** Call before accepting keyboard evidence, even if a helper caught an input error. */
export function assertKeyboardOnly(log: readonly KeyboardInput[]): void {
  if (log.some(input => input.result === "refused")) throw new Error("C-UI-01 refused input remains in the guard log")
  if (!log.some(input => input.result === "allowed")) throw new Error("C-UI-01 no app keyboard input was observed")
}
