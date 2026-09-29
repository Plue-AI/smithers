import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import { BOOTSTRAP_SENTENCES, createStartupErrorElement, StartupErrorPanel, webBackendSwitch } from "./StartupError"
import { presentStartupFailure, STARTUP_UNKNOWN_FAILURE, StartupTimedOut } from "./StartupFailure"
import { PRIVACY_RETIREMENT_COPY } from "./chain/PrivacyRetirementCopy"
import {
  PrivacyAuthorityMissing, PrivacyCleanupPending, PrivacyConflictingErasureProof, PrivacyKeyNotRemoved,
  PrivacyMarkerMismatch, PrivacyMarkerUnreadable, PrivacyStorageUnavailable, type PrivacyRetirementError
} from "./chain/PrivacyRetirement"
import { RECOVERY_DOWNLOAD_LABEL, RECOVERY_RESET_LABEL } from "./state/StorageRecoveryContract"

import { StorageWriteFailedError, WriterHeldByAnotherTabError, WriterMovedToAnotherTabError } from "./state/StorageRecoveryContract"
import { BootstrapFailure } from "./runtime/Runtime"
import { PALETTES } from "./state/AppState"
import { contrastRatio, rgbOf, variant, type Declarations, type Rgb } from "./styles/paletteTokens"

GlobalRegistrator.register()
const roots = new Set<Root>()

afterAll(async () => {
  // React's scheduler finishes a commit in a task of its own; unregistering the
  // DOM before it runs takes `window` away mid-flight.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  flushSync(() => {
    for (const root of roots) root.unmount()
  })
  roots.clear()
  document.body.textContent = ""
})

/** Every declaration an element carries, keyed by property so order cannot matter. */
const declarations = (element: HTMLElement): Record<string, string> => {
  const style = element.style
  const entries: Array<readonly [string, string]> = []
  for (let index = 0; index < style.length; index += 1) {
    const property = style.item(index)
    entries.push([property, style.getPropertyValue(property)])
  }
  return Object.fromEntries(entries)
}

const detailOf = (panel: HTMLElement): HTMLElement => {
  const detail = panel.querySelector("pre")
  if (detail === null) throw new Error("the panel rendered no <pre>")
  return detail
}

const renderReactPanel = (reason: unknown): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(<StartupErrorPanel reason={reason} />))
  const panel = host.querySelector("main")
  if (panel === null) throw new Error("the React panel rendered no <main>")
  return panel
}

/** What the panel shows before anyone opens Details. */
const visibleText = (panel: HTMLElement): string => {
  const copy = panel.cloneNode(true) as HTMLElement
  for (const detail of copy.querySelectorAll("pre")) detail.remove()
  return copy.textContent ?? ""
}

const buttonsOf = (panel: HTMLElement): Array<string | null> =>
  [...panel.querySelectorAll("button")].map(button => button.textContent)

/** Both paths for one reason; the caller disposes the DOM panel. */
const bothPanels = (reason: unknown) => {
  const fallback = createStartupErrorElement(document, presentStartupFailure(reason))
  document.body.append(fallback.element)
  return { fallback, panels: [fallback.element, renderReactPanel(reason)] }
}

