import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { themeRegistry, DEFAULT_THEME_KEY } from "@smthrs/ui"
import { rgbOf, variant } from "../styles/paletteTokens"
import { scopedControllers } from "./ControllerTestScope"
import { DEFAULT_PALETTE, HISTORICAL_PALETTES } from "./AppState"
import { createAppStore } from "./AppStore"
import { memoryStorage, unavailableAgent } from "./TestFixtures"

const createAppController = scopedControllers()

GlobalRegistrator.register()

/*
 * bun test shares one process across test files, so the DOM globals registered
 * above would otherwise leak into every file that runs after this one and
 * silently flip `typeof window`/`typeof document` branches (AppStore's theme
 * detection reads both). Registration is confined to this file's run.
 */
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const tokens = readFileSync(fileURLToPath(new URL("../styles/tokens.css", import.meta.url)), "utf8")
/** Comments carry braces and selector-looking text, so the block scan reads the code alone. */
const code = tokens.replace(/\/\*[\s\S]*?\*\//g, "")

/** The semantic values a palette owns: everything else in tokens.css derives from these. */
const SEMANTIC_TOKENS = [
  "--bg",
  "--text",
  "--text-muted",
  "--text-faint",
  "--text-placeholder",
  "--surface",
  "--surface-2",
  "--surface-3",
  "--surface-glass",
  "--surface-glass-strong",
  "--border",
  "--border-strong",
  "--border-solid",
  "--hover",
  "--hover-subtle",
  "--inverse-bg",
  "--inverse-text",
  "--brand",
  "--success",
  "--warning",
  "--danger",
  "--info",
  "--code-bg",
  "--code-text",
  "--inline-code-bg",
  "--shadow-rgb"
] as const

/** The declarations inside the first block whose selector matches exactly. */
const blockFor = (selector: string): string | undefined => {
  for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").trim() === selector) return match[2] ?? ""
  }
  return undefined
}

const declares = (body: string, token: string): boolean => new RegExp(`(^|\\s)${token}\\s*:`, "m").test(body)

describe("the retained Paper palette", () => {
  test("custom flow widgets and app share Paper semantic colors in both modes", () => {
    expect(DEFAULT_THEME_KEY).toBe("paper")
    expect(Object.keys(themeRegistry)).toEqual(["paper"])
    for (const mode of ["light", "dark"] as const) {
      const app = variant("paper", mode)
      const widget = themeRegistry.paper[mode]
      for (const [token, field] of [["--bg", "bg"], ["--surface", "surface"], ["--text", "text"], ["--brand", "brand"], ["--text-muted", "textMuted"], ["--text-faint", "textFaint"], ["--text-placeholder", "textPlaceholder"]] as const) {
        const { r, g, b } = rgbOf(app, token)
        const channels = widget[field].slice(1).match(/../g)!.map(hex => Number.parseInt(hex, 16))
        expect([r, g, b]).toEqual(channels)
      }
    }
  })

  test("fresh sessions use Paper with independently selectable light/dark", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableAgent)
    expect(store.session().palette).toBe(DEFAULT_PALETTE)
    expect(document.documentElement.dataset.palette).toBe("paper")
    expect(controller.commands.find("appearance.theme")).toBeUndefined()
    expect(controller.commands.find("plugins")).toBeUndefined()
    expect(controller.commands.find("agent.explain")).toBeUndefined()
    for (const mode of ["light", "dark"] as const) {
      expect((await controller.commands.run("appearance.dark-mode", mode)).status).toBe("executed")
      expect(store.session().theme).toBe(mode)
      expect(document.documentElement.dataset.theme).toBe(mode)
      expect(store.session().palette).toBe("paper")
    }
    for (const name of ["wiki", "history.show", "browser.open", "code.hover", "chat.send"]) {
      expect(controller.commands.find(name)).toBeDefined()
    }
  })

  test.each(HISTORICAL_PALETTES.map(palette => [palette] as const))("normalizes saved %s without rewriting its events or unrelated data", async palette => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    await first.dispatch({ type: "palette.changed", actor: "user", palette }).isPersisted.promise
    await first.dispatch({ type: "plugin.installed", actor: "user", plugin: "local-custom-plugin" }).isPersisted.promise
    await first.dispatch({ type: "message.appended", actor: "user", text: "Keep this conversation" }).isPersisted.promise
    await first.dispatch({ type: "surface.changed", actor: "user", surface: "plugins" }).isPersisted.promise
    const old = await first.eventHistory()
    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().palette).toBe("paper")
    expect(second.session().surface).toBe("chat")
    expect(second.session().plugins).toContain("local-custom-plugin")
    expect([...second.collections.messages.values()].map(row => row.text)).toContain("Keep this conversation")
    const recovered = await second.eventHistory()
    const ordered = [...recovered.events].sort((a, b) => a.sequence - b.sequence)
    const earlier = [...old.events].sort((a, b) => a.sequence - b.sequence)
    expect(recovered.head.streamId).toBe(old.head.streamId)
    expect(ordered.slice(0, earlier.length)).toEqual(earlier)
    expect(ordered.slice(earlier.length).map(row => [row.type, row.actor])).toEqual([
      ...(palette === "paper" ? [] : [["palette.changed", "system"]]), ["surface.changed", "system"]
    ])
    expect((await second.verifyState()).valid).toBe(true)
    const third = await createAppStore({ kind: "localStorage", storage })
    const reopened = await third.eventHistory()
    expect(reopened.head).toEqual(recovered.head)
    expect(reopened.checkpoint).toEqual(recovered.checkpoint)
    expect([...reopened.events].sort((a, b) => a.sequence - b.sequence)).toEqual(ordered)
    expect((await third.verifyState()).valid).toBe(true)
  })

  test("both variants declare every semantic token and share one geometry/bridge", () => {
    for (const selector of [":root", ':root[data-theme="dark"]']) {
      const block = blockFor(selector)
      expect(block).toBeDefined()
      expect(SEMANTIC_TOKENS.filter(token => !declares(block ?? "", token))).toEqual([])
    }
    expect(code).not.toContain("data-palette")
    expect(tokens.split("--brand-soft:").length - 1).toBe(1)
    expect(tokens.split("--sp-4:").length - 1).toBe(1)
  })
})
