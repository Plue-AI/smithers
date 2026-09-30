import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import { ControllerTestProvider } from "../ControllerContext"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { Card } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { contentKey, FileCardAddressLine, FileCardBody, FileListCardBody, followMarkdownLink, isMarkdownPath } from "./FileCards"

/*
 * The file card's two renderings (will, 2026-09-01): a markdown file goes
 * through the shared WYSIWYG editor boundary, read only; every other text
 * file stays a fenced block. Binary and truncation notes are unchanged.
 */

GlobalRegistrator.register()

/*
 * Every root is unmounted synchronously before the globals leave: a root
 * left mounted keeps React scheduler work queued, and that work reads
 * `window` on a later macrotask — after unregister, it throws into whichever
 * test file bun runs next in the same process (seen: FilesSeam.test.ts
 * failing with "window is not defined" right after this file).
 */
const mounted: Array<{ readonly root: Root; readonly host: HTMLElement; readonly dispose?: () => Promise<void> }> = []

afterEach(async () => {
  for (const { root, host, dispose } of mounted.splice(0)) {
    flushSync(() => root.unmount())
    host.remove()
    await dispose?.()
  }
})

afterAll(async () => {
  const { disposeCodeViewPool } = await import("@smthrs/ui/adapters/code-view")
  disposeCodeViewPool()
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const fileCard = (path: string, content: string, extra: Partial<Extract<Card, { kind: "file" }>["payload"]> = {}): Extract<Card, { kind: "file" }> => ({
  id: `file-smithersai/smithers-${path}`,
  kind: "file",
  title: `File · smithersai/smithers · ${path}`,
  status: "active",
  createdAt: 1,
  ordinal: 1,
  payload: { repo: "smithersai/smithers", path, content, truncated: false, ...extra }
})

const render = (card: Extract<Card, { kind: "file" }>): HTMLElement => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  flushSync(() => root.render(<FileCardBody card={card} onRunCommand={() => {}} />))
  return host
}

describe("the file card", () => {
  test("names markdown by extension, case-insensitively", () => {
    for (const path of ["README.md", "docs/guide.MD", "notes.markdown", "page.mdx"]) expect(isMarkdownPath(path)).toBe(true)
    for (const path of ["src/app.ts", "Makefile", "md", "readme.md.bak", "index.html"]) expect(isMarkdownPath(path)).toBe(false)
  })

  test("the editor's reset key follows the content, so a same-length edit reseeds the document", () => {
    expect(contentKey("# Smithers\n")).not.toBe(contentKey("# Smothers\n"))
    expect(contentKey("abc")).toBe(contentKey("abc"))
  })

  test("a markdown file renders through the read-only editor boundary, not a fenced block", async () => {
    const content = "# Smithers\n\nDurable agent workflows.\n"
    // The surface reads the session's input mode, just as it does under the app provider.
    const { host } = await renderOn(NATIVE, fileCard("README.md", content))
    // Wait for the lazy surface: checking only its loading state can hide a failed adapter.
    for (let tick = 0; tick < 200 && host.querySelector('[data-testid="markdown-editor"]') === null; tick += 1) {
      await wait(10)
    }
    const editor = host.querySelector<HTMLTextAreaElement>('textarea[data-testid="markdown-editor"]')
    expect(editor?.value).toBe(content)
    expect(editor?.readOnly).toBe(true)
    expect(host.querySelector("pre") === null).toBe(true)
    const doc = host.querySelector("[data-file-markdown]")
    expect(doc).not.toBeNull()
    expect(host.textContent).toContain("smithersai/smithers · README.md")
  })

  test("a non-markdown file stays a fenced block, and truncation is stated", () => {
    const host = render(fileCard("src/app.ts", "export const x = 1\n", { truncated: true }))
    expect(host.querySelector("pre")?.textContent).toBe("export const x = 1\n")
    expect(host.querySelector("[data-file-markdown]")).toBeNull()
    expect(host.textContent).toContain("Truncated")
  })

  /*
   * Ask 6 (will, 2026-09-02): "when we show a file it should be shown in a
   * panel with a reasonable max height that we can scroll within". The cap
   * itself is the .world-card-panel rule (styles/Layout.test.ts pins it);
   * what this holds is that the file body IS that panel — both renderings.
   */
  test("a file body is the scrolling panel, markdown and fenced alike", async () => {
    const fenced = render(fileCard("src/main.ts", "export {}\n"))
    expect(fenced.querySelector(".world-card-panel")).not.toBeNull()
    expect(fenced.querySelector(".world-card-panel")?.contains(fenced.querySelector("pre"))).toBe(true)

    const { host: markdown } = await renderOn(NATIVE, fileCard("README.md", "# Title\n"))
    const panel = markdown.querySelector(".world-card-panel")
    expect(panel).not.toBeNull()
    expect(panel?.querySelector("[data-file-markdown]")).not.toBeNull()
  })

  test("a binary file is stated, never handed to the editor", () => {
    const host = render(fileCard("logo.md", "", { binary: true }))
    expect(host.querySelector("[data-file-markdown]")).toBeNull()
    expect(host.textContent).toContain("binary")
  })
})

/*
 * Code intelligence L1 (docs/code-intel/PLAN.md §1): a code file renders
 * through the lazy CodeSurface on `@pierre/diffs` `File`. The plain block is
 * the complete first state (the chunk, the grammar and the theme are async);
 * the token view replaces it. A file no grammar claims, and a truncated
 * file, keep the plain block: half a file is not highlighted.
 */
const codeView = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>('[data-slot="code-view"]')

const shadowOf = (host: HTMLElement): ShadowRoot | null => codeView(host)?.querySelector("diffs-container")?.shadowRoot ?? null

/*
 * Poll until the lazy chunk mounted and pierre coloured a token; React settles
 * between macrotasks. The bound is wall-clock, not ticks: a 10 ms timer takes
 * far longer under a loaded machine (2026-09-03: 600 ticks expired at 8.5 s
 * with a load average of 100 while the token arrived later), and a real
 * first tokenize measures 2.6 s idle under bun/JSC.
 */
const HIGHLIGHT_DEADLINE_MS = 30_000
const highlighted = async (host: HTMLElement): Promise<void> => {
  const deadline = Date.now() + HIGHLIGHT_DEADLINE_MS
  while (Date.now() < deadline && shadowOf(host)?.querySelector("[data-line] span[style]") == null) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (shadowOf(host)?.querySelector("[data-line] span[style]") == null) throw new Error("the code view never painted a token")
}

describe("the file card's code view", () => {
  test("a code file shows the plain block first and the token view once the surface and grammar have loaded", async () => {
    const host = render(fileCard("src/app.ts", "export const answer: number = 42\n"))
    /*
     * The plain block is the complete first state whichever boundary owns it
     * at this moment: the Suspense fallback while the chunk loads, the
     * adapter's own block while the grammar loads (packages/smithers/ui pins the cold
     * sequence; here the chunk may already be warm from an earlier card).
     */
    expect(host.querySelector("pre")?.textContent).toBe("export const answer: number = 42\n")
    await highlighted(host)
    const view = codeView(host)
    expect(view?.getAttribute("data-language")).toBe("typescript")
    expect(view?.getAttribute("data-state")).toBe("ready")
    expect((shadowOf(host)?.querySelectorAll("[data-line] span[style]").length ?? 0) > 1).toBe(true)
    // The panel stays the one scroller: the view sits directly inside it, beside the address line.
    expect(view?.closest(".world-card-panel")).not.toBeNull()
    expect(host.textContent).not.toContain("Truncated")
  }, 30_000)

  test("a file no grammar claims keeps the plain block after the surface has loaded", async () => {
    // Warm the lazy boundary first so the second mount renders the real surface synchronously.
    await highlighted(render(fileCard("warm.ts", "let warm = 1\n")))
    const host = render(fileCard("LICENSE", "MIT License\n\nPermission is hereby granted\n"))
    expect(host.querySelector("pre.world-card-path")?.textContent).toBe("MIT License\n\nPermission is hereby granted\n")
    expect(codeView(host)).toBeNull()
  }, 30_000)

  test("a truncated code file is highlighted like any other, and the cut is stated below it", async () => {
    await highlighted(render(fileCard("warm2.ts", "let warm = 2\n")))
    const host = render(fileCard("src/big.ts", "export const cut = 1\n", { truncated: true }))
    await highlighted(host)
    expect(codeView(host)).not.toBeNull()
    expect(host.textContent).toContain("Truncated")
  }, 30_000)

  test("the anchored line rides the panel as data-line and is the selected line in the view", async () => {
    const host = render(fileCard("src/anchor.ts", "const a = 1\nconst b = 2\nconst c = 3\n", { line: 2, column: 7 }))
    expect(host.querySelector(".world-card-panel")?.getAttribute("data-line")).toBe("2")
    await highlighted(host)
    expect(shadowOf(host)?.querySelector('[data-line="2"]')?.hasAttribute("data-selected-line")).toBe(true)
    expect(shadowOf(host)?.querySelectorAll("[data-line][data-selected-line]")).toHaveLength(1)
  }, 30_000)
})


/*
 * Code intelligence L4 (docs/code-intel/PLAN.md §5): the card projects the
 * payload the code-intel seam writes — language word, diagnostics count and
 * rows, the hover answer, the server state — and binds the two pointer
 * gestures to code.hover and code.definition through onRunCommand, the same
 * door every row in this file uses. Nothing here is component state: a
 * payload with the field shows the element, a payload without it shows
 * nothing.
 */
const diagnostic = (line: number, severity: "error" | "warning" | "information" | "hint", message: string) => ({
  line,
  character: 7,
  endLine: line,
  endCharacter: 13,
  severity,
  message,
  source: "ts",
  code: "2551"
})

const renderWith = (card: Extract<Card, { kind: "file" }>): { readonly host: HTMLElement; readonly calls: Array<[string, string | undefined]> } => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  flushSync(() => root.render(<FileCardBody card={card} onRunCommand={(name, args) => calls.push([name, args])} />))
  return { host, calls }
}