describe("the startup error panel", () => {
  /*
   * The defect this pins: the DOM builder carried its own cssText copy of the
   * React panel's inline styles, so a cosmetic edit to one representation left
   * the other behind. React now mounts the DOM builder, and this keeps it so.
   */
  test("styles the panel and its detail identically from React and from the DOM builder", async () => {
    const { fallback, panels: [dom, react] } = bothPanels(new Error("create app store: opfs unavailable"))
    try {
      const panelStyle = declarations(dom!)
      const detailStyle = declarations(detailOf(dom!))
      // Guards the comparisons below against passing on two empty declaration sets.
      expect(panelStyle["max-width"]).toBe("44rem")
      expect(detailStyle["white-space"]).toBe("pre-wrap")
      expect(panelStyle).toEqual(declarations(react!))
      expect(detailStyle).toEqual(declarations(detailOf(react!)))
    } finally {
      await fallback.dispose()
    }
  })

  /*
   * The defect this pins: smithers.sh showed "Error: prepare runtime and
   * persisted state: Local privacy cleanup is incomplete. Reload to retry..."
   * as the whole panel. Raw text now sits only behind a closed Details.
   */
  test("an unknown error shows one sentence and its doors, never its message", async () => {
    const reason = new Error("prepare runtime and persisted state: SECRET internal jargon")
    const { fallback, panels } = bothPanels(reason)
    try {
      for (const panel of panels) {
        expect(panel.querySelector("h1")?.textContent).toBe(STARTUP_UNKNOWN_FAILURE.sentence)
        expect(visibleText(panel)).not.toContain("SECRET")
        expect(visibleText(panel)).not.toContain("Reload to")
        expect(buttonsOf(panel)).toEqual(["Retry", RECOVERY_DOWNLOAD_LABEL, RECOVERY_RESET_LABEL])
        expect(panel.querySelector("details")?.open).toBe(false)
        expect(panel.querySelector("summary")?.textContent).toBe("Details")
        expect(detailOf(panel).textContent).toContain("SECRET internal jargon")
        expect(panel.dataset.fault).toBe("bug")
        expect(panel.dataset.failure).toBeUndefined()
      }
    } finally {
      await fallback.dispose()
    }
  })

  test("every action is a native button, and Details opens from the keyboard", async () => {
    const { fallback, panels } = bothPanels(new StartupTimedOut(1))
    try {
      for (const panel of panels) {
        for (const button of panel.querySelectorAll("button")) expect(button.type).toBe("button")
        const summary = panel.querySelector("summary")!
        summary.focus()
        summary.click()
        expect(panel.querySelector("details")?.open).toBe(true)
      }
    } finally {
      await fallback.dispose()
    }
  })

  test("a watchdog timeout blames infra and keeps both doors", async () => {
    const { fallback, panels } = bothPanels(new StartupTimedOut(60_000))
    try {
      for (const panel of panels) {
        expect(panel.querySelector("h1")?.textContent).toBe("Smithers is taking too long to start. Not your fault.")
        expect(panel.dataset.fault).toBe("infra")
        expect(buttonsOf(panel)).toEqual(["Retry", RECOVERY_DOWNLOAD_LABEL, RECOVERY_RESET_LABEL])
      }
    } finally {
      await fallback.dispose()
    }
  })
})

const PRIVACY_VARIANTS: ReadonlyArray<PrivacyRetirementError> = [
  new PrivacyMarkerUnreadable(), new PrivacyCleanupPending(), new PrivacyConflictingErasureProof(), new PrivacyKeyNotRemoved(),
  new PrivacyStorageUnavailable(), new PrivacyMarkerMismatch(), new PrivacyAuthorityMissing()
]

describe("privacy cleanup failures", () => {
  test("the variant list covers every registered tag", () => {
    expect(PRIVACY_VARIANTS.map((variant): string => variant._tag).sort()).toEqual(Object.keys(PRIVACY_RETIREMENT_COPY).sort())
  })

  for (const variant of PRIVACY_VARIANTS) {
    test(`${variant._tag} shows its own sentence and doors, even under the boot step's wrapper`, async () => {
      const copy = PRIVACY_RETIREMENT_COPY[variant._tag]
      const expected = typeof copy === "function" ? copy(variant as never) : copy
      const wrapped = new Error(`prepare runtime and persisted state: ${variant.message}`, { cause: variant })
      for (const reason of [variant, wrapped]) {
        const { fallback, panels } = bothPanels(reason)
        try {
          for (const panel of panels) {
            expect(panel.querySelector("h1")?.textContent).toBe(expected.sentence)
            expect(panel.dataset.failure).toBe(variant._tag)
            expect(panel.dataset.fault).not.toBe("user")
            expect(visibleText(panel)).not.toContain("cleanup is incomplete")
            expect(visibleText(panel)).not.toContain("Reload to retry")
            expect(buttonsOf(panel)).toEqual(expected.actions.map(action => action === "retry" ? "Retry" : RECOVERY_RESET_LABEL))
            expect(buttonsOf(panel)).not.toContain(RECOVERY_DOWNLOAD_LABEL)
          }
        } finally {
          await fallback.dispose()
        }
      }
    })
  }
})

for (const [reason, heading, buttons] of [
  [new StorageWriteFailedError(), "Changes could not be saved", ["Reload"]],
  [new WriterHeldByAnotherTabError(), "Smithers is open in another tab", ["Use Smithers here", "Reload"]],
  [new WriterMovedToAnotherTabError(), "Smithers moved to another tab", ["Use Smithers here"]]
] as const) {
  test(heading, () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.add(root)
    flushSync(() => root.render(<StartupErrorPanel reason={reason} />))
    expect(host.querySelector("h1")?.textContent).toBe(heading)
    expect([...host.querySelectorAll("button")].map(button => button.textContent)).toEqual([...buttons])
    expect(host.querySelector("pre")).toBeNull()
    expect(host.textContent).not.toContain("recovery")
    expect(host.textContent).not.toContain("Reset")
  })
}