const tokenIn = (host: HTMLElement, line: number, text: string): HTMLElement => {
  const span = Array.from(shadowOf(host)?.querySelectorAll<HTMLElement>(`[data-line="${line}"] [data-char]`) ?? []).find((candidate) =>
    candidate.textContent === text
  )
  if (span === undefined) throw new Error(`no token "${text}" on line ${line}`)
  return span
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("the file card's code intelligence", () => {
  test("the header names the language of a code file and says nothing for a file no grammar claims", () => {
    expect(render(fileCard("src/app.ts", "export {}\n")).querySelector('[data-slot="code-language"]')?.textContent).toBe("TypeScript")
    expect(render(fileCard("src/App.tsx", "export {}\n")).querySelector('[data-slot="code-language"]')?.textContent).toBe("TSX")
    expect(render(fileCard("LICENSE", "MIT\n")).querySelector('[data-slot="code-language"]')).toBeNull()
  })

  test("the diagnostics count line exists only once the server answered, and counts errors and warnings", () => {
    expect(render(fileCard("src/app.ts", "export {}\n")).querySelector('[data-slot="code-diagnostics-count"]')).toBeNull()
    expect(render(fileCard("src/app.ts", "export {}\n", { diagnostics: [] })).querySelector('[data-slot="code-diagnostics-count"]')?.textContent).toBe(
      "0 errors · 0 warnings"
    )
    const mixed = render(
      fileCard("src/app.ts", "export {}\n", {
        diagnostics: [diagnostic(1, "error", "e"), diagnostic(1, "warning", "w1"), diagnostic(1, "warning", "w2"), diagnostic(1, "hint", "h")]
      })
    )
    expect(mixed.querySelector('[data-slot="code-diagnostics-count"]')?.textContent).toBe("1 error · 2 warnings")
  })

  test("a publication the host capped counts what the card holds and says how many of the total that is; a complete list says nothing more", () => {
    const fifty = Array.from({ length: 50 }, (_item, index) => diagnostic(index + 1, "error", `e${index}`))
    expect(render(fileCard("src/app.ts", "export {}\n", { diagnostics: fifty, diagnosticsTotal: 132 })).querySelector('[data-slot="code-diagnostics-count"]')?.textContent)
      .toBe("50 errors · 0 warnings · 50 of 132 shown")
    expect(render(fileCard("src/app.ts", "export {}\n", { diagnostics: fifty, diagnosticsTotal: 50 })).querySelector('[data-slot="code-diagnostics-count"]')?.textContent)
      .toBe("50 errors · 0 warnings")
  })

  test("a diagnostic renders under its line with its severity, message and origin", async () => {
    const host = render(
      fileCard("src/app.ts", "const message = 'x'\nconst length = message.lenght\n", {
        diagnostics: [diagnostic(2, "error", "Property 'lenght' does not exist on type 'string'.")]
      })
    )
    await highlighted(host)
    const row = host.querySelector<HTMLElement>('[data-slot="code-diagnostic"]')
    expect(row?.textContent).toContain("Property 'lenght' does not exist on type 'string'.")
    expect(row?.textContent).toContain("(ts 2551)")
    expect(row?.getAttribute("data-severity")).toBe("error")
    expect(row?.closest("[slot]")?.getAttribute("slot")).toBe("annotation-2")
  }, 30_000)

  test("the hover answer renders under its line as markdown; a null or absent hover renders nothing", async () => {
    const host = render(
      fileCard("src/app.ts", "export const answer: number = 42\n", {
        hover: { line: 1, character: 14, contents: "```typescript\nconst answer: number\n```\n" }
      })
    )
    await highlighted(host)
    const box = host.querySelector<HTMLElement>('[data-slot="code-hover"]')
    expect(box?.textContent).toContain("const answer: number")
    expect(box?.textContent).not.toContain("```")
    expect(box?.closest("[slot]")?.getAttribute("slot")).toBe("annotation-1")
    expect(box?.querySelector('[data-slot="code-hover-cut"]')).toBeNull()
    expect(render(fileCard("src/b.ts", "export {}\n", { hover: null })).querySelector('[data-slot="code-hover"]')).toBeNull()
    expect(render(fileCard("src/c.ts", "export {}\n")).querySelector('[data-slot="code-hover"]')).toBeNull()
  }, 30_000)

  test("a hover the host cut at its cap says so in the box instead of ending as if complete", async () => {
    const host = render(
      fileCard("src/app.ts", "export const answer: number = 42\n", {
        hover: { line: 1, character: 14, contents: "```typescript\nconst answer: number\n```\nA very long doc comment", truncated: true }
      })
    )
    await highlighted(host)
    expect(host.querySelector('[data-slot="code-hover-cut"]')?.textContent).toBe("(cut at 4 KiB)")
  }, 30_000)

  test("a ready server's one-line note renders when the seam left one, and nothing when it did not", () => {
    const noted = render(fileCard("src/app.ts", "export {}\n", { intel: { state: "ready", note: "Definition of src/app.ts:1:14: outside the repository (1 location not openable here)" } }))
    expect(noted.querySelector('[data-intel="ready"]')?.textContent).toBe("Definition of src/app.ts:1:14: outside the repository (1 location not openable here)")
    expect(render(fileCard("src/app.ts", "export {}\n", { intel: { state: "ready" } })).querySelector("[data-intel]")).toBeNull()
  })

  test("the server state is stated only when it is not ready: missing with its install line, unavailable with the host's message, starting", () => {
    const missing = render(fileCard("src/app.ts", "export {}\n", { intel: { state: "missing", note: "npm i -g typescript-language-server typescript" } }))
    const note = missing.querySelector('[data-intel="missing"]')
    expect(note?.textContent).toContain("no TypeScript language server on this machine")
    expect(note?.textContent).toContain("Install: npm i -g typescript-language-server typescript")
    expect(render(fileCard("src/app.ts", "export {}\n", { intel: { state: "unavailable", note: "the language server exited" } })).querySelector('[data-intel="unavailable"]')?.textContent)
      .toContain("the language server exited")
    expect(render(fileCard("src/app.ts", "export {}\n", { intel: { state: "starting" } })).querySelector('[data-intel="starting"]')?.textContent)
      .toContain("Starting the TypeScript language server")
    expect(render(fileCard("src/app.ts", "export {}\n", { intel: { state: "ready" } })).querySelector("[data-intel]")).toBeNull()
    expect(render(fileCard("src/app.ts", "export {}\n")).querySelector("[data-intel]")).toBeNull()
  })

  test("a pointer at rest on a token runs code.hover at the token's position; ⌘-click runs code.definition; both are data-flow bindings", async () => {
    const { host, calls } = renderWith(fileCard("src/app.ts", "export const answer: number = 42\n"))
    await highlighted(host)
    const surface = host.querySelector('[data-flow="code.hover"]')
    expect(surface).not.toBeNull()
    expect(surface?.getAttribute("data-flow-activate")).toBe("code.definition")
    // `answer` starts at the 14th character of line 1.
    const answer = tokenIn(host, 1, "answer")
    answer.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }))
    expect(calls).toEqual([])
    await wait(400)
    expect(calls).toEqual([["code.hover", "src/app.ts:1:14 smithersai/smithers"]])
    answer.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, metaKey: true }))
    expect(calls[1]).toEqual(["code.definition", "src/app.ts:1:14 smithersai/smithers"])
    answer.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))
    expect(calls).toHaveLength(2)
  }, 30_000)

  test("one hover in flight: a position already asked, or already answered, is not asked again; a new position is", async () => {
    const card = fileCard("src/app.ts", "export const answer: number = 42\n")
    const { host, calls } = renderWith(card)
    await highlighted(host)
    const answer = tokenIn(host, 1, "answer")
    const rest = async (token: HTMLElement): Promise<void> => {
      token.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }))
      await wait(400)
      token.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, composed: true, pointerType: "mouse" }))
    }
    await rest(answer)
    await rest(answer)
    expect(calls).toEqual([["code.hover", "src/app.ts:1:14 smithersai/smithers"]])
    // The answer lands on the payload: resting there again asks nothing.
    const root = mounted[mounted.length - 1]!.root
    flushSync(() =>
      root.render(
        <FileCardBody
          card={{ ...card, payload: { ...card.payload, hover: { line: 1, character: 14, contents: "const answer: number" } } }}
          onRunCommand={(name, args) => calls.push([name, args])}
        />
      )
    )
    await rest(tokenIn(host, 1, "answer"))
    expect(calls).toHaveLength(1)
    await rest(tokenIn(host, 1, "42"))
    expect(calls[1]).toEqual(["code.hover", "src/app.ts:1:31 smithersai/smithers"])
  }, 30_000)
})

/*
 * THE THREE-DOOR LAW meets the host matrix: the gestures are bindings to
 * code.hover / code.definition, which a host registers only where it can
 * reach a language server — the workspace tunnel, `cloud.terminal`. A card
 * that bound them without it would be a dead control (the pointer path drops
 * an unregistered name silently), so the card reads the catalog: bound where
 * the flows exist, and absent otherwise, with no capability-gap copy either
 * way.
 */
const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}
const unavailableAgent: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }

/** The web host with the workspace terminal tunnel: the language server is in reach. */
const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true }),
  authFlow: "redirect",
  sandbox: null
}

/** The same host without the tunnel: no language server, so no gesture. */
const WEB_NO_TUNNEL: AppBootstrap = {
  ...WEB,
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false })
}
const NATIVE: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "local",
  capabilities: localCapabilities({ agent: true, identity: true, cloud: true }),
  authFlow: "native-handoff",
  sandbox: null
}

const renderOn = async (bootstrap: AppBootstrap, card: Extract<Card, { kind: "file" }>): Promise<{ readonly host: HTMLElement; readonly calls: Array<[string, string | undefined]> }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, { bootstrap })
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host, dispose: () => controller.dispose() })
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <FileCardBody card={card} onRunCommand={(name, args) => calls.push([name, args])} />
      </ControllerTestProvider>
    )
  )
  return { host, calls }
}