const renderBootstrapFailure = (kind: "unreachable" | "missing" | "server" | "invalid"): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(<StartupErrorPanel reason={new BootstrapFailure(kind, 404)} />))
  return host
}

const buttonLabels = (host: HTMLElement): Array<string | null> =>
  [...host.querySelectorAll("button")].map(button => button.textContent)

for (const kind of ["unreachable", "missing", "server", "invalid"] as const) {
  /*
   * The defect this pins: every hosted user saw a developer "Switch backend"
   * form during an outage, and nothing said the outage was not theirs.
   */
  test(`bootstrap ${kind} on the hosted web offers Retry and blames the backend`, () => {
    const host = renderBootstrapFailure(kind)
    expect(host.querySelector("h1")?.textContent).toBe("Backend unavailable")
    expect(host.textContent).not.toContain("404")
    expect(host.textContent).toContain("Not your fault.")
    expect(host.querySelector<HTMLElement>("[data-failure]")?.dataset.failure).toBe(`BootstrapFailure:${kind}`)
    expect(host.querySelector("[data-failure] p")?.textContent).toBe(BOOTSTRAP_SENTENCES[kind])
    expect(host.textContent).not.toContain("Backend is unreachable")
    expect(host.textContent).not.toContain("bootstrap")
    expect(buttonLabels(host)).toEqual(["Retry"])
    expect(host.querySelector("form")).toBeNull()
  })

  test(`bootstrap ${kind} in the native shell keeps backend switching`, () => {
    window.__electrobun = {} as NonNullable<typeof window.__electrobun>
    try {
      const host = renderBootstrapFailure(kind)
      expect(host.textContent).toContain("Not your fault.")
      expect(buttonLabels(host)).toEqual(["Retry", "Switch backend"])
      flushSync(() => host.querySelector<HTMLButtonElement>("button:last-of-type")!.click())
      expect(host.querySelector('input[name="origin"]')).not.toBeNull()
      expect(host.querySelector('input[name="token"]')).not.toBeNull()
    } finally {
      delete window.__electrobun
    }
  })
}

/*
 * The defect this pins: any throw rendered "Invalid backend URL." and the
 * alert never cleared; later, each input's raw exception text reached the
 * panel. A bad origin now reads as the person's to fix, anything else as
 * ours with the raw text behind Details, and each submit shows only its own.
 */
test("a failed backend switch presents its typed cause, fresh on every submit", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  const switchBackend = async (origin: string, token: string) => {
    if (origin === "https://down.example") throw new Error("socket closed by native bridge")
    await webBackendSwitch(origin, token)
  }
  flushSync(() => root.render(
    <StartupErrorPanel reason={new BootstrapFailure("unreachable")} switchBackend={switchBackend} />
  ))
  flushSync(() => host.querySelector<HTMLButtonElement>("button:last-of-type")!.click())
  const alert = () => host.querySelector<HTMLElement>('form [role="alert"]')
  const submit = async (origin: string, token: string): Promise<HTMLElement | null> => {
    host.querySelector<HTMLInputElement>('input[name="origin"]')!.value = origin
    host.querySelector<HTMLInputElement>('input[name="token"]')!.value = token
    flushSync(() => host.querySelector("form")!.requestSubmit())
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let turn = 0; turn < 50 && alert() === null; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    return alert()
  }
  for (const [origin, token] of [["https://backend.example/path", ""], ["ftp://backend.example", "secret"], ["not a url", ""]] as const) {
    const shown = await submit(origin, token)
    expect(shown?.dataset.failure).toBe("BackendOriginInvalid")
    expect(shown?.dataset.fault).toBe("user")
    expect(shown?.querySelector("p")?.textContent).toBe("Enter an http or https origin, like https://backend.example.")
  }
  const down = await submit("https://down.example", "")
  expect(down?.dataset.failure).toBeUndefined()
  expect(down?.dataset.fault).toBe("infra")
  expect(down?.querySelector("p")?.textContent).toBe("Smithers could not switch to that backend. Not your fault.")
  expect(down?.querySelector("details")?.open).toBe(false)
  expect(down?.querySelector("details pre")?.textContent).toContain("socket closed by native bridge")
  expect(host.querySelectorAll('form [role="alert"]')).toHaveLength(1)
  expect(host.textContent).not.toContain("Invalid backend URL")
})