describe("the file card's gestures follow the host's catalog", () => {
  test("without the workspace tunnel a TypeScript card binds no code.* gesture and adds no capability-gap copy", async () => {
    const { host, calls } = await renderOn(WEB_NO_TUNNEL, fileCard("src/app.ts", "export const answer: number = 42\n"))
    await highlighted(host)
    expect(host.querySelector('[data-flow="code.hover"]')).toBeNull()
    expect(host.querySelector("[data-flow-activate]")).toBeNull()
    expect(host.querySelector("[data-intel]")).toBeNull()
    expect(host.textContent).not.toContain("/code.hover")
    // The file is still highlighted: highlighting is client-side everywhere.
    expect((shadowOf(host)?.querySelectorAll("[data-line] span[style]").length ?? 0) > 1).toBe(true)
    // No gesture is armed: a rest or ⌘-click on the code runs nothing — not a silently dropped command.
    const span = shadowOf(host)?.querySelector<HTMLElement>("[data-line] span[style]")
    if (span == null) throw new Error("no coloured token")
    span.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }))
    await wait(400)
    span.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, metaKey: true }))
    expect(calls).toEqual([])
  }, 30_000)

  test("a file no language server would serve carries no note, and a card the seam already annotated keeps its own state", async () => {
    const json = await renderOn(WEB_NO_TUNNEL, fileCard("package.json", "{ \"name\": \"x\" }\n"))
    expect(json.host.querySelector("[data-intel]")).toBeNull()
    const cloud = await renderOn(WEB_NO_TUNNEL, fileCard("src/app.ts", "export {}\n", { intel: { state: "unavailable", note: "Hover and definitions need a workspace language server; Smithers Cloud does not relay one yet." } }))
    expect(cloud.host.querySelector('[data-intel="unavailable"]')?.textContent).toContain("Smithers Cloud does not relay one yet")
  })


  test("with cloud.terminal the same card binds both gestures and states nothing", async () => {
    const { host, calls } = await renderOn(WEB, fileCard("src/app.ts", "export const answer: number = 42\n"))
    await highlighted(host)
    expect(host.querySelector('[data-flow="code.hover"]')?.getAttribute("data-flow-activate")).toBe("code.definition")
    expect(host.querySelector("[data-intel]")).toBeNull()
    tokenIn(host, 1, "answer").dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, metaKey: true }))
    expect(calls).toEqual([["code.definition", "src/app.ts:1:14 smithersai/smithers"]])
  }, 30_000)
})

describe("the address line's head-moved rule", () => {
  const line = (source: "head" | "working-copy" | undefined): string => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push({ root, host })
    flushSync(() =>
      root.render(
        <FileCardAddressLine
          repo="smithersai/smithers"
          path="README.md"
          address="/smithersai/smithers/README.md"
          readAt={{ changeId: "qupxosqw", commitId: "aaaa1111", ...(source === undefined ? {} : { source }) }}
          head={{ changeId: "ronvznsk", commitId: "bbbb2222" }}
          refreshCommand="files.read"
          onRunCommand={() => {}}
        />
      )
    )
    return host.textContent ?? ""
  }
  test("a read at the head reports head moved when the head commit differs", () => {
    expect(line("head")).toContain("head moved")
    expect(line(undefined)).toContain("head moved")
  })
  test("a working-copy read never reports head moved: its drift is the origin chip's N ahead", () => {
    expect(line("working-copy")).not.toContain("head moved")
  })
})


describe("file listing bindings", () => {
  test.each([undefined, "checkout with spaces"])("lists and reads in its repository scope (%s)", (localRepoId) => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push({ root, host })
    const commands: Array<{ name: string; args?: string }> = []
    flushSync(() => root.render(<FileListCardBody
      card={{
        id: "listing", kind: "file-list", title: "Files", status: "active", createdAt: 1, ordinal: 1,
        payload: { repo: "smithersai/smithers", localRepoId, path: "my docs", entries: [
          { name: "examples", kind: "dir" }, { name: "read me.md", kind: "file" }
        ] }
      }}
      onRunCommand={(name, args) => { commands.push({ name, args }) }}
    />))
    const scope = localRepoId === undefined ? "smithersai/smithers" : '"checkout with spaces"'
    const buttons = host.querySelectorAll("button")
    const expected = [
      { name: "files.list", args: `"my docs/examples" ${scope}` },
      { name: "files.read", args: `"my docs/read me.md" ${scope}` }
    ]
    for (const [index, button] of Array.from(buttons).entries()) {
      expect(button.dataset.flow).toBe(expected[index]!.name)
      expect(button.dataset.flowArgs).toBe(expected[index]!.args)
      button.click()
    }
    expect(commands).toEqual(expected)
  })
})