/*
 * Every startup panel is legible in every theme the page can be in.
 *
 * The defect this pins: the panel painted `#1a1a1a` text and no background,
 * so in dark theme it sat on the page's `--bg` (#011627 in night-owl) at
 * 1.1:1 and "Smithers is open in another tab" was invisible. The pairs are
 * resolved from the panel's real declarations against tokens.css, and also
 * with no stylesheet at all, because the DOM path runs when the bundle (and
 * the CSS it imports) never loaded.
 */
describe("the startup panels are legible in every theme", () => {
  /** A theme is a palette and mode from tokens.css, or no stylesheet (the UA's white page). */
  const THEMES: ReadonlyArray<{ readonly name: string; readonly tokens: Declarations | undefined }> = [
    { name: "no stylesheet", tokens: undefined },
    ...PALETTES.flatMap((palette) =>
      (["light", "dark"] as const).map((mode) => ({ name: `${palette} ${mode}`, tokens: variant(palette, mode) }))
    )
  ]

  const hex = (value: string): Rgb => {
    const match = /^#([0-9a-f]{6})$/i.exec(value.trim())
    if (match === null) throw new Error(`not a colour this check can read: ${value}`)
    const number = Number.parseInt(match[1] ?? "", 16)
    return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 }
  }

  /** What a declared value paints: a token when the sheet is loaded, its fallback when not. */
  const paint = (value: string, tokens: Declarations | undefined): Rgb => {
    const reference = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/i.exec(value.trim())
    if (reference === null) return hex(value)
    if (tokens !== undefined) return rgbOf(tokens, reference[1] ?? "")
    if (reference[2] === undefined) throw new Error(`${value} paints nothing without the stylesheet`)
    return hex(reference[2])
  }

  /** An empty declaration paints nothing and inherits, or shows what is behind it. */
  const painted = (value: string, tokens: Declarations | undefined): Rgb | undefined =>
    value === "" ? undefined : paint(value, tokens)

  /** An unpainted panel shows the page behind it: body's `--bg`, or the UA's white. */
  const page = (tokens: Declarations | undefined): Rgb =>
    tokens === undefined ? { r: 255, g: 255, b: 255 } : rgbOf(tokens, "--bg")

  const renderPanel = (reason: unknown): HTMLElement => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.add(root)
    flushSync(() => root.render(<StartupErrorPanel reason={reason} />))
    const panel = host.querySelector("main")
    if (panel === null) throw new Error("the React panel rendered no <main>")
    return panel
  }

  test("every panel's text and detail clear 4.5:1 in all themes, on both paths", async () => {
    const fallback = createStartupErrorElement(document, presentStartupFailure(new Error("boot rejected")))
    try {
      const panels = [
        { name: "DOM failed to start", element: fallback.element },
        { name: "failed to start", element: renderPanel(new Error("boot rejected")) },
        { name: "open in another tab", element: renderPanel(new WriterHeldByAnotherTabError()) },
        { name: "moved to another tab", element: renderPanel(new WriterMovedToAnotherTabError()) },
        { name: "backend unavailable", element: renderPanel(new BootstrapFailure("unreachable", 0)) }
      ]
      const failures: Array<string> = []
      let checked = 0
      for (const theme of THEMES) {
        for (const panel of panels) {
          const text = paint(panel.element.style.color, theme.tokens)
          const ground = painted(panel.element.style.background, theme.tokens) ?? page(theme.tokens)
          const pairs = [{ where: "panel", text, ground }]
          const detail = panel.element.querySelector("pre")
          if (detail !== null) {
            pairs.push({
              where: "detail",
              text: painted(detail.style.color, theme.tokens) ?? text,
              ground: painted(detail.style.background, theme.tokens) ?? ground
            })
          }
          for (const pair of pairs) {
            checked += 1
            const ratio = contrastRatio(pair.text, pair.ground)
            if (ratio < 4.5) failures.push(`${theme.name}: ${panel.name} ${pair.where} is ${ratio}:1`)
          }
        }
      }
      // 19 themes x (5 panels + 2 details): guards against passing on an empty sweep.
      expect(checked).toBe(THEMES.length * 7)
      expect(failures).toEqual([])
    } finally {
      await fallback.dispose()
    }
  })
})