test("a listing refresh uses its host's flow and scope", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  const commands: Array<{ name: string; args?: string }> = []
  flushSync(() => root.render(<FileCardAddressLine
    repo="smithersai/smithers"
    path=""
    readAt={{ changeId: "old", commitId: "aaaa" }}
    head={{ changeId: "new", commitId: "bbbb" }}
    refreshCommand="box.files"
    refreshScope="workspace with spaces"
    onRunCommand={(name, args) => { commands.push({ name, args }) }}
  />))
  const button = host.querySelector("button")!
  expect(button.dataset.flow).toBe("box.files")
  expect(button.dataset.flowArgs).toBe('/ "workspace with spaces"')
  button.click()
  expect(commands).toEqual([{ name: "box.files", args: '/ "workspace with spaces"' }])
})

describe("a markdown file card's links (#3132)", () => {
  const follow = (payload: Extract<Card, { kind: "file" }>["payload"], href: string) => {
    const commands: Array<{ name: string; args?: string }> = []
    const scrolled: Array<number> = []
    const editor = { getMarkdown: () => payload.content, setMarkdown: () => {}, scrollToLine: (line: number) => { scrolled.push(line); return true } }
    const handled = followMarkdownLink(payload, href, (name, args) => commands.push({ name, args }), editor)
    return { handled, commands, scrolled }
  }
  const repoReadme = fileCard("docs/README.md", "# Guide\n\n## Install\n", { repo: "alpha/one", ref: "abc123" }).payload
  const boxReadme = fileCard("README.md", "[LICENSE](LICENSE)", { repo: "smithersai/jjhub", workspaceId: "ws 1" }).payload

  test("a relative link reads the file from the card's own repository and revision, not the page's", () => {
    expect(follow(repoReadme, "../LICENSE")).toEqual({ handled: true, commands: [{ name: "files.read", args: "LICENSE alpha/one --ref abc123" }], scrolled: [] })
    expect(follow(repoReadme, "api/")).toEqual({ handled: true, commands: [{ name: "files.list", args: "docs/api alpha/one" }], scrolled: [] })
    expect(follow({ ...repoReadme, localRepoId: "local-7" }, "setup.md#run").commands).toEqual([{ name: "files.read", args: "docs/setup.md local-7 --ref abc123" }])
  })

  test("a box's markdown opens the box's own files", () => {
    expect(follow(boxReadme, "LICENSE").commands).toEqual([{ name: "box.file", args: 'LICENSE "ws 1"' }])
    expect(follow(boxReadme, "./").commands).toEqual([{ name: "box.files", args: '/ "ws 1"' }])
  })

  test("a same-document anchor scrolls to its heading; an unknown one stays put", () => {
    expect(follow(repoReadme, "#install")).toEqual({ handled: true, commands: [], scrolled: [3] })
    expect(follow(repoReadme, "#missing")).toEqual({ handled: true, commands: [], scrolled: [] })
  })

  test("web links stay the browser's; unsafe schemes and escapes above the root go nowhere", () => {
    expect(follow(repoReadme, "https://example.com").handled).toBe(false)
    for (const href of ["javascript:alert(1)", "../../etc/passwd"]) expect(follow(repoReadme, href)).toEqual({ handled: true, commands: [], scrolled: [] })
  })
})
